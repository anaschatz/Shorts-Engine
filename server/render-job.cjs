const { randomUUID } = require("node:crypto");
const { existsSync, statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { createCandidateEditPlans, detectHighlights, extractMediaSignals } = require("./analysis.cjs");
const { validateEditPlan } = require("./edit-plan.cjs");
const { cleanupSampledFrames, extractSampledFrames, publicFrameSummary } = require("./frame-extraction.cjs");
const { analyzeGoalEvidence, mergeGoalEvidenceIntoVisualSignals, publicGoalEvidence } = require("./goal-evidence-provider.cjs");
const { analyzeMatchEventTruth, publicMatchEventTruth } = require("./match-event-truth.cjs");
const { sanitizeText } = require("./media.cjs");
const { extractAudio, renderShort } = require("./render.cjs");
const { loadOcrQaCalibration, publicOcrQaCalibration } = require("./ocr-qa-calibration.cjs");
const {
  analyzeScoreboardOcr,
  defaultScoreboardRegions,
  publicScoreboardOcr,
  validateScoreboardOcrOutput,
} = require("./scoreboard-ocr.cjs");
const { chooseTranscriptionProvider } = require("./transcription.cjs");
const { assertStoragePath, storagePath, writeJsonAtomic } = require("./storage.cjs");
const { analyzeTracking, publicTrackingProviderOutput } = require("./tracking-provider.cjs");
const { assertVideoOutputCoverage } = require("./video-output-gate.cjs");
const { analyzeFrames, publicVisualSignals, validateVisualSignals } = require("./vision.cjs");
const { analyzeVisualTracking, publicVisualTrackingSummary } = require("./visual-tracking.cjs");
const { isLocalVideoProofSource } = require("./staging-smoke-metadata.cjs");

const SCOREBUG_FIRST_OCR_BUDGET_MS = 45_000;
const VISUAL_WINDOW_OCR_BUDGET_MS = 30_000;
const SCOREBUG_FIRST_CHUNK_SECONDS = 90;
const SCOREBUG_FIRST_CHUNK_FRAME_COUNT = 4;
const SCOREBUG_FIRST_CHUNK_TIMEOUT_MS = 15_000;
const SCOREBUG_FIRST_MAX_TOTAL_OCR_BUDGET_MS = 180_000;
const SCOREBUG_FIRST_ROI_CANDIDATE_IDS = Object.freeze([
  "scorebug_broadcast_compact",
  "scorebug_left_compact",
  "scoreboard_top_left",
  "scoreboard_top_center",
  "scoreboard_top_right",
]);

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function createDefaultDependencies(overrides = {}) {
  const { LocalArtifactAdapter } = require("./adapters/local-artifact-adapter.cjs");
  const deps = {
    assertStoragePath,
    artifactStore: new LocalArtifactAdapter(),
    chooseTranscriptionProvider,
    analyzeFrames,
    assertVideoOutputCoverage,
    analyzeGoalEvidence,
    analyzeMatchEventTruth,
    analyzeScoreboardOcr,
    createCandidateEditPlans,
    createExportId: () => `exp_${randomUUID()}`,
    detectHighlights,
    extractAudio,
    extractSampledFrames,
    loadOcrQaCalibration,
    extractMediaSignals,
    fileExists: existsSync,
    analyzeTracking,
    analyzeVisualTracking,
    isRegularFile,
    logger: console,
    renderShort,
    scheduler: setImmediate,
    cleanupSampledFrames,
    storagePath,
    statFile: statSync,
    validateEditPlan,
    writeJsonAtomic,
    ...overrides,
  };
  if (!deps.artifactStore) deps.artifactStore = new LocalArtifactAdapter();
  return deps;
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ocrStepBudgetMs(deps, key, fallback) {
  const budgets = deps && deps.scoreboardOcrTimeouts && typeof deps.scoreboardOcrTimeouts === "object"
    ? deps.scoreboardOcrTimeouts
    : {};
  const value = Number(budgets[key]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(250, Math.min(fallback, value));
}

function safeReasonList(values = [], max = 8) {
  return (Array.isArray(values) ? values : [])
    .map((reason) => sanitizeText(reason, 80))
    .filter(Boolean)
    .slice(0, max);
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : Boolean(value);
}

function safeGoalEvidenceCandidates(goalEvidence, max = 12) {
  const events = Array.isArray(goalEvidence && goalEvidence.events) ? goalEvidence.events : [];
  return events.slice(0, max).map((event, index) => ({
    index: index + 1,
    id: sanitizeText(event && event.id || `goal_evidence_${index + 1}`, 80),
    outcomeHint: sanitizeText(event && event.outcomeHint || "unknown", 48),
    start: safeNumber(event && event.start),
    end: safeNumber(event && event.end),
    confidence: safeNumber(event && event.confidence),
    reasonCodes: Array.isArray(event && event.reasonCodes)
      ? event.reasonCodes.map((reason) => sanitizeText(reason, 64)).filter(Boolean).slice(0, 12)
      : [],
    missingEvidence: Array.isArray(event && event.missingEvidence)
      ? event.missingEvidence.map((reason) => sanitizeText(reason, 64)).filter(Boolean).slice(0, 8)
      : [],
    recoveryEligibility: sanitizeText(event && event.recoveryEligibility || "not_recoverable", 60),
    rejectionReason: event && event.rejectionReason ? sanitizeText(event.rejectionReason, 80) : null,
    combinedGoalConfirmation: Boolean(event && event.combinedGoalConfirmation),
    replayGoalConfirmation: Boolean(event && event.replayGoalConfirmation),
    crowdReactionSupport: Boolean(event && event.crowdReactionSupport),
    offsideFlag: Boolean(event && event.offsideFlag),
    noGoalSignal: Boolean(event && event.VARNoGoalSignal),
  }));
}

function missingEvidenceByCandidate(candidates = [], max = 12) {
  return (Array.isArray(candidates) ? candidates : [])
    .slice(0, max)
    .map((candidate, index) => ({
      index: index + 1,
      id: sanitizeText(candidate && candidate.id || `goal_evidence_${index + 1}`, 80),
      outcomeHint: sanitizeText(candidate && candidate.outcomeHint || "unknown", 48),
      start: safeNumber(candidate && candidate.start),
      end: safeNumber(candidate && candidate.end),
      missingEvidence: safeReasonList(candidate && candidate.missingEvidence, 8),
      rejectionReason: candidate && candidate.rejectionReason ? sanitizeText(candidate.rejectionReason, 80) : null,
    }))
    .filter((candidate) => candidate.missingEvidence.length > 0 || candidate.rejectionReason);
}

function topRejectionReasons(candidates = [], max = 8) {
  const counts = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const reasons = [
      candidate && candidate.rejectionReason,
      ...safeReasonList(candidate && candidate.missingEvidence, 4),
    ].filter(Boolean);
    for (const reason of reasons) {
      const safe = sanitizeText(reason, 80);
      if (!safe) continue;
      counts.set(safe, (counts.get(safe) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([reason, count]) => ({ reason, count }));
}

function scoreboardOcrEnabledForTrace(scoreboardOcr) {
  const mode = sanitizeText(scoreboardOcr && scoreboardOcr.providerMode || "", 80);
  if (!mode) return false;
  return ![
    "deterministic-scoreboard-ocr",
    "external-scoreboard-ocr-disabled",
  ].includes(mode);
}

function stableScoreChangeCount(scoreboardOcr) {
  const evidence = Array.isArray(scoreboardOcr && scoreboardOcr.evidence) ? scoreboardOcr.evidence : [];
  const stableEvidenceCount = evidence.filter((item) => (
    item &&
    item.scoreChanged &&
    item.temporalConsistency &&
    !item.ambiguous &&
    !item.scoreReverted
  )).length;
  if (stableEvidenceCount > 0) return stableEvidenceCount;
  const timeline = scoreboardOcr && scoreboardOcr.summary && Array.isArray(scoreboardOcr.summary.scoreTimeline)
    ? scoreboardOcr.summary.scoreTimeline
    : [];
  return timeline.filter((item) => (
    item &&
    item.status === "score_changed" &&
    item.temporalConsistency
  )).length;
}

function goalEvidenceTraceNextAction({ scoreboardOcr, stableChanges, countedGoalEvents }) {
  const summary = scoreboardOcr && scoreboardOcr.summary ? scoreboardOcr.summary : {};
  if (!scoreboardOcrEnabledForTrace(scoreboardOcr)) {
    return "enable-live-scoreboard-ocr-with-SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR-1-and-local-ocr-runtime";
  }
  if (safeNumber(summary.evidenceCount) === 0) {
    return "inspect-scoreboard-ocr-crops-or-enable-SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS-1-for-local-debug";
  }
  if (stableChanges === 0) {
    return "inspect-score-timeline-for-unreadable-or-ambiguous-scorebug";
  }
  if (countedGoalEvents === 0) {
    return "connect-stable-score-changes-to-live-action-windows-before-render";
  }
  return "inspect-valid-goal-selection-evidence-trace";
}

function safeOcrChunkSummary(scoreboardOcr = null) {
  const summary = scoreboardOcr && scoreboardOcr.summary ? scoreboardOcr.summary : {};
  const chunkSummary = summary && summary.chunkSummary && typeof summary.chunkSummary === "object" && !Array.isArray(summary.chunkSummary)
    ? summary.chunkSummary
    : null;
  if (!chunkSummary) return null;
  return {
    mode: sanitizeText(chunkSummary.mode || "chunked_scorebug_first_ocr", 60),
    chunkCount: safeNumber(chunkSummary.chunkCount),
    scannedChunks: safeNumber(chunkSummary.scannedChunks),
    skippedChunks: safeNumber(chunkSummary.skippedChunks),
    timedOutChunks: safeNumber(chunkSummary.timedOutChunks),
    failedChunks: safeNumber(chunkSummary.failedChunks),
    scannedDurationSeconds: safeNumber(chunkSummary.scannedDurationSeconds),
    discoveredScoreChanges: safeNumber(chunkSummary.discoveredScoreChanges),
    totalBudgetMs: safeNumber(chunkSummary.totalBudgetMs),
    chunkTimeoutMs: safeNumber(chunkSummary.chunkTimeoutMs),
    chunks: Array.isArray(chunkSummary.chunks)
      ? chunkSummary.chunks.slice(0, 12).map((chunk, index) => ({
          index: safeNumber(chunk && chunk.index) || index + 1,
          start: safeNumber(chunk && chunk.start),
          end: safeNumber(chunk && chunk.end),
          status: sanitizeText(chunk && chunk.status || "unknown", 40),
          plannedFrameCount: safeNumber(chunk && chunk.plannedFrameCount),
          sampledFrameCount: safeNumber(chunk && chunk.sampledFrameCount),
          attemptedRoiCount: safeNumber(chunk && chunk.attemptedRoiCount),
          attemptedObservationCount: safeNumber(chunk && chunk.attemptedObservationCount),
          evidenceCount: safeNumber(chunk && chunk.evidenceCount),
          scoreChangeCount: safeNumber(chunk && chunk.scoreChangeCount),
          skippedReason: chunk && chunk.skippedReason ? sanitizeText(chunk.skippedReason, 80) : null,
        }))
      : [],
  };
}

function localSourceReady(context = {}, deps = {}) {
  const inputPath = context.inputPath;
  if (!inputPath) return false;
  try {
    const exists = typeof deps.fileExists === "function" ? deps.fileExists(inputPath) : existsSync(inputPath);
    const regular = typeof deps.isRegularFile === "function" ? deps.isRegularFile(inputPath) : isRegularFile(inputPath);
    return Boolean(exists && regular);
  } catch {
    return false;
  }
}

function buildValidGoalSelectionFailureDetails({
  context = {},
  deps = {},
  scoreboardOcr = null,
  goalEvidence = null,
  matchEventTruth = null,
  goalDiscovery = null,
  goalEvidenceCandidates = [],
  stableChanges = 0,
  countedGoalEvents = 0,
} = {}) {
  const scoreboardSummary = scoreboardOcr && scoreboardOcr.summary ? scoreboardOcr.summary : {};
  const goalEvidenceSummary = goalEvidence && goalEvidence.summary ? goalEvidence.summary : {};
  const truthSummary = matchEventTruth && matchEventTruth.summary ? matchEventTruth.summary : {};
  const candidates = Array.isArray(goalEvidenceCandidates) && goalEvidenceCandidates.length
    ? goalEvidenceCandidates
    : safeGoalEvidenceCandidates(goalEvidence);
  const missingByCandidate = missingEvidenceByCandidate(candidates);
  const chunkSummary = safeOcrChunkSummary(scoreboardOcr);
  const scoreChangesFound = safeNumber(scoreboardSummary.scoreChangeCount) ?? stableChanges ?? 0;
  const discoveredCountedGoals = safeNumber(truthSummary.countedGoalEventCount) ?? countedGoalEvents ?? 0;
  const candidateCount = candidates.length || safeNumber(goalEvidenceSummary.eventCount) || 0;
  const rejectedCandidateCount = safeNumber(goalEvidenceSummary.rejectedCandidateCount) ??
    candidates.filter((candidate) => candidate && (candidate.rejectionReason || safeReasonList(candidate.missingEvidence).length)).length;
  return {
    phase: "planning",
    step: "create_edit_plan",
    substep: "build_edit_plan",
    sourceType: sanitizeText((context.source && context.source.sourceType) || context.metadata?.sourceType || "upload", 40),
    sourceDuration: safeNumber(context.metadata && context.metadata.durationSeconds),
    sourceValidated: Boolean(context.metadata && context.metadata.durationSeconds),
    downloadedSourceReady: localSourceReady(context, deps),
    scoreboardOcrAttempted: Boolean(scoreboardOcr),
    scoreboardOcrEnabled: scoreboardOcrEnabledForTrace(scoreboardOcr),
    scoreboardOcrProviderMode: scoreboardOcr && scoreboardOcr.providerMode ? sanitizeText(scoreboardOcr.providerMode, 80) : null,
    scoreboardObservationCount: safeNumber(scoreboardSummary.evidenceCount) ?? 0,
    scoreboardSampledFrameCount: safeNumber(scoreboardSummary.sampledFrameCount) ?? 0,
    scoreChangeCount: safeNumber(scoreboardSummary.scoreChangeCount) ?? 0,
    stableScoreChangeCount: safeNumber(stableChanges) ?? 0,
    chunksScanned: safeNumber(chunkSummary && chunkSummary.scannedChunks) ?? 0,
    chunkCount: safeNumber(chunkSummary && chunkSummary.chunkCount) ?? 0,
    skippedChunks: safeNumber(chunkSummary && chunkSummary.skippedChunks) ?? 0,
    timedOutChunks: safeNumber(chunkSummary && chunkSummary.timedOutChunks) ?? 0,
    scoreChangesFound,
    countedGoalEventCount: discoveredCountedGoals,
    discoveredCountedGoals,
    expectedCountedGoals: safeNumber(context.metadata && context.metadata.expectedCountedGoals),
    visualWindowCount: safeNumber(goalDiscovery && goalDiscovery.visualWindowCount) ?? 0,
    bucketCount: safeNumber(goalDiscovery && goalDiscovery.bucketCount) ?? 0,
    lateBucketInspected: safeBoolean(goalDiscovery && goalDiscovery.lateBucketInspected),
    selectedValidGoalCount: Array.isArray(goalDiscovery && goalDiscovery.selectedValidGoals)
      ? goalDiscovery.selectedValidGoals.length
      : 0,
    candidateCount,
    rejectedCandidateCount,
    topRejectionReasons: topRejectionReasons(candidates),
    missingEvidenceByCandidate: missingByCandidate,
    goalEvidenceCandidates: candidates.slice(0, 12),
    goalEvidenceEventCount: safeNumber(goalEvidenceSummary.eventCount) ?? 0,
    validGoalEvidenceCount: safeNumber(goalEvidenceSummary.validGoalCount) ?? 0,
    offsideOrNoGoalEvidenceCount: safeNumber(goalEvidenceSummary.offsideOrNoGoalCount) ?? 0,
    celebrationOnlyEvidenceCount: safeNumber(goalEvidenceSummary.celebrationOnlyCount) ?? 0,
    anthemOrIntroEvidenceCount: safeNumber(goalEvidenceSummary.anthemOrIntroCount) ?? 0,
    ocrEvidenceCount: safeNumber(goalEvidenceSummary.ocrEvidenceCount),
    scoreboardConfirmedGoalCount: safeNumber(goalEvidenceSummary.scoreboardConfirmedGoalCount),
    recoverableGoalEvidenceCandidateCount: safeNumber(goalEvidenceSummary.recoverableCandidateCount),
    matchEventTruthConfirmedGoalCount: safeNumber(truthSummary.confirmedGoalCount),
    matchEventTruthDisallowedGoalCount: safeNumber(truthSummary.disallowedGoalCount),
    matchEventTruthPossibleGoalCount: safeNumber(truthSummary.possibleGoalCount),
    matchEventTruthScoreTimelineObservationCount: safeNumber(truthSummary.scoreTimelineObservationCount),
    matchEventTruthScoreChangeCount: safeNumber(truthSummary.scoreChangeCount),
    matchEventTruthCountedGoalEventCount: safeNumber(truthSummary.countedGoalEventCount),
    matchEventTruthDisallowedGoalEventCount: safeNumber(truthSummary.disallowedGoalEventCount),
    matchEventTruthSelectedGoalCount: safeNumber(truthSummary.selectedGoalCount),
    matchEventTruthScoreChangeAnchorsFound: safeNumber(truthSummary.scoreChangeAnchorsFound),
    matchEventTruthStableScoreChangeAnchorCount: safeNumber(truthSummary.stableScoreChangeAnchorCount),
    matchEventTruthRevertedScoreChangeAnchorCount: safeNumber(truthSummary.revertedScoreChangeAnchorCount),
    matchEventTruthAnchorsLinkedToGoalPhaseCount: safeNumber(truthSummary.anchorsLinkedToGoalPhaseCount),
    matchEventTruthAnchorsMissingVisualSupportCount: safeNumber(truthSummary.anchorsMissingVisualSupportCount),
    matchEventTruthAnchorsWithLiveActionEvidence: safeNumber(truthSummary.anchorsWithLiveActionEvidence),
    matchEventTruthAnchorsRejected: safeNumber(truthSummary.anchorsRejected),
    matchEventTruthSelectedCountedGoals: safeNumber(truthSummary.selectedCountedGoals),
    matchEventTruthOcrOnlyBlockedCount: safeNumber(truthSummary.ocrOnlyBlockedCount),
    matchEventTruthMissingActionEvidenceCount: safeNumber(truthSummary.missingActionEvidenceCount),
    matchEventTruthMissedGoalReasons: safeReasonList(truthSummary.missedGoalReasons, 8),
    matchEventTruthScoreChangeAnchors: Array.isArray(matchEventTruth && matchEventTruth.scoreChangeAnchors)
      ? matchEventTruth.scoreChangeAnchors.slice(0, 12)
      : [],
    ocrChunkSummary: chunkSummary,
    nextAction: goalEvidenceTraceNextAction({ scoreboardOcr, stableChanges, countedGoalEvents: discoveredCountedGoals }),
  };
}

function resolveLocalArtifactPath(artifactStore, artifact) {
  if (artifactStore && typeof artifactStore.resolveLocalPath === "function") {
    return artifactStore.resolveLocalPath(artifact);
  }
  if (artifactStore && typeof artifactStore.resolveArtifact === "function") {
    return artifactStore.resolveArtifact(artifact);
  }
  return artifactStore.resolve(artifact);
}

function localPathForNewArtifact(artifactStore, input) {
  return artifactStore.createOutputStage(input.type, input);
}

function assertUploadReady(upload, deps) {
  if (!upload || typeof upload !== "object" || !upload.id || (!upload.path && !upload.artifact && !upload.storageKey) || !upload.metadata) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const inputArtifact = upload.artifact
    ? deps.artifactStore.createRecord(upload.artifact)
    : deps.artifactStore.createRecord({
        id: upload.id,
        type: "upload",
        ownerProjectId: upload.projectId,
        storageKey: upload.storageKey || `${upload.id}.${upload.extension || "mp4"}`,
        size: upload.byteSize,
        status: "available",
        createdAt: upload.createdAt,
      });
  const hasExplicitArtifact = Boolean(upload.artifact || upload.storageKey);
  let inputStage;
  let inputPath;
  if (!hasExplicitArtifact && upload.path) {
    inputPath = deps.assertStoragePath(upload.path, "uploads");
    inputStage = {
      id: `stage_${upload.id}`,
      purpose: "input",
      adapterMode: "legacy-local",
      artifact: null,
      localPath: inputPath,
      permanentLocal: true,
      cleanupRequired: false,
      createdAt: nowIso(),
    };
  } else {
    inputStage = deps.artifactStore.stageInputForProcessing(inputArtifact, { step: "stage_source_upload" });
    inputPath = inputStage.localPath;
    if (upload.path && inputStage.permanentLocal && inputPath !== deps.assertStoragePath(upload.path, "uploads")) {
      throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
    }
  }
  if (!deps.fileExists(inputPath) || !deps.isRegularFile(inputPath)) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const durationSeconds = Number(upload.metadata.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError("VALIDATION_ERROR", "Upload metadata is invalid.", 400);
  }
  return { inputArtifact, inputPath, inputStage, metadata: { ...upload.metadata, durationSeconds } };
}

function isYouTubeLongSource(source, metadata = {}) {
  const sourceType = (source && source.sourceType) || metadata.sourceType;
  return Boolean(
    sourceType === "youtube" &&
      Number(metadata.durationSeconds || 0) >= 120,
  );
}

function goalSelectionModeForSource(source, metadata = {}) {
  if (isLocalVideoProofSource(source)) return "valid_goals_only";
  return isYouTubeLongSource(source, metadata) ? "valid_goals_only" : "balanced";
}

function ocrQaCalibrationOptionsFromEnv(env = process.env) {
  const reportRef = sanitizeText(env && env.SHORTSENGINE_OCR_QA_REVIEW_REF, 160);
  return reportRef ? { reportRef } : {};
}

function assertPipelineContext({ job, project, upload, payload, deps }) {
  if (!job || !job.id || !job._controller) {
    throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
  }
  if (!project || !project.id || !project.uploadId) {
    throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  }
  if (!payload || typeof payload !== "object") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  if (upload && project.uploadId !== upload.id) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const { inputArtifact, inputPath, inputStage, metadata } = assertUploadReady(upload, deps);
  const title = sanitizeText(payload.title || project.title || "ShortsEngine Short", 120);
  const preset = sanitizeText(payload.preset || "hype", 40).toLowerCase();
  const language = sanitizeText(payload.language || "auto", 32) || "auto";
  const styleTarget = sanitizeText(payload.styleTarget || "vertical_9_16", 40).toLowerCase() || "vertical_9_16";
  const editIntensity = sanitizeText(payload.editIntensity || "balanced", 40).toLowerCase() || "balanced";
  const stylePreset = sanitizeText(payload.stylePreset || "social_sports_v1", 40).toLowerCase() || "social_sports_v1";
  const source = payload.source || project.source || upload.source || null;
  const goalSelectionMode = goalSelectionModeForSource(source, metadata);
  if (!title || !preset) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const approvedEditPlan = payload.approvedEditPlan
    ? deps.validateEditPlan(payload.approvedEditPlan, metadata)
    : null;
  const audioKey = `${job.id}.wav`;
  const subtitlesKey = `${job.id}.ass`;
  const outputKey = `${job.id}.mp4`;
  const audio = localPathForNewArtifact(deps.artifactStore, { type: "extracted_audio", storageKey: audioKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  const output = localPathForNewArtifact(deps.artifactStore, { type: "rendered_video", storageKey: outputKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  const subtitles = localPathForNewArtifact(deps.artifactStore, { type: "subtitle_temp", storageKey: subtitlesKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  return {
    audioKey,
    audioPath: audio.localPath,
    audioStage: audio,
    inputArtifact,
    inputPath,
    inputStage,
    language,
    metadata,
    outputKey,
    outputPath: output.localPath,
    outputStage: output,
    preset,
    source,
    subtitlesKey,
    subtitlesPath: subtitles.localPath,
    subtitlesStage: subtitles,
    stylePreset,
    styleTarget,
    editIntensity,
    title,
    goalSelectionMode,
    approvedEditPlan,
    regenerationApproval: payload.regenerationApproval && typeof payload.regenerationApproval === "object"
      ? {
          approvalId: sanitizeText(payload.regenerationApproval.approvalId || "", 80),
          regenerationPlanId: sanitizeText(payload.regenerationApproval.regenerationPlanId || "", 120),
          draftHash: sanitizeText(payload.regenerationApproval.draftHash || "", 80),
          draftRecordId: sanitizeText(payload.regenerationApproval.draftRecordId || "", 80),
          sourceJobId: sanitizeText(payload.regenerationApproval.sourceJobId || "", 120),
          sourceExportId: sanitizeText(payload.regenerationApproval.sourceExportId || "", 120),
          approvedAt: sanitizeText(payload.regenerationApproval.approvedAt || "", 80),
          approvedBy: sanitizeText(payload.regenerationApproval.approvedBy || "", 80),
        }
      : null,
  };
}

function normalizedCaption(caption, mediaDuration) {
  const start = Number(caption && caption.start);
  const end = Number(caption && caption.end);
  const text = sanitizeText(caption && caption.text, 160);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) return null;
  if (Number.isFinite(mediaDuration) && end > mediaDuration + 1) return null;
  return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text };
}

function validateTranscript(transcript, metadata = {}) {
  if (!transcript || typeof transcript !== "object") {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const mediaDuration = Number(metadata.durationSeconds || 0);
  const captions = Array.isArray(transcript.captions) ? transcript.captions.map((caption) => normalizedCaption(caption, mediaDuration)) : [];
  if (!captions.length || captions.some((caption) => !caption)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const segments = Array.isArray(transcript.segments)
    ? transcript.segments.map((segment) => normalizedCaption(segment, mediaDuration)).filter(Boolean)
    : [];
  return {
    ...transcript,
    provider: sanitizeText(transcript.provider || "unknown", 40),
    language: sanitizeText(transcript.language || "auto", 32) || "auto",
    text: sanitizeText(transcript.text || captions.map((caption) => caption.text).join(" "), 4000),
    captions,
    segments,
  };
}

function validateMediaSignals(signals, metadata = {}) {
  if (!signals || typeof signals !== "object") {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  const durationSeconds = Number(signals.durationSeconds || metadata.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  return {
    ...signals,
    durationSeconds,
    audioPeaks: Array.isArray(signals.audioPeaks) ? signals.audioPeaks : [],
    sceneChanges: Array.isArray(signals.sceneChanges) ? signals.sceneChanges : [],
    highMotionCandidates: Array.isArray(signals.highMotionCandidates) ? signals.highMotionCandidates : [],
  };
}

function candidateWindowTime(window = {}) {
  const parsed = Number(window.time ?? window.center ?? window.timestamp);
  if (Number.isFinite(parsed)) return parsed;
  const start = Number(window.start);
  const end = Number(window.end);
  return Number.isFinite(start) && Number.isFinite(end) ? (start + end) / 2 : Number.NaN;
}

function candidateWindowScore(window = {}) {
  const hints = new Set(Array.isArray(window.visualHints) ? window.visualHints : []);
  const weights = {
    shot_contact: 1,
    ball_toward_goal: 0.9,
    goal_mouth_visible: 0.82,
    ball_in_net: 1.2,
    scoreboard_goal_confirmed: 1.05,
    referee_goal_signal: 1.05,
    assistant_referee_flag: 0.9,
    offside_line_replay: 0.86,
    scoreboard_goal_removed: 0.86,
    var_check_graphic: 0.74,
    shot_like_motion: 0.46,
    ball_visible: 0.22,
    crowd_reaction: 0.14,
    replay_indicator: 0.1,
  };
  const hintScore = [...hints].reduce((sum, hint) => sum + (weights[hint] || 0), 0);
  return Number((Number(window.confidence || 0) + hintScore).toFixed(4));
}

function selectCandidateWindowCoverage(windows = [], duration = 0, maxWindows = 24) {
  const safeWindows = (Array.isArray(windows) ? windows : [])
    .filter((window) => Number.isFinite(candidateWindowTime(window)))
    .sort((a, b) => candidateWindowTime(a) - candidateWindowTime(b));
  const limit = Math.max(1, Math.min(24, Math.floor(Number(maxWindows) || 24)));
  if (safeWindows.length <= limit) return safeWindows;

  const mediaDuration = Math.max(0, Number(duration) || candidateWindowTime(safeWindows[safeWindows.length - 1]) || 0);
  const bucketCount = Math.min(8, Math.max(3, Math.ceil((mediaDuration || 180) / 60)));
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (const window of safeWindows) {
    const time = candidateWindowTime(window);
    const index = mediaDuration > 0
      ? Math.min(bucketCount - 1, Math.max(0, Math.floor(time / (mediaDuration / bucketCount))))
      : 0;
    buckets[index].push(window);
  }

  const selected = [];
  const seen = new Set();
  const keyFor = (window) => `${Number(candidateWindowTime(window)).toFixed(2)}:${window.source || ""}:${(window.visualHints || []).join(",")}`;
  const add = (window) => {
    if (!window || selected.length >= limit) return false;
    const key = keyFor(window);
    if (seen.has(key)) return false;
    selected.push(window);
    seen.add(key);
    return true;
  };
  const ranked = (items) => [...items]
    .sort((a, b) => candidateWindowScore(b) - candidateWindowScore(a) || candidateWindowTime(a) - candidateWindowTime(b));
  const lateBucketStart = Math.max(0, Math.floor(bucketCount * 0.66));

  for (let bucketIndex = lateBucketStart; bucketIndex < bucketCount; bucketIndex += 1) {
    for (const window of ranked(buckets[bucketIndex]).slice(0, 3)) add(window);
  }
  for (const bucket of buckets) add(ranked(bucket)[0]);
  for (const bucket of buckets) add(ranked(bucket).find((window) => !seen.has(keyFor(window))));
  for (const window of ranked(safeWindows)) add(window);

  return selected.sort((a, b) => candidateWindowTime(a) - candidateWindowTime(b));
}

function visualCandidateWindowsFromSignals(mediaSignals = {}) {
  const windows = [];
  const duration = Number(mediaSignals.durationSeconds || 0);
  const openingBoundary = duration >= 90 ? Math.min(45, Math.max(18, duration * 0.12)) : 0;
  const isPostOpening = (time) => !openingBoundary || Number(time || 0) > openingBoundary;
  for (const item of Array.isArray(mediaSignals.highMotionCandidates) ? mediaSignals.highMotionCandidates : []) {
    windows.push({
      time: item.time,
      confidence: item.confidence,
      source: item.source || "high_motion_candidate",
      visualHints: isPostOpening(item.time) ? ["shot_like_motion", "ball_visible"] : [],
    });
  }
  for (const item of Array.isArray(mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : []) {
    windows.push({
      time: item.time,
      confidence: Math.min(0.78, Number(item.energyScore || 0.55)),
      source: item.source || "audio_peak_context",
      visualHints: isPostOpening(item.time) && Number(item.energyScore || 0) >= 0.85 ? ["crowd_reaction"] : [],
    });
  }
  for (const item of Array.isArray(mediaSignals.sceneChanges) ? mediaSignals.sceneChanges : []) {
    windows.push({
      time: item.time,
      confidence: Math.min(0.72, Number(item.confidence || 0.5)),
      source: item.source || "scene_change_context",
      visualHints: isPostOpening(item.time) ? ["replay_indicator"] : [],
    });
  }
  return selectCandidateWindowCoverage(windows, duration);
}

function scoreChangeCandidateWindowsFromOcr(scoreboardOcr = {}, metadata = {}) {
  const evidence = Array.isArray(scoreboardOcr && scoreboardOcr.evidence) ? scoreboardOcr.evidence : [];
  const timeline = scoreboardOcr && scoreboardOcr.summary && Array.isArray(scoreboardOcr.summary.scoreTimeline)
    ? scoreboardOcr.summary.scoreTimeline
    : [];
  const windows = [];
  const push = (item = {}, index = 0) => {
    const timestamp = Number(item.timestamp ?? item.time ?? item.confirmedAt);
    if (!Number.isFinite(timestamp) || timestamp < 0) return;
    const scoreChanged = Boolean(item.scoreChanged || item.status === "score_changed");
    const temporalConsistency = item.temporalConsistency !== false;
    const scoreReverted = Boolean(item.scoreReverted || item.reverted || item.status === "goal_removed");
    if (!scoreChanged || !temporalConsistency || scoreReverted) return;
    windows.push({
      time: timestamp,
      confidence: Math.max(0.82, Math.min(0.98, Number(item.confidence || 0.86))),
      source: "scorebug_first_score_change",
      visualHints: ["scoreboard_goal_confirmed", "shot_like_motion", "goal_mouth_visible"],
      scoreBefore: item.scoreBefore || null,
      scoreAfter: item.scoreAfter || null,
      index: index + 1,
    });
  };
  evidence.forEach(push);
  if (!windows.length) timeline.forEach(push);
  return selectCandidateWindowCoverage(windows, Number(metadata.durationSeconds || 0), 12);
}

function mergeCandidateWindows(primary = [], secondary = [], metadata = {}, maxWindows = 24) {
  const merged = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])];
  return selectCandidateWindowCoverage(merged, Number(metadata.durationSeconds || 0), maxWindows);
}

function roundNumber(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, safe));
}

function candidateWindowOverlapsChunk(window = {}, chunk = {}) {
  const time = candidateWindowTime(window);
  if (Number.isFinite(time)) return time >= chunk.start && time <= chunk.end;
  const start = Number(window.start);
  const end = Number(window.end);
  return Number.isFinite(start) && Number.isFinite(end) && end >= chunk.start && start <= chunk.end;
}

function buildChunkSamplingWindows({ chunk, metadata = {}, candidateWindows = [], frameCount = SCOREBUG_FIRST_CHUNK_FRAME_COUNT } = {}) {
  const duration = Number(metadata.durationSeconds || 0);
  const start = clampNumber(chunk.start, 0, duration || chunk.end, 0);
  const end = clampNumber(chunk.end, start + 1, duration || chunk.end, start + 1);
  const chunkDuration = Math.max(1, end - start);
  const windows = [];
  const pushWindow = (time, input = {}) => {
    const timestamp = clampNumber(time, start, end, start);
    windows.push({
      timestamp: roundNumber(timestamp),
      start: roundNumber(clampNumber(input.start ?? timestamp - 1.2, start, end, start)),
      end: roundNumber(clampNumber(input.end ?? timestamp + 1.2, start, end, end)),
      confidence: roundNumber(clampNumber(input.confidence ?? 0.58, 0.05, 0.98, 0.58)),
      source: sanitizeText(input.source || "scorebug_chunk_periodic_sample", 48),
      visualHints: Array.isArray(input.visualHints)
        ? input.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
        : [],
    });
  };
  const baseFrameCount = Math.max(2, Math.min(8, Math.round(Number(frameCount) || SCOREBUG_FIRST_CHUNK_FRAME_COUNT)));
  for (let index = 0; index < baseFrameCount; index += 1) {
    pushWindow(start + ((index + 0.5) / baseFrameCount) * chunkDuration, {
      confidence: 0.54,
      source: "scorebug_chunk_periodic_sample",
    });
  }
  const inChunkCandidates = (Array.isArray(candidateWindows) ? candidateWindows : [])
    .filter((window) => candidateWindowOverlapsChunk(window, { start, end }))
    .sort((a, b) => candidateWindowScore(b) - candidateWindowScore(a))
    .slice(0, 3);
  for (const candidate of inChunkCandidates) {
    const time = candidateWindowTime(candidate);
    if (!Number.isFinite(time)) continue;
    for (const offset of [-4, 0, 8]) {
      pushWindow(time + offset, {
        start: Number(candidate.start),
        end: Number(candidate.end),
        confidence: Math.max(0.6, Number(candidate.confidence || 0.6)),
        source: "scorebug_chunk_candidate_sample",
        visualHints: candidate.visualHints,
      });
    }
  }
  const deduped = [];
  for (const window of windows.sort((a, b) => a.timestamp - b.timestamp)) {
    if (deduped.some((existing) => Math.abs(existing.timestamp - window.timestamp) < 1.25)) continue;
    deduped.push(window);
  }
  return deduped.slice(0, 12);
}

function buildScorebugOcrChunks({ metadata = {}, candidateWindows = [], config = {} } = {}) {
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  if (!duration) return [];
  const chunkSeconds = clampNumber(config.chunkSeconds, 30, 180, SCOREBUG_FIRST_CHUNK_SECONDS);
  const frameCount = clampNumber(config.framesPerChunk, 2, 8, SCOREBUG_FIRST_CHUNK_FRAME_COUNT);
  const maxChunks = Math.max(1, Math.min(40, Math.ceil(duration / chunkSeconds)));
  const chunks = [];
  for (let index = 0; index < maxChunks; index += 1) {
    const start = roundNumber(index * chunkSeconds);
    const end = roundNumber(Math.min(duration, (index + 1) * chunkSeconds));
    if (end <= start) continue;
    const chunk = { index: index + 1, start, end };
    chunks.push({
      ...chunk,
      samplingWindows: buildChunkSamplingWindows({ chunk, metadata, candidateWindows, frameCount }),
    });
  }
  return chunks;
}

function chunkTimeoutMsFor({ totalBudgetMs, configuredTimeoutMs }) {
  const configured = Number(configuredTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(250, Math.min(15_000, Math.min(totalBudgetMs, configured)));
  }
  const budget = Number(totalBudgetMs || SCOREBUG_FIRST_OCR_BUDGET_MS);
  if (Number.isFinite(budget) && budget > 0 && budget < SCOREBUG_FIRST_OCR_BUDGET_MS) {
    return Math.max(250, Math.min(15_000, Math.floor(budget)));
  }
  return SCOREBUG_FIRST_CHUNK_TIMEOUT_MS;
}

function totalChunkedOcrBudgetMs({ totalBudgetMs, chunkCount, chunkTimeoutMs, configuredTotalBudgetMs }) {
  const configured = Number(configuredTotalBudgetMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(250, Math.min(SCOREBUG_FIRST_MAX_TOTAL_OCR_BUDGET_MS, Math.floor(configured)));
  }
  const budget = Number(totalBudgetMs || SCOREBUG_FIRST_OCR_BUDGET_MS);
  if (Number.isFinite(budget) && budget > 0 && budget < SCOREBUG_FIRST_OCR_BUDGET_MS) {
    return Math.max(250, Math.floor(budget));
  }
  const scaledBudget = Math.max(
    Number.isFinite(budget) ? budget : SCOREBUG_FIRST_OCR_BUDGET_MS,
    Math.max(1, Number(chunkCount) || 1) * Math.max(250, Number(chunkTimeoutMs) || SCOREBUG_FIRST_CHUNK_TIMEOUT_MS),
  );
  return Math.min(SCOREBUG_FIRST_MAX_TOTAL_OCR_BUDGET_MS, Math.floor(scaledBudget));
}

function evidenceKey(item = {}) {
  return [
    Number(item.timestamp || 0).toFixed(2),
    item.status || "",
    item.scoreBefore || "",
    item.scoreAfter || "",
    item.source || "",
  ].join("|");
}

function aggregateChunkedScoreboardOcr(outputs = [], { metadata = {}, chunkSummary = null } = {}) {
  const safeOutputs = (Array.isArray(outputs) ? outputs : []).filter((output) => output && typeof output === "object");
  const evidence = [];
  const seenEvidence = new Set();
  for (const output of safeOutputs) {
    for (const item of Array.isArray(output.evidence) ? output.evidence : []) {
      const key = evidenceKey(item);
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(item);
    }
  }
  evidence.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const regionIdsUsed = [...new Set(safeOutputs
    .flatMap((output) => output.summary && Array.isArray(output.summary.regionIdsUsed) ? output.summary.regionIdsUsed : [])
    .map((id) => sanitizeText(id, 64))
    .filter(Boolean))]
    .slice(0, 12);
  const roiCalibration = aggregateScorebugRoiCalibration(safeOutputs);
  const scorebugDebug = aggregateScorebugDebugSummary(safeOutputs, roiCalibration, chunkSummary);
  const result = validateScoreboardOcrOutput({
    providerMode: "chunked-scoreboard-ocr",
    fallbackUsed: !evidence.length || safeOutputs.every((output) => output.fallbackUsed),
    confidence: safeOutputs.reduce((max, output) => Math.max(max, Number(output.confidence || 0)), 0),
    evidence,
    roiCalibration,
    scorebugDebug,
    sampledFrameCount: safeOutputs.reduce((sum, output) => sum + Number(output.summary && output.summary.sampledFrameCount || 0), 0),
    regionCount: safeOutputs.reduce((sum, output) => sum + Number(output.summary && output.summary.regionCount || 0), 0),
    regionIdsUsed,
    preprocessingVariantCount: safeOutputs.reduce((max, output) => Math.max(max, Number(output.summary && output.summary.preprocessingVariantCount || 0)), 0),
    chunkSummary,
  }, metadata);
  return {
    ...result,
    chunkSummary: result.chunkSummary || chunkSummary,
    summary: {
      ...result.summary,
      chunkSummary: result.summary && result.summary.chunkSummary || chunkSummary,
    },
  };
}

function roiCandidateKey(candidate = {}) {
  return [
    sanitizeText(candidate.regionId || "scoreboard_region", 80),
    sanitizeText(candidate.layoutId || "none", 80),
  ].join("::");
}

function mergeRoiCandidate(existing = null, candidate = {}) {
  const base = existing || {
    regionId: sanitizeText(candidate.regionId || "scoreboard_region", 80),
    layoutId: candidate.layoutId ? sanitizeText(candidate.layoutId, 80) : null,
    score: 0,
    observationCount: 0,
    textPresentCount: 0,
    readableCount: 0,
    readableObservationCount: 0,
    rejectedObservationCount: 0,
    clockOnlyObservationCount: 0,
    scoreChangeCount: 0,
    revertedCount: 0,
    unchangedCount: 0,
    ambiguousCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    averageConfidence: 0,
    diagnosis: null,
    reasonCodes: [],
    nextAction: null,
  };
  const reasonCodes = new Set([
    ...(Array.isArray(base.reasonCodes) ? base.reasonCodes : []),
    ...(Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : []),
  ].map((reason) => sanitizeText(reason, 80)).filter(Boolean));
  const firstTimestamp = [base.firstTimestamp, candidate.firstTimestamp]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const lastTimestamp = [base.lastTimestamp, candidate.lastTimestamp]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const observationCount = Number(base.observationCount || 0) + Number(candidate.observationCount || 0);
  const confidenceWeight = Number(base.averageConfidence || 0) * Number(base.observationCount || 0) +
    Number(candidate.averageConfidence || 0) * Number(candidate.observationCount || 0);
  return {
    ...base,
    score: Math.max(Number(base.score || 0), Number(candidate.score || 0)) +
      Math.max(0, Number(candidate.scoreChangeCount || 0)) * 8 +
      Math.max(0, Number(candidate.readableObservationCount || candidate.readableCount || 0)) * 2,
    observationCount,
    textPresentCount: Number(base.textPresentCount || 0) + Number(candidate.textPresentCount || 0),
    readableCount: Number(base.readableCount || 0) + Number(candidate.readableCount || 0),
    readableObservationCount: Number(base.readableObservationCount || 0) + Number(candidate.readableObservationCount || 0),
    rejectedObservationCount: Number(base.rejectedObservationCount || 0) + Number(candidate.rejectedObservationCount || 0),
    clockOnlyObservationCount: Number(base.clockOnlyObservationCount || 0) + Number(candidate.clockOnlyObservationCount || 0),
    scoreChangeCount: Number(base.scoreChangeCount || 0) + Number(candidate.scoreChangeCount || 0),
    revertedCount: Number(base.revertedCount || 0) + Number(candidate.revertedCount || 0),
    unchangedCount: Number(base.unchangedCount || 0) + Number(candidate.unchangedCount || 0),
    ambiguousCount: Number(base.ambiguousCount || 0) + Number(candidate.ambiguousCount || 0),
    firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : null,
    lastTimestamp: Number.isFinite(lastTimestamp) ? lastTimestamp : null,
    averageConfidence: observationCount > 0 ? confidenceWeight / observationCount : Math.max(Number(base.averageConfidence || 0), Number(candidate.averageConfidence || 0)),
    diagnosis: candidate.diagnosis || base.diagnosis,
    reasonCodes: [...reasonCodes].slice(0, 10),
    nextAction: candidate.nextAction || base.nextAction,
  };
}

function collectRoiCandidates(output = {}) {
  const summary = output && output.summary && typeof output.summary === "object" ? output.summary : {};
  const calibration = summary.roiCalibration && typeof summary.roiCalibration === "object" ? summary.roiCalibration : {};
  const debug = summary.scorebugDebug && typeof summary.scorebugDebug === "object" ? summary.scorebugDebug : {};
  return [
    calibration.selectedRoi,
    ...(Array.isArray(calibration.rejectedRois) ? calibration.rejectedRois : []),
    debug.selectedRoi,
    ...(Array.isArray(debug.rejectedRois) ? debug.rejectedRois : []),
  ].filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
}

function aggregateScorebugRoiCalibration(outputs = []) {
  const candidates = new Map();
  for (const output of outputs) {
    for (const candidate of collectRoiCandidates(output)) {
      const key = roiCandidateKey(candidate);
      candidates.set(key, mergeRoiCandidate(candidates.get(key), candidate));
    }
  }
  const ranked = [...candidates.values()].sort((a, b) =>
    Number(b.scoreChangeCount || 0) - Number(a.scoreChangeCount || 0) ||
    Number(b.readableObservationCount || b.readableCount || 0) - Number(a.readableObservationCount || a.readableCount || 0) ||
    Number(b.score || 0) - Number(a.score || 0) ||
    Number(b.averageConfidence || 0) - Number(a.averageConfidence || 0));
  const selectedRoi = ranked[0] || null;
  return {
    selectedRoi,
    candidateCount: ranked.length,
    rejectedRois: ranked.slice(1, 13),
    globalFallback: !selectedRoi,
    reasonCodes: [
      "chunked_scorebug_roi_calibration",
      selectedRoi ? "scorebug_roi_selected_from_chunks" : "scorebug_no_readable_roi",
    ],
    confidence: selectedRoi ? Number(selectedRoi.averageConfidence || 0) : 0,
  };
}

function aggregateScorebugDebugSummary(outputs = [], roiCalibration = {}, chunkSummary = null) {
  const selectedRoi = roiCalibration && roiCalibration.selectedRoi ? roiCalibration.selectedRoi : null;
  const chunkReports = Array.isArray(chunkSummary && chunkSummary.chunks) ? chunkSummary.chunks : [];
  const timedOutChunks = chunkReports.filter((chunk) => chunk.status === "timed_out").length;
  const failedChunks = chunkReports.filter((chunk) => chunk.status === "failed").length;
  const attemptedRoiIds = new Set(chunkReports.flatMap((chunk) => Array.isArray(chunk.roiCandidateIds) ? chunk.roiCandidateIds : []));
  const chunkAttemptedObservationCount = chunkReports.reduce((sum, chunk) => sum + Number(chunk.attemptedObservationCount || 0), 0);
  const scoreChangeCount = outputs.reduce((sum, output) => sum + Number(output.summary && output.summary.scoreChangeCount || 0), 0);
  const outputAttemptedObservationCount = outputs.reduce((sum, output) => {
    const debug = output.summary && output.summary.scorebugDebug;
    return sum + Math.max(
      Number(debug && debug.attemptedObservationCount || 0),
      Number(output.summary && output.summary.regionCount || 0),
    );
  }, 0);
  const readableObservationCount = outputs.reduce((sum, output) => {
    const debug = output.summary && output.summary.scorebugDebug;
    return sum + Number(debug && debug.readableObservationCount || 0);
  }, 0);
  const textPresentObservationCount = outputs.reduce((sum, output) => {
    const debug = output.summary && output.summary.scorebugDebug;
    return sum + Number(debug && debug.textPresentObservationCount || 0);
  }, 0);
  const chunkRejectedRois = selectedRoi || (roiCalibration && Array.isArray(roiCalibration.rejectedRois) && roiCalibration.rejectedRois.length)
    ? []
    : [...attemptedRoiIds].slice(0, 12).map((regionId) => ({
        regionId,
        layoutId: null,
        observationCount: chunkReports
          .filter((chunk) => Array.isArray(chunk.roiCandidateIds) && chunk.roiCandidateIds.includes(regionId))
          .reduce((sum, chunk) => sum + Number(chunk.plannedFrameCount || 0), 0),
        readableObservationCount: 0,
        scoreChangeCount: 0,
        diagnosis: "scorebug_unreadable",
        reasonCodes: ["scorebug_no_readable_roi"],
        nextAction: "enable-scoreboard-ocr-qa-artifacts-and-inspect-crops-for-wrong-roi-or-small-scorebug",
      }));
  const attemptedRoiCount = Math.max(0, Number(roiCalibration && roiCalibration.candidateCount || 0), attemptedRoiIds.size);
  const attemptedObservationCount = Math.max(outputAttemptedObservationCount, chunkAttemptedObservationCount);
  return {
    attemptedRoiCount,
    attemptedObservationCount,
    textPresentObservationCount,
    readableObservationCount,
    selectedRoi,
    rejectedRois: Array.isArray(roiCalibration && roiCalibration.rejectedRois) && roiCalibration.rejectedRois.length
      ? roiCalibration.rejectedRois
      : chunkRejectedRois,
    state: scoreChangeCount > 0
      ? "score_changes_detected"
      : timedOutChunks > 0 && outputs.length === 0
        ? "scorebug_all_chunks_timed_out"
        : timedOutChunks > 0 || failedChunks > 0
          ? "scorebug_partial_chunk_failures"
          : readableObservationCount > 0
            ? "scorebug_static_or_ambiguous"
            : "scorebug_unreadable",
    nextAction: scoreChangeCount > 0
      ? "feed-scorebug-score-changes-into-match-event-truth"
      : "inspect-scorebug-chunk-report-and-calibrate-roi-or-budgets",
    qaRecommended: scoreChangeCount === 0,
    reasonCodes: [
      "chunked_scorebug_first_ocr",
      ...(timedOutChunks > 0 ? ["scorebug_chunk_timeout_recorded"] : []),
      ...(failedChunks > 0 ? ["scorebug_chunk_failure_recorded"] : []),
      ...(attemptedRoiCount > 0 ? ["scorebug_roi_candidates_attempted"] : []),
      ...(selectedRoi ? ["scorebug_roi_selected_from_chunks"] : ["scorebug_no_readable_roi"]),
    ],
  };
}

function safeChunkFailureCode(error) {
  return sanitizeText(error && error.code || "SCOREBOARD_OCR_CHUNK_FAILED", 80);
}

function scorebugChunkRoiCandidateIds(metadata = {}) {
  try {
    const ids = defaultScoreboardRegions(metadata)
      .map((region) => sanitizeText(region && region.id, 80))
      .filter((id) => SCOREBUG_FIRST_ROI_CANDIDATE_IDS.includes(id));
    return ids.length ? ids : [...SCOREBUG_FIRST_ROI_CANDIDATE_IDS];
  } catch {
    return [...SCOREBUG_FIRST_ROI_CANDIDATE_IDS];
  }
}

function chunkSampledFrameTimestamps(chunk = {}) {
  return (Array.isArray(chunk.samplingWindows) ? chunk.samplingWindows : [])
    .map((window) => roundNumber(window && window.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp))
    .slice(0, 16);
}

function chunkDiagnosticsBase(chunk = {}, metadata = {}) {
  return {
    sampledFrameTimestamps: chunkSampledFrameTimestamps(chunk),
    roiCandidateIds: scorebugChunkRoiCandidateIds(metadata),
  };
}

function plannedChunkFrameCount(chunk = {}, diagnostics = null) {
  const timestamps = diagnostics && Array.isArray(diagnostics.sampledFrameTimestamps)
    ? diagnostics.sampledFrameTimestamps
    : chunkSampledFrameTimestamps(chunk);
  const windows = Array.isArray(chunk.samplingWindows) ? chunk.samplingWindows : [];
  return Math.max(0, Math.min(16, timestamps.length || windows.length));
}

function plannedChunkRoiCount(diagnostics = {}) {
  const ids = Array.isArray(diagnostics.roiCandidateIds) ? diagnostics.roiCandidateIds : [];
  return Math.max(0, Math.min(SCOREBUG_FIRST_ROI_CANDIDATE_IDS.length, ids.length));
}

function plannedChunkObservationCount(chunk = {}, diagnostics = null) {
  const safeDiagnostics = diagnostics || chunkDiagnosticsBase(chunk);
  return Math.max(0, Math.min(144, plannedChunkFrameCount(chunk, safeDiagnostics) * plannedChunkRoiCount(safeDiagnostics)));
}

function chunkAttemptDiagnostics(chunk = {}, metadata = {}, summary = {}, debug = {}) {
  const diagnostics = chunkDiagnosticsBase(chunk, metadata);
  const plannedFrameCount = plannedChunkFrameCount(chunk, diagnostics);
  const plannedRoiCount = plannedChunkRoiCount(diagnostics);
  const plannedObservationCount = plannedChunkObservationCount(chunk, diagnostics);
  return {
    ...diagnostics,
    plannedFrameCount,
    attemptedRoiCount: Math.max(
      plannedRoiCount,
      Number(debug && debug.attemptedRoiCount || 0),
      Number(summary && summary.roiCalibration && summary.roiCalibration.candidateCount || 0),
    ),
    attemptedObservationCount: Math.max(
      plannedObservationCount,
      Number(debug && debug.attemptedObservationCount || 0),
      Number(summary && summary.regionCount || 0),
    ),
  };
}

function selectedScorebugRoi(summary = {}) {
  return (summary.roiCalibration && summary.roiCalibration.selectedRoi) ||
    (summary.scorebugDebug && summary.scorebugDebug.selectedRoi) ||
    null;
}

function scorebugChunkRows(result = {}) {
  const summary = result && result.summary ? result.summary : {};
  return [
    ...(Array.isArray(summary.scoreTimeline) ? summary.scoreTimeline : []),
    ...(Array.isArray(result.evidence) ? result.evidence : []),
  ];
}

function scoreTextCandidatesFromRows(rows = []) {
  const candidates = new Set();
  for (const row of rows) {
    for (const value of [row && row.scoreBefore, row && row.scoreAfter, row && row.detectedScoreText]) {
      const safe = sanitizeText(value || "", 16);
      if (/^\d{1,2}-\d{1,2}$/.test(safe)) candidates.add(safe);
    }
  }
  return [...candidates].slice(0, 12);
}

function rejectedScoreCandidateReasonsFromRows(rows = [], summary = {}) {
  const reasons = [];
  for (const row of rows) {
    if (row && row.status === "clock_only") reasons.push("clock_only_ignored");
    if (row && row.status === "ambiguous") reasons.push("ambiguous_score_timeline");
    if (row && row.status === "unreadable") reasons.push("unreadable_scorebug");
    if (Array.isArray(row && row.transitionReasonCodes)) reasons.push(...row.transitionReasonCodes);
    if (Array.isArray(row && row.ambiguityReasons)) reasons.push(...row.ambiguityReasons);
  }
  const debug = summary.scorebugDebug || {};
  const selected = selectedScorebugRoi(summary) || {};
  if (Array.isArray(debug.reasonCodes)) reasons.push(...debug.reasonCodes);
  if (Array.isArray(selected.reasonCodes)) reasons.push(...selected.reasonCodes);
  return [...new Set(safeReasonList(reasons, 16))].slice(0, 12);
}

function stableScoreDecisionForOutput(result = {}) {
  const summary = result && result.summary ? result.summary : {};
  const debug = summary.scorebugDebug || {};
  if (Number(summary.scoreChangeCount || 0) > 0) return "score_changes_detected";
  if (Number(summary.scoreRevertedCount || 0) > 0) return "score_revert_detected";
  if (debug.state) return sanitizeText(debug.state, 80);
  if (Number(summary.clockOnlyCount || 0) > 0 && Number(summary.evidenceCount || 0) === 0) return "clock_only_ignored";
  if (Number(summary.evidenceCount || 0) > 0) return "scorebug_evidence_without_stable_change";
  return "no_readable_scorebug";
}

function chunkReportFromOutput(chunk = {}, result = {}, elapsedMs = 0, timeoutMs = null, metadata = {}) {
  const summary = result && result.summary ? result.summary : {};
  const debug = summary.scorebugDebug || {};
  const selectedRoi = selectedScorebugRoi(summary);
  const rows = scorebugChunkRows(result);
  const attempts = chunkAttemptDiagnostics(chunk, metadata, summary, debug);
  const textPresentObservationCount = Number(debug.textPresentObservationCount || 0);
  const readableObservationCount = Number(debug.readableObservationCount || 0);
  const rejectedObservationCount = selectedRoi
    ? Number(selectedRoi.rejectedObservationCount || 0)
    : Number(debug.rejectedObservationCount || (attempts.attemptedObservationCount && !readableObservationCount ? attempts.attemptedObservationCount : 0));
  const rejectedReasons = rejectedScoreCandidateReasonsFromRows(rows, summary);
  if (!readableObservationCount && attempts.attemptedObservationCount > 0) {
    rejectedReasons.push("scorebug_no_readable_roi");
    if (!Number(summary.sampledFrameCount || 0)) rejectedReasons.push("scorebug_frame_or_crop_unavailable");
  }
  return {
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    status: "completed",
    ...attempts,
    sampledFrameCount: Number(summary.sampledFrameCount || 0),
    roiDetected: Boolean(selectedRoi),
    selectedRoiId: selectedRoi && selectedRoi.regionId ? sanitizeText(selectedRoi.regionId, 80) : null,
    ocrTextCandidateCount: textPresentObservationCount,
    evidenceCount: Number(summary.evidenceCount || 0),
    scoreChangeCount: Number(summary.scoreChangeCount || 0),
    textPresentObservationCount,
    readableObservationCount,
    clockOnlyObservationCount: selectedRoi ? Number(selectedRoi.clockOnlyObservationCount || 0) : Number(summary.clockOnlyCount || 0),
    rejectedObservationCount,
    stableScoreDecision: stableScoreDecisionForOutput(result),
    normalizedScoreCandidates: scoreTextCandidatesFromRows(rows),
    rejectedScoreCandidateReasons: [...new Set(safeReasonList(rejectedReasons, 12))],
    skippedReason: null,
    nextAction: sanitizeText(debug.nextAction || (selectedRoi && selectedRoi.nextAction) || "inspect-scorebug-chunk-report", 180),
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs || 0))),
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.round(Number(timeoutMs))) : null,
  };
}

function chunkReportFromFailure(chunk = {}, error = {}, status = "failed", elapsedMs = 0, timeoutMs = null, metadata = {}) {
  const code = safeChunkFailureCode(error);
  const attempts = chunkAttemptDiagnostics(chunk, metadata);
  return {
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    status,
    ...attempts,
    sampledFrameCount: Array.isArray(chunk.samplingWindows) ? chunk.samplingWindows.length : 0,
    roiDetected: false,
    selectedRoiId: null,
    ocrTextCandidateCount: 0,
    evidenceCount: 0,
    scoreChangeCount: 0,
    textPresentObservationCount: 0,
    readableObservationCount: 0,
    clockOnlyObservationCount: 0,
    rejectedObservationCount: 0,
    stableScoreDecision: status === "timed_out"
      ? "timed_out"
      : status === "skipped"
        ? "not_scanned"
        : "chunk_failed",
    normalizedScoreCandidates: [],
    rejectedScoreCandidateReasons: [code],
    skippedReason: code,
    nextAction: status === "timed_out"
      ? "reduce-scorebug-ocr-workload-or-enable-scoreboard-ocr-qa-artifacts"
      : "inspect-scorebug-chunk-failure-and-retry-with-safe-budgets",
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs || 0))),
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.round(Number(timeoutMs))) : null,
  };
}

function buildChunkSummary({ chunks = [], outputs = [], chunkReports = [], discoveredScoreChanges = 0, totalBudgetMs = 0, chunkTimeoutMs = 0 } = {}) {
  const reports = Array.isArray(chunkReports) ? chunkReports : [];
  const completed = reports.filter((chunk) => chunk.status === "completed");
  const skipped = reports.filter((chunk) => chunk.status !== "completed");
  const attemptedRoiIds = new Set(reports.flatMap((chunk) => Array.isArray(chunk.roiCandidateIds) ? chunk.roiCandidateIds : []));
  return {
    mode: "chunked_scorebug_first_ocr",
    chunkCount: chunks.length,
    scannedChunks: outputs.length,
    skippedChunks: skipped.length,
    scannedDurationSeconds: roundNumber(completed.reduce((sum, chunk) => sum + Math.max(0, Number(chunk.end) - Number(chunk.start)), 0)),
    discoveredScoreChanges,
    plannedFrameCount: reports.reduce((sum, chunk) => sum + Number(chunk.plannedFrameCount || 0), 0),
    attemptedRoiCount: attemptedRoiIds.size,
    attemptedObservationCount: reports.reduce((sum, chunk) => sum + Number(chunk.attemptedObservationCount || 0), 0),
    totalBudgetMs,
    chunkTimeoutMs,
    chunks: reports,
  };
}

function throwScorebugOcrTimeout({ chunks = [], outputs = [], chunkReports = [], discoveredScoreChanges = 0, totalBudgetMs = 0, chunkTimeoutMs = 0, startedMs = Date.now(), substep = "scorebug_first_chunk_scan_incomplete" } = {}) {
  const chunkSummary = buildChunkSummary({
    chunks,
    outputs,
    chunkReports,
    discoveredScoreChanges,
    totalBudgetMs,
    chunkTimeoutMs,
  });
  throw new AppError("SCOREBOARD_OCR_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504, {
    phase: "analysis",
    step: "run_scorebug_ocr",
    substep,
    chunkIndex: chunkReports.length ? chunkReports[chunkReports.length - 1].index : 1,
    chunkCount: chunks.length,
    scannedChunks: outputs.length,
    skippedChunks: chunkSummary.skippedChunks,
    discoveredScoreChanges,
    elapsedMs: Date.now() - startedMs,
    timeoutMs: totalBudgetMs,
    totalBudgetMs,
    chunkTimeoutMs,
    chunkSummary,
    logsDownloaded: false,
    artifactsDownloaded: false,
  });
}

async function runChunkedScorebugFirstOcr({
  deps,
  context,
  mediaSignals,
  visualCandidateWindows,
  signal,
  jobs,
  job,
  project,
  requestId,
  totalBudgetMs,
} = {}) {
  const startedMs = Date.now();
  const chunkConfig = deps.scoreboardOcrChunking && typeof deps.scoreboardOcrChunking === "object"
    ? deps.scoreboardOcrChunking
    : {};
  const chunks = buildScorebugOcrChunks({
    metadata: context.metadata,
    candidateWindows: visualCandidateWindows,
    config: chunkConfig,
  });
  const chunkTimeoutMs = chunkTimeoutMsFor({
    totalBudgetMs,
    configuredTimeoutMs: chunkConfig.chunkTimeoutMs,
  });
  const effectiveTotalBudgetMs = totalChunkedOcrBudgetMs({
    totalBudgetMs,
    chunkCount: chunks.length,
    chunkTimeoutMs,
    configuredTotalBudgetMs: chunkConfig.totalBudgetMs,
  });
  const outputs = [];
  const chunkReports = [];
  let discoveredScoreChanges = 0;

  for (const chunk of chunks) {
    const elapsedMs = Date.now() - startedMs;
    if (elapsedMs >= effectiveTotalBudgetMs) {
      chunkReports.push(chunkReportFromFailure(
        chunk,
        { code: "SCOREBOARD_OCR_TOTAL_BUDGET_EXHAUSTED" },
        "skipped",
        elapsedMs,
        0,
        context.metadata,
      ));
      break;
    }
    updateJobStep({
      jobs,
      job,
      projectId: project.id,
      requestId,
      logger: deps.logger,
      progress: Math.min(29, 28 + Math.floor((chunk.index - 1) / Math.max(1, chunks.length) * 2)),
      step: "run_scorebug_ocr",
      substep: "scorebug_first_chunk",
      longSource: true,
      scorebugFirst: true,
      budgetMs: chunkTimeoutMs,
      progressDetails: {
        chunkIndex: chunk.index,
        chunkCount: chunks.length,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        ...chunkDiagnosticsBase(chunk, context.metadata),
        scannedChunks: outputs.length,
        discoveredScoreChanges,
        elapsedMs,
        totalBudgetMs: effectiveTotalBudgetMs,
        chunkTimeoutMs,
      },
    });
    const remainingBudgetMs = Math.max(250, effectiveTotalBudgetMs - elapsedMs);
    const effectiveChunkTimeoutMs = Math.min(chunkTimeoutMs, remainingBudgetMs);
    let result = null;
    try {
      result = await runStepWithTimeout(
        (stepSignal) => deps.analyzeScoreboardOcr({
          inputPath: context.inputPath,
          metadata: context.metadata,
          candidateWindows: chunk.samplingWindows,
          mediaSignals,
          visualSignals: { windows: [] },
          frames: [],
          frameSummary: null,
          ocrSamplingWindows: chunk.samplingWindows,
          scorebugFirstOnly: true,
          signal: stepSignal,
          timeoutMs: Math.min(effectiveChunkTimeoutMs, SCOREBUG_FIRST_CHUNK_TIMEOUT_MS),
        }),
        {
          signal,
          timeoutMs: effectiveChunkTimeoutMs,
          code: "SCOREBOARD_OCR_TIMEOUT",
          details: {
            phase: "analysis",
            step: "run_scorebug_ocr",
            substep: "scorebug_first_chunk",
            chunkIndex: chunk.index,
            chunkCount: chunks.length,
            chunkStart: chunk.start,
            chunkEnd: chunk.end,
            scannedChunks: outputs.length,
            discoveredScoreChanges,
            elapsedMs: Date.now() - startedMs,
            timeoutMs: effectiveChunkTimeoutMs,
            totalBudgetMs: effectiveTotalBudgetMs,
            chunkTimeoutMs,
          },
        },
      );
    } catch (error) {
      if ((signal && signal.aborted) || error.code === "JOB_CANCELLED") throw error;
      const status = error.code === "SCOREBOARD_OCR_TIMEOUT" ? "timed_out" : "failed";
      const failedReport = chunkReportFromFailure(chunk, error, status, Date.now() - startedMs, effectiveChunkTimeoutMs, context.metadata);
      chunkReports.push(failedReport);
      logInfo(deps.logger, {
        event: "scoreboard_ocr_chunk_skipped",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "run_scorebug_ocr",
        substep: "scorebug_first_chunk",
        chunkIndex: chunk.index,
        chunkCount: chunks.length,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        status,
        code: failedReport.skippedReason,
        scannedChunks: outputs.length,
        discoveredScoreChanges,
        elapsedMs: Date.now() - startedMs,
        budgetMs: chunkTimeoutMs,
        totalBudgetMs: effectiveTotalBudgetMs,
        logsDownloaded: false,
        artifactsDownloaded: false,
      });
      continue;
    }
    outputs.push(result);
    discoveredScoreChanges += stableScoreChangeCount(result);
    chunkReports.push(chunkReportFromOutput(chunk, result, Date.now() - startedMs, effectiveChunkTimeoutMs, context.metadata));
    logInfo(deps.logger, {
      event: "scoreboard_ocr_chunk_completed",
      requestId,
      projectId: project.id,
      jobId: job.id,
      step: "run_scorebug_ocr",
      substep: "scorebug_first_chunk",
      chunkIndex: chunk.index,
      chunkCount: chunks.length,
      chunkStart: chunk.start,
      chunkEnd: chunk.end,
      sampledFrameCount: result.summary && result.summary.sampledFrameCount,
      evidenceCount: result.summary && result.summary.evidenceCount,
      scoreChangeCount: result.summary && result.summary.scoreChangeCount,
      discoveredScoreChanges,
      elapsedMs: Date.now() - startedMs,
      budgetMs: chunkTimeoutMs,
      totalBudgetMs: effectiveTotalBudgetMs,
      logsDownloaded: false,
      artifactsDownloaded: false,
    });
  }

  for (const chunk of chunks.slice(chunkReports.length)) {
    chunkReports.push(chunkReportFromFailure(
      chunk,
      { code: "SCOREBOARD_OCR_NOT_SCANNED" },
      "skipped",
      Date.now() - startedMs,
      0,
      context.metadata,
    ));
  }
  const chunkSummary = buildChunkSummary({
    chunks,
    outputs,
    chunkReports,
    discoveredScoreChanges,
    totalBudgetMs: effectiveTotalBudgetMs,
    chunkTimeoutMs,
  });
  if (!outputs.length) {
    const failedScoreboardOcr = aggregateChunkedScoreboardOcr([], {
      metadata: context.metadata,
      chunkSummary,
    });
    jobs.update(job, {
      scoreboardOcr: publicScoreboardOcr(failedScoreboardOcr),
    });
    throwScorebugOcrTimeout({
      chunks,
      outputs,
      chunkReports,
      discoveredScoreChanges,
      totalBudgetMs: effectiveTotalBudgetMs,
      chunkTimeoutMs,
      startedMs,
      substep: "scorebug_first_all_chunks_failed",
    });
  }
  return aggregateChunkedScoreboardOcr(outputs, {
    metadata: context.metadata,
    chunkSummary,
  });
}

function validateHighlightResult(result, metadata = {}) {
  if (!result || typeof result !== "object" || !Array.isArray(result.moments) || result.moments.length === 0) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const durationSeconds = Number(metadata.durationSeconds || 0);
  const moments = result.moments.slice(0, 7).map((moment, index) => {
    const start = Number(moment && moment.start);
    const end = Number(moment && moment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > durationSeconds + 0.25) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    if (!Array.isArray(moment.reasonCodes)) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    return {
      ...moment,
      id: sanitizeText(moment.id || `moment_${index + 1}`, 60),
      rank: Number.isFinite(Number(moment.rank)) ? Number(moment.rank) : index + 1,
      start,
      end,
      highlightType: sanitizeText(moment.highlightType || "generic_highlight", 60),
      confidence: Number.isFinite(Number(moment.confidence)) ? Number(moment.confidence) : 0,
      reasonCodes: moment.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean),
      retentionScore: Number.isFinite(Number(moment.retentionScore)) ? Number(moment.retentionScore) : 0,
    };
  });
  return { ...result, moments };
}

function publicMediaSignals(mediaSignals) {
  return {
    durationSeconds: mediaSignals.durationSeconds,
    audioPeaks: mediaSignals.audioPeaks,
    sceneChanges: mediaSignals.sceneChanges,
  };
}

function phaseForPipelineStep(step = "") {
  const safe = sanitizeText(step, 80);
  if (["extract_audio", "analyze_media", "extract_sampled_frames", "extract_scorebug_frames", "run_scorebug_ocr", "analyze_visuals", "analyze_visual_tracking", "transcribe", "analyze_goal_evidence", "detect_highlights"].includes(safe)) return "analysis";
  if (["plan_story", "create_edit_plan", "video_output_qa_failed", "approved_edit_plan"].includes(safe)) return "planning";
  if (["render_kinetic_captions", "render_beat_effects", "render_short", "commit_render"].includes(safe)) return "render";
  if (safe === "completed") return "completed";
  return "orchestration";
}

function updateJobStep({
  jobs,
  job,
  projectId,
  requestId,
  logger,
  progress,
  step,
  substep = null,
  longSource = false,
  scorebugFirst = false,
  budgetMs = null,
  progressDetails = null,
}) {
  const startedAt = nowIso();
  const progressMeta = {
    phase: phaseForPipelineStep(step),
    step: sanitizeText(step, 80),
    substep: substep ? sanitizeText(substep, 80) : null,
    startedAt,
    longSource: Boolean(longSource),
    scorebugFirst: Boolean(scorebugFirst),
    budgetMs: Number.isFinite(Number(budgetMs)) ? Number(budgetMs) : null,
  };
  if (progressDetails && typeof progressDetails === "object" && !Array.isArray(progressDetails)) {
    const numericKeys = [
      "chunkIndex",
      "chunkCount",
      "chunkStart",
      "chunkEnd",
      "scannedChunks",
      "discoveredScoreChanges",
      "elapsedMs",
      "totalBudgetMs",
      "chunkTimeoutMs",
    ];
    for (const key of numericKeys) {
      if (Number.isFinite(Number(progressDetails[key]))) {
        progressMeta[key] = Number(progressDetails[key]);
      }
    }
  }
  jobs.update(job, { status: "processing", progress, step, progressMeta });
  logInfo(logger, {
    event: "job_step",
    requestId,
    projectId,
    jobId: job.id,
    step,
    substep: progressMeta.substep,
    progress: job.progress,
    progressMeta,
  });
}

async function runStepWithTimeout(work, {
  signal,
  timeoutMs,
  code,
  message = SAFE_MESSAGES.ANALYSIS_FAILED,
  details = {},
} = {}) {
  const budget = Number(timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) return await work(signal);
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  let timeout = null;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new AppError(code, message, 504, {
            ...details,
            timeoutMs: budget,
          }));
        }, budget);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function completeCancelledJob({ jobs, job, logger, projectId, requestId }) {
  if (!job) return;
  if (job.status !== "cancelled") {
    jobs.update(job, {
      status: "cancelled",
      error: { code: "JOB_CANCELLED", message: SAFE_MESSAGES.JOB_CANCELLED },
      step: "cancelled",
    });
  }
  logInfo(logger, { event: "job_cancelled", requestId, projectId, jobId: job.id, code: "JOB_CANCELLED" });
}

function failJob({ jobs, job, project, error, logger, requestId }) {
  if (project) {
    project.status = "failed";
    project.updatedAt = nowIso();
  }
  if (job) jobs.fail(job, error);
  logInfo(logger, {
    event: "job_failed",
    requestId,
    projectId: project && project.id,
    jobId: job && job.id,
    code: (job && job.error && job.error.code) || error.code || "UNEXPECTED",
  });
}

function projectSetReady(project, deps) {
  project.status = "ready";
  project.updatedAt = nowIso();
  if (deps.projectRepository && typeof deps.projectRepository.save === "function") {
    deps.projectRepository.save(project);
  }
}

function createExportRecord({ deps, exportsById, record }) {
  if (deps.exportRepository && typeof deps.exportRepository.create === "function") {
    return deps.exportRepository.create(record);
  }
  if (exportsById && typeof exportsById.set === "function") {
    exportsById.set(record.id, record);
    return record;
  }
  throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 500);
}

function persistExportAndReadyProject({ deps, exportsById, project, record }) {
  if (deps.persistenceAdapter && typeof deps.persistenceAdapter.transaction === "function") {
    return deps.persistenceAdapter.transaction(() => {
      const exportRecord = createExportRecord({ deps, exportsById, record });
      projectSetReady(project, deps);
      return exportRecord;
    });
  }
  const exportRecord = createExportRecord({ deps, exportsById, record });
  projectSetReady(project, deps);
  return exportRecord;
}

function persistRenderResult(deps, record) {
  if (deps.persistRenderRecord && typeof deps.persistRenderRecord === "function") {
    deps.persistRenderRecord(record);
    return;
  }
  deps.writeJsonAtomic(deps.storagePath("projects", `${record.project.id}.render.json`), record);
}

function artifactSize(deps, filePath) {
  try {
    return deps.statFile(filePath).size;
  } catch {
    return null;
  }
}

function indexArtifact(deps, artifact) {
  if (!artifact || !deps.artifactRepository || typeof deps.artifactRepository.create !== "function") return;
  try {
    deps.artifactRepository.create(artifact);
  } catch (error) {
    logInfo(deps.logger, {
      event: "artifact_index_skipped",
      artifactId: artifact.id,
      code: error.code || "ARTIFACT_INDEX_FAILED",
    });
  }
}

function indexPipelineStages(deps, context) {
  if (!context) return;
  for (const stage of [context.audioStage, context.subtitlesStage]) {
    if (stage && stage.artifact) indexArtifact(deps, stage.artifact);
  }
}

function cleanupPipelineStages({ deps, context, logger, requestId, projectId, jobId }) {
  if (!context || !deps.artifactStore || typeof deps.artifactStore.cleanupStage !== "function") return;
  const stages = [context.inputStage, context.audioStage, context.subtitlesStage, context.outputStage].filter(Boolean);
  for (const stage of stages) {
    const result = deps.artifactStore.cleanupStage(stage);
    if (result && result.cleaned) {
      if (deps.artifactRepository && typeof deps.artifactRepository.markDeleted === "function" && stage.artifact) {
        try {
          deps.artifactRepository.markDeleted(stage.artifact.id);
        } catch {
          // The artifact index is best-effort for already-cleaned temp files.
        }
      }
      logInfo(logger, {
        event: "artifact_stage_cleaned",
        requestId,
        projectId,
        jobId,
        artifactId: stage.artifact && stage.artifact.id,
        storageMode: stage.adapterMode,
        step: "cleanup_stage",
      });
    }
  }
}

function updateApprovalAudit({ deps, context, job, projectId, requestId, status, exportId, error }) {
  const repository = deps && deps.regenerationApprovalRepository;
  const outboxRepository = deps && deps.approvalOutboxRepository;
  const approvalId = context && context.regenerationApproval && context.regenerationApproval.approvalId;
  if (!repository || !approvalId) return null;
  try {
    let record = null;
    let eventType = null;
    if (status === "render_processing" && typeof repository.markRenderProcessing === "function") {
      record = repository.markRenderProcessing(approvalId, job && job.id);
      eventType = "render_processing";
    } else if (status === "render_completed" && typeof repository.markRenderCompleted === "function") {
      record = repository.markRenderCompleted(approvalId, { jobId: job && job.id, exportId });
      eventType = "render_completed";
    } else if (status === "render_failed" && typeof repository.markRenderFailed === "function") {
      record = repository.markRenderFailed(approvalId, {
        jobId: job && job.id,
        errorCode: (error && error.code) || "RENDER_FAILED",
      });
      eventType = "render_failed";
    } else if (status === "cancelled" && typeof repository.markRenderCancelled === "function") {
      record = repository.markRenderCancelled(approvalId, { jobId: job && job.id });
      eventType = "render_cancelled";
    }
    if (record && eventType && outboxRepository && typeof outboxRepository.createLifecycleEvent === "function") {
      outboxRepository.createLifecycleEvent({
        eventType,
        requestId,
        approvalRecord: record,
        jobId: job && job.id,
        exportId,
        errorCode: (error && error.code) || (record && record.errorCode),
        status: record.status,
      });
      logInfo(deps.logger, {
        event: "approval_outbox_created",
        requestId,
        projectId,
        jobId: job && job.id,
        approvalId,
        eventType,
      });
    }
    logInfo(deps.logger, {
      event: "approval_audit_updated",
      requestId,
      projectId,
      jobId: job && job.id,
      approvalId,
      status,
    });
    return record;
  } catch (auditError) {
    logInfo(deps.logger, {
      event: "approval_audit_update_failed",
      requestId,
      projectId,
      jobId: job && job.id,
      approvalId,
      code: auditError.code || "APPROVAL_AUDIT_UPDATE_FAILED",
    });
    return null;
  }
}

function transcriptFromApprovedPlan(plan, context) {
  const captions = Array.isArray(plan.captions)
    ? plan.captions.map((caption) => ({
        start: caption.start,
        end: caption.end,
        text: sanitizeText(caption.text, 160),
      }))
    : [];
  return validateTranscript({
    provider: "approved_regeneration_draft",
    language: context.language,
    text: captions.map((caption) => caption.text).join(" "),
    captions,
    segments: captions,
  }, context.metadata);
}

function mediaSignalsFromApprovedPlan(context) {
  return validateMediaSignals({
    durationSeconds: context.metadata.durationSeconds,
    audioPeaks: [],
    sceneChanges: [],
    highMotionCandidates: [],
  }, context.metadata);
}

function visualSignalsFromApprovedPlan(plan, context) {
  return validateVisualSignals({
    providerMode: "approved_regeneration_draft",
    fallbackUsed: false,
    confidence: Number.isFinite(Number(plan.actionFocusConfidence)) ? Number(plan.actionFocusConfidence) : 0,
    providerMetadata: {
      model: "human-approved-draft",
      latencyMs: 0,
    },
    windows: [],
  }, context.metadata);
}

function goalEvidenceFromApprovedPlan(plan) {
  const goalOutcome = plan && plan.goalOutcome && plan.goalOutcome.eventType === "ball_in_net"
    ? plan.goalOutcome
    : null;
  const validGoalCount = goalOutcome && goalOutcome.outcome === "confirmed_goal" ? 1 : 0;
  const offsideOrNoGoalCount = goalOutcome && goalOutcome.outcome === "disallowed_offside" ? 1 : 0;
  const unconfirmedGoalCount = goalOutcome && goalOutcome.outcome === "unknown_decision" ? 1 : 0;
  return publicGoalEvidence({
    providerMode: "approved_regeneration_draft",
    fallbackUsed: false,
    confidence: goalOutcome ? Number(goalOutcome.confidence || 1) : 0,
    events: [],
    summary: {
      eventCount: validGoalCount + offsideOrNoGoalCount + unconfirmedGoalCount,
      validGoalCount,
      offsideOrNoGoalCount,
      unconfirmedGoalCount,
      nonGoalChanceCount: 0,
      goalEvidenceCoverage: validGoalCount ? 1 : 0,
    },
  });
}

function highlightResultFromApprovedPlan(plan) {
  return {
    moments: [{
      id: "approved_regeneration_moment",
      rank: 1,
      start: plan.sourceStart,
      end: plan.sourceEnd,
      highlightType: plan.highlightType || "generic_highlight",
      confidence: Number.isFinite(Number(plan.confidence)) ? Number(plan.confidence) : 0.8,
      reasonCodes: Array.isArray(plan.reasonCodes) ? plan.reasonCodes : [plan.highlightType || "generic_highlight"],
      retentionScore: Number.isFinite(Number(plan.retentionScore)) ? Number(plan.retentionScore) : 88,
    }],
  };
}

async function runRenderJob(options) {
  const {
    jobs,
    exportsById,
    exportRepository,
    projectRepository,
    job,
    project,
    upload,
    payload,
    requestId,
    dependencies,
  } = options || {};
  const deps = createDefaultDependencies({ exportRepository, projectRepository, ...dependencies });
  const signal = job && job._controller ? job._controller.signal : null;
  let context = null;
  let sampledFrames = null;
  let sampledFrameSummary = null;
  let transcript = null;
  let mediaSignals = null;
  let visualSignals = null;
  let scoreboardOcr = null;
  let ocrQaCalibration = null;
  let goalEvidence = null;
  let matchEventTruth = null;
  let videoOutputQA = null;
  let trackingProviderOutput = null;
  let visualTracking = null;
  let highlightResult = null;
  let candidatePlans = null;
  let editPlan = null;
  try {
    context = assertPipelineContext({ job, project, upload, payload, deps });
    const longSourceRuntime = isYouTubeLongSource(context.source, context.metadata);
    const scorebugFirstOcrBudgetMs = ocrStepBudgetMs(deps, "scorebugFirstMs", SCOREBUG_FIRST_OCR_BUDGET_MS);
    const visualWindowOcrBudgetMs = ocrStepBudgetMs(deps, "visualWindowMs", VISUAL_WINDOW_OCR_BUDGET_MS);
    indexPipelineStages(deps, context);

    if (context.approvedEditPlan) {
      updateApprovalAudit({
        deps,
        context,
        job,
        projectId: project.id,
        requestId,
        status: "render_processing",
      });
      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 72, step: "approved_edit_plan" });
      editPlan = deps.validateEditPlan(context.approvedEditPlan, context.metadata);
      candidatePlans = [editPlan];
      highlightResult = validateHighlightResult(highlightResultFromApprovedPlan(editPlan), context.metadata);
      mediaSignals = mediaSignalsFromApprovedPlan(context);
      visualSignals = visualSignalsFromApprovedPlan(editPlan, context);
      scoreboardOcr = null;
      ocrQaCalibration = publicOcrQaCalibration(null);
      goalEvidence = goalEvidenceFromApprovedPlan(editPlan);
      matchEventTruth = publicMatchEventTruth(null);
      trackingProviderOutput = null;
      visualTracking = publicVisualTrackingSummary(editPlan.visualTrackingSummary || null, context.metadata);
      transcript = transcriptFromApprovedPlan(editPlan, context);
      sampledFrameSummary = {
        providerMode: "approved_regeneration_draft",
        fallbackUsed: false,
        summary: {
          frameCount: 0,
          sampledWindows: 0,
          skippedWindows: 0,
        },
        frames: [],
      };
      logInfo(deps.logger, {
        event: "approved_edit_plan_selected",
        requestId,
        projectId: project.id,
        jobId: job.id,
        approvalId: context.regenerationApproval && context.regenerationApproval.approvalId,
        regenerationPlanId: context.regenerationApproval && context.regenerationApproval.regenerationPlanId,
        highlightType: editPlan.highlightType,
        framingMode: editPlan.framingMode,
        aspectRatio: editPlan.aspectRatio,
      });
    } else {
      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 8, step: "extract_audio", substep: "audio_track_stage", longSource: longSourceRuntime });
      if (context.metadata.hasAudio) {
        await deps.extractAudio(context.inputPath, context.audioPath, { signal });
      }

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 22, step: "analyze_media", substep: "media_signal_extraction", longSource: longSourceRuntime });
      mediaSignals = validateMediaSignals(
        await deps.extractMediaSignals({
          inputPath: context.inputPath,
          metadata: context.metadata,
          signal,
        }),
        context.metadata,
      );

      let visualCandidateWindows = visualCandidateWindowsFromSignals(mediaSignals);
      if (longSourceRuntime) {
        updateJobStep({
          jobs,
          job,
          projectId: project.id,
          requestId,
          logger: deps.logger,
          progress: 26,
          step: "extract_scorebug_frames",
          substep: "chunked_scorebug_sampling_plan",
          longSource: true,
          scorebugFirst: true,
          budgetMs: scorebugFirstOcrBudgetMs,
        });
        scoreboardOcr = await runChunkedScorebugFirstOcr({
          deps,
          context,
          mediaSignals,
          visualCandidateWindows,
          signal,
          jobs,
          job,
          project,
          requestId,
          totalBudgetMs: scorebugFirstOcrBudgetMs,
        });
        logInfo(deps.logger, {
          event: "scoreboard_ocr_completed",
          requestId,
          projectId: project.id,
          jobId: job.id,
          step: "run_scorebug_ocr",
          substep: "scorebug_first_stable_change_detection",
          providerMode: scoreboardOcr.providerMode,
          fallbackUsed: scoreboardOcr.fallbackUsed,
          sampledFrameCount: scoreboardOcr.summary && scoreboardOcr.summary.sampledFrameCount,
          evidenceCount: scoreboardOcr.summary && scoreboardOcr.summary.evidenceCount,
          scoreChangeCount: scoreboardOcr.summary && scoreboardOcr.summary.scoreChangeCount,
          scoreRevertedCount: scoreboardOcr.summary && scoreboardOcr.summary.scoreRevertedCount,
          ambiguousCount: scoreboardOcr.summary && scoreboardOcr.summary.ambiguousCount,
          unreadableCount: scoreboardOcr.summary && scoreboardOcr.summary.unreadableCount,
          regionIdsUsed: scoreboardOcr.summary && scoreboardOcr.summary.regionIdsUsed,
          preprocessingVariantCount: scoreboardOcr.summary && scoreboardOcr.summary.preprocessingVariantCount,
          qaReport: scoreboardOcr.summary && scoreboardOcr.summary.qaReport,
          scorebugDebug: scoreboardOcr.summary && scoreboardOcr.summary.scorebugDebug,
          chunkSummary: scoreboardOcr.summary && scoreboardOcr.summary.chunkSummary,
          scoreTimeline: scoreboardOcr.summary && scoreboardOcr.summary.scoreTimeline,
          scorebugFirst: true,
        });
        const scorebugCandidateWindows = scoreChangeCandidateWindowsFromOcr(scoreboardOcr, context.metadata);
        visualCandidateWindows = mergeCandidateWindows(scorebugCandidateWindows, visualCandidateWindows, context.metadata);
      }

      updateJobStep({
        jobs,
        job,
        projectId: project.id,
        requestId,
        logger: deps.logger,
        progress: 30,
        step: "extract_sampled_frames",
        substep: longSourceRuntime ? "scorebug_anchor_visual_windows" : "visual_candidate_windows",
        longSource: longSourceRuntime,
        scorebugFirst: longSourceRuntime,
      });
      sampledFrames = await deps.extractSampledFrames({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        signal,
      });
      sampledFrameSummary = publicFrameSummary(sampledFrames);
      logInfo(deps.logger, {
        event: "frame_extraction_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "extract_sampled_frames",
        providerMode: sampledFrameSummary.providerMode,
        fallbackUsed: sampledFrameSummary.fallbackUsed,
        frameCount: sampledFrameSummary.summary.frameCount,
        sampledWindows: sampledFrameSummary.summary.sampledWindows,
        skippedWindows: sampledFrameSummary.summary.skippedWindows,
      });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 38, step: "analyze_visuals", substep: longSourceRuntime ? "scorebug_narrowed_visual_analysis" : "frame_visual_analysis", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });
      visualSignals = validateVisualSignals(
        await deps.analyzeFrames({
          inputPath: context.inputPath,
          metadata: context.metadata,
          candidateWindows: visualCandidateWindows,
          mediaSignals,
          frames: sampledFrames.frames,
          frameSummary: sampledFrameSummary,
          signal,
        }),
        context.metadata,
      );
      trackingProviderOutput = publicTrackingProviderOutput(await deps.analyzeTracking({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        mediaSignals,
        visualSignals,
        frames: sampledFrames.frames,
        frameSummary: sampledFrameSummary,
        signal,
      }), context.metadata);
      visualTracking = publicVisualTrackingSummary(deps.analyzeVisualTracking({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        mediaSignals,
        visualSignals,
        trackingProviderOutput,
        frames: sampledFrames.frames,
        frameSummary: sampledFrameSummary,
      }), context.metadata);
      logInfo(deps.logger, {
        event: "visual_analysis_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_visuals",
        providerMode: visualSignals.providerMode,
        frameCount: sampledFrameSummary.summary.frameCount,
        visualWindowCount: visualSignals.summary.windowCount,
        fallbackUsed: visualSignals.fallbackUsed,
        latencyMs: visualSignals.providerMetadata && visualSignals.providerMetadata.latencyMs,
        errorCode: visualSignals.failure && visualSignals.failure.code,
      });
      logInfo(deps.logger, {
        event: "visual_tracking_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_visual_tracking",
        providerMode: trackingProviderOutput.providerMode,
        frameCount: visualTracking.frameCount,
        ballTrackCount: trackingProviderOutput.ballTrackCount,
        playerClusterCount: trackingProviderOutput.playerClusterCount,
        trackingConfidence: visualTracking.trackingConfidence,
        ballCandidateConfidence: visualTracking.ballCandidateConfidence,
        playerClusterConfidence: visualTracking.playerClusterConfidence,
        recommendedFramingMode: visualTracking.recommendedFramingMode,
        cropSafetyReason: visualTracking.cropSafetyReason,
        fallbackUsed: visualTracking.fallbackUsed,
        errorCode: trackingProviderOutput.failure && trackingProviderOutput.failure.code,
      });

      if (!scoreboardOcr) {
        updateJobStep({
          jobs,
          job,
          projectId: project.id,
          requestId,
          logger: deps.logger,
          progress: 46,
          step: "analyze_scoreboard_ocr",
          substep: "visual_window_scoreboard_ocr",
          longSource: longSourceRuntime,
          scorebugFirst: false,
          budgetMs: visualWindowOcrBudgetMs,
        });
        scoreboardOcr = await runStepWithTimeout(
          (stepSignal) => deps.analyzeScoreboardOcr({
            inputPath: context.inputPath,
            metadata: context.metadata,
            candidateWindows: visualCandidateWindows,
            mediaSignals,
            visualSignals,
          frames: sampledFrames.frames,
          frameSummary: sampledFrameSummary,
          signal: stepSignal,
          timeoutMs: visualWindowOcrBudgetMs,
        }),
        {
          signal,
          timeoutMs: visualWindowOcrBudgetMs,
          code: "SCOREBOARD_OCR_TIMEOUT",
            details: {
              phase: "analysis",
              step: "analyze_scoreboard_ocr",
              substep: "visual_window_scoreboard_ocr",
            },
          },
        );
        logInfo(deps.logger, {
          event: "scoreboard_ocr_completed",
          requestId,
          projectId: project.id,
          jobId: job.id,
          step: "analyze_scoreboard_ocr",
          substep: "visual_window_scoreboard_ocr",
          providerMode: scoreboardOcr.providerMode,
          fallbackUsed: scoreboardOcr.fallbackUsed,
          sampledFrameCount: scoreboardOcr.summary && scoreboardOcr.summary.sampledFrameCount,
          evidenceCount: scoreboardOcr.summary && scoreboardOcr.summary.evidenceCount,
          scoreChangeCount: scoreboardOcr.summary && scoreboardOcr.summary.scoreChangeCount,
          scoreRevertedCount: scoreboardOcr.summary && scoreboardOcr.summary.scoreRevertedCount,
          ambiguousCount: scoreboardOcr.summary && scoreboardOcr.summary.ambiguousCount,
          unreadableCount: scoreboardOcr.summary && scoreboardOcr.summary.unreadableCount,
          regionIdsUsed: scoreboardOcr.summary && scoreboardOcr.summary.regionIdsUsed,
          preprocessingVariantCount: scoreboardOcr.summary && scoreboardOcr.summary.preprocessingVariantCount,
          qaReport: scoreboardOcr.summary && scoreboardOcr.summary.qaReport,
          scorebugDebug: scoreboardOcr.summary && scoreboardOcr.summary.scorebugDebug,
          scoreTimeline: scoreboardOcr.summary && scoreboardOcr.summary.scoreTimeline,
          scorebugFirst: false,
        });
      }
      const ocrQaCalibrationOptions = ocrQaCalibrationOptionsFromEnv();
      ocrQaCalibration = publicOcrQaCalibration(deps.loadOcrQaCalibration(ocrQaCalibrationOptions));
      logInfo(deps.logger, {
        event: "ocr_qa_calibration_loaded",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_scoreboard_ocr",
        status: ocrQaCalibration.status,
        usable: ocrQaCalibration.usable,
        decisionSupportLevel: ocrQaCalibration.decisionSupportLevel,
        scoreboardCropQuality: ocrQaCalibration.scoreboardCropQuality,
        goalEvidencePolicy: ocrQaCalibration.goalEvidencePolicy,
        goalDecisionAllowed: ocrQaCalibration.goalDecisionAllowed,
        noFalseGoalFromOcrOnly: ocrQaCalibration.noFalseGoalFromOcrOnly,
        reportRefConfigured: Boolean(ocrQaCalibrationOptions.reportRef),
      });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 50, step: "transcribe", substep: "transcription_provider", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });
      const provider = deps.chooseTranscriptionProvider({ forceMock: !context.metadata.hasAudio });
      transcript = validateTranscript(
        await provider.transcribe({
          audioPath: context.audioPath,
          metadata: context.metadata,
          preset: context.preset,
          title: context.title,
          language: context.language,
        }),
        context.metadata,
      );

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 56, step: "analyze_goal_evidence", substep: "build_goal_anchors", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });
      goalEvidence = await deps.analyzeGoalEvidence({
        inputPath: context.inputPath,
        metadata: context.metadata,
        transcript,
        mediaSignals,
        visualSignals,
        scoreboardOcr: scoreboardOcr && scoreboardOcr.evidence,
        ocrQaCalibration,
        frames: sampledFrames.frames,
        frameSummary: sampledFrameSummary,
        signal,
      });
      visualSignals = mergeGoalEvidenceIntoVisualSignals(visualSignals, goalEvidence, context.metadata);
      matchEventTruth = deps.analyzeMatchEventTruth({
        metadata: {
          ...context.metadata,
          sourceType: (context.source && context.source.sourceType) || context.metadata.sourceType,
          goalSelectionMode: context.goalSelectionMode,
          allowCandidateClusterRecovery: context.goalSelectionMode === "valid_goals_only" &&
            ((context.source && context.source.sourceType) || context.metadata.sourceType) === "youtube",
        },
        transcript,
        mediaSignals,
        visualSignals,
        goalEvidence,
        scoreboardOcr: scoreboardOcr && scoreboardOcr.evidence,
        ocrQaCalibration,
      });
      logInfo(deps.logger, {
        event: "match_event_truth_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_goal_evidence",
        providerMode: matchEventTruth.providerMode,
        confirmedGoalCount: matchEventTruth.summary && matchEventTruth.summary.confirmedGoalCount,
        disallowedGoalCount: matchEventTruth.summary && matchEventTruth.summary.disallowedGoalCount,
        possibleGoalCount: matchEventTruth.summary && matchEventTruth.summary.possibleGoalCount,
        lateConfirmedGoalCount: matchEventTruth.summary && matchEventTruth.summary.lateConfirmedGoalCount,
        scoreTimelineObservationCount: matchEventTruth.summary && matchEventTruth.summary.scoreTimelineObservationCount,
        scoreChangeCount: matchEventTruth.summary && matchEventTruth.summary.scoreChangeCount,
        countedGoalEventCount: matchEventTruth.summary && matchEventTruth.summary.countedGoalEventCount,
        disallowedGoalEventCount: matchEventTruth.summary && matchEventTruth.summary.disallowedGoalEventCount,
        selectedGoalCount: matchEventTruth.summary && matchEventTruth.summary.selectedGoalCount,
        stableScoreChangeAnchorCount: matchEventTruth.summary && matchEventTruth.summary.stableScoreChangeAnchorCount,
        revertedScoreChangeAnchorCount: matchEventTruth.summary && matchEventTruth.summary.revertedScoreChangeAnchorCount,
        anchorsLinkedToGoalPhaseCount: matchEventTruth.summary && matchEventTruth.summary.anchorsLinkedToGoalPhaseCount,
        anchorsMissingVisualSupportCount: matchEventTruth.summary && matchEventTruth.summary.anchorsMissingVisualSupportCount,
        scoreChangeAnchors: Array.isArray(matchEventTruth.scoreChangeAnchors)
          ? matchEventTruth.scoreChangeAnchors.slice(0, 12)
          : [],
        missedGoalReasons: matchEventTruth.summary && matchEventTruth.summary.missedGoalReasons,
        decoderStatusSummary: matchEventTruth.summary && matchEventTruth.summary.decoderStatusSummary,
        noFalseGoalFromOcrOnly: matchEventTruth.summary && matchEventTruth.summary.noFalseGoalFromOcrOnly,
        ocrQaSupportStatus: matchEventTruth.summary && matchEventTruth.summary.ocrQaSupportStatus,
      });
      logInfo(deps.logger, {
        event: "goal_evidence_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_goal_evidence",
        providerMode: goalEvidence.providerMode,
        fallbackUsed: goalEvidence.fallbackUsed,
        evidenceEventCount: goalEvidence.summary && goalEvidence.summary.eventCount,
        validGoalCount: goalEvidence.summary && goalEvidence.summary.validGoalCount,
        offsideOrNoGoalCount: goalEvidence.summary && goalEvidence.summary.offsideOrNoGoalCount,
        unconfirmedGoalCount: goalEvidence.summary && goalEvidence.summary.unconfirmedGoalCount,
        celebrationOnlyCount: goalEvidence.summary && goalEvidence.summary.celebrationOnlyCount,
        anthemOrIntroCount: goalEvidence.summary && goalEvidence.summary.anthemOrIntroCount,
        ocrEvidenceCount: goalEvidence.summary && goalEvidence.summary.ocrEvidenceCount,
        scoreboardConfirmedGoalCount: goalEvidence.summary && goalEvidence.summary.scoreboardConfirmedGoalCount,
        ambiguousOcrCount: goalEvidence.summary && goalEvidence.summary.ambiguousOcrCount,
        goalEvidenceCoverage: goalEvidence.summary && goalEvidence.summary.goalEvidenceCoverage,
        ocrQaStatus: goalEvidence.summary && goalEvidence.summary.ocrQaStatus,
        ocrQaUsable: goalEvidence.summary && goalEvidence.summary.ocrQaUsable,
        ocrQaSupportLevel: goalEvidence.summary && goalEvidence.summary.ocrQaSupportLevel,
      });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 58, step: "detect_highlights", substep: "recover_goal_phases", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });
      highlightResult = validateHighlightResult(
        deps.detectHighlights({
          transcript,
          signals: mediaSignals,
          visualSignals,
          goalEvidence,
          matchEventTruth,
          preset: context.preset,
          title: context.title,
        }),
        context.metadata,
      );

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 66, step: "plan_story", substep: "football_story_planning", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 72, step: "create_edit_plan", substep: "build_edit_plan", longSource: longSourceRuntime, scorebugFirst: longSourceRuntime });
      candidatePlans = deps.createCandidateEditPlans({
        moments: highlightResult.moments,
        metadata: {
          ...context.metadata,
          goalSelectionMode: context.goalSelectionMode,
        },
        transcript,
        mediaSignals,
        visualSignals,
        goalEvidence,
        matchEventTruth,
        visualTracking,
        preset: context.preset,
        title: context.title,
        language: context.language,
        styleTarget: context.styleTarget,
        editIntensity: context.editIntensity,
        stylePreset: context.stylePreset,
      });
      if (!Array.isArray(candidatePlans) || candidatePlans.length === 0) {
        const code = context.goalSelectionMode === "valid_goals_only" ? "NO_VALID_GOALS_FOUND" : "AI_OUTPUT_INVALID";
        if (context.goalSelectionMode === "valid_goals_only") {
          const goalDiscovery = highlightResult &&
            highlightResult.explainability &&
            highlightResult.explainability.goalDiscovery;
          const goalEvidenceCandidates = goalDiscovery &&
            Array.isArray(goalDiscovery.goalEvidenceCandidates) &&
            goalDiscovery.goalEvidenceCandidates.length > 0
            ? goalDiscovery.goalEvidenceCandidates.slice(0, 12)
            : safeGoalEvidenceCandidates(goalEvidence);
          const stableChanges = stableScoreChangeCount(scoreboardOcr);
          const countedGoalEvents = matchEventTruth && matchEventTruth.summary
            ? safeNumber(matchEventTruth.summary.countedGoalEventCount) || 0
            : 0;
          const failureDetails = buildValidGoalSelectionFailureDetails({
            context,
            deps,
            scoreboardOcr,
            goalEvidence,
            matchEventTruth,
            goalDiscovery,
            goalEvidenceCandidates,
            stableChanges,
            countedGoalEvents,
          });
          logInfo(deps.logger, {
            event: "valid_goal_selection_empty",
            requestId,
            projectId: project.id,
            jobId: job.id,
            step: "create_edit_plan",
            code,
            ...failureDetails,
            scoreboardOcrAttempted: Boolean(scoreboardOcr),
            scoreboardOcrEnabled: scoreboardOcrEnabledForTrace(scoreboardOcr),
            scoreboardOcrProviderMode: scoreboardOcr && scoreboardOcr.providerMode,
            scoreboardObservationCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.evidenceCount,
            scoreboardSampledFrameCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.sampledFrameCount,
            scoreChangeCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.scoreChangeCount,
            stableScoreChangeCount: stableChanges,
            countedGoalEventCount: countedGoalEvents,
            missingEvidenceByCandidate: missingEvidenceByCandidate(goalEvidenceCandidates),
            nextAction: goalEvidenceTraceNextAction({ scoreboardOcr, stableChanges, countedGoalEvents }),
            visualWindowCount: goalDiscovery && goalDiscovery.visualWindowCount,
            bucketCount: goalDiscovery && goalDiscovery.bucketCount,
            lateBucketInspected: goalDiscovery && goalDiscovery.lateBucketInspected,
            selectedValidGoalCount: goalDiscovery && Array.isArray(goalDiscovery.selectedValidGoals)
              ? goalDiscovery.selectedValidGoals.length
              : 0,
            goalEvidenceCandidates,
            matchTruthCandidates: goalDiscovery && Array.isArray(goalDiscovery.matchTruthCandidates)
              ? goalDiscovery.matchTruthCandidates.slice(0, 16)
              : [],
            excludedOffsideOrNoGoalCount: goalDiscovery && Array.isArray(goalDiscovery.excludedOffsideOrNoGoal)
              ? goalDiscovery.excludedOffsideOrNoGoal.length
              : 0,
            excludedUnconfirmedBallInNetCount: goalDiscovery && Array.isArray(goalDiscovery.excludedUnconfirmedBallInNet)
              ? goalDiscovery.excludedUnconfirmedBallInNet.length
              : 0,
            goalEvidenceEventCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.eventCount,
            validGoalEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount,
            offsideOrNoGoalEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.offsideOrNoGoalCount,
            celebrationOnlyEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.celebrationOnlyCount,
            anthemOrIntroEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.anthemOrIntroCount,
            ocrEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.ocrEvidenceCount,
            scoreboardConfirmedGoalCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.scoreboardConfirmedGoalCount,
            recoverableGoalEvidenceCandidateCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.recoverableCandidateCount,
            rejectedGoalEvidenceCandidateCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.rejectedCandidateCount,
            matchEventTruthConfirmedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.confirmedGoalCount,
            matchEventTruthDisallowedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.disallowedGoalCount,
            matchEventTruthPossibleGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.possibleGoalCount,
            matchEventTruthScoreTimelineObservationCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.scoreTimelineObservationCount,
            matchEventTruthScoreChangeCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.scoreChangeCount,
            matchEventTruthCountedGoalEventCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.countedGoalEventCount,
            matchEventTruthDisallowedGoalEventCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.disallowedGoalEventCount,
            matchEventTruthSelectedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.selectedGoalCount,
            matchEventTruthScoreChangeAnchorsFound: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.scoreChangeAnchorsFound,
            matchEventTruthStableScoreChangeAnchorCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.stableScoreChangeAnchorCount,
            matchEventTruthRevertedScoreChangeAnchorCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.revertedScoreChangeAnchorCount,
            matchEventTruthAnchorsLinkedToGoalPhaseCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.anchorsLinkedToGoalPhaseCount,
            matchEventTruthAnchorsMissingVisualSupportCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.anchorsMissingVisualSupportCount,
            matchEventTruthAnchorsWithLiveActionEvidence: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.anchorsWithLiveActionEvidence,
            matchEventTruthAnchorsRejected: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.anchorsRejected,
            matchEventTruthSelectedCountedGoals: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.selectedCountedGoals,
            matchEventTruthOcrOnlyBlockedCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.ocrOnlyBlockedCount,
            matchEventTruthMissingActionEvidenceCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.missingActionEvidenceCount,
            matchEventTruthMissedGoalReasons: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.missedGoalReasons,
            matchEventTruthScoreChangeAnchors: matchEventTruth && Array.isArray(matchEventTruth.scoreChangeAnchors)
              ? matchEventTruth.scoreChangeAnchors.slice(0, 12)
              : [],
          });
          throw new AppError(code, SAFE_MESSAGES[code], 422, failureDetails);
        }
        throw new AppError(code, SAFE_MESSAGES[code], 422);
      }
      editPlan = deps.validateEditPlan(candidatePlans[0], context.metadata);
      if (candidatePlans[0] && candidatePlans[0].visualQA) {
        editPlan.visualQA = candidatePlans[0].visualQA;
      }
    }
    if (!context.approvedEditPlan && context.goalSelectionMode === "valid_goals_only") {
      try {
        videoOutputQA = deps.assertVideoOutputCoverage({
          editPlan,
          matchEventTruth,
          goalSelectionMode: context.goalSelectionMode,
        });
      } catch (error) {
        if (error && error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
          videoOutputQA = error.details;
          editPlan.videoOutputQA = videoOutputQA;
          jobs.update(job, {
            editPlan,
            videoOutputQA,
            step: "video_output_qa_failed",
          });
          logInfo(deps.logger, {
            event: "video_output_qa_failed",
            requestId,
            projectId: project.id,
            jobId: job.id,
            step: "create_edit_plan",
            status: videoOutputQA.status,
            expectedGoalCount: videoOutputQA.expectedGoalCount,
            actualConfirmedGoalSegmentCount: videoOutputQA.actualConfirmedGoalSegmentCount,
            coveredGoalCount: videoOutputQA.coveredGoalCount,
            missingGoalNumbers: videoOutputQA.missingGoalNumbers,
            failedReasonCount: Array.isArray(videoOutputQA.failedReasons) ? videoOutputQA.failedReasons.length : 0,
            logsDownloaded: false,
            artifactsDownloaded: false,
          });
        }
        throw error;
      }
      editPlan.videoOutputQA = videoOutputQA;
      logInfo(deps.logger, {
        event: "video_output_qa_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "create_edit_plan",
        status: videoOutputQA.status,
        expectedGoalCount: videoOutputQA.expectedGoalCount,
        actualConfirmedGoalSegmentCount: videoOutputQA.actualConfirmedGoalSegmentCount,
        coveredGoalCount: videoOutputQA.coveredGoalCount,
        extraGoalSegmentCount: videoOutputQA.extraGoalSegmentCount,
        failedReasonCount: Array.isArray(videoOutputQA.failedReasons) ? videoOutputQA.failedReasons.length : 0,
        logsDownloaded: false,
        artifactsDownloaded: false,
      });
    }
    logInfo(deps.logger, {
      event: "edit_plan_selected",
      requestId,
      projectId: project.id,
      jobId: job.id,
      highlightType: editPlan.highlightType,
      confidence: editPlan.confidence,
      actionFocusConfidence: editPlan.actionFocusConfidence,
      framingMode: editPlan.framingMode,
      framingReason: editPlan.framingReason,
      stylePreset: editPlan.stylePreset,
      styleTarget: editPlan.styleTarget,
      editIntensity: editPlan.editIntensity,
      aspectRatio: editPlan.aspectRatio,
      cropPlanMode: editPlan.cropPlan && editPlan.cropPlan.mode,
      cropPlanFallbackUsed: editPlan.cropPlan && editPlan.cropPlan.fallbackUsed,
      animationCueCount: Array.isArray(editPlan.animationCues) ? editPlan.animationCues.length : 0,
      unsupportedAnimationCueCount: Array.isArray(editPlan.unsupportedAnimationCues) ? editPlan.unsupportedAnimationCues.length : 0,
      captionSafetyStatus: editPlan.highlightType === "goal" ? "goal-language-allowed" : "false-goal-guarded",
      falseGoalGuardTriggered: editPlan.highlightType !== "goal",
      visualProviderMode: visualSignals.providerMode,
      visualWindowCount: visualSignals.summary.windowCount,
      scoreboardOcrProviderMode: scoreboardOcr && scoreboardOcr.providerMode,
      scoreboardOcrEvidenceCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.evidenceCount,
      scoreboardOcrScoreChangeCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.scoreChangeCount,
      scoreboardOcrAmbiguousCount: scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.ambiguousCount,
      ocrQaStatus: ocrQaCalibration && ocrQaCalibration.status,
      ocrQaUsable: ocrQaCalibration && ocrQaCalibration.usable,
      ocrQaSupportLevel: ocrQaCalibration && ocrQaCalibration.decisionSupportLevel,
      goalEvidenceProviderMode: goalEvidence && goalEvidence.providerMode,
      goalEvidenceEventCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.eventCount,
      validGoalEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount,
      matchEventTruthConfirmedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.confirmedGoalCount,
      matchEventTruthDisallowedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.disallowedGoalCount,
      visualTrackingConfidence: visualTracking && visualTracking.trackingConfidence,
    });

    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 78, step: "render_kinetic_captions", substep: "caption_animation_plan" });
    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 82, step: "render_beat_effects", substep: "effect_timeline_plan" });
    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 86, step: "render_short", substep: "ffmpeg_render" });
    await deps.renderShort({
      inputPath: context.inputPath,
      outputPath: context.outputPath,
      subtitlesPath: context.subtitlesPath,
      plan: editPlan,
      signal,
    });
    if (!deps.fileExists(context.outputPath) || !deps.isRegularFile(context.outputPath)) {
      throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
    }

    const renderedArtifact = typeof deps.artifactStore.commitOutputStageAsync === "function"
      ? await deps.artifactStore.commitOutputStageAsync(context.outputStage, {
          contentType: "video/mp4",
          status: "available",
          signal,
        })
      : deps.artifactStore.commitOutputStage(context.outputStage, {
          contentType: "video/mp4",
          status: "available",
        });
    logInfo(deps.logger, {
      event: "artifact_committed",
      requestId,
      projectId: project.id,
      jobId: job.id,
      artifactId: renderedArtifact.id,
      storageMode: context.outputStage.adapterMode,
      step: "commit_render",
    });
    indexArtifact(deps, renderedArtifact);

    const exportId = deps.createExportId();
    const exportRecord = persistExportAndReadyProject({
      deps,
      exportsById,
      project,
      record: {
        id: exportId,
        projectId: project.id,
        jobId: job.id,
        ownerId: job.ownerId || project.ownerId || null,
        outputPath: context.outputStage.permanentLocal ? context.outputPath : null,
        artifact: deps.artifactStore.createRecord({
          id: exportId,
          type: "export",
          ownerProjectId: project.id,
          ownerJobId: job.id,
          storageKey: context.outputKey,
          size: renderedArtifact.size ?? artifactSize(deps, context.outputPath),
          contentType: renderedArtifact.contentType || "video/mp4",
          source: context.source,
          status: "available",
        }),
        fileName: `${project.id}-short.mp4`,
        source: context.source,
        createdAt: nowIso(),
      },
    });
    jobs.complete(job, {
      outputPath: context.outputStage.permanentLocal ? context.outputPath : null,
      exportId,
      editPlan,
      candidatePlans,
      highlights: highlightResult.moments,
      mediaSignals: publicMediaSignals(mediaSignals),
      visualSignals: publicVisualSignals(visualSignals),
      scoreboardOcr: publicScoreboardOcr(scoreboardOcr),
      ocrQaCalibration: publicOcrQaCalibration(ocrQaCalibration),
      goalEvidence: publicGoalEvidence(goalEvidence),
      matchEventTruth: publicMatchEventTruth(matchEventTruth),
      trackingProviderOutput,
      visualTracking,
      sampledFrames: sampledFrameSummary,
      videoOutputQA,
      step: "completed",
      progressMeta: {
        phase: "completed",
        step: "completed",
        substep: null,
        startedAt: nowIso(),
        longSource: Boolean(longSourceRuntime),
        scorebugFirst: Boolean(longSourceRuntime),
        budgetMs: null,
      },
    });
    updateApprovalAudit({
      deps,
      context,
      job,
      projectId: project.id,
      requestId,
      status: "render_completed",
      exportId,
    });
    persistRenderResult(deps, {
      project,
      job: jobs.publicJob(job),
      transcript,
      mediaSignals,
      visualSignals,
      scoreboardOcr: publicScoreboardOcr(scoreboardOcr),
      ocrQaCalibration: publicOcrQaCalibration(ocrQaCalibration),
      goalEvidence: publicGoalEvidence(goalEvidence),
      matchEventTruth: publicMatchEventTruth(matchEventTruth),
      trackingProviderOutput,
      visualTracking,
      sampledFrames: sampledFrameSummary,
      videoOutputQA,
      highlights: highlightResult.moments,
      candidatePlans,
      editPlan,
      exportId,
      exportRecord,
    });
    logInfo(deps.logger, {
      event: "job_completed",
      requestId,
      projectId: project.id,
      jobId: job.id,
      exportId,
      highlightType: editPlan.highlightType,
      confidence: editPlan.confidence,
      actionFocusConfidence: editPlan.actionFocusConfidence,
      framingMode: editPlan.framingMode,
      framingReason: editPlan.framingReason,
      stylePreset: editPlan.stylePreset,
      styleTarget: editPlan.styleTarget,
      editIntensity: editPlan.editIntensity,
      aspectRatio: editPlan.aspectRatio,
      cropPlanMode: editPlan.cropPlan && editPlan.cropPlan.mode,
      cropPlanFallbackUsed: editPlan.cropPlan && editPlan.cropPlan.fallbackUsed,
      animationCueCount: Array.isArray(editPlan.animationCues) ? editPlan.animationCues.length : 0,
      unsupportedAnimationCueCount: Array.isArray(editPlan.unsupportedAnimationCues) ? editPlan.unsupportedAnimationCues.length : 0,
      captionSafetyStatus: editPlan.highlightType === "goal" ? "goal-language-allowed" : "false-goal-guarded",
      falseGoalGuardTriggered: editPlan.highlightType !== "goal",
      visualProviderMode: visualSignals.providerMode,
      visualWindowCount: visualSignals.summary.windowCount,
      goalEvidenceProviderMode: goalEvidence && goalEvidence.providerMode,
      goalEvidenceEventCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.eventCount,
      validGoalEvidenceCount: goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount,
      matchEventTruthConfirmedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.confirmedGoalCount,
      matchEventTruthDisallowedGoalCount: matchEventTruth && matchEventTruth.summary && matchEventTruth.summary.disallowedGoalCount,
      ocrQaStatus: ocrQaCalibration && ocrQaCalibration.status,
      ocrQaUsable: ocrQaCalibration && ocrQaCalibration.usable,
      ocrQaSupportLevel: ocrQaCalibration && ocrQaCalibration.decisionSupportLevel,
      visualTrackingConfidence: visualTracking && visualTracking.trackingConfidence,
    });
  } catch (error) {
    if ((signal && signal.aborted) || (job && job.status === "cancelled") || error.code === "JOB_CANCELLED") {
      completeCancelledJob({ jobs, job, logger: deps.logger, projectId: project && project.id, requestId });
      updateApprovalAudit({
        deps,
        context,
        job,
        projectId: project && project.id,
        requestId,
        status: "cancelled",
        error,
      });
      return;
    }
    failJob({ jobs, job, project, error, logger: deps.logger, requestId });
    updateApprovalAudit({
      deps,
      context,
      job,
      projectId: project && project.id,
      requestId,
      status: "render_failed",
      error,
    });
  } finally {
    if (sampledFrames && typeof deps.cleanupSampledFrames === "function") {
      const cleanupResult = deps.cleanupSampledFrames({
        outputDir: sampledFrames.outputDir,
        frames: sampledFrames.frames,
      });
      if (cleanupResult && cleanupResult.cleanedCount > 0) {
        logInfo(deps.logger, {
          event: "sampled_frames_cleaned",
          requestId,
          projectId: project && project.id,
          jobId: job && job.id,
          step: "cleanup_sampled_frames",
          cleanedCount: cleanupResult.cleanedCount,
        });
      }
    }
    cleanupPipelineStages({
      deps,
      context,
      logger: deps.logger,
      requestId,
      projectId: project && project.id,
      jobId: job && job.id,
    });
  }
}

function enqueueRenderJob(options) {
  const { jobs, job, project, requestId, dependencies } = options || {};
  const deps = createDefaultDependencies(dependencies);
  if (!job || job.status !== "queued") return job;
  jobs.update(job, { status: "processing", progress: 1, step: "queued" });
  logInfo(deps.logger, {
    event: "job_started",
    requestId,
    projectId: project && project.id,
    jobId: job.id,
  });
  deps.scheduler(() => {
    runRenderJob({ ...options, dependencies: deps }).catch((error) => {
      logInfo(deps.logger, {
        event: "job_unhandled_rejection",
        requestId,
        projectId: project && project.id,
        jobId: job.id,
        code: error && error.code ? error.code : "UNEXPECTED",
      });
    });
  });
  return job;
}

module.exports = {
  createDefaultDependencies,
  enqueueRenderJob,
  runRenderJob,
  validateHighlightResult,
  validateMediaSignals,
  validateTranscript,
  visualCandidateWindowsFromSignals,
  resolveLocalArtifactPath,
  ocrQaCalibrationOptionsFromEnv,
};
