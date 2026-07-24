(() => {
  const SESSION_KEY = "rf_recruiter_google_session";
  if (localStorage.getItem(SESSION_KEY)) return;
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/app.html?next=${encodeURIComponent(next)}`);
})();
