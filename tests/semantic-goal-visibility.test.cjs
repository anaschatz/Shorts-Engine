const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSemanticGoalFrames,
  classifyFeatures,
} = require("../server/semantic-goal-visibility.cjs");

test("semantic goal visibility classifies goalmouth finish features as clear", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.26,
    whiteRatio: 0.034,
    darkRatio: 0.18,
    skinRatio: 0.012,
    saturatedColorRatio: 0.16,
    blackBarRatio: 0,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.hasVisibleFinish, true);
  assert.equal(evidence.hasBallInNetOrPayoff, true);
  assert.equal(evidence.hasGoalMouth, true);
});

test("semantic goal visibility rejects player closeup frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.04,
    whiteRatio: 0.01,
    darkRatio: 0.16,
    skinRatio: 0.08,
    saturatedColorRatio: 0.2,
    blackBarRatio: 0,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects scoreboard-only frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.01,
    whiteRatio: 0.12,
    darkRatio: 0.35,
    skinRatio: 0,
    saturatedColorRatio: 0.04,
    blackBarRatio: 0.02,
  }, "confirmation");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.scoreboardOnly, true);
  assert.ok(evidence.reasons.includes("semantic_scoreboard_only"));
});

test("semantic goal visibility preserves safe existing clear evidence", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        hasVisibleFinish: true,
        hasBallInNetOrPayoff: true,
      },
    }],
  });

  assert.equal(result.clearFrameCount, 1);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "clear");
});

test("semantic goal visibility rejects existing replay evidence", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        replayOnly: true,
      },
    }],
  });

  assert.equal(result.clearFrameCount, 0);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "failed");
});
