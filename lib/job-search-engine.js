import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

const ATS_HOST_PATTERNS = [
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)successfactors\.(com|eu)$/i,
  /(^|\.)oraclecloud\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)phenompeople\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)ultipro\.com$/i,
  /(^|\.)dayforcehcm\.com$/i,
  /(^|\.)avature\.net$/i,
  /(^|\.)eightfold\.ai$/i,
];

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
function isAtsHost(host) { return ATS_HOST_PATTERNS.some(re => re.test(String(host || "").toLowerCase().replace(/^www\./, ""))); }
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
      "User-Agent": "Mozilla/5.0 (compatible; SmartJobsSearchAgent/1.0)",
      Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`search_http_${response.status}`);
  return parseRssItems(await response.text());
}

export async function searchPublicWeb(query) {
  const requested = config.jobAgentSearchProvider;
  if ((requested === "serper" || requested === "auto") && config.serperApiKey) return searchSerper(query);
  if ((requested === "brave" || requested === "auto") && config.braveSearchApiKey) return searchBrave(query);
  return searchBingRss(query);
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

function deriveCompanyFromTitle(pageTitle, roleTitle) {
  const text = String(pageTitle || "").replace(roleTitle || "", "").replace(/^[\s|–—-]+|[\s|–—-]+$/g, "");
  return text.split(/\s+[|–—-]\s+/).filter(Boolean)[0]?.trim() || "";
}

export async function verifyJobCandidate(candidate) {
  const source = await safeExternalUrl(candidate.url);
  if (isAggregatorHost(source.hostname)) return null;

  const fetched = await safeFetchFollowingRedirects(source, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });
  const response = fetched.response;
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!/html|text/i.test(contentType)) return null;

  const finalUrl = fetched.finalUrl;
  if (isAggregatorHost(finalUrl.hostname)) return null;
  const html = (await response.text()).slice(0, 900000);
  const visibleText = htmlToText(html).slice(0, 70000);
  if (visibleText.length < 120 || CLOSED_PATTERNS.some(re => re.test(visibleText.slice(0, 12000)))) return null;

  const structured = readJsonLdJobs(html)[0] || null;
  const pageTitle = titleFromHtml(html);
  const title = textValue(structured?.title) || readMeta(html, "og:title") || candidate.title || pageTitle;
  const company = textValue(structured?.hiringOrganization) || deriveCompanyFromTitle(pageTitle, title);
  const location = locationFromJob(structured || {}) || textValue(structured?.jobLocationType) || "";
  const description = htmlToText(structured?.description || "") || visibleText;
  const datePosted = parseDate(structured?.datePosted);
  const validThrough = parseDate(structured?.validThrough);
  if (validThrough && validThrough.getTime() < Date.now() - 86400000) return null;

  const officialSource = isAtsHost(finalUrl.hostname) || looksLikeCareerPath(finalUrl);
  if (!officialSource) return null;
  if (!title || title.length < 4 || description.length < 150) return null;

  const salary = salaryFromJob(structured || {});
  const remote = /remote|telecommute|work from home/i.test(`${location} ${textValue(structured?.jobLocationType)} ${description.slice(0, 2500)}`);
  const requisitionId = textValue(structured?.identifier);
  const job = {
    source_url: candidate.url,
    final_url: canonicalizeUrl(finalUrl.toString()),
    source_host: finalUrl.hostname.toLowerCase().replace(/^www\./, ""),
    requisition_id: requisitionId.slice(0, 240),
    title: htmlToText(title).slice(0, 300),
    company: htmlToText(company).slice(0, 220),
    location: htmlToText(location).slice(0, 350),
    remote,
    compensation_text: salary.text,
    compensation_min: salary.min,
    compensation_max: salary.max,
    compensation_currency: salary.currency,
    date_posted: datePosted ? datePosted.toISOString().slice(0, 10) : null,
    valid_through: validThrough ? validThrough.toISOString() : null,
    description_text: description.slice(0, 50000),
    official_source: officialSource,
    active_verified: true,
    raw_data: {
      searchTitle: candidate.title || "",
      searchSnippet: candidate.snippet || "",
      structured: structured || {},
    },
  };
  job.canonical_key = canonicalKey(job);
  return job;
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
    exclusionTerms: agent.excluded_title_terms || [],
    notes: ["Deterministic city-first coverage plan used."],
  };
}

function queryWithOfficialBias(query) {
  const ats = "(site:myworkdayjobs.com OR site:greenhouse.io OR site:lever.co OR site:smartrecruiters.com OR site:successfactors.com OR site:oraclecloud.com OR site:icims.com OR inurl:careers OR inurl:jobs)";
  return `${query} ${ats}`.slice(0, 1900);
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

export async function discoverAndVerifyJobs(searchPlan, onProgress = () => {}) {
  const queries = Array.isArray(searchPlan?.queries) ? searchPlan.queries.slice(0, config.jobAgentMaxQueries) : [];
  const discovered = new Map();
  const errors = [];

  for (let i = 0; i < queries.length; i += 1) {
    const entry = queries[i];
    try {
      let items = await searchPublicWeb(queryWithOfficialBias(entry.query || ""));
      if (!items.length) items = await searchPublicWeb(entry.query || "");
      for (const item of items) {
        try {
          const url = new URL(item.url);
          if (isAggregatorHost(url.hostname)) continue;
          const key = canonicalizeUrl(url.toString()).toLowerCase();
          if (!discovered.has(key)) discovered.set(key, { ...item, query: entry.query, searchLocation: entry.location });
        } catch { /* ignore bad result URLs */ }
      }
      onProgress({ stage: "discover", completed: i + 1, total: queries.length, discovered: discovered.size });
    } catch (error) {
      errors.push(`Search failed for ${entry.query}: ${error.message}`);
    }
    if (discovered.size >= config.jobAgentMaxDiscovered) break;
  }

  const candidates = [...discovered.values()].slice(0, config.jobAgentMaxDiscovered);
  const verifiedRows = await mapLimit(candidates, config.jobAgentVerifyConcurrency, async (candidate, index) => {
    const verified = await verifyJobCandidate(candidate);
    onProgress({ stage: "verify", completed: index + 1, total: candidates.length });
    return verified;
  });
  const verified = [];
  for (const row of verifiedRows) {
    if (row?.error) errors.push(`Verification failed: ${row.error.message}`);
    else if (row) verified.push(row);
  }

  const unique = new Map();
  for (const job of verified) {
    const existing = unique.get(job.canonical_key);
    if (!existing || (job.description_text?.length || 0) > (existing.description_text?.length || 0)) unique.set(job.canonical_key, job);
  }
  return { discoveredCount: discovered.size, verified: [...unique.values()], errors };
}
