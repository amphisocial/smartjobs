// Shared entitlement helper. Membership management now lives on /membership.html.
(function () {
  const CID = "rf_client";
  const TOK = "rf_token";
  let cid = localStorage.getItem(CID);
  if (!cid) {
    cid = crypto.randomUUID();
    localStorage.setItem(CID, cid);
  }
  let token = localStorage.getItem(TOK) || "";

  function goToMembership() {
    const from = encodeURIComponent(location.pathname + location.search);
    location.href = `/membership.html?from=${from}`;
  }

  function updateBadge(data) {
    const element = document.getElementById("rfCredits");
    if (!element) return;
    if (data?.unlimited || token) element.textContent = "Unlimited ✦";
    else if (typeof data?.remaining === "number") element.textContent = `${data.remaining} free run${data.remaining === 1 ? "" : "s"} left`;
    else element.textContent = "Free plan";
  }

  function setToken(value) {
    token = String(value || "").trim();
    if (token) localStorage.setItem(TOK, token);
    else localStorage.removeItem(TOK);
    updateBadge(token ? { unlimited: true } : {});
    window.dispatchEvent(new CustomEvent("rf:membership-changed", { detail: { unlimited: Boolean(token) } }));
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, clientId: cid, token }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 || response.status === 402) {
      setTimeout(goToMembership, 250);
      throw new Error(data.error || data.message || "This feature requires a membership.");
    }
    if (!response.ok) throw new Error(data.error || data.message || "Request failed");
    updateBadge(data);
    return data;
  }


  updateBadge(token ? { unlimited: true } : {});
  window.RF = {
    post,
    openMember: goToMembership,
    openPay: goToMembership,
    startCheckout: goToMembership,
    setToken,
    clearToken: () => setToken(""),
    get token() { return token; },
  };
})();
