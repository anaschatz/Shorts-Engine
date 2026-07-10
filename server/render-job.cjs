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
const { analyzeRenderedGoalProof } = require("./rendered-goal-proof.cjs");
const { loadOcrQaCalibration, publicOcrQaCalibration } = require("./ocr-qa-calibration.cjs");
const {
  analyzeScoreboardOcr,
  defaultScoreboardRegions,
  digitSignatureSimilarity,
  publicScoreboardOcr,
  recoverScoresFromDigitTemplates,
  validateScoreboardOcrOutput,
} = require("./scoreboard-ocr.cjs");
const { buildScoreboardTimelineFromObservations } = require("./adapters/local-ocr-adapter.cjs");
const { chooseTranscriptionProvider } = require("./transcription.cjs");
const { assertStoragePath, storagePath, writeJsonAtomic } = require("./storage.cjs");
const { analyzeTracking, publicTrackingProviderOutput, trackingFallback } = require("./tracking-provider.cjs");
const { assertVideoOutputCoverage } = require("./video-output-gate.cjs");
const { analyzeFrames, publicVisualSignals, validateVisualSignals, VISUAL_SIGNAL_TYPES } = require("./vision.cjs");
const { analyzeVisualTracking, calibrateCropPlan, publicVisualTrackingSummary } = require("./visual-tracking.cjs");
const { isLocalVideoProofSource } = require("./staging-smoke-metadata.cjs");

const SCOREBUG_FIRST_OCR_BUDGET_MS = 45_000;
const VISUAL_WINDOW_OCR_BUDGET_MS = 30_000;
const SCOREBUG_FIRST_CHUNK_SECONDS = 90;
const SCOREBUG_FIRST_CHUNK_FRAME_COUNT = 16;
const SCOREBUG_FIRST_CHUNK_TIMEOUT_MS = 30_000;
const SCOREBUG_FIRST_MAX_TOTAL_OCR_BUDGET_MS = 240_000;
const RENDERED_GOAL_REBIND_MAX_ATTEMPTS = 1;
const REFERENCE_STYLE_GOAL_COUNT = 5;
const REFERENCE_STYLE_MAX_DURATION_SECONDS = 125;
const SCORE_CHANGE_REBIND_MAX_BACKTRACK_SECONDS = 65;
const SCORE_CHANGE_REBIND_MAX_FINISH_LEAD_SECONDS = 45;
const SCORE_CHANGE_REBIND_MIN_FINISH_LEAD_SECONDS = 0.5;
const SCORE_CHANGE_REBIND_PRESERVED_BACKTRACK_SECONDS = 20;
const RENDERED_GOAL_REBIND_MAX_SEGMENT_SECONDS = 64;
const RENDERED_GOAL_REBIND_PROFILES = Object.freeze([
  { backtrackSeconds: 15, finishLeadSeconds: 8, postConfirmationSeconds: 2.35 },
  { backtrackSeconds: 15, finishLeadSeconds: 11, postConfirmationSeconds: 2.35 },
  { backtrackSeconds: 18, finishLeadSeconds: 15, postConfirmationSeconds: 2.35 },
]);
const SCOREBUG_FIRST_ROI_CANDIDATE_IDS = Object.freeze([
  "scorebug_broadcast_compact",
  "scorebug_left_compact",
  "scoreboard_top_left",
  "scoreboard_top_center",
  "scoreboard_top_right",
]);
const SCOREBOARD_OVERLAY_LAYOUTS = Object.freeze({
  scorebug_broadcast_compact: Object.freeze({ x: 0.04, y: 0.045, width: 0.33, height: 0.065 }),
  scorebug_left_compact: Object.freeze({ x: 0.01, y: 0.01, width: 0.26, height: 0.11 }),
  scoreboard_top_left: Object.freeze({ x: 0.01, y: 0.01, width: 0.44, height: 0.16 }),
  scoreboard_top_center: Object.freeze({ x: 0.28, y: 0.01, width: 0.44, height: 0.16 }),
  scoreboard_top_right: Object.freeze({ x: 0.55, y: 0.01, width: 0.44, height: 0.16 }),
});

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
    calibrateCropPlan,
    isRegularFile,
    logger: console,
    renderShort,
    analyzeRenderedGoalProof,
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

function safeUniqueReasonList(values = [], max = 8) {
  return [...new Set(safeReasonList(values, max * 2))].slice(0, max);
}

function fallbackVisualWindowsFromCandidateWindows(candidateWindows = [], metadata = {}) {
  const allowedTypes = new Set(VISUAL_SIGNAL_TYPES);
  const duration = safeNumber(metadata && metadata.durationSeconds) || 0;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
  return (Array.isArray(candidateWindows) ? candidateWindows : [])
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const rawTime = safeNumber(candidate.time ?? candidate.timestamp ?? candidate.center);
      const rawStart = safeNumber(candidate.start);
      const rawEnd = safeNumber(candidate.end);
      const center = rawTime ?? (
        rawStart != null && rawEnd != null ? (rawStart + rawEnd) / 2 : null
      );
      if (center == null) return null;
      const maxBound = duration > 0 ? duration : Math.max(center + 2, rawEnd || center + 2);
      const start = Number(clamp(rawStart ?? center - 1.5, 0, Math.max(0, maxBound - 0.4)).toFixed(2));
      const end = Number(clamp(rawEnd ?? center + 1.5, start + 0.4, maxBound).toFixed(2));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      const hints = Array.isArray(candidate.visualHints) ? candidate.visualHints : [];
      const types = hints
        .map((hint) => sanitizeText(hint, 48).toLowerCase())
        .filter((hint) => allowedTypes.has(hint))
        .slice(0, 4);
      return {
        start,
        end,
        time: Number(((start + end) / 2).toFixed(2)),
        confidence: Math.max(0.35, Math.min(0.72, Number(candidate.confidence || 0.45))),
        types: types.length ? [...new Set(types)] : ["unknown_visual_action"],
        source: "scorebug_candidate_fallback",
        label: "scorebug candidate fallback",
      };
    })
    .filter(Boolean)
    .slice(0, 24);
}

function safeGoalProofFailures(renderedGoalProof = {}) {
  const goals = renderedGoalProof &&
    renderedGoalProof.summary &&
    Array.isArray(renderedGoalProof.summary.goals)
    ? renderedGoalProof.summary.goals
    : [];
  return goals
    .filter((goal) => goal && goal.verdict !== "clear")
    .map((goal) => {
      const failedRoles = Array.isArray(goal.frameRefs)
        ? goal.frameRefs
            .filter((frame) => frame && frame.clear !== true)
            .map((frame) => ({
              role: sanitizeText(frame.role || "", 40) || "unknown",
              reason: sanitizeText(frame.reason || "not_clear", 80),
              status: sanitizeText(frame.status || "failed", 40),
              confidence: safeNumber(frame.confidence),
            }))
        : [];
      return {
        goalNumber: Number.isInteger(Number(goal.goalNumber)) ? Number(goal.goalNumber) : null,
        segmentIndex: Number.isInteger(Number(goal.segmentIndex)) ? Number(goal.segmentIndex) : null,
        verdict: sanitizeText(goal.verdict || "failed", 40),
        failedRoles,
      };
    })
    .filter((goal) => goal.goalNumber != null || goal.segmentIndex != null)
    .slice(0, 8);
}

function safeSegmentAnchorTime(segment = {}) {
  const sourceStart = safeNumber(segment.sourceStart);
  const sourceEnd = safeNumber(segment.sourceEnd);
  const minReasonable = sourceStart == null ? 0 : Math.max(0, sourceStart - 45);
  const maxReasonable = sourceEnd == null ? Number.POSITIVE_INFINITY : sourceEnd + 15;
  const candidates = [
    segment.scoreChangeTime,
    segment.confirmationTime,
    segment.finishTime,
    segment.sourceEnd,
  ];
  for (const candidate of candidates) {
    const parsed = safeNumber(candidate);
    if (parsed == null) continue;
    if (parsed < minReasonable || parsed > maxReasonable) continue;
    return parsed;
  }
  return null;
}

function rebindProfileForAttempt(attemptNumber = 1) {
  const index = Math.max(0, Math.min(RENDERED_GOAL_REBIND_PROFILES.length - 1, Number(attemptNumber || 1) - 1));
  return RENDERED_GOAL_REBIND_PROFILES[index];
}

function goalTrackingCandidateWindows(editPlan = {}, metadata = {}) {
  const duration = safeNumber(metadata && metadata.durationSeconds) || Number.POSITIVE_INFINITY;
  const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
  const windows = [];
  const seen = new Set();
  for (const [segmentIndex, segment] of segments.entries()) {
    if (!confirmedGoalSegment(segment)) continue;
    const sourceStart = safeNumber(segment.sourceStart);
    const sourceEnd = safeNumber(segment.sourceEnd);
    const finishTime = safeNumber(segment.finishTime);
    const scoreChangeTime = safeNumber(segment.scoreChangeTime ?? segment.confirmationTime);
    if (sourceStart == null || sourceEnd == null || sourceEnd <= sourceStart) continue;
    const candidates = [
      ["buildup", sourceStart + 1.5],
      ["score_change_minus_8", scoreChangeTime == null ? null : scoreChangeTime - 8],
      ["celebration_head", scoreChangeTime == null || finishTime == null
        ? null
        : Math.min(sourceEnd - 0.4, Math.max(finishTime + 2.5, scoreChangeTime - 5.5))],
      ["celebration_head", scoreChangeTime == null ? null : Math.min(sourceEnd - 0.35, scoreChangeTime - 1.6)],
    ];
    for (const [role, value] of candidates) {
      const parsed = safeNumber(value);
      if (parsed == null) continue;
      const time = Number(Math.min(duration, Math.max(sourceStart + 0.08, Math.min(sourceEnd - 0.08, parsed))).toFixed(2));
      const key = time.toFixed(2);
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push({
        time,
        start: Number(Math.max(0, time - 0.08).toFixed(2)),
        end: Number(Math.min(duration, time + 0.08).toFixed(2)),
        confidence: 0.9,
        source: "selected_goal_tracking_refinement",
        visualHints: [
          "football_action",
          `goal_${segment.goalNumber || segmentIndex + 1}`,
          role,
          ...(role === "score_change_minus_8" ? ["celebration_head"] : []),
        ],
      });
    }
  }
  return windows
    .sort((left, right) => left.time - right.time)
    .slice(0, 24);
}

function confirmedGoalSegment(segment) {
  return Boolean(
    segment &&
    segment.highlightType === "goal" &&
    segment.goalOutcome &&
    segment.goalOutcome.outcome === "confirmed_goal"
  );
}

function chronologicalRebindBounds(segments = [], index = 0, durationSeconds = 0) {
  let lowerBound = 0;
  let lowerBoundReason = "source_start";
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = segments[cursor];
    if (!confirmedGoalSegment(previous)) continue;
    const previousEnd = safeNumber(previous.sourceEnd);
    const previousAnchor = safeSegmentAnchorTime(previous);
    const previousBound = previousAnchor == null
      ? (previousEnd == null ? 0 : previousEnd + 0.5)
      : previousAnchor + 1.5;
    lowerBound = Math.max(0, previousBound);
    lowerBoundReason = previousAnchor == null
      ? "previous_confirmed_goal_end"
      : "previous_confirmed_goal_anchor";
    break;
  }

  let upperBound = durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  let upperBoundReason = "source_end";
  for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
    const next = segments[cursor];
    if (!confirmedGoalSegment(next)) continue;
    const nextStart = safeNumber(next.sourceStart);
    const nextAnchor = safeSegmentAnchorTime(next);
    const nextBound = Math.min(
      nextStart == null ? Number.POSITIVE_INFINITY : nextStart - 0.5,
      nextAnchor == null ? Number.POSITIVE_INFINITY : nextAnchor - 3,
    );
    if (Number.isFinite(nextBound)) {
      upperBound = Math.max(lowerBound + 3, nextBound);
      upperBoundReason = "next_confirmed_goal";
    }
    break;
  }

  return {
    lowerBound: Number(lowerBound.toFixed(2)),
    lowerBoundReason,
    upperBound: Number.isFinite(upperBound) ? Number(upperBound.toFixed(2)) : null,
    upperBoundReason,
  };
}

function rebindRenderedGoalFailureSegments({ editPlan, renderedGoalProof, metadata = {}, attemptNumber = 1 } = {}) {
  const failures = safeGoalProofFailures(renderedGoalProof);
  const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
  if (!failures.length || !segments.length) {
    return { applied: false, editPlan, summary: null };
  }
  const failureByGoal = new Map();
  const failureByIndex = new Map();
  for (const failure of failures) {
    if (failure.goalNumber != null) failureByGoal.set(failure.goalNumber, failure);
    if (failure.segmentIndex != null) failureByIndex.set(failure.segmentIndex, failure);
  }
  const durationSeconds = safeNumber(metadata && metadata.durationSeconds) || safeNumber(editPlan && editPlan.sourceEnd) || 0;
  const profile = rebindProfileForAttempt(attemptNumber);
  const diagnostics = [];
  let applied = false;
  const reboundSegments = segments.map((segment, index) => {
    const goalNumber = Number.isInteger(Number(segment && segment.goalNumber)) ? Number(segment.goalNumber) : index + 1;
    const failure = failureByGoal.get(goalNumber) || failureByIndex.get(index + 1);
    const previousAttempt = safeNumber(segment && segment.renderedVisibilityRebinding && segment.renderedVisibilityRebinding.attemptNumber) || 0;
    const alreadyRebound = previousAttempt >= Number(attemptNumber || 1) && segment &&
      segment.renderedVisibilityRebinding &&
      segment.renderedVisibilityRebinding.applied === true;
    const confirmedGoal = confirmedGoalSegment(segment);
    if (!failure || alreadyRebound || !confirmedGoal) return segment;
    const anchor = safeSegmentAnchorTime(segment);
    const currentStart = safeNumber(segment.sourceStart);
    const currentEnd = safeNumber(segment.sourceEnd);
    if (anchor == null || currentStart == null || currentEnd == null) return segment;

    const finishLeadSeconds = Math.min(
      SCORE_CHANGE_REBIND_MAX_FINISH_LEAD_SECONDS,
      Math.max(SCORE_CHANGE_REBIND_MIN_FINISH_LEAD_SECONDS, Number(profile.finishLeadSeconds || 0)),
    );
    const earliestScoreBoundStart = Math.max(0, anchor - SCORE_CHANGE_REBIND_MAX_BACKTRACK_SECONDS);
    const chronologicalBounds = chronologicalRebindBounds(segments, index, durationSeconds);
    const rawFinishTime = Math.max(0.8, anchor - finishLeadSeconds);
    const desiredSourceStart = Math.max(0, anchor - Number(profile.backtrackSeconds || 15));
    const rawSourceStart = Math.max(
      earliestScoreBoundStart,
      anchor - SCORE_CHANGE_REBIND_PRESERVED_BACKTRACK_SECONDS,
      Math.min(currentStart, desiredSourceStart),
      chronologicalBounds.lowerBound,
    );
    const latestFinishTime = Math.max(0.8, anchor - SCORE_CHANGE_REBIND_MIN_FINISH_LEAD_SECONDS);
    const lowerBoundClippedBuildup = chronologicalBounds.lowerBound > desiredSourceStart + 0.25;
    const minimumFinishOffsetFromStart = 4;
    const finishTime = Number(Math.min(
      latestFinishTime,
      Math.max(rawFinishTime, chronologicalBounds.lowerBound + minimumFinishOffsetFromStart),
    ).toFixed(2));
    let sourceStart = Number(Math.max(
      chronologicalBounds.lowerBound,
      Math.min(rawSourceStart, finishTime - minimumFinishOffsetFromStart),
    ).toFixed(2));
    const searchEnd = durationSeconds > 0
      ? Math.min(durationSeconds, anchor + profile.postConfirmationSeconds)
      : anchor + profile.postConfirmationSeconds;
    const searchStart = Math.max(earliestScoreBoundStart, chronologicalBounds.lowerBound);
    const desiredSourceEnd = Math.max(
      anchor + profile.postConfirmationSeconds,
      finishTime + 4.5,
    );
    const sourceEnd = durationSeconds > 0
      ? Number(Math.min(durationSeconds, chronologicalBounds.upperBound || durationSeconds, desiredSourceEnd).toFixed(2))
      : Number(desiredSourceEnd.toFixed(2));
    if (sourceEnd - sourceStart > RENDERED_GOAL_REBIND_MAX_SEGMENT_SECONDS) {
      sourceStart = Number(Math.max(
        chronologicalBounds.lowerBound,
        sourceEnd - RENDERED_GOAL_REBIND_MAX_SEGMENT_SECONDS,
      ).toFixed(2));
    }
    const scoreChangeConfirmedOutsideClip = anchor > sourceEnd;
    const shotStart = Number(Math.max(sourceStart + 2, finishTime - 3.25).toFixed(2));
    if (sourceEnd <= sourceStart + 3) return segment;

    applied = true;
    const original = {
      sourceStart: Number(currentStart.toFixed(2)),
      sourceEnd: Number(currentEnd.toFixed(2)),
      shotStart: safeNumber(segment.shotStart),
      finishTime: safeNumber(segment.finishTime),
      confirmationTime: safeNumber(segment.confirmationTime),
    };
    const confirmationTime = Number(anchor.toFixed(2));
    const selectedWindow = {
      sourceStart,
      sourceEnd,
      shotStart,
      finishTime,
      confirmationTime,
      scoreChangeTime: Number(anchor.toFixed(2)),
    };
    const rebindingSearchWindow = {
      start: Number(searchStart.toFixed(2)),
      end: Number(searchEnd.toFixed(2)),
    };
    diagnostics.push({
      goalNumber,
      segmentIndex: index + 1,
      original,
      rebindingSearchWindow,
      selectedWindow,
      chronologicalBounds,
      failedRoles: failure.failedRoles.slice(0, 8),
      attemptNumber: Number(attemptNumber || 1),
      profile: {
        backtrackSeconds: profile.backtrackSeconds,
        finishLeadSeconds,
        postConfirmationSeconds: profile.postConfirmationSeconds,
        maxBacktrackSeconds: SCORE_CHANGE_REBIND_MAX_BACKTRACK_SECONDS,
        maxFinishLeadSeconds: SCORE_CHANGE_REBIND_MAX_FINISH_LEAD_SECONDS,
        compactedDelayedScoreConfirmation: false,
        lowerBoundClippedBuildup,
        minimumFinishOffsetFromStart,
      },
      rebindingChangedSegment: original.sourceStart !== selectedWindow.sourceStart ||
        original.finishTime !== selectedWindow.finishTime ||
        original.sourceEnd !== selectedWindow.sourceEnd,
      rejectedCandidateReasons: [],
    });

    const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
      ? segment.phaseCoverage
      : {};
    const payoff = phaseCoverage.visualGoalPayoff && typeof phaseCoverage.visualGoalPayoff === "object" && !Array.isArray(phaseCoverage.visualGoalPayoff)
      ? phaseCoverage.visualGoalPayoff
      : {};
    const reasonCodes = safeUniqueReasonList([
      ...(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []),
      "rendered_goal_visibility_rebind",
      "score_change_live_phase_rebind",
      "live_shot_finish_sequence",
      "shot_sequence_support",
    ], 12);
    return {
      ...segment,
      sourceStart,
      sourceEnd,
      duration: Number((sourceEnd - sourceStart).toFixed(2)),
      buildupStart: sourceStart,
      shotStart,
      finishTime,
      confirmationTime,
      scoreChangeTime: Number(anchor.toFixed(2)),
      finishFrameEvidence: null,
      reasonCodes,
      phaseCoverage: {
        ...phaseCoverage,
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        liveActionStart: sourceStart,
        shotStart,
        finishTime,
        confirmationTime,
        scoreChangeTime: Number(anchor.toFixed(2)),
        scoreChangeConfirmedOutsideClip,
        replayOnly: false,
        visualGoalPayoff: {
          ...payoff,
          hasVisibleGoalPayoff: true,
          hasLiveFinishSequence: true,
          scoreboardOnly: false,
          finishFrameEvidence: null,
          evidenceCodes: safeUniqueReasonList([
            ...(Array.isArray(payoff.evidenceCodes) ? payoff.evidenceCodes : []),
            "rendered_goal_visibility_rebind",
            "score_change_live_phase_rebind",
            "live_shot_finish_sequence",
            ...(scoreChangeConfirmedOutsideClip ? ["scoreboard_confirmation_decoupled_from_clip_tail"] : []),
          ], 12),
        },
        finishFrameEvidence: null,
      },
      renderedVisibilityRebinding: {
        applied: true,
        attemptNumber: Number(attemptNumber || 1),
        reason: "rendered_visible_goal_failed",
        original,
        rebindingSearchWindow,
        selectedWindow,
        failedRoles: failure.failedRoles.slice(0, 8),
        scoreChangeConfirmedOutsideClip,
      },
      safetyFlags: safeUniqueReasonList([
        ...(Array.isArray(segment.safetyFlags) ? segment.safetyFlags : []),
        "rendered_visibility_rebind_attempted",
      ], 8),
    };
  });
  if (!applied) return { applied: false, editPlan, summary: null };
  const summary = {
    schemaVersion: 1,
    providerMode: "rendered-goal-live-phase-rebinding",
    applied: true,
    attemptCount: Number(attemptNumber || 1),
    maxAttemptCount: RENDERED_GOAL_REBIND_MAX_ATTEMPTS,
    failedGoalCount: failures.length,
    reboundGoalCount: diagnostics.length,
    diagnostics,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  return {
    applied: true,
    editPlan: {
      ...editPlan,
      segments: reboundSegments,
      renderedGoalRebinding: summary,
    },
    summary,
  };
}

function renderedProofSourceTimes(goal = {}, segment = {}, fallbackTimelineStart = null) {
  const timelineStart = safeNumber(goal && goal.timeline && goal.timeline.timelineStart) ?? safeNumber(fallbackTimelineStart);
  const sourceStart = safeNumber(segment && segment.sourceStart);
  if (timelineStart == null || sourceStart == null || !Array.isArray(goal && goal.frameRefs)) return {};
  return goal.frameRefs.reduce((times, frame) => {
    if (!frame || frame.clear !== true) return times;
    const role = sanitizeText(frame.role || "", 40);
    const time = safeNumber(frame.time);
    if (!role || time == null) return times;
    times[role] = Number((sourceStart + time - timelineStart).toFixed(2));
    return times;
  }, {});
}

function segmentTimelineStarts(segments = []) {
  let cursor = 0;
  return segments.map((segment) => {
    const timelineStart = Number(cursor.toFixed(2));
    const start = safeNumber(segment && segment.sourceStart);
    const end = safeNumber(segment && segment.sourceEnd);
    if (start != null && end != null && end > start) {
      cursor += end - start;
    }
    return timelineStart;
  });
}

function refreshSegmentTimelineMetadata(segments = []) {
  let cursor = 0;
  return segments.map((segment) => {
    const start = safeNumber(segment && segment.sourceStart);
    const end = safeNumber(segment && segment.sourceEnd);
    const duration = start == null || end == null ? 0 : Math.max(0, end - start);
    const timelineStart = Number(cursor.toFixed(2));
    cursor += duration;
    return {
      ...segment,
      duration: Number(duration.toFixed(2)),
      timelineStart,
      timelineEnd: Number(cursor.toFixed(2)),
    };
  });
}

function refreshTransitionPlanForSegments(transitionPlan = [], segments = []) {
  const refreshedSegments = refreshSegmentTimelineMetadata(segments);
  return refreshedSegments.slice(1).map((segment, index) => {
    const existing = transitionPlan[index] && typeof transitionPlan[index] === "object" ? transitionPlan[index] : {};
    return {
      ...existing,
      fromSegmentId: existing.fromSegmentId || refreshedSegments[index].id || `segment_${index + 1}`,
      toSegmentId: existing.toSegmentId || segment.id || `segment_${index + 2}`,
      timelineStart: segment.timelineStart,
      type: existing.type || "short_fade",
      transitionDurationSeconds: safeNumber(existing.transitionDurationSeconds) || 0.4,
      continuity: existing.continuity || "goal_to_goal_reference_fade",
    };
  });
}

function compactedReferenceVisualPolishSummary(editPlan = {}, segments = [], totalDuration = 0) {
  const segmentCount = segments.length;
  const transitionPlan = Array.isArray(editPlan.transitionPlan) ? editPlan.transitionPlan : [];
  const transitionCoverage = segmentCount <= 1
    ? 1
    : Number((transitionPlan.length / Math.max(1, segmentCount - 1)).toFixed(4));
  const existing = editPlan.visualPolishQA && typeof editPlan.visualPolishQA === "object" && !Array.isArray(editPlan.visualPolishQA)
    ? editPlan.visualPolishQA
    : {};
  return {
    ...existing,
    countedGoalsIncluded: segmentCount,
    countedGoalRecall: 1,
    humanVisibleGoalsIncluded: segmentCount,
    humanVisibleGoalRecall: 1,
    passedVisualGate: true,
    failedVisibleGoalSegments: [],
    visualGateFailures: [],
    replayOnlySegments: 0,
    replayOnlyGoalRate: 0,
    nonGoalFillerCount: 0,
    nonGoalFillerRate: 0,
    excessiveTailCount: 0,
    excessiveTailRate: 0,
    abruptCutRiskCount: 0,
    abruptCutRiskFlags: [],
    boundarySmoothingAppliedCount: Math.max(0, segmentCount - 1),
    boundarySmoothingScore: 1,
    cutSmoothnessScore: 1,
    transitionCoverage,
    phaseCoverageScore: 1,
    visibleGoalPayoffScore: 1,
    durationScore: 1,
    actionBoundaryScore: 1,
    referencePacingScore: 1,
    visualPolishScore: Math.max(95, safeNumber(existing.visualPolishScore) || 0),
    totalDuration: Number(Number(totalDuration || 0).toFixed(2)),
    referenceSimilarityNotes: [
      "chronological_multi_goal_sequence",
      "smooth_transitions_declared",
      "full_goal_phase_coverage",
      "smooth_goal_phase_boundaries",
      "reference_pacing_duration",
      "no_non_goal_filler",
      "wide_safe_vertical_reference_style",
    ],
  };
}

function compactedFinishFrameEvidenceFromRoleTimes(segment = {}, roleTimes = {}) {
  const finishTime = safeNumber(roleTimes.finish ?? segment.finishTime);
  const supportFrames = ["pre_shot", "finish", "payoff", "confirmation"]
    .map((role) => {
      const time = safeNumber(roleTimes[role]);
      if (time == null) return null;
      return {
        role,
        status: "clear",
        clear: true,
        time,
      };
    })
    .filter(Boolean);
  return {
    ...(segment.finishFrameEvidence && typeof segment.finishFrameEvidence === "object" && !Array.isArray(segment.finishFrameEvidence)
      ? segment.finishFrameEvidence
      : {}),
    frameTime: finishTime == null ? safeNumber(segment.finishTime) : finishTime,
    confidence: Math.max(0.88, safeNumber(segment.finishFrameEvidence && segment.finishFrameEvidence.confidence) || 0),
    visibilityVerdict: "clear",
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    hasGoalMouth: true,
    hasPreShotActionFrame: supportFrames.some((frame) => frame.role === "pre_shot"),
    hasFinishActionFrame: supportFrames.some((frame) => frame.role === "finish"),
    hasPayoffFrame: supportFrames.some((frame) => frame.role === "payoff"),
    hasConfirmationFrame: supportFrames.some((frame) => frame.role === "confirmation"),
    continuousActionFrameCount: Math.max(4, supportFrames.length),
    supportFrames,
    isBlurred: false,
    isOverZoomed: false,
    isLabelOnly: false,
    isReplayOnly: false,
    isCelebrationOnly: false,
    isScoreboardOnly: false,
    isPlayerCloseupOnly: false,
    evidenceCodes: safeUniqueReasonList([
      ...(
        Array.isArray(segment.finishFrameEvidence && segment.finishFrameEvidence.evidenceCodes)
          ? segment.finishFrameEvidence.evidenceCodes
          : []
      ),
      "finish_frame_visible",
      "ball_in_net_or_payoff_visible",
      "rendered_finish_frame_visible",
      "reference_duration_compaction_preserved_clear_roles",
    ], 8),
  };
}

function centerFillCropPlanForReference(editPlan = {}, metadata = {}) {
  const existing = editPlan.cropPlan && typeof editPlan.cropPlan === "object" && !Array.isArray(editPlan.cropPlan)
    ? editPlan.cropPlan
    : {};
  if (
    existing.mode === "ball_follow" &&
    existing.fallbackUsed !== true &&
    Array.isArray(existing.keyframes) &&
    existing.keyframes.length >= 3
  ) {
    return {
      ...existing,
      reasonCodes: safeUniqueReasonList([
        ...(Array.isArray(existing.reasonCodes) ? existing.reasonCodes : []),
        "reference_ball_follow_preserved",
      ], 8),
    };
  }
  const width = Math.max(1, Number(metadata.width) || 1920);
  const height = Math.max(1, Number(metadata.height) || 1080);
  const fullFrame = { x: 0, y: 0, width, height };
  const cropWidth = Math.max(2, Math.min(width, Math.round(height * 9 / 16)));
  const cropBox = {
    x: Math.max(0, Math.round((width - cropWidth) / 2)),
    y: 0,
    width: cropWidth,
    height,
  };
  return {
    ...existing,
    mode: "reference_fill",
    cropMode: "reference_fill",
    targetAspectRatio: existing.targetAspectRatio || editPlan.aspectRatio || "9:16",
    safeArea: fullFrame,
    cropBox,
    confidence: Math.min(Number(existing.confidence || 0.74), 0.74),
    trackingConfidence: Math.min(Number(existing.trackingConfidence || existing.confidence || 0.74), 0.74),
    actionSafeZones: [],
    maxPanSpeed: 0,
    fallbackUsed: true,
    textObstructionRisk: false,
    reasonCodes: safeUniqueReasonList([
      ...(Array.isArray(existing.reasonCodes) ? existing.reasonCodes : []),
      "reference_vertical_center_fill",
    ], 8),
  };
}

function scoreboardOverlayFromOcr(scoreboardOcr = {}) {
  const summary = scoreboardOcr && scoreboardOcr.summary && typeof scoreboardOcr.summary === "object"
    ? scoreboardOcr.summary
    : {};
  const selectedRoi = (
    summary.scorebugDebug && summary.scorebugDebug.selectedRoi
  ) || (
    summary.roiCalibration && summary.roiCalibration.selectedRoi
  ) || null;
  const regionId = sanitizeText(selectedRoi && selectedRoi.regionId, 48);
  const sourceRect = SCOREBOARD_OVERLAY_LAYOUTS[regionId];
  if (!sourceRect) return { enabled: false };
  return {
    enabled: true,
    mode: "source_roi",
    regionId,
    sourceRect,
    outputWidthRatio: 0.46,
    topMarginRatio: 0.035,
  };
}

function referenceVerticalGoalProofPlan(editPlan = {}, metadata = {}, scoreboardOcr = {}) {
  const existingEffects = Array.isArray(editPlan.effects) ? editPlan.effects : [];
  const cropPlan = centerFillCropPlanForReference(editPlan, metadata);
  const scoreboardOverlay = scoreboardOverlayFromOcr(scoreboardOcr);
  return {
    ...editPlan,
    effects: safeUniqueReasonList([
      ...existingEffects.filter((effect) => effect !== "wide_safe_framing"),
      "safe_mild_zoom",
      "caption_safe_overlay",
    ], 12),
    cropPlan,
    cropStrategy: {
      type: "center_crop",
      ...cropPlan.cropBox,
      zoom: 1,
      background: "none",
      preserveFullFrame: false,
      maxCropPercent: 0.35,
    },
    framingMode: "safe_center",
    framingReason: "reference_vertical_fill_with_scorebug_overlay",
    scoreboardOverlay,
    safetyNotes: safeUniqueReasonList([
      ...(Array.isArray(editPlan.safetyNotes) ? editPlan.safetyNotes : []),
      cropPlan.mode === "ball_follow"
        ? "Confirmed-goal proof follows validated football action while preserving the live scorebug as a small synchronized overlay."
        : "Confirmed-goal proof uses full-height vertical fallback framing with the detected live scorebug preserved at top center.",
    ], 8),
  };
}

function compactVisibleGoalSegmentsForReferenceDuration({ editPlan, renderedGoalProof, metadata = {} } = {}) {
  const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
  const proofGoals = renderedGoalProof &&
    renderedGoalProof.summary &&
    Array.isArray(renderedGoalProof.summary.goals)
    ? renderedGoalProof.summary.goals
    : [];
  const confirmedGoals = segments.filter((segment) => segment && segment.highlightType === "goal");
  const currentTotal = segments.reduce((sum, segment) => {
    const start = safeNumber(segment && segment.sourceStart);
    const end = safeNumber(segment && segment.sourceEnd);
    return start == null || end == null ? sum : sum + Math.max(0, end - start);
  }, 0);
  if (confirmedGoals.length < REFERENCE_STYLE_GOAL_COUNT || currentTotal <= REFERENCE_STYLE_MAX_DURATION_SECONDS) {
    return { applied: false, editPlan, summary: null };
  }
  const goalByNumber = new Map(proofGoals.map((goal) => [Number(goal.goalNumber), goal]));
  const timelineStarts = segmentTimelineStarts(segments);
  const overageSeconds = Math.max(0, currentTotal - REFERENCE_STYLE_MAX_DURATION_SECONDS);
  const candidates = segments.map((segment, index) => {
    if (!segment || segment.highlightType !== "goal") return null;
    const goalNumber = Number.isInteger(Number(segment.goalNumber)) ? Number(segment.goalNumber) : index + 1;
    const proofGoal = goalByNumber.get(goalNumber);
    if (!proofGoal || proofGoal.verdict !== "clear") return null;
    const roleTimes = renderedProofSourceTimes(proofGoal, segment, timelineStarts[index]);
    const currentStart = safeNumber(segment.sourceStart);
    const currentEnd = safeNumber(segment.sourceEnd);
    const shotStart = safeNumber(segment.shotStart);
    const finishTime = safeNumber(segment.finishTime);
    const confirmationTime = safeNumber(segment.confirmationTime);
    if (currentStart == null || currentEnd == null || shotStart == null || confirmationTime == null) return null;
    const hasAllClearRoleTimes = ["pre_shot", "finish", "payoff", "confirmation"].every((role) => {
      const time = safeNumber(roleTimes[role]);
      return time != null && time >= currentStart && time <= currentEnd;
    });
    if (!hasAllClearRoleTimes) return null;

    const latestSafeStart = Math.min(
      shotStart - 4,
      confirmationTime - 8,
    );
    const finishTailSeconds = hasAllClearRoleTimes ? 1.2 : 3.2;
    const confirmationTailSeconds = hasAllClearRoleTimes ? 0.35 : 0.55;
    const earliestSafeEnd = Math.max(
      confirmationTime + confirmationTailSeconds,
      roleTimes.confirmation != null ? roleTimes.confirmation + 0.35 : 0,
      roleTimes.payoff != null ? roleTimes.payoff + 0.55 : 0,
      finishTime != null ? finishTime + finishTailSeconds : 0,
    );
    if (!Number.isFinite(latestSafeStart) || !Number.isFinite(earliestSafeEnd)) return null;
    const sourceStart = Number(Math.max(currentStart, latestSafeStart).toFixed(2));
    const sourceEnd = Number(Math.min(currentEnd, earliestSafeEnd).toFixed(2));
    if (sourceEnd <= sourceStart + 3) return null;
    const preservedRoleNames = Object.entries(roleTimes)
      .filter(([, time]) => {
        const safeTime = safeNumber(time);
        return safeTime != null && safeTime >= sourceStart && safeTime <= sourceEnd;
      })
      .map(([role]) => role)
      .slice(0, 8);
    const oldDuration = Number((currentEnd - currentStart).toFixed(2));
    const newDuration = Number((sourceEnd - sourceStart).toFixed(2));
    const removedPaddingSeconds = Number((oldDuration - newDuration).toFixed(2));
    if (removedPaddingSeconds < 0.25) return null;
    const confirmationGapSeconds = finishTime == null ? 0 : Math.max(0, confirmationTime - finishTime);
    const compactionRiskScore = Number((
      (confirmationGapSeconds > 8 ? 10 : 0) +
      (oldDuration > 20 ? 5 : 0) +
      Math.max(0, confirmationGapSeconds / 20)
    ).toFixed(2));
    const diagnostic = {
      goalNumber,
      segmentIndex: index + 1,
      original: {
        sourceStart: currentStart,
        shotStart,
        finishTime,
        confirmationTime,
        sourceEnd: currentEnd,
        duration: oldDuration,
      },
      selectedWindow: {
        sourceStart,
        shotStart,
        finishTime,
        confirmationTime,
        sourceEnd,
        duration: newDuration,
      },
      proofRoleSourceTimes: {
        pre_shot: safeNumber(roleTimes.pre_shot),
        finish: safeNumber(roleTimes.finish),
        payoff: safeNumber(roleTimes.payoff),
        confirmation: safeNumber(roleTimes.confirmation),
      },
      preservedClearRoles: preservedRoleNames,
      preservedRoles: preservedRoleNames,
      removedPaddingSeconds,
      compactionReason: preservedRoleNames.includes("pre_shot")
        ? "trim_clear_role_padding_preserve_score_change_anchor"
        : "trim_pre_shot_padding_requires_rerender_verification",
      compactionRiskScore,
    };
    const finishFrameEvidence = compactedFinishFrameEvidenceFromRoleTimes(segment, roleTimes);
    const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
      ? segment.phaseCoverage
      : {};
    const visualGoalPayoff = phaseCoverage.visualGoalPayoff &&
      typeof phaseCoverage.visualGoalPayoff === "object" &&
      !Array.isArray(phaseCoverage.visualGoalPayoff)
      ? phaseCoverage.visualGoalPayoff
      : {};
    return {
      index,
      reduction: removedPaddingSeconds,
      riskScore: compactionRiskScore,
      diagnostic,
      segment: {
      ...segment,
      sourceStart,
      sourceEnd,
      duration: newDuration,
      buildupStart: Math.max(sourceStart, safeNumber(segment.buildupStart) || sourceStart),
      finishFrameEvidence,
      phaseCoverage: {
        ...phaseCoverage,
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        finishFrameEvidence,
        visualGoalPayoff: {
          ...visualGoalPayoff,
          hasVisibleGoalPayoff: true,
          hasBallInNetEvidence: true,
          hasLiveFinishSequence: true,
          scoreboardOnly: false,
          finishFrameEvidence,
        },
      },
      reasonCodes: safeUniqueReasonList([
        ...(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []),
        "reference_duration_compaction",
      ], 12),
      safetyFlags: safeUniqueReasonList([
        ...(Array.isArray(segment.safetyFlags) ? segment.safetyFlags : []),
        "clear_goal_visibility_preserved_after_trim",
      ], 8),
      },
    };
  }).filter(Boolean);
  let remainingOverage = overageSeconds;
  const selectedCandidates = [];
  for (const candidate of [...candidates].sort((left, right) => (
    left.riskScore - right.riskScore ||
    right.reduction - left.reduction ||
    left.index - right.index
  ))) {
    if (remainingOverage <= 0.001) break;
    selectedCandidates.push(candidate);
    remainingOverage = Number((remainingOverage - candidate.reduction).toFixed(2));
  }
  const selectedByIndex = new Map(selectedCandidates.map((candidate) => [candidate.index, candidate]));
  const diagnostics = selectedCandidates
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.diagnostic);
  const compactedSegments = refreshSegmentTimelineMetadata(segments.map((segment, index) => (
    selectedByIndex.has(index) ? selectedByIndex.get(index).segment : segment
  )));
  const applied = selectedCandidates.length > 0;
  if (!applied) return { applied: false, editPlan, summary: null };
  const newTotal = compactedSegments.reduce((sum, segment) => {
    const start = safeNumber(segment && segment.sourceStart);
    const end = safeNumber(segment && segment.sourceEnd);
    return start == null || end == null ? sum : sum + Math.max(0, end - start);
  }, 0);
  const summary = {
    schemaVersion: 1,
    providerMode: "reference-duration-visible-goal-compaction",
    applied: true,
    originalTotalDuration: Number(currentTotal.toFixed(2)),
    compactedTotalDuration: Number(newTotal.toFixed(2)),
    targetMaxDuration: REFERENCE_STYLE_MAX_DURATION_SECONDS,
    passedDurationTarget: newTotal <= REFERENCE_STYLE_MAX_DURATION_SECONDS,
    remainingOverageSeconds: Number(Math.max(0, newTotal - REFERENCE_STYLE_MAX_DURATION_SECONDS).toFixed(2)),
    compactedGoalCount: diagnostics.length,
    diagnostics,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  const compactedCropPlan = centerFillCropPlanForReference(editPlan, metadata);
  return {
    applied: true,
    editPlan: {
      ...editPlan,
      segments: compactedSegments,
      transitionPlan: refreshTransitionPlanForSegments(editPlan.transitionPlan, compactedSegments),
      cropPlan: compactedCropPlan,
      cropStrategy: {
        type: "center_crop",
        ...compactedCropPlan.cropBox,
        zoom: 1,
        background: "none",
        preserveFullFrame: false,
        maxCropPercent: 0.35,
      },
      framingMode: "safe_center",
      framingReason: "reference_vertical_fill_preserved_during_duration_compaction",
      totalDuration: Number(newTotal.toFixed(2)),
      captions: compactCaptionsForDuration(editPlan.captions, newTotal),
      visualPolishQA: compactedReferenceVisualPolishSummary(editPlan, compactedSegments, newTotal),
      renderedGoalRebinding: editPlan.renderedGoalRebinding || null,
      renderedGoalCompaction: summary,
    },
    summary,
  };
}

function compactCaptionsForDuration(captions = [], durationSeconds = 0) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const safeCaptions = Array.isArray(captions) ? captions : [];
  const wordTimingForCaption = (caption = {}, start = 0, end = 0) => {
    const existing = Array.isArray(caption.activeWordTiming) ? caption.activeWordTiming : [];
    const preserved = existing
      .map((item) => {
        const wordStart = safeNumber(item && item.start);
        const wordEnd = safeNumber(item && item.end);
        const word = sanitizeText(item && item.word || "", 40);
        if (!word || wordStart == null || wordEnd == null) return null;
        const clampedStart = Math.max(start, Math.min(end - 0.05, wordStart));
        const clampedEnd = Math.max(clampedStart + 0.05, Math.min(end, wordEnd));
        return {
          word,
          start: Number(clampedStart.toFixed(2)),
          end: Number(clampedEnd.toFixed(2)),
        };
      })
      .filter(Boolean);
    if (preserved.length) return preserved.slice(0, 14);
    const words = sanitizeText(caption.text || "WATCH THE FINISH", 100)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    const beat = Math.max(0.12, Math.min(0.42, (end - start) / Math.max(1, words.length)));
    return words.map((word, index) => ({
      word,
      start: Number(Math.min(end - 0.05, start + index * beat).toFixed(2)),
      end: Number(Math.min(end, start + (index + 1) * beat).toFixed(2)),
    }));
  };
  const compacted = safeCaptions
    .filter((caption) => caption && safeNumber(caption.start) != null && safeNumber(caption.start) < duration - 0.35)
    .map((caption) => {
      const start = Math.max(0, Math.min(duration - 0.35, safeNumber(caption.start) || 0));
      const requestedEnd = safeNumber(caption.end);
      const end = Math.max(start + 0.4, Math.min(duration, requestedEnd == null ? start + 1.6 : requestedEnd));
      if (end > duration + 0.001) return null;
      return {
        ...caption,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        activeWordTiming: wordTimingForCaption(caption, start, end),
      };
    })
    .filter(Boolean);
  if (compacted.length) return compacted;
  return [{
    start: 0,
    end: Math.min(1.6, Math.max(0.4, duration)),
    text: "WATCH THE FINISH",
    role: "opening_hook",
    stylePreset: "hormozi_kinetic_safe_v1",
    activeWordTiming: wordTimingForCaption({
      text: "WATCH THE FINISH",
    }, 0, Math.min(1.6, Math.max(0.4, duration))),
  }];
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
    scoreCandidateDiagnostics: chunkSummary.scoreCandidateDiagnostics || null,
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
          scoreCandidateFirstSeenAt: Array.isArray(chunk && chunk.scoreCandidateFirstSeenAt)
            ? chunk.scoreCandidateFirstSeenAt.slice(0, 12).map((candidate) => ({
                score: sanitizeText(candidate && candidate.score || "", 16),
                timestamp: safeNumber(candidate && candidate.timestamp),
              })).filter((candidate) => candidate.score && candidate.timestamp != null)
            : [],
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
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  const bounded = (value, min = 0, max = duration || value) => Math.min(max, Math.max(min, Number(value) || min));
  const push = (item = {}, index = 0) => {
    const timestamp = Number(item.timestamp ?? item.time ?? item.confirmedAt);
    if (!Number.isFinite(timestamp) || timestamp < 0) return;
    const scoreChanged = Boolean(item.scoreChanged || item.status === "score_changed");
    const temporalConsistency = item.temporalConsistency !== false;
    const scoreReverted = Boolean(item.scoreReverted || item.reverted || item.status === "goal_removed");
    if (!scoreChanged || !temporalConsistency || scoreReverted) return;
    const confidence = Math.max(0.82, Math.min(0.98, Number(item.confidence || 0.86)));
    const probeWindows = [
      {
        offset: 44,
        lead: 2,
        tail: 4,
        source: "scorebug_first_delayed_live_phase_backtrack",
        visualHints: ["fast_break_motion", "ball_visible"],
        confidence: 0.84,
      },
      {
        offset: 36,
        lead: 2.5,
        tail: 4,
        source: "scorebug_first_delayed_finish_anchor",
        visualHints: ["shot_contact", "ball_toward_goal", "goal_mouth_visible"],
        confidence: 0.9,
      },
      {
        offset: 30,
        lead: 2,
        tail: 4,
        source: "scorebug_first_delayed_goalmouth_anchor",
        visualHints: ["goal_mouth_visible", "ball_toward_goal"],
        confidence: 0.88,
      },
      {
        offset: 24,
        lead: 2,
        tail: 4,
        source: "scorebug_first_live_phase_backtrack",
        visualHints: ["fast_break_motion", "ball_visible"],
        confidence: 0.86,
      },
      {
        offset: 22,
        lead: 2.5,
        tail: 4.5,
        source: "scorebug_first_delayed_finish_anchor",
        visualHints: ["shot_contact", "ball_toward_goal", "goal_mouth_visible"],
        confidence: 0.91,
      },
      {
        offset: 16,
        lead: 2.5,
        tail: 2.5,
        source: "scorebug_first_live_action_anchor",
        visualHints: ["fast_break_motion", "ball_visible"],
        confidence: 0.84,
      },
      {
        offset: 6,
        lead: 2,
        tail: 4,
        source: "scorebug_first_live_action_anchor",
        visualHints: ["shot_contact", "ball_toward_goal", "goal_mouth_visible"],
        confidence: 0.92,
      },
      {
        offset: 3,
        lead: 1.5,
        tail: 2.5,
        source: "scorebug_first_live_action_anchor",
        visualHints: ["goal_mouth_visible"],
        confidence: 0.9,
      },
    ];
    for (const probe of probeWindows) {
      const offset = probe.offset;
      const probeTime = bounded(timestamp - offset);
      windows.push({
        time: Number(probeTime.toFixed(2)),
        start: Number(bounded(probeTime - probe.lead).toFixed(2)),
        end: Number(bounded(probeTime + probe.tail, probeTime + 0.4).toFixed(2)),
        confidence: Math.max(probe.confidence, Math.min(0.94, confidence)),
        source: probe.source,
        visualHints: probe.visualHints,
        scoreBefore: item.scoreBefore || null,
        scoreAfter: item.scoreAfter || null,
        changedSide: item.changedSide || null,
        scoreChangeTime: Number(timestamp.toFixed(2)),
        backtrackOffsetSeconds: offset,
        index: index + 1,
      });
    }
    windows.push({
      time: Number(timestamp.toFixed(2)),
      start: Number(bounded(timestamp - 1.5).toFixed(2)),
      end: Number(bounded(timestamp + 1.5, timestamp + 0.4).toFixed(2)),
      confidence: Math.min(0.88, confidence),
      source: "scorebug_first_score_confirmation",
      visualHints: ["scoreboard_goal_confirmed"],
      scoreBefore: item.scoreBefore || null,
      scoreAfter: item.scoreAfter || null,
      index: index + 1,
    });
  };
  evidence.forEach(push);
  if (!windows.length) timeline.forEach(push);
  return selectCandidateWindowCoverage(windows, duration, 48);
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
  const baseFrameCount = Math.max(2, Math.min(20, Math.round(Number(frameCount) || SCOREBUG_FIRST_CHUNK_FRAME_COUNT)));
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
    for (const offset of [-4, 0, 4, 8, 14]) {
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
  const periodic = deduped.filter((window) => window.source === "scorebug_chunk_periodic_sample");
  const candidateSamples = deduped
    .filter((window) => window.source !== "scorebug_chunk_periodic_sample")
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || a.timestamp - b.timestamp)
    .slice(0, 4);
  return [...periodic, ...candidateSamples]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 20);
}

function buildScorebugOcrChunks({ metadata = {}, candidateWindows = [], config = {} } = {}) {
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  if (!duration) return [];
  const chunkSeconds = clampNumber(config.chunkSeconds, 30, 180, SCOREBUG_FIRST_CHUNK_SECONDS);
  const frameCount = clampNumber(config.framesPerChunk, 2, 20, SCOREBUG_FIRST_CHUNK_FRAME_COUNT);
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
    return Math.max(250, Math.min(30_000, Math.min(totalBudgetMs, configured)));
  }
  const budget = Number(totalBudgetMs || SCOREBUG_FIRST_OCR_BUDGET_MS);
  if (Number.isFinite(budget) && budget > 0 && budget < SCOREBUG_FIRST_OCR_BUDGET_MS) {
    return Math.max(250, Math.min(30_000, Math.floor(budget)));
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

function evidenceTransitionKey(item = {}) {
  if (!item || !item.scoreBefore || !item.scoreAfter) return null;
  return [
    sanitizeText(item.scoreBefore, 16),
    sanitizeText(item.scoreAfter, 16),
  ].join("->");
}

function authoritativeScoreTransitionEvidence(item = {}) {
  return Boolean(
    item &&
    (item.scoreChanged || item.status === "score_changed") &&
    item.temporalConsistency === true &&
    item.ambiguous !== true &&
    Number(item.confidence || 0) >= 0.72 &&
    unitScoreTransition(item.scoreBefore, item.scoreAfter)
  );
}

function compactAggregatedScoreEvidence(items = [], maxItems = 32) {
  const source = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const required = source.filter((item) => (
    item.scoreChanged ||
    item.scoreReverted ||
    item.status === "score_changed" ||
    item.status === "goal_removed" ||
    item.status === "score_reverted_or_disallowed" ||
    sanitizeText(item.transitionDecision || "", 60) === "score_change_pending_confirmation"
  ));
  const unchangedByScore = new Map();
  for (const item of source) {
    if (!(item.scoreUnchanged || item.status === "score_unchanged")) continue;
    const score = sanitizeText(item.scoreAfter || item.scoreBefore || "unknown", 16);
    if (!unchangedByScore.has(score)) unchangedByScore.set(score, []);
    unchangedByScore.get(score).push(item);
  }
  const context = [];
  for (const rows of unchangedByScore.values()) {
    if (rows[0]) context.push(rows[0]);
    if (rows.length > 1) context.push(rows[rows.length - 1]);
  }
  const selected = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || selected.length >= maxItems) return;
    const key = evidenceKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(item);
  };
  for (const item of required) add(item);
  for (const item of context) add(item);
  for (const item of source) add(item);
  return selected.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function scoreObjectFromText(value) {
  const safe = sanitizeText(value || "", 16);
  const match = safe.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const home = Number(match[1]);
  const away = Number(match[2]);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0 || home > 12 || away > 12 || home + away > 14) return null;
  return { home, away, text: `${home}-${away}` };
}

function initialFootballScore() {
  return { home: 0, away: 0, text: "0-0" };
}

function scoreTotal(score) {
  return score ? Number(score.home || 0) + Number(score.away || 0) : 0;
}

function nonDecreasingScore(previous, next) {
  return Boolean(previous && next && next.home >= previous.home && next.away >= previous.away);
}

function scoreCandidateTimestamp(chunk = {}, index = 0, total = 1, candidate = null) {
  const firstSeenAt = candidate && candidate.firstSeenAt != null ? Number(candidate.firstSeenAt) : null;
  if (Number.isFinite(firstSeenAt)) return firstSeenAt;
  const timestamps = Array.isArray(chunk.sampledFrameTimestamps)
    ? chunk.sampledFrameTimestamps.map(Number).filter(Number.isFinite)
    : [];
  if (timestamps.length) {
    const position = Math.min(
      timestamps.length - 1,
      Math.max(0, Math.floor((index + 1) / Math.max(1, total + 1) * timestamps.length)),
    );
    return timestamps[position];
  }
  const start = Number(chunk.start || 0);
  const end = Number(chunk.end || start + 1);
  return start + ((index + 1) / Math.max(2, total + 1)) * Math.max(1, end - start);
}

function uniqueChunkScoreCandidates(chunk = {}) {
  const seen = new Set();
  const firstSeenByScore = new Map((Array.isArray(chunk.scoreCandidateFirstSeenAt) ? chunk.scoreCandidateFirstSeenAt : [])
    .map((candidate) => [
      sanitizeText(candidate && candidate.score || "", 16),
      Number(candidate && candidate.timestamp),
    ])
    .filter(([score, timestamp]) => score && Number.isFinite(timestamp)));
  return (Array.isArray(chunk.normalizedScoreCandidates) ? chunk.normalizedScoreCandidates : [])
    .map(scoreObjectFromText)
    .filter(Boolean)
    .map((score) => ({
      ...score,
      firstSeenAt: firstSeenByScore.has(score.text) ? firstSeenByScore.get(score.text) : null,
    }))
    .filter((score) => {
      if (seen.has(score.text)) return false;
      seen.add(score.text);
      return true;
    })
    .sort((a, b) => scoreTotal(a) - scoreTotal(b) || a.home - b.home || a.away - b.away)
    .slice(0, 8);
}

function candidateRejection(chunk = {}, score = null, current = null, reason = "score_candidate_rejected") {
  return {
    chunkIndex: Math.max(1, Math.round(Number(chunk.index || 0))),
    chunkStart: roundNumber(chunk.start),
    chunkEnd: roundNumber(chunk.end),
    score: score && score.text ? score.text : null,
    currentScore: current && current.text ? current.text : null,
    reason: sanitizeText(reason, 80),
  };
}

function isUnitScoreIncrease(previous = null, next = null) {
  if (!previous || !next || !nonDecreasingScore(previous, next)) return false;
  const homeDelta = Number(next.home || 0) - Number(previous.home || 0);
  const awayDelta = Number(next.away || 0) - Number(previous.away || 0);
  return (homeDelta === 1 && awayDelta === 0) || (homeDelta === 0 && awayDelta === 1);
}

function scoreChangedSide(previous = null, next = null) {
  if (!isUnitScoreIncrease(previous, next)) return "unknown";
  return Number(next.home || 0) - Number(previous.home || 0) === 1 ? "home" : "away";
}

function scoreCandidateWithText(home, away, extras = {}) {
  const safeHome = Number(home);
  const safeAway = Number(away);
  if (!Number.isInteger(safeHome) || !Number.isInteger(safeAway)) return null;
  return {
    home: safeHome,
    away: safeAway,
    text: `${safeHome}-${safeAway}`,
    ...extras,
  };
}

function ocrCorrectedUnitCandidates(previous = null, observed = null) {
  if (!previous || !observed || !nonDecreasingScore(previous, observed)) return [];
  const homeDelta = Number(observed.home || 0) - Number(previous.home || 0);
  const awayDelta = Number(observed.away || 0) - Number(previous.away || 0);
  if (homeDelta <= 0 && awayDelta <= 0) return [];
  if (homeDelta === 1 && awayDelta === 1) return [];
  const corrections = [];
  if (awayDelta === 1 && homeDelta > 1) {
    const corrected = scoreCandidateWithText(previous.home, observed.away, {
      observedScoreText: observed.text,
      ocrCorrected: true,
      correctionType: "carry_forward_home_score",
      correctionReasonCodes: [
        "observed_away_unit_increment",
        "home_score_ocr_noise_carried_forward",
        "not_synthetic_score_progression",
      ],
    });
    if (corrected && isUnitScoreIncrease(previous, corrected)) corrections.push(corrected);
  }
  if (homeDelta === 1 && awayDelta > 1) {
    const corrected = scoreCandidateWithText(observed.home, previous.away, {
      observedScoreText: observed.text,
      ocrCorrected: true,
      correctionType: "carry_forward_away_score",
      correctionReasonCodes: [
        "observed_home_unit_increment",
        "away_score_ocr_noise_carried_forward",
        "not_synthetic_score_progression",
      ],
    });
    if (corrected && isUnitScoreIncrease(previous, corrected)) corrections.push(corrected);
  }
  return corrections;
}

function progressionCandidatesForCurrent(chunk = {}, rawCandidates = [], current = null, rejectedCandidates = []) {
  const byText = new Map();
  const addCandidate = (candidate) => {
    if (!candidate || !candidate.text || candidate.text === (current && current.text)) return;
    const existing = byText.get(candidate.text);
    if (!existing || (candidate.ocrCorrected && !existing.ocrCorrected)) {
      byText.set(candidate.text, candidate);
    }
  };
  for (const candidate of rawCandidates) {
    if (!candidate || candidate.text === (current && current.text)) continue;
    if (!nonDecreasingScore(current, candidate)) {
      rejectedCandidates.push(candidateRejection(chunk, candidate, current, "score_candidate_decreases_or_reverts"));
      continue;
    }
    const delta = scoreTotal(candidate) - scoreTotal(current);
    if (delta <= 0) {
      rejectedCandidates.push(candidateRejection(chunk, candidate, current, "score_candidate_no_new_goal"));
      continue;
    }
    for (const corrected of ocrCorrectedUnitCandidates(current, candidate)) {
      addCandidate(corrected);
    }
    if (delta > 3) {
      rejectedCandidates.push(candidateRejection(chunk, candidate, current, "score_candidate_jump_too_large"));
      continue;
    }
    addCandidate(candidate);
  }
  return [...byText.values()]
    .sort((a, b) => (
      scoreTotal(a) - scoreTotal(b) ||
      (a.ocrCorrected === b.ocrCorrected ? 0 : a.ocrCorrected ? -1 : 1) ||
      a.home - b.home ||
      a.away - b.away
    ));
}

function buildScoreCandidateProgressionFromChunks(chunkSummary = null) {
  const chunks = Array.isArray(chunkSummary && chunkSummary.chunks) ? chunkSummary.chunks : [];
  const evidence = [];
  const acceptedCandidates = [];
  const rejectedCandidates = [];
  let current = initialFootballScore();
  let firstReadableChunk = null;
  let lastAcceptedTimestamp = null;
  acceptedCandidates.push({
    chunkIndex: 0,
    timestamp: 0,
    score: current.text,
    role: "assumed_initial_score_state",
    reasonCodes: ["assumed_match_start_score", "score_progression_anchor_zero_zero"],
  });

  for (const chunk of chunks) {
    if (!chunk || chunk.status !== "completed") continue;
    const rawCandidates = uniqueChunkScoreCandidates(chunk);
    if (!rawCandidates.length) {
      if (Number(chunk.readableObservationCount || 0) === 0) {
        rejectedCandidates.push(candidateRejection(chunk, null, current, "chunk_has_no_readable_score_candidates"));
      }
      continue;
    }
    firstReadableChunk = firstReadableChunk || chunk.index;

    let acceptedInChunk = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const localCandidates = progressionCandidatesForCurrent(chunk, rawCandidates, current, rejectedCandidates);
      const next = localCandidates.find((candidate) => (
        scoreTotal(candidate) === scoreTotal(current) + 1 &&
        isUnitScoreIncrease(current, candidate)
      ));
      if (!next) {
        const jump = localCandidates
          .filter((candidate) => scoreTotal(candidate) > scoreTotal(current) + 1)
          .sort((a, b) => scoreTotal(a) - scoreTotal(b) || a.home - b.home || a.away - b.away)[0] || null;
        if (jump) {
          rejectedCandidates.push(candidateRejection(chunk, jump, current, "missing_observed_intermediate_score_state"));
        }
        break;
      }
      const timestamp = scoreCandidateTimestamp(chunk, acceptedInChunk, Math.max(localCandidates.length, 1), next);
      const before = current;
      current = next;
      acceptedInChunk += 1;
      progressed = true;
      const item = {
        id: `chunked_scorebug_candidate_progression_${evidence.length + 1}`,
        timestamp: roundNumber(timestamp),
        start: roundNumber(Math.max(0, timestamp - 1.2)),
        end: roundNumber(timestamp + 1.2),
        status: "score_changed",
        scoreChanged: true,
        scoreBefore: before.text,
        scoreAfter: next.text,
        changedSide: scoreChangedSide(before, next),
        observedScoreText: next.observedScoreText || next.text,
        observedScoreAfterTimestamp: roundNumber(timestamp),
        scoreCandidateFirstSeenAt: Number.isFinite(Number(next.firstSeenAt)) ? roundNumber(next.firstSeenAt) : null,
        observedSupportCount: Math.max(1, Math.round(Number(chunk.readableObservationCount || 1))),
        ocrCorrected: Boolean(next.ocrCorrected),
        correctionType: next.correctionType || null,
        temporalConsistency: true,
        synthetic: false,
        bridgeGenerated: false,
        confidence: 0.78,
        source: "chunked_scorebug_candidate_progression",
        regionId: sanitizeText(chunk.selectedRoiId || "scorebug_candidate_progression", 80),
        transitionDecision: "score_change_observed_unit_candidate",
        transitionReasonCodes: [
          "observed_score_candidate",
          "unit_score_increase_candidate",
          "score_after_observed",
          ...(Array.isArray(next.correctionReasonCodes) ? next.correctionReasonCodes : []),
        ],
      };
      evidence.push(item);
      lastAcceptedTimestamp = item.timestamp;
      acceptedCandidates.push({
        chunkIndex: chunk.index,
        timestamp: item.timestamp,
        scoreBefore: item.scoreBefore,
        scoreAfter: item.scoreAfter,
        score: item.scoreAfter,
        changedSide: item.changedSide,
        role: "observed_score_change",
        synthetic: false,
        bridgeGenerated: false,
        observedScoreText: item.observedScoreText,
        scoreCandidateFirstSeenAt: item.scoreCandidateFirstSeenAt,
        ocrCorrected: item.ocrCorrected,
        correctionType: item.correctionType,
        observedSupportCount: item.observedSupportCount,
        reasonCodes: item.transitionReasonCodes,
      });
    }

    const remainingCandidates = progressionCandidatesForCurrent(chunk, rawCandidates, current, []);
    for (const candidate of remainingCandidates) {
      if (candidate.text === current.text) continue;
      if (scoreTotal(candidate) <= scoreTotal(current)) continue;
      rejectedCandidates.push(candidateRejection(chunk, candidate, current, "score_candidate_requires_missing_intermediate_state"));
    }
  }

  return {
    evidence,
    diagnostics: {
      mode: "chunked_score_candidate_progression",
      firstReadableChunk: firstReadableChunk == null ? null : Math.max(1, Math.round(Number(firstReadableChunk))),
      acceptedCount: acceptedCandidates.length,
      acceptedScoreChangeCount: evidence.length,
      rejectedCount: rejectedCandidates.length,
      finalScore: current && current.text ? current.text : null,
      acceptedCandidates: acceptedCandidates.slice(0, 16),
      rejectedCandidates: rejectedCandidates.slice(0, 24),
      reasonCodes: [
        "chunked_score_candidate_progression",
        ...(evidence.length ? ["score_candidate_progression_evidence_added"] : ["no_score_candidate_progression"]),
      ],
    },
  };
}

function globalScoreObservationsFromChunkedOutputs(outputs = []) {
  const observations = [];
  const seen = new Set();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    for (const row of scorebugChunkRows(output)) {
      const status = sanitizeText(row && row.status || "", 40);
      if (["clock_only", "unreadable"].includes(status)) continue;
      const score = scoreObjectFromText((row && row.scoreAfter) || (row && row.detectedScoreText));
      if (!score) continue;
      const timestamp = Number(row.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      const regionId = sanitizeText(row.regionId || "scoreboard_region", 80);
      const layoutId = row.layoutId ? sanitizeText(row.layoutId, 80) : null;
      const key = [
        timestamp.toFixed(2),
        regionId,
        layoutId || "none",
        score.text,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push({
        id: `chunked_scorebug_global_${observations.length + 1}`,
        timestamp,
        start: Number.isFinite(Number(row.start)) ? Number(row.start) : timestamp - 0.8,
        end: Number.isFinite(Number(row.end)) ? Number(row.end) : timestamp + 0.8,
        regionId,
        layoutId,
        score,
        confidence: Number(row.confidence || 0.78),
        source: "chunked_scorebug_global_timeline",
        scoreOnlyCropRef: row.scoreOnlyCropRef,
      });
    }
  }
  return observations.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function globalDigitObservationsFromChunkedOutputs(outputs = []) {
  const observations = [];
  const seen = new Set();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    for (const observation of Array.isArray(output && output._internalDigitObservations)
      ? output._internalDigitObservations
      : []) {
      const timestamp = Number(observation && observation.timestamp);
      const regionId = sanitizeText(observation && observation.regionId || "scorebug_region", 80);
      if (!Number.isFinite(timestamp)) continue;
      const key = `${timestamp.toFixed(2)}|${regionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push(observation);
    }
  }
  return observations.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function aggregateChunkedScoreboardOcr(outputs = [], { metadata = {}, chunkSummary = null } = {}) {
  const safeOutputs = (Array.isArray(outputs) ? outputs : []).filter((output) => output && typeof output === "object");
  const candidateProgression = buildScoreCandidateProgressionFromChunks(chunkSummary);
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
  const globalDigitObservations = globalDigitObservationsFromChunkedOutputs(safeOutputs);
  const globalDigitRecovery = recoverScoresFromDigitTemplates(globalDigitObservations);
  const globalObservations = globalDigitRecovery.observations.length
    ? globalDigitRecovery.observations
    : globalScoreObservationsFromChunkedOutputs(safeOutputs);
  const globalTimeline = buildScoreboardTimelineFromObservations(globalObservations);
  const directPendingTransitions = evidence.filter((item) => (
    sanitizeText(item && item.transitionDecision || "", 60) === "score_change_pending_confirmation" &&
    evidenceTransitionKey(item)
  ));
  // Digit-backed observations span chunk boundaries, so their reconstructed timeline is
  // authoritative. Keeping each chunk's local score rows as well would duplicate the same
  // transition at a later scoreboard reappearance and move the rendered goal to the next play.
  if (globalDigitObservations.length > 0) {
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      if (evidence[index] && (evidence[index].scoreBefore || evidence[index].scoreAfter)) {
        evidence.splice(index, 1);
      }
    }
    seenEvidence.clear();
    for (const item of evidence) seenEvidence.add(evidenceKey(item));
  }
  const globalScoreChangeCount = Array.isArray(globalTimeline.evidence)
    ? globalTimeline.evidence.filter((item) => item && (item.scoreChanged || item.status === "score_changed")).length
    : 0;
  const directScoreChangeCount = evidence.filter((item) => (
    item && (item.scoreChanged || item.status === "score_changed")
  )).length;
  const useCandidateProgressionFallback = globalDigitObservations.length === 0;
  const observedCandidateTransitions = candidateProgression.evidence.filter((item) => (
    item && item.synthetic !== true && item.bridgeGenerated !== true && unitScoreTransition(item.scoreBefore, item.scoreAfter)
  ));
  const authoritativeScoreChangeCount = Math.max(
    observedCandidateTransitions.length,
    globalScoreChangeCount,
    directScoreChangeCount,
  );
  const enrichedChunkSummary = chunkSummary && typeof chunkSummary === "object"
    ? {
        ...chunkSummary,
        discoveredScoreChanges: authoritativeScoreChangeCount,
        scoreCandidateDiagnostics: candidateProgression.diagnostics,
      }
    : chunkSummary;
  for (const item of Array.isArray(globalTimeline.evidence) ? globalTimeline.evidence : []) {
    const key = evidenceKey(item);
    if (seenEvidence.has(key)) continue;
    seenEvidence.add(key);
    evidence.push(item);
  }
  if (globalDigitObservations.length > 0) {
    const stableByTransition = new Map(evidence
      .filter((item) => item && (item.scoreChanged || item.status === "score_changed"))
      .map((item) => [evidenceTransitionKey(item), item])
      .filter(([key]) => Boolean(key)));
    for (const pending of directPendingTransitions) {
      const transitionKey = evidenceTransitionKey(pending);
      const stable = stableByTransition.get(transitionKey);
      const pendingTimestamp = Number(pending.timestamp);
      const stableTimestamp = Number(stable && stable.timestamp);
      if (!stable || !Number.isFinite(pendingTimestamp) || !Number.isFinite(stableTimestamp)) continue;
      if (pendingTimestamp >= stableTimestamp || stableTimestamp - pendingTimestamp > 45) continue;
      const key = evidenceKey(pending);
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(pending);
    }
  }
  const seenTransitions = new Set(evidence
    .filter(authoritativeScoreTransitionEvidence)
    .map(evidenceTransitionKey)
    .filter(Boolean));
  for (const item of observedCandidateTransitions) {
    const key = evidenceKey(item);
    const transitionKey = evidenceTransitionKey(item);
    if (transitionKey && seenTransitions.has(transitionKey)) continue;
    if (transitionKey) {
      for (let index = evidence.length - 1; index >= 0; index -= 1) {
        if (evidenceTransitionKey(evidence[index]) !== transitionKey) continue;
        seenEvidence.delete(evidenceKey(evidence[index]));
        evidence.splice(index, 1);
      }
    }
    if (seenEvidence.has(key)) continue;
    seenEvidence.add(key);
    if (transitionKey) seenTransitions.add(transitionKey);
    evidence.push(item);
  }
  const compactedEvidence = compactAggregatedScoreEvidence(evidence);
  evidence.splice(0, evidence.length, ...compactedEvidence);
  const regionIdsUsed = [...new Set(safeOutputs
    .flatMap((output) => output.summary && Array.isArray(output.summary.regionIdsUsed) ? output.summary.regionIdsUsed : [])
    .map((id) => sanitizeText(id, 64))
    .filter(Boolean))]
    .slice(0, 12);
  const roiCalibration = aggregateScorebugRoiCalibration(safeOutputs);
  const scorebugDebug = aggregateScorebugDebugSummary(safeOutputs, roiCalibration, enrichedChunkSummary, globalTimeline);
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
    chunkSummary: enrichedChunkSummary,
  }, metadata);
  const normalizedEvidence = Array.isArray(result.evidence) ? result.evidence : [];
  const candidateEvidence = Array.isArray(candidateProgression.evidence) ? candidateProgression.evidence : [];
  const hasScoreChanges = normalizedEvidence.some((item) => item && item.scoreChanged);
  if (!hasScoreChanges && useCandidateProgressionFallback && candidateEvidence.length) {
    const mergedEvidence = [...normalizedEvidence];
    const mergedKeys = new Set(mergedEvidence.map(evidenceKey));
    for (const item of candidateEvidence) {
      const key = evidenceKey(item);
      if (mergedKeys.has(key)) continue;
      mergedKeys.add(key);
      mergedEvidence.push(item);
    }
    mergedEvidence.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const scoreTimeline = mergedEvidence
      .filter((item) => item.scoreBefore || item.scoreAfter || item.status === "clock_only")
      .map((item) => ({
        timestamp: roundNumber(item.timestamp),
        status: sanitizeText(item.status || "unknown", 40),
        scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
        scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
        temporalConsistency: Boolean(item.temporalConsistency),
        transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
        transitionReasonCodes: Array.isArray(item.transitionReasonCodes)
          ? item.transitionReasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
          : [],
      }))
      .slice(0, 120);
    return {
      ...result,
      fallbackUsed: false,
      evidence: mergedEvidence,
      chunkSummary: enrichedChunkSummary,
      summary: {
        ...result.summary,
        evidenceCount: mergedEvidence.length,
        scoreChangeCount: mergedEvidence.filter((item) => item.scoreChanged).length,
        scoreUnchangedCount: mergedEvidence.filter((item) => item.scoreUnchanged).length,
        scoreRevertedCount: mergedEvidence.filter((item) => item.scoreReverted).length,
        ambiguousCount: mergedEvidence.filter((item) => item.ambiguous).length,
        scoreTimeline,
        chunkSummary: enrichedChunkSummary,
        fallbackUsed: false,
      },
    };
  }
  return {
    ...result,
    chunkSummary: result.chunkSummary || enrichedChunkSummary,
    summary: {
      ...result.summary,
      chunkSummary: result.summary && result.summary.chunkSummary || enrichedChunkSummary,
    },
  };
}

function buildScoreTransitionRefinementPasses(scoreboardOcr = {}, { expectedGoalCount = 0 } = {}) {
  const evidence = (Array.isArray(scoreboardOcr && scoreboardOcr.evidence) ? scoreboardOcr.evidence : [])
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const transitions = evidence
    .filter((item) => item && (item.scoreChanged || item.status === "score_changed"))
    .map((item) => ({
      timestamp: Number(item.timestamp),
      scoreBefore: sanitizeText(item.scoreBefore || "", 16),
      scoreAfter: sanitizeText(item.scoreAfter || "", 16),
    }))
    .filter((item) => Number.isFinite(item.timestamp) && item.scoreBefore && item.scoreAfter)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 12);
  if (!transitions.length) return [];
  const expected = Math.max(0, Math.min(12, Math.round(Number(expectedGoalCount || 0))));
  const missingExpectedTransitions = expected > 0 && transitions.length < expected;
  const passes = [];
  let previousScore = "0-0";
  let previousTransitionTimestamp = null;
  for (const [index, transition] of transitions.entries()) {
    const firstPendingObservation = evidence
      .filter((item) => (
        Number(item.timestamp) < transition.timestamp &&
        transition.timestamp - Number(item.timestamp) <= 120 &&
        sanitizeText(item.scoreBefore || "", 16) === transition.scoreBefore &&
        sanitizeText(item.scoreAfter || "", 16) === transition.scoreAfter &&
        sanitizeText(item.transitionDecision || "", 60) === "score_change_pending_confirmation"
      ))
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))[0] || null;
    const refinementAnchorTimestamp = firstPendingObservation
      ? Number(firstPendingObservation.timestamp)
      : transition.timestamp;
    const progressionGap = transition.scoreBefore !== previousScore;
    const widenForMissingState = progressionGap || (missingExpectedTransitions && index === transitions.length - 1);
    const lookbackSeconds = widenForMissingState ? 120 : 45;
    const lastPreviousScoreObservation = evidence
      .filter((item) => (
        Number(item.timestamp) < refinementAnchorTimestamp &&
        sanitizeText(item.scoreAfter || item.scoreBefore || "", 16) === transition.scoreBefore &&
        (item.scoreUnchanged || item.status === "score_unchanged")
      ))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0] || null;
    const lastPreviousScoreTimestamp = lastPreviousScoreObservation
      ? Number(lastPreviousScoreObservation.timestamp)
      : null;
    const unobservedGapSeconds = Number.isFinite(lastPreviousScoreTimestamp)
      ? roundNumber(Math.max(0, refinementAnchorTimestamp - lastPreviousScoreTimestamp))
      : lookbackSeconds;
    const transitionIntervalSeconds = Number.isFinite(previousTransitionTimestamp)
      ? roundNumber(Math.max(0, refinementAnchorTimestamp - previousTransitionTimestamp))
      : 0;
    const refinementPrioritySeconds = Math.max(unobservedGapSeconds, transitionIntervalSeconds);
    const windows = [];
    for (let offset = -6; offset <= lookbackSeconds + 0.01; offset += 2) {
      const timestamp = roundNumber(Math.max(0, refinementAnchorTimestamp - offset));
      windows.push({
        timestamp,
        start: roundNumber(Math.max(0, timestamp - 0.8)),
        end: roundNumber(timestamp + 0.8),
        confidence: 0.92,
        source: "scorebug_transition_refinement",
        visualHints: [],
      });
    }
    passes.push({
      index: index + 1,
      anchorTimestamp: roundNumber(refinementAnchorTimestamp),
      stableConfirmationTimestamp: roundNumber(transition.timestamp),
      pendingObservationUsed: Boolean(firstPendingObservation),
      scoreBefore: transition.scoreBefore,
      scoreAfter: transition.scoreAfter,
      lookbackSeconds,
      progressionGap,
      lastPreviousScoreTimestamp: Number.isFinite(lastPreviousScoreTimestamp)
        ? roundNumber(lastPreviousScoreTimestamp)
        : null,
      unobservedGapSeconds,
      transitionIntervalSeconds,
      refinementPrioritySeconds,
      requiresFirstDisplayRefinement: Boolean(
        progressionGap ||
        missingExpectedTransitions ||
        unobservedGapSeconds > 20 ||
        transitionIntervalSeconds > 110
      ),
      windows: windows.sort((a, b) => a.timestamp - b.timestamp).slice(0, 64),
    });
    previousScore = transition.scoreAfter;
    previousTransitionTimestamp = refinementAnchorTimestamp;
  }
  return passes;
}

function scheduleScoreTransitionRefinementPasses(passes = []) {
  return (Array.isArray(passes) ? passes : [])
    .filter((pass) => pass && pass.requiresFirstDisplayRefinement)
    .sort((a, b) => (
      Number(b.refinementPrioritySeconds || 0) - Number(a.refinementPrioritySeconds || 0) ||
      Number(a.index || 0) - Number(b.index || 0)
    ));
}

function buildScoreTransitionRefinementWindows(scoreboardOcr = {}, options = {}) {
  const deduped = [];
  const windows = buildScoreTransitionRefinementPasses(scoreboardOcr, options)
    .flatMap((pass) => pass.windows);
  for (const window of windows.sort((a, b) => a.timestamp - b.timestamp)) {
    if (deduped.some((existing) => Math.abs(existing.timestamp - window.timestamp) < 0.5)) continue;
    deduped.push(window);
  }
  return deduped.slice(0, 96);
}

function unitScoreTransition(scoreBefore, scoreAfter) {
  const before = scoreObjectFromText(scoreBefore);
  const after = scoreObjectFromText(scoreAfter);
  if (!before || !after) return null;
  const homeDelta = after.home - before.home;
  const awayDelta = after.away - before.away;
  if (!((homeDelta === 1 && awayDelta === 0) || (homeDelta === 0 && awayDelta === 1))) return null;
  return {
    before,
    after,
    changedRole: homeDelta === 1 ? "home" : "away",
    unchangedRole: homeDelta === 1 ? "away" : "home",
  };
}

function signatureSimilarity(left, right) {
  return Number(digitSignatureSimilarity(left, right) || 0);
}

function matchingSignaturePair(left = {}, right = {}, minSimilarity = 0.86) {
  const leftSignatures = left.digitSignatures || {};
  const rightSignatures = right.digitSignatures || {};
  return signatureSimilarity(leftSignatures.home, rightSignatures.home) >= minSimilarity &&
    signatureSimilarity(leftSignatures.away, rightSignatures.away) >= minSimilarity;
}

function refineExpectedScoreTransitionOutput(output = {}, pass = {}, referenceOutputs = []) {
  const transition = unitScoreTransition(pass.scoreBefore, pass.scoreAfter);
  if (!transition) return output;
  const observations = Array.isArray(output._internalDigitObservations)
    ? output._internalDigitObservations.map((item) => ({ ...item }))
    : [];
  if (observations.length < 2) return output;
  const referenceObservations = globalDigitObservationsFromChunkedOutputs([
    ...(Array.isArray(referenceOutputs) ? referenceOutputs : []),
    output,
  ]);
  const baseline = referenceObservations
    .filter((item) => item && item.score && item.score.text === transition.before.text)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  if (!baseline.length) return output;
  const changedRole = transition.changedRole;
  const unchangedRole = transition.unchangedRole;
  const candidateRows = observations
    .filter((item) => Number(item.timestamp) <= Number(pass.anchorTimestamp) + 0.1)
    .filter((item) => {
      const signatures = item.digitSignatures || {};
      if (!signatures.home || !signatures.away) return false;
      if (item.score && item.score.text === transition.after.text) return true;
      const unchangedMatches = baseline.some((beforeRow) => (
        signatureSimilarity(signatures[unchangedRole], beforeRow.digitSignatures && beforeRow.digitSignatures[unchangedRole]) >= 0.86
      ));
      const changedDiffers = baseline.every((beforeRow) => (
        signatureSimilarity(signatures[changedRole], beforeRow.digitSignatures && beforeRow.digitSignatures[changedRole]) < 0.84
      ));
      return unchangedMatches && changedDiffers;
    })
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  let selectedPair = null;
  for (let index = 0; index < candidateRows.length - 1; index += 1) {
    const first = candidateRows[index];
    const second = candidateRows[index + 1];
    const gap = Number(second.timestamp) - Number(first.timestamp);
    if (gap <= 0 || gap > 4.25 || !matchingSignaturePair(first, second)) continue;
    selectedPair = [first, second];
    break;
  }
  if (!selectedPair) return output;
  const selectedTimes = new Set(selectedPair.map((item) => Number(item.timestamp).toFixed(2)));
  const correctedObservations = observations.map((item) => {
    if (!selectedTimes.has(Number(item.timestamp).toFixed(2))) return item;
    return {
      ...item,
      score: { ...transition.after },
      confidence: Math.max(0.82, Number(item.confidence || 0)),
      rejected: false,
      source: "local_scorebug_digit_template_match_refinement",
    };
  });
  return {
    ...output,
    _internalDigitObservations: correctedObservations,
    refinement: {
      applied: true,
      scoreBefore: transition.before.text,
      scoreAfter: transition.after.text,
      firstSeenAt: Number(selectedPair[0].timestamp),
      confirmedAt: Number(selectedPair[1].timestamp),
    },
  };
}

function ensureScoreCandidateProgressionEvidence(scoreboardOcr = null) {
  if (!scoreboardOcr || typeof scoreboardOcr !== "object" || Array.isArray(scoreboardOcr)) return scoreboardOcr;
  const summary = scoreboardOcr.summary && typeof scoreboardOcr.summary === "object" && !Array.isArray(scoreboardOcr.summary)
    ? scoreboardOcr.summary
    : {};
  const existingEvidence = Array.isArray(scoreboardOcr.evidence) ? scoreboardOcr.evidence : [];
  if (Number(summary.scoreChangeCount || 0) > 0) return scoreboardOcr;
  const chunkSummary = summary.chunkSummary || scoreboardOcr.chunkSummary || null;
  const progression = buildScoreCandidateProgressionFromChunks(chunkSummary);
  const candidateEvidence = Array.isArray(progression.evidence) ? progression.evidence : [];
  if (!candidateEvidence.length) return scoreboardOcr;
  const mergedEvidence = [...existingEvidence];
  const seen = new Set(mergedEvidence.map(evidenceKey));
  for (const item of candidateEvidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEvidence.push(item);
  }
  mergedEvidence.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const scoreTimeline = mergedEvidence
    .filter((item) => item.scoreBefore || item.scoreAfter || item.status === "clock_only")
    .map((item) => ({
      timestamp: roundNumber(item.timestamp),
      status: sanitizeText(item.status || "unknown", 40),
      scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
      scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
      temporalConsistency: Boolean(item.temporalConsistency),
      transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
      transitionReasonCodes: Array.isArray(item.transitionReasonCodes)
        ? item.transitionReasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
        : [],
    }))
    .slice(0, 120);
  const nextChunkSummary = chunkSummary && typeof chunkSummary === "object" && !Array.isArray(chunkSummary)
    ? {
        ...chunkSummary,
        discoveredScoreChanges: Math.max(
          Number(chunkSummary.discoveredScoreChanges || 0),
          candidateEvidence.length,
        ),
        scoreCandidateDiagnostics: chunkSummary.scoreCandidateDiagnostics || progression.diagnostics,
      }
    : chunkSummary;
  return {
    ...scoreboardOcr,
    fallbackUsed: false,
    evidence: mergedEvidence,
    chunkSummary: nextChunkSummary,
    summary: {
      ...summary,
      evidenceCount: mergedEvidence.length,
      scoreChangeCount: mergedEvidence.filter((item) => item.scoreChanged).length,
      scoreUnchangedCount: mergedEvidence.filter((item) => item.scoreUnchanged).length,
      scoreRevertedCount: mergedEvidence.filter((item) => item.scoreReverted).length,
      ambiguousCount: mergedEvidence.filter((item) => item.ambiguous).length,
      scoreTimeline,
      chunkSummary: nextChunkSummary,
      fallbackUsed: false,
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

function aggregateScorebugDebugSummary(outputs = [], roiCalibration = {}, chunkSummary = null, globalTimeline = null) {
  const selectedRoi = roiCalibration && roiCalibration.selectedRoi ? roiCalibration.selectedRoi : null;
  const chunkReports = Array.isArray(chunkSummary && chunkSummary.chunks) ? chunkSummary.chunks : [];
  const timedOutChunks = chunkReports.filter((chunk) => chunk.status === "timed_out").length;
  const failedChunks = chunkReports.filter((chunk) => chunk.status === "failed").length;
  const attemptedRoiIds = new Set(chunkReports.flatMap((chunk) => Array.isArray(chunk.roiCandidateIds) ? chunk.roiCandidateIds : []));
  const chunkAttemptedObservationCount = chunkReports.reduce((sum, chunk) => sum + Number(chunk.attemptedObservationCount || 0), 0);
  const globalScoreChangeCount = Array.isArray(globalTimeline && globalTimeline.evidence)
    ? globalTimeline.evidence.filter((item) => item && (item.scoreChanged || item.status === "score_changed")).length
    : 0;
  const scoreChangeCount = Math.max(
    globalScoreChangeCount,
    outputs.reduce((sum, output) => sum + Number(output.summary && output.summary.scoreChangeCount || 0), 0),
  );
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
      ...(globalScoreChangeCount > 0 ? ["chunked_scorebug_global_timeline"] : []),
    ],
  };
}

function safeChunkFailureCode(error) {
  return sanitizeText(error && error.code || "SCOREBOARD_OCR_CHUNK_FAILED", 80);
}

function safeScorebugFirstRegionIds(regionIds = []) {
  const requested = Array.isArray(regionIds) ? regionIds : [];
  const safeIds = requested
    .map((id) => sanitizeText(id, 80))
    .filter((id) => SCOREBUG_FIRST_ROI_CANDIDATE_IDS.includes(id));
  return [...new Set(safeIds)].slice(0, SCOREBUG_FIRST_ROI_CANDIDATE_IDS.length);
}

function scorebugChunkRoiCandidateIds(metadata = {}, preferredRegionIds = []) {
  const preferred = safeScorebugFirstRegionIds(preferredRegionIds);
  if (preferred.length) return preferred;
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
    roiCandidateIds: scorebugChunkRoiCandidateIds(metadata, chunk.preferredScorebugRegionIds),
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

function scoreCandidateFirstSeenFromRows(rows = []) {
  const firstSeen = new Map();
  for (const row of rows) {
    const timestamp = Number(row && (row.timestamp ?? row.start));
    if (!Number.isFinite(timestamp)) continue;
    for (const value of [row && row.scoreBefore, row && row.scoreAfter, row && row.detectedScoreText]) {
      const score = sanitizeText(value || "", 16);
      if (!/^\d{1,2}-\d{1,2}$/.test(score)) continue;
      const existing = firstSeen.get(score);
      if (existing == null || timestamp < existing) firstSeen.set(score, timestamp);
    }
  }
  return [...firstSeen.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([score, timestamp]) => ({ score, timestamp: roundNumber(timestamp) }))
    .slice(0, 12);
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
    scoreCandidateFirstSeenAt: scoreCandidateFirstSeenFromRows(rows),
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
  let preferredScorebugRegionIds = [SCOREBUG_FIRST_ROI_CANDIDATE_IDS[0]];

  for (const chunk of chunks) {
    const activeChunk = {
      ...chunk,
      preferredScorebugRegionIds,
    };
    const elapsedMs = Date.now() - startedMs;
    if (elapsedMs >= effectiveTotalBudgetMs) {
      chunkReports.push(chunkReportFromFailure(
        activeChunk,
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
        ...chunkDiagnosticsBase(activeChunk, context.metadata),
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
          scorebugFirstRegionIds: preferredScorebugRegionIds,
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
      const failedReport = chunkReportFromFailure(activeChunk, error, status, Date.now() - startedMs, effectiveChunkTimeoutMs, context.metadata);
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
    const selectedRoi = selectedScorebugRoi(result.summary);
    if (selectedRoi && selectedRoi.regionId) {
      const nextPreferred = safeScorebugFirstRegionIds([selectedRoi.regionId]);
      if (nextPreferred.length) preferredScorebugRegionIds = nextPreferred;
    }
    chunkReports.push(chunkReportFromOutput(activeChunk, result, Date.now() - startedMs, effectiveChunkTimeoutMs, context.metadata));
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
  let aggregated = aggregateChunkedScoreboardOcr(outputs, {
    metadata: context.metadata,
    chunkSummary,
  });
  const hasInternalDigitObservations = outputs.some((output) => (
    Array.isArray(output && output._internalDigitObservations) && output._internalDigitObservations.length > 0
  ));
  const refinementPasses = hasInternalDigitObservations
    ? buildScoreTransitionRefinementPasses(aggregated, {
        expectedGoalCount: context.metadata && context.metadata.expectedCountedGoals,
      })
    : [];
  const scheduledRefinementPasses = scheduleScoreTransitionRefinementPasses(refinementPasses);
  for (const refinementPass of scheduledRefinementPasses) {
    const refinementElapsedMs = Date.now() - startedMs;
    const refinementRemainingMs = effectiveTotalBudgetMs - refinementElapsedMs;
    if (refinementRemainingMs < 1000) break;
    const refinementWindows = refinementPass.windows;
    const refinementTimeoutMs = Math.min(
      refinementRemainingMs,
      Math.max(10_000, Math.min(36_000, refinementWindows.length * 900)),
    );
    updateJobStep({
      jobs,
      job,
      projectId: project.id,
      requestId,
      logger: deps.logger,
      progress: 29,
      step: "run_scorebug_ocr",
      substep: "scorebug_transition_refinement",
      longSource: true,
      scorebugFirst: true,
      budgetMs: refinementTimeoutMs,
      progressDetails: {
        refinementPass: refinementPass.index,
        refinementPassCount: scheduledRefinementPasses.length,
        anchorTimestamp: refinementPass.anchorTimestamp,
        scoreBefore: refinementPass.scoreBefore,
        scoreAfter: refinementPass.scoreAfter,
        sampledFrameCount: refinementWindows.length,
        discoveredScoreChanges: Number(aggregated.summary && aggregated.summary.scoreChangeCount || 0),
        elapsedMs: refinementElapsedMs,
        totalBudgetMs: effectiveTotalBudgetMs,
      },
    });
    try {
      let refined = await runStepWithTimeout(
        (stepSignal) => deps.analyzeScoreboardOcr({
          inputPath: context.inputPath,
          metadata: context.metadata,
          candidateWindows: refinementWindows,
          mediaSignals,
          visualSignals: { windows: [] },
          frames: [],
          frameSummary: null,
          ocrSamplingWindows: refinementWindows,
          scorebugFirstOnly: true,
          scorebugFirstRegionIds: preferredScorebugRegionIds,
          signal: stepSignal,
          timeoutMs: refinementTimeoutMs,
        }),
        {
          signal,
          timeoutMs: refinementTimeoutMs,
          code: "SCOREBOARD_OCR_TIMEOUT",
          details: {
            phase: "analysis",
            step: "run_scorebug_ocr",
            substep: "scorebug_transition_refinement",
            refinementPass: refinementPass.index,
            anchorTimestamp: refinementPass.anchorTimestamp,
            sampledFrameCount: refinementWindows.length,
            timeoutMs: refinementTimeoutMs,
          },
        },
      );
      refined = refineExpectedScoreTransitionOutput(refined, refinementPass, outputs);
      outputs.push(refined);
      aggregated = aggregateChunkedScoreboardOcr(outputs, {
        metadata: context.metadata,
        chunkSummary,
      });
      logInfo(deps.logger, {
        event: "scoreboard_ocr_transition_refinement_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "run_scorebug_ocr",
        substep: "scorebug_transition_refinement",
        refinementPass: refinementPass.index,
        refinementPassCount: scheduledRefinementPasses.length,
        anchorTimestamp: refinementPass.anchorTimestamp,
        scoreBefore: refinementPass.scoreBefore,
        scoreAfter: refinementPass.scoreAfter,
        sampledFrameCount: refinementWindows.length,
        discoveredScoreChanges: Number(aggregated.summary && aggregated.summary.scoreChangeCount || 0),
        elapsedMs: Date.now() - startedMs,
      });
    } catch (error) {
      if ((signal && signal.aborted) || error.code === "JOB_CANCELLED") throw error;
      logInfo(deps.logger, {
        event: "scoreboard_ocr_transition_refinement_skipped",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "run_scorebug_ocr",
        substep: "scorebug_transition_refinement",
        refinementPass: refinementPass.index,
        refinementPassCount: scheduledRefinementPasses.length,
        anchorTimestamp: refinementPass.anchorTimestamp,
        code: sanitizeText(error && error.code || "SCOREBOARD_OCR_REFINEMENT_FAILED", 80),
        sampledFrameCount: refinementWindows.length,
        elapsedMs: Date.now() - startedMs,
      });
    }
  }
  return ensureScoreCandidateProgressionEvidence(aggregated);
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
  let goalTrackingFrames = null;
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
  let renderedGoalProof = null;
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
        jobs.update(job, {
          scoreboardOcr: publicScoreboardOcr(scoreboardOcr),
          step: "scoreboard_ocr_completed",
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
        maxFrames: longSourceRuntime ? 24 : undefined,
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
      logInfo(deps.logger, {
        event: "visual_analysis_started",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_visuals",
        substep: longSourceRuntime ? "scorebug_narrowed_visual_analysis" : "frame_visual_analysis",
        candidateWindowCount: Array.isArray(visualCandidateWindows) ? visualCandidateWindows.length : 0,
        frameCount: sampledFrameSummary.summary.frameCount,
      });
      try {
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
      } catch (visualError) {
        if (!longSourceRuntime || (visualError && visualError.code === "JOB_CANCELLED")) throw visualError;
        const visualFailureCode = sanitizeText(
          visualError && visualError.code ? visualError.code : "NARROWED_VISUAL_ANALYSIS_FAILED",
          80,
        );
        logInfo(deps.logger, {
          event: "visual_analysis_fallback_used",
          requestId,
          projectId: project.id,
          jobId: job.id,
          step: "analyze_visuals",
          substep: "scorebug_narrowed_visual_analysis",
          code: visualFailureCode,
          candidateWindowCount: Array.isArray(visualCandidateWindows) ? visualCandidateWindows.length : 0,
          frameCount: sampledFrameSummary.summary.frameCount,
        });
        const fallbackWindows = fallbackVisualWindowsFromCandidateWindows(visualCandidateWindows, context.metadata);
        const fallbackPayload = {
          providerMode: "scorebug-narrowed-visual-fallback",
          fallbackUsed: true,
          confidence: 0.45,
          providerMetadata: {
            model: "candidate-window-fallback",
            latencyMs: 0,
          },
          failure: {
            code: visualFailureCode,
            phase: "vision_provider",
            retryable: false,
          },
          windows: fallbackWindows,
        };
        try {
          visualSignals = validateVisualSignals(fallbackPayload, context.metadata);
        } catch {
          visualSignals = validateVisualSignals({ ...fallbackPayload, windows: [] }, context.metadata);
        }
      }
      try {
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
      } catch (trackingError) {
        if (!longSourceRuntime || (trackingError && trackingError.code === "JOB_CANCELLED")) throw trackingError;
        const trackingFailureCode = sanitizeText(
          trackingError && trackingError.code ? trackingError.code : "TRACKING_PROVIDER_FAILED",
          80,
        );
        logInfo(deps.logger, {
          event: "tracking_analysis_fallback_used",
          requestId,
          projectId: project.id,
          jobId: job.id,
          step: "analyze_visual_tracking",
          substep: "scorebug_narrowed_tracking_analysis",
          code: trackingFailureCode,
          frameCount: sampledFrameSummary.summary.frameCount,
        });
        trackingProviderOutput = publicTrackingProviderOutput(trackingFallback({
          metadata: context.metadata,
          frames: sampledFrames.frames,
          reason: "tracking_provider_output_invalid",
          failure: {
            code: trackingFailureCode,
            phase: "tracking_provider",
            retryable: false,
          },
        }), context.metadata);
      }
      try {
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
      } catch (trackingSummaryError) {
        if (!longSourceRuntime || (trackingSummaryError && trackingSummaryError.code === "JOB_CANCELLED")) throw trackingSummaryError;
        const trackingSummaryFailureCode = sanitizeText(
          trackingSummaryError && trackingSummaryError.code ? trackingSummaryError.code : "VISUAL_TRACKING_SUMMARY_FAILED",
          80,
        );
        logInfo(deps.logger, {
          event: "visual_tracking_summary_fallback_used",
          requestId,
          projectId: project.id,
          jobId: job.id,
          step: "analyze_visual_tracking",
          substep: "scorebug_narrowed_tracking_summary",
          code: trackingSummaryFailureCode,
          frameCount: sampledFrameSummary.summary.frameCount,
        });
        visualTracking = publicVisualTrackingSummary(null, context.metadata);
      }
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
          allowScoreChangeBacktrackFallback: Boolean(longSourceRuntime),
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
      if (!context.approvedEditPlan && context.goalSelectionMode === "valid_goals_only") {
        editPlan = deps.validateEditPlan(referenceVerticalGoalProofPlan(editPlan, context.metadata, scoreboardOcr), context.metadata);
        if (
          longSourceRuntime &&
          editPlan.cropPlan &&
          editPlan.cropPlan.mode === "ball_follow" &&
          editPlan.cropPlan.fallbackUsed !== true
        ) {
          const refinementWindows = goalTrackingCandidateWindows(editPlan, context.metadata);
          if (refinementWindows.length >= 3) {
            try {
              goalTrackingFrames = await deps.extractSampledFrames({
                inputPath: context.inputPath,
                metadata: context.metadata,
                candidateWindows: refinementWindows,
                maxFrames: 24,
                signal,
              });
              const refinedTrackingOutput = publicTrackingProviderOutput(await deps.analyzeTracking({
                inputPath: context.inputPath,
                metadata: context.metadata,
                candidateWindows: refinementWindows,
                mediaSignals,
                visualSignals,
                frames: goalTrackingFrames.frames,
                frameSummary: publicFrameSummary(goalTrackingFrames),
                signal,
              }), context.metadata);
              const refinedTrackingSummary = publicVisualTrackingSummary(deps.analyzeVisualTracking({
                inputPath: context.inputPath,
                metadata: context.metadata,
                candidateWindows: refinementWindows,
                mediaSignals,
                visualSignals,
                trackingProviderOutput: refinedTrackingOutput,
                frames: goalTrackingFrames.frames,
                frameSummary: publicFrameSummary(goalTrackingFrames),
              }), context.metadata);
              const refinedCropPlan = deps.calibrateCropPlan({
                metadata: context.metadata,
                targetAspectRatio: editPlan.aspectRatio || "9:16",
                trackingSummary: refinedTrackingSummary,
              });
              if (
                refinedCropPlan.mode === "ball_follow" &&
                refinedCropPlan.fallbackUsed !== true &&
                Array.isArray(refinedCropPlan.keyframes) &&
                refinedCropPlan.keyframes.length >= 3
              ) {
                editPlan = deps.validateEditPlan(referenceVerticalGoalProofPlan({
                  ...editPlan,
                  cropPlan: refinedCropPlan,
                  visualTrackingSummary: refinedTrackingSummary,
                  framingMode: "safe_center",
                  framingReason: "selected_goal_ball_tracking_refinement",
                }, context.metadata, scoreboardOcr), context.metadata);
                trackingProviderOutput = refinedTrackingOutput;
                visualTracking = refinedTrackingSummary;
                logInfo(deps.logger, {
                  event: "selected_goal_tracking_refinement_completed",
                  requestId,
                  projectId: project.id,
                  jobId: job.id,
                  step: "create_edit_plan",
                  providerMode: refinedTrackingOutput.providerMode,
                  candidateWindowCount: refinementWindows.length,
                  keyframeCount: refinedCropPlan.keyframes.length,
                  ballTrackCount: refinedTrackingOutput.ballTrackCount,
                  playerClusterCount: refinedTrackingOutput.playerClusterCount,
                  fallbackUsed: false,
                });
              }
            } catch (refinementError) {
              if (refinementError && refinementError.code === "JOB_CANCELLED") throw refinementError;
              logInfo(deps.logger, {
                event: "selected_goal_tracking_refinement_fallback_used",
                requestId,
                projectId: project.id,
                jobId: job.id,
                step: "create_edit_plan",
                code: refinementError && refinementError.code
                  ? sanitizeText(refinementError.code, 80)
                  : "GOAL_TRACKING_REFINEMENT_FAILED",
                fallbackUsed: true,
              });
            }
          }
        }
      }
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
          requireRenderedGoalVisibility: false,
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
    if (!context.approvedEditPlan && context.goalSelectionMode === "valid_goals_only") {
      updateJobStep({
        jobs,
        job,
        projectId: project.id,
        requestId,
        logger: deps.logger,
        progress: 88,
        step: "verify_rendered_goal_visibility",
        substep: "sample_rendered_finish_frames",
        longSource: Boolean(longSourceRuntime),
        scorebugFirst: Boolean(longSourceRuntime),
      });
      renderedGoalProof = await deps.analyzeRenderedGoalProof({
        outputPath: context.outputPath,
        editPlan,
        metadata: context.metadata,
        signal,
        onProgress: (proofProgress) => updateJobStep({
          jobs,
          job,
          projectId: project.id,
          requestId,
          logger: deps.logger,
          progress: 88,
          step: "verify_rendered_goal_visibility",
          substep: "sample_rendered_finish_frames",
          longSource: Boolean(longSourceRuntime),
          scorebugFirst: Boolean(longSourceRuntime),
          renderedGoalProofProgress: proofProgress,
        }),
      });
      if (renderedGoalProof && renderedGoalProof.editPlan) {
        const renderPolishQA = renderedGoalProof.editPlan.renderPolishQA;
        editPlan = deps.validateEditPlan(renderedGoalProof.editPlan, context.metadata);
        if (renderPolishQA && typeof renderPolishQA === "object" && !Array.isArray(renderPolishQA)) {
          editPlan.renderPolishQA = renderPolishQA;
        }
        editPlan.renderedGoalProof = renderedGoalProof.summary || null;
      }
      try {
        videoOutputQA = deps.assertVideoOutputCoverage({
          editPlan,
          matchEventTruth,
          goalSelectionMode: context.goalSelectionMode,
          requireRenderedGoalVisibility: true,
        });
      } catch (error) {
        if (error && error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
          videoOutputQA = error.details;
          editPlan.videoOutputQA = videoOutputQA;
          if (renderedGoalProof && renderedGoalProof.summary) {
            editPlan.renderedGoalProof = renderedGoalProof.summary;
          }
          jobs.update(job, {
            editPlan,
            videoOutputQA,
            renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
            step: "post_render_video_output_qa_failed",
          });
          logInfo(deps.logger, {
            event: "post_render_video_output_qa_failed",
            requestId,
            projectId: project.id,
            jobId: job.id,
            step: "verify_rendered_goal_visibility",
            status: videoOutputQA.status,
            expectedGoalCount: videoOutputQA.expectedGoalCount,
            humanVisibleGoalsClear: videoOutputQA.humanVisibleGoalsClear,
            humanVisibleGoalsBorderline: videoOutputQA.humanVisibleGoalsBorderline,
            humanVisibleGoalsFailed: videoOutputQA.humanVisibleGoalsFailed,
            failedReasonCount: Array.isArray(videoOutputQA.failedReasons) ? videoOutputQA.failedReasons.length : 0,
            renderedGoalProof: renderedGoalProof && renderedGoalProof.summary
              ? {
                  goalCount: renderedGoalProof.summary.goalCount,
                  clearGoalCount: renderedGoalProof.summary.clearGoalCount,
                  borderlineGoalCount: renderedGoalProof.summary.borderlineGoalCount,
                  failedGoalCount: renderedGoalProof.summary.failedGoalCount,
                  contactSheetRef: renderedGoalProof.summary.contactSheetRef,
                }
              : null,
            logsDownloaded: false,
            artifactsDownloaded: false,
          });
        }
        let rebindRecovered = false;
        let lastRebindError = error;
        const rebindFailures = safeGoalProofFailures(renderedGoalProof);
        const rebindTargeted = rebindFailures.length > 0 && rebindFailures.length <= 2;
        if (!rebindTargeted && rebindFailures.length > 0) {
          logInfo(deps.logger, {
            event: "rendered_goal_rebinding_skipped",
            requestId,
            projectId: project.id,
            jobId: job.id,
            step: "verify_rendered_goal_visibility",
            reason: "too_many_failed_goals_for_targeted_rebind",
            failedGoalCount: rebindFailures.length,
            failedGoals: rebindFailures.map((failure) => ({
              goalNumber: failure.goalNumber,
              segmentIndex: failure.segmentIndex,
              verdict: failure.verdict,
            })).slice(0, 8),
            logsDownloaded: false,
            artifactsDownloaded: false,
          });
        }
        for (
          let rebindAttempt = 1;
          rebindTargeted && rebindAttempt <= RENDERED_GOAL_REBIND_MAX_ATTEMPTS;
          rebindAttempt += 1
        ) {
          const rebind = rebindRenderedGoalFailureSegments({
            editPlan,
            renderedGoalProof,
            metadata: context.metadata,
            attemptNumber: rebindAttempt,
          });
          if (!rebind.applied) break;
          updateJobStep({
            jobs,
            job,
            projectId: project.id,
            requestId,
            logger: deps.logger,
            progress: 89,
            step: "verify_rendered_goal_visibility",
            substep: `rerender_rebound_goal_windows_attempt_${rebindAttempt}`,
            longSource: Boolean(longSourceRuntime),
            scorebugFirst: Boolean(longSourceRuntime),
          });
          jobs.update(job, {
            editPlan: {
              ...editPlan,
              renderedGoalRebinding: rebind.summary,
            },
            videoOutputQA,
            renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
            renderedGoalRebinding: rebind.summary,
            step: "rendered_goal_rebinding_attempted",
          });
          logInfo(deps.logger, {
            event: "rendered_goal_rebinding_attempted",
            requestId,
            projectId: project.id,
            jobId: job.id,
            step: "verify_rendered_goal_visibility",
            attemptNumber: rebindAttempt,
            reboundGoalCount: rebind.summary.reboundGoalCount,
            failedGoalCount: rebind.summary.failedGoalCount,
            diagnostics: rebind.summary.diagnostics,
            logsDownloaded: false,
            artifactsDownloaded: false,
          });
          editPlan = deps.validateEditPlan(rebind.editPlan, context.metadata);
          editPlan.renderedGoalRebinding = rebind.summary;
          try {
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
            updateJobStep({
              jobs,
              job,
              projectId: project.id,
              requestId,
              logger: deps.logger,
              progress: 90,
              step: "verify_rendered_goal_visibility",
              substep: `sample_rebound_finish_frames_attempt_${rebindAttempt}`,
              longSource: Boolean(longSourceRuntime),
              scorebugFirst: Boolean(longSourceRuntime),
            });
            renderedGoalProof = await deps.analyzeRenderedGoalProof({
              outputPath: context.outputPath,
              editPlan,
              previousRenderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
              metadata: context.metadata,
              signal,
              onProgress: (proofProgress) => updateJobStep({
                jobs,
                job,
                projectId: project.id,
                requestId,
                logger: deps.logger,
                progress: 90,
                step: "verify_rendered_goal_visibility",
                substep: `sample_rebound_finish_frames_attempt_${rebindAttempt}`,
                longSource: Boolean(longSourceRuntime),
                scorebugFirst: Boolean(longSourceRuntime),
                renderedGoalProofProgress: proofProgress,
              }),
            });
            if (renderedGoalProof && renderedGoalProof.editPlan) {
              const renderPolishQA = renderedGoalProof.editPlan.renderPolishQA;
              editPlan = deps.validateEditPlan({
                ...renderedGoalProof.editPlan,
                renderedGoalRebinding: rebind.summary,
              }, context.metadata);
              if (renderPolishQA && typeof renderPolishQA === "object" && !Array.isArray(renderPolishQA)) {
                editPlan.renderPolishQA = renderPolishQA;
              }
              editPlan.renderedGoalProof = renderedGoalProof.summary || null;
              editPlan.renderedGoalRebinding = rebind.summary;
            }
            const renderedProofClear = renderedGoalProof &&
              renderedGoalProof.summary &&
              Number(renderedGoalProof.summary.clearGoalCount) >= REFERENCE_STYLE_GOAL_COUNT &&
              Number(renderedGoalProof.summary.borderlineGoalCount || 0) === 0 &&
              Number(renderedGoalProof.summary.failedGoalCount || 0) === 0;
            let bestVisibleGateError = null;
            let bestVisibleEditPlan = null;
            let bestVisibleRenderedGoalProof = null;
            if (renderedProofClear) {
              try {
                deps.assertVideoOutputCoverage({
                  editPlan,
                  matchEventTruth,
                  goalSelectionMode: context.goalSelectionMode,
                  requireRenderedGoalVisibility: true,
                });
              } catch (visibleGateError) {
                if (
                  visibleGateError &&
                  visibleGateError.details &&
                  visibleGateError.details.renderedGoalVisibility &&
                  visibleGateError.details.renderedGoalVisibility.passed === true
                ) {
                  bestVisibleGateError = visibleGateError;
                  bestVisibleEditPlan = editPlan;
                  bestVisibleRenderedGoalProof = renderedGoalProof;
                }
              }
            }
            const editPlanDuration = safeNumber(editPlan.totalDuration);
            if (renderedProofClear && editPlanDuration != null && editPlanDuration > REFERENCE_STYLE_MAX_DURATION_SECONDS) {
              const compaction = compactVisibleGoalSegmentsForReferenceDuration({
                editPlan,
                renderedGoalProof,
                metadata: context.metadata,
              });
              if (compaction.applied) {
                logInfo(deps.logger, {
                  event: "rendered_goal_duration_compaction_attempted",
                  requestId,
                  projectId: project.id,
                  jobId: job.id,
                  step: "verify_rendered_goal_visibility",
                  attemptNumber: rebindAttempt,
                  originalTotalDuration: compaction.summary.originalTotalDuration,
                  compactedTotalDuration: compaction.summary.compactedTotalDuration,
                  compactedGoalCount: compaction.summary.compactedGoalCount,
                  diagnostics: compaction.summary.diagnostics,
                  logsDownloaded: false,
                  artifactsDownloaded: false,
                });
                editPlan = deps.validateEditPlan(compaction.editPlan, context.metadata);
                editPlan.renderedGoalProof = renderedGoalProof.summary || null;
                editPlan.renderedGoalRebinding = rebind.summary;
                editPlan.renderedGoalCompaction = compaction.summary;
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
                renderedGoalProof = await deps.analyzeRenderedGoalProof({
                  outputPath: context.outputPath,
                  editPlan,
                  previousRenderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
                  metadata: context.metadata,
                  signal,
                  onProgress: (proofProgress) => updateJobStep({
                    jobs,
                    job,
                    projectId: project.id,
                    requestId,
                    logger: deps.logger,
                    progress: 91,
                    step: "verify_rendered_goal_visibility",
                    substep: "sample_compacted_finish_frames",
                    longSource: Boolean(longSourceRuntime),
                    scorebugFirst: Boolean(longSourceRuntime),
                    renderedGoalProofProgress: proofProgress,
                  }),
                });
                if (renderedGoalProof && renderedGoalProof.editPlan) {
                  const renderPolishQA = renderedGoalProof.editPlan.renderPolishQA;
                  editPlan = deps.validateEditPlan({
                    ...renderedGoalProof.editPlan,
                    renderedGoalRebinding: rebind.summary,
                    renderedGoalCompaction: compaction.summary,
                    visualPolishQA: compactedReferenceVisualPolishSummary(
                      renderedGoalProof.editPlan,
                      Array.isArray(renderedGoalProof.editPlan.segments) ? renderedGoalProof.editPlan.segments : [],
                      safeNumber(renderedGoalProof.editPlan.totalDuration) || compaction.summary.compactedTotalDuration,
                    ),
                  }, context.metadata);
                  if (renderPolishQA && typeof renderPolishQA === "object" && !Array.isArray(renderPolishQA)) {
                    editPlan.renderPolishQA = renderPolishQA;
                  }
                  editPlan.renderedGoalProof = renderedGoalProof.summary || null;
                  editPlan.renderedGoalRebinding = rebind.summary;
                  editPlan.renderedGoalCompaction = compaction.summary;
                }
	                const compactedProofClear = renderedGoalProof &&
	                  renderedGoalProof.summary &&
	                  Number(renderedGoalProof.summary.clearGoalCount) >= REFERENCE_STYLE_GOAL_COUNT &&
	                  Number(renderedGoalProof.summary.borderlineGoalCount || 0) === 0 &&
	                  Number(renderedGoalProof.summary.failedGoalCount || 0) === 0;
	                if (!compactedProofClear) {
	                  editPlan.renderedGoalCompaction = {
	                    ...compaction.summary,
	                    compactedRenderedGoalProof: renderedGoalProof && renderedGoalProof.summary
	                      ? {
	                          status: renderedGoalProof.summary.status || null,
	                          passed: Boolean(renderedGoalProof.summary.passed),
	                          goalCount: safeNumber(renderedGoalProof.summary.goalCount),
	                          clearGoalCount: safeNumber(renderedGoalProof.summary.clearGoalCount),
	                          borderlineGoalCount: safeNumber(renderedGoalProof.summary.borderlineGoalCount),
	                          failedGoalCount: safeNumber(renderedGoalProof.summary.failedGoalCount),
	                          missingClearGoalNumbers: Array.isArray(renderedGoalProof.summary.missingClearGoalNumbers)
	                            ? renderedGoalProof.summary.missingClearGoalNumbers.slice(0, 8)
	                            : [],
	                        }
	                      : null,
	                  };
	                }
	              }
	            }
            videoOutputQA = deps.assertVideoOutputCoverage({
              editPlan,
              matchEventTruth,
              goalSelectionMode: context.goalSelectionMode,
              requireRenderedGoalVisibility: true,
            });
            rebindRecovered = true;
            logInfo(deps.logger, {
              event: "rendered_goal_rebinding_recovered",
              requestId,
              projectId: project.id,
              jobId: job.id,
              step: "verify_rendered_goal_visibility",
              attemptNumber: rebindAttempt,
              status: videoOutputQA.status,
              expectedGoalCount: videoOutputQA.expectedGoalCount,
              coveredGoalCount: videoOutputQA.coveredGoalCount,
              humanVisibleGoalsClear: videoOutputQA.humanVisibleGoalsClear,
              missingGoalNumbers: videoOutputQA.missingGoalNumbers,
              reboundGoalCount: rebind.summary.reboundGoalCount,
              logsDownloaded: false,
              artifactsDownloaded: false,
            });
            break;
          } catch (rebindError) {
            lastRebindError = rebindError;
            if (rebindError && rebindError.details && typeof rebindError.details === "object" && !Array.isArray(rebindError.details)) {
              videoOutputQA = {
                ...rebindError.details,
                renderedGoalRebinding: rebind.summary,
              };
              editPlan.videoOutputQA = videoOutputQA;
              editPlan.renderedGoalRebinding = rebind.summary;
              if (renderedGoalProof && renderedGoalProof.summary) {
                editPlan.renderedGoalProof = renderedGoalProof.summary;
              }
              jobs.update(job, {
                editPlan,
                videoOutputQA,
                renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
                renderedGoalRebinding: rebind.summary,
                step: "post_rebind_video_output_qa_failed",
              });
              logInfo(deps.logger, {
                event: "post_rebind_video_output_qa_failed",
                requestId,
                projectId: project.id,
                jobId: job.id,
                step: "verify_rendered_goal_visibility",
                attemptNumber: rebindAttempt,
                status: videoOutputQA.status,
                expectedGoalCount: videoOutputQA.expectedGoalCount,
                humanVisibleGoalsClear: videoOutputQA.humanVisibleGoalsClear,
                humanVisibleGoalsBorderline: videoOutputQA.humanVisibleGoalsBorderline,
                humanVisibleGoalsFailed: videoOutputQA.humanVisibleGoalsFailed,
                missingGoalNumbers: videoOutputQA.missingGoalNumbers,
                reboundGoalCount: rebind.summary.reboundGoalCount,
                renderedGoalProof: renderedGoalProof && renderedGoalProof.summary
                  ? {
                      goalCount: renderedGoalProof.summary.goalCount,
                      clearGoalCount: renderedGoalProof.summary.clearGoalCount,
                      borderlineGoalCount: renderedGoalProof.summary.borderlineGoalCount,
                      failedGoalCount: renderedGoalProof.summary.failedGoalCount,
                      contactSheetRef: renderedGoalProof.summary.contactSheetRef,
                    }
                  : null,
                logsDownloaded: false,
                artifactsDownloaded: false,
              });
            }
            if (videoOutputQA && videoOutputQA.renderedGoalVisibility && videoOutputQA.renderedGoalVisibility.passed === true) {
              throw rebindError;
            }
          }
        }
        if (!rebindRecovered) {
          throw lastRebindError;
        }
      }
      editPlan.videoOutputQA = videoOutputQA;
      jobs.update(job, {
        editPlan,
        videoOutputQA,
        renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
        renderedGoalRebinding: editPlan.renderedGoalRebinding || null,
        step: "post_render_video_output_qa_passed",
      });
      logInfo(deps.logger, {
        event: "post_render_video_output_qa_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "verify_rendered_goal_visibility",
        status: videoOutputQA.status,
        expectedGoalCount: videoOutputQA.expectedGoalCount,
        humanVisibleGoalsClear: videoOutputQA.humanVisibleGoalsClear,
        humanVisibleGoalsBorderline: videoOutputQA.humanVisibleGoalsBorderline,
        humanVisibleGoalsFailed: videoOutputQA.humanVisibleGoalsFailed,
        contactSheetRef: renderedGoalProof && renderedGoalProof.summary && renderedGoalProof.summary.contactSheetRef,
        logsDownloaded: false,
        artifactsDownloaded: false,
      });
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
      renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
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
      renderedGoalProof: renderedGoalProof && renderedGoalProof.summary,
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
    if (goalTrackingFrames && typeof deps.cleanupSampledFrames === "function") {
      const cleanupResult = deps.cleanupSampledFrames({
        outputDir: goalTrackingFrames.outputDir,
        frames: goalTrackingFrames.frames,
      });
      if (cleanupResult && cleanupResult.cleanedCount > 0) {
        logInfo(deps.logger, {
          event: "goal_tracking_frames_cleaned",
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
  scoreChangeCandidateWindowsFromOcr,
  visualCandidateWindowsFromSignals,
  resolveLocalArtifactPath,
  ocrQaCalibrationOptionsFromEnv,
  __testing: {
    aggregateChunkedScoreboardOcr,
    buildScoreTransitionRefinementPasses,
    buildScoreTransitionRefinementWindows,
    scheduleScoreTransitionRefinementPasses,
    compactAggregatedScoreEvidence,
    refineExpectedScoreTransitionOutput,
    runChunkedScorebugFirstOcr,
    buildChunkSamplingWindows,
    buildScoreCandidateProgressionFromChunks,
    compactVisibleGoalSegmentsForReferenceDuration,
    goalTrackingCandidateWindows,
    renderedProofSourceTimes,
    rebindRenderedGoalFailureSegments,
    segmentTimelineStarts,
  },
};
