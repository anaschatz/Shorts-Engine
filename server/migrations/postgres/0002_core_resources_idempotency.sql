CREATE TABLE projects (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  schema_version integer NOT NULL DEFAULT 2,
  project_type text NOT NULL,
  upload_id text,
  title text NOT NULL,
  language text,
  status text NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_json jsonb,
  source_revision text,
  record_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id)
);
CREATE INDEX projects_owner_idx ON projects(owner_id, updated_at DESC);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  owner_project_id text,
  owner_job_id text,
  type text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('staging', 'validating', 'available', 'delete_pending', 'failed', 'deleted')
  ),
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size bigint,
  checksum_sha256 char(64),
  retention_until timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (owner_project_id, owner_id)
    REFERENCES projects(id, owner_id)
);
CREATE INDEX artifacts_owner_idx ON artifacts(owner_id, created_at DESC);
CREATE INDEX artifacts_retention_idx ON artifacts(status, retention_until);

CREATE TABLE uploads (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  artifact_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('staging', 'uploading', 'validating', 'available', 'failed', 'cancelled')
  ),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  checksum_sha256 char(64),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES projects(id, owner_id),
  FOREIGN KEY (artifact_id, owner_id)
    REFERENCES artifacts(id, owner_id)
);
CREATE INDEX uploads_owner_idx ON uploads(owner_id, created_at DESC);

ALTER TABLE projects
  ADD CONSTRAINT projects_upload_owner_fk
  FOREIGN KEY (upload_id, owner_id)
  REFERENCES uploads(id, owner_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE exports (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  job_id text NOT NULL,
  artifact_id text NOT NULL,
  file_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES projects(id, owner_id),
  FOREIGN KEY (artifact_id, owner_id)
    REFERENCES artifacts(id, owner_id)
);
CREATE INDEX exports_owner_idx ON exports(owner_id, created_at DESC);

CREATE TABLE idempotency_records (
  owner_id text NOT NULL REFERENCES users(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash char(64) NOT NULL,
  resource_type text,
  resource_id text,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (owner_id, scope, key)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);
