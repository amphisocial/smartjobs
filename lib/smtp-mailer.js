import net from "node:net";
import tls from "node:tls";
import { config } from "../config.js";

function header(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}
function htmlEscape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function dotStuff(value) { return String(value || "").replace(/^\./gm, ".."); }

function createReader(socket) {
  let buffer = "";
  const waiters = [];
  const onData = chunk => {
    buffer += chunk.toString("utf8");
    while (true) {
      const lines = buffer.split(/\r?\n/);
      if (lines.length < 2) return;
      let end = -1;
      let code = "";
      for (let i = 0; i < lines.length - 1; i += 1) {
        const match = lines[i].match(/^(\d{3})([ -])/);
        if (!match) continue;
        if (!code) code = match[1];
        if (match[1] === code && match[2] === " ") { end = i; break; }
      }
      if (end < 0) return;
      const responseLines = lines.slice(0, end + 1);
      buffer = lines.slice(end + 1).join("\r\n");
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ code: Number(code), text: responseLines.join("\n") });
    }
  };
  const onError = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  socket.on("data", onData);
  socket.on("error", onError);
  return {
    read(timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("SMTP response timed out."));
        }, timeoutMs);
        waiter.resolve = value => { clearTimeout(timer); resolve(value); };
        waiter.reject = error => { clearTimeout(timer); reject(error); };
      });
    },
    detach() {
      socket.off("data", onData);
      socket.off("error", onError);
      while (waiters.length) waiters.shift().reject(new Error("SMTP connection upgraded."));
    },
  };
}

async function connectSocket() {
  const options = { host: config.smtp.host, port: config.smtp.port };
  const socket = config.smtp.secure
    ? tls.connect({ ...options, servername: config.smtp.host, rejectUnauthorized: config.smtp.rejectUnauthorized })
    : net.connect(options);
  await new Promise((resolve, reject) => {
    socket.once(config.smtp.secure ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });
  socket.setTimeout(30000, () => socket.destroy(new Error("SMTP socket timeout.")));
  return socket;
}

async function expect(reader, allowed = [250]) {
  const response = await reader.read();
  if (!allowed.includes(response.code)) throw new Error(`SMTP ${response.code}: ${response.text}`);
  return response;
}

async function command(socket, reader, line, allowed = [250]) {
  socket.write(`${line}\r\n`);
  return expect(reader, allowed);
}

async function authenticate(socket, reader) {
  if (!config.smtp.user) return;
  await command(socket, reader, "AUTH LOGIN", [334]);
  await command(socket, reader, Buffer.from(config.smtp.user).toString("base64"), [334]);
  await command(socket, reader, Buffer.from(config.smtp.password).toString("base64"), [235]);
}

export function smtpConfigured() {
  return Boolean(config.smtp.host && config.smtp.from && (!config.smtp.user || config.smtp.password));
}

export async function sendSmtpMail({ to, subject, text, html }) {
  if (!smtpConfigured()) throw new Error("SMTP is not configured.");
  let socket = await connectSocket();
  let reader = createReader(socket);
  try {
    await expect(reader, [220]);
    const hostname = header(config.smtp.heloName || "smartjobs.local");
    const ehlo = await command(socket, reader, `EHLO ${hostname}`, [250]);

    if (!config.smtp.secure && config.smtp.startTls && /STARTTLS/i.test(ehlo.text)) {
      await command(socket, reader, "STARTTLS", [220]);
      reader.detach();
      socket = tls.connect({ socket, servername: config.smtp.host, rejectUnauthorized: config.smtp.rejectUnauthorized });
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      reader = createReader(socket);
      await command(socket, reader, `EHLO ${hostname}`, [250]);
    }

    await authenticate(socket, reader);
    const parsedFrom = String(config.smtp.from || "").match(/<([^>]+)>/)?.[1] || config.smtp.from;
    const fromAddress = header(config.smtp.fromAddress || parsedFrom);
    await command(socket, reader, `MAIL FROM:<${fromAddress}>`, [250]);
    await command(socket, reader, `RCPT TO:<${header(to)}>`, [250, 251]);
    await command(socket, reader, "DATA", [354]);

    const boundary = `smartjobs_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const message = [
      `From: ${header(config.smtp.from)}`,
      `To: ${header(to)}`,
      `Subject: ${header(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text || "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html || `<pre>${htmlEscape(text || "")}</pre>`,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    await expect(reader, [250]);
    await command(socket, reader, "QUIT", [221]).catch(() => {});
  } finally {
    socket.end();
  }
}

export async function sendJobAgentDigest({ to, displayName, agent, results }) {
  const name = displayName || "there";
  const appUrl = `${String(config.appBaseUrl || "").replace(/\/$/, "")}/job-agent.html`;
  const subject = `${results.length} new SmartJobs match${results.length === 1 ? "" : "es"}: ${agent.name}`;
  const rows = results.map(result => {
    const compensation = result.compensation_text ? ` · ${htmlEscape(result.compensation_text)}` : "";
    const posted = result.date_posted ? `Posted ${htmlEscape(result.date_posted)}` : "Posting date unavailable";
    const original = result.original_date_posted && result.original_date_posted !== result.date_posted
      ? ` · original ${htmlEscape(result.original_date_posted)}` : "";
    const source = `${htmlEscape(result.source_system || "employer")} · ${htmlEscape(result.source_host || "official source")}`;
    return `<li style="margin:0 0 18px"><a href="${htmlEscape(result.final_url)}" style="font-weight:700;color:#4338ca;text-decoration:none">${htmlEscape(result.title)}</a><br><span>${htmlEscape(result.company)} · ${htmlEscape(result.location || (result.remote_eligible ? "Remote" : "Location not listed"))}${compensation}</span><br><span style="color:#475569">${posted}${original} · ${source}</span><br><span style="color:#475569">Fit ${Number(result.fit_score || 0)}% — ${htmlEscape(result.fit_summary)}</span></li>`;
  }).join("");
  const text = [`Hi ${name},`, "", `${results.length} new verified match(es) were found by ${agent.name}:`, "",
    ...results.map(r => `- ${r.title} — ${r.company} — ${r.location || "Location not listed"} — Fit ${r.fit_score}%\n  ${r.final_url}`),
    "", appUrl ? `Review and update your statuses: ${appUrl}` : ""].join("\n");
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#0f172a;line-height:1.5;max-width:680px;margin:auto"><h2>New SmartJobs matches</h2><p>Hi ${htmlEscape(name)}, your <strong>${htmlEscape(agent.name)}</strong> agent found ${results.length} new verified match${results.length === 1 ? "" : "es"}.</p><ol style="padding-left:22px">${rows}</ol>${appUrl ? `<p><a href="${htmlEscape(appUrl)}" style="display:inline-block;background:#4f46e5;color:white;padding:12px 18px;border-radius:9px;text-decoration:none;font-weight:700">Review in SmartJobs</a></p>` : ""}<p style="color:#64748b;font-size:12px">Human review is required. SmartJobs never submits an application automatically.</p></div>`;
  await sendSmtpMail({ to, subject, text, html });
}
