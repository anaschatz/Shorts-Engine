const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeRenderedGoalProof } = require("../server/rendered-goal-proof.cjs");

function goalSegment(overrides = {}) {
  return {
    id: "goal_1",
    goalNumber: 1,
    highlightType: "goal",
    sourceStart: 80,
    shotStart: 88,
    finishTime: 92,
    confirmationTime: 96,
    sourceEnd: 100,
    duration: 20,
    replayOnly: false,
    reasonCodes: [
      "visual_shot_contact",
      "visual_ball_toward_goal",
      "scoreboard_ocr_score_change",
      "scoreboard_temporal_consistency",
    ],
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
    },
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      visualGoalPayoff: {
        hasLiveFinishSequence: true,
        evidenceCodes: ["visual_ball_in_net", "scoreboard_ocr_score_change"],
      },
    },
    finishFrameEvidence: {
      frameTime: 92,
      confidence: 0.9,
      visibilityVerdict: "clear",
      hasVisibleFinish: true,
      hasBallInNetOrPayoff: true,
      hasGoalMouth: true,
      hasPreShotActionFrame: true,
      hasFinishActionFrame: true,
      hasPayoffFrame: true,
      hasConfirmationFrame: true,
      continuousActionFrameCount: 4,
      evidenceCodes: ["finish_frame_visible", "ball_in_net_or_payoff_visible"],
    },
    ...overrides,
  };
}

function editPlan(segment) {
  return {
    mode: "valid_goals_only",
    totalDuration: 20,
    export: { width: 1080, height: 1920 },
    segments: [segment],
  };
}

test("rendered goal proof ignores stale source proof without rendered support frames", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({ frames: [] }),
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 1);
  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.equal(result.summary.goals[0].existingClearProofUsed, false);
  assert.equal(result.summary.goals[0].verdict, "failed");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
});

test("rendered goal proof requires extracted frames plus strong source evidence", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({
      frames: [
        { id: "pre", localPath: "pre.jpg", timestamp: 5 },
        { id: "finish", localPath: "finish.jpg", timestamp: 10 },
        { id: "payoff", localPath: "payoff.jpg", timestamp: 11 },
        { id: "confirmation", localPath: "confirmation.jpg", timestamp: 12 },
      ],
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 1);
  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.equal(result.summary.goals[0].verdict, "failed");
  assert.ok(result.summary.goals[0].failedFrameReasons.length > 0);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
});

test("rendered goal proof passes only with semantic validated goal frames", async () => {
  const semanticGoalEvidence = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({
      frames: [
        { id: "pre", localPath: "pre.jpg", timestamp: 5, visualHints: ["goal_role:pre_shot"], semanticGoalEvidence: { ...semanticGoalEvidence, roles: ["pre_shot"] } },
        { id: "finish", localPath: "finish.jpg", timestamp: 10, visualHints: ["goal_role:finish"], semanticGoalEvidence: { ...semanticGoalEvidence, roles: ["finish"] } },
        { id: "payoff", localPath: "payoff.jpg", timestamp: 11, visualHints: ["goal_role:payoff"], semanticGoalEvidence: { ...semanticGoalEvidence, roles: ["payoff"] } },
        { id: "confirmation", localPath: "confirmation.jpg", timestamp: 12, visualHints: ["goal_role:confirmation"], semanticGoalEvidence: { ...semanticGoalEvidence, roles: ["confirmation"] } },
      ],
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 1);
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.failedGoalCount, 0);
  assert.equal(result.summary.goals[0].verdict, "clear");
  assert.equal(result.summary.goals[0].unverifiedFrameCount, 0);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "clear");
});

test("rendered goal proof lets a clear finish frame satisfy payoff when later payoff samples are unclear", async () => {
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.91,
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({
      frames: [
        { id: "pre", localPath: "pre.jpg", timestamp: 5, visualHints: ["goal_role:pre_shot"], semanticGoalEvidence: { ...clear, roles: ["pre_shot"] } },
        { id: "finish", localPath: "finish.jpg", timestamp: 10, visualHints: ["goal_role:finish"], semanticGoalEvidence: { ...clear, roles: ["finish"] } },
        { id: "payoff", localPath: "payoff.jpg", timestamp: 11, visualHints: ["goal_role:payoff"], semanticGoalEvidence: { visibilityVerdict: "failed", visibleGoal: false, confidence: 0.2, reasons: ["semantic_frame_not_clear"], roles: ["payoff"] } },
        { id: "confirmation", localPath: "confirmation.jpg", timestamp: 12, visualHints: ["goal_role:confirmation"], semanticGoalEvidence: { ...clear, roles: ["confirmation"] } },
      ],
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.borderlineGoalCount, 0);
  assert.equal(result.summary.goals[0].verdict, "clear");
  const payoffRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(payoffRef.clear, true);
  assert.equal(payoffRef.satisfiedByRole, "finish");
});

test("rendered goal proof rebinds to nearby semantic clear frames per role", async () => {
  let sampledWindows = [];
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.9,
  };
  const failed = {
    visibilityVerdict: "failed",
    visibleGoal: false,
    reasons: ["semantic_frame_not_clear"],
    confidence: 0.2,
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => ({
      frames: (sampledWindows = candidateWindows).map((window, index) => {
        const role = window.role;
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && index === candidateWindows.findLastIndex((item) => item.role === "finish")) ||
          (role === "payoff" && index === candidateWindows.findIndex((item) => item.role === "payoff")) ||
          (role === "confirmation" && index === candidateWindows.findIndex((item) => item.role === "confirmation"));
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: {
            ...(shouldClear ? clear : failed),
            roles: [role],
          },
        };
      }),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].verdict, "clear");
  assert.equal(result.summary.goals[0].candidateFrameCount, 24);
  assert.equal(sampledWindows.filter((window) => window.role === "finish").length, 8);
  assert.equal(sampledWindows.filter((window) => window.role === "payoff").length, 6);
  assert.equal(result.summary.goals[0].frameRefs.length, 4);
});

test("rendered goal proof rejects replay-only semantic frames", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({
      frames: [
        { id: "pre", localPath: "pre.jpg", timestamp: 5, visualHints: ["goal_role:pre_shot"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, replayOnly: true, roles: ["pre_shot"] } },
        { id: "finish", localPath: "finish.jpg", timestamp: 10, visualHints: ["goal_role:finish"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, replayOnly: true, roles: ["finish"] } },
        { id: "payoff", localPath: "payoff.jpg", timestamp: 11, visualHints: ["goal_role:payoff"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, replayOnly: true, roles: ["payoff"] } },
        { id: "confirmation", localPath: "confirmation.jpg", timestamp: 12, visualHints: ["goal_role:confirmation"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, replayOnly: true, roles: ["confirmation"] } },
      ],
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.ok(result.summary.goals[0].failedFrameReasons.includes("semantic_frame_forbidden_content"));
});

test("rendered goal proof rejects celebration/player closeup semantic frames", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async () => ({
      frames: [
        { id: "pre", localPath: "pre.jpg", timestamp: 5, visualHints: ["goal_role:pre_shot"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, celebrationOnly: true, playerCloseupOnly: true, roles: ["pre_shot"] } },
        { id: "finish", localPath: "finish.jpg", timestamp: 10, visualHints: ["goal_role:finish"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, celebrationOnly: true, playerCloseupOnly: true, roles: ["finish"] } },
        { id: "payoff", localPath: "payoff.jpg", timestamp: 11, visualHints: ["goal_role:payoff"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, celebrationOnly: true, playerCloseupOnly: true, roles: ["payoff"] } },
        { id: "confirmation", localPath: "confirmation.jpg", timestamp: 12, visualHints: ["goal_role:confirmation"], semanticGoalEvidence: { visibilityVerdict: "clear", visibleGoal: true, celebrationOnly: true, playerCloseupOnly: true, roles: ["confirmation"] } },
      ],
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.ok(result.summary.goals[0].failedFrameReasons.includes("semantic_frame_forbidden_content"));
});
