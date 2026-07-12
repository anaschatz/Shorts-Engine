const test = require("node:test");
const assert = require("node:assert/strict");

const { createHumanReviewGate, publicHumanReviewGate } = require("../server/human-review-gate.cjs");

test("uncertain goals require human approval before publishing", () => {
  const gate = createHumanReviewGate({
    summary: {
      uncertainReviewItemCount: 1,
      possibleGoalCount: 1,
      anchorsMissingVisualSupportCount: 0,
    },
    scoreChanges: [{ outcome: "uncertain_review" }],
  });

  assert.equal(gate.status, "required");
  assert.equal(gate.requiresReview, true);
  assert.equal(gate.previewPolicy, "allowed");
  assert.equal(gate.publishingPolicy, "human_approval_required");
  assert.deepEqual(gate.reasonCodes, [
    "uncertain_goal_evidence",
    "possible_goal_unconfirmed",
    "ambiguous_score_change",
  ]);
});

test("clear decisions stay automatic and approved reviews release the gate", () => {
  const clear = createHumanReviewGate({ summary: { confirmedGoalCount: 2 } });
  assert.equal(clear.status, "not_required");
  assert.equal(clear.publishingPolicy, "automatic_allowed");

  const approved = createHumanReviewGate({
    summary: { uncertainReviewItemCount: 2 },
  }, { approved: true, source: "operator_review" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.requiresReview, false);
  assert.equal(publicHumanReviewGate(approved).reviewed, true);
});
