const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence, normalizeOcrQaCalibrationInput } = require("./goal-evidence-provider.cjs");
const { validateVisualSignals, visualReasonCodesForWindow } = require("./vision.cjs");

const MATCH_EVENT_TRUTH_VERSION = 1;
const MAX_EVENTS = 24;
const MAX_CODES = 32;
const MAX_MISSING = 8;
const MAX_FLAGS = 8;

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
  "kickoff_after_goal",
  "replay_goal_confirmation",
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

const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

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

function windowSetForDecision({ event, visualSignals, duration }) {
  const start = seconds(event.start);
  const end = Math.max(start + 0.5, seconds(event.end, start + 1));
  const windows = windowsInRange(visualSignals, start, end, 2);
  const shotStart = firstWindowTime(windows, ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal"], start);
  const payoffStart = firstWindowTime(windows, PAYOFF_CODES, Math.min(end, shotStart + 2));
  const payoffEnd = lastWindowTime(windows, PAYOFF_CODES, end);
  const decisionStart = firstWindowTime(windows, DECISION_CODES, null);
  const sourceStart = round(Math.max(0, Math.min(start, shotStart) - 4));
  const sourceEnd = round(Math.min(
    seconds(duration, Math.max(end, payoffEnd) + 10),
    Math.max(end, payoffEnd, decisionStart || 0) + (decisionStart == null ? 8 : 4),
  ));
  return {
    sourceStart,
    sourceEnd: Math.max(sourceStart + 3, sourceEnd),
    buildupWindow: { start: sourceStart, end: round(Math.max(sourceStart + 0.5, shotStart)) },
    shotWindow: { start: round(shotStart), end: round(Math.max(shotStart + 0.5, payoffStart)) },
    payoffWindow: { start: round(payoffStart), end: round(Math.max(payoffStart + 0.5, payoffEnd)) },
    reactionWindow: { start: round(payoffEnd), end: round(Math.min(seconds(duration, payoffEnd + 4), payoffEnd + 4)) },
    decisionWindow: decisionStart == null
      ? null
      : { start: round(decisionStart), end: round(Math.min(seconds(duration, decisionStart + 6), Math.max(decisionStart + 1, sourceEnd))) },
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
  return {
    id: sanitizeText(decision.id || `match_event_${index + 1}`, 80),
    type,
    outcome,
    confidence: round(clamp(decision.confidence, 0.05, 0.98)),
    sourceStart,
    sourceEnd,
    buildupWindow: normalizeOptionalWindow(decision.buildupWindow, sourceStart, sourceEnd),
    shotWindow: normalizeOptionalWindow(decision.shotWindow, sourceStart, sourceEnd),
    payoffWindow: normalizeOptionalWindow(decision.payoffWindow, sourceStart, sourceEnd),
    reactionWindow: normalizeOptionalWindow(decision.reactionWindow, sourceStart, sourceEnd),
    decisionWindow: normalizeOptionalWindow(decision.decisionWindow, sourceStart, sourceEnd, true),
    evidenceCodes: uniqueCodes(decision.evidenceCodes),
    missingEvidence: uniqueCodes(decision.missingEvidence, MAX_MISSING),
    safetyFlags: uniqueCodes(decision.safetyFlags, MAX_FLAGS),
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
  return normalizeDecision({
    id: sanitizeText(event.id || `goal_truth_${index + 1}`, 80),
    type,
    outcome: goalOutcomeForType(type),
    confidence: confidenceForDecision(type, evidenceCodes, event.confidence),
    ...windows,
    evidenceCodes,
    missingEvidence: missingEvidenceForDecision(type, evidenceCodes, ocrQaCalibration),
    safetyFlags: safetyFlagsForDecision(type, evidenceCodes, ocrQaCalibration),
    captionIntent: captionIntentForType(type),
    renderPriority: typePriority(type) + Math.min(99, seconds(event.start)),
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

function validateMatchEventTruthOutput(output, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
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
    summary: {
      eventCount: events.length,
      confirmedGoalCount,
      disallowedGoalCount,
      possibleGoalCount,
      chanceOrSaveCount: events.filter((event) => event.type === "big_chance" || event.type === "save").length,
      rejectedEventCount: rejectedEvents.length,
      lateConfirmedGoalCount: events.filter((event) => event.type === "confirmed_goal" && event.sourceStart >= lateCutoff).length,
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
  const occupied = events.map((event) => ({ start: event.sourceStart, end: event.sourceEnd }));
  const visualEvents = (Array.isArray(visualSignals.windows) ? visualSignals.windows : [])
    .map((window, index) => buildVisualDecision({ window, mediaSignals: input.mediaSignals, metadata, index, occupied }))
    .filter(Boolean)
    .slice(0, 10);
  const selectedEvents = [...events, ...visualEvents].filter((event) => event.type !== "neutral");
  const rejectedEvents = [...events, ...visualEvents].filter((event) => (
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
  }, { durationSeconds: Number.MAX_SAFE_INTEGER });
  return {
    schemaVersion: normalized.schemaVersion,
    providerMode: normalized.providerMode,
    fallbackUsed: normalized.fallbackUsed,
    ocrQaCalibration: normalized.ocrQaCalibration,
    summary: publicSummary(normalized.summary, safe.summary),
    selectedEvents: normalized.events.map(publicDecision),
    rejectedEvents: normalized.rejectedEvents.map(publicDecision),
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
    noFalseGoalFromOcrOnly: numeric("noFalseGoalFromOcrOnly"),
    ocrQaSupportStatus: sanitizeText(original.ocrQaSupportStatus || normalizedSummary.ocrQaSupportStatus || "ignored", 32),
  };
}

function publicDecision(event) {
  return {
    id: sanitizeText(event.id, 80),
    type: event.type,
    outcome: event.outcome,
    confidence: event.confidence,
    sourceStart: event.sourceStart,
    sourceEnd: event.sourceEnd,
    buildupWindow: event.buildupWindow,
    shotWindow: event.shotWindow,
    payoffWindow: event.payoffWindow,
    reactionWindow: event.reactionWindow,
    decisionWindow: event.decisionWindow,
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
