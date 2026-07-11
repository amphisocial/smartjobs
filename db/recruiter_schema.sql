BEGIN;

CREATE TABLE IF NOT EXISTS recruiter_jobs (
  id UUID PRIMARY KEY,
  recruiter_key TEXT NOT NULL,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  start_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_process','closed')),
  source_type TEXT NOT NULL DEFAULT 'paste' CHECK (source_type IN ('paste','external_link','linkedin','ai_help')),
  source_url TEXT,
  raw_description TEXT NOT NULL DEFAULT '',
  role_description TEXT NOT NULL DEFAULT '',
  must_have JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_qualifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  nice_to_have JSONB NOT NULL DEFAULT '[]'::jsonb,
  responsibilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  screening_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by TEXT NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS recruiter_jobs_owner_idx ON recruiter_jobs (recruiter_key, modified_at DESC);
CREATE INDEX IF NOT EXISTS recruiter_jobs_status_idx ON recruiter_jobs (recruiter_key, status);

CREATE TABLE IF NOT EXISTS recruiter_candidates (
  id UUID PRIMARY KEY,
  recruiter_key TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  resume_text TEXT NOT NULL,
  resume_filename TEXT NOT NULL DEFAULT '',
  resume_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by TEXT NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_candidates_owner_idx ON recruiter_candidates (recruiter_key, modified_at DESC);
CREATE INDEX IF NOT EXISTS recruiter_candidates_hash_idx ON recruiter_candidates (recruiter_key, resume_hash);

CREATE TABLE IF NOT EXISTS recruiter_job_candidates (
  job_id UUID NOT NULL REFERENCES recruiter_jobs(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES recruiter_candidates(id) ON DELETE CASCADE,
  pipeline_status TEXT NOT NULL DEFAULT 'new' CHECK (pipeline_status IN ('new','screening','interview','offer','rejected','withdrawn','hired')),
  notes TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by TEXT NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS recruiter_job_candidates_candidate_idx ON recruiter_job_candidates (candidate_id, modified_at DESC);

CREATE TABLE IF NOT EXISTS recruiter_candidate_rankings (
  job_id UUID NOT NULL REFERENCES recruiter_jobs(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES recruiter_candidates(id) ON DELETE CASCADE,
  score NUMERIC(5,2) NOT NULL,
  rank_position INTEGER,
  recommendation TEXT NOT NULL DEFAULT 'maybe' CHECK (recommendation IN ('strong_yes','yes','maybe','no')),
  summary TEXT NOT NULL DEFAULT '',
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns JSONB NOT NULL DEFAULT '[]'::jsonb,
  matched_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  interview_focus JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_provider TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  job_version INTEGER NOT NULL,
  candidate_hash TEXT NOT NULL,
  ranked_by TEXT NOT NULL,
  ranked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS recruiter_rankings_job_idx ON recruiter_candidate_rankings (job_id, score DESC);

CREATE TABLE IF NOT EXISTS recruiter_job_builder_sessions (
  id UUID PRIMARY KEY,
  recruiter_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'AI job builder',
  draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_job_builder_sessions_owner_idx ON recruiter_job_builder_sessions (recruiter_key, modified_at DESC);

CREATE TABLE IF NOT EXISTS recruiter_job_builder_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES recruiter_job_builder_sessions(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('recruiter','assistant')),
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_job_builder_messages_session_idx ON recruiter_job_builder_messages (session_id, id);

CREATE TABLE IF NOT EXISTS recruiter_interview_sessions (
  id UUID PRIMARY KEY,
  recruiter_key TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES recruiter_jobs(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES recruiter_candidates(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS recruiter_interview_sessions_owner_idx ON recruiter_interview_sessions (recruiter_key, modified_at DESC);
CREATE INDEX IF NOT EXISTS recruiter_interview_sessions_pair_idx ON recruiter_interview_sessions (job_id, candidate_id, modified_at DESC);

CREATE TABLE IF NOT EXISTS recruiter_interview_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES recruiter_interview_sessions(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('system','recruiter','candidate','coach')),
  message TEXT NOT NULL,
  coach JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_interview_turns_session_idx ON recruiter_interview_turns (session_id, id);

COMMIT;
