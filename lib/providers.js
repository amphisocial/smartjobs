// lib/providers.js
// -----------------------------------------------------------------------------
// One generic complete() the rest of the app calls. Routes to OpenAI or Gemini,
// supports an optional list of images (for screenshots of JDs/resumes), and can
// request strict JSON. Returns the raw text; callers parse.
// -----------------------------------------------------------------------------

import { config } from "../config.js";

function isTransient(s) { return s === 429 || s === 503; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(fn, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

// images: array of { mime, data } (base64, no data: prefix)
export async function complete({ system, user, images = [], temperature = 0.4, json = false }) {
  if (config.provider === "openai") return openai({ system, user, images, temperature, json });
  return gemini({ system, user, images, temperature, json });
}

async function openai({ system, user, images, temperature, json }) {
  const { apiKey, model, baseUrl } = config.openai;
  const content = [{ type: "text", text: user }];
  for (const img of images) content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    temperature,
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await callWithRetry(() =>
    withTimeout((signal) =>
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
    ), "OpenAI"
  );
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function gemini({ system, user, images, temperature, json }) {
  const { apiKey, model, baseUrl } = config.gemini;
  const parts = [{ text: user }];
  for (const img of images) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
  const res = await callWithRetry(() =>
    withTimeout((signal) =>
      fetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    ), "Gemini"
  );
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

async function callWithRetry(makeReq, label) {
  const maxAttempts = 3;
  let res, detail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await makeReq();
    if (res.ok) return res;
    detail = await res.text().catch(() => "");
    if (attempt < maxAttempts && isTransient(res.status)) {
      await sleep(800 * attempt);
      continue;
    }
    throw new Error(`${label} ${res.status}: ${detail.slice(0, 300)}`);
  }
  throw new Error(`${label}: exhausted retries`);
}

// Pull a JSON object/array out of a model reply, tolerating code fences/stray text.
export function parseJson(raw) {
  if (!raw || typeof raw !== "string") throw new Error("Empty model response");
  let t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const firstObj = t.indexOf("{"), firstArr = t.indexOf("[");
  let start = -1, openCh = "{", closeCh = "}";
  if (firstArr !== -1 && (firstArr < firstObj || firstObj === -1)) { start = firstArr; openCh = "["; closeCh = "]"; }
  else start = firstObj;
  if (start === -1) throw new Error("No JSON found in model response");
  const end = t.lastIndexOf(closeCh);
  return JSON.parse(t.slice(start, end + 1));
}
