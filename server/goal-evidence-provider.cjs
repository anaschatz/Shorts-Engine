const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { normalizeOcrQaCalibrationReport, publicOcrQaCalibration } = require("./ocr-qa-calibration.cjs");
const { validateVisualSignals, visualReasonCodesForWindow } = require("./vision.cjs");

const DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS = 12000;
const MAX_EVIDENCE_EVENTS = 32;
const MAX_REASON_CODES = 14;
const POST_GOAL_CONTEXT_SECONDS = 15;
const SCOREBOARD_BACKED_LOOKBACK_SECONDS = 24;
const SCOREBOARD_BACKED_POST_SECONDS = 2.5;

const GOAL_EVIDENCE_OUTCOMES = Object.freeze([
  "valid_goal",
  "offside_goal",
  "no_goal",
  "possible_goal_unconfirmed",
  "non_goal_chance",
  "celebration_only",
  "anthem_or_intro",
]);

const GOAL_EVIDENCE_REASON_CODES = Object.freeze([
  "ball_in_net",
  "visual_ball_in_net",
  "scoreboard_ocr_score_change",
  "scoreboard_ocr_score_unchanged",
  "scoreboard_ocr_goal_removed",
  "scoreboard_ocr_ambiguous",
  "scoreboard_backed_goal_sequence",
  "scoreboard_temporal_consistency",
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "confirmed_by_commentary",
  "visual_offside_flag",
  "visual_no_goal_decision",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_offside_line",
  "visual_var_check",
  "visual_var_decision",
  "offside_commentary",
  "flag_commentary",
  "disallowed_commentary",
  "no_goal_commentary",
  "var_check",
  "commentator_goal_call_support",
  "crowd_reaction_support",
  "combined_goal_confirmation",
  "live_shot_finish_sequence",
  "replay_goal_confirmation",
  "kickoff_after_goal",
  "shot_sequence_support",
  "celebration_only",
  "anthem_or_intro",
  "non_goal_chance",
]);

const SUPPLEMENTAL_VISUAL_BY_REASON = Object.freeze({
  scoreboard_ocr_score_change: "scoreboard_goal_confirmed",
  scoreboard_backed_goal_sequence: "scoreboard_goal_confirmed",
  kickoff_after_goal: "scoreboard_goal_confirmed",
  visual_scoreboard_goal_confirmed: "scoreboard_goal_confirmed",
  visual_referee_goal_signal: "referee_goal_signal",
  visual_offside_flag: "assistant_referee_flag",
  visual_no_goal_decision: "scoreboard_no_goal",
  visual_referee_no_goal_signal: "referee_no_goal_signal",
  visual_scoreboard_goal_removed: "scoreboard_goal_removed",
  scoreboard_ocr_goal_removed: "scoreboard_goal_removed",
  visual_offside_line: "offside_line_replay",
  visual_var_check: "var_check_graphic",
  visual_var_decision: "var_decision_graphic",
});

const CONFIRMED_CAPTION_TERMS = Object.freeze([
  "goal confirmed",
  "confirmed goal",
  "it counts",
  "the goal stands",
  "finish counts",
  "finish stands",
  "μετραει",
  "μετράει",
]);

const GOAL_CALL_TERMS = Object.freeze([
  "goal",
  "scores",
  "scored",
  "back of the net",
  "finds the net",
  "into the net",
  "γκολ",
  "σκοραρ",
  "σκόραρ",
]);

const OFFSIDE_TERMS = Object.freeze(["offside", "flag is up", "flag goes up", "οφσαιντ", "οφσάιντ", "σημαια", "σημαία"]);
const DISALLOWED_TERMS = Object.freeze(["disallowed", "ruled out", "no goal", "chalked off", "does not count", "δεν μετρά", "ακυρώνεται"]);
const VAR_TERMS = Object.freeze(["var", "check", "review", "checking", "video assistant", "ελεγχος", "έλεγχος"]);
const RESTART_TERMS = Object.freeze(["restart", "kickoff", "kick off", "back underway", "play restarts", "σεντρα", "σέντρα"]);
const ANTHEM_INTRO_TERMS = Object.freeze([
  "anthem",
  "lineups",
  "kick off approaches",
  "players walk out",
  "ceremony",
  "national anthem",
  "ύμνος",
  "υμνος",
  "ενδεκάδες",
  "σέντρα πλησιάζει",
]);
const CELEBRATION_ONLY_TERMS = Object.freeze([
  "celebration",
  "celebrates",
  "celebrating",
  "fans celebrate",
  "πανηγυρ",
  "πανηγυρισ",
]);

const OCR_STATUSES = Object.freeze([
  "score_changed",
  "score_unchanged",
  "goal_confirmed",
  "goal_removed",
  "clock_only",
  "ambiguous",
  "unreadable",
  "unknown",
]);

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
  const serialized = JSON.stringify(value || {});
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i.test(serialized);
}

function hasTerm(text, terms) {
  const safe = sanitizeText(text, 240).toLowerCase();
  return terms.some((term) => safe.includes(term.toLowerCase()));
}

function captionEvidence(caption = {}) {
  const text = sanitizeText(caption.text || "", 240);
  const reasons = [];
  if (hasTerm(text, CONFIRMED_CAPTION_TERMS)) reasons.push("confirmed_by_commentary");
  if (hasTerm(text, GOAL_CALL_TERMS)) reasons.push("commentator_goal_call_support");
  if (hasTerm(text, OFFSIDE_TERMS)) reasons.push("offside_commentary", "flag_commentary");
  if (hasTerm(text, DISALLOWED_TERMS)) reasons.push("disallowed_commentary", "no_goal_commentary");
  if (hasTerm(text, VAR_TERMS)) reasons.push("var_check");
  if (hasTerm(text, RESTART_TERMS)) reasons.push("kickoff_after_goal");
  return [...new Set(reasons)];
}

function captionsInRange(captions = [], start = 0, end = 0) {
  return (Array.isArray(captions) ? captions : [])
    .filter((caption) => seconds(caption.start) <= end && seconds(caption.end) >= start)
    .map((caption) => ({
      start: seconds(caption.start),
      end: seconds(caption.end),
      reasonCodes: captionEvidence(caption),
    }))
    .filter((item) => item.reasonCodes.length);
}

function windowCenter(window = {}) {
  const start = seconds(window.start);
  const end = seconds(window.end, start);
  return seconds(window.center ?? (start + end) / 2, start);
}

function windowHasReason(window, reason) {
  return visualReasonCodesForWindow(window).includes(reason);
}

function visualDecisionReasons(window = {}) {
  return visualReasonCodesForWindow(window).filter((reason) => [
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "visual_offside_flag",
    "visual_no_goal_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
    "visual_offside_line",
    "visual_var_check",
    "visual_var_decision",
    "visual_replay_angle",
  ].includes(reason));
}

function eventWindowForBallInNet(ballWindow, windows = [], metadata = {}) {
  const payoff = seconds(ballWindow.end, windowCenter(ballWindow));
  const start = Math.max(0, firstShotStartBefore(payoff, windows) ?? seconds(ballWindow.start) - 4);
  const duration = seconds(metadata.durationSeconds, payoff + POST_GOAL_CONTEXT_SECONDS);
  const end = Math.min(duration || payoff + POST_GOAL_CONTEXT_SECONDS, payoff + POST_GOAL_CONTEXT_SECONDS);
  return { start: round(start), end: round(end), payoff };
}

function firstShotStartBefore(payoff, windows = []) {
  const match = [...windows]
    .filter((window) => {
      const center = windowCenter(window);
      return center <= payoff + 0.5 &&
        center >= payoff - 18 &&
        ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal"].some((reason) => windowHasReason(window, reason));
    })
    .sort((a, b) => seconds(a.start) - seconds(b.start))[0];
  return match ? seconds(match.start) : null;
}

function reasonFlags(reasonCodes = []) {
  const reasons = new Set(reasonCodes);
  return {
    ballInNetEvidence: reasons.has("ball_in_net") || reasons.has("visual_ball_in_net"),
    scoreboardChanged: reasons.has("visual_scoreboard_goal_confirmed") ||
      reasons.has("visual_scoreboard_goal_removed") ||
      reasons.has("scoreboard_ocr_score_change"),
    scoreboardGoalConfirmed: reasons.has("visual_scoreboard_goal_confirmed") || reasons.has("scoreboard_ocr_score_change"),
    scoreboardBackedGoalSequence: reasons.has("scoreboard_backed_goal_sequence"),
    refereeGoalSignal: reasons.has("visual_referee_goal_signal"),
    kickoffAfterGoal: reasons.has("kickoff_after_goal"),
    replayGoalConfirmation: reasons.has("replay_goal_confirmation"),
    offsideFlag: reasons.has("visual_offside_flag") || reasons.has("flag_commentary") || reasons.has("offside_commentary"),
    VARNoGoalSignal: reasons.has("visual_no_goal_decision") ||
      reasons.has("visual_referee_no_goal_signal") ||
      reasons.has("visual_scoreboard_goal_removed") ||
      reasons.has("scoreboard_ocr_goal_removed") ||
      reasons.has("scoreboard_ocr_score_unchanged") ||
      reasons.has("disallowed_commentary") ||
      reasons.has("no_goal_commentary"),
    commentatorGoalCall: reasons.has("confirmed_by_commentary") || reasons.has("commentator_goal_call_support"),
    crowdReactionSupport: reasons.has("crowd_reaction_support"),
    scoreboardOcrEvidence: reasons.has("scoreboard_ocr_score_change") ||
      reasons.has("scoreboard_ocr_score_unchanged") ||
      reasons.has("scoreboard_ocr_goal_removed") ||
      reasons.has("scoreboard_ocr_ambiguous"),
    combinedGoalConfirmation: reasons.has("combined_goal_confirmation"),
    liveShotFinishSequence: reasons.has("live_shot_finish_sequence") || reasons.has("shot_sequence_support"),
    celebrationOnlyEvidence: reasons.has("celebration_only"),
    anthemOrIntroEvidence: reasons.has("anthem_or_intro"),
  };
}

function outcomeForReasons(reasonCodes = []) {
  const reasons = new Set(reasonCodes);
  const hasBallInNet = reasons.has("ball_in_net") || reasons.has("visual_ball_in_net");
  const hasScoreboardBackedSequence = reasons.has("scoreboard_backed_goal_sequence") && (
    reasons.has("shot_sequence_support") ||
    reasons.has("visual_shot_contact") ||
    reasons.has("visual_ball_toward_goal")
  );
  const hasScoreConfirmed = reasons.has("visual_scoreboard_goal_confirmed") || reasons.has("scoreboard_ocr_score_change");
  const hasVisualGoalDecision = reasons.has("visual_referee_goal_signal") || reasons.has("kickoff_after_goal");
  const hasReplayConfirmation = reasons.has("replay_goal_confirmation") && hasScoreConfirmed;
  const hasCommentaryConfirmation = reasons.has("confirmed_by_commentary") || reasons.has("commentator_goal_call_support");
  const hasCombinedConfirmation = reasons.has("combined_goal_confirmation") && (
    reasons.has("shot_sequence_support") ||
    reasons.has("live_shot_finish_sequence")
  );
  if (
    reasons.has("visual_offside_flag") ||
    reasons.has("visual_offside_line") ||
    reasons.has("visual_no_goal_decision") ||
    reasons.has("visual_referee_no_goal_signal") ||
    reasons.has("visual_scoreboard_goal_removed") ||
    reasons.has("scoreboard_ocr_goal_removed") ||
    reasons.has("scoreboard_ocr_score_unchanged") ||
    reasons.has("offside_commentary") ||
    reasons.has("flag_commentary") ||
    reasons.has("disallowed_commentary") ||
    reasons.has("no_goal_commentary")
  ) {
    return "offside_goal";
  }
  if (reasons.has("anthem_or_intro")) return "anthem_or_intro";
  if (reasons.has("celebration_only") && !hasBallInNet) return "celebration_only";
  if (
    (hasBallInNet || hasScoreboardBackedSequence) &&
    (
      hasScoreConfirmed ||
      hasVisualGoalDecision ||
      hasReplayConfirmation ||
      hasCommentaryConfirmation ||
      hasCombinedConfirmation
    )
  ) {
    return "valid_goal";
  }
  if (hasBallInNet) return "possible_goal_unconfirmed";
  return "non_goal_chance";
}

function assertOutcomeMatchesEvidence(outcomeHint, reasonCodes = []) {
  const computed = outcomeForReasons(reasonCodes);
  if (outcomeHint === computed) return outcomeHint;
  if (outcomeHint === "no_goal" && computed === "offside_goal") return "no_goal";
  if (outcomeHint === "offside_goal" && computed === "no_goal") return "offside_goal";
  throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
}

function normalizeReasonCodes(reasonCodes = []) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .map((reason) => sanitizeText(reason, 80))
    .filter(Boolean))]
    .filter((reason) => GOAL_EVIDENCE_REASON_CODES.includes(reason))
    .slice(0, MAX_REASON_CODES);
}

function normalizeEvent(event = {}, metadata = {}, index = 0) {
  if (!event || typeof event !== "object" || Array.isArray(event) || hasUnsafeValue(event)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  const start = round(clamp(event.start, 0, duration || seconds(event.end, 0)));
  const end = round(clamp(event.end, start + 0.4, duration || seconds(event.end, start + 1)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const reasonCodes = normalizeReasonCodes(event.reasonCodes);
  if (!reasonCodes.length) throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  const requestedOutcome = sanitizeText(event.outcomeHint || outcomeForReasons(reasonCodes), 48);
  const outcomeHint = assertOutcomeMatchesEvidence(requestedOutcome, reasonCodes);
  if (!GOAL_EVIDENCE_OUTCOMES.includes(outcomeHint)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const flags = reasonFlags(reasonCodes);
  return {
    id: sanitizeText(event.id || `goal_evidence_${index + 1}`, 80),
    start,
    end,
    center: round((start + end) / 2),
    outcomeHint,
    confidence: round(clamp(event.confidence, 0.05, 0.98)),
    evidenceSource: sanitizeText(event.evidenceSource || "deterministic_goal_evidence", 60),
    reasonCodes,
    ...flags,
  };
}

function eventScore(event = {}) {
  const reasons = new Set(event.reasonCodes || []);
  const outcomeBoost = event.outcomeHint === "valid_goal"
    ? 1.1
    : event.outcomeHint === "offside_goal" || event.outcomeHint === "no_goal"
      ? 0.9
      : event.outcomeHint === "celebration_only" || event.outcomeHint === "anthem_or_intro"
        ? 0.35
        : 0;
  const evidenceBoost = [
    "ball_in_net",
    "visual_ball_in_net",
    "scoreboard_backed_goal_sequence",
    "scoreboard_ocr_score_change",
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "confirmed_by_commentary",
    "visual_offside_flag",
    "visual_no_goal_decision",
  ].reduce((score, reason) => score + (reasons.has(reason) ? 0.25 : 0), 0);
  return Number((Number(event.confidence || 0) + outcomeBoost + evidenceBoost).toFixed(4));
}

function isGoalDecisionEvidence(event = {}) {
  return [
    "valid_goal",
    "offside_goal",
    "no_goal",
    "possible_goal_unconfirmed",
  ].includes(event.outcomeHint);
}

function temporalBucketIndex(event = {}, duration = 0, bucketCount = 8) {
  const center = seconds(event.center ?? ((seconds(event.start) + seconds(event.end)) / 2));
  if (!duration) return 0;
  return Math.min(bucketCount - 1, Math.max(0, Math.floor((center / duration) * bucketCount)));
}

function selectTemporalCoverageEvents(events = [], metadata = {}, maxEvents = MAX_EVIDENCE_EVENTS) {
  const safeEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  if (safeEvents.length <= maxEvents) return safeEvents.sort((a, b) => seconds(a.start) - seconds(b.start));

  const duration = seconds(metadata.durationSeconds, safeEvents[safeEvents.length - 1]?.end || 0);
  const selected = [];
  const selectedIds = new Set();
  const addEvent = (event) => {
    if (!event || selectedIds.has(event.id) || selected.length >= maxEvents) return false;
    selected.push(event);
    selectedIds.add(event.id);
    return true;
  };

  const sortedByTime = [...safeEvents].sort((a, b) => seconds(a.start) - seconds(b.start));
  addEvent(sortedByTime[0]);
  addEvent(sortedByTime[sortedByTime.length - 1]);

  const buckets = new Map();
  for (const event of safeEvents) {
    const key = temporalBucketIndex(event, duration);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  for (const bucketEvents of buckets.values()) {
    const strongest = [...bucketEvents].sort((a, b) => eventScore(b) - eventScore(a) || seconds(a.start) - seconds(b.start))[0];
    addEvent(strongest);
  }

  for (const event of [...safeEvents].sort((a, b) => eventScore(b) - eventScore(a) || seconds(a.start) - seconds(b.start))) {
    addEvent(event);
  }

  return selected.sort((a, b) => seconds(a.start) - seconds(b.start));
}

function selectSourceWideEvidenceEvents(events = [], metadata = {}) {
  const safeEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  if (safeEvents.length <= MAX_EVIDENCE_EVENTS) {
    return safeEvents.sort((a, b) => seconds(a.start) - seconds(b.start));
  }

  const goalDecisionEvents = safeEvents.filter(isGoalDecisionEvidence);
  const supportEvents = safeEvents.filter((event) => !isGoalDecisionEvidence(event));
  if (goalDecisionEvents.length >= MAX_EVIDENCE_EVENTS) {
    return selectTemporalCoverageEvents(goalDecisionEvents, metadata, MAX_EVIDENCE_EVENTS);
  }

  const remaining = MAX_EVIDENCE_EVENTS - goalDecisionEvents.length;
  return [
    ...goalDecisionEvents,
    ...selectTemporalCoverageEvents(supportEvents, metadata, remaining),
  ].sort((a, b) => seconds(a.start) - seconds(b.start));
}

function parseScoreText(value) {
  const safe = sanitizeText(value || "", 40);
  const match = safe.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
  if (!match) return null;
  return {
    home: Number(match[1]),
    away: Number(match[2]),
    text: `${Number(match[1])}-${Number(match[2])}`,
  };
}

function normalizeScore(value) {
  if (!value) return null;
  if (typeof value === "string") return parseScoreText(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const home = Number(value.home);
    const away = Number(value.away);
    if (Number.isFinite(home) && Number.isFinite(away) && home >= 0 && away >= 0 && home <= 30 && away <= 30) {
      return { home: Math.round(home), away: Math.round(away), text: `${Math.round(home)}-${Math.round(away)}` };
    }
    return parseScoreText(value.text || value.scoreText);
  }
  return null;
}

function scoreDelta(before, after) {
  if (!before || !after) return 0;
  return Math.abs(after.home - before.home) + Math.abs(after.away - before.away);
}

function scoreTotal(score) {
  return score ? Number(score.home || 0) + Number(score.away || 0) : 0;
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

function normalizeOcrEvidenceItem(item = {}, metadata = {}, index = 0) {
  if (!item || typeof item !== "object" || Array.isArray(item) || hasUnsafeValue(item)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  const timestamp = round(clamp(item.timestamp ?? item.time ?? item.center, 0, duration || seconds(item.end, 0)));
  const start = round(clamp(item.start ?? item.windowStart ?? timestamp - 0.8, 0, duration || timestamp));
  const end = round(clamp(item.end ?? item.windowEnd ?? timestamp + 0.8, start + 0.2, duration || timestamp + 1));
  const scoreBefore = normalizeScore(item.scoreBefore || item.beforeScore || item.previousScore);
  const scoreAfter = normalizeScore(item.scoreAfter || item.afterScore || item.currentScore || item.detectedScoreText);
  const delta = scoreDelta(scoreBefore, scoreAfter);
  const direction = scoreDirection(scoreBefore, scoreAfter);
  const providedStatus = sanitizeText(item.status || "", 40);
  let status = OCR_STATUSES.includes(providedStatus)
    ? providedStatus
    : direction === "increase"
      ? "score_changed"
      : direction === "decrease"
        ? "goal_removed"
        : direction === "same"
          ? "score_unchanged"
          : "ambiguous";
  if (scoreBefore && scoreAfter) {
    if (direction === "decrease") status = "goal_removed";
    else if (direction === "ambiguous") status = "ambiguous";
    else if (direction === "same" && status === "score_changed") status = "score_unchanged";
    else if (direction === "increase" && status === "score_unchanged") status = "ambiguous";
  }
  const confidence = round(clamp(item.confidence, 0.05, 0.98));
  const temporalConsistency = Boolean(item.temporalConsistency ?? item.temporallyConsistent ?? ((delta === 0 || delta === 1) && confidence >= 0.72));
  const ambiguous = Boolean(item.ambiguous) || status === "ambiguous" || confidence < 0.55;
  const scoreChanged = (status === "score_changed" || status === "goal_confirmed") && direction === "increase" && temporalConsistency && !ambiguous;
  const scoreReverted = status === "goal_removed" && direction === "decrease" && temporalConsistency && !ambiguous;
  const scoreUnchanged = status === "score_unchanged" || scoreReverted;
  return {
    id: sanitizeText(item.id || `scoreboard_ocr_${index + 1}`, 80),
    start,
    end,
    timestamp,
    status,
    confidence,
    scoreBefore: scoreBefore ? scoreBefore.text : null,
    scoreAfter: scoreAfter ? scoreAfter.text : null,
    clock: item.clock || item.detectedClock ? sanitizeText(item.clock || item.detectedClock, 16) : null,
    scoreChanged,
    scoreUnchanged,
    scoreReverted,
    temporalConsistency,
    ambiguous,
    source: sanitizeText(item.source || "scoreboard_ocr_contract", 60),
    imageSegmentationStatus: sanitizeText(item.imageSegmentationStatus || item.segmentationStatus || "", 40) || null,
    imageDecoderStatus: sanitizeText(item.imageDecoderStatus || item.decoderStatus || "", 40) || null,
    imageDecoderMode: sanitizeText(item.imageDecoderMode || item.decoderMode || "", 40) || null,
  };
}

function ocrEvidenceScore(item = {}) {
  const statusBoost = item.scoreChanged ? 1 : item.scoreUnchanged ? 0.85 : item.ambiguous ? 0.25 : 0.4;
  const consistencyBoost = item.temporalConsistency ? 0.2 : 0;
  return Number((Number(item.confidence || 0) + statusBoost + consistencyBoost).toFixed(4));
}

function selectTemporalCoverageOcrEvidence(items = [], metadata = {}, maxItems = MAX_EVIDENCE_EVENTS) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (safeItems.length <= maxItems) return safeItems.sort((a, b) => seconds(a.timestamp) - seconds(b.timestamp));

  const duration = seconds(metadata.durationSeconds, safeItems[safeItems.length - 1]?.timestamp || 0);
  const selected = [];
  const selectedIds = new Set();
  const addItem = (item) => {
    if (!item || selectedIds.has(item.id) || selected.length >= maxItems) return false;
    selected.push(item);
    selectedIds.add(item.id);
    return true;
  };
  const sortedByTime = [...safeItems].sort((a, b) => seconds(a.timestamp) - seconds(b.timestamp));
  addItem(sortedByTime[0]);
  addItem(sortedByTime[sortedByTime.length - 1]);

  const bucketCount = 8;
  const buckets = new Map();
  for (const item of safeItems) {
    const key = duration
      ? Math.min(bucketCount - 1, Math.max(0, Math.floor((seconds(item.timestamp) / duration) * bucketCount)))
      : 0;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  for (const bucketItems of buckets.values()) {
    addItem([...bucketItems].sort((a, b) => ocrEvidenceScore(b) - ocrEvidenceScore(a) || seconds(a.timestamp) - seconds(b.timestamp))[0]);
  }
  for (const item of [...safeItems].sort((a, b) => ocrEvidenceScore(b) - ocrEvidenceScore(a) || seconds(a.timestamp) - seconds(b.timestamp))) {
    addItem(item);
  }

  return selected.sort((a, b) => seconds(a.timestamp) - seconds(b.timestamp));
}

function normalizeOcrEvidence(items = [], metadata = {}) {
  const rawItems = Array.isArray(items) ? items : [];
  return selectTemporalCoverageOcrEvidence(
    rawItems.map((item, index) => normalizeOcrEvidenceItem(item, metadata, index)),
    metadata,
  );
}

function normalizeOcrQaCalibrationInput(value) {
  if (!value) return { schemaVersion: 1, ...publicOcrQaCalibration(null) };
  if (value && typeof value === "object" && value.calibration) {
    return normalizeOcrQaCalibrationReport(value, { maxAgeMs: Number.MAX_SAFE_INTEGER });
  }
  return { schemaVersion: 1, ...publicOcrQaCalibration(value) };
}

function ocrReasonsInRange(ocrEvidence = [], start = 0, end = 0, ocrQaCalibration = null) {
  const reasons = [];
  const items = (Array.isArray(ocrEvidence) ? ocrEvidence : []).filter((item) => item.timestamp >= start - 1 && item.timestamp <= end + 1);
  const calibration = normalizeOcrQaCalibrationInput(ocrQaCalibration);
  const usable = Boolean(calibration.usable);
  if (usable && items.some((item) => item.scoreChanged)) reasons.push("scoreboard_ocr_score_change", "scoreboard_temporal_consistency");
  if (usable && items.some((item) => item.scoreReverted)) reasons.push("scoreboard_ocr_goal_removed");
  if (usable && items.some((item) => item.scoreUnchanged)) reasons.push("scoreboard_ocr_score_unchanged");
  if (items.some((item) => item.ambiguous)) reasons.push("scoreboard_ocr_ambiguous");
  return [...new Set(reasons)];
}

function allowsScoreboardBackedGoalRecovery(ocrQaCalibration = null) {
  const calibration = normalizeOcrQaCalibrationInput(ocrQaCalibration);
  return Boolean(calibration.usable) && calibration.decisionSupportLevel === "strong";
}

function visualReasonsInRange(windows = [], start = 0, end = 0) {
  return [...new Set((Array.isArray(windows) ? windows : [])
    .filter((window) => seconds(window.start) <= end && seconds(window.end) >= start)
    .flatMap(visualReasonCodesForWindow))];
}

function isShotSequenceReason(reason) {
  return [
    "visual_shot_contact",
    "visual_shot_like_motion",
    "visual_ball_toward_goal",
    "visual_goal_mouth",
    "visual_goal_area",
  ].includes(reason);
}

function isNoGoalDecisionReason(reason) {
  return [
    "visual_offside_flag",
    "visual_no_goal_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
    "visual_offside_line",
  ].includes(reason);
}

function isGoalSupportDecisionReason(reason) {
  return [
    "confirmed_by_commentary",
    "commentator_goal_call_support",
    "replay_goal_confirmation",
    "kickoff_after_goal",
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "scoreboard_ocr_score_change",
    "scoreboard_temporal_consistency",
  ].includes(reason);
}

function supportsCombinedGoalConfirmation(reasonCodes = []) {
  const reasons = new Set(reasonCodes);
  const hasDisqualifier = [
    "visual_offside_flag",
    "visual_no_goal_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
    "visual_offside_line",
    "scoreboard_ocr_goal_removed",
    "scoreboard_ocr_score_unchanged",
    "offside_commentary",
    "flag_commentary",
    "disallowed_commentary",
    "no_goal_commentary",
  ].some((reason) => reasons.has(reason));
  if (hasDisqualifier) return false;
  if (!reasons.has("ball_in_net") && !reasons.has("visual_ball_in_net")) return false;
  if (!reasons.has("shot_sequence_support") && !reasons.has("live_shot_finish_sequence")) return false;
  return [...reasons].some(isGoalSupportDecisionReason);
}

function scoreChangeAlreadyCovered(scoreItem = {}, events = []) {
  const timestamp = seconds(scoreItem.timestamp);
  return events.some((event) => timestamp >= seconds(event.start) - 1 && timestamp <= seconds(event.end) + 1);
}

function scoreboardBackedGoalWindow(scoreItem = {}, windows = [], metadata = {}) {
  const timestamp = seconds(scoreItem.timestamp);
  const duration = seconds(metadata.durationSeconds, timestamp + SCOREBOARD_BACKED_POST_SECONDS);
  const lookbackStart = Math.max(0, timestamp - SCOREBOARD_BACKED_LOOKBACK_SECONDS);
  const lookbackEnd = Math.min(duration || timestamp + 1, timestamp + 1);
  const nearbyWindows = (Array.isArray(windows) ? windows : [])
    .filter((window) => seconds(window.start) <= lookbackEnd && seconds(window.end) >= lookbackStart);
  const nearbyReasons = visualReasonsInRange(nearbyWindows, lookbackStart, lookbackEnd);
  if (nearbyReasons.some(isNoGoalDecisionReason)) return null;
  if (!nearbyReasons.some(isShotSequenceReason)) return null;
  const shotWindows = nearbyWindows.filter((window) => visualReasonCodesForWindow(window).some(isShotSequenceReason));
  const firstShot = shotWindows.sort((a, b) => seconds(a.start) - seconds(b.start))[0];
  if (!firstShot) return null;
  return {
    start: round(Math.max(0, seconds(firstShot.start))),
    end: round(Math.min(duration || timestamp + SCOREBOARD_BACKED_POST_SECONDS, timestamp + SCOREBOARD_BACKED_POST_SECONDS)),
    reasonCodes: normalizeReasonCodes([
      "scoreboard_backed_goal_sequence",
      "shot_sequence_support",
      ...nearbyReasons.filter((reason) => [
        "visual_shot_contact",
        "visual_shot_like_motion",
        "visual_ball_toward_goal",
        "visual_goal_mouth",
        "visual_goal_area",
        "visual_scoreboard_goal_confirmed",
        "visual_referee_goal_signal",
      ].includes(reason)),
    ]),
  };
}

function validateGoalEvidenceOutput(output, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const ocrEvidence = normalizeOcrEvidence(output.ocrEvidence || output.scoreboardOcr || output.scoreboardEvidence, metadata);
  const ocrQaCalibration = normalizeOcrQaCalibrationInput(output.ocrQaCalibration);
  const rawEvents = Array.isArray(output.events) ? output.events : [];
  const normalizedEvents = rawEvents
    .map((event, index) => normalizeEvent(event, metadata, index))
    .sort((a, b) => eventScore(b) - eventScore(a) || a.start - b.start)
  const events = selectSourceWideEvidenceEvents(normalizedEvents, metadata);
  if (rawEvents.length !== normalizedEvents.length && rawEvents.length <= MAX_EVIDENCE_EVENTS) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const supplementalVisualWindows = events.flatMap((event) => supplementalWindowsForEvent(event, metadata));
  return {
    providerMode: sanitizeText(output.providerMode || "deterministic-goal-evidence", 60),
    fallbackUsed: Boolean(output.fallbackUsed),
    confidence: round(clamp(output.confidence ?? (events.length ? Math.max(...events.map((event) => event.confidence)) : 0), 0, 1)),
    ocrEvidence,
    events,
    supplementalVisualWindows,
    summary: {
      eventCount: events.length,
      validGoalCount: events.filter((event) => event.outcomeHint === "valid_goal").length,
      offsideOrNoGoalCount: events.filter((event) => ["offside_goal", "no_goal"].includes(event.outcomeHint)).length,
      unconfirmedGoalCount: events.filter((event) => event.outcomeHint === "possible_goal_unconfirmed").length,
      nonGoalChanceCount: events.filter((event) => event.outcomeHint === "non_goal_chance").length,
      celebrationOnlyCount: events.filter((event) => event.outcomeHint === "celebration_only").length,
      anthemOrIntroCount: events.filter((event) => event.outcomeHint === "anthem_or_intro").length,
      ocrEvidenceCount: ocrEvidence.length,
      scoreboardConfirmedGoalCount: events.filter((event) => (event.reasonCodes || []).includes("scoreboard_ocr_score_change")).length,
      scoreboardGoalRemovedCount: events.filter((event) => (event.reasonCodes || []).includes("scoreboard_ocr_goal_removed")).length,
      ambiguousOcrCount: ocrEvidence.filter((item) => item.ambiguous).length,
      combinedGoalConfirmationCount: events.filter((event) => (event.reasonCodes || []).includes("combined_goal_confirmation")).length,
      replayConfirmationCount: events.filter((event) => (event.reasonCodes || []).includes("replay_goal_confirmation")).length,
      crowdReactionSupportCount: events.filter((event) => (event.reasonCodes || []).includes("crowd_reaction_support")).length,
      goalEvidenceCoverage: events.some((event) => event.outcomeHint === "valid_goal") ? 1 : 0,
      ocrQaStatus: ocrQaCalibration.status,
      ocrQaUsable: Boolean(ocrQaCalibration.usable),
      ocrQaSupportLevel: ocrQaCalibration.decisionSupportLevel,
    },
    ocrQaCalibration: publicOcrQaCalibration(ocrQaCalibration),
  };
}

function supplementalWindowsForEvent(event = {}, metadata = {}) {
  const windows = [];
  const decisionReasons = (event.reasonCodes || []).filter((reason) => SUPPLEMENTAL_VISUAL_BY_REASON[reason]);
  for (const reason of decisionReasons) {
    windows.push({
      start: Math.max(0, round(event.end - 1.2)),
      end: round(event.end),
      types: [SUPPLEMENTAL_VISUAL_BY_REASON[reason]],
      confidence: event.confidence,
      source: "goal_evidence_provider",
    });
  }
  return validateVisualSignals({
    providerMode: "goal-evidence-provider",
    fallbackUsed: false,
    windows,
  }, metadata).windows;
}

function deterministicGoalEvidence(input = {}) {
  const metadata = input.metadata || {};
  const visualSignals = validateVisualSignals(
    input.visualSignals || { providerMode: "goal-evidence-input-none", fallbackUsed: true, windows: [] },
    metadata,
  );
  const windows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  const transcript = input.transcript || {};
  const captions = Array.isArray(transcript.captions) ? transcript.captions : [];
  const ocrEvidence = normalizeOcrEvidence(input.ocrEvidence || input.scoreboardOcr || input.scoreboardEvidence, metadata);
  const ocrQaCalibration = normalizeOcrQaCalibrationInput(input.ocrQaCalibration);
  const events = [];
  const ballInNetWindows = windows.filter((window) => windowHasReason(window, "visual_ball_in_net"));

  for (const [index, ballWindow] of ballInNetWindows.entries()) {
    const range = eventWindowForBallInNet(ballWindow, windows, metadata);
    const postEnd = Math.min(seconds(metadata.durationSeconds, range.end), range.payoff + POST_GOAL_CONTEXT_SECONDS);
    const nearbyWindows = windows.filter((window) => seconds(window.start) <= postEnd && seconds(window.end) >= range.start - 1);
    const nearbyReasons = [...new Set(nearbyWindows.flatMap(visualReasonCodesForWindow))];
    const hasShotSequence = nearbyReasons.some(isShotSequenceReason);
    const visualReasons = [...new Set([
      "ball_in_net",
      "visual_ball_in_net",
      ...nearbyWindows.flatMap(visualDecisionReasons),
      ...(hasShotSequence ? ["shot_sequence_support", "live_shot_finish_sequence"] : []),
      ...(nearbyWindows.some((window) => windowHasReason(window, "visual_crowd_reaction")) ? ["crowd_reaction_support"] : []),
      ...(nearbyWindows.some((window) => windowHasReason(window, "visual_replay_indicator") || windowHasReason(window, "visual_replay_angle"))
        ? ["replay_goal_confirmation"]
        : []),
    ])];
    const textReasons = [...new Set(captionsInRange(captions, range.payoff - 0.5, postEnd).flatMap((item) => item.reasonCodes))];
    const ocrReasons = ocrReasonsInRange(ocrEvidence, range.payoff - 0.5, postEnd, ocrQaCalibration);
    const baseReasonCodes = normalizeReasonCodes([...visualReasons, ...textReasons, ...ocrReasons]);
    const reasonCodes = normalizeReasonCodes([
      ...baseReasonCodes,
      ...(supportsCombinedGoalConfirmation(baseReasonCodes) ? ["combined_goal_confirmation"] : []),
    ]);
    events.push({
      id: `goal_event_${index + 1}`,
      start: range.start,
      end: postEnd,
      confidence: Math.max(Number(ballWindow.confidence || 0.72), reasonCodes.includes("confirmed_by_commentary") ? 0.86 : 0.68),
      outcomeHint: outcomeForReasons(reasonCodes),
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes,
    });
  }

  const scoreChangedItems = allowsScoreboardBackedGoalRecovery(ocrQaCalibration)
    ? ocrEvidence.filter((item) => item.scoreChanged && item.temporalConsistency)
    : [];
  for (const [index, scoreItem] of scoreChangedItems.entries()) {
    if (scoreChangeAlreadyCovered(scoreItem, events)) continue;
    const range = scoreboardBackedGoalWindow(scoreItem, windows, metadata);
    if (!range) continue;
    const textReasons = [...new Set(captionsInRange(captions, range.start, range.end).flatMap((item) => item.reasonCodes))];
    const ocrReasons = ocrReasonsInRange(ocrEvidence, range.start, range.end, ocrQaCalibration);
    const reasonCodes = normalizeReasonCodes([
      ...range.reasonCodes,
      ...textReasons,
      ...ocrReasons,
    ]);
    events.push({
      id: `scoreboard_backed_goal_${index + 1}`,
      start: range.start,
      end: range.end,
      confidence: Math.max(Number(scoreItem.confidence || 0.78), 0.82),
      outcomeHint: outcomeForReasons(reasonCodes),
      evidenceSource: "deterministic_scoreboard_backed_goal_sequence",
      reasonCodes,
    });
  }

  const celebrationOnlyWindows = windows.filter((window) => (
    windowHasReason(window, "visual_celebration_after_shot") &&
    !ballInNetWindows.some((ballWindow) => Math.abs(windowCenter(ballWindow) - windowCenter(window)) <= POST_GOAL_CONTEXT_SECONDS)
  ));
  for (const [index, celebrationWindow] of celebrationOnlyWindows.slice(0, 3).entries()) {
    const start = Math.max(0, seconds(celebrationWindow.start) - 1.5);
    const end = Math.min(seconds(metadata.durationSeconds, seconds(celebrationWindow.end) + 4), seconds(celebrationWindow.end) + 4);
    const textReasons = [...new Set(captionsInRange(captions, start, end).flatMap((item) => item.reasonCodes))];
    if (textReasons.some((reason) => ["confirmed_by_commentary", "commentator_goal_call_support"].includes(reason))) continue;
    events.push({
      id: `celebration_only_${index + 1}`,
      start,
      end,
      confidence: Math.min(0.82, Number(celebrationWindow.confidence || 0.64)),
      outcomeHint: "celebration_only",
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes: ["celebration_only"],
    });
  }

  const openingBoundary = seconds(metadata.durationSeconds, 0) >= 90
    ? Math.min(45, Math.max(18, seconds(metadata.durationSeconds, 0) * 0.12))
    : 0;
  const introCaptions = captions.filter((caption) => (
    openingBoundary > 0 &&
    seconds(caption.start) <= openingBoundary &&
    hasTerm(caption.text || "", ANTHEM_INTRO_TERMS)
  ));
  for (const [index, caption] of introCaptions.slice(0, 2).entries()) {
    events.push({
      id: `anthem_or_intro_${index + 1}`,
      start: Math.max(0, seconds(caption.start) - 1),
      end: Math.min(seconds(metadata.durationSeconds, seconds(caption.end) + 2), seconds(caption.end) + 2),
      confidence: 0.76,
      outcomeHint: "anthem_or_intro",
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes: ["anthem_or_intro"],
    });
  }

  const shotOnlyWindows = windows.filter((window) => (
    !ballInNetWindows.length &&
    ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal", "visual_goal_mouth", "visual_goal_area"].some((reason) => windowHasReason(window, reason))
  ));
  for (const [index, shotWindow] of shotOnlyWindows.slice(0, 4).entries()) {
    const start = Math.max(0, seconds(shotWindow.start) - 3);
    const end = Math.min(seconds(metadata.durationSeconds, seconds(shotWindow.end) + 8), seconds(shotWindow.end) + 8);
    events.push({
      id: `non_goal_chance_${index + 1}`,
      start,
      end,
      confidence: Math.min(0.74, Number(shotWindow.confidence || 0.62)),
      outcomeHint: "non_goal_chance",
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes: ["non_goal_chance", "shot_sequence_support"],
    });
  }

  return validateGoalEvidenceOutput({
    providerMode: "deterministic-goal-evidence",
    fallbackUsed: false,
    ocrEvidence,
    ocrQaCalibration,
    events,
  }, metadata);
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithTimeout(promise, { signal, timeoutMs = DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return Promise.reject(cancellationError());
  let timer = null;
  let abortListener = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => finish(reject, cancellationError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => {
      finish(reject, new AppError("GOAL_EVIDENCE_PROVIDER_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, Math.max(250, Math.min(DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS)));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class DeterministicGoalEvidenceProvider {
  health() {
    return {
      ready: true,
      mode: "deterministic-goal-evidence",
      networkRequired: false,
      goalClaimAllowed: false,
      providerTimeoutMs: DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS,
      capabilities: [
        "scoreboard_ocr_contract",
        "score_change_temporal_consistency",
        "ball_in_net_confirmation",
        "offside_no_goal_exclusion",
        "full_source_goal_candidate_scan",
        "late_goal_temporal_coverage",
        "celebration_intro_exclusion",
      ],
    };
  }

  async analyzeGoalEvidence(input = {}) {
    return deterministicGoalEvidence(input);
  }
}

class ExternalGoalEvidenceProviderAdapter extends DeterministicGoalEvidenceProvider {
  constructor({ client = null } = {}) {
    super();
    this.client = client;
  }

  health() {
    return {
      ...super.health(),
      ready: Boolean(this.client),
      mode: this.client ? "external-goal-evidence-adapter" : "external-goal-evidence-disabled",
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeGoalEvidence(input = {}) {
    if (!this.client || typeof this.client.analyzeGoalEvidence !== "function") {
      return validateGoalEvidenceOutput({
        ...deterministicGoalEvidence(input),
        providerMode: "deterministic-goal-evidence",
        fallbackUsed: true,
        ocrQaCalibration: input.ocrQaCalibration,
      }, input.metadata || {});
    }
    try {
      const output = await raceWithTimeout(this.client.analyzeGoalEvidence(input), {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });
      return validateGoalEvidenceOutput({
        ...output,
        providerMode: "external-goal-evidence-adapter",
        fallbackUsed: Boolean(output && output.fallbackUsed),
        ocrQaCalibration: input.ocrQaCalibration,
      }, input.metadata || {});
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      if (error && error.code === "AI_OUTPUT_INVALID") throw error;
      return validateGoalEvidenceOutput({
        ...deterministicGoalEvidence(input),
        providerMode: "deterministic-goal-evidence",
        fallbackUsed: true,
        ocrQaCalibration: input.ocrQaCalibration,
      }, input.metadata || {});
    }
  }
}

function createGoalEvidenceProvider({ mode, client } = {}) {
  const safeMode = sanitizeText(mode || "", 80).toLowerCase();
  if (safeMode === "external" || safeMode === "external-goal-evidence-adapter") {
    return new ExternalGoalEvidenceProviderAdapter({ client });
  }
  return new DeterministicGoalEvidenceProvider();
}

async function analyzeGoalEvidence(input = {}) {
  const provider = input.provider || createGoalEvidenceProvider({
    mode: input.providerMode || input.mode,
    client: input.providerClient || input.client,
  });
  return provider.analyzeGoalEvidence(input);
}

function mergeGoalEvidenceIntoVisualSignals(visualSignals, goalEvidence, metadata = {}) {
  const base = validateVisualSignals(
    visualSignals || { providerMode: "goal-evidence-merge-empty", fallbackUsed: true, windows: [] },
    metadata,
  );
  const supplemental = Array.isArray(goalEvidence && goalEvidence.supplementalVisualWindows)
    ? goalEvidence.supplementalVisualWindows
    : [];
  return validateVisualSignals({
    ...base,
    providerMode: base.providerMode,
    windows: [...base.windows, ...supplemental],
  }, metadata);
}

function publicGoalEvidence(goalEvidence) {
  const safe = goalEvidence && typeof goalEvidence === "object" ? goalEvidence : {};
  return {
    providerMode: sanitizeText(safe.providerMode || "deterministic-goal-evidence", 60),
    fallbackUsed: Boolean(safe.fallbackUsed),
    confidence: round(clamp(safe.confidence, 0, 1)),
    summary: safe.summary && typeof safe.summary === "object"
      ? {
          eventCount: Number(safe.summary.eventCount || 0),
          validGoalCount: Number(safe.summary.validGoalCount || 0),
          offsideOrNoGoalCount: Number(safe.summary.offsideOrNoGoalCount || 0),
          unconfirmedGoalCount: Number(safe.summary.unconfirmedGoalCount || 0),
          nonGoalChanceCount: Number(safe.summary.nonGoalChanceCount || 0),
          celebrationOnlyCount: Number(safe.summary.celebrationOnlyCount || 0),
          anthemOrIntroCount: Number(safe.summary.anthemOrIntroCount || 0),
          ocrEvidenceCount: Number(safe.summary.ocrEvidenceCount || 0),
          scoreboardConfirmedGoalCount: Number(safe.summary.scoreboardConfirmedGoalCount || 0),
          scoreboardGoalRemovedCount: Number(safe.summary.scoreboardGoalRemovedCount || 0),
          ambiguousOcrCount: Number(safe.summary.ambiguousOcrCount || 0),
          combinedGoalConfirmationCount: Number(safe.summary.combinedGoalConfirmationCount || 0),
          replayConfirmationCount: Number(safe.summary.replayConfirmationCount || 0),
          crowdReactionSupportCount: Number(safe.summary.crowdReactionSupportCount || 0),
          goalEvidenceCoverage: Number(safe.summary.goalEvidenceCoverage || 0),
          ocrQaStatus: sanitizeText(safe.summary.ocrQaStatus || "missing", 32),
          ocrQaUsable: Boolean(safe.summary.ocrQaUsable),
          ocrQaSupportLevel: sanitizeText(safe.summary.ocrQaSupportLevel || "ignore", 32),
        }
      : null,
    ocrQaCalibration: publicOcrQaCalibration(safe.ocrQaCalibration),
    ocrEvidence: Array.isArray(safe.ocrEvidence)
      ? safe.ocrEvidence.map((item) => ({
          id: sanitizeText(item.id, 80),
          timestamp: Number(item.timestamp || 0),
          status: sanitizeText(item.status || "unknown", 40),
          confidence: Number(item.confidence || 0),
          scoreChanged: Boolean(item.scoreChanged),
          scoreUnchanged: Boolean(item.scoreUnchanged),
          scoreReverted: Boolean(item.scoreReverted),
          temporalConsistency: Boolean(item.temporalConsistency),
          ambiguous: Boolean(item.ambiguous),
          imageSegmentationStatus: item.imageSegmentationStatus ? sanitizeText(item.imageSegmentationStatus, 40) : null,
          imageDecoderStatus: item.imageDecoderStatus ? sanitizeText(item.imageDecoderStatus, 40) : null,
          imageDecoderMode: item.imageDecoderMode ? sanitizeText(item.imageDecoderMode, 40) : null,
        }))
      : [],
    events: Array.isArray(safe.events)
      ? safe.events.map((event) => ({
          id: sanitizeText(event.id, 80),
          start: Number(event.start || 0),
          end: Number(event.end || 0),
          outcomeHint: sanitizeText(event.outcomeHint || "possible_goal_unconfirmed", 48),
          confidence: Number(event.confidence || 0),
          evidenceSource: sanitizeText(event.evidenceSource || "deterministic_goal_evidence", 60),
          reasonCodes: Array.isArray(event.reasonCodes) ? event.reasonCodes.map((reason) => sanitizeText(reason, 80)).slice(0, MAX_REASON_CODES) : [],
          ballInNetEvidence: Boolean(event.ballInNetEvidence),
          scoreboardGoalConfirmed: Boolean(event.scoreboardGoalConfirmed),
          scoreboardChanged: Boolean(event.scoreboardChanged),
          scoreboardOcrEvidence: Boolean(event.scoreboardOcrEvidence),
          kickoffAfterGoal: Boolean(event.kickoffAfterGoal),
          replayGoalConfirmation: Boolean(event.replayGoalConfirmation),
          refereeGoalSignal: Boolean(event.refereeGoalSignal),
          offsideFlag: Boolean(event.offsideFlag),
          VARNoGoalSignal: Boolean(event.VARNoGoalSignal),
          commentatorGoalCall: Boolean(event.commentatorGoalCall),
          crowdReactionSupport: Boolean(event.crowdReactionSupport),
          combinedGoalConfirmation: Boolean(event.combinedGoalConfirmation),
          liveShotFinishSequence: Boolean(event.liveShotFinishSequence),
          celebrationOnlyEvidence: Boolean(event.celebrationOnlyEvidence),
          anthemOrIntroEvidence: Boolean(event.anthemOrIntroEvidence),
        }))
      : [],
  };
}

module.exports = {
  GOAL_EVIDENCE_OUTCOMES,
  GOAL_EVIDENCE_REASON_CODES,
  POST_GOAL_CONTEXT_SECONDS,
  selectSourceWideEvidenceEvents,
  DeterministicGoalEvidenceProvider,
  ExternalGoalEvidenceProviderAdapter,
  analyzeGoalEvidence,
  createGoalEvidenceProvider,
  deterministicGoalEvidence,
  mergeGoalEvidenceIntoVisualSignals,
  normalizeOcrQaCalibrationInput,
  normalizeOcrEvidence,
  publicGoalEvidence,
  selectTemporalCoverageOcrEvidence,
  validateGoalEvidenceOutput,
};
