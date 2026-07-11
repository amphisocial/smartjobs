(() => {
  const $ = id => document.getElementById(id);
  const state = { jobs: [], pairs: [], sourceMode: "paste", aiDraft: null, jobAgentSession: null, activeJob: null, interview: null };
  const PIPE = ["new","screening","interview","offer","rejected","withdrawn","hired"];
  const COVERAGE_LABELS = { currentRole:"Current role", motivation:"Motivation / leaving", mustHaves:"Must-haves", gaps:"Gaps / transitions", leadership:"Leadership scope", outcomes:"Measured outcomes", logistics:"Logistics", candidateQuestions:"Candidate questions" };

  function esc(s){return String(s == null ? "" : s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function arr(v){return Array.isArray(v)?v:[];}
  function list(v){return `<ul>${arr(v).map(x=>`<li>${esc(x)}</li>`).join("") || "<li>None recorded</li>"}</ul>`;}
  function statusLabel(v){return ({open:"Open",in_process:"In process",closed:"Closed"})[v]||v;}
  function fmtDate(v){if(!v)return "—";try{let d;if(/^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0,10))&&!String(v).includes("T")){const [y,m,day]=String(v).split("-").map(Number);d=new Date(y,m-1,day);}else d=new Date(v);return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(d);}catch{return v;}}
  function toast(msg){const el=$("toast");el.textContent=msg;el.classList.remove("hidden");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.add("hidden"),2600);}
  async function post(url, body={}){return window.RF.post(url, body);}
  function setBusy(btn,on,label){if(!btn)return;if(on){btn.dataset.old=btn.textContent;btn.textContent=label||"Working…";btn.disabled=true;}else{btn.textContent=btn.dataset.old||btn.textContent;btn.disabled=false;}}
  function hasLogin(){return !!window.RF?.token;}

  function selectTab(name){
    document.querySelectorAll("#mainTabs .tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
    document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${name}`));
    if(name==="manage-jobs") renderJobs();
    if(name==="interview") loadInterviewPairs();
  }
  $("mainTabs").addEventListener("click",e=>{const b=e.target.closest(".tab");if(b)selectTab(b.dataset.tab);});

  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$(b.dataset.close).classList.add("hidden")));
  document.querySelectorAll(".scrim").forEach(s=>s.addEventListener("click",e=>{if(e.target===s)s.classList.add("hidden");}));
  $("openMemberBtn").onclick=()=>window.RF.openMember();

  // ---------- New Job ----------
  $("sourceModes").addEventListener("click",e=>{
    const b=e.target.closest(".source");if(!b)return;
    state.sourceMode=b.dataset.mode;
    document.querySelectorAll(".source").forEach(x=>x.classList.toggle("active",x===b));
    document.querySelectorAll(".mode-panel").forEach(x=>x.classList.toggle("active",x.dataset.panel===state.sourceMode));
    $("createJobBtn").textContent=state.sourceMode==="ai_help"?"Create job from AI draft":state.sourceMode==="paste"?"Analyze and create job":"Import and create job";
  });

  function normalizeDraft(d={}){
    return {
      title:d.title||"",companyName:d.companyName||"",startDate:d.startDate||"",roleDescription:d.roleDescription||"",
      responsibilities:arr(d.responsibilities),mustHave:arr(d.mustHave),preferredQualifications:arr(d.preferredQualifications),niceToHave:arr(d.niceToHave),screeningQuestions:arr(d.screeningQuestions),metadata:d.metadata||{}
    };
  }
  function applyDraft(d){
    state.aiDraft=normalizeDraft(d);
    if(state.aiDraft.title)$("jobTitle").value=state.aiDraft.title;
    if(state.aiDraft.companyName)$("jobCompany").value=state.aiDraft.companyName;
    if(state.aiDraft.startDate)$("jobStart").value=state.aiDraft.startDate;
    renderDraft();
  }
  function renderDraft(){
    const d=state.aiDraft;if(!d){$("draftPreview").className="preview-empty";$("draftPreview").textContent="Structured sections will appear after AI analysis or AI Help.";return;}
    $("draftPreview").className="";
    $("draftPreview").innerHTML=`<div class="preview-title">${esc(d.title||"Draft job")}</div><div class="preview-desc">${esc(d.roleDescription||"")}</div>
      <div class="preview-section"><h4>Must have</h4>${list(d.mustHave)}</div>
      <div class="preview-section"><h4>Responsibilities</h4>${list(d.responsibilities)}</div>
      <div class="preview-section"><h4>Preferred / nice to have</h4>${list([...d.preferredQualifications,...d.niceToHave])}</div>`;
  }

  $("jobChatSend").onclick=async()=>{
    const input=$("jobChatInput"),message=input.value.trim();if(!message)return;
    const chat=$("jobChat");chat.insertAdjacentHTML("beforeend",`<div class="bubble user">${esc(message)}</div>`);input.value="";chat.scrollTop=chat.scrollHeight;
    const btn=$("jobChatSend");setBusy(btn,true,"Thinking…");
    try{
      const d=await post("/api/recruiter/job-agent/chat",{sessionId:state.jobAgentSession,message});
      state.jobAgentSession=d.sessionId;chat.insertAdjacentHTML("beforeend",`<div class="bubble assistant">${esc(d.message||"")}</div>`);chat.scrollTop=chat.scrollHeight;
      if(d.draft)applyDraft(d.draft);
      $("draftReady").classList.toggle("hidden",!d.ready);
    }catch(e){chat.insertAdjacentHTML("beforeend",`<div class="bubble assistant">${esc(e.message)}</div>`);}finally{setBusy(btn,false);}
  };
  $("jobChatInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("jobChatSend").click();}});
  $("applyDraft").onclick=()=>{applyDraft(state.aiDraft||{});toast("AI draft applied");};

  function jobPayloadFromForm(){
    const d=state.aiDraft||{};
    return {title:$("jobTitle").value.trim(),companyName:$("jobCompany").value.trim(),startDate:$("jobStart").value||null,status:$("jobStatus").value,
      roleDescription:d.roleDescription||"",responsibilities:d.responsibilities||[],mustHave:d.mustHave||[],preferredQualifications:d.preferredQualifications||[],niceToHave:d.niceToHave||[],screeningQuestions:d.screeningQuestions||[],metadata:d.metadata||{}};
  }
  function resetJobForm(){
    ["jobRaw","externalUrl","externalContent","linkedinUrl","linkedinContent","jobTitle","jobCompany","jobStart"].forEach(id=>$(id).value="");
    $("jobStatus").value="open";state.aiDraft=null;state.jobAgentSession=null;renderDraft();$("draftReady").classList.add("hidden");
    $("jobChat").innerHTML='<div class="bubble assistant">Describe the person you need, the business problem, and the role level. I’ll ask focused questions and build the job profile.</div>';
  }
  $("createJobBtn").onclick=async()=>{
    const btn=$("createJobBtn"),err=$("newJobError");err.textContent="";
    if(!hasLogin()){window.RF.openMember();return;}
    try{
      setBusy(btn,true,state.sourceMode==="paste"?"Analyzing…":"Creating…");
      let d;
      const base=jobPayloadFromForm();
      if(state.sourceMode==="paste"){
        d=await post("/api/recruiter/jobs/create",{...base,sourceType:"paste",rawDescription:$("jobRaw").value.trim(),analyze:true});
      }else if(state.sourceMode==="external_link"){
        d=await post("/api/recruiter/jobs/import",{...base,sourceType:"external_link",sourceUrl:$("externalUrl").value.trim(),pastedContent:$("externalContent").value.trim()});
      }else if(state.sourceMode==="linkedin"){
        d=await post("/api/recruiter/jobs/import",{...base,sourceType:"linkedin",sourceUrl:$("linkedinUrl").value.trim(),pastedContent:$("linkedinContent").value.trim()});
      }else{
        if(!state.aiDraft)throw new Error("Use AI Help until a draft is available.");
        d=await post("/api/recruiter/jobs/create",{...base,...state.aiDraft,sourceType:"ai_help",rawDescription:state.aiDraft.roleDescription||"AI-created job profile",analyze:false});
      }
      await loadJobs();resetJobForm();toast(`Created ${d.job.title}`);selectTab("manage-jobs");
    }catch(e){err.textContent=e.message;}finally{setBusy(btn,false);}
  };

  // ---------- Jobs ----------
  async function loadJobs(){
    if(!hasLogin()){state.jobs=[];updateCounts();return;}
    const d=await post("/api/recruiter/jobs/list",{});state.jobs=d.jobs||[];updateCounts();renderJobs();fillJobFilters();
  }
  function updateCounts(){
    $("jobCount").textContent=state.jobs.length;$("openJobsCount").textContent=state.jobs.filter(j=>j.status==="open").length;
    $("accessGate").classList.toggle("hidden",hasLogin());
  }
  function fillJobFilters(){
    const current=$("interviewJobFilter").value;
    $("interviewJobFilter").innerHTML='<option value="">All jobs</option>'+state.jobs.map(j=>`<option value="${j.id}">${esc(j.title)} — ${esc(j.company_name||"")}</option>`).join("");
    $("interviewJobFilter").value=current;
  }
  function filteredJobs(){
    const q=$("jobSearch").value.trim().toLowerCase(),st=$("jobStatusFilter").value;
    return state.jobs.filter(j=>(!st||j.status===st)&&(!q||`${j.title} ${j.company_name}`.toLowerCase().includes(q)));
  }
  function renderJobs(){
    const rows=filteredJobs(),wrap=$("jobsList");
    wrap.innerHTML=rows.map(j=>`<article class="job-card"><span class="status ${j.status}">${statusLabel(j.status)}</span><h3>${esc(j.title)}</h3><div class="company">${esc(j.company_name||"Company not set")}</div>
      <div class="job-meta"><div><strong>${j.candidate_count||0}</strong>Candidates</div><div><strong>${j.ranked_count||0}</strong>Ranked</div><div><strong>${j.unranked_count||0}</strong>Need rank</div></div>
      <button class="secondary open-btn" data-open-job="${j.id}">Open</button></article>`).join("");
    $("jobsEmpty").classList.toggle("hidden",rows.length>0);
    wrap.querySelectorAll("[data-open-job]").forEach(b=>b.onclick=()=>openJob(b.dataset.openJob));
  }
  $("jobSearch").oninput=renderJobs;$("jobStatusFilter").onchange=renderJobs;$("refreshJobs").onclick=()=>loadJobs().catch(e=>toast(e.message));

  async function openJob(id){
    const d=await post("/api/recruiter/jobs/get",{jobId:id});state.activeJob=d.job;renderJobModal();$("jobModal").classList.remove("hidden");
  }
  function jobModalHeader(j){return `<p class="eyebrow">${esc(j.company_name||"Recruiter job")}</p><h2 style="margin:5px 35px 0 0">${esc(j.title)}</h2><div style="display:flex;gap:8px;margin-top:8px"><span class="status ${j.status}">${statusLabel(j.status)}</span><span style="font-size:11px;color:#64748b">Modified ${fmtDate(j.modified_at)}</span></div>`;}
  function renderJobModal(active="details"){
    const j=state.activeJob;if(!j)return;
    $("jobModalBody").innerHTML=`${jobModalHeader(j)}<div class="modal-tabs"><button class="modal-tab ${active==="details"?"active":""}" data-mtab="details">Job details</button><button class="modal-tab ${active==="edit"?"active":""}" data-mtab="edit">Edit</button><button class="modal-tab ${active==="candidates"?"active":""}" data-mtab="candidates">Candidates (${j.candidates.length})</button></div>
      <div class="modal-view ${active==="details"?"active":""}" data-mview="details">${renderJobDetails(j)}</div>
      <div class="modal-view ${active==="edit"?"active":""}" data-mview="edit">${renderJobEdit(j)}</div>
      <div class="modal-view ${active==="candidates"?"active":""}" data-mview="candidates">${renderCandidates(j)}</div>`;
    const body=$("jobModalBody");body.querySelectorAll("[data-mtab]").forEach(b=>b.onclick=()=>renderJobModal(b.dataset.mtab));
    wireJobEdit();wireCandidates();
  }
  function renderJobDetails(j){return `<div class="detail-grid"><div class="detail-box"><h4>Role description</h4><p>${esc(j.role_description||j.raw_description||"No description")}</p></div><div class="detail-box"><h4>Metadata</h4><p><b>Start:</b> ${fmtDate(j.start_date)}<br><b>Created by:</b> ${esc(j.created_by)}<br><b>Created:</b> ${fmtDate(j.created_at)}<br><b>Modified by:</b> ${esc(j.modified_by)}<br><b>Modified:</b> ${fmtDate(j.modified_at)}<br><b>Source:</b> ${esc(j.source_type)}</p></div>
    <div class="detail-box"><h4>Responsibilities</h4>${list(j.responsibilities)}</div><div class="detail-box"><h4>Must have</h4>${list(j.must_have)}</div><div class="detail-box"><h4>Preferred qualifications</h4>${list(j.preferred_qualifications)}</div><div class="detail-box"><h4>Nice to have</h4>${list(j.nice_to_have)}</div><div class="detail-box" style="grid-column:1/-1"><h4>Screening questions</h4>${list(j.screening_questions)}</div></div>`;}
  function lines(v){return arr(v).join("\n");}
  function renderJobEdit(j){return `<div class="form-grid"><label class="span-2">Title<input id="editTitle" value="${esc(j.title)}"></label><label>Company<input id="editCompany" value="${esc(j.company_name)}"></label><label>Start date<input id="editStart" type="date" value="${esc((j.start_date||"").slice(0,10))}"></label><label>Status<select id="editStatus"><option value="open">Open</option><option value="in_process">In process</option><option value="closed">Closed</option></select></label><label class="span-2">Role description<textarea id="editRole" rows="5">${esc(j.role_description)}</textarea></label><label>Responsibilities, one per line<textarea id="editResp" rows="7">${esc(lines(j.responsibilities))}</textarea></label><label>Must-have, one per line<textarea id="editMust" rows="7">${esc(lines(j.must_have))}</textarea></label><label>Preferred, one per line<textarea id="editPref" rows="6">${esc(lines(j.preferred_qualifications))}</textarea></label><label>Nice-to-have, one per line<textarea id="editNice" rows="6">${esc(lines(j.nice_to_have))}</textarea></label><label class="span-2">Screening questions, one per line<textarea id="editQuestions" rows="6">${esc(lines(j.screening_questions))}</textarea></label></div><button class="primary" id="saveJobEdit">Save changes</button><div class="inline-error" id="jobEditError"></div>`;}
  function splitLines(id){return $(id).value.split("\n").map(x=>x.trim()).filter(Boolean);}
  function wireJobEdit(){
    if(!$("editStatus"))return;$("editStatus").value=state.activeJob.status;
    $("saveJobEdit").onclick=async()=>{const b=$("saveJobEdit");setBusy(b,true,"Saving…");$("jobEditError").textContent="";try{const d=await post("/api/recruiter/jobs/update",{jobId:state.activeJob.id,changes:{title:$("editTitle").value.trim(),companyName:$("editCompany").value.trim(),startDate:$("editStart").value||null,status:$("editStatus").value,roleDescription:$("editRole").value.trim(),responsibilities:splitLines("editResp"),mustHave:splitLines("editMust"),preferredQualifications:splitLines("editPref"),niceToHave:splitLines("editNice"),screeningQuestions:splitLines("editQuestions")}});state.activeJob={...d.job,candidates:state.activeJob.candidates};await loadJobs();await openJob(state.activeJob.id);toast("Job updated");}catch(e){$("jobEditError").textContent=e.message;}finally{setBusy(b,false);}};
  }

  function candidateCard(c){
    const detail=c.ranking_state==="ranked"?`<details class="rank-detail"><summary>AI ranking reasoning</summary><p><b>${esc(c.ranking_summary||"")}</b></p><div class="detail-grid"><div><b>Strengths</b>${list(c.strengths)}</div><div><b>Concerns</b>${list(c.concerns)}</div><div><b>Matched</b>${list(c.matched_requirements)}</div><div><b>Missing / validate</b>${list(c.missing_requirements)}</div></div></details>`:"";
    return `<div class="candidate-row ${c.ranking_state}"><div class="candidate-head"><div><h4>${esc(c.name)}</h4><div class="candidate-sub">${esc(c.email||"")} ${c.resume_filename?`• ${esc(c.resume_filename)}`:""} • ${esc(c.pipeline_status)}</div></div><div>${c.score!=null?`<div class="score">${Math.round(c.score)}</div><div class="recommendation">${esc(c.recommendation)}</div>`:`<div class="recommendation">${esc(c.ranking_state)}</div>`}</div></div>${detail}<div class="row-actions"><select class="pipeline-select" data-candidate="${c.id}">${PIPE.map(p=>`<option value="${p}" ${p===c.pipeline_status?"selected":""}>${p.replaceAll("_"," ")}</option>`).join("")}</select><button class="ghost" data-interview-candidate="${c.id}">Practice interview</button></div></div>`;
  }
  function renderCandidates(j){return `<div class="candidate-add"><h3 style="font-size:14px;margin:0 0 10px">Add candidate</h3><div class="form-grid"><label>Name<input id="candName"></label><label>Email<input id="candEmail" type="email"></label><label>LinkedIn<input id="candLinkedin" type="url"></label><label>Resume file<input id="candFile" type="file" accept=".pdf,.docx"></label><label class="span-2">Resume text<textarea id="candResume" rows="8" placeholder="Paste resume or upload PDF/Word"></textarea></label></div><button class="primary" id="addCandidateBtn">Add candidate</button><div class="inline-error" id="candidateError"></div></div>
      <div class="actions"><button class="primary" id="rankUnranked">Rank unranked candidates</button><button class="secondary" id="rankAll">Re-rank all</button></div><p style="font-size:11px;color:#64748b">Amber candidates are unranked. Purple rankings are stale because the job changed. Green rankings are current and stored.</p><div class="candidate-list">${j.candidates.map(candidateCard).join("")||'<div class="empty"><p>No candidates added.</p></div>'}</div>`;}
  function fileData(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}
  function wireCandidates(){
    if(!$("addCandidateBtn"))return;
    $("candFile").onchange=async()=>{const f=$("candFile").files[0];if(!f)return;try{const d=await fetch("/api/extract-file",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:await fileData(f),mime:f.type,filename:f.name})}).then(async r=>{const x=await r.json();if(!r.ok)throw new Error(x.error);return x;});$("candResume").value=d.text;toast("Resume extracted");}catch(e){$("candidateError").textContent=e.message;}};
    $("addCandidateBtn").onclick=async()=>{const b=$("addCandidateBtn");setBusy(b,true,"Adding…");try{const f=$("candFile").files[0];const d=await post("/api/recruiter/candidates/add",{jobId:state.activeJob.id,candidate:{name:$("candName").value.trim(),email:$("candEmail").value.trim(),linkedinUrl:$("candLinkedin").value.trim(),resumeText:$("candResume").value.trim(),resumeFilename:f?.name||""}});state.activeJob=d.job;await loadJobs();renderJobModal("candidates");toast("Candidate added");}catch(e){$("candidateError").textContent=e.message;}finally{setBusy(b,false);}};
    $("rankUnranked").onclick=()=>rankCandidates("unranked");$("rankAll").onclick=()=>rankCandidates("all");
    document.querySelectorAll(".pipeline-select").forEach(s=>s.onchange=async()=>{try{await post("/api/recruiter/candidates/pipeline",{jobId:state.activeJob.id,candidateId:s.dataset.candidate,pipelineStatus:s.value});toast("Pipeline updated");}catch(e){toast(e.message);}});
    document.querySelectorAll("[data-interview-candidate]").forEach(b=>b.onclick=()=>startInterview(state.activeJob.id,b.dataset.interviewCandidate));
  }
  async function rankCandidates(mode){
    const b=mode==="all"?$("rankAll"):$("rankUnranked");setBusy(b,true,"Ranking…");
    try{const d=await post("/api/recruiter/rank",{jobId:state.activeJob.id,mode});state.activeJob=d.job;await loadJobs();renderJobModal("candidates");toast(d.rankedNow?`Ranked ${d.rankedNow} candidate(s)`:d.message);}catch(e){toast(e.message);}finally{setBusy(b,false);}
  }

  // ---------- Interview ----------
  async function loadInterviewPairs(){
    if(!hasLogin()){state.pairs=[];renderInterviewPairs();return;}
    try{const d=await post("/api/recruiter/interviews/list",{jobId:$("interviewJobFilter").value||null,candidate:$("interviewCandidateFilter").value.trim()||null});state.pairs=d.pairs||[];renderInterviewPairs();}catch(e){toast(e.message);}
  }
  function renderInterviewPairs(){
    $("interviewPairs").innerHTML=state.pairs.map(p=>`<div class="pair-row"><div><h4>${esc(p.name)}</h4><p>${esc(p.email||"No email")}</p></div><div><h4>${esc(p.title)}</h4><p>${esc(p.company_name||"")} • ${esc(p.pipeline_status)}</p></div><div>${p.score!=null?`<b>${Math.round(p.score)}</b><p>${esc(p.recommendation||"")}</p>`:"<p>Unranked</p>"}</div><button class="primary" data-start-interview="${p.job_id}|${p.candidate_id}">Interview</button></div>`).join("");
    $("interviewEmpty").classList.toggle("hidden",state.pairs.length>0);document.querySelectorAll("[data-start-interview]").forEach(b=>b.onclick=()=>{const [j,c]=b.dataset.startInterview.split("|");startInterview(j,c);});
  }
  $("interviewJobFilter").onchange=loadInterviewPairs;let candidateTimer;$("interviewCandidateFilter").oninput=()=>{clearTimeout(candidateTimer);candidateTimer=setTimeout(loadInterviewPairs,300);};$("refreshInterviews").onclick=loadInterviewPairs;

  async function startInterview(jobId,candidateId){
    $("jobModal").classList.add("hidden");$("interviewModalBody").innerHTML='<div style="padding:40px">Preparing role-play…</div>';$("interviewModal").classList.remove("hidden");
    try{const d=await post("/api/recruiter/interviews/start",{jobId,candidateId});state.interview={sessionId:d.sessionId,pair:d.pair,coverage:d.coverage||{},suggested:d.suggestedFirstQuestion||"",risks:d.riskAreas||[],turns:[{speaker:"candidate",message:d.candidateOpening||""},{speaker:"coach",message:d.coachWelcome||""}]};renderInterview();}catch(e){$("interviewModalBody").innerHTML=`<div style="padding:30px;color:#b91c1c">${esc(e.message)}</div>`;}
  }
  function coverageHtml(cov){return Object.entries(COVERAGE_LABELS).map(([k,l])=>`<div class="coverage-item ${cov?.[k]?"done":""}"><span>${l}</span><b>${cov?.[k]?"✓":"—"}</b></div>`).join("");}
  function renderInterview(){
    const s=state.interview,p=s.pair;
    $("interviewModalBody").innerHTML=`<div class="interview-header"><p class="eyebrow">Recruiter practice</p><h2>${esc(p.candidate_name)} — ${esc(p.title)}</h2><p style="font-size:12px;color:#64748b;margin:0">You are the recruiter. AI role-plays the candidate from the resume and coaches your questioning.</p></div><div class="interview-body"><div class="interview-chat"><div class="transcript" id="transcript">${s.turns.map(t=>`<div class="turn ${t.speaker}"><b>${t.speaker==="candidate"?p.candidate_name:t.speaker==="recruiter"?"You":"Coach"}</b><br>${esc(t.message)}</div>`).join("")}</div><div class="interview-composer"><textarea id="interviewQuestion" rows="2" placeholder="Ask your next recruiter question…">${esc(s.suggested||"")}</textarea><button class="primary" id="sendQuestion">Ask</button></div><div class="actions"><button class="secondary" id="finishInterview">Finish and assess</button></div></div><aside class="coach-panel"><h3>Coverage</h3><div class="coverage">${coverageHtml(s.coverage)}</div><div class="coach-card"><b>Best next question</b><p id="nextQuestion">${esc(s.suggested||"Start with the candidate's current role and scope.")}</p></div><div class="coach-card"><b>Risks / unknowns</b>${list(s.risks)}</div></aside></div>`;
    const tr=$("transcript");tr.scrollTop=tr.scrollHeight;$("sendQuestion").onclick=sendInterviewQuestion;$("finishInterview").onclick=finishInterview;
    $("interviewQuestion").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendInterviewQuestion();}});
  }
  async function sendInterviewQuestion(){
    const q=$("interviewQuestion").value.trim();if(!q)return;const b=$("sendQuestion");setBusy(b,true,"Asking…");
    try{const d=await post("/api/recruiter/interviews/turn",{sessionId:state.interview.sessionId,question:q});state.interview.turns.push({speaker:"recruiter",message:q},{speaker:"candidate",message:d.candidateAnswer||""},{speaker:"coach",message:d.questionAssessment||""});state.interview.coverage=d.coverage||state.interview.coverage;state.interview.suggested=d.suggestedNextQuestion||"";state.interview.risks=d.unresolvedRisks||[];renderInterview();}catch(e){toast(e.message);}finally{setBusy(b,false);}
  }
  async function finishInterview(){
    const b=$("finishInterview");setBusy(b,true,"Assessing…");try{const d=await post("/api/recruiter/interviews/finish",{sessionId:state.interview.sessionId});renderInterviewSummary(d.summary);}catch(e){toast(e.message);}finally{setBusy(b,false);}
  }
  function renderInterviewSummary(s){
    $("interviewModalBody").innerHTML=`<div class="interview-header"><p class="eyebrow">Practice complete</p><h2>Recruiter interview assessment</h2></div><div style="padding:24px"><div class="summary-score">${Math.round(s.interviewQualityScore||0)}<span style="font-size:14px;color:#64748b"> / 100</span></div><p>${esc(s.summary||"")}</p><div class="detail-grid"><div class="detail-box"><h4>Evidence gathered</h4>${list(s.evidenceGathered)}</div><div class="detail-box"><h4>Remaining unknowns</h4>${list(s.remainingUnknowns)}</div><div class="detail-box"><h4>Questioning strengths</h4>${list(s.questioningStrengths)}</div><div class="detail-box"><h4>Improvements</h4>${list(s.questioningImprovements)}</div><div class="detail-box" style="grid-column:1/-1"><h4>Recommended follow-ups</h4>${list(s.recommendedFollowUps)}</div></div><button class="primary" data-close-summary>Done</button></div>`;
    $("interviewModalBody").querySelector("[data-close-summary]").onclick=()=>{$("interviewModal").classList.add("hidden");loadInterviewPairs();};
  }

  // ---------- startup ----------
  async function bootstrap(){
    updateCounts();renderDraft();
    if(!hasLogin())return;
    try{const d=await post("/api/recruiter/bootstrap",{});state.jobs=d.jobs||[];state.pairs=d.pairs||[];updateCounts();renderJobs();renderInterviewPairs();fillJobFilters();}catch(e){$("accessGate").classList.remove("hidden");$("accessGate").querySelector("p").textContent=e.message;}
  }
  bootstrap();
})();
