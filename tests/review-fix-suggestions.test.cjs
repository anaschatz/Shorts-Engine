const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRegenerationReadiness,
  buildReviewFixSuggestions,
  validateReviewSuggestion,
} = require("../eval/review-fix-suggestions.cjs");
const { findReviewSensitiveLeak } = require("../eval/review-comparison.cjs");

function report(overrides = {}) {
  return {
    passed: false,
    threshold: 82,
    metrics: {
      momentTypeMatch: 1,
      noFalseGoalClaim: 1,
      captionActionAlignment: 1,
      captionSpecificity: 1,
      framingSafety: 1,
      aspectRatioCorrectness: 1,
      pacingScore: 1,
      animationCueCoverage: 1,
      referenceStyleSimilarity: 1,
      reviewerReadinessScore: 1,
      overallScore: 70,
      ...(overrides.metrics || {}),
    },
    failedCriteria: overrides.failedCriteria || [],
    failedCases: overrides.failedCases || [{ code: "REVIEW_SCORE_BELOW_THRESHOLD", message: "Score below threshold.", field: "overallScore" }],
    ...overrides,
  };
}

test("review fix suggestions stay empty for clean passing reviews", () => {
  const suggestions = buildReviewFixSuggestions(report({
    passed: true,
    metrics: { overallScore: 96 },
    failedCriteria: [],
    failedCases: [],
  }));
  assert.deepEqual(suggestions, []);
  const readiness = buildRegenerationReadiness(suggestions);
  assert.equal(readiness.regenerationAvailable, false);
  assert.equal(readiness.suggestionCount, 0);
  assert.equal(readiness.blockingSuggestionCount, 0);
});

test("false goal failures produce blocking false goal guard suggestions", () => {
  const suggestions = buildReviewFixSuggestions(report({
    metrics: { noFalseGoalClaim: 0 },
    failedCriteria: [{ metric: "noFalseGoalClaim", score: 0, min: 1 }],
    failedCases: [{ code: "REVIEW_CRITICAL_METRIC_FAILED", message: "noFalseGoalClaim failed.", field: "noFalseGoalClaim" }],
  }));
  assert.equal(suggestions[0].type, "false_goal_guard");
  assert.equal(suggestions[0].severity, "blocking");
  assert.equal(suggestions[0].target, "review");
  assert.equal(suggestions[0].canAutoApply, false);
  assert.equal(suggestions[0].requiresHumanReview, true);
  const readiness = buildRegenerationReadiness(suggestions);
  assert.equal(readiness.regenerationAvailable, true);
  assert.equal(readiness.regenerationPlan, null);
});

test("caption, framing, aspect and animation metrics map to specific suggestions", () => {
  const suggestions = buildReviewFixSuggestions(report({
    metrics: {
      captionActionAlignment: 0.2,
      captionSpecificity: 0.4,
      framingSafety: 0,
      aspectRatioCorrectness: 0,
      animationCueCoverage: 0.2,
      pacingScore: 0.4,
    },
    failedCriteria: [
      { metric: "captionActionAlignment", score: 0.2, min: 0.8 },
      { metric: "captionSpecificity", score: 0.4, min: 0.75 },
      { metric: "framingSafety", score: 0, min: 1 },
      { metric: "aspectRatioCorrectness", score: 0, min: 1 },
      { metric: "animationCueCoverage", score: 0.2, min: 0.75 },
      { metric: "pacingScore", score: 0.4, min: 0.75 },
    ],
  }));
  const types = new Set(suggestions.map((item) => item.type));
  assert.equal(types.has("caption_rewrite"), true);
  assert.equal(types.has("evidence_strengthening"), true);
  assert.equal(types.has("framing_adjustment"), true);
  assert.equal(types.has("aspect_ratio_fix"), true);
  assert.equal(types.has("animation_cue_adjustment"), true);
  assert.equal(types.has("caption_timing_adjustment"), true);
});

test("reviewer readiness and moment failures produce manual and reselection suggestions", () => {
  const suggestions = buildReviewFixSuggestions(report({
    metrics: {
      momentTypeMatch: 0,
      reviewerReadinessScore: 0.3,
    },
    failedCriteria: [
      { metric: "momentTypeMatch", score: 0, min: 1 },
      { metric: "reviewerReadinessScore", score: 0.3, min: 0.75 },
    ],
    failedCases: [{ code: "REVIEW_MEDIA_MISSING", message: "Media missing.", field: "media.generated" }],
  }));
  const types = new Set(suggestions.map((item) => item.type));
  assert.equal(types.has("moment_reselection"), true);
  assert.equal(types.has("reviewer_manual_check"), true);
});

test("review fix suggestion validation rejects unknown shape and unsafe fields", () => {
  assert.throws(
    () => validateReviewSuggestion({
      id: "sug_bad_type",
      type: "unknown",
      severity: "warning",
      target: "caption",
      message: "Bad",
      reasonCode: "BAD",
      safeAction: "Bad",
    }),
    /type/,
  );
  assert.throws(
    () => validateReviewSuggestion({
      id: "sug_bad_target",
      type: "caption_rewrite",
      severity: "warning",
      target: "storage",
      message: "Bad",
      reasonCode: "BAD",
      safeAction: "Bad",
    }),
    /target/,
  );
  assert.throws(
    () => validateReviewSuggestion({
      id: "sug_extra",
      type: "caption_rewrite",
      severity: "warning",
      target: "caption",
      message: "Bad",
      reasonCode: "BAD",
      safeAction: "Bad",
      storageKey: "unsafe",
    }),
    /unsupported field/,
  );
});

test("review fix suggestions redact unsafe values and expose no leaks", () => {
  const suggestion = validateReviewSuggestion({
    id: "sug_redaction",
    type: "caption_rewrite",
    severity: "warning",
    target: "caption",
    message: "Inspect /Users/example/private.mov",
    reasonCode: "CAPTION_ACTION_MISMATCH",
    safeAction: "Do not paste Bearer abc123 into reports.",
  });
  const payload = JSON.stringify(suggestion);
  assert.doesNotMatch(payload, /\/Users\/|Bearer abc123/i);
  assert.equal(findReviewSensitiveLeak(suggestion), null);
});
