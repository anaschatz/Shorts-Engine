CREATE TABLE upload_sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  upload_id text NOT NULL,
  artifact_id text NOT NULL,
  provider_upload_id text,
  status text NOT NULL CHECK (
    status IN ('created', 'uploading', 'completing', 'completed', 'aborting', 'aborted', 'failed')
  ),
  part_size_bytes bigint NOT NULL,
  expected_parts integer NOT NULL,
  expected_byte_size bigint NOT NULL,
  expected_checksum_sha256 char(64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (upload_id),
  FOREIGN KEY (upload_id, owner_id) REFERENCES uploads(id, owner_id),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
);
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions(status, expires_at);

CREATE TABLE artifact_references (
  artifact_id text NOT NULL,
  owner_id text NOT NULL REFERENCES users(id),
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  active_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (artifact_id, reference_type, reference_id),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
);
CREATE INDEX artifact_references_active_idx
  ON artifact_references(artifact_id, active_until);

CREATE TABLE storage_operations (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  artifact_id text,
  upload_session_id text,
  operation text NOT NULL CHECK (operation IN ('abort_multipart', 'delete_object', 'verify_delete')),
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id),
  FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id)
);
CREATE INDEX storage_operations_claim_idx
  ON storage_operations(next_attempt_at, created_at)
  WHERE status = 'queued';

CREATE TABLE delivery_grants (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id),
  artifact_id text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('preview', 'export')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
);
CREATE INDEX delivery_grants_lookup_idx
  ON delivery_grants(token_hash, expires_at)
  WHERE revoked_at IS NULL;
