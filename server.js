// server.js
import express from "express";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { extractText as pdfExtractText, getDocumentProxy } from "unpdf";
import { config, assertConfig, activeProvider, billingEnabled, billingModeWarning } from "./config.js";
import { complete, parseJson } from "./lib/providers.js";
import * as P from "./lib/prompts.js";
import { buildResumePdf } from "./lib/pdf.js";
import { initStore, ensureMember, getMemberByToken, setStatusByCustomer, getApplications, setApplications } from "./lib/store.js";
import { createCheckoutSession, resolvePaidSession, constructWebhookEvent } from "./lib/billing.js";
import { checkAndConsume, consumeLive } from "./lib/ratelimit.js";

assertConfig();
await initStore();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", true);

// Stripe webhook BEFORE express.json (needs the raw body for signature check).
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try { event = constructWebhookEvent(req.body, req.headers["stripe-signature"]); }
  catch (err) { console.error("[webhook] verify failed:", err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }
  try {
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": await ensureMember(o.customer, o.subscription, "active"); break;
      case "customer.subscription.updated": await setStatusByCustomer(o.customer, o.status); break;
      case "customer.subscription.deleted": await setStatusByCustomer(o.customer, "canceled"); break;
      case "invoice.payment_failed": await setStatusByCustomer(o.customer, "past_due"); break;
    }
  } catch (err) { console.error("[webhook] handler error:", err.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => { if (req.path === "/" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache, no-store, must-revalidate"); next(); });
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true, provider: activeProvider(), billing: billingEnabled(), stripeMode: config.stripe.mode }));
app.get("/api/config", (_req, res) => res.json({ billingEnabled: billingEnabled(), liveDailyLimit: config.liveDailyLimit, freeDailyLimit: config.freeDailyLimit }));

// --- entitlement gate: members are unlimited; everyone else has a daily cap ---
async function gate(req, res) {
  const token = req.body?.token;
  if (token) {
    const m = await getMemberByToken(token);
    if (m && (m.status === "active" || m.status === "trialing")) return { ok: true, remaining: null, unlimited: true };
  }
  const g = checkAndConsume(req);
  if (!g.allowed) { res.status(429).json({ error: "daily_limit_reached", limit: g.limit }); return { ok: false }; }
  return { ok: true, remaining: g.remaining, unlimited: false };
}

async function run(spec, images = []) {
  const raw = await complete({ system: spec.system, user: spec.user, images, json: !!spec.json, temperature: spec.temperature ?? 0.4 });
  return parseJson(raw);
}
function errJson(res, err) {
  console.error("[error]", err.message);
  const msg = /429|quota|RESOURCE_EXHAUSTED|insufficient_quota/i.test(err.message)
    ? "The AI is over its usage limit right now. Check the provider billing/quota."
    : /401|403|API key|Incorrect API key/i.test(err.message) ? "AI provider rejected the request (check the API key)."
    : "Something went wrong processing that. Please try again.";
  res.status(502).json({ error: msg });
}

// --- billing endpoints ---
app.post("/api/checkout", async (req, res) => {
  if (!billingEnabled()) return res.status(503).json({ error: "billing_not_configured" });
  try { res.json({ url: await createCheckoutSession(`${req.protocol}://${req.get("host")}`) }); }
  catch (e) {
    const stripe = e.raw || {};
    console.error("[checkout] message:", e.message);
    console.error("[checkout] stripe:", JSON.stringify({ type: e.type, code: e.code, decline_code: e.decline_code, param: e.param, status: e.statusCode, detail: stripe.message || "" }));
    res.status(500).json({ error: "Could not start checkout.", detail: e.message });
  }
});
app.get("/api/claim", async (req, res) => {
  if (!billingEnabled()) return res.status(503).json({ error: "billing_not_configured" });
  try {
    const paid = await resolvePaidSession(String(req.query.session_id || ""));
    if (!paid) return res.status(402).json({ error: "Payment not completed." });
    res.json({ token: await ensureMember(paid.customerId, paid.subscriptionId, "active") });
  } catch (e) { console.error("[claim]", e.message); res.status(500).json({ error: "Could not verify subscription." }); }
});
app.post("/api/member", async (req, res) => {
  try {
    const token = (req.body && req.body.token) || "";
    if (!token) return res.status(400).json({ error: "missing code" });
    const m = await getMemberByToken(String(token).trim());
    res.json({ active: Boolean(m && (m.status === "active" || m.status === "trialing")) });
  } catch (e) { console.error("[member]", e.message); res.status(500).json({ error: "Could not check that code." }); }
});

// --- application tracker sync (members only; keyed by member token) ---
async function requireMember(req, res) {
  const token = (req.body && req.body.token || "").trim();
  if (!token) { res.status(401).json({ error: "membership_required" }); return null; }
  const m = await getMemberByToken(token);
  if (!m) { res.status(401).json({ error: "unknown_member" }); return null; }
  return token;
}
app.post("/api/apps/load", async (req, res) => {
  try { const t = await requireMember(req, res); if (!t) return; res.json({ applications: await getApplications(t) }); }
  catch (e) { console.error("[apps/load]", e.message); res.status(500).json({ error: "Could not load your applications." }); }
});
app.post("/api/apps/save", async (req, res) => {
  try {
    const t = await requireMember(req, res); if (!t) return;
    const apps = Array.isArray(req.body.applications) ? req.body.applications : [];
    await setApplications(t, apps);
    res.json({ ok: true });
  } catch (e) { console.error("[apps/save]", e.message); res.status(500).json({ error: "Could not save your applications." }); }
});

// --- OCR helper (not gated) ---
app.post("/api/extract", async (req, res) => {
  try {
    const { image, mime, kind } = req.body || {};
    if (!image) return res.status(400).json({ error: "No image provided." });
    const base64 = image.includes(",") ? image.split(",")[1] : image;
    const out = await run(P.extractText(kind === "jd" ? "job description" : "resume"), [{ mime: mime || "image/jpeg", data: base64 }]);
    res.json({ text: out.text || "" });
  } catch (e) { errJson(res, e); }
});

// --- Resume file upload: parse .docx / .pdf to text (not gated) ---
app.post("/api/extract-file", async (req, res) => {
  try {
    const { data, mime, filename } = req.body || {};
    if (!data) return res.status(400).json({ error: "No file provided." });
    const buf = Buffer.from(data.includes(",") ? data.split(",")[1] : data, "base64");
    const name = (filename || "").toLowerCase();
    let text = "";
    if (name.endsWith(".docx") || /officedocument|msword/i.test(mime || "")) {
      const r = await mammoth.extractRawText({ buffer: buf }); text = r.value || "";
    } else if (name.endsWith(".pdf") || /pdf/i.test(mime || "")) {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await pdfExtractText(pdf, { mergePages: true });
      text = (out && out.text) || "";
    } else {
      return res.status(400).json({ error: "Upload a .pdf or .docx file (or paste the text)." });
    }
    text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text || text.length < 30) return res.status(422).json({ error: "Couldn't read text from that file — it may be scanned or image-based. Try a screenshot upload or paste the text." });
    res.json({ text });
  } catch (e) { console.error("[extract-file]", e.message); res.status(500).json({ error: "Couldn't read that file. Please paste the text instead." }); }
});

// --- Job description from a link (not gated) ---
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}
async function safeUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid URL."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) links are supported.");
  let addrs = [];
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new Error("Couldn't resolve that link."); }
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("That link points to a private address and can't be fetched.");
  return u.toString();
}
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
app.post("/api/fetch-jd", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "Paste a job posting link." });
    const safe = await safeUrl(url);
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
    let html = "";
    try {
      const r = await fetch(safe, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; SmartJobsBot/1.0; +https://smartjobs)", "Accept": "text/html,application/xhtml+xml" } });
      const ct = r.headers.get("content-type") || "";
      if (!/text|html|xml/i.test(ct)) throw new Error("not-html");
      html = (await r.text()).slice(0, 400000);
    } finally { clearTimeout(to); }
    const text = htmlToText(html).slice(0, 18000);
    if (text.length < 120) return res.json({ found: false, note: "That page didn't return readable text — it may require a login or run entirely in JavaScript (LinkedIn/Indeed often do). Please paste the description." });
    const out = await run(P.extractJdFromPage(text));
    if (!out.found || !out.jobDescription) return res.json({ found: false, note: out.note || "Couldn't find a job posting on that page. Please paste the description." });
    const header = [out.title, out.company].filter(Boolean).join(" — ");
    res.json({ found: true, title: out.title, company: out.company, jd: (header ? header + "\n\n" : "") + out.jobDescription });
  } catch (e) {
    console.error("[fetch-jd]", e.message);
    const known = /valid URL|http\(s\)|private address|resolve/.test(e.message);
    res.status(known ? 400 : 502).json({ error: known ? e.message : "Couldn't fetch that link. Please paste the description instead." });
  }
});

// --- gated candidate endpoints ---
async function gated(req, res, spec) {
  const g = await gate(req, res); if (!g.ok) return;
  const out = await run(spec);
  res.json({ ...out, remaining: g.remaining, unlimited: g.unlimited });
}
app.post("/api/fit", async (req, res) => { try { const { jd, resume } = req.body || {}; if (!jd || !resume) return res.status(400).json({ error: "Paste both a job description and a resume." }); await gated(req, res, P.fitAnalysis(jd, resume)); } catch (e) { errJson(res, e); } });
app.post("/api/ats", async (req, res) => { try { const { jd, resume } = req.body || {}; if (!jd || !resume) return res.status(400).json({ error: "Paste both a job description and a resume." }); await gated(req, res, P.atsResume(jd, resume)); } catch (e) { errJson(res, e); } });
app.post("/api/training", async (req, res) => { try { const { jd, resume } = req.body || {}; if (!jd || !resume) return res.status(400).json({ error: "Paste both a job description and a resume." }); await gated(req, res, P.trainingPlan(jd, resume)); } catch (e) { errJson(res, e); } });
app.post("/api/interview/start", async (req, res) => { try { const { jd, resume } = req.body || {}; if (!jd || !resume) return res.status(400).json({ error: "Paste both a job description and a resume." }); await gated(req, res, P.interviewQuestions(jd, resume)); } catch (e) { errJson(res, e); } });
app.post("/api/interview/stage", async (req, res) => { try { const { jd, resume, stage } = req.body || {}; if (!jd || !resume) return res.status(400).json({ error: "Need the job description and your profile." }); await gated(req, res, P.stageInterview(jd, resume, stage || "recruiter")); } catch (e) { errJson(res, e); } });

// --- LIVE voice interview (members only, 2/day; Pro = unlimited later) ---
app.post("/api/interview/live-start", async (req, res) => {
  try {
    const { jd, resume, stage, token } = req.body || {};
    if (!jd || !resume) return res.status(400).json({ error: "Need the job description and your resume." });
    const m = token ? await getMemberByToken(String(token).trim()) : null;
    const isMember = m && (m.status === "active" || m.status === "trialing");
    if (!isMember) return res.status(402).json({ error: "paid_feature" });
    const lc = consumeLive(String(token).trim(), config.liveDailyLimit);
    if (!lc.allowed) return res.status(429).json({ error: "live_daily_limit", limit: lc.limit });
    const spec = (stage && stage !== "general") ? P.stageInterview(jd, resume, stage) : P.interviewQuestions(jd, resume);
    const out = await run(spec);
    const questions = (out.questions || []).map(q => q.q).filter(Boolean).slice(0, 5);
    if (!questions.length) throw new Error("Could not generate questions.");
    res.json({ questions, remaining: lc.remaining, limit: lc.limit });
  } catch (e) { errJson(res, e); }
});
app.post("/api/interview/live-turn", async (req, res) => {
  try {
    const { jd, resume, planned, transcript, plannedIndex } = req.body || {};
    if (!jd || !Array.isArray(planned)) return res.status(400).json({ error: "bad request" });
    res.json(await run(P.liveTurn(jd, resume || "", planned, transcript || "", plannedIndex || 0)));
  } catch (e) { errJson(res, e); }
});
app.post("/api/interview/live-summary", async (req, res) => {
  try {
    const { jd, planned, transcript } = req.body || {};
    if (!jd || !transcript) return res.status(400).json({ error: "bad request" });
    res.json(await run(P.liveSummary(jd, planned || [], transcript)));
  } catch (e) { errJson(res, e); }
});

// --- interview follow-ons (free within a started session) ---
app.post("/api/interview/feedback", async (req, res) => { try { const { jd, question, answer } = req.body || {}; if (!question || !answer) return res.status(400).json({ error: "Missing question or answer." }); res.json(await run(P.interviewFeedback(jd || "", question, answer))); } catch (e) { errJson(res, e); } });
app.post("/api/interview/summary", async (req, res) => { try { const { jd, qa } = req.body || {}; if (!Array.isArray(qa) || !qa.length) return res.status(400).json({ error: "No answers to summarize." }); res.json(await run(P.interviewSummary(jd || "", qa))); } catch (e) { errJson(res, e); } });

// --- ATS PDF (not gated; no AI) ---
app.post("/api/ats-pdf", async (req, res) => { try { const { resume } = req.body || {}; if (!resume) return res.status(400).json({ error: "No resume data." }); const pdf = await buildResumePdf(resume); res.set("Content-Type", "application/pdf"); res.set("Content-Disposition", 'attachment; filename="resume-ats.pdf"'); res.send(pdf); } catch (e) { errJson(res, e); } });

// --- gated HR endpoints ---
app.post("/api/hr/rank", async (req, res) => { try { const { jd, candidates } = req.body || {}; if (!jd || !Array.isArray(candidates) || !candidates.length) return res.status(400).json({ error: "Provide a job description and at least one candidate." }); await gated(req, res, P.hrRank(jd, candidates)); } catch (e) { errJson(res, e); } });
app.post("/api/hr/talking-points", async (req, res) => { try { const { jd, candidate } = req.body || {}; if (!jd || !candidate) return res.status(400).json({ error: "Missing job description or candidate." }); res.json(await run(P.hrTalkingPoints(jd, candidate))); } catch (e) { errJson(res, e); } });

app.listen(config.port, () => {
  const w = billingModeWarning(); if (w) console.warn("[billing] WARNING:", w);
  console.log(`rolefit up on :${config.port} — provider=${activeProvider()} billing=${billingEnabled()} stripeMode=${config.stripe.mode}`);
});
