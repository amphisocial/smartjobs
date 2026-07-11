(() => {
  const SESSION_KEY = "rf_recruiter_google_session";
  const USER_KEY = "rf_recruiter_google_user";
  const state = {
    sessionToken: localStorage.getItem(SESSION_KEY) || "",
    user: null,
    config: null,
  };

  try {
    state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    state.user = null;
  }

  const $ = id => document.getElementById(id);

  function notify() {
    updateUi();
    window.dispatchEvent(new CustomEvent("rf:recruiter-auth-changed", {
      detail: { signedIn: !!state.sessionToken, user: state.user },
    }));
  }

  function updateUi() {
    const signedIn = !!state.sessionToken;
    const account = $("recruiterAccount");
    const name = $("recruiterAccountName");
    const picture = $("recruiterAccountPicture");
    const signOut = $("recruiterSignOut");

    if (account) account.classList.toggle("hidden", !signedIn);
    if (signOut) signOut.classList.toggle("hidden", !signedIn);
    if (name) name.textContent = state.user?.name || state.user?.email || "";
    if (picture) {
      picture.src = state.user?.picture || "";
      picture.classList.toggle("hidden", !state.user?.picture);
    }
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
    const message = $("googleAuthMessage");
    if (message) message.textContent = "Signing in…";
    try {
      const r = await fetch("/api/recruiter/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: response.credential }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.message || "Google sign-in failed.");

      state.sessionToken = d.sessionToken;
      state.user = d.user || null;
      localStorage.setItem(SESSION_KEY, state.sessionToken);
      localStorage.setItem(USER_KEY, JSON.stringify(state.user));
      if (message) message.textContent = "";
      notify();
    } catch (e) {
      if (message) message.textContent = e.message;
    }
  }

  async function init() {
    updateUi();
    const r = await fetch("/api/recruiter/auth/config");
    state.config = await r.json().catch(() => ({}));

    const message = $("googleAuthMessage");
    if (!r.ok || !state.config.enabled || !state.config.clientId) {
      if (message) message.textContent = "Google authentication is not configured on the server.";
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
      const target = $("googleSignInButton");
      if (target) {
        target.innerHTML = "";
        window.google.accounts.id.renderButton(target, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "signin_with",
          width: 260,
        });
      }
    } catch (e) {
      if (message) message.textContent = e.message;
    }
  }

  function signOut() {
    state.sessionToken = "";
    state.user = null;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.google?.accounts?.id?.disableAutoSelect();
    notify();
  }

  window.RecruiterAuth = {
    get sessionToken() { return state.sessionToken; },
    get user() { return state.user; },
    get signedIn() { return !!state.sessionToken; },
    signOut,
    ready: init(),
  };

  document.addEventListener("click", e => {
    if (e.target.closest("#recruiterSignOut")) {
      e.preventDefault();
      signOut();
    }
  });
})();
