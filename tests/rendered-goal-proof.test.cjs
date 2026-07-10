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
    renderPolishQA: {
      cleanActionLayoutRequired: true,
      cleanActionLayoutPassed: true,
      actionLayoutMode: "clean_action_letterbox",
      blurredBackgroundUsed: false,
      duplicateBackgroundUsed: false,
      splitLayoutCaptionCount: 0,
    },
    segments: [segment],
  };
}

function editPlanWithSegments(segments) {
  return {
    mode: "valid_goals_only",
    totalDuration: segments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0),
    export: { width: 1080, height: 1920 },
    renderPolishQA: {
      cleanActionLayoutRequired: true,
      cleanActionLayoutPassed: true,
      actionLayoutMode: "clean_action_letterbox",
      blurredBackgroundUsed: false,
      duplicateBackgroundUsed: false,
      splitLayoutCaptionCount: 0,
    },
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

function clearPreviousGoalProof(goalNumber, segmentIndex, timeline) {
  return {
    goalNumber,
    segmentIndex,
    verdict: "clear",
    timeline,
    frameCount: 4,
    candidateFrameCount: 40,
    sourceEvidenceStrong: true,
    unverifiedFrameCount: 0,
    failedFrameReasons: [],
    frameRefs: [
      { role: "pre_shot", time: timeline.shot - 0.35, clear: true, status: "clear", frameId: `g${goalNumber}_pre` },
      { role: "finish", time: timeline.finish, clear: true, status: "clear", frameId: `g${goalNumber}_finish` },
      { role: "payoff", time: timeline.payoff, clear: true, status: "clear", frameId: `g${goalNumber}_payoff` },
      { role: "confirmation", time: timeline.confirmation, clear: true, status: "clear", frameId: `g${goalNumber}_confirmation` },
    ],
    finishSearch: { selectedClear: true, clearCandidateCount: 2 },
    payoffSearch: { selectedClear: true, clearCandidateCount: 2 },
  };
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
    editPlan: editPlan(goalSegment({
      shotStart: 84,
      finishTime: 86,
      confirmationTime: 96,
    })),
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
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.finishBeforeScoreChange, true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.payoffBeforeScoreChange, true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.confirmationAtOrAfterScoreChange, true);
});

test("rendered goal proof rejects finish or payoff evidence at and after the score change", async () => {
  let sampledWindows = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      shotStart: 84,
      finishTime: 86,
      confirmationTime: 96,
    })),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
        frames: candidateWindows.map((window, index) => {
        const clear = window.role === "pre_shot" ||
          window.role === "confirmation" ||
          (window.role === "finish" && window.time >= 14.5) ||
          (window.role === "payoff" && window.time >= 16);
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: clear
            ? clearEvidenceForRole(window.role)
            : {
                visibilityVerdict: "failed",
                visibleGoal: false,
                confidence: 0.3,
                roles: [window.role],
              },
        };
        }),
      };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  const goal = result.summary.goals[0];
  const payoff = goal.frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(payoff.clear, false);
  assert.equal(sampledWindows
    .filter((window) => window.role === "finish" || window.role === "payoff")
    .every((window) => Number(window.time) <= 16 - 0.25), true);
});

test("rendered goal proof rejects scoreboard-backed wide action sequence without clear finish and payoff frames", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 531.72,
      sourceEnd: 558.07,
      shotStart: 547.62,
      finishTime: 549.72,
      confirmationTime: 555.72,
      duration: 26.35,
      reasonCodes: [
        "goal",
        "scoreboard_backed_goal_sequence",
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        "shot_sequence_support",
        "live_shot_finish_sequence",
      ],
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => {
        const clearWideAction = window.role === "pre_shot" || window.role === "confirmation";
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: clearWideAction
            ? clearEvidenceForRole(window.role)
            : {
                visibilityVerdict: "failed",
                visibleGoal: false,
                confidence: 0.28,
                reasons: ["semantic_frame_too_wide_unclear"],
                roles: [window.role],
              },
        };
      }),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.equal(result.summary.missingClearGoalNumbers.includes(1), true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.sequenceFallbackPassed, false);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.sequenceFallbackMode, null);
  assert.ok(result.editPlan.segments[0].finishFrameEvidence.reasons.includes("role_specific_finish_payoff_required"));
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
  assert.equal(result.summary.borderlineGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.equal(result.summary.nonClearGoalCount, 1);
  assert.deepEqual(result.summary.missingClearGoalNumbers, [1]);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
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
  assert.equal(calls.length >= 2, true);
  assert.equal(calls.length <= 8, true);
  assert.equal(calls[0].length <= 24, true);
  assert.equal(calls.flat().some((window) => Number(window.time) >= 20), true);
  assert.equal(result.summary.timing.candidateFrameWindowCount >= 16, true);
  assert.equal(result.summary.timing.candidateFrameWindowCount <= 160, true);
  assert.equal(result.summary.timing.uniqueFrameWindowCount, result.summary.timing.candidateFrameWindowCount);
  assert.equal(result.summary.timing.framesExtracted, result.summary.timing.candidateFrameWindowCount);
  assert.equal(result.summary.timing.batchExtractionCallCount, calls.length);
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
  assert.equal(extractionCallCount >= 2, true);
  assert.equal(extractionCallCount <= 5, true);
  assert.equal(result.summary.timing.candidateFrameWindowCount >= 16, true);
  assert.equal(result.summary.timing.candidateFrameWindowCount <= 160, true);
  assert.equal(result.summary.timing.uniqueFrameWindowCount <= 80, true);
  assert.equal(result.summary.timing.framesExtracted, result.summary.timing.uniqueFrameWindowCount);
  assert.equal(result.summary.timing.framesReused, result.summary.timing.uniqueFrameWindowCount);
  assert.equal(result.summary.timing.skippedDuplicateFrameCount, result.summary.timing.uniqueFrameWindowCount);
});

test("rendered goal proof targets changed goals and reuses unchanged clear proof", async () => {
  const sampledGoalNumbers = [];
  const goalOne = goalSegment({ id: "goal_1", goalNumber: 1 });
  const goalTwo = goalSegment({
    id: "goal_2",
    goalNumber: 2,
    sourceStart: 120,
    sourceEnd: 140,
    shotStart: 128,
    finishTime: 132,
    confirmationTime: 136,
    duration: 20,
  });
  const previousRenderedGoalProof = {
    goals: [
      clearPreviousGoalProof(1, 1, {
        sourceStart: 80,
        sourceEnd: 100,
        duration: 20,
        timelineStart: 0,
        timelineEnd: 20,
        shot: 8,
        finish: 12,
        payoff: 12.55,
        confirmation: 16,
      }),
    ],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlanWithSegments([goalOne, goalTwo]),
    previousRenderedGoalProof,
    extractFrames: async ({ candidateWindows }) => {
      sampledGoalNumbers.push(...candidateWindows.map((window) => window.goalNumber));
      return { frames: clearFramesFromWindows(candidateWindows) };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.goalCount, 2);
  assert.equal(result.summary.clearGoalCount, 2);
  assert.equal(result.summary.goals[0].existingClearProofUsed, true);
  assert.equal(result.summary.goals[1].existingClearProofUsed, false);
  assert.equal(result.summary.timing.reusedExistingClearGoalCount, 1);
  assert.equal(result.summary.timing.targetedGoalProofCount, 1);
  assert.equal(sampledGoalNumbers.includes(1), false);
  assert.equal(sampledGoalNumbers.includes(2), true);
});

test("rendered goal proof retimes unchanged source proof after duration compaction", async () => {
  const sampledGoalNumbers = [];
  const compactedGoal = goalSegment({
    id: "goal_1",
    goalNumber: 1,
    sourceStart: 84,
    sourceEnd: 100,
    shotStart: 88,
    finishTime: 92,
    confirmationTime: 96,
    duration: 16,
    timelineStart: 0,
    timelineEnd: 16,
    reasonCodes: [
      "visual_shot_contact",
      "visual_ball_toward_goal",
      "scoreboard_ocr_score_change",
      "scoreboard_temporal_consistency",
      "reference_duration_compaction",
    ],
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
      evidenceCodes: ["reference_duration_compaction_preserved_clear_roles"],
    },
  });
  const previousRenderedGoalProof = {
    goals: [
      clearPreviousGoalProof(1, 1, {
        sourceStart: 80,
        sourceEnd: 100,
        duration: 20,
        timelineStart: 7,
        timelineEnd: 27,
        shot: 15,
        finish: 19,
        payoff: 19.55,
        confirmation: 23,
      }),
    ],
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlanWithSegments([compactedGoal]),
    previousRenderedGoalProof,
    extractFrames: async ({ candidateWindows }) => {
      sampledGoalNumbers.push(...candidateWindows.map((window) => window.goalNumber));
      return { frames: clearFramesFromWindows(candidateWindows) };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].existingClearProofUsed, true);
  assert.equal(result.summary.goals[0].retimedFromPreviousClearProof, true);
  assert.equal(result.summary.timing.reusedExistingClearGoalCount, 1);
  assert.equal(result.summary.timing.targetedGoalProofCount, 0);
  assert.deepEqual(sampledGoalNumbers, []);
  const finish = result.summary.goals[0].frameRefs.find((frame) => frame.role === "finish");
  assert.equal(finish.clear, true);
  assert.equal(finish.time, 8);
});

test("rendered goal proof rejects finish-only evidence when payoff samples are unclear", async () => {
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

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.nonClearGoalCount, 1);
  assert.notEqual(result.summary.goals[0].verdict, "clear");
  const payoffRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(payoffRef.clear, false);
  assert.equal(result.summary.goals[0].failedFrameReasons.includes("semantic_frame_not_clear"), true);
});

test("rendered goal proof rejects payoff-only evidence when finish samples are unclear", async () => {
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
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "payoff" && Number(window.time) >= 16) ||
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
      };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.nonClearGoalCount, 1);
  assert.notEqual(result.summary.goals[0].verdict, "clear");
  assert.equal(sampledWindows.filter((window) => window.role === "finish").length >= 5, true);
  const finishRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "finish");
  assert.equal(finishRef.clear, false);
  assert.notEqual(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "clear");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.hasFinishActionFrame, false);
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
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 12) < 0.05) ||
          (role === "payoff" && time >= 12.55 - 0.05 && time <= 14.6 + 0.05) ||
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
      };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].verdict, "clear");
  assert.equal(result.summary.goals[0].candidateFrameCount >= 20, true);
  assert.equal(result.summary.goals[0].candidateFrameCount <= 80, true);
  assert.equal(sampledWindows.filter((window) => window.role === "finish").length >= 5, true);
  assert.equal(sampledWindows.filter((window) => window.role === "payoff").length >= 3, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Number(window.time) < 12), true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 12) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Math.abs(Number(window.time) - 12.55) < 0.05), true);
  assert.equal(sampledWindows
    .filter((window) => window.role === "payoff")
    .every((window) => Number(window.time) >= 7 - 0.1), true);
  assert.equal(result.summary.goals[0].frameRefs.length, 4);
  assert.equal(result.summary.goals[0].payoffSearch.clearCandidateCount >= 1, true);
  assert.equal(result.summary.goals[0].payoffSearch.selectedClear, true);
});

test("rendered goal proof rescues payoff from later clear frame after forbidden early payoff", async () => {
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
  const forbidden = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasBallInNetOrPayoff: true,
    playerCloseupOnly: true,
    confidence: 0.75,
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 12) < 0.05) ||
          (role === "payoff" && time >= 13.1 - 0.05 && time <= 14.6 + 0.05) ||
          (role === "confirmation" && index === candidateWindows.findIndex((item) => item.role === "confirmation"));
        const earlyForbiddenPayoff = role === "payoff" && Math.abs(time - 12.55) < 0.05;
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: {
            ...(shouldClear ? clear : earlyForbiddenPayoff ? forbidden : failed),
            roles: [role],
          },
        };
      }),
      };
    },
    writeJson: () => {},
  });

  const payoffRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(payoffRef.clear, true);
  assert.equal(Number(payoffRef.time) >= 13.1 - 0.05, true);
  assert.equal(result.summary.goals[0].payoffSearch.clearCandidateCount >= 3, true);
  assert.equal(result.summary.goals[0].payoffSearch.rejectedReasons.includes("semantic_frame_forbidden_content"), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Math.abs(Number(window.time) - 14.6) < 0.05), true);
  assert.doesNotMatch(JSON.stringify(result.summary.goals[0].payoffSearch), /localPath|\/Users|storageKey|secret|token|stdout|stderr/i);
});

test("rendered goal proof prefers payoff frame distinct from the selected finish", async () => {
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
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 12) < 0.05) ||
          (role === "payoff" && time >= 12.2 - 0.05 && time <= 14.1 + 0.05) ||
          (role === "confirmation" && index === candidateWindows.findIndex((item) => item.role === "confirmation"));
        return {
          id: `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: {
            ...(shouldClear ? clear : {
              visibilityVerdict: "failed",
              visibleGoal: false,
              confidence: 0.2,
              reasons: ["semantic_frame_not_clear"],
            }),
            roles: [role],
          },
        };
      }),
    }),
    writeJson: () => {},
  });

  const payoffRef = result.summary.goals[0].frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(payoffRef.clear, true);
  assert.equal(Math.abs(Number(payoffRef.time) - 12.55) < 0.05, true);
  assert.equal(result.summary.goals[0].payoffSearch.selectedClear, true);
});

test("rendered goal proof rejects payoff frames that happen before finish", async () => {
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
    editPlan: editPlan(goalSegment({
      sourceStart: 80,
      sourceEnd: 100,
      shotStart: 90,
      finishTime: 94,
      confirmationTime: 96,
      duration: 20,
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 14) < 0.05) ||
          (role === "payoff" && time >= 11.5 && time <= 13.5) ||
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

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.goals[0].failedFrameReasons.includes("finish_payoff_frame_not_ordered"), true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
});

test("rendered goal proof coalesces near-finish payoff when selected finish is a late clear frame", async () => {
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
    editPlan: editPlan(goalSegment({
      sourceStart: 530.25,
      sourceEnd: 552.8,
      shotStart: 533.35,
      finishTime: 535.45,
      confirmationTime: 550.45,
      duration: 22.55,
    })),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => {
        const role = window.role;
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && time >= 19 && time <= 20.5) ||
          (role === "payoff" && Math.abs(time - 5.75) < 0.1) ||
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

  const goal = result.summary.goals[0];
  const finishRef = goal.frameRefs.find((frame) => frame.role === "finish");
  const payoffRef = goal.frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(finishRef.clear, true);
  assert.equal(payoffRef.clear, true);
  assert.equal(finishRef.coalescedFromRole, "payoff");
  assert.equal(payoffRef.role, "payoff");
  assert.equal(Math.abs(finishRef.time - 5.75) < 0.15, true);
  assert.equal(goal.failedFrameReasons.includes("finish_payoff_frame_not_ordered"), false);
});

test("rendered goal proof can bind one visible ball-in-net frame as finish and payoff", async () => {
  const clearPayoff = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.88,
    roles: ["payoff"],
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
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "payoff" && Math.abs(time - 12) < 0.05) ||
          (role === "confirmation" && index === candidateWindows.findIndex((item) => item.role === "confirmation"));
        return {
          id: shouldClear && role === "payoff" ? "visible_goalmouth_frame" : `frame_${index + 1}`,
          localPath: `frame_${index + 1}.jpg`,
          timestamp: window.time,
          visualHints: window.visualHints,
          semanticGoalEvidence: shouldClear
            ? role === "payoff"
              ? clearPayoff
              : clearEvidenceForRole(role)
            : {
                ...failed,
                roles: [role],
              },
        };
      }),
    }),
    writeJson: () => {},
  });

  const evidence = result.editPlan.segments[0].finishFrameEvidence;
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.finishPayoffSingleFrame, true);
  assert.deepEqual(evidence.coalescedVisibleGoalFrame, {
    applied: true,
    sourceRole: "payoff",
    time: 12,
  });
  assert.equal(result.summary.goals[0].frameRefs.find((frame) => frame.role === "finish").frameId, "visible_goalmouth_frame");
});

test("rendered goal proof accepts a tight semantic-clear finish payoff burst", async () => {
  const clear = {
    visibilityVerdict: "clear",
    visibleGoal: true,
    hasVisibleFinish: true,
    hasBallInNetOrPayoff: true,
    confidence: 0.86,
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
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && (Math.abs(time - 12) < 0.05 || Math.abs(time - 12.1) < 0.05)) ||
          (role === "payoff" && (Math.abs(time - 12) < 0.05 || Math.abs(time - 12.1) < 0.05)) ||
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

  const evidence = result.editPlan.segments[0].finishFrameEvidence;
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.microFinishPayoffBurst, true);
  assert.equal(evidence.finishPayoffDistinct, true);
  assert.equal(evidence.finishPayoffOrdered, true);
});

test("rendered goal proof accepts one close payoff frame when the full goal role sequence is clear", async () => {
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
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 12) < 0.05) ||
          (role === "payoff" && Math.abs(time - 12.55) < 0.05) ||
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

  const evidence = result.editPlan.segments[0].finishFrameEvidence;
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.selectedRoleSequenceSupportPassed, true);
  assert.equal(evidence.payoffClearSupportPassed, true);
  assert.equal(result.summary.goals[0].payoffSearch.clearCandidateCount <= 2, true);
});

test("rendered goal proof rejects sparse isolated payoff false positives", async () => {
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
        const time = Number(window.time);
        const shouldClear =
          (role === "pre_shot" && index === candidateWindows.findIndex((item) => item.role === "pre_shot")) ||
          (role === "finish" && Math.abs(time - 12) < 0.05) ||
          (role === "payoff" && (Math.abs(time - 14.1) < 0.05 || Math.abs(time - 14.6) < 0.05)) ||
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

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.goals[0].failedFrameReasons.includes("payoff_frame_clear_support_too_sparse"), true);
  assert.equal(result.summary.goals[0].payoffSearch.clearCandidateCount >= 2, true);
  assert.equal(result.summary.goals[0].payoffSearch.clearCandidateRatio < 0.12, true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
});

test("rendered goal proof samples early finish frames for delayed scoreboard confirmation", async () => {
  let sampledWindows = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 526.22,
      sourceEnd: 558.07,
      shotStart: 542.12,
      finishTime: 544.22,
      confirmationTime: 555.72,
      duration: 31.85,
    })),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
      frames: candidateWindows.map((window, index) => ({
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
      };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].candidateFrameCount <= 120, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 7.5) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 10.5) < 0.05), true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 28.85) < 0.05), false);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Math.abs(Number(window.time) - 29.5) < 0.05), false);
  assert.equal(sampledWindows
    .filter((window) => window.role === "payoff")
    .every((window) => Number(window.time) >= 7.5 - 0.65 && Number(window.time) <= 29.5 - 2.5), true);
});

test("rendered goal proof samples rebound finish frames around the selected live finish", async () => {
  let sampledWindows = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 515.54,
      sourceEnd: 558.07,
      shotStart: 521.44,
      finishTime: 523.54,
      confirmationTime: 555.72,
      duration: 42.53,
      renderedVisibilityRebinding: {
        applied: true,
        attemptNumber: 1,
      },
    })),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
        frames: candidateWindows.map((window, index) => {
          const role = window.role;
          const time = Number(window.time);
          const clear = role === "pre_shot" ||
            role === "confirmation" ||
            (role === "finish" && time >= 7 && time <= 9.5) ||
            (role === "payoff" && time >= 7.5 && time <= 10.5);
          return {
            id: `frame_${index + 1}`,
            localPath: `frame_${index + 1}.jpg`,
            timestamp: window.time,
            visualHints: window.visualHints,
            semanticGoalEvidence: clear
              ? clearEvidenceForRole(role)
              : {
                  visibilityVerdict: "failed",
                  visibleGoal: false,
                  confidence: 0.36,
                  roles: [role],
                },
          };
        }),
      };
    },
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.failedGoalCount, 0);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 8) < 0.1), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Number(window.time) >= 7.5 && Number(window.time) <= 10.5), true);
  const goal = result.summary.goals[0];
  const finish = goal.frameRefs.find((frame) => frame.role === "finish");
  const payoff = goal.frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(finish.clear, true);
  assert.equal(payoff.clear, true);
  assert.equal(payoff.time >= finish.time, true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "clear");
});

test("rendered goal proof keeps rebound sampling bounded around the selected score-change finish", async () => {
  const sampledWindows = [];
  await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 530.25,
      sourceEnd: 552.8,
      shotStart: 533.35,
      finishTime: 535.45,
      confirmationTime: 550.45,
      duration: 22.55,
      renderedVisibilityRebinding: {
        applied: true,
        attemptNumber: 1,
      },
    })),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return { frames: clearFramesFromWindows(candidateWindows) };
    },
    writeJson: () => {},
  });

  assert.equal(sampledWindows.length <= 64, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Math.abs(Number(window.time) - 5.2) < 0.75), true);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Number(window.time) >= 5.5 && Number(window.time) <= 7.5), true);
  assert.equal(sampledWindows.some((window) => window.role === "confirmation"), true);
});

test("rendered goal proof rejects post-goal closeups near a delayed score change", async () => {
  const sampledWindows = [];
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment({
      sourceStart: 100,
      sourceEnd: 122,
      shotStart: 105,
      finishTime: 107,
      confirmationTime: 120,
      duration: 22,
    })),
    extractFrames: async ({ candidateWindows }) => {
      sampledWindows.push(...candidateWindows);
      return {
        frames: candidateWindows.map((window, index) => {
          const role = window.role;
          const time = Number(window.time);
          const clear = role === "pre_shot" ||
            role === "confirmation" ||
            (role === "finish" && Math.abs(time - 12) < 0.05) ||
            (role === "payoff" && time >= 12.5 && time <= 13.5);
          return {
            id: `frame_${index + 1}`,
            localPath: `frame_${index + 1}.jpg`,
            timestamp: window.time,
            visualHints: window.visualHints,
            semanticGoalEvidence: clear
              ? clearEvidenceForRole(role)
              : {
                  visibilityVerdict: "failed",
                  visibleGoal: false,
                  confidence: time >= 17 ? 0.95 : 0.42,
                  celebrationOnly: time >= 17,
                  playerCloseupOnly: time >= 17,
                  roles: [role],
                },
          };
        }),
      };
    },
    writeJson: () => {},
  });

  const goal = result.summary.goals[0];
  const finish = goal.frameRefs.find((frame) => frame.role === "finish");
  const payoff = goal.frameRefs.find((frame) => frame.role === "payoff");
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(finish.time, 12);
  assert.equal(payoff.time >= finish.time, true);
  assert.equal(sampledWindows.some((window) => window.role === "finish" && Number(window.time) > 16), false);
  assert.equal(sampledWindows.some((window) => window.role === "payoff" && Number(window.time) > 17.5), false);
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

test("rendered goal proof accepts a scoreboard-backed closeup only for confirmation", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: window.role === "confirmation"
          ? {
              visibilityVerdict: "clear",
              visibleGoal: true,
              celebrationOnly: true,
              playerCloseupOnly: true,
              confidence: 0.9,
              roles: ["confirmation"],
            }
          : clearEvidenceForRole(window.role),
      })),
    }),
    writeJson: () => {},
  });

  const goal = result.summary.goals[0];
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(goal.verdict, "clear");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.scoreboardConfirmationFallback, true);
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.hasConfirmationFrame, true);
  assert.equal(goal.failedFrameReasons.includes("semantic_frame_forbidden_content"), false);
});

test("rendered scorebug confirms an otherwise unclear confirmation after clear action frames", async () => {
  const plan = editPlan(goalSegment());
  plan.renderPolishQA = {
    cleanActionLayoutRequired: true,
    cleanActionLayoutPassed: true,
    actionLayoutMode: "scorebug_preserved_vertical_fill",
    fullHeightActionCrop: true,
    scoreboardOverlayRendered: true,
    scoreboardOverlayRegionId: "scorebug_broadcast_compact",
    sourceScoreboardDuplicateSuppressed: true,
    blurredBackgroundUsed: false,
    duplicateBackgroundUsed: false,
    splitLayoutCaptionCount: 0,
  };
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: plan,
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: window.role === "confirmation"
          ? {
              visibilityVerdict: "failed",
              visibleGoal: false,
              confidence: 0.2,
              roles: ["confirmation"],
            }
          : clearEvidenceForRole(window.role),
      })),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.goals[0].verdict, "clear");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.scoreboardConfirmationFallback, true);
});

test("unclear confirmation stays failed when no scoreboard overlay was rendered", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: editPlan(goalSegment()),
    extractFrames: async ({ candidateWindows }) => ({
      frames: candidateWindows.map((window, index) => ({
        id: `frame_${index + 1}`,
        localPath: `frame_${index + 1}.jpg`,
        timestamp: window.time,
        visualHints: window.visualHints,
        semanticGoalEvidence: window.role === "confirmation"
          ? {
              visibilityVerdict: "failed",
              visibleGoal: false,
              confidence: 0.2,
              roles: ["confirmation"],
            }
          : clearEvidenceForRole(window.role),
      })),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.goals[0].verdict, "borderline");
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.scoreboardConfirmationFallback, false);
});

test("rendered goal proof rejects blurred duplicate proof layout even when semantic frames are clear", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: {
      ...editPlan(goalSegment()),
      renderPolishQA: {
        cleanActionLayoutRequired: true,
        cleanActionLayoutPassed: false,
        actionLayoutMode: "blurred_duplicate_background",
        blurredBackgroundUsed: true,
        duplicateBackgroundUsed: true,
        splitLayoutCaptionCount: 0,
      },
    },
    extractFrames: async ({ candidateWindows }) => ({
      frames: clearFramesFromWindows(candidateWindows),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.passed, false);
  assert.equal(result.summary.clearGoalCount, 0);
  assert.equal(result.summary.failedGoalCount, 1);
  assert.equal(result.summary.layoutContract.passed, false);
  assert.ok(result.summary.goals[0].failedFrameReasons.includes("blurred_duplicate_background_used"));
  assert.equal(result.editPlan.segments[0].finishFrameEvidence.visibilityVerdict, "failed");
});

test("rendered goal proof accepts validated vertical fill with a rendered scorebug", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: {
      ...editPlan(goalSegment()),
      renderPolishQA: {
        cleanActionLayoutRequired: true,
        cleanActionLayoutPassed: true,
        actionLayoutMode: "scorebug_preserved_vertical_fill",
        fullHeightActionCrop: true,
        scoreboardOverlayRendered: true,
        scoreboardOverlayRegionId: "scorebug_broadcast_compact",
        sourceScoreboardDuplicateSuppressed: true,
        blurredBackgroundUsed: false,
        duplicateBackgroundUsed: false,
        splitLayoutCaptionCount: 0,
      },
    },
    extractFrames: async ({ candidateWindows }) => ({
      frames: clearFramesFromWindows(candidateWindows),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.layoutContract.passed, true);
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.passed, true);
});

test("rendered goal proof accepts bounded ball-follow with synchronized source scorebug", async () => {
  const result = await analyzeRenderedGoalProof({
    outputPath: "rendered-output.mp4",
    editPlan: {
      ...editPlan(goalSegment()),
      renderPolishQA: {
        cleanActionLayoutRequired: true,
        cleanActionLayoutPassed: true,
        actionLayoutMode: "ball_follow_with_synchronized_scorebug",
        fullHeightActionCrop: true,
        dynamicCropRendered: true,
        cropKeyframeCount: 8,
        maxPanSpeed: 0.18,
        scoreboardOverlayRendered: true,
        scoreboardOverlayRegionId: "scorebug_broadcast_compact",
        sourceScoreboardDuplicateSuppressed: true,
        blurredBackgroundUsed: false,
        duplicateBackgroundUsed: false,
        splitLayoutCaptionCount: 0,
      },
    },
    extractFrames: async ({ candidateWindows }) => ({
      frames: clearFramesFromWindows(candidateWindows),
    }),
    writeJson: () => {},
  });

  assert.equal(result.summary.layoutContract.passed, true);
  assert.equal(result.summary.clearGoalCount, 1);
  assert.equal(result.summary.passed, true);
});
