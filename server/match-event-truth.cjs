const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence, normalizeOcrQaCalibrationInput } = require("./goal-evidence-provider.cjs");
const { validateVisualSignals, visualReasonCodesForWindow } = require("./vision.cjs");

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
  "scoreboard_backed_goal_sequence",
]);
const LIVE_GOAL_PHASE_CODES = Object.freeze([
  ...SHOT_CODES,
  "visual_ball_visible",
  "visual_fast_break",
  "visual_goal_area",
  "visual_goal_mouth",
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
const GOAL_PHASE_LOOKBACK_SECONDS = 22;
const GOAL_PHASE_MIN_PRE_SHOT_SECONDS = 10;
const GOAL_PHASE_MAX_PRE_SHOT_SECONDS = 15;
const SCORE_CHANGE_MIN_CONFIDENCE = 0.72;
const SCORE_CHANGE_STRONG_CONFIDENCE = 0.86;
const SCORE_CHANGE_REVERT_LOOKAHEAD_SECONDS = 28;
const SCORE_CHANGE_CONFIRMATION_SECONDS = 8;
const SCORE_CHANGE_POST_SECONDS = 4;

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
  return {
    hasBuildup: raw.hasBuildup == null ? sourceStart <= shotStart - 6 : Boolean(raw.hasBuildup),
    hasShot: raw.hasShot == null ? hasAny(evidenceCodes, SHOT_CODES) : Boolean(raw.hasShot),
    hasFinish: raw.hasFinish == null ? hasAny(evidenceCodes, GOAL_FINISH_CODES) : Boolean(raw.hasFinish),
    hasConfirmation: raw.hasConfirmation == null
      ? context.type === "confirmed_goal" || hasAny(evidenceCodes, CONFIRMED_SUPPORT_CODES)
      : Boolean(raw.hasConfirmation),
    liveActionStart: normalizePhaseTimestamp(raw.liveActionStart, sourceStart, sourceEnd, sourceStart),
    shotStart,
    finishTime,
    confirmationTime,
    replayUsed,
    replayOnly,
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
      visualFinish: codes.has("ball_in_net") || codes.has("visual_ball_in_net") || codes.has("scoreboard_backed_goal_sequence"),
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
  const liveActionStart = firstWindowStart(liveWindowsBeforeReplay, firstWindowTime(contextWindows, LIVE_GOAL_PHASE_CODES, start));
  const shotStart = firstWindowTime(liveWindowsBeforeReplay, SHOT_CODES, firstWindowTime(contextWindows, SHOT_CODES, start));
  const payoffStart = firstWindowTime(contextWindows, PAYOFF_CODES, Math.min(end, shotStart + 2));
  const payoffEnd = lastWindowTime(contextWindows, PAYOFF_CODES, end);
  const decisionStart = firstWindowTime(contextWindows, DECISION_CODES, null);
  const hasLivePhase = hasLiveActionBeforeReplay(contextWindows, replayStart) || (!hasAny(eventCodes, REPLAY_SUPPORT_CODES) && hasAny(eventCodes, SHOT_CODES));
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
  const phaseCoverage = {
    hasBuildup: !replayOnly && sourceStart <= shotStart - 6,
    hasShot: !replayOnly && (hasAny(eventCodes, SHOT_CODES) || liveWindowsBeforeReplay.some((window) => hasAny(visualReasonCodesForWindow(window), SHOT_CODES))),
    hasFinish: hasAny(eventCodes, GOAL_FINISH_CODES) || hasAny(visualCodesForRange(visualSignals, sourceStart, boundedSourceEnd), GOAL_FINISH_CODES),
    hasConfirmation: decisionStart != null || hasAny(eventCodes, CONFIRMED_SUPPORT_CODES),
    liveActionStart: round(liveActionStart),
    shotStart: round(shotStart),
    finishTime: round(payoffEnd),
    confirmationTime: decisionStart == null ? null : round(decisionStart),
    replayUsed,
    replayOnly,
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
    scoreBefore: normalizeScoreField(decision.scoreBefore),
    scoreAfter: normalizeScoreField(decision.scoreAfter),
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
  if (item.scoreReverted || status === "goal_removed") codes.push("scoreboard_ocr_goal_removed");
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
    temporalConsistency: Boolean(item.temporalConsistency),
    ambiguous: Boolean(item.ambiguous),
  };
}

function scoreChangeAuthority(item = {}, calibration = null) {
  const confidence = Number(item.confidence || 0);
  const calibrated = Boolean(calibration && calibration.usable && calibration.decisionSupportLevel === "strong");
  const decoderBacked = safeDecoderStatus(item) === "decoded" ||
    safeImageSegmentationStatus(item) === "readable" ||
    /scorebug_digit_reader|digit_scorebug/i.test(String(item.source || ""));
  return Boolean(item.temporalConsistency) &&
    !item.ambiguous &&
    (calibrated || (decoderBacked && confidence >= SCORE_CHANGE_STRONG_CONFIDENCE));
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
      changes.push({
        id: sanitizeText(item.id || `score_change_${changes.length + 1}`, 80),
        startScore: before.text,
        endScore: after.text,
        changeTime: round(seconds(item.timestamp)),
        teamSide: scoreTeamSide(before, after),
        scoreDelta: scoreDelta(before, after),
        confidence: round(clamp(item.confidence, 0, 1)),
        persistedDuration: 0,
        reverted: false,
        revertedAt: null,
        outcome: "uncertain_review",
        reasonCodes: uniqueCodes(["scoreboard_ocr_ambiguous"], 8),
      });
      continue;
    }
    if (direction === "decrease" || item.scoreReverted) {
      changes.push({
        id: sanitizeText(item.id || `score_revert_${changes.length + 1}`, 80),
        startScore: before.text,
        endScore: after.text,
        changeTime: round(seconds(item.timestamp)),
        teamSide: scoreTeamSide(before, after),
        scoreDelta: scoreDelta(before, after),
        confidence: round(clamp(item.confidence, 0, 1)),
        persistedDuration: 0,
        reverted: true,
        revertedAt: round(seconds(item.timestamp)),
        outcome: "disallowed_goal",
        reasonCodes: uniqueCodes(["scoreboard_ocr_goal_removed", "scoreboard_temporal_consistency"], 8),
      });
      continue;
    }
    const revert = matchingRevertForScoreChange(item, stableItems);
    if (revert && revert.id) consumedReverts.add(revert.id);
    changes.push({
      id: sanitizeText(item.id || `score_change_${changes.length + 1}`, 80),
      startScore: before.text,
      endScore: after.text,
      changeTime: round(seconds(item.timestamp)),
      teamSide: scoreTeamSide(before, after),
      scoreDelta: scoreDelta(before, after),
      confidence: round(clamp(item.confidence, 0, 1)),
      persistedDuration: scoreChangePersistedDuration(item, revert, duration),
      reverted: Boolean(revert),
      revertedAt: revert ? round(seconds(revert.timestamp)) : null,
      outcome: revert ? "disallowed_goal" : "counted_goal",
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
  return (Array.isArray(decisions) ? decisions : []).some((decision) => (
    changeTime >= seconds(decision.sourceStart) - 2 &&
    changeTime <= seconds(decision.sourceEnd) + 2 &&
    ["confirmed_goal", "disallowed_offside", "disallowed_no_goal"].includes(decision.type)
  ));
}

function scoreChangeVisualContext(change = {}, visualSignals = {}, metadata = {}) {
  const changeTime = seconds(change.changeTime);
  const duration = seconds(metadata.durationSeconds, changeTime + SCORE_CHANGE_POST_SECONDS);
  const left = Math.max(0, changeTime - GOAL_PHASE_LOOKBACK_SECONDS);
  const right = Math.min(duration || changeTime + SCORE_CHANGE_POST_SECONDS, changeTime + SCORE_CHANGE_POST_SECONDS);
  const contextWindows = sortedWindows(windowsInRange(visualSignals, left, right, 2));
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
  const finishTime = lastWindowTime(finishWindows, GOAL_FINISH_CODES, changeTime);
  const decisionStart = firstWindowStart(decisionWindows, changeTime);
  const replayUsed = contextWindows.some((window) => hasAny(visualReasonCodesForWindow(window), REPLAY_SUPPORT_CODES));
  const replayOnly = replayUsed && !liveWindows.length;
  const hasShot = shotStart != null;
  const hasFinish = finishWindows.length > 0 || change.outcome === "counted_goal";
  const sourceStart = hasShot
    ? round(Math.max(0, Math.min(liveActionStart == null ? shotStart : liveActionStart, shotStart - GOAL_PHASE_MIN_PRE_SHOT_SECONDS)))
    : round(Math.max(0, changeTime - GOAL_PHASE_MIN_PRE_SHOT_SECONDS));
  const sourceEnd = round(Math.min(duration || changeTime + SCORE_CHANGE_POST_SECONDS, Math.max(changeTime + 2, finishTime + 3, sourceStart + 8)));
  return {
    sourceStart,
    sourceEnd,
    buildupWindow: { start: sourceStart, end: round(Math.max(sourceStart + 0.5, shotStart == null ? changeTime : shotStart)) },
    shotWindow: { start: round(shotStart == null ? Math.max(sourceStart, changeTime - 3) : shotStart), end: round(Math.max((shotStart == null ? changeTime - 2 : shotStart) + 0.5, finishTime)) },
    payoffWindow: { start: round(Math.max(sourceStart, Math.min(finishTime, changeTime))), end: round(Math.max(finishTime + 0.5, changeTime)) },
    reactionWindow: { start: round(changeTime), end: round(Math.min(duration || changeTime + SCORE_CHANGE_POST_SECONDS, changeTime + SCORE_CHANGE_POST_SECONDS)) },
    decisionWindow: { start: round(decisionStart == null ? changeTime : decisionStart), end: round(Math.min(duration || changeTime + SCORE_CHANGE_POST_SECONDS, Math.max(changeTime + 1, sourceEnd))) },
    phaseCoverage: {
      hasBuildup: hasShot && sourceStart <= shotStart - 6,
      hasShot,
      hasFinish,
      hasConfirmation: true,
      liveActionStart: round(liveActionStart == null ? sourceStart : liveActionStart),
      shotStart: round(shotStart == null ? Math.max(sourceStart, changeTime - 3) : shotStart),
      finishTime: round(finishTime),
      confirmationTime: round(changeTime),
      replayUsed,
      replayOnly,
    },
    visualCodes: visualCodesForRange(visualSignals, left, right),
  };
}

function buildScoreChangeDecision({ change, visualSignals, metadata, index }) {
  const context = scoreChangeVisualContext(change, visualSignals, metadata);
  const hasLiveAction = context.phaseCoverage.hasShot && !context.phaseCoverage.replayOnly;
  const isCounted = change.outcome === "counted_goal";
  const isDisallowed = change.outcome === "disallowed_goal";
  const type = isCounted && hasLiveAction
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
  if (!isCounted && !isDisallowed) missingEvidence.push("stable_counted_goal_decision");
  return normalizeDecision({
    id: `score_change_truth_${index + 1}`,
    type,
    outcome: goalOutcomeForType(type),
    confidence: round(clamp(change.confidence, 0.05, 0.98)),
    ...context,
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

function buildScoreChangeTruthDecisions({ scoreChanges = [], existingEvents = [], visualSignals = {}, metadata = {} } = {}) {
  const decisions = [];
  const rejected = [];
  for (const change of Array.isArray(scoreChanges) ? scoreChanges : []) {
    if (scoreChangeCoveredByDecision(change, [...existingEvents, ...decisions])) continue;
    const decision = buildScoreChangeDecision({
      change,
      visualSignals,
      metadata,
      index: decisions.length + rejected.length,
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

function recoverConfirmedGoalClusters({ visualEvents = [], metadata = {} } = {}) {
  if (!clusterRecoveryEnabled(metadata)) return [];
  const duration = seconds(metadata.durationSeconds, 0);
  const candidates = (Array.isArray(visualEvents) ? visualEvents : [])
    .filter((event) => event && event.type === "big_chance")
    .filter((event) => hasAny(event.evidenceCodes, ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal"]))
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
      const shotStart = seconds(event.shotWindow && event.shotWindow.start, seconds(event.sourceStart));
      const sourceStart = round(Math.max(0, Math.min(event.sourceStart, shotStart - 8)));
      const finishTime = seconds(event.payoffWindow && event.payoffWindow.end, seconds(event.sourceEnd));
      const sourceEnd = round(Math.min(duration || event.sourceEnd + 10, Math.max(event.sourceEnd + 8, finishTime + 8, sourceStart + 18)));
      return normalizeDecision({
        id: `cluster_recovered_goal_${index + 1}`,
        type: "confirmed_goal",
        outcome: "confirmed_goal",
        confidence: round(clamp(0.72 + score / 100, 0.72, 0.86)),
        sourceStart,
        sourceEnd,
        buildupWindow: { start: sourceStart, end: round(Math.max(sourceStart + 0.5, shotStart)) },
        shotWindow: event.shotWindow,
        payoffWindow: { start: event.payoffWindow.start, end: round(Math.max(event.payoffWindow.end, finishTime)) },
        reactionWindow: { start: round(finishTime), end: round(Math.min(duration || sourceEnd, finishTime + 4)) },
        decisionWindow: { start: round(finishTime), end: round(Math.min(duration || sourceEnd, Math.max(finishTime + 1, sourceEnd))) },
        phaseCoverage: {
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
          "goal_candidate_cluster_recovery",
          "combined_goal_confirmation",
        ]),
        missingEvidence: [],
        safetyFlags: [
          "candidate_cluster_recovery",
          "no_false_goal_from_ocr_only",
          "requires_operator_review_for_production",
        ],
        captionIntent: "confirmed_goal_caption",
        renderPriority: typePriority("confirmed_goal") + 500 - index,
      }, index, metadata);
    });
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
      changeTime: round(seconds(change.changeTime)),
      teamSide: sanitizeText(change.teamSide || "unknown", 16),
      scoreDelta: Math.max(0, Math.min(3, Math.round(Number(change.scoreDelta || 0)))),
      confidence: round(clamp(change.confidence, 0, 1)),
      persistedDuration: round(clamp(change.persistedDuration, 0, 300)),
      reverted: Boolean(change.reverted),
      revertedAt: change.revertedAt == null ? null : round(seconds(change.revertedAt)),
      outcome: ["counted_goal", "disallowed_goal", "uncertain_review"].includes(change.outcome)
        ? change.outcome
        : "uncertain_review",
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
  const lateCutoff = Math.max(0, seconds(metadata.durationSeconds, 0) * 0.66);
  const countedGoalEventCount = scoreChanges.filter((change) => change.outcome === "counted_goal").length;
  const disallowedGoalEventCount = scoreChanges.filter((change) => change.outcome === "disallowed_goal").length;
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
    metadata,
  });
  const occupied = events.map((event) => ({ start: event.sourceStart, end: event.sourceEnd }));
  const visualEvents = (Array.isArray(visualSignals.windows) ? visualSignals.windows : [])
    .map((window, index) => buildVisualDecision({ window, mediaSignals: input.mediaSignals, metadata, index, occupied }))
    .filter(Boolean)
    .slice(0, 10);
  const recoveryEvents = [...events, ...scoreChangeTruth.decisions].some((event) => event.type === "confirmed_goal")
    ? []
    : recoverConfirmedGoalClusters({ visualEvents, metadata });
  const selectedEvents = [...events, ...scoreChangeTruth.decisions, ...recoveryEvents, ...visualEvents].filter((event) => event.type !== "neutral");
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
    events: Array.isArray(safe.events) ? safe.events : [],
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
    changeTime: Number(change.changeTime || 0),
    teamSide: sanitizeText(change.teamSide || "unknown", 16),
    scoreDelta: Number(change.scoreDelta || 0),
    confidence: round(clamp(change.confidence, 0, 1)),
    persistedDuration: Number(change.persistedDuration || 0),
    reverted: Boolean(change.reverted),
    revertedAt: change.revertedAt == null ? null : Number(change.revertedAt),
    outcome: sanitizeText(change.outcome || "uncertain_review", 32),
    reasonCodes: uniqueCodes(change.reasonCodes, 12),
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
    scoreBefore: event.scoreBefore || null,
    scoreAfter: event.scoreAfter || null,
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
