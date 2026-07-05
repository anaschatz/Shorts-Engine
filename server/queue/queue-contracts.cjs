const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText, validateResourceId } = require("../repositories/ids.cjs");
const { validateJobId, validateLeaseId, validateWorkerId } = require("../jobs.cjs");

const JOB_QUEUE_METHODS = Object.freeze([
  "create",
  "enqueue",
  "get",
  "all",
  "claim",
  "claimNext",
  "heartbeat",
  "update",
  "complete",
  "fail",
  "retry",
  "cancel",
  "releaseExpiredLeases",
  "publicJob",
  "publicJobSummary",
  "health",
]);

const QUEUE_BACKENDS = Object.freeze(["local-jobstore"]);

function validateRequestId(value, fallback = "queue_request") {
  const safe = sanitizeText(value || fallback, 120);
  if (!/^[A-Za-z0-9:_-]{3,120}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validateLeaseMs(value, fallback) {
  const duration = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(duration) || duration < 1000 || duration > 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(duration);
}

function validateNowMs(value) {
  const nowMs = value === undefined || value === null ? Date.now() : Number(value);
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(nowMs);
}

function validateBackoffMs(value) {
  if (value === undefined || value === null) return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0 || duration > 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(duration);
}

function validateRetryAt(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 40);
  if (!Number.isFinite(Date.parse(safe))) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validateQueueBackend(value = "local-jobstore") {
  const safe = sanitizeText(value || "local-jobstore", 40);
  if (!QUEUE_BACKENDS.includes(safe)) {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  return safe;
}

function validateQueueContract(queue) {
  for (const method of JOB_QUEUE_METHODS) {
    if (!queue || typeof queue[method] !== "function") {
      throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
    }
  }
  return queue;
}

function queueCapabilities(queue) {
  return Object.fromEntries(JOB_QUEUE_METHODS.map((method) => [method, Boolean(queue && typeof queue[method] === "function")]));
}

function validateProjectId(projectId) {
  return validateResourceId(projectId, "prj");
}

function validateUploadId(uploadId) {
  return uploadId ? validateResourceId(uploadId, "upl") : null;
}

function validateAction(action = "generate") {
  const safe = sanitizeText(action || "generate", 60);
  if (!/^[A-Za-z0-9:_-]{3,60}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validateIdempotencyKey(key) {
  if (!key) return null;
  const safe = sanitizeText(key, 160);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validateJobReference(jobOrId) {
  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId && jobOrId.id;
  return validateJobId(jobId);
}

function validateLease(lease, fallbackJobId = null) {
  if (!lease || typeof lease !== "object") {
    throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
  }
  return {
    jobId: validateJobId(lease.jobId || fallbackJobId),
    workerId: validateWorkerId(lease.workerId),
    leaseId: validateLeaseId(lease.leaseId),
    leaseExpiresAt: lease.leaseExpiresAt ? validateRetryAt(lease.leaseExpiresAt) : null,
    attempt: Math.max(0, Math.floor(Number(lease.attempt || 0))),
  };
}

function validateClaimOptions(options = {}, defaults = {}) {
  return {
    workerId: validateWorkerId(options.workerId || defaults.workerId),
    leaseId: options.leaseId ? validateLeaseId(options.leaseId) : undefined,
    leaseMs: validateLeaseMs(options.leaseMs || options.leaseDurationMs, defaults.leaseMs),
    nowMs: validateNowMs(options.nowMs),
    requestId: validateRequestId(options.requestId || defaults.requestId || "queue_claim"),
  };
}

function validateRetryOptions(options = {}) {
  return {
    backoffMs: validateBackoffMs(options.backoffMs),
    nextRetryAt: validateRetryAt(options.nextRetryAt),
    nowMs: validateNowMs(options.nowMs),
    requestId: validateRequestId(options.requestId || "queue_retry"),
  };
}

module.exports = {
  JOB_QUEUE_METHODS,
  QUEUE_BACKENDS,
  queueCapabilities,
  validateAction,
  validateBackoffMs,
  validateClaimOptions,
  validateIdempotencyKey,
  validateJobReference,
  validateLease,
  validateLeaseMs,
  validateNowMs,
  validateProjectId,
  validateQueueBackend,
  validateQueueContract,
  validateRequestId,
  validateRetryAt,
  validateRetryOptions,
  validateUploadId,
};
