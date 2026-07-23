const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { normalizeOwnerId } = require("./auth.cjs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { publicHumanReviewGate } = require("./human-review-gate.cjs");
const { normalizeNarratedJobPayload, pipelineTypeForAction } = require("./pipelines/pipeline-registry.cjs");
const { normalizeSmokeSource } = require("./staging-smoke-metadata.cjs");
const { idempotencyKey } = require("./shared/core/idempotency.cjs");

function nowIso() {
  return new Date().toISOString();
}

const JOB_STATUSES = Object.freeze(["queued", "processing", "completed", "failed", "cancelled"]);
const ACTIVE_JOB_STATUSES = Object.freeze(["queued", "processing"]);
const TERMINAL_JOB_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
const JOB_STYLE_TARGETS = Object.freeze(["auto", "vertical_9_16", "square_1_1"]);
const JOB_STYLE_ALIASES = Object.freeze({
  shorts: "vertical_9_16",
  square: "square_1_1",
  vertical: "vertical_9_16",
});
const JOB_EDIT_INTENSITIES = Object.freeze(["clean", "balanced", "punchy"]);
const JOB_RENDER_STYLE_PRESETS = Object.freeze(["clean_sports", "social_sports_v1", "punchy_highlight", "reference_football_multi_goal_v1"]);
const JOB_GOAL_SELECTION_MODES = Object.freeze(["balanced", "valid_goals_only"]);
const JOB_COMPOSITION_MODES = Object.freeze(["auto", "single_moment", "multi_moment"]);

const DEFAULT_RECOVERY_POLICY = Object.freeze({
  maxAttempts: 2,
  staleProcessingMs: 5 * 60 * 1000,
  leaseDurationMs: 5 * 60 * 1000,
});

const ALLOWED_TRANSITIONS = Object.freeze({
  queued: new Set(["queued", "processing", "failed", "cancelled"]),
  processing: new Set(["queued", "processing", "completed", "failed", "cancelled"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
});

const TERMINAL_MUTATION_ALLOWLIST = Object.freeze(["status"]);

function clampProgress(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) {
    throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409, { progress });
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function assertTransition(fromStatus, toStatus) {
  if (!JOB_STATUSES.includes(toStatus) || !ALLOWED_TRANSITIONS[fromStatus]?.has(toStatus)) {
    throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409, {
      fromStatus,
      toStatus,
    });
  }
}

function assertTerminalMutationAllowed(job, patch) {
  if (!TERMINAL_JOB_STATUSES.includes(job.status)) return;
  const keys = Object.keys(patch);
  const allowed =
    keys.length === 1 &&
    TERMINAL_MUTATION_ALLOWLIST.includes(keys[0]) &&
    patch.status === job.status;
  if (!allowed) {
    throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409, {
      fromStatus: job.status,
      attemptedFields: keys,
    });
  }
}

function sanitizeText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isInside(baseDir, candidatePath) {
  const base = resolve(baseDir);
  const target = resolve(candidatePath);
  const pathFromBase = relative(base, target);
  return pathFromBase === "" || (!pathFromBase.startsWith("..") && !isAbsolute(pathFromBase));
}

function validateJobId(jobId) {
  const safe = String(jobId || "");
  if (!/^job_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateWorkerId(workerId) {
  const safe = sanitizeText(workerId, 100);
  if (!/^wrk_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateLeaseId(leaseId) {
  const safe = sanitizeText(leaseId, 100);
  if (!/^lease_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateLeaseDurationMs(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 1000 || duration > 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(duration);
}

function validateOptionalBackoffMs(value) {
  if (value === null || value === undefined) return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0 || duration > 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(duration);
}

function validateOptionalIsoTime(value) {
  if (!value) return null;
  const safe = sanitizeText(value, 40);
  if (!Number.isFinite(Date.parse(safe))) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validatePersistedFileName(fileName) {
  const safe = basename(fileName || "");
  if (!/^job_[A-Za-z0-9-]{8,80}\.json$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateRouteLikeId(value, prefix) {
  const safe = sanitizeText(value, 100);
  if (!safe || !new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateOptionalStoragePath(value, area) {
  if (!value) return null;
  const target = resolve(String(value));
  const base = resolve(CONFIG[`${area}Dir`]);
  if (!isInside(base, target)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return target;
}

function jsonClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function safePayloadObject(value, maxBytes = 30000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cloned = jsonClone(value);
  const byteLength = Buffer.byteLength(JSON.stringify(cloned), "utf8");
  if (byteLength <= 0 || byteLength > maxBytes) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return cloned;
}

function publicJsonClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(redactForLogs(value)));
}

function restoreSafeEditPlanMetadata(publicJob, sourceJob) {
  if (!publicJob || !sourceJob || !sourceJob.editPlan || typeof sourceJob.editPlan !== "object") return publicJob;
  const publicPlan = publicJob.editPlan && typeof publicJob.editPlan === "object" ? publicJob.editPlan : {};
  for (const key of ["visualPolishQA", "renderPolishQA", "editAssembly"]) {
    if (sourceJob.editPlan[key] && typeof sourceJob.editPlan[key] === "object") {
      publicPlan[key] = key === "renderPolishQA"
        ? publicRenderPolishQaSummary(sourceJob.editPlan[key])
        : publicJsonClone(sourceJob.editPlan[key]);
    }
  }
  publicJob.editPlan = publicPlan;
  return publicJob;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;
}

function safeStringList(values, limit = 10, maxLength = 80) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeContentDraftSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactId = sanitizeText(value.artifactId, 100);
  const contentHash = sanitizeText(value.contentHash, 80).toLowerCase();
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(artifactId) || !/^[a-f0-9]{64}$/.test(contentHash)) return null;
  return {
    artifactId,
    contentHash,
    projectRevision: Math.max(1, Math.floor(Number(value.projectRevision || 1))),
    formatId: sanitizeText(value.formatId, 80),
    sceneCount: Math.max(0, Math.floor(Number(value.sceneCount || 0))),
    beatCount: Math.max(0, Math.floor(Number(value.beatCount || 0))),
    approvalRequired: value.approvalRequired === true,
  };
}

function normalizeNarratedRenderSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactIds = [value.manifestArtifactId, value.timelineArtifactId].map((item) => sanitizeText(item, 100));
  const hashes = [value.manifestHash, value.timelineHash].map((item) => sanitizeText(item, 80).toLowerCase());
  if (artifactIds.some((item) => !/^art_[A-Za-z0-9-]{8,80}$/.test(item)) || hashes.some((item) => !/^[a-f0-9]{64}$/.test(item))) return null;
  const optionalArtifact = (artifactValue, hashValue) => {
    const artifactId = sanitizeText(artifactValue || "", 100);
    const contentHash = sanitizeText(hashValue || "", 80).toLowerCase();
    if (!artifactId && !contentHash) return { artifactId: null, contentHash: null };
    if (!/^art_[A-Za-z0-9-]{8,80}$/.test(artifactId) || !/^[a-f0-9]{64}$/.test(contentHash)) return null;
    return { artifactId, contentHash };
  };
  const captionManifest = optionalArtifact(value.captionManifestArtifactId, value.captionManifestHash);
  const captionAss = optionalArtifact(value.captionAssArtifactId, value.captionAssHash);
  const audioNormalization = optionalArtifact(value.audioNormalizationReportArtifactId, value.audioNormalizationReportHash);
  const qaReport = optionalArtifact(value.qaReportArtifactId, value.qaReportHash);
  const contactSheet = optionalArtifact(value.contactSheetArtifactId, value.contactSheetHash);
  const rightsManifest = optionalArtifact(value.rightsManifestArtifactId, value.rightsManifestHash);
  const provenanceReport = optionalArtifact(value.provenanceReportArtifactId, value.provenanceReportHash);
  const exportMetadata = optionalArtifact(value.exportMetadataArtifactId, value.exportMetadataHash);
  if (!captionManifest || !captionAss || !audioNormalization || !qaReport || !contactSheet || !rightsManifest || !provenanceReport || !exportMetadata) return null;
  return {
    manifestArtifactId: artifactIds[0],
    manifestHash: hashes[0],
    timelineArtifactId: artifactIds[1],
    timelineHash: hashes[1],
    renderProfile: sanitizeText(value.renderProfile || "preview", 24),
    silentPreview: value.silentPreview === true,
    previewOnly: value.previewOnly === true,
    publishable: value.publishable === true,
    narrationStatus: sanitizeText(value.narrationStatus || "not_uploaded", 40),
    narrationUsed: value.narrationUsed === true,
    narrationTimingUsed: value.narrationTimingUsed === true,
    audioIncluded: value.audioIncluded === true,
    captionsIncluded: value.captionsIncluded === true,
    captionsBurned: value.captionsBurned === true,
    audioNormalized: value.audioNormalized === true,
    captionManifestArtifactId: captionManifest.artifactId,
    captionManifestHash: captionManifest.contentHash,
    captionAssArtifactId: captionAss.artifactId,
    captionAssHash: captionAss.contentHash,
    audioNormalizationReportArtifactId: audioNormalization.artifactId,
    audioNormalizationReportHash: audioNormalization.contentHash,
    qaStatus: sanitizeText(value.qaStatus || "not_run", 20),
    qaPassed: value.qaPassed === true,
    qaReportArtifactId: qaReport.artifactId,
    qaReportHash: qaReport.contentHash,
    packageStatus: sanitizeText(value.packageStatus || "not_required", 20),
    contactSheetArtifactId: contactSheet.artifactId,
    contactSheetHash: contactSheet.contentHash,
    rightsManifestArtifactId: rightsManifest.artifactId,
    rightsManifestHash: rightsManifest.contentHash,
    provenanceReportArtifactId: provenanceReport.artifactId,
    provenanceReportHash: provenanceReport.contentHash,
    exportMetadataArtifactId: exportMetadata.artifactId,
    exportMetadataHash: exportMetadata.contentHash,
    publishApprovalRequired: value.publishApprovalRequired === true,
    blockingGateCount: Math.max(0, Math.floor(Number(value.blockingGateCount || 0))),
    blockingPassedCount: Math.max(0, Math.floor(Number(value.blockingPassedCount || 0))),
    blockingFailedCount: Math.max(0, Math.floor(Number(value.blockingFailedCount || 0))),
    warningCount: Math.max(0, Math.floor(Number(value.warningCount || 0))),
    failedGateCodes: safeStringList(value.failedGateCodes, 24, 80),
    technicalFinal: value.technicalFinal === true,
    timingMode: sanitizeText(value.timingMode || "estimated_silent", 40),
  };
}

function normalizeNarrationAlignmentSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactId = sanitizeText(value.artifactId, 100);
  const contentHash = sanitizeText(value.contentHash, 80).toLowerCase();
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(artifactId) || !/^[a-f0-9]{64}$/.test(contentHash)) return null;
  return { artifactId, contentHash, durationFrames: Math.max(30, Math.floor(Number(value.durationFrames || 30))), wordCount: Math.max(1, Math.floor(Number(value.wordCount || 1))), exactSequenceMatch: value.exactSequenceMatch === true };
}

function normalizeAnimationScenePlanSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.required === false) {
    const reason = sanitizeText(value.reason, 40).toLowerCase();
    if (reason !== "checked_profile") return null;
    return { required: false, reason: "checked_profile" };
  }
  const artifactId = sanitizeText(value.artifactId, 100);
  const contentHash = sanitizeText(value.contentHash, 80).toLowerCase();
  const plannerConfigurationHash = sanitizeText(
    value.plannerConfigurationHash,
    80,
  ).toLowerCase();
  const plannerMode = sanitizeText(value.plannerMode, 40).toLowerCase();
  const promptProfileId = sanitizeText(value.promptProfileId, 160);
  const sceneCount = Number(value.sceneCount);
  const fallbackSceneCount = Number(value.fallbackSceneCount);
  if (
    !/^art_[A-Za-z0-9-]{8,80}$/.test(artifactId)
    || !/^[a-f0-9]{64}$/.test(contentHash)
    || !/^[a-f0-9]{64}$/.test(plannerConfigurationHash)
    || !["disabled", "mock", "openai_compatible"].includes(plannerMode)
    || !/^[a-z][a-z0-9_-]{1,159}$/.test(promptProfileId)
    || !Number.isInteger(sceneCount)
    || sceneCount < 1
    || sceneCount > 20
    || !Number.isInteger(fallbackSceneCount)
    || fallbackSceneCount < 0
    || fallbackSceneCount > sceneCount
  ) return null;
  return {
    required: true,
    artifactId,
    contentHash,
    sceneCount,
    fallbackSceneCount,
    plannerMode,
    promptProfileId,
    plannerConfigurationHash,
    reused: value.reused === true,
  };
}

function normalizeTechnicalQaSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactId = sanitizeText(value.qaReportArtifactId || "", 100);
  const reportHash = sanitizeText(value.qaReportHash || "", 80).toLowerCase();
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(artifactId) || !/^[a-f0-9]{64}$/.test(reportHash)) return null;
  return {
    qaStatus: sanitizeText(value.qaStatus || "failed", 20),
    qaPassed: value.qaPassed === true,
    qaReportArtifactId: artifactId,
    qaReportHash: reportHash,
    blockingGateCount: Math.max(0, Math.floor(Number(value.blockingGateCount || 0))),
    blockingPassedCount: Math.max(0, Math.floor(Number(value.blockingPassedCount || 0))),
    blockingFailedCount: Math.max(0, Math.floor(Number(value.blockingFailedCount || 0))),
    warningCount: Math.max(0, Math.floor(Number(value.warningCount || 0))),
    failedGateCodes: safeStringList(value.failedGateCodes, 24, 80),
    technicalFinal: value.technicalFinal === true,
    publishable: false,
  };
}

function normalizeEvidencePackageSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = sanitizeText(value.packageStatus || "failed", 20).toLowerCase();
  if (!["complete", "failed"].includes(status)) return null;
  const failedArtifactCode = sanitizeText(value.failedArtifactCode || "", 80) || null;
  if (status === "failed") return { packageStatus: "failed", failedArtifactCode, outputHash: sanitizeText(value.outputHash || "", 80).toLowerCase() || null, technicalFinal: true, qaPassed: value.qaPassed === true, publishable: false, publishApprovalRequired: true };
  const pairs = [
    ["contactSheetArtifactId", "contactSheetHash"], ["rightsManifestArtifactId", "rightsManifestHash"],
    ["provenanceReportArtifactId", "provenanceReportHash"], ["exportMetadataArtifactId", "exportMetadataHash"],
  ];
  const normalized = {};
  for (const [idKey, hashKey] of pairs) {
    const id = sanitizeText(value[idKey] || "", 100);
    const digest = sanitizeText(value[hashKey] || "", 80).toLowerCase();
    if (!/^art_[A-Za-z0-9-]{8,80}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest)) return null;
    normalized[idKey] = id; normalized[hashKey] = digest;
  }
  const outputHash = sanitizeText(value.outputHash || "", 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(outputHash)) return null;
  return { packageStatus: "complete", ...normalized, outputHash, failedArtifactCode: null, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true };
}

function publicTwoPhaseGoalCamera(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goals = Array.isArray(value.goals) ? value.goals.slice(0, 12).map((goal) => ({
    goalNumber: safeNumber(goal && goal.goalNumber),
    ballFollowStart: safeNumber(goal && goal.ballFollowStart),
    ballFollowEnd: safeNumber(goal && goal.ballFollowEnd),
    visibleFinishTime: safeNumber(goal && goal.visibleFinishTime),
    scorerFollowStart: safeNumber(goal && goal.scorerFollowStart),
    scorerFollowEnd: safeNumber(goal && goal.scorerFollowEnd),
    targetSwitchTime: safeNumber(goal && goal.targetSwitchTime),
    ballVisibilityCoverage: safeNumber(goal && goal.ballVisibilityCoverage),
    ballCenterCoverage: safeNumber(goal && goal.ballCenterCoverage),
    ballVerticalSafeCoverage: safeNumber(goal && goal.ballVerticalSafeCoverage),
    verticalWideSafeFallbackRequired: goal && goal.verticalWideSafeFallbackRequired === true,
    firstBallTrackedTime: safeNumber(goal && goal.firstBallTrackedTime),
    ballStartGapSeconds: safeNumber(goal && goal.ballStartGapSeconds),
    scorerHeadCoverage: safeNumber(goal && goal.scorerHeadCoverage),
    wideSafeFallbackFrames: safeNumber(goal && goal.wideSafeFallbackFrames),
    scorerGroupFallbackFrames: safeNumber(goal && goal.scorerGroupFallbackFrames),
    scorerWideSafeFallbackFrames: safeNumber(goal && goal.scorerWideSafeFallbackFrames),
    scorerTargetMode: sanitizeText(goal && goal.scorerTargetMode || "", 50) || null,
    trackingConfidence: goal && goal.trackingConfidence && typeof goal.trackingConfidence === "object"
      ? {
          ballFollow: safeNumber(goal.trackingConfidence.ballFollow),
          scorerFollow: safeNumber(goal.trackingConfidence.scorerFollow),
        }
      : null,
    ballFollowPassed: goal && goal.ballFollowPassed === true,
    scorerFollowPassed: goal && goal.scorerFollowPassed === true,
    passed: goal && goal.passed === true,
    failedReasons: safeStringList(goal && goal.failedReasons, 6, 80),
  })) : [];
  return {
    passed: value.passed === true,
    goalCount: safeNumber(value.goalCount),
    coveredGoalCount: safeNumber(value.coveredGoalCount),
    missingGoalNumbers: Array.isArray(value.missingGoalNumbers)
      ? value.missingGoalNumbers.map(safeNumber).filter((item) => item !== null).slice(0, 12)
      : [],
    goalClaimAllowed: false,
    goals,
  };
}

function publicRenderPolishQaSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const transitions = Array.isArray(value.transitions)
    ? value.transitions.slice(0, 8).map((transition) => ({
        fromSegmentId: sanitizeText(transition && transition.fromSegmentId || "", 80) || null,
        toSegmentId: sanitizeText(transition && transition.toSegmentId || "", 80) || null,
        timelineStart: safeNumber(transition && transition.timelineStart),
        type: sanitizeText(transition && transition.type || "", 40) || null,
        transitionDurationSeconds: safeNumber(transition && transition.transitionDurationSeconds),
        renderedBy: sanitizeText(transition && transition.renderedBy || "", 60) || null,
      }))
    : [];
  return {
    contractVersion: safeNumber(value.contractVersion),
    renderProfile: sanitizeText(value.renderProfile || "", 40) || null,
    encoderPreset: sanitizeText(value.encoderPreset || "", 40) || null,
    encoderCrf: safeNumber(value.encoderCrf),
    segmentRenderMode: sanitizeText(value.segmentRenderMode || "", 80) || null,
    videoEnhancementEnabled: value.videoEnhancementEnabled === true,
    videoEnhancementApplied: value.videoEnhancementApplied === true,
    videoEnhancementProvider: sanitizeText(value.videoEnhancementProvider || "", 60) || null,
    videoEnhancementModel: sanitizeText(value.videoEnhancementModel || "", 80) || null,
    videoEnhancementScale: safeNumber(value.videoEnhancementScale),
    videoEnhancementFps: safeNumber(value.videoEnhancementFps),
    videoEnhancementTemporalMode: sanitizeText(value.videoEnhancementTemporalMode || "", 60) || null,
    videoEnhancementOverlayProtection: sanitizeText(value.videoEnhancementOverlayProtection || "", 80) || null,
    videoEnhancementFallbackUsed: value.videoEnhancementFallbackUsed === true,
    videoEnhancementFallbackReason: sanitizeText(value.videoEnhancementFallbackReason || "", 80) || null,
    renderStylePreset: sanitizeText(value.renderStylePreset || "", 80) || null,
    outputWidth: safeNumber(value.outputWidth),
    outputHeight: safeNumber(value.outputHeight),
    cleanActionLayoutRequired: value.cleanActionLayoutRequired === true,
    cleanActionLayoutPassed: value.cleanActionLayoutPassed === true,
    actionLayoutMode: sanitizeText(value.actionLayoutMode || "", 80) || null,
    fullHeightActionCrop: value.fullHeightActionCrop === true,
    dynamicCropRendered: value.dynamicCropRendered === true,
    cropKeyframeCount: safeNumber(value.cropKeyframeCount),
    maxPanSpeed: safeNumber(value.maxPanSpeed),
    maxPanAcceleration: safeNumber(value.maxPanAcceleration),
    trackingProviderMode: sanitizeText(value.trackingProviderMode || "", 80) || null,
    trackingConfidence: safeNumber(value.trackingConfidence),
    ballCandidateConfidence: safeNumber(value.ballCandidateConfidence),
    playerClusterConfidence: safeNumber(value.playerClusterConfidence),
    ballTrackCount: safeNumber(value.ballTrackCount),
    playerClusterCount: safeNumber(value.playerClusterCount),
    celebrationHeadTrackCount: safeNumber(value.celebrationHeadTrackCount),
    celebrationHeadKeyframeCount: safeNumber(value.celebrationHeadKeyframeCount),
    celebrationHeadTrackedGoalCount: safeNumber(value.celebrationHeadTrackedGoalCount),
    celebrationHeadTrackingRequired: value.celebrationHeadTrackingRequired === true,
    celebrationHeadTrackingPassed: value.celebrationHeadTrackingPassed === true,
    celebrationHeadFollowRendered: value.celebrationHeadFollowRendered === true,
    celebrationGroupFallbackFrameCount: safeNumber(value.celebrationGroupFallbackFrameCount),
    celebrationFollowPassed: value.celebrationFollowPassed === true,
    twoPhaseGoalCameraPassed: value.twoPhaseGoalCameraPassed === true,
    twoPhaseGoalCamera: publicTwoPhaseGoalCamera(value.twoPhaseGoalCamera),
    scoreboardOverlayRendered: value.scoreboardOverlayRendered === true,
    scoreboardOverlayRegionId: sanitizeText(value.scoreboardOverlayRegionId || "", 80) || null,
    sourceScoreboardDuplicateSuppressed: value.sourceScoreboardDuplicateSuppressed === true,
    intermediateVideoEncoding: sanitizeText(value.intermediateVideoEncoding || "", 60) || null,
    lossyVideoEncodeCount: safeNumber(value.lossyVideoEncodeCount),
    blurredBackgroundUsed: value.blurredBackgroundUsed === true,
    duplicateBackgroundUsed: value.duplicateBackgroundUsed === true,
    splitLayoutCaptionCount: safeNumber(value.splitLayoutCaptionCount),
    transitionMode: sanitizeText(value.transitionMode || "", 80) || null,
    transitionRenderedCount: safeNumber(value.transitionRenderedCount),
    hardCutFallbackCount: safeNumber(value.hardCutFallbackCount),
    transitions,
    animatedCaptionCount: safeNumber(value.animatedCaptionCount),
    dynamicWordCaptionCount: safeNumber(value.dynamicWordCaptionCount),
    staticCaptionFallbackCount: safeNumber(value.staticCaptionFallbackCount),
    captionsRendered: value.captionsRendered !== false,
    captionsDisabledByOperator: value.captionsDisabledByOperator === true,
    captionMotion: sanitizeText(value.captionMotion || "", 80) || null,
    overlayRenderedCount: safeNumber(value.overlayRenderedCount),
    overlayFallbackCount: safeNumber(value.overlayFallbackCount),
    overlayMode: sanitizeText(value.overlayMode || "", 80) || null,
    visualPolishScore: safeNumber(value.visualPolishScore),
    renderPolishWarnings: safeStringList(value.renderPolishWarnings, 12, 80),
  };
}

function publicGoalOutcomeSummary(value) {
  if (!value) return null;
  const outcome = typeof value === "object" && !Array.isArray(value)
    ? value.outcome || value.status || value.type
    : value;
  const safeOutcome = sanitizeText(outcome || "", 60);
  return safeOutcome ? { outcome: safeOutcome } : null;
}

function publicPhaseCoverageSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    hasBuildup: Boolean(value.hasBuildup),
    hasShot: Boolean(value.hasShot),
    hasFinish: Boolean(value.hasFinish),
    hasConfirmation: Boolean(value.hasConfirmation),
    replayOnly: Boolean(value.replayOnly),
    celebrationOnly: Boolean(value.celebrationOnly),
  };
}

function publicBoundarySmoothingSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    applied: Boolean(value.applied),
    smoothingLevel: sanitizeText(value.smoothingLevel || "", 40) || null,
    preActionPaddingSeconds: safeNumber(value.preActionPaddingSeconds),
    postConfirmationPaddingSeconds: safeNumber(value.postConfirmationPaddingSeconds),
  };
}

function publicVisualGoalGateSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    passed: Boolean(value.passed),
    confidence: safeNumber(value.confidence),
    failureCode: sanitizeText(value.failureCode || "", 80) || null,
  };
}

function publicRenderedGoalProofSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const timing = value.timing && typeof value.timing === "object" && !Array.isArray(value.timing)
    ? value.timing
    : null;
  return {
    schemaVersion: safeNumber(value.schemaVersion),
    providerMode: sanitizeText(value.providerMode || "", 80) || null,
    passed: typeof value.passed === "boolean" ? value.passed : null,
    status: sanitizeText(value.status || "", 40) || null,
    goalCount: safeNumber(value.goalCount),
    clearGoalCount: safeNumber(value.clearGoalCount),
    borderlineGoalCount: safeNumber(value.borderlineGoalCount),
    failedGoalCount: safeNumber(value.failedGoalCount),
    nonClearGoalCount: safeNumber(value.nonClearGoalCount),
    missingClearGoalNumbers: Array.isArray(value.missingClearGoalNumbers)
      ? value.missingClearGoalNumbers
          .map((goalNumber) => safeNumber(goalNumber))
          .filter((goalNumber) => goalNumber !== null)
          .slice(0, 12)
      : [],
    contactSheetRef: sanitizeText(value.contactSheetRef || "", 180) || null,
    timing: timing
      ? {
          renderMs: safeNumber(timing.renderMs),
          renderedGoalProofMs: safeNumber(timing.renderedGoalProofMs),
          frameExtractionMs: safeNumber(timing.frameExtractionMs),
          semanticVisibilityMs: safeNumber(timing.semanticVisibilityMs),
          rebindAttemptCount: safeNumber(timing.rebindAttemptCount),
          framesExtracted: safeNumber(timing.framesExtracted),
          framesReused: safeNumber(timing.framesReused),
          candidateFrameWindowCount: safeNumber(timing.candidateFrameWindowCount),
          uniqueFrameWindowCount: safeNumber(timing.uniqueFrameWindowCount),
          batchExtractionCallCount: safeNumber(timing.batchExtractionCallCount),
          bottleneckStep: sanitizeText(timing.bottleneckStep || "", 80) || null,
          perGoalProofMs: Array.isArray(timing.perGoalProofMs)
            ? timing.perGoalProofMs.slice(0, 12).map((item, index) => ({
                goalNumber: safeNumber(item && item.goalNumber) || index + 1,
                ms: safeNumber(item && item.ms),
              }))
            : [],
        }
      : null,
    goals: Array.isArray(value.goals)
      ? value.goals.slice(0, 12).map((goal, index) => {
          const payoffSearch = goal && goal.payoffSearch && typeof goal.payoffSearch === "object" && !Array.isArray(goal.payoffSearch)
            ? goal.payoffSearch
            : null;
          return {
            goalNumber: safeNumber(goal && goal.goalNumber) || index + 1,
            segmentIndex: safeNumber(goal && goal.segmentIndex),
            verdict: sanitizeText(goal && goal.verdict || "", 40) || null,
            frameCount: safeNumber(goal && goal.frameCount),
            candidateFrameCount: safeNumber(goal && goal.candidateFrameCount),
            unverifiedFrameCount: safeNumber(goal && goal.unverifiedFrameCount),
            failedFrameReasons: safeStringList(goal && goal.failedFrameReasons, 8, 80),
            payoffSearch: payoffSearch
              ? {
                  role: sanitizeText(payoffSearch.role || "", 40) || null,
                  required: Boolean(payoffSearch.required),
                  searchStart: safeNumber(payoffSearch.searchStart),
                  searchEnd: safeNumber(payoffSearch.searchEnd),
                  candidateCount: safeNumber(payoffSearch.candidateCount),
                  clearCandidateCount: safeNumber(payoffSearch.clearCandidateCount),
                  selectedTime: safeNumber(payoffSearch.selectedTime),
                  selectedClear: typeof payoffSearch.selectedClear === "boolean" ? payoffSearch.selectedClear : null,
                  selectedReason: sanitizeText(payoffSearch.selectedReason || "", 80) || null,
                  rejectedReasons: safeStringList(payoffSearch.rejectedReasons, 8, 80),
                  sampledCandidateCount: Array.isArray(payoffSearch.sampledCandidates) ? payoffSearch.sampledCandidates.length : 0,
                }
              : null,
            semanticSummary: goal && goal.semanticSummary && typeof goal.semanticSummary === "object" && !Array.isArray(goal.semanticSummary)
              ? {
                  providerMode: sanitizeText(goal.semanticSummary.providerMode || "", 80) || null,
                  clearFrameCount: safeNumber(goal.semanticSummary.clearFrameCount),
                  failedFrameCount: safeNumber(goal.semanticSummary.failedFrameCount),
                }
              : null,
            frameRefs: Array.isArray(goal && goal.frameRefs)
              ? goal.frameRefs.slice(0, 8).map((frame) => ({
                  role: sanitizeText(frame && frame.role || "", 40) || null,
                  time: safeNumber(frame && frame.time),
                  status: sanitizeText(frame && frame.status || "", 40) || null,
                  clear: typeof (frame && frame.clear) === "boolean" ? frame.clear : null,
                  confidence: safeNumber(frame && frame.confidence),
                  reason: sanitizeText(frame && frame.reason || "", 80) || null,
                })).filter((frame) => frame.role)
              : [],
          };
        })
      : [],
  };
}

function publicCaptionSummary(caption = {}, index = 0) {
  const activeWordTiming = Array.isArray(caption.activeWordTiming)
    ? caption.activeWordTiming.slice(0, 16).map((timing) => ({
        word: sanitizeText(timing && timing.word || "", 24) || null,
        start: safeNumber(timing && timing.start),
        end: safeNumber(timing && timing.end),
      })).filter((timing) => timing.word && timing.start !== null && timing.end !== null)
    : [];
  const words = Array.isArray(caption.words)
    ? caption.words.map((word) => sanitizeText(word, 24)).filter(Boolean).slice(0, 16)
    : activeWordTiming.map((timing) => timing.word);
  return {
    index: index + 1,
    start: safeNumber(caption.start),
    end: safeNumber(caption.end),
    text: sanitizeText(caption.text || "", 120) || null,
    role: sanitizeText(caption.role || "caption", 60),
    words,
    activeWordTiming,
    stylePreset: sanitizeText(caption.stylePreset || "", 60) || null,
    contrastMode: sanitizeText(caption.contrastMode || "", 60) || null,
    safeArea: caption.safeArea && typeof caption.safeArea === "object" && !Array.isArray(caption.safeArea)
      ? { name: sanitizeText(caption.safeArea.name || "", 60) || null }
      : null,
    riskFlags: safeStringList(caption.captionRiskFlags, 6, 80),
  };
}

function publicHookPlanSummary(plan = {}, captions = []) {
  const raw = plan.hookPlan && typeof plan.hookPlan === "object" && !Array.isArray(plan.hookPlan)
    ? plan.hookPlan
    : {};
  const openingCaption = captions.find((caption) => caption && caption.role === "opening_hook") || null;
  if (!Object.keys(raw).length && !openingCaption && !plan.hook) return null;
  return {
    hookStart: safeNumber(raw.hookStart ?? raw.start ?? (openingCaption && openingCaption.start)),
    hookEnd: safeNumber(raw.hookEnd ?? raw.end ?? (openingCaption && openingCaption.end)),
    hookType: sanitizeText(raw.hookType || raw.type || (openingCaption && openingCaption.role) || "opening_hook", 60),
    hookText: sanitizeText(raw.hookText || raw.text || plan.hook || (openingCaption && openingCaption.text) || "", 120) || null,
    relatedGoalNumber: safeNumber(raw.relatedGoalNumber),
    relatedMomentId: sanitizeText(raw.relatedMomentId || plan.candidateId || "", 80) || null,
    evidenceCodes: safeStringList(
      Array.isArray(raw.evidenceCodes) && raw.evidenceCodes.length ? raw.evidenceCodes : plan.reasonCodes,
      10,
      80,
    ),
    noFalseGoalClaim: raw.noFalseGoalClaim !== false,
  };
}

function publicAudioPolicySummary(policy = null) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  return {
    audioMode: sanitizeText(policy.audioMode || "", 60) || null,
    licenseStatus: sanitizeText(policy.licenseStatus || "", 60) || null,
    source: sanitizeText(policy.source || "", 80) || null,
    safeForExport: policy.safeForExport === true,
    operatorActionRequired: policy.operatorActionRequired === true,
    externalAudioBundled: policy.externalAudioBundled === true,
    copyrightedTrackBundled: policy.copyrightedTrackBundled === true,
  };
}

function publicCreativeStyleSummary(style = null) {
  if (!style || typeof style !== "object" || Array.isArray(style)) return null;
  return {
    colorGrade: sanitizeText(style.colorGrade || "", 60) || null,
    mildZoom: safeNumber(style.mildZoom),
    sharpen: safeNumber(style.sharpen),
    contrastBoost: safeNumber(style.contrastBoost),
    mirror: style.mirror === true,
    copyrightEvasion: style.copyrightEvasion === true,
    watermarkObscuring: style.watermarkObscuring === true,
  };
}

function publicRenderPlanSummary(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const segments = Array.isArray(plan.segments)
    ? plan.segments.slice(0, 12).map((segment, index) => ({
        index: index + 1,
        id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
        goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Math.round(Number(segment.goalNumber)) : null,
        highlightType: sanitizeText(segment.highlightType || "", 80) || null,
        scoreBefore: sanitizeText(segment.scoreBefore || "", 16) || null,
        scoreAfter: sanitizeText(segment.scoreAfter || "", 16) || null,
        scoreChangeTime: safeNumber(segment.scoreChangeTime),
        sourceStart: safeNumber(segment.sourceStart),
        buildupStart: safeNumber(segment.buildupStart),
        shotStart: safeNumber(segment.shotStart),
        finishTime: safeNumber(segment.finishTime),
        confirmationTime: safeNumber(segment.confirmationTime),
        sourceEnd: safeNumber(segment.sourceEnd),
        duration: safeNumber(segment.duration),
        timelineStart: safeNumber(segment.timelineStart),
        timelineEnd: safeNumber(segment.timelineEnd),
        goalOutcome: publicGoalOutcomeSummary(segment.goalOutcome || segment.outcome),
        replayUsed: typeof segment.replayUsed === "boolean" ? segment.replayUsed : null,
        replayOnly: Boolean(segment.replayOnly || (segment.phaseCoverage && segment.phaseCoverage.replayOnly)),
        boundarySmoothing: publicBoundarySmoothingSummary(segment.boundarySmoothing),
        phaseCoverage: publicPhaseCoverageSummary(segment.phaseCoverage),
        visualGoalGate: publicVisualGoalGateSummary(segment.visualGoalGate),
        reasonCodes: safeStringList(segment.reasonCodes, 10, 80),
        whySelected: sanitizeText(segment.whySelected || "", 180) || null,
        safetyFlags: safeStringList(segment.safetyFlags, 8, 80),
      }))
    : [];
  const videoOutputQA = plan.videoOutputQA && typeof plan.videoOutputQA === "object" && !Array.isArray(plan.videoOutputQA)
    ? publicJsonClone(plan.videoOutputQA)
    : null;
  const renderedGoalProof = plan.renderedGoalProof && typeof plan.renderedGoalProof === "object" && !Array.isArray(plan.renderedGoalProof)
    ? publicRenderedGoalProofSummary(plan.renderedGoalProof)
    : null;
  const renderedGoalRebinding = plan.renderedGoalRebinding && typeof plan.renderedGoalRebinding === "object" && !Array.isArray(plan.renderedGoalRebinding)
    ? publicJsonClone(plan.renderedGoalRebinding)
    : null;
  const renderedGoalCompaction = plan.renderedGoalCompaction && typeof plan.renderedGoalCompaction === "object" && !Array.isArray(plan.renderedGoalCompaction)
    ? publicJsonClone(plan.renderedGoalCompaction)
    : null;
  const captions = Array.isArray(plan.captions)
    ? plan.captions.slice(0, 12).map(publicCaptionSummary)
    : [];
  return {
    mode: sanitizeText(plan.mode || "", 80) || null,
    highlightType: sanitizeText(plan.highlightType || "", 80) || null,
    sourceStart: safeNumber(plan.sourceStart),
    sourceEnd: safeNumber(plan.sourceEnd),
    totalDuration: safeNumber(plan.totalDuration),
    segmentCount: Array.isArray(plan.segments) ? plan.segments.length : 0,
    captionCount: Array.isArray(plan.captions) ? plan.captions.length : 0,
    captions,
    animationCueCount: Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
    stylePreset: sanitizeText(plan.stylePreset || "", 80) || null,
    framingMode: sanitizeText(plan.framingMode || "", 80) || null,
    styleTarget: sanitizeText(plan.styleTarget || "", 40) || null,
    editIntensity: sanitizeText(plan.editIntensity || "", 40) || null,
    cropPlanMode: sanitizeText(plan.cropPlan && plan.cropPlan.mode ? plan.cropPlan.mode : "", 80) || null,
    goalSelectionMode: sanitizeText(plan.goalSelectionMode || "", 80) || null,
    hookPlan: publicHookPlanSummary(plan, captions),
    audioPolicy: publicAudioPolicySummary(plan.audioPolicy),
    creativeStyleTransforms: publicCreativeStyleSummary(plan.creativeStyleTransforms),
    segments,
    videoOutputQA,
    renderedGoalProof,
    renderedGoalRebinding,
    renderedGoalCompaction,
    visualPolishQA: plan.visualPolishQA && typeof plan.visualPolishQA === "object" ? publicJsonClone(plan.visualPolishQA) : null,
    renderPolishQA: publicRenderPolishQaSummary(plan.renderPolishQA),
    editAssembly: plan.editAssembly && typeof plan.editAssembly === "object" ? publicJsonClone(plan.editAssembly) : null,
    humanReviewGate: plan.humanReviewGate ? publicHumanReviewGate(plan.humanReviewGate) : null,
  };
}

const SAFE_ERROR_DETAIL_STRING_KEYS = Object.freeze([
  "phase",
  "step",
  "substep",
  "sourceType",
  "scoreboardOcrProviderMode",
  "nextAction",
]);
const SAFE_ERROR_DETAIL_BOOLEAN_KEYS = Object.freeze([
  "sourceValidated",
  "downloadedSourceReady",
  "scoreboardOcrAttempted",
  "scoreboardOcrEnabled",
  "lateBucketInspected",
]);
const SAFE_ERROR_DETAIL_NUMBER_KEYS = Object.freeze([
  "sourceDuration",
  "scoreboardObservationCount",
  "scoreboardSampledFrameCount",
  "scoreChangeCount",
  "stableScoreChangeCount",
  "chunksScanned",
  "chunkCount",
  "skippedChunks",
  "timedOutChunks",
  "scoreChangesFound",
  "countedGoalEventCount",
  "discoveredCountedGoals",
  "expectedCountedGoals",
  "visualWindowCount",
  "bucketCount",
  "selectedValidGoalCount",
  "candidateCount",
  "rejectedCandidateCount",
  "goalEvidenceEventCount",
  "validGoalEvidenceCount",
  "offsideOrNoGoalEvidenceCount",
  "celebrationOnlyEvidenceCount",
  "anthemOrIntroEvidenceCount",
  "ocrEvidenceCount",
  "scoreboardConfirmedGoalCount",
  "recoverableGoalEvidenceCandidateCount",
  "matchEventTruthConfirmedGoalCount",
  "matchEventTruthDisallowedGoalCount",
  "matchEventTruthPossibleGoalCount",
  "matchEventTruthScoreTimelineObservationCount",
  "matchEventTruthScoreChangeCount",
  "matchEventTruthCountedGoalEventCount",
  "matchEventTruthDisallowedGoalEventCount",
  "matchEventTruthSelectedGoalCount",
  "matchEventTruthScoreChangeAnchorsFound",
  "matchEventTruthStableScoreChangeAnchorCount",
  "matchEventTruthRevertedScoreChangeAnchorCount",
  "matchEventTruthAnchorsLinkedToGoalPhaseCount",
  "matchEventTruthAnchorsMissingVisualSupportCount",
  "matchEventTruthAnchorsWithLiveActionEvidence",
  "matchEventTruthAnchorsRejected",
  "matchEventTruthSelectedCountedGoals",
  "matchEventTruthOcrOnlyBlockedCount",
  "matchEventTruthMissingActionEvidenceCount",
]);

function normalizeReasonList(values, max = 8) {
  return (Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeErrorCandidate(candidate = {}, index = 0) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return {
    index: Number.isFinite(Number(candidate.index)) ? Number(candidate.index) : index + 1,
    id: sanitizeText(candidate.id || `goal_evidence_${index + 1}`, 80),
    outcomeHint: sanitizeText(candidate.outcomeHint || "unknown", 48),
    start: Number.isFinite(Number(candidate.start)) ? Number(candidate.start) : null,
    end: Number.isFinite(Number(candidate.end)) ? Number(candidate.end) : null,
    reasonCodes: normalizeReasonList(candidate.reasonCodes, 12),
    missingEvidence: normalizeReasonList(candidate.missingEvidence, 8),
    recoveryEligibility: sanitizeText(candidate.recoveryEligibility || "not_recoverable", 60),
    rejectionReason: candidate.rejectionReason ? sanitizeText(candidate.rejectionReason, 80) : null,
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
  };
}

function normalizeTopRejectionReasons(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      return {
        reason: sanitizeText(item.reason || "", 80),
        count: Number.isFinite(Number(item.count)) ? Number(item.count) : 0,
      };
    })
    .filter((item) => item && item.reason)
    .slice(0, 8);
}

function normalizeErrorChunkSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    mode: sanitizeText(value.mode || "chunked_scorebug_first_ocr", 60),
    chunkCount: Number.isFinite(Number(value.chunkCount)) ? Number(value.chunkCount) : null,
    scannedChunks: Number.isFinite(Number(value.scannedChunks)) ? Number(value.scannedChunks) : null,
    skippedChunks: Number.isFinite(Number(value.skippedChunks)) ? Number(value.skippedChunks) : null,
    timedOutChunks: Number.isFinite(Number(value.timedOutChunks)) ? Number(value.timedOutChunks) : null,
    discoveredScoreChanges: Number.isFinite(Number(value.discoveredScoreChanges)) ? Number(value.discoveredScoreChanges) : null,
  };
}

function normalizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const safe = {};
  for (const key of SAFE_ERROR_DETAIL_STRING_KEYS) {
    if (details[key] != null) safe[key] = sanitizeText(details[key], key === "nextAction" ? 180 : 80);
  }
  for (const key of SAFE_ERROR_DETAIL_BOOLEAN_KEYS) {
    if (typeof details[key] === "boolean") safe[key] = details[key];
  }
  for (const key of SAFE_ERROR_DETAIL_NUMBER_KEYS) {
    if (Number.isFinite(Number(details[key]))) safe[key] = Number(details[key]);
  }
  const topRejectionReasons = normalizeTopRejectionReasons(details.topRejectionReasons);
  if (topRejectionReasons.length) safe.topRejectionReasons = topRejectionReasons;
  const missingEvidenceByCandidate = (Array.isArray(details.missingEvidenceByCandidate) ? details.missingEvidenceByCandidate : [])
    .map(normalizeErrorCandidate)
    .filter(Boolean)
    .slice(0, 12);
  if (missingEvidenceByCandidate.length) safe.missingEvidenceByCandidate = missingEvidenceByCandidate;
  const goalEvidenceCandidates = (Array.isArray(details.goalEvidenceCandidates) ? details.goalEvidenceCandidates : [])
    .map(normalizeErrorCandidate)
    .filter(Boolean)
    .slice(0, 12);
  if (goalEvidenceCandidates.length) safe.goalEvidenceCandidates = goalEvidenceCandidates;
  const missedGoalReasons = normalizeReasonList(details.matchEventTruthMissedGoalReasons, 8);
  if (missedGoalReasons.length) safe.matchEventTruthMissedGoalReasons = missedGoalReasons;
  const ocrChunkSummary = normalizeErrorChunkSummary(details.ocrChunkSummary);
  if (ocrChunkSummary) safe.ocrChunkSummary = ocrChunkSummary;
  return Object.keys(safe).length ? safe : null;
}

function normalizeError(error) {
  if (!error) return null;
  const code = sanitizeText(error.code || "UNEXPECTED", 80);
  const normalized = {
    code,
    message: sanitizeText(error.message || SAFE_MESSAGES[code] || SAFE_MESSAGES.UNEXPECTED, 240),
  };
  const details = normalizeErrorDetails(error.details);
  if (details) normalized.details = details;
  return normalized;
}

function normalizeStyleTarget(value) {
  const safe = sanitizeText(value || "vertical_9_16", 40).toLowerCase();
  if (JOB_STYLE_TARGETS.includes(safe)) return safe;
  return JOB_STYLE_ALIASES[safe] || "vertical_9_16";
}

function normalizeEditIntensity(value) {
  const safe = sanitizeText(value || "balanced", 40).toLowerCase();
  return JOB_EDIT_INTENSITIES.includes(safe) ? safe : "balanced";
}

function normalizeRenderStylePreset(value) {
  const safe = sanitizeText(value || "social_sports_v1", 40).toLowerCase();
  return JOB_RENDER_STYLE_PRESETS.includes(safe) ? safe : "social_sports_v1";
}

function normalizeGoalSelectionMode(value) {
  const safe = sanitizeText(value || "", 40).toLowerCase();
  return JOB_GOAL_SELECTION_MODES.includes(safe) ? safe : null;
}

function normalizeCompositionMode(value) {
  const safe = sanitizeText(value || "auto", 40).toLowerCase();
  return JOB_COMPOSITION_MODES.includes(safe) ? safe : "auto";
}

function normalizePayload(payload, options = {}) {
  if (!payload || typeof payload !== "object") return null;
  const pipelineType = pipelineTypeForAction(options.action || "generate", options.pipelineType);
  if (pipelineType === "narrated_short") {
    return normalizeNarratedJobPayload(payload, options.action);
  }
  const normalized = {
    title: sanitizeText(payload.title || "ShortsEngine Short", 120),
    preset: sanitizeText(payload.preset || "hype", 40).toLowerCase(),
    language: sanitizeText(payload.language || "auto", 32) || "auto",
    styleTarget: normalizeStyleTarget(payload.styleTarget),
    editIntensity: normalizeEditIntensity(payload.editIntensity),
    stylePreset: normalizeRenderStylePreset(payload.stylePreset),
    goalSelectionMode: normalizeGoalSelectionMode(payload.goalSelectionMode),
    compositionMode: normalizeCompositionMode(payload.compositionMode),
    expectedCountedGoals: Number.isInteger(Number(payload.expectedCountedGoals))
      ? Math.max(0, Math.min(20, Number(payload.expectedCountedGoals)))
      : null,
    expectedFinalScore: /^\d{1,2}-\d{1,2}$/.test(String(payload.expectedFinalScore || ""))
      ? String(payload.expectedFinalScore)
      : null,
    rightsConfirmed: payload.rightsConfirmed === true,
    source: normalizeSmokeSource(payload.source),
  };
  if (payload.approvedEditPlan) normalized.approvedEditPlan = safePayloadObject(payload.approvedEditPlan);
  if (payload.regenerationApproval) {
    const approval = safePayloadObject(payload.regenerationApproval, 6000);
    normalized.regenerationApproval = {
      schemaVersion: Number.isFinite(Number(approval.schemaVersion)) ? Number(approval.schemaVersion) : 1,
      approvalId: sanitizeText(approval.approvalId || "", 80),
      regenerationPlanId: sanitizeText(approval.regenerationPlanId || "", 120),
      draftHash: sanitizeText(approval.draftHash || "", 80),
      sourceJobId: sanitizeText(approval.sourceJobId || "", 120),
      sourceExportId: sanitizeText(approval.sourceExportId || "", 120),
      approvedAt: sanitizeText(approval.approvedAt || "", 80),
      operatorNote: sanitizeText(approval.operatorNote || "", 500),
    };
  }
  if (payload.footballReviewApproval) {
    const approval = safePayloadObject(payload.footballReviewApproval, 4000);
    normalized.footballReviewApproval = {
      reviewId: sanitizeText(approval.reviewId || "", 80),
      reviewVersion: Math.max(1, Math.floor(Number(approval.reviewVersion || 1))),
      candidateId: sanitizeText(approval.candidateId || "", 80),
      sourceRevision: sanitizeText(approval.sourceRevision || "", 80).toLowerCase(),
      projectRevision: Math.max(1, Math.floor(Number(approval.projectRevision || 1))),
      reviewedAt: sanitizeText(approval.reviewedAt || "", 48),
      reviewerId: sanitizeText(approval.reviewerId || "", 80),
    };
  }
  return normalized;
}

function publicPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const safe = jsonClone(payload);
  if (safe.approvedEditPlan) {
    safe.approvedEditPlan = {
      aspectRatio: sanitizeText(safe.approvedEditPlan.aspectRatio || "", 20),
      highlightType: sanitizeText(safe.approvedEditPlan.highlightType || "", 80),
      framingMode: sanitizeText(safe.approvedEditPlan.framingMode || "", 80),
      stylePreset: sanitizeText(safe.approvedEditPlan.stylePreset || "", 80),
      captionCount: Array.isArray(safe.approvedEditPlan.captions) ? safe.approvedEditPlan.captions.length : 0,
      animationCueCount: Array.isArray(safe.approvedEditPlan.animationCues) ? safe.approvedEditPlan.animationCues.length : 0,
    };
  }
  if (safe.footballReviewApproval) {
    safe.footballReviewApproval = {
      reviewId: sanitizeText(safe.footballReviewApproval.reviewId || "", 80),
      reviewVersion: Math.max(1, Math.floor(Number(safe.footballReviewApproval.reviewVersion || 1))),
      candidateId: sanitizeText(safe.footballReviewApproval.candidateId || "", 80),
      projectRevision: Math.max(1, Math.floor(Number(safe.footballReviewApproval.projectRevision || 1))),
      reviewedAt: sanitizeText(safe.footballReviewApproval.reviewedAt || "", 48),
    };
  }
  return safe;
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logWarn(logger, payload) {
  if (!logger || typeof logger.warn !== "function") return;
  logger.warn(JSON.stringify(redactForLogs({ level: "warn", ...payload })));
}

function persistenceFailure(error) {
  if (error instanceof AppError) return error;
  return new AppError("DB_TRANSACTION_FAILED", SAFE_MESSAGES.DB_TRANSACTION_FAILED, 500);
}

function createWorkerId() {
  return `wrk_${randomUUID()}`;
}

function createLeaseId() {
  return `lease_${randomUUID()}`;
}

function normalizeLeaseInput(options = {}) {
  return {
    workerId: validateWorkerId(options.workerId || createWorkerId()),
    leaseId: validateLeaseId(options.leaseId || createLeaseId()),
    leaseMs: validateLeaseDurationMs(options.leaseMs || options.leaseDurationMs || DEFAULT_RECOVERY_POLICY.leaseDurationMs),
    nowMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
  };
}

function leaseFromJob(job) {
  if (!job || !job.workerId || !job.leaseId) return null;
  return {
    jobId: job.id,
    workerId: job.workerId,
    leaseId: job.leaseId,
    leaseExpiresAt: job.leaseExpiresAt,
    attempt: Number(job.attempts || 0),
  };
}

function leaseMatches(job, lease) {
  if (!job || !lease) return false;
  return (
    job.id === validateJobId(lease.jobId || job.id) &&
    job.workerId === validateWorkerId(lease.workerId) &&
    job.leaseId === validateLeaseId(lease.leaseId)
  );
}

class JobStore {
  constructor(options = {}) {
    this.jobs = new Map();
    this.idempotency = new Map();
    this.persistenceAdapter = options.persistenceAdapter || null;
    this.persistEnabled = Boolean(options.persist);
    if (this.persistenceAdapter) this.persistEnabled = true;
    this.jobDir = resolve(options.jobDir || CONFIG.jobDir);
    this.logger = options.logger || null;
    this.maxAttempts = Number(options.maxAttempts || DEFAULT_RECOVERY_POLICY.maxAttempts);
    this.staleProcessingMs = Number(options.staleProcessingMs || DEFAULT_RECOVERY_POLICY.staleProcessingMs);
    this.leaseDurationMs = validateLeaseDurationMs(options.leaseDurationMs || DEFAULT_RECOVERY_POLICY.leaseDurationMs);
    this.backend = this.persistenceAdapter
      ? sanitizeText(this.persistenceAdapter.mode || "adapter", 40)
      : this.persistEnabled
        ? "local-json"
        : "memory";
    if (this.persistEnabled && !this.persistenceAdapter) this.ensureJobDir();
  }

  ensureJobDir() {
    mkdirSync(this.jobDir, { recursive: true });
  }

  jobPath(jobId) {
    const safeId = validateJobId(jobId);
    const target = resolve(this.jobDir, `${safeId}.json`);
    if (!isInside(this.jobDir, target)) {
      throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
    }
    return target;
  }

  create({ projectId, uploadId = null, action, pipelineType = null, idempotencyKey: key, payload = null, ownerId = null }) {
    const existingJob = this.findIdempotentJob(key);
    if (existingJob) return existingJob;
    const createdAt = nowIso();
    const normalizedAction = sanitizeText(action || "generate", 60);
    const normalizedPipelineType = pipelineTypeForAction(normalizedAction, pipelineType);
    const job = {
      id: `job_${randomUUID()}`,
      projectId,
      uploadId,
      ownerId: ownerId ? normalizeOwnerId(ownerId) : null,
      action: normalizedAction,
      pipelineType: normalizedPipelineType,
      idempotencyKey: key || null,
      payload: normalizePayload(payload, { action: normalizedAction, pipelineType: normalizedPipelineType }),
      status: "queued",
      progress: 0,
      step: "queued",
      error: null,
      outputPath: null,
      exportId: null,
      editPlan: null,
      candidatePlans: null,
      highlights: null,
      mediaSignals: null,
      contentDraft: null,
      narratedRender: null,
      narrationAlignment: null,
      animationScenePlan: null,
      technicalQa: null,
      evidencePackage: null,
      humanReviewGate: null,
      attempts: 0,
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      nextRetryAt: null,
      backoffMs: null,
      lastRetryCode: null,
      createdAt,
      updatedAt: createdAt,
      _controller: new AbortController(),
    };
    this.persist(job, "job_created");
    this.jobs.set(job.id, job);
    if (key) this.idempotency.set(key, job.id);
    return job;
  }

  findIdempotentJob(key) {
    if (!key) return null;
    if (this.idempotency.has(key)) {
      return this.jobs.get(this.idempotency.get(key)) || null;
    }
    if (!this.persistenceAdapter || typeof this.persistenceAdapter.getIdempotencyJobId !== "function") return null;
    try {
      const persistedJobId = this.persistenceAdapter.getIdempotencyJobId(key);
      if (!persistedJobId) return null;
      const inMemory = this.jobs.get(persistedJobId);
      if (inMemory) return inMemory;
      const persisted = this.persistenceAdapter.getPersistedJob(persistedJobId);
      if (!persisted) return null;
      const job = this.hydrateJob(persisted);
      this.jobs.set(job.id, job);
      if (job.idempotencyKey) this.idempotency.set(job.idempotencyKey, job.id);
      return job;
    } catch (error) {
      logWarn(this.logger, {
        event: "job_idempotency_lookup_skipped",
        backend: this.backend,
        code: error.code || "JOB_RECORD_INVALID",
      });
      return null;
    }
  }

  publicJob(job) {
    if (!job) return null;
    const { _controller, ...safe } = job;
    const publicSafe = jsonClone(safe);
    delete publicSafe.outputPath;
    delete publicSafe.workerId;
    delete publicSafe.leaseId;
    delete publicSafe.claimedAt;
    delete publicSafe.leaseExpiresAt;
    if (publicSafe.payload) publicSafe.payload = publicPayload(publicSafe.payload);
    if (publicSafe.renderedGoalProof) publicSafe.renderedGoalProof = publicRenderedGoalProofSummary(publicSafe.renderedGoalProof);
    if (publicSafe.editPlan && typeof publicSafe.editPlan === "object" && !Array.isArray(publicSafe.editPlan)) {
      if (publicSafe.editPlan.renderedGoalProof) {
        publicSafe.editPlan.renderedGoalProof = publicRenderedGoalProofSummary(publicSafe.editPlan.renderedGoalProof);
      }
      if (publicSafe.editPlan.renderedGoalRebinding && typeof publicSafe.editPlan.renderedGoalRebinding === "object") {
        publicSafe.editPlan.renderedGoalRebinding = publicJsonClone(publicSafe.editPlan.renderedGoalRebinding);
      }
      if (publicSafe.editPlan.renderedGoalCompaction && typeof publicSafe.editPlan.renderedGoalCompaction === "object") {
        publicSafe.editPlan.renderedGoalCompaction = publicJsonClone(publicSafe.editPlan.renderedGoalCompaction);
      }
    }
    return restoreSafeEditPlanMetadata(publicJsonClone(publicSafe), safe);
  }

  publicJobSummary(job) {
    if (!job) return null;
    const summary = {
      id: job.id || null,
      projectId: job.projectId || null,
      uploadId: job.uploadId || null,
      action: job.action || null,
      pipelineType: job.pipelineType || pipelineTypeForAction(job.action || "generate"),
      status: job.status || null,
      progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
      step: job.step || null,
      progressMeta: job.progressMeta && typeof job.progressMeta === "object" && !Array.isArray(job.progressMeta)
        ? job.progressMeta
        : null,
      exportId: job.exportId || null,
      error: normalizeError(job.error),
      videoOutputQA: job.videoOutputQA || (job.editPlan && job.editPlan.videoOutputQA) || null,
      renderedGoalProof: publicRenderedGoalProofSummary(job.renderedGoalProof || (job.editPlan && job.editPlan.renderedGoalProof) || null),
      renderedGoalRebinding: job.renderedGoalRebinding || (job.editPlan && job.editPlan.renderedGoalRebinding) || null,
      renderedGoalCompaction: job.renderedGoalCompaction || (job.editPlan && job.editPlan.renderedGoalCompaction) || null,
      scoreboardOcr: job.scoreboardOcr || null,
      matchEventTruth: job.matchEventTruth || null,
      contentDraft: normalizeContentDraftSummary(job.contentDraft),
      narratedRender: normalizeNarratedRenderSummary(job.narratedRender),
      narrationAlignment: normalizeNarrationAlignmentSummary(job.narrationAlignment),
      animationScenePlan: normalizeAnimationScenePlanSummary(job.animationScenePlan),
      technicalQa: normalizeTechnicalQaSummary(job.technicalQa),
      evidencePackage: normalizeEvidencePackageSummary(job.evidencePackage),
      humanReviewGate: job.humanReviewGate ? publicHumanReviewGate(job.humanReviewGate) : null,
      renderPlanSummary: publicRenderPlanSummary(job.editPlan),
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
    };
    const publicSummary = publicJsonClone(summary);
    if (
      publicSummary &&
      publicSummary.renderPlanSummary &&
      job.editPlan &&
      typeof job.editPlan === "object"
    ) {
      publicSummary.renderPlanSummary.renderPolishQA = publicRenderPolishQaSummary(job.editPlan.renderPolishQA);
    }
    return publicSummary;
  }

  serializeJob(job) {
    const safe = jsonClone(job);
    return {
      id: safe.id,
      projectId: safe.projectId,
      uploadId: safe.uploadId || null,
      ownerId: safe.ownerId || null,
      action: safe.action,
      pipelineType: safe.pipelineType,
      idempotencyKey: safe.idempotencyKey || null,
      payload: normalizePayload(safe.payload, { action: safe.action, pipelineType: safe.pipelineType }),
      status: safe.status,
      progress: safe.progress,
      step: safe.step || null,
      error: normalizeError(safe.error),
      outputPath: safe.outputPath || null,
      exportId: safe.exportId || null,
      editPlan: jsonClone(safe.editPlan || null),
      candidatePlans: jsonClone(safe.candidatePlans || null),
      highlights: jsonClone(safe.highlights || null),
      mediaSignals: jsonClone(safe.mediaSignals || null),
      contentDraft: normalizeContentDraftSummary(safe.contentDraft),
      narratedRender: normalizeNarratedRenderSummary(safe.narratedRender),
      narrationAlignment: normalizeNarrationAlignmentSummary(safe.narrationAlignment),
      animationScenePlan: normalizeAnimationScenePlanSummary(safe.animationScenePlan),
      technicalQa: normalizeTechnicalQaSummary(safe.technicalQa),
      evidencePackage: normalizeEvidencePackageSummary(safe.evidencePackage),
      visualSignals: jsonClone(safe.visualSignals || null),
      scoreboardOcr: jsonClone(safe.scoreboardOcr || null),
      ocrQaCalibration: jsonClone(safe.ocrQaCalibration || null),
      goalEvidence: jsonClone(safe.goalEvidence || null),
      matchEventTruth: jsonClone(safe.matchEventTruth || null),
      humanReviewGate: safe.humanReviewGate ? publicHumanReviewGate(safe.humanReviewGate) : null,
      videoOutputQA: jsonClone(safe.videoOutputQA || null),
      renderedGoalProof: jsonClone(safe.renderedGoalProof || null),
      renderedGoalRebinding: jsonClone(safe.renderedGoalRebinding || null),
      renderedGoalCompaction: jsonClone(safe.renderedGoalCompaction || null),
      attempts: Number.isFinite(Number(safe.attempts)) ? Number(safe.attempts) : 0,
      workerId: safe.workerId || null,
      leaseId: safe.leaseId || null,
      claimedAt: safe.claimedAt || null,
      leaseExpiresAt: safe.leaseExpiresAt || null,
      lastHeartbeatAt: safe.lastHeartbeatAt || null,
      nextRetryAt: safe.nextRetryAt || null,
      backoffMs: validateOptionalBackoffMs(safe.backoffMs),
      lastRetryCode: safe.lastRetryCode || null,
      createdAt: safe.createdAt,
      updatedAt: safe.updatedAt,
    };
  }

  hydrateJob(record) {
    const job = this.validateRecord(record);
    return {
      ...job,
      _controller: new AbortController(),
    };
  }

  validateRecord(record) {
    if (!record || typeof record !== "object") {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const id = validateJobId(record.id);
    const projectId = validateRouteLikeId(record.projectId, "prj");
    const uploadId = record.uploadId ? validateRouteLikeId(record.uploadId, "upl") : null;
    const ownerId = record.ownerId ? normalizeOwnerId(record.ownerId) : null;
    const status = sanitizeText(record.status, 40);
    if (!JOB_STATUSES.includes(status)) {
      throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
    }
    const outputPath = validateOptionalStoragePath(record.outputPath, "render");
    const exportId = record.exportId ? validateRouteLikeId(record.exportId, "exp") : null;
    const attempts = Math.max(0, Math.floor(Number(record.attempts || 0)));
    const workerId = record.workerId ? validateWorkerId(record.workerId) : null;
    const leaseId = record.leaseId ? validateLeaseId(record.leaseId) : null;
    const action = sanitizeText(record.action || "generate", 60);
    const pipelineType = pipelineTypeForAction(action, record.pipelineType);
    if ((workerId && !leaseId) || (!workerId && leaseId)) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    return {
      id,
      projectId,
      uploadId,
      ownerId,
      action,
      pipelineType,
      idempotencyKey: record.idempotencyKey ? sanitizeText(record.idempotencyKey, 160) : null,
      payload: normalizePayload(record.payload, { action, pipelineType }),
      status,
      progress: clampProgress(record.progress ?? 0),
      step: record.step ? sanitizeText(record.step, 80) : null,
      error: normalizeError(record.error),
      outputPath,
      exportId,
      editPlan: jsonClone(record.editPlan || null),
      candidatePlans: jsonClone(record.candidatePlans || null),
      highlights: jsonClone(record.highlights || null),
      mediaSignals: jsonClone(record.mediaSignals || null),
      contentDraft: normalizeContentDraftSummary(record.contentDraft),
      narratedRender: normalizeNarratedRenderSummary(record.narratedRender),
      narrationAlignment: normalizeNarrationAlignmentSummary(record.narrationAlignment),
      animationScenePlan: normalizeAnimationScenePlanSummary(record.animationScenePlan),
      technicalQa: normalizeTechnicalQaSummary(record.technicalQa),
      evidencePackage: normalizeEvidencePackageSummary(record.evidencePackage),
      visualSignals: jsonClone(record.visualSignals || null),
      scoreboardOcr: jsonClone(record.scoreboardOcr || null),
      ocrQaCalibration: jsonClone(record.ocrQaCalibration || null),
      goalEvidence: jsonClone(record.goalEvidence || null),
      matchEventTruth: jsonClone(record.matchEventTruth || null),
      humanReviewGate: record.humanReviewGate ? publicHumanReviewGate(record.humanReviewGate) : null,
      videoOutputQA: jsonClone(record.videoOutputQA || null),
      renderedGoalProof: jsonClone(record.renderedGoalProof || null),
      renderedGoalRebinding: jsonClone(record.renderedGoalRebinding || null),
      renderedGoalCompaction: jsonClone(record.renderedGoalCompaction || null),
      attempts,
      workerId,
      leaseId,
      claimedAt: validateOptionalIsoTime(record.claimedAt),
      leaseExpiresAt: validateOptionalIsoTime(record.leaseExpiresAt),
      lastHeartbeatAt: validateOptionalIsoTime(record.lastHeartbeatAt),
      nextRetryAt: validateOptionalIsoTime(record.nextRetryAt),
      backoffMs: validateOptionalBackoffMs(record.backoffMs),
      lastRetryCode: record.lastRetryCode ? sanitizeText(record.lastRetryCode, 80) : null,
      createdAt: record.createdAt ? sanitizeText(record.createdAt, 40) : nowIso(),
      updatedAt: record.updatedAt ? sanitizeText(record.updatedAt, 40) : nowIso(),
    };
  }

  persist(job, event = "job_persisted", options = {}) {
    if (!this.persistEnabled || !job) return;
    const record = this.serializeJob(job);
    try {
      if (this.persistenceAdapter && options.lease && typeof this.persistenceAdapter.persistClaimedJob === "function") {
        this.persistenceAdapter.persistClaimedJob(record, { ...options.lease, nowMs: options.nowMs });
      } else if (this.persistenceAdapter) {
        this.persistenceAdapter.persistJob(record);
      } else {
        this.ensureJobDir();
        atomicWriteJson(this.jobPath(job.id), record);
      }
    } catch (error) {
      throw persistenceFailure(error);
    }
    logInfo(this.logger, {
      event,
      backend: this.backend,
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
      attempts: job.attempts,
    });
  }

  get(jobId) {
    return this.jobs.get(validateJobId(jobId)) || null;
  }

  all() {
    return [...this.jobs.values()];
  }

  byStatus(statuses) {
    const wanted = Array.isArray(statuses) ? statuses : [statuses];
    return this.all().filter((job) => wanted.includes(job.status));
  }

  queued() {
    return this.byStatus("queued");
  }

  rememberJob(job) {
    const existing = this.jobs.get(job.id);
    const target = existing || job;
    if (existing) Object.assign(existing, job);
    this.jobs.set(target.id, target);
    if (target.idempotencyKey) this.idempotency.set(target.idempotencyKey, target.id);
    return target;
  }

  isLeaseExpired(job, nowMs = Date.now()) {
    if (!job || job.status !== "processing") return false;
    const expiresMs = Date.parse(job.leaseExpiresAt || "");
    if (Number.isFinite(expiresMs)) return expiresMs <= nowMs;
    const heartbeatMs = Date.parse(job.lastHeartbeatAt || "");
    if (!Number.isFinite(heartbeatMs)) return true;
    return nowMs - heartbeatMs > this.staleProcessingMs;
  }

  assertLease(job, lease, options = {}) {
    if (!leaseMatches(job, lease)) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    if (this.isLeaseExpired(job, nowMs)) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    return leaseFromJob(job);
  }

  claimPatch(job, leaseInput) {
    const claimedAt = new Date(leaseInput.nowMs).toISOString();
    return {
      status: "processing",
      progress: Math.max(1, clampProgress(job.progress || 0)),
      step: job.step && job.step !== "queued" ? job.step : "queued",
      error: null,
      attempts: Number(job.attempts || 0) + 1,
      workerId: leaseInput.workerId,
      leaseId: leaseInput.leaseId,
      claimedAt,
      leaseExpiresAt: new Date(leaseInput.nowMs + leaseInput.leaseMs).toISOString(),
      lastHeartbeatAt: claimedAt,
      nextRetryAt: null,
      backoffMs: null,
    };
  }

  canClaim(job, nowMs = Date.now()) {
    if (!job) return false;
    if (job.status === "queued") {
      const retryAtMs = Date.parse(job.nextRetryAt || "");
      return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return false;
    return job.status === "processing" && this.isLeaseExpired(job, nowMs);
  }

  claimJob(jobId, options = {}) {
    const leaseInput = normalizeLeaseInput({ leaseMs: this.leaseDurationMs, ...options });
    if (this.persistenceAdapter && typeof this.persistenceAdapter.claimPersistedJob === "function") {
      let record;
      try {
        record = this.persistenceAdapter.claimPersistedJob({
          jobId,
          ...leaseInput,
          maxAttempts: this.maxAttempts,
        });
      } catch (error) {
        throw persistenceFailure(error);
      }
      if (!record) {
        const current = this.get(jobId);
        if (current && TERMINAL_JOB_STATUSES.includes(current.status)) {
          throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
        }
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      const job = this.rememberJob(this.hydrateJob(record));
      logInfo(this.logger, {
        event: "job_claimed",
        backend: this.backend,
        jobId: job.id,
        projectId: job.projectId,
        workerId: job.workerId,
        leaseId: job.leaseId,
        attempts: job.attempts,
        leaseExpiresAt: job.leaseExpiresAt,
      });
      return { job, lease: leaseFromJob(job) };
    }

    const job = this.get(jobId);
    if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) {
      throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
    }
    if (!this.canClaim(job, leaseInput.nowMs)) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    if (job.status === "processing" && Number(job.attempts || 0) >= this.maxAttempts) {
      this.recoverStaleJob(job, new Date(leaseInput.nowMs).toISOString());
      this.persist(job, "job_marked_stale");
      throw new AppError("JOB_STATE_INVALID", SAFE_MESSAGES.JOB_STATE_INVALID, 409);
    }
    this.update(job, this.claimPatch(job, leaseInput));
    logInfo(this.logger, {
      event: "job_claimed",
      backend: this.backend,
      jobId: job.id,
      projectId: job.projectId,
      workerId: job.workerId,
      leaseId: job.leaseId,
      attempts: job.attempts,
      leaseExpiresAt: job.leaseExpiresAt,
    });
    return { job, lease: leaseFromJob(job) };
  }

  claimNextJob(options = {}) {
    const leaseInput = normalizeLeaseInput({ leaseMs: this.leaseDurationMs, ...options });
    if (this.persistenceAdapter && typeof this.persistenceAdapter.claimPersistedJob === "function") {
      let record;
      try {
        record = this.persistenceAdapter.claimPersistedJob({ ...leaseInput, maxAttempts: this.maxAttempts });
      } catch (error) {
        throw persistenceFailure(error);
      }
      if (!record) return null;
      const job = this.rememberJob(this.hydrateJob(record));
      return { job, lease: leaseFromJob(job) };
    }

    const candidates = this.all()
      .filter((job) => this.canClaim(job, leaseInput.nowMs))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    for (const job of candidates) {
      try {
        return this.claimJob(job.id, leaseInput);
      } catch (error) {
        if (error.code !== "JOB_STATE_INVALID" && error.code !== "JOB_LEASE_INVALID") throw error;
      }
    }
    return null;
  }

  health(nowMs = Date.now()) {
    const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] || 0) + 1;
    }
    const leases = this.leaseHealth(nowMs);
    return {
      mode: this.persistenceAdapter ? "adapter" : this.backend,
      backend: this.backend,
      queueBackend: this.backend,
      claimingSupported: true,
      persisted: this.persistEnabled,
      total: this.jobs.size,
      statuses: counts,
      active: counts.queued + counts.processing,
      staleProcessing: this.all().filter((job) => this.isStale(job, nowMs)).length,
      activeLeases: leases.active,
      expiredLeases: leases.expired,
      retryScheduled: this.all().filter((job) => job.status === "queued" && Number.isFinite(Date.parse(job.nextRetryAt || "")) && Date.parse(job.nextRetryAt) > nowMs).length,
      leaseDurationMs: this.leaseDurationMs,
      leases,
      maxAttempts: this.maxAttempts,
      staleProcessingMs: this.staleProcessingMs,
      repository: this.jobRepositoryHealth(),
    };
  }

  leaseHealth(nowMs = Date.now()) {
    let active = 0;
    let expired = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "processing" || !job.leaseId || !job.workerId) continue;
      if (this.isLeaseExpired(job, nowMs)) expired += 1;
      else active += 1;
    }
    return {
      supported: true,
      backend: this.backend,
      active,
      expired,
    };
  }

  jobRepositoryHealth() {
    if (!this.persistenceAdapter || typeof this.persistenceAdapter.health !== "function") {
      return {
        ready: true,
        backend: this.backend,
      };
    }
    try {
      const health = this.persistenceAdapter.health();
      const jobs = health && health.repositories ? health.repositories.jobs : null;
      return {
        ready: Boolean(health && health.ready && (!jobs || jobs.ready)),
        backend: this.backend,
        total: jobs && typeof jobs.total === "number" ? jobs.total : undefined,
      };
    } catch {
      return {
        ready: false,
        backend: this.backend,
      };
    }
  }

  update(job, patch) {
    return this.applyUpdate(job, patch);
  }

  applyUpdate(job, patch, persistOptions = {}) {
    if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
    const previous = this.serializeJob(job);
    const next = { ...patch };
    assertTerminalMutationAllowed(job, next);
    const previousStatus = job.status;
    const hasNextStatus = Object.prototype.hasOwnProperty.call(next, "status");
    if (hasNextStatus) {
      assertTransition(job.status, next.status);
    }
    if (Object.prototype.hasOwnProperty.call(next, "progress")) {
      next.progress = clampProgress(next.progress);
    }
    if (Object.prototype.hasOwnProperty.call(next, "attempts")) {
      next.attempts = Math.max(0, Math.floor(Number(next.attempts || 0)));
    }
    const nextStatus = hasNextStatus ? next.status : job.status;
    if (nextStatus === "processing") {
      if (previousStatus !== "processing" && !Object.prototype.hasOwnProperty.call(next, "attempts")) {
        next.attempts = Number(job.attempts || 0) + 1;
      }
      if (!Object.prototype.hasOwnProperty.call(next, "lastHeartbeatAt")) {
        next.lastHeartbeatAt = nowIso();
      }
      if (!Object.prototype.hasOwnProperty.call(next, "error")) {
        next.error = null;
      }
    }
    if (next.payload) next.payload = normalizePayload(next.payload, { action: job.action, pipelineType: job.pipelineType });
    if (next.contentDraft) next.contentDraft = normalizeContentDraftSummary(next.contentDraft);
    if (next.narratedRender) next.narratedRender = normalizeNarratedRenderSummary(next.narratedRender);
    if (next.narrationAlignment) next.narrationAlignment = normalizeNarrationAlignmentSummary(next.narrationAlignment);
    if (next.animationScenePlan) next.animationScenePlan = normalizeAnimationScenePlanSummary(next.animationScenePlan);
    if (next.technicalQa) next.technicalQa = normalizeTechnicalQaSummary(next.technicalQa);
    if (next.evidencePackage) next.evidencePackage = normalizeEvidencePackageSummary(next.evidencePackage);
    if (next.error) next.error = normalizeError(next.error);
    Object.assign(job, next, { updatedAt: nowIso() });
    try {
      this.persist(job, persistOptions.event || "job_persisted", persistOptions);
    } catch (error) {
      Object.assign(job, this.hydrateJob(previous));
      throw error;
    }
    return job;
  }

  updateWithLease(job, patch, lease, options = {}) {
    this.assertLease(job, lease, options);
    return this.applyUpdate(job, patch, { lease, nowMs: options.nowMs, event: options.event || "job_lease_updated" });
  }

  heartbeat(job) {
    return this.update(job, { lastHeartbeatAt: nowIso() });
  }

  heartbeatWithLease(job, lease, options = {}) {
    const leaseMs = validateLeaseDurationMs(options.leaseMs || this.leaseDurationMs);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const now = new Date(nowMs).toISOString();
    return this.updateWithLease(job, {
      lastHeartbeatAt: now,
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    }, lease, { ...options, event: "job_lease_renewed", nowMs });
  }

  fail(job, error) {
    const code = error.code || "RENDER_FAILED";
    this.update(job, {
      status: "failed",
      error: {
        code,
        message: error.userMessage || SAFE_MESSAGES[code] || SAFE_MESSAGES.RENDER_FAILED,
        details: error.details || null,
      },
      step: "failed",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
  }

  failWithLease(job, error, lease, options = {}) {
    const code = error.code || "RENDER_FAILED";
    this.updateWithLease(job, {
      status: "failed",
      error: {
        code,
        message: error.userMessage || SAFE_MESSAGES[code] || SAFE_MESSAGES.RENDER_FAILED,
      },
      step: "failed",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
    }, lease, { ...options, event: "job_lease_failed" });
  }

  retryWithLease(job, error, lease, options = {}) {
    const code = error.code || "UNEXPECTED";
    const nextRetryAt = validateOptionalIsoTime(options.nextRetryAt);
    const backoffMs = validateOptionalBackoffMs(options.backoffMs);
    this.updateWithLease(job, {
      status: "queued",
      progress: 0,
      error: {
        code: "JOB_RETRY_SCHEDULED",
        message: SAFE_MESSAGES.JOB_RETRY_SCHEDULED,
      },
      step: "queued",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      nextRetryAt,
      backoffMs,
      lastRetryCode: sanitizeText(code, 80),
    }, lease, { ...options, event: "job_retry_scheduled" });
  }

  complete(job, patch) {
    this.update(job, {
      ...patch,
      status: "completed",
      progress: 100,
      error: null,
      step: patch?.step || "completed",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      backoffMs: null,
    });
  }

  completeWithLease(job, patch, lease, options = {}) {
    this.updateWithLease(job, {
      ...patch,
      status: "completed",
      progress: 100,
      error: null,
      step: patch?.step || "completed",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      backoffMs: null,
    }, lease, { ...options, event: "job_lease_completed" });
  }

  cancel(jobId) {
    const job = this.get(jobId);
    if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
    if (!ACTIVE_JOB_STATUSES.includes(job.status)) {
      throw new AppError("CANCEL_NOT_SUPPORTED", SAFE_MESSAGES.CANCEL_NOT_SUPPORTED, 409);
    }
    job._controller.abort();
    this.update(job, {
      status: "cancelled",
      error: { code: "JOB_CANCELLED", message: SAFE_MESSAGES.JOB_CANCELLED },
      step: "cancelled",
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
    return job;
  }

  isStale(job, nowMs) {
    if (job.status !== "processing") return false;
    if (job.leaseExpiresAt) return this.isLeaseExpired(job, nowMs);
    const heartbeatMs = Date.parse(job.lastHeartbeatAt || "");
    if (!Number.isFinite(heartbeatMs)) return true;
    return nowMs - heartbeatMs > this.staleProcessingMs;
  }

  recoverStaleJob(job, now = nowIso()) {
    if (Number(job.attempts || 0) < this.maxAttempts) {
      Object.assign(job, {
        status: "queued",
        progress: 0,
        step: "queued",
        error: { code: "JOB_RETRY_SCHEDULED", message: SAFE_MESSAGES.JOB_RETRY_SCHEDULED },
        workerId: null,
        leaseId: null,
        claimedAt: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        nextRetryAt: null,
        backoffMs: null,
        updatedAt: now,
      });
      logInfo(this.logger, {
        event: "job_retry_scheduled",
        jobId: job.id,
        projectId: job.projectId,
        attempts: job.attempts,
      });
      return "queued";
    }
    Object.assign(job, {
      status: "failed",
      step: "failed",
      error: { code: "JOB_STALE", message: SAFE_MESSAGES.JOB_STALE },
      workerId: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
    logInfo(this.logger, {
      event: "job_marked_stale",
      jobId: job.id,
      projectId: job.projectId,
      attempts: job.attempts,
    });
    return "failed";
  }

  recover(options = {}) {
    if (!this.persistEnabled) return { records: 0, ignored: 0, queued: 0, failed: 0, terminal: 0 };
    this.jobs.clear();
    this.idempotency.clear();
    const nowMs = options.nowMs || Date.now();
    const summary = { records: 0, ignored: 0, queued: 0, failed: 0, terminal: 0 };
    if (this.persistenceAdapter) {
      return this.recoverFromAdapter({ nowMs, summary });
    }
    this.ensureJobDir();
    for (const fileName of readdirSync(this.jobDir).sort()) {
      if (!fileName.endsWith(".json")) continue;
      let record;
      let job;
      try {
        validatePersistedFileName(fileName);
        record = JSON.parse(readFileSync(join(this.jobDir, fileName), "utf8"));
        job = this.hydrateJob(record);
      } catch (error) {
        summary.ignored += 1;
        logWarn(this.logger, {
          event: "job_recovery_skipped",
          fileName: basename(fileName),
          code: error.code || "JOB_RECORD_INVALID",
        });
        continue;
      }
      if (this.isStale(job, nowMs)) {
        const outcome = this.recoverStaleJob(job);
        summary[outcome] += 1;
      } else if (job.status === "queued") {
        summary.queued += 1;
      } else if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        summary.terminal += 1;
      }
      this.jobs.set(job.id, job);
      if (job.idempotencyKey && !this.idempotency.has(job.idempotencyKey)) {
        this.idempotency.set(job.idempotencyKey, job.id);
      }
      this.persist(job, "job_recovered");
      summary.records += 1;
    }
    return summary;
  }

  recoverFromAdapter({ nowMs, summary }) {
    let records;
    try {
      records = this.persistenceAdapter.listPersistedJobs();
    } catch (error) {
      throw persistenceFailure(error);
    }
    for (const record of Array.isArray(records) ? records : []) {
      let job;
      try {
        job = this.hydrateJob(record);
      } catch (error) {
        summary.ignored += 1;
        logWarn(this.logger, {
          event: "job_recovery_skipped",
          backend: this.backend,
          code: error.code || "JOB_RECORD_INVALID",
        });
        continue;
      }
      if (this.isStale(job, nowMs)) {
        const outcome = this.recoverStaleJob(job);
        summary[outcome] += 1;
      } else if (job.status === "queued") {
        summary.queued += 1;
      } else if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        summary.terminal += 1;
      }
      this.jobs.set(job.id, job);
      if (job.idempotencyKey && !this.idempotency.has(job.idempotencyKey)) {
        this.idempotency.set(job.idempotencyKey, job.id);
      }
      this.persist(job, "job_recovered");
      summary.records += 1;
    }
    return summary;
  }
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  DEFAULT_RECOVERY_POLICY,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  JobStore,
  idempotencyKey,
  validateJobId,
  validateLeaseId,
  validateWorkerId,
};
