const { randomUUID } = require("node:crypto");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("../errors.cjs");
const { ACTIVE_JOB_STATUSES, JobStore, TERMINAL_JOB_STATUSES } = require("../jobs.cjs");
const {
  queueCapabilities,
  validateAction,
  validateClaimOptions,
  validateIdempotencyKey,
  validateJobReference,
  validateLease,
  validateQueueBackend,
  validateQueueContract,
  validateRequestId,
  validateRetryOptions,
  validateProjectId,
  validateUploadId,
} = require("./queue-contracts.cjs");

function createWorkerId() {
  return `wrk_${randomUUID()}`;
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logWarn(logger, payload) {
  if (!logger || typeof logger.warn !== "function") return;
  logger.warn(JSON.stringify(redactForLogs({ level: "warn", ...payload })));
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function terminalStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(status);
}

function activeStatus(status) {
  return ACTIVE_JOB_STATUSES.includes(status);
}

class LocalJobQueue {
  constructor(options = {}) {
    this.store = options.jobs || options.store || new JobStore(options.jobStoreOptions || {});
    this.logger = Object.prototype.hasOwnProperty.call(options, "logger") ? options.logger : null;
    this.backend = validateQueueBackend(options.backend || "local-jobstore");
    this.workerId = options.workerId || createWorkerId();
    validateQueueContract(this);
  }

  create(record = {}) {
    const projectId = validateProjectId(record.projectId);
    const uploadId = validateUploadId(record.uploadId);
    const action = validateAction(record.action || "generate");
    const idempotencyKey = validateIdempotencyKey(record.idempotencyKey);
    const job = this.store.create({
      projectId,
      uploadId,
      action,
      idempotencyKey,
      payload: record.payload || null,
    });
    logInfo(this.logger, {
      event: "queue_job_created",
      jobId: job.id,
      projectId: job.projectId,
      uploadId: job.uploadId,
      status: job.status,
    });
    return job;
  }

  enqueue(jobOrId, options = {}) {
    const requestId = validateRequestId(options.requestId || "queue_enqueue");
    const job = this.get(validateJobReference(jobOrId));
    if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
    if (terminalStatus(job.status)) {
      logInfo(this.logger, {
        event: "queue_enqueue_terminal_skipped",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        status: job.status,
      });
      return job;
    }
    if (!activeStatus(job.status)) {
      throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
    }
    logInfo(this.logger, {
      event: "queue_job_enqueued",
      requestId,
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
      nextRetryAt: job.nextRetryAt || null,
    });
    return job;
  }

  get(jobId) {
    return this.store.get(validateJobReference(jobId));
  }

  all() {
    return this.store.all();
  }

  queued() {
    return this.store.queued();
  }

  publicJob(job) {
    return this.store.publicJob(job);
  }

  claim(jobOrId, options = {}) {
    const lease = validateClaimOptions(options, {
      workerId: this.workerId,
      leaseMs: this.store.leaseDurationMs,
      requestId: "queue_claim",
    });
    const result = this.store.claimJob(validateJobReference(jobOrId), lease);
    logInfo(this.logger, {
      event: "queue_job_claimed",
      requestId: lease.requestId,
      jobId: result.job.id,
      projectId: result.job.projectId,
      workerId: result.lease.workerId,
      leaseId: result.lease.leaseId,
      attempt: result.lease.attempt,
      leaseExpiresAt: result.lease.leaseExpiresAt,
    });
    return result;
  }

  claimNext(options = {}) {
    const lease = validateClaimOptions(options, {
      workerId: this.workerId,
      leaseMs: this.store.leaseDurationMs,
      requestId: "queue_claim_next",
    });
    const result = this.store.claimNextJob(lease);
    if (result) {
      logInfo(this.logger, {
        event: "queue_job_claimed",
        requestId: lease.requestId,
        jobId: result.job.id,
        projectId: result.job.projectId,
        workerId: result.lease.workerId,
        leaseId: result.lease.leaseId,
        attempt: result.lease.attempt,
        leaseExpiresAt: result.lease.leaseExpiresAt,
      });
    }
    return result;
  }

  update(job, patch, lease, options = {}) {
    const safeLease = validateLease(lease, validateJobReference(job));
    return this.store.updateWithLease(job, patch, safeLease, options);
  }

  heartbeat(job, lease, options = {}) {
    const safeLease = validateLease(lease, validateJobReference(job));
    const nextOptions = {
      ...options,
      nowMs: options.nowMs,
      leaseMs: options.leaseMs || this.store.leaseDurationMs,
    };
    return this.store.heartbeatWithLease(job, safeLease, nextOptions);
  }

  complete(job, patch, lease, options = {}) {
    const safeLease = validateLease(lease, validateJobReference(job));
    return this.store.completeWithLease(job, patch, safeLease, options);
  }

  fail(job, error, lease, options = {}) {
    const safeLease = validateLease(lease, validateJobReference(job));
    return this.store.failWithLease(job, error, safeLease, options);
  }

  retry(job, error, lease, options = {}) {
    const safeLease = validateLease(lease, validateJobReference(job));
    const retryOptions = validateRetryOptions(options);
    return this.store.retryWithLease(job, error, safeLease, retryOptions);
  }

  cancel(jobOrId, options = {}) {
    const requestId = validateRequestId(options.requestId || "queue_cancel");
    const job = this.store.cancel(validateJobReference(jobOrId));
    logInfo(this.logger, {
      event: "queue_job_cancelled",
      requestId,
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
    });
    return job;
  }

  releaseExpiredLeases(options = {}) {
    const nowMs = options.nowMs === undefined || options.nowMs === null ? Date.now() : Number(options.nowMs);
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const requestId = validateRequestId(options.requestId || "queue_release_expired");
    const summary = { released: 0, failed: 0, inspected: 0 };
    for (const job of this.store.all()) {
      if (job.status !== "processing") continue;
      summary.inspected += 1;
      if (!this.store.isLeaseExpired(job, nowMs)) continue;
      const outcome = this.store.recoverStaleJob(job, nowIso(nowMs));
      if (typeof this.store.persist === "function") this.store.persist(job, "job_expired_lease_released");
      if (outcome === "queued") summary.released += 1;
      if (outcome === "failed") summary.failed += 1;
      logWarn(this.logger, {
        event: "queue_expired_lease_released",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        status: job.status,
        outcome,
      });
    }
    return summary;
  }

  updateWithLease(job, patch, lease, options = {}) {
    return this.update(job, patch, lease, options);
  }

  heartbeatWithLease(job, lease, options = {}) {
    return this.heartbeat(job, lease, options);
  }

  completeWithLease(job, patch, lease, options = {}) {
    return this.complete(job, patch, lease, options);
  }

  failWithLease(job, error, lease, options = {}) {
    return this.fail(job, error, lease, options);
  }

  retryWithLease(job, error, lease, options = {}) {
    return this.retry(job, error, lease, options);
  }

  claimJob(jobId, options = {}) {
    return this.claim(jobId, options);
  }

  claimNextJob(options = {}) {
    return this.claimNext(options);
  }

  health(nowMs = Date.now()) {
    const storeHealth = this.store.health(nowMs);
    const workers = new Set();
    let activeWorkers = 0;
    let expiredLeases = 0;
    let activeLeases = 0;
    for (const job of this.store.all()) {
      if (job.status !== "processing" || !job.workerId || !job.leaseId) continue;
      workers.add(job.workerId);
      if (this.store.isLeaseExpired(job, nowMs)) expiredLeases += 1;
      else activeLeases += 1;
    }
    activeWorkers = workers.size;
    return {
      ready: true,
      adapter: "local-job-queue",
      backend: this.backend,
      queueBackend: storeHealth.queueBackend || storeHealth.backend || this.backend,
      durable: Boolean(storeHealth.persisted),
      capabilities: queueCapabilities(this),
      workerRuntime: {
        multiWorkerSafe: true,
        leaseBasedClaims: true,
        staleLeaseReclaim: true,
      },
      workers: {
        active: activeWorkers,
      },
      leases: {
        active: activeLeases,
        expired: expiredLeases,
        durationMs: storeHealth.leaseDurationMs,
      },
      jobs: {
        total: storeHealth.total,
        statuses: storeHealth.statuses,
        queued: Number(storeHealth.statuses && storeHealth.statuses.queued || 0),
        processing: Number(storeHealth.statuses && storeHealth.statuses.processing || 0),
        failed: Number(storeHealth.statuses && storeHealth.statuses.failed || 0),
        cancelled: Number(storeHealth.statuses && storeHealth.statuses.cancelled || 0),
        retryScheduled: Number(storeHealth.retryScheduled || 0),
      },
      repository: storeHealth.repository,
    };
  }
}

function createLocalJobQueue(options = {}) {
  return validateQueueContract(new LocalJobQueue(options));
}

module.exports = {
  LocalJobQueue,
  createLocalJobQueue,
};
