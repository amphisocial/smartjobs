// lib/billing.js — Stripe operations (checkout, claim, webhook verify).
import Stripe from "stripe";
import { config, billingEnabled } from "../config.js";
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

export async function createCheckoutSession(origin) {
  if (!billingEnabled()) throw new Error("Billing not configured.");
  const s = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
  });
  return s.url;
}
export async function resolvePaidSession(sessionId) {
  if (!billingEnabled()) throw new Error("Billing not configured.");
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  const paid = s.payment_status === "paid" || s.status === "complete";
  if (!paid) return null;
  return { customerId: s.customer, subscriptionId: s.subscription };
}
export function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("Stripe not configured.");
  if (!config.stripe.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not set.");
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
