const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { normalizeOwnerId } = require("../auth.cjs");
const { normalizeSmokeSource } = require("../staging-smoke-metadata.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const PROJECT_SCHEMA_VERSION = 2;
const PROJECT_TYPES = Object.freeze(["clip", "narrated_short"]);
const PROJECT_STATUSES = Object.freeze(["draft", "awaiting_approval", "processing", "ready", "failed", "cancelled"]);

function validateArtifactId(value, field) {
  const safe = sanitizeText(value, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function validateHash(value, field) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function normalizeActiveNarration(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeNarration" });
  }
  const projectRevision = Number(value.projectRevision);
  if (!Number.isInteger(projectRevision) || projectRevision < 1 || projectRevision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeNarration.projectRevision" });
  }
  const status = sanitizeText(value.status, 40).toLowerCase();
  if (!["uploaded_unaligned", "aligned"].includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeNarration.status" });
  }
  const media = value.media && typeof value.media === "object" && !Array.isArray(value.media) ? value.media : {};
  const rights = value.rights && typeof value.rights === "object" && !Array.isArray(value.rights) ? value.rights : {};
  const aligned = status === "aligned";
  return {
    status,
    projectRevision,
    manifestArtifactId: validateArtifactId(value.manifestArtifactId, "input.activeNarration.manifestArtifactId"),
    manifestHash: validateHash(value.manifestHash, "input.activeNarration.manifestHash"),
    audioArtifactId: validateArtifactId(value.audioArtifactId, "input.activeNarration.audioArtifactId"),
    audioHash: validateHash(value.audioHash, "input.activeNarration.audioHash"),
    draftArtifactId: validateArtifactId(value.draftArtifactId, "input.activeNarration.draftArtifactId"),
    draftHash: validateHash(value.draftHash, "input.activeNarration.draftHash"),
    scriptHash: validateHash(value.scriptHash, "input.activeNarration.scriptHash"),
    voiceProfileId: sanitizeText(value.voiceProfileId, 80),
    language: sanitizeText(value.language, 12).toLowerCase(),
    media: {
      container: sanitizeText(media.container, 20),
      codec: sanitizeText(media.codec, 40),
      sampleRate: Number(media.sampleRate),
      channels: Number(media.channels),
      durationSeconds: Number(media.durationSeconds),
      bytes: Number(media.bytes),
    },
    rights: {
      commercialUseAllowed: rights.commercialUseAllowed === true,
      ownershipBasis: sanitizeText(rights.ownershipBasis, 40),
      consentDeclared: rights.consentDeclared === true,
      licenseDeclared: rights.licenseDeclared === true,
    },
    alignmentArtifactId: aligned ? validateArtifactId(value.alignmentArtifactId, "input.activeNarration.alignmentArtifactId") : null,
    alignmentHash: aligned ? validateHash(value.alignmentHash, "input.activeNarration.alignmentHash") : null,
    aligned,
    timingReady: aligned,
    renderReady: false,
  };
}

function normalizeActiveAnimationScenePlan(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan" });
  }
  const projectRevision = Number(value.projectRevision);
  const sceneCount = Number(value.sceneCount);
  const fallbackSceneCount = Number(value.fallbackSceneCount);
  if (!Number.isInteger(projectRevision) || projectRevision < 1 || projectRevision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.projectRevision" });
  }
  if (!Number.isInteger(sceneCount) || sceneCount < 1 || sceneCount > 20) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.sceneCount" });
  }
  if (!Number.isInteger(fallbackSceneCount) || fallbackSceneCount < 0 || fallbackSceneCount > sceneCount) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.fallbackSceneCount" });
  }
  const plannerMode = sanitizeText(value.plannerMode, 40).toLowerCase();
  if (!["disabled", "mock", "openai_compatible"].includes(plannerMode)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.plannerMode" });
  }
  const promptProfileId = sanitizeText(value.promptProfileId, 160);
  if (!/^[a-z][a-z0-9_-]{1,159}$/.test(promptProfileId)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.promptProfileId" });
  }
  if (value.status !== "ready" || value.animationProfile !== "semantic-v3") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.activeAnimationScenePlan.status" });
  }
  return {
    status: "ready",
    animationProfile: "semantic-v3",
    projectRevision,
    planArtifactId: validateArtifactId(value.planArtifactId, "input.activeAnimationScenePlan.planArtifactId"),
    planHash: validateHash(value.planHash, "input.activeAnimationScenePlan.planHash"),
    draftArtifactId: validateArtifactId(value.draftArtifactId, "input.activeAnimationScenePlan.draftArtifactId"),
    draftHash: validateHash(value.draftHash, "input.activeAnimationScenePlan.draftHash"),
    alignmentArtifactId: validateArtifactId(value.alignmentArtifactId, "input.activeAnimationScenePlan.alignmentArtifactId"),
    alignmentHash: validateHash(value.alignmentHash, "input.activeAnimationScenePlan.alignmentHash"),
    timingContextHash: validateHash(value.timingContextHash, "input.activeAnimationScenePlan.timingContextHash"),
    semanticEventGraphHash: validateHash(value.semanticEventGraphHash, "input.activeAnimationScenePlan.semanticEventGraphHash"),
    semanticVisualSentencePlanHash: validateHash(value.semanticVisualSentencePlanHash, "input.activeAnimationScenePlan.semanticVisualSentencePlanHash"),
    plannerMode,
    promptProfileId,
    plannerConfigurationHash: validateHash(
      value.plannerConfigurationHash,
      "input.activeAnimationScenePlan.plannerConfigurationHash",
    ),
    sceneCount,
    fallbackSceneCount,
  };
}

function normalizeLastInvalidation(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALIDATION_STATE_INVALID", SAFE_MESSAGES.INVALIDATION_STATE_INVALID, 409);
  const fromRevision = Number(value.fromRevision);
  const toRevision = Number(value.toRevision);
  const changeType = sanitizeText(value.changeType, 24).toLowerCase();
  const requestHash = validateHash(value.requestHash, "input.lastInvalidation.requestHash");
  if (!Number.isInteger(fromRevision) || !Number.isInteger(toRevision) || fromRevision < 1 || toRevision !== fromRevision + 1 || !["content", "style_only"].includes(changeType)) throw new AppError("INVALIDATION_STATE_INVALID", SAFE_MESSAGES.INVALIDATION_STATE_INVALID, 409);
  return {
    artifactId: validateArtifactId(value.artifactId, "input.lastInvalidation.artifactId"),
    contentHash: validateHash(value.contentHash, "input.lastInvalidation.contentHash"),
    requestHash,
    idempotencyKeyHash: value.idempotencyKeyHash ? validateHash(value.idempotencyKeyHash, "input.lastInvalidation.idempotencyKeyHash") : null,
    fromRevision,
    toRevision,
    changeType,
    narrationReused: value.narrationReused === true,
    approvalRequired: true,
  };
}

function normalizeProjectInput(record = {}) {
  const requestedType = sanitizeText(record.projectType || (record.input && record.input.type === "content_brief" ? "narrated_short" : "clip"), 40);
  if (!PROJECT_TYPES.includes(requestedType)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "projectType" });
  }
  if (requestedType === "clip") {
    const uploadId = validateResourceId(record.uploadId || (record.input && record.input.uploadId), "upl");
    return {
      projectType: "clip",
      uploadId,
      input: { type: "upload", uploadId },
    };
  }
  const briefArtifactId = validateArtifactId(record.briefArtifactId || (record.input && record.input.briefArtifactId), "input.briefArtifactId");
  const revision = Number(record.revision ?? (record.input && record.input.revision) ?? 1);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "input.revision" });
  }
  const lastInvalidation = normalizeLastInvalidation(record.lastInvalidation || (record.input && record.input.lastInvalidation) || null);
  if (lastInvalidation && lastInvalidation.toRevision !== revision) {
    throw new AppError("INVALIDATION_STATE_INVALID", SAFE_MESSAGES.INVALIDATION_STATE_INVALID, 409, { field: "input.lastInvalidation.toRevision" });
  }
  return {
    projectType: "narrated_short",
    uploadId: null,
    input: {
      type: "content_brief",
      briefArtifactId,
      revision,
      claimLedgerArtifactId: record.claimLedgerArtifactId || (record.input && record.input.claimLedgerArtifactId)
        ? validateArtifactId(record.claimLedgerArtifactId || record.input.claimLedgerArtifactId, "input.claimLedgerArtifactId")
        : null,
      scriptArtifactId: record.scriptArtifactId || (record.input && record.input.scriptArtifactId)
        ? validateArtifactId(record.scriptArtifactId || record.input.scriptArtifactId, "input.scriptArtifactId")
        : null,
      storyboardArtifactId: record.storyboardArtifactId || (record.input && record.input.storyboardArtifactId)
        ? validateArtifactId(record.storyboardArtifactId || record.input.storyboardArtifactId, "input.storyboardArtifactId")
        : null,
      activeNarration: normalizeActiveNarration(record.activeNarration || (record.input && record.input.activeNarration) || null),
      activeAnimationScenePlan: normalizeActiveAnimationScenePlan(
        record.activeAnimationScenePlan
          || (record.input && record.input.activeAnimationScenePlan)
          || null,
      ),
      lastInvalidation,
    },
  };
}

function normalizeProject(record = {}) {
  const id = validateResourceId(record.id, "prj");
  const inputRecord = record.inputJson && typeof record.inputJson === "string"
    ? (() => { try { return JSON.parse(record.inputJson); } catch { return null; } })()
    : record.input;
  const input = normalizeProjectInput({ ...record, input: inputRecord });
  const status = sanitizeText(record.status || "draft", 40);
  if (!PROJECT_STATUSES.includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const createdAt = record.createdAt || nowIso();
  const language = input.projectType === "narrated_short" ? sanitizeText(record.language || "en", 12).toLowerCase() : null;
  if (language && !["el", "en"].includes(language)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "language" });
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    projectType: input.projectType,
    uploadId: input.uploadId,
    input: input.input,
    title: sanitizeText(record.title || "ShortsEngine Short", 120),
    language,
    status,
    ownerId: record.ownerId ? normalizeOwnerId(record.ownerId) : null,
    source: normalizeSmokeSource(record.source),
    createdAt,
    updatedAt: record.updatedAt || createdAt,
  };
}

function projectSnapshotToken(project) {
  return JSON.stringify(normalizeProject(project));
}

function projectSnapshotsEqual(left, right) {
  return projectSnapshotToken(left) === projectSnapshotToken(right);
}

class InMemoryProjectRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
  }

  create(record) {
    const project = normalizeProject(record);
    this.records.set(project.id, project);
    return project;
  }

  save(record) {
    return this.create(record);
  }

  get(projectId) {
    return this.records.get(validateResourceId(projectId, "prj")) || null;
  }

  update(projectId, patch = {}) {
    const current = this.get(projectId);
    if (!current) {
      throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
    }
    const next = normalizeProject({ ...current, ...patch, id: current.id, updatedAt: nowIso() });
    this.records.set(next.id, next);
    Object.assign(current, next);
    return current;
  }

  compareAndSwap(projectId, expectedProject, patch = {}) {
    const current = this.get(projectId);
    if (!current || !projectSnapshotsEqual(current, expectedProject)) {
      return null;
    }
    return this.update(projectId, patch);
  }

  delete(projectId) {
    return this.records.delete(validateResourceId(projectId, "prj"));
  }

  all() {
    return [...this.records.values()];
  }

  publicProject(project) {
    return project ? jsonClone(normalizeProject(project)) : null;
  }

  health() {
    const statuses = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, 0]));
    for (const project of this.records.values()) {
      statuses[project.status] = (statuses[project.status] || 0) + 1;
    }
    return {
      ready: true,
      total: this.records.size,
      statuses,
    };
  }
}

module.exports = {
  InMemoryProjectRepository,
  PROJECT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  normalizeProject,
  normalizeActiveNarration,
  normalizeActiveAnimationScenePlan,
  normalizeLastInvalidation,
  projectSnapshotToken,
  projectSnapshotsEqual,
};
