const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const DRAFT_AUDIT_SCHEMA_VERSION = 1;
const DRAFT_RECORD_FILE_RE = /^rdft_[a-f0-9]{32}\.json$/;
const DRAFT_HASH_RE = /^[a-f0-9]{16,64}$/;
const DRAFT_STATUSES = Object.freeze(["draft", "not_needed"]);
const DRAFT_VALIDATION_STATUSES = Object.freeze(["valid", "blocked", "not_needed"]);
const MAX_DRAFT_RECORD_BYTES = 96 * 1024;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function draftRecordIdFor(input = {}) {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
  return `rdft_${hash}`;
}

function writeDraftJsonAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function validateDraftRecordId(value) {
  const safe = sanitizeText(value, 80);
  if (!/^rdft_[a-f0-9]{32}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateDraftHash(value) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!DRAFT_HASH_RE.test(safe)) {
    throw new AppError("VALIDATION_ERROR", "Draft hash is invalid.", 400, { field: "draftHash" });
  }
  return safe;
}

function normalizeDraftStatus(value) {
  const safe = sanitizeText(value || "draft", 40);
  if (!DRAFT_STATUSES.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "status" });
  }
  return safe;
}

function normalizeValidationStatus(value) {
  const safe = sanitizeText(value || "valid", 40);
  if (!DRAFT_VALIDATION_STATUSES.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "validationStatus" });
  }
  return safe;
}

function safeTokenList(values, maxItems = 20, maxLength = 100) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, maxLength))
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value)))]
    .slice(0, maxItems);
}

function safeSafetyChecks(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, 12)
    .map((check) => ({
      code: sanitizeText(check && check.code, 80),
      status: sanitizeText(check && check.status, 40),
    }))
    .filter((check) => /^[A-Z0-9_:-]{2,80}$/.test(check.code) && ["passed", "blocked", "failed", "warning"].includes(check.status));
}

function summarizeEditPlan(plan = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const sourceStart = Number(plan.sourceStart);
  const sourceEnd = Number(plan.sourceEnd);
  const captionCount = Number(plan.captionCount);
  const animationCueCount = Number(plan.animationCueCount);
  const effectCount = Number(plan.effectCount);
  return {
    aspectRatio: sanitizeText(plan.aspectRatio || "", 20),
    highlightType: sanitizeText(plan.highlightType || "", 80),
    framingMode: sanitizeText(plan.framingMode || "", 80),
    stylePreset: sanitizeText(plan.stylePreset || "", 80),
    styleTarget: sanitizeText(plan.styleTarget || "", 80),
    editIntensity: sanitizeText(plan.editIntensity || "", 80),
    sourceStart: Number.isFinite(sourceStart) ? Number(sourceStart.toFixed(2)) : null,
    sourceEnd: Number.isFinite(sourceEnd) ? Number(sourceEnd.toFixed(2)) : null,
    captionCount: Number.isFinite(captionCount) ? Math.max(0, Math.floor(captionCount)) : Array.isArray(plan.captions) ? plan.captions.length : 0,
    animationCueCount: Number.isFinite(animationCueCount) ? Math.max(0, Math.floor(animationCueCount)) : Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
    effectCount: Number.isFinite(effectCount) ? Math.max(0, Math.floor(effectCount)) : Array.isArray(plan.effects) ? plan.effects.length : 0,
  };
}

function sourceKey(record = {}) {
  return [
    record.projectId,
    record.sourceJobId,
    record.sourceExportId,
    record.regenerationPlanId,
  ].join("|");
}

function normalizeDraftRecord(record = {}, existingVersion = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const projectId = validateResourceId(record.projectId || record.sourceProjectId, "prj");
  const sourceJobId = validateResourceId(record.sourceJobId || record.jobId, "job");
  const sourceExportId = validateResourceId(record.sourceExportId || record.exportId, "exp");
  const regenerationPlanId = validateResourceId(record.regenerationPlanId, "regen");
  const draftHash = validateDraftHash(record.draftHash);
  const status = normalizeDraftStatus(record.status);
  const validationStatus = normalizeValidationStatus(
    record.validationStatus ||
      (status === "not_needed" ? "not_needed" : Array.isArray(record.blockingReasonCodes) && record.blockingReasonCodes.length ? "blocked" : "valid"),
  );
  const id = record.id
    ? validateDraftRecordId(record.id)
    : draftRecordIdFor({ projectId, sourceJobId, sourceExportId, regenerationPlanId, draftHash });
  const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
  return {
    schemaVersion: DRAFT_AUDIT_SCHEMA_VERSION,
    id,
    regenerationPlanId,
    version: Math.max(1, Math.floor(Number(existingVersion || record.version || 1))),
    draftHash,
    projectId,
    sourceJobId,
    sourceExportId,
    status,
    validationStatus,
    proposedEditPlanSummary: summarizeEditPlan(record.proposedEditPlanSummary || record.proposedEditPlan),
    appliedSuggestionIds: safeTokenList(record.appliedSuggestionIds, 24),
    skippedSuggestionIds: safeTokenList(record.skippedSuggestionIds, 24),
    proposedChanges: safeTokenList(record.proposedChanges, 16),
    blockingReasonCodes: safeTokenList(record.blockingReasonCodes, 16),
    safetyChecks: safeSafetyChecks(record.safetyChecks),
    createdAt,
    updatedAt: sanitizeText(record.updatedAt || createdAt, 40),
  };
}

function recordFromPlan(plan = {}, options = {}) {
  const blockingReasonCodes = (Array.isArray(plan.blockingReasons) ? plan.blockingReasons : [])
    .map((reason) => reason && reason.code)
    .filter(Boolean);
  return {
    projectId: plan.projectId || options.projectId,
    sourceJobId: plan.jobId || options.sourceJobId,
    sourceExportId: plan.exportId || options.sourceExportId,
    regenerationPlanId: plan.regenerationPlanId,
    draftHash: plan.draftHash,
    status: plan.status,
    validationStatus: plan.status === "not_needed"
      ? "not_needed"
      : blockingReasonCodes.length || (Array.isArray(plan.safetyChecks) && plan.safetyChecks.some((check) => check.status !== "passed"))
        ? "blocked"
        : "valid",
    proposedEditPlan: plan.proposedEditPlan,
    appliedSuggestionIds: plan.appliedSuggestionIds,
    skippedSuggestionIds: plan.skippedSuggestionIds,
    proposedChanges: plan.proposedChanges,
    blockingReasonCodes,
    safetyChecks: plan.safetyChecks,
    createdAt: options.createdAt || plan.createdAt,
  };
}

class RegenerationDraftRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.persist = options.persist !== false;
    this.dir = options.dir || CONFIG.reviewDraftDir;
    if (this.persist) mkdirSync(this.dir, { recursive: true });
  }

  persistRecord(record) {
    if (!this.persist) return;
    writeDraftJsonAtomic(join(this.dir, `${validateDraftRecordId(record.id)}.json`), record);
  }

  nextVersionFor(record) {
    const sameSource = this.listForSource(record).filter((item) => item.regenerationPlanId === record.regenerationPlanId);
    const existingHash = sameSource.find((item) => item.draftHash === record.draftHash);
    if (existingHash) return existingHash.version;
    return sameSource.reduce((max, item) => Math.max(max, Number(item.version || 0)), 0) + 1;
  }

  create(record) {
    const base = normalizeDraftRecord(record);
    const existing = this.records.get(base.id);
    if (existing) return existing;
    const requestedVersion = Number(record && record.version);
    const version = Number.isFinite(requestedVersion) && requestedVersion >= 1
      ? Math.floor(requestedVersion)
      : this.nextVersionFor(base);
    const normalized = normalizeDraftRecord({ ...base, version });
    this.records.set(normalized.id, normalized);
    this.persistRecord(normalized);
    return normalized;
  }

  createFromPlan(plan, options = {}) {
    return this.create(recordFromPlan(plan, options));
  }

  get(draftRecordId) {
    return this.records.get(validateDraftRecordId(draftRecordId)) || null;
  }

  getByPlanHash({ regenerationPlanId, draftHash, projectId, sourceJobId, sourceExportId } = {}) {
    const safePlanId = validateResourceId(regenerationPlanId, "regen");
    const safeHash = validateDraftHash(draftHash);
    const safeProjectId = projectId ? validateResourceId(projectId, "prj") : null;
    const safeJobId = sourceJobId ? validateResourceId(sourceJobId, "job") : null;
    const safeExportId = sourceExportId ? validateResourceId(sourceExportId, "exp") : null;
    return this.all().find((record) => (
      record.regenerationPlanId === safePlanId &&
      record.draftHash === safeHash &&
      (!safeProjectId || record.projectId === safeProjectId) &&
      (!safeJobId || record.sourceJobId === safeJobId) &&
      (!safeExportId || record.sourceExportId === safeExportId)
    )) || null;
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
    return [...this.records.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)) || a.version - b.version);
  }

  publicDraft(record) {
    if (!record) return null;
    return jsonClone(normalizeDraftRecord(record));
  }

  restore() {
    if (!this.persist || !existsSync(this.dir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.dir).sort()) {
      try {
        if (!DRAFT_RECORD_FILE_RE.test(basename(fileName))) {
          ignored += 1;
          continue;
        }
        const filePath = join(this.dir, fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_DRAFT_RECORD_BYTES) {
          ignored += 1;
          continue;
        }
        const restored = normalizeDraftRecord(JSON.parse(readFileSync(filePath, "utf8")));
        this.records.set(restored.id, restored);
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
      repository: "regeneration-drafts",
      records: this.records.size,
      persistent: this.persist,
    };
  }
}

module.exports = {
  DRAFT_AUDIT_SCHEMA_VERSION,
  RegenerationDraftRepository,
  draftRecordIdFor,
  normalizeDraftRecord,
  summarizeEditPlan,
};
