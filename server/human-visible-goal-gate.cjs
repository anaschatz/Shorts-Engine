const { sanitizeText } = require("./media.cjs");

const FAILURE_CODES = Object.freeze({
  GOAL_NOT_VISIBLE: "GOAL_NOT_VISIBLE",
  CELEBRATION_ONLY: "CELEBRATION_ONLY",
  SCOREBOARD_ONLY: "SCOREBOARD_ONLY",
  REPLAY_ONLY: "REPLAY_ONLY",
  NO_SHOT_VISIBLE: "NO_SHOT_VISIBLE",
  NO_FINISH_VISIBLE: "NO_FINISH_VISIBLE",
  FINISH_FRAME_NOT_PROVEN: "FINISH_FRAME_NOT_PROVEN",
  FINISH_FRAME_BLURRED: "FINISH_FRAME_BLURRED",
  FINISH_FRAME_OVERZOOMED: "FINISH_FRAME_OVERZOOMED",
  FINISH_FRAME_LABEL_ONLY: "FINISH_FRAME_LABEL_ONLY",
});

const SHOT_CODES = Object.freeze([
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_shot_like_motion",
  "shot_sequence_support",
]);

const STRONG_SHOT_CODES = Object.freeze([
  "visual_shot_contact",
  "visual_ball_toward_goal",
]);

const GOALMOUTH_CODES = Object.freeze([
  "visual_goal_mouth",
  "visual_ball_in_net",
  "ball_in_net",
  "visual_keeper_action",
]);

const PAYOFF_CODES = Object.freeze([
  "visual_ball_in_net",
  "ball_in_net",
]);

const FINISH_FRAME_CODES = Object.freeze([
  "finish_frame_visible",
  "rendered_finish_frame_visible",
  "ball_in_net_or_payoff_visible",
  "clear_goal_payoff_visible",
]);

const MIN_FINISH_FRAME_CONFIDENCE = 0.72;
const FINISH_FRAME_TOLERANCE_SECONDS = 2.5;

const CONFIRMATION_CODES = Object.freeze([
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "scoreboard_ocr_score_change",
  "scoreboard_temporal_consistency",
  "scoreboard_backed_goal_sequence",
  "confirmed_by_commentary",
  "combined_goal_confirmation",
  "kickoff_after_goal",
]);

const REPLAY_CODES = Object.freeze([
  "visual_replay_indicator",
  "visual_replay_angle",
]);

const CELEBRATION_CODES = Object.freeze([
  "visual_celebration_after_shot",
  "visual_celebration_after_whistle",
  "visual_crowd_reaction",
  "crowd_reaction_support",
  "crowd_reaction",
]);

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTime(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Number(parsed.toFixed(2));
}

function safeCodes(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean))];
}

function hasAny(codes, expected) {
  const set = new Set(codes);
  return expected.some((code) => set.has(code));
}

function valueObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finishFrameEvidenceForSegment(segment = {}, normalized = {}) {
  const phase = valueObject(segment.phaseCoverage);
  const visualPayoff = valueObject(phase.visualGoalPayoff);
  return valueObject(
    segment.finishFrameEvidence ||
    phase.finishFrameEvidence ||
    visualPayoff.finishFrameEvidence ||
    (segment.visualGoalGate && segment.visualGoalGate.finishFrameEvidence)
  );
}

function validateFinishFrameEvidence(segment = {}, normalized = {}) {
  const evidence = finishFrameEvidenceForSegment(segment, normalized);
  const hasEvidence = Object.keys(evidence).length > 0;
  const sourceStart = normalized.sourceStart;
  const sourceEnd = normalized.sourceEnd;
  const finishTime = normalized.finishTime;
  const frameTime = numberOrNull(evidence.frameTime ?? evidence.time ?? evidence.timestamp);
  const confidence = numberOrNull(evidence.confidence);
  const evidenceCodes = safeCodes(evidence.evidenceCodes || evidence.reasonCodes);
  const hasVisibleFinish = evidence.hasVisibleFinish === true || evidence.visibleFinish === true;
  const hasBallInNetOrPayoff = evidence.hasBallInNetOrPayoff === true ||
    evidence.hasBallInNet === true ||
    evidence.hasClearPayoff === true ||
    evidence.ballInNetOrPayoffVisible === true;
  const hasGoalMouth = evidence.hasGoalMouth === true || evidence.goalMouthVisible === true;
  const frameWithinSegment = frameTime !== null &&
    sourceStart !== null &&
    sourceEnd !== null &&
    frameTime >= sourceStart - 0.05 &&
    frameTime <= sourceEnd + 0.05;
  const nearFinish = frameTime !== null &&
    finishTime !== null &&
    Math.abs(frameTime - finishTime) <= FINISH_FRAME_TOLERANCE_SECONDS;
  const isBlurred = evidence.isBlurred === true || evidence.blurred === true || evidence.blurRisk === true;
  const isOverZoomed = evidence.isOverZoomed === true || evidence.overZoomed === true || evidence.overZoomRisk === true;
  const isLabelOnly = evidence.isLabelOnly === true || evidence.labelOnly === true || evidence.captionOnly === true;
  const isReplayOnly = evidence.isReplayOnly === true || evidence.replayOnly === true;
  const isCelebrationOnly = evidence.isCelebrationOnly === true || evidence.celebrationOnly === true;
  const isScoreboardOnly = evidence.isScoreboardOnly === true || evidence.scoreboardOnly === true;
  const confidenceOk = confidence === null || confidence >= MIN_FINISH_FRAME_CONFIDENCE;
  const evidenceBacked = hasAny(evidenceCodes, FINISH_FRAME_CODES);
  const reasons = [
    ...(!hasEvidence ? ["finish_frame_evidence_missing"] : []),
    ...(hasEvidence && !frameWithinSegment ? ["finish_frame_outside_segment"] : []),
    ...(hasEvidence && !nearFinish ? ["finish_frame_not_near_finish"] : []),
    ...(hasEvidence && !hasVisibleFinish ? ["finish_frame_missing_visible_finish"] : []),
    ...(hasEvidence && !hasBallInNetOrPayoff ? ["finish_frame_missing_ball_in_net_or_payoff"] : []),
    ...(hasEvidence && !hasGoalMouth ? ["finish_frame_missing_goalmouth"] : []),
    ...(hasEvidence && !evidenceBacked ? ["finish_frame_not_evidence_backed"] : []),
    ...(hasEvidence && !confidenceOk ? ["finish_frame_low_confidence"] : []),
    ...(isBlurred ? ["finish_frame_blurred"] : []),
    ...(isOverZoomed ? ["finish_frame_overzoomed"] : []),
    ...(isLabelOnly ? ["finish_frame_label_only"] : []),
    ...(isReplayOnly ? ["finish_frame_replay_only"] : []),
    ...(isCelebrationOnly ? ["finish_frame_celebration_only"] : []),
    ...(isScoreboardOnly ? ["finish_frame_scoreboard_only"] : []),
  ];
  return {
    passed: reasons.length === 0,
    frameTime: roundTime(frameTime),
    confidence,
    hasVisibleFinish,
    hasBallInNetOrPayoff,
    hasGoalMouth,
    frameWithinSegment,
    nearFinish,
    isBlurred,
    isOverZoomed,
    isLabelOnly,
    isReplayOnly,
    isCelebrationOnly,
    isScoreboardOnly,
    evidenceCodes,
    reasons: safeCodes(reasons).slice(0, 10),
  };
}

function sampleGoalFrameRefs(segment = {}) {
  const sourceStart = numberOrNull(segment.sourceStart);
  const sourceEnd = numberOrNull(segment.sourceEnd);
  const shotStart = numberOrNull(segment.shotStart);
  const finishTime = numberOrNull(segment.finishTime);
  const confirmationTime = numberOrNull(segment.confirmationTime);
  const refs = [
    ["source_start", sourceStart],
    ["buildup_midpoint", sourceStart !== null && shotStart !== null ? (sourceStart + shotStart) / 2 : null],
    ["shot_start", shotStart],
    ["finish_minus_1s", finishTime === null ? null : Math.max(0, finishTime - 1)],
    ["finish", finishTime],
    ["finish_plus_1s", finishTime === null ? null : finishTime + 1],
    ["confirmation", confirmationTime],
    ["source_end", sourceEnd],
  ];
  const seen = new Set();
  return refs
    .map(([label, time]) => ({ label, time: roundTime(time) }))
    .filter((item) => item.time !== null)
    .filter((item) => {
      const key = `${item.label}:${item.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function normalizedSegment(segment = {}) {
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object"
    ? segment.phaseCoverage
    : {};
  return {
    sourceStart: numberOrNull(segment.sourceStart),
    sourceEnd: numberOrNull(segment.sourceEnd),
    shotStart: numberOrNull(segment.shotStart ?? phase.shotStart),
    finishTime: numberOrNull(segment.finishTime ?? phase.finishTime),
    confirmationTime: numberOrNull(segment.confirmationTime ?? phase.confirmationTime),
    replayOnly: segment.replayOnly === true || phase.replayOnly === true,
    replayUsed: segment.replayUsed === true || phase.replayUsed === true,
    phase,
    reasonCodes: safeCodes([
      ...(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []),
      ...(phase.visualGoalPayoff && Array.isArray(phase.visualGoalPayoff.evidenceCodes)
        ? phase.visualGoalPayoff.evidenceCodes
        : []),
    ]),
  };
}

function failureCodeForEvidence(evidence, segment) {
  if (segment.replayOnly) return FAILURE_CODES.REPLAY_ONLY;
  if (evidence.isScoreboardOnly) return FAILURE_CODES.SCOREBOARD_ONLY;
  if (evidence.isCelebrationOnly) return FAILURE_CODES.CELEBRATION_ONLY;
  if (!evidence.hasShotFrames) return FAILURE_CODES.NO_SHOT_VISIBLE;
  if (!evidence.hasRenderedFinishFrame) {
    if (evidence.finishFrame && evidence.finishFrame.isBlurred) return FAILURE_CODES.FINISH_FRAME_BLURRED;
    if (evidence.finishFrame && evidence.finishFrame.isOverZoomed) return FAILURE_CODES.FINISH_FRAME_OVERZOOMED;
    if (evidence.finishFrame && evidence.finishFrame.isLabelOnly) return FAILURE_CODES.FINISH_FRAME_LABEL_ONLY;
    return FAILURE_CODES.FINISH_FRAME_NOT_PROVEN;
  }
  if (!evidence.hasPayoffFrames || !evidence.hasGoalmouthFrames) return FAILURE_CODES.NO_FINISH_VISIBLE;
  return FAILURE_CODES.GOAL_NOT_VISIBLE;
}

function validateHumanVisibleGoalSequence({ segment = {} } = {}) {
  const normalized = normalizedSegment(segment);
  const phase = normalized.phase;
  const sourceStart = normalized.sourceStart;
  const shotStart = normalized.shotStart;
  const finishTime = normalized.finishTime;
  const confirmationTime = normalized.confirmationTime;
  const hasTimingShape = sourceStart !== null &&
    shotStart !== null &&
    finishTime !== null &&
    shotStart >= sourceStart &&
    finishTime >= shotStart;
  const confirmationAfterFinish = confirmationTime !== null && finishTime !== null && confirmationTime >= finishTime - 0.25;
  const hasBuildupFrames = phase.hasBuildup === true &&
    hasTimingShape &&
    shotStart - sourceStart >= 2;
  const hasShotFrames = phase.hasShot === true &&
    hasAny(normalized.reasonCodes, SHOT_CODES);
  const hasStrongShotFrames = hasAny(normalized.reasonCodes, STRONG_SHOT_CODES);
  const visualPayoff = phase.visualGoalPayoff && typeof phase.visualGoalPayoff === "object"
    ? phase.visualGoalPayoff
    : {};
  const hasLiveFinishSequence = visualPayoff.hasLiveFinishSequence === true ||
    hasAny(normalized.reasonCodes, ["live_shot_finish_sequence"]);
  const hasStableScorebackedFinish = phase.hasFinish === true &&
    hasShotFrames &&
    hasLiveFinishSequence &&
    visualPayoff.scoreboardOnly !== true &&
    confirmationAfterFinish &&
    hasAny(normalized.reasonCodes, CONFIRMATION_CODES);
  const hasGoalmouthFrames = phase.hasFinish === true &&
    (hasAny(normalized.reasonCodes, GOALMOUTH_CODES) || hasStableScorebackedFinish);
  const hasPayoffFrames = phase.hasFinish === true &&
    (
      hasAny(normalized.reasonCodes, PAYOFF_CODES) ||
      hasStableScorebackedFinish ||
      (hasGoalmouthFrames && hasStrongShotFrames && confirmationAfterFinish)
    );
  const hasConfirmationAfterFinish = phase.hasConfirmation === true &&
    confirmationAfterFinish &&
    hasAny(normalized.reasonCodes, CONFIRMATION_CODES);
  const hasReplayOnlySignals = normalized.replayOnly ||
    (hasAny(normalized.reasonCodes, REPLAY_CODES) && !hasShotFrames && !hasPayoffFrames);
  const hasCelebrationSignals = hasAny(normalized.reasonCodes, CELEBRATION_CODES);
  const isCelebrationOnly = hasCelebrationSignals && !hasShotFrames && !hasPayoffFrames;
  const hasScoreboardSignals = hasAny(normalized.reasonCodes, CONFIRMATION_CODES);
  const isScoreboardOnly = hasScoreboardSignals && !hasShotFrames && !hasPayoffFrames;
  const finishFrame = validateFinishFrameEvidence(segment, normalized);
  const evidence = {
    hasBuildupFrames,
    hasShotFrames,
    hasGoalmouthFrames,
    hasPayoffFrames,
    hasStableScorebackedFinish,
    hasConfirmationAfterFinish,
    hasRenderedFinishFrame: finishFrame.passed,
    finishFrame,
    isScoreboardOnly,
    isCelebrationOnly,
    hasReplayOnlySignals,
  };
  const passed = !hasReplayOnlySignals &&
    hasBuildupFrames &&
    hasShotFrames &&
    hasGoalmouthFrames &&
    hasPayoffFrames &&
    finishFrame.passed &&
    hasConfirmationAfterFinish;
  const confidenceParts = [
    hasBuildupFrames,
    hasShotFrames,
    hasGoalmouthFrames,
    hasPayoffFrames,
    hasConfirmationAfterFinish,
  ].filter(Boolean).length;
  return {
    passed,
    confidence: Number((confidenceParts / 5).toFixed(2)),
    failureCode: passed ? null : failureCodeForEvidence(evidence, normalized),
    evidence,
    sampledFrames: sampleGoalFrameRefs(segment),
    debugFrames: sampleGoalFrameRefs(segment),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function publicHumanVisibleGoalGate(value = {}) {
  const gate = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : validateHumanVisibleGoalSequence({ segment: value });
  return {
    passed: Boolean(gate.passed),
    confidence: numberOrNull(gate.confidence),
    failureCode: gate.failureCode ? sanitizeText(gate.failureCode, 60) : null,
    evidence: gate.evidence && typeof gate.evidence === "object"
      ? {
          hasBuildupFrames: Boolean(gate.evidence.hasBuildupFrames),
          hasShotFrames: Boolean(gate.evidence.hasShotFrames),
          hasGoalmouthFrames: Boolean(gate.evidence.hasGoalmouthFrames),
          hasPayoffFrames: Boolean(gate.evidence.hasPayoffFrames),
          hasStableScorebackedFinish: Boolean(gate.evidence.hasStableScorebackedFinish),
          hasRenderedFinishFrame: Boolean(gate.evidence.hasRenderedFinishFrame),
          hasConfirmationAfterFinish: Boolean(gate.evidence.hasConfirmationAfterFinish),
        }
      : null,
    finishFrameEvidence: gate.evidence && gate.evidence.finishFrame
      ? {
          passed: Boolean(gate.evidence.finishFrame.passed),
          frameTime: roundTime(gate.evidence.finishFrame.frameTime),
          confidence: numberOrNull(gate.evidence.finishFrame.confidence),
          hasVisibleFinish: Boolean(gate.evidence.finishFrame.hasVisibleFinish),
          hasBallInNetOrPayoff: Boolean(gate.evidence.finishFrame.hasBallInNetOrPayoff),
          hasGoalMouth: Boolean(gate.evidence.finishFrame.hasGoalMouth),
          isBlurred: Boolean(gate.evidence.finishFrame.isBlurred),
          isOverZoomed: Boolean(gate.evidence.finishFrame.isOverZoomed),
          isLabelOnly: Boolean(gate.evidence.finishFrame.isLabelOnly),
          isReplayOnly: Boolean(gate.evidence.finishFrame.isReplayOnly),
          isCelebrationOnly: Boolean(gate.evidence.finishFrame.isCelebrationOnly),
          isScoreboardOnly: Boolean(gate.evidence.finishFrame.isScoreboardOnly),
          reasons: safeCodes(gate.evidence.finishFrame.reasons).slice(0, 8),
        }
      : null,
    sampledFrames: Array.isArray(gate.sampledFrames)
      ? gate.sampledFrames.map((item) => ({
          label: sanitizeText(item.label, 40),
          time: roundTime(item.time),
        })).filter((item) => item.label && item.time !== null).slice(0, 8)
      : [],
  };
}

module.exports = {
  FAILURE_CODES,
  validateFinishFrameEvidence,
  publicHumanVisibleGoalGate,
  sampleGoalFrameRefs,
  validateHumanVisibleGoalSequence,
};
