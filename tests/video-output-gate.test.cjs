const test = require("node:test");
const assert = require("node:assert/strict");

const { assertVideoOutputCoverage } = require("../server/video-output-gate.cjs");

function countedScoreChanges(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `counted_goal_${index + 1}`,
    startScore: `${index}-0`,
    endScore: `${index + 1}-0`,
    changeTime: 100 + index * 80,
    actionAnchorTime: 90 + index * 80,
    teamSide: "home",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 12,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  }));
}

function visibleGoalSegment(goalNumber, sourceStart) {
  const shotStart = sourceStart + 10;
  const finishTime = shotStart + 4;
  const confirmationTime = finishTime + 6;
  return {
    id: `segment_goal_${goalNumber}`,
    goalNumber,
    sourceStart,
    sourceEnd: confirmationTime + 4,
    highlightType: "goal",
    reasonCodes: [
      "visual_shot_contact",
      "visual_ball_toward_goal",
      "visual_ball_in_net",
      "scoreboard_ocr_score_change",
      "scoreboard_temporal_consistency",
      "scoreboard_backed_goal_sequence",
    ],
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
      offsideStatus: "onside",
      confidence: 0.93,
      decisionTimestamp: confirmationTime,
      decisionEvidence: ["scoreboard_backed_goal_sequence"],
    },
    shotStart,
    finishTime,
    confirmationTime,
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      replayOnly: false,
    },
  };
}

test("video output gate fails closed when final edit plan covers only two of five counted goals", () => {
  let error;
  try {
    assertVideoOutputCoverage({
      goalSelectionMode: "valid_goals_only",
      matchEventTruth: {
        providerMode: "fixture-match-event-truth",
        events: [],
        rejectedEvents: [],
        scoreTimelineObservations: [],
        scoreChanges: countedScoreChanges(5),
        summary: {
          countedGoalEventCount: 5,
        },
      },
      editPlan: {
        segments: [
          visibleGoalSegment(1, 84),
          visibleGoalSegment(2, 164),
        ],
      },
    });
  } catch (err) {
    error = err;
  }

  assert.equal(error && error.code, "VIDEO_OUTPUT_QA_FAILED");
  assert.equal(error.details.expectedGoalCount, 5);
  assert.equal(error.details.actualConfirmedGoalSegmentCount, 2);
  assert.equal(error.details.coveredGoalCount, 2);
  assert.deepEqual(error.details.missingGoalNumbers, [3, 4, 5]);
  assert.ok(error.details.failedReasons.includes("missing_or_invalid_counted_goal_segment"));
  assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});

test("video output gate passes only when all five counted goals have visible phases", () => {
  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(5),
      summary: {
        countedGoalEventCount: 5,
      },
    },
    editPlan: {
      segments: Array.from({ length: 5 }, (_, index) => visibleGoalSegment(index + 1, 84 + index * 80)),
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.expectedGoalCount, 5);
  assert.equal(report.actualConfirmedGoalSegmentCount, 5);
  assert.equal(report.coveredGoalCount, 5);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});
