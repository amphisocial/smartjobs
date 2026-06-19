// server.js
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertConfig, activeProvider, billingEnabled, billingModeWarning } from "./config.js";
import { complete, parseJson } from "./lib/providers.js";
import * as P from "./lib/prompts.js";
import { buildResumePdf } from "./lib/pdf.js";
import { initStore, ensureMember, getMemberByToken, setStatusByCustomer, getApplications, setApplications } from "./lib/store.js";
import { createCheckoutSession, resolvePaidSession, constructWebhookEvent } from "./lib/billing.js";
import { checkAndConsume } from "./lib/ratelimit.js";

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
app.get("/api/config", (_req, res) => res.json({ billingEnabled: billingEnabled() }));

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
  catch (e) { console.error("[checkout]", e.message); res.status(500).json({ error: "Could not start checkout." }); }
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
