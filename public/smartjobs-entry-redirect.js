(() => {
  if (!localStorage.getItem("rf_recruiter_google_session")) return;
  location.replace("/app.html");
})();
