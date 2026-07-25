import crypto from "node:crypto";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
const usingPg = Boolean(config.databaseUrl);
let pool = null;
let ready = false;

const accountsMem = new Map();
const referralsMem = new Map();

function code() { return `sjref_${crypto.randomBytes(18).toString("hex")}`; }
function id() { return crypto.randomUUID(); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }

export async function initMembershipStore() {
  if (ready) return;
  if (!usingPg) {
    console.warn("[membership-store] No DATABASE_URL — referral and account links are in memory only.");
    ready = true;
    return;
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
  });
  pool.on("error", error => console.error("[membership-store] PostgreSQL pool error", error));
  await pool.query(`CREATE TABLE IF NOT EXISTS membership_accounts (
    google_sub TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    picture TEXT,
    member_token TEXT,
    trial_used BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE membership_accounts ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS membership_accounts_email_unique
    ON membership_accounts (lower(email))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS membership_referrals (
    id TEXT PRIMARY KEY,
    invite_code TEXT UNIQUE NOT NULL,
    inviter_sub TEXT NOT NULL REFERENCES membership_accounts(google_sub) ON DELETE CASCADE,
    inviter_email TEXT NOT NULL,
    inviter_name TEXT,
    invitee_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    reward_days INTEGER NOT NULL DEFAULT 7,
    invitee_sub TEXT,
    invitee_customer_id TEXT,
    invitee_subscription_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    email_sent_at TIMESTAMPTZ,
    qualified_at TIMESTAMPTZ,
    rewarded_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(inviter_sub, invitee_email)
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS membership_referrals_invitee_unique
    ON membership_referrals (lower(invitee_email))`);
  ready = true;
  console.log("[membership-store] Postgres ready.");
}

export function membershipStoreReady() { return ready; }

export async function upsertMembershipAccount(user, memberToken = null) {
  const record = {
    google_sub: String(user.sub),
    email: normalizeEmail(user.email),
    display_name: String(user.name || user.email || ""),
    picture: String(user.picture || ""),
    member_token: memberToken || null,
  };
  if (!usingPg) {
    const existing = accountsMem.get(record.google_sub) || {};
    const saved = { ...existing, ...record, member_token: memberToken || existing.member_token || null, updated_at: new Date().toISOString() };
    accountsMem.set(record.google_sub, saved);
    return saved;
  }
  const result = await pool.query(`INSERT INTO membership_accounts
    (google_sub,email,display_name,picture,member_token,updated_at)
    VALUES ($1,$2,$3,$4,$5,now())
    ON CONFLICT (google_sub) DO UPDATE SET
      email=EXCLUDED.email,
      display_name=EXCLUDED.display_name,
      picture=EXCLUDED.picture,
      member_token=COALESCE(EXCLUDED.member_token,membership_accounts.member_token),
      updated_at=now()
    RETURNING *`, [record.google_sub, record.email, record.display_name, record.picture, record.member_token]);
  return result.rows[0];
}

export async function getMembershipAccount(googleSub) {
  if (!googleSub) return null;
  if (!usingPg) return accountsMem.get(String(googleSub)) || null;
  const result = await pool.query("SELECT * FROM membership_accounts WHERE google_sub=$1", [String(googleSub)]);
  return result.rows[0] || null;
}

export async function bindMembershipToken(googleSub, memberToken) {
  if (!googleSub || !memberToken) return null;
  if (!usingPg) {
    const existing = accountsMem.get(String(googleSub));
    if (!existing) return null;
    existing.member_token = String(memberToken);
    existing.updated_at = new Date().toISOString();
    return existing;
  }
  const result = await pool.query(`UPDATE membership_accounts SET member_token=$1,updated_at=now()
    WHERE google_sub=$2 RETURNING *`, [String(memberToken), String(googleSub)]);
  return result.rows[0] || null;
}

export async function markMembershipTrialUsed(googleSub) {
  if (!googleSub) return null;
  if (!usingPg) {
    const existing = accountsMem.get(String(googleSub));
    if (!existing) return null;
    existing.trial_used = true;
    existing.updated_at = new Date().toISOString();
    return existing;
  }
  const result = await pool.query(`UPDATE membership_accounts SET trial_used=true,updated_at=now()
    WHERE google_sub=$1 RETURNING *`, [String(googleSub)]);
  return result.rows[0] || null;
}

export async function createReferralInvite(inviter, inviteeEmail, rewardDays) {
  const normalized = normalizeEmail(inviteeEmail);
  const existingId = [...referralsMem.values()].find(item => item.invitee_email === normalized)?.id;
  if (!usingPg) {
    if (existingId) {
      const existing = referralsMem.get(existingId);
      if (existing.inviter_sub !== inviter.sub) throw new Error("invitee_already_invited");
      return existing;
    }
    const referral = {
      id: id(), invite_code: code(), inviter_sub: inviter.sub, inviter_email: normalizeEmail(inviter.email),
      inviter_name: inviter.name || inviter.email, invitee_email: normalized, status: "created",
      reward_days: Number(rewardDays || 7), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    referralsMem.set(referral.id, referral);
    return referral;
  }
  try {
    const result = await pool.query(`INSERT INTO membership_referrals
      (id,invite_code,inviter_sub,inviter_email,inviter_name,invitee_email,reward_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (inviter_sub,invitee_email) DO UPDATE SET updated_at=now()
      RETURNING *`, [id(), code(), String(inviter.sub), normalizeEmail(inviter.email), String(inviter.name || inviter.email), normalized, Number(rewardDays || 7)]);
    return result.rows[0];
  } catch (error) {
    if (error.code !== "23505") throw error;
    const existing = await pool.query("SELECT * FROM membership_referrals WHERE lower(invitee_email)=lower($1)", [normalized]);
    if (existing.rows[0]?.inviter_sub === String(inviter.sub)) return existing.rows[0];
    throw new Error("invitee_already_invited");
  }
}

export async function markReferralEmailSent(referralId) {
  if (!usingPg) {
    const item = referralsMem.get(String(referralId));
    if (!item) return null;
    item.status = item.status === "created" ? "sent" : item.status;
    item.email_sent_at = new Date().toISOString();
    item.updated_at = item.email_sent_at;
    return item;
  }
  const result = await pool.query(`UPDATE membership_referrals SET
    status=CASE WHEN status='created' THEN 'sent' ELSE status END,
    email_sent_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [String(referralId)]);
  return result.rows[0] || null;
}

export async function getReferralByCode(inviteCode) {
  if (!inviteCode) return null;
  if (!usingPg) return [...referralsMem.values()].find(item => item.invite_code === String(inviteCode)) || null;
  const result = await pool.query("SELECT * FROM membership_referrals WHERE invite_code=$1", [String(inviteCode)]);
  return result.rows[0] || null;
}

export async function getReferralById(referralId) {
  if (!referralId) return null;
  if (!usingPg) return referralsMem.get(String(referralId)) || null;
  const result = await pool.query("SELECT * FROM membership_referrals WHERE id=$1", [String(referralId)]);
  return result.rows[0] || null;
}

export async function listReferrals(inviterSub) {
  if (!usingPg) return [...referralsMem.values()].filter(item => item.inviter_sub === String(inviterSub)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const result = await pool.query(`SELECT * FROM membership_referrals WHERE inviter_sub=$1
    ORDER BY created_at DESC LIMIT 100`, [String(inviterSub)]);
  return result.rows;
}

export async function qualifyReferral(referralId, invitee) {
  if (!usingPg) {
    const item = referralsMem.get(String(referralId));
    if (!item || item.status === "rewarded") return item || null;
    Object.assign(item, {
      status: "qualified_pending", invitee_sub: invitee.sub || null,
      invitee_customer_id: invitee.customerId || null, invitee_subscription_id: invitee.subscriptionId || null,
      qualified_at: item.qualified_at || new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    return item;
  }
  const result = await pool.query(`UPDATE membership_referrals SET
    status=CASE WHEN status='rewarded' THEN status ELSE 'qualified_pending' END,
    invitee_sub=COALESCE($2,invitee_sub),invitee_customer_id=COALESCE($3,invitee_customer_id),
    invitee_subscription_id=COALESCE($4,invitee_subscription_id),qualified_at=COALESCE(qualified_at,now()),updated_at=now()
    WHERE id=$1 RETURNING *`, [String(referralId), invitee.sub || null, invitee.customerId || null, invitee.subscriptionId || null]);
  return result.rows[0] || null;
}

export async function listPendingReferralRewards(inviterSub) {
  if (!usingPg) return [...referralsMem.values()].filter(item => item.inviter_sub === String(inviterSub) && item.status === "qualified_pending");
  const result = await pool.query(`SELECT * FROM membership_referrals
    WHERE inviter_sub=$1 AND status='qualified_pending' ORDER BY qualified_at ASC`, [String(inviterSub)]);
  return result.rows;
}

export async function claimReferralReward(referralId) {
  if (!usingPg) {
    const item = referralsMem.get(String(referralId));
    if (!item || item.status !== "qualified_pending") return null;
    item.status = "rewarding";
    item.updated_at = new Date().toISOString();
    return item;
  }
  const result = await pool.query(`UPDATE membership_referrals SET status='rewarding',updated_at=now()
    WHERE id=$1 AND status='qualified_pending' RETURNING *`, [String(referralId)]);
  return result.rows[0] || null;
}

export async function releaseReferralReward(referralId) {
  if (!usingPg) {
    const item = referralsMem.get(String(referralId));
    if (item?.status === "rewarding") item.status = "qualified_pending";
    return item || null;
  }
  const result = await pool.query(`UPDATE membership_referrals SET status='qualified_pending',updated_at=now()
    WHERE id=$1 AND status='rewarding' RETURNING *`, [String(referralId)]);
  return result.rows[0] || null;
}

export async function markReferralRewarded(referralId) {
  if (!usingPg) {
    const item = referralsMem.get(String(referralId));
    if (!item) return null;
    item.status = "rewarded";
    item.rewarded_at = new Date().toISOString();
    item.updated_at = item.rewarded_at;
    return item;
  }
  const result = await pool.query(`UPDATE membership_referrals SET status='rewarded',rewarded_at=now(),updated_at=now()
    WHERE id=$1 RETURNING *`, [String(referralId)]);
  return result.rows[0] || null;
}
