// app-billing.js — shared billing UI for candidate.html and hr.html.
// Manages the anonymous client id + member token, wraps gated requests,
// opens Stripe checkout, and supports member-code redemption.
(function () {
  const CID = "rf_client", TOK = "rf_token";
  let cid = localStorage.getItem(CID);
  if (!cid) {
    cid = crypto.randomUUID();
    localStorage.setItem(CID, cid);
  }
  let token = localStorage.getItem(TOK) || "";

  const css = `
  .rf-scrim{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:22px;z-index:50}
  .rf-scrim.on{display:flex}
  .rf-modal{background:#fff;border:1px solid #E5E8EC;border-radius:18px;max-width:400px;width:100%;padding:28px;font-family:Inter,system-ui,sans-serif}
  .rf-modal h2{font-size:24px;font-weight:800;letter-spacing:-.02em;color:#0F172A}
  .rf-modal h2 em{font-style:normal;color:#4F46E5}
  .rf-modal p{margin-top:10px;color:#64748B;font-size:14.5px;line-height:1.5}
  .rf-price{margin-top:16px;font-size:26px;font-weight:800;color:#0F172A}
  .rf-price small{font-size:14px;color:#64748B;font-weight:500}
  .rf-cta{display:block;width:100%;text-align:center;margin-top:16px;background:#4F46E5;color:#fff;border:none;padding:14px;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none}
  .rf-cta:disabled{opacity:.65;cursor:default}
  .rf-x{display:block;width:100%;margin-top:10px;background:none;border:none;color:#64748B;font-size:13px;cursor:pointer;padding:6px}
  .rf-box{margin-top:14px;background:#F8FAFC;border:1px solid #E5E8EC;border-radius:10px;padding:13px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#0F172A;word-break:break-all}
  .rf-in{width:100%;margin-top:12px;border:1px solid #E5E8EC;border-radius:10px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:13px;outline:none}
  .rf-in:focus{border-color:#4F46E5}
  .rf-msg{margin-top:9px;font-size:13px;min-height:16px;color:#64748B}
  .rf-msg.ok{color:#059669}.rf-msg.bad{color:#DC2626}
  .rf-divider{display:flex;align-items:center;gap:10px;margin:20px 0 2px;color:#94A3B8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
  .rf-divider:before,.rf-divider:after{content:"";height:1px;background:#E5E8EC;flex:1}
  .rf-upgrade-note{text-align:center!important;font-size:13px!important;margin-top:10px!important}`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  const wrap = document.createElement("div");
  wrap.innerHTML = `
  <div class="rf-scrim" id="rfPay"><div class="rf-modal">
    <h2>Upgrade to <em>unlimited</em>.</h2>
    <p>Get unlimited access to candidate tools and the recruiter workspace, including job creation, candidate ranking, and interview practice.</p>
    <div class="rf-price">$4.99<small> / month</small></div>
    <a class="rf-cta" id="rfUpgrade" href="#">Upgrade to paid membership</a>
    <button class="rf-x" id="rfPayClose">Maybe later</button>
    <button class="rf-x" id="rfPayCode">Already a member? Use your code</button>
  </div></div>
  <div class="rf-scrim" id="rfMem"><div class="rf-modal">
    <h2>Member <em>code</em></h2>
    <div id="rfHas" style="display:none">
      <p>This is your member code. Paste it on your other devices to unlock unlimited there too.</p>
      <div class="rf-box" id="rfCode"></div>
      <button class="rf-cta" id="rfCopy">Copy code</button>
    </div>
    <div id="rfNone">
      <p>Already subscribed? Paste your member code to unlock unlimited access on this device.</p>
      <input class="rf-in" id="rfCodeIn" placeholder="paste your code (rf_…)" autocomplete="off" spellcheck="false" />
      <button class="rf-cta" id="rfRedeem">Unlock this device</button>
      <div class="rf-msg" id="rfMsg"></div>
      <div class="rf-divider">or</div>
      <p class="rf-upgrade-note">Don’t have a member code?</p>
      <button class="rf-cta" id="rfMemberUpgrade">Click here to upgrade</button>
    </div>
    <button class="rf-x" id="rfMemClose">Close</button>
  </div></div>`;
  document.body.appendChild(wrap);
  const $ = id => document.getElementById(id);

  function openPay() {
    $("rfMem").classList.remove("on");
    $("rfPay").classList.add("on");
  }
  function closePay() { $("rfPay").classList.remove("on"); }
  function openMember() {
    closePay();
    const has = !!token;
    $("rfHas").style.display = has ? "block" : "none";
    $("rfNone").style.display = has ? "none" : "block";
    if (has) $("rfCode").textContent = token;
    $("rfMsg").textContent = "";
    $("rfMsg").className = "rf-msg";
    $("rfMem").classList.add("on");
  }
  function closeMember() { $("rfMem").classList.remove("on"); }

  async function startCheckout(button) {
    const b = button || $("rfUpgrade");
    const original = b.textContent;
    b.textContent = "Opening secure checkout…";
    b.disabled = true;
    try {
      const r = await fetch("/api/checkout", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.status === 503) throw new Error("Paid memberships are not configured yet.");
      if (!r.ok || !d.url) throw new Error(d.error || "Could not start checkout.");
      location.href = d.url;
    } catch (e) {
      b.textContent = original;
      b.disabled = false;
      alert(e.message || "Couldn't open checkout. Try again.");
    }
  }

  $("rfPayClose").onclick = closePay;
  $("rfPayCode").onclick = openMember;
  $("rfMemClose").onclick = closeMember;
  $("rfPay").addEventListener("click", e => { if (e.target === $("rfPay")) closePay(); });
  $("rfMem").addEventListener("click", e => { if (e.target === $("rfMem")) closeMember(); });
  $("rfUpgrade").onclick = e => { e.preventDefault(); startCheckout($("rfUpgrade")); };
  $("rfMemberUpgrade").onclick = () => startCheckout($("rfMemberUpgrade"));

  $("rfCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(token);
      $("rfCopy").textContent = "Copied ✓";
      setTimeout(() => $("rfCopy").textContent = "Copy code", 1400);
    } catch (_) {}
  };

  $("rfRedeem").onclick = async () => {
    const code = $("rfCodeIn").value.trim(), msg = $("rfMsg");
    if (!code) {
      msg.className = "rf-msg bad";
      msg.textContent = "Paste your member code first.";
      return;
    }
    msg.className = "rf-msg";
    msg.textContent = "Checking…";
    try {
      const r = await fetch("/api/member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: code }),
      });
      const d = await r.json();
      if (d.active) {
        token = code;
        localStorage.setItem(TOK, code);
        msg.className = "rf-msg ok";
        msg.textContent = "Unlocked! Unlimited on this device.";
        updateBadge({ unlimited: true });
        window.dispatchEvent(new CustomEvent("rf:membership-changed", { detail: { unlimited: true } }));
        setTimeout(openMember, 800);
      } else {
        msg.className = "rf-msg bad";
        msg.textContent = "That code isn't an active membership.";
      }
    } catch (_) {
      msg.className = "rf-msg bad";
      msg.textContent = "Couldn't check that code.";
    }
  };

  const memLink = document.getElementById("rfMember");
  if (memLink) memLink.onclick = e => { e.preventDefault(); openMember(); };

  function updateBadge(d) {
    const el = document.getElementById("rfCredits");
    if (!el) return;
    if (d && d.unlimited) el.textContent = "Unlimited ✦";
    else if (d && typeof d.remaining === "number") el.textContent = `${d.remaining} free run${d.remaining === 1 ? "" : "s"} left`;
  }
  if (token) updateBadge({ unlimited: true });

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, clientId: cid, token }),
    });
    if (r.status === 429) {
      openPay();
      throw new Error("Out of free runs for today — upgrade or come back tomorrow.");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Request failed");
    updateBadge(d);
    return d;
  }

  window.RF = {
    post,
    openMember,
    openPay,
    startCheckout: () => startCheckout($("rfUpgrade")),
    get token() { return token; },
  };
})();
