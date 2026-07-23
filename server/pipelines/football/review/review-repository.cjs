const { createHash, randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { CONFIG } = require("../../../config.cjs");
const { normalizeOwnerId } = require("../../../auth.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { assertCandidateSet, normalizeCandidate, validateCandidateId } = require("./candidate-contract.cjs");

const FOOTBALL_REVIEW_SCHEMA_VERSION = 1;
const REVIEW_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "regeneration_requested",
  "render_queued",
  "render_processing",
  "render_completed",
  "render_failed",
  "cancelled",
]);
const DECISION_ACTIONS = Object.freeze(["select", "reject_all", "regenerate"]);
const REVIEW_ID_RE = /^fbr_[a-f0-9-]{36}$/;
const REVIEW_FILE_RE = /^fbr_[a-f0-9-]{36}\.json$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,160}$/;
const MAX_REVIEW_FILE_BYTES = 512 * 1024;

function reviewDir() {
  return CONFIG.footballReviewDir || join(CONFIG.dataDir, "football-reviews");
}

function validateReviewId(value) {
  const safe = sanitizeText(value, 80);
  if (!REVIEW_ID_RE.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateVersion(value, field = "expectedVersion") {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return version;
}

function validateSourceRevision(value) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "sourceRevision" });
  }
  return safe;
}

function validateIdempotencyKey(value) {
  const safe = sanitizeText(value, 160);
  if (!IDEMPOTENCY_KEY_RE.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "idempotencyKey" });
  }
  return safe;
}

function boundedNote(value) {
  const raw = String(value || "");
  if (raw.length > 280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "note" });
  }
  return sanitizeText(raw, 280);
}

function requestHash(input = {}) {
  return createHash("sha256").update(JSON.stringify({
    action: input.action,
    candidateId: input.candidateId || null,
    expectedVersion: Number(input.expectedVersion),
    expectedSourceRevision: input.expectedSourceRevision,
    note: input.note || "",
  })).digest("hex");
}

function normalizeAuditEvent(event = {}) {
  return {
    sequence: Math.max(1, Math.floor(Number(event.sequence || 1))),
    type: sanitizeText(event.type || "review_created", 64),
    at: sanitizeText(event.at || nowIso(), 40),
    actorId: event.actorId ? normalizeOwnerId(event.actorId) : null,
    fromStatus: event.fromStatus ? sanitizeText(event.fromStatus, 40) : null,
    toStatus: sanitizeText(event.toStatus || "pending", 40),
    version: validateVersion(event.version || 1, "audit.version"),
    candidateId: event.candidateId ? validateCandidateId(event.candidateId) : null,
    renderJobId: event.renderJobId ? validateResourceId(event.renderJobId, "job") : null,
    reasonCode: event.reasonCode ? sanitizeText(event.reasonCode, 80) : null,
  };
}

function normalizeReview(record = {}) {
  const projectId = validateResourceId(record.projectId, "prj");
  const sourceJobId = validateResourceId(record.sourceJobId, "job");
  const sourceUploadId = validateResourceId(record.sourceUploadId, "upl");
  const sourceRevision = validateSourceRevision(record.sourceRevision);
  const projectRevision = validateVersion(record.projectRevision || 1, "projectRevision");
  const version = validateVersion(record.version || 1, "version");
  const status = sanitizeText(record.status || "pending", 40);
  if (!REVIEW_STATUSES.includes(status)) {
    throw new AppError("FOOTBALL_REVIEW_STATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_STATE_INVALID, 409);
  }
  const candidates = assertCandidateSet((Array.isArray(record.candidates) ? record.candidates : []).map((candidate) => normalizeCandidate(candidate, {
    projectId,
    sourceJobId,
    sourceRevision,
    sourceDurationSeconds: Math.max(Number(candidate.sourceEnd || 0) + 1, 1),
  })));
  const selectedCandidateId = record.selectedCandidateId ? validateCandidateId(record.selectedCandidateId) : null;
  if (selectedCandidateId && !candidates.some((candidate) => candidate.id === selectedCandidateId)) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400);
  }
  const id = record.id ? validateReviewId(record.id) : `fbr_${randomUUID()}`;
  const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
  return {
    schemaVersion: FOOTBALL_REVIEW_SCHEMA_VERSION,
    id,
    projectId,
    ownerId: normalizeOwnerId(record.ownerId),
    sourceJobId,
    sourceUploadId,
    sourceRevision,
    projectRevision,
    version,
    status,
    candidates,
    selectedCandidateId,
    decision: record.decision ? sanitizeText(record.decision, 40) : null,
    note: boundedNote(record.note),
    reviewerId: record.reviewerId ? normalizeOwnerId(record.reviewerId) : null,
    reviewedAt: record.reviewedAt ? sanitizeText(record.reviewedAt, 40) : null,
    renderJobId: record.renderJobId ? validateResourceId(record.renderJobId, "job") : null,
    regenerationJobId: record.regenerationJobId ? validateResourceId(record.regenerationJobId, "job") : null,
    rightsConfirmed: record.rightsConfirmed === true,
    decisionIdempotencyKey: record.decisionIdempotencyKey ? validateIdempotencyKey(record.decisionIdempotencyKey) : null,
    decisionRequestHash: record.decisionRequestHash ? validateSourceRevision(record.decisionRequestHash) : null,
    createdAt,
    updatedAt: sanitizeText(record.updatedAt || createdAt, 40),
    audit: (Array.isArray(record.audit) ? record.audit : []).slice(0, 100).map(normalizeAuditEvent),
  };
}

function writeJsonAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function sourceKey(record) {
  return `${record.projectId}|${record.sourceJobId}|${record.sourceRevision}`;
}

class FootballReviewRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.idempotency = options.idempotency || new Map();
    this.persist = options.persist !== false;
    this.dir = options.dir || reviewDir();
    if (this.persist) mkdirSync(this.dir, { recursive: true });
  }

  persistRecord(record) {
    if (!this.persist) return;
    writeJsonAtomic(join(this.dir, `${validateReviewId(record.id)}.json`), record);
  }

  create(input = {}) {
    const normalized = normalizeReview({
      ...input,
      version: 1,
      status: "pending",
      selectedCandidateId: null,
      decision: null,
      reviewerId: null,
      reviewedAt: null,
      renderJobId: null,
      regenerationJobId: null,
      decisionIdempotencyKey: null,
      decisionRequestHash: null,
      audit: [{
        sequence: 1,
        type: "review_created",
        at: input.createdAt || nowIso(),
        actorId: input.ownerId,
        fromStatus: null,
        toStatus: "pending",
        version: 1,
      }],
    });
    const existing = this.all().find((record) => sourceKey(record) === sourceKey(normalized));
    if (existing) return existing;
    this.records.set(normalized.id, normalized);
    this.persistRecord(normalized);
    return normalized;
  }

  get(reviewId) {
    return this.records.get(validateReviewId(reviewId)) || null;
  }

  latestForProject(projectId) {
    const safeProjectId = validateResourceId(projectId, "prj");
    return this.all()
      .filter((record) => record.projectId === safeProjectId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.version - a.version)[0] || null;
  }

  getForSource({ projectId, sourceJobId, sourceRevision } = {}) {
    const key = `${validateResourceId(projectId, "prj")}|${validateResourceId(sourceJobId, "job")}|${validateSourceRevision(sourceRevision)}`;
    return this.all().find((record) => sourceKey(record) === key) || null;
  }

  assertCurrent(record, input = {}) {
    const expectedVersion = validateVersion(input.expectedVersion);
    const expectedSourceRevision = validateSourceRevision(input.expectedSourceRevision);
    if (record.version !== expectedVersion || record.sourceRevision !== expectedSourceRevision) {
      throw new AppError("FOOTBALL_REVIEW_STALE", SAFE_MESSAGES.FOOTBALL_REVIEW_STALE, 409, {
        expectedVersion,
        currentVersion: record.version,
      });
    }
  }

  replayFor(record, input) {
    const key = validateIdempotencyKey(input.idempotencyKey);
    const priorId = this.idempotency.get(key);
    if (!priorId) return null;
    const prior = this.get(priorId);
    if (!prior || prior.id !== record.id || prior.decisionRequestHash !== requestHash(input)) {
      throw new AppError("FOOTBALL_REVIEW_CONFLICT", SAFE_MESSAGES.FOOTBALL_REVIEW_CONFLICT, 409);
    }
    return prior;
  }

  decide(reviewId, input = {}) {
    const current = this.get(reviewId);
    if (!current) throw new AppError("FOOTBALL_REVIEW_NOT_FOUND", SAFE_MESSAGES.FOOTBALL_REVIEW_NOT_FOUND, 404);
    const replay = this.replayFor(current, input);
    if (replay) return { record: replay, replayed: true };
    this.assertCurrent(current, input);
    if (current.status !== "pending") {
      throw new AppError("FOOTBALL_REVIEW_ALREADY_DECIDED", SAFE_MESSAGES.FOOTBALL_REVIEW_ALREADY_DECIDED, 409, {
        currentVersion: current.version,
      });
    }
    const action = sanitizeText(input.action, 40);
    if (!DECISION_ACTIONS.includes(action)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "action" });
    }
    const candidateId = action === "select" ? validateCandidateId(input.candidateId) : null;
    if (candidateId && !current.candidates.some((candidate) => candidate.id === candidateId)) {
      throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400);
    }
    const reviewerId = normalizeOwnerId(input.reviewerId);
    if (reviewerId !== current.ownerId) {
      throw new AppError("FORBIDDEN", SAFE_MESSAGES.FORBIDDEN, 403);
    }
    const now = sanitizeText(input.now || nowIso(), 40);
    const nextStatus = action === "select" ? "approved" : action === "reject_all" ? "rejected" : "regeneration_requested";
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const next = normalizeReview({
      ...current,
      version: current.version + 1,
      status: nextStatus,
      decision: action,
      selectedCandidateId: candidateId,
      note: boundedNote(input.note),
      reviewerId,
      reviewedAt: now,
      decisionIdempotencyKey: idempotencyKey,
      decisionRequestHash: requestHash(input),
      updatedAt: now,
      audit: [...current.audit, {
        sequence: current.audit.length + 1,
        type: action === "select" ? "candidate_selected" : action === "reject_all" ? "candidates_rejected" : "regeneration_requested",
        at: now,
        actorId: reviewerId,
        fromStatus: current.status,
        toStatus: nextStatus,
        version: current.version + 1,
        candidateId,
      }],
    });
    this.records.set(next.id, next);
    this.idempotency.set(idempotencyKey, next.id);
    this.persistRecord(next);
    return { record: next, replayed: false };
  }

  markJob(reviewId, input = {}) {
    const current = this.get(reviewId);
    if (!current) throw new AppError("FOOTBALL_REVIEW_NOT_FOUND", SAFE_MESSAGES.FOOTBALL_REVIEW_NOT_FOUND, 404);
    const kind = input.kind === "regeneration" ? "regeneration" : "render";
    const jobId = validateResourceId(input.jobId, "job");
    const nextStatus = kind === "regeneration" ? "regeneration_requested" : sanitizeText(input.status || "render_queued", 40);
    if (!REVIEW_STATUSES.includes(nextStatus)) {
      throw new AppError("FOOTBALL_REVIEW_STATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_STATE_INVALID, 409);
    }
    const now = sanitizeText(input.now || nowIso(), 40);
    const next = normalizeReview({
      ...current,
      version: current.version + 1,
      status: nextStatus,
      renderJobId: kind === "render" ? jobId : current.renderJobId,
      regenerationJobId: kind === "regeneration" ? jobId : current.regenerationJobId,
      updatedAt: now,
      audit: [...current.audit, {
        sequence: current.audit.length + 1,
        type: kind === "render" ? nextStatus : "regeneration_job_queued",
        at: now,
        actorId: input.actorId || current.reviewerId,
        fromStatus: current.status,
        toStatus: nextStatus,
        version: current.version + 1,
        candidateId: current.selectedCandidateId,
        renderJobId: jobId,
        reasonCode: input.reasonCode,
      }],
    });
    this.records.set(next.id, next);
    this.persistRecord(next);
    return next;
  }

  selectedCandidate(record) {
    const current = typeof record === "string" ? this.get(record) : record;
    if (!current || !current.selectedCandidateId) return null;
    return current.candidates.find((candidate) => candidate.id === current.selectedCandidateId) || null;
  }

  publicReview(record, candidateOptions = new Map()) {
    if (!record) return null;
    const { publicCandidate } = require("./candidate-contract.cjs");
    return {
      schemaVersion: record.schemaVersion,
      id: record.id,
      projectId: record.projectId,
      sourceJobId: record.sourceJobId,
      sourceRevision: record.sourceRevision,
      projectRevision: record.projectRevision,
      version: record.version,
      status: record.status,
      candidateCount: record.candidates.length,
      candidates: record.candidates.map((candidate) => publicCandidate(candidate, candidateOptions.get(candidate.id) || {})),
      selectedCandidateId: record.selectedCandidateId,
      decision: record.decision,
      note: record.note || null,
      reviewedAt: record.reviewedAt,
      renderJobId: record.renderJobId,
      regenerationJobId: record.regenerationJobId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      alreadyReviewed: record.status !== "pending",
      nextAction: record.status === "pending"
        ? "select-reject-or-regenerate"
        : record.status === "render_queued" || record.status === "render_processing"
          ? "wait-for-render"
          : null,
    };
  }

  all() {
    return [...this.records.values()];
  }

  restore() {
    if (!this.persist || !existsSync(this.dir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.dir).sort()) {
      try {
        if (!REVIEW_FILE_RE.test(basename(fileName))) {
          ignored += 1;
          continue;
        }
        const filePath = join(this.dir, fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REVIEW_FILE_BYTES) {
          ignored += 1;
          continue;
        }
        const restored = normalizeReview(JSON.parse(readFileSync(filePath, "utf8")));
        this.records.set(restored.id, restored);
        if (restored.decisionIdempotencyKey) this.idempotency.set(restored.decisionIdempotencyKey, restored.id);
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
      repository: "football-reviews",
      persistent: this.persist,
      records: this.records.size,
      pending: this.all().filter((record) => record.status === "pending").length,
    };
  }
}

module.exports = {
  DECISION_ACTIONS,
  FOOTBALL_REVIEW_SCHEMA_VERSION,
  FootballReviewRepository,
  REVIEW_STATUSES,
  normalizeReview,
  validateReviewId,
};
