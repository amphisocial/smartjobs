// config.js
// -----------------------------------------------------------------------------
// AI provider switch (AI_PROVIDER=openai|gemini) + Stripe billing with a
// test/live mode switch (STRIPE_MODE=test|live). Set all of these as Railway
// Variables; keys never get committed to git.
// -----------------------------------------------------------------------------

const STRIPE_MODE = (process.env.STRIPE_MODE || "test").toLowerCase().trim();
function stripeVar(name) {
  const prefix = STRIPE_MODE === "live" ? "STRIPE_LIVE_" : "STRIPE_TEST_";
  return (process.env[prefix + name] || process.env["STRIPE_" + name] || "").trim();
}
function buildStripeConfig() {
  return {
    mode: STRIPE_MODE,
    secretKey: stripeVar("SECRET_KEY"),
    priceId: stripeVar("PRICE_ID"),
    webhookSecret: stripeVar("WEBHOOK_SECRET"),
  };
}

export const config = {
  provider: (process.env.AI_PROVIDER || "openai").toLowerCase().trim(),

  // How many free AI "runs" per visitor per day before the paywall.
  freeDailyLimit: parseInt(process.env.FREE_DAILY_LIMIT || "3", 10),

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

  // Billing: STRIPE_MODE picks which key set is active (store both, flip to switch).
  stripe: buildStripeConfig(),

  databaseUrl: process.env.DATABASE_URL || "",
  pgSsl: (process.env.PGSSL || "false").toLowerCase() === "true",

  port: parseInt(process.env.PORT || "3000", 10),
};

export function assertConfig() {
  const p = config.provider;
  if (p !== "openai" && p !== "gemini") throw new Error(`AI_PROVIDER must be "openai" or "gemini", got "${p}"`);
  if (p === "openai" && !config.openai.apiKey) throw new Error("AI_PROVIDER=openai but OPENAI_API_KEY is not set");
  if (p === "gemini" && !config.gemini.apiKey) throw new Error("AI_PROVIDER=gemini but GEMINI_API_KEY is not set");
}

export function activeProvider() { return config.provider; }

export function billingEnabled() {
  return Boolean(config.stripe.secretKey && config.stripe.priceId);
}

export function billingModeWarning() {
  if (!billingEnabled()) return null;
  const k = config.stripe.secretKey, m = config.stripe.mode;
  if (m === "live" && k.startsWith("sk_test_")) return "STRIPE_MODE=live but the active key is sk_test_ — real cards won't charge. Check STRIPE_LIVE_SECRET_KEY.";
  if (m === "test" && k.startsWith("sk_live_")) return "STRIPE_MODE=test but the active key is sk_live_ — test cards will be REJECTED. Check STRIPE_TEST_SECRET_KEY.";
  return null;
}
