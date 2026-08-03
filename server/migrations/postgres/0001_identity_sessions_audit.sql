CREATE TABLE users (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE user_identities (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  last_login_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (user_id, issuer)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (idle_expires_at <= expires_at)
);
CREATE INDEX sessions_active_lookup_idx
  ON sessions(token_hash, idle_expires_at, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_user_idx ON sessions(user_id, created_at DESC);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system')),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_resource_idx
  ON audit_events(resource_type, resource_id, created_at DESC);
CREATE INDEX audit_events_actor_idx
  ON audit_events(actor_user_id, created_at DESC);
