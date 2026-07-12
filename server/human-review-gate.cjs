const { sanitizeText } = require("./media.cjs");

const REVIEW_REASON_CODES = Object.freeze([
  "uncertain_goal_evidence",
  "possible_goal_unconfirmed",
  "ambiguous_score_change",
  "counted_goal_missing_visual_support",
]);

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function uniqueReasons(values = []) {
  return [...new Set(values)]
    .filter((value) => REVIEW_REASON_CODES.includes(value))
    .slice(0, REVIEW_REASON_CODES.length);
}

function createHumanReviewGate(matchEventTruth = {}, options = {}) {
  const summary = matchEventTruth && typeof matchEventTruth.summary === "object"
    ? matchEventTruth.summary
    : {};
  const scoreChanges = Array.isArray(matchEventTruth.scoreChanges) ? matchEventTruth.scoreChanges : [];
  const uncertainReviewItemCount = count(summary.uncertainReviewItemCount);
  const possibleGoalCount = count(summary.possibleGoalCount);
  const missingVisualSupportCount = count(summary.anchorsMissingVisualSupportCount);
  const ambiguousScoreChangeCount = scoreChanges.filter((change) => (
    change && change.outcome === "uncertain_review"
  )).length;
  const reasonCodes = uniqueReasons([
    uncertainReviewItemCount > 0 ? "uncertain_goal_evidence" : null,
    possibleGoalCount > 0 ? "possible_goal_unconfirmed" : null,
    ambiguousScoreChangeCount > 0 ? "ambiguous_score_change" : null,
    missingVisualSupportCount > 0 ? "counted_goal_missing_visual_support" : null,
  ]);
  const requiresReview = reasonCodes.length > 0;
  const approved = options.approved === true;
  return {
    schemaVersion: 1,
    status: approved ? "approved" : requiresReview ? "required" : "not_required",
    requiresReview: requiresReview && !approved,
    reviewed: approved,
    reasonCodes,
    reviewItemCount: Math.max(
      uncertainReviewItemCount,
      possibleGoalCount,
      ambiguousScoreChangeCount,
      missingVisualSupportCount,
    ),
    previewPolicy: "allowed",
    publishingPolicy: requiresReview && !approved ? "human_approval_required" : "automatic_allowed",
    nextAction: requiresReview && !approved ? "complete-human-goal-review" : null,
    source: sanitizeText(options.source || "match_event_truth", 48),
  };
}

function publicHumanReviewGate(value = {}) {
  const reasonCodes = uniqueReasons(Array.isArray(value.reasonCodes) ? value.reasonCodes : []);
  const approved = value.status === "approved" || value.reviewed === true;
  const requiresReview = value.requiresReview === true && !approved;
  return {
    schemaVersion: 1,
    status: approved ? "approved" : requiresReview ? "required" : "not_required",
    requiresReview,
    reviewed: approved,
    reasonCodes,
    reviewItemCount: count(value.reviewItemCount),
    previewPolicy: "allowed",
    publishingPolicy: requiresReview ? "human_approval_required" : "automatic_allowed",
    nextAction: requiresReview ? "complete-human-goal-review" : null,
    source: sanitizeText(value.source || "match_event_truth", 48),
  };
}

module.exports = {
  REVIEW_REASON_CODES,
  createHumanReviewGate,
  publicHumanReviewGate,
};
