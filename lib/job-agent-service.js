import { config } from "../config.js";
import { complete, parseJson } from "./providers.js";
import { searchPlanPrompt, fitEvaluationPrompt } from "./job-agent-prompts.js";
import { deterministicSearchPlan, discoverAndVerifyJobs } from "./job-search-engine.js";
import { getMemberByToken } from "./store.js";
import { sendJobAgentDigest, smtpConfigured } from "./smtp-mailer.js";
import {
  getJobSearchAgent, updateAgentPlan, createJobAgentRun, finishJobAgentRun, markAgentRunTime,
  upsertJobAgentResult, listDueJobSearchAgents, listDigestDueAgents, getUnsentDigestResults,
  markDigestSent, withJobAgentSchedulerLock,
} from "./job-agent-store.js";

async function ai(spec) {
  const raw = await complete({
    system: spec.system,
    user: spec.user,
    json: true,
    temperature: spec.temperature ?? 0.2,
  });
  return parseJson(raw);
}

function array(value, max = 100) {
  return Array.isArray(value) ? value.filter(v => v != null).slice(0, max) : [];
}

function normalizePlan(raw, agent) {
  const fallback = deterministicSearchPlan(agent);
  const aiQueries = array(raw?.queries, config.jobAgentMaxQueries).map((entry, index) => ({
    query: String(entry?.query || "").replace(/\s+/g, " ").trim().slice(0, 1500),
    titleFamily: String(entry?.titleFamily || "").trim().slice(0, 200),
    location: String(entry?.location || "").trim().slice(0, 200),
    priority: Number(entry?.priority || index + 1),
  })).filter(entry => entry.query).sort((a, b) => a.priority - b.priority);

  // Enforce one broad, focused query for every explicit geography before using
  // AI-generated depth queries. Search quality must not depend on model ordering.
  const coverageCount = fallback.locationWaves.length;
  const combined = [...fallback.queries.slice(0, coverageCount), ...aiQueries, ...fallback.queries.slice(coverageCount)];
  const seen = new Set();
  const queries = [];
  for (const entry of combined) {
    const key = `${entry.location}|${entry.query}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(entry);
    if (queries.length >= config.jobAgentMaxQueries) break;
  }
  return {
    titleFamilies: array(raw?.titleFamilies, 30).length ? array(raw?.titleFamilies, 30) : fallback.titleFamilies,
    locationWaves: fallback.locationWaves,
    queries,
    exclusionTerms: array(raw?.exclusionTerms, 50).map(String),
    notes: array(raw?.notes, 30).map(String),
    generatedAt: new Date().toISOString(),
    generatedBy: aiQueries.length ? "ai_with_enforced_city_coverage" : "fallback",
  };
}

export async function generateJobSearchPlan(agent) {
  try {
    return normalizePlan(await ai(searchPlanPrompt(agent)), agent);
  } catch (error) {
    console.error("[job-agent] plan generation failed, using fallback:", error.message);
    const plan = deterministicSearchPlan(agent);
    return { ...plan, generatedAt: new Date().toISOString(), generatedBy: "fallback", notes: [...(plan.notes || []), error.message] };
  }
}

function fallbackEvaluation(agent, job) {
  const title = job.title.toLowerCase();
  const targets = [...(agent.target_titles || []), ...(agent.preferred_title_terms || [])].map(v => String(v).toLowerCase());
  const exclusions = [...(agent.excluded_title_terms || []), ...(agent.excluded_keywords || [])].map(v => String(v).toLowerCase());
  let score = 45;
  if (targets.some(term => term && (title.includes(term) || term.split(/\s+/).filter(w => w.length > 3).some(w => title.includes(w))))) score += 28;
  if ((agent.priority_cities || []).some(city => job.location.toLowerCase().includes(String(city).split(",")[0].toLowerCase()))) score += 10;
  if (job.remote && agent.remote_eligible) score += 7;
  if (job.compensation_max && agent.min_base_compensation && job.compensation_max >= agent.min_base_compensation) score += 8;
  if (exclusions.some(term => term && `${title} ${job.description_text.slice(0, 4000).toLowerCase()}`.includes(term))) score -= 35;
  score = Math.max(0, Math.min(100, score));
  return {
    fitScore: score,
    recommended: score >= 68,
    fitSummary: score >= 68 ? "Title, location, and scope align with the saved search preferences." : "Potential match, but the available evidence is not strong enough for a priority recommendation.",
    mandatoryQualifications: [],
    preferredQualifications: [],
    materialGaps: [],
    compensationAssessment: job.compensation_max && agent.min_base_compensation
      ? (job.compensation_max >= agent.min_base_compensation ? "meets" : "below") : "unclear",
    whyIncludedOrExcluded: "Deterministic fallback evaluation used because the AI evaluation was unavailable.",
  };
}

async function evaluateBatch(agent, jobs) {
  try {
    const output = await ai(fitEvaluationPrompt(agent, jobs));
    const byIndex = new Map(array(output?.evaluations, jobs.length).map(item => [Number(item.index), item]));
    return jobs.map((job, index) => {
      const item = byIndex.get(index);
      if (!item) return fallbackEvaluation(agent, job);
      return {
        fitScore: Math.max(0, Math.min(100, Number(item.fitScore || 0))),
        recommended: Boolean(item.recommended),
        fitSummary: String(item.fitSummary || "").trim().slice(0, 1200),
        mandatoryQualifications: array(item.mandatoryQualifications, 30).map(String),
        preferredQualifications: array(item.preferredQualifications, 30).map(String),
        materialGaps: array(item.materialGaps, 30).map(String),
        compensationAssessment: ["meets", "likely_meets", "unclear", "below"].includes(item.compensationAssessment) ? item.compensationAssessment : "unclear",
        whyIncludedOrExcluded: String(item.whyIncludedOrExcluded || "").trim().slice(0, 1600),
      };
    });
  } catch (error) {
    console.error("[job-agent] fit evaluation failed:", error.message);
    return jobs.map(job => fallbackEvaluation(agent, job));
  }
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function zonedDateToUtc(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = target - actualAsUtc;
    guess += delta;
    if (Math.abs(delta) < 1000) break;
  }
  return new Date(guess);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function computeNextRunAt(agent, after = new Date()) {
  if (!agent.schedule_enabled) return null;
  const timeZone = agent.timezone || "America/New_York";
  const [hour, minute] = String(agent.schedule_time || "07:00").split(":").map(Number);
  const now = zonedParts(after, timeZone);
  const currentLocalDate = new Date(Date.UTC(now.year, now.month - 1, now.day));
  let local;

  if (agent.schedule_frequency === "daily") {
    local = { year: now.year, month: now.month, day: now.day, hour, minute, second: 0 };
    if (zonedDateToUtc(local, timeZone) <= after) local = { ...addLocalDays(now, 1), hour, minute, second: 0 };
  } else if (agent.schedule_frequency === "monthly") {
    const day = Math.min(28, Math.max(1, Number(agent.schedule_day || 1)));
    local = { year: now.year, month: now.month, day, hour, minute, second: 0 };
    if (zonedDateToUtc(local, timeZone) <= after) {
      const nextMonth = new Date(Date.UTC(now.year, now.month, 1));
      local = { year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth() + 1, day, hour, minute, second: 0 };
    }
  } else {
    const targetDay = Math.min(6, Math.max(0, Number(agent.schedule_day ?? 1)));
    const currentDay = currentLocalDate.getUTCDay();
    let daysAhead = (targetDay - currentDay + 7) % 7;
    local = { ...addLocalDays(now, daysAhead), hour, minute, second: 0 };
    if (zonedDateToUtc(local, timeZone) <= after) {
      daysAhead += 7;
      local = { ...addLocalDays(now, daysAhead), hour, minute, second: 0 };
    }
  }
  return zonedDateToUtc(local, timeZone).toISOString();
}

export async function runJobSearchAgent({ owner, agentId, triggerType = "manual", onProgress = () => {} }) {
  const agent = await getJobSearchAgent(owner, agentId);
  if (!agent) throw new Error("job_search_agent_not_found");
  const run = await createJobAgentRun(owner, agentId, triggerType);
  if (!run) throw new Error("job_search_agent_not_found");

  const errors = [];
  let stats = { queryCount: 0, discoveredCount: 0, verifiedCount: 0, recommendedCount: 0 };
  try {
    let plan = agent.search_plan && Array.isArray(agent.search_plan.queries) && agent.search_plan.queries.length
      ? agent.search_plan : await generateJobSearchPlan(agent);
    if (!agent.search_plan?.queries?.length) await updateAgentPlan(owner, agentId, plan);
    stats.queryCount = plan.queries.length;
    onProgress({ stage: "plan", plan });

    const discovery = await discoverAndVerifyJobs(plan, onProgress);
    errors.push(...discovery.errors);
    stats.discoveredCount = discovery.discoveredCount;
    stats.verifiedCount = discovery.verified.length;

    const evaluated = [];
    const batchSize = 8;
    for (let i = 0; i < discovery.verified.length; i += batchSize) {
      const jobs = discovery.verified.slice(i, i + batchSize);
      const evaluations = await evaluateBatch(agent, jobs);
      jobs.forEach((job, index) => evaluated.push({ job, evaluation: evaluations[index] }));
      onProgress({ stage: "evaluate", completed: Math.min(i + batchSize, discovery.verified.length), total: discovery.verified.length });
    }

    evaluated.sort((a, b) => Number(b.evaluation.recommended) - Number(a.evaluation.recommended) || b.evaluation.fitScore - a.evaluation.fitScore);
    const selected = evaluated.slice(0, agent.max_results || 25);
    for (const row of selected) {
      await upsertJobAgentResult(owner, agentId, run.id, row.job, row.evaluation);
      if (row.evaluation.recommended) stats.recommendedCount += 1;
    }

    const nextRunAt = computeNextRunAt(agent, new Date());
    await markAgentRunTime(owner, agentId, nextRunAt);
    await finishJobAgentRun(run.id, "completed", stats, errors);
    return { runId: run.id, stats, errors, plan };
  } catch (error) {
    errors.push(error.message);
    const nextRunAt = computeNextRunAt(agent, new Date(Date.now() + 3600000));
    await markAgentRunTime(owner, agentId, nextRunAt);
    await finishJobAgentRun(run.id, "failed", stats, errors);
    throw error;
  }
}

function localDayStamp(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

async function paidForScheduledAgent(agent) {
  if (!agent.member_token) return false;
  const member = await getMemberByToken(agent.member_token);
  return Boolean(member && ["active", "trialing"].includes(member.status));
}

async function runDueAgents() {
  const due = await listDueJobSearchAgents(config.jobAgentSchedulerBatchSize);
  for (const agent of due) {
    try {
      if (!await paidForScheduledAgent(agent)) {
        await markAgentRunTime(agent.owner_key, agent.id, null);
        console.warn(`[job-agent] disabled unpaid scheduled agent ${agent.id}`);
        continue;
      }
      await runJobSearchAgent({ owner: agent.owner_key, agentId: agent.id, triggerType: "scheduled" });
    } catch (error) {
      console.error(`[job-agent] scheduled run failed for ${agent.id}:`, error.message);
    }
  }
}

async function sendDueDigests() {
  if (!smtpConfigured()) return;
  const now = new Date();
  const agents = await listDigestDueAgents();
  for (const agent of agents) {
    try {
      if (!await paidForScheduledAgent(agent)) continue;
      const local = zonedParts(now, agent.timezone || "America/New_York");
      if (local.hour !== Number(agent.digest_hour ?? 20)) continue;
      if (agent.last_digest_at && localDayStamp(new Date(agent.last_digest_at), agent.timezone) === localDayStamp(now, agent.timezone)) continue;
      const results = await getUnsentDigestResults(agent.id, 40);
      if (!results.length) {
        await markDigestSent(agent.id, []);
        continue;
      }
      await sendJobAgentDigest({ to: agent.email, displayName: agent.display_name, agent, results });
      await markDigestSent(agent.id, results.map(r => r.id));
    } catch (error) {
      console.error(`[job-agent] digest failed for ${agent.id}:`, error.message);
    }
  }
}

let schedulerTimer = null;
let schedulerRunning = false;

export function startJobAgentScheduler() {
  if (!config.jobAgentSchedulerEnabled || schedulerTimer) return;
  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await withJobAgentSchedulerLock(async () => {
        await runDueAgents();
        await sendDueDigests();
      });
    } catch (error) {
      console.error("[job-agent] scheduler tick failed:", error.message);
    } finally { schedulerRunning = false; }
  };
  schedulerTimer = setInterval(tick, config.jobAgentSchedulerIntervalMinutes * 60000);
  schedulerTimer.unref?.();
  setTimeout(tick, 15000).unref?.();
  console.log(`[job-agent] scheduler enabled every ${config.jobAgentSchedulerIntervalMinutes} minute(s).`);
}
