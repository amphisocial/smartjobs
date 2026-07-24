(() => {
  const SESSION_KEY = "rf_recruiter_google_session";
  const USER_KEY = "rf_recruiter_google_user";
  const ROLE_KEY = "sj_active_role";

  const session = localStorage.getItem(SESSION_KEY) || "";
  if (!session) return;

  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { user = null; }

  const page = location.pathname.split("/").pop() || "index.html";
  const inferredRole = page === "hr.html" ? "recruiter" : "candidate";
  const storedRole = localStorage.getItem(ROLE_KEY);
  let role = ["candidate", "recruiter"].includes(storedRole) ? storedRole : inferredRole;
  // The page itself is authoritative. This avoids a stale saved role showing
  // recruiter navigation over a candidate tool, or vice versa.
  if (page === "candidate.html" || page === "job-agent.html") role = "candidate";
  if (page === "hr.html") role = "recruiter";
  localStorage.setItem(ROLE_KEY, role);

  const candidateNav = [
    ["Overview", "/app.html?role=candidate", "app.html"],
    ["Job Toolkit", "/candidate.html", "candidate.html"],
    ["Search Agents", "/job-agent.html", "job-agent.html"],
    ["Applications", "/candidate.html?tool=tracker", "tracker"],
    ["Interview Prep", "/candidate.html?tool=interview", "interview"],
  ];
  const recruiterNav = [
    ["Overview", "/app.html?role=recruiter", "app.html"],
    ["Hiring Workspace", "/hr.html", "hr.html"],
    ["Jobs", "/hr.html?section=jobs", "jobs"],
    ["Candidates", "/hr.html?section=candidates", "candidates"],
    ["Interviews", "/hr.html?section=interviews", "interviews"],
  ];

  function roleHome(nextRole = role) {
    return nextRole === "recruiter" ? "/hr.html" : "/candidate.html";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  }

  function initials() {
    const value = user?.name || user?.email || "SJ";
    return value.split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join("").toUpperCase();
  }

  function currentKey() {
    const q = new URLSearchParams(location.search);
    return q.get("tool") || q.get("section") || page;
  }

  function renderNav() {
    const rows = role === "recruiter" ? recruiterNav : candidateNav;
    const key = currentKey();
    return rows.map(([label, href, itemKey]) =>
      `<a href="${href}" class="${key === itemKey ? "active" : ""}">${label}</a>`
    ).join("");
  }

  function markLegacyNavigation() {
    const candidates = [...document.querySelectorAll("nav, header, .topbar, .header, .nav")];
    for (const node of candidates) {
      if (node.closest(".sj-shell")) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const links = [...node.querySelectorAll("a[href]")].map(a => a.getAttribute("href") || "");
      const looksGlobal = /rolefit|smartjobs/.test(text) && links.some(h => /(^|\/)(index\.html)?$|candidate\.html|hr\.html|job-agent\.html/.test(h));
      if (looksGlobal) node.dataset.sjLegacyNav = "true";
    }
  }

  function buildShell() {
    if (document.querySelector(".sj-shell")) return;
    const shell = document.createElement("header");
    shell.className = "sj-shell";
    shell.innerHTML = `
      <div class="sj-shell-inner">
        <a class="sj-brand" href="${roleHome()}"><span class="sj-brand-mark">S</span><span>Smart<b>Jobs</b></span></a>
        <nav class="sj-nav" aria-label="${role === "recruiter" ? "Recruiter" : "Candidate"} tools">${renderNav()}</nav>
        <div class="sj-shell-actions">
          <button class="sj-mobile-menu" type="button" aria-label="Open navigation">Menu</button>
          <div class="sj-role-switch" role="group" aria-label="Active role">
            <button type="button" data-sj-role="candidate" class="${role === "candidate" ? "active" : ""}">Candidate</button>
            <button type="button" data-sj-role="recruiter" class="${role === "recruiter" ? "active" : ""}">Recruiter</button>
          </div>
          <div class="sj-account">
            <button class="sj-account-button" type="button" aria-expanded="false">
              ${user?.picture ? `<img class="sj-avatar" src="${escapeHtml(user.picture)}" alt="">` : `<span class="sj-avatar">${escapeHtml(initials())}</span>`}
              <span class="sj-account-name">${escapeHtml(user?.name || user?.email || "Account")}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            <div class="sj-account-menu" hidden>
              <div class="sj-account-summary"><strong>${escapeHtml(user?.name || "SmartJobs user")}</strong><span>${escapeHtml(user?.email || "")}</span></div>
              <button type="button" data-sj-membership>Membership & billing</button>
              <button type="button" data-sj-signout>Sign out</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.prepend(shell);
    document.body.classList.add("sj-shell-active");

    shell.querySelector(".sj-mobile-menu")?.addEventListener("click", () => shell.classList.toggle("mobile-open"));
    shell.querySelectorAll("[data-sj-role]").forEach(button => button.addEventListener("click", () => {
      const nextRole = button.dataset.sjRole;
      if (nextRole === role) return;
      localStorage.setItem(ROLE_KEY, nextRole);
      location.href = `/app.html?role=${nextRole}`;
    }));

    const accountButton = shell.querySelector(".sj-account-button");
    const accountMenu = shell.querySelector(".sj-account-menu");
    accountButton?.addEventListener("click", event => {
      event.stopPropagation();
      const open = accountMenu.hidden;
      accountMenu.hidden = !open;
      accountButton.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", () => { if (accountMenu) accountMenu.hidden = true; });
    accountMenu?.addEventListener("click", event => event.stopPropagation());

    shell.querySelector("[data-sj-membership]")?.addEventListener("click", () => {
      if (window.RF?.openMember) window.RF.openMember();
      else if (window.RF?.openPay) window.RF.openPay();
      else location.href = "/candidate.html?membership=1";
    });
    shell.querySelector("[data-sj-signout]")?.addEventListener("click", () => {
      window.RecruiterAuth?.signOut?.();
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(ROLE_KEY);
      window.google?.accounts?.id?.disableAutoSelect?.();
      location.replace("/app.html");
    });
  }

  function activateRequestedSection() {
    const params = new URLSearchParams(location.search);
    const requested = params.get("tool") || params.get("section");
    if (!requested) return;
    const labels = {
      tracker: ["job tracker", "application tracker", "applications"],
      interview: ["mock interview", "interview practice", "interview"],
      jobs: ["jobs", "job workspace", "job library"],
      candidates: ["candidates", "candidate library", "talent"],
      interviews: ["interviews", "interview simulator", "practice"],
    }[requested] || [requested];

    const controls = [...document.querySelectorAll('button, [role="tab"], a[href^="#"]')];
    const match = controls.find(node => {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return labels.some(label => text === label || text.includes(label));
    });
    if (match) setTimeout(() => match.click(), 120);
  }

  function interceptMarketingHomeLinks() {
    document.addEventListener("click", event => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      let url;
      try { url = new URL(link.href, location.origin); } catch { return; }
      if (url.origin !== location.origin) return;
      if (url.pathname === "/" || url.pathname === "/index.html") {
        event.preventDefault();
        location.href = `/app.html?role=${role}`;
      }
    }, true);
  }

  function init() {
    markLegacyNavigation();
    buildShell();
    activateRequestedSection();
    interceptMarketingHomeLinks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
