const test = require("node:test");
const assert = require("node:assert/strict");

const { validateEditPlan } = require("../server/edit-plan.cjs");
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

function customScoreChanges(times = []) {
  return times.map((time, index) => ({
    id: `counted_goal_${index + 1}`,
    startScore: `${index}-0`,
    endScore: `${index + 1}-0`,
    changeTime: time,
    actionAnchorTime: time - 10,
    teamSide: "home",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 12,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  }));
}

function visibleGoalSegment(goalNumber, sourceStart, overrides = {}) {
  const shotStart = sourceStart + 10;
  const finishTime = shotStart + 4;
  const confirmationTime = finishTime + 6;
  const finalFinishTime = Number.isFinite(Number(overrides.finishTime)) ? Number(overrides.finishTime) : finishTime;
  const defaultFinishFrameEvidence = {
    frameTime: finalFinishTime,
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
    isBlurred: false,
    isOverZoomed: false,
    isLabelOnly: false,
    isReplayOnly: false,
    isCelebrationOnly: false,
    isScoreboardOnly: false,
    evidenceCodes: ["finish_frame_visible", "ball_in_net_or_payoff_visible"],
  };
  const segment = {
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
    ...overrides,
  };
  return {
    ...segment,
    finishFrameEvidence: Object.prototype.hasOwnProperty.call(overrides, "finishFrameEvidence")
      ? overrides.finishFrameEvidence
      : defaultFinishFrameEvidence,
  };
}

function creativeOutputContract() {
  return {
    hookPlan: {
      hookStart: 0,
      hookEnd: 1.6,
      hookType: "goal_payoff",
      hookText: "VALID FINISHES ONLY",
      evidenceCodes: ["scoreboard_backed_goal_sequence", "visual_ball_in_net"],
      relatedGoalNumber: 1,
      noFalseGoalClaim: true,
      coldOpen: true,
      timelinePlacement: "first_two_seconds",
      sourceStart: 98,
      sourceEnd: 99.5,
    },
    captions: [
      {
        start: 0,
        end: 1.8,
        text: "VALID FINISHES ONLY",
        role: "opening_hook",
        style: { fontScale: 1.12, maxLines: 2, stroke: 5, shadow: 2 },
        words: ["VALID", "FINISHES", "ONLY"],
        activeWordTiming: [
          { word: "VALID", start: 0, end: 0.52, active: true },
          { word: "FINISHES", start: 0.54, end: 1.08, active: true },
          { word: "ONLY", start: 1.1, end: 1.62, active: true },
        ],
        stylePreset: "hormozi_kinetic_safe_v1",
        safeArea: { name: "center_safe", avoidsScorebug: true, maxWidthPercent: 0.84, maxHeightPercent: 0.22 },
        contrastMode: "outline_shadow",
      },
      {
        start: 1.9,
        end: 3.4,
        text: "GOAL ONE COUNTS",
        role: "action_callout",
        style: { fontScale: 1, maxLines: 2, stroke: 5, shadow: 2 },
        words: ["GOAL", "ONE", "COUNTS"],
        activeWordTiming: [
          { word: "GOAL", start: 1.9, end: 2.28, active: true },
          { word: "ONE", start: 2.3, end: 2.74, active: true },
          { word: "COUNTS", start: 2.76, end: 3.28, active: true },
        ],
        stylePreset: "sports_dynamic_safe_v1",
        safeArea: { name: "lower_third_safe", avoidsScorebug: true, maxWidthPercent: 0.86, maxHeightPercent: 0.2 },
        contrastMode: "outline_shadow",
      },
    ],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2, safeForMotion: true },
      { type: "caption_word_pop", start: 0, end: 1.8, safeForMotion: true },
      { type: "kinetic_caption", start: 0.2, end: 1.6, safeForMotion: true },
    ],
    audioPolicy: {
      audioMode: "source",
      licenseStatus: "source_rights_confirmed",
      source: "source_audio",
      externalAudioBundled: false,
      copyrightedTrackBundled: false,
      operatorActionRequired: false,
    },
    creativeStyleTransforms: {
      colorGrade: "sports_pop_safe",
      mildZoom: 1.02,
      mirror: false,
      copyrightEvasion: false,
      watermarkObscuring: false,
    },
    renderPolishQA: {
      cleanActionLayoutRequired: true,
      cleanActionLayoutPassed: true,
      actionLayoutMode: "clean_action_letterbox",
      blurredBackgroundUsed: false,
      duplicateBackgroundUsed: false,
      splitLayoutCaptionCount: 0,
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
        ...creativeOutputContract(),
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
      ...creativeOutputContract(),
      totalDuration: 64,
      segments: Array.from({ length: 5 }, (_, index) => visibleGoalSegment(index + 1, 84 + index * 80)),
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.expectedGoalCount, 5);
  assert.equal(report.actualConfirmedGoalSegmentCount, 5);
  assert.equal(report.coveredGoalCount, 5);
  assert.equal(report.hook.passed, true);
  assert.equal(report.captions.dynamicCaptionCount, 2);
  assert.equal(report.animations.passed, true);
  assert.equal(report.audioPolicy.passed, true);
  assert.equal(report.creativeStyle.passed, true);
  assert.equal(report.renderedGoalVisibility.passed, true);
  assert.equal(report.renderedGoalVisibility.visibleGoalCount, 5);
  assert.equal(report.renderedGoalVisibility.humanVisibleGoalsClear, 5);
  assert.equal(report.renderedGoalVisibility.humanVisibleGoalsBorderline, 0);
  assert.equal(report.renderedGoalVisibility.humanVisibleGoalsFailed, 0);
  assert.equal(report.humanVisibleGoalsClear, 5);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});

test("scoreboard-first gate accepts tight shot estimate when score-change backtrack is present", () => {
  const scoreChangeTime = 200.45;
  const sourceStart = 180.25;
  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: [{
        id: "away_counted_goal_1",
        startScore: "0-0",
        endScore: "0-1",
        changeTime: scoreChangeTime,
        actionAnchorTime: scoreChangeTime - 14,
        teamSide: "away",
        scoreDelta: 1,
        confidence: 0.94,
        persistedDuration: 16,
        reverted: false,
        outcome: "counted_goal",
        reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
      }],
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [
        visibleGoalSegment(1, sourceStart, {
          sourceEnd: scoreChangeTime + 2.35,
          shotStart: sourceStart + 3.1,
          finishTime: sourceStart + 4,
          confirmationTime: scoreChangeTime,
          scoreBefore: "0-0",
          scoreAfter: "0-1",
          scoreChangeTime,
          goalOutcome: {
            eventType: "ball_in_net",
            outcome: "confirmed_goal",
            offsideStatus: "onside",
            scoreBefore: "0-0",
            scoreAfter: "0-1",
            scoreChangeTime,
            confidence: 0.93,
            decisionTimestamp: scoreChangeTime,
            decisionEvidence: ["scoreboard_backed_goal_sequence"],
          },
          finishFrameEvidence: {
            ...visibleGoalSegment(1, sourceStart).finishFrameEvidence,
            frameTime: sourceStart + 4,
          },
        }),
      ],
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.coveredGoalCount, 1);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.equal(report.matches[0].segmentIndex, 1);
  assert.deepEqual(report.matches[0].reasons, []);
});

test("video output gate rejects confirmed goals without rendered finish-frame proof", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [visibleGoalSegment(1, 84, { finishFrameEvidence: null })],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderedGoalVisibility.passed, false);
    assert.equal(error.details.renderedGoalVisibility.failedGoals[0].failureCode, "FINISH_FRAME_NOT_PROVEN");
    assert.ok(error.details.failedReasons.includes("rendered_goal_visibility_failed"));
    assert.ok(error.details.matches[0].reasons.includes("rendered_goal_visibility_failed"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("validated edit plan preserves rendered support-frame timing for visible goal proof", () => {
  const segment = visibleGoalSegment(1, 84, {
    finishFrameEvidence: {
      ...visibleGoalSegment(1, 84).finishFrameEvidence,
      supportFrames: [
        { role: "pre_shot", status: "clear", clear: true, time: 4.5 },
        { role: "finish", status: "clear", clear: true, time: 10 },
        { role: "payoff", status: "clear", clear: true, time: 10.4 },
        { role: "confirmation", status: "clear", clear: true, time: 12 },
      ],
    },
  });
  const editPlan = validateEditPlan({
    ...creativeOutputContract(),
    mode: "multi_moment_compilation",
    highlightType: "goal",
    reasonCodes: ["goal"],
    aspectRatio: "9:16",
    export: { format: "mp4", width: 1080, height: 1920 },
    segments: [segment],
  }, { durationSeconds: 200 });

  assert.deepEqual(
    editPlan.segments[0].finishFrameEvidence.supportFrames.map((frame) => frame.time),
    [4.5, 10, 10.4, 12],
  );
  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan,
  });

  assert.equal(report.passed, true);
  assert.equal(report.renderedGoalVisibility.clearGoalCount, 1);
});

test("video output gate rejects score-change goals whose finish is not before the scoreboard update", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [
        visibleGoalSegment(1, 84, {
          finishTime: 100,
          finishFrameEvidence: {
            ...visibleGoalSegment(1, 84).finishFrameEvidence,
            frameTime: 100,
          },
        }),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.ok(error.details.matches[0].reasons.includes("finish_not_before_scoreboard_change"));
    assert.ok(error.details.failedReasons.includes("missing_or_invalid_counted_goal_segment"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects blurred or over-zoomed finish-frame proof", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [
        visibleGoalSegment(1, 84, {
          finishFrameEvidence: {
            frameTime: 98,
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
            isBlurred: true,
            isOverZoomed: true,
            evidenceCodes: ["finish_frame_visible", "ball_in_net_or_payoff_visible"],
          },
        }),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderedGoalVisibility.failedGoals[0].failureCode, "FINISH_FRAME_BLURRED");
    assert.ok(error.details.renderedGoalVisibility.failedGoals[0].finishFrameEvidence.reasons.includes("finish_frame_blurred"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects old false-positive proof with only one clear human-visible goal", () => {
  const clearGoal = visibleGoalSegment(1, 84);
  const borderlineGoal = (goalNumber, sourceStart) => visibleGoalSegment(goalNumber, sourceStart, {
    finishFrameEvidence: {
      ...visibleGoalSegment(goalNumber, sourceStart).finishFrameEvidence,
      visibilityVerdict: "borderline",
    },
  });
  const failedGoal = (goalNumber, sourceStart, failure) => visibleGoalSegment(goalNumber, sourceStart, {
    finishFrameEvidence: {
      ...visibleGoalSegment(goalNumber, sourceStart).finishFrameEvidence,
      visibilityVerdict: "failed",
      [failure]: true,
    },
  });

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(5),
      summary: { countedGoalEventCount: 5 },
    },
    editPlan: {
      ...creativeOutputContract(),
      totalDuration: 75,
      segments: [
        clearGoal,
        borderlineGoal(2, 164),
        failedGoal(3, 244, "isPlayerCloseupOnly"),
        borderlineGoal(4, 324),
        failedGoal(5, 404, "isFrameTooWideUnclear"),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderedGoalVisibility.humanVisibleGoalsClear, 1);
    assert.equal(error.details.renderedGoalVisibility.humanVisibleGoalsBorderline, 2);
    assert.equal(error.details.renderedGoalVisibility.humanVisibleGoalsFailed, 2);
    assert.equal(error.details.humanVisibleGoalsClear, 1);
    assert.equal(error.details.humanVisibleGoalsBorderline, 2);
    assert.equal(error.details.humanVisibleGoalsFailed, 2);
    assert.ok(error.details.failedReasons.includes("borderline_goal_visibility"));
    assert.ok(error.details.failedReasons.includes("human_visible_clear_goal_count_mismatch"));
    assert.deepEqual(error.details.missingGoalNumbers, [2, 3, 4, 5]);
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects finish-frame proof without clear verdict and support frames", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [visibleGoalSegment(1, 84, {
        finishFrameEvidence: {
          frameTime: 98,
          confidence: 0.9,
          hasVisibleFinish: true,
          hasBallInNetOrPayoff: true,
          hasGoalMouth: true,
          evidenceCodes: ["finish_frame_visible", "clear_goal_payoff_visible"],
        },
      })],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderedGoalVisibility.humanVisibleGoalsClear, 0);
    assert.equal(error.details.renderedGoalVisibility.failedGoals[0].failureCode, "INSUFFICIENT_ACTION_FRAMES");
    assert.ok(error.details.renderedGoalVisibility.failedGoals[0].finishFrameEvidence.reasons.includes("finish_frame_visibility_verdict_missing"));
    assert.ok(error.details.renderedGoalVisibility.failedGoals[0].finishFrameEvidence.reasons.includes("insufficient_continuous_action_frames"));
    return true;
  });
});

test("video output gate rejects overlapping duplicate goal windows even when five goals are nominally covered", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: customScoreChanges([100, 180, 190, 280, 360]),
      summary: { countedGoalEventCount: 5 },
    },
    editPlan: {
      ...creativeOutputContract(),
      totalDuration: 64,
      segments: [
        visibleGoalSegment(1, 84),
        visibleGoalSegment(2, 160),
        visibleGoalSegment(3, 160, {
          sourceEnd: 194,
          finishTime: 174,
          confirmationTime: 190,
        }),
        visibleGoalSegment(4, 260),
        visibleGoalSegment(5, 340),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.expectedGoalCount, 5);
    assert.equal(error.details.actualConfirmedGoalSegmentCount, 5);
    assert.equal(error.details.coveredGoalCount, 5);
    assert.equal(error.details.distinctGoalIdentity.passed, false);
    assert.equal(error.details.distinctGoalIdentity.uniqueConfirmedGoalCount, 4);
    assert.ok(error.details.failedReasons.includes("duplicate_goal_segments_detected"));
    assert.match(JSON.stringify(error.details.distinctGoalIdentity.duplicatePairs), /duplicate_goal_window_overlap/);
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects overlapping distinct goal labels without separate live phases", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: customScoreChanges([234.25, 472, 483.25, 556.45, 594.25]),
      summary: { countedGoalEventCount: 5 },
    },
    editPlan: {
      ...creativeOutputContract(),
      totalDuration: 75,
      segments: [
        visibleGoalSegment(1, 223.6, { sourceEnd: 238.6, shotStart: 229.75, finishTime: 234.25, confirmationTime: 236.25 }),
        visibleGoalSegment(2, 461.35, { sourceEnd: 476.35, shotStart: 467.5, finishTime: 472, confirmationTime: 474 }),
        visibleGoalSegment(3, 471.1, { sourceEnd: 486.1, shotStart: 477.25, finishTime: 483.25, confirmationTime: 483.75 }),
        visibleGoalSegment(4, 545.8, { sourceEnd: 560.8, shotStart: 551.95, finishTime: 556.45, confirmationTime: 558.45 }),
        visibleGoalSegment(5, 583.6, { sourceEnd: 598.6, shotStart: 589.75, finishTime: 594.25, confirmationTime: 596.25 }),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.distinctGoalIdentity.passed, false);
    assert.equal(error.details.distinctGoalIdentity.uniqueConfirmedGoalCount, 4);
    assert.match(JSON.stringify(error.details.distinctGoalIdentity.duplicatePairs), /overlapping_goal_windows_need_separate_live_phases/);
    assert.ok(error.details.failedReasons.includes("duplicate_goal_segments_detected"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects duplicate finish times and reused score-change identity", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: customScoreChanges([100, 102]),
      summary: { countedGoalEventCount: 2 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [
        visibleGoalSegment(1, 84, {
          scoreBefore: "0-0",
          scoreAfter: "1-0",
          scoreChangeTime: 100,
        }),
        visibleGoalSegment(2, 86, {
          scoreBefore: "0-0",
          scoreAfter: "1-0",
          scoreChangeTime: 101,
        }),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.distinctGoalIdentity.passed, false);
    assert.match(JSON.stringify(error.details.distinctGoalIdentity.duplicatePairs), /duplicate_finish_time/);
    assert.match(JSON.stringify(error.details.distinctGoalIdentity.duplicatePairs), /duplicate_score_change_identity/);
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects five-goal proof that is too long for reference-style output", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(5),
      summary: { countedGoalEventCount: 5 },
    },
    editPlan: {
      ...creativeOutputContract(),
      totalDuration: 142.5,
      segments: Array.from({ length: 5 }, (_, index) => visibleGoalSegment(index + 1, 84 + index * 80)),
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.referenceStyleDuration.passed, false);
    assert.equal(error.details.referenceStyleDuration.totalDuration, 142.5);
    assert.ok(error.details.failedReasons.includes("reference_style_duration_out_of_bounds"));
    return true;
  });
});

test("video output gate rejects internal debug captions in user-facing proof", () => {
  const contract = creativeOutputContract();
  contract.captions[0] = {
    ...contract.captions[0],
    text: "FINISH + BUILD-UP",
    words: ["FINISH", "BUILD-UP"],
    activeWordTiming: [
      { word: "FINISH", start: 0, end: 0.72, active: true },
      { word: "BUILD-UP", start: 0.74, end: 1.58, active: true },
    ],
  };

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...contract,
      segments: [visibleGoalSegment(1, 84)],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.captions.passed, false);
    assert.equal(error.details.captions.debugCaptionCount, 1);
    assert.ok(error.details.failedReasons.includes("debug_caption_label_rendered"));
    return true;
  });
});

test("video output gate reports missing first and last counted goals explicitly", () => {
  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(5),
      summary: { countedGoalEventCount: 5 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [
        visibleGoalSegment(2, 164),
        visibleGoalSegment(3, 244),
        visibleGoalSegment(4, 324),
      ],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.expectedGoalCount, 5);
    assert.equal(error.details.coveredGoalCount, 3);
    assert.deepEqual(error.details.missingGoalNumbers, [1, 5]);
    assert.ok(error.details.failedReasons.includes("missing_or_invalid_counted_goal_segment"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects a goal segment that starts too close to the scoreboard change", () => {
  const weakBacktrackSegment = {
    ...visibleGoalSegment(1, 92),
    sourceStart: 94,
    sourceEnd: 106,
    shotStart: 95,
    finishTime: 98,
    confirmationTime: 102,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      replayOnly: false,
    },
  };

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [weakBacktrackSegment],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.deepEqual(error.details.missingGoalNumbers, [1]);
    assert.ok(error.details.matches[0].reasons.includes("missing_scoreboard_backtrack_context"));
    assert.ok(error.details.matches[0].reasons.includes("insufficient_pre_shot_context"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate accepts compact live phase tied to a later stable score change", () => {
  const scoreChange = {
    id: "counted_goal_late_stable_scoreboard",
    startScore: "1-0",
    endScore: "1-1",
    changeTime: 482.04,
    actionAnchorTime: 457.04,
    teamSide: "away",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 8,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  };
  const segment = visibleGoalSegment(2, 449.04, {
    sourceEnd: 462.54,
    shotStart: 454.94,
    finishTime: 457.04,
    confirmationTime: 459.29,
    scoreBefore: "1-0",
    scoreAfter: "1-1",
    scoreChangeTime: 482.04,
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
      offsideStatus: "onside",
      confidence: 0.93,
      decisionTimestamp: 482.04,
      decisionEvidence: ["scoreboard_backed_goal_sequence"],
      scoreBefore: "1-0",
      scoreAfter: "1-1",
      scoreChangeTime: 482.04,
    },
  });

  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: [scoreChange],
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [segment],
    },
  });

  assert.equal(report.status, "passed");
  assert.equal(report.coveredGoalCount, 1);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});

test("video output gate matches segments against the first observed scoreboard change", () => {
  const firstSeenAt = 537.19;
  const scoreChange = {
    id: "counted_goal_first_score_display",
    startScore: "2-1",
    endScore: "2-2",
    firstSeenAt,
    changeTime: 542.81,
    actionAnchorTime: firstSeenAt,
    hasPendingObservation: true,
    teamSide: "away",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 8,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  };
  const segment = visibleGoalSegment(1, 517.19, {
    sourceEnd: 539.54,
    shotStart: 525.94,
    finishTime: 529.19,
    confirmationTime: firstSeenAt,
    scoreBefore: "2-1",
    scoreAfter: "2-2",
    scoreChangeTime: firstSeenAt,
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
      offsideStatus: "onside",
      confidence: 0.93,
      decisionTimestamp: firstSeenAt,
      decisionEvidence: ["scoreboard_backed_goal_sequence"],
      scoreBefore: "2-1",
      scoreAfter: "2-2",
      scoreChangeTime: firstSeenAt,
    },
  });

  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: [scoreChange],
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [segment],
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.expectedGoals[0].anchorTime, firstSeenAt);
  assert.equal(report.expectedGoals[0].confirmationTime, firstSeenAt);
  assert.deepEqual(report.missingGoalNumbers, []);
});

test("video output gate uses stable score change when pending action anchor is too far away", () => {
  const scoreChange = {
    id: "counted_goal_with_far_pending_anchor",
    startScore: "0-0",
    endScore: "1-0",
    changeTime: 140,
    actionAnchorTime: 40,
    teamSide: "home",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 12,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  };
  const segment = visibleGoalSegment(1, 116, {
    sourceEnd: 144,
    shotStart: 128,
    finishTime: 136,
    confirmationTime: 140,
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
      offsideStatus: "onside",
      confidence: 0.93,
      decisionTimestamp: 140,
      decisionEvidence: ["scoreboard_backed_goal_sequence"],
    },
  });

  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: [scoreChange],
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...creativeOutputContract(),
      segments: [segment],
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.coveredGoalCount, 1);
  assert.equal(report.expectedGoals[0].anchorTime, 140);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});

test("video output gate allows explicit pre-render finish probes but rejects them after render", () => {
  const scoreChange = {
    id: "counted_goal_render_probe",
    startScore: "0-0",
    endScore: "1-0",
    changeTime: 140,
    actionAnchorTime: 126,
    teamSide: "home",
    scoreDelta: 1,
    confidence: 0.92,
    persistedDuration: 12,
    reverted: false,
    outcome: "counted_goal",
    reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
  };
  const renderProbeSegment = visibleGoalSegment(1, 116, {
    sourceEnd: 143,
    shotStart: 123,
    finishTime: 126,
    confirmationTime: 140,
    finishFrameEvidence: {
      frameTime: 126,
      confidence: 0,
      visibilityVerdict: "pending_rendered_proof",
      hasVisibleFinish: false,
      hasBallInNetOrPayoff: false,
      hasGoalMouth: false,
      hasPreShotActionFrame: false,
      hasFinishActionFrame: false,
      hasPayoffFrame: false,
      hasConfirmationFrame: true,
      continuousActionFrameCount: 0,
      isScoreboardOnly: true,
      evidenceCodes: ["rendered_finish_proof_required"],
    },
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
      offsideStatus: "onside",
      confidence: 0.93,
      decisionTimestamp: 140,
      decisionEvidence: ["scoreboard_backed_goal_sequence"],
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      scoreChangeTime: 140,
    },
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: false,
      hasConfirmation: true,
      replayOnly: false,
      requiresRenderedFinishProof: true,
      visualGoalPayoff: {
        hasVisibleGoalPayoff: false,
        scoreboardOnly: true,
        requiresRenderedFinishProof: true,
      },
    },
    reasonCodes: [
      "scoreboard_ocr_score_change",
      "scoreboard_temporal_consistency",
      "scoreboard_backed_goal_sequence",
    ],
  });
  const matchEventTruth = {
    providerMode: "fixture-match-event-truth",
    events: [],
    rejectedEvents: [],
    scoreTimelineObservations: [],
    scoreChanges: [scoreChange],
    summary: { countedGoalEventCount: 1 },
  };
  const editPlan = {
    ...creativeOutputContract(),
    segments: [renderProbeSegment],
  };

  const preRenderReport = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth,
    editPlan,
    requireRenderedGoalVisibility: false,
  });

  assert.equal(preRenderReport.passed, true);
  assert.equal(preRenderReport.coveredGoalCount, 1);
  assert.equal(preRenderReport.renderedGoalVisibility.status, "pre_render_skipped");

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth,
    editPlan,
    requireRenderedGoalVisibility: true,
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.coveredGoalCount, 0);
    assert.deepEqual(error.details.missingGoalNumbers, [1]);
    assert.ok(error.details.failedReasons.includes("missing_or_invalid_counted_goal_segment"));
    assert.ok(error.details.failedReasons.includes("invalid_segment_coverage"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate fails when final proof lacks dynamic word captions", () => {
  const contract = creativeOutputContract();
  contract.captions = contract.captions.map((caption) => ({ ...caption, activeWordTiming: [] }));

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...contract,
      segments: [visibleGoalSegment(1, 84)],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.captions.passed, false);
    assert.ok(error.details.failedReasons.includes("caption_word_timing_invalid"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects copyrighted audio or evasion styling in public proof", () => {
  const contract = creativeOutputContract();
  contract.audioPolicy = {
    ...contract.audioPolicy,
    source: "trending_commercial_track",
    copyrightedTrackBundled: true,
  };
  contract.creativeStyleTransforms = {
    ...contract.creativeStyleTransforms,
    mirror: true,
    copyrightEvasion: true,
  };

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...contract,
      segments: [visibleGoalSegment(1, 84)],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.audioPolicy.passed, false);
    assert.equal(error.details.creativeStyle.passed, false);
    assert.ok(error.details.failedReasons.includes("copyrighted_audio_bundled"));
    assert.ok(error.details.failedReasons.includes("copyright_evasion_style"));
    return true;
  });
});

test("video output gate rejects valid-goal proof rendered with blurred duplicate layout", () => {
  const contract = creativeOutputContract();
  contract.renderPolishQA = {
    cleanActionLayoutRequired: true,
    cleanActionLayoutPassed: false,
    actionLayoutMode: "blurred_duplicate_background",
    blurredBackgroundUsed: true,
    duplicateBackgroundUsed: true,
    splitLayoutCaptionCount: 0,
  };

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...contract,
      segments: [visibleGoalSegment(1, 84)],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderLayout.passed, false);
    assert.ok(error.details.renderLayout.reasons.includes("blurred_duplicate_background_used"));
    assert.ok(error.details.failedReasons.includes("blurred_duplicate_background_used"));
    assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
    return true;
  });
});

test("video output gate rejects split caption layout in valid-goal proof", () => {
  const contract = creativeOutputContract();
  contract.renderPolishQA = {
    ...contract.renderPolishQA,
    cleanActionLayoutPassed: false,
    splitLayoutCaptionCount: 1,
  };

  assert.throws(() => assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: {
      providerMode: "fixture-match-event-truth",
      events: [],
      rejectedEvents: [],
      scoreTimelineObservations: [],
      scoreChanges: countedScoreChanges(1),
      summary: { countedGoalEventCount: 1 },
    },
    editPlan: {
      ...contract,
      segments: [visibleGoalSegment(1, 84)],
    },
  }), (error) => {
    assert.equal(error.code, "VIDEO_OUTPUT_QA_FAILED");
    assert.equal(error.details.renderLayout.passed, false);
    assert.ok(error.details.renderLayout.reasons.includes("split_caption_layout_used"));
    assert.ok(error.details.failedReasons.includes("split_caption_layout_used"));
    return true;
  });
});
