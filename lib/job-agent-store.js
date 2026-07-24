import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

let pool = null;
let ready = false;

const cleanArray = value => Array.isArray(value) ? value.map(v => String(v || "").trim()).filter(Boolean).slice(0, 100) : [];
const json = (value, fallback = []) => JSON.stringify(value ?? fallback);

export function jobAgentOwnerKey(identity) {
  return "jba_" + crypto.createHash("sha256").update(String(identity || "")).digest("hex").slice(0, 32);
}
export function newJobAgentId() { return crypto.randomUUID(); }
export function jobAgentDbReady() { return ready; }

export async function initJobAgentStore() {
  const connectionString = config.jobAgentDatabaseUrl || config.databaseUrl;
  if (!connectionString) {
    console.warn("[job-agent-store] SMARTJOBS_DATABASE_URL or DATABASE_URL is required; job-agent endpoints will return 503.");
    return false;
  }
  const { default: Pg } = await import("pg");
  pool = new Pg.Pool({ connectionString, ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined });
  const schemaPath = fileURLToPath(new URL("../db/job_agent_schema.sql", import.meta.url));
  await pool.query(await fs.readFile(schemaPath, "utf8"));
  await pool.query(`UPDATE job_agent_runs SET status='failed',completed_at=now(),
    error_messages=error_messages || '["Run interrupted by a process restart or timeout."]'::jsonb
    WHERE status='running' AND started_at < now() - interval '2 hours'`);
  ready = true;
  console.log("[job-agent-store] Postgres schema ready.");
  return true;
}

function db() {
  if (!pool || !ready) throw new Error("job_agent_database_not_configured");
  return pool;
}

export async function upsertJobAgentAccount(owner, user, memberToken = null) {
  const q = await db().query(`INSERT INTO job_agent_accounts
    (owner_key,google_sub,email,display_name,picture_url,member_token,last_login_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,now(),now())
    ON CONFLICT (owner_key) DO UPDATE SET
      email=EXCLUDED.email, display_name=EXCLUDED.display_name, picture_url=EXCLUDED.picture_url,
      member_token=COALESCE(EXCLUDED.member_token,job_agent_accounts.member_token),
      last_login_at=now(), updated_at=now()
    RETURNING *`, [owner, user.sub, user.email, user.name || user.email, user.picture || "", memberToken || null]);
  return q.rows[0];
}

export async function getJobAgentAccount(owner) {
  const q = await db().query("SELECT * FROM job_agent_accounts WHERE owner_key=$1", [owner]);
  return q.rows[0] || null;
}

export async function bindMemberToken(owner, token) {
  await db().query("UPDATE job_agent_accounts SET member_token=$2,updated_at=now() WHERE owner_key=$1", [owner, token || null]);
}

export async function getJobAgentUsage(owner) {
  const q = await db().query(`SELECT action,usage_count FROM job_agent_daily_usage
    WHERE owner_key=$1 AND usage_date=CURRENT_DATE`, [owner]);
  return Object.fromEntries(q.rows.map(r => [r.action, Number(r.usage_count || 0)]));
}

export async function consumeJobAgentUsage(owner, action, limit) {
  const max = Math.max(1, Number(limit || 1));
  const q = await db().query(`INSERT INTO job_agent_daily_usage
      (owner_key,usage_date,action,usage_count,updated_at)
    VALUES ($1,CURRENT_DATE,$2,1,now())
    ON CONFLICT (owner_key,usage_date,action)
    DO UPDATE SET usage_count=job_agent_daily_usage.usage_count+1,updated_at=now()
    WHERE job_agent_daily_usage.usage_count < $3
    RETURNING usage_count`, [owner, action, max]);
  if (q.rows[0]) return { allowed: true, used: Number(q.rows[0].usage_count), limit: max };
  const current = await db().query(`SELECT usage_count FROM job_agent_daily_usage
    WHERE owner_key=$1 AND usage_date=CURRENT_DATE AND action=$2`, [owner, action]);
  return { allowed: false, used: Number(current.rows[0]?.usage_count || max), limit: max };
}

function normalizedAgentInput(input = {}) {
  const scheduleFrequency = ["daily", "weekly", "monthly"].includes(input.scheduleFrequency) ? input.scheduleFrequency : "weekly";
  const scheduleTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.scheduleTime || "")) ? String(input.scheduleTime) : "07:00";
  return {
    name: String(input.name || "My job search agent").trim().slice(0, 160),
    profileSummary: String(input.profileSummary || "").trim().slice(0, 80000),
    targetTitles: cleanArray(input.targetTitles),
    preferredTitleTerms: cleanArray(input.preferredTitleTerms),
    excludedTitleTerms: cleanArray(input.excludedTitleTerms),
    industries: cleanArray(input.industries),
    roleKeywords: cleanArray(input.roleKeywords),
    excludedKeywords: cleanArray(input.excludedKeywords),
    priorityCities: cleanArray(input.priorityCities),
    states: cleanArray(input.states),
    regions: cleanArray(input.regions),
    remoteEligible: input.remoteEligible !== false,
    minBaseCompensation: input.minBaseCompensation !== null && input.minBaseCompensation !== undefined && input.minBaseCompensation !== "" && Number.isFinite(Number(input.minBaseCompensation)) ? Math.max(0, Number(input.minBaseCompensation)) : null,
    minTotalCompensation: input.minTotalCompensation !== null && input.minTotalCompensation !== undefined && input.minTotalCompensation !== "" && Number.isFinite(Number(input.minTotalCompensation)) ? Math.max(0, Number(input.minTotalCompensation)) : null,
    maxResults: Math.min(75, Math.max(5, Number(input.maxResults || 25))),
    maxPostingAgeDays: Math.min(3650, Math.max(0, Number(input.maxPostingAgeDays ?? 30))),
    postingDatePolicy: ["require_date", "allow_missing", "ignore"].includes(input.postingDatePolicy) ? input.postingDatePolicy : "allow_missing",
    repostPolicy: ["use_original", "use_latest", "exclude"].includes(input.repostPolicy) ? input.repostPolicy : "use_original",
    officialSourcesOnly: input.officialSourcesOnly !== false,
    verifyApplicationOpen: input.verifyApplicationOpen !== false,
    allowAggregatorDiscovery: input.allowAggregatorDiscovery !== false,
    preferredSourceSystems: cleanArray(input.preferredSourceSystems).length ? cleanArray(input.preferredSourceSystems) : ["workday", "adp", "greenhouse", "lever", "smartrecruiters", "successfactors", "oracle", "icims", "ukg", "dayforce", "jobvite", "ashby", "avature", "eightfold", "phenom", "employer"],
    searchPlan: input.searchPlan && typeof input.searchPlan === "object" ? input.searchPlan : {},
    scheduleEnabled: Boolean(input.scheduleEnabled),
    scheduleFrequency,
    scheduleTime,
    scheduleDay: Math.min(scheduleFrequency === "monthly" ? 28 : 6, Math.max(scheduleFrequency === "monthly" ? 1 : 0, Number(input.scheduleDay ?? 1))),
    timezone: String(input.timezone || "America/New_York").trim().slice(0, 80),
    emailEnabled: input.emailEnabled !== false,
    digestHour: Math.min(23, Math.max(0, Number(input.digestHour ?? 20))),
    isActive: input.isActive !== false,
    nextRunAt: input.nextRunAt || null,
  };
}

export async function saveJobSearchAgent(owner, input) {
  const d = normalizedAgentInput(input);
  if (input.id) {
    const q = await db().query(`UPDATE job_search_agents SET
      name=$3,profile_summary=$4,target_titles=$5::jsonb,preferred_title_terms=$6::jsonb,
      excluded_title_terms=$7::jsonb,industries=$8::jsonb,role_keywords=$9::jsonb,
      excluded_keywords=$10::jsonb,priority_cities=$11::jsonb,states=$12::jsonb,regions=$13::jsonb,
      remote_eligible=$14,min_base_compensation=$15,min_total_compensation=$16,max_results=$17,
      max_posting_age_days=$18,posting_date_policy=$19,repost_policy=$20,official_sources_only=$21,
      verify_application_open=$22,allow_aggregator_discovery=$23,preferred_source_systems=$24::jsonb,
      search_plan=$25::jsonb,schedule_enabled=$26,schedule_frequency=$27,schedule_time=$28,
      schedule_day=$29,timezone=$30,email_enabled=$31,digest_hour=$32,is_active=$33,
      next_run_at=$34,updated_at=now()
      WHERE id=$1 AND owner_key=$2 RETURNING *`, [input.id, owner, d.name, d.profileSummary, json(d.targetTitles), json(d.preferredTitleTerms),
      json(d.excludedTitleTerms), json(d.industries), json(d.roleKeywords), json(d.excludedKeywords), json(d.priorityCities),
      json(d.states), json(d.regions), d.remoteEligible, d.minBaseCompensation, d.minTotalCompensation, d.maxResults,
      d.maxPostingAgeDays, d.postingDatePolicy, d.repostPolicy, d.officialSourcesOnly, d.verifyApplicationOpen,
      d.allowAggregatorDiscovery, json(d.preferredSourceSystems), json(d.searchPlan, {}), d.scheduleEnabled,
      d.scheduleFrequency, d.scheduleTime, d.scheduleDay, d.timezone, d.emailEnabled, d.digestHour,
      d.isActive, d.nextRunAt]);
    return q.rows[0] || null;
  }
  const id = newJobAgentId();
  const q = await db().query(`INSERT INTO job_search_agents
    (id,owner_key,name,profile_summary,target_titles,preferred_title_terms,excluded_title_terms,industries,
     role_keywords,excluded_keywords,priority_cities,states,regions,remote_eligible,min_base_compensation,
     min_total_compensation,max_results,max_posting_age_days,posting_date_policy,repost_policy,
     official_sources_only,verify_application_open,allow_aggregator_discovery,preferred_source_systems,
     search_plan,schedule_enabled,schedule_frequency,schedule_time,schedule_day,timezone,email_enabled,
     digest_hour,is_active,next_run_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
      $12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26,$27,
      $28,$29,$30,$31,$32,$33,$34)
    RETURNING *`, [id, owner, d.name, d.profileSummary, json(d.targetTitles), json(d.preferredTitleTerms),
    json(d.excludedTitleTerms), json(d.industries), json(d.roleKeywords), json(d.excludedKeywords), json(d.priorityCities),
    json(d.states), json(d.regions), d.remoteEligible, d.minBaseCompensation, d.minTotalCompensation, d.maxResults,
    d.maxPostingAgeDays, d.postingDatePolicy, d.repostPolicy, d.officialSourcesOnly, d.verifyApplicationOpen,
    d.allowAggregatorDiscovery, json(d.preferredSourceSystems), json(d.searchPlan, {}), d.scheduleEnabled,
    d.scheduleFrequency, d.scheduleTime, d.scheduleDay, d.timezone, d.emailEnabled, d.digestHour,
    d.isActive, d.nextRunAt]);
  return q.rows[0];
}

export async function listJobSearchAgents(owner) {
  const q = await db().query(`SELECT a.*,
    (SELECT COUNT(*)::int FROM job_agent_results r WHERE r.agent_id=a.id) AS result_count,
    (SELECT COUNT(*)::int FROM job_agent_results r WHERE r.agent_id=a.id AND r.workflow_status='new') AS new_count,
    (SELECT status FROM job_agent_runs x WHERE x.agent_id=a.id ORDER BY started_at DESC LIMIT 1) AS last_run_status
    FROM job_search_agents a WHERE a.owner_key=$1 ORDER BY a.updated_at DESC`, [owner]);
  return q.rows;
}

export async function getJobSearchAgent(owner, agentId) {
  const q = await db().query("SELECT * FROM job_search_agents WHERE id=$1 AND owner_key=$2", [agentId, owner]);
  return q.rows[0] || null;
}

export async function deleteJobSearchAgent(owner, agentId) {
  const q = await db().query("DELETE FROM job_search_agents WHERE id=$1 AND owner_key=$2 RETURNING id", [agentId, owner]);
  return Boolean(q.rows[0]);
}

export async function setJobSearchAgentNextRun(owner, agentId, nextRunAt) {
  const q = await db().query(`UPDATE job_search_agents SET next_run_at=$3,updated_at=now()
    WHERE id=$1 AND owner_key=$2 RETURNING *`, [agentId, owner, nextRunAt || null]);
  return q.rows[0] || null;
}

export async function updateAgentPlan(owner, agentId, searchPlan) {
  const q = await db().query(`UPDATE job_search_agents SET search_plan=$3::jsonb,updated_at=now()
    WHERE id=$1 AND owner_key=$2 RETURNING *`, [agentId, owner, json(searchPlan, {})]);
  return q.rows[0] || null;
}

export async function hasRunningJobAgentRun(owner, agentId) {
  const q = await db().query(`SELECT 1 FROM job_agent_runs WHERE owner_key=$1 AND agent_id=$2 AND status='running' AND started_at > now()-interval '2 hours' LIMIT 1`, [owner, agentId]);
  return Boolean(q.rows[0]);
}

export async function createJobAgentRun(owner, agentId, triggerType = "manual") {
  const id = newJobAgentId();
  const q = await db().query(`INSERT INTO job_agent_runs (id,owner_key,agent_id,trigger_type,status)
    SELECT $1,$2,id,$3,'running' FROM job_search_agents WHERE id=$4 AND owner_key=$2 RETURNING *`,
  [id, owner, triggerType, agentId]);
  return q.rows[0] || null;
}

export async function finishJobAgentRun(runId, status, stats = {}, errors = []) {
  const q = await db().query(`UPDATE job_agent_runs SET status=$2,query_count=$3,discovered_count=$4,
    verified_count=$5,recommended_count=$6,skipped_count=$7,empty_query_count=$8,
    provider_diagnostics=$9::jsonb,rejection_reasons=$10::jsonb,error_messages=$11::jsonb,completed_at=now()
    WHERE id=$1 RETURNING *`, [runId, status, Number(stats.queryCount || 0), Number(stats.discoveredCount || 0),
    Number(stats.verifiedCount || 0), Number(stats.recommendedCount || 0), Number(stats.skippedCount || 0),
    Number(stats.emptyQueryCount || 0), json(stats.providerDiagnostics, {}), json(stats.rejectionReasons, {}), json(errors)]);
  return q.rows[0] || null;
}

export async function markAgentRunTime(owner, agentId, nextRunAt = null) {
  await db().query(`UPDATE job_search_agents SET last_run_at=now(),next_run_at=$3,updated_at=now()
    WHERE id=$1 AND owner_key=$2`, [agentId, owner, nextRunAt]);
}

export async function upsertJobAgentResult(owner, agentId, runId, job, evaluation) {
  const id = newJobAgentId();
  const q = await db().query(`INSERT INTO job_agent_results
    (id,owner_key,agent_id,canonical_key,source_url,final_url,source_host,source_system,requisition_id,title,company,location,
     remote_eligible,compensation_text,compensation_min,compensation_max,compensation_currency,date_posted,
     original_date_posted,posting_date_source,repost_detected,valid_through,description_text,official_source,
     active_verified,application_open_verified,active_verified_at,fit_score,recommended,fit_summary,
     mandatory_qualifications,preferred_qualifications,material_gaps,compensation_assessment,evaluation_reason,
     raw_data,last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
      $25,$26,now(),$27,$28,$29,$30::jsonb,$31::jsonb,$32::jsonb,$33,$34,$35::jsonb,now())
    ON CONFLICT (owner_key,agent_id,canonical_key) DO UPDATE SET
      source_url=EXCLUDED.source_url,final_url=EXCLUDED.final_url,source_host=EXCLUDED.source_host,
      source_system=EXCLUDED.source_system,requisition_id=EXCLUDED.requisition_id,title=EXCLUDED.title,
      company=EXCLUDED.company,location=EXCLUDED.location,remote_eligible=EXCLUDED.remote_eligible,
      compensation_text=EXCLUDED.compensation_text,compensation_min=EXCLUDED.compensation_min,
      compensation_max=EXCLUDED.compensation_max,compensation_currency=EXCLUDED.compensation_currency,
      date_posted=COALESCE(EXCLUDED.date_posted,job_agent_results.date_posted),
      original_date_posted=COALESCE(EXCLUDED.original_date_posted,job_agent_results.original_date_posted),
      posting_date_source=COALESCE(NULLIF(EXCLUDED.posting_date_source,''),job_agent_results.posting_date_source),
      repost_detected=EXCLUDED.repost_detected,valid_through=EXCLUDED.valid_through,
      description_text=EXCLUDED.description_text,official_source=EXCLUDED.official_source,
      active_verified=EXCLUDED.active_verified,application_open_verified=EXCLUDED.application_open_verified,
      active_verified_at=now(),fit_score=EXCLUDED.fit_score,recommended=EXCLUDED.recommended,
      fit_summary=EXCLUDED.fit_summary,mandatory_qualifications=EXCLUDED.mandatory_qualifications,
      preferred_qualifications=EXCLUDED.preferred_qualifications,material_gaps=EXCLUDED.material_gaps,
      compensation_assessment=EXCLUDED.compensation_assessment,evaluation_reason=EXCLUDED.evaluation_reason,
      raw_data=EXCLUDED.raw_data,last_seen_at=now()
    RETURNING id,(xmax=0) AS inserted`, [id, owner, agentId, job.canonical_key, job.source_url, job.final_url,
    job.source_host || "", job.source_system || "employer", job.requisition_id || "", job.title,
    job.company || "", job.location || "", Boolean(job.remote), job.compensation_text || "",
    job.compensation_min, job.compensation_max, job.compensation_currency || "USD", job.date_posted || null,
    job.original_date_posted || null, job.posting_date_source || "", Boolean(job.repost_detected),
    job.valid_through || null, job.description_text || "", Boolean(job.official_source),
    Boolean(job.active_verified), Boolean(job.application_open_verified),
    Math.max(0, Math.min(100, Number(evaluation.fitScore || 0))), Boolean(evaluation.recommended),
    evaluation.fitSummary || "", json(evaluation.mandatoryQualifications), json(evaluation.preferredQualifications),
    json(evaluation.materialGaps), evaluation.compensationAssessment || "unclear",
    evaluation.whyIncludedOrExcluded || "", json(job.raw_data, {})]);
  const row = q.rows[0];
  await db().query(`INSERT INTO job_agent_run_results (run_id,result_id,is_new) VALUES ($1,$2,$3)
    ON CONFLICT (run_id,result_id) DO UPDATE SET is_new=EXCLUDED.is_new`, [runId, row.id, Boolean(row.inserted)]);
  return { id: row.id, inserted: Boolean(row.inserted) };
}

export async function listJobAgentResults(owner, filters = {}) {
  const values = [owner];
  const where = ["r.owner_key=$1"];
  if (filters.agentId) { values.push(filters.agentId); where.push(`r.agent_id=$${values.length}`); }
  if (filters.status && ["new", "saved", "approved", "rejected", "applied"].includes(filters.status)) {
    values.push(filters.status); where.push(`r.workflow_status=$${values.length}`);
  }
  if (filters.recommended === true) where.push("r.recommended=true");
  const limit = Math.min(250, Math.max(1, Number(filters.limit || 100)));
  values.push(limit);
  const q = await db().query(`SELECT r.*,a.name AS agent_name FROM job_agent_results r
    JOIN job_search_agents a ON a.id=r.agent_id
    WHERE ${where.join(" AND ")}
    ORDER BY CASE r.workflow_status WHEN 'new' THEN 0 WHEN 'approved' THEN 1 WHEN 'saved' THEN 2 WHEN 'applied' THEN 3 ELSE 4 END,
      r.recommended DESC,r.fit_score DESC,r.last_seen_at DESC LIMIT $${values.length}`, values);
  return q.rows;
}

export async function updateJobAgentResultStatus(owner, resultId, status) {
  const allowed = ["new", "saved", "approved", "rejected", "applied"];
  if (!allowed.includes(status)) throw new Error("invalid_result_status");
  const q = await db().query(`UPDATE job_agent_results SET workflow_status=$3,
    applied_at=CASE WHEN $3='applied' THEN COALESCE(applied_at,now()) ELSE applied_at END
    WHERE id=$1 AND owner_key=$2 RETURNING *`, [resultId, owner, status]);
  return q.rows[0] || null;
}

export async function listRecentJobAgentRuns(owner, limit = 30) {
  const q = await db().query(`SELECT x.*,a.name AS agent_name FROM job_agent_runs x
    JOIN job_search_agents a ON a.id=x.agent_id WHERE x.owner_key=$1
    ORDER BY x.started_at DESC LIMIT $2`, [owner, Math.min(100, Math.max(1, Number(limit || 30)))]);
  return q.rows;
}

export async function listDueJobSearchAgents(limit = 5) {
  const q = await db().query(`SELECT a.*,u.email,u.display_name,u.member_token FROM job_search_agents a
    JOIN job_agent_accounts u ON u.owner_key=a.owner_key
    WHERE a.schedule_enabled=true AND a.is_active=true AND a.next_run_at IS NOT NULL AND a.next_run_at<=now()
      AND NOT EXISTS (SELECT 1 FROM job_agent_runs r WHERE r.agent_id=a.id AND r.status='running' AND r.started_at>now()-interval '2 hours')
    ORDER BY a.next_run_at ASC LIMIT $1`, [Math.min(20, Math.max(1, Number(limit || 5)))]);
  return q.rows;
}

export async function listDigestDueAgents() {
  const q = await db().query(`SELECT a.*,u.email,u.display_name,u.member_token FROM job_search_agents a
    JOIN job_agent_accounts u ON u.owner_key=a.owner_key
    WHERE a.email_enabled=true AND a.is_active=true`);
  return q.rows;
}

export async function getUnsentDigestResults(agentId, limit = 40) {
  const q = await db().query(`SELECT * FROM job_agent_results WHERE agent_id=$1 AND recommended=true
    AND workflow_status<>'rejected' AND email_sent_at IS NULL ORDER BY fit_score DESC,last_seen_at DESC LIMIT $2`,
  [agentId, Math.min(100, Math.max(1, Number(limit || 40)))]);
  return q.rows;
}

export async function markDigestSent(agentId, resultIds) {
  const ids = Array.isArray(resultIds) ? resultIds.filter(Boolean) : [];
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    if (ids.length) await client.query("UPDATE job_agent_results SET email_sent_at=now() WHERE agent_id=$1 AND id=ANY($2::uuid[])", [agentId, ids]);
    await client.query("UPDATE job_search_agents SET last_digest_at=now() WHERE id=$1", [agentId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}

export async function withJobAgentSchedulerLock(callback) {
  const client = await db().connect();
  let locked = false;
  try {
    const q = await client.query("SELECT pg_try_advisory_lock(hashtext('smartjobs_job_agent_scheduler')) AS locked");
    locked = Boolean(q.rows[0]?.locked);
    if (!locked) return false;
    await callback();
    return true;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('smartjobs_job_agent_scheduler'))").catch(() => {});
    client.release();
  }
}
