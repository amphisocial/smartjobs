import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { complete, parseJson } from "./providers.js";
import { getMemberByToken } from "./store.js";
import { verifyRecruiterSession } from "./google-auth.js";
import {
  recruiterDbReady,
  recruiterOwnerKey,
  migrateRecruiterOwner,
} from "./recruiter-store.js";
import { linkedinCandidateProfilePrompt } from "./linkedin-candidate-prompt.js";

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
  }
  const value = String(ip || "").toLowerCase();
  return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|main|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let match;
  while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = decodeEntities(match[3]);
  return attrs;
}

function readMeta(html, key) {
  const wanted = key.toLowerCase();
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseTagAttributes(tag);
    if ((attrs.property || "").toLowerCase() === wanted || (attrs.name || "").toLowerCase() === wanted) {
      return String(attrs.content || "").trim();
    }
  }
  return "";
}

function readTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(match?.[1] || "").replace(/\s+/g, " ").trim();
}

function readJsonLd(html) {
  const values = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) && values.join("\n").length < 20000) {
    const value = decodeEntities(match[1]).trim();
    if (value) values.push(value);
  }
  return values.join("\n").slice(0, 20000);
}

async function normalizeLinkedInUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); }
  catch { throw new Error("Enter a valid LinkedIn profile URL."); }

  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only an http(s) LinkedIn URL is supported.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
    throw new Error("Use a LinkedIn profile URL from linkedin.com.");
  }
  if (!/^\/in\/[^/?#]+/i.test(url.pathname)) {
    throw new Error("Use a LinkedIn person profile URL such as https://www.linkedin.com/in/name.");
  }

  const addresses = await dns.lookup(url.hostname, { all: true })
    .catch(() => { throw new Error("Could not resolve the LinkedIn URL."); });
  if (addresses.some(a => isPrivateIp(a.address))) throw new Error("The LinkedIn URL resolved to a private address.");

  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchPublicLinkedInEvidence(linkedinUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(linkedinUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    if (!response.ok) throw new Error(`LinkedIn returned HTTP ${response.status}.`);
    const type = response.headers.get("content-type") || "";
    if (!/html|text/i.test(type)) throw new Error("LinkedIn did not return a readable profile page.");

    const finalUrl = new URL(response.url || linkedinUrl);
    const finalHost = finalUrl.hostname.toLowerCase().replace(/^www\./, "");
    if (finalHost !== "linkedin.com" && !finalHost.endsWith(".linkedin.com")) {
      throw new Error("LinkedIn redirected to an unsupported page.");
    }

    const html = (await response.text()).slice(0, 800000);
    const title = readTitle(html);
    const ogTitle = readMeta(html, "og:title");
    const ogDescription = readMeta(html, "og:description");
    const description = readMeta(html, "description");
    const jsonLd = readJsonLd(html);
    const pageText = htmlToText(html).slice(0, 30000);
    const evidence = [
      `PROFILE URL: ${linkedinUrl}`,
      title && `PAGE TITLE: ${title}`,
      ogTitle && `OPEN GRAPH TITLE: ${ogTitle}`,
      ogDescription && `OPEN GRAPH DESCRIPTION: ${ogDescription}`,
      description && description !== ogDescription && `PAGE DESCRIPTION: ${description}`,
      jsonLd && `PUBLIC STRUCTURED DATA:\n${jsonLd}`,
      pageText && `PUBLIC PAGE TEXT:\n${pageText}`,
    ].filter(Boolean).join("\n\n").slice(0, 50000);

    const usefulMeta = `${ogTitle} ${ogDescription} ${description}`.trim();
    const likelyWall = /authwall|sign in to linkedin|join linkedin|login/i.test(`${response.url} ${title} ${pageText.slice(0, 1000)}`);
    if (evidence.length < 120 || (likelyWall && usefulMeta.length < 80)) {
      throw new Error("LinkedIn did not expose enough public profile information for a reliable candidate profile.");
    }
    return evidence;
  } finally {
    clearTimeout(timer);
  }
}

function strings(value, max = 50) {
  return Array.isArray(value) ? value.map(v => String(v || "").trim()).filter(Boolean).slice(0, max) : [];
}

function records(value, max = 30) {
  return Array.isArray(value) ? value.filter(v => v && typeof v === "object").slice(0, max) : [];
}

function fallbackName(linkedinUrl) {
  try {
    const slug = new URL(linkedinUrl).pathname.split("/").filter(Boolean)[1] || "LinkedIn candidate";
    return slug.replace(/-\d+$/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch {
    return "LinkedIn candidate";
  }
}

function buildResumeText(profile, linkedinUrl) {
  const experience = records(profile.experience).map(item => {
    const heading = [item.title, item.company].map(v => String(v || "").trim()).filter(Boolean).join(" — ");
    const meta = [item.dates, item.location].map(v => String(v || "").trim()).filter(Boolean).join(" | ");
    const bullets = strings(item.bullets).map(v => `• ${v}`).join("\n");
    return [heading, meta, bullets].filter(Boolean).join("\n");
  }).filter(Boolean);

  const education = records(profile.education).map(item =>
    [[item.degree, item.school].map(v => String(v || "").trim()).filter(Boolean).join(" — "), String(item.dates || "").trim()]
      .filter(Boolean).join(" | ")
  ).filter(Boolean);

  const sections = [
    String(profile.name || "").trim(),
    String(profile.headline || "").trim(),
    String(profile.location || "").trim(),
    [profile.email, profile.phone].map(v => String(v || "").trim()).filter(Boolean).join(" | "),
    profile.about && `PROFESSIONAL SUMMARY\n${String(profile.about).trim()}`,
    experience.length && `EXPERIENCE\n${experience.join("\n\n")}`,
    education.length && `EDUCATION\n${education.join("\n")}`,
    strings(profile.skills).length && `SKILLS\n${strings(profile.skills).join(" • ")}`,
    strings(profile.certifications).length && `CERTIFICATIONS\n${strings(profile.certifications).join(" • ")}`,
    `SOURCE\nLinkedIn profile: ${linkedinUrl}\nProfile generated only from information publicly exposed by LinkedIn. Missing details were not inferred.`,
  ].filter(Boolean);

  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function authenticate(req, res) {
  if (!recruiterDbReady()) {
    res.status(503).json({ error: "Recruiter workspace requires PostgreSQL." });
    return null;
  }
  const user = verifyRecruiterSession(String(req.body?.recruiterSession || "").trim());
  if (!user) {
    res.status(401).json({ error: "google_signin_required", message: "Sign in with Google to import a LinkedIn candidate." });
    return null;
  }

  const owner = recruiterOwnerKey(`google:${user.sub}`);
  const memberToken = String(req.body?.token || "").trim();
  if (memberToken) {
    const member = await getMemberByToken(memberToken);
    if (member && ["active", "trialing"].includes(member.status)) {
      await migrateRecruiterOwner(recruiterOwnerKey(memberToken), owner);
    }
  }
  return { owner, user };
}

async function runAi(spec) {
  const raw = await complete({
    system: spec.system,
    user: spec.user,
    json: true,
    temperature: spec.temperature ?? 0.1,
  });
  return parseJson(raw);
}

export function installRecruiterLinkedInRoutes(app) {
  app.post("/api/recruiter/candidates/linkedin-preview", async (req, res) => {
    try {
      const auth = await authenticate(req, res);
      if (!auth) return;

      const linkedinUrl = await normalizeLinkedInUrl(req.body?.linkedinUrl);
      const evidence = await fetchPublicLinkedInEvidence(linkedinUrl);
      const rawProfile = await runAi(linkedinCandidateProfilePrompt(evidence, linkedinUrl));
      const profile = {
        name: String(rawProfile.name || fallbackName(linkedinUrl)).trim(),
        email: String(rawProfile.email || "").trim(),
        phone: String(rawProfile.phone || "").trim(),
        headline: String(rawProfile.headline || "").trim(),
        location: String(rawProfile.location || "").trim(),
        about: String(rawProfile.about || "").trim(),
        experience: records(rawProfile.experience),
        education: records(rawProfile.education),
        skills: strings(rawProfile.skills),
        certifications: strings(rawProfile.certifications),
        warnings: strings(rawProfile.warnings, 20),
        confidence: ["high", "medium", "low"].includes(String(rawProfile.confidence || "").toLowerCase())
          ? String(rawProfile.confidence).toLowerCase() : "low",
      };
      const resumeText = buildResumeText(profile, linkedinUrl);
      if (!profile.name || resumeText.length < 80) {
        return res.status(422).json({ error: "LinkedIn exposed too little reliable information to build this candidate profile." });
      }

      res.json({
        candidate: {
          name: profile.name,
          email: profile.email,
          phone: profile.phone,
          linkedinUrl,
          resumeText,
          source: "linkedin_public_profile",
          confidence: profile.confidence,
          warnings: profile.warnings,
        },
      });
    } catch (error) {
      console.error("[linkedin-candidate-import]", error.message);
      if (/valid LinkedIn|LinkedIn person profile|linkedin\.com|http\(s\)|private address|resolve/i.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      if (/did not expose|did not return|redirected|HTTP \d+/i.test(error.message)) {
        return res.status(422).json({
          error: `${error.message} LinkedIn may be showing a sign-in wall or restricting this profile.`,
        });
      }
      if (/429|quota|RESOURCE_EXHAUSTED|insufficient_quota/i.test(error.message)) {
        return res.status(502).json({ error: "The AI provider is over its current quota." });
      }
      res.status(500).json({ error: "Could not import this LinkedIn profile. Check the server log for details." });
    }
  });
}
