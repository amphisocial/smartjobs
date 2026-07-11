import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { complete, parseJson } from "./providers.js";
import { getMemberByToken } from "./store.js";
import * as RP from "./recruiter-prompts.js";
import {
  initRecruiterStore, recruiterDbReady, recruiterOwnerKey, createJob, listJobs, getJob, updateJob,
  addCandidate, updateCandidatePipeline, saveRanking, refreshRankPositions, listInterviewPairs,
  createJobBuilderSession, getJobBuilderSession, addJobBuilderMessage, getCandidateJob,
  createInterviewSession, getInterviewSession, addInterviewTurn, completeInterviewSession
} from "./recruiter-store.js";

function modelName() {
  return config.provider === "gemini" ? config.gemini.model : config.openai.model;
}
async function ai(spec) {
  const raw = await complete({ system: spec.system, user: spec.user, json: !!spec.json, temperature: spec.temperature ?? 0.3 });
  return parseJson(raw);
}
function cleanList(v) {
  return Array.isArray(v) ? v.map(x => String(x || "").trim()).filter(Boolean).slice(0, 40) : [];
}
function normalizeJob(d = {}, fallback = {}) {
  return {
    title: String(fallback.title || d.title || "Untitled role").trim(),
    companyName: String(fallback.companyName || d.companyName || "").trim(),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(fallback.startDate || d.startDate || "")) ? String(fallback.startDate || d.startDate) : null,
    status: ["open", "in_process", "closed"].includes(fallback.status) ? fallback.status : "open",
    sourceType: fallback.sourceType || "paste",
    sourceUrl: fallback.sourceUrl || null,
    rawDescription: String(fallback.rawDescription || "").trim(),
    roleDescription: String(d.roleDescription || fallback.roleDescription || "").trim(),
    responsibilities: cleanList(d.responsibilities || fallback.responsibilities),
    mustHave: cleanList(d.mustHave || fallback.mustHave),
    preferredQualifications: cleanList(d.preferredQualifications || fallback.preferredQualifications),
    niceToHave: cleanList(d.niceToHave || fallback.niceToHave),
    screeningQuestions: cleanList(d.screeningQuestions || fallback.screeningQuestions),
    metadata: { ...(fallback.metadata || {}), ...(d.metadata || {}) }
  };
}
function knownError(res, err) {
  console.error("[recruiter]", err.message);
  if (err.message === "recruiter_database_not_configured") return res.status(503).json({ error: "Recruiter workspace requires DATABASE_URL and the recruiter schema." });
  if (/valid URL|http\(s\)|private address|resolve/.test(err.message)) return res.status(400).json({ error: err.message });
  if (/429|quota|RESOURCE_EXHAUSTED|insufficient_quota/i.test(err.message)) return res.status(502).json({ error: "The AI provider is over its current quota." });
  return res.status(500).json({ error: "Recruiter workflow failed. Check the server log for details." });
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
  }
  const l = String(ip).toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}
async function safeUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid URL."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) links are supported.");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new Error("Couldn't resolve that link."); });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error("That link points to a private address and can't be fetched.");
  return u.toString();
}
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function fetchReadable(url) {
  const safe = await safeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(safe, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; SmartJobsRecruiter/1.0)", Accept: "text/html,application/xhtml+xml" } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/text|html|xml/i.test(type)) throw new Error("The page did not return readable HTML.");
    return htmlToText((await r.text()).slice(0, 500000)).slice(0, 30000);
  } finally { clearTimeout(timer); }
}

async function auth(req, res) {
  if (!recruiterDbReady()) { res.status(503).json({ error: "Recruiter workspace requires PostgreSQL. Install db/recruiter_schema.sql and set DATABASE_URL." }); return null; }
  const token = String(req.body?.token || "").trim();
  if (!token) { res.status(401).json({ error: "Use an active member code to access the recruiter workspace." }); return null; }
  const member = await getMemberByToken(token);
  if (!member || !["active", "trialing"].includes(member.status)) { res.status(401).json({ error: "The member code is not active." }); return null; }
  return { owner: recruiterOwnerKey(token), actor: member.customer_id || member.customerId || recruiterOwnerKey(token) };
}

export async function installRecruiterRoutes(app) {
  await initRecruiterStore();

  app.post("/api/recruiter/bootstrap", async (req, res) => {
    try { const a = await auth(req, res); if (!a) return; res.json({ jobs: await listJobs(a.owner), pairs: await listInterviewPairs(a.owner), unlimited: true }); }
    catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/jobs/list", async (req, res) => {
    try { const a = await auth(req, res); if (!a) return; res.json({ jobs: await listJobs(a.owner), unlimited: true }); }
    catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/jobs/get", async (req, res) => {
    try { const a = await auth(req, res); if (!a) return; const job = await getJob(a.owner, req.body.jobId); if (!job) return res.status(404).json({ error: "Job not found." }); res.json({ job, unlimited: true }); }
    catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/jobs/create", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const raw = String(req.body.rawDescription || "").trim();
      if (!raw && !req.body.roleDescription) return res.status(400).json({ error: "Paste a job description or use AI Help." });
      let structured = {};
      if (req.body.analyze !== false && raw) structured = await ai(await RP.structureJob(raw, req.body));
      const job = await createJob(a.owner, a.actor, normalizeJob(structured, { ...req.body, sourceType: req.body.sourceType || "paste", rawDescription: raw }));
      res.json({ job, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/jobs/import", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const sourceType = req.body.sourceType === "linkedin" ? "linkedin" : "external_link";
      const sourceUrl = String(req.body.sourceUrl || "").trim();
      let text = String(req.body.pastedContent || "").trim();
      let fetchNote = "";
      if (!text && sourceUrl) {
        try { text = await fetchReadable(sourceUrl); }
        catch (e) { fetchNote = e.message; }
      }
      if (text.length < 120) {
        const note = sourceType === "linkedin"
          ? "LinkedIn commonly blocks server-side retrieval. Paste the visible job/profile content in the LinkedIn content box and import again."
          : "The page did not expose enough readable content. Paste the job text and import again.";
        return res.status(422).json({ error: note, note: fetchNote });
      }
      const structured = await ai(await RP.structureJob(text, { ...req.body, sourceType, sourceUrl }));
      const job = await createJob(a.owner, a.actor, normalizeJob(structured, { ...req.body, sourceType, sourceUrl, rawDescription: text, metadata: { fetchNote } }));
      res.json({ job, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/jobs/update", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const job = await updateJob(a.owner, a.actor, req.body.jobId, req.body.changes || {});
      if (!job) return res.status(404).json({ error: "Job not found." });
      res.json({ job, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/candidates/add", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const c = req.body.candidate || {};
      if (!req.body.jobId || !String(c.name || "").trim() || String(c.resumeText || "").trim().length < 40) return res.status(400).json({ error: "Candidate name and readable resume are required." });
      const candidate = await addCandidate(a.owner, a.actor, req.body.jobId, c);
      if (!candidate) return res.status(404).json({ error: "Job not found." });
      res.json({ candidate, job: await getJob(a.owner, req.body.jobId), unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/candidates/pipeline", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const allowed = ["new", "screening", "interview", "offer", "rejected", "withdrawn", "hired"];
      if (!allowed.includes(req.body.pipelineStatus)) return res.status(400).json({ error: "Invalid pipeline status." });
      const row = await updateCandidatePipeline(a.owner, a.actor, req.body.jobId, req.body.candidateId, req.body.pipelineStatus, req.body.notes || "");
      if (!row) return res.status(404).json({ error: "Candidate/job link not found." });
      res.json({ ok: true, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/rank", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      let job = await getJob(a.owner, req.body.jobId);
      if (!job) return res.status(404).json({ error: "Job not found." });
      const mode = req.body.mode === "all" ? "all" : "unranked";
      const targets = job.candidates.filter(c => mode === "all" || c.ranking_state !== "ranked");
      if (!targets.length) return res.json({ job, rankedNow: 0, message: "All candidates already have a current ranking.", unlimited: true });
      for (const candidate of targets) {
        const rank = await ai(await RP.rankCandidate(job, candidate));
        await saveRanking(a.owner, a.actor, job, candidate, rank, config.provider, modelName());
      }
      await refreshRankPositions(job.id);
      job = await getJob(a.owner, job.id);
      res.json({ job, rankedNow: targets.length, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/job-agent/chat", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      let session = req.body.sessionId ? await getJobBuilderSession(a.owner, req.body.sessionId) : null;
      if (!session) session = await createJobBuilderSession(a.owner, a.actor);
      const message = String(req.body.message || "").trim();
      if (!message) return res.status(400).json({ error: "Enter a message for the job builder." });
      await addJobBuilderMessage(session.id, "recruiter", message);
      session = await getJobBuilderSession(a.owner, session.id);
      const out = await ai(await RP.jobBuilderChat(session.messages, session.draft));
      await addJobBuilderMessage(session.id, "assistant", out.message || "", { draft: out.draft || {}, ready: !!out.ready });
      res.json({ sessionId: session.id, message: out.message, ready: !!out.ready, draft: out.draft || {}, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/interviews/list", async (req, res) => {
    try { const a = await auth(req, res); if (!a) return; res.json({ pairs: await listInterviewPairs(a.owner, req.body.jobId || null, req.body.candidate || null), unlimited: true }); }
    catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/interviews/start", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const pair = await getCandidateJob(a.owner, req.body.jobId, req.body.candidateId);
      if (!pair) return res.status(404).json({ error: "Candidate/job pair not found." });
      const out = await ai(await RP.interviewStart(pair, pair));
      const session = await createInterviewSession(a.owner, a.actor, req.body.jobId, req.body.candidateId, out.coverage || {});
      await addInterviewTurn(session.id, "system", out.coachWelcome || "Practice session started.", { coverage: out.coverage || {}, riskAreas: out.riskAreas || [], suggestedNextQuestion: out.suggestedFirstQuestion || "" });
      await addInterviewTurn(session.id, "candidate", out.candidateOpening || "Thanks for taking the time to speak with me.");
      res.json({ sessionId: session.id, pair, ...out, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/interviews/turn", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const session = await getInterviewSession(a.owner, req.body.sessionId);
      if (!session || session.status !== "active") return res.status(404).json({ error: "Active interview session not found." });
      const pair = await getCandidateJob(a.owner, session.job_id, session.candidate_id);
      const question = String(req.body.question || "").trim();
      if (!question) return res.status(400).json({ error: "Enter the recruiter question." });
      const out = await ai(await RP.interviewTurn(pair, pair, session.turns, question, session.coverage));
      await addInterviewTurn(session.id, "recruiter", question);
      await addInterviewTurn(session.id, "candidate", out.candidateAnswer || "", { coverage: out.coverage || session.coverage });
      await addInterviewTurn(session.id, "coach", out.questionAssessment || "", { coverage: out.coverage || session.coverage, unresolvedRisks: out.unresolvedRisks || [], suggestedNextQuestion: out.suggestedNextQuestion || "", questionQualityScore: out.questionQualityScore });
      res.json({ ...out, unlimited: true });
    } catch (e) { knownError(res, e); }
  });

  app.post("/api/recruiter/interviews/finish", async (req, res) => {
    try {
      const a = await auth(req, res); if (!a) return;
      const session = await getInterviewSession(a.owner, req.body.sessionId);
      if (!session) return res.status(404).json({ error: "Interview session not found." });
      if (session.status === "completed") return res.json({ summary: session.summary, unlimited: true });
      const pair = await getCandidateJob(a.owner, session.job_id, session.candidate_id);
      const summary = await ai(await RP.interviewFinish(pair, pair, session.turns, session.coverage));
      await completeInterviewSession(session.id, summary);
      res.json({ summary, unlimited: true });
    } catch (e) { knownError(res, e); }
  });
}
