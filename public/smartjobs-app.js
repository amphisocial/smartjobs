(() => {
  const SESSION_KEY = "rf_recruiter_google_session";
  const USER_KEY = "rf_recruiter_google_user";
  const ROLE_KEY = "sj_active_role";
  const $ = id => document.getElementById(id);

  let role = new URLSearchParams(location.search).get("role") || localStorage.getItem(ROLE_KEY) || "candidate";
  if (!["candidate","recruiter"].includes(role)) role = "candidate";
  localStorage.setItem(ROLE_KEY, role);

  function user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }
  function signedIn() { return Boolean(localStorage.getItem(SESSION_KEY)); }
  function roleHome() { return role === "recruiter" ? "/hr.html" : "/candidate.html"; }

  function roleCards() {
    if (role === "recruiter") return [
      ["▦","Hiring Workspace","Create jobs, manage candidates, rank applicants, and prepare interviews in one workspace.","/hr.html","Open workspace"],
      ["＋","Jobs & Requirements","Build structured roles from pasted descriptions, links, or the AI job builder.","/hr.html?section=jobs","Manage jobs"],
      ["◎","Candidate Ranking","Import resumes or LinkedIn profiles and review transparent, human-controlled rankings.","/hr.html?section=candidates","Review candidates"],
      ["◉","Interview Simulator","Practice recruiter screens against the role and candidate evidence before the live call.","/hr.html?section=interviews","Practice interviews"],
    ];
    return [
      ["✦","Job Toolkit","Run fit analysis, build an ATS resume, and create a targeted preparation plan.","/candidate.html","Open toolkit"],
      ["⌕","Job Search Agents","Create city-first searches, review verified openings, and monitor scheduled runs.","/job-agent.html","Open agents"],
      ["✓","Application Tracker","Keep opportunities, stages, notes, and follow-up preparation together.","/candidate.html?tool=tracker","Track applications"],
      ["◉","Interview Practice","Generate role-specific questions, practice answers, and receive structured feedback.","/candidate.html?tool=interview","Start practicing"],
    ];
  }

  function renderRole() {
    document.querySelectorAll("[data-role]").forEach(button => button.classList.toggle("active", button.dataset.role === role));
    $("roleEyebrow").textContent = role === "recruiter" ? "RECRUITER WORKSPACE" : "CANDIDATE WORKSPACE";
    $("roleTitle").textContent = role === "recruiter" ? "Hire with a clearer workflow." : "Run your entire job search here.";
    $("roleDescription").textContent = role === "recruiter"
      ? "Move from role definition to candidate review and interview preparation without jumping between unrelated pages."
      : "Search, assess fit, tailor your resume, track applications, and practice interviews without losing your place.";
    $("toolGrid").innerHTML = roleCards().map(([icon,title,copy,href,action]) => `
      <a class="tool-card" href="${href}"><span class="tool-icon">${icon}</span><h2>${title}</h2><p>${copy}</p><span class="tool-link">${action} →</span></a>`).join("");
  }

  function renderAuth() {
    const isSignedIn = signedIn();
    $("loginView").classList.toggle("hidden", isSignedIn);
    $("dashboardView").classList.toggle("hidden", !isSignedIn);
    $("signedInActions").classList.toggle("hidden", !isSignedIn);
    $("roleSwitch").classList.toggle("hidden", !isSignedIn);
    if (!isSignedIn) return;
    const current = user() || {};
    $("accountName").textContent = current.name || current.email || "Account";
    const avatar = $("accountAvatar");
    if (current.picture) {
      avatar.innerHTML = `<img src="${current.picture.replace(/"/g,"&quot;")}" alt="">`;
    } else {
      const initials = (current.name || current.email || "SJ").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();
      avatar.textContent = initials;
    }
    renderRole();

    const next = new URLSearchParams(location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      history.replaceState({}, "", `/app.html?role=${role}`);
      location.replace(next);
    }
  }

  document.querySelectorAll("[data-role]").forEach(button => button.addEventListener("click", () => {
    role = button.dataset.role;
    localStorage.setItem(ROLE_KEY, role);
    const url = new URL(location.href);
    url.searchParams.set("role", role);
    history.replaceState({}, "", url);
    renderRole();
  }));

  $("brandHome").addEventListener("click", event => {
    if (!signedIn()) return;
    event.preventDefault();
    location.href = roleHome();
  });
  $("signOut").addEventListener("click", () => {
    window.RecruiterAuth?.signOut?.();
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ROLE_KEY);
    window.google?.accounts?.id?.disableAutoSelect?.();
    location.replace("/app.html");
  });

  window.addEventListener("rf:recruiter-auth-changed", renderAuth);
  window.RecruiterAuth?.ready?.then(renderAuth).catch(renderAuth);
  renderAuth();
})();
