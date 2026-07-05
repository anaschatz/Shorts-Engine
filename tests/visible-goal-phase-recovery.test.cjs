const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeVisibleGoalPhaseRecovery,
  analyzeVisibleGoalCandidateRecovery,
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

test("score-change recovery binds stable score change to inferred live finish without full-source scan", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 248, end: 249, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: 252, end: 254, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 257, end: 259, types: ["goal_mouth_visible"], confidence: 0.9 },
      { start: 271, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.88 },
    ]),
    change: {
      changeTime: 272,
      actionAnchorTime: 272,
      startScore: "1-0",
      endScore: "2-0",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.selected.primarySource, "live_action");
  assert.equal(recovery.selected.replayOnly, false);
  assert.equal(recovery.selected.phaseCoverage.hasShot, true);
  assert.equal(recovery.selected.phaseCoverage.hasFinish, true);
  assert.equal(recovery.selected.phaseCoverage.visualGoalPayoff.hasBallInNetEvidence, false);
  assert.equal(recovery.selected.phaseCoverage.visualGoalPayoff.inferredFromStableScoreChange, true);
  assert.equal(recovery.bindingDiagnostics.fullSourceScanUsed, false);
  assert.equal(recovery.bindingDiagnostics.maxBackwardSeconds, 25);
  assert.ok(recovery.bindingDiagnostics.sampledFrameBudget <= 24);
});

test("score-change recovery uses bounded fallback window for earlier live phase", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 239, end: 241, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 244, end: 246, types: ["goal_mouth_visible"], confidence: 0.89 },
      { start: 271, end: 272, type: "scoreboard_goal_confirmed", confidence: 0.88 },
    ]),
    change: {
      changeTime: 272,
      actionAnchorTime: 272,
      startScore: "1-0",
      endScore: "2-0",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.bindingDiagnostics.fallbackUsed, true);
  assert.equal(recovery.bindingDiagnostics.maxBackwardSeconds, 35);
  assert.equal(recovery.bindingDiagnostics.fullSourceScanUsed, false);
  assert.ok(recovery.selected.sourceStart <= 239);
});

test("candidate recovery selects strong live phase without explicit ball-in-net OCR", () => {
  const recovery = analyzeVisibleGoalCandidateRecovery({
    metadata,
    event: {
      id: "live_goal_candidate",
      start: 246,
      end: 266,
      outcomeHint: "non_goal_chance",
      recoveryEligibility: "recoverable_live_goal_candidate",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_goal_mouth",
        "visual_crowd_reaction",
        "replay_goal_confirmation",
        "live_shot_finish_sequence",
      ],
    },
    visualSignals: visualSignals([
      { start: 246, end: 248, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
      { start: 252, end: 254, types: ["goal_mouth_visible", "crowd_reaction"], confidence: 0.88 },
      { start: 260, end: 264, types: ["replay_indicator", "replay_angle"], confidence: 0.84 },
    ]),
  });

  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.selected.primarySource, "live_action");
  assert.equal(recovery.selected.replayOnly, false);
  assert.equal(recovery.selected.phaseCoverage.hasShot, true);
  assert.equal(recovery.selected.phaseCoverage.hasFinish, true);
  assert.equal(recovery.selected.phaseCoverage.visualGoalPayoff.hasBallInNetEvidence, false);
  assert.equal(recovery.selected.phaseCoverage.visualGoalPayoff.hasLiveFinishSequence, true);
});

test("candidate recovery rejects offside or no-goal candidates even with strong visuals", () => {
  const recovery = analyzeVisibleGoalCandidateRecovery({
    metadata,
    event: {
      id: "offside_candidate",
      start: 246,
      end: 266,
      outcomeHint: "offside_goal",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_goal_mouth",
        "visual_offside_flag",
        "live_shot_finish_sequence",
      ],
    },
    visualSignals: visualSignals([
      { start: 246, end: 248, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
      { start: 252, end: 254, types: ["goal_mouth_visible", "crowd_reaction"], confidence: 0.88 },
    ]),
  });

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "DISQUALIFIED_NO_GOAL");
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
  assert.equal(report.bindingDiagnostics.fullSourceScanUsed, false);
  assert.ok(report.sampledTimestamps.length >= 4);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|OPENAI_API_KEY|token|secret|stderr|stdout|raw/i);
});
