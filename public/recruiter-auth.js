(() => {
  const SESSION_KEY = "rf_recruiter_google_session";
  const USER_KEY = "rf_recruiter_google_user";
  const state = {
    sessionToken: localStorage.getItem(SESSION_KEY) || "",
    user: null,
    config: null,
  };

  try { state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); }
  catch { state.user = null; }

  const all = selector => [...document.querySelectorAll(selector)];

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
    element.classList.toggle("hidden", hidden);
  }

  function notify() {
    updateUi();
    window.dispatchEvent(new CustomEvent("rf:recruiter-auth-changed", {
      detail: { signedIn: !!state.sessionToken, user: state.user },
    }));
  }

  function updateUi() {
    const signedIn = !!state.sessionToken;
    all('[data-recruiter-account], #recruiterAccount').forEach(node => setHidden(node, !signedIn));
    all('[data-recruiter-sign-out], #recruiterSignOut').forEach(node => setHidden(node, !signedIn));
    all('[data-google-signin-target], #googleSignInButton').forEach(node => setHidden(node, signedIn));
    all('[data-recruiter-account-name], #recruiterAccountName').forEach(node => {
      node.textContent = state.user?.name || state.user?.email || "";
    });
    all('[data-recruiter-account-picture], #recruiterAccountPicture').forEach(node => {
      node.src = state.user?.picture || "";
      setHidden(node, !signedIn || !state.user?.picture);
    });
  }

  async function waitForGoogle() {
    if (window.google?.accounts?.id) return;
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        if (window.google?.accounts?.id) {
          clearInterval(timer);
          resolve();
        } else if (attempts > 100) {
          clearInterval(timer);
          reject(new Error("Google sign-in library did not load."));
        }
      }, 100);
    });
  }

  async function handleCredential(response) {
    const messages = all("#googleAuthMessage");
    messages.forEach(node => { node.textContent = "Signing in…"; });
    try {
      const result = await fetch("/api/recruiter/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: response.credential }),
      });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(data.error || data.message || "Google sign-in failed.");
      state.sessionToken = data.sessionToken;
      state.user = data.user || null;
      localStorage.setItem(SESSION_KEY, state.sessionToken);
      localStorage.setItem(USER_KEY, JSON.stringify(state.user));
      messages.forEach(node => { node.textContent = ""; });
      notify();
    } catch (error) {
      messages.forEach(node => { node.textContent = error.message; });
    }
  }

  function signInTargets() {
    const sharedHeaderTarget = document.querySelector('#smartjobsAppHeader [data-google-signin-target]');
    if (sharedHeaderTarget) return [sharedHeaderTarget];
    const seen = new Set();
    return all('[data-google-signin-target], #googleSignInButton').filter(node => {
      if (seen.has(node)) return false;
      seen.add(node);
      return !node.classList.contains("sj-secondary-login-hidden");
    });
  }

  async function init() {
    updateUi();
    const result = await fetch("/api/recruiter/auth/config");
    state.config = await result.json().catch(() => ({}));
    const messages = all("#googleAuthMessage");
    if (!result.ok || !state.config.enabled || !state.config.clientId) {
      messages.forEach(node => { node.textContent = "Google authentication is not configured on the server."; });
      return;
    }

    try {
      await waitForGoogle();
      window.google.accounts.id.initialize({
        client_id: state.config.clientId,
        callback: handleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      for (const target of signInTargets()) {
        target.innerHTML = "";
        const inHeader = !!target.closest("#smartjobsAppHeader");
        window.google.accounts.id.renderButton(target, {
          type: "standard",
          theme: "outline",
          size: inHeader ? "medium" : "large",
          shape: "rectangular",
          text: "signin_with",
          width: inHeader ? 190 : 260,
        });
      }
    } catch (error) {
      messages.forEach(node => { node.textContent = error.message; });
    }
  }

  function signOut() {
    state.sessionToken = "";
    state.user = null;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("rf_token");
    window.google?.accounts?.id?.disableAutoSelect();
    notify();
    location.assign("/");
  }

  window.RecruiterAuth = {
    get sessionToken() { return state.sessionToken; },
    get user() { return state.user; },
    get signedIn() { return !!state.sessionToken; },
    signOut,
    ready: init(),
  };

  document.addEventListener("click", event => {
    if (event.target.closest('[data-recruiter-sign-out], #recruiterSignOut')) {
      event.preventDefault();
      signOut();
    }
  });
})();
