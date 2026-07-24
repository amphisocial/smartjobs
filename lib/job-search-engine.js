import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

const SOURCE_SYSTEMS = [
  { key: "workday", label: "Workday", patterns: [/(^|\.)myworkdayjobs\.com$/i], sites: ["myworkdayjobs.com"] },
  { key: "adp", label: "ADP", patterns: [/(^|\.)workforcenow\.adp\.com$/i, /(^|\.)recruiting\.adp\.com$/i, /(^|\.)jobs\.adp\.com$/i], sites: ["workforcenow.adp.com", "recruiting.adp.com", "jobs.adp.com"] },
  { key: "greenhouse", label: "Greenhouse", patterns: [/(^|\.)greenhouse\.io$/i], sites: ["greenhouse.io"] },
  { key: "lever", label: "Lever", patterns: [/(^|\.)lever\.co$/i], sites: ["lever.co"] },
  { key: "smartrecruiters", label: "SmartRecruiters", patterns: [/(^|\.)smartrecruiters\.com$/i], sites: ["smartrecruiters.com"] },
  { key: "successfactors", label: "SuccessFactors", patterns: [/(^|\.)successfactors\.(com|eu)$/i], sites: ["successfactors.com"] },
  { key: "oracle", label: "Oracle Recruiting", patterns: [/(^|\.)oraclecloud\.com$/i], sites: ["oraclecloud.com"] },
  { key: "icims", label: "iCIMS", patterns: [/(^|\.)icims\.com$/i], sites: ["icims.com"] },
  { key: "phenom", label: "Phenom", patterns: [/(^|\.)phenompeople\.com$/i], sites: ["phenompeople.com"] },
  { key: "ashby", label: "Ashby", patterns: [/(^|\.)ashbyhq\.com$/i], sites: ["ashbyhq.com"] },
  { key: "jobvite", label: "Jobvite", patterns: [/(^|\.)jobvite\.com$/i], sites: ["jobvite.com"] },
  { key: "ukg", label: "UKG", patterns: [/(^|\.)ultipro\.com$/i, /(^|\.)ukg\.com$/i], sites: ["ultipro.com", "ukg.com"] },
  { key: "dayforce", label: "Dayforce", patterns: [/(^|\.)dayforcehcm\.com$/i, /(^|\.)dayforce\.com$/i], sites: ["dayforcehcm.com", "dayforce.com"] },
  { key: "avature", label: "Avature", patterns: [/(^|\.)avature\.net$/i], sites: ["avature.net"] },
  { key: "eightfold", label: "Eightfold", patterns: [/(^|\.)eightfold\.ai$/i], sites: ["eightfold.ai"] },
];

const DEFAULT_SOURCE_SYSTEM_KEYS = [...SOURCE_SYSTEMS.map(item => item.key), "employer"];


const AGGREGATOR_HOSTS = [
  "indeed.com", "linkedin.com", "glassdoor.com", "ziprecruiter.com", "careerbuilder.com",
  "monster.com", "talent.com", "jooble.org", "lensa.com", "simplyhired.com", "jobrapido.com",
  "jobilize.com", "diversityjobs.com", "tealhq.com", "builtin.com", "theladders.com", "salary.com",
  "jobgether.com", "grabjobs.co", "learn4good.com", "bebee.com", "adzuna.com", "jobs2careers.com",
];

const CLOSED_PATTERNS = [
  /job (?:is )?no longer available/i,
  /position (?:has been|is) filled/i,
  /applications? (?:are )?closed/i,
  /this job has expired/i,
  /job posting (?:has been )?removed/i,
  /we are no longer accepting applications/i,
  /sorry[, ]+this opportunity/i,
  /404[^\n]{0,60}(job|career|position)/i,
];

const decodeEntities = value => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(Number.parseInt(n, 16)));

function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|main)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hostMatches(host, value) {
  const normalized = String(host || "").toLowerCase().replace(/^www\./, "");
  return normalized === value || normalized.endsWith(`.${value}`);
}
function isAggregatorHost(host) { return AGGREGATOR_HOSTS.some(v => hostMatches(host, v)); }
export function sourceSystemForHost(host) {
  const normalized = String(host || "").toLowerCase().replace(/^www\./, "");
  return SOURCE_SYSTEMS.find(item => item.patterns.some(re => re.test(normalized)))?.key || "employer";
}
function isAtsHost(host) { return sourceSystemForHost(host) !== "employer"; }
function looksLikeCareerPath(url) { return /\/(careers?|jobs?|opportunities|positions?|join-us|work-with-us)(\/|$)/i.test(url.pathname); }

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
  }
  const value = String(ip || "").toLowerCase();
  return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80");
}

async function safeExternalUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); }
  catch { throw new Error("invalid_url"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported_url_protocol");
  const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("unsafe_url");
  return url;
}

function tagValue(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeEntities(match?.[1] || "").trim();
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(String(xml || ""))) && items.length < 50) {
    const block = match[1];
    const link = tagValue(block, "link");
    if (!link) continue;
    items.push({
      title: htmlToText(tagValue(block, "title")),
      url: link,
      snippet: htmlToText(tagValue(block, "description")),
      published: tagValue(block, "pubDate"),
    });
  }
  return items;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = config.jobAgentSearchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

async function safeFetchFollowingRedirects(rawUrl, options = {}, maxRedirects = 5) {
  let current = await safeExternalUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchWithTimeout(current, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    current = await safeExternalUrl(new URL(location, current).toString());
  }
  throw new Error("too_many_redirects");
}

async function searchSerper(query) {
  if (!config.serperApiKey) throw new Error("serper_api_key_missing");
  const response = await fetchWithTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": config.serperApiKey },
    body: JSON.stringify({ q: query, num: 30, gl: "us", hl: "en" }),
  });
  if (!response.ok) throw new Error(`serper_http_${response.status}`);
  const data = await response.json();
  return (data.organic || []).map(item => ({ title: item.title || "", url: item.link || "", snippet: item.snippet || "", published: item.date || "" })).filter(item => item.url);
}

async function searchBrave(query) {
  if (!config.braveSearchApiKey) throw new Error("brave_api_key_missing");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");
  url.searchParams.set("country", "us");
  url.searchParams.set("search_lang", "en");
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", "X-Subscription-Token": config.braveSearchApiKey } });
  if (!response.ok) throw new Error(`brave_http_${response.status}`);
  const data = await response.json();
  return (data.web?.results || []).map(item => ({ title: item.title || "", url: item.url || "", snippet: item.description || "", published: item.age || "" })).filter(item => item.url);
}

async function searchBingRss(query) {
  const endpoint = config.jobAgentSearchRssUrl || "https://www.bing.com/search";
  const url = new URL(endpoint);
  url.searchParams.set("format", "rss");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "30");
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }, Math.min(config.jobAgentSearchTimeoutMs, 6000));
  if (!response.ok) throw new Error(`bing_rss_http_${response.status}`);
  const body = await response.text();
  const items = parseRssItems(body);
  if (!items.length && !/<rss\b|<channel\b/i.test(body)) throw new Error("bing_rss_non_rss_response");
  return items;
}

function parseBingHtmlResults(html) {
  const items = [];
  const blocks = String(html || "").match(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    items.push({ title: htmlToText(anchor[2]), url: decodeEntities(anchor[1]), snippet: htmlToText(snippet), published: "" });
    if (items.length >= 30) break;
  }
  return items.filter(item => /^https?:\/\//i.test(item.url));
}

async function searchBingHtml(query) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "30");
  url.searchParams.set("setlang", "en-US");
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }, Math.min(config.jobAgentSearchTimeoutMs, 6000));
  if (!response.ok) throw new Error(`bing_html_http_${response.status}`);
  const body = await response.text();
  const items = parseBingHtmlResults(body);
  if (!items.length && /captcha|unusual traffic|verify you are human/i.test(body)) throw new Error("bing_html_challenge");
  return items;
}

function duckDuckGoTarget(raw) {
  try {
    const url = new URL(decodeEntities(raw), "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return "";
  }
}

function parseDuckDuckGoResults(html) {
  const items = [];
  const blocks = String(html || "").match(/<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bresult\b|$)/gi) || [];
  for (const block of blocks) {
    const anchor = block.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const snippet = block.match(/<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] || "";
    const url = duckDuckGoTarget(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    items.push({ title: htmlToText(anchor[2]), url, snippet: htmlToText(snippet), published: "" });
    if (items.length >= 30) break;
  }
  return items;
}

async function searchDuckDuckGoHtml(query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }, Math.min(config.jobAgentSearchTimeoutMs, 6000));
  if (!response.ok) throw new Error(`duckduckgo_http_${response.status}`);
  const body = await response.text();
  const items = parseDuckDuckGoResults(body);
  if (!items.length && /captcha|anomaly|bots use duckduckgo/i.test(body)) throw new Error("duckduckgo_challenge");
  return items;
}

export function jobSearchProviderStatus() {
  return {
    requested: config.jobAgentSearchProvider,
    allowFallback: config.jobAgentSearchAllowFallback,
    serperConfigured: Boolean(config.serperApiKey),
    serperKeySource: config.serperKeySource || "missing",
    braveConfigured: Boolean(config.braveSearchApiKey),
    braveKeySource: config.braveKeySource || "missing",
  };
}

function searchProviderChain() {
  const requested = config.jobAgentSearchProvider;
  const configured = [];
  if (config.serperApiKey) configured.push({ name: "serper", run: searchSerper });
  if (config.braveSearchApiKey) configured.push({ name: "brave", run: searchBrave });
  const noKey = [
    { name: "bing_rss", run: searchBingRss },
    { name: "bing_html", run: searchBingHtml },
    { name: "duckduckgo_html", run: searchDuckDuckGoHtml },
  ];
  if (requested === "serper") {
    const primary = [{ name: "serper", run: searchSerper }];
    return config.jobAgentSearchAllowFallback ? [...primary, ...noKey] : primary;
  }
  if (requested === "brave") {
    const primary = [{ name: "brave", run: searchBrave }];
    return config.jobAgentSearchAllowFallback ? [...primary, ...noKey] : primary;
  }
  if (requested === "bing") return noKey.filter(p => p.name.startsWith("bing"));
  if (requested === "duckduckgo") return [{ name: "duckduckgo_html", run: searchDuckDuckGoHtml }];
  return [...configured, ...noKey];
}

export async function searchPublicWebDetailed(query) {
  const attempts = [];
  const seen = new Set();
  for (const provider of searchProviderChain()) {
    if (seen.has(provider.name)) continue;
    seen.add(provider.name);
    const started = Date.now();
    try {
      const items = await provider.run(query);
      attempts.push({ provider: provider.name, ok: true, count: items.length, elapsedMs: Date.now() - started });
      if (items.length) return { items, provider: provider.name, attempts };
    } catch (error) {
      attempts.push({ provider: provider.name, ok: false, count: 0, error: error.message, elapsedMs: Date.now() - started });
    }
  }
  return { items: [], provider: "none", attempts };
}

export async function searchPublicWeb(query) {
  return (await searchPublicWebDetailed(query)).items;
}

export async function diagnoseJobSearchProvider(query = 'technology jobs "Boston, MA"') {
  const result = await searchPublicWebDetailed(query);
  return {
    ok: result.items.length > 0,
    provider: result.provider,
    count: result.items.length,
    configuration: jobSearchProviderStatus(),
    attempts: result.attempts,
    sample: result.items.slice(0, 3).map(item => ({ title: item.title, url: item.url })),
  };
}

function flattenJsonLd(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) value.forEach(v => flattenJsonLd(v, out));
  else if (typeof value === "object") {
    const type = value["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some(v => String(v || "").toLowerCase() === "jobposting")) out.push(value);
    if (value["@graph"]) flattenJsonLd(value["@graph"], out);
  }
  return out;
}

function readJsonLdJobs(html) {
  const jobs = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    try { flattenJsonLd(JSON.parse(decodeEntities(match[1]).trim()), jobs); }
    catch { /* malformed JSON-LD is common */ }
  }
  return jobs;
}

function readMeta(html, property) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const wanted = property.toLowerCase();
  for (const tag of tags) {
    const attrs = {};
    const re = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let match;
    while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = decodeEntities(match[3]);
    if ((attrs.property || "").toLowerCase() === wanted || (attrs.name || "").toLowerCase() === wanted) return attrs.content || "";
  }
  return "";
}

function titleFromHtml(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return htmlToText(match?.[1] || "");
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(", ");
  if (typeof value === "object") return textValue(value.name || value.value || value.text || "");
  return "";
}

function locationFromJob(job) {
  if (/telecommute|remote/i.test(textValue(job.jobLocationType))) return "Remote";
  const locations = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
  const values = [];
  for (const item of locations) {
    const address = item?.address || item;
    const parts = [address?.addressLocality, address?.addressRegion, address?.addressCountry].map(textValue).filter(Boolean);
    const label = parts.join(", ") || textValue(item?.name);
    if (label) values.push(label);
  }
  return [...new Set(values)].join(" / ");
}

function salaryFromJob(job) {
  const base = job?.baseSalary;
  if (!base) return { text: "", min: null, max: null, currency: "USD" };
  const currency = textValue(base.currency || base.value?.currency || "USD") || "USD";
  const unit = textValue(base.value?.unitText || base.unitText || "YEAR");
  const min = Number(base.value?.minValue ?? base.minValue ?? base.value?.value ?? base.value);
  const max = Number(base.value?.maxValue ?? base.maxValue ?? base.value?.value ?? base.value);
  const cleanMin = Number.isFinite(min) ? min : null;
  const cleanMax = Number.isFinite(max) ? max : cleanMin;
  const format = n => n == null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  const text = cleanMin == null ? "" : `${format(cleanMin)}${cleanMax && cleanMax !== cleanMin ? `–${format(cleanMax)}` : ""} / ${unit.toLowerCase()}`;
  return { text, min: cleanMin, max: cleanMax, currency };
}

function canonicalizeUrl(raw) {
  const url = new URL(raw);
  url.hash = "";
  const removable = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "source", "src", "gh_src"];
  removable.forEach(key => url.searchParams.delete(key));
  [...url.searchParams.keys()].filter(key => /^utm_/i.test(key)).forEach(key => url.searchParams.delete(key));
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function canonicalKey(job) {
  const requisition = String(job.requisition_id || "").trim().toLowerCase();
  const company = String(job.company || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  if (requisition && company) {
    return crypto.createHash("sha256").update(`req:${company}:${requisition}`).digest("hex");
  }
  const normalizedUrl = canonicalizeUrl(job.final_url || job.source_url);
  return crypto.createHash("sha256").update(normalizedUrl.toLowerCase()).digest("hex");
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnly(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function plausiblePostingDate(date) {
  if (!date) return false;
  const year = date.getUTCFullYear();
  return year >= 2000 && date.getTime() <= Date.now() + 31 * 86400000;
}

export function collectOfficialPostingDates(structured, html) {
  const rows = [];
  const add = (value, source, weight = 1) => {
    const date = parseDate(value);
    if (!plausiblePostingDate(date)) return;
    const key = dateOnly(date);
    if (!rows.some(row => row.key === key && row.source === source)) rows.push({ date, key, source, weight });
  };

  add(structured?.datePosted, "jsonld.datePosted", 10);
  add(structured?.datePublished, "jsonld.datePublished", 8);
  add(structured?.validFrom, "jsonld.validFrom", 7);

  const metaTags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = {};
    const re = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let match;
    while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = decodeEntities(match[3]);
    const label = String(attrs.itemprop || attrs.name || attrs.property || "").toLowerCase();
    if (/dateposted|datepublished|publicationdate|posteddate|publishdate|validfrom/.test(label)) {
      add(attrs.content || attrs.value, `meta.${label}`, 8);
    }
  }

  const rawPatterns = [
    [/["']datePosted["']\s*:\s*["']([^"']+)["']/gi, "embedded.datePosted", 9],
    [/["'](?:postedDate|date_posted|publicationDate|publishedDate|publishDate|validFrom)["']\s*:\s*["']([^"']+)["']/gi, "embedded.published", 7],
    [/["'](?:postedOn|lastPublished|lastPublishedDate)["']\s*:\s*["']([^"']+)["']/gi, "embedded.repost", 5],
  ];
  for (const [pattern, source, weight] of rawPatterns) {
    let match;
    while ((match = pattern.exec(String(html || ""))) && rows.length < 40) add(match[1], source, weight);
  }

  rows.sort((a, b) => a.date - b.date || b.weight - a.weight);
  const unique = [];
  for (const row of rows) if (!unique.some(item => item.key === row.key)) unique.push(row);
  return unique;
}

export function postingDateDecision(agent, dateRows) {
  const policy = agent?.posting_date_policy || "allow_missing";
  const repostPolicy = agent?.repost_policy || "use_original";
  const maxAgeDays = Math.max(0, Number(agent?.max_posting_age_days ?? 30));
  const original = dateRows[0] || null;
  const latest = dateRows[dateRows.length - 1] || original;
  const repostDetected = Boolean(original && latest && latest.date.getTime() - original.date.getTime() > 2 * 86400000);
  if (repostPolicy === "exclude" && repostDetected) return { allowed: false, reason: "repost_excluded", original, latest, repostDetected };
  const selected = repostPolicy === "use_latest" ? latest : original;
  if (policy === "require_date" && !selected) return { allowed: false, reason: "official_posting_date_missing", original, latest, repostDetected };
  if (policy !== "ignore" && selected && maxAgeDays > 0) {
    const ageDays = Math.floor((Date.now() - selected.date.getTime()) / 86400000);
    if (ageDays > maxAgeDays) return { allowed: false, reason: `posting_older_than_${maxAgeDays}_days`, original, latest, selected, repostDetected, ageDays };
  }
  return { allowed: true, original, latest, selected, repostDetected };
}

export function applicationOpenEvidence(structured, html, visibleText) {
  const hasStructuredJob = Boolean(structured && String(structured?.["@type"] || "").toLowerCase().includes("jobposting"));
  const text = `${String(html || "").slice(0, 500000)}\n${String(visibleText || "").slice(0, 30000)}`;
  const explicitApply = /(?:>\s*apply(?: now| today| for this job)?\s*<|\bapply now\b|\bapply for this job\b|\bsubmit (?:your )?application\b|\bstart application\b|href=["'][^"']*(?:apply|application)[^"']*["']|aria-label=["'][^"']*apply[^"']*["'])/i.test(text);
  return hasStructuredJob || explicitApply;
}

function deriveCompanyFromTitle(pageTitle, roleTitle) {
  const text = String(pageTitle || "").replace(roleTitle || "", "").replace(/^[\s|–—-]+|[\s|–—-]+$/g, "");
  return text.split(/\s+[|–—-]\s+/).filter(Boolean)[0]?.trim() || "";
}

export async function verifyJobCandidate(candidate, agent = {}) {
  const reject = (reason, detail = "") => ({ rejected: true, reason, detail: String(detail || "").slice(0, 300), url: candidate?.url || "" });
  try {
    const source = await safeExternalUrl(candidate.url);
    if (isAggregatorHost(source.hostname)) return reject("aggregator_url");

    const fetched = await safeFetchFollowingRedirects(source, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    const response = fetched.response;
    if (!response.ok) return reject(`http_${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/html|text/i.test(contentType)) return reject("unsupported_content_type", contentType);

    const finalUrl = fetched.finalUrl;
    if (isAggregatorHost(finalUrl.hostname)) return reject("redirected_to_aggregator");
    const html = (await response.text()).slice(0, 900000);
    const visibleText = htmlToText(html).slice(0, 70000);
    if (visibleText.length < 120) return reject("unreadable_or_javascript_shell", `visible_text_length=${visibleText.length}`);
    if (CLOSED_PATTERNS.some(re => re.test(visibleText.slice(0, 18000)))) return reject("posting_closed_or_removed");

    const structured = readJsonLdJobs(html)[0] || null;
    const pageTitle = titleFromHtml(html);
    const title = textValue(structured?.title) || readMeta(html, "og:title") || candidate.title || pageTitle;
    const company = textValue(structured?.hiringOrganization) || deriveCompanyFromTitle(pageTitle, title);
    const location = locationFromJob(structured || {}) || textValue(structured?.jobLocationType) || "";
    const description = htmlToText(structured?.description || "") || visibleText;
    const validThrough = parseDate(structured?.validThrough);
    if (validThrough && validThrough.getTime() < Date.now() - 86400000) return reject("valid_through_expired", validThrough.toISOString());

    const sourceSystem = sourceSystemForHost(finalUrl.hostname);
    const officialSource = sourceSystem !== "employer" || looksLikeCareerPath(finalUrl) || Boolean(structured?.hiringOrganization);
    if (agent.official_sources_only !== false && !officialSource) return reject("not_official_employer_or_ats");
    if (!title || title.length < 4) return reject("job_title_missing");
    if (description.length < 150) return reject("job_description_too_short", `description_length=${description.length}`);

    const dateRows = collectOfficialPostingDates(structured, html);
    const dateDecision = postingDateDecision(agent, dateRows);
    if (!dateDecision.allowed) return reject(dateDecision.reason || "posting_date_policy");

    // A successful, readable page on a recognized ATS is acceptable open-status
    // evidence unless the page was explicitly closed or expired above. Employer
    // pages still require JobPosting data or an explicit apply control.
    const explicitOpenEvidence = applicationOpenEvidence(structured, html, visibleText);
    const applicationOpenVerified = explicitOpenEvidence || sourceSystem !== "employer";
    if (agent.verify_application_open !== false && !applicationOpenVerified) return reject("application_open_not_explicit");

    const salary = salaryFromJob(structured || {});
    const remote = /remote|telecommute|work from home/i.test(`${location} ${textValue(structured?.jobLocationType)} ${description.slice(0, 2500)}`);
    const requisitionId = textValue(structured?.identifier);
    const selectedDate = dateDecision.selected || null;
    const job = {
      source_url: candidate.url,
      final_url: canonicalizeUrl(finalUrl.toString()),
      source_host: finalUrl.hostname.toLowerCase().replace(/^www\./, ""),
      source_system: sourceSystem,
      requisition_id: requisitionId.slice(0, 240),
      title: htmlToText(title).slice(0, 300),
      company: htmlToText(company).slice(0, 220),
      location: htmlToText(location).slice(0, 350),
      remote,
      compensation_text: salary.text,
      compensation_min: salary.min,
      compensation_max: salary.max,
      compensation_currency: salary.currency,
      date_posted: dateOnly(selectedDate?.date),
      original_date_posted: dateOnly(dateDecision.original?.date),
      posting_date_source: selectedDate?.source || "",
      repost_detected: Boolean(dateDecision.repostDetected),
      valid_through: validThrough ? validThrough.toISOString() : null,
      description_text: description.slice(0, 50000),
      official_source: officialSource,
      active_verified: true,
      application_open_verified: applicationOpenVerified,
      raw_data: {
        searchTitle: candidate.title || "",
        searchSnippet: candidate.snippet || "",
        searchPublished: candidate.published || "",
        structured: structured || {},
        officialPostingDates: dateRows.map(row => ({ date: row.key, source: row.source })),
        postingDatePolicy: agent.posting_date_policy || "allow_missing",
        repostPolicy: agent.repost_policy || "use_original",
        verification: {
          responseStatus: response.status,
          officialSource,
          sourceSystem,
          applicationOpenVerified,
          explicitOpenEvidence,
          validThrough: validThrough ? validThrough.toISOString() : null,
        },
      },
    };
    job.canonical_key = canonicalKey(job);
    return { job };
  } catch (error) {
    return reject(error.message || "verification_exception");
  }
}

function quote(value) {
  const cleaned = String(value || "").replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? `"${cleaned}"` : "";
}

export function deterministicSearchPlan(agent) {
  const titles = (agent.target_titles?.length ? agent.target_titles : ["Chief Information Officer", "Vice President Information Technology", "Senior Director Technology"])
    .map(String).filter(Boolean).slice(0, 14);
  const locations = [
    ...(agent.priority_cities || []).map((location, index) => ({ label: location, locations: [location], priority: index + 1 })),
    ...(agent.states || []).map((location, index) => ({ label: location, locations: [location], priority: 100 + index })),
    ...(agent.regions || []).map((location, index) => ({ label: location, locations: [location], priority: 200 + index })),
    ...(agent.remote_eligible ? [{ label: "United States remote", locations: ["United States remote"], priority: 999 }] : []),
  ];
  const queries = [];
  const combinedTitles = titles.slice(0, 8).map(quote).join(" OR ");

  // Coverage pass: every city/state/region receives a focused search before any
  // location receives a second query. This prevents a long Boston title list from
  // consuming the full query budget before New York, DC, Hartford, Maine, or NH.
  for (const [locationIndex, wave] of locations.entries()) {
    queries.push({
      query: `(${combinedTitles}) ${quote(wave.locations[0])} (careers OR jobs)`,
      titleFamily: "All target titles",
      location: wave.locations[0],
      priority: locationIndex + 1,
    });
    if (queries.length >= config.jobAgentMaxQueries) break;
  }

  // Depth passes then search each title family across all locations in the same
  // city-first wave order until the configurable budget is reached.
  for (const title of titles) {
    for (const [locationIndex, wave] of locations.entries()) {
      if (queries.length >= config.jobAgentMaxQueries) break;
      queries.push({
        query: `${quote(title)} ${quote(wave.locations[0])} (careers OR jobs)`,
        titleFamily: title,
        location: wave.locations[0],
        priority: 1000 + (titles.indexOf(title) * Math.max(1, locations.length)) + locationIndex,
      });
    }
    if (queries.length >= config.jobAgentMaxQueries) break;
  }
  return {
    titleFamilies: titles.map(title => ({ label: title, titles: [title] })),
    locationWaves: locations,
    queries,
    sourcePolicy: {
      preferredSystems: normalizedSourceKeys(agent),
      officialSourcesOnly: agent.official_sources_only !== false,
      verifyApplicationOpen: agent.verify_application_open !== false,
      maxPostingAgeDays: Number(agent.max_posting_age_days ?? 30),
      postingDatePolicy: agent.posting_date_policy || "allow_missing",
      repostPolicy: agent.repost_policy || "use_original",
      aggregators: agent.allow_aggregator_discovery !== false ? "discovery_only" : "disabled",
    },
    exclusionTerms: agent.excluded_title_terms || [],
    notes: ["Deterministic city-first coverage plan used."],
  };
}

function normalizedSourceKeys(agent = {}) {
  const requested = Array.isArray(agent.preferred_source_systems)
    ? agent.preferred_source_systems.map(value => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return requested.length ? [...new Set(requested)] : DEFAULT_SOURCE_SYSTEM_KEYS;
}

function queryWithOfficialBias(query, agent = {}) {
  const keys = normalizedSourceKeys(agent);
  const preferred = [];
  const prioritizedKeys = ["workday", "adp", "greenhouse", "lever", "smartrecruiters", "successfactors", "oracle", "icims"];
  for (const key of prioritizedKeys) {
    if (!keys.includes(key)) continue;
    const item = SOURCE_SYSTEMS.find(source => source.key === key);
    if (item) preferred.push(...item.sites.slice(0, 1).map(site => `site:${site}`));
    if (preferred.length >= 6) break;
  }
  const clauses = [];
  if (preferred.length) clauses.push(`(${preferred.join(" OR ")})`);
  if (keys.includes("employer")) clauses.push("(inurl:careers OR inurl:jobs)");
  return `${query} ${clauses.length ? `(${clauses.join(" OR ")})` : ""}`.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function aggregatorLeadQuery(item, location) {
  const title = String(item?.title || "").replace(/\s+[|–—-]\s+(Indeed|LinkedIn|Glassdoor|ZipRecruiter).*$/i, "").trim();
  const snippetCompany = String(item?.snippet || "").match(/(?:at|with)\s+([A-Z][A-Za-z0-9&.' -]{2,80})/i)?.[1] || "";
  return `${quote(title)} ${snippetCompany ? quote(snippetCompany) : ""} ${quote(location || "")} (careers OR jobs)`.replace(/\s+/g, " ").trim();
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function discoverAndVerifyJobs(searchPlan, agent = {}, onProgress = () => {}) {
  const queries = Array.isArray(searchPlan?.queries) ? searchPlan.queries.slice(0, config.jobAgentMaxQueries) : [];
  const discovered = new Map();
  const aggregatorLeads = [];
  const errors = [];
  const queryDiagnostics = [];
  const providerCounts = {};
  const providerAttemptCounts = {};
  const providerErrors = {};
  let completedQueries = 0;
  let emptyQueryCount = 0;

  const addProvider = provider => {
    if (!provider || provider === "none") return;
    providerCounts[provider] = Number(providerCounts[provider] || 0) + 1;
  };
  const recordAttempts = attempts => {
    for (const item of attempts || []) {
      providerAttemptCounts[item.provider] = Number(providerAttemptCounts[item.provider] || 0) + 1;
      if (!item.ok) providerErrors[item.provider] = Number(providerErrors[item.provider] || 0) + 1;
    }
  };

  const addOfficialCandidates = (items, entry) => {
    for (const item of items) {
      if (discovered.size >= config.jobAgentMaxDiscovered) break;
      try {
        const url = new URL(item.url);
        if (isAggregatorHost(url.hostname)) {
          if (agent.allow_aggregator_discovery !== false && aggregatorLeads.length < 40) {
            aggregatorLeads.push({ ...item, searchLocation: entry.location || "" });
          }
          continue;
        }
        const key = canonicalizeUrl(url.toString()).toLowerCase();
        if (!discovered.has(key)) discovered.set(key, { ...item, query: entry.query, searchLocation: entry.location });
      } catch { /* ignore bad result URLs */ }
    }
  };

  const searchOne = async (entry, index) => {
    const diagnostic = { query: entry.query || "", location: entry.location || "", attempts: [], resultCount: 0 };
    try {
      // Broad query first. The previous implementation started with a very long
      // site: clause that several no-key providers returned as an empty page.
      let result = await searchPublicWebDetailed(entry.query || "");
      diagnostic.attempts.push(...result.attempts);
      recordAttempts(result.attempts);
      diagnostic.resultCount += result.items.length;
      addProvider(result.provider);
      addOfficialCandidates(result.items, entry);

      // If the broad query did not expose enough official URLs, run one compact
      // official-source query rather than the former 15-domain OR expression.
      if (result.items.length === 0 || discovered.size < 4) {
        const biased = queryWithOfficialBias(entry.query || "", agent);
        if (biased && biased !== entry.query) {
          result = await searchPublicWebDetailed(biased);
          diagnostic.attempts.push(...result.attempts);
          recordAttempts(result.attempts);
          diagnostic.resultCount += result.items.length;
          addProvider(result.provider);
          addOfficialCandidates(result.items, entry);
        }
      }
      if (!diagnostic.resultCount) emptyQueryCount += 1;
    } catch (error) {
      errors.push(`Search failed for ${entry.query}: ${error.message}`);
      diagnostic.error = error.message;
      emptyQueryCount += 1;
    } finally {
      completedQueries += 1;
      queryDiagnostics[index] = diagnostic;
      onProgress({ stage: "discover", completed: completedQueries, total: queries.length, discovered: discovered.size });
    }
  };

  await mapLimit(queries, config.jobAgentQueryConcurrency, searchOne);

  // Aggregators are clues only. Resolve a limited number of clues back to an
  // employer/ATS result and never persist the aggregator URL as verification.
  if (agent.allow_aggregator_discovery !== false && discovered.size < config.jobAgentMaxDiscovered) {
    const leads = aggregatorLeads.slice(0, 12);
    await mapLimit(leads, Math.min(3, config.jobAgentQueryConcurrency), async lead => {
      const query = aggregatorLeadQuery(lead, lead.searchLocation);
      if (!query) return;
      const result = await searchPublicWebDetailed(queryWithOfficialBias(query, agent));
      recordAttempts(result.attempts);
      addProvider(result.provider);
      if (!result.items.length) {
        errors.push(`No official-source result found for aggregator lead: ${lead.title}`);
        return;
      }
      addOfficialCandidates(result.items, { query, location: lead.searchLocation });
    });
  }

  const candidates = [...discovered.values()].slice(0, config.jobAgentMaxDiscovered);
  const verifiedRows = await mapLimit(candidates, config.jobAgentVerifyConcurrency, async (candidate, index) => {
    const verified = await verifyJobCandidate(candidate, agent);
    onProgress({ stage: "verify", completed: index + 1, total: candidates.length });
    return verified;
  });
  const verified = [];
  let verificationErrors = 0;
  const verificationRejections = {};
  for (const row of verifiedRows) {
    if (row?.error) {
      verificationErrors += 1;
      errors.push(`Verification failed: ${row.error.message}`);
    } else if (row?.job) {
      verified.push(row.job);
    } else if (row?.rejected) {
      const reason = row.reason || "verification_rejected";
      verificationRejections[reason] = Number(verificationRejections[reason] || 0) + 1;
    } else if (row) {
      // Backward compatibility for any custom verifier returning a job directly.
      verified.push(row);
    } else {
      verificationRejections.verification_rejected = Number(verificationRejections.verification_rejected || 0) + 1;
    }
  }
  const verificationRejected = Object.values(verificationRejections).reduce((sum, value) => sum + Number(value || 0), 0);

  const unique = new Map();
  for (const job of verified) {
    const existing = unique.get(job.canonical_key);
    if (!existing || (job.description_text?.length || 0) > (existing.description_text?.length || 0)) unique.set(job.canonical_key, job);
  }
  const deduplicated = [...unique.values()];
  const skippedCount = verificationRejected + verificationErrors + Math.max(0, verified.length - deduplicated.length);
  const rejectionReasons = {
    ...verificationRejections,
    verification_error: verificationErrors,
    duplicate: Math.max(0, verified.length - deduplicated.length),
  };
  const diagnostics = {
    providerConfiguration: jobSearchProviderStatus(),
    providerCounts,
    providerAttemptCounts,
    providerErrors,
    emptyQueryCount,
    queryCount: queries.length,
    queryDiagnostics: queryDiagnostics.slice(0, 12),
    aggregatorLeadCount: aggregatorLeads.length,
  };
  if (!discovered.size) {
    const attempts = queryDiagnostics.flatMap(row => row?.attempts || []);
    const providerSummary = attempts.slice(-8).map(item => `${item.provider}:${item.ok ? `${item.count} results` : item.error}`).join(", ");
    errors.push(`Discovery returned no candidates. Provider attempts: ${providerSummary || "none recorded"}. Configure SERPER_API_KEY or BRAVE_SEARCH_API_KEY, or use the Search connection test.`);
  }
  return {
    discoveredCount: discovered.size,
    verified: deduplicated,
    skippedCount,
    emptyQueryCount,
    rejectionReasons,
    diagnostics,
    errors,
  };
}

