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

function editPlanWithSegments(segments) {
  return {
    mode: "valid_goals_only",
    totalDuration: segments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0),
    export: { width: 1080, height: 1920 },
    segments,
  };
}

function clearEvidenceForRole(role) {
  return {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: role === "finish",
    hasBallInNetOrPayoff: ["finish", "payoff"].includes(role),
    confidence: 0.9,
    roles: [role],
  };
}

function clearFramesFromWindows(candidateWindows) {
  return candidateWindows.map((window, index) => ({
    id: `frame_${index + 1}`,
    localPath: `frame_${index + 1}.jpg`,
    timestamp: window.time,
    visualHints: window.visualHints,
    semanticGoalEvidence: clearEvidenceForRole(window.role),
  }));
}

test("rendered goal proof preserves 9:16 output dimensions for sampled frames", async () => {
  let receivedMetadata = null;
  await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: {
      mode: "valid_goals_only",
      aspectRatio: "9:16",
      totalDuration: 20,
      segments: [goalSegment()],
    },
    extractFrames: async ({ metadata }) => {
      receivedMetadata = metadata;
      return { frames: [] };
    },
    writeJson: () => {},
  });

  assert.equal(receivedMetadata.width, 1080);
  assert.equal(receivedMetadata.height, 1920);
});

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
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: { ...semanticGoalEvidence, roles: [window.role] },
      })),
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

test("rendered goal proof reports borderline as non-passing missing clear goal", async () => {
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.91,
  };
  const failed = {
    visibilityVerdict: "failed",
    visibleGoal: false,
    confidence: 0.2,
    reasons: ["semantic_frame_not_clear"],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
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

  assert.equal(result.summary.passed, false);
  assert.equal(result.summary.status, "failed");
  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.borderlineGoalCount, 1);
  assert.equal(result.summary.failedGoalCount, 0);
  assert.equal(result.summary.nonClearGoalCount, 1);
  assert.deepEqual(result.summary.missingClearGoalNumbers, [1]);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "borderline");
});

test("rendered goal proof batches windows across goals and keeps role mapping", async () => {
  const calls = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlanWithSegments([
      goalSegment({ id: "goal_1", goalNumber: 1, timelineStart: 0 }),
      goalSegment({ id: "goal_2", goalNumber: 2, sourceStart: 120, sourceEnd: 140, shotStart: 128, finishTime: 132, confirmationTime: 136, timelineStart: 20 }),
    ]),
    extractFrames: async ({ candidateWindows }) => {
      calls.push(candidateWindows);
      return { frames: clearFramesFromWindows(candidateWindows) };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 2);
  assert.equal(result.summary.clearGoalCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length <= 24, true);
  assert.equal(calls[0].some((window) => Number(window.time) >= 20), true);
  assert.equal(result.summary.timing.candidateFrameWindowCount >= 32, true);
  assert.equal(result.summary.timing.candidateFrameWindowCount <= 48, true);
  assert.equal(result.summary.timing.uniqueFrameWindowCount, result.summary.timing.candidateFrameWindowCount);
  assert.equal(result.summary.timing.framesExtracted, result.summary.timing.candidateFrameWindowCount);
  assert.equal(result.summary.timing.batchExtractionCallCount, 2);
  assert.doesNotMatch(JSON.stringify(result.summary), /localPath|\/Users|storageKey|secret|token|stdout|stderr/i);
});

test("rendered goal proof reuses duplicate rendered frame windows safely", async () => {
  let extractionCallCount = 0;
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlanWithSegments([
      goalSegment({ id: "goal_1", goalNumber: 1, timelineStart: 0 }),
      goalSegment({ id: "goal_2", goalNumber: 2, timelineStart: 0 }),
    ]),
    extractFrames: async ({ candidateWindows }) => {
      extractionCallCount += 1;
      return { frames: clearFramesFromWindows(candidateWindows) };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 2);
  assert.equal(result.summary.clearGoalCount, 2);
  assert.equal(extractionCallCount, 1);
  assert.equal(result.summary.timing.candidateFrameWindowCount >= 32, true);
  assert.equal(result.summary.timing.candidateFrameWindowCount <= 48, true);
  assert.equal(result.summary.timing.uniqueFrameWindowCount <= 24, true);
  assert.equal(result.summary.timing.framesExtracted, result.summary.timing.uniqueFrameWindowCount);
  assert.equal(result.summary.timing.framesReused, result.summary.timing.uniqueFrameWindowCount);
  assert.equal(result.summary.timing.skippedDuplicateFrameCount, result.summary.timing.uniqueFrameWindowCount);
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
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(Number(window.time) - 12) < 0.1) ||
          (role === "confirmation" && index === candidateWindows.findIndex((item) => item.role === "confirmation"));
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: {
            ...(shouldClear ? clear : { visibilityVerdict: "failed", visibleGoal: false, confidence: 0.2, reasons: ["semantic_frame_not_clear"] }),
            roles: [role],
          },
        };
      }),
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

test("rendered goal proof lets a clear payoff frame satisfy finish when finish samples are unclear", async () => {
  let sampledWindows = [];
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.91,
  };
  const failed = {
    visibilityVerdict: "failed",
    visibleGoal: false,
    confidence: 0.2,
    reasons: ["semantic_frame_not_clear"],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => ({
      frames: (sampledWindows = candidateWindows).map((window, index) => {
        const role = window.role;
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "payoff" && index === candidateWindows.findLastIndex((item) => item.role === "payoff")) ||
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
  assert.equal(result.summary.borderlineGoalCount, 0);
  assert.equal(result.summary.goals[0].verdict, "clear");
  assert.equal(sampledWindows.filter((window) => window.role === "finish").length >= 5, true);
  const finishRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "finish");
  assert.equal(finishRef.clear, true);
  assert.equal(finishRef.satisfiedByRole, "payoff");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "clear");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.hasFinishActionFrame, true);
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
  assert.equal(result.summary.goals[0].candidateFrameCount >= 16, true);
  assert.equal(result.summary.goals[0].candidateFrameCount <= 24, true);
  assert.equal(sampledWindows.filter((window) => window.role === "finish").length >= 5, true);
  assert.equal(sampledWindows.filter((window) => window.role === "payoff").length >= 4, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Number(window.time) < 12), true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 12) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Math.abs(Number(window.time) - 12.55) < 0.05), true);
  assert.equal(result.summary.goals[0].frameRefs.length, 4);
});

test("rendered goal proof samples early finish frames for delayed scoreboard confirmation", async () => {
  let sampledWindows = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 526.22,
      sourceEnd: 558.07,
      shotStart: 548.12,
      finishTime: 550.22,
      confirmationTime: 555.72,
      duration: 31.85,
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: (sampledWindows = candidateWindows).map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: {
          visibilityVerdict: "clear",
          visibleGoal: true,
          hasVisibleFinish: window.role === "finish",
          hasBallInNetOrPayoff: ["finish", "payoff"].includes(window.role),
          confidence: 0.9,
          roles: [window.role],
        },
      })),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].candidateFrameCount <= 24, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 7.5) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 10.5) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Math.abs(Number(window.time) - 7.5) < 0.05), true);
});

test("rendered goal proof prefers declared finish over early score-change lead frames", async () => {
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    hasGoalMouth: true,
    confidence: 0.91,
    reasons: [],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 458.54,
      sourceEnd: 484.39,
      shotStart: 471.69,
      finishTime: 472.04,
      confirmationTime: 482.04,
      duration: 25.85,
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: {
          ...clear,
          roles: [window.role],
        },
      })),
    }),
    writeJson: () => {},
  });

  const finishRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "finish");
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(finishRef.clear, true);
  assert.equal(Math.abs(Number(finishRef.time) - 13.5) < 0.75, true);
  assert.equal(result.editPlan.segments[0].finishTime >= 471.25, true);
});

test("rendered goal proof rejects finish frames without enough pre-shot context", async () => {
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    hasGoalMouth: true,
    confidence: 0.91,
    reasons: [],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 458.54,
      sourceEnd: 484.39,
      shotStart: 459.69,
      finishTime: 460.04,
      confirmationTime: 482.04,
      duration: 25.85,
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: {
          ...clear,
          roles: [window.role],
        },
      })),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.goals[0].failedFrameReasons.includes("finish_frame_lacks_pre_context"), true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.reasons.includes("finish_frame_lacks_pre_context"), true);
  assert.equal(result.editPlan.segments[0].finishTime, 460.04);
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
