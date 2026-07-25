import { config, billingEnabled, googleAuthEnabled } from "../config.js";
import { getMemberByToken } from "./store.js";
import {
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscriptionAtPeriodEnd,
  resumeSubscription,
  getConfiguredPriceDetails,
} from "./billing.js";
import { verifyRecruiterSession } from "./google-auth.js";
import { initMembershipStore, membershipStoreReady, getReferralByCode } from "./membership-store.js";
import {
  resolveMembershipForUser,
  membershipOverview,
  validateReferralForCheckout,
  sendReferralInvite,
  applyPendingReferralRewardsForInviter,
  canonicalGmailAddress,
} from "./membership-service.js";

function activeMember(member) {
  return Boolean(member && ["active", "trialing"].includes(member.status));
}

async function authenticate(req, res) {
  const user = verifyRecruiterSession(String(req.body?.recruiterSession || "").trim());
  if (!user) {
    res.status(401).json({ error: "google_signin_required", message: "Sign in with Google to manage membership." });
    return null;
  }
  return user;
}

function knownError(res, error) {
  const code = error.message;
  if (code === "gmail_address_required") return res.status(400).json({ error: "Enter a valid @gmail.com address." });
  if (code === "self_referral_not_allowed") return res.status(400).json({ error: "You cannot invite your own account." });
  if (code === "invitee_already_invited") return res.status(409).json({ error: "That Gmail address already has a SmartJobs invitation." });
  if (code === "smtp_not_configured") return res.status(503).json({ error: "Referral email is not configured on the server yet." });
  if (code === "referral_not_found") return res.status(404).json({ error: "This invitation link is no longer valid." });
  if (code === "referral_email_mismatch") return res.status(403).json({ error: "Sign in with the Gmail address that received this invitation." });
  if (code === "referral_already_used") return res.status(409).json({ error: "This invitation has already been used." });
  console.error("[membership]", error.message);
  return res.status(500).json({ error: "Membership request failed. Check the PM2 log for details." });
}

export async function installMembershipRoutes(app) {
  await initMembershipStore();

  app.get("/api/membership/public", async (_req, res) => {
    const price = await getConfiguredPriceDetails().catch(() => null);
    res.json({
      billingEnabled: billingEnabled(),
      googleAuthEnabled: googleAuthEnabled(),
      price,
      trialDays: config.membershipTrialDays,
      referralRewardDays: config.referralRewardDays,
    });
  });

  app.post("/api/membership/bootstrap", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      await applyPendingReferralRewardsForInviter(user.sub);
      const overview = await membershipOverview(user, String(req.body?.token || ""));
      let invitation = null;
      if (req.body?.referralCode) {
        const referral = await getReferralByCode(String(req.body.referralCode));
        if (referral) {
          invitation = {
            validForUser: canonicalGmailAddress(referral.invitee_email) === canonicalGmailAddress(user.email),
            inviterName: referral.inviter_name || "A SmartJobs member",
            inviteeEmail: referral.invitee_email,
            status: referral.status,
          };
        }
      }
      res.json({ ...overview, invitation, membershipStoreReady: membershipStoreReady() });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/membership/checkout", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      if (!billingEnabled()) return res.status(503).json({ error: "Paid memberships are not configured yet." });
      const overview = await membershipOverview(user, String(req.body?.token || ""));
      if (overview.paid) return res.status(409).json({ error: "Your membership is already active." });
      const referral = await validateReferralForCheckout(req.body?.referralCode, user);
      const origin = `${req.protocol}://${req.get("host")}`;
      const metadata = {
        product: "smartjobs_complete",
        smartjobs_google_sub: user.sub,
        smartjobs_email: user.email,
        smartjobs_name: user.name,
        smartjobs_referral_id: referral?.id || "",
      };
      const url = await createCheckoutSession(origin, {
        customerEmail: user.email,
        clientReferenceId: `google:${user.sub}`,
        metadata,
        subscriptionMetadata: metadata,
        trialPeriodDays: overview.trialEligible ? config.membershipTrialDays : 0,
        successUrl: `${origin}/membership.html?checkout=success`,
        cancelUrl: `${origin}/membership.html?checkout=cancelled`,
      });
      res.json({ url });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/membership/portal", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      const resolved = await resolveMembershipForUser(user, String(req.body?.token || ""), true);
      if (!resolved.member?.customer_id) return res.status(404).json({ error: "No Stripe membership was found for this account." });
      const origin = `${req.protocol}://${req.get("host")}`;
      res.json({ url: await createBillingPortalSession(resolved.member.customer_id, `${origin}/membership.html`) });
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/membership/cancel", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      const resolved = await resolveMembershipForUser(user, String(req.body?.token || ""), true);
      if (!activeMember(resolved.member) || !resolved.member.subscription_id) return res.status(404).json({ error: "No active membership was found." });
      await cancelSubscriptionAtPeriodEnd(resolved.member.subscription_id);
      res.json(await membershipOverview(user, resolved.memberToken));
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/membership/resume", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      const resolved = await resolveMembershipForUser(user, String(req.body?.token || ""), true);
      if (!resolved.member?.subscription_id) return res.status(404).json({ error: "No membership was found." });
      await resumeSubscription(resolved.member.subscription_id);
      res.json(await membershipOverview(user, resolved.memberToken));
    } catch (error) { knownError(res, error); }
  });

  app.post("/api/membership/invite", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      const origin = `${req.protocol}://${req.get("host")}`;
      await sendReferralInvite(user, req.body?.email, origin);
      res.json(await membershipOverview(user, String(req.body?.token || "")));
    } catch (error) { knownError(res, error); }
  });

  // Retain code-based access for users moving a paid membership to another device.
  app.post("/api/membership/redeem", async (req, res) => {
    try {
      const user = await authenticate(req, res); if (!user) return;
      const token = String(req.body?.memberCode || "").trim();
      const member = token ? await getMemberByToken(token) : null;
      if (!activeMember(member)) return res.status(400).json({ error: "That member code is not active." });
      const overview = await membershipOverview(user, token);
      res.json(overview);
    } catch (error) { knownError(res, error); }
  });
}
