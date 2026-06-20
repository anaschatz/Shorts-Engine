const test = require("node:test");
const assert = require("node:assert/strict");

const {
  captionEvidenceInRange,
  decisionVisualEvidence,
  resolveGoalOutcome,
} = require("../server/goal-outcome.cjs");

function baseGoalEvidence() {
  return {
    hasBallInNetOrLineCross: true,
    hasShotContact: true,
    hasBallTowardGoal: true,
    hasGoalMouthFrame: true,
    confidence: 0.9,
    payoffEnd: 10.2,
  };
}

test("goal outcome resolver marks flag and no-goal evidence as disallowed offside", () => {
  const outcome = resolveGoalOutcome({
    reasons: ["goal", "visual_ball_in_net"],
    goalEvidence: baseGoalEvidence(),
    visualWindows: [
      { start: 18, end: 20, types: ["assistant_referee_flag", "referee_no_goal_signal"], confidence: 0.9 },
    ],
    captions: [{ start: 18.2, end: 19.5, text: "The flag is up, no goal for offside" }],
    start: 4,
    end: 22,
    payoffEnd: 10.2,
  });

  assert.equal(outcome.outcome, "disallowed_offside");
  assert.equal(outcome.offsideStatus, "offside");
  assert.equal(outcome.safeCaptionBadge, "OFFSIDE - NO GOAL");
  assert.equal(outcome.requiresPostContext, true);
  assert.deepEqual(outcome.decisionWindow, { start: 9.95, end: 22 });
  assert.ok(outcome.decisionEvidence.includes("visual_referee_no_goal_signal"));
});

test("goal outcome resolver keeps weak VAR evidence as possible offside", () => {
  const outcome = resolveGoalOutcome({
    reasons: ["goal", "visual_ball_in_net"],
    goalEvidence: baseGoalEvidence(),
    visualWindows: [{ start: 14, end: 16, types: ["var_check_graphic"], confidence: 0.78 }],
    captions: [{ start: 14.2, end: 15.4, text: "VAR check is underway" }],
    start: 5,
    end: 20,
    payoffEnd: 10.2,
  });

  assert.equal(outcome.outcome, "possible_offside");
  assert.equal(outcome.offsideStatus, "possible");
  assert.equal(outcome.safeCaptionBadge, "VAR CHECK");
  assert.ok(outcome.decisionEvidence.includes("visual_var_check"));
});

test("goal outcome resolver requires explicit confirmation for confirmed goal", () => {
  const plainFinish = resolveGoalOutcome({
    reasons: ["goal", "visual_ball_in_net"],
    goalEvidence: baseGoalEvidence(),
    captions: [{ start: 11, end: 12, text: "The striker finishes into the net" }],
    start: 5,
    end: 18,
    payoffEnd: 10.2,
  });
  const confirmed = resolveGoalOutcome({
    reasons: ["goal", "visual_ball_in_net"],
    goalEvidence: baseGoalEvidence(),
    visualWindows: [{ start: 13, end: 14, types: ["scoreboard_goal_confirmed"], confidence: 0.83 }],
    captions: [{ start: 13.2, end: 14.2, text: "Goal confirmed, it counts" }],
    start: 5,
    end: 18,
    payoffEnd: 10.2,
  });

  assert.equal(plainFinish.outcome, "unknown_decision");
  assert.equal(plainFinish.safeCaptionBadge, "DECISION UNCLEAR");
  assert.equal(confirmed.outcome, "confirmed_goal");
  assert.equal(confirmed.offsideStatus, "onside");
  assert.equal(confirmed.safeCaptionBadge, "CONFIRMED GOAL");
  assert.equal(confirmed.requiresPostContext, false);
});

test("goal outcome resolver keeps decision windows valid when payoff extends beyond candidate end", () => {
  const outcome = resolveGoalOutcome({
    reasons: ["goal", "visual_ball_in_net", "combined_goal_confirmation"],
    goalEvidence: {
      ...baseGoalEvidence(),
      payoffEnd: 22.4,
    },
    captions: [{ start: 23, end: 24, text: "The goal stands after restart" }],
    start: 12,
    end: 20,
    payoffEnd: 22.4,
  });

  assert.equal(outcome.outcome, "confirmed_goal");
  assert.equal(outcome.decisionWindow.start, 22.15);
  assert.ok(outcome.decisionWindow.end > outcome.decisionWindow.start);
});

test("goal outcome evidence helpers reject raw logs and expose only safe evidence codes", () => {
  const evidence = captionEvidenceInRange([
    { start: 9, end: 10, text: "No goal after VAR" },
  ], 8, 12);
  const visual = decisionVisualEvidence([
    { start: 9, end: 10, types: ["scoreboard_goal_removed", "replay_angle"], localPath: "/Users/example/private.png" },
  ]);

  assert.deepEqual(evidence[0].evidence, ["disallowed_commentary", "var_check", "no_goal_commentary"]);
  assert.deepEqual(visual, ["visual_scoreboard_goal_removed", "visual_replay_angle"]);
  assert.doesNotMatch(JSON.stringify({ evidence, visual }), /\/Users|private/i);
});
