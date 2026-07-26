BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version bigint PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  external_subject text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  schema_version integer NOT NULL DEFAULT 2,
  project_type text NOT NULL,
  upload_id text,
  title text NOT NULL,
  status text NOT NULL,
  input_json jsonb NOT NULL,
  source_revision text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  owner_project_id text REFERENCES projects(id),
  owner_job_id text,
  type text NOT NULL,
  status text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint,
  checksum_sha256 text,
  retention_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_retention_idx ON artifacts(status, retention_until);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  owner_id text NOT NULL REFERENCES users(id),
  upload_id text,
  action text NOT NULL,
  pipeline_type text NOT NULL,
  idempotency_key text UNIQUE,
  status text NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  step text,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  next_retry_at timestamptz,
  worker_id text,
  lease_id text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  cancelled_at timestamptz,
  payload_json jsonb NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs(status, next_retry_at, created_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS jobs_owner_active_idx
  ON jobs(owner_id, status)
  WHERE status IN ('queued', 'processing');

CREATE OR REPLACE FUNCTION claim_next_job(
  p_worker_id text,
  p_lease_id text,
  p_lease_seconds integer
)
RETURNS SETOF jobs
LANGUAGE sql
AS $$
  WITH candidate AS (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
      AND (next_retry_at IS NULL OR next_retry_at <= now())
      AND cancelled_at IS NULL
      AND attempt < max_attempts
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE jobs
  SET
    status = 'processing',
    attempt = attempt + 1,
    worker_id = p_worker_id,
    lease_id = p_lease_id,
    lease_expires_at = now() + make_interval(secs => GREATEST(1, p_lease_seconds)),
    last_heartbeat_at = now(),
    updated_at = now()
  WHERE id = (SELECT id FROM candidate)
  RETURNING jobs.*;
$$;

CREATE TABLE IF NOT EXISTS job_dead_letters (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id),
  final_error_code text NOT NULL,
  attempts integer NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_dead_letters_job_idx ON job_dead_letters(job_id);

CREATE TABLE IF NOT EXISTS football_reviews (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  owner_id text NOT NULL REFERENCES users(id),
  source_job_id text NOT NULL REFERENCES jobs(id),
  source_upload_id text NOT NULL,
  source_revision text NOT NULL,
  project_revision integer NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  selected_candidate_id text,
  decision text,
  reviewer_id text REFERENCES users(id),
  reviewer_note text,
  reviewed_at timestamptz,
  render_job_id text REFERENCES jobs(id),
  regeneration_job_id text REFERENCES jobs(id),
  decision_idempotency_key text UNIQUE,
  decision_request_hash text,
  rights_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(project_id, source_job_id, source_revision)
);
CREATE INDEX IF NOT EXISTS football_reviews_owner_idx ON football_reviews(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS football_reviews_status_idx ON football_reviews(status, updated_at);

CREATE TABLE IF NOT EXISTS football_review_candidates (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES football_reviews(id) ON DELETE CASCADE,
  source_start double precision NOT NULL,
  source_end double precision NOT NULL,
  confidence double precision NOT NULL,
  reason_codes jsonb NOT NULL,
  evidence jsonb NOT NULL,
  framing jsonb NOT NULL,
  edit_plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_start >= 0),
  CHECK (source_end > source_start),
  CHECK (source_end - source_start <= 90),
  CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS football_review_candidates_review_idx ON football_review_candidates(review_id);

CREATE TABLE IF NOT EXISTS football_review_audit (
  id bigserial PRIMARY KEY,
  review_id text NOT NULL REFERENCES football_reviews(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  actor_id text REFERENCES users(id),
  from_status text,
  to_status text NOT NULL,
  version integer NOT NULL,
  candidate_id text,
  render_job_id text,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(review_id, sequence)
);

CREATE TABLE IF NOT EXISTS analysis_cache (
  cache_key text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  source_checksum text NOT NULL,
  pipeline_version text NOT NULL,
  configuration_hash text NOT NULL,
  evidence_contract_version text NOT NULL,
  artifact_id text NOT NULL REFERENCES artifacts(id),
  estimated_cost_usd numeric(12,6),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_cache_expiry_idx ON analysis_cache(expires_at);

INSERT INTO schema_migrations(version, name)
VALUES (1, 'production_beta_core_and_football_review')
ON CONFLICT (version) DO NOTHING;

COMMIT;
