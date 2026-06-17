const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const APPROVAL_AUDIT_SCHEMA_VERSION = 1;
const APPROVAL_RECORD_FILE_RE = /^appr_[a-f0-9]{32}\.json$/;
const DRAFT_HASH_RE = /^[a-f0-9]{16,64}$/;
const APPROVAL_STATUSES = Object.freeze([
  "approved",
  "render_queued",
  "render_processing",
  "render_completed",
  "render_failed",
  "cancelled",
  "rejected",
]);
const MAX_APPROVAL_RECORD_BYTES = 96 * 1024;

function validateApprovalId(value) {
  const safe = sanitizeText(value, 80);
  if (!/^appr_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function writeApprovalJsonAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function validateDraftHash(value) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!DRAFT_HASH_RE.test(safe)) {
    throw new AppError("VALIDATION_ERROR", "Draft hash is invalid.", 400, { field: "draftHash" });
  }
  return safe;
}

function validateIdempotencyKey(value) {
  const safe = sanitizeText(value, 160);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "idempotencyKey" });
  }
  return safe;
}

function normalizeApprovalStatus(value) {
  const safe = sanitizeText(value || "approved", 40);
  if (!APPROVAL_STATUSES.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "status" });
  }
  return safe;
}

function normalizeApprovedBy(value) {
  const safe = sanitizeText(value || "operator/manual/local", 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:/-]{0,79}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "approvedBy" });
  }
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

function normalizeDraftRecordId(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 80);
  if (!/^rdft_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function sameApprovalRequest(a = {}, b = {}) {
  return (
    a.projectId === b.projectId &&
    a.sourceJobId === b.sourceJobId &&
    a.sourceExportId === b.sourceExportId &&
    a.regenerationPlanId === b.regenerationPlanId &&
    a.draftHash === b.draftHash
  );
}

function normalizeApprovalRecord(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const approvalId = validateApprovalId(record.approvalId || record.id);
  const projectId = validateResourceId(record.projectId || record.sourceProjectId, "prj");
  const sourceJobId = validateResourceId(record.sourceJobId || record.jobId, "job");
  const sourceExportId = validateResourceId(record.sourceExportId || record.exportId, "exp");
  const regenerationPlanId = validateResourceId(record.regenerationPlanId, "regen");
  const draftHash = validateDraftHash(record.draftHash);
  const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
  const newRenderJobId = record.newRenderJobId ? validateResourceId(record.newRenderJobId, "job") : null;
  const completedExportId = record.completedExportId ? validateResourceId(record.completedExportId, "exp") : null;
  return {
    schemaVersion: APPROVAL_AUDIT_SCHEMA_VERSION,
    approvalId,
    regenerationPlanId,
    draftHash,
    projectId,
    sourceJobId,
    sourceExportId,
    newRenderJobId,
    completedExportId,
    idempotencyKey: validateIdempotencyKey(record.idempotencyKey),
    approvedAt: sanitizeText(record.approvedAt || createdAt, 40),
    approvedBy: normalizeApprovedBy(record.approvedBy),
    status: normalizeApprovalStatus(record.status),
    errorCode: normalizeErrorCode(record.errorCode),
    draftRecordId: normalizeDraftRecordId(record.draftRecordId),
    createdAt,
    updatedAt: sanitizeText(record.updatedAt || createdAt, 40),
  };
}

class RegenerationApprovalRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.persist = options.persist !== false;
    this.dir = options.dir || CONFIG.reviewApprovalDir;
    if (this.persist) mkdirSync(this.dir, { recursive: true });
  }

  persistRecord(record) {
    if (!this.persist) return;
    writeApprovalJsonAtomic(join(this.dir, `${validateApprovalId(record.approvalId)}.json`), record);
  }

  createIdempotent(record) {
    const normalized = normalizeApprovalRecord(record);
    const byKey = this.getByIdempotencyKey(normalized.idempotencyKey);
    if (byKey) {
      if (!sameApprovalRequest(byKey, normalized)) {
        throw new AppError("VALIDATION_ERROR", "Approval idempotency key belongs to another draft.", 409, {
          field: "idempotencyKey",
          nextAction: "refresh-regeneration-draft",
        });
      }
      return byKey;
    }
    const byId = this.records.get(normalized.approvalId);
    if (byId) {
      if (!sameApprovalRequest(byId, normalized)) {
        throw new AppError("VALIDATION_ERROR", "Approval id belongs to another draft.", 409, {
          field: "approvalId",
          nextAction: "refresh-regeneration-draft",
        });
      }
      return byId;
    }
    this.records.set(normalized.approvalId, normalized);
    this.persistRecord(normalized);
    return normalized;
  }

  update(approvalId, patch = {}) {
    const current = this.get(approvalId);
    if (!current) throw new AppError("APPROVAL_NOT_FOUND", "Approval audit record was not found.", 404);
    const normalized = normalizeApprovalRecord({
      ...current,
      ...patch,
      approvalId: current.approvalId,
      idempotencyKey: current.idempotencyKey,
      projectId: current.projectId,
      sourceJobId: current.sourceJobId,
      sourceExportId: current.sourceExportId,
      regenerationPlanId: current.regenerationPlanId,
      draftHash: current.draftHash,
      updatedAt: patch.updatedAt || nowIso(),
    });
    this.records.set(normalized.approvalId, normalized);
    this.persistRecord(normalized);
    return normalized;
  }

  markRenderQueued(approvalId, jobId) {
    return this.update(approvalId, {
      status: "render_queued",
      newRenderJobId: jobId,
      errorCode: null,
    });
  }

  markRenderProcessing(approvalId, jobId) {
    return this.update(approvalId, {
      status: "render_processing",
      newRenderJobId: jobId,
      errorCode: null,
    });
  }

  markRenderCompleted(approvalId, { jobId, exportId } = {}) {
    return this.update(approvalId, {
      status: "render_completed",
      newRenderJobId: jobId,
      completedExportId: exportId,
      errorCode: null,
    });
  }

  markRenderFailed(approvalId, { jobId, errorCode } = {}) {
    return this.update(approvalId, {
      status: "render_failed",
      newRenderJobId: jobId,
      errorCode: normalizeErrorCode(errorCode || "RENDER_FAILED"),
    });
  }

  markRenderCancelled(approvalId, { jobId } = {}) {
    return this.update(approvalId, {
      status: "cancelled",
      newRenderJobId: jobId,
      errorCode: "JOB_CANCELLED",
    });
  }

  get(approvalId) {
    return this.records.get(validateApprovalId(approvalId)) || null;
  }

  getByIdempotencyKey(key) {
    const safeKey = validateIdempotencyKey(key);
    return this.all().find((record) => record.idempotencyKey === safeKey) || null;
  }

  getByRenderJobId(jobId) {
    const safeJobId = validateResourceId(jobId, "job");
    return this.all().find((record) => record.newRenderJobId === safeJobId) || null;
  }

  listForSource(options = {}) {
    const safeProjectId = options.projectId ? validateResourceId(options.projectId, "prj") : null;
    const safeJobId = (options.sourceJobId || options.jobId) ? validateResourceId(options.sourceJobId || options.jobId, "job") : null;
    const safeExportId = (options.sourceExportId || options.exportId) ? validateResourceId(options.sourceExportId || options.exportId, "exp") : null;
    return this.all().filter((record) => {
      if (safeProjectId && record.projectId !== safeProjectId) return false;
      if (safeJobId && record.sourceJobId !== safeJobId) return false;
      if (safeExportId && record.sourceExportId !== safeExportId) return false;
      return true;
    });
  }

  all() {
    return [...this.records.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.approvalId.localeCompare(b.approvalId));
  }

  publicApproval(record) {
    if (!record) return null;
    return jsonClone(normalizeApprovalRecord(record));
  }

  restore() {
    if (!this.persist || !existsSync(this.dir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.dir).sort()) {
      try {
        if (!APPROVAL_RECORD_FILE_RE.test(basename(fileName))) {
          ignored += 1;
          continue;
        }
        const filePath = join(this.dir, fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_APPROVAL_RECORD_BYTES) {
          ignored += 1;
          continue;
        }
        const restored = normalizeApprovalRecord(JSON.parse(readFileSync(filePath, "utf8")));
        this.records.set(restored.approvalId, restored);
        records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  health() {
    return {
      ready: true,
      repository: "regeneration-approvals",
      records: this.records.size,
      persistent: this.persist,
    };
  }
}

module.exports = {
  APPROVAL_AUDIT_SCHEMA_VERSION,
  APPROVAL_STATUSES,
  RegenerationApprovalRepository,
  normalizeApprovalRecord,
  validateApprovalId,
};
