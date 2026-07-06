const { randomUUID, createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { normalizeOwnerId } = require("./auth.cjs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { normalizeSmokeSource } = require("./staging-smoke-metadata.cjs");

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function idempotencyKey(action, payload) {
  const hash = createHash("sha256").update(stableStringify(payload || {})).digest("hex").slice(0, 20);
  return `${action}-${hash}`;
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
      publicPlan[key] = publicJsonClone(sourceJob.editPlan[key]);
    }
  }
  publicJob.editPlan = publicPlan;
  return publicJob;
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;
}

function safeStringList(values, limit = 10, maxLength = 80) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, limit);
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

function publicRenderPlanSummary(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const segments = Array.isArray(plan.segments)
    ? plan.segments.slice(0, 12).map((segment, index) => ({
        index: index + 1,
        id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
        goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Math.round(Number(segment.goalNumber)) : null,
        highlightType: sanitizeText(segment.highlightType || "", 80) || null,
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
    ? publicJsonClone(plan.renderedGoalProof)
    : null;
  const renderedGoalRebinding = plan.renderedGoalRebinding && typeof plan.renderedGoalRebinding === "object" && !Array.isArray(plan.renderedGoalRebinding)
    ? publicJsonClone(plan.renderedGoalRebinding)
    : null;
  const renderedGoalCompaction = plan.renderedGoalCompaction && typeof plan.renderedGoalCompaction === "object" && !Array.isArray(plan.renderedGoalCompaction)
    ? publicJsonClone(plan.renderedGoalCompaction)
    : null;
  return {
    mode: sanitizeText(plan.mode || "", 80) || null,
    highlightType: sanitizeText(plan.highlightType || "", 80) || null,
    totalDuration: safeNumber(plan.totalDuration),
    segmentCount: Array.isArray(plan.segments) ? plan.segments.length : 0,
    captionCount: Array.isArray(plan.captions) ? plan.captions.length : 0,
    animationCueCount: Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
    stylePreset: sanitizeText(plan.stylePreset || "", 80) || null,
    framingMode: sanitizeText(plan.framingMode || "", 80) || null,
    styleTarget: sanitizeText(plan.styleTarget || "", 40) || null,
    editIntensity: sanitizeText(plan.editIntensity || "", 40) || null,
    cropPlanMode: sanitizeText(plan.cropPlan && plan.cropPlan.mode ? plan.cropPlan.mode : "", 80) || null,
    goalSelectionMode: sanitizeText(plan.goalSelectionMode || "", 80) || null,
    segments,
    videoOutputQA,
    renderedGoalProof,
    renderedGoalRebinding,
    renderedGoalCompaction,
    visualPolishQA: plan.visualPolishQA && typeof plan.visualPolishQA === "object" ? publicJsonClone(plan.visualPolishQA) : null,
    renderPolishQA: plan.renderPolishQA && typeof plan.renderPolishQA === "object" ? publicJsonClone(plan.renderPolishQA) : null,
    editAssembly: plan.editAssembly && typeof plan.editAssembly === "object" ? publicJsonClone(plan.editAssembly) : null,
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

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const normalized = {
    title: sanitizeText(payload.title || "ShortsEngine Short", 120),
    preset: sanitizeText(payload.preset || "hype", 40).toLowerCase(),
    language: sanitizeText(payload.language || "auto", 32) || "auto",
    styleTarget: normalizeStyleTarget(payload.styleTarget),
    editIntensity: normalizeEditIntensity(payload.editIntensity),
    stylePreset: normalizeRenderStylePreset(payload.stylePreset),
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

  create({ projectId, uploadId = null, action, idempotencyKey: key, payload = null, ownerId = null }) {
    const existingJob = this.findIdempotentJob(key);
    if (existingJob) return existingJob;
    const createdAt = nowIso();
    const job = {
      id: `job_${randomUUID()}`,
      projectId,
      uploadId,
      ownerId: ownerId ? normalizeOwnerId(ownerId) : null,
      action,
      idempotencyKey: key || null,
      payload: normalizePayload(payload),
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
    return restoreSafeEditPlanMetadata(publicJsonClone(publicSafe), safe);
  }

  publicJobSummary(job) {
    if (!job) return null;
    return publicJsonClone({
      id: job.id || null,
      projectId: job.projectId || null,
      uploadId: job.uploadId || null,
      action: job.action || null,
      status: job.status || null,
      progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
      step: job.step || null,
      progressMeta: job.progressMeta && typeof job.progressMeta === "object" && !Array.isArray(job.progressMeta)
        ? job.progressMeta
        : null,
      exportId: job.exportId || null,
      error: normalizeError(job.error),
      videoOutputQA: job.videoOutputQA || (job.editPlan && job.editPlan.videoOutputQA) || null,
      renderedGoalProof: job.renderedGoalProof || (job.editPlan && job.editPlan.renderedGoalProof) || null,
      renderedGoalRebinding: job.renderedGoalRebinding || (job.editPlan && job.editPlan.renderedGoalRebinding) || null,
      renderedGoalCompaction: job.renderedGoalCompaction || (job.editPlan && job.editPlan.renderedGoalCompaction) || null,
      renderPlanSummary: publicRenderPlanSummary(job.editPlan),
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
    });
  }

  serializeJob(job) {
    const safe = jsonClone(job);
    return {
      id: safe.id,
      projectId: safe.projectId,
      uploadId: safe.uploadId || null,
      ownerId: safe.ownerId || null,
      action: safe.action,
      idempotencyKey: safe.idempotencyKey || null,
      payload: normalizePayload(safe.payload),
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
    if ((workerId && !leaseId) || (!workerId && leaseId)) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    return {
      id,
      projectId,
      uploadId,
      ownerId,
      action: sanitizeText(record.action || "generate", 60),
      idempotencyKey: record.idempotencyKey ? sanitizeText(record.idempotencyKey, 160) : null,
      payload: normalizePayload(record.payload),
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
    if (next.payload) next.payload = normalizePayload(next.payload);
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
