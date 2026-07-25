(() => {
  const PAGE = (location.pathname.split("/").pop() || "candidate.html").toLowerCase();
  const NAV = [
    { label: "Job Fit", href: "/candidate.html", page: "candidate.html" },
    { label: "Agent", href: "/job-agent.html", page: "job-agent.html" },
    { label: "Job Tracker", href: "/tracker.html", page: "tracker.html" },
    { label: "Recruiter", href: "/hr.html", page: "hr.html" },
    { label: "Membership", href: "/membership.html", page: "membership.html" },
  ];

  if (!document.body || document.getElementById("smartjobsAppHeader")) return;
  document.body.classList.remove("sj-shell-active");
  document.body.classList.add("sj-unified-header");
  if (PAGE === "job-agent.html") document.body.classList.add("sj-page-agent");

  const header = document.createElement("header");
  header.id = "smartjobsAppHeader";
  header.className = "sj-app-header";
  header.innerHTML = `
    <div class="sj-app-header-inner">
      <a class="sj-app-brand" href="/candidate.html" aria-label="SmartJobs Job Fit">Smart<span>Jobs</span></a>
      <nav class="sj-app-nav" aria-label="SmartJobs features">
        ${NAV.map(item => `<a href="${item.href}"${PAGE === item.page ? ' class="active" aria-current="page"' : ""}>${item.label}</a>`).join("")}
      </nav>
      <div class="sj-app-account-zone">
        <span id="rfCredits" class="sj-app-credits"></span>
        <div id="googleSignInButton" data-google-signin-target class="sj-header-google"></div>
        <div id="recruiterAccount" data-recruiter-account class="sj-app-account hidden" hidden>
          <img id="recruiterAccountPicture" data-recruiter-account-picture class="sj-app-avatar hidden" alt="" hidden>
          <span id="recruiterAccountName" data-recruiter-account-name class="sj-app-account-name"></span>
        </div>
        <button id="recruiterSignOut" data-recruiter-sign-out class="sj-app-signout hidden" type="button" hidden>Sign out</button>
      </div>
    </div>`;
  document.body.prepend(header);

  function cleanupLegacyChrome() {
    document.body.classList.remove("sj-shell-active");
    document.querySelectorAll("body > .sj-shell").forEach(node => node.remove());
    document.querySelectorAll("body > header.topbar:not(#smartjobsAppHeader), body > .wrap > header").forEach(node => node.remove());
    const signInTargets = [...document.querySelectorAll('[id="googleSignInButton"], [data-google-signin-target]')];
    signInTargets.forEach(node => {
      if (!node.closest("#smartjobsAppHeader")) node.classList.add("sj-secondary-login-hidden");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", cleanupLegacyChrome);
  else cleanupLegacyChrome();
})();
