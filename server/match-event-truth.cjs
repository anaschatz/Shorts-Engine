const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence, normalizeOcrQaCalibrationInput } = require("./goal-evidence-provider.cjs");
const { validateVisualSignals, visualReasonCodesForWindow } = require("./vision.cjs");
const {
  analyzeVisibleGoalPhaseRecovery,
  analyzeVisibleGoalCandidateRecovery,
  publicVisibleGoalPhaseRecovery,
} = require("./visible-goal-phase-recovery.cjs");

const MATCH_EVENT_TRUTH_VERSION = 1;
const MAX_EVENTS = 32;
const MAX_CODES = 32;
const MAX_MISSING = 8;
const MAX_FLAGS = 8;
const MAX_CLUSTER_RECOVERY_GOALS = 3;

const MATCH_EVENT_TYPES = Object.freeze([
  "confirmed_goal",
  "disallowed_offside",
  "disallowed_no_goal",
  "possible_goal_unconfirmed",
  "big_chance",
  "save",
  "foul",
  "replay",
  "crowd_reaction",
  "neutral",
]);

const MATCH_EVENT_OUTCOMES = Object.freeze([
  "confirmed_goal",
  "disallowed_offside",
  "disallowed_no_goal",
  "possible_goal_unconfirmed",
  "no_goal",
  "unknown",
]);

const CONFIRMED_SUPPORT_CODES = Object.freeze([
  "scoreboard_backed_goal_sequence",
  "scoreboard_ocr_score_change",
  "scoreboard_temporal_consistency",
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "confirmed_by_commentary",
  "combined_goal_confirmation",
  "kickoff_after_goal",
  "replay_goal_confirmation",
  "goal_candidate_cluster_recovery",
]);

const OFFSIDE_CODES = Object.freeze([
  "visual_offside_flag",
  "visual_offside_line",
  "offside_commentary",
  "flag_commentary",
]);

const DISALLOWED_CODES = Object.freeze([
  "visual_no_goal_decision",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "scoreboard_ocr_goal_removed",
  "scoreboard_ocr_score_unchanged",
  "disallowed_commentary",
  "no_goal_commentary",
]);

const ACTION_CODES = Object.freeze([
  "scoreboard_backed_goal_sequence",
  "ball_in_net",
  "visual_ball_in_net",
  "visual_shot_contact",
  "visual_shot_like_motion",
  "visual_ball_toward_goal",
  "visual_goal_mouth",
  "visual_goal_area",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_foul_like_contact",
  "visual_fast_break",
  "shot_sequence_support",
  "live_shot_finish_sequence",
]);

const PAYOFF_CODES = Object.freeze([
  "ball_in_net",
  "visual_ball_in_net",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_celebration_after_shot",
]);

const DECISION_CODES = Object.freeze([
  ...CONFIRMED_SUPPORT_CODES,
  ...OFFSIDE_CODES,
  ...DISALLOWED_CODES,
  "visual_var_check",
  "visual_var_decision",
  "var_check",
  "scoreboard_ocr_ambiguous",
]);

const SHOT_CODES = Object.freeze([
  "visual_shot_contact",
  "visual_shot_like_motion",
  "visual_ball_toward_goal",
  "shot_sequence_support",
]);
const GOAL_FINISH_CODES = Object.freeze([
  "ball_in_net",
  "visual_ball_in_net",
]);
const LIVE_GOAL_PHASE_CODES = Object.freeze([
  ...SHOT_CODES,
  "visual_ball_visible",
  "visual_fast_break",
  "visual_goal_area",
  "visual_goal_mouth",
]);
const CLUSTER_GOALMOUTH_CODES = Object.freeze([
  "visual_goal_mouth",
  "visual_goal_area",
]);
const CLUSTER_CONFIRMATION_CODES = Object.freeze([
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "confirmed_by_commentary",
  "combined_goal_confirmation",
  "replay_goal_confirmation",
  "kickoff_after_goal",
  "visual_replay_indicator",
  "visual_replay_angle",
]);
const CLUSTER_NON_GOAL_CODES = Object.freeze([
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_offside_flag",
  "visual_offside_line",
  "visual_no_goal_decision",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "scoreboard_ocr_goal_removed",
  "scoreboard_ocr_score_unchanged",
]);
const REPLAY_SUPPORT_CODES = Object.freeze([
  "visual_replay_indicator",
  "visual_replay_angle",
  "replay_goal_confirmation",
]);
const CELEBRATION_SUPPORT_CODES = Object.freeze([
  "visual_celebration_after_shot",
  "visual_celebration_after_whistle",
  "visual_crowd_reaction",
  "crowd_reaction_support",
]);
const GOAL_PHASE_LOOKBACK_SECONDS = 45;
const SCORE_CHANGE_BINDING_LOOKBACK_SECONDS = 35;
const SCORE_CHANGE_BINDING_FORWARD_SECONDS = 8;
const GOAL_PHASE_MIN_PRE_SHOT_SECONDS = 10;
const GOAL_PHASE_MAX_PRE_SHOT_SECONDS = 15;
const SCORE_CHANGE_MIN_CONFIDENCE = 0.72;
const SCORE_CHANGE_STRONG_CONFIDENCE = 0.86;
const SCORE_CHANGE_REVERT_LOOKAHEAD_SECONDS = 28;
const SCORE_CHANGE_CONFIRMATION_SECONDS = 8;
const SCORE_CHANGE_DEDUP_TIME_TOLERANCE_SECONDS = 1.25;
const SCORE_CHANGE_PENDING_LOOKBACK_SECONDS = 70;
const SCORE_CHANGE_POST_SECONDS = 20;
const SCORE_CHANGE_BACKTRACK_FALLBACK_SECONDS = 24;
const SCORE_CHANGE_BACKTRACK_FALLBACK_TAIL_SECONDS = 7;
const SCORE_CHANGE_BACKTRACK_FALLBACK_SHOT_LEAD_SECONDS = 10;
const SCORE_CHANGE_BACKTRACK_FALLBACK_FINISH_LEAD_SECONDS = 3;

const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;
const SAFE_SCORE_RE = /^\d{1,2}\s*[-:]\s*\d{1,2}$/;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function uniqueCodes(codes = [], max = MAX_CODES) {
  return [...new Set((Array.isArray(codes) ? codes : [])
    .map((code) => sanitizeText(code, 80))
    .filter(Boolean)
    .filter((code) => !SENSITIVE_RE.test(code)))]
    .slice(0, max);
}

function hasAny(codes = [], expected = []) {
  const set = new Set(codes);
  return expected.some((code) => set.has(code));
}

function normalizeFinishFrameEvidence(value = null, context = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!raw || hasUnsafeValue(raw)) return null;
  const sourceStart = seconds(context.sourceStart);
  const sourceEnd = Math.max(sourceStart + 0.5, seconds(context.sourceEnd, sourceStart + 1));
  const fallbackFrameTime = normalizePhaseTimestamp(context.finishTime, sourceStart, sourceEnd, sourceEnd);
  const frameTime = normalizePhaseTimestamp(raw.frameTime ?? raw.time ?? raw.timestamp, sourceStart, sourceEnd, fallbackFrameTime);
  const confidence = Number.isFinite(Number(raw.confidence))
    ? round(Math.min(1, Math.max(0, Number(raw.confidence))))
    : null;
  const visibilityVerdict = sanitizeText(
    raw.visibilityVerdict ||
      raw.verdict ||
      raw.humanVisibilityVerdict ||
      raw.humanVisibleVerdict ||
      "",
    32,
  ).toLowerCase();
  const continuousActionFrameCount = Number.isFinite(Number(
    raw.continuousActionFrameCount ??
      raw.actionFrameCount ??
      raw.clearActionFrameCount,
  ))
    ? Math.max(0, Math.round(Number(
        raw.continuousActionFrameCount ??
          raw.actionFrameCount ??
          raw.clearActionFrameCount,
      )))
    : null;
  const supportFrames = Array.isArray(raw.supportFrames)
    ? raw.supportFrames.slice(0, 8).map((frame) => {
        const item = frame && typeof frame === "object" && !Array.isArray(frame) ? frame : {};
        return {
          role: sanitizeText(item.role || item.label || item.type || "", 40),
          status: sanitizeText(item.status || item.verdict || "", 40).toLowerCase(),
          time: normalizePhaseTimestamp(item.time ?? item.frameTime ?? item.timestamp, sourceStart, sourceEnd, null),
          clear: item.clear === true || item.visible === true,
        };
      }).filter((frame) => frame.role || frame.status || frame.time !== null)
    : [];
  return {
    frameTime,
    confidence,
    visibilityVerdict: ["clear", "borderline", "failed"].includes(visibilityVerdict) ? visibilityVerdict : undefined,
    hasVisibleFinish: raw.hasVisibleFinish === true || raw.visibleFinish === true,
    hasBallInNetOrPayoff: raw.hasBallInNetOrPayoff === true ||
      raw.hasBallInNet === true ||
      raw.hasClearPayoff === true ||
      raw.ballInNetOrPayoffVisible === true,
    hasGoalMouth: raw.hasGoalMouth === true || raw.goalMouthVisible === true,
    hasPreShotActionFrame: raw.hasPreShotActionFrame === true || raw.preShotActionFrameVisible === true,
    hasFinishActionFrame: raw.hasFinishActionFrame === true || raw.finishActionFrameVisible === true,
    hasPayoffFrame: raw.hasPayoffFrame === true || raw.payoffFrameVisible === true,
    hasConfirmationFrame: raw.hasConfirmationFrame === true || raw.confirmationFrameVisible === true,
    continuousActionFrameCount,
    supportFrames,
    isBlurred: raw.isBlurred === true || raw.blurred === true || raw.blurRisk === true,
    isOverZoomed: raw.isOverZoomed === true || raw.overZoomed === true || raw.overZoomRisk === true,
    isLabelOnly: raw.isLabelOnly === true || raw.labelOnly === true || raw.captionOnly === true,
    isReplayOnly: raw.isReplayOnly === true || raw.replayOnly === true,
    isCelebrationOnly: raw.isCelebrationOnly === true || raw.celebrationOnly === true,
    isScoreboardOnly: raw.isScoreboardOnly === true || raw.scoreboardOnly === true,
    isPlayerCloseupOnly: raw.isPlayerCloseupOnly === true || raw.playerCloseupOnly === true,
    isFrameTooWideUnclear: raw.isFrameTooWideUnclear === true ||
      raw.frameTooWideUnclear === true ||
      raw.tooWideUnclear === true,
    evidenceCodes: uniqueCodes(raw.evidenceCodes || raw.reasonCodes, 12),
  };
}

function windowStart(window = {}) {
  return seconds(window.start);
}

function windowEnd(window = {}, fallback = 0) {
  return seconds(window.end, fallback);
}

function windowsInRange(visualSignals, start = 0, end = 0, padding = 0) {
  const windows = Array.isArray(visualSignals && visualSignals.windows) ? visualSignals.windows : [];
  const left = Math.max(0, seconds(start) - padding);
  const right = Math.max(left, seconds(end) + padding);
  return windows.filter((window) => windowEnd(window) >= left && windowStart(window) <= right);
}

function firstWindowTime(windows = [], codes = [], fallback = null) {
  const match = [...windows]
    .filter((window) => hasAny(visualReasonCodesForWindow(window), codes))
    .sort((a, b) => windowStart(a) - windowStart(b))[0];
  return match ? round(windowStart(match)) : fallback;
}

function lastWindowTime(windows = [], codes = [], fallback = null) {
  const match = [...windows]
    .filter((window) => hasAny(visualReasonCodesForWindow(window), codes))
    .sort((a, b) => windowEnd(b) - windowEnd(a))[0];
  return match ? round(windowEnd(match)) : fallback;
}

function finishFrameEvidenceFromWindows(windows = [], fallbackTime = null) {
  const finishWindows = [...windows].filter((window) => hasAny(visualReasonCodesForWindow(window), GOAL_FINISH_CODES));
  if (!finishWindows.length) return null;
  const best = finishWindows
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || windowEnd(b) - windowEnd(a))[0];
  const frameTime = round(windowEnd(best, fallbackTime == null ? 0 : fallbackTime));
  return {
    frameTime,
    confidence: round(clamp(best.confidence, 0.05, 0.98)),
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    hasGoalMouth: true,
    isBlurred: false,
    isOverZoomed: false,
    isLabelOnly: false,
    isReplayOnly: false,
    isCelebrationOnly: false,
    isScoreboardOnly: false,
    evidenceCodes: ["finish_frame_visible", "ball_in_net_or_payoff_visible"],
  };
}

function visualCodesForRange(visualSignals, start = 0, end = 0) {
  return uniqueCodes(windowsInRange(visualSignals, start, end, 1.5).flatMap(visualReasonCodesForWindow), 32);
}

function signalCodesForRange(mediaSignals = {}, start = 0, end = 0) {
  const left = Math.max(0, seconds(start) - 3);
  const right = Math.max(left, seconds(end) + 3);
  const peaks = Array.isArray(mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : [];
  const scenes = Array.isArray(mediaSignals.sceneChanges) ? mediaSignals.sceneChanges : [];
  const codes = [];
  const nearbyPeaks = peaks.filter((peak) => seconds(peak.time) >= left && seconds(peak.time) <= right);
  if (nearbyPeaks.some((peak) => Number(peak.energyScore || 0) >= 0.7)) codes.push("audio_energy_spike");
  if (nearbyPeaks.some((peak) => Number(peak.energyScore || 0) >= 0.88)) codes.push("crowd_spike");
  if (scenes.some((scene) => seconds(scene.time) >= left && seconds(scene.time) <= right && Number(scene.confidence || 0) >= 0.6)) {
    codes.push("scene_change_cluster");
  }
  return uniqueCodes(codes);
}

function ocrCodesInRange(ocrEvidence = [], start = 0, end = 0, calibration = null) {
  const usable = Boolean(calibration && calibration.usable);
  const items = (Array.isArray(ocrEvidence) ? ocrEvidence : [])
    .filter((item) => seconds(item.timestamp) >= start - 1 && seconds(item.timestamp) <= end + 1);
  const codes = [];
  if (usable && items.some((item) => item.scoreChanged)) codes.push("scoreboard_ocr_score_change", "scoreboard_temporal_consistency");
  if (usable && items.some((item) => item.scoreReverted)) codes.push("scoreboard_ocr_goal_removed");
  if (usable && items.some((item) => item.scoreUnchanged)) codes.push("scoreboard_ocr_score_unchanged");
  if (items.some((item) => item.ambiguous)) codes.push("scoreboard_ocr_ambiguous");
  return uniqueCodes(codes);
}

function scoreTransitionInRange(ocrEvidence = [], start = 0, end = 0, calibration = null) {
  const left = seconds(start) - 1;
  const right = seconds(end) + 1;
  const transitions = (Array.isArray(ocrEvidence) ? ocrEvidence : [])
    .filter((item) => seconds(item.timestamp) >= left && seconds(item.timestamp) <= right)
    .filter((item) => !item.ambiguous && (item.scoreChanged || item.scoreReverted))
    .filter((item) => scoreChangeAuthority(item, calibration) || item.scoreReverted)
    .map((item) => {
      const before = parseScoreValue(item.scoreBefore);
      const after = parseScoreValue(item.scoreAfter);
      const direction = scoreDirection(before, after);
      if (!before || !after || direction === "same" || direction === "unknown" || direction === "ambiguous") return null;
      return {
        scoreBefore: before.text,
        scoreAfter: after.text,
        scoreChangeTime: round(seconds(item.timestamp)),
        confidence: round(clamp(item.confidence, 0, 1)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(seconds(end) - a.scoreChangeTime) - Math.abs(seconds(end) - b.scoreChangeTime));
  return transitions[0] || null;
}

function eventBaseCodes(event = {}) {
  return uniqueCodes([
    ...(Array.isArray(event.reasonCodes) ? event.reasonCodes : []),
    event.ballInNetEvidence ? "ball_in_net" : "",
    event.scoreboardBackedGoalSequence ? "scoreboard_backed_goal_sequence" : "",
    event.scoreboardGoalConfirmed ? "scoreboard_ocr_score_change" : "",
    event.offsideFlag ? "visual_offside_flag" : "",
    event.VARNoGoalSignal ? "visual_no_goal_decision" : "",
    event.commentatorGoalCall ? "commentator_goal_call_support" : "",
    event.crowdReactionSupport ? "crowd_reaction_support" : "",
  ].filter(Boolean), 32);
}

function captionIntentForType(type) {
  const intents = {
    confirmed_goal: "confirmed_goal_caption",
    disallowed_offside: "offside_no_goal_caption",
    disallowed_no_goal: "no_goal_decision_caption",
    possible_goal_unconfirmed: "neutral_unconfirmed_goal_caption",
    big_chance: "big_chance_caption",
    save: "save_caption",
    foul: "foul_caption",
    replay: "replay_context_caption",
    crowd_reaction: "reaction_support_caption",
    neutral: "neutral_pressure_caption",
  };
  return intents[type] || intents.neutral;
}

function typePriority(type) {
  const priorities = {
    confirmed_goal: 1000,
    disallowed_offside: 740,
    disallowed_no_goal: 700,
    possible_goal_unconfirmed: 620,
    big_chance: 520,
    save: 500,
    foul: 460,
    replay: 340,
    crowd_reaction: 300,
    neutral: 120,
  };
  return priorities[type] || priorities.neutral;
}

function goalTypeForEvidence(codes = [], event = {}, ocrQaCalibration = null) {
  const ballInNet = hasAny(codes, ["ball_in_net", "visual_ball_in_net"]) || Boolean(event.ballInNetEvidence);
  const scoreboardBackedGoalSequence = hasAny(codes, ["scoreboard_backed_goal_sequence"]) &&
    hasAny(codes, ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency", "visual_scoreboard_goal_confirmed"]);
  const hasGoalEventEvidence = ballInNet || scoreboardBackedGoalSequence;
  const hasAction = hasGoalEventEvidence && hasAny(codes, ACTION_CODES);
  const hasConfirmedSupport = hasAny(codes, CONFIRMED_SUPPORT_CODES);
  const hasOffside = hasAny(codes, OFFSIDE_CODES);
  const hasDisallowed = hasAny(codes, DISALLOWED_CODES);
  const hasOcrOnlySupport = hasAny(codes, ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"]) &&
    !hasAny(codes, ["visual_scoreboard_goal_confirmed", "visual_referee_goal_signal", "confirmed_by_commentary", "kickoff_after_goal"]);

  if (hasOffside) return "disallowed_offside";
  if (hasDisallowed) return hasAny(codes, ["scoreboard_ocr_score_unchanged"]) && hasAny(codes, ["visual_ball_in_net", "ball_in_net"])
    ? "disallowed_offside"
    : "disallowed_no_goal";
  if (hasGoalEventEvidence && hasAction && hasConfirmedSupport && !(hasOcrOnlySupport && !(ocrQaCalibration && ocrQaCalibration.usable))) {
    return "confirmed_goal";
  }
  if (ballInNet) return "possible_goal_unconfirmed";
  return null;
}

function goalOutcomeForType(type) {
  if (type === "confirmed_goal") return "confirmed_goal";
  if (type === "disallowed_offside") return "disallowed_offside";
  if (type === "disallowed_no_goal") return "disallowed_no_goal";
  if (type === "possible_goal_unconfirmed") return "possible_goal_unconfirmed";
  return type === "neutral" ? "unknown" : "no_goal";
}

function truthEventTypeForMatchType(type) {
  if (type === "confirmed_goal") return "valid_goal";
  if (type === "disallowed_offside" || type === "disallowed_no_goal") return "disallowed_goal";
  if (type === "possible_goal_unconfirmed") return "goal_candidate";
  return "unknown";
}

function truthStatusForMatchType(type) {
  if (type === "confirmed_goal") return "valid_goal";
  if (type === "disallowed_offside" || type === "disallowed_no_goal") return "disallowed_goal";
  return "unknown";
}

function normalizeScoreField(value) {
  if (value == null || value === "") return null;
  const text = sanitizeText(typeof value === "object" ? value.text || value.scoreText : value, 16);
  return SAFE_SCORE_RE.test(text) ? text.replace(/\s+/g, "") : null;
}

function parseScoreValue(value) {
  const text = normalizeScoreField(value);
  if (!text) return null;
  const [home, away] = text.split("-").map((part) => Number(part));
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0 || home > 30 || away > 30) return null;
  return { home, away, text };
}

function scoreTotal(score) {
  return score ? Number(score.home || 0) + Number(score.away || 0) : 0;
}

function scoreDelta(before, after) {
  if (!before || !after) return 0;
  return Math.abs(after.home - before.home) + Math.abs(after.away - before.away);
}

function sameScore(a, b) {
  return Boolean(a && b && a.home === b.home && a.away === b.away);
}

function scoreDirection(before, after) {
  const delta = scoreDelta(before, after);
  if (!before || !after) return "unknown";
  if (delta === 0) return "same";
  if (delta !== 1) return "ambiguous";
  const totalDelta = scoreTotal(after) - scoreTotal(before);
  if (totalDelta === 1) return "increase";
  if (totalDelta === -1) return "decrease";
  return "ambiguous";
}

function scoreTeamSide(before, after) {
  if (!before || !after) return "unknown";
  if (after.home - before.home === 1 && after.away === before.away) return "home";
  if (after.away - before.away === 1 && after.home === before.home) return "away";
  if (before.home - after.home === 1 && after.away === before.away) return "home";
  if (before.away - after.away === 1 && after.home === before.home) return "away";
  return "unknown";
}

function normalizeTeams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const home = sanitizeText(value.home || value.homeTeam || "", 48);
  const away = sanitizeText(value.away || value.awayTeam || "", 48);
  return home || away ? { home: home || null, away: away || null } : null;
}

function disqualifiersForDecision(type, codes = [], missingEvidence = []) {
  const disqualifiers = [];
  if (type === "disallowed_offside" || hasAny(codes, OFFSIDE_CODES)) disqualifiers.push("offside");
  if (type === "disallowed_no_goal" || hasAny(codes, DISALLOWED_CODES)) disqualifiers.push("no_goal_decision");
  if (type === "possible_goal_unconfirmed") disqualifiers.push("unconfirmed_goal_decision");
  if (missingEvidence.includes("final_goal_decision")) disqualifiers.push("missing_final_goal_decision");
  if (missingEvidence.includes("usable_ocr_qa_calibration")) disqualifiers.push("missing_usable_ocr_qa");
  if (missingEvidence.includes("live_goal_phase")) disqualifiers.push("replay_only_goal_candidate");
  return uniqueCodes(disqualifiers, MAX_FLAGS);
}

function sortedWindows(windows = []) {
  return [...windows].sort((a, b) => windowStart(a) - windowStart(b) || windowEnd(a) - windowEnd(b));
}

function windowsWithCodes(windows = [], codes = []) {
  return sortedWindows(windows).filter((window) => hasAny(visualReasonCodesForWindow(window), codes));
}

function firstWindowStart(windows = [], fallback = null) {
  const first = sortedWindows(windows)[0];
  return first ? round(windowStart(first)) : fallback;
}

function hasLiveActionBeforeReplay(windows = [], replayStart = null) {
  return windowsWithCodes(windows, LIVE_GOAL_PHASE_CODES)
    .some((window) => replayStart == null || windowStart(window) <= replayStart - 0.25);
}

function normalizePhaseTimestamp(value, min, max, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return round(clamp(parsed, min, max));
}

function visualGoalPayoffForCodes(codes = []) {
  const hasBallInNetEvidence = hasAny(codes, ["ball_in_net", "visual_ball_in_net"]);
  const hasLiveFinishSequence = hasAny(codes, ["live_shot_finish_sequence"]) && hasAny(codes, SHOT_CODES);
  const hasScoreboardSupport = hasAny(codes, ["scoreboard_backed_goal_sequence", "scoreboard_ocr_score_change", "scoreboard_temporal_consistency"]);
  return {
    hasVisibleGoalPayoff: hasBallInNetEvidence || hasLiveFinishSequence,
    hasBallInNetEvidence,
    hasLiveFinishSequence,
    scoreboardOnly: hasScoreboardSupport && !hasBallInNetEvidence && !hasLiveFinishSequence,
    evidenceCodes: uniqueCodes([
      ...(hasBallInNetEvidence ? ["visual_ball_in_net"] : []),
      ...(hasLiveFinishSequence ? ["live_shot_finish_sequence"] : []),
      ...(hasScoreboardSupport ? ["scoreboard_goal_confirmation"] : []),
    ], 8),
  };
}

function normalizePhaseCoverage(value = {}, context = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceStart = seconds(context.sourceStart);
  const sourceEnd = Math.max(sourceStart + 0.5, seconds(context.sourceEnd, sourceStart + 1));
  const evidenceCodes = Array.isArray(context.evidenceCodes) ? context.evidenceCodes : [];
  const shotWindow = context.shotWindow || {};
  const payoffWindow = context.payoffWindow || {};
  const decisionWindow = context.decisionWindow || null;
  const shotStart = normalizePhaseTimestamp(raw.shotStart, sourceStart, sourceEnd, normalizePhaseTimestamp(shotWindow.start, sourceStart, sourceEnd, sourceStart));
  const finishTime = normalizePhaseTimestamp(raw.finishTime, sourceStart, sourceEnd, normalizePhaseTimestamp(payoffWindow.end, sourceStart, sourceEnd, sourceEnd));
  const confirmationTime = normalizePhaseTimestamp(
    raw.confirmationTime,
    sourceStart,
    sourceEnd,
    decisionWindow ? normalizePhaseTimestamp(decisionWindow.start, sourceStart, sourceEnd, null) : null,
  );
  const replayUsed = Boolean(raw.replayUsed) || hasAny(evidenceCodes, REPLAY_SUPPORT_CODES);
  const replayOnly = Boolean(raw.replayOnly);
  const visualGoalPayoff = raw.visualGoalPayoff && typeof raw.visualGoalPayoff === "object" && !Array.isArray(raw.visualGoalPayoff)
    ? {
        ...visualGoalPayoffForCodes(evidenceCodes),
        hasVisibleGoalPayoff: Boolean(raw.visualGoalPayoff.hasVisibleGoalPayoff) && visualGoalPayoffForCodes(evidenceCodes).hasVisibleGoalPayoff,
        hasBallInNetEvidence: Boolean(raw.visualGoalPayoff.hasBallInNetEvidence) && hasAny(evidenceCodes, ["ball_in_net", "visual_ball_in_net"]),
        hasLiveFinishSequence: Boolean(raw.visualGoalPayoff.hasLiveFinishSequence) && hasAny(evidenceCodes, ["live_shot_finish_sequence"]),
        inferredFromStableScoreChange: Boolean(raw.visualGoalPayoff.inferredFromStableScoreChange),
        scoreboardOnly: Boolean(raw.visualGoalPayoff.scoreboardOnly) || visualGoalPayoffForCodes(evidenceCodes).scoreboardOnly,
        evidenceCodes: uniqueCodes(raw.visualGoalPayoff.evidenceCodes || visualGoalPayoffForCodes(evidenceCodes).evidenceCodes, 8),
      }
    : visualGoalPayoffForCodes(evidenceCodes);
  const finishFrameEvidence = normalizeFinishFrameEvidence(
    raw.finishFrameEvidence ||
      (raw.visualGoalPayoff && raw.visualGoalPayoff.finishFrameEvidence),
    { sourceStart, sourceEnd, finishTime },
  );
  const visualGoalPayoffWithFinishFrame = finishFrameEvidence
    ? { ...visualGoalPayoff, finishFrameEvidence }
    : visualGoalPayoff;
  return {
    hasBuildup: raw.hasBuildup == null ? sourceStart <= shotStart - 6 : Boolean(raw.hasBuildup),
    hasShot: raw.hasShot == null ? hasAny(evidenceCodes, SHOT_CODES) : Boolean(raw.hasShot),
    hasFinish: raw.hasFinish == null
      ? visualGoalPayoffWithFinishFrame.hasVisibleGoalPayoff
      : Boolean(raw.hasFinish) && visualGoalPayoffWithFinishFrame.hasVisibleGoalPayoff,
    hasConfirmation: raw.hasConfirmation == null
      ? context.type === "confirmed_goal" || hasAny(evidenceCodes, CONFIRMED_SUPPORT_CODES)
      : Boolean(raw.hasConfirmation),
    liveActionStart: normalizePhaseTimestamp(raw.liveActionStart, sourceStart, sourceEnd, sourceStart),
    shotStart,
    finishTime,
    confirmationTime,
    replayUsed,
    replayOnly,
    visualGoalPayoff: visualGoalPayoffWithFinishFrame,
    finishFrameEvidence,
  };
}

function truthContractForDecision({
  type,
  outcome,
  confidence,
  sourceStart,
  sourceEnd,
  phaseCoverage,
  evidenceCodes,
}) {
  const codes = new Set(evidenceCodes);
  const disallowed = type === "disallowed_offside" ||
    type === "disallowed_no_goal" ||
    hasAny(evidenceCodes, [...OFFSIDE_CODES, ...DISALLOWED_CODES]);
  return {
    eventType: type === "confirmed_goal" ||
      type === "disallowed_offside" ||
      type === "disallowed_no_goal" ||
      type === "possible_goal_unconfirmed"
      ? "goal"
      : "non_goal",
    outcome,
    confidence: round(clamp(confidence, 0.05, 0.98)),
    evidence: {
      visualFinish: codes.has("ball_in_net") || codes.has("visual_ball_in_net"),
      commentatorSpike: codes.has("confirmed_by_commentary") || codes.has("commentator_goal_call_support"),
      crowdSpike: codes.has("crowd_reaction_support") || codes.has("crowd_spike") || codes.has("audio_energy_spike"),
      scoreboardChange: codes.has("scoreboard_ocr_score_change") || codes.has("scoreboard_temporal_consistency"),
      scoreboardReverted: codes.has("scoreboard_ocr_goal_removed"),
      replayConfirmation: codes.has("replay_goal_confirmation") || codes.has("visual_replay_indicator") || codes.has("visual_replay_angle"),
      restartAfterGoal: codes.has("kickoff_after_goal"),
      disallowEvidence: hasAny(evidenceCodes, [...OFFSIDE_CODES, ...DISALLOWED_CODES]),
      combinedGoalConfirmation: codes.has("combined_goal_confirmation"),
    },
    disallowed,
    reasonCodes: uniqueCodes(evidenceCodes, 16),
    sourceWindow: { start: round(sourceStart), end: round(sourceEnd) },
    livePhaseWindow: {
      start: round(phaseCoverage.liveActionStart),
      end: round(phaseCoverage.finishTime),
    },
    replayWindows: phaseCoverage.replayUsed
      ? [{ start: round(phaseCoverage.finishTime), end: round(sourceEnd) }]
      : [],
  };
}

function windowSetForDecision({ event, visualSignals, duration }) {
  const start = seconds(event.start);
  const end = Math.max(start + 0.5, seconds(event.end, start + 1));
  const durationSeconds = seconds(duration, Math.max(end + 10, 0));
  const eventCodes = eventBaseCodes(event);
  const contextWindows = sortedWindows(windowsInRange(
    visualSignals,
    Math.max(0, start - GOAL_PHASE_LOOKBACK_SECONDS),
    end,
    3,
  ));
  const replayStart = firstWindowTime(contextWindows, REPLAY_SUPPORT_CODES, null);
  const liveWindowsBeforeReplay = contextWindows.filter((window) => (
    hasAny(visualReasonCodesForWindow(window), LIVE_GOAL_PHASE_CODES) &&
    !hasAny(visualReasonCodesForWindow(window), REPLAY_SUPPORT_CODES) &&
    !hasAny(visualReasonCodesForWindow(window), CELEBRATION_SUPPORT_CODES) &&
    (replayStart == null || windowStart(window) <= replayStart - 0.25)
  ));
  const anchorLookback = Math.max(GOAL_PHASE_LOOKBACK_SECONDS / 2, GOAL_PHASE_MAX_PRE_SHOT_SECONDS + 8);
  const anchoredLiveWindows = liveWindowsBeforeReplay.filter((window) => windowEnd(window) >= start - anchorLookback);
  const livePhaseWindows = anchoredLiveWindows.some((window) => hasAny(visualReasonCodesForWindow(window), SHOT_CODES))
    ? anchoredLiveWindows
    : liveWindowsBeforeReplay;
  const liveActionStart = firstWindowStart(livePhaseWindows, firstWindowTime(contextWindows, LIVE_GOAL_PHASE_CODES, start));
  const shotStart = firstWindowTime(livePhaseWindows, SHOT_CODES, firstWindowTime(contextWindows, SHOT_CODES, start));
  const payoffStart = firstWindowTime(contextWindows, PAYOFF_CODES, Math.min(end, shotStart + 2));
  const payoffEnd = lastWindowTime(contextWindows, PAYOFF_CODES, end);
  const decisionStart = firstWindowTime(contextWindows, DECISION_CODES, null);
  const hasLivePhase = hasLiveActionBeforeReplay(livePhaseWindows, replayStart) || (!hasAny(eventCodes, REPLAY_SUPPORT_CODES) && hasAny(eventCodes, SHOT_CODES));
  const replayUsed = replayStart != null || hasAny(eventCodes, REPLAY_SUPPORT_CODES);
  const replayOnly = replayUsed && !hasLivePhase;
  const phaseAnchor = Math.min(start, liveActionStart, shotStart);
  const earliestStart = Math.max(0, shotStart - GOAL_PHASE_MAX_PRE_SHOT_SECONDS);
  const latestStart = Math.max(0, shotStart - GOAL_PHASE_MIN_PRE_SHOT_SECONDS);
  const sourceStart = round(clamp(phaseAnchor - 2, earliestStart, latestStart));
  const sourceEnd = round(Math.min(
    durationSeconds,
    Math.max(end, payoffEnd + 4, decisionStart == null ? 0 : decisionStart + 3),
  ));
  const boundedSourceEnd = Math.max(sourceStart + 3, sourceEnd);
  const finishFrameEvidence = finishFrameEvidenceFromWindows(contextWindows, payoffEnd);
  const phaseCoverage = {
    hasBuildup: !replayOnly && sourceStart <= shotStart - 6,
    hasShot: !replayOnly && (hasAny(eventCodes, SHOT_CODES) || livePhaseWindows.some((window) => hasAny(visualReasonCodesForWindow(window), SHOT_CODES))),
    hasFinish: hasAny(eventCodes, GOAL_FINISH_CODES) || hasAny(visualCodesForRange(visualSignals, sourceStart, boundedSourceEnd), GOAL_FINISH_CODES),
    hasConfirmation: decisionStart != null || hasAny(eventCodes, CONFIRMED_SUPPORT_CODES),
    liveActionStart: round(liveActionStart),
    shotStart: round(shotStart),
    finishTime: round(payoffEnd),
    confirmationTime: decisionStart == null ? null : round(decisionStart),
    replayUsed,
    replayOnly,
    finishFrameEvidence,
  };
  return {
    sourceStart,
    sourceEnd: boundedSourceEnd,
    buildupWindow: { start: sourceStart, end: round(Math.max(sourceStart + 0.5, shotStart)) },
    shotWindow: { start: round(shotStart), end: round(Math.max(shotStart + 0.5, payoffStart)) },
    payoffWindow: { start: round(payoffStart), end: round(Math.max(payoffStart + 0.5, payoffEnd)) },
    reactionWindow: { start: round(payoffEnd), end: round(Math.min(durationSeconds, payoffEnd + 4)) },
    decisionWindow: decisionStart == null
      ? null
      : { start: round(decisionStart), end: round(Math.min(durationSeconds, Math.max(decisionStart + 1, boundedSourceEnd))) },
    phaseCoverage,
    replayUsed,
    replayOnly,
  };
}

function missingEvidenceForDecision(type, codes = [], ocrQaCalibration = null) {
  const missing = [];
  if (["confirmed_goal", "disallowed_offside", "disallowed_no_goal", "possible_goal_unconfirmed"].includes(type)) {
    if (!hasAny(codes, ["ball_in_net", "visual_ball_in_net", "scoreboard_backed_goal_sequence"])) {
      missing.push("ball_in_net_or_scoreboard_backed_goal_sequence");
    }
    if (!hasAny(codes, ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal", "shot_sequence_support"])) {
      missing.push("shot_or_ball_trajectory");
    }
    if (type === "confirmed_goal" && !hasAny(codes, CONFIRMED_SUPPORT_CODES)) missing.push("confirmed_goal_support");
    if (hasAny(codes, ["scoreboard_ocr_score_change", "scoreboard_ocr_score_unchanged"]) && !(ocrQaCalibration && ocrQaCalibration.usable)) {
      missing.push("usable_ocr_qa_calibration");
    }
    if (type === "possible_goal_unconfirmed") missing.push("final_goal_decision");
  }
  return missing.slice(0, MAX_MISSING);
}

function safetyFlagsForDecision(type, codes = [], ocrQaCalibration = null) {
  const flags = ["no_false_goal_from_ocr_only"];
  if (hasAny(codes, ["scoreboard_ocr_score_change", "scoreboard_ocr_score_unchanged"])) flags.push("ocr_support_only");
  if (!(ocrQaCalibration && ocrQaCalibration.usable)) flags.push("ocr_qa_ignored_or_missing");
  if (type !== "confirmed_goal") flags.push("no_confirmed_goal_caption");
  if (type === "confirmed_goal") flags.push("confirmed_goal_requires_action_and_support");
  if (type === "crowd_reaction") flags.push("reaction_support_only");
  if (hasAny(codes, REPLAY_SUPPORT_CODES)) flags.push("replay_support_only");
  return flags.slice(0, MAX_FLAGS);
}

function confidenceForDecision(type, codes = [], baseConfidence = 0) {
  const supportBoost = CONFIRMED_SUPPORT_CODES.reduce((sum, code) => sum + (codes.includes(code) ? 0.03 : 0), 0);
  const decisionBoost = [...OFFSIDE_CODES, ...DISALLOWED_CODES].reduce((sum, code) => sum + (codes.includes(code) ? 0.04 : 0), 0);
  const typeBase = type === "confirmed_goal"
    ? 0.82
    : type === "disallowed_offside" || type === "disallowed_no_goal"
      ? 0.78
      : type === "possible_goal_unconfirmed"
        ? 0.62
        : type === "big_chance" || type === "save"
          ? 0.58
          : 0.42;
  return round(clamp(Math.max(typeBase, Number(baseConfidence || 0)) + supportBoost + decisionBoost, 0.05, 0.98));
}

function normalizeDecision(decision = {}, index = 0, metadata = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision) || hasUnsafeValue(decision)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  const sourceStart = round(clamp(decision.sourceStart, 0, duration || seconds(decision.sourceEnd, 0)));
  const sourceEnd = round(clamp(decision.sourceEnd, sourceStart + 0.5, duration || seconds(decision.sourceEnd, sourceStart + 1)));
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const type = sanitizeText(decision.type || "neutral", 48);
  const outcome = sanitizeText(decision.outcome || goalOutcomeForType(type), 48);
  if (!MATCH_EVENT_TYPES.includes(type) || !MATCH_EVENT_OUTCOMES.includes(outcome)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const evidenceCodes = uniqueCodes(decision.evidenceCodes);
  const missingEvidence = uniqueCodes(decision.missingEvidence, MAX_MISSING);
  const buildupWindow = normalizeOptionalWindow(decision.buildupWindow, sourceStart, sourceEnd);
  const shotWindow = normalizeOptionalWindow(decision.shotWindow, sourceStart, sourceEnd);
  const payoffWindow = normalizeOptionalWindow(decision.payoffWindow, sourceStart, sourceEnd);
  const reactionWindow = normalizeOptionalWindow(decision.reactionWindow, sourceStart, sourceEnd);
  const decisionWindow = normalizeOptionalWindow(decision.decisionWindow, sourceStart, sourceEnd, true);
  const phaseCoverage = normalizePhaseCoverage(decision.phaseCoverage, {
    sourceStart,
    sourceEnd,
    evidenceCodes,
    type,
    shotWindow,
    payoffWindow,
    decisionWindow,
  });
  return {
    id: sanitizeText(decision.id || `match_event_${index + 1}`, 80),
    type,
    eventType: truthEventTypeForMatchType(type),
    truthStatus: truthStatusForMatchType(type),
    outcome,
    confidence: round(clamp(decision.confidence, 0.05, 0.98)),
    sourceStart,
    sourceEnd,
    buildupWindow,
    shotWindow,
    payoffWindow,
    reactionWindow,
    decisionWindow,
    phaseCoverage,
    shotStart: phaseCoverage.shotStart,
    finishTime: phaseCoverage.finishTime,
    confirmationTime: phaseCoverage.confirmationTime,
    replayUsed: phaseCoverage.replayUsed,
    replayOnly: phaseCoverage.replayOnly,
    evidenceCodes,
    evidence: evidenceCodes,
    missingEvidence,
    disqualifiers: disqualifiersForDecision(type, evidenceCodes, missingEvidence),
    decisionWindowStart: decisionWindow ? decisionWindow.start : null,
    decisionWindowEnd: decisionWindow ? decisionWindow.end : null,
    teams: normalizeTeams(decision.teams),
    goalNumber: Number.isInteger(Number(decision.goalNumber)) && Number(decision.goalNumber) > 0
      ? Math.min(99, Math.round(Number(decision.goalNumber)))
      : null,
    scoreBefore: normalizeScoreField(decision.scoreBefore),
    scoreAfter: normalizeScoreField(decision.scoreAfter),
    scoreChangeTime: decision.scoreChangeTime == null ? null : round(seconds(decision.scoreChangeTime)),
    scoringSide: sanitizeText(decision.scoringSide || "unknown", 16),
    cannotConfirmGoalAlone: Boolean(decision.cannotConfirmGoalAlone),
    primarySource: decision.primarySource ? sanitizeText(decision.primarySource, 40) : null,
    visibleGoalRecovery: decision.visibleGoalRecovery && typeof decision.visibleGoalRecovery === "object"
      ? publicVisibleGoalPhaseRecovery(decision.visibleGoalRecovery)
      : null,
    anchorDiagnostics: normalizeAnchorDiagnostics(decision.anchorDiagnostics),
    safetyFlags: uniqueCodes(decision.safetyFlags, MAX_FLAGS),
    truth: truthContractForDecision({
      type,
      outcome,
      confidence: round(clamp(decision.confidence, 0.05, 0.98)),
      sourceStart,
      sourceEnd,
      phaseCoverage,
      evidenceCodes,
    }),
    captionIntent: sanitizeText(decision.captionIntent || captionIntentForType(type), 64),
    renderPriority: round(clamp(decision.renderPriority, 0, 1200), 1),
  };
}

function normalizeOptionalWindow(window, minStart, maxEnd, nullable = false) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return nullable ? null : { start: round(minStart), end: round(maxEnd) };
  const start = round(clamp(window.start, minStart, maxEnd));
  const end = round(clamp(window.end, start + 0.1, maxEnd));
  return { start, end };
}

function normalizeAnchorDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const searchWindow = value.searchWindow && typeof value.searchWindow === "object" && !Array.isArray(value.searchWindow)
    ? {
        start: round(seconds(value.searchWindow.start)),
        end: round(seconds(value.searchWindow.end)),
      }
    : null;
  return {
    changeTime: round(seconds(value.changeTime)),
    actionAnchorTime: value.actionAnchorTime == null ? null : round(seconds(value.actionAnchorTime)),
    searchWindow,
    bindingStrategy: value.bindingStrategy ? sanitizeText(value.bindingStrategy, 60) : null,
    bindingFallbackUsed: Boolean(value.bindingFallbackUsed),
    bindingFullSourceScanUsed: Boolean(value.bindingFullSourceScanUsed),
    bindingSampledFrameBudget: Math.max(0, Math.round(Number(value.bindingSampledFrameBudget || 0))),
    bindingMaxBackwardSeconds: Math.max(0, Math.round(Number(value.bindingMaxBackwardSeconds || 0))),
    liveWindowCount: Math.max(0, Math.round(Number(value.liveWindowCount || 0))),
    shotWindowCount: Math.max(0, Math.round(Number(value.shotWindowCount || 0))),
    finishWindowCount: Math.max(0, Math.round(Number(value.finishWindowCount || 0))),
    decisionWindowCount: Math.max(0, Math.round(Number(value.decisionWindowCount || 0))),
    mediaActionWindowCount: Math.max(0, Math.round(Number(value.mediaActionWindowCount || 0))),
    missingActionEvidence: Boolean(value.missingActionEvidence),
    ocrOnlyBlocked: Boolean(value.ocrOnlyBlocked),
    visibleGoalRecovery: value.visibleGoalRecovery && typeof value.visibleGoalRecovery === "object"
      ? publicVisibleGoalPhaseRecovery(value.visibleGoalRecovery)
      : null,
  };
}

function safeDecoderStatus(item = {}) {
  const status = sanitizeText(item.decoderStatus || item.imageDecoderStatus || "unknown", 40);
  return status || "unknown";
}

function safeImageSegmentationStatus(item = {}) {
  const status = sanitizeText(item.imageSegmentationStatus || item.segmentationStatus || "unknown", 40);
  return status || "unknown";
}

function scoreObservationReasonCodes(item = {}, calibration = null) {
  const codes = [];
  const status = sanitizeText(item.status || "", 40);
  if (item.scoreChanged || status === "score_changed" || status === "goal_confirmed") codes.push("scoreboard_ocr_score_change");
  if (item.scoreReverted || status === "goal_removed" || status === "score_reverted_or_disallowed") codes.push("scoreboard_ocr_goal_removed");
  if (item.scoreUnchanged || status === "score_unchanged") codes.push("scoreboard_ocr_score_unchanged");
  if (item.temporalConsistency) codes.push("scoreboard_temporal_consistency");
  if (item.ambiguous) codes.push("scoreboard_ocr_ambiguous");
  if (calibration && calibration.usable) codes.push("ocr_qa_calibrated");
  return uniqueCodes(codes, 12);
}

function normalizeScoreTimelineObservation(item = {}, index = 0, calibration = null) {
  const before = parseScoreValue(item.scoreBefore);
  const after = parseScoreValue(item.scoreAfter);
  const direction = scoreDirection(before, after);
  const confidence = round(clamp(item.confidence, 0, 1));
  const isStable = Boolean(item.temporalConsistency) &&
    !item.ambiguous &&
    confidence >= SCORE_CHANGE_MIN_CONFIDENCE &&
    before &&
    after &&
    direction !== "ambiguous" &&
    direction !== "unknown";
  return {
    id: sanitizeText(item.id || `score_observation_${index + 1}`, 80),
    timestamp: round(seconds(item.timestamp)),
    homeScore: after ? after.home : null,
    awayScore: after ? after.away : null,
    scoreBefore: before ? before.text : null,
    scoreAfter: after ? after.text : null,
    confidence,
    source: sanitizeText(item.source || "ocr", 60),
    decoderStatus: safeDecoderStatus(item),
    imageSegmentationStatus: safeImageSegmentationStatus(item),
    isStable,
    reasonCodes: scoreObservationReasonCodes(item, calibration),
    status: sanitizeText(item.status || "unknown", 40),
    transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
    temporalConsistency: Boolean(item.temporalConsistency),
    ambiguous: Boolean(item.ambiguous),
  };
}

function scoreChangeAuthority(item = {}, calibration = null) {
  const confidence = Number(item.confidence || 0);
  const normalizedScoreChange = Boolean(item.scoreChanged) && confidence >= SCORE_CHANGE_MIN_CONFIDENCE;
  return Boolean(item.temporalConsistency) &&
    !item.ambiguous &&
    (normalizedScoreChange || scoreChangeStrongAuthority(item, calibration));
}

function scoreChangeStrongAuthority(item = {}, calibration = null) {
  const confidence = Number(item.confidence || 0);
  const calibrated = Boolean(calibration && calibration.usable && calibration.decisionSupportLevel === "strong");
  const decoderBacked = safeDecoderStatus(item) === "decoded" ||
    safeImageSegmentationStatus(item) === "readable" ||
    /scorebug_digit_reader|digit_scorebug/i.test(String(item.source || ""));
  return calibrated || (decoderBacked && confidence >= SCORE_CHANGE_STRONG_CONFIDENCE);
}

function scoreChangePersistedDuration(item = {}, nextRevert = null, duration = 0) {
  const timestamp = seconds(item.timestamp);
  if (nextRevert) return Math.max(0, round(seconds(nextRevert.timestamp) - timestamp));
  const fallbackEnd = duration > timestamp ? Math.min(duration, timestamp + SCORE_CHANGE_CONFIRMATION_SECONDS) : timestamp + SCORE_CHANGE_CONFIRMATION_SECONDS;
  return Math.max(0, round(fallbackEnd - timestamp));
}

function matchingRevertForScoreChange(change = {}, laterItems = []) {
  const before = parseScoreValue(change.scoreBefore);
  const after = parseScoreValue(change.scoreAfter);
  if (!before || !after) return null;
  const changeTime = seconds(change.timestamp);
  return laterItems.find((item) => {
    const itemTime = seconds(item.timestamp);
    if (itemTime <= changeTime || itemTime - changeTime > SCORE_CHANGE_REVERT_LOOKAHEAD_SECONDS) return false;
    if (!item.scoreReverted || item.ambiguous || !item.temporalConsistency) return false;
    return sameScore(parseScoreValue(item.scoreBefore), after) && sameScore(parseScoreValue(item.scoreAfter), before);
  }) || null;
}

function pendingObservationForScoreChange(change = {}, earlierItems = []) {
  const before = parseScoreValue(change.scoreBefore);
  const after = parseScoreValue(change.scoreAfter);
  if (!before || !after) return null;
  const changeTime = seconds(change.timestamp);
  const matches = (Array.isArray(earlierItems) ? earlierItems : [])
    .filter((item) => {
      const itemTime = seconds(item.timestamp);
      if (itemTime >= changeTime || changeTime - itemTime > SCORE_CHANGE_PENDING_LOOKBACK_SECONDS) return false;
      if (item.scoreChanged || item.scoreReverted) return false;
      if (!sameScore(parseScoreValue(item.scoreBefore), before) || !sameScore(parseScoreValue(item.scoreAfter), after)) return false;
      const pendingDecision = sanitizeText(item.transitionDecision || "", 60) === "score_change_pending_confirmation";
      const pendingReason = Array.isArray(item.transitionReasonCodes) &&
        item.transitionReasonCodes.includes("unit_score_increase_candidate");
      return pendingDecision || pendingReason || (!item.temporalConsistency && item.ambiguous);
    })
    .sort((a, b) => seconds(a.timestamp) - seconds(b.timestamp));
  return matches[0] || null;
}

function stableConfirmationForPendingObservation(item = {}, laterItems = [], calibration = null) {
  const before = parseScoreValue(item.scoreBefore);
  const after = parseScoreValue(item.scoreAfter);
  if (!before || !after) return null;
  const itemTime = seconds(item.timestamp);
  const pendingDecision = sanitizeText(item.transitionDecision || "", 60) === "score_change_pending_confirmation";
  const pendingReason = Array.isArray(item.transitionReasonCodes) &&
    item.transitionReasonCodes.includes("unit_score_increase_candidate");
  if (!pendingDecision && !pendingReason) return null;
  return (Array.isArray(laterItems) ? laterItems : []).find((candidate) => {
    const candidateTime = seconds(candidate.timestamp);
    if (candidateTime <= itemTime || candidateTime - itemTime > SCORE_CHANGE_PENDING_LOOKBACK_SECONDS) return false;
    if (!sameScore(parseScoreValue(candidate.scoreBefore), before) || !sameScore(parseScoreValue(candidate.scoreAfter), after)) return false;
    return scoreChangeAuthority(candidate, calibration);
  }) || null;
}

function normalizeScoreChanges(ocrEvidence = [], calibration = null, metadata = {}) {
  const duration = seconds(metadata.durationSeconds, 0);
  const stableItems = (Array.isArray(ocrEvidence) ? ocrEvidence : [])
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => seconds(a.timestamp) - seconds(b.timestamp));
  const changes = [];
  const consumedReverts = new Set();
  for (const item of stableItems) {
    if (consumedReverts.has(item.id)) continue;
    const before = parseScoreValue(item.scoreBefore);
    const after = parseScoreValue(item.scoreAfter);
    const direction = scoreDirection(before, after);
    if (!before || !after || direction === "same" || direction === "unknown" || direction === "ambiguous") continue;
    if (!scoreChangeAuthority(item, calibration)) {
      if (stableConfirmationForPendingObservation(item, stableItems, calibration)) continue;
      changes.push({
        id: sanitizeText(item.id || `score_change_${changes.length + 1}`, 80),
        startScore: before.text,
        endScore: after.text,
        firstSeenAt: round(seconds(item.timestamp)),
        confirmedAt: null,
        stableUntil: null,
        changeTime: round(seconds(item.timestamp)),
        source: "scoreboard_ocr",
        roiId: sanitizeText(item.regionId || item.roiId || "", 80) || null,
        layoutId: sanitizeText(item.layoutId || "", 80) || null,
        teamSide: scoreTeamSide(before, after),
        scoreDelta: scoreDelta(before, after),
        confidence: round(clamp(item.confidence, 0, 1)),
        persistedDuration: 0,
        reverted: false,
        revertedAt: null,
        outcome: "uncertain_review",
        evidenceCodes: uniqueCodes(scoreObservationReasonCodes(item, calibration), 12),
        reasonCodes: uniqueCodes(["scoreboard_ocr_ambiguous"], 8),
      });
      continue;
    }
    if (direction === "decrease" || item.scoreReverted) {
      changes.push({
        id: sanitizeText(item.id || `score_revert_${changes.length + 1}`, 80),
        startScore: before.text,
        endScore: after.text,
        firstSeenAt: round(seconds(item.timestamp)),
        confirmedAt: round(seconds(item.timestamp)),
        stableUntil: round(seconds(item.timestamp)),
        changeTime: round(seconds(item.timestamp)),
        source: "scoreboard_ocr",
        roiId: sanitizeText(item.regionId || item.roiId || "", 80) || null,
        layoutId: sanitizeText(item.layoutId || "", 80) || null,
        teamSide: scoreTeamSide(before, after),
        scoreDelta: scoreDelta(before, after),
        confidence: round(clamp(item.confidence, 0, 1)),
        persistedDuration: 0,
        reverted: true,
        revertedAt: round(seconds(item.timestamp)),
        outcome: "disallowed_goal",
        evidenceCodes: uniqueCodes([
          ...scoreObservationReasonCodes(item, calibration),
          "scoreboard_ocr_goal_removed",
          "scoreboard_temporal_consistency",
        ], 12),
        reasonCodes: uniqueCodes(["scoreboard_ocr_goal_removed", "scoreboard_temporal_consistency"], 8),
      });
      continue;
    }
    const revert = matchingRevertForScoreChange(item, stableItems);
    if (revert && revert.id) consumedReverts.add(revert.id);
    const pendingObservation = pendingObservationForScoreChange(item, stableItems);
    changes.push({
      id: sanitizeText(item.id || `score_change_${changes.length + 1}`, 80),
      startScore: before.text,
      endScore: after.text,
      firstSeenAt: pendingObservation ? round(seconds(pendingObservation.timestamp)) : round(seconds(item.timestamp)),
      confirmedAt: round(seconds(item.timestamp)),
      changeTime: round(seconds(item.timestamp)),
      actionAnchorTime: pendingObservation ? round(seconds(pendingObservation.timestamp)) : round(seconds(item.timestamp)),
      hasPendingObservation: Boolean(pendingObservation),
      strongAuthority: scoreChangeStrongAuthority(item, calibration),
      stableUntil: revert
        ? round(seconds(revert.timestamp))
        : round(seconds(item.timestamp) + scoreChangePersistedDuration(item, revert, duration)),
      source: "scoreboard_ocr",
      roiId: sanitizeText(item.regionId || item.roiId || "", 80) || null,
      layoutId: sanitizeText(item.layoutId || "", 80) || null,
      teamSide: scoreTeamSide(before, after),
      scoreDelta: scoreDelta(before, after),
      confidence: round(clamp(item.confidence, 0, 1)),
      persistedDuration: scoreChangePersistedDuration(item, revert, duration),
      reverted: Boolean(revert),
      revertedAt: revert ? round(seconds(revert.timestamp)) : null,
      outcome: revert ? "disallowed_goal" : "counted_goal",
      evidenceCodes: uniqueCodes([
        ...scoreObservationReasonCodes(item, calibration),
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        ...(pendingObservation ? ["score_change_pending_observation"] : []),
        ...(revert ? ["scoreboard_ocr_goal_removed"] : []),
      ], 12),
      reasonCodes: uniqueCodes([
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        ...(revert ? ["scoreboard_ocr_goal_removed"] : []),
      ], 8),
    });
  }
  return changes.slice(0, MAX_EVENTS);
}

function scoreChangeCoveredByDecision(change = {}, decisions = []) {
  const changeTime = seconds(change.changeTime);
  const startScore = normalizeScoreField(change.startScore);
  const endScore = normalizeScoreField(change.endScore);
  const hasScoreTransition = Boolean(startScore && endScore);
  return (Array.isArray(decisions) ? decisions : []).some((decision) => {
    if (!decision || !["confirmed_goal", "disallowed_offside", "disallowed_no_goal"].includes(decision.type)) return false;
    const decisionChangeTime = decision.scoreChangeTime == null ? null : seconds(decision.scoreChangeTime);
    if (hasScoreTransition) {
      const decisionStartScore = normalizeScoreField(decision.scoreBefore);
      const decisionEndScore = normalizeScoreField(decision.scoreAfter);
      if (decisionStartScore || decisionEndScore) {
        if (decisionStartScore !== startScore || decisionEndScore !== endScore) return false;
        return decisionChangeTime == null ||
          Math.abs(decisionChangeTime - changeTime) <= SCORE_CHANGE_CONFIRMATION_SECONDS;
      }
      return decisionChangeTime != null &&
        Math.abs(decisionChangeTime - changeTime) <= SCORE_CHANGE_DEDUP_TIME_TOLERANCE_SECONDS;
    }
    return changeTime >= seconds(decision.sourceStart) - 2 &&
      changeTime <= seconds(decision.sourceEnd) + 2;
  });
}

function mediaActionContextForScoreChange(change = {}, mediaSignals = {}, metadata = {}) {
  const stableChangeTime = seconds(change.changeTime);
  const actionAnchorTime = seconds(change.actionAnchorTime, stableChangeTime);
  const searchAnchorTime = Math.min(stableChangeTime, actionAnchorTime);
  const duration = seconds(metadata.durationSeconds, stableChangeTime + SCORE_CHANGE_POST_SECONDS);
  const left = Math.max(0, searchAnchorTime - SCORE_CHANGE_BINDING_LOOKBACK_SECONDS);
  const right = Math.min(duration || stableChangeTime + SCORE_CHANGE_BINDING_FORWARD_SECONDS, stableChangeTime + SCORE_CHANGE_BINDING_FORWARD_SECONDS);
  const highMotionCandidates = Array.isArray(mediaSignals && mediaSignals.highMotionCandidates)
    ? mediaSignals.highMotionCandidates
    : [];
  const audioPeaks = Array.isArray(mediaSignals && mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : [];
  const motion = highMotionCandidates
    .map((item) => ({
      time: seconds(item.time ?? item.timestamp),
      confidence: Number(item.confidence ?? item.energyScore ?? 0),
    }))
    .filter((item) => item.time >= left && item.time <= right && item.confidence >= 0.72)
    .sort((a, b) => Math.abs(searchAnchorTime - b.time) - Math.abs(searchAnchorTime - a.time));
  if (!motion.length) return null;
  const anchor = motion[motion.length - 1];
  const nearbyAudio = audioPeaks.some((item) => {
    const time = seconds(item.time ?? item.timestamp);
    const energy = Number(item.energyScore ?? item.confidence ?? 0);
    return time >= anchor.time - 8 && time <= stableChangeTime + 2 && energy >= 0.75;
  });
  return {
    start: round(Math.max(0, anchor.time - 4)),
    end: round(Math.min(duration || searchAnchorTime + 2, Math.max(anchor.time + 4, searchAnchorTime))),
    confidence: round(clamp(anchor.confidence + (nearbyAudio ? 0.05 : 0), 0.05, 0.98)),
    nearbyAudio,
  };
}

function scoreChangeAnchorCodes(change = {}) {
  return uniqueCodes([
    ...(Array.isArray(change.evidenceCodes) ? change.evidenceCodes : []),
    ...(Array.isArray(change.reasonCodes) ? change.reasonCodes : []),
    ...(change.outcome === "counted_goal" ? ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] : []),
  ], 12);
}

function scoreChangeVisualContext(change = {}, visualSignals = {}, metadata = {}, mediaSignals = {}, index = 0) {
  const stableChangeTime = seconds(change.changeTime);
  const actionAnchorTime = seconds(change.actionAnchorTime, stableChangeTime);
  const searchAnchorTime = Math.min(stableChangeTime, actionAnchorTime);
  const confirmationAnchorTime = stableChangeTime;
  const duration = seconds(metadata.durationSeconds, stableChangeTime + SCORE_CHANGE_POST_SECONDS);
  const left = Math.max(0, searchAnchorTime - SCORE_CHANGE_BINDING_LOOKBACK_SECONDS);
  const right = Math.min(duration || stableChangeTime + SCORE_CHANGE_BINDING_FORWARD_SECONDS, stableChangeTime + SCORE_CHANGE_BINDING_FORWARD_SECONDS);
  const mediaAction = mediaActionContextForScoreChange(change, mediaSignals, metadata);
  const contextWindows = sortedWindows(windowsInRange(visualSignals, left, right, 2));
  const recovery = analyzeVisibleGoalPhaseRecovery({
    change,
    visualSignals,
    metadata,
    index,
  });
  if (recovery.selected) {
    const selected = recovery.selected;
    return {
      sourceStart: selected.sourceStart,
      sourceEnd: selected.sourceEnd,
      buildupWindow: { start: selected.sourceStart, end: round(Math.max(selected.sourceStart + 0.5, selected.shotStart)) },
      shotWindow: { start: selected.shotStart, end: round(Math.max(selected.shotStart + 0.5, selected.finishTime)) },
      payoffWindow: { start: round(Math.max(selected.sourceStart, selected.finishTime - 0.5)), end: round(Math.max(selected.finishTime + 0.5, selected.finishTime)) },
      reactionWindow: { start: selected.finishTime, end: round(Math.min(duration || selected.sourceEnd, selected.sourceEnd)) },
      decisionWindow: { start: selected.confirmationTime, end: round(Math.min(duration || selected.sourceEnd, Math.max(selected.confirmationTime + 1, selected.sourceEnd))) },
      phaseCoverage: selected.phaseCoverage,
      visualCodes: uniqueCodes([
        ...selected.visualCodes,
        ...(mediaAction ? ["media_high_motion_goal_phase_support"] : []),
        ...(mediaAction && mediaAction.nearbyAudio ? ["audio_energy_spike"] : []),
      ], 32),
      primarySource: selected.primarySource,
      visibleGoalRecovery: publicVisibleGoalPhaseRecovery(recovery),
      anchorDiagnostics: {
        changeTime: round(stableChangeTime),
        actionAnchorTime: round(actionAnchorTime),
        searchWindow: { start: round(left), end: round(right) },
        liveWindowCount: recovery.candidateCounts.liveAction,
        shotWindowCount: recovery.candidateCounts.shot,
        finishWindowCount: Number(recovery.candidateCounts.payoff || 0) + Number(recovery.candidateCounts.inferredFinish || 0),
        decisionWindowCount: contextWindows.filter((window) => hasAny(visualReasonCodesForWindow(window), DECISION_CODES)).length,
        mediaActionWindowCount: mediaAction ? 1 : 0,
        missingActionEvidence: false,
        ocrOnlyBlocked: false,
        bindingStrategy: selected.bindingStrategy,
        bindingFallbackUsed: Boolean(selected.fallbackUsed),
        bindingFullSourceScanUsed: false,
        bindingSampledFrameBudget: recovery.bindingDiagnostics && recovery.bindingDiagnostics.sampledFrameBudget,
        bindingMaxBackwardSeconds: recovery.bindingDiagnostics && recovery.bindingDiagnostics.maxBackwardSeconds,
        visibleGoalRecovery: publicVisibleGoalPhaseRecovery(recovery),
      },
    };
  }
  const liveWindows = contextWindows.filter((window) => {
    const codes = visualReasonCodesForWindow(window);
    return hasAny(codes, LIVE_GOAL_PHASE_CODES) &&
      !hasAny(codes, REPLAY_SUPPORT_CODES) &&
      !hasAny(codes, CELEBRATION_SUPPORT_CODES);
  });
  const shotWindows = contextWindows.filter((window) => hasAny(visualReasonCodesForWindow(window), SHOT_CODES));
  const finishWindows = contextWindows.filter((window) => hasAny(visualReasonCodesForWindow(window), GOAL_FINISH_CODES));
  const decisionWindows = contextWindows.filter((window) => hasAny(visualReasonCodesForWindow(window), DECISION_CODES));
  const shotStart = firstWindowTime(liveWindows.length ? liveWindows : shotWindows, SHOT_CODES, null);
  const liveActionStart = firstWindowStart(liveWindows, shotStart == null ? null : Math.max(0, shotStart - GOAL_PHASE_MIN_PRE_SHOT_SECONDS));
  const finishTime = lastWindowTime(finishWindows, GOAL_FINISH_CODES, confirmationAnchorTime);
  const decisionStart = firstWindowStart(decisionWindows, confirmationAnchorTime);
  const replayUsed = contextWindows.some((window) => hasAny(visualReasonCodesForWindow(window), REPLAY_SUPPORT_CODES));
  const replayOnly = replayUsed && !liveWindows.length;
  const hasMediaAction = Boolean(mediaAction);
  const effectiveShotStart = shotStart == null && mediaAction ? mediaAction.start : shotStart;
  const effectiveLiveActionStart = liveActionStart == null && mediaAction ? mediaAction.start : liveActionStart;
  const hasShot = effectiveShotStart != null;
  const hasFinish = finishWindows.length > 0;
  const allowBacktrackFallback = Boolean(metadata.allowScoreChangeBacktrackFallback) &&
    change.outcome === "counted_goal" &&
    hasAny(scoreChangeAnchorCodes(change), ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"]) &&
    !hasAny(visualCodesForRange(visualSignals, left, right), [...OFFSIDE_CODES, ...DISALLOWED_CODES]);
  if (allowBacktrackFallback && (!hasShot || !hasFinish || replayOnly)) {
    const sourceStart = round(Math.max(0, confirmationAnchorTime - SCORE_CHANGE_BACKTRACK_FALLBACK_SECONDS));
    const shotStart = round(Math.max(
      sourceStart + GOAL_PHASE_MIN_PRE_SHOT_SECONDS,
      confirmationAnchorTime - SCORE_CHANGE_BACKTRACK_FALLBACK_SHOT_LEAD_SECONDS,
    ));
    const finishTime = round(Math.max(
      shotStart + 1.5,
      confirmationAnchorTime - SCORE_CHANGE_BACKTRACK_FALLBACK_FINISH_LEAD_SECONDS,
    ));
    const sourceEnd = round(Math.min(
      duration || stableChangeTime + SCORE_CHANGE_POST_SECONDS,
      Math.max(confirmationAnchorTime + SCORE_CHANGE_BACKTRACK_FALLBACK_TAIL_SECONDS, finishTime + 4),
    ));
    return {
      sourceStart,
      sourceEnd,
      buildupWindow: { start: sourceStart, end: shotStart },
      shotWindow: { start: shotStart, end: round(Math.max(shotStart + 0.5, finishTime)) },
      payoffWindow: { start: round(Math.max(shotStart, finishTime - 1)), end: finishTime },
      reactionWindow: { start: finishTime, end: round(Math.min(duration || sourceEnd, sourceEnd)) },
      decisionWindow: { start: round(confirmationAnchorTime), end: round(Math.min(duration || sourceEnd, Math.max(confirmationAnchorTime + 1, sourceEnd))) },
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        liveActionStart: sourceStart,
        shotStart,
        finishTime,
        confirmationTime: round(confirmationAnchorTime),
        replayUsed,
        replayOnly: false,
        visualGoalPayoff: {
          hasVisibleGoalPayoff: true,
          hasBallInNetEvidence: false,
          hasLiveFinishSequence: true,
          inferredFromStableScoreChange: true,
          scoreboardOnly: false,
          evidenceCodes: ["scoreboard_temporal_consistency", "live_shot_finish_sequence"],
        },
      },
      visualCodes: uniqueCodes([
        ...visualCodesForRange(visualSignals, left, right),
        "scoreboard_backed_goal_sequence",
        "score_change_backtrack_window",
        "shot_sequence_support",
        "live_shot_finish_sequence",
        ...(hasMediaAction ? ["media_high_motion_goal_phase_support"] : []),
        ...(mediaAction && mediaAction.nearbyAudio ? ["audio_energy_spike"] : []),
      ], 32),
      primarySource: "score_change_backtrack",
      visibleGoalRecovery: publicVisibleGoalPhaseRecovery(recovery),
      anchorDiagnostics: {
        changeTime: round(stableChangeTime),
        actionAnchorTime: round(actionAnchorTime),
        searchWindow: { start: round(left), end: round(right) },
        liveWindowCount: liveWindows.length,
        shotWindowCount: shotWindows.length,
        finishWindowCount: finishWindows.length,
        decisionWindowCount: decisionWindows.length,
        mediaActionWindowCount: hasMediaAction ? 1 : 0,
        missingActionEvidence: false,
        ocrOnlyBlocked: false,
        bindingStrategy: "score_change_backtrack_fallback",
        bindingFallbackUsed: true,
        bindingFullSourceScanUsed: false,
        bindingSampledFrameBudget: recovery && recovery.bindingDiagnostics && recovery.bindingDiagnostics.sampledFrameBudget,
        bindingMaxBackwardSeconds: SCORE_CHANGE_BACKTRACK_FALLBACK_SECONDS,
        visibleGoalRecovery: publicVisibleGoalPhaseRecovery(recovery),
      },
    };
  }
  const sourceStart = hasShot
    ? round(Math.max(0, Math.min(effectiveLiveActionStart == null ? effectiveShotStart : effectiveLiveActionStart, effectiveShotStart - GOAL_PHASE_MIN_PRE_SHOT_SECONDS)))
    : round(Math.max(0, confirmationAnchorTime - GOAL_PHASE_MIN_PRE_SHOT_SECONDS));
  const effectiveFinishTime = finishWindows.length > 0
    ? finishTime
    : mediaAction
      ? Math.max(mediaAction.end, confirmationAnchorTime - 1)
      : finishTime;
  const sourceEnd = round(Math.min(duration || stableChangeTime + SCORE_CHANGE_POST_SECONDS, Math.max(confirmationAnchorTime + 2, effectiveFinishTime + 3, sourceStart + 8)));
  const finishFrameEvidence = finishFrameEvidenceFromWindows(finishWindows, effectiveFinishTime);
  return {
    sourceStart,
    sourceEnd,
    buildupWindow: { start: sourceStart, end: round(Math.max(sourceStart + 0.5, effectiveShotStart == null ? confirmationAnchorTime : effectiveShotStart)) },
    shotWindow: { start: round(effectiveShotStart == null ? Math.max(sourceStart, confirmationAnchorTime - 3) : effectiveShotStart), end: round(Math.max((effectiveShotStart == null ? confirmationAnchorTime - 2 : effectiveShotStart) + 0.5, effectiveFinishTime)) },
    payoffWindow: { start: round(Math.max(sourceStart, Math.min(effectiveFinishTime, confirmationAnchorTime))), end: round(Math.max(effectiveFinishTime + 0.5, confirmationAnchorTime)) },
    reactionWindow: { start: round(confirmationAnchorTime), end: round(Math.min(duration || stableChangeTime + SCORE_CHANGE_POST_SECONDS, confirmationAnchorTime + SCORE_CHANGE_POST_SECONDS)) },
    decisionWindow: { start: round(decisionStart == null ? confirmationAnchorTime : decisionStart), end: round(Math.min(duration || stableChangeTime + SCORE_CHANGE_POST_SECONDS, Math.max(confirmationAnchorTime + 1, sourceEnd))) },
    phaseCoverage: {
      hasBuildup: hasShot && sourceStart <= effectiveShotStart - 6,
      hasShot,
      hasFinish,
      hasConfirmation: true,
      liveActionStart: round(effectiveLiveActionStart == null ? sourceStart : effectiveLiveActionStart),
      shotStart: round(effectiveShotStart == null ? Math.max(sourceStart, confirmationAnchorTime - 3) : effectiveShotStart),
      finishTime: round(effectiveFinishTime),
      confirmationTime: round(confirmationAnchorTime),
      replayUsed,
      replayOnly,
      finishFrameEvidence,
    },
    visualCodes: uniqueCodes([
      ...visualCodesForRange(visualSignals, left, right),
      ...(hasMediaAction ? ["media_high_motion_goal_phase_support", "shot_sequence_support"] : []),
      ...(mediaAction && mediaAction.nearbyAudio ? ["audio_energy_spike"] : []),
    ], 32),
    anchorDiagnostics: {
      changeTime: round(stableChangeTime),
      actionAnchorTime: round(actionAnchorTime),
      searchWindow: { start: round(left), end: round(right) },
      liveWindowCount: liveWindows.length,
      shotWindowCount: shotWindows.length,
      finishWindowCount: finishWindows.length,
      decisionWindowCount: decisionWindows.length,
      mediaActionWindowCount: hasMediaAction ? 1 : 0,
      missingActionEvidence: !hasShot || !hasFinish || replayOnly,
      ocrOnlyBlocked: !hasShot || !hasFinish || replayOnly,
      bindingStrategy: null,
      bindingFallbackUsed: Boolean(recovery && recovery.bindingDiagnostics && recovery.bindingDiagnostics.fallbackUsed),
      bindingFullSourceScanUsed: false,
      bindingSampledFrameBudget: recovery && recovery.bindingDiagnostics && recovery.bindingDiagnostics.sampledFrameBudget,
      bindingMaxBackwardSeconds: recovery && recovery.bindingDiagnostics && recovery.bindingDiagnostics.maxBackwardSeconds,
      visibleGoalRecovery: publicVisibleGoalPhaseRecovery(recovery),
    },
  };
}

function buildScoreChangeDecision({ change, visualSignals, mediaSignals, metadata, index, goalNumber = null }) {
  const context = scoreChangeVisualContext(change, visualSignals, metadata, mediaSignals, index);
  const hasLiveAction = context.phaseCoverage.hasShot && !context.phaseCoverage.replayOnly;
  const hasRenderableGoalPhase = hasLiveAction && context.phaseCoverage.hasFinish;
  const isCounted = change.outcome === "counted_goal";
  const isDisallowed = change.outcome === "disallowed_goal";
  const type = isCounted && hasRenderableGoalPhase
    ? "confirmed_goal"
    : isDisallowed
      ? "disallowed_no_goal"
      : "possible_goal_unconfirmed";
  const evidenceCodes = uniqueCodes([
    ...context.visualCodes,
    ...change.reasonCodes,
    ...(isCounted ? ["scoreboard_backed_goal_sequence"] : []),
    ...(hasLiveAction ? ["shot_sequence_support", "live_shot_finish_sequence"] : []),
  ], 32);
  const missingEvidence = [];
  if (!hasLiveAction) missingEvidence.push("live_goal_phase");
  if (context.phaseCoverage.replayOnly) missingEvidence.push("live_goal_phase");
  if (isCounted && !context.phaseCoverage.hasFinish) missingEvidence.push("finish_or_stable_score_confirmation");
  if (!isCounted && !isDisallowed) missingEvidence.push("stable_counted_goal_decision");
  return normalizeDecision({
    id: `score_change_truth_${index + 1}`,
    type,
    outcome: goalOutcomeForType(type),
    confidence: round(clamp(change.confidence, 0.05, 0.98)),
    ...context,
    goalNumber,
    scoreChangeTime: change.changeTime,
    scoringSide: change.teamSide,
    cannotConfirmGoalAlone: true,
    primarySource: context.primarySource || null,
    visibleGoalRecovery: context.visibleGoalRecovery || null,
    evidenceCodes,
    missingEvidence,
    safetyFlags: uniqueCodes([
      "scorebug_truth_integration",
      "no_false_goal_from_ocr_only",
      ...(context.phaseCoverage.replayOnly ? ["replay_only_rejected_as_primary_goal"] : []),
    ], MAX_FLAGS),
    scoreBefore: change.startScore,
    scoreAfter: change.endScore,
    captionIntent: captionIntentForType(type),
    renderPriority: typePriority(type) + 700 + Math.min(250, seconds(change.changeTime) / 2),
  }, index, metadata);
}

function buildScoreChangeTruthDecisions({ scoreChanges = [], existingEvents = [], visualSignals = {}, mediaSignals = {}, metadata = {} } = {}) {
  const decisions = [];
  const rejected = [];
  let countedGoalNumber = 0;
  for (const change of Array.isArray(scoreChanges) ? scoreChanges : []) {
    if (scoreChangeCoveredByDecision(change, [...existingEvents, ...decisions])) continue;
    const goalNumber = change.outcome === "counted_goal" ? ++countedGoalNumber : null;
    const decision = buildScoreChangeDecision({
      change,
      visualSignals,
      mediaSignals,
      metadata,
      index: decisions.length + rejected.length,
      goalNumber,
    });
    if (decision.type === "confirmed_goal" || decision.type === "disallowed_no_goal" || decision.type === "disallowed_offside") {
      decisions.push(decision);
    } else {
      rejected.push(decision);
    }
  }
  return { decisions, rejected };
}

function buildGoalDecision({ event, metadata, mediaSignals, visualSignals, ocrEvidence, ocrQaCalibration, index }) {
  const duration = seconds(metadata.durationSeconds, seconds(event.end, 0));
  const start = seconds(event.start);
  const end = Math.max(start + 0.5, seconds(event.end, start + 1));
  const evidenceCodes = uniqueCodes([
    ...eventBaseCodes(event),
    ...signalCodesForRange(mediaSignals, start, end),
    ...visualCodesForRange(visualSignals, start, end),
    ...ocrCodesInRange(ocrEvidence, start, end, ocrQaCalibration),
  ], 32);
  const linkedScoreTransition = scoreTransitionInRange(ocrEvidence, start, end, ocrQaCalibration);
  const type = goalTypeForEvidence(evidenceCodes, event, ocrQaCalibration) ||
    (event.outcomeHint === "celebration_only" ? "crowd_reaction" : "neutral");
  const windows = windowSetForDecision({ event, visualSignals, duration });
  const finalType = type === "confirmed_goal" && windows.phaseCoverage && windows.phaseCoverage.replayOnly
    ? "possible_goal_unconfirmed"
    : type;
  const missingEvidence = missingEvidenceForDecision(finalType, evidenceCodes, ocrQaCalibration);
  if (windows.phaseCoverage && windows.phaseCoverage.replayOnly) missingEvidence.push("live_goal_phase");
  const safetyFlags = safetyFlagsForDecision(finalType, evidenceCodes, ocrQaCalibration);
  if (windows.phaseCoverage && windows.phaseCoverage.replayOnly) safetyFlags.push("replay_only_rejected_as_primary_goal");
  return normalizeDecision({
    id: sanitizeText(event.id || `goal_truth_${index + 1}`, 80),
    type: finalType,
    outcome: goalOutcomeForType(finalType),
    confidence: confidenceForDecision(finalType, evidenceCodes, event.confidence),
    ...windows,
    evidenceCodes,
    missingEvidence,
    safetyFlags,
    scoreBefore: linkedScoreTransition && linkedScoreTransition.scoreBefore,
    scoreAfter: linkedScoreTransition && linkedScoreTransition.scoreAfter,
    scoreChangeTime: linkedScoreTransition && linkedScoreTransition.scoreChangeTime,
    captionIntent: captionIntentForType(finalType),
    renderPriority: typePriority(finalType) + Math.min(99, seconds(event.start)),
  }, index, metadata);
}

function buildVisualDecision({ window, mediaSignals, metadata, index, occupied }) {
  const start = windowStart(window);
  const end = Math.max(start + 0.5, windowEnd(window, start + 1));
  if (occupied.some((range) => end >= range.start - 1 && start <= range.end + 1)) return null;
  const evidenceCodes = uniqueCodes([
    ...visualReasonCodesForWindow(window),
    ...signalCodesForRange(mediaSignals, start, end),
  ]);
  let type = "neutral";
  if (hasAny(evidenceCodes, ["visual_save_like_motion", "visual_keeper_action"])) type = "save";
  else if (hasAny(evidenceCodes, ["visual_foul_like_contact"])) type = "foul";
  else if (hasAny(evidenceCodes, ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal", "visual_goal_mouth"])) type = "big_chance";
  else if (hasAny(evidenceCodes, ["visual_replay_indicator", "visual_replay_angle"])) type = "replay";
  else if (hasAny(evidenceCodes, ["visual_crowd_reaction"])) type = "crowd_reaction";
  if (type === "neutral") return null;
  const duration = seconds(metadata.durationSeconds, end + 4);
  const sourceStart = round(Math.max(0, start - (type === "big_chance" ? 4 : 2.5)));
  const sourceEnd = round(Math.min(duration, end + (type === "big_chance" || type === "save" ? 6 : 4)));
  return normalizeDecision({
    id: `visual_truth_${index + 1}`,
    type,
    outcome: goalOutcomeForType(type),
    confidence: confidenceForDecision(type, evidenceCodes, window.confidence),
    sourceStart,
    sourceEnd,
    buildupWindow: { start: sourceStart, end: start },
    shotWindow: { start, end },
    payoffWindow: { start, end },
    reactionWindow: { start: end, end: sourceEnd },
    decisionWindow: null,
    evidenceCodes,
    missingEvidence: type === "big_chance" ? ["no_ball_in_net_or_goal_decision"] : [],
    safetyFlags: safetyFlagsForDecision(type, evidenceCodes, null),
    captionIntent: captionIntentForType(type),
    renderPriority: typePriority(type) + Math.min(99, start),
  }, index, metadata);
}

function clusterRecoveryEnabled(metadata = {}) {
  return metadata.goalSelectionMode === "valid_goals_only" &&
    metadata.sourceType === "youtube" &&
    metadata.allowCandidateClusterRecovery === true &&
    seconds(metadata.durationSeconds, 0) >= 120;
}

function clusterRecoveryScore(event = {}) {
  const codes = new Set(event.evidenceCodes || []);
  let score = 0;
  if (codes.has("visual_shot_contact") || codes.has("visual_ball_toward_goal")) score += 3;
  if (codes.has("visual_shot_like_motion")) score += 2;
  if (codes.has("audio_energy_spike") || codes.has("crowd_spike")) score += 3;
  if (codes.has("visual_crowd_reaction")) score += 2;
  if (codes.has("visual_replay_indicator") || codes.has("visual_replay_angle")) score += 2;
  if (codes.has("scene_change_cluster")) score += 1;
  if (hasAny(event.evidenceCodes, [...OFFSIDE_CODES, ...DISALLOWED_CODES])) score -= 100;
  return score;
}

function hasRecoverableVisibleGoalCluster(event = {}) {
  const codes = event.evidenceCodes || [];
  const hasStrongShot = hasAny(codes, ["visual_shot_contact", "visual_ball_toward_goal"]);
  const hasGoalmouth = hasAny(codes, CLUSTER_GOALMOUTH_CODES);
  const hasExplicitPayoff = hasAny(codes, ["visual_ball_in_net", "ball_in_net"]);
  const hasLiveFinishSupport = hasAny(codes, ["visual_celebration_after_shot", "visual_crowd_reaction", "crowd_spike", "audio_energy_spike"]);
  const hasConfirmationSupport = hasAny(codes, CLUSTER_CONFIRMATION_CODES);
  const hasNonGoalEvidence = hasAny(codes, CLUSTER_NON_GOAL_CODES) || hasAny(codes, [...OFFSIDE_CODES, ...DISALLOWED_CODES]);
  return hasStrongShot &&
    hasGoalmouth &&
    !hasNonGoalEvidence &&
    (hasExplicitPayoff || (hasLiveFinishSupport && hasConfirmationSupport));
}

function recoverConfirmedGoalClusters({ visualEvents = [], visualSignals = {}, metadata = {} } = {}) {
  if (!clusterRecoveryEnabled(metadata)) return [];
  const duration = seconds(metadata.durationSeconds, 0);
  const candidates = (Array.isArray(visualEvents) ? visualEvents : [])
    .filter((event) => event && ["big_chance", "possible_goal_unconfirmed", "neutral"].includes(event.type))
    .filter(hasRecoverableVisibleGoalCluster)
    .filter((event) => hasAny(event.evidenceCodes, ["audio_energy_spike", "crowd_spike", "visual_crowd_reaction", "visual_replay_indicator", "visual_replay_angle", "scene_change_cluster"]))
    .filter((event) => !hasAny(event.evidenceCodes, [...OFFSIDE_CODES, ...DISALLOWED_CODES]))
    .map((event) => ({ event, score: clusterRecoveryScore(event) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score || a.event.sourceStart - b.event.sourceStart);
  const selected = [];
  for (const item of candidates) {
    if (selected.some((selectedItem) => Math.abs(selectedItem.event.sourceStart - item.event.sourceStart) < 12)) continue;
    selected.push(item);
    if (selected.length >= MAX_CLUSTER_RECOVERY_GOALS) break;
  }
  return selected
    .sort((a, b) => a.event.sourceStart - b.event.sourceStart)
    .map(({ event, score }, index) => {
      const visibleRecovery = analyzeVisibleGoalCandidateRecovery({
        event,
        visualSignals,
        metadata,
        index,
      });
      const recovered = visibleRecovery && visibleRecovery.selected ? visibleRecovery.selected : null;
      const shotStart = recovered
        ? seconds(recovered.shotStart)
        : seconds(event.shotWindow && event.shotWindow.start, seconds(event.sourceStart));
      const sourceStart = recovered
        ? seconds(recovered.sourceStart)
        : round(Math.max(0, Math.min(event.sourceStart, shotStart - 8)));
      const finishTime = recovered
        ? seconds(recovered.finishTime)
        : seconds(event.payoffWindow && event.payoffWindow.end, seconds(event.sourceEnd));
      const sourceEnd = recovered
        ? seconds(recovered.sourceEnd)
        : round(Math.min(duration || event.sourceEnd + 10, Math.max(event.sourceEnd + 8, finishTime + 8, sourceStart + 18)));
      return normalizeDecision({
        id: `cluster_recovered_goal_${index + 1}`,
        type: "confirmed_goal",
        outcome: "confirmed_goal",
        confidence: round(clamp(0.72 + score / 100, 0.72, 0.86)),
        sourceStart,
        sourceEnd,
        buildupWindow: recovered
          ? { start: recovered.buildupStart, end: round(Math.max(recovered.buildupStart + 0.5, shotStart)) }
          : { start: sourceStart, end: round(Math.max(sourceStart + 0.5, shotStart)) },
        shotWindow: recovered
          ? { start: recovered.shotStart, end: round(Math.max(recovered.shotStart + 0.5, recovered.finishTime)) }
          : event.shotWindow,
        payoffWindow: recovered
          ? { start: round(Math.max(recovered.shotStart, recovered.finishTime - 1)), end: recovered.finishTime }
          : { start: event.payoffWindow.start, end: round(Math.max(event.payoffWindow.end, finishTime)) },
        reactionWindow: { start: round(finishTime), end: round(Math.min(duration || sourceEnd, finishTime + 4)) },
        decisionWindow: { start: round(finishTime), end: round(Math.min(duration || sourceEnd, Math.max(finishTime + 1, sourceEnd))) },
        phaseCoverage: recovered && recovered.phaseCoverage ? recovered.phaseCoverage : {
          hasBuildup: true,
          hasShot: true,
          hasFinish: true,
          hasConfirmation: true,
          liveActionStart: sourceStart,
          shotStart,
          finishTime,
          confirmationTime: finishTime,
          replayUsed: hasAny(event.evidenceCodes, ["visual_replay_indicator", "visual_replay_angle"]),
          replayOnly: false,
        },
        evidenceCodes: uniqueCodes([
          ...event.evidenceCodes,
          ...(recovered && Array.isArray(recovered.visualCodes) ? recovered.visualCodes : []),
          "goal_candidate_cluster_recovery",
          "combined_goal_confirmation",
          "live_shot_finish_sequence",
        ]),
        missingEvidence: [],
        safetyFlags: [
          "candidate_cluster_recovery",
          "no_false_goal_from_ocr_only",
          "requires_operator_review_for_production",
        ],
        visibleGoalRecovery: visibleRecovery,
        captionIntent: "confirmed_goal_caption",
        renderPriority: typePriority("confirmed_goal") + 500 - index,
      }, index, metadata);
    });
}

function matchingEventForScoreChange(change = {}, events = []) {
  const changeTime = seconds(change.changeTime);
  const startScore = normalizeScoreField(change.startScore);
  const endScore = normalizeScoreField(change.endScore);
  return (Array.isArray(events) ? events : []).find((event) => {
    if (!event || event.scoreChangeTime == null) return false;
    if (Math.abs(seconds(event.scoreChangeTime) - changeTime) > 2) return false;
    if (startScore && event.scoreBefore && normalizeScoreField(event.scoreBefore) !== startScore) return false;
    if (endScore && event.scoreAfter && normalizeScoreField(event.scoreAfter) !== endScore) return false;
    return true;
  }) || null;
}

function scoreChangeAnchorContract(change = {}, events = [], index = 0) {
  const event = matchingEventForScoreChange(change, events);
  const phase = event && event.phaseCoverage ? event.phaseCoverage : null;
  const hasLiveAction = Boolean(phase && phase.hasShot && phase.replayOnly !== true);
  const hasVisibleFinish = Boolean(phase && phase.hasFinish);
  const selectedForRender = Boolean(event && event.type === "confirmed_goal");
  const missingEvidence = uniqueCodes([
    ...(Array.isArray(event && event.missingEvidence) ? event.missingEvidence : []),
    ...(change.outcome === "counted_goal" && !selectedForRender ? ["visible_goal_phase"] : []),
    ...(change.outcome === "uncertain_review" ? ["stable_score_change"] : []),
  ], MAX_MISSING);
  const firstSeenAt = change.firstSeenAt == null
    ? (change.actionAnchorTime == null ? change.changeTime : change.actionAnchorTime)
    : change.firstSeenAt;
  const confirmedAt = change.confirmedAt == null && change.outcome === "counted_goal"
    ? change.changeTime
    : change.confirmedAt;
  const stableUntil = change.stableUntil == null && confirmedAt != null && change.persistedDuration
    ? round(seconds(confirmedAt) + seconds(change.persistedDuration))
    : change.stableUntil;
  return {
    id: sanitizeText(`anchor_${change.id || index + 1}`, 96),
    scoreBefore: normalizeScoreField(change.startScore),
    scoreAfter: normalizeScoreField(change.endScore),
    firstSeenAt: firstSeenAt == null ? null : round(seconds(firstSeenAt)),
    confirmedAt: confirmedAt == null ? null : round(seconds(confirmedAt)),
    stableUntil: stableUntil == null ? null : round(seconds(stableUntil)),
    reverted: Boolean(change.reverted),
    revertedAt: change.revertedAt == null ? null : round(seconds(change.revertedAt)),
    confidence: round(clamp(change.confidence, 0, 1)),
    source: "scoreboard_ocr",
    roiId: change.roiId ? sanitizeText(change.roiId, 80) : null,
    layoutId: change.layoutId ? sanitizeText(change.layoutId, 80) : null,
    outcome: ["counted_goal", "disallowed_goal", "uncertain_review"].includes(change.outcome)
      ? change.outcome
      : "uncertain_review",
    selectedForRender,
    linkedEventId: event ? sanitizeText(event.id, 80) : null,
    linkedEventType: event ? sanitizeText(event.type, 48) : null,
    hasLiveAction,
    hasVisibleFinish,
    replayOnly: Boolean(phase && phase.replayOnly),
    missingEvidence,
    evidenceCodes: uniqueCodes([
      ...(Array.isArray(change.evidenceCodes) ? change.evidenceCodes : []),
      ...(Array.isArray(change.reasonCodes) ? change.reasonCodes : []),
      ...(Array.isArray(event && event.evidenceCodes) ? event.evidenceCodes : []),
    ], 16),
  };
}

function validateMatchEventTruthOutput(output, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const scoreTimelineObservations = (Array.isArray(output.scoreTimelineObservations) ? output.scoreTimelineObservations : [])
    .map((item, index) => normalizeScoreTimelineObservation(item, index, output.ocrQaCalibration))
    .slice(0, MAX_EVENTS);
  const scoreChanges = (Array.isArray(output.scoreChanges) ? output.scoreChanges : [])
    .map((change, index) => ({
      id: sanitizeText(change.id || `score_change_${index + 1}`, 80),
      startScore: normalizeScoreField(change.startScore),
      endScore: normalizeScoreField(change.endScore),
      firstSeenAt: change.firstSeenAt == null ? null : round(seconds(change.firstSeenAt)),
      confirmedAt: change.confirmedAt == null ? null : round(seconds(change.confirmedAt)),
      stableUntil: change.stableUntil == null ? null : round(seconds(change.stableUntil)),
      changeTime: round(seconds(change.changeTime)),
      actionAnchorTime: change.actionAnchorTime == null ? null : round(seconds(change.actionAnchorTime)),
      hasPendingObservation: Boolean(change.hasPendingObservation),
      strongAuthority: Boolean(change.strongAuthority),
      source: sanitizeText(change.source || "scoreboard_ocr", 60) === "scoreboard_ocr" ? "scoreboard_ocr" : "scoreboard_ocr",
      roiId: change.roiId ? sanitizeText(change.roiId, 80) : null,
      layoutId: change.layoutId ? sanitizeText(change.layoutId, 80) : null,
      teamSide: sanitizeText(change.teamSide || "unknown", 16),
      scoreDelta: Math.max(0, Math.min(3, Math.round(Number(change.scoreDelta || 0)))),
      confidence: round(clamp(change.confidence, 0, 1)),
      persistedDuration: round(clamp(change.persistedDuration, 0, 300)),
      reverted: Boolean(change.reverted),
      revertedAt: change.revertedAt == null ? null : round(seconds(change.revertedAt)),
      outcome: ["counted_goal", "disallowed_goal", "uncertain_review"].includes(change.outcome)
        ? change.outcome
        : "uncertain_review",
      evidenceCodes: uniqueCodes(change.evidenceCodes || change.reasonCodes, 12),
      reasonCodes: uniqueCodes(change.reasonCodes, 12),
    }))
    .filter((change) => change.startScore && change.endScore && change.scoreDelta === 1)
    .slice(0, MAX_EVENTS);
  const events = (Array.isArray(output.events) ? output.events : [])
    .map((event, index) => normalizeDecision(event, index, metadata))
    .sort((a, b) => b.renderPriority - a.renderPriority || a.sourceStart - b.sourceStart)
    .slice(0, MAX_EVENTS);
  const rejectedEvents = (Array.isArray(output.rejectedEvents) ? output.rejectedEvents : [])
    .map((event, index) => normalizeDecision(event, index, metadata))
    .slice(0, MAX_EVENTS);
  const confirmedGoalCount = events.filter((event) => event.type === "confirmed_goal").length;
  const disallowedGoalCount = events.filter((event) => event.type === "disallowed_offside" || event.type === "disallowed_no_goal").length;
  const possibleGoalCount = events.filter((event) => event.type === "possible_goal_unconfirmed").length;
  const allEvents = [...events, ...rejectedEvents];
  const scoreChangeAnchors = scoreChanges.map((change, index) => scoreChangeAnchorContract(change, allEvents, index));
  const scoreChangeDecisionEvents = allEvents.filter((event) => /^score_change_truth_/.test(event.id));
  const scoreChangeEvidenceEvents = allEvents.filter((event) => (
    event.evidenceCodes.includes("scoreboard_ocr_score_change") &&
    event.evidenceCodes.includes("scoreboard_temporal_consistency")
  ));
  const scoreChangeAnchorEvents = scoreChangeEvidenceEvents.length ? scoreChangeEvidenceEvents : scoreChangeDecisionEvents;
  const scoreboardSelectedGoals = events.filter((event) => (
    event.type === "confirmed_goal" &&
    event.evidenceCodes.includes("scoreboard_ocr_score_change") &&
    (event.evidenceCodes.includes("scoreboard_backed_goal_sequence") ||
      event.evidenceCodes.includes("live_shot_finish_sequence"))
  ));
  const scoreChangeAnchorsWithLiveAction = scoreChangeAnchors.filter((anchor) => (
    anchor.hasLiveAction &&
    anchor.replayOnly !== true
  ));
  const replayOnlyCount = allEvents.filter((event) => (
    event.replayOnly === true ||
    (event.phaseCoverage && event.phaseCoverage.replayOnly === true)
  )).length;
  const celebrationOnlyCount = allEvents.filter((event) => (
    event.type === "crowd_reaction" ||
    event.evidenceCodes.includes("visual_celebration_after_shot") ||
    event.evidenceCodes.includes("visual_celebration_after_whistle")
  )).length;
  const missingActionEvidenceCount = scoreChangeAnchorEvents.filter((event) => (
    event.missingEvidence.includes("live_goal_phase")
  )).length;
  const ocrOnlyBlockedCount = scoreChangeAnchorEvents.filter((event) => (
    event.cannotConfirmGoalAlone &&
    event.type !== "confirmed_goal" &&
    event.type !== "disallowed_offside" &&
    event.type !== "disallowed_no_goal"
  )).length;
  const lateCutoff = Math.max(0, seconds(metadata.durationSeconds, 0) * 0.66);
  const countedGoalEventCount = scoreChanges.filter((change) => change.outcome === "counted_goal").length;
  const disallowedGoalEventCount = scoreChanges.filter((change) => change.outcome === "disallowed_goal").length;
  const stableScoreChangeAnchorCount = scoreChangeAnchors.filter((anchor) => anchor.outcome === "counted_goal" && !anchor.reverted).length;
  const revertedScoreChangeAnchorCount = scoreChangeAnchors.filter((anchor) => anchor.reverted || anchor.outcome === "disallowed_goal").length;
  const anchorsLinkedToGoalPhaseCount = scoreChangeAnchors.filter((anchor) => anchor.hasLiveAction && anchor.hasVisibleFinish && !anchor.replayOnly).length;
  const anchorsMissingVisualSupportCount = scoreChangeAnchors.filter((anchor) => anchor.outcome === "counted_goal" && !anchor.selectedForRender).length;
  const uncertainReviewItems = [
    ...scoreChanges.filter((change) => change.outcome === "uncertain_review").map((change) => `score_change_${change.id}`),
    ...rejectedEvents.filter((event) => event.type === "possible_goal_unconfirmed").map((event) => event.id),
  ].slice(0, MAX_MISSING);
  const missedGoalReasons = [
    ...(countedGoalEventCount > confirmedGoalCount ? ["counted_score_change_not_selected"] : []),
    ...(scoreTimelineObservations.some((item) => item.reasonCodes.includes("scoreboard_ocr_ambiguous")) ? ["ambiguous_scorebug_observation"] : []),
    ...(rejectedEvents.some((event) => event.missingEvidence.includes("live_goal_phase")) ? ["missing_live_goal_phase"] : []),
  ].slice(0, MAX_MISSING);
  const decoderStatuses = scoreTimelineObservations.reduce((acc, item) => {
    const status = sanitizeText(item.decoderStatus || "unknown", 40);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    schemaVersion: MATCH_EVENT_TRUTH_VERSION,
    providerMode: sanitizeText(output.providerMode || "deterministic-match-event-truth", 60),
    fallbackUsed: Boolean(output.fallbackUsed),
    ocrQaCalibration: output.ocrQaCalibration && typeof output.ocrQaCalibration === "object"
      ? {
          status: sanitizeText(output.ocrQaCalibration.status || "missing", 32),
          usable: Boolean(output.ocrQaCalibration.usable),
          decisionSupportLevel: sanitizeText(output.ocrQaCalibration.decisionSupportLevel || "ignore", 32),
          goalEvidencePolicy: "support_only",
          goalDecisionAllowed: false,
          noFalseGoalFromOcrOnly: true,
        }
      : null,
    events,
    rejectedEvents,
    scoreTimelineObservations,
    scoreChanges,
    scoreChangeAnchors,
    summary: {
      eventCount: events.length,
      confirmedGoalCount,
      disallowedGoalCount,
      possibleGoalCount,
      chanceOrSaveCount: events.filter((event) => event.type === "big_chance" || event.type === "save").length,
      rejectedEventCount: rejectedEvents.length,
      lateConfirmedGoalCount: events.filter((event) => event.type === "confirmed_goal" && event.sourceStart >= lateCutoff).length,
      scoreTimelineObservationCount: scoreTimelineObservations.length,
      scoreChangeCount: scoreChanges.length,
      countedGoalEventCount,
      disallowedGoalEventCount,
      selectedGoalCount: confirmedGoalCount,
      scoreChangeAnchorsFound: scoreChanges.length,
      stableScoreChangeAnchorCount,
      revertedScoreChangeAnchorCount,
      anchorsLinkedToGoalPhaseCount,
      anchorsMissingVisualSupportCount,
      anchorsWithLiveActionEvidence: scoreChangeAnchorsWithLiveAction.length,
      anchorsRejected: Math.max(0, countedGoalEventCount - scoreboardSelectedGoals.length),
      selectedCountedGoals: scoreboardSelectedGoals.length,
      replayOnlyCount,
      celebrationOnlyCount,
      ocrOnlyBlockedCount,
      missingActionEvidenceCount,
      uncertainReviewItemCount: uncertainReviewItems.length,
      uncertainReviewItems,
      missedGoalReasons,
      decoderStatusSummary: decoderStatuses,
      noFalseGoalFromOcrOnly: events.every((event) => (
        event.type !== "confirmed_goal" ||
        !event.evidenceCodes.includes("scoreboard_ocr_score_change") ||
        event.evidenceCodes.includes("ball_in_net") ||
        event.evidenceCodes.includes("visual_ball_in_net") ||
        event.evidenceCodes.includes("scoreboard_backed_goal_sequence")
      )) ? 1 : 0,
      ocrQaSupportStatus: output.ocrQaCalibration && output.ocrQaCalibration.usable ? "usable" : "ignored",
    },
  };
}

function analyzeMatchEventTruth(input = {}) {
  const metadata = input.metadata || {};
  const visualSignals = validateVisualSignals(
    input.visualSignals || { providerMode: "match-event-truth-empty", fallbackUsed: true, windows: [] },
    metadata,
  );
  const ocrQaCalibration = normalizeOcrQaCalibrationInput(input.ocrQaCalibration || (input.goalEvidence && input.goalEvidence.ocrQaCalibration));
  const ocrEvidence = normalizeOcrEvidence(
    input.ocrEvidence || input.scoreboardOcr || (input.goalEvidence && input.goalEvidence.ocrEvidence),
    metadata,
  );
  const scoreTimelineObservations = ocrEvidence.map((item, index) => normalizeScoreTimelineObservation(item, index, ocrQaCalibration));
  const scoreChanges = normalizeScoreChanges(ocrEvidence, ocrQaCalibration, metadata);
  const goalEvents = Array.isArray(input.goalEvidence && input.goalEvidence.events) ? input.goalEvidence.events : [];
  const events = goalEvents.map((event, index) => buildGoalDecision({
    event,
    metadata,
    mediaSignals: input.mediaSignals,
    visualSignals,
    ocrEvidence,
    ocrQaCalibration,
    index,
  }));
  const scoreChangeTruth = buildScoreChangeTruthDecisions({
    scoreChanges,
    existingEvents: events,
    visualSignals,
    mediaSignals: input.mediaSignals,
    metadata,
  });
  const occupied = events.map((event) => ({ start: event.sourceStart, end: event.sourceEnd }));
  const visualEvents = (Array.isArray(visualSignals.windows) ? visualSignals.windows : [])
    .map((window, index) => buildVisualDecision({ window, mediaSignals: input.mediaSignals, metadata, index, occupied }))
    .filter(Boolean)
    .slice(0, 10);
  const recoveryCandidates = [...events, ...visualEvents];
  const recoveryEvents = [...events, ...scoreChangeTruth.decisions].some((event) => event.type === "confirmed_goal")
    ? []
    : recoverConfirmedGoalClusters({ visualEvents: recoveryCandidates, visualSignals, metadata });
  const selectedVisualEvents = metadata.goalSelectionMode === "valid_goals_only" ? [] : visualEvents;
  const selectedEvents = [...events, ...scoreChangeTruth.decisions, ...recoveryEvents, ...selectedVisualEvents].filter((event) => event.type !== "neutral");
  const rejectedEvents = [...events, ...scoreChangeTruth.rejected, ...visualEvents].filter((event) => (
    event.type === "possible_goal_unconfirmed" ||
    event.type === "crowd_reaction" ||
    event.missingEvidence.length > 0
  ));
  return validateMatchEventTruthOutput({
    providerMode: "deterministic-match-event-truth",
    fallbackUsed: Boolean(input.fallbackUsed),
    ocrQaCalibration,
    events: selectedEvents,
    rejectedEvents,
    scoreTimelineObservations,
    scoreChanges,
  }, metadata);
}

function publicMatchEventTruth(matchEventTruth) {
  const safe = matchEventTruth && typeof matchEventTruth === "object" ? matchEventTruth : {};
  const normalized = validateMatchEventTruthOutput({
    providerMode: safe.providerMode || "deterministic-match-event-truth",
    fallbackUsed: Boolean(safe.fallbackUsed),
    ocrQaCalibration: safe.ocrQaCalibration,
    events: Array.isArray(safe.events)
      ? safe.events
      : Array.isArray(safe.selectedEvents)
        ? safe.selectedEvents
        : [],
    rejectedEvents: Array.isArray(safe.rejectedEvents) ? safe.rejectedEvents : [],
    scoreTimelineObservations: Array.isArray(safe.scoreTimelineObservations) ? safe.scoreTimelineObservations : [],
    scoreChanges: Array.isArray(safe.scoreChanges) ? safe.scoreChanges : [],
  }, { durationSeconds: Number.MAX_SAFE_INTEGER });
  return {
    schemaVersion: normalized.schemaVersion,
    providerMode: normalized.providerMode,
    fallbackUsed: normalized.fallbackUsed,
    ocrQaCalibration: normalized.ocrQaCalibration,
    summary: publicSummary(normalized.summary, safe.summary),
    selectedEvents: normalized.events.map(publicDecision),
    rejectedEvents: normalized.rejectedEvents.map(publicDecision),
    scoreTimelineObservations: normalized.scoreTimelineObservations.map(publicScoreObservation),
    scoreChanges: normalized.scoreChanges.map(publicScoreChange),
    scoreChangeAnchors: normalized.scoreChangeAnchors.map(publicScoreChangeAnchor),
  };
}

function publicSummary(normalizedSummary = {}, originalSummary = {}) {
  const original = originalSummary && typeof originalSummary === "object" && !Array.isArray(originalSummary)
    ? originalSummary
    : {};
  const numeric = (key) => {
    const value = Number(Object.prototype.hasOwnProperty.call(original, key) ? original[key] : normalizedSummary[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    eventCount: numeric("eventCount"),
    confirmedGoalCount: numeric("confirmedGoalCount"),
    disallowedGoalCount: numeric("disallowedGoalCount"),
    possibleGoalCount: numeric("possibleGoalCount"),
    chanceOrSaveCount: numeric("chanceOrSaveCount"),
    rejectedEventCount: numeric("rejectedEventCount"),
    lateConfirmedGoalCount: numeric("lateConfirmedGoalCount"),
    scoreTimelineObservationCount: numeric("scoreTimelineObservationCount"),
    scoreChangeCount: numeric("scoreChangeCount"),
    countedGoalEventCount: numeric("countedGoalEventCount"),
    disallowedGoalEventCount: numeric("disallowedGoalEventCount"),
    selectedGoalCount: numeric("selectedGoalCount"),
    scoreChangeAnchorsFound: numeric("scoreChangeAnchorsFound"),
    stableScoreChangeAnchorCount: numeric("stableScoreChangeAnchorCount"),
    revertedScoreChangeAnchorCount: numeric("revertedScoreChangeAnchorCount"),
    anchorsLinkedToGoalPhaseCount: numeric("anchorsLinkedToGoalPhaseCount"),
    anchorsMissingVisualSupportCount: numeric("anchorsMissingVisualSupportCount"),
    anchorsWithLiveActionEvidence: numeric("anchorsWithLiveActionEvidence"),
    anchorsRejected: numeric("anchorsRejected"),
    selectedCountedGoals: numeric("selectedCountedGoals"),
    replayOnlyCount: numeric("replayOnlyCount"),
    celebrationOnlyCount: numeric("celebrationOnlyCount"),
    ocrOnlyBlockedCount: numeric("ocrOnlyBlockedCount"),
    missingActionEvidenceCount: numeric("missingActionEvidenceCount"),
    uncertainReviewItemCount: numeric("uncertainReviewItemCount"),
    missedGoalReasons: uniqueCodes(original.missedGoalReasons || normalizedSummary.missedGoalReasons, MAX_MISSING),
    decoderStatusSummary: Object.fromEntries(Object.entries(
      original.decoderStatusSummary && typeof original.decoderStatusSummary === "object"
        ? original.decoderStatusSummary
        : normalizedSummary.decoderStatusSummary || {},
    )
      .map(([key, value]) => [sanitizeText(key, 40), Math.max(0, Math.round(Number(value || 0)))])
      .filter(([key]) => key)),
    noFalseGoalFromOcrOnly: numeric("noFalseGoalFromOcrOnly"),
    ocrQaSupportStatus: sanitizeText(original.ocrQaSupportStatus || normalizedSummary.ocrQaSupportStatus || "ignored", 32),
  };
}

function publicScoreObservation(item = {}) {
  return {
    id: sanitizeText(item.id, 80),
    timestamp: Number(item.timestamp || 0),
    homeScore: Number.isInteger(item.homeScore) ? item.homeScore : null,
    awayScore: Number.isInteger(item.awayScore) ? item.awayScore : null,
    scoreBefore: normalizeScoreField(item.scoreBefore),
    scoreAfter: normalizeScoreField(item.scoreAfter),
    confidence: round(clamp(item.confidence, 0, 1)),
    source: sanitizeText(item.source || "ocr", 60),
    decoderStatus: sanitizeText(item.decoderStatus || "unknown", 40),
    imageSegmentationStatus: sanitizeText(item.imageSegmentationStatus || "unknown", 40),
    isStable: Boolean(item.isStable),
    reasonCodes: uniqueCodes(item.reasonCodes, 12),
    status: sanitizeText(item.status || "unknown", 40),
  };
}

function publicScoreChange(change = {}) {
  return {
    id: sanitizeText(change.id, 80),
    startScore: normalizeScoreField(change.startScore),
    endScore: normalizeScoreField(change.endScore),
    firstSeenAt: change.firstSeenAt == null ? null : Number(change.firstSeenAt),
    confirmedAt: change.confirmedAt == null ? null : Number(change.confirmedAt),
    stableUntil: change.stableUntil == null ? null : Number(change.stableUntil),
    changeTime: Number(change.changeTime || 0),
    actionAnchorTime: change.actionAnchorTime == null ? null : Number(change.actionAnchorTime),
    hasPendingObservation: Boolean(change.hasPendingObservation),
    strongAuthority: Boolean(change.strongAuthority),
    source: "scoreboard_ocr",
    roiId: change.roiId ? sanitizeText(change.roiId, 80) : null,
    layoutId: change.layoutId ? sanitizeText(change.layoutId, 80) : null,
    teamSide: sanitizeText(change.teamSide || "unknown", 16),
    scoreDelta: Number(change.scoreDelta || 0),
    confidence: round(clamp(change.confidence, 0, 1)),
    persistedDuration: Number(change.persistedDuration || 0),
    reverted: Boolean(change.reverted),
    revertedAt: change.revertedAt == null ? null : Number(change.revertedAt),
    outcome: sanitizeText(change.outcome || "uncertain_review", 32),
    evidenceCodes: uniqueCodes(change.evidenceCodes, 12),
    reasonCodes: uniqueCodes(change.reasonCodes, 12),
  };
}

function publicScoreChangeAnchor(anchor = {}) {
  return {
    id: sanitizeText(anchor.id, 96),
    scoreBefore: normalizeScoreField(anchor.scoreBefore),
    scoreAfter: normalizeScoreField(anchor.scoreAfter),
    firstSeenAt: anchor.firstSeenAt == null ? null : Number(anchor.firstSeenAt),
    confirmedAt: anchor.confirmedAt == null ? null : Number(anchor.confirmedAt),
    stableUntil: anchor.stableUntil == null ? null : Number(anchor.stableUntil),
    reverted: Boolean(anchor.reverted),
    revertedAt: anchor.revertedAt == null ? null : Number(anchor.revertedAt),
    confidence: round(clamp(anchor.confidence, 0, 1)),
    source: "scoreboard_ocr",
    roiId: anchor.roiId ? sanitizeText(anchor.roiId, 80) : null,
    layoutId: anchor.layoutId ? sanitizeText(anchor.layoutId, 80) : null,
    outcome: sanitizeText(anchor.outcome || "uncertain_review", 32),
    selectedForRender: Boolean(anchor.selectedForRender),
    linkedEventId: anchor.linkedEventId ? sanitizeText(anchor.linkedEventId, 80) : null,
    linkedEventType: anchor.linkedEventType ? sanitizeText(anchor.linkedEventType, 48) : null,
    hasLiveAction: Boolean(anchor.hasLiveAction),
    hasVisibleFinish: Boolean(anchor.hasVisibleFinish),
    replayOnly: Boolean(anchor.replayOnly),
    missingEvidence: uniqueCodes(anchor.missingEvidence, MAX_MISSING),
    evidenceCodes: uniqueCodes(anchor.evidenceCodes, 16),
  };
}

function publicDecision(event) {
  return {
    id: sanitizeText(event.id, 80),
    type: event.type,
    eventType: event.eventType || truthEventTypeForMatchType(event.type),
    truthStatus: event.truthStatus || truthStatusForMatchType(event.type),
    outcome: event.outcome,
    confidence: event.confidence,
    sourceStart: event.sourceStart,
    sourceEnd: event.sourceEnd,
    decisionWindowStart: event.decisionWindowStart,
    decisionWindowEnd: event.decisionWindowEnd,
    teams: event.teams || null,
    goalNumber: event.goalNumber || null,
    scoreBefore: event.scoreBefore || null,
    scoreAfter: event.scoreAfter || null,
    scoreChangeTime: event.scoreChangeTime == null ? null : Number(event.scoreChangeTime),
    scoringSide: event.scoringSide || "unknown",
    cannotConfirmGoalAlone: Boolean(event.cannotConfirmGoalAlone),
    primarySource: event.primarySource || null,
    visibleGoalRecovery: event.visibleGoalRecovery || null,
    anchorDiagnostics: event.anchorDiagnostics || null,
    evidence: Array.isArray(event.evidence) ? event.evidence : event.evidenceCodes,
    disqualifiers: Array.isArray(event.disqualifiers) ? event.disqualifiers : [],
    buildupWindow: event.buildupWindow,
    shotWindow: event.shotWindow,
    payoffWindow: event.payoffWindow,
    reactionWindow: event.reactionWindow,
    decisionWindow: event.decisionWindow,
    phaseCoverage: event.phaseCoverage,
    truth: event.truth || truthContractForDecision({
      type: event.type,
      outcome: event.outcome,
      confidence: event.confidence,
      sourceStart: event.sourceStart,
      sourceEnd: event.sourceEnd,
      phaseCoverage: event.phaseCoverage,
      evidenceCodes: event.evidenceCodes,
    }),
    shotStart: event.shotStart,
    finishTime: event.finishTime,
    confirmationTime: event.confirmationTime,
    replayUsed: Boolean(event.replayUsed),
    replayOnly: Boolean(event.replayOnly),
    evidenceCodes: event.evidenceCodes,
    missingEvidence: event.missingEvidence,
    safetyFlags: event.safetyFlags,
    captionIntent: event.captionIntent,
    renderPriority: event.renderPriority,
  };
}

module.exports = {
  MATCH_EVENT_TYPES,
  MATCH_EVENT_OUTCOMES,
  analyzeMatchEventTruth,
  publicMatchEventTruth,
  validateMatchEventTruthOutput,
};
