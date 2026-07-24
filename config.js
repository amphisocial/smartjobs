// config.js
// Loads /opt/apps/smartjobs/.env automatically. PM2 environment values take precedence.
import dotenv from "dotenv";
const dotenvResult = dotenv.config({ override: false });
const fileEnv = dotenvResult.parsed || {};

// PM2 can retain an explicitly empty variable and thereby prevent dotenv from
// populating the value in process.env. Read the parsed .env file as a fallback
// for empty PM2 values, and accept common historical aliases.
function envValue(names, fallback = "") {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  for (const name of list) {
    const value = fileEnv[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function secretValue(names, fallback = "") {
  const value = envValue(names, fallback);
  // PM2 ecosystem files and shell exports sometimes preserve literal wrapping
  // quotes. Strip only one matching outer quote pair; never log the secret.
  const match = String(value).match(/^(["'])([\s\S]*)\1$/);
  return (match ? match[2] : String(value)).trim();
}

function envSource(names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") return `process:${name}`;
  }
  for (const name of list) {
    const value = fileEnv[name];
    if (value != null && String(value).trim() !== "") return `.env:${name}`;
  }
  return "missing";
}

const STRIPE_MODE = envValue("STRIPE_MODE", "test").toLowerCase();

function stripeVar(name) {
  const prefix = STRIPE_MODE === "live" ? "STRIPE_LIVE_" : "STRIPE_TEST_";
  return envValue([prefix + name, "STRIPE_" + name]);
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(envValue(name, String(fallback)), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanVar(name, fallback = false) {
  const raw = envValue(name);
  if (raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase().trim());
}

export const config = {
  provider: envValue("AI_PROVIDER", "openai").toLowerCase(),
  freeDailyLimit: positiveInt("FREE_DAILY_LIMIT", 3),
  liveDailyLimit: positiveInt("LIVE_DAILY_LIMIT", 2),

  // Recruiter free-tier limits. Paid members remain unlimited.
  recruiterFreeJobsDaily: positiveInt("RECRUITER_FREE_JOBS_DAILY", 5),
  recruiterFreeRankRunsDaily: positiveInt("RECRUITER_FREE_RANK_RUNS_DAILY", 5),
  recruiterFreeInterviewsDaily: positiveInt("RECRUITER_FREE_INTERVIEWS_DAILY", 5),

  // Candidate job-search agent limits and workflow controls.
  jobAgentFreeRunsDaily: positiveInt("JOB_AGENT_FREE_RUNS_DAILY", 5),
  jobAgentMaxQueries: positiveInt("JOB_AGENT_MAX_QUERIES", 24),
  jobAgentMaxDiscovered: positiveInt("JOB_AGENT_MAX_DISCOVERED", 100),
  jobAgentVerifyConcurrency: positiveInt("JOB_AGENT_VERIFY_CONCURRENCY", 5),
  jobAgentQueryConcurrency: positiveInt("JOB_AGENT_QUERY_CONCURRENCY", 3),
  jobAgentSearchTimeoutMs: positiveInt("JOB_AGENT_SEARCH_TIMEOUT_MS", 10000),
  jobAgentSchedulerEnabled: booleanVar("JOB_AGENT_SCHEDULER_ENABLED", true),
  jobAgentSchedulerIntervalMinutes: positiveInt("JOB_AGENT_SCHEDULER_INTERVAL_MINUTES", 15),
  jobAgentSchedulerBatchSize: positiveInt("JOB_AGENT_SCHEDULER_BATCH_SIZE", 4),
  jobAgentSearchProvider: envValue("JOB_AGENT_SEARCH_PROVIDER", "auto").toLowerCase(),
  jobAgentSearchAllowFallback: booleanVar("JOB_AGENT_SEARCH_ALLOW_FALLBACK", true),
  jobAgentSearchRssUrl: envValue("JOB_AGENT_SEARCH_RSS_URL", "https://www.bing.com/search"),
  serperApiKey: secretValue(["SERPER_API_KEY", "SERPER_KEY", "SERPER_APIKEY", "SERPERDEV_API_KEY", "JOB_AGENT_SERPER_API_KEY"]),
  serperKeySource: envSource(["SERPER_API_KEY", "SERPER_KEY", "SERPER_APIKEY", "SERPERDEV_API_KEY", "JOB_AGENT_SERPER_API_KEY"]),
  braveSearchApiKey: secretValue(["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY", "JOB_AGENT_BRAVE_API_KEY"]),
  braveKeySource: envSource(["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY", "JOB_AGENT_BRAVE_API_KEY"]),
  appBaseUrl: envValue("APP_BASE_URL"),

  // Google Identity Services. No Google client secret is required for ID-token sign-in.
  googleClientId: envValue("GOOGLE_CLIENT_ID"),
  authSessionSecret: envValue("AUTH_SESSION_SECRET"),
  recruiterSessionDays: positiveInt("RECRUITER_AUTH_SESSION_DAYS", 30),

  openai: {
    apiKey: envValue("OPENAI_API_KEY"),
    model: envValue("OPENAI_MODEL", "gpt-4o"),
    baseUrl: envValue("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  },
  gemini: {
    apiKey: envValue("GEMINI_API_KEY"),
    model: envValue("GEMINI_MODEL", "gemini-2.5-flash"),
    baseUrl: envValue("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
  },

  stripe: {
    mode: STRIPE_MODE,
    secretKey: stripeVar("SECRET_KEY"),
    priceId: stripeVar("PRICE_ID"),
    webhookSecret: stripeVar("WEBHOOK_SECRET"),
  },

  databaseUrl: envValue("DATABASE_URL"),
  // Optional dedicated SmartJobs database. Falls back to DATABASE_URL.
  jobAgentDatabaseUrl: envValue("SMARTJOBS_DATABASE_URL"),
  pgSsl: (process.env.PGSSL || "false").toLowerCase() === "true",

  smtp: {
    host: envValue("SMTP_HOST"),
    port: positiveInt("SMTP_PORT", 587),
    secure: booleanVar("SMTP_SECURE", false),
    startTls: booleanVar("SMTP_STARTTLS", true),
    rejectUnauthorized: booleanVar("SMTP_REJECT_UNAUTHORIZED", true),
    user: envValue("SMTP_USER"),
    password: envValue("SMTP_PASSWORD"),
    from: envValue("SMTP_FROM"),
    fromAddress: envValue("SMTP_FROM_ADDRESS"),
    heloName: envValue("SMTP_HELO_NAME", "smartjobs.local"),
  },

  port: Number.parseInt(envValue("PORT", "3000"), 10),
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
