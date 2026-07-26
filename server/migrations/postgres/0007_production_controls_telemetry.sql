CREATE TABLE project_memberships (
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_single_owner_idx
  ON project_memberships(project_id)
  WHERE role = 'owner';

INSERT INTO project_memberships(project_id, user_id, role)
SELECT id, owner_id, 'owner'
FROM projects
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE TABLE job_attempts (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  worker_id text NOT NULL,
  lease_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('processing', 'completed', 'retry_scheduled', 'failed', 'cancelled', 'lease_expired')
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error_code text,
  failure_category text,
  queue_wait_ms bigint CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  processing_duration_ms bigint CHECK (
    processing_duration_ms IS NULL OR processing_duration_ms >= 0
  ),
  PRIMARY KEY (job_id, attempt),
  UNIQUE (lease_id)
);
CREATE INDEX job_attempts_worker_idx
  ON job_attempts(worker_id, started_at DESC);
CREATE INDEX job_attempts_status_idx
  ON job_attempts(status, started_at DESC);

CREATE TABLE quota_policies (
  owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_render_limit integer CHECK (daily_render_limit > 0),
  monthly_render_limit integer CHECK (monthly_render_limit > 0),
  concurrent_job_limit integer CHECK (concurrent_job_limit > 0),
  provider_budget_usd numeric(16,8) CHECK (provider_budget_usd >= 0),
  upload_size_limit_bytes bigint CHECK (upload_size_limit_bytes > 0),
  video_duration_limit_seconds integer CHECK (video_duration_limit_seconds > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE job_cost_records (
  job_id text PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline_type text NOT NULL,
  analysis_duration_ms bigint CHECK (analysis_duration_ms IS NULL OR analysis_duration_ms >= 0),
  render_duration_ms bigint CHECK (render_duration_ms IS NULL OR render_duration_ms >= 0),
  queue_wait_ms bigint CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  provider_usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_usage bigint CHECK (token_usage IS NULL OR token_usage >= 0),
  tts_duration_ms bigint CHECK (tts_duration_ms IS NULL OR tts_duration_ms >= 0),
  generated_asset_count integer CHECK (
    generated_asset_count IS NULL OR generated_asset_count >= 0
  ),
  storage_bytes bigint CHECK (storage_bytes IS NULL OR storage_bytes >= 0),
  estimated_cost_usd numeric(16,8),
  final_cost_usd numeric(16,8),
  cost_coverage numeric(6,5) NOT NULL DEFAULT 0 CHECK (
    cost_coverage BETWEEN 0 AND 1
  ),
  failure_category text,
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, owner_id)
);
CREATE INDEX job_cost_records_owner_idx
  ON job_cost_records(owner_id, updated_at DESC);
CREATE INDEX job_cost_records_pipeline_idx
  ON job_cost_records(pipeline_type, completed, updated_at DESC);

CREATE TABLE metric_events (
  id bigserial PRIMARY KEY,
  metric_name text NOT NULL,
  metric_kind text NOT NULL CHECK (metric_kind IN ('counter', 'histogram')),
  metric_value double precision NOT NULL CHECK (
    metric_value >= 0 AND metric_value < 'Infinity'::double precision
  ),
  labels_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX metric_events_name_time_idx
  ON metric_events(metric_name, recorded_at DESC);

CREATE VIEW production_metric_summary AS
SELECT
  metric_name,
  labels_json,
  count(*) AS sample_count,
  sum(metric_value) AS total_value,
  avg(metric_value) AS average_value,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY metric_value) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value) AS p95,
  max(recorded_at) AS last_recorded_at
FROM metric_events
GROUP BY metric_name, labels_json;

CREATE VIEW production_job_outcomes AS
SELECT
  pipeline_type,
  count(*) FILTER (WHERE status = 'completed') AS completed_count,
  count(*) FILTER (WHERE status = 'failed') AS failed_count,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
  count(*) FILTER (WHERE attempt > 1) AS retried_count,
  count(*) FILTER (WHERE step = 'dead_letter') AS dead_letter_count
FROM jobs
GROUP BY pipeline_type;
