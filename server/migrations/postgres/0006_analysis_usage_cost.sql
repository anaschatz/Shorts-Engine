CREATE TABLE analysis_cache (
  cache_key char(64) PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  source_checksum char(64) NOT NULL,
  pipeline_version text NOT NULL,
  configuration_hash char(64) NOT NULL,
  evidence_contract_version text NOT NULL,
  artifact_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
);
CREATE INDEX analysis_cache_expiry_idx ON analysis_cache(expires_at);

CREATE TABLE provider_usage_events (
  id bigserial PRIMARY KEY,
  owner_id text REFERENCES users(id) ON DELETE SET NULL,
  job_id text REFERENCES jobs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  operation text NOT NULL,
  unit_type text NOT NULL,
  unit_count numeric(20,6) NOT NULL,
  byte_count bigint,
  duration_ms bigint,
  retry_count integer NOT NULL DEFAULT 0,
  price_book_version text,
  provider_cost_usd numeric(16,8),
  compute_cost_usd numeric(16,8),
  currency char(3) NOT NULL DEFAULT 'USD',
  estimated boolean NOT NULL DEFAULT true,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_usage_events_job_idx
  ON provider_usage_events(job_id, created_at);
CREATE INDEX provider_usage_events_owner_idx
  ON provider_usage_events(owner_id, created_at);

CREATE VIEW job_cost_rollups AS
SELECT
  job_id,
  count(*) AS event_count,
  count(*) FILTER (
    WHERE provider_cost_usd IS NOT NULL OR compute_cost_usd IS NOT NULL
  ) AS priced_event_count,
  sum(provider_cost_usd) AS provider_cost_usd,
  sum(compute_cost_usd) AS compute_cost_usd,
  CASE
    WHEN count(*) = count(*) FILTER (
      WHERE provider_cost_usd IS NOT NULL OR compute_cost_usd IS NOT NULL
    )
    THEN coalesce(sum(provider_cost_usd), 0) + coalesce(sum(compute_cost_usd), 0)
    ELSE NULL
  END AS total_cost_usd
FROM provider_usage_events
WHERE job_id IS NOT NULL
GROUP BY job_id;
