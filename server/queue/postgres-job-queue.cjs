const { createHash, randomUUID } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { mapJob } = require("../adapters/postgres-persistence-adapter.cjs");

const RENDER_ACTIONS = new Set([
  "generate",
  "render",
  "render_approved_candidate",
  "render_approved_football",
  "render_narrated_short",
  "render_motivational_source_short",
]);
const MAX_RETRY_DELAY_MS = 60_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function requestHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function deterministicRetryDelayMs(jobId, attempt, options = {}) {
  const baseMs = Math.max(100, Math.min(
    MAX_RETRY_DELAY_MS,
    Number(options.baseMs || 1000) * (2 ** Math.max(0, Number(attempt || 1) - 1)),
  ));
  const digest = createHash("sha256")
    .update(`${jobId}:${attempt}`, "utf8")
    .digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff;
  const factor = 0.8 + fraction * 0.4;
  return Math.max(100, Math.min(MAX_RETRY_DELAY_MS, Math.round(baseMs * factor)));
}

function safeErrorCode(error, fallback = "RENDER_FAILED") {
  const code = String(error && error.code || fallback);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : fallback;
}

function leaseInput(jobOrId, lease) {
  const jobId = String(jobOrId && jobOrId.id || jobOrId || "");
  const workerId = String(lease && lease.workerId || "");
  const leaseId = String(lease && lease.leaseId || "");
  const attempt = Number(lease && lease.attempt);
  if (
    !jobId
    || !workerId
    || !leaseId
    || !Number.isInteger(attempt)
    || attempt < 1
  ) {
    throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
  }
  return { jobId, workerId, leaseId, attempt };
}

class PostgresJobQueue {
  constructor(options = {}) {
    this.persistence = options.persistenceAdapter;
    this.config = options.config || {};
    this.observability = options.observability || null;
    this.workerId = options.workerId || `wrk_${randomUUID()}`;
    this.randomUUID = options.randomUUID || randomUUID;
    this.backend = "postgres";
    this.leaseMs = Number(
      options.leaseMs
      || this.config.worker && this.config.worker.leaseMs
      || 60_000,
    );
    this.maxAttempts = Number(
      options.maxAttempts
      ?? (this.config.worker && this.config.worker.maxAttempts)
      ?? (Number(options.maxRetries ?? 3) + 1),
    );
    const quotas = this.config.quotas || {};
    this.dailyRenderQuota = Number(options.dailyRenderQuota || quotas.dailyRenderLimit || 20);
    this.monthlyRenderQuota = Number(options.monthlyRenderQuota || quotas.monthlyRenderLimit || 400);
    this.ownerConcurrency = Number(options.ownerConcurrency || quotas.perUserConcurrency || 2);
    this.globalConcurrency = Number(options.globalConcurrency || quotas.globalConcurrency || 8);
    this.providerBudgetUsd = Number(
      options.providerBudgetUsd ?? quotas.providerBudgetUsd ?? 100,
    );
  }

  async withTransaction(callback) {
    if (!this.persistence || typeof this.persistence.withTransaction !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    return await this.persistence.withTransaction(callback);
  }

  async recordClaim(transaction, row) {
    await transaction.query(
      `UPDATE job_attempts
       SET
         status = 'lease_expired',
         finished_at = clock_timestamp(),
         processing_duration_ms = GREATEST(
           0,
           floor(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::bigint
         )
       WHERE job_id = $1
         AND status = 'processing'
         AND attempt < $2`,
      [row.id, row.attempt],
    );
    await transaction.query(
      `INSERT INTO job_attempts(
         job_id, attempt, worker_id, lease_id, status,
         started_at, last_heartbeat_at, queue_wait_ms
       )
       VALUES (
         $1, $2, $3, $4, 'processing',
         clock_timestamp(), clock_timestamp(),
         GREATEST(
           0,
           floor(EXTRACT(EPOCH FROM (clock_timestamp() - $5::timestamptz)) * 1000)::bigint
         )
       )
       ON CONFLICT (job_id, attempt)
       DO UPDATE SET
         worker_id = EXCLUDED.worker_id,
         lease_id = EXCLUDED.lease_id,
         status = 'processing',
         started_at = clock_timestamp(),
         last_heartbeat_at = clock_timestamp(),
         finished_at = NULL,
         error_code = NULL,
         failure_category = NULL`,
      [
        row.id,
        row.attempt,
        row.worker_id,
        row.lease_id,
        row.created_at,
      ],
    );
  }

  async finishAttempt(transaction, fencing, status, errorCode = null) {
    await transaction.query(
      `UPDATE job_attempts
       SET
         status = $5,
         finished_at = clock_timestamp(),
         error_code = $6,
         failure_category = $6,
         processing_duration_ms = GREATEST(
           0,
           floor(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::bigint
         )
       WHERE job_id = $1
         AND worker_id = $2
         AND lease_id = $3
         AND attempt = $4
         AND status = 'processing'`,
      [
        fencing.jobId,
        fencing.workerId,
        fencing.leaseId,
        fencing.attempt,
        status,
        errorCode,
      ],
    );
  }

  async recordJobCost(transaction, row) {
    await transaction.query(
      `INSERT INTO job_cost_records(
         job_id, owner_id, pipeline_type,
         analysis_duration_ms, render_duration_ms, queue_wait_ms, retry_count,
         provider_usage_json, token_usage, tts_duration_ms,
         generated_asset_count, storage_bytes,
         estimated_cost_usd, final_cost_usd, cost_coverage,
         failure_category, completed, updated_at
       )
       SELECT
         job.id,
         job.owner_id,
         job.pipeline_type,
         CASE
           WHEN job.action LIKE 'analyze_%' THEN attempts.processing_ms
           ELSE NULL
         END,
         CASE
           WHEN job.action = ANY($2::text[]) THEN attempts.processing_ms
           ELSE NULL
         END,
         attempts.queue_wait_ms,
         GREATEST(0, job.attempt - 1),
         costs.usage_json,
         costs.token_usage,
         costs.tts_duration_ms,
         artifacts.generated_asset_count,
         artifacts.storage_bytes,
         costs.total_cost_usd,
         CASE WHEN costs.coverage = 1 THEN costs.total_cost_usd ELSE NULL END,
         costs.coverage,
         job.error_code,
         job.status = 'completed',
         clock_timestamp()
       FROM jobs AS job
       LEFT JOIN LATERAL (
         SELECT
           sum(processing_duration_ms)::bigint AS processing_ms,
           min(queue_wait_ms)::bigint AS queue_wait_ms
         FROM job_attempts
         WHERE job_id = job.id
       ) AS attempts ON true
       LEFT JOIN LATERAL (
         SELECT
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'provider', provider,
                 'operation', operation,
                 'unitType', unit_type,
                 'unitCount', unit_count,
                 'durationMs', duration_ms,
                 'retryCount', retry_count,
                 'estimated', estimated
               )
               ORDER BY created_at, id
             ),
             '[]'::jsonb
           ) AS usage_json,
           floor(coalesce(sum(unit_count) FILTER (
             WHERE unit_type IN ('token', 'tokens')
           ), 0))::bigint AS token_usage,
           coalesce(sum(duration_ms) FILTER (
             WHERE operation LIKE '%tts%'
                OR unit_type IN ('audio_second', 'audio_seconds')
           ), 0)::bigint AS tts_duration_ms,
           CASE
             WHEN count(*) = 0 THEN NULL
             ELSE sum(coalesce(provider_cost_usd, 0) + coalesce(compute_cost_usd, 0))
           END AS total_cost_usd,
           CASE
             WHEN count(*) = 0 THEN 0
             ELSE count(*) FILTER (
               WHERE provider_cost_usd IS NOT NULL OR compute_cost_usd IS NOT NULL
             )::numeric / count(*)::numeric
           END AS coverage
         FROM provider_usage_events
         WHERE job_id = job.id
       ) AS costs ON true
       LEFT JOIN LATERAL (
         SELECT
           count(*) FILTER (
             WHERE status = 'available'
           )::integer AS generated_asset_count,
           coalesce(sum(byte_size) FILTER (
             WHERE status = 'available'
           ), 0)::bigint AS storage_bytes
         FROM artifacts
         WHERE owner_job_id = job.id
       ) AS artifacts ON true
       WHERE job.id = $1
       ON CONFLICT (job_id)
       DO UPDATE SET
         analysis_duration_ms = EXCLUDED.analysis_duration_ms,
         render_duration_ms = EXCLUDED.render_duration_ms,
         queue_wait_ms = EXCLUDED.queue_wait_ms,
         retry_count = EXCLUDED.retry_count,
         provider_usage_json = EXCLUDED.provider_usage_json,
         token_usage = EXCLUDED.token_usage,
         tts_duration_ms = EXCLUDED.tts_duration_ms,
         generated_asset_count = EXCLUDED.generated_asset_count,
         storage_bytes = EXCLUDED.storage_bytes,
         estimated_cost_usd = EXCLUDED.estimated_cost_usd,
         final_cost_usd = EXCLUDED.final_cost_usd,
         cost_coverage = EXCLUDED.cost_coverage,
         failure_category = EXCLUDED.failure_category,
         completed = EXCLUDED.completed,
         updated_at = clock_timestamp()`,
      [row.id, [...RENDER_ACTIONS]],
    );
  }

  async enqueue(record, options = {}) {
    return await this.withTransaction(
      async (transaction) => await this.enqueueInTransaction(transaction, record, options),
    );
  }

  async enqueueInTransaction(transaction, record, options = {}) {
    if (!transaction || typeof transaction.query !== "function") {
      throw new TypeError("enqueueInTransaction requires an active PostgreSQL transaction");
    }
    const ownerId = String(record && record.ownerId || "");
    const projectId = String(record && record.projectId || "");
    const action = String(record && record.action || "generate");
    const pipelineType = String(record && record.pipelineType || "clip");
    const key = String(options.idempotencyKey || record.idempotencyKey || "");
    const hash = String(options.requestHash || requestHash({
      ownerId,
      projectId,
      uploadId: record.uploadId || null,
      action,
      pipelineType,
      payload: record.payload || {},
    }));
    if (key) {
      const reserved = await transaction.query(
          `INSERT INTO idempotency_records(
             owner_id, scope, key, request_hash, resource_type
           )
           VALUES ($1, $2, $3, $4, 'job')
           ON CONFLICT (owner_id, scope, key) DO NOTHING
           RETURNING owner_id`,
          [ownerId, `job:${action}`, key, hash],
      );
      if (!reserved.rowCount) {
        const existing = await transaction.query(
            `SELECT request_hash, resource_id
             FROM idempotency_records
             WHERE owner_id = $1 AND scope = $2 AND key = $3
             FOR UPDATE`,
            [ownerId, `job:${action}`, key],
        );
        const row = existing.rows[0];
        if (!row || String(row.request_hash).trim() !== hash) {
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            SAFE_MESSAGES.IDEMPOTENCY_CONFLICT,
            409,
          );
        }
        if (!row.resource_id) {
          throw new AppError(
            "PROJECT_STATE_LOCKED",
            SAFE_MESSAGES.PROJECT_STATE_LOCKED,
            409,
          );
        }
        const replay = await transaction.query(
            "SELECT * FROM jobs WHERE id = $1 AND owner_id = $2",
            [row.resource_id, ownerId],
        );
        if (!replay.rowCount) {
          throw new AppError(
            "PROJECT_STATE_LOCKED",
            SAFE_MESSAGES.PROJECT_STATE_LOCKED,
            409,
          );
        }
        return { job: mapJob(replay.rows[0]), replayed: true };
      }
    }

    if (RENDER_ACTIONS.has(action)) {
      await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`render-quota:${ownerId}`],
      );
      const policy = await transaction.query(
        `SELECT
           daily_render_limit,
           monthly_render_limit,
           provider_budget_usd
         FROM quota_policies
         WHERE owner_id = $1`,
        [ownerId],
      );
      const ownerPolicy = policy.rows[0] || {};
      const dailyLimit = Number(
        ownerPolicy.daily_render_limit ?? this.dailyRenderQuota,
      );
      const monthlyLimit = Number(
        ownerPolicy.monthly_render_limit ?? this.monthlyRenderQuota,
      );
      const providerBudgetUsd = Number(
        ownerPolicy.provider_budget_usd ?? this.providerBudgetUsd,
      );
      const quota = await transaction.query(
          `SELECT
             count(*) FILTER (
               WHERE created_at >= date_trunc('day', clock_timestamp())
             )::integer AS daily_count,
             count(*) FILTER (
               WHERE created_at >= date_trunc('month', clock_timestamp())
             )::integer AS monthly_count
           FROM jobs
           WHERE owner_id = $1
             AND action = ANY($2::text[])
             AND created_at >= date_trunc('month', clock_timestamp())`,
          [ownerId, [...RENDER_ACTIONS]],
      );
      if (
        Number(quota.rows[0].daily_count) >= dailyLimit
        || Number(quota.rows[0].monthly_count) >= monthlyLimit
      ) {
        if (this.observability) {
          this.observability.increment("quota_rejection_total", {
            pipeline: pipelineType.toLowerCase(),
            category: "render_count",
          });
        }
        throw new AppError(
          "RENDER_QUOTA_EXCEEDED",
          SAFE_MESSAGES.RENDER_QUOTA_EXCEEDED,
          429,
        );
      }
      const budget = await transaction.query(
        `SELECT coalesce(sum(
           coalesce(provider_cost_usd, 0) + coalesce(compute_cost_usd, 0)
         ), 0) AS attributed_cost_usd
         FROM provider_usage_events
         WHERE owner_id = $1
           AND created_at >= date_trunc('month', clock_timestamp())`,
        [ownerId],
      );
      if (Number(budget.rows[0].attributed_cost_usd || 0) >= providerBudgetUsd) {
        if (this.observability) {
          this.observability.increment("quota_rejection_total", {
            pipeline: pipelineType.toLowerCase(),
            category: "provider_budget",
          });
        }
        throw new AppError(
          "RENDER_QUOTA_EXCEEDED",
          SAFE_MESSAGES.RENDER_QUOTA_EXCEEDED,
          429,
        );
      }
    }

    const jobId = String(record.id || `job_${this.randomUUID()}`);
    const inserted = await transaction.query(
        `INSERT INTO jobs(
           id, owner_id, project_id, upload_id, action, pipeline_type,
           status, progress, step, max_attempts, payload_json, traceparent
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           'queued', 0, 'queued', $7, $8::jsonb, $9
         )
         RETURNING *`,
        [
          jobId,
          ownerId,
          projectId,
          record.uploadId || null,
          action,
          pipelineType,
          this.maxAttempts,
          JSON.stringify(record.payload || {}),
          record.traceparent || null,
        ],
    );
    if (key) {
      await transaction.query(
          `UPDATE idempotency_records
           SET resource_id = $4
           WHERE owner_id = $1 AND scope = $2 AND key = $3`,
          [ownerId, `job:${action}`, key, jobId],
      );
    }
    return { job: mapJob(inserted.rows[0]), replayed: false };
  }

  async moveExpiredExhaustedToDlq(transaction) {
    const exhausted = await transaction.query(
      `WITH expired AS (
         SELECT id
         FROM jobs
         WHERE status = 'processing'
           AND lease_expires_at <= clock_timestamp()
           AND attempt >= max_attempts
         ORDER BY lease_expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       UPDATE jobs AS job
       SET
         status = 'failed',
         step = 'dead_letter',
         error_code = COALESCE(job.error_code, 'JOB_STALE'),
         worker_id = NULL,
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
       FROM expired
       WHERE job.id = expired.id
       RETURNING job.*`,
    );
    for (const row of exhausted.rows) {
      await transaction.query(
        `UPDATE job_attempts
         SET
           status = 'failed',
           finished_at = clock_timestamp(),
           error_code = $3,
           failure_category = $3,
           processing_duration_ms = GREATEST(
             0,
             floor(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::bigint
           )
         WHERE job_id = $1 AND attempt = $2 AND status = 'processing'`,
        [row.id, row.attempt, row.error_code || "JOB_STALE"],
      );
      await transaction.query(
        `INSERT INTO job_dead_letters(
           job_id, owner_id, final_error_code, attempts, record_json
         )
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (job_id)
         DO UPDATE SET
           final_error_code = EXCLUDED.final_error_code,
           attempts = EXCLUDED.attempts,
           record_json = EXCLUDED.record_json,
           resolved_at = NULL,
           resolved_by = NULL`,
        [
          row.id,
          row.owner_id,
          row.error_code || "JOB_STALE",
          row.attempt,
          JSON.stringify({
            jobId: row.id,
            action: row.action,
            pipelineType: row.pipeline_type,
            errorCode: row.error_code || "JOB_STALE",
          }),
        ],
      );
    }
    return exhausted.rowCount;
  }

  async finalizeExpiredCancellations(transaction) {
    const result = await transaction.query(
      `WITH expired AS (
         SELECT id
         FROM jobs
         WHERE status = 'processing'
           AND cancel_requested_at IS NOT NULL
           AND lease_expires_at <= clock_timestamp()
         ORDER BY lease_expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       UPDATE jobs AS job
       SET
         status = 'cancelled',
         step = 'cancelled',
         completed_at = clock_timestamp(),
         worker_id = NULL,
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
       FROM expired
       WHERE job.id = expired.id
       RETURNING job.id, job.attempt`,
    );
    for (const row of result.rows) {
      await transaction.query(
        `UPDATE job_attempts
         SET
           status = 'cancelled',
           finished_at = clock_timestamp(),
           processing_duration_ms = GREATEST(
             0,
             floor(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::bigint
           )
         WHERE job_id = $1 AND attempt = $2 AND status = 'processing'`,
        [row.id, row.attempt],
      );
    }
    return result.rowCount;
  }

  async claimNext(options = {}) {
    const workerId = String(options.workerId || this.workerId);
    const leaseId = `lease_${this.randomUUID()}`;
    const leaseMs = Number(options.leaseMs || this.leaseMs);
    return await this.withTransaction(async (transaction) => {
      await this.finalizeExpiredCancellations(transaction);
      await this.moveExpiredExhaustedToDlq(transaction);
      const claimed = await transaction.query(
        `WITH candidate AS (
           SELECT job.id
           FROM jobs AS job
           JOIN users AS owner ON owner.id = job.owner_id
           WHERE (
             (
               job.status = 'queued'
               AND (job.next_retry_at IS NULL OR job.next_retry_at <= clock_timestamp())
             )
             OR (
               job.status = 'processing'
               AND job.lease_expires_at <= clock_timestamp()
               AND job.attempt < job.max_attempts
             )
           )
           AND job.cancel_requested_at IS NULL
           AND (
             SELECT count(*)
             FROM jobs AS global_active
             WHERE global_active.status = 'processing'
               AND global_active.lease_expires_at > clock_timestamp()
           ) < $6
           AND (
             NOT (job.action = ANY($4::text[]))
             OR (
               SELECT count(*)
               FROM jobs AS active
               WHERE active.owner_id = job.owner_id
                 AND active.status = 'processing'
                 AND active.lease_expires_at > clock_timestamp()
                 AND active.action = ANY($4::text[])
             ) < coalesce(
               (
                 SELECT concurrent_job_limit
                 FROM quota_policies
                 WHERE owner_id = job.owner_id
               ),
               $5
             )
           )
           ORDER BY job.created_at, job.id
           FOR UPDATE OF job, owner SKIP LOCKED
           LIMIT 1
         )
         UPDATE jobs AS job
         SET
           status = 'processing',
           step = 'processing',
           attempt = job.attempt + 1,
           worker_id = $1,
           lease_id = $2,
           lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
           last_heartbeat_at = clock_timestamp(),
           next_retry_at = NULL,
           updated_at = clock_timestamp()
         FROM candidate
         WHERE job.id = candidate.id
         RETURNING job.*`,
        [
          workerId,
          leaseId,
          leaseMs,
          [...RENDER_ACTIONS],
          this.ownerConcurrency,
          this.globalConcurrency,
        ],
      );
      if (!claimed.rowCount) return null;
      await this.recordClaim(transaction, claimed.rows[0]);
      const job = mapJob(claimed.rows[0]);
      return {
        job,
        lease: {
          jobId: job.id,
          workerId,
          leaseId,
          attempt: job.attempts,
          leaseExpiresAt: job.leaseExpiresAt,
        },
      };
    });
  }

  async claim(jobOrId, options = {}) {
    const jobId = String(jobOrId && jobOrId.id || jobOrId || "");
    const workerId = String(options.workerId || this.workerId);
    const leaseId = `lease_${this.randomUUID()}`;
    const leaseMs = Number(options.leaseMs || this.leaseMs);
    return await this.withTransaction(async (transaction) => {
      await this.finalizeExpiredCancellations(transaction);
      await this.moveExpiredExhaustedToDlq(transaction);
      const locked = await transaction.query(
        `SELECT
           job.action,
           job.owner_id,
           coalesce(policy.concurrent_job_limit, $2) AS concurrent_job_limit
         FROM jobs AS job
         JOIN users AS owner ON owner.id = job.owner_id
         LEFT JOIN quota_policies AS policy ON policy.owner_id = job.owner_id
         WHERE job.id = $1
         FOR UPDATE OF job, owner`,
        [jobId, this.ownerConcurrency],
      );
      const globalActive = await transaction.query(
        `SELECT count(*)::integer AS count
         FROM jobs
         WHERE status = 'processing'
           AND lease_expires_at > clock_timestamp()`,
      );
      if (Number(globalActive.rows[0].count) >= this.globalConcurrency) {
        throw new AppError(
          "JOB_LEASE_INVALID",
          SAFE_MESSAGES.JOB_LEASE_INVALID,
          409,
        );
      }
      if (locked.rowCount && RENDER_ACTIONS.has(locked.rows[0].action)) {
        const active = await transaction.query(
          `SELECT count(*)::integer AS count
           FROM jobs
           WHERE owner_id = $1
             AND status = 'processing'
             AND lease_expires_at > clock_timestamp()
             AND action = ANY($2::text[])`,
          [locked.rows[0].owner_id, [...RENDER_ACTIONS]],
        );
        if (
          Number(active.rows[0].count)
          >= Number(locked.rows[0].concurrent_job_limit)
        ) {
          throw new AppError(
            "JOB_LEASE_INVALID",
            SAFE_MESSAGES.JOB_LEASE_INVALID,
            409,
          );
        }
      }
      const claimed = await transaction.query(
        `UPDATE jobs
         SET
           status = 'processing',
           step = 'processing',
           attempt = attempt + 1,
           worker_id = $2,
           lease_id = $3,
           lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
           last_heartbeat_at = clock_timestamp(),
           next_retry_at = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND (
             (
               status = 'queued'
               AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
             )
             OR (
               status = 'processing'
               AND lease_expires_at <= clock_timestamp()
               AND attempt < max_attempts
             )
           )
           AND cancel_requested_at IS NULL
         RETURNING *`,
        [jobId, workerId, leaseId, leaseMs],
      );
      if (!claimed.rowCount) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      await this.recordClaim(transaction, claimed.rows[0]);
      const job = mapJob(claimed.rows[0]);
      return {
        job,
        lease: {
          jobId: job.id,
          workerId,
          leaseId,
          attempt: job.attempts,
          leaseExpiresAt: job.leaseExpiresAt,
        },
      };
    });
  }

  async heartbeat(jobOrId, lease, options = {}) {
    const fencing = leaseInput(jobOrId, lease);
    const leaseMs = Number(options.leaseMs || this.leaseMs);
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE jobs
         SET
           lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
           last_heartbeat_at = clock_timestamp(),
           updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'processing'
           AND worker_id = $2
           AND lease_id = $3
           AND attempt = $4
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [
          fencing.jobId,
          fencing.workerId,
          fencing.leaseId,
          fencing.attempt,
          leaseMs,
        ],
      );
      if (!result.rowCount) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      await transaction.query(
        `UPDATE job_attempts
         SET last_heartbeat_at = clock_timestamp()
         WHERE job_id = $1
           AND worker_id = $2
           AND lease_id = $3
           AND attempt = $4
           AND status = 'processing'`,
        [
          fencing.jobId,
          fencing.workerId,
          fencing.leaseId,
          fencing.attempt,
        ],
      );
      return mapJob(result.rows[0]);
    });
  }

  async update(jobOrId, patch = {}, lease) {
    const fencing = leaseInput(jobOrId, lease);
    const result = await this.persistence.query(
      `UPDATE jobs
       SET
         progress = COALESCE($5, progress),
         step = COALESCE($6, step),
         updated_at = clock_timestamp()
       WHERE id = $1
         AND status = 'processing'
         AND worker_id = $2
         AND lease_id = $3
         AND attempt = $4
         AND lease_expires_at > clock_timestamp()
       RETURNING *`,
      [
        fencing.jobId,
        fencing.workerId,
        fencing.leaseId,
        fencing.attempt,
        Number.isFinite(Number(patch.progress)) ? Math.max(0, Math.min(99, Number(patch.progress))) : null,
        patch.step ? String(patch.step).slice(0, 80) : null,
      ],
    );
    if (!result.rowCount) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    return mapJob(result.rows[0]);
  }

  async complete(jobOrId, patch = {}, lease) {
    return await this.withTransaction(
      async (transaction) => await this.completeInTransaction(
        transaction,
        jobOrId,
        patch,
        lease,
      ),
    );
  }

  async completeInTransaction(transaction, jobOrId, patch = {}, lease) {
    if (!transaction || typeof transaction.query !== "function") {
      throw new TypeError("completeInTransaction requires an active PostgreSQL transaction");
    }
    const fencing = leaseInput(jobOrId, lease);
    const result = await transaction.query(
      `UPDATE jobs
       SET
         status = CASE
           WHEN cancel_requested_at IS NULL THEN 'completed'
           ELSE 'cancelled'
         END,
         progress = CASE
           WHEN cancel_requested_at IS NULL THEN 100
           ELSE progress
         END,
         step = CASE
           WHEN cancel_requested_at IS NULL THEN 'completed'
           ELSE 'cancelled'
         END,
         result_json = CASE
           WHEN cancel_requested_at IS NULL THEN $5::jsonb
           ELSE result_json
         END,
         completed_at = clock_timestamp(),
         worker_id = NULL,
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
       WHERE id = $1
         AND status = 'processing'
         AND worker_id = $2
         AND lease_id = $3
         AND attempt = $4
         AND lease_expires_at > clock_timestamp()
       RETURNING *`,
      [
        fencing.jobId,
        fencing.workerId,
        fencing.leaseId,
        fencing.attempt,
        JSON.stringify(patch.result || patch || {}),
      ],
    );
    if (!result.rowCount) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    await this.finishAttempt(
      transaction,
      fencing,
      result.rows[0].status === "completed" ? "completed" : "cancelled",
    );
    await this.recordJobCost(transaction, result.rows[0]);
    return mapJob(result.rows[0]);
  }

  async completeAtomically(jobOrId, patch = {}, lease, mutation) {
    if (typeof mutation !== "function") {
      throw new TypeError("completeAtomically requires a transaction mutation");
    }
    return await this.withTransaction(async (transaction) => {
      const completed = await this.completeInTransaction(
        transaction,
        jobOrId,
        patch,
        lease,
      );
      if (completed.status === "completed") {
        await mutation(transaction, completed);
      }
      return completed;
    });
  }

  async retry(jobOrId, error, lease, options = {}) {
    const fencing = leaseInput(jobOrId, lease);
    const code = safeErrorCode(error);
    const delayMs = deterministicRetryDelayMs(
      fencing.jobId,
      fencing.attempt,
      options,
    );
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE jobs
         SET
           status = CASE
             WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
             WHEN attempt >= max_attempts THEN 'failed'
             ELSE 'queued'
           END,
           step = CASE
             WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
             WHEN attempt >= max_attempts THEN 'dead_letter'
             ELSE 'retry_scheduled'
           END,
           error_code = CASE
             WHEN cancel_requested_at IS NULL THEN $5
             ELSE NULL
           END,
           next_retry_at = CASE
             WHEN cancel_requested_at IS NOT NULL OR attempt >= max_attempts THEN NULL
             ELSE clock_timestamp() + ($6::bigint * interval '1 millisecond')
           END,
           worker_id = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'processing'
           AND worker_id = $2
           AND lease_id = $3
           AND attempt = $4
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [
          fencing.jobId,
          fencing.workerId,
          fencing.leaseId,
          fencing.attempt,
          code,
          delayMs,
        ],
      );
      if (!result.rowCount) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      const row = result.rows[0];
      await this.finishAttempt(
        transaction,
        fencing,
        row.status === "queued"
          ? "retry_scheduled"
          : row.status === "cancelled"
            ? "cancelled"
            : "failed",
        row.status === "cancelled" ? null : code,
      );
      await transaction.query(
        `INSERT INTO audit_events(
           actor_type, action, resource_type, resource_id, safe_metadata
         )
         VALUES ('system', $2, 'job', $1, $3::jsonb)`,
        [
          row.id,
          row.status === "queued" ? "job.retry_scheduled" : "job.dead_letter",
          JSON.stringify({
            attempt: Number(row.attempt),
            errorCode: code,
            retryDelayMs: row.status === "queued" ? delayMs : null,
          }),
        ],
      );
      if (row.status === "failed") {
        await transaction.query(
          `INSERT INTO job_dead_letters(
             job_id, owner_id, final_error_code, attempts, record_json
           )
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (job_id)
           DO UPDATE SET
             final_error_code = EXCLUDED.final_error_code,
             attempts = EXCLUDED.attempts,
             record_json = EXCLUDED.record_json,
             resolved_at = NULL,
             resolved_by = NULL`,
          [
            row.id,
            row.owner_id,
            code,
            row.attempt,
            JSON.stringify({
              jobId: row.id,
              action: row.action,
              pipelineType: row.pipeline_type,
              errorCode: code,
            }),
          ],
        );
        await this.recordJobCost(transaction, row);
      }
      return mapJob(row);
    });
  }

  async fail(jobOrId, error, lease) {
    const fencing = leaseInput(jobOrId, lease);
    const code = safeErrorCode(error);
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE jobs
         SET
           status = CASE
             WHEN cancel_requested_at IS NULL THEN 'failed'
             ELSE 'cancelled'
           END,
           step = CASE
             WHEN cancel_requested_at IS NULL THEN 'failed'
             ELSE 'cancelled'
           END,
           error_code = CASE
             WHEN cancel_requested_at IS NULL THEN $5
             ELSE NULL
           END,
           worker_id = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'processing'
           AND worker_id = $2
           AND lease_id = $3
           AND attempt = $4
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [
          fencing.jobId,
          fencing.workerId,
          fencing.leaseId,
          fencing.attempt,
          code,
        ],
      );
      if (!result.rowCount) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      await this.finishAttempt(
        transaction,
        fencing,
        result.rows[0].status === "cancelled" ? "cancelled" : "failed",
        result.rows[0].status === "cancelled" ? null : code,
      );
      await transaction.query(
        `INSERT INTO audit_events(
           actor_type, action, resource_type, resource_id, safe_metadata
         )
         VALUES ('system', 'job.failed', 'job', $1, $2::jsonb)`,
        [
          result.rows[0].id,
          JSON.stringify({ attempt: fencing.attempt, errorCode: code }),
        ],
      );
      await this.recordJobCost(transaction, result.rows[0]);
      return mapJob(result.rows[0]);
    });
  }

  async cancel(jobOrId, options = {}) {
    const jobId = String(jobOrId && jobOrId.id || jobOrId || "");
    const ownerId = String(options.ownerId || "");
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE jobs
         SET
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           step = CASE WHEN status = 'queued' THEN 'cancelled' ELSE step END,
           cancel_requested_at = clock_timestamp(),
           updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_id = $2
           AND status IN ('queued', 'processing')
         RETURNING *`,
        [jobId, ownerId],
      );
      if (!result.rowCount) {
        throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
      }
      await transaction.query(
        `INSERT INTO audit_events(
           actor_user_id, actor_type, action, resource_type, resource_id, safe_metadata
         )
         VALUES ($1, 'user', 'job.cancel_requested', 'job', $2, $3::jsonb)`,
        [
          ownerId,
          jobId,
          JSON.stringify({ previousStatus: result.rows[0].status }),
        ],
      );
      if (result.rows[0].status === "cancelled") {
        await this.recordJobCost(transaction, result.rows[0]);
      }
      return mapJob(result.rows[0]);
    });
  }

  async acknowledgeCancellation(jobOrId, lease) {
    const fencing = leaseInput(jobOrId, lease);
    return await this.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE jobs
         SET
           status = 'cancelled',
           step = 'cancelled',
           completed_at = clock_timestamp(),
           worker_id = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'processing'
           AND cancel_requested_at IS NOT NULL
           AND worker_id = $2
           AND lease_id = $3
           AND attempt = $4
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [
          fencing.jobId,
          fencing.workerId,
          fencing.leaseId,
          fencing.attempt,
        ],
      );
      if (!result.rowCount) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      await this.finishAttempt(transaction, fencing, "cancelled");
      await this.recordJobCost(transaction, result.rows[0]);
      return mapJob(result.rows[0]);
    });
  }

  async get(jobId, ownerId) {
    const result = await this.persistence.query(
      "SELECT * FROM jobs WHERE id = $1 AND owner_id = $2",
      [jobId, ownerId],
    );
    return mapJob(result.rows[0]);
  }

  async inspectDeadLetters({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
    const result = await this.persistence.query(
      `SELECT
         job_id, final_error_code, attempts, redrive_count, created_at
       FROM job_dead_letters
       WHERE resolved_at IS NULL
       ORDER BY created_at
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      jobId: row.job_id,
      errorCode: row.final_error_code,
      attempts: Number(row.attempts),
      redriveCount: Number(row.redrive_count),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async redriveDeadLetter({ jobId, operatorId }) {
    return await this.withTransaction(async (transaction) => {
      const deadLetter = await transaction.query(
        `SELECT job_id
         FROM job_dead_letters
         WHERE job_id = $1 AND resolved_at IS NULL
         FOR UPDATE`,
        [jobId],
      );
      if (!deadLetter.rowCount) {
        throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
      }
      const job = await transaction.query(
        `UPDATE jobs
         SET
           status = 'queued',
           step = 'redriven',
           attempt = 0,
           next_retry_at = clock_timestamp(),
           error_code = NULL,
           worker_id = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'failed'
         RETURNING *`,
        [jobId],
      );
      if (!job.rowCount) {
        throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
      }
      await transaction.query(
        `UPDATE job_dead_letters
         SET
           resolved_at = clock_timestamp(),
           resolved_by = $2,
           redrive_count = redrive_count + 1
         WHERE job_id = $1`,
        [jobId, operatorId],
      );
      await transaction.query(
        `INSERT INTO audit_events(
           actor_type, action, resource_type, resource_id, safe_metadata
         )
         VALUES ('operator', 'job.redrive', 'job', $1, $2::jsonb)`,
        [jobId, JSON.stringify({ operatorId: String(operatorId).slice(0, 80) })],
      );
      return mapJob(job.rows[0]);
    });
  }

  async health() {
    try {
      const result = await this.persistence.query(
        `SELECT
           count(*)::integer AS total,
           count(*) FILTER (WHERE status = 'queued')::integer AS queued,
           count(*) FILTER (WHERE status = 'processing')::integer AS processing,
           count(*) FILTER (WHERE status = 'failed')::integer AS failed,
           count(*) FILTER (
             WHERE status = 'processing' AND lease_expires_at <= clock_timestamp()
           )::integer AS expired,
           EXTRACT(EPOCH FROM (
             clock_timestamp() - min(created_at) FILTER (WHERE status = 'queued')
           )) AS oldest_age_seconds
         FROM jobs`,
      );
      const row = result.rows[0];
      if (this.observability) {
        this.observability.observe("queue_depth", Number(row.queued || 0), {
          outcome: "queued",
        });
        this.observability.observe("queue_depth", Number(row.processing || 0), {
          outcome: "processing",
        });
      }
      return {
        ready: true,
        adapter: "postgres-job-queue",
        backend: "postgres",
        durable: true,
        workerRuntime: {
          multiWorkerSafe: true,
          leaseBasedClaims: true,
          staleLeaseReclaim: true,
        },
        leases: {
          durationMs: this.leaseMs,
          expired: Number(row.expired || 0),
        },
        jobs: {
          total: Number(row.total || 0),
          queued: Number(row.queued || 0),
          processing: Number(row.processing || 0),
          failed: Number(row.failed || 0),
          oldestAgeSeconds: row.oldest_age_seconds === null
            ? null
            : Number(row.oldest_age_seconds),
        },
      };
    } catch {
      return {
        ready: false,
        adapter: "postgres-job-queue",
        backend: "postgres",
        durable: true,
        workerRuntime: {
          multiWorkerSafe: true,
          leaseBasedClaims: true,
          staleLeaseReclaim: true,
        },
      };
    }
  }

  async close() {
    return false;
  }

  async updateWithLease(job, patch, lease, options) {
    return await this.update(job, patch, lease, options);
  }

  async heartbeatWithLease(job, lease, options) {
    return await this.heartbeat(job, lease, options);
  }

  async completeWithLease(job, patch, lease, options) {
    return await this.complete(job, patch, lease, options);
  }

  async failWithLease(job, error, lease, options) {
    return await this.fail(job, error, lease, options);
  }

  async retryWithLease(job, error, lease, options) {
    return await this.retry(job, error, lease, options);
  }
}

async function createPostgresJobQueue(options = {}) {
  return new PostgresJobQueue(options);
}

module.exports = {
  PostgresJobQueue,
  RENDER_ACTIONS,
  createPostgresJobQueue,
  deterministicRetryDelayMs,
  mapJob,
  requestHash,
};
