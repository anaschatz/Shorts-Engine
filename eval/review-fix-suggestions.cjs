const { AppError } = require("../server/errors.cjs");
const { findReviewSensitiveLeak } = require("./review-comparison.cjs");
const { sanitizeReportText } = require("./scoring.cjs");

const SUGGESTION_SCHEMA_VERSION = 1;
const MAX_SUGGESTIONS = 12;
const ALLOWED_TYPES = Object.freeze([
  "caption_rewrite",
  "caption_timing_adjustment",
  "framing_adjustment",
  "animation_cue_adjustment",
  "moment_reselection",
  "false_goal_guard",
  "evidence_strengthening",
  "aspect_ratio_fix",
  "reviewer_manual_check",
]);
const ALLOWED_SEVERITIES = Object.freeze(["info", "warning", "blocking"]);
const ALLOWED_TARGETS = Object.freeze(["caption", "editPlan", "framing", "animation", "moment", "review"]);
const ALLOWED_KEYS = Object.freeze([
  "id",
  "type",
  "severity",
  "target",
  "message",
  "reasonCode",
  "safeAction",
  "canAutoApply",
  "requiresHumanReview",
  "relatedMetric",
  "relatedFailureCode",
]);
const METRIC_MINIMUMS = Object.freeze({
  momentTypeMatch: 1,
  noFalseGoalClaim: 1,
  captionActionAlignment: 0.8,
  captionSpecificity: 0.75,
  framingSafety: 1,
  aspectRatioCorrectness: 1,
  pacingScore: 0.75,
  animationCueCoverage: 0.75,
  referenceStyleSimilarity: 0.78,
  reviewerReadinessScore: 0.75,
});

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeToken(value, maxLength = 80) {
  return sanitizeReportText(value, maxLength).toLowerCase().replace(/[^a-z0-9_:-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function safeText(value, maxLength = 180) {
  return sanitizeReportText(value, maxLength)
    .replace(/Bearer\s+\[redacted\]/gi, "[redacted-token]")
    .replace(/OPENAI_API_KEY=\[redacted\]/gi, "[redacted-secret]");
}

function validateKnown(value, allowed, field) {
  const token = normalizeToken(value, 80);
  const match = allowed.find((item) => normalizeToken(item, 80) === token);
  if (!match) {
    throw new AppError("VALIDATION_ERROR", `${field} is not supported.`, 400);
  }
  return match;
}

function metricScore(report, metric) {
  return toNumber(report && report.metrics && report.metrics[metric], 1);
}

function metricFailed(report, metric) {
  const minimum = METRIC_MINIMUMS[metric] ?? 0.75;
  const failedCriteria = Array.isArray(report && report.failedCriteria) ? report.failedCriteria : [];
  return metricScore(report, metric) < minimum || failedCriteria.some((item) => item && item.metric === metric);
}

function failureCode(report, metric, fallback = null) {
  const failedCases = Array.isArray(report && report.failedCases) ? report.failedCases : [];
  const byField = failedCases.find((item) => item && item.field === metric);
  if (byField && byField.code) return normalizeToken(byField.code, 80).toUpperCase();
  const critical = failedCases.find((item) => item && item.code === "REVIEW_CRITICAL_METRIC_FAILED");
  if (critical && ["noFalseGoalClaim", "framingSafety", "aspectRatioCorrectness"].includes(metric)) {
    return "REVIEW_CRITICAL_METRIC_FAILED";
  }
  const score = failedCases.find((item) => item && item.code === "REVIEW_SCORE_BELOW_THRESHOLD");
  if (score && fallback) return "REVIEW_SCORE_BELOW_THRESHOLD";
  return fallback;
}

function suggestion(input) {
  return {
    canAutoApply: false,
    requiresHumanReview: true,
    relatedFailureCode: null,
    ...input,
  };
}

function validateReviewSuggestion(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new AppError("VALIDATION_ERROR", "Review fix suggestion must be an object.", 400);
  }
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new AppError("VALIDATION_ERROR", `Review fix suggestion has unsupported field ${key}.`, 400);
    }
  }
  const validated = {
    id: normalizeToken(candidate.id, 100),
    type: validateKnown(candidate.type, ALLOWED_TYPES, "suggestion.type"),
    severity: validateKnown(candidate.severity, ALLOWED_SEVERITIES, "suggestion.severity"),
    target: validateKnown(candidate.target, ALLOWED_TARGETS, "suggestion.target"),
    message: safeText(candidate.message, 180),
    reasonCode: normalizeToken(candidate.reasonCode, 80).toUpperCase(),
    safeAction: safeText(candidate.safeAction, 220),
    canAutoApply: false,
    requiresHumanReview: candidate.requiresHumanReview !== false,
    relatedMetric: candidate.relatedMetric ? normalizeToken(candidate.relatedMetric, 80) : null,
    relatedFailureCode: candidate.relatedFailureCode ? normalizeToken(candidate.relatedFailureCode, 80).toUpperCase() : null,
  };
  if (!/^[a-z0-9][a-z0-9_-]{2,100}$/.test(validated.id)) {
    throw new AppError("VALIDATION_ERROR", "suggestion.id must be a safe id.", 400);
  }
  if (!validated.message || !validated.reasonCode || !validated.safeAction) {
    throw new AppError("VALIDATION_ERROR", "Review fix suggestion is missing required text fields.", 400);
  }
  const leak = findReviewSensitiveLeak(validated);
  if (leak) {
    throw new AppError("VALIDATION_ERROR", "Review fix suggestion contained unsafe data.", 400);
  }
  return validated;
}

function dedupeSuggestions(suggestions) {
  const seen = new Set();
  return suggestions
    .map(validateReviewSuggestion)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, MAX_SUGGESTIONS);
}

function buildReviewFixSuggestions(report = {}) {
  const suggestions = [];
  const failedCriteria = Array.isArray(report.failedCriteria) ? report.failedCriteria : [];
  const failedCases = Array.isArray(report.failedCases) ? report.failedCases : [];
  const hasFailures = failedCriteria.length > 0 || failedCases.length > 0 || report.passed === false;
  if (!hasFailures && report.passed === true) {
    return [];
  }

  if (metricFailed(report, "noFalseGoalClaim")) {
    suggestions.push(suggestion({
      id: "sug_false_goal_guard",
      type: "false_goal_guard",
      severity: "blocking",
      target: "review",
      message: "Goal language appears without explicit goal evidence.",
      reasonCode: "FALSE_GOAL_RISK",
      safeAction: "Remove goal or scored wording unless the selected moment has explicit scoring evidence.",
      relatedMetric: "noFalseGoalClaim",
      relatedFailureCode: failureCode(report, "noFalseGoalClaim", "REVIEW_CRITICAL_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "momentTypeMatch")) {
    suggestions.push(suggestion({
      id: "sug_moment_reselection",
      type: "moment_reselection",
      severity: "blocking",
      target: "moment",
      message: "The selected moment does not match the expected football action.",
      reasonCode: "MOMENT_TYPE_MISMATCH",
      safeAction: "Re-check the ranked moments and choose the strongest chance, save, foul, counter, replay, or reaction window backed by evidence.",
      relatedMetric: "momentTypeMatch",
      relatedFailureCode: failureCode(report, "momentTypeMatch", "REVIEW_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "captionActionAlignment")) {
    suggestions.push(suggestion({
      id: "sug_caption_action_alignment",
      type: "caption_rewrite",
      severity: metricScore(report, "captionActionAlignment") <= 0.25 ? "blocking" : "warning",
      target: "caption",
      message: "Captions do not line up with the visible action.",
      reasonCode: "CAPTION_ACTION_MISMATCH",
      safeAction: "Rewrite the hook/action captions around the actual moment type and evidence instead of generic hype.",
      relatedMetric: "captionActionAlignment",
      relatedFailureCode: failureCode(report, "captionActionAlignment", "REVIEW_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "captionSpecificity")) {
    suggestions.push(suggestion({
      id: "sug_caption_specificity",
      type: "evidence_strengthening",
      severity: "warning",
      target: "caption",
      message: "Caption wording is too generic for the selected moment.",
      reasonCode: "CAPTION_TOO_GENERIC",
      safeAction: "Use concrete action words from the selected moment, such as save, foul, pressure, chance, replay, or crowd reaction.",
      relatedMetric: "captionSpecificity",
      relatedFailureCode: failureCode(report, "captionSpecificity", "REVIEW_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "pacingScore")) {
    suggestions.push(suggestion({
      id: "sug_caption_timing",
      type: "caption_timing_adjustment",
      severity: "warning",
      target: "editPlan",
      message: "The selected duration or caption pacing is outside the expected short-form range.",
      reasonCode: "PACING_OUT_OF_RANGE",
      safeAction: "Tighten the selected window and retime captions so the action lands quickly without overlap.",
      relatedMetric: "pacingScore",
      relatedFailureCode: failureCode(report, "pacingScore", "REVIEW_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "framingSafety")) {
    suggestions.push(suggestion({
      id: "sug_framing_adjustment",
      type: "framing_adjustment",
      severity: "blocking",
      target: "framing",
      message: "Framing may hide the ball, players, or key action.",
      reasonCode: "FRAMING_SAFETY_FAILED",
      safeAction: "Use wide-safe framing or reduce crop aggression until reliable ball/action tracking is available.",
      relatedMetric: "framingSafety",
      relatedFailureCode: failureCode(report, "framingSafety", "REVIEW_CRITICAL_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "aspectRatioCorrectness")) {
    suggestions.push(suggestion({
      id: "sug_aspect_ratio_fix",
      type: "aspect_ratio_fix",
      severity: "blocking",
      target: "editPlan",
      message: "The render aspect ratio does not match the expected review target.",
      reasonCode: "ASPECT_RATIO_MISMATCH",
      safeAction: "Regenerate the edit plan with the expected aspect ratio before rendering again.",
      relatedMetric: "aspectRatioCorrectness",
      relatedFailureCode: failureCode(report, "aspectRatioCorrectness", "REVIEW_CRITICAL_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "animationCueCoverage") || metricFailed(report, "referenceStyleSimilarity")) {
    suggestions.push(suggestion({
      id: "sug_animation_cues",
      type: "animation_cue_adjustment",
      severity: "warning",
      target: "animation",
      message: "Animation cues do not yet match the reference-style expectation.",
      reasonCode: "ANIMATION_CUE_GAP",
      safeAction: "Add or retime supported kinetic caption, punch zoom, impact flash, or replay cues only where action evidence supports them.",
      relatedMetric: metricFailed(report, "animationCueCoverage") ? "animationCueCoverage" : "referenceStyleSimilarity",
      relatedFailureCode: failureCode(report, "animationCueCoverage", "REVIEW_METRIC_FAILED") || failureCode(report, "referenceStyleSimilarity", "REVIEW_METRIC_FAILED"),
    }));
  }

  if (metricFailed(report, "reviewerReadinessScore") || failedCases.some((item) => /^REVIEW_(MEDIA|RIGHTS|REFERENCE|HUMAN_REVIEW)/.test(String(item && item.code)))) {
    suggestions.push(suggestion({
      id: "sug_reviewer_manual_check",
      type: "reviewer_manual_check",
      severity: "warning",
      target: "review",
      message: "The review sample needs operator confirmation before it can be used as quality evidence.",
      reasonCode: "REVIEWER_READINESS_GAP",
      safeAction: "Confirm rights, generated/source media availability, and human review notes before treating this output as product-ready.",
      relatedMetric: "reviewerReadinessScore",
      relatedFailureCode: failureCode(report, "reviewerReadinessScore", "REVIEW_REVIEWER_READINESS_FAILED"),
    }));
  }

  if (!suggestions.length && (report.passed === false || toNumber(report.metrics && report.metrics.overallScore, 100) < toNumber(report.threshold, 82))) {
    suggestions.push(suggestion({
      id: "sug_review_manual_triage",
      type: "reviewer_manual_check",
      severity: "warning",
      target: "review",
      message: "The review did not pass, but no specific auto-fix mapping is available.",
      reasonCode: "MANUAL_REVIEW_REQUIRED",
      safeAction: "Inspect failed criteria manually and rerun review comparison after a targeted fix.",
      relatedMetric: "overallScore",
      relatedFailureCode: "REVIEW_SCORE_BELOW_THRESHOLD",
    }));
  }

  return dedupeSuggestions(suggestions);
}

function buildRegenerationReadiness(suggestions) {
  const safeSuggestions = dedupeSuggestions(suggestions || []);
  const blockingSuggestionCount = safeSuggestions.filter((item) => item.severity === "blocking").length;
  return {
    regenerationAvailable: safeSuggestions.length > 0,
    regenerationPlan: null,
    suggestionCount: safeSuggestions.length,
    blockingSuggestionCount,
    nextAction: safeSuggestions.length
      ? blockingSuggestionCount
        ? "Create a safe regeneration draft, then resolve blocking items manually before any render."
        : "Create a safe regeneration draft for operator review; render remains locked."
      : "No regeneration suggestions are needed for this passing review.",
  };
}

module.exports = {
  ALLOWED_SEVERITIES,
  ALLOWED_TARGETS,
  ALLOWED_TYPES,
  SUGGESTION_SCHEMA_VERSION,
  buildRegenerationReadiness,
  buildReviewFixSuggestions,
  validateReviewSuggestion,
};
