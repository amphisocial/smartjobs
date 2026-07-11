(() => {
  const STYLE_ID = "recruiterLinkedInImportStyles";

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .linkedin-import-tools{margin-top:8px;padding:10px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px}
      .linkedin-import-tools button{width:100%}
      .linkedin-import-help{margin:7px 0 0;color:#475569;font-size:11px;line-height:1.45}
      .linkedin-import-status{margin-top:7px;font-size:11px;line-height:1.45;color:#475569;white-space:pre-line}
      .linkedin-import-status.ok{color:#047857}
      .linkedin-import-status.error{color:#b91c1c}
    `;
    document.head.appendChild(style);
  }

  function errorMessage(data, fallback) {
    return data?.message || data?.error || fallback;
  }

  async function importProfile(button, status) {
    const urlInput = document.getElementById("candLinkedin");
    const nameInput = document.getElementById("candName");
    const emailInput = document.getElementById("candEmail");
    const resumeInput = document.getElementById("candResume");
    const candidateError = document.getElementById("candidateError");
    const linkedinUrl = urlInput?.value.trim() || "";

    if (!linkedinUrl) {
      status.className = "linkedin-import-status error";
      status.textContent = "Paste a LinkedIn person profile URL first.";
      urlInput?.focus();
      return;
    }

    await window.RecruiterAuth.ready;
    if (!window.RecruiterAuth.signedIn) {
      status.className = "linkedin-import-status error";
      status.textContent = "Sign in with Google before importing a candidate.";
      return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Reading public profile…";
    status.className = "linkedin-import-status";
    status.textContent = "Retrieving publicly visible LinkedIn information and building a reviewable candidate profile…";
    if (candidateError) candidateError.textContent = "";

    try {
      const data = await window.RF.post("/api/recruiter/candidates/linkedin-preview", {
        recruiterSession: window.RecruiterAuth.sessionToken,
        linkedinUrl,
      });
      const candidate = data.candidate || {};
      if (nameInput) nameInput.value = candidate.name || "";
      if (emailInput) emailInput.value = candidate.email || "";
      if (resumeInput) resumeInput.value = candidate.resumeText || "";
      if (urlInput && candidate.linkedinUrl) urlInput.value = candidate.linkedinUrl;

      const warnings = Array.isArray(candidate.warnings) ? candidate.warnings.filter(Boolean) : [];
      status.className = "linkedin-import-status ok";
      status.textContent = `Profile imported (${candidate.confidence || "low"} confidence). Review the generated resume text, then click Add candidate.${warnings.length ? `\nReview notes: ${warnings.join(" • ")}` : ""}`;
      nameInput?.focus();
    } catch (error) {
      status.className = "linkedin-import-status error";
      status.textContent = error.message || "Could not import this LinkedIn profile.";
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function enhanceCandidateForm() {
    const input = document.getElementById("candLinkedin");
    if (!input || input.dataset.linkedinImportEnhanced === "true") return;
    input.dataset.linkedinImportEnhanced = "true";

    const tools = document.createElement("div");
    tools.className = "linkedin-import-tools";
    tools.innerHTML = `
      <button type="button" class="secondary" data-import-linkedin-candidate>Import profile from LinkedIn URL</button>
      <p class="linkedin-import-help">Uses only information LinkedIn exposes publicly. It does not bypass sign-in, privacy settings, or access controls.</p>
      <div class="linkedin-import-status" aria-live="polite"></div>
    `;
    input.insertAdjacentElement("afterend", tools);

    const button = tools.querySelector("[data-import-linkedin-candidate]");
    const status = tools.querySelector(".linkedin-import-status");
    button.addEventListener("click", () => importProfile(button, status));
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        importProfile(button, status);
      }
    });
  }

  addStyles();
  enhanceCandidateForm();
  const observer = new MutationObserver(enhanceCandidateForm);
  observer.observe(document.body, { childList: true, subtree: true });
})();
