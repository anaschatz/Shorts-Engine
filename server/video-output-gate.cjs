const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { publicMatchEventTruth } = require("./match-event-truth.cjs");

const OUTPUT_GATE_SCHEMA_VERSION = 1;
const MATCH_TOLERANCE_SECONDS = 2;
const MAX_PUBLIC_ITEMS = 12;

const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeCodes(values = [], max = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean)
    .filter((value) => !SENSITIVE_RE.test(value)))]
    .slice(0, max);
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function publicWindow(value = {}) {
  const start = numberOrNull(value.start ?? value.sourceStart);
  const end = numberOrNull(value.end ?? value.sourceEnd);
  return {
    start: start == null ? null : round(start),
    end: end == null ? null : round(end),
  };
}

function publicExpectedGoal(goal = {}) {
  return {
    goalNumber: goal.goalNumber,
    source: sanitizeText(goal.source || "unknown", 40),
    anchorTime: goal.anchorTime == null ? null : round(goal.anchorTime),
    confirmationTime: goal.confirmationTime == null ? null : round(goal.confirmationTime),
    sourceWindow: goal.sourceWindow || null,
    scoreBefore: goal.scoreBefore ? sanitizeText(goal.scoreBefore, 16) : null,
    scoreAfter: goal.scoreAfter ? sanitizeText(goal.scoreAfter, 16) : null,
  };
}

function publicSegment(segment = {}, index = 0) {
  const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const goalOutcome = segment.goalOutcome && typeof segment.goalOutcome === "object" && !Array.isArray(segment.goalOutcome)
    ? segment.goalOutcome
    : null;
  return {
    index: index + 1,
    id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
    sourceStart: round(segment.sourceStart),
    sourceEnd: round(segment.sourceEnd),
    highlightType: sanitizeText(segment.highlightType || "unknown", 48),
    goalNumber: numberOrNull(segment.goalNumber),
    outcome: goalOutcome ? sanitizeText(goalOutcome.outcome || "unknown", 48) : null,
    shotStart: numberOrNull(segment.shotStart),
    finishTime: numberOrNull(segment.finishTime),
    confirmationTime: numberOrNull(segment.confirmationTime),
    replayOnly: Boolean(segment.replayOnly || phaseCoverage.replayOnly),
    replayUsed: Boolean(segment.replayUsed || phaseCoverage.replayUsed),
    phaseCoverage: {
      hasBuildup: Boolean(phaseCoverage.hasBuildup),
      hasShot: Boolean(phaseCoverage.hasShot),
      hasFinish: Boolean(phaseCoverage.hasFinish),
      hasConfirmation: Boolean(phaseCoverage.hasConfirmation),
      replayOnly: Boolean(phaseCoverage.replayOnly),
    },
    reasonCodes: safeCodes(segment.reasonCodes, 10),
    safetyFlags: safeCodes(segment.safetyFlags, 8),
  };
}

function segmentList(editPlan = {}) {
  if (Array.isArray(editPlan.segments) && editPlan.segments.length) return editPlan.segments;
  if (!editPlan || typeof editPlan !== "object") return [];
  return [{
    id: editPlan.candidateId || "single_segment",
    sourceStart: editPlan.sourceStart,
    sourceEnd: editPlan.sourceEnd,
    highlightType: editPlan.highlightType,
    reasonCodes: editPlan.reasonCodes,
    goalOutcome: editPlan.goalOutcome,
    confidence: editPlan.confidence,
    replayOnly: editPlan.replayOnly,
    phaseCoverage: editPlan.phaseCoverage,
    shotStart: editPlan.shotStart,
    finishTime: editPlan.finishTime,
    confirmationTime: editPlan.confirmationTime,
  }];
}

function isConfirmedGoalSegment(segment = {}) {
  return segment.highlightType === "goal" &&
    segment.goalOutcome &&
    segment.goalOutcome.eventType === "ball_in_net" &&
    segment.goalOutcome.outcome === "confirmed_goal";
}

function segmentContainsTime(segment = {}, time) {
  if (time == null) return false;
  const start = numberOrNull(segment.sourceStart);
  const end = numberOrNull(segment.sourceEnd);
  return start != null && end != null && time >= start - MATCH_TOLERANCE_SECONDS && time <= end + MATCH_TOLERANCE_SECONDS;
}

function overlapSeconds(segment = {}, expected = {}) {
  if (!expected.sourceWindow) return 0;
  const start = numberOrNull(segment.sourceStart);
  const end = numberOrNull(segment.sourceEnd);
  if (start == null || end == null) return 0;
  const left = Math.max(start, expected.sourceWindow.start);
  const right = Math.min(end, expected.sourceWindow.end);
  return Math.max(0, right - left);
}

function expectedGoalsFromTruth(matchEventTruth = {}) {
  const truth = publicMatchEventTruth(matchEventTruth);
  const scoreChanges = (Array.isArray(truth.scoreChanges) ? truth.scoreChanges : [])
    .filter((change) => change.outcome === "counted_goal")
    .sort((a, b) => Number(a.changeTime || 0) - Number(b.changeTime || 0));
  if (scoreChanges.length) {
    return scoreChanges.map((change, index) => ({
      goalNumber: index + 1,
      source: "score_change",
      anchorTime: numberOrNull(change.actionAnchorTime ?? change.changeTime),
      confirmationTime: numberOrNull(change.changeTime),
      sourceWindow: null,
      scoreBefore: change.startScore || null,
      scoreAfter: change.endScore || null,
    }));
  }

  const selectedGoals = (Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [])
    .filter((event) => event.type === "confirmed_goal" && event.outcome === "confirmed_goal")
    .sort((a, b) => Number(a.sourceStart || 0) - Number(b.sourceStart || 0));
  if (selectedGoals.length) {
    return selectedGoals.map((event, index) => ({
      goalNumber: numberOrNull(event.goalNumber) || index + 1,
      source: "match_event_truth",
      anchorTime: numberOrNull(event.shotStart ?? event.scoreChangeTime ?? event.sourceStart),
      confirmationTime: numberOrNull(event.confirmationTime ?? event.scoreChangeTime ?? event.sourceEnd),
      sourceWindow: publicWindow(event),
      scoreBefore: event.scoreBefore || null,
      scoreAfter: event.scoreAfter || null,
    }));
  }

  const countedGoalCount = Number(truth.summary && truth.summary.countedGoalEventCount || 0);
  return Array.from({ length: Math.max(0, Math.min(7, countedGoalCount)) }, (_, index) => ({
    goalNumber: index + 1,
    source: "summary_count",
    anchorTime: null,
    confirmationTime: null,
    sourceWindow: null,
    scoreBefore: null,
    scoreAfter: null,
  }));
}

function segmentFailureReasons(segment = {}, goalSelectionMode = "balanced") {
  const reasons = [];
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" ? segment.phaseCoverage : {};
  const shotStart = numberOrNull(segment.shotStart ?? phase.shotStart);
  const finishTime = numberOrNull(segment.finishTime ?? phase.finishTime);
  const confirmationTime = numberOrNull(segment.confirmationTime ?? phase.confirmationTime);
  const reasonCodes = new Set(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []);
  const confirmedGoal = isConfirmedGoalSegment(segment);

  if (goalSelectionMode === "valid_goals_only" && !confirmedGoal) reasons.push("non_goal_segment_in_valid_goals_only_output");
  if (confirmedGoal && (segment.replayOnly || phase.replayOnly)) reasons.push("replay_only_goal_segment");
  if (confirmedGoal && (!phase.hasBuildup || shotStart == null)) reasons.push("missing_buildup_or_shot_start");
  if (confirmedGoal && (!phase.hasShot || shotStart == null)) reasons.push("missing_visible_shot");
  if (confirmedGoal && (!phase.hasFinish || finishTime == null)) reasons.push("missing_visible_finish");
  if (confirmedGoal && (!phase.hasConfirmation || confirmationTime == null)) reasons.push("missing_goal_confirmation");
  if (
    confirmedGoal &&
    (reasonCodes.has("visual_celebration_after_shot") || reasonCodes.has("visual_celebration_after_whistle")) &&
    (!phase.hasShot || !phase.hasFinish)
  ) {
    reasons.push("celebration_only_goal_segment");
  }
  return safeCodes(reasons, 8);
}

function matchExpectedGoals(expectedGoals = [], segments = []) {
  const matches = [];
  const usedSegments = new Set();
  for (const expected of expectedGoals) {
    const candidates = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ index }) => !usedSegments.has(index))
      .filter(({ segment }) => isConfirmedGoalSegment(segment))
      .map(({ segment, index }) => ({
        segment,
        index,
        score: [
          numberOrNull(segment.goalNumber) === expected.goalNumber ? 4 : 0,
          segmentContainsTime(segment, expected.anchorTime) ? 3 : 0,
          segmentContainsTime(segment, expected.confirmationTime) ? 3 : 0,
          overlapSeconds(segment, expected) > 0.5 ? 2 : 0,
        ].reduce((sum, value) => sum + value, 0),
      }))
      .filter((candidate) => candidate.score > 0 || expected.anchorTime == null)
      .sort((a, b) => b.score - a.score || Number(a.segment.sourceStart || 0) - Number(b.segment.sourceStart || 0));
    const selected = candidates[0] || null;
    if (!selected) {
      matches.push({ expected, segmentIndex: null, covered: false, reasons: ["missing_goal_segment"] });
      continue;
    }
    usedSegments.add(selected.index);
    const failures = segmentFailureReasons(selected.segment, "valid_goals_only");
    matches.push({
      expected,
      segmentIndex: selected.index + 1,
      covered: failures.length === 0,
      reasons: failures,
    });
  }
  return matches;
}

function assertVideoOutputCoverage({
  editPlan,
  matchEventTruth,
  goalSelectionMode = "balanced",
} = {}) {
  if (!editPlan || typeof editPlan !== "object" || hasUnsafeValue(editPlan)) {
    throw new AppError("VIDEO_OUTPUT_QA_FAILED", SAFE_MESSAGES.VIDEO_OUTPUT_QA_FAILED, 422);
  }
  const mode = sanitizeText(goalSelectionMode || "balanced", 40);
  const segments = segmentList(editPlan);
  const expectedGoals = expectedGoalsFromTruth(matchEventTruth);
  const publicSegments = segments.map(publicSegment);
  const invalidSegments = segments
    .map((segment, index) => ({
      index: index + 1,
      id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
      reasons: segmentFailureReasons(segment, mode),
    }))
    .filter((item) => item.reasons.length)
    .slice(0, MAX_PUBLIC_ITEMS);
  const confirmedGoalSegments = segments.filter(isConfirmedGoalSegment);
  const matches = matchExpectedGoals(expectedGoals, segments);
  const coveredGoalCount = matches.filter((match) => match.covered).length;
  const extraGoalSegmentCount = expectedGoals.length > 0
    ? Math.max(0, confirmedGoalSegments.length - expectedGoals.length)
    : confirmedGoalSegments.length;
  const failedReasons = safeCodes([
    ...(mode === "valid_goals_only" && expectedGoals.length === 0 ? ["no_counted_goal_truth"] : []),
    ...(mode === "valid_goals_only" && segments.some((segment) => !isConfirmedGoalSegment(segment)) ? ["non_goal_segments_present"] : []),
    ...(matches.some((match) => !match.covered) ? ["missing_or_invalid_counted_goal_segment"] : []),
    ...(extraGoalSegmentCount > 0 ? ["unexpected_extra_goal_segment"] : []),
    ...(invalidSegments.length ? ["invalid_segment_coverage"] : []),
  ], 10);
  const passed = mode !== "valid_goals_only"
    ? invalidSegments.length === 0
    : expectedGoals.length > 0 &&
      coveredGoalCount === expectedGoals.length &&
      confirmedGoalSegments.length === expectedGoals.length &&
      invalidSegments.length === 0 &&
      segments.every(isConfirmedGoalSegment);

  const report = {
    schemaVersion: OUTPUT_GATE_SCHEMA_VERSION,
    status: passed ? "passed" : "failed",
    passed,
    goalSelectionMode: mode,
    expectedGoalCount: expectedGoals.length,
    actualSegmentCount: segments.length,
    actualConfirmedGoalSegmentCount: confirmedGoalSegments.length,
    coveredGoalCount,
    missingGoalNumbers: matches
      .filter((match) => !match.covered)
      .map((match) => match.expected.goalNumber)
      .slice(0, MAX_PUBLIC_ITEMS),
    extraGoalSegmentCount,
    expectedGoals: expectedGoals.map(publicExpectedGoal).slice(0, MAX_PUBLIC_ITEMS),
    matches: matches.map((match) => ({
      goalNumber: match.expected.goalNumber,
      segmentIndex: match.segmentIndex,
      covered: match.covered,
      reasons: safeCodes(match.reasons, 8),
    })).slice(0, MAX_PUBLIC_ITEMS),
    invalidSegments,
    segments: publicSegments.slice(0, MAX_PUBLIC_ITEMS),
    failedReasons,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };

  if (!passed) {
    throw new AppError("VIDEO_OUTPUT_QA_FAILED", SAFE_MESSAGES.VIDEO_OUTPUT_QA_FAILED, 422, report);
  }
  return report;
}

module.exports = {
  assertVideoOutputCoverage,
  expectedGoalsFromTruth,
};
