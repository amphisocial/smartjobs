(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const referralCode = params.get("ref") || sessionStorage.getItem("sj_referral_code") || "";
  if (params.get("ref")) sessionStorage.setItem("sj_referral_code", params.get("ref"));

  let state = null;
  let cancellationArmed = false;
  let cancellationTimer = null;

  function money(amount, currency = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(Number(amount || 0) / 100);
  }
  function date(value) {
    return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(Number(value) * 1000)) : "—";
  }
  function statusLabel(value) {
    return ({ active: "Active", trialing: "Free trial", canceled: "Canceled", past_due: "Past due", unpaid: "Unpaid", incomplete: "Incomplete" })[value] || "Free";
  }
  function message(id, text = "", type = "") {
    const node = $(id);
    node.textContent = text;
    node.className = `message ${type}`.trim();
  }

  async function api(url, body = {}) {
    if (!window.RecruiterAuth?.signedIn) throw new Error("Sign in with Google first.");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recruiterSession: window.RecruiterAuth.sessionToken,
        token: window.RF?.token || localStorage.getItem("rf_token") || "",
        ...body,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || "Membership request failed.");
    return data;
  }

  function renderPricing(data) {
    const price = data?.price;
    const interval = price ? (Number(price.intervalCount || 1) > 1 ? `${price.intervalCount} ${price.interval}s` : price.interval) : "";
    const priceText = price ? `${money(price.unitAmount, price.currency)} / ${interval}` : "Complete membership";
    $("heroPrice").textContent = priceText;
    $("heroTrial").textContent = data?.trialEligible === false ? "Complete access · cancel anytime" : `${data?.trialDays || 7}-day free trial`;
    $("membershipPrice").textContent = priceText;
    $("startTrial").textContent = data?.trialEligible === false ? "Start membership" : `Start ${data?.trialDays || 7}-day free trial`;
  }

  function renderReferrals(referrals = []) {
    const root = $("referralList");
    if (!referrals.length) {
      root.innerHTML = '<div class="referral-row"><strong>No invitations sent yet</strong><span>Invite a friend with a Gmail address.</span><span></span></div>';
      return;
    }
    root.innerHTML = referrals.map(item => {
      const status = String(item.status || "sent").replaceAll("_", " ");
      const detail = item.status === "rewarded" ? `${item.reward_days || 7} days added` : item.status === "qualified_pending" ? "Waiting to apply reward" : "Invitation sent";
      return `<div class="referral-row"><strong>${escapeHtml(item.invitee_email)}</strong><span>${escapeHtml(detail)}</span><span class="referral-status ${escapeHtml(item.status)}">${escapeHtml(status)}</span></div>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render(data) {
    state = data;
    renderPricing(data);
    $("signedOutCard").classList.add("hidden");
    $("membershipWorkspace").classList.remove("hidden");

    if (data.memberToken && window.RF?.setToken) window.RF.setToken(data.memberToken);
    const active = Boolean(data.paid);
    $("freePlanActions").classList.toggle("hidden", active);
    $("memberPlanActions").classList.toggle("hidden", !active);
    $("ownedCodeBlock").classList.toggle("hidden", !data.memberToken);

    if (active) {
      const subscription = data.subscription || {
        status: data.memberStatus || "active",
        productName: data.price?.productName || "SmartJobs Complete",
        unitAmount: data.price?.unitAmount || 0,
        currency: data.price?.currency || "USD",
        interval: data.price?.interval || "month",
        intervalCount: data.price?.intervalCount || 1,
        cancelAtPeriodEnd: false,
        trialEnd: null,
        currentPeriodEnd: null,
      };
      const canceling = Boolean(subscription.cancelAtPeriodEnd);
      $("planName").textContent = subscription.productName || "SmartJobs Complete";
      $("statusPill").textContent = canceling ? "Canceling" : statusLabel(subscription.status);
      $("statusPill").className = `status-pill ${canceling ? "canceling" : subscription.status}`;
      $("planSummary").textContent = canceling
        ? "Your membership remains active until the date below. You can keep it before then."
        : subscription.status === "trialing"
          ? "Every SmartJobs feature is unlocked during your free trial."
          : "Every SmartJobs feature is unlocked with no daily AI-run limits.";
      $("memberStatus").textContent = statusLabel(subscription.status);
      const end = subscription.status === "trialing" ? subscription.trialEnd : subscription.currentPeriodEnd;
      $("dateLabel").textContent = canceling ? "Access through" : subscription.status === "trialing" ? "Trial ends" : "Next billing date";
      $("membershipDate").textContent = date(end);
      $("billingState").textContent = canceling ? "Cancels automatically" : "Renews automatically";
      $("cancelMembership").classList.toggle("hidden", canceling);
      $("resumeMembership").classList.toggle("hidden", !canceling);
      $("memberCode").textContent = data.memberToken;
    } else {
      $("planName").textContent = "Free plan";
      $("statusPill").textContent = "Free";
      $("statusPill").className = "status-pill free";
      $("planSummary").textContent = data.trialEligible === false ? "Start a complete SmartJobs membership for access to every feature." : `Start a ${data.trialDays || 7}-day free trial for complete access to every SmartJobs feature.`;
    }

    const invitation = data.invitation;
    if (invitation) {
      $("invitationNotice").classList.remove("hidden");
      $("invitationNotice").textContent = invitation.validForUser
        ? `${invitation.inviterName} invited you. Start your free trial with this Gmail account to accept the invitation.`
        : `This invitation was sent to ${invitation.inviteeEmail}. Sign in with that Gmail account to use it.`;
    } else $("invitationNotice").classList.add("hidden");

    $("sendInvite").disabled = !data.smtpConfigured;
    $("sendInvite").title = data.smtpConfigured ? "" : "SMTP is not configured on the server.";
    renderReferrals(data.referrals || []);
  }

  async function bootstrap() {
    if (!window.RecruiterAuth?.signedIn) {
      $("signedOutCard").classList.remove("hidden");
      $("membershipWorkspace").classList.add("hidden");
      const publicData = await fetch("/api/membership/public").then(r => r.json()).catch(() => ({}));
      renderPricing(publicData);
      return;
    }
    message("membershipMessage", "Loading membership…");
    try {
      const data = await api("/api/membership/bootstrap", { referralCode });
      render(data);
      message("membershipMessage", "");
      if (params.get("checkout") === "success") {
        message("membershipMessage", data.memberStatus === "trialing" ? "Your free trial is active. All SmartJobs features are unlocked." : "Your SmartJobs membership is active. All features are unlocked.", "ok");
        history.replaceState({}, "", referralCode ? `/membership.html?ref=${encodeURIComponent(referralCode)}` : "/membership.html");
      } else if (params.get("checkout") === "cancelled") {
        message("membershipMessage", "Checkout was canceled. No membership change was made.");
        history.replaceState({}, "", referralCode ? `/membership.html?ref=${encodeURIComponent(referralCode)}` : "/membership.html");
      }
    } catch (error) {
      message("membershipMessage", error.message, "error");
    }
  }

  async function busy(button, text, action) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = text;
    try { return await action(); }
    finally { button.disabled = false; button.textContent = original; }
  }

  $("startTrial").onclick = () => busy($("startTrial"), "Opening secure checkout…", async () => {
    message("membershipMessage", "");
    try {
      const data = await api("/api/membership/checkout", { referralCode });
      location.href = data.url;
    } catch (error) { message("membershipMessage", error.message, "error"); }
  });

  $("manageBilling").onclick = () => busy($("manageBilling"), "Opening Stripe…", async () => {
    try {
      const data = await api("/api/membership/portal");
      location.href = data.url;
    } catch (error) { message("membershipMessage", error.message, "error"); }
  });

  $("cancelMembership").onclick = () => {
    if (!cancellationArmed) {
      cancellationArmed = true;
      $("cancelMembership").textContent = "Confirm cancellation";
      message("membershipMessage", "Click Confirm cancellation within 10 seconds. Access continues through the current trial or billing period.");
      clearTimeout(cancellationTimer);
      cancellationTimer = setTimeout(() => {
        cancellationArmed = false;
        $("cancelMembership").textContent = "Cancel membership";
        message("membershipMessage", "");
      }, 10000);
      return;
    }
    clearTimeout(cancellationTimer);
    cancellationArmed = false;
    busy($("cancelMembership"), "Canceling…", async () => {
      try {
        render(await api("/api/membership/cancel"));
        $("cancelMembership").textContent = "Cancel membership";
        message("membershipMessage", "Cancellation scheduled. You keep access through the displayed date.", "ok");
      } catch (error) {
        $("cancelMembership").textContent = "Cancel membership";
        message("membershipMessage", error.message, "error");
      }
    });
  };

  $("resumeMembership").onclick = () => busy($("resumeMembership"), "Updating…", async () => {
    try { render(await api("/api/membership/resume")); message("membershipMessage", "Your membership will continue.", "ok"); }
    catch (error) { message("membershipMessage", error.message, "error"); }
  });

  $("copyMemberCode").onclick = async () => {
    try {
      await navigator.clipboard.writeText(state?.memberToken || "");
      $("copyMemberCode").textContent = "Copied ✓";
      setTimeout(() => { $("copyMemberCode").textContent = "Copy code"; }, 1400);
    } catch { message("membershipMessage", "Could not copy the code. Select it manually.", "error"); }
  };

  $("redeemMemberCode").onclick = () => busy($("redeemMemberCode"), "Checking…", async () => {
    const memberCode = $("redeemCode").value.trim();
    if (!memberCode) return message("membershipMessage", "Enter a member code first.", "error");
    try { const data = await api("/api/membership/redeem", { memberCode }); render(data); message("membershipMessage", "Membership linked to this Google account.", "ok"); }
    catch (error) { message("membershipMessage", error.message, "error"); }
  });

  $("sendInvite").onclick = () => busy($("sendInvite"), "Sending…", async () => {
    const email = $("inviteEmail").value.trim();
    message("referralMessage", "");
    try {
      const data = await api("/api/membership/invite", { email });
      render(data);
      $("inviteEmail").value = "";
      message("referralMessage", `Invitation sent to ${email}.`, "ok");
    } catch (error) { message("referralMessage", error.message, "error"); }
  });

  window.addEventListener("rf:recruiter-auth-changed", bootstrap);
  Promise.resolve(window.RecruiterAuth?.ready).then(bootstrap);
})();
