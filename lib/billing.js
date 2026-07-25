// lib/billing.js — Stripe operations for checkout, subscriptions and billing management.
import Stripe from "stripe";
import { config, billingEnabled } from "../config.js";

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

function compactMetadata(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && String(item) !== "")
    .map(([key, item]) => [String(key).slice(0, 40), String(item).slice(0, 500)]));
}

function periodEnd(subscription) {
  return Number(subscription?.current_period_end || subscription?.items?.data?.[0]?.current_period_end || 0);
}

export async function createCheckoutSession(origin, options = {}) {
  if (!billingEnabled() || !stripe) throw new Error("Billing not configured.");
  const cleanOrigin = String(origin || "").replace(/\/$/, "");
  const metadata = compactMetadata(options.metadata);
  const subscriptionMetadata = compactMetadata(options.subscriptionMetadata || metadata);
  const trialDays = Math.max(0, Number(options.trialPeriodDays || 0));

  const payload = {
    mode: "subscription",
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: options.successUrl || `${cleanOrigin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: options.cancelUrl || `${cleanOrigin}/membership.html?checkout=cancelled`,
  };
  if (options.customerEmail) payload.customer_email = String(options.customerEmail).trim().toLowerCase();
  if (options.clientReferenceId) payload.client_reference_id = String(options.clientReferenceId).slice(0, 200);
  if (Object.keys(metadata).length) payload.metadata = metadata;
  if (trialDays > 0 || Object.keys(subscriptionMetadata).length) {
    payload.subscription_data = {};
    if (trialDays > 0) {
      payload.subscription_data.trial_period_days = trialDays;
      payload.payment_method_collection = "always";
    }
    if (Object.keys(subscriptionMetadata).length) payload.subscription_data.metadata = subscriptionMetadata;
  }

  const session = await stripe.checkout.sessions.create(payload);
  return session.url;
}

export async function resolvePaidSession(sessionId) {
  if (!billingEnabled() || !stripe) throw new Error("Billing not configured.");
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const complete = session.payment_status === "paid" || session.payment_status === "no_payment_required" || session.status === "complete";
  if (!complete || !session.customer || !session.subscription) return null;
  const subscription = await stripe.subscriptions.retrieve(String(session.subscription));
  return {
    customerId: String(session.customer),
    subscriptionId: String(session.subscription),
    status: subscription.status || "active",
  };
}

export async function getConfiguredPriceDetails() {
  if (!billingEnabled() || !stripe) return null;
  const price = await stripe.prices.retrieve(config.stripe.priceId, { expand: ["product"] });
  return {
    priceId: price.id,
    unitAmount: Number(price.unit_amount || 0),
    currency: String(price.currency || "usd").toUpperCase(),
    interval: price.recurring?.interval || "month",
    intervalCount: Number(price.recurring?.interval_count || 1),
    productName: typeof price.product === "object" ? String(price.product.name || "SmartJobs Complete") : "SmartJobs Complete",
  };
}

export async function getSubscriptionDetails(subscriptionId) {
  if (!billingEnabled() || !stripe || !subscriptionId) return null;
  const subscription = await stripe.subscriptions.retrieve(String(subscriptionId), {
    expand: ["items.data.price.product"],
  });
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  return {
    id: subscription.id,
    customerId: String(subscription.customer || ""),
    status: subscription.status,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    canceledAt: subscription.canceled_at || null,
    trialEnd: subscription.trial_end || null,
    currentPeriodEnd: periodEnd(subscription) || null,
    unitAmount: Number(price?.unit_amount || 0),
    currency: String(price?.currency || "usd").toUpperCase(),
    interval: price?.recurring?.interval || "month",
    intervalCount: Number(price?.recurring?.interval_count || 1),
    productName: typeof price?.product === "object" ? String(price.product.name || "SmartJobs Complete") : "SmartJobs Complete",
  };
}

export async function createBillingPortalSession(customerId, returnUrl) {
  if (!billingEnabled() || !stripe || !customerId) throw new Error("Billing portal is unavailable.");
  const session = await stripe.billingPortal.sessions.create({
    customer: String(customerId),
    return_url: String(returnUrl),
  });
  return session.url;
}

export async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  if (!billingEnabled() || !stripe || !subscriptionId) throw new Error("Subscription not found.");
  const subscription = await stripe.subscriptions.update(String(subscriptionId), { cancel_at_period_end: true });
  return getSubscriptionDetails(subscription.id);
}

export async function resumeSubscription(subscriptionId) {
  if (!billingEnabled() || !stripe || !subscriptionId) throw new Error("Subscription not found.");
  const subscription = await stripe.subscriptions.update(String(subscriptionId), { cancel_at_period_end: false });
  return getSubscriptionDetails(subscription.id);
}

export async function extendSubscriptionFreeDays(subscriptionId, days) {
  if (!billingEnabled() || !stripe || !subscriptionId) throw new Error("Subscription not found.");
  const addDays = Math.max(1, Number(days || 0));
  const subscription = await stripe.subscriptions.retrieve(String(subscriptionId));
  if (!["active", "trialing"].includes(subscription.status)) throw new Error("subscription_not_active");
  const now = Math.floor(Date.now() / 1000);
  const base = subscription.status === "trialing"
    ? Math.max(now, Number(subscription.trial_end || 0))
    : Math.max(now, periodEnd(subscription));
  const trialEnd = base + addDays * 86400;
  const updated = await stripe.subscriptions.update(String(subscriptionId), {
    trial_end: trialEnd,
    proration_behavior: "none",
  });
  return getSubscriptionDetails(updated.id);
}

export async function hasSubscriptionHistoryByEmail(email) {
  if (!billingEnabled() || !stripe || !email) return false;
  const normalized = String(email).trim().toLowerCase();
  const customers = await stripe.customers.list({ email: normalized, limit: 20 });
  for (const customer of customers.data || []) {
    const subscriptions = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 1 });
    if ((subscriptions.data || []).length) return true;
  }
  return false;
}

// Lets Google-authenticated users recover paid access without re-entering a member code.
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
