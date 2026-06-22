const { sanitizeText } = require("./media.cjs");
const { visualReasonCodesForWindow } = require("./vision.cjs");

const BACKWARD_SEARCH_SECONDS = 45;
const FORWARD_SEARCH_SECONDS = 15;
const MIN_PRE_SHOT_SECONDS = 8;
const MAX_PRE_SHOT_SECONDS = 15;

const FAILURE_CODES = Object.freeze({
  NO_FINISH_VISIBLE: "NO_FINISH_VISIBLE",
  NO_SHOT_VISIBLE: "NO_SHOT_VISIBLE",
  SCOREBOARD_ONLY: "SCOREBOARD_ONLY",
  REPLAY_ONLY: "REPLAY_ONLY",
  CELEBRATION_ONLY: "CELEBRATION_ONLY",
  DISQUALIFIED_NO_GOAL: "DISQUALIFIED_NO_GOAL",
  NOT_RECOVERABLE_CANDIDATE: "NOT_RECOVERABLE_CANDIDATE",
});

const SHOT_CODES = Object.freeze([
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_shot_like_motion",
]);

const STRONG_SHOT_CODES = Object.freeze([
  "visual_shot_contact",
  "visual_ball_toward_goal",
]);

const LIVE_ACTION_CODES = Object.freeze([
  ...SHOT_CODES,
  "visual_ball_visible",
  "visual_fast_break",
  "visual_goal_area",
  "visual_goal_mouth",
  "visual_ball_in_net",
  "visual_keeper_action",
]);

const PAYOFF_CODES = Object.freeze([
  "visual_ball_in_net",
]);

const GOALMOUTH_CODES = Object.freeze([
  "visual_goal_area",
  "visual_goal_mouth",
  "visual_ball_in_net",
]);

const INFERRED_FINISH_SUPPORT_CODES = Object.freeze([
  "visual_goal_area",
  "visual_goal_mouth",
]);

const DECISION_CODES = Object.freeze([
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
]);

const CANDIDATE_CONFIRMATION_CODES = Object.freeze([
  ...DECISION_CODES,
  "confirmed_by_commentary",
  "commentator_goal_call_support",
  "combined_goal_confirmation",
  "crowd_reaction_support",
  "visual_crowd_reaction",
  "replay_goal_confirmation",
  "visual_replay_indicator",
  "visual_replay_angle",
  "audio_energy_spike",
  "crowd_spike",
  "kickoff_after_goal",
]);

const DISQUALIFYING_CODES = Object.freeze([
  "visual_offside_flag",
  "visual_offside_line",
  "visual_no_goal_decision",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "scoreboard_ocr_goal_removed",
  "scoreboard_ocr_score_unchanged",
  "offside_commentary",
  "flag_commentary",
  "disallowed_commentary",
  "no_goal_commentary",
]);

const SCOREBOARD_CODES = Object.freeze([
  "visual_scoreboard_context",
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
]);

const REPLAY_CODES = Object.freeze([
  "visual_replay_indicator",
  "visual_replay_angle",
]);

const CELEBRATION_CODES = Object.freeze([
  "visual_celebration_after_shot",
  "visual_celebration_after_whistle",
  "visual_crowd_reaction",
]);

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function uniqueCodes(codes = [], max = 32) {
  return [...new Set((Array.isArray(codes) ? codes : [])
    .map((code) => sanitizeText(code, 80))
    .filter(Boolean))]
    .slice(0, max);
}

function hasAny(codes = [], expected = []) {
  const set = new Set(codes);
  return expected.some((code) => set.has(code));
}

function windowStart(window = {}) {
  return seconds(window.start);
}

function windowEnd(window = {}, fallback = 0) {
  return seconds(window.end, fallback);
}

function sortedWindows(windows = []) {
  return [...windows].sort((a, b) => windowStart(a) - windowStart(b) || windowEnd(a) - windowEnd(b));
}

function windowCodes(window = {}) {
  return uniqueCodes(visualReasonCodesForWindow(window), 16);
}

function windowsInRange(visualSignals, start = 0, end = 0, padding = 0) {
  const windows = Array.isArray(visualSignals && visualSignals.windows) ? visualSignals.windows : [];
  const left = Math.max(0, seconds(start) - padding);
  const right = Math.max(left, seconds(end) + padding);
  return sortedWindows(windows.filter((window) => windowEnd(window) >= left && windowStart(window) <= right));
}

function publicWindow(window = {}) {
  const start = round(windowStart(window));
  const end = round(Math.max(start + 0.1, windowEnd(window, start + 0.1)));
  return {
    start,
    end,
    codes: windowCodes(window),
    confidence: round(clamp(window.confidence, 0, 1)),
  };
}

function publicWindows(windows = [], max = 12) {
  return sortedWindows(windows).map(publicWindow).slice(0, max);
}

function isReplayWindow(window = {}) {
  return hasAny(windowCodes(window), REPLAY_CODES);
}

function isCelebrationWindow(window = {}) {
  return hasAny(windowCodes(window), CELEBRATION_CODES);
}

function isScoreboardOnlyWindow(window = {}) {
  const codes = windowCodes(window);
  return hasAny(codes, SCOREBOARD_CODES) &&
    !hasAny(codes, LIVE_ACTION_CODES) &&
    !hasAny(codes, PAYOFF_CODES) &&
    !isReplayWindow(window) &&
    !isCelebrationWindow(window);
}

function isLiveWindow(window = {}) {
  const codes = windowCodes(window);
  return hasAny(codes, LIVE_ACTION_CODES) && !isReplayWindow(window) && !isCelebrationWindow(window);
}

function isShotWindow(window = {}) {
  const codes = windowCodes(window);
  return hasAny(codes, SHOT_CODES) && !isReplayWindow(window) && !isCelebrationWindow(window);
}

function isPayoffWindow(window = {}) {
  const codes = windowCodes(window);
  return hasAny(codes, PAYOFF_CODES) && !isReplayWindow(window) && !isCelebrationWindow(window);
}

function isInferredFinishWindow(window = {}) {
  const codes = windowCodes(window);
  return hasAny(codes, INFERRED_FINISH_SUPPORT_CODES) && !isReplayWindow(window);
}

function isDecisionWindow(window = {}) {
  return hasAny(windowCodes(window), DECISION_CODES);
}

function midpoint(a, b) {
  return round((seconds(a) + seconds(b)) / 2);
}

function sampledTimestampRefs({ sourceStart, shotStart, finishTime, confirmationTime, sourceEnd } = {}) {
  const refs = [
    ["search_start", sourceStart],
    ["buildup_midpoint", midpoint(sourceStart, shotStart)],
    ["shot_start", shotStart],
    ["finish_minus_1s", Math.max(0, seconds(finishTime) - 1)],
    ["finish", finishTime],
    ["confirmation", confirmationTime],
    ["search_end", sourceEnd],
  ];
  const seen = new Set();
  return refs
    .map(([label, time]) => ({ label, time: round(time) }))
    .filter((item) => Number.isFinite(item.time))
    .filter((item) => {
      const key = `${item.label}:${item.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function findDecisionAfter(windows = [], finishTime = 0, fallback = null) {
  const decision = sortedWindows(windows)
    .filter((window) => windowStart(window) >= finishTime - 0.25)
    .filter(isDecisionWindow)[0];
  return decision ? windowStart(decision) : fallback;
}

function findShotBefore(windows = [], finishWindow = {}) {
  const finishStart = windowStart(finishWindow);
  return sortedWindows(windows)
    .filter((window) => windowEnd(window) <= finishStart + 0.25)
    .filter((window) => finishStart - windowEnd(window) <= 24)
    .filter(isShotWindow)
    .sort((a, b) => windowStart(b) - windowStart(a))[0] || null;
}

function liveOriginForShot(windows = [], shotWindow = {}, finishWindow = {}) {
  const shotStart = windowStart(shotWindow);
  const finishEnd = windowEnd(finishWindow, shotStart + 1);
  const earliest = Math.max(0, shotStart - MAX_PRE_SHOT_SECONDS);
  const nearbyLive = sortedWindows(windows)
    .filter(isLiveWindow)
    .filter((window) => windowEnd(window) >= earliest && windowStart(window) <= finishEnd)
    .filter((window) => windowStart(window) <= shotStart + 0.25);
  return nearbyLive[0] || shotWindow;
}

function candidateFromFinish({ windows, finishWindow, duration, confirmationAnchorTime, allowInferredPayoff = false }) {
  const shotWindow = findShotBefore(windows, finishWindow);
  if (!shotWindow) return null;
  const originWindow = liveOriginForShot(windows, shotWindow, finishWindow);
  const shotStart = round(windowStart(shotWindow));
  const finishTime = round(windowEnd(finishWindow, shotStart + 1));
  const decisionTime = findDecisionAfter(windows, finishTime, confirmationAnchorTime);
  const confirmationTime = round(Math.max(finishTime, seconds(decisionTime, confirmationAnchorTime)));
  const sourceStart = round(Math.max(
    0,
    Math.min(windowStart(originWindow), Math.max(0, shotStart - MIN_PRE_SHOT_SECONDS)),
  ));
  const sourceEnd = round(Math.min(
    duration || confirmationTime + 3,
    Math.max(confirmationTime + 2, finishTime + 3, sourceStart + 8),
  ));
  const selectedWindows = sortedWindows(windows)
    .filter((window) => windowEnd(window) >= sourceStart - 0.25 && windowStart(window) <= sourceEnd + 0.25);
  const codes = uniqueCodes([
    ...selectedWindows.flatMap(windowCodes),
    "shot_sequence_support",
    "live_shot_finish_sequence",
  ], 32);
  const hasStrongShot = hasAny(codes, STRONG_SHOT_CODES);
  const hasGoalMouth = hasAny(codes, GOALMOUTH_CODES);
  const hasPayoff = hasAny(codes, PAYOFF_CODES);
  const hasCandidateConfirmation = hasAny(codes, CANDIDATE_CONFIRMATION_CODES);
  const hasInferredPayoff = allowInferredPayoff && hasGoalMouth && hasCandidateConfirmation;
  if (!hasStrongShot || !hasGoalMouth || (!hasPayoff && !hasInferredPayoff)) return null;
  return {
    primarySource: "live_action",
    sourceStart,
    sourceEnd,
    buildupStart: sourceStart,
    shotStart,
    finishTime,
    confirmationTime,
    replayOnly: false,
    replayUsed: windows.some(isReplayWindow),
    score: round(0.72 + Math.min(0.24, selectedWindows.length * 0.025)),
    visualCodes: codes,
    phaseCoverage: {
      hasBuildup: sourceStart <= shotStart - 2,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      liveActionStart: sourceStart,
      shotStart,
      finishTime,
      confirmationTime,
      replayUsed: windows.some(isReplayWindow),
      replayOnly: false,
      visualGoalPayoff: {
        hasVisibleGoalPayoff: true,
        hasBallInNetEvidence: hasPayoff,
        hasLiveFinishSequence: true,
        scoreboardOnly: false,
        evidenceCodes: uniqueCodes([
          ...(hasPayoff ? ["visual_ball_in_net"] : ["visual_goal_mouth"]),
          "live_shot_finish_sequence",
        ], 8),
      },
    },
    sampledTimestamps: sampledTimestampRefs({ sourceStart, shotStart, finishTime, confirmationTime, sourceEnd }),
    supportingWindows: publicWindows(selectedWindows),
  };
}

function eventCodes(event = {}) {
  return uniqueCodes([
    ...(Array.isArray(event.evidenceCodes) ? event.evidenceCodes : []),
    ...(Array.isArray(event.reasonCodes) ? event.reasonCodes : []),
  ], 32);
}

function candidateRecoveryEligible(event = {}) {
  if (!event || typeof event !== "object") return false;
  const codes = eventCodes(event);
  if (hasAny(codes, DISQUALIFYING_CODES)) return false;
  if (String(event.recoveryEligibility || "").startsWith("recoverable_")) return true;
  return hasAny(codes, ["visual_shot_contact", "visual_ball_toward_goal"]) &&
    hasAny(codes, ["visual_goal_mouth", "visual_goal_area", "visual_ball_in_net"]) &&
    hasAny(codes, CANDIDATE_CONFIRMATION_CODES);
}

function scoreCandidate(candidate = {}) {
  if (!candidate || candidate.primarySource !== "live_action") return 0;
  const duration = Math.max(0, seconds(candidate.sourceEnd) - seconds(candidate.sourceStart));
  const hasGoodLead = seconds(candidate.shotStart) - seconds(candidate.sourceStart) >= 2;
  const hasTail = seconds(candidate.sourceEnd) >= seconds(candidate.confirmationTime) + 1;
  return round(candidate.score + (hasGoodLead ? 0.04 : 0) + (hasTail ? 0.03 : 0) - (duration > 34 ? 0.04 : 0));
}

function buildFailureCode({ shotWindows, replayWindows, celebrationWindows, scoreboardOnlyWindows } = {}) {
  if (shotWindows && shotWindows.length) return FAILURE_CODES.NO_FINISH_VISIBLE;
  if (replayWindows && replayWindows.length) return FAILURE_CODES.REPLAY_ONLY;
  if (celebrationWindows && celebrationWindows.length) return FAILURE_CODES.CELEBRATION_ONLY;
  if (scoreboardOnlyWindows && scoreboardOnlyWindows.length) return FAILURE_CODES.SCOREBOARD_ONLY;
  return FAILURE_CODES.NO_SHOT_VISIBLE;
}

function analyzeVisibleGoalPhaseRecovery({
  change = {},
  visualSignals = {},
  metadata = {},
  index = 0,
} = {}) {
  const stableChangeTime = seconds(change.changeTime);
  const actionAnchorTime = seconds(change.actionAnchorTime, stableChangeTime);
  const confirmationAnchorTime = Math.min(stableChangeTime, actionAnchorTime);
  const duration = seconds(metadata.durationSeconds, stableChangeTime + FORWARD_SEARCH_SECONDS);
  const searchStart = Math.max(0, confirmationAnchorTime - BACKWARD_SEARCH_SECONDS);
  const searchEnd = Math.min(duration || stableChangeTime + FORWARD_SEARCH_SECONDS, stableChangeTime + FORWARD_SEARCH_SECONDS);
  const contextWindows = windowsInRange(visualSignals, searchStart, searchEnd, 1.5);
  const replayWindows = contextWindows.filter(isReplayWindow);
  const celebrationWindows = contextWindows.filter(isCelebrationWindow);
  const scoreboardOnlyWindows = contextWindows.filter(isScoreboardOnlyWindow);
  const liveWindows = contextWindows.filter(isLiveWindow);
  const shotWindows = contextWindows.filter(isShotWindow);
  const payoffWindows = contextWindows.filter(isPayoffWindow);
  const candidates = payoffWindows
    .map((finishWindow) => candidateFromFinish({
      windows: contextWindows,
      finishWindow,
      duration,
      confirmationAnchorTime,
    }))
    .filter(Boolean)
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.sourceStart - b.sourceStart);
  const selected = candidates[0] || null;
  const failureCode = selected ? null : buildFailureCode({
    shotWindows,
    replayWindows,
    celebrationWindows,
    scoreboardOnlyWindows,
  });
  return {
    schemaVersion: 1,
    anchor: {
      index: index + 1,
      changeTime: round(stableChangeTime),
      actionAnchorTime: round(actionAnchorTime),
      confirmationAnchorTime: round(confirmationAnchorTime),
      scoreBefore: sanitizeText(change.startScore || "", 16) || null,
      scoreAfter: sanitizeText(change.endScore || "", 16) || null,
    },
    searchWindow: { start: round(searchStart), end: round(searchEnd) },
    selected,
    selectedLiveActionWindows: selected ? [selected].map((candidate) => ({
      sourceStart: candidate.sourceStart,
      sourceEnd: candidate.sourceEnd,
      shotStart: candidate.shotStart,
      finishTime: candidate.finishTime,
      confirmationTime: candidate.confirmationTime,
      primarySource: candidate.primarySource,
      sampledTimestamps: candidate.sampledTimestamps,
    })) : [],
    rejectedReplayWindows: publicWindows(replayWindows),
    rejectedCelebrationWindows: publicWindows(celebrationWindows),
    rejectedScoreboardOnlyWindows: publicWindows(scoreboardOnlyWindows),
    candidateCounts: {
      liveAction: liveWindows.length,
      shot: shotWindows.length,
      payoff: payoffWindows.length,
      replay: replayWindows.length,
      celebration: celebrationWindows.length,
      scoreboardOnly: scoreboardOnlyWindows.length,
    },
    failureCode,
    sampledTimestamps: selected
      ? selected.sampledTimestamps
      : sampledTimestampRefs({
          sourceStart: searchStart,
          shotStart: shotWindows[0] ? windowStart(shotWindows[0]) : confirmationAnchorTime,
          finishTime: payoffWindows[0] ? windowEnd(payoffWindows[0]) : confirmationAnchorTime,
          confirmationTime: confirmationAnchorTime,
          sourceEnd: searchEnd,
        }),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function analyzeVisibleGoalCandidateRecovery({
  event = {},
  visualSignals = {},
  metadata = {},
  index = 0,
} = {}) {
  const codes = eventCodes(event);
  const disqualified = hasAny(codes, DISQUALIFYING_CODES);
  const eventStart = seconds(event.sourceStart ?? event.start);
  const eventEnd = Math.max(eventStart + 0.5, seconds(event.sourceEnd ?? event.end, eventStart + 1));
  const duration = seconds(metadata.durationSeconds, eventEnd + FORWARD_SEARCH_SECONDS);
  const searchStart = Math.max(0, eventStart - Math.max(MIN_PRE_SHOT_SECONDS, 8));
  const searchEnd = Math.min(duration || eventEnd + FORWARD_SEARCH_SECONDS, eventEnd + FORWARD_SEARCH_SECONDS);
  const contextWindows = windowsInRange(visualSignals, searchStart, searchEnd, 1.5);
  const replayWindows = contextWindows.filter(isReplayWindow);
  const celebrationWindows = contextWindows.filter(isCelebrationWindow);
  const scoreboardOnlyWindows = contextWindows.filter(isScoreboardOnlyWindow);
  const liveWindows = contextWindows.filter(isLiveWindow);
  const shotWindows = contextWindows.filter(isShotWindow);
  const payoffWindows = contextWindows.filter(isPayoffWindow);
  const inferredFinishWindows = contextWindows.filter(isInferredFinishWindow);
  const finishWindows = [];
  const seenFinish = new Set();
  for (const window of [...payoffWindows, ...inferredFinishWindows]) {
    const key = `${windowStart(window)}:${windowEnd(window)}`;
    if (seenFinish.has(key)) continue;
    seenFinish.add(key);
    finishWindows.push(window);
  }
  const eligible = candidateRecoveryEligible({ ...event, evidenceCodes: codes });
  const candidates = !eligible || disqualified
    ? []
    : finishWindows
        .map((finishWindow) => candidateFromFinish({
          windows: contextWindows,
          finishWindow,
          duration,
          confirmationAnchorTime: eventEnd,
          allowInferredPayoff: true,
        }))
        .filter(Boolean)
        .sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.sourceStart - b.sourceStart);
  const selected = candidates[0] || null;
  const failureCode = selected
    ? null
    : disqualified
      ? FAILURE_CODES.DISQUALIFIED_NO_GOAL
      : !eligible
        ? FAILURE_CODES.NOT_RECOVERABLE_CANDIDATE
        : buildFailureCode({ shotWindows, replayWindows, celebrationWindows, scoreboardOnlyWindows });
  return {
    schemaVersion: 1,
    anchor: {
      index: index + 1,
      candidateId: sanitizeText(event.id || `goal_candidate_${index + 1}`, 80),
      outcomeHint: sanitizeText(event.outcomeHint || event.type || "unknown", 48),
      recoveryEligibility: sanitizeText(event.recoveryEligibility || (eligible ? "recoverable_live_goal_candidate" : "not_recoverable"), 60),
    },
    searchWindow: { start: round(searchStart), end: round(searchEnd) },
    selected,
    selectedLiveActionWindows: selected ? [selected].map((candidate) => ({
      sourceStart: candidate.sourceStart,
      sourceEnd: candidate.sourceEnd,
      shotStart: candidate.shotStart,
      finishTime: candidate.finishTime,
      confirmationTime: candidate.confirmationTime,
      primarySource: candidate.primarySource,
      sampledTimestamps: candidate.sampledTimestamps,
    })) : [],
    rejectedReplayWindows: publicWindows(replayWindows),
    rejectedCelebrationWindows: publicWindows(celebrationWindows),
    rejectedScoreboardOnlyWindows: publicWindows(scoreboardOnlyWindows),
    candidateCounts: {
      liveAction: liveWindows.length,
      shot: shotWindows.length,
      payoff: payoffWindows.length,
      inferredFinish: inferredFinishWindows.length,
      replay: replayWindows.length,
      celebration: celebrationWindows.length,
      scoreboardOnly: scoreboardOnlyWindows.length,
    },
    failureCode,
    sampledTimestamps: selected
      ? selected.sampledTimestamps
      : sampledTimestampRefs({
          sourceStart: searchStart,
          shotStart: shotWindows[0] ? windowStart(shotWindows[0]) : eventStart,
          finishTime: finishWindows[0] ? windowEnd(finishWindows[0]) : eventEnd,
          confirmationTime: eventEnd,
          sourceEnd: searchEnd,
        }),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function publicVisibleGoalPhaseRecovery(recovery = {}) {
  const selected = recovery.selected && typeof recovery.selected === "object" ? recovery.selected : null;
  return {
    schemaVersion: 1,
    anchor: recovery.anchor || null,
    searchWindow: recovery.searchWindow || null,
    selectedLiveActionWindows: Array.isArray(recovery.selectedLiveActionWindows) ? recovery.selectedLiveActionWindows : [],
    rejectedReplayWindows: Array.isArray(recovery.rejectedReplayWindows) ? recovery.rejectedReplayWindows : [],
    rejectedCelebrationWindows: Array.isArray(recovery.rejectedCelebrationWindows) ? recovery.rejectedCelebrationWindows : [],
    rejectedScoreboardOnlyWindows: Array.isArray(recovery.rejectedScoreboardOnlyWindows) ? recovery.rejectedScoreboardOnlyWindows : [],
    candidateCounts: recovery.candidateCounts || null,
    failureCode: recovery.failureCode ? sanitizeText(recovery.failureCode, 60) : null,
    selectedPrimarySource: selected
      ? sanitizeText(selected.primarySource, 40)
      : recovery.selectedPrimarySource
        ? sanitizeText(recovery.selectedPrimarySource, 40)
        : null,
    sampledTimestamps: Array.isArray(recovery.sampledTimestamps) ? recovery.sampledTimestamps : [],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

module.exports = {
  FAILURE_CODES,
  analyzeVisibleGoalPhaseRecovery,
  analyzeVisibleGoalCandidateRecovery,
  publicVisibleGoalPhaseRecovery,
};
