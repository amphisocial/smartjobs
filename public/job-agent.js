(() => {
  const state = { agents: [], results: [], runs: [], selectedId: "", paid: false, usage: null, smtpConfigured: false, searchHealth: null, pollTimer: null };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const arr = value => Array.isArray(value) ? value : [];
  const listText = value => arr(value).join("\n");
  const splitList = value => String(value || "").split(/\n|;/).map(v => v.trim()).filter(Boolean);
  const money = value => value ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value)) : "";
  const fmtDate = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

  async function api(url, body = {}) {
    if (!window.RecruiterAuth?.signedIn) throw new Error("Sign in with Google first.");
    return window.RF.post(url, { recruiterSession: window.RecruiterAuth.sessionToken, ...body });
  }

  function setMessage(text = "", type = "") {
    const el = $("formMessage");
    el.textContent = text;
    el.className = `message ${type}`.trim();
  }

  function setTab(name) {
    document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${name}`));
  }

  function fillDayOptions() {
    const frequency = $("scheduleFrequency").value;
    const select = $("scheduleDay");
    const current = Number(select.dataset.value || select.value || 1);
    select.innerHTML = "";
    if (frequency === "daily") {
      select.innerHTML = '<option value="1">Every day</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    if (frequency === "weekly") {
      ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].forEach((label, index) => {
        select.insertAdjacentHTML("beforeend", `<option value="${index}">${label}</option>`);
      });
      select.value = String(Math.min(6, Math.max(0, current)));
    } else {
      for (let day = 1; day <= 28; day += 1) select.insertAdjacentHTML("beforeend", `<option value="${day}">Day ${day}</option>`);
      select.value = String(Math.min(28, Math.max(1, current)));
    }
    delete select.dataset.value;
  }

  function initStaticOptions() {
    const digest = $("digestHour");
    for (let hour = 0; hour < 24; hour += 1) {
      const label = new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(new Date(2020, 0, 1, hour));
      digest.insertAdjacentHTML("beforeend", `<option value="${hour}">${label}</option>`);
    }
    digest.value = "20";
    fillDayOptions();
  }

  function emptyAgent() {
    return {
      name: "Executive technology search",
      profile_summary: "",
      target_titles: ["Chief Information Officer", "Divisional CIO", "Vice President Information Technology", "Head of IT", "Senior Director Business Applications"],
      preferred_title_terms: ["enterprise platforms", "business technology", "digital transformation", "commercial technology"],
      excluded_title_terms: [], industries: [], role_keywords: [], excluded_keywords: [],
      priority_cities: ["Boston, MA", "Cambridge, MA", "Somerville, MA", "New York, NY", "Washington, DC", "Hartford, CT", "Portland, ME", "Bangor, ME", "Manchester, NH"],
      states: ["Massachusetts", "New York", "Connecticut", "Maine", "New Hampshire"],
      regions: ["New England", "Northeast", "Mid-Atlantic"], remote_eligible: true,
      min_base_compensation: 225000, min_total_compensation: 250000, max_results: 25,
      max_posting_age_days: 30, posting_date_policy: "allow_missing", repost_policy: "use_original",
      official_sources_only: true, verify_application_open: true, allow_aggregator_discovery: true,
      preferred_source_systems: ["workday", "adp", "greenhouse", "lever", "smartrecruiters", "successfactors", "oracle", "icims", "ukg", "dayforce", "jobvite", "ashby", "avature", "eightfold", "phenom", "employer"],
      schedule_enabled: false, schedule_frequency: "weekly", schedule_time: "07:00", schedule_day: 1,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York", email_enabled: true, digest_hour: 20,
      search_plan: {}, is_active: true,
    };
  }

  function selectAgent(agent) {
    const a = agent || emptyAgent();
    state.selectedId = a.id || "";
    $("agentId").value = a.id || "";
    $("agentName").value = a.name || "";
    $("profileSummary").value = a.profile_summary || "";
    $("targetTitles").value = listText(a.target_titles);
    $("preferredTitles").value = listText(a.preferred_title_terms);
    $("excludedTitles").value = listText(a.excluded_title_terms);
    $("industries").value = listText(a.industries);
    $("roleKeywords").value = listText(a.role_keywords);
    $("excludedKeywords").value = listText(a.excluded_keywords);
    $("priorityCities").value = listText(a.priority_cities);
    $("states").value = listText(a.states);
    $("regions").value = listText(a.regions);
    $("remoteEligible").checked = a.remote_eligible !== false;
    $("minBase").value = a.min_base_compensation || "";
    $("minTotal").value = a.min_total_compensation || "";
    $("maxResults").value = a.max_results || 25;
    $("maxPostingAgeDays").value = String(a.max_posting_age_days ?? 30);
    $("postingDatePolicy").value = a.posting_date_policy || "allow_missing";
    $("repostPolicy").value = a.repost_policy || "use_original";
    $("officialSourcesOnly").checked = a.official_sources_only !== false;
    $("verifyApplicationOpen").checked = a.verify_application_open !== false;
    $("allowAggregatorDiscovery").checked = a.allow_aggregator_discovery !== false;
    $("preferredSourceSystems").value = listText(a.preferred_source_systems?.length ? a.preferred_source_systems : emptyAgent().preferred_source_systems);
    $("scheduleEnabled").checked = Boolean(a.schedule_enabled);
    $("scheduleFrequency").value = a.schedule_frequency || "weekly";
    $("scheduleDay").dataset.value = String(a.schedule_day ?? 1);
    fillDayOptions();
    $("scheduleTime").value = a.schedule_time || "07:00";
    $("timezone").value = a.timezone || "America/New_York";
    $("emailEnabled").checked = a.email_enabled !== false;
    $("digestHour").value = String(a.digest_hour ?? 20);
    $("formHeading").textContent = a.id ? a.name : "Create a job-search agent";
    $("deleteAgent").classList.toggle("hidden", !a.id);
    $("planPreview").textContent = a.search_plan && Object.keys(a.search_plan).length ? JSON.stringify(a.search_plan, null, 2) : "Save the agent, then generate its city-first search plan.";
    updateScheduleUi();
    renderAgents();
  }

  function collectAgent() {
    return {
      id: $("agentId").value || undefined,
      name: $("agentName").value.trim(),
      profileSummary: $("profileSummary").value.trim(),
      targetTitles: splitList($("targetTitles").value),
      preferredTitleTerms: splitList($("preferredTitles").value),
      excludedTitleTerms: splitList($("excludedTitles").value),
      industries: splitList($("industries").value),
      roleKeywords: splitList($("roleKeywords").value),
      excludedKeywords: splitList($("excludedKeywords").value),
      priorityCities: splitList($("priorityCities").value),
      states: splitList($("states").value),
      regions: splitList($("regions").value),
      remoteEligible: $("remoteEligible").checked,
      minBaseCompensation: $("minBase").value ? Number($("minBase").value) : null,
      minTotalCompensation: $("minTotal").value ? Number($("minTotal").value) : null,
      maxResults: Number($("maxResults").value || 25),
      maxPostingAgeDays: Number($("maxPostingAgeDays").value || 0),
      postingDatePolicy: $("postingDatePolicy").value,
      repostPolicy: $("repostPolicy").value,
      officialSourcesOnly: $("officialSourcesOnly").checked,
      verifyApplicationOpen: $("verifyApplicationOpen").checked,
      allowAggregatorDiscovery: $("allowAggregatorDiscovery").checked,
      preferredSourceSystems: splitList($("preferredSourceSystems").value).map(v => v.toLowerCase()),
      scheduleEnabled: $("scheduleEnabled").checked,
      scheduleFrequency: $("scheduleFrequency").value,
      scheduleDay: Number($("scheduleDay").value || 1),
      scheduleTime: $("scheduleTime").value,
      timezone: $("timezone").value.trim(),
      emailEnabled: $("emailEnabled").checked,
      digestHour: Number($("digestHour").value || 20),
      isActive: true,
    };
  }

  function updateScheduleUi() {
    const enabled = $("scheduleEnabled").checked;
    document.querySelector(".schedule-box").classList.toggle("enabled", enabled);
    if (!state.paid) {
      $("scheduleEnabled").disabled = true;
      $("scheduleEnabled").title = "Scheduled monitoring is available to paid members.";
    } else {
      $("scheduleEnabled").disabled = false;
      $("scheduleEnabled").title = "";
    }
    $("smtpNote").textContent = state.smtpConfigured
      ? "SMTP is configured. Scheduled agents send a nightly digest when new recommended matches are waiting."
      : "SMTP is not configured yet. Add SMTP_* settings to .env before enabling email summaries.";
  }

  function latestRun(agentId) {
    return state.runs.find(run => run.agent_id === agentId) || null;
  }

  function renderAgents() {
    const root = $("agentList");
    if (!state.agents.length) {
      root.innerHTML = '<div class="empty" style="padding:18px">No saved agents yet.</div>';
    } else {
      root.innerHTML = state.agents.map(agent => {
        const run = latestRun(agent.id);
        const status = run?.status || "idle";
        return `<div class="agent-item ${agent.id === state.selectedId ? "active" : ""}" data-agent-id="${agent.id}">
          <strong>${esc(agent.name)}</strong>
          <div class="agent-meta"><span><i class="status-dot ${status}"></i>${esc(status)}</span><span>${Number(agent.new_count || 0)} new</span></div>
        </div>`;
      }).join("");
    }
    const filter = $("resultAgentFilter");
    const selected = filter.value;
    filter.innerHTML = '<option value="">All agents</option>' + state.agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
    filter.value = selected;
  }

  function renderQuota() {
    $("quotaTitle").textContent = state.paid ? "Paid membership" : "Free plan";
    $("quotaText").textContent = state.paid ? "Unlimited manual runs plus scheduled monitoring." : `${state.usage?.remaining ?? 5} of ${state.usage?.limit ?? 5} agent runs remaining today.`;
    $("upgradeSchedule").classList.toggle("hidden", state.paid);
    $("rfCredits").textContent = state.paid ? "Unlimited ✦" : `${state.usage?.remaining ?? 5} agent runs left`;
    updateScheduleUi();
  }

  function resultMatchesFilters(result) {
    const agentId = $("resultAgentFilter").value;
    const status = $("resultStatusFilter").value;
    if (agentId && result.agent_id !== agentId) return false;
    if (status && result.workflow_status !== status) return false;
    if ($("recommendedOnly").checked && !result.recommended) return false;
    return true;
  }

  function renderResults() {
    const visible = state.results.filter(resultMatchesFilters);
    $("resultCount").textContent = String(state.results.filter(r => r.workflow_status === "new").length);
    const root = $("resultsList");
    if (!visible.length) {
      root.innerHTML = '<div class="empty"><strong>No matching results in this view.</strong><br>Run an agent or change the filters.</div>';
      return;
    }
    root.innerHTML = visible.map(result => {
      const mandatory = arr(result.mandatory_qualifications).slice(0, 5);
      const gaps = arr(result.material_gaps).slice(0, 5);
      const compensation = result.compensation_text || (result.compensation_min ? `${money(result.compensation_min)}${result.compensation_max && result.compensation_max !== result.compensation_min ? `–${money(result.compensation_max)}` : ""}` : "Compensation not published");
      return `<article class="result-card" data-result-id="${result.id}">
        <div class="result-top"><div>
          <a class="result-title" href="${esc(result.final_url)}" target="_blank" rel="noopener">${esc(result.title)}</a>
          <div class="result-company">${esc(result.company || "Company not parsed")} · ${esc(result.location || (result.remote_eligible ? "Remote" : "Location not listed"))}</div>
          <div class="result-meta">
            <span class="chip fit">Fit ${Number(result.fit_score || 0)}%</span>
            ${result.recommended ? '<span class="chip recommended">Recommended</span>' : ""}
            <span class="chip">${esc(compensation)}</span>
            <span class="chip">Posted ${esc(result.date_posted || "date unavailable")}${result.repost_detected ? " · repost detected" : ""}</span>
            ${result.original_date_posted && result.original_date_posted !== result.date_posted ? `<span class="chip">Original ${esc(result.original_date_posted)}</span>` : ""}
            <span class="chip">${esc(result.source_system || "employer")} · ${esc(result.source_host)}</span>
            <span class="chip">${result.application_open_verified ? "Application open verified" : "Open status not explicit"}</span>
          </div>
        </div><span class="workflow-badge">${esc(result.workflow_status)}</span></div>
        <div class="fit-summary">${esc(result.fit_summary || result.evaluation_reason || "Verified active posting ready for review.")}</div>
        ${(mandatory.length || gaps.length) ? `<div class="detail-grid">
          <div class="detail-box"><strong>Mandatory qualifications</strong>${mandatory.length ? `<ul>${mandatory.map(v => `<li>${esc(v)}</li>`).join("")}</ul>` : '<p>No structured list returned.</p>'}</div>
          <div class="detail-box"><strong>Material gaps</strong>${gaps.length ? `<ul>${gaps.map(v => `<li>${esc(v)}</li>`).join("")}</ul>` : '<p>No material gaps identified.</p>'}</div>
        </div>` : ""}
        <div class="result-actions">
          <button class="apply" data-action="apply">Apply ↗</button>
          <button data-action="applied">Mark applied</button>
          <button data-action="saved">Save</button>
          <button data-action="approved">Approve</button>
          <button class="reject" data-action="rejected">Reject</button>
          <a href="${esc(result.final_url)}" target="_blank" rel="noopener">Official posting</a>
        </div>
      </article>`;
    }).join("");
  }

  function renderMonitoring() {
    const root = $("monitoringList");
    root.innerHTML = state.agents.length ? state.agents.map(agent => {
      const run = latestRun(agent.id);
      return `<div class="monitor-card"><div><strong>${esc(agent.name)}</strong><br><span>${agent.schedule_enabled ? `${esc(agent.schedule_frequency)} at ${esc(agent.schedule_time)} · ${esc(agent.timezone)}` : "Manual only"}</span></div><div><strong>Next run</strong><br><span>${fmtDate(agent.next_run_at)}</span></div><div><strong>Last run</strong><br><span>${fmtDate(agent.last_run_at)}</span></div><div><strong>Results</strong><br><span>${Number(agent.result_count || 0)} total · ${Number(agent.new_count || 0)} new</span></div><div><strong>Email</strong><br><span>${agent.email_enabled ? (state.smtpConfigured ? `Digest at ${agent.digest_hour}:00` : "Needs SMTP") : "Off"}</span></div></div>`;
    }).join("") : '<div class="empty">Save an agent to see monitoring status.</div>';

    $("runList").innerHTML = state.runs.length ? state.runs.map(run => {
      const errors = arr(run.error_messages);
      const providers = run.provider_diagnostics?.providerCounts || {};
      const providerText = Object.entries(providers).map(([name, count]) => `${name} × ${count}`).join(", ") || "no provider returned results";
      const rejectionText = Object.entries(run.rejection_reasons || {}).filter(([, count]) => Number(count) > 0).map(([name, count]) => `${name.replace(/_/g, " ")}: ${count}`).join(" · ");
      return `<div class="run-row"><div><strong>${esc(run.agent_name)}</strong><br><span>${fmtDate(run.started_at)}</span>${errors.length ? `<br><span class="run-error">${esc(errors[0])}</span>` : ""}</div><span class="run-status ${run.status}">${esc(run.status)}</span><span>${esc(run.trigger_type)}</span><span>${Number(run.discovered_count || 0)} discovered · ${Number(run.verified_count || 0)} verified · ${Number(run.skipped_count || 0)} skipped · ${Number(run.recommended_count || 0)} recommended<br><small>${esc(providerText)}${rejectionText ? ` · ${esc(rejectionText)}` : ""}</small></span></div>`;
    }).join("") : '<div class="empty">No agent runs yet.</div>';
    managePolling();
  }

  function updateState(data) {
    if (data.agents) state.agents = data.agents;
    if (data.results) state.results = data.results;
    if (data.runs) state.runs = data.runs;
    if (typeof data.paid === "boolean") state.paid = data.paid;
    if (data.usage) state.usage = data.usage;
    if (typeof data.smtpConfigured === "boolean") state.smtpConfigured = data.smtpConfigured;
    if (data.searchHealth) {
      state.searchHealth = data.searchHealth;
      const detail = data.searchHealth.ok
        ? `Search connection ready: ${data.searchHealth.provider} returned ${data.searchHealth.count} results.`
        : `Search connection failed: ${(data.searchHealth.attempts || []).map(a => `${a.provider}: ${a.ok ? `${a.count} results` : a.error}`).join("; ")}`;
      $("searchHealthStatus").textContent = detail;
      $("searchHealthStatus").className = `hint ${data.searchHealth.ok ? "ok" : "error"}`;
    }
    renderAgents(); renderQuota(); renderResults(); renderMonitoring();
  }

  async function bootstrap() {
    if (!window.RecruiterAuth?.signedIn) return;
    setMessage("Loading saved agents…");
    try {
      const data = await api("/api/job-agent/bootstrap", { checkStripe: true });
      updateState(data);
      const current = state.agents.find(a => a.id === state.selectedId) || state.agents[0];
      selectAgent(current || null);
      setMessage("");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  async function saveCurrent({ silent = false } = {}) {
    const button = $("saveAgent");
    const original = button.textContent;
    button.disabled = true; button.textContent = "Saving…";
    try {
      const data = await api("/api/job-agent/agents/save", { agent: collectAgent() });
      const saved = data.agent;
      const index = state.agents.findIndex(a => a.id === saved.id);
      if (index >= 0) state.agents[index] = saved; else state.agents.unshift(saved);
      updateState(data);
      selectAgent(saved);
      if (!silent) setMessage("Agent saved.", "ok");
      return saved;
    } catch (error) {
      if (/paid_feature|scheduled/i.test(error.message)) startAgentCheckout();
      setMessage(error.message, "error");
      throw error;
    } finally { button.disabled = false; button.textContent = original; }
  }

  async function generatePlan() {
    const button = $("generatePlan");
    const original = button.textContent;
    button.disabled = true; button.textContent = "Designing plan…";
    try {
      const agent = await saveCurrent({ silent: true });
      const data = await api("/api/job-agent/agents/plan", { agentId: agent.id });
      const index = state.agents.findIndex(a => a.id === agent.id);
      if (index >= 0) state.agents[index] = data.agent;
      $("planPreview").textContent = JSON.stringify(data.plan, null, 2);
      setMessage(`Generated ${data.plan.queries?.length || 0} focused searches in city-first order.`, "ok");
    } catch (error) { setMessage(error.message, "error"); }
    finally { button.disabled = false; button.textContent = original; }
  }

  async function testSearchConnection(force = true) {
    const button = $("testSearch");
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Testing…";
    $("searchHealthStatus").textContent = "Testing search providers with a Boston technology query…";
    try {
      const data = await api("/api/job-agent/search/health", { force });
      updateState(data);
      if (!data.searchHealth?.ok) throw new Error("No search provider returned results.");
      setMessage("Search connection is working.", "ok");
      return data.searchHealth;
    } catch (error) {
      $("searchHealthStatus").textContent = error.message;
      $("searchHealthStatus").className = "hint error";
      setMessage(error.message, "error");
      throw error;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function runCurrent() {
    const button = $("runAgent");
    const original = button.textContent;
    button.disabled = true; button.textContent = "Starting…";
    try {
      const agent = await saveCurrent({ silent: true });
      const data = await api("/api/job-agent/agents/run", { agentId: agent.id });
      updateState(data);
      setMessage(data.message || "Agent run started.", "ok");
      setTab("monitoring");
      setTimeout(refreshResults, 1800);
    } catch (error) {
      if (/free agent runs|limit|paid/i.test(error.message)) startAgentCheckout();
      setMessage(error.message, "error");
    } finally { button.disabled = false; button.textContent = original; }
  }

  async function refreshResults() {
    if (!window.RecruiterAuth?.signedIn) return;
    try {
      const data = await api("/api/job-agent/results/list", { limit: 180 });
      updateState(data);
    } catch (error) { console.warn(error); }
  }

  function managePolling() {
    const running = state.runs.some(run => run.status === "running");
    if (running && !state.pollTimer) state.pollTimer = setInterval(refreshResults, 8000);
    if (!running && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function setResultStatus(resultId, status) {
    try {
      const data = await api("/api/job-agent/results/status", { resultId, status });
      const index = state.results.findIndex(r => r.id === resultId);
      if (index >= 0) state.results[index] = { ...state.results[index], ...data.result };
      updateState(data); renderResults();
    } catch (error) { alert(error.message); }
  }

  async function readProfileFile() {
    const file = $("profileFile").files[0];
    if (!file) return alert("Choose a PDF or Word file first.");
    $("fileStatus").textContent = "Reading…";
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const data = await api("/api/extract-file", { data: dataUrl, mime: file.type, filename: file.name });
      $("profileSummary").value = data.text;
      $("fileStatus").textContent = "Profile loaded. Review before saving.";
    } catch (error) { $("fileStatus").textContent = error.message; }
  }

  document.addEventListener("click", async event => {
    const tab = event.target.closest(".tab"); if (tab) setTab(tab.dataset.tab);
    const agentItem = event.target.closest(".agent-item"); if (agentItem) selectAgent(state.agents.find(a => a.id === agentItem.dataset.agentId));
    const resultCard = event.target.closest(".result-card");
    const action = event.target.closest("[data-action]");
    if (resultCard && action) {
      const result = state.results.find(r => r.id === resultCard.dataset.resultId);
      if (!result) return;
      const value = action.dataset.action;
      if (value === "apply") {
        window.open(result.final_url, "_blank", "noopener");
        await setResultStatus(result.id, "approved");
      } else await setResultStatus(result.id, value);
    }
  });

  $("newAgent").onclick = () => { selectAgent(null); setTab("configure"); setMessage(""); };
  $("testSearch").onclick = () => testSearchConnection(true).catch(() => {});
  $("saveAgent").onclick = () => saveCurrent().catch(() => {});
  $("generatePlan").onclick = generatePlan;
  $("runAgent").onclick = runCurrent;
  $("readProfileFile").onclick = event => { event.preventDefault(); readProfileFile(); };
  $("deleteAgent").onclick = async () => {
    if (!state.selectedId || !confirm("Delete this agent and all of its saved results?")) return;
    try {
      await api("/api/job-agent/agents/delete", { agentId: state.selectedId });
      state.agents = state.agents.filter(a => a.id !== state.selectedId);
      state.results = state.results.filter(r => r.agent_id !== state.selectedId);
      selectAgent(state.agents[0] || null); renderResults(); renderMonitoring();
    } catch (error) { setMessage(error.message, "error"); }
  };
  $("scheduleFrequency").onchange = fillDayOptions;
  $("scheduleEnabled").onchange = updateScheduleUi;
  async function startAgentCheckout() {
    const button = $("upgradeSchedule");
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Opening secure checkout…";
    try {
      const data = await api("/api/job-agent/checkout");
      if (!data.url) throw new Error("Could not start checkout.");
      location.href = data.url;
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      setMessage(error.message || "Could not start checkout.", "error");
    }
  }
  $("upgradeSchedule").onclick = startAgentCheckout;
  ["resultAgentFilter", "resultStatusFilter", "recommendedOnly"].forEach(id => $(id).addEventListener("change", renderResults));

  window.addEventListener("rf:recruiter-auth-changed", event => {
    const signedIn = Boolean(event.detail?.signedIn);
    $("signInGate").classList.toggle("hidden", signedIn);
    $("workspace").classList.toggle("hidden", !signedIn);
    if (signedIn) bootstrap();
  });
  window.addEventListener("rf:membership-changed", bootstrap);

  initStaticOptions();
  const checkoutState = new URLSearchParams(location.search).get("checkout");
  if (checkoutState === "success") setMessage("Payment completed. Sign in is being linked to your paid membership; refresh once if the badge does not update immediately.", "success");
  if (checkoutState === "cancelled") setMessage("Checkout was cancelled. Your saved agent was not changed.");
  Promise.resolve(window.RecruiterAuth?.ready).then(() => {
    const signedIn = Boolean(window.RecruiterAuth?.signedIn);
    $("signInGate").classList.toggle("hidden", signedIn);
    $("workspace").classList.toggle("hidden", !signedIn);
    if (signedIn) bootstrap(); else selectAgent(null);
  });
})();
