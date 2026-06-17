const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const APPROVAL_OUTBOX_SCHEMA_VERSION = 2;
const OUTBOX_EVENT_FILE_RE = /^aout_[a-f0-9]{32}\.json$/;
const MAX_OUTBOX_EVENT_BYTES = 64 * 1024;
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const APPROVAL_OUTBOX_EVENT_TYPES = Object.freeze([
  "approval_created",
  "render_queued",
  "render_processing",
  "render_completed",
  "render_failed",
  "render_cancelled",
]);
const APPROVAL_OUTBOX_STATUSES = Object.freeze(["pending", "processing", "delivered", "failed", "dead_letter"]);
const TERMINAL_OUTBOX_STATUSES = Object.freeze(["delivered", "dead_letter"]);
const OUTBOX_STATUS_ALIASES = Object.freeze({
  processed: "delivered",
});
const SAFE_PAYLOAD_FIELDS = Object.freeze([
  "requestId",
  "projectId",
  "approvalId",
  "draftRecordId",
  "regenerationPlanId",
  "sourceJobId",
  "sourceExportId",
  "newRenderJobId",
  "completedExportId",
  "status",
  "errorCode",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function outboxEventIdFor(input = {}) {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
  return `aout_${hash}`;
}

function writeOutboxJsonAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function validateOutboxEventId(value) {
  const safe = sanitizeText(value, 80);
  if (!/^aout_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateOutboxWorkerId(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 100);
  if (!/^obw_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateApprovalId(value) {
  const safe = sanitizeText(value, 80);
  if (!/^appr_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateDraftRecordId(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 80);
  if (!/^rdft_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function normalizeEventType(value) {
  const safe = sanitizeText(value, 60);
  if (!APPROVAL_OUTBOX_EVENT_TYPES.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "eventType" });
  }
  return safe;
}

function normalizeOutboxStatus(value) {
  const safe = sanitizeText(value || "pending", 40);
  const normalized = OUTBOX_STATUS_ALIASES[safe] || safe;
  if (!APPROVAL_OUTBOX_STATUSES.includes(normalized)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "status" });
  }
  return normalized;
}

function normalizeOutboxAttempts(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.floor(raw)));
}

function normalizeOutboxMaxAttempts(value) {
  const raw = value === undefined || value === null || value === "" ? DEFAULT_OUTBOX_MAX_ATTEMPTS : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_OUTBOX_MAX_ATTEMPTS;
  return Math.max(1, Math.min(20, Math.floor(raw)));
}

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 40);
  const parsed = Date.parse(safe);
  if (!Number.isFinite(parsed)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "timestamp" });
  }
  return safe;
}

function nextAttemptDue(record, nowMs) {
  const nextMs = Date.parse(record && record.nextAttemptAt ? record.nextAttemptAt : "");
  return !Number.isFinite(nextMs) || nextMs <= nowMs;
}

function staleLock(record, nowMs, staleLockMs = DEFAULT_STALE_LOCK_MS) {
  if (!record || record.status !== "processing") return false;
  const lockedMs = Date.parse(record.lockedAt || "");
  if (!Number.isFinite(lockedMs)) return true;
  const ttl = Math.max(1000, Math.min(Number(staleLockMs || DEFAULT_STALE_LOCK_MS), 60 * 60 * 1000));
  return lockedMs + ttl <= nowMs;
}

function canClaim(record, nowMs) {
  if (!record || TERMINAL_OUTBOX_STATUSES.includes(record.status)) return false;
  if (record.status === "pending") return true;
  if (record.status === "failed") return nextAttemptDue(record, nowMs);
  return false;
}

function validateStatusTransition(currentStatus, nextStatus) {
  const current = normalizeOutboxStatus(currentStatus);
  const next = normalizeOutboxStatus(nextStatus);
  if (current === next) return;
  if (TERMINAL_OUTBOX_STATUSES.includes(current)) {
    throw new AppError("OUTBOX_STATE_INVALID", SAFE_MESSAGES.OUTBOX_STATE_INVALID, 409);
  }
  const allowed = {
    pending: ["processing", "failed", "dead_letter"],
    failed: ["processing", "dead_letter"],
    processing: ["delivered", "failed", "dead_letter"],
  };
  if (!allowed[current] || !allowed[current].includes(next)) {
    throw new AppError("OUTBOX_STATE_INVALID", SAFE_MESSAGES.OUTBOX_STATE_INVALID, 409);
  }
}

function normalizeSafeToken(value, maxLength = 100) {
  if (!value) return null;
  const safe = sanitizeText(value, maxLength);
  if (!/^[A-Za-z0-9_:-]{1,100}$/.test(safe)) return null;
  return safe;
}

function normalizeErrorCode(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 80).toUpperCase();
  if (!/^[A-Z0-9_:-]{2,80}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "errorCode" });
  }
  return safe;
}

function safePayloadValue(field, value) {
  if (value === undefined || value === null || value === "") return null;
  if (field === "projectId") return validateResourceId(value, "prj");
  if (field === "sourceJobId" || field === "newRenderJobId") return validateResourceId(value, "job");
  if (field === "sourceExportId" || field === "completedExportId") return validateResourceId(value, "exp");
  if (field === "regenerationPlanId") return validateResourceId(value, "regen");
  if (field === "approvalId") return validateApprovalId(value);
  if (field === "draftRecordId") return validateDraftRecordId(value);
  if (field === "errorCode") return normalizeErrorCode(value);
  if (field === "status") return sanitizeText(value, 40);
  if (field === "requestId") return normalizeSafeToken(value, 100);
  return normalizeSafeToken(value, 100);
}

function safePayload(payload = {}) {
  const safe = {};
  for (const field of SAFE_PAYLOAD_FIELDS) {
    const value = safePayloadValue(field, payload[field]);
    if (value !== null) safe[field] = value;
  }
  return safe;
}

function lifecyclePayload(input = {}) {
  const approval = input.approvalRecord || {};
  return safePayload({
    requestId: input.requestId,
    projectId: input.projectId || approval.projectId,
    approvalId: input.approvalId || approval.approvalId,
    draftRecordId: input.draftRecordId || approval.draftRecordId,
    regenerationPlanId: input.regenerationPlanId || approval.regenerationPlanId,
    sourceJobId: input.sourceJobId || approval.sourceJobId,
    sourceExportId: input.sourceExportId || approval.sourceExportId,
    newRenderJobId: input.jobId || input.newRenderJobId || approval.newRenderJobId,
    completedExportId: input.exportId || input.completedExportId || approval.completedExportId,
    status: input.status || approval.status,
    errorCode: input.errorCode || approval.errorCode,
  });
}

function normalizeOutboxEvent(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const eventType = normalizeEventType(record.eventType);
  const payload = safePayload(record.payload || record);
  const approvalId = validateApprovalId(record.approvalId || payload.approvalId);
  const id = record.id
    ? validateOutboxEventId(record.id)
    : outboxEventIdFor({
        eventType,
        approvalId,
        projectId: payload.projectId,
        sourceJobId: payload.sourceJobId,
        sourceExportId: payload.sourceExportId,
        newRenderJobId: payload.newRenderJobId,
        completedExportId: payload.completedExportId,
        status: payload.status,
        errorCode: payload.errorCode,
      });
  const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
  const status = normalizeOutboxStatus(record.status || "pending");
  const deliveredAt = normalizeIsoTimestamp(record.deliveredAt);
  return {
    schemaVersion: APPROVAL_OUTBOX_SCHEMA_VERSION,
    id,
    eventType,
    approvalId,
    payload,
    status,
    attempts: normalizeOutboxAttempts(record.attempts),
    maxAttempts: normalizeOutboxMaxAttempts(record.maxAttempts),
    nextAttemptAt: normalizeIsoTimestamp(record.nextAttemptAt),
    lockedAt: normalizeIsoTimestamp(record.lockedAt),
    lockOwner: validateOutboxWorkerId(record.lockOwner),
    deliveredAt: status === "delivered" ? (deliveredAt || sanitizeText(record.updatedAt || createdAt, 40)) : deliveredAt,
    lastErrorCode: record.lastErrorCode ? normalizeErrorCode(record.lastErrorCode) : null,
    createdAt,
    updatedAt: sanitizeText(record.updatedAt || createdAt, 40),
  };
}

class ApprovalOutboxRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.persist = options.persist !== false;
    this.dir = options.dir || CONFIG.reviewApprovalOutboxDir;
    if (this.persist) mkdirSync(this.dir, { recursive: true });
  }

  persistRecord(record) {
    if (!this.persist) return;
    writeOutboxJsonAtomic(join(this.dir, `${validateOutboxEventId(record.id)}.json`), record);
  }

  create(record) {
    const normalized = normalizeOutboxEvent(record);
    const existing = this.records.get(normalized.id);
    if (existing) return existing;
    this.records.set(normalized.id, normalized);
    this.persistRecord(normalized);
    return normalized;
  }

  createLifecycleEvent(input = {}) {
    const eventType = normalizeEventType(input.eventType);
    const payload = lifecyclePayload(input);
    if (eventType === "approval_created") {
      delete payload.newRenderJobId;
      delete payload.completedExportId;
      delete payload.errorCode;
      payload.status = "approved";
    }
    return this.create({
      eventType,
      approvalId: payload.approvalId,
      payload,
      createdAt: input.createdAt,
    });
  }

  get(eventId) {
    return this.records.get(validateOutboxEventId(eventId)) || null;
  }

  listPending(limit = 100) {
    const max = Math.max(1, Math.min(500, Math.floor(Number(limit || 100))));
    return this.all().filter((record) => record.status === "pending").slice(0, max);
  }

  listDue(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const max = Math.max(1, Math.min(500, Math.floor(Number(options.limit || 100))));
    return this.all().filter((record) => canClaim(record, nowMs)).slice(0, max);
  }

  updateLifecycle(eventId, patch = {}) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", SAFE_MESSAGES.OUTBOX_EVENT_NOT_FOUND, 404);
    validateStatusTransition(current.status, patch.status || current.status);
    const updated = normalizeOutboxEvent({
      ...current,
      ...patch,
      updatedAt: patch.updatedAt || nowIso(),
    });
    this.records.set(updated.id, updated);
    this.persistRecord(updated);
    return updated;
  }

  claimDue(options = {}) {
    const workerId = validateOutboxWorkerId(options.workerId);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 10))));
    const claimed = [];
    for (const record of this.listDue({ nowMs, limit: 500 })) {
      if (claimed.length >= limit) break;
      const current = this.get(record.id);
      if (!canClaim(current, nowMs)) continue;
      if (Number(current.attempts || 0) >= Number(current.maxAttempts || DEFAULT_OUTBOX_MAX_ATTEMPTS)) {
        this.markDeadLetter(current.id, {
          errorCode: current.lastErrorCode || "OUTBOX_MAX_ATTEMPTS",
          updatedAt: new Date(nowMs).toISOString(),
        });
        continue;
      }
      claimed.push(this.updateLifecycle(current.id, {
        status: "processing",
        attempts: Number(current.attempts || 0) + 1,
        lockedAt: new Date(nowMs).toISOString(),
        lockOwner: workerId,
        nextAttemptAt: null,
        lastErrorCode: null,
        updatedAt: new Date(nowMs).toISOString(),
      }));
    }
    return claimed;
  }

  assertLockOwner(record, workerId) {
    const owner = validateOutboxWorkerId(workerId);
    if (owner && record.lockOwner && record.lockOwner !== owner) {
      throw new AppError("OUTBOX_STATE_INVALID", SAFE_MESSAGES.OUTBOX_STATE_INVALID, 409);
    }
  }

  markDelivered(eventId, { workerId = null, updatedAt = nowIso() } = {}) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", SAFE_MESSAGES.OUTBOX_EVENT_NOT_FOUND, 404);
    if (current.status === "delivered") return current;
    this.assertLockOwner(current, workerId);
    return this.updateLifecycle(eventId, {
      status: "delivered",
      lockedAt: null,
      lockOwner: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      deliveredAt: updatedAt,
      updatedAt,
    });
  }

  markProcessed(eventId, updatedAt = nowIso()) {
    return this.markDelivered(eventId, { updatedAt });
  }

  markFailed(eventId, {
    errorCode = "OUTBOX_DELIVERY_FAILED",
    nextAttemptAt = null,
    updatedAt = nowIso(),
    workerId = null,
  } = {}) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", SAFE_MESSAGES.OUTBOX_EVENT_NOT_FOUND, 404);
    if (current.status === "dead_letter") return current;
    this.assertLockOwner(current, workerId);
    const attempts = current.status === "processing" ? Number(current.attempts || 0) : Number(current.attempts || 0) + 1;
    if (attempts >= Number(current.maxAttempts || DEFAULT_OUTBOX_MAX_ATTEMPTS)) {
      return this.markDeadLetter(eventId, { errorCode, updatedAt, workerId });
    }
    return this.updateLifecycle(eventId, {
      status: "failed",
      attempts,
      lockedAt: null,
      lockOwner: null,
      lastErrorCode: errorCode,
      nextAttemptAt,
      updatedAt,
    });
  }

  markDeadLetter(eventId, { errorCode = "OUTBOX_DEAD_LETTER", updatedAt = nowIso(), workerId = null } = {}) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", SAFE_MESSAGES.OUTBOX_EVENT_NOT_FOUND, 404);
    if (current.status === "dead_letter") return current;
    this.assertLockOwner(current, workerId);
    return this.updateLifecycle(eventId, {
      status: "dead_letter",
      lockedAt: null,
      lockOwner: null,
      lastErrorCode: errorCode,
      nextAttemptAt: null,
      updatedAt,
    });
  }

  recoverStaleLocks(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const staleLockMs = Number.isFinite(Number(options.staleLockMs)) ? Number(options.staleLockMs) : DEFAULT_STALE_LOCK_MS;
    const updatedAt = new Date(nowMs).toISOString();
    const recovered = [];
    for (const record of this.all()) {
      if (!staleLock(record, nowMs, staleLockMs)) continue;
      recovered.push(this.markFailed(record.id, {
        errorCode: "OUTBOX_LOCK_STALE",
        nextAttemptAt: updatedAt,
        updatedAt,
      }));
    }
    return recovered;
  }

  all() {
    return [...this.records.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  }

  publicEvent(record) {
    if (!record) return null;
    return jsonClone(normalizeOutboxEvent(record));
  }

  restore() {
    if (!this.persist || !existsSync(this.dir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.dir).sort()) {
      try {
        if (!OUTBOX_EVENT_FILE_RE.test(basename(fileName))) {
          ignored += 1;
          continue;
        }
        const filePath = join(this.dir, fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_OUTBOX_EVENT_BYTES) {
          ignored += 1;
          continue;
        }
        const restored = normalizeOutboxEvent(JSON.parse(readFileSync(filePath, "utf8")));
        this.records.set(restored.id, restored);
        records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  health() {
    const byStatus = Object.fromEntries(APPROVAL_OUTBOX_STATUSES.map((status) => [status, 0]));
    const byType = Object.fromEntries(APPROVAL_OUTBOX_EVENT_TYPES.map((type) => [type, 0]));
    const nowMs = Date.now();
    let oldestPendingMs = null;
    for (const record of this.records.values()) {
      byStatus[record.status] = Number(byStatus[record.status] || 0) + 1;
      byType[record.eventType] = Number(byType[record.eventType] || 0) + 1;
      if (["pending", "failed"].includes(record.status)) {
        const createdMs = Date.parse(record.createdAt || "");
        if (Number.isFinite(createdMs)) oldestPendingMs = oldestPendingMs === null ? createdMs : Math.min(oldestPendingMs, createdMs);
      }
    }
    return {
      ready: true,
      repository: "approval-outbox",
      records: this.records.size,
      persistent: this.persist,
      statuses: byStatus,
      eventTypes: byType,
      oldestPendingAgeMs: oldestPendingMs === null ? 0 : Math.max(0, nowMs - oldestPendingMs),
    };
  }
}

module.exports = {
  APPROVAL_OUTBOX_EVENT_TYPES,
  APPROVAL_OUTBOX_SCHEMA_VERSION,
  APPROVAL_OUTBOX_STATUSES,
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_STALE_LOCK_MS,
  ApprovalOutboxRepository,
  TERMINAL_OUTBOX_STATUSES,
  normalizeOutboxEvent,
  outboxEventIdFor,
  validateOutboxEventId,
  validateOutboxWorkerId,
};
