package main

const leadSchema = `
CREATE TABLE IF NOT EXISTS keagent_comment_consents (
 owner_id text NOT NULL, device_id text NOT NULL, account_id text NOT NULL, work_id text NOT NULL,
 label text NOT NULL, purposes jsonb NOT NULL, expires_at timestamptz NOT NULL,
 retention_days int NOT NULL, base_url text NOT NULL, creatorhub_account_id text NOT NULL,
 ai_endpoint text NOT NULL, consented_at timestamptz NOT NULL DEFAULT now(),
 revoked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,device_id,account_id,work_id));
CREATE INDEX IF NOT EXISTS keagent_comment_consent_expiry ON keagent_comment_consents(expires_at);

CREATE TABLE IF NOT EXISTS keagent_lead_settings (
 owner_id text NOT NULL, device_id text NOT NULL,
 criteria text NOT NULL DEFAULT '', criteria_version text NOT NULL DEFAULT 'v1',
 max_comments int NOT NULL DEFAULT 200, concurrency int NOT NULL DEFAULT 2,
 creatorhub_base_url text NOT NULL DEFAULT 'http://127.0.0.1:8000',
 creatorhub_account_id text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,device_id));

CREATE TABLE IF NOT EXISTS keagent_comment_analysis_jobs (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL,
 account_id text NOT NULL, work_id text NOT NULL,
 source_id text NOT NULL REFERENCES keagent_comment_sources(id) ON DELETE CASCADE,
 criteria text NOT NULL, criteria_hash text NOT NULL,
 criteria_version text NOT NULL DEFAULT 'v1',
 max_comments int NOT NULL DEFAULT 200, concurrency int NOT NULL DEFAULT 2,
 status text NOT NULL DEFAULT 'queued',
 total int NOT NULL DEFAULT 0, processed int NOT NULL DEFAULT 0,
 qualified int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0,
 error text NOT NULL DEFAULT '', request_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(owner_id,device_id,request_key));
CREATE INDEX IF NOT EXISTS keagent_comment_analysis_job_queue
 ON keagent_comment_analysis_jobs(status,created_at);
ALTER TABLE keagent_comment_analysis_jobs ADD COLUMN IF NOT EXISTS criteria_version text NOT NULL DEFAULT 'v1';

CREATE TABLE IF NOT EXISTS keagent_comment_analyses (
 id text PRIMARY KEY,
 job_id text NOT NULL REFERENCES keagent_comment_analysis_jobs(id) ON DELETE CASCADE,
 owner_id text NOT NULL, device_id text NOT NULL, account_id text NOT NULL, work_id text NOT NULL,
 source_id text NOT NULL REFERENCES keagent_comment_sources(id) ON DELETE CASCADE,
 comment_row_id text NOT NULL REFERENCES keagent_comment_observations(id) ON DELETE CASCADE,
 comment_id text NOT NULL DEFAULT '', criteria_hash text NOT NULL,
 intent text NOT NULL DEFAULT '', evidence text NOT NULL DEFAULT '',
 qualified boolean NOT NULL DEFAULT false, reason text NOT NULL DEFAULT '',
 draft text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'queued', error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,comment_row_id,criteria_hash));
CREATE INDEX IF NOT EXISTS keagent_comment_analysis_list
 ON keagent_comment_analyses(job_id,status,qualified);

CREATE TABLE IF NOT EXISTS keagent_outreach_tasks (
 id text PRIMARY KEY,
 analysis_id text NOT NULL UNIQUE REFERENCES keagent_comment_analyses(id) ON DELETE CASCADE,
 owner_id text NOT NULL, device_id text NOT NULL, account_id text NOT NULL, work_id text NOT NULL,
 draft text NOT NULL, status text NOT NULL DEFAULT 'approved', request_key text NOT NULL,
 creatorhub_task_id text NOT NULL DEFAULT '', method text NOT NULL DEFAULT '',
 error text NOT NULL DEFAULT '', attempts int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz, finished_at timestamptz,
 UNIQUE(owner_id,device_id,request_key));
CREATE INDEX IF NOT EXISTS keagent_outreach_list
 ON keagent_outreach_tasks(owner_id,device_id,account_id,created_at DESC);
`
