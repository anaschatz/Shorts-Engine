const test = require("node:test");
const assert = require("node:assert/strict");

const { validateHumanVisibleGoalSequence } = require("../server/human-visible-goal-gate.cjs");

function baseSegment(overrides = {}) {
  return {
    sourceStart: 10,
    shotStart: 18,
    finishTime: 22,
    confirmationTime: 24,
    sourceEnd: 27,
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      replayOnly: false,
    },
    reasonCodes: [
      "visual_shot_contact",
      "visual_ball_toward_goal",
      "visual_goal_mouth",
      "visual_ball_in_net",
      "visual_scoreboard_goal_confirmed",
    ],
    ...overrides,
  };
}

test("human-visible goal gate accepts visible buildup, shot, finish, and confirmation", () => {
  const gate = validateHumanVisibleGoalSequence({ segment: baseSegment() });

  assert.equal(gate.passed, true);
  assert.equal(gate.failureCode, null);
  assert.equal(gate.evidence.hasBuildupFrames, true);
  assert.equal(gate.evidence.hasShotFrames, true);
  assert.equal(gate.evidence.hasGoalmouthFrames, true);
  assert.equal(gate.evidence.hasPayoffFrames, true);
  assert.equal(gate.evidence.hasConfirmationAfterFinish, true);
  assert.ok(gate.sampledFrames.some((frame) => frame.label === "finish"));
});

test("human-visible goal gate rejects scoreboard-only goal claims", () => {
  const gate = validateHumanVisibleGoalSequence({
    segment: baseSegment({
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency", "scoreboard_backed_goal_sequence"],
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
      },
    }),
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.failureCode, "SCOREBOARD_ONLY");
  assert.equal(gate.evidence.hasPayoffFrames, false);
});

test("human-visible goal gate rejects celebration-only goal claims", () => {
  const gate = validateHumanVisibleGoalSequence({
    segment: baseSegment({
      reasonCodes: ["visual_celebration_after_shot", "visual_crowd_reaction"],
      phaseCoverage: {
        hasBuildup: false,
        hasShot: false,
        hasFinish: false,
        hasConfirmation: true,
      },
    }),
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.failureCode, "CELEBRATION_ONLY");
});

test("human-visible goal gate rejects replay-only primary segments", () => {
  const gate = validateHumanVisibleGoalSequence({
    segment: baseSegment({
      replayOnly: true,
      reasonCodes: ["visual_replay_indicator", "visual_ball_in_net", "visual_scoreboard_goal_confirmed"],
    }),
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.failureCode, "REPLAY_ONLY");
});

test("human-visible goal gate rejects shot-like motion without visible finish", () => {
  const gate = validateHumanVisibleGoalSequence({
    segment: baseSegment({
      reasonCodes: [
        "visual_shot_like_motion",
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        "shot_sequence_support",
        "live_shot_finish_sequence",
      ],
    }),
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.failureCode, "NO_FINISH_VISIBLE");
  assert.equal(gate.evidence.hasShotFrames, true);
  assert.equal(gate.evidence.hasGoalmouthFrames, false);
});
