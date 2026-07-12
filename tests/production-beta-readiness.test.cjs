const test = require("node:test");
const assert = require("node:assert/strict");

const { createProductionBetaReadiness } = require("../server/production-beta-readiness.cjs");

function evaluation() {
  return {
    status: "passed",
    productionBetaReady: true,
    metrics: {
      matchCount: 24,
      acceptedWithoutEditRate: 0.79,
      falseGoalRate: 0,
      renderFailureRate: 0.04,
      costPerVideoUsd: 0.5,
      costPerCompletedVideoUsd: 0.48,
    },
  };
}

test("production beta readiness requires every infrastructure and quality boundary", () => {
  const result = createProductionBetaReadiness({
    persistence: { mode: "postgres", ready: true },
    artifacts: { mode: "s3", ready: true },
    queue: { persisted: true, claimingSupported: true },
    auth: { mode: "oidc", ready: true },
    evaluation: evaluation(),
    humanReviewGateAvailable: true,
  });

  assert.equal(result.ready, true);
  assert.equal(result.stage, "production_beta");
  assert.deepEqual(result.blockers, []);
});

test("current local prototype reports honest production blockers", () => {
  const result = createProductionBetaReadiness({
    persistence: { mode: "sqlite", ready: true },
    artifacts: { mode: "local", ready: true },
    queue: { persisted: true, claimingSupported: true },
    auth: { mode: "operator", ready: true },
    evaluation: { status: "missing", productionBetaReady: false, metrics: null },
    humanReviewGateAvailable: true,
  });

  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("rights_cleared_human_evaluation"));
  assert.ok(result.blockers.includes("postgres_persistence"));
  assert.ok(result.blockers.includes("object_storage"));
  assert.ok(result.blockers.includes("durable_multi_worker_queue"));
  assert.ok(result.blockers.includes("accounts_identity"));
  assert.equal(result.blockers.includes("ambiguous_goal_human_review_gate"), false);
});
