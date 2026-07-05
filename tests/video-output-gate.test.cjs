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
    ...overrides,
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
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
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
        visibleGoalSegment(3, 170),
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
  const segment = {
    ...visibleGoalSegment(1, 116),
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
  };

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
