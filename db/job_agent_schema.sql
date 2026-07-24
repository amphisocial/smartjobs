CREATE TABLE IF NOT EXISTS job_agent_accounts (
  owner_key TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT '',
  member_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_search_agents (
  id UUID PRIMARY KEY,
  owner_key TEXT NOT NULL REFERENCES job_agent_accounts(owner_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile_summary TEXT NOT NULL DEFAULT '',
  target_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_title_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_title_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
  industries JSONB NOT NULL DEFAULT '[]'::jsonb,
  role_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority_cities JSONB NOT NULL DEFAULT '[]'::jsonb,
  states JSONB NOT NULL DEFAULT '[]'::jsonb,
  regions JSONB NOT NULL DEFAULT '[]'::jsonb,
  remote_eligible BOOLEAN NOT NULL DEFAULT true,
  min_base_compensation INTEGER,
  min_total_compensation INTEGER,
  max_results INTEGER NOT NULL DEFAULT 25,
  max_posting_age_days INTEGER NOT NULL DEFAULT 30 CHECK (max_posting_age_days BETWEEN 0 AND 3650),
  posting_date_policy TEXT NOT NULL DEFAULT 'allow_missing' CHECK (posting_date_policy IN ('require_date','allow_missing','ignore')),
  repost_policy TEXT NOT NULL DEFAULT 'use_original' CHECK (repost_policy IN ('use_original','use_latest','exclude')),
  official_sources_only BOOLEAN NOT NULL DEFAULT true,
  verify_application_open BOOLEAN NOT NULL DEFAULT true,
  allow_aggregator_discovery BOOLEAN NOT NULL DEFAULT true,
  preferred_source_systems JSONB NOT NULL DEFAULT '["workday","adp","greenhouse","lever","smartrecruiters","successfactors","oracle","icims","ukg","dayforce","jobvite","ashby","avature","eightfold","phenom","employer"]'::jsonb,
  search_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  schedule_frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (schedule_frequency IN ('daily','weekly','monthly')),
  schedule_time TEXT NOT NULL DEFAULT '07:00',
  schedule_day INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  digest_hour INTEGER NOT NULL DEFAULT 20 CHECK (digest_hour BETWEEN 0 AND 23),
  is_active BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_digest_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_search_agents_owner ON job_search_agents(owner_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_search_agents_due ON job_search_agents(next_run_at) WHERE schedule_enabled AND is_active;

CREATE TABLE IF NOT EXISTS job_agent_daily_usage (
  owner_key TEXT NOT NULL REFERENCES job_agent_accounts(owner_key) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  action TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, usage_date, action)
);

CREATE TABLE IF NOT EXISTS job_agent_runs (
  id UUID PRIMARY KEY,
  owner_key TEXT NOT NULL REFERENCES job_agent_accounts(owner_key) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES job_search_agents(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','scheduled')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  query_count INTEGER NOT NULL DEFAULT 0,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  recommended_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  empty_query_count INTEGER NOT NULL DEFAULT 0,
  provider_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  rejection_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_job_agent_runs_agent ON job_agent_runs(agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS job_agent_results (
  id UUID PRIMARY KEY,
  owner_key TEXT NOT NULL REFERENCES job_agent_accounts(owner_key) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES job_search_agents(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  source_host TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'employer',
  requisition_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  remote_eligible BOOLEAN NOT NULL DEFAULT false,
  compensation_text TEXT NOT NULL DEFAULT '',
  compensation_min INTEGER,
  compensation_max INTEGER,
  compensation_currency TEXT NOT NULL DEFAULT 'USD',
  date_posted DATE,
  original_date_posted DATE,
  posting_date_source TEXT NOT NULL DEFAULT '',
  repost_detected BOOLEAN NOT NULL DEFAULT false,
  valid_through TIMESTAMPTZ,
  description_text TEXT NOT NULL DEFAULT '',
  official_source BOOLEAN NOT NULL DEFAULT false,
  active_verified BOOLEAN NOT NULL DEFAULT false,
  application_open_verified BOOLEAN NOT NULL DEFAULT false,
  active_verified_at TIMESTAMPTZ,
  fit_score INTEGER NOT NULL DEFAULT 0 CHECK (fit_score BETWEEN 0 AND 100),
  recommended BOOLEAN NOT NULL DEFAULT false,
  fit_summary TEXT NOT NULL DEFAULT '',
  mandatory_qualifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_qualifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  material_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  compensation_assessment TEXT NOT NULL DEFAULT 'unclear',
  evaluation_reason TEXT NOT NULL DEFAULT '',
  workflow_status TEXT NOT NULL DEFAULT 'new' CHECK (workflow_status IN ('new','saved','approved','rejected','applied')),
  applied_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_sent_at TIMESTAMPTZ,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (owner_key, agent_id, canonical_key)
);

ALTER TABLE job_agent_runs ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_agent_runs ADD COLUMN IF NOT EXISTS empty_query_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_agent_runs ADD COLUMN IF NOT EXISTS provider_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE job_agent_runs ADD COLUMN IF NOT EXISTS rejection_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS max_posting_age_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS posting_date_policy TEXT NOT NULL DEFAULT 'allow_missing';
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS repost_policy TEXT NOT NULL DEFAULT 'use_original';
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS official_sources_only BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS verify_application_open BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS allow_aggregator_discovery BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE job_search_agents ADD COLUMN IF NOT EXISTS preferred_source_systems JSONB NOT NULL DEFAULT '["workday","adp","greenhouse","lever","smartrecruiters","successfactors","oracle","icims","ukg","dayforce","jobvite","ashby","avature","eightfold","phenom","employer"]'::jsonb;
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'employer';
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS requisition_id TEXT NOT NULL DEFAULT '';
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS original_date_posted DATE;
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS posting_date_source TEXT NOT NULL DEFAULT '';
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS repost_detected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE job_agent_results ADD COLUMN IF NOT EXISTS application_open_verified BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_job_agent_results_owner ON job_agent_results(owner_key, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_agent_results_agent ON job_agent_results(agent_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_agent_results_digest ON job_agent_results(agent_id, email_sent_at) WHERE recommended AND workflow_status <> 'rejected';

CREATE TABLE IF NOT EXISTS job_agent_run_results (
  run_id UUID NOT NULL REFERENCES job_agent_runs(id) ON DELETE CASCADE,
  result_id UUID NOT NULL REFERENCES job_agent_results(id) ON DELETE CASCADE,
  is_new BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, result_id)
);
