const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const APPROVAL_OUTBOX_SCHEMA_VERSION = 1;
const OUTBOX_EVENT_FILE_RE = /^aout_[a-f0-9]{32}\.json$/;
const MAX_OUTBOX_EVENT_BYTES = 64 * 1024;
const APPROVAL_OUTBOX_EVENT_TYPES = Object.freeze([
  "approval_created",
  "render_queued",
  "render_processing",
  "render_completed",
  "render_failed",
  "render_cancelled",
]);
const APPROVAL_OUTBOX_STATUSES = Object.freeze(["pending", "processed", "failed"]);
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
  if (!APPROVAL_OUTBOX_STATUSES.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "status" });
  }
  return safe;
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
  return {
    schemaVersion: APPROVAL_OUTBOX_SCHEMA_VERSION,
    id,
    eventType,
    approvalId,
    payload,
    status: normalizeOutboxStatus(record.status || "pending"),
    attempts: Math.max(0, Math.min(100, Math.floor(Number(record.attempts || 0)))),
    nextAttemptAt: record.nextAttemptAt ? sanitizeText(record.nextAttemptAt, 40) : null,
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

  markProcessed(eventId, updatedAt = nowIso()) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", "Approval outbox event was not found.", 404);
    const updated = normalizeOutboxEvent({
      ...current,
      status: "processed",
      lastErrorCode: null,
      updatedAt,
    });
    this.records.set(updated.id, updated);
    this.persistRecord(updated);
    return updated;
  }

  markFailed(eventId, { errorCode = "OUTBOX_DELIVERY_FAILED", nextAttemptAt = null, updatedAt = nowIso() } = {}) {
    const current = this.get(eventId);
    if (!current) throw new AppError("OUTBOX_EVENT_NOT_FOUND", "Approval outbox event was not found.", 404);
    const updated = normalizeOutboxEvent({
      ...current,
      status: "failed",
      attempts: Number(current.attempts || 0) + 1,
      lastErrorCode: errorCode,
      nextAttemptAt,
      updatedAt,
    });
    this.records.set(updated.id, updated);
    this.persistRecord(updated);
    return updated;
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
    for (const record of this.records.values()) {
      byStatus[record.status] = Number(byStatus[record.status] || 0) + 1;
      byType[record.eventType] = Number(byType[record.eventType] || 0) + 1;
    }
    return {
      ready: true,
      repository: "approval-outbox",
      records: this.records.size,
      persistent: this.persist,
      statuses: byStatus,
      eventTypes: byType,
    };
  }
}

module.exports = {
  APPROVAL_OUTBOX_EVENT_TYPES,
  APPROVAL_OUTBOX_SCHEMA_VERSION,
  APPROVAL_OUTBOX_STATUSES,
  ApprovalOutboxRepository,
  normalizeOutboxEvent,
  outboxEventIdFor,
  validateOutboxEventId,
};
