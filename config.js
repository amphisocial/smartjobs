// config.js
// Loads /opt/apps/smartjobs/.env automatically. PM2 environment values take precedence.
import dotenv from "dotenv";
dotenv.config({ override: false });

const STRIPE_MODE = (process.env.STRIPE_MODE || "test").toLowerCase().trim();

function stripeVar(name) {
  const prefix = STRIPE_MODE === "live" ? "STRIPE_LIVE_" : "STRIPE_TEST_";
  return (process.env[prefix + name] || process.env["STRIPE_" + name] || "").trim();
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  provider: (process.env.AI_PROVIDER || "openai").toLowerCase().trim(),
  freeDailyLimit: positiveInt("FREE_DAILY_LIMIT", 3),
  liveDailyLimit: positiveInt("LIVE_DAILY_LIMIT", 2),

  // Recruiter free-tier limits. Paid members remain unlimited.
  recruiterFreeJobsDaily: positiveInt("RECRUITER_FREE_JOBS_DAILY", 5),
  recruiterFreeRankRunsDaily: positiveInt("RECRUITER_FREE_RANK_RUNS_DAILY", 5),
  recruiterFreeInterviewsDaily: positiveInt("RECRUITER_FREE_INTERVIEWS_DAILY", 5),

  // Google Identity Services. No Google client secret is required for ID-token sign-in.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  authSessionSecret: (process.env.AUTH_SESSION_SECRET || "").trim(),
  recruiterSessionDays: positiveInt("RECRUITER_AUTH_SESSION_DAYS", 30),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
  },

  stripe: {
    mode: STRIPE_MODE,
    secretKey: stripeVar("SECRET_KEY"),
    priceId: stripeVar("PRICE_ID"),
    webhookSecret: stripeVar("WEBHOOK_SECRET"),
  },

  databaseUrl: (process.env.DATABASE_URL || "").trim(),
  pgSsl: (process.env.PGSSL || "false").toLowerCase() === "true",
  port: Number.parseInt(process.env.PORT || "3000", 10),
};

export function assertConfig() {
  if (!["openai", "gemini"].includes(config.provider)) {
    throw new Error(`AI_PROVIDER must be "openai" or "gemini", got "${config.provider}"`);
  }
  if (config.provider === "openai" && !config.openai.apiKey) {
    throw new Error("AI_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  if (config.provider === "gemini" && !config.gemini.apiKey) {
    throw new Error("AI_PROVIDER=gemini but GEMINI_API_KEY is not set");
  }
  if (config.googleClientId && !config.authSessionSecret) {
    throw new Error("GOOGLE_CLIENT_ID is set but AUTH_SESSION_SECRET is missing");
  }
}

export function activeProvider() { return config.provider; }
export function billingEnabled() { return Boolean(config.stripe.secretKey && config.stripe.priceId); }
export function googleAuthEnabled() { return Boolean(config.googleClientId && config.authSessionSecret); }

export function billingModeWarning() {
  if (!billingEnabled()) return null;
  const k = config.stripe.secretKey;
  const m = config.stripe.mode;
  if (m === "live" && k.startsWith("sk_test_")) {
    return "STRIPE_MODE=live but the active key is sk_test_. Check STRIPE_LIVE_SECRET_KEY.";
  }
  if (m === "test" && k.startsWith("sk_live_")) {
    return "STRIPE_MODE=test but the active key is sk_live_. Check STRIPE_TEST_SECRET_KEY.";
  }
  return null;
}
