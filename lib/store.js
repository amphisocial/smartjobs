// lib/store.js — member store: access_token -> Stripe subscription status.
// Postgres when DATABASE_URL is set; in-memory fallback for local dev.
import crypto from "node:crypto";
import { config } from "../config.js";

let pg = null;
const mem = new Map();          // token -> record
const memByCustomer = new Map();// customerId -> token
const appsMem = new Map();      // token -> applications array (dev fallback)
const usingPg = Boolean(config.databaseUrl);

export async function initStore() {
  if (!usingPg) { console.warn("[store] No DATABASE_URL — in-memory store (dev only; add Railway Postgres before charging)."); return; }
  const { default: Pg } = await import("pg");
  pg = new Pg.Pool({ connectionString: config.databaseUrl, ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined });
  await pg.query(`CREATE TABLE IF NOT EXISTS members (
    token TEXT PRIMARY KEY, customer_id TEXT UNIQUE NOT NULL,
    subscription_id TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await pg.query(`CREATE TABLE IF NOT EXISTS applications (
    token TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  console.log("[store] Postgres ready.");
}
const newToken = () => "rf_" + crypto.randomBytes(24).toString("hex");

export async function ensureMember(customerId, subscriptionId, status = "active") {
  if (!customerId) throw new Error("ensureMember: missing customerId");
  if (usingPg) {
    const ex = await pg.query("SELECT token FROM members WHERE customer_id=$1", [customerId]);
    if (ex.rows[0]) { await pg.query("UPDATE members SET subscription_id=$1,status=$2,updated_at=now() WHERE customer_id=$3", [subscriptionId || null, status, customerId]); return ex.rows[0].token; }
    const token = newToken();
    await pg.query("INSERT INTO members (token,customer_id,subscription_id,status) VALUES ($1,$2,$3,$4)", [token, customerId, subscriptionId || null, status]);
    return token;
  }
  let token = memByCustomer.get(customerId);
  if (!token) { token = newToken(); memByCustomer.set(customerId, token); }
  mem.set(token, { customerId, subscriptionId, status });
  return token;
}
export async function getMemberByToken(token) {
  if (!token) return null;
  if (usingPg) { const r = await pg.query("SELECT token,customer_id,subscription_id,status FROM members WHERE token=$1", [token]); return r.rows[0] || null; }
  return mem.get(token) || null;
}
export async function setStatusByCustomer(customerId, status) {
  if (!customerId) return;
  if (usingPg) { await pg.query("UPDATE members SET status=$1,updated_at=now() WHERE customer_id=$2", [status, customerId]); return; }
  const token = memByCustomer.get(customerId);
  if (token && mem.has(token)) mem.get(token).status = status;
}

// --- application tracker sync (keyed by member token) ---
export async function getApplications(token) {
  if (usingPg) { const r = await pg.query("SELECT data FROM applications WHERE token=$1", [token]); return r.rows[0]?.data || []; }
  return appsMem.get(token) || [];
}
export async function setApplications(token, data) {
  if (usingPg) { await pg.query(`INSERT INTO applications (token,data,updated_at) VALUES ($1,$2,now()) ON CONFLICT (token) DO UPDATE SET data=$2, updated_at=now()`, [token, JSON.stringify(data)]); return; }
  appsMem.set(token, data);
}
