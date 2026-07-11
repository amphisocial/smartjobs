import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

let pool = null;
let ready = false;

export function recruiterOwnerKey(identity) {
  return "rec_" + crypto.createHash("sha256").update(String(identity || "")).digest("hex").slice(0, 32);
}
export function resumeHash(text) {
  return crypto.createHash("sha256").update(String(text || "").trim()).digest("hex");
}
export function newId() { return crypto.randomUUID(); }
export function recruiterDbReady() { return ready; }

export async function initRecruiterStore() {
  if (!config.databaseUrl) {
    console.warn("[recruiter-store] DATABASE_URL is required for recruiter workspace; endpoints will return 503.");
    return false;
  }
  const { default: Pg } = await import("pg");
  pool = new Pg.Pool({ connectionString: config.databaseUrl, ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined });
  const schemaPath = fileURLToPath(new URL("../db/recruiter_schema.sql", import.meta.url));
  await pool.query(await fs.readFile(schemaPath, "utf8"));
  ready = true;
  console.log("[recruiter-store] Postgres schema ready.");
  return true;
}

function db() {
  if (!pool || !ready) throw new Error("recruiter_database_not_configured");
  return pool;
}
function json(v, fallback = []) { return JSON.stringify(v ?? fallback); }

export async function migrateRecruiterOwner(oldOwner, newOwner) {
  if (!oldOwner || !newOwner || oldOwner === newOwner) return 0;
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const count = await client.query(
      "SELECT COUNT(*)::int AS n FROM recruiter_jobs WHERE recruiter_key=$1",
      [oldOwner],
    );
    const moved = Number(count.rows[0]?.n || 0);
    if (moved > 0) {
      await client.query("UPDATE recruiter_jobs SET recruiter_key=$2 WHERE recruiter_key=$1", [oldOwner, newOwner]);
      await client.query("UPDATE recruiter_candidates SET recruiter_key=$2 WHERE recruiter_key=$1", [oldOwner, newOwner]);
      await client.query("UPDATE recruiter_job_builder_sessions SET recruiter_key=$2 WHERE recruiter_key=$1", [oldOwner, newOwner]);
      await client.query("UPDATE recruiter_interview_sessions SET recruiter_key=$2 WHERE recruiter_key=$1", [oldOwner, newOwner]);
    }
    await client.query("COMMIT");
    return moved;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertRecruiterAccount(owner, user) {
  const q = await db().query(`INSERT INTO recruiter_accounts
    (recruiter_key,email,display_name,picture_url,last_login_at)
    VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (recruiter_key) DO UPDATE SET
      email=EXCLUDED.email, display_name=EXCLUDED.display_name,
      picture_url=EXCLUDED.picture_url, last_login_at=now()
    RETURNING recruiter_key,email,display_name,picture_url,created_at,last_login_at`,
    [owner, user.email, user.name || user.email, user.picture || ""]);
  return q.rows[0];
}

export async function getDailyUsage(owner) {
  const q = await db().query(`SELECT action,usage_count
    FROM recruiter_daily_usage
    WHERE recruiter_key=$1 AND usage_date=CURRENT_DATE`, [owner]);
  return Object.fromEntries(q.rows.map(r => [r.action, Number(r.usage_count || 0)]));
}

export async function consumeDailyUsage(owner, action, limit) {
  const max = Math.max(1, Number(limit || 1));
  const q = await db().query(`INSERT INTO recruiter_daily_usage
      (recruiter_key,usage_date,action,usage_count,updated_at)
    VALUES ($1,CURRENT_DATE,$2,1,now())
    ON CONFLICT (recruiter_key,usage_date,action)
    DO UPDATE SET usage_count=recruiter_daily_usage.usage_count + 1, updated_at=now()
    WHERE recruiter_daily_usage.usage_count < $3
    RETURNING usage_count`, [owner, action, max]);
  if (q.rows[0]) return { allowed: true, used: Number(q.rows[0].usage_count), limit: max };
  const current = await db().query(`SELECT usage_count FROM recruiter_daily_usage
    WHERE recruiter_key=$1 AND usage_date=CURRENT_DATE AND action=$2`, [owner, action]);
  return { allowed: false, used: Number(current.rows[0]?.usage_count || max), limit: max };
}


export async function createJob(owner, actor, input) {
  const id = newId();
  const q = await db().query(`INSERT INTO recruiter_jobs
    (id,recruiter_key,title,company_name,start_date,status,source_type,source_url,raw_description,role_description,must_have,preferred_qualifications,nice_to_have,responsibilities,screening_questions,metadata,created_by,modified_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$17)
    RETURNING *`, [id, owner, input.title, input.companyName || "", input.startDate || null, input.status || "open", input.sourceType || "paste", input.sourceUrl || null,
    input.rawDescription || "", input.roleDescription || "", json(input.mustHave), json(input.preferredQualifications), json(input.niceToHave), json(input.responsibilities), json(input.screeningQuestions), json(input.metadata, {}), actor]);
  return q.rows[0];
}

export async function listJobs(owner) {
  const q = await db().query(`SELECT j.*,
    COUNT(jc.candidate_id)::int AS candidate_count,
    COUNT(r.candidate_id) FILTER (WHERE r.job_version=j.row_version AND r.candidate_hash=c.resume_hash)::int AS ranked_count,
    COUNT(jc.candidate_id) FILTER (WHERE r.candidate_id IS NULL OR r.job_version<>j.row_version OR r.candidate_hash<>c.resume_hash)::int AS unranked_count
    FROM recruiter_jobs j
    LEFT JOIN recruiter_job_candidates jc ON jc.job_id=j.id
    LEFT JOIN recruiter_candidates c ON c.id=jc.candidate_id
    LEFT JOIN recruiter_candidate_rankings r ON r.job_id=j.id AND r.candidate_id=jc.candidate_id
    WHERE j.recruiter_key=$1
    GROUP BY j.id ORDER BY j.modified_at DESC`, [owner]);
  return q.rows;
}

export async function getJob(owner, jobId) {
  const jq = await db().query("SELECT * FROM recruiter_jobs WHERE id=$1 AND recruiter_key=$2", [jobId, owner]);
  if (!jq.rows[0]) return null;
  const cq = await db().query(`SELECT c.*, jc.pipeline_status, jc.notes, jc.added_at,
    r.score, r.rank_position, r.recommendation, r.summary AS ranking_summary, r.strengths, r.concerns,
    r.matched_requirements, r.missing_requirements, r.reasons, r.interview_focus, r.ranked_at,
    CASE WHEN r.candidate_id IS NULL THEN 'unranked'
         WHEN r.job_version<>$2 OR r.candidate_hash<>c.resume_hash THEN 'stale'
         ELSE 'ranked' END AS ranking_state
    FROM recruiter_job_candidates jc
    JOIN recruiter_candidates c ON c.id=jc.candidate_id
    LEFT JOIN recruiter_candidate_rankings r ON r.job_id=jc.job_id AND r.candidate_id=jc.candidate_id
    WHERE jc.job_id=$1 AND c.recruiter_key=$3
    ORDER BY CASE WHEN r.job_version=$2 AND r.candidate_hash=c.resume_hash THEN 0 ELSE 1 END, r.score DESC NULLS LAST, c.name`, [jobId, jq.rows[0].row_version, owner]);
  return { ...jq.rows[0], candidates: cq.rows };
}

export async function updateJob(owner, actor, jobId, input) {
  const q = await db().query(`UPDATE recruiter_jobs SET
    title=COALESCE($3,title), company_name=COALESCE($4,company_name), start_date=$5,
    status=COALESCE($6,status), raw_description=COALESCE($7,raw_description), role_description=COALESCE($8,role_description),
    must_have=COALESCE($9::jsonb,must_have), preferred_qualifications=COALESCE($10::jsonb,preferred_qualifications),
    nice_to_have=COALESCE($11::jsonb,nice_to_have), responsibilities=COALESCE($12::jsonb,responsibilities),
    screening_questions=COALESCE($13::jsonb,screening_questions), metadata=COALESCE($14::jsonb,metadata),
    modified_by=$15, modified_at=now(),
    row_version=row_version + CASE WHEN
      COALESCE($3,title) IS DISTINCT FROM title OR COALESCE($4,company_name) IS DISTINCT FROM company_name OR
      COALESCE($7,raw_description) IS DISTINCT FROM raw_description OR COALESCE($8,role_description) IS DISTINCT FROM role_description OR
      COALESCE($9::jsonb,must_have) IS DISTINCT FROM must_have OR COALESCE($10::jsonb,preferred_qualifications) IS DISTINCT FROM preferred_qualifications OR
      COALESCE($11::jsonb,nice_to_have) IS DISTINCT FROM nice_to_have OR COALESCE($12::jsonb,responsibilities) IS DISTINCT FROM responsibilities
      THEN 1 ELSE 0 END
    WHERE id=$1 AND recruiter_key=$2 RETURNING *`, [jobId, owner, input.title ?? null, input.companyName ?? null, input.startDate || null,
    input.status ?? null, input.rawDescription ?? null, input.roleDescription ?? null,
    input.mustHave === undefined ? null : json(input.mustHave), input.preferredQualifications === undefined ? null : json(input.preferredQualifications),
    input.niceToHave === undefined ? null : json(input.niceToHave), input.responsibilities === undefined ? null : json(input.responsibilities),
    input.screeningQuestions === undefined ? null : json(input.screeningQuestions), input.metadata === undefined ? null : json(input.metadata, {}), actor]);
  return q.rows[0] || null;
}

export async function addCandidate(owner, actor, jobId, input) {
  const job = await db().query("SELECT id FROM recruiter_jobs WHERE id=$1 AND recruiter_key=$2", [jobId, owner]);
  if (!job.rows[0]) return null;
  const hash = resumeHash(input.resumeText);
  let c = await db().query("SELECT * FROM recruiter_candidates WHERE recruiter_key=$1 AND resume_hash=$2 LIMIT 1", [owner, hash]);
  if (!c.rows[0]) {
    const id = newId();
    c = await db().query(`INSERT INTO recruiter_candidates
      (id,recruiter_key,name,email,phone,linkedin_url,resume_text,resume_filename,resume_hash,metadata,created_by,modified_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11) RETURNING *`,
      [id, owner, input.name, input.email || "", input.phone || "", input.linkedinUrl || "", input.resumeText, input.resumeFilename || "", hash, json(input.metadata, {}), actor]);
  }
  await db().query(`INSERT INTO recruiter_job_candidates (job_id,candidate_id,pipeline_status,notes,added_by,modified_by)
    VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (job_id,candidate_id) DO UPDATE SET pipeline_status=EXCLUDED.pipeline_status, notes=EXCLUDED.notes, modified_by=EXCLUDED.modified_by, modified_at=now()`,
    [jobId, c.rows[0].id, input.pipelineStatus || "new", input.notes || "", actor]);
  return c.rows[0];
}

export async function updateCandidatePipeline(owner, actor, jobId, candidateId, status, notes = "") {
  const q = await db().query(`UPDATE recruiter_job_candidates jc SET pipeline_status=$4,notes=$5,modified_by=$3,modified_at=now()
    FROM recruiter_jobs j, recruiter_candidates c WHERE jc.job_id=$1 AND jc.candidate_id=$2 AND j.id=jc.job_id AND c.id=jc.candidate_id AND j.recruiter_key=$6 AND c.recruiter_key=$6 RETURNING jc.*`,
    [jobId, candidateId, actor, status, notes, owner]);
  return q.rows[0] || null;
}

export async function saveRanking(owner, actor, job, candidate, rank, modelProvider, modelName) {
  const recommendation = ["strong_yes", "yes", "maybe", "no"].includes(String(rank.recommendation || "").toLowerCase())
    ? String(rank.recommendation).toLowerCase() : "maybe";
  const score = Math.max(0, Math.min(100, Number(rank.score || 0)));
  await db().query(`INSERT INTO recruiter_candidate_rankings
    (job_id,candidate_id,score,recommendation,summary,strengths,concerns,matched_requirements,missing_requirements,reasons,interview_focus,model_provider,model_name,job_version,candidate_hash,ranked_by,ranked_at)
    SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,now()
    WHERE EXISTS (SELECT 1 FROM recruiter_jobs WHERE id=$1 AND recruiter_key=$17)
    ON CONFLICT (job_id,candidate_id) DO UPDATE SET score=EXCLUDED.score,recommendation=EXCLUDED.recommendation,summary=EXCLUDED.summary,
      strengths=EXCLUDED.strengths,concerns=EXCLUDED.concerns,matched_requirements=EXCLUDED.matched_requirements,missing_requirements=EXCLUDED.missing_requirements,
      reasons=EXCLUDED.reasons,interview_focus=EXCLUDED.interview_focus,model_provider=EXCLUDED.model_provider,model_name=EXCLUDED.model_name,
      job_version=EXCLUDED.job_version,candidate_hash=EXCLUDED.candidate_hash,ranked_by=EXCLUDED.ranked_by,ranked_at=now()`,
    [job.id, candidate.id, score, recommendation, rank.summary || "", json(rank.strengths), json(rank.concerns), json(rank.matchedRequirements), json(rank.missingRequirements), json(rank.reasons), json(rank.interviewFocus), modelProvider || "", modelName || "", job.row_version, candidate.resume_hash, actor, owner]);
}

export async function refreshRankPositions(jobId) {
  await db().query(`WITH ranked AS (SELECT job_id,candidate_id,ROW_NUMBER() OVER (ORDER BY score DESC, ranked_at ASC)::int AS pos FROM recruiter_candidate_rankings WHERE job_id=$1)
    UPDATE recruiter_candidate_rankings r SET rank_position=ranked.pos FROM ranked WHERE r.job_id=ranked.job_id AND r.candidate_id=ranked.candidate_id`, [jobId]);
}

export async function listInterviewPairs(owner, jobId = null, candidateText = null) {
  const q = await db().query(`SELECT j.id AS job_id,j.title,j.company_name,j.status AS job_status,c.id AS candidate_id,c.name,c.email,jc.pipeline_status,
    r.score,r.recommendation,r.interview_focus,
    (SELECT s.id FROM recruiter_interview_sessions s WHERE s.job_id=j.id AND s.candidate_id=c.id AND s.recruiter_key=$1 ORDER BY s.modified_at DESC LIMIT 1) AS last_session_id,
    (SELECT s.status FROM recruiter_interview_sessions s WHERE s.job_id=j.id AND s.candidate_id=c.id AND s.recruiter_key=$1 ORDER BY s.modified_at DESC LIMIT 1) AS last_session_status
    FROM recruiter_job_candidates jc JOIN recruiter_jobs j ON j.id=jc.job_id JOIN recruiter_candidates c ON c.id=jc.candidate_id
    LEFT JOIN recruiter_candidate_rankings r ON r.job_id=j.id AND r.candidate_id=c.id
    WHERE j.recruiter_key=$1 AND c.recruiter_key=$1 AND ($2::uuid IS NULL OR j.id=$2) AND ($3::text IS NULL OR c.name ILIKE '%'||$3||'%' OR c.email ILIKE '%'||$3||'%')
    ORDER BY j.modified_at DESC,c.name`, [owner, jobId || null, candidateText || null]);
  return q.rows;
}

export async function createJobBuilderSession(owner, actor) {
  const id = newId();
  const q = await db().query("INSERT INTO recruiter_job_builder_sessions (id,recruiter_key,created_by) VALUES ($1,$2,$3) RETURNING *", [id, owner, actor]);
  return q.rows[0];
}
export async function getJobBuilderSession(owner, sessionId) {
  const s = await db().query("SELECT * FROM recruiter_job_builder_sessions WHERE id=$1 AND recruiter_key=$2", [sessionId, owner]);
  if (!s.rows[0]) return null;
  const m = await db().query("SELECT speaker,message,payload,created_at FROM recruiter_job_builder_messages WHERE session_id=$1 ORDER BY id", [sessionId]);
  return { ...s.rows[0], messages: m.rows };
}
export async function addJobBuilderMessage(sessionId, speaker, message, payload = {}) {
  await db().query("INSERT INTO recruiter_job_builder_messages (session_id,speaker,message,payload) VALUES ($1,$2,$3,$4::jsonb)", [sessionId, speaker, message, json(payload, {})]);
  await db().query("UPDATE recruiter_job_builder_sessions SET draft=CASE WHEN $2::jsonb='{}'::jsonb THEN draft ELSE $2::jsonb END,modified_at=now() WHERE id=$1", [sessionId, json(payload?.draft || {}, {})]);
}

export async function getCandidateJob(owner, jobId, candidateId) {
  const q = await db().query(`SELECT j.*,c.id AS candidate_id,c.name AS candidate_name,c.resume_text,c.resume_hash,c.email AS candidate_email,c.linkedin_url AS candidate_linkedin,
    r.score,r.recommendation,r.interview_focus,r.concerns AS ranking_concerns,r.missing_requirements
    FROM recruiter_jobs j JOIN recruiter_job_candidates jc ON jc.job_id=j.id JOIN recruiter_candidates c ON c.id=jc.candidate_id
    LEFT JOIN recruiter_candidate_rankings r ON r.job_id=j.id AND r.candidate_id=c.id
    WHERE j.id=$1 AND c.id=$2 AND j.recruiter_key=$3 AND c.recruiter_key=$3`, [jobId, candidateId, owner]);
  return q.rows[0] || null;
}
export async function createInterviewSession(owner, actor, jobId, candidateId, coverage = {}) {
  const id = newId();
  const q = await db().query(`INSERT INTO recruiter_interview_sessions (id,recruiter_key,job_id,candidate_id,coverage,created_by)
    SELECT $1,$2,$3,$4,$5::jsonb,$6 WHERE EXISTS (SELECT 1 FROM recruiter_jobs WHERE id=$3 AND recruiter_key=$2) RETURNING *`, [id, owner, jobId, candidateId, json(coverage, {}), actor]);
  return q.rows[0] || null;
}
export async function getInterviewSession(owner, sessionId) {
  const s = await db().query("SELECT * FROM recruiter_interview_sessions WHERE id=$1 AND recruiter_key=$2", [sessionId, owner]);
  if (!s.rows[0]) return null;
  const t = await db().query("SELECT speaker,message,coach,created_at FROM recruiter_interview_turns WHERE session_id=$1 ORDER BY id", [sessionId]);
  return { ...s.rows[0], turns: t.rows };
}
export async function addInterviewTurn(sessionId, speaker, message, coach = {}) {
  await db().query("INSERT INTO recruiter_interview_turns (session_id,speaker,message,coach) VALUES ($1,$2,$3,$4::jsonb)", [sessionId, speaker, message, json(coach, {})]);
  await db().query("UPDATE recruiter_interview_sessions SET coverage=CASE WHEN $2::jsonb='{}'::jsonb THEN coverage ELSE $2::jsonb END,modified_at=now() WHERE id=$1", [sessionId, json(coach?.coverage || {}, {})]);
}
export async function completeInterviewSession(sessionId, summary) {
  const q = await db().query("UPDATE recruiter_interview_sessions SET status='completed',summary=$2::jsonb,modified_at=now(),completed_at=now() WHERE id=$1 RETURNING *", [sessionId, json(summary, {})]);
  return q.rows[0] || null;
}
