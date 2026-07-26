const { randomUUID } = require("node:crypto");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("../errors.cjs");
const { runPostgresMigrations } = require("../migrations/postgres/runner.cjs");

function databaseFailure(code = "DB_TRANSACTION_FAILED", status = 500) {
  return new AppError(code, SAFE_MESSAGES[code], status);
}

function safeLogger(logger, level, payload) {
  if (!logger || typeof logger[level] !== "function") return;
  logger[level](JSON.stringify(redactForLogs(payload)));
}

function createPostgresPool(config, options = {}) {
  const { Pool } = options.pg || require("pg");
  const postgres = config.postgres || config;
  const pool = new Pool({
    connectionString: postgres.url,
    max: postgres.poolMax || 5,
    connectionTimeoutMillis: postgres.connectionTimeoutMs || 5000,
    idleTimeoutMillis: postgres.idleTimeoutMs || 30000,
    statement_timeout: postgres.statementTimeoutMs || 30000,
    query_timeout: postgres.statementTimeoutMs || 30000,
    application_name: "shortsengine",
    ssl: postgres.sslMode === "require"
      ? { rejectUnauthorized: options.rejectUnauthorized !== false }
      : false,
  });
  pool.on("error", () => {
    safeLogger(options.logger, "error", {
      level: "error",
      event: "postgres_pool_error",
      code: "DB_CONNECTION_FAILED",
    });
  });
  return pool;
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function mapProject(row) {
  if (!row) return null;
  return {
    schemaVersion: Number(row.schema_version || 2),
    id: row.id,
    ownerId: row.owner_id,
    projectType: row.project_type,
    uploadId: row.upload_id || null,
    title: row.title,
    language: row.language || null,
    status: row.status,
    input: safeJson(row.input_json),
    source: safeJson(row.source_json, null),
    sourceRevision: row.source_revision || null,
    recordVersion: Number(row.record_version || 1),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    uploadId: row.upload_id || null,
    action: row.action,
    pipelineType: row.pipeline_type,
    status: row.status,
    progress: Number(row.progress || 0),
    step: row.step,
    attempts: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 3),
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    workerId: row.worker_id || null,
    leaseId: row.lease_id || null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).toISOString() : null,
    payload: safeJson(row.payload_json),
    result: safeJson(row.result_json, null),
    error: row.error_code
      ? { code: row.error_code, message: SAFE_MESSAGES[row.error_code] || "The job failed." }
      : null,
    traceparent: row.traceparent || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

class PostgresPersistenceAdapter {
  constructor(options = {}) {
    this.config = options.config;
    this.logger = Object.prototype.hasOwnProperty.call(options, "logger") ? options.logger : console;
    this.pool = options.pool || createPostgresPool(options.config, {
      logger: this.logger,
      pg: options.pg,
      rejectUnauthorized: options.rejectUnauthorized,
    });
    this.client = options.client || null;
    this.ownsPool = !options.pool && !options.client;
    this.mode = "postgres";
    this.transactionTimeoutMs = Number(
      options.transactionTimeoutMs
      || (options.config.postgres && options.config.postgres.transactionTimeoutMs)
      || 60000,
    );
  }

  async query(text, values = []) {
    try {
      return await (this.client || this.pool).query(text, values);
    } catch {
      throw databaseFailure();
    }
  }

  async withTransaction(callback) {
    if (this.client) return await callback(this);
    const client = await this.pool.connect().catch(() => {
      throw databaseFailure();
    });
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.transactionTimeoutMs}ms`],
      );
      const transaction = new PostgresPersistenceAdapter({
        config: this.config,
        logger: this.logger,
        pool: this.pool,
        client,
        transactionTimeoutMs: this.transactionTimeoutMs,
      });
      const result = await callback(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof AppError) throw error;
      throw databaseFailure();
    } finally {
      client.release();
    }
  }

  async transaction(callback) {
    return await this.withTransaction(callback);
  }

  async migrate(options = {}) {
    if (this.client) throw databaseFailure("DB_MIGRATION_FAILED", 503);
    return await runPostgresMigrations({
      pool: this.pool,
      logger: this.logger,
      timeoutMs: options.timeoutMs || this.transactionTimeoutMs,
    });
  }

  async createUserFromIdentity({ userId, issuer, subject }) {
    return await this.withTransaction(async (transaction) => {
      const candidateId = String(userId || `usr_${randomUUID()}`);
      await transaction.query(
        `INSERT INTO users(id, status)
         VALUES ($1, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [candidateId],
      );
      const identity = await transaction.query(
        `INSERT INTO user_identities(user_id, issuer, subject, last_login_at)
         VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (issuer, subject)
         DO UPDATE SET last_login_at = EXCLUDED.last_login_at
         RETURNING user_id`,
        [candidateId, issuer, subject],
      );
      const resolvedUserId = identity.rows[0].user_id;
      if (resolvedUserId !== candidateId) {
        await transaction.query(
          `DELETE FROM users
           WHERE id = $1
             AND NOT EXISTS (
               SELECT 1 FROM user_identities WHERE user_id = $1
             )`,
          [candidateId],
        );
      }
      const user = await transaction.query(
        "SELECT id, status, created_at, updated_at FROM users WHERE id = $1",
        [resolvedUserId],
      );
      return {
        id: user.rows[0].id,
        status: user.rows[0].status,
        createdAt: new Date(user.rows[0].created_at).toISOString(),
        updatedAt: new Date(user.rows[0].updated_at).toISOString(),
      };
    });
  }

  async createSession(record) {
    const result = await this.query(
      `INSERT INTO sessions(
         id, user_id, token_hash, csrf_token_hash,
         expires_at, idle_expires_at, last_seen_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
       RETURNING id, user_id, expires_at, idle_expires_at, created_at`,
      [
        record.id,
        record.userId,
        record.tokenHash,
        record.csrfTokenHash,
        record.expiresAt,
        record.idleExpiresAt,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at).toISOString(),
      idleExpiresAt: new Date(row.idle_expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async resolveSession({ tokenHash, idleTtlMs }) {
    const result = await this.query(
      `UPDATE sessions AS session
       SET
         last_seen_at = clock_timestamp(),
         idle_expires_at = LEAST(
           session.expires_at,
           clock_timestamp() + ($2::bigint * interval '1 millisecond')
         )
       FROM users
       WHERE session.token_hash = $1
         AND session.user_id = users.id
         AND session.revoked_at IS NULL
         AND session.expires_at > clock_timestamp()
         AND session.idle_expires_at > clock_timestamp()
         AND users.status = 'active'
       RETURNING
         session.id,
         session.user_id,
         session.csrf_token_hash,
         session.expires_at,
         session.idle_expires_at`,
      [tokenHash, idleTtlMs],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      csrfTokenHash: String(row.csrf_token_hash).trim(),
      expiresAt: new Date(row.expires_at).toISOString(),
      idleExpiresAt: new Date(row.idle_expires_at).toISOString(),
    };
  }

  async revokeSession({ tokenHash, userId = null }) {
    const result = await this.query(
      `UPDATE sessions
       SET revoked_at = clock_timestamp()
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND ($2::text IS NULL OR user_id = $2)`,
      [tokenHash, userId],
    );
    return result.rowCount > 0;
  }

  async createProject(record) {
    const result = await this.query(
      `INSERT INTO projects(
         id, owner_id, schema_version, project_type, upload_id,
         title, language, status, input_json, source_json, source_revision,
         created_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::jsonb, $10::jsonb, $11,
         COALESCE($12::timestamptz, clock_timestamp()),
         COALESCE($13::timestamptz, clock_timestamp())
       )
       RETURNING *`,
      [
        record.id,
        record.ownerId,
        Number(record.schemaVersion || 2),
        record.projectType || "clip",
        record.uploadId || null,
        record.title || "ShortsEngine Short",
        record.language || null,
        record.status || "draft",
        JSON.stringify(record.input || {}),
        record.source ? JSON.stringify(record.source) : null,
        record.sourceRevision || null,
        record.createdAt || null,
        record.updatedAt || null,
      ],
    );
    return mapProject(result.rows[0]);
  }

  async getProject(projectId, ownerId) {
    const result = await this.query(
      "SELECT * FROM projects WHERE id = $1 AND owner_id = $2",
      [projectId, ownerId],
    );
    return mapProject(result.rows[0]);
  }

  async getProjectOwnedBy(projectId, ownerId) {
    return await this.getProject(projectId, ownerId);
  }

  async compareAndSwapProject({ projectId, ownerId, expectedVersion, patch = {} }) {
    const result = await this.query(
      `UPDATE projects
       SET
         title = COALESCE($4, title),
         status = COALESCE($5, status),
         input_json = COALESCE($6::jsonb, input_json),
         source_revision = COALESCE($7, source_revision),
         record_version = record_version + 1,
         updated_at = clock_timestamp()
       WHERE id = $1
         AND owner_id = $2
         AND record_version = $3
       RETURNING *`,
      [
        projectId,
        ownerId,
        expectedVersion,
        patch.title || null,
        patch.status || null,
        patch.input ? JSON.stringify(patch.input) : null,
        patch.sourceRevision || null,
      ],
    );
    return mapProject(result.rows[0]);
  }

  async reserveIdempotency({ ownerId, scope, key, requestHash, resourceType = null, resourceId = null }) {
    const inserted = await this.query(
      `INSERT INTO idempotency_records(
         owner_id, scope, key, request_hash, resource_type, resource_id
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, scope, key) DO NOTHING
       RETURNING *`,
      [ownerId, scope, key, requestHash, resourceType, resourceId],
    );
    if (inserted.rowCount) return { reserved: true, record: inserted.rows[0] };
    const existing = await this.query(
      `SELECT request_hash, resource_type, resource_id, response_json
       FROM idempotency_records
       WHERE owner_id = $1 AND scope = $2 AND key = $3`,
      [ownerId, scope, key],
    );
    const row = existing.rows[0];
    if (!row || String(row.request_hash).trim() !== requestHash) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        SAFE_MESSAGES.IDEMPOTENCY_CONFLICT || SAFE_MESSAGES.VALIDATION_ERROR,
        409,
      );
    }
    return {
      reserved: false,
      record: {
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        response: safeJson(row.response_json, null),
      },
    };
  }

  async completeIdempotency({ ownerId, scope, key, resourceType, resourceId, response }) {
    const result = await this.query(
      `UPDATE idempotency_records
       SET resource_type = $4, resource_id = $5, response_json = $6::jsonb
       WHERE owner_id = $1 AND scope = $2 AND key = $3
       RETURNING owner_id`,
      [ownerId, scope, key, resourceType, resourceId, JSON.stringify(response || null)],
    );
    return result.rowCount > 0;
  }

  async appendAudit(record) {
    const result = await this.query(
      `INSERT INTO audit_events(
         actor_user_id, actor_type, action, resource_type,
         resource_id, request_id, safe_metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, created_at`,
      [
        record.actorUserId || null,
        record.actorType || "system",
        record.action,
        record.resourceType,
        record.resourceId || null,
        record.requestId || null,
        JSON.stringify(record.safeMetadata || {}),
      ],
    );
    return {
      id: Number(result.rows[0].id),
      createdAt: new Date(result.rows[0].created_at).toISOString(),
    };
  }

  async recordUsage(record) {
    const result = await this.query(
      `INSERT INTO provider_usage_events(
         owner_id, job_id, provider, operation, unit_type, unit_count,
         byte_count, duration_ms, retry_count, price_book_version,
         provider_cost_usd, compute_cost_usd, currency, estimated, trace_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15
       )
       RETURNING id, created_at`,
      [
        record.ownerId || null,
        record.jobId || null,
        record.provider,
        record.operation,
        record.unitType,
        record.unitCount,
        record.byteCount || null,
        record.durationMs || null,
        record.retryCount || 0,
        record.priceBookVersion || null,
        Number.isFinite(Number(record.providerCostUsd)) ? record.providerCostUsd : null,
        Number.isFinite(Number(record.computeCostUsd)) ? record.computeCostUsd : null,
        record.currency || "USD",
        record.estimated !== false,
        record.traceId || null,
      ],
    );
    return {
      id: Number(result.rows[0].id),
      createdAt: new Date(result.rows[0].created_at).toISOString(),
    };
  }

  async getJobOwnedBy(jobId, ownerId) {
    const result = await this.query(
      "SELECT * FROM jobs WHERE id = $1 AND owner_id = $2",
      [jobId, ownerId],
    );
    return mapJob(result.rows[0]);
  }

  async readiness() {
    try {
      const result = await (this.client || this.pool).query(
        `SELECT
           1 AS connected,
           COALESCE((SELECT max(version) FROM schema_migrations), 0) AS version`,
      );
      return {
        ready: Number(result.rows[0].version || 0) >= 6,
        adapter: "postgres-persistence",
        mode: "postgres",
        database: true,
        transactions: true,
        migrations: {
          currentVersion: Number(result.rows[0].version || 0),
          requiredVersion: 6,
        },
      };
    } catch {
      return {
        ready: false,
        adapter: "postgres-persistence",
        mode: "postgres",
        database: true,
        transactions: true,
        migrations: { currentVersion: 0, requiredVersion: 6 },
      };
    }
  }

  async health() {
    return await this.readiness();
  }

  async close() {
    if (!this.ownsPool || !this.pool || typeof this.pool.end !== "function") return false;
    await this.pool.end();
    return true;
  }
}

async function createPostgresPersistenceAdapter(options = {}) {
  return new PostgresPersistenceAdapter(options);
}

module.exports = {
  PostgresPersistenceAdapter,
  createPostgresPersistenceAdapter,
  createPostgresPool,
  mapJob,
  mapProject,
};
