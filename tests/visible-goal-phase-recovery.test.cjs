const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeVisibleGoalPhaseRecovery,
  publicVisibleGoalPhaseRecovery,
} = require("../server/visible-goal-phase-recovery.cjs");

function visualSignals(windows) {
  return {
    providerMode: "fixture-vision",
    fallbackUsed: false,
    windows,
  };
}

const metadata = Object.freeze({ durationSeconds: 420, width: 1920, height: 1080 });

test("score-change recovery searches backward to select visible live goal phase", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 250, end: 252, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 255, end: 257, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 270, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.9 },
      { start: 276, end: 280, types: ["replay_indicator", "replay_angle"], confidence: 0.88 },
    ]),
    change: {
      changeTime: 272,
      actionAnchorTime: 272,
      startScore: "1-0",
      endScore: "2-0",
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.selected.primarySource, "live_action");
  assert.equal(recovery.selected.replayOnly, false);
  assert.ok(recovery.selected.sourceStart <= 250);
  assert.ok(recovery.selected.finishTime >= 257);
  assert.equal(recovery.selected.phaseCoverage.visualGoalPayoff.hasVisibleGoalPayoff, true);
  assert.ok(recovery.rejectedReplayWindows.length >= 1);
});

test("score-change recovery rejects scoreboard-only anchors", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 270, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.9 },
      { start: 272, end: 274, type: "scoreboard_context", confidence: 0.8 },
    ]),
    change: {
      changeTime: 272,
      startScore: "1-0",
      endScore: "2-0",
    },
  });

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "SCOREBOARD_ONLY");
  assert.equal(recovery.rejectedScoreboardOnlyWindows.length, 2);
});

test("score-change recovery rejects replay-only visible finish", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 268, end: 271, types: ["replay_indicator", "replay_angle", "ball_in_net"], confidence: 0.91 },
      { start: 272, end: 274, type: "crowd_reaction", confidence: 0.84 },
    ]),
    change: {
      changeTime: 274,
      startScore: "1-0",
      endScore: "2-0",
    },
  });

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "REPLAY_ONLY");
  assert.ok(recovery.rejectedReplayWindows.length >= 1);
});

test("score-change recovery rejects shot without visible payoff", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 250, end: 252, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 270, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 272,
      startScore: "1-0",
      endScore: "2-0",
    },
  });

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "NO_FINISH_VISIBLE");
});

test("public recovery report has safe diagnostics only", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 250, end: 252, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 255, end: 257, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 270, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 272,
      startScore: "1-0",
      endScore: "2-0",
    },
  });
  const report = publicVisibleGoalPhaseRecovery(recovery);

  assert.equal(report.logsDownloaded, false);
  assert.equal(report.artifactsDownloaded, false);
  assert.ok(report.sampledTimestamps.length >= 4);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|OPENAI_API_KEY|token|secret|stderr|stdout|raw/i);
});
