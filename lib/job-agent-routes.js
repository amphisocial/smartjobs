import { config, googleAuthEnabled, billingEnabled } from "../config.js";
import { getMemberByToken, ensureMember } from "./store.js";
import { createCheckoutSession, findActiveSubscriptionByEmail } from "./billing.js";
import { verifyRecruiterSession } from "./google-auth.js";
import {
  initJobAgentStore, jobAgentDbReady, jobAgentOwnerKey, upsertJobAgentAccount,
  getJobAgentAccount, bindMemberToken, getJobAgentUsage, consumeJobAgentUsage,
  saveJobSearchAgent, listJobSearchAgents, getJobSearchAgent, deleteJobSearchAgent,
  updateAgentPlan, setJobSearchAgentNextRun, listJobAgentResults, updateJobAgentResultStatus,
  listRecentJobAgentRuns, hasRunningJobAgentRun,
} from "./job-agent-store.js";
import { generateJobSearchPlan, runJobSearchAgent, computeNextRunAt, startJobAgentScheduler } from "./job-agent-service.js";
import { smtpConfigured } from "./smtp-mailer.js";
import { diagnoseJobSearchProvider } from "./job-search-engine.js";


let searchHealthCache = { checkedAt: 0, value: null };
async function searchHealth(force = false) {
  const fresh = Date.now() - searchHealthCache.checkedAt < 5 * 60 * 1000;
  if (!force && fresh && searchHealthCache.value) return searchHealthCache.value;
  const value = await diagnoseJobSearchProvider('technology jobs "Boston, MA" careers');
  searchHealthCache = { checkedAt: Date.now(), value };
  return value;
}

function activeMember(member) {
  return Boolean(member && ["active", "trialing"].includes(member.status));
}

async function authenticate(req, res) {
  if (!jobAgentDbReady()) {
    res.status(503).json({ error: "Job search agents require PostgreSQL. Set SMARTJOBS_DATABASE_URL or DATABASE_URL." });
    return null;
  }
  const user = verifyRecruiterSession(String(req.body?.recruiterSession || "").trim());
  if (!user) {
    res.status(401).json({ error: "google_signin_required", message: "Sign in with Google to use job search agents." });
    return null;
  }
  const owner = jobAgentOwnerKey(`google:${user.sub}`);
  const suppliedToken = String(req.body?.token || "").trim();
  let account = await getJobAgentAccount(owner);
  let memberToken = suppliedToken || account?.member_token || "";
  let member = memberToken ? await getMemberByToken(memberToken) : null;

  if (suppliedToken && activeMember(member)) {
    await upsertJobAgentAccount(owner, user, suppliedToken);
    await bindMemberToken(owner, suppliedToken);
  } else {
    account = await upsertJobAgentAccount(owner, user, null);
    memberToken = account.member_token || "";
    member = memberToken ? await getMemberByToken(memberToken) : null;
  }

  // No code entry is required after sign-in: recover an active Stripe subscription
  // by the user's verified Google email and bind the resulting member token.
  if (!activeMember(member) && billingEnabled() && req.body?.checkStripe === true) {
    try {
      const paid = await findActiveSubscriptionByEmail(user.email);
      if (paid) {
        memberToken = await ensureMember(paid.customerId, paid.subscriptionId, paid.status);
        await bindMemberToken(owner, memberToken);
        member = await getMemberByToken(memberToken);
      }
    } catch (error) {
      console.warn(`[job-agent] Stripe email entitlement lookup failed for ${user.email}:`, error.message);
    }
  }
  return { owner, user, paid: activeMember(member), memberToken: activeMember(member) ? memberToken : "" };
}

function usagePayload(used, paid) {
  const count = Number(used.agent_run || 0);
  return {
    used: paid ? 0 : count,
    limit: config.jobAgentFreeRunsDaily,
    remaining: paid ? null : Math.max(0, config.jobAgentFreeRunsDaily - count),
  };
}

async function respond(res, auth, payload = {}) {
  const usage = auth.paid ? {} : await getJobAgentUsage(auth.owner);
  res.json({
    ...payload,
    user: auth.user,
    paid: auth.paid,
    schedulingAvailable: auth.paid,
    smtpConfigured: smtpConfigured(),
    usage: usagePayload(usage, auth.paid),
  });
}

function knownError(res, error) {
  console.error("[job-agent]", error.message);
  if (error.message === "job_agent_database_not_configured") return res.status(503).json({ error: "Job search agent database is not configured." });
  if (error.message === "job_search_agent_not_found") return res.status(404).json({ error: "Job search agent not found." });
  if (error.message === "invalid_result_status") return res.status(400).json({ error: "Invalid result status." });
  if (/429|quota|RESOURCE_EXHAUSTED|insufficient_quota/i.test(error.message)) return res.status(502).json({ error: "The AI provider is over its current quota." });
  return res.status(500).json({ error: "Job search agent workflow failed. Check the PM2 log for details." });
}

function validateAgentInput(body = {}) {
  const titles = Array.isArray(body.targetTitles) ? body.targetTitles.filter(Boolean) : [];
  const cities = Array.isArray(body.priorityCities) ? body.priorityCities.filter(Boolean) : [];
  const states = Array.isArray(body.states) ? body.states.filter(Boolean) : [];
  const regions = Array.isArray(body.regions) ? body.regions.filter(Boolean) : [];
  if (!String(body.profileSummary || "").trim()) throw new Error("Add a resume or applicant profile summary.");
  if (!titles.length) throw new Error("Add at least one target title.");
  if (!cities.length && !states.length && !regions.length && body.remoteEligible === false) throw new Error("Add a city, state, region, or enable US remote roles.");
}

export async function installJobAgentRoutes(app) {
  await initJobAgentStore();

  app.get("/api/job-agent/config", (_req, res) => {
    res.json({
      enabled: jobAgentDbReady() && googleAuthEnabled(),
      freeRunsDaily: config.jobAgentFreeRunsDaily,
      schedulerEnabled: config.jobAgentSchedulerEnabled,
      smtpConfigured: smtpConfigured(),
      searchProvider: config.jobAgentSearchProvider,
      serperConfigured: Boolean(config.serperApiKey),
      braveConfigured: Boolean(config.braveSearchApiKey),
    });
  });

  app.post("/api/job-agent/search/health", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      const health = await searchHealth(req.body?.force === true);
      await respond(res, auth, { searchHealth: health });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/checkout", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      if (!billingEnabled()) return res.status(503).json({ error: "billing_not_configured" });
      const origin = `${req.protocol}://${req.get("host")}`;
      const url = await createCheckoutSession(origin, {
        customerEmail: auth.user.email,
        clientReferenceId: auth.owner,
        metadata: { smartjobs_owner_key: auth.owner, product: "job_search_agent" },
        successUrl: `${origin}/job-agent.html?checkout=success`,
        cancelUrl: `${origin}/job-agent.html?checkout=cancelled`,
      });
      res.json({ url });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/bootstrap", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      await respond(res, auth, {
        agents: await listJobSearchAgents(auth.owner),
        results: await listJobAgentResults(auth.owner, { limit: 120 }),
        runs: await listRecentJobAgentRuns(auth.owner, 40),
      });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/agents/save", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      validateAgentInput(req.body.agent || {});
      const requested = req.body.agent || {};
      if (requested.scheduleEnabled && !auth.paid) {
        return res.status(402).json({ error: "paid_feature", message: "Scheduled monitoring is available to paid members." });
      }
      let agent = await saveJobSearchAgent(auth.owner, {
        ...requested,
        scheduleEnabled: auth.paid && Boolean(requested.scheduleEnabled),
        nextRunAt: null,
      });
      if (!agent) return res.status(404).json({ error: "Job search agent not found." });
      const nextRunAt = agent.schedule_enabled ? computeNextRunAt(agent) : null;
      agent = await setJobSearchAgentNextRun(auth.owner, agent.id, nextRunAt);
      await respond(res, auth, { agent });
    } catch (error) {
      if (/Add a resume|Add at least|Add a city/.test(error.message)) return res.status(400).json({ error: error.message });
      knownError(res, error);
    }
  });

  app.post("/api/job-agent/agents/delete", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      const deleted = await deleteJobSearchAgent(auth.owner, req.body.agentId);
      if (!deleted) return res.status(404).json({ error: "Job search agent not found." });
      await respond(res, auth, { ok: true });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/agents/plan", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      const agent = await getJobSearchAgent(auth.owner, req.body.agentId);
      if (!agent) return res.status(404).json({ error: "Job search agent not found." });
      const plan = await generateJobSearchPlan(agent);
      const saved = await updateAgentPlan(auth.owner, agent.id, plan);
      await respond(res, auth, { agent: saved, plan });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/agents/run", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      const agent = await getJobSearchAgent(auth.owner, req.body.agentId);
      if (!agent) return res.status(404).json({ error: "Job search agent not found." });
      if (await hasRunningJobAgentRun(auth.owner, agent.id)) return res.status(409).json({ error: "agent_already_running", message: "This agent already has a run in progress." });
      const health = await searchHealth(false);
      if (!health.ok) {
        const details = (health.attempts || []).map(item => `${item.provider}: ${item.ok ? `${item.count} results` : item.error}`).join("; ");
        const message = `Search connection returned no results. ${details || "No provider response was recorded."} Configure SERPER_API_KEY or BRAVE_SEARCH_API_KEY, then test again.`;
        return res.status(503).json({ error: message, code: "job_search_provider_unavailable", searchHealth: health });
      }
      if (!auth.paid) {
        const usage = await consumeJobAgentUsage(auth.owner, "agent_run", config.jobAgentFreeRunsDaily);
        if (!usage.allowed) {
          return res.status(429).json({ error: "job_agent_daily_limit", message: "You have used all five free agent runs for today.", usage });
        }
      }
      void runJobSearchAgent({ owner: auth.owner, agentId: agent.id, triggerType: "manual" })
        .catch(error => console.error(`[job-agent] manual run failed for ${agent.id}:`, error.message));
      await respond(res, auth, { started: true, message: "Agent run started. Results will appear here as soon as verification and fit analysis finish." });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/results/list", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      await respond(res, auth, {
        results: await listJobAgentResults(auth.owner, {
          agentId: req.body.agentId || null,
          status: req.body.status || null,
          recommended: req.body.recommended === true,
          limit: req.body.limit || 150,
        }),
        runs: await listRecentJobAgentRuns(auth.owner, 40),
      });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/job-agent/results/status", async (req, res) => {
    try {
      const auth = await authenticate(req, res); if (!auth) return;
      const result = await updateJobAgentResultStatus(auth.owner, req.body.resultId, req.body.status);
      if (!result) return res.status(404).json({ error: "Job result not found." });
      await respond(res, auth, { result });
    } catch (error) { knownError(res, error); }
  });

  if (jobAgentDbReady()) startJobAgentScheduler();
}
