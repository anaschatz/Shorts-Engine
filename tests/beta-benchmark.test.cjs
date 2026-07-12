const test = require("node:test");
const assert = require("node:assert/strict");

const { buildBetaBenchmark } = require("../eval/beta-benchmark.cjs");

function review(overrides = {}) {
  return {
    criteria: {
      moment_selection: { score: 5 },
      ball_player_framing: { score: 4 },
      caption_action_alignment: { score: 4 },
      pacing_energy: { score: 4 },
      false_goal_guard: { score: 5 },
      overall_short_quality: { score: 4 },
    },
    flags: { falseGoalClaim: false },
    ...overrides,
  };
}

function match(index, overrides = {}) {
  return {
    matchId: `match_${String(index).padStart(2, "0")}`,
    rightsConfirmed: true,
    renderStatus: "completed",
    acceptedWithoutEdit: index <= 16,
    costUsd: 0.42,
    review: review(),
    ...overrides,
  };
}

test("20 rights-cleared scored matches produce measurable beta metrics", () => {
  const report = buildBetaBenchmark({
    datasetId: "beta_fixture",
    matches: Array.from({ length: 20 }, (_, index) => match(index + 1)),
  }, { now: "2026-07-10T20:00:00.000Z" });

  assert.equal(report.status, "passed");
  assert.equal(report.metrics.matchCount, 20);
  assert.equal(report.metrics.acceptedWithoutEditRate, 0.8);
  assert.equal(report.metrics.falseGoalRate, 0);
  assert.equal(report.metrics.renderFailureRate, 0);
  assert.equal(report.metrics.costPerVideoUsd, 0.42);
  assert.equal(report.metrics.costPerCompletedVideoUsd, 0.42);
  assert.equal(report.metrics.humanScores.moment_selection, 5);
});

test("benchmark blocks incomplete rights, reviews, cost and unsafe quality", () => {
  const matches = Array.from({ length: 20 }, (_, index) => match(index + 1));
  matches[0] = match(1, {
    rightsConfirmed: false,
    acceptedWithoutEdit: false,
    costUsd: null,
    review: review({ flags: { falseGoalClaim: true } }),
  });
  matches[1] = match(2, { renderStatus: "failed", review: null, acceptedWithoutEdit: null });
  const report = buildBetaBenchmark({
    matches,
    thresholds: { maxRenderFailureRate: 0.01, minCostCoverageRate: 1 },
  });

  assert.equal(report.status, "blocked");
  assert.ok(report.failedChecks.includes("rights_cleared"));
  assert.ok(report.failedChecks.includes("false_goal_rate"));
  assert.ok(report.failedChecks.includes("render_failure_rate"));
  assert.ok(report.failedChecks.includes("cost_coverage"));
});

test("benchmark rejects duplicate and malformed match records", () => {
  const matches = Array.from({ length: 20 }, (_, index) => match(index + 1));
  matches[1].matchId = matches[0].matchId;
  matches[2].renderStatus = "unknown";
  const report = buildBetaBenchmark({ matches });

  assert.equal(report.productionBetaReady, false);
  assert.equal(report.invalidEntryCount, 1);
  assert.equal(report.duplicateMatchIdCount, 1);
  assert.ok(report.failedChecks.includes("all_entries_valid"));
});
