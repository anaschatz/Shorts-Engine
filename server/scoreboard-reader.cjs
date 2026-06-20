const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { scorebugTransitionDecision } = require("./scorebug-calibration.cjs");

const SCOREBOARD_READER_STATUSES = Object.freeze([
  "readable",
  "ambiguous",
  "unreadable",
]);

const SCOREBOARD_TIMELINE_STATUSES = Object.freeze([
  "score_changed",
  "score_unchanged",
  "goal_removed",
  "score_reverted_or_disallowed",
  "clock_only",
  "ambiguous",
  "unreadable",
]);

const MAX_SCORE_VALUE = 30;
const MAX_TEXT_PREVIEW = 120;
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function scoreText(score = {}) {
  if (!Number.isInteger(score.home) || !Number.isInteger(score.away)) return null;
  return `${score.home}-${score.away}`;
}

function normalizeScoreObject(score = {}) {
  if (!score || typeof score !== "object" || Array.isArray(score)) return null;
  const home = Number(score.home);
  const away = Number(score.away);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0 || home > MAX_SCORE_VALUE || away > MAX_SCORE_VALUE) return null;
  return { home, away, text: `${home}-${away}` };
}

function normalizeReaderStatus(status) {
  const safe = sanitizeText(status || "", 32);
  return SCOREBOARD_READER_STATUSES.includes(safe) ? safe : "unreadable";
}

function normalizeTimelineStatus(status) {
  const safe = sanitizeText(status || "", 40);
  return SCOREBOARD_TIMELINE_STATUSES.includes(safe) ? safe : "unreadable";
}

function uniqueReasons(reasons = []) {
  return [...new Set((Array.isArray(reasons) ? reasons : [])
    .map((reason) => sanitizeText(reason, 60))
    .filter(Boolean)
    .filter((reason) => !SENSITIVE_RE.test(reason)))]
    .slice(0, 8);
}

function readScoreboardCandidate(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || hasUnsafeValue(input)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (
    SCOREBOARD_READER_STATUSES.includes(String(input.status || "")) &&
    (Number.isInteger(input.homeScore) || input.homeScore === null || input.homeScore === undefined) &&
    (Number.isInteger(input.awayScore) || input.awayScore === null || input.awayScore === undefined)
  ) {
    const homeScore = Number.isInteger(input.homeScore) ? input.homeScore : null;
    const awayScore = Number.isInteger(input.awayScore) ? input.awayScore : null;
    return {
      status: normalizeReaderStatus(input.status),
      timestamp: round(seconds(input.timestamp)),
      start: round(seconds(input.start, seconds(input.timestamp) - 0.8)),
      end: round(seconds(input.end, seconds(input.timestamp) + 0.8)),
      homeScore,
      awayScore,
      scoreText: homeScore !== null && awayScore !== null ? `${homeScore}-${awayScore}` : null,
      ocrText: sanitizeText(input.ocrText || input.normalizedText || input.text || "", MAX_TEXT_PREVIEW),
      normalizedText: sanitizeText(input.normalizedText || input.ocrText || input.text || "", MAX_TEXT_PREVIEW),
      clock: input.clock ? sanitizeText(input.clock, 16) : null,
      confidence: round(clamp(input.confidence, 0, 1)),
      regionId: sanitizeText(input.regionId || "scoreboard_region", 80),
      preprocessingVariant: sanitizeText(input.preprocessingVariant || input.variantId || "default", 60),
      source: sanitizeText(input.source || "scoreboard_reader", 80),
      layoutId: sanitizeText(input.layoutId || "", 80) || null,
      scoreOnlyCropRef: input.scoreOnlyCropRef ? sanitizeText(input.scoreOnlyCropRef, 180) : null,
      ambiguityReasons: uniqueReasons(input.ambiguityReasons || []),
      safeDebug: {
        textPresent: Boolean(input.ocrText || input.normalizedText || input.text),
        scoreParsed: homeScore !== null && awayScore !== null,
        clockParsed: Boolean(input.clock),
      },
    };
  }
  const textPreview = sanitizeText(input.text || "", MAX_TEXT_PREVIEW);
  const score = normalizeScoreObject(input.score);
  const clock = input.clock ? sanitizeText(input.clock, 16) : null;
  const confidence = round(clamp(input.confidence ?? (score ? 0.78 : clock ? 0.62 : textPreview ? 0.35 : 0.05), 0, 1));
  const ambiguityReasons = [];
  let status = "unreadable";

  if (input.rejected) {
    status = "unreadable";
    ambiguityReasons.push("ocr_text_rejected");
  } else if (score && confidence >= 0.3) {
    status = "readable";
  } else if (score && confidence < 0.3) {
    status = "ambiguous";
    ambiguityReasons.push("low_confidence_score");
  } else if (clock) {
    status = "ambiguous";
    ambiguityReasons.push("clock_only");
  } else if (textPreview) {
    status = "ambiguous";
    ambiguityReasons.push("score_not_found");
  } else {
    ambiguityReasons.push("empty_ocr_text");
  }

  return {
    status: normalizeReaderStatus(status),
    timestamp: round(seconds(input.timestamp)),
    start: round(seconds(input.start, seconds(input.timestamp) - 0.8)),
    end: round(seconds(input.end, seconds(input.timestamp) + 0.8)),
    homeScore: score ? score.home : null,
    awayScore: score ? score.away : null,
    scoreText: score ? score.text : null,
    ocrText: textPreview,
    normalizedText: textPreview,
    clock,
    confidence,
    regionId: sanitizeText(input.regionId || "scoreboard_region", 80),
    preprocessingVariant: sanitizeText(input.preprocessingVariant || input.variantId || "default", 60),
    source: sanitizeText(input.source || "scoreboard_reader", 80),
    layoutId: sanitizeText(input.layoutId || "", 80) || null,
    scoreOnlyCropRef: input.scoreOnlyCropRef ? sanitizeText(input.scoreOnlyCropRef, 180) : null,
    ambiguityReasons: uniqueReasons([...ambiguityReasons, ...(input.ambiguityReasons || [])]),
    safeDebug: {
      textPresent: Boolean(textPreview),
      scoreParsed: Boolean(score),
      clockParsed: Boolean(clock),
    },
  };
}

function sameScore(a, b) {
  return Boolean(a && b && a.home === b.home && a.away === b.away);
}

function scoreTotal(score) {
  return score ? Number(score.home || 0) + Number(score.away || 0) : 0;
}

function scoreDelta(before, after) {
  if (!before || !after) return 0;
  return Math.abs(after.home - before.home) + Math.abs(after.away - before.away);
}

function scoreTransition(before, after) {
  const delta = scoreDelta(before, after);
  if (!before || !after) return { delta, direction: "unknown", consistent: false };
  if (delta === 0) return { delta, direction: "same", consistent: true };
  if (delta !== 1) return { delta, direction: "ambiguous", consistent: false };
  const totalDelta = scoreTotal(after) - scoreTotal(before);
  if (totalDelta === 1) return { delta, direction: "increase", consistent: true };
  if (totalDelta === -1) return { delta, direction: "decrease", consistent: true };
  return { delta, direction: "ambiguous", consistent: false };
}

function scoreFromReading(reading = {}) {
  if (!Number.isInteger(reading.homeScore) || !Number.isInteger(reading.awayScore)) return null;
  return { home: reading.homeScore, away: reading.awayScore, text: `${reading.homeScore}-${reading.awayScore}` };
}

function rankReading(reading = {}) {
  const score = reading.status === "readable" ? 2 : 0;
  const clock = reading.clock ? 0.4 : 0;
  return score + clock + Number(reading.confidence || 0);
}

function bestReadingsByTimestamp(readings = []) {
  const best = [];
  for (const reading of readings) {
    const existing = best.find((item) => Math.abs(item.timestamp - reading.timestamp) < 0.2);
    if (!existing) {
      best.push(reading);
      continue;
    }
    if (rankReading(reading) > rankReading(existing)) Object.assign(existing, reading);
  }
  return best.sort((a, b) => a.timestamp - b.timestamp);
}

function buildStableScoreTimeline(readings = [], options = {}) {
  const minStableReads = Math.max(1, Math.min(3, Math.round(Number(options.minStableReads || 2))));
  const safeReadings = bestReadingsByTimestamp((Array.isArray(readings) ? readings : [])
    .map((reading) => readScoreboardCandidate(reading))
    .filter((reading) => Number.isFinite(reading.timestamp)));
  const timeline = [];
  let stableScore = null;
  let pending = null;

  for (const reading of safeReadings) {
    const currentScore = scoreFromReading(reading);
    let status = "unreadable";
    let scoreBefore = stableScore ? stableScore.text : null;
    let scoreAfter = currentScore ? currentScore.text : null;
    let temporalConsistency = false;
    let ambiguityReasons = [...reading.ambiguityReasons];
    let transitionDecision = "unreadable";
    let transitionReasonCodes = [];

    if (reading.status === "unreadable") {
      status = "unreadable";
      transitionDecision = "unreadable";
    } else if (!currentScore && reading.clock) {
      status = "clock_only";
      transitionDecision = "rejected_clock";
      transitionReasonCodes.push("clock_like_text_rejected");
    } else if (!currentScore) {
      status = "ambiguous";
      transitionDecision = "unreadable";
    } else if (!stableScore) {
      stableScore = currentScore;
      status = "ambiguous";
      transitionDecision = "initial_score";
      transitionReasonCodes.push("initial_score_observed");
      ambiguityReasons.push("initial_score_needs_followup");
    } else if (sameScore(currentScore, stableScore)) {
      pending = null;
      status = "score_unchanged";
      scoreBefore = stableScore.text;
      scoreAfter = stableScore.text;
      temporalConsistency = true;
      transitionDecision = "score_unchanged";
      transitionReasonCodes.push("score_stable_repeat");
    } else {
      const transition = scoreTransition(stableScore, currentScore);
      const calibrationDecision = scorebugTransitionDecision({
        previousScore: stableScore,
        candidateScore: currentScore,
        confidence: reading.confidence,
        minConfidence: options.minConfidence || 0.55,
      });
      transitionDecision = calibrationDecision.decision;
      transitionReasonCodes.push(...calibrationDecision.reasonCodes);
      scoreBefore = stableScore.text;
      if (!transition.consistent || transition.direction === "ambiguous") {
        pending = null;
        status = "ambiguous";
        transitionDecision = "rejected_impossible_transition";
        ambiguityReasons.push("impossible_or_non_unit_score_transition");
      } else if (pending && sameScore(pending.score, currentScore)) {
        pending.count += 1;
        if (pending.count >= minStableReads) {
          status = transition.direction === "increase" ? "score_changed" : "goal_removed";
          transitionDecision = transition.direction === "increase"
            ? "score_changed"
            : "score_reverted_or_disallowed";
          temporalConsistency = true;
          stableScore = currentScore;
          pending = null;
        } else {
          status = "ambiguous";
          transitionDecision = "score_change_pending_confirmation";
          ambiguityReasons.push("score_change_not_stable");
        }
      } else {
        pending = { score: currentScore, count: 1, direction: transition.direction };
        status = minStableReads === 1
          ? transition.direction === "increase" ? "score_changed" : "goal_removed"
          : "ambiguous";
        transitionDecision = minStableReads === 1
          ? transition.direction === "increase" ? "score_changed" : "score_reverted_or_disallowed"
          : "score_change_pending_confirmation";
        temporalConsistency = minStableReads === 1;
        if (minStableReads === 1) {
          stableScore = currentScore;
          pending = null;
        } else {
          ambiguityReasons.push("score_change_needs_confirmation");
        }
      }
    }

    timeline.push({
      id: sanitizeText(reading.id || `scoreboard_reading_${timeline.length + 1}`, 80),
      timestamp: reading.timestamp,
      start: reading.start,
      end: reading.end,
      status: normalizeTimelineStatus(status),
      scoreBefore,
      scoreAfter,
      detectedScoreText: scoreAfter,
      clock: reading.clock,
      temporalConsistency,
      confidence: reading.confidence,
      source: reading.source,
      regionId: reading.regionId,
      preprocessingVariant: reading.preprocessingVariant,
      layoutId: reading.layoutId,
      scoreOnlyCropRef: reading.scoreOnlyCropRef,
      transitionDecision: sanitizeText(transitionDecision, 60),
      transitionReasonCodes: uniqueReasons(transitionReasonCodes),
      ambiguityReasons: uniqueReasons(ambiguityReasons),
    });
  }
  return timeline;
}

module.exports = {
  SCOREBOARD_READER_STATUSES,
  SCOREBOARD_TIMELINE_STATUSES,
  buildStableScoreTimeline,
  readScoreboardCandidate,
  scoreText,
};
