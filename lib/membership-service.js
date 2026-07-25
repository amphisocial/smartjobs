import { config, billingEnabled } from "../config.js";
import { ensureMember, getMemberByToken } from "./store.js";
import {
  findActiveSubscriptionByEmail,
  hasSubscriptionHistoryByEmail,
  getConfiguredPriceDetails,
  getSubscriptionDetails,
  extendSubscriptionFreeDays,
} from "./billing.js";
import {
  upsertMembershipAccount,
  getMembershipAccount,
  bindMembershipToken,
  markMembershipTrialUsed,
  createReferralInvite,
  markReferralEmailSent,
  getReferralByCode,
  getReferralById,
  listReferrals,
  qualifyReferral,
  listPendingReferralRewards,
  claimReferralReward,
  releaseReferralReward,
  markReferralRewarded,
} from "./membership-store.js";
import { smtpConfigured, sendSmtpMail } from "./smtp-mailer.js";

function activeMember(member) {
  return Boolean(member && ["active", "trialing"].includes(member.status));
}
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
export function canonicalGmailAddress(value) {
  const email = normalizeEmail(value);
  const match = email.match(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@gmail\.com$/i);
  if (!match) return "";
  const local = match[1].split("+")[0].replace(/\./g, "");
  return local ? `${local}@gmail.com` : "";
}
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function resolveMembershipForUser(user, suppliedToken = "", checkStripe = true) {
  let account = await upsertMembershipAccount(user, null);
  let memberToken = String(suppliedToken || account?.member_token || "").trim();
  let member = memberToken ? await getMemberByToken(memberToken) : null;

  if (suppliedToken && activeMember(member)) {
    await bindMembershipToken(user.sub, memberToken);
    await markMembershipTrialUsed(user.sub);
    account = await getMembershipAccount(user.sub);
  }

  if (!activeMember(member) && billingEnabled() && checkStripe) {
    const paid = await findActiveSubscriptionByEmail(user.email).catch(error => {
      console.warn(`[membership] Stripe entitlement lookup failed for ${user.email}:`, error.message);
      return null;
    });
    if (paid) {
      memberToken = await ensureMember(paid.customerId, paid.subscriptionId, paid.status);
      await bindMembershipToken(user.sub, memberToken);
      await markMembershipTrialUsed(user.sub);
      member = await getMemberByToken(memberToken);
      account = await getMembershipAccount(user.sub);
    }
  }

  return { account, member, memberToken: activeMember(member) ? memberToken : "", paid: activeMember(member) };
}

export async function membershipOverview(user, suppliedToken = "") {
  const resolved = await resolveMembershipForUser(user, suppliedToken, true);
  let subscription = null;
  if (resolved.member?.subscription_id) {
    subscription = await getSubscriptionDetails(resolved.member.subscription_id).catch(error => {
      console.warn("[membership] subscription details unavailable:", error.message);
      return null;
    });
  }
  const [price, referrals, subscriptionHistory] = await Promise.all([
    getConfiguredPriceDetails().catch(() => null),
    listReferrals(user.sub),
    resolved.paid ? Promise.resolve(true) : hasSubscriptionHistoryByEmail(user.email).catch(() => Boolean(resolved.account?.trial_used)),
  ]);
  const trialEligible = !resolved.paid && !resolved.account?.trial_used && !subscriptionHistory;
  return {
    user,
    paid: resolved.paid,
    memberToken: resolved.memberToken,
    memberStatus: subscription?.status || resolved.member?.status || "free",
    subscription,
    price,
    trialDays: config.membershipTrialDays,
    trialEligible,
    referralRewardDays: config.referralRewardDays,
    smtpConfigured: smtpConfigured(),
    referrals,
  };
}

export async function validateReferralForCheckout(inviteCode, user) {
  if (!inviteCode) return null;
  const referral = await getReferralByCode(String(inviteCode).trim());
  if (!referral) throw new Error("referral_not_found");
  if (canonicalGmailAddress(referral.invitee_email) !== canonicalGmailAddress(user.email)) throw new Error("referral_email_mismatch");
  if (String(referral.inviter_sub) === String(user.sub)) throw new Error("self_referral_not_allowed");
  if (["rewarded", "rewarding"].includes(referral.status)) throw new Error("referral_already_used");
  return referral;
}

export async function sendReferralInvite(user, inviteeEmail, origin) {
  if (!smtpConfigured()) throw new Error("smtp_not_configured");
  const email = canonicalGmailAddress(inviteeEmail);
  if (!email) throw new Error("gmail_address_required");
  if (email === canonicalGmailAddress(user.email)) throw new Error("self_referral_not_allowed");

  await upsertMembershipAccount(user, null);
  const referral = await createReferralInvite(user, email, config.referralRewardDays);
  if (referral.status !== "created") throw new Error("invitee_already_invited");
  const base = String(config.appBaseUrl || origin || "").replace(/\/$/, "");
  const link = `${base}/membership.html?ref=${encodeURIComponent(referral.invite_code)}`;
  const inviterName = user.name || user.email;
  const subject = `${inviterName} invited you to try SmartJobs free`;
  const text = [
    `Hi,`, "", `${inviterName} invited you to SmartJobs.`,
    `Use Job Fit, ATS resume tools, live AI interviews, the application tracker, recruiter tools, and agentic job search with a ${config.membershipTrialDays}-day free trial.`,
    "", `Accept the invitation: ${link}`, "",
    `Sign in with this Gmail address (${email}) so the invitation can be verified.`,
  ].join("\n");
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#172033;line-height:1.55;max-width:620px;margin:auto">
    <h2 style="margin-bottom:8px">You’re invited to SmartJobs</h2>
    <p><strong>${escapeHtml(inviterName)}</strong> invited you to try the complete SmartJobs workspace.</p>
    <p>Use Job Fit, ATS resume tools, live AI interviews, the application tracker, recruiter tools, and agentic job search with a <strong>${config.membershipTrialDays}-day free trial</strong>.</p>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:700">Accept invitation</a></p>
    <p style="color:#667085;font-size:13px">Sign in with ${escapeHtml(email)} so SmartJobs can verify the invitation. SmartJobs never submits job applications automatically.</p>
  </div>`;
  await sendSmtpMail({ to: email, subject, text, html });
  return markReferralEmailSent(referral.id);
}

async function sendRewardEmail(referral, subscription) {
  if (!smtpConfigured()) return;
  const subject = `${referral.reward_days} free SmartJobs days added`;
  const end = subscription?.trialEnd ? new Date(subscription.trialEnd * 1000).toLocaleDateString("en-US") : "your updated billing date";
  const text = `Your referral qualified. ${referral.reward_days} additional free days were added to your SmartJobs membership. Your updated free-access date is ${end}.`;
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#172033;line-height:1.55"><h2>Referral reward applied</h2><p><strong>${referral.reward_days} additional free days</strong> were added to your SmartJobs membership.</p><p>Your updated free-access date is ${escapeHtml(end)}.</p></div>`;
  await sendSmtpMail({ to: referral.inviter_email, subject, text, html }).catch(error => console.warn("[membership] reward email failed:", error.message));
}

export async function applyReferralReward(referralId) {
  const claimed = await claimReferralReward(referralId);
  if (!claimed) return false;
  try {
    const account = await getMembershipAccount(claimed.inviter_sub);
    const member = account?.member_token ? await getMemberByToken(account.member_token) : null;
    if (!activeMember(member) || !member.subscription_id) {
      await releaseReferralReward(claimed.id);
      return false;
    }
    const subscription = await extendSubscriptionFreeDays(member.subscription_id, claimed.reward_days || config.referralRewardDays);
    const rewarded = await markReferralRewarded(claimed.id);
    await sendRewardEmail(rewarded, subscription);
    return true;
  } catch (error) {
    await releaseReferralReward(claimed.id).catch(() => {});
    console.error("[membership] referral reward failed:", error.message);
    return false;
  }
}

export async function applyPendingReferralRewardsForInviter(inviterSub) {
  if (!inviterSub) return 0;
  const pending = await listPendingReferralRewards(inviterSub);
  let applied = 0;
  for (const referral of pending) if (await applyReferralReward(referral.id)) applied += 1;
  return applied;
}

export async function processMembershipCheckout(session) {
  const metadata = session?.metadata || {};
  const subscriptionId = String(session?.subscription || "");
  const customerId = String(session?.customer || "");
  if (!subscriptionId || !customerId) return null;
  const details = await getSubscriptionDetails(subscriptionId).catch(() => null);
  const status = details?.status || (session.payment_status === "no_payment_required" ? "trialing" : "active");
  const memberToken = await ensureMember(customerId, subscriptionId, status);

  const googleSub = String(metadata.smartjobs_google_sub || "");
  const email = normalizeEmail(metadata.smartjobs_email || session.customer_details?.email || session.customer_email || "");
  if (googleSub && email) {
    await upsertMembershipAccount({
      sub: googleSub,
      email,
      name: metadata.smartjobs_name || email,
      picture: "",
    }, memberToken);
    await bindMembershipToken(googleSub, memberToken);
    await markMembershipTrialUsed(googleSub);
  }

  const referralId = String(metadata.smartjobs_referral_id || "");
  if (referralId) {
    const referral = await getReferralById(referralId);
    if (referral && canonicalGmailAddress(referral.invitee_email) === canonicalGmailAddress(email) && referral.inviter_sub !== googleSub) {
      await qualifyReferral(referral.id, { sub: googleSub || null, customerId, subscriptionId });
      await applyReferralReward(referral.id);
    }
  }
  if (googleSub) await applyPendingReferralRewardsForInviter(googleSub);
  return { memberToken, status };
}
