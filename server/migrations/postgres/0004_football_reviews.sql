CREATE TABLE football_reviews (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  source_job_id text NOT NULL,
  source_upload_id text NOT NULL,
  source_revision text NOT NULL,
  project_revision integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (
    status IN ('preparing', 'pending', 'preparation_failed', 'selected', 'rejected', 'regeneration_requested')
  ),
  selected_candidate_id text,
  rights_confirmed boolean NOT NULL DEFAULT false,
  render_job_id text,
  regeneration_job_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id),
  UNIQUE (project_id, source_job_id, source_revision),
  FOREIGN KEY (project_id, owner_id) REFERENCES projects(id, owner_id),
  FOREIGN KEY (source_job_id, owner_id) REFERENCES jobs(id, owner_id),
  FOREIGN KEY (source_upload_id, owner_id) REFERENCES uploads(id, owner_id),
  FOREIGN KEY (render_job_id, owner_id) REFERENCES jobs(id, owner_id),
  FOREIGN KEY (regeneration_job_id, owner_id) REFERENCES jobs(id, owner_id)
);
CREATE INDEX football_reviews_owner_idx ON football_reviews(owner_id, updated_at DESC);
CREATE INDEX football_reviews_status_idx ON football_reviews(status, updated_at);

CREATE TABLE football_review_candidates (
  id text PRIMARY KEY,
  review_id text NOT NULL,
  owner_id text NOT NULL REFERENCES users(id),
  schema_version integer NOT NULL DEFAULT 2,
  source_start double precision NOT NULL,
  source_end double precision NOT NULL,
  confidence double precision NOT NULL,
  purpose_json jsonb NOT NULL,
  evidence_json jsonb NOT NULL,
  uncertainty_json jsonb NOT NULL,
  framing_json jsonb NOT NULL,
  captions_json jsonb NOT NULL,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  edit_plan_json jsonb NOT NULL,
  editorial_signature char(64) NOT NULL,
  plan_hash char(64) NOT NULL,
  preview_status text NOT NULL DEFAULT 'queued' CHECK (
    preview_status IN ('queued', 'rendering', 'ready', 'failed', 'expired')
  ),
  preview_artifact_id text,
  preview_checksum_sha256 char(64),
  preview_duration_seconds double precision,
  preview_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (review_id, editorial_signature),
  FOREIGN KEY (review_id, owner_id)
    REFERENCES football_reviews(id, owner_id)
    ON DELETE CASCADE,
  FOREIGN KEY (preview_artifact_id, owner_id)
    REFERENCES artifacts(id, owner_id),
  CHECK (source_start >= 0),
  CHECK (source_end > source_start),
  CHECK (source_end - source_start <= 90),
  CHECK (confidence BETWEEN 0 AND 1)
);
CREATE INDEX football_review_candidates_review_idx
  ON football_review_candidates(review_id, preview_status);

CREATE TABLE football_review_decisions (
  id text PRIMARY KEY,
  review_id text NOT NULL,
  owner_id text NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('select', 'reject', 'regenerate')),
  candidate_id text,
  expected_version integer NOT NULL,
  expected_source_revision text NOT NULL,
  request_hash char(64) NOT NULL,
  reviewer_note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (review_id),
  FOREIGN KEY (review_id, owner_id)
    REFERENCES football_reviews(id, owner_id),
  FOREIGN KEY (candidate_id)
    REFERENCES football_review_candidates(id)
);

CREATE TABLE football_review_audit (
  id bigserial PRIMARY KEY,
  review_id text NOT NULL,
  owner_id text NOT NULL REFERENCES users(id),
  sequence integer NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  version integer NOT NULL,
  candidate_id text,
  job_id text,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (review_id, sequence),
  FOREIGN KEY (review_id, owner_id)
    REFERENCES football_reviews(id, owner_id)
    ON DELETE CASCADE
);
