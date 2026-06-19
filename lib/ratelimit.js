// lib/ratelimit.js — free daily cap without login (IP + clientId). In-memory:
// resets on redeploy, not shared across instances. Move to Redis for scale.
import { config } from "../config.js";
const hits = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function keyFor(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || req.socket?.remoteAddress || "unknown";
  const clientId = (req.body && req.body.clientId) || "anon";
  return `${ip}::${clientId}`;
}
export function checkAndConsume(req) {
  const limit = config.freeDailyLimit, key = keyFor(req), day = today();
  const rec = hits.get(key);
  if (!rec || rec.day !== day) { hits.set(key, { day, count: 1 }); return { allowed: true, remaining: limit - 1, limit }; }
  if (rec.count >= limit) return { allowed: false, remaining: 0, limit };
  rec.count += 1;
  return { allowed: true, remaining: limit - rec.count, limit };
}
setInterval(() => { const day = today(); for (const [k, v] of hits) if (v.day !== day) hits.delete(k); }, 3600000).unref?.();

// Live voice interviews: members only, capped per day (Pro = unlimited, later).
const live = new Map();
export function consumeLive(token, limit = 2) {
  const day = today(), rec = live.get(token);
  if (!rec || rec.day !== day) { live.set(token, { day, count: 1 }); return { allowed: true, remaining: limit - 1, limit }; }
  if (rec.count >= limit) return { allowed: false, remaining: 0, limit };
  rec.count += 1;
  return { allowed: true, remaining: limit - rec.count, limit };
}
