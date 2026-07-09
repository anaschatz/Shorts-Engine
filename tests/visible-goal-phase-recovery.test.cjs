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
  assert.equal(recovery.selected.phaseCoverage.finishFrameEvidence.hasVisibleFinish, true);
  assert.equal(recovery.selected.phaseCoverage.finishFrameEvidence.hasBallInNetOrPayoff, true);
  assert.ok(recovery.selected.phaseCoverage.finishFrameEvidence.evidenceCodes.includes("finish_frame_visible"));
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

test("score-change recovery rejects goalmouth-only stable score change without visible payoff", () => {
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

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "NO_FINISH_VISIBLE");
  assert.equal(recovery.bindingDiagnostics.fullSourceScanUsed, false);
  assert.equal(recovery.bindingDiagnostics.maxBackwardSeconds, 50);
  assert.ok(recovery.bindingDiagnostics.sampledFrameBudget <= 24);
});

test("score-change recovery anchors source start before the scoreboard change instead of narrow confirmation", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 96, end: 97, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 98, end: 99, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 100, end: 101, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 100,
      actionAnchorTime: 100,
      startScore: "0-0",
      endScore: "0-1",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.selected.bindingMethod, "scoreboard_change_reverse_search");
  assert.equal(recovery.selected.scoreChangeTime, 100);
  assert.equal(recovery.selected.secondsBeforeScoreChange >= 20, true);
  assert.equal(recovery.selected.sourceStart <= 80, true);
  assert.equal(recovery.selected.shotStart < recovery.selected.scoreChangeTime, true);
  assert.equal(recovery.selected.finishTime < recovery.selected.scoreChangeTime, true);
});

test("score-change recovery rejects uncertain goalmouth-only payoff windows", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 96, end: 97, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 98, end: 99, types: ["goal_mouth_visible"], confidence: 0.9 },
      { start: 100, end: 101, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 100,
      actionAnchorTime: 100,
      startScore: "1-1",
      endScore: "2-1",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "NO_FINISH_VISIBLE");
  assert.equal(recovery.bindingDiagnostics.fullSourceScanUsed, false);
});

test("score-change recovery prefers visible finish closest to stable scoreboard change", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata: { durationSeconds: 600, width: 1920, height: 1080 },
    visualSignals: visualSignals([
      { start: 524, end: 526, types: ["fast_break_motion", "ball_visible"], confidence: 0.8 },
      { start: 529, end: 530, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
      { start: 531, end: 532, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.9 },
      { start: 544, end: 546, types: ["fast_break_motion", "ball_visible"], confidence: 0.78 },
      { start: 549, end: 550, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.88 },
      { start: 552, end: 553, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.88 },
      { start: 555, end: 556, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 555.72,
      actionAnchorTime: 555.72,
      startScore: "2-1",
      endScore: "2-2",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.notEqual(recovery.selected.bindingStrategy, "score_change_inferred_payoff");
  assert.ok(recovery.selected.finishTime >= 552);
  assert.ok(recovery.selected.finishTime < recovery.selected.scoreChangeTime);
  assert.ok(recovery.selected.scoreChangeTime - recovery.selected.finishTime <= 6);
  assert.notEqual(recovery.selected.finishTime, 532);
});

test("score-change recovery prefers the live finish 13-15 seconds before delayed scoreboard change", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata: { durationSeconds: 320, width: 1920, height: 1080 },
    visualSignals: visualSignals([
      { start: 236, end: 238, types: ["fast_break_motion", "ball_visible"], confidence: 0.82 },
      { start: 241, end: 242, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.86 },
      { start: 243, end: 244, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.88 },
      { start: 246, end: 248, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: 250, end: 251, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
      { start: 252, end: 253, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      { start: 267, end: 268, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 267,
      actionAnchorTime: 267,
      startScore: "1-0",
      endScore: "1-1",
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.notEqual(recovery.selected.bindingStrategy, "score_change_inferred_payoff");
  assert.ok(recovery.selected.finishTime >= 252);
  assert.ok(recovery.selected.scoreChangeTime - recovery.selected.finishTime >= 13);
  assert.ok(recovery.selected.scoreChangeTime - recovery.selected.finishTime <= 16);
  assert.notEqual(recovery.selected.finishTime, 244);
});

test("score-change recovery does not borrow the next close goal finish window", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata: { durationSeconds: 540, width: 1920, height: 1080 },
    visualSignals: visualSignals([
      { start: 466, end: 472, types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      { start: 474, end: 475, type: "scoreboard_goal_confirmed", confidence: 0.9 },
      { start: 479, end: 483, types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 483.75, end: 484.75, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 474,
      actionAnchorTime: 474,
      outcome: "counted_goal",
      startScore: "1-0",
      endScore: "1-1",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.ok(recovery.selected.finishTime <= 472.25);
  assert.ok(recovery.selected.confirmationTime <= 475);
  assert.notEqual(recovery.selected.finishTime, 483);
});

test("score-change recovery does not borrow the previous close goal finish window", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata: { durationSeconds: 540, width: 1920, height: 1080 },
    minActionTime: 474.25,
    visualSignals: visualSignals([
      { start: 466, end: 472, types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      { start: 474, end: 475, type: "scoreboard_goal_confirmed", confidence: 0.9 },
      { start: 479, end: 483, types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 483.75, end: 484.75, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    change: {
      changeTime: 483.75,
      actionAnchorTime: 483.75,
      outcome: "counted_goal",
      startScore: "1-1",
      endScore: "2-1",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    },
  });

  assert.equal(recovery.failureCode, null);
  assert.ok(recovery.selected.sourceStart >= 474.25);
  assert.ok(recovery.selected.finishTime >= 483);
  assert.notEqual(recovery.selected.finishTime, 472);
  assert.equal(recovery.bindingDiagnostics.minActionTime, 474.25);
});

test("score-change recovery uses bounded fallback window for earlier live phase", () => {
  const recovery = analyzeVisibleGoalPhaseRecovery({
    metadata,
    visualSignals: visualSignals([
      { start: 234.5, end: 236, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 238, end: 240, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.89 },
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
  assert.ok(recovery.selected.sourceStart <= 237);
});

test("candidate recovery rejects strong live phase without explicit visible payoff", () => {
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

  assert.equal(recovery.selected, null);
  assert.equal(recovery.failureCode, "NO_FINISH_VISIBLE");
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
