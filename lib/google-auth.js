import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { config, googleAuthEnabled } from "../config.js";

const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function sign(value) {
  return crypto.createHmac("sha256", config.authSessionSecret).update(value).digest("base64url");
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export async function verifyGoogleCredential(credential) {
  if (!googleAuthEnabled() || !googleClient) throw new Error("google_auth_not_configured");
  if (!credential) throw new Error("missing_google_credential");

  const ticket = await googleClient.verifyIdToken({
    idToken: String(credential),
    audience: config.googleClientId,
  });
  const p = ticket.getPayload();
  if (!p?.sub || !p?.email || p.email_verified === false) throw new Error("invalid_google_identity");

  return {
    sub: String(p.sub),
    email: String(p.email).toLowerCase(),
    name: String(p.name || p.email),
    picture: String(p.picture || ""),
  };
}

export function createRecruiterSession(user) {
  if (!googleAuthEnabled()) throw new Error("google_auth_not_configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "smartjobs-recruiter",
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture || "",
    iat: now,
    exp: now + config.recruiterSessionDays * 86400,
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifyRecruiterSession(token) {
  if (!googleAuthEnabled() || !token) return null;
  const [encoded, signature, extra] = String(token).split(".");
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== "smartjobs-recruiter" || !payload.sub || !payload.email || Number(payload.exp) <= now) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      name: String(payload.name || payload.email),
      picture: String(payload.picture || ""),
      exp: Number(payload.exp),
    };
  } catch {
    return null;
  }
}
