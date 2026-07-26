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
    cancelRequestedAt: row.cancel_requested_at ? new Date(row.cancel_requested_at).toISOString() : null,
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

function mapUploadSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    uploadId: row.upload_id,
    artifactId: row.artifact_id,
    projectId: row.project_id || null,
    providerUploadId: row.provider_upload_id || null,
    status: row.status,
    partSizeBytes: Number(row.part_size_bytes),
    expectedParts: Number(row.expected_parts),
    expectedByteSize: Number(row.expected_byte_size),
    expectedChecksumSha256: row.expected_checksum_sha256
      ? String(row.expected_checksum_sha256).trim()
      : null,
    storageKey: row.storage_key || null,
    contentType: row.content_type || null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
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

  async createMultipartUploadSession(record) {
    return await this.withTransaction(async (transaction) => {
      await transaction.createProject({
        id: record.projectId,
        ownerId: record.ownerId,
        projectType: record.projectType || "clip",
        title: record.title || "ShortsEngine Short",
        language: record.language || null,
        status: "uploading",
        input: record.projectInput || {},
      });
      await transaction.query(
        `INSERT INTO artifacts(
           id, owner_id, owner_project_id, type, status, storage_key,
           content_type, byte_size, checksum_sha256, retention_until, metadata_json
         )
         VALUES (
           $1, $2, $3, 'upload', 'staging', $4,
           $5, $6, $7, $8, $9::jsonb
         )`,
        [
          record.artifactId,
          record.ownerId,
          record.projectId,
          record.storageKey,
          record.contentType,
          record.expectedByteSize,
          record.expectedChecksumSha256 || null,
          record.retentionUntil || null,
          JSON.stringify(record.artifactMetadata || {}),
        ],
      );
      await transaction.query(
        `INSERT INTO uploads(
           id, owner_id, project_id, artifact_id, status,
           original_filename, mime_type, byte_size, checksum_sha256,
           metadata_json, source_json
         )
         VALUES (
           $1, $2, $3, $4, 'staging',
           $5, $6, $7, $8, $9::jsonb, $10::jsonb
         )`,
        [
          record.uploadId,
          record.ownerId,
          record.projectId,
          record.artifactId,
          record.originalFilename,
          record.contentType,
          record.expectedByteSize,
          record.expectedChecksumSha256 || null,
          JSON.stringify(record.uploadMetadata || {}),
          record.source ? JSON.stringify(record.source) : null,
        ],
      );
      await transaction.query(
        `UPDATE projects
         SET upload_id = $3, updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [record.projectId, record.ownerId, record.uploadId],
      );
      const created = await transaction.query(
        `INSERT INTO upload_sessions(
           id, owner_id, upload_id, artifact_id, status,
           part_size_bytes, expected_parts, expected_byte_size,
           expected_checksum_sha256, expires_at
         )
         VALUES (
           $1, $2, $3, $4, 'created',
           $5, $6, $7, $8, $9
         )
         RETURNING *`,
        [
          record.sessionId,
          record.ownerId,
          record.uploadId,
          record.artifactId,
          record.partSizeBytes,
          record.expectedParts,
          record.expectedByteSize,
          record.expectedChecksumSha256 || null,
          record.expiresAt,
        ],
      );
      return mapUploadSession({
        ...created.rows[0],
        project_id: record.projectId,
        storage_key: record.storageKey,
        content_type: record.contentType,
      });
    });
  }

  async attachMultipartUpload({ ownerId, uploadId, providerUploadId }) {
    return await this.withTransaction(async (transaction) => {
      const attached = await transaction.query(
        `UPDATE upload_sessions AS session
         SET
           provider_upload_id = $3,
           status = 'uploading',
           updated_at = clock_timestamp()
         FROM uploads, artifacts
         WHERE session.upload_id = $1
           AND session.owner_id = $2
           AND session.status = 'created'
           AND uploads.id = session.upload_id
           AND uploads.owner_id = session.owner_id
           AND artifacts.id = session.artifact_id
           AND artifacts.owner_id = session.owner_id
         RETURNING
           session.*,
           uploads.project_id,
           artifacts.storage_key,
           artifacts.content_type`,
        [uploadId, ownerId, providerUploadId],
      );
      if (!attached.rowCount) return null;
      await transaction.query(
        `UPDATE uploads
         SET status = 'uploading', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2 AND status = 'staging'`,
        [uploadId, ownerId],
      );
      return mapUploadSession(attached.rows[0]);
    });
  }

  async getMultipartUploadOwnedBy(uploadId, ownerId) {
    const result = await this.query(
      `SELECT
         session.*,
         uploads.project_id,
         artifacts.storage_key,
         artifacts.content_type
       FROM upload_sessions AS session
       JOIN uploads
         ON uploads.id = session.upload_id
        AND uploads.owner_id = session.owner_id
       JOIN artifacts
         ON artifacts.id = session.artifact_id
        AND artifacts.owner_id = session.owner_id
       WHERE session.upload_id = $1
         AND session.owner_id = $2`,
      [uploadId, ownerId],
    );
    return mapUploadSession(result.rows[0]);
  }

  async markMultipartUploadCompleteInTransaction(transaction, { ownerId, uploadId }) {
    if (!transaction || typeof transaction.query !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    const completed = await transaction.query(
        `UPDATE upload_sessions AS session
         SET status = 'completed', updated_at = clock_timestamp()
         FROM uploads, artifacts
         WHERE session.upload_id = $1
           AND session.owner_id = $2
           AND session.status IN ('uploading', 'completing')
           AND uploads.id = session.upload_id
           AND uploads.owner_id = session.owner_id
           AND artifacts.id = session.artifact_id
           AND artifacts.owner_id = session.owner_id
         RETURNING
           session.*,
           uploads.project_id,
           artifacts.storage_key,
           artifacts.content_type`,
        [uploadId, ownerId],
    );
    if (!completed.rowCount) return null;
    await transaction.query(
        `UPDATE uploads
         SET status = 'validating', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [uploadId, ownerId],
    );
    await transaction.query(
        `UPDATE artifacts
         SET status = 'validating', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [completed.rows[0].artifact_id, ownerId],
    );
    return mapUploadSession(completed.rows[0]);
  }

  async markMultipartUploadComplete({ ownerId, uploadId }) {
    return await this.withTransaction(async (transaction) => {
      return await this.markMultipartUploadCompleteInTransaction(
        transaction,
        { ownerId, uploadId },
      );
    });
  }

  async failMultipartUpload({
    ownerId,
    uploadId,
    operationId,
    operation = "abort_multipart",
    errorCode = "CLOUD_STORAGE_FAILED",
  }) {
    return await this.withTransaction(async (transaction) => {
      const failed = await transaction.query(
        `UPDATE upload_sessions
         SET status = 'failed', updated_at = clock_timestamp()
         WHERE upload_id = $1
           AND owner_id = $2
           AND status NOT IN ('aborted')
         RETURNING id, artifact_id, provider_upload_id`,
        [uploadId, ownerId],
      );
      if (!failed.rowCount) return false;
      const row = failed.rows[0];
      await transaction.query(
        `UPDATE uploads
         SET status = 'failed', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [uploadId, ownerId],
      );
      await transaction.query(
        `UPDATE artifacts
         SET status = 'failed', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [row.artifact_id, ownerId],
      );
      if (row.provider_upload_id || operation === "delete_object") {
        await transaction.query(
          `INSERT INTO storage_operations(
             id, owner_id, artifact_id, upload_session_id,
             operation, status, next_attempt_at, error_code
           )
           VALUES ($1, $2, $3, $4, $5, 'queued', clock_timestamp(), $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            operationId,
            ownerId,
            row.artifact_id,
            row.id,
            operation,
            errorCode,
          ],
        );
      }
      return true;
    });
  }

  async publishValidatedUploadInTransaction(transaction, {
    ownerId,
    uploadId,
    checksumSha256,
    byteSize,
    metadata = {},
  }) {
    if (!transaction || typeof transaction.query !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    const upload = await transaction.query(
      `UPDATE uploads
         SET
           status = 'available',
           checksum_sha256 = $3,
           byte_size = $4,
           metadata_json = metadata_json || $5::jsonb,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_id = $2
           AND status = 'validating'
         RETURNING artifact_id, project_id`,
      [uploadId, ownerId, checksumSha256, byteSize, JSON.stringify(metadata)],
    );
    if (!upload.rowCount) {
      const replay = await transaction.query(
        `SELECT upload.project_id
         FROM uploads AS upload
         JOIN artifacts AS artifact
           ON artifact.id = upload.artifact_id
          AND artifact.owner_id = upload.owner_id
         WHERE upload.id = $1
           AND upload.owner_id = $2
           AND upload.status = 'available'
           AND artifact.status = 'available'
           AND upload.checksum_sha256 = $3
           AND artifact.checksum_sha256 = $3
           AND upload.byte_size = $4
           AND artifact.byte_size = $4`,
        [uploadId, ownerId, checksumSha256, byteSize],
      );
      return replay.rowCount > 0;
    }
    await transaction.query(
      `UPDATE artifacts
         SET
           status = 'available',
           checksum_sha256 = $3,
           byte_size = $4,
           metadata_json = metadata_json || $5::jsonb,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_id = $2
           AND status = 'validating'`,
      [
        upload.rows[0].artifact_id,
        ownerId,
        checksumSha256,
        byteSize,
        JSON.stringify(metadata),
      ],
    );
    await transaction.query(
      `UPDATE projects
         SET status = 'ready', updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
      [upload.rows[0].project_id, ownerId],
    );
    return true;
  }

  async publishValidatedUpload(record) {
    return await this.withTransaction(async (transaction) => {
      return await this.publishValidatedUploadInTransaction(
        transaction,
        record,
      );
    });
  }

  async getAvailableUploadArtifactOwnedBy(uploadId, ownerId) {
    const result = await this.query(
      `SELECT
         upload.id AS upload_id,
         upload.project_id,
         upload.metadata_json AS upload_metadata_json,
         artifact.id AS artifact_id,
         artifact.storage_key,
         artifact.content_type,
         artifact.byte_size,
         artifact.checksum_sha256,
         artifact.metadata_json AS artifact_metadata_json
       FROM uploads AS upload
       JOIN artifacts AS artifact
         ON artifact.id = upload.artifact_id
        AND artifact.owner_id = upload.owner_id
       WHERE upload.id = $1
         AND upload.owner_id = $2
         AND upload.status = 'available'
         AND artifact.status = 'available'`,
      [uploadId, ownerId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      uploadId: row.upload_id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      storageKey: row.storage_key,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      checksumSha256: row.checksum_sha256
        ? String(row.checksum_sha256).trim()
        : null,
      metadata: {
        ...safeJson(row.artifact_metadata_json),
        ...safeJson(row.upload_metadata_json),
      },
    };
  }

  async beginRenderArtifact(record) {
    const result = await this.query(
      `INSERT INTO artifacts(
         id, owner_id, owner_project_id, owner_job_id, type, status,
         storage_key, content_type, retention_until, metadata_json
       )
       SELECT
         $1, job.owner_id, job.project_id, job.id, 'export', 'staging',
         $7, 'video/mp4', $8, $9::jsonb
       FROM jobs AS job
       WHERE job.id = $2
         AND job.owner_id = $3
         AND job.project_id = $4
         AND job.status = 'processing'
         AND job.worker_id = $5
         AND job.lease_id = $6
         AND job.lease_expires_at > clock_timestamp()
       RETURNING id`,
      [
        record.artifactId,
        record.jobId,
        record.ownerId,
        record.projectId,
        record.workerId,
        record.leaseId,
        record.storageKey,
        record.retentionUntil || null,
        JSON.stringify(record.metadata || {}),
      ],
    );
    return result.rowCount > 0;
  }

  async publishRenderExportInTransaction(transaction, record) {
    const artifact = await transaction.query(
      `UPDATE artifacts
       SET
         status = 'available',
         checksum_sha256 = $3,
         byte_size = $4,
         metadata_json = metadata_json || $5::jsonb,
         updated_at = clock_timestamp()
       WHERE id = $1
         AND owner_id = $2
         AND owner_project_id = $6
         AND owner_job_id = $7
         AND status = 'staging'
       RETURNING id`,
      [
        record.artifactId,
        record.ownerId,
        record.checksumSha256,
        record.byteSize,
        JSON.stringify(record.metadata || {}),
        record.projectId,
        record.jobId,
      ],
    );
    if (!artifact.rowCount) {
      throw new AppError(
        "PROJECT_STATE_LOCKED",
        SAFE_MESSAGES.PROJECT_STATE_LOCKED,
        409,
      );
    }
    const exported = await transaction.query(
      `INSERT INTO exports(
         id, owner_id, project_id, job_id, artifact_id,
         file_name, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')
       RETURNING id`,
      [
        record.exportId,
        record.ownerId,
        record.projectId,
        record.jobId,
        record.artifactId,
        record.fileName,
      ],
    );
    await transaction.query(
      `UPDATE projects
       SET status = 'completed', updated_at = clock_timestamp()
       WHERE id = $1 AND owner_id = $2`,
      [record.projectId, record.ownerId],
    );
    return exported.rowCount > 0;
  }

  async failRenderArtifact({
    ownerId,
    artifactId,
    operationId,
    errorCode = "RENDER_FAILED",
  }) {
    return await this.withTransaction(async (transaction) => {
      const artifact = await transaction.query(
        `UPDATE artifacts
         SET status = 'delete_pending', updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_id = $2
           AND status IN ('staging', 'failed', 'available')
         RETURNING id`,
        [artifactId, ownerId],
      );
      if (!artifact.rowCount) return false;
      await transaction.query(
        `INSERT INTO storage_operations(
           id, owner_id, artifact_id, operation, status,
           next_attempt_at, error_code
         )
         VALUES (
           $1, $2, $3, 'delete_object', 'queued',
           clock_timestamp(), $4
         )
         ON CONFLICT (id) DO NOTHING`,
        [operationId, ownerId, artifactId, errorCode],
      );
      return true;
    });
  }

  async createDeliveryGrant(record) {
    const result = await this.query(
      `INSERT INTO delivery_grants(
         id, owner_id, artifact_id, token_hash, purpose, expires_at
       )
       SELECT $1, $2, artifact.id, $4, $5, $6
       FROM artifacts AS artifact
       WHERE artifact.id = $3
         AND artifact.owner_id = $2
         AND artifact.status = 'available'
         AND (
           ($5 = 'preview' AND artifact.type = 'preview')
           OR ($5 = 'export' AND artifact.type = 'export')
         )
       RETURNING id, artifact_id, purpose, expires_at`,
      [
        record.id,
        record.ownerId,
        record.artifactId,
        record.tokenHash,
        record.purpose,
        record.expiresAt,
      ],
    );
    if (!result.rowCount) return null;
    return {
      id: result.rows[0].id,
      artifactId: result.rows[0].artifact_id,
      purpose: result.rows[0].purpose,
      expiresAt: new Date(result.rows[0].expires_at).toISOString(),
    };
  }

  async resolveDeliveryGrant({ ownerId, tokenHash }) {
    const result = await this.query(
      `SELECT
         grant.id,
         grant.purpose,
         grant.expires_at,
         artifact.id AS artifact_id,
         artifact.storage_key,
         artifact.content_type,
         artifact.byte_size,
         artifact.checksum_sha256
       FROM delivery_grants AS grant
       JOIN artifacts AS artifact
         ON artifact.id = grant.artifact_id
        AND artifact.owner_id = grant.owner_id
       WHERE grant.token_hash = $1
         AND grant.owner_id = $2
         AND grant.revoked_at IS NULL
         AND grant.expires_at > clock_timestamp()
         AND artifact.status = 'available'`,
      [tokenHash, ownerId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      purpose: row.purpose,
      expiresAt: new Date(row.expires_at).toISOString(),
      artifact: {
        id: row.artifact_id,
        storageKey: row.storage_key,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        checksumSha256: row.checksum_sha256
          ? String(row.checksum_sha256).trim()
          : null,
      },
    };
  }

  async claimStorageOperation({ leaseId, leaseMs = 60_000 }) {
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
         `WITH candidate AS (
           SELECT
             operation.id,
             artifact.storage_key,
             session.provider_upload_id
           FROM storage_operations AS operation
           JOIN artifacts AS artifact
             ON artifact.id = operation.artifact_id
            AND artifact.owner_id = operation.owner_id
           LEFT JOIN upload_sessions AS session
             ON session.id = operation.upload_session_id
           WHERE (
             operation.status = 'queued'
             AND (
               operation.next_attempt_at IS NULL
               OR operation.next_attempt_at <= clock_timestamp()
             )
           ) OR (
             operation.status = 'processing'
             AND operation.lease_expires_at <= clock_timestamp()
           )
           ORDER BY operation.next_attempt_at NULLS FIRST, operation.created_at, operation.id
           FOR UPDATE OF operation SKIP LOCKED
           LIMIT 1
         )
         UPDATE storage_operations AS operation
         SET
           status = 'processing',
           attempt = operation.attempt + 1,
           lease_id = $1,
           lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
         FROM candidate
         WHERE operation.id = candidate.id
         RETURNING
           operation.id,
           operation.owner_id,
           operation.operation,
           operation.attempt,
           operation.max_attempts,
           operation.lease_id,
           operation.lease_expires_at,
           candidate.storage_key,
           candidate.provider_upload_id`,
        [leaseId, leaseMs],
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        ownerId: row.owner_id,
        operation: row.operation,
        attempt: Number(row.attempt),
        maxAttempts: Number(row.max_attempts),
        leaseId: row.lease_id,
        leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
        storageKey: row.storage_key,
        providerUploadId: row.provider_upload_id || null,
      };
    });
  }

  async completeStorageOperation({ operationId, leaseId }) {
    const result = await this.query(
      `UPDATE storage_operations
       SET
         status = 'completed',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = NULL,
         updated_at = clock_timestamp()
       WHERE id = $1
         AND status = 'processing'
         AND lease_id = $2
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [operationId, leaseId],
    );
    return result.rowCount > 0;
  }

  async failStorageOperation({
    operationId,
    leaseId,
    errorCode = "CLOUD_STORAGE_FAILED",
    retryDelayMs = 1000,
  }) {
    const result = await this.query(
      `UPDATE storage_operations
       SET
         status = CASE
           WHEN attempt >= max_attempts THEN 'dead_letter'
           ELSE 'queued'
         END,
         next_attempt_at = CASE
           WHEN attempt >= max_attempts THEN NULL
           ELSE clock_timestamp() + ($4::bigint * interval '1 millisecond')
         END,
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = $3,
         updated_at = clock_timestamp()
       WHERE id = $1
         AND status = 'processing'
         AND lease_id = $2
         AND lease_expires_at > clock_timestamp()
       RETURNING status`,
      [operationId, leaseId, errorCode, retryDelayMs],
    );
    return result.rowCount ? result.rows[0].status : null;
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
  mapUploadSession,
};
