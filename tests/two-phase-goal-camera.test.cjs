const test = require("node:test");
const assert = require("node:assert/strict");

const { twoPhaseGoalCameraSummary } = require("../server/render.cjs");

test("two-phase camera requires ball coverage before scorer or group follow", () => {
  const summary = twoPhaseGoalCameraSummary({
    segments: [{
      goalNumber: 1,
      sourceStart: 2,
      finishTime: 10,
      confirmationTime: 16,
      sourceEnd: 18,
    }],
    visualTrackingSummary: { trackingSamples: [
      { sourceTime: 3, ballBox: { x: 290, y: 440, width: 20, height: 20 } },
      { sourceTime: 7, ballBox: { x: 690, y: 430, width: 20, height: 20 } },
      { sourceTime: 9.7, ballBox: { x: 890, y: 420, width: 20, height: 20 } },
    ] },
    cropPlan: {
      cropBox: { x: 0, y: 0, width: 608, height: 1080 },
      keyframes: [
        { sourceTime: 3, centerX: 300, source: "ball_detection", phase: "ball_follow", confidence: 0.82 },
        { sourceTime: 7, centerX: 700, source: "ball_detection", phase: "ball_follow", confidence: 0.86 },
        { sourceTime: 9.7, centerX: 900, source: "ball_interpolation", phase: "ball_follow", confidence: 0.72 },
        { sourceTime: 11, source: "celebration_group_fallback", phase: "scorer_follow", confidence: 0.78 },
        { sourceTime: 15, source: "celebration_group_fallback", phase: "scorer_follow", confidence: 0.8 },
      ],
    },
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.coveredGoalCount, 1);
  assert.equal(summary.goals[0].targetSwitchTime, 10);
  assert.equal(summary.goals[0].ballVisibilityCoverage, 1);
  assert.equal(summary.goals[0].ballCenterCoverage, 1);
  assert.equal(summary.goals[0].ballVerticalSafeCoverage, 1);
  assert.equal(summary.goals[0].scorerTargetMode, "celebration_group_fallback");
  assert.equal(summary.goalClaimAllowed, false);
});

test("two-phase camera accepts an honest wide celebration fallback", () => {
  const summary = twoPhaseGoalCameraSummary({
    segments: [{ goalNumber: 1, sourceStart: 2, finishTime: 10, confirmationTime: 16, sourceEnd: 18 }],
    visualTrackingSummary: { trackingSamples: [
      { sourceTime: 3, ballBox: { x: 290, y: 440, width: 20, height: 20 } },
      { sourceTime: 9.7, ballBox: { x: 890, y: 420, width: 20, height: 20 } },
    ] },
    cropPlan: { cropBox: { x: 0, y: 0, width: 608, height: 1080 }, keyframes: [
      { sourceTime: 3, centerX: 300, source: "ball_detection", phase: "ball_follow", confidence: 0.82 },
      { sourceTime: 9.7, centerX: 900, source: "ball_detection", phase: "ball_follow", confidence: 0.8 },
      { sourceTime: 12, source: "celebration_wide_safe_fallback", phase: "scorer_follow", confidence: 0.45 },
    ] },
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.goals[0].scorerTargetMode, "celebration_wide_safe_fallback");
  assert.equal(summary.goals[0].scorerHeadCoverage, 0);
  assert.equal(summary.goalClaimAllowed, false);
});
