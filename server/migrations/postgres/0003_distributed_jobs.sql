CREATE TABLE jobs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  upload_id text,
  action text NOT NULL,
  pipeline_type text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  step text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_retry_at timestamptz,
  worker_id text,
  lease_id text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  completed_at timestamptz,
  error_code text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb,
  traceparent text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES projects(id, owner_id),
  FOREIGN KEY (upload_id, owner_id)
    REFERENCES uploads(id, owner_id)
);
CREATE INDEX jobs_claim_idx
  ON jobs(next_retry_at, created_at, id)
  WHERE status = 'queued';
CREATE INDEX jobs_expired_lease_idx
  ON jobs(lease_expires_at, created_at, id)
  WHERE status = 'processing';
CREATE INDEX jobs_owner_active_idx
  ON jobs(owner_id, status, created_at)
  WHERE status IN ('queued', 'processing');

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_owner_job_fk
  FOREIGN KEY (owner_job_id, owner_id)
  REFERENCES jobs(id, owner_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE exports
  ADD CONSTRAINT exports_owner_job_fk
  FOREIGN KEY (job_id, owner_id)
  REFERENCES jobs(id, owner_id);

CREATE TABLE job_dead_letters (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL UNIQUE REFERENCES jobs(id),
  owner_id text NOT NULL REFERENCES users(id),
  final_error_code text NOT NULL,
  attempts integer NOT NULL,
  record_json jsonb NOT NULL,
  redrive_count integer NOT NULL DEFAULT 0,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id, owner_id)
    REFERENCES jobs(id, owner_id)
);
CREATE INDEX job_dead_letters_active_idx
  ON job_dead_letters(created_at DESC)
  WHERE resolved_at IS NULL;
