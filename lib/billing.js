// lib/billing.js — Stripe operations (checkout, claim, webhook verify).
import Stripe from "stripe";
import { config, billingEnabled } from "../config.js";
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

export async function createCheckoutSession(origin, options = {}) {
  if (!billingEnabled()) throw new Error("Billing not configured.");
  const cleanOrigin = String(origin || "").replace(/\/$/, "");
  const payload = {
    mode: "subscription",
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: options.successUrl || `${cleanOrigin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: options.cancelUrl || `${cleanOrigin}/`,
  };
  if (options.customerEmail) payload.customer_email = String(options.customerEmail).trim().toLowerCase();
  if (options.clientReferenceId) payload.client_reference_id = String(options.clientReferenceId).slice(0, 200);
  if (options.metadata && typeof options.metadata === "object") payload.metadata = options.metadata;
  const session = await stripe.checkout.sessions.create(payload);
  return session.url;
}

export async function resolvePaidSession(sessionId) {
  if (!billingEnabled()) throw new Error("Billing not configured.");
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const paid = session.payment_status === "paid" || session.status === "complete";
  if (!paid) return null;
  return { customerId: session.customer, subscriptionId: session.subscription };
}

// Lets Google-authenticated users recover paid access without re-entering a member code.
// Stripe customer email is matched only to a verified Google email, and the subscription
// must currently be active or trialing.
export async function findActiveSubscriptionByEmail(email) {
  if (!billingEnabled() || !stripe || !email) return null;
  const normalized = String(email).trim().toLowerCase();
  const customers = await stripe.customers.list({ email: normalized, limit: 20 });
  for (const customer of customers.data || []) {
    const subscriptions = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 20 });
    const subscription = (subscriptions.data || [])
      .filter(item => ["active", "trialing"].includes(item.status))
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0];
    if (subscription) {
      return { customerId: customer.id, subscriptionId: subscription.id, status: subscription.status };
    }
  }
  return null;
}

export function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("Stripe not configured.");
  if (!config.stripe.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not set.");
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
