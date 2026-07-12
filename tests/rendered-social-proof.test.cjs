const test = require("node:test");
const assert = require("node:assert/strict");

const { renderedSocialPolishProof } = require("../server/rendered-social-proof.cjs");

function goalSegment(overrides = {}) {
  return {
    id: "goal_1",
    highlightType: "goal",
    sourceStart: 10,
    shotStart: 20,
    finishTime: 22,
    confirmationTime: 25,
    sourceEnd: 32,
    goalNumber: 1,
    goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal" },
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      replayOnly: false,
    },
    finishFrameEvidence: {
      frameTime: 22,
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
    },
    ...overrides,
  };
}

function videoOutputQA(overrides = {}) {
  return {
    status: "passed",
    passed: true,
    expectedGoalCount: 1,
    actualConfirmedGoalSegmentCount: 1,
    coveredGoalCount: 1,
    hook: {
      passed: true,
      hookType: "goal_payoff",
      hookStart: 0,
      hookEnd: 1.85,
      hookText: "THE FINISH HITS",
      relatedGoalNumber: 1,
      evidenceCodes: ["confirmed_goal", "ball_in_net"],
      noFalseGoalClaim: true,
    },
    captions: {
      passed: true,
      captionCount: 2,
      dynamicCaptionCount: 2,
      readableCaptionCount: 2,
      openingHookCaptionInFirstTwoSeconds: true,
      safeAreas: ["lower_third"],
      stylePresets: ["hormozi_sports"],
      reasons: [],
    },
    animations: {
      passed: true,
      cueCount: 3,
      hookCueCount: 2,
      cueTypes: ["intro_hook", "caption_word_pop", "segment_flash"],
      reasons: [],
    },
    audioPolicy: {
      passed: true,
      audioMode: "source_only",
      licenseStatus: "source_rights_confirmed",
      externalAudioBundled: false,
      copyrightedTrackBundled: false,
      reasons: [],
    },
    creativeStyle: {
      passed: true,
      colorGrade: "sports_clean",
      mildZoom: 1.02,
      mirror: false,
      copyrightEvasion: false,
      watermarkObscuring: false,
      reasons: [],
    },
    renderedGoalVisibility: {
      passed: true,
      goalCount: 1,
      visibleGoalCount: 1,
      clearGoalCount: 1,
      borderlineGoalCount: 0,
      failedGoalCount: 0,
      humanVisibleGoalsClear: 1,
      humanVisibleGoalsBorderline: 0,
      humanVisibleGoalsFailed: 0,
      finishFrameContactSheetRequired: true,
      goals: [{
        index: 1,
        goalNumber: 1,
        finishTime: 22,
        passed: true,
        confidence: 0.9,
        failureCode: null,
        finishFrameEvidence: {
          passed: true,
          visibilityVerdict: "clear",
          frameTime: 22,
          confidence: 0.9,
          reasons: [],
        },
      }],
      failedGoals: [],
      reasons: [],
    },
    ...overrides,
  };
}

function renderPlan(overrides = {}) {
  return {
    mode: "multi_moment_compilation",
    segmentCount: 1,
    segments: [goalSegment()],
    captions: [
      {
        start: 0.1,
        end: 1.8,
        text: "THE FINISH HITS",
        role: "opening_hook",
        words: ["THE", "FINISH", "HITS"],
        activeWordTiming: [
          { word: "THE", start: 0.1, end: 0.45 },
          { word: "FINISH", start: 0.45, end: 1.1 },
          { word: "HITS", start: 1.1, end: 1.8 },
        ],
        stylePreset: "hormozi_sports",
        contrastMode: "outlined_shadow",
        safeArea: { name: "lower_third" },
      },
      {
        start: 24,
        end: 26,
        text: "GOAL CONFIRMED",
        role: "confirmation",
        words: ["GOAL", "CONFIRMED"],
        activeWordTiming: [
          { word: "GOAL", start: 24, end: 24.6 },
          { word: "CONFIRMED", start: 24.6, end: 25.5 },
        ],
        stylePreset: "hormozi_sports",
        contrastMode: "outlined_shadow",
        safeArea: { name: "lower_third" },
      },
    ],
    renderPolishQA: {
      transitionRenderedCount: 0,
      hardCutFallbackCount: 0,
      animatedCaptionCount: 2,
      dynamicWordCaptionCount: 2,
      captionMotion: "ass_word_by_word_highlight",
      overlayRenderedCount: 2,
      visualPolishScore: 98,
      transitions: [],
    },
    visualPolishQA: {
      abruptCutRiskCount: 0,
      cutSmoothnessScore: 1,
      phaseCoverageScore: 1,
      referencePacingScore: 1,
      visualPolishScore: 98,
    },
    visualTrackingSummary: {
      frameCount: 3,
      sampledTimestamps: [14.2, 18.6, 21.4],
      detectedMotionRegions: [],
      estimatedActionCenter: { x: 960, y: 520 },
      estimatedActionBounds: { x: 700, y: 250, width: 420, height: 420 },
      ballCandidateConfidence: 0.89,
      playerClusterConfidence: 0.86,
      cameraMotionLevel: 0.08,
      trackingConfidence: 0.91,
      recommendedFramingMode: "soft_follow",
      cropSafetyReason: "soft_follow_provider_ball_player_action",
      fallbackUsed: false,
      trackingProviderMode: "opencv-object-tracking",
      ballTrackCount: 2,
      playerClusterCount: 2,
      goalClaimAllowed: false,
    },
    cropPlan: {
      mode: "soft_follow",
      cropMode: "soft_follow",
      targetAspectRatio: "9:16",
      safeArea: { x: 650, y: 65, width: 530, height: 950 },
      cropBox: { x: 612, y: 0, width: 608, height: 1080 },
      confidence: 0.91,
      trackingConfidence: 0.91,
      actionCenterX: 960,
      actionCenterY: 520,
      maxPanSpeed: 0.18,
      safeMargins: { left: 40, top: 65, right: 38, bottom: 65 },
      reasonCodes: ["soft_follow_stable_action_bounds"],
      textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
      actionSafeZones: [{ x: 700, y: 250, width: 420, height: 420 }],
      fallbackUsed: false,
      textObstructionRisk: false,
    },
    videoOutputQA: videoOutputQA(),
    ...overrides,
  };
}

function baseProof(overrides = {}) {
  return renderedSocialPolishProof({
    outputMp4: {
      relativePath: "manual-downloads/shortsengine-youtube-test-20260704.mp4",
      sizeBytes: 123456,
      downloadVerified: true,
    },
    ffprobe: {
      status: "passed",
      sizeBytes: 123456,
      durationSeconds: 32,
      width: 1080,
      height: 1920,
    },
    renderPlan: renderPlan(overrides.renderPlan),
    videoOutputQA: overrides.videoOutputQA || videoOutputQA(),
    generatedAt: "2026-07-04T10:00:00.000Z",
    ...overrides.proof,
  });
}

test("rendered social polish proof passes for fresh MP4 with hook and dynamic captions", () => {
  const report = baseProof();
  assert.equal(report.passed, true);
  assert.equal(report.outputFreshness.uniqueOutput, true);
  assert.equal(report.renderedHook.passed, true);
  assert.equal(report.dynamicCaptions.dynamicWordCaptionCount, 2);
  assert.equal(report.dynamicCaptions.activeWordHighlightRendered, true);
  assert.equal(report.dynamicCaptions.openingCaptionCandidates[0].hookTextMatch, true);
  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.trackingProviderMode, "opencv-object-tracking");
  assert.equal(report.renderedActionFraming.goalClaimAllowed, false);
  assert.equal(report.rightsSafeStyle.passed, true);
  assert.equal(report.logsDownloaded, false);
  assert.equal(report.artifactsDownloaded, false);
});

test("rendered social polish proof accepts a polished balanced non-goal short", () => {
  const base = renderPlan();
  const report = baseProof({
    renderPlan: {
      mode: "single_moment",
      goalSelectionMode: "balanced",
      sourceStart: 38,
      sourceEnd: 56,
      totalDuration: 18,
      segmentCount: 0,
      segments: [],
      hookPlan: {
        hookStart: 0,
        hookEnd: 1.6,
        hookType: "shot",
        hookText: "THE CHANCE OPENS",
        reasonCodes: ["big_chance", "visual_shot_like_motion"],
        noFalseGoalClaim: true,
      },
      audioPolicy: {
        audioMode: "source",
        licenseStatus: "source_rights_confirmed",
        externalAudioBundled: false,
        copyrightedTrackBundled: false,
      },
      creativeStyleTransforms: {
        mirror: false,
        copyrightEvasion: false,
        watermarkObscuring: false,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        transitionRenderedCount: 0,
        hardCutFallbackCount: 0,
      },
      visualPolishQA: {
        ...base.visualPolishQA,
        abruptCutRiskCount: 0,
      },
    },
    videoOutputQA: {},
  });

  assert.equal(report.phaseVisibility.mode, "balanced");
  assert.equal(report.phaseVisibility.passed, true);
  assert.equal(report.dynamicCaptions.openingHookCaptionRendered, true);
  assert.equal(report.passed, true, JSON.stringify(report.failedReasons));
});

test("rendered social polish proof recognizes a hook-matching opening caption without a role label", () => {
  const base = renderPlan();
  const report = baseProof({
    renderPlan: {
      mode: "single_moment",
      goalSelectionMode: "balanced",
      sourceStart: 38,
      sourceEnd: 62,
      totalDuration: 24,
      segmentCount: 0,
      segments: [],
      captions: [{
        ...base.captions[0],
        start: 0,
        end: 2.4,
        text: "THE BIG CHANCE OPENS",
        role: "action_callout",
      }],
      hookPlan: {
        hookStart: 0,
        hookEnd: 1.6,
        hookType: "shot",
        hookText: "THE BIG CHANCE OPENS",
        evidenceCodes: ["big_chance", "visual_shot_like_motion"],
        noFalseGoalClaim: true,
      },
      audioPolicy: {
        audioMode: "source",
        licenseStatus: "source_rights_confirmed",
        externalAudioBundled: false,
        copyrightedTrackBundled: false,
      },
      creativeStyleTransforms: {
        mirror: false,
        copyrightEvasion: false,
        watermarkObscuring: false,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        dynamicWordCaptionCount: 1,
        transitionRenderedCount: 0,
        hardCutFallbackCount: 0,
      },
      visualPolishQA: {
        ...base.visualPolishQA,
        abruptCutRiskCount: 0,
      },
    },
    videoOutputQA: {},
  });

  assert.equal(report.dynamicCaptions.openingHookCaptionRendered, true);
  assert.equal(report.passed, true, JSON.stringify(report.failedReasons));
});

test("rendered social polish proof requires celebration head coverage when renderer opts in", () => {
  const base = renderPlan();
  const ballFollow = {
    mode: "ball_follow",
    cropMode: "ball_follow",
    fallbackUsed: false,
    confidence: 0.82,
    trackingConfidence: 0.82,
    maxPanSpeed: 0.18,
    textObstructionRisk: false,
    actionSafeZones: [],
    keyframes: [
      { sourceTime: 12, centerX: 800, centerY: 540, zoom: 1, confidence: 0.84, source: "ball_detection" },
      { sourceTime: 22, centerX: 980, centerY: 540, zoom: 1, confidence: 0.86, source: "ball_detection" },
      { sourceTime: 26, centerX: 1320, centerY: 540, zoom: 1, confidence: 0.82, source: "celebration_face_detection", trackingTarget: "celebration_head" },
    ],
  };
  const passing = baseProof({
    renderPlan: {
      goalSelectionMode: "valid_goals_only",
      cropPlan: ballFollow,
      visualTrackingSummary: {
        ...base.visualTrackingSummary,
        recommendedFramingMode: "ball_follow",
        fallbackUsed: false,
        celebrationHeadTrackCount: 1,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        dynamicCropRendered: true,
        cropKeyframeCount: 3,
        maxPanSpeed: 0.18,
        trackingProviderMode: "ffmpeg-football-tracking",
        trackingConfidence: 0.82,
        ballTrackCount: 2,
        playerClusterCount: 2,
        celebrationHeadTrackCount: 1,
        celebrationHeadKeyframeCount: 1,
        celebrationHeadTrackedGoalCount: 1,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: true,
        celebrationHeadFollowRendered: true,
      },
    },
  });
  assert.equal(passing.renderedActionFraming.celebrationHeadTrackingPassed, true);
  assert.equal(passing.passed, true);

  const failed = baseProof({
    renderPlan: {
      goalSelectionMode: "valid_goals_only",
      cropPlan: ballFollow,
      visualTrackingSummary: {
        ...base.visualTrackingSummary,
        recommendedFramingMode: "ball_follow",
        fallbackUsed: false,
        celebrationHeadTrackCount: 0,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        dynamicCropRendered: true,
        cropKeyframeCount: 3,
        maxPanSpeed: 0.18,
        trackingProviderMode: "ffmpeg-football-tracking",
        trackingConfidence: 0.82,
        ballTrackCount: 2,
        playerClusterCount: 2,
        celebrationHeadTrackCount: 0,
        celebrationHeadKeyframeCount: 0,
        celebrationHeadTrackedGoalCount: 0,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: false,
        celebrationHeadFollowRendered: false,
      },
    },
  });
  assert.equal(failed.renderedActionFraming.celebrationHeadTrackingPassed, false);
  assert.ok(failed.failedReasons.includes("celebration_follow_incomplete"));
  assert.equal(failed.passed, false);

  const groupFallback = baseProof({
    renderPlan: {
      goalSelectionMode: "valid_goals_only",
      cropPlan: ballFollow,
      visualTrackingSummary: {
        ...base.visualTrackingSummary,
        recommendedFramingMode: "ball_follow",
        fallbackUsed: false,
        celebrationHeadTrackCount: 0,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        dynamicCropRendered: true,
        cropKeyframeCount: 3,
        maxPanSpeed: 0.18,
        maxPanAcceleration: 0.12,
        trackingProviderMode: "ffmpeg-football-tracking",
        trackingConfidence: 0.82,
        ballTrackCount: 2,
        playerClusterCount: 2,
        celebrationHeadTrackCount: 0,
        celebrationHeadKeyframeCount: 0,
        celebrationHeadTrackedGoalCount: 0,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: false,
        celebrationHeadFollowRendered: false,
        celebrationGroupFallbackFrameCount: 2,
        twoPhaseGoalCameraPassed: true,
        twoPhaseGoalCamera: {
          passed: true,
          goalCount: 1,
          coveredGoalCount: 1,
          missingGoalNumbers: [],
        },
      },
    },
  });
  assert.equal(groupFallback.renderedActionFraming.celebrationHeadTrackingPassed, false);
  assert.equal(groupFallback.renderedActionFraming.celebrationFollowPassed, true);
  assert.equal(groupFallback.renderedActionFraming.twoPhaseGoalCameraPassed, true);
  assert.equal(groupFallback.passed, true);
});

test("rendered social polish proof fails when hook is missing from first two seconds", () => {
  const qa = videoOutputQA({
    hook: {
      passed: false,
      hookStart: 2.2,
      hookEnd: 4,
      evidenceCodes: [],
      noFalseGoalClaim: true,
      reasons: ["hook_not_in_first_two_seconds"],
    },
  });
  const report = baseProof({ videoOutputQA: qa, renderPlan: { videoOutputQA: qa } });
  assert.equal(report.passed, false);
  assert.match(report.failedReasons.join(","), /hook/);
});

test("rendered social polish proof fails when captions are not word-by-word", () => {
  const report = baseProof({
    renderPlan: {
      renderPolishQA: {
        transitionRenderedCount: 0,
        hardCutFallbackCount: 0,
        animatedCaptionCount: 2,
        dynamicWordCaptionCount: 0,
        captionMotion: "ass_fade_scale",
        overlayRenderedCount: 2,
        visualPolishScore: 72,
      },
    },
  });
  assert.equal(report.passed, false);
  assert.match(report.failedReasons.join(","), /dynamic_word_captions_missing|rendered_caption_motion_not_word_by_word/);
});

test("rendered social polish proof fails for latest or unprobed output references", () => {
  const report = baseProof({
    proof: {
      outputMp4: {
        relativePath: "manual-downloads/latest.mp4",
        sizeBytes: 123,
        downloadVerified: true,
      },
      ffprobe: { status: "missing" },
    },
  });
  assert.equal(report.passed, false);
  assert.match(report.failedReasons.join(","), /output_mp4_reference_not_unique|ffprobe_not_passed/);
});

test("rendered social polish proof rejects non-goal filler in final segments", () => {
  const report = baseProof({
    renderPlan: {
      segments: [
        goalSegment(),
        {
          id: "chance_1",
          highlightType: "big_chance",
          sourceStart: 40,
          sourceEnd: 48,
          phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: false, hasConfirmation: false },
        },
      ],
    },
  });
  assert.equal(report.passed, false);
  assert.match(report.failedReasons.join(","), /non_goal_segments_present/);
});

test("rendered social polish proof rejects five-goal MP4 that is too long for reference-style output", () => {
  const qa = videoOutputQA({
    expectedGoalCount: 5,
    actualConfirmedGoalSegmentCount: 5,
    coveredGoalCount: 5,
  });
  const report = baseProof({
    videoOutputQA: qa,
    renderPlan: {
      videoOutputQA: qa,
    },
    proof: {
      ffprobe: {
        status: "passed",
        sizeBytes: 123456,
        durationSeconds: 142.5,
        width: 1080,
        height: 1920,
      },
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.referenceDuration.passed, false);
  assert.equal(report.referenceDuration.durationSeconds, 142.5);
  assert.match(report.failedReasons.join(","), /rendered_reference_duration_out_of_bounds/);
});

test("rendered social polish proof surfaces duplicate goal identity failures from video output QA", () => {
  const qa = videoOutputQA({
    expectedGoalCount: 5,
    actualConfirmedGoalSegmentCount: 5,
    coveredGoalCount: 5,
    passed: false,
    status: "failed",
    distinctGoalIdentity: {
      passed: false,
      uniqueConfirmedGoalCount: 4,
      duplicateSegmentIndexes: [3],
      duplicatePairs: [
        {
          leftSegmentIndex: 2,
          rightSegmentIndex: 3,
          leftGoalNumber: 2,
          rightGoalNumber: 3,
          overlapRatio: 0.66,
          reasons: ["duplicate_goal_window_overlap"],
        },
      ],
    },
  });
  const report = baseProof({
    videoOutputQA: qa,
    renderPlan: {
      videoOutputQA: qa,
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.phaseVisibility.uniqueConfirmedGoalCount, 4);
  assert.deepEqual(report.phaseVisibility.duplicateSegmentIndexes, [3]);
  assert.match(report.failedReasons.join(","), /distinct_goal_identity_failed|video_output_qa_failed/);
});

test("rendered social polish proof fails when finish-frame visibility gate failed", () => {
  const qa = videoOutputQA({
    passed: false,
    status: "failed",
    renderedGoalVisibility: {
      passed: false,
      goalCount: 1,
      visibleGoalCount: 0,
      clearGoalCount: 0,
      borderlineGoalCount: 0,
      failedGoalCount: 1,
      humanVisibleGoalsClear: 0,
      humanVisibleGoalsBorderline: 0,
      humanVisibleGoalsFailed: 1,
      finishFrameContactSheetRequired: true,
      failedGoals: [{
        index: 1,
        goalNumber: 1,
        failureCode: "FINISH_FRAME_NOT_PROVEN",
        finishFrameEvidence: {
          passed: false,
          visibilityVerdict: "failed",
          frameTime: null,
          confidence: null,
          reasons: ["finish_frame_evidence_missing"],
        },
      }],
      reasons: ["rendered_goal_visibility_failed", "finish_frame_not_proven"],
    },
  });
  const report = baseProof({
    videoOutputQA: qa,
    renderPlan: {
      videoOutputQA: qa,
      segments: [goalSegment({ finishFrameEvidence: null })],
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.phaseVisibility.renderedGoalVisibility.passed, false);
  assert.equal(report.phaseVisibility.renderedGoalVisibility.failedGoals[0].failureCode, "FINISH_FRAME_NOT_PROVEN");
  assert.match(report.failedReasons.join(","), /rendered_goal_visibility_failed|video_output_qa_failed/);
});

test("rendered social polish proof fails unsafe soft-follow framing", () => {
  const report = baseProof({
    renderPlan: {
      visualTrackingSummary: {
        trackingProviderMode: "opencv-object-tracking",
        ballCandidateConfidence: 0.4,
        playerClusterConfidence: 0.4,
        trackingConfidence: 0.93,
        fallbackUsed: false,
        ballTrackCount: 0,
        playerClusterCount: 0,
        goalClaimAllowed: false,
      },
      cropPlan: {
        mode: "soft_follow",
        cropMode: "soft_follow",
        targetAspectRatio: "9:16",
        safeArea: { x: 100, y: 100, width: 400, height: 700 },
        cropBox: { x: 100, y: 100, width: 400, height: 700 },
        confidence: 0.93,
        trackingConfidence: 0.93,
        actionCenterX: 1200,
        actionCenterY: 500,
        maxPanSpeed: 0.32,
        actionSafeZones: [{ x: 1200, y: 220, width: 360, height: 320 }],
        textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
        fallbackUsed: false,
        textObstructionRisk: false,
      },
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.renderedActionFraming.passed, false);
  assert.match(report.failedReasons.join(","), /soft_follow_without_reliable_action_tracking|action_safe_zone_not_contained|abrupt_crop_pan_risk/);
});

test("rendered social polish proof passes wide-safe fallback when tracking is uncertain", () => {
  const report = baseProof({
    renderPlan: {
      visualTrackingSummary: {
        trackingProviderMode: "opencv-object-tracking",
        trackingProviderFailureCode: "OPENCV_TRACKING_LOW_CONFIDENCE",
        ballCandidateConfidence: 0.2,
        playerClusterConfidence: 0.42,
        trackingConfidence: 0.36,
        fallbackUsed: true,
        ballTrackCount: 0,
        playerClusterCount: 0,
        goalClaimAllowed: false,
      },
      cropPlan: {
        mode: "wide_safe",
        cropMode: "wide_safe",
        targetAspectRatio: "9:16",
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        cropBox: { x: 0, y: 0, width: 1920, height: 1080 },
        confidence: 0.36,
        trackingConfidence: 0.36,
        actionCenterX: 960,
        actionCenterY: 540,
        maxPanSpeed: 0,
        actionSafeZones: [],
        textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
        fallbackUsed: true,
        textObstructionRisk: false,
      },
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.renderedActionFraming.cropMode, "wide_safe");
  assert.equal(report.renderedActionFraming.fallbackUsed, true);
});

test("rendered social polish proof accepts wide-safe summary fallback without explicit crop plan", () => {
  const report = baseProof({
    renderPlan: {
      cropPlan: null,
      cropPlanMode: "wide_safe",
      visualTrackingSummary: {
        trackingProviderMode: "deterministic-wide-safe",
        trackingConfidence: 0.4,
        fallbackUsed: true,
        goalClaimAllowed: false,
      },
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.cropMode, "wide_safe");
  assert.equal(report.renderedActionFraming.fallbackUsed, true);
  assert.equal(report.renderedActionFraming.maxPanSpeed, 0);
});

test("rendered social polish proof accepts validated reference-fill summary fallback", () => {
  const report = baseProof({
    renderPlan: {
      cropPlan: null,
      cropPlanMode: "reference_fill",
      renderPolishQA: {
        ...renderPlan().renderPolishQA,
        actionLayoutMode: "scorebug_preserved_vertical_fill",
        fullHeightActionCrop: true,
        scoreboardOverlayRendered: true,
        scoreboardOverlayRegionId: "scorebug_broadcast_compact",
      },
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.cropMode, "reference_fill");
  assert.equal(report.renderedActionFraming.fallbackUsed, true);
});

test("rendered social polish proof does not classify static fallback cuts as crop pan risk", () => {
  const report = baseProof({
    renderPlan: {
      visualPolishQA: {
        abruptCutRiskCount: 1,
        cutSmoothnessScore: 0.8,
        phaseCoverageScore: 1,
        referencePacingScore: 1,
        visualPolishScore: 92,
      },
      visualTrackingSummary: {
        trackingProviderMode: "deterministic-wide-safe",
        trackingConfidence: 0.4,
        fallbackUsed: true,
        goalClaimAllowed: false,
      },
      cropPlan: {
        mode: "wide_safe",
        cropMode: "wide_safe",
        targetAspectRatio: "9:16",
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        cropBox: { x: 0, y: 0, width: 1920, height: 1080 },
        confidence: 0.4,
        trackingConfidence: 0.4,
        maxPanSpeed: 0,
        actionSafeZones: [],
        textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
        fallbackUsed: true,
        textObstructionRisk: false,
      },
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.abruptCropPanRisk, false);
  assert.match(report.failedReasons.join(","), /abrupt_cut_risk_detected/);
  assert.doesNotMatch(report.failedReasons.join(","), /abrupt_crop_pan_risk/);
});

test("rendered social polish recovers stale cut risk after complete rendered goal sequences", () => {
  const second = goalSegment({
    id: "goal_2",
    goalNumber: 2,
    sourceStart: 40,
    shotStart: 45,
    finishTime: 48,
    confirmationTime: 51,
    sourceEnd: 56,
  });
  const clearRefs = ["pre_shot", "finish", "payoff", "confirmation"]
    .map((role, index) => ({ role, time: index + 1, clear: true }));
  const report = baseProof({
    renderPlan: {
      segmentCount: 2,
      segments: [goalSegment(), second],
      visualPolishQA: {
        abruptCutRiskCount: 2,
        cutSmoothnessScore: 0.35,
        phaseCoverageScore: 1,
        referencePacingScore: 0.5,
        visualPolishScore: 72,
      },
      renderPolishQA: {
        ...renderPlan().renderPolishQA,
        transitionRenderedCount: 1,
        hardCutFallbackCount: 0,
        transitions: [{
          type: "short_fade",
          timelineStart: 22,
          transitionDurationSeconds: 0.4,
          renderedBy: "segment_fade_concat",
        }],
      },
      renderedGoalProof: {
        passed: true,
        clearGoalCount: 2,
        failedGoalCount: 0,
        goals: [
          { goalNumber: 1, verdict: "clear", frameRefs: clearRefs },
          { goalNumber: 2, verdict: "clear", frameRefs: clearRefs },
        ],
      },
    },
  });

  assert.equal(report.smoothEditing.passed, true);
  assert.equal(report.smoothEditing.renderedSequenceRecovery, true);
  assert.doesNotMatch(report.smoothEditing.reasons.join(","), /abrupt_cut_risk_detected/);
});

test("rendered social polish report does not expose sensitive strings", () => {
  const report = baseProof();
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /\/Users\/|\/private\/|token|secret|stdout|stderr/i);
});

test("rendered social polish treats operator-disabled captions as intentional", () => {
  const report = baseProof({
    renderPlan: {
      renderPolishQA: {
        ...renderPlan().renderPolishQA,
        captionsRendered: false,
        captionsDisabledByOperator: true,
        animatedCaptionCount: 0,
        dynamicWordCaptionCount: 0,
        captionMotion: "none",
      },
    },
  });

  assert.equal(report.dynamicCaptions.passed, true);
  assert.equal(report.dynamicCaptions.disabledByOperator, true);
  assert.equal(report.dynamicCaptions.dynamicWordCaptionCount, 0);
});

test("rendered social polish accepts safe static framing without celebration head tracking", () => {
  const base = renderPlan();
  const report = baseProof({
    renderPlan: {
      cropPlan: {
        mode: "reference_fill",
        cropMode: "reference_fill",
        targetAspectRatio: "9:16",
        confidence: 0,
        trackingConfidence: 0,
        fallbackUsed: true,
        actionSafeZones: [],
        textSafeZones: [],
        textObstructionRisk: false,
      },
      visualTrackingSummary: {
        trackingProviderMode: "safe-tracking-fallback",
        trackingConfidence: 0,
        ballCandidateConfidence: 0,
        playerClusterConfidence: 0,
        ballTrackCount: 0,
        playerClusterCount: 0,
        fallbackUsed: true,
      },
      renderPolishQA: {
        ...base.renderPolishQA,
        celebrationHeadTrackCount: 0,
        celebrationHeadKeyframeCount: 0,
        celebrationHeadTrackedGoalCount: 0,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: false,
        celebrationHeadFollowRendered: false,
        twoPhaseGoalCameraPassed: false,
      },
    },
  });

  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.celebrationFollowPassed, true);
  assert.equal(report.renderedActionFraming.reasons.includes("celebration_follow_incomplete"), false);
});

test("rendered social polish accepts two clear five-goal tracking fallbacks", () => {
  const segments = Array.from({ length: 5 }, (_, index) => goalSegment({
    id: `goal_${index + 1}`,
    goalNumber: index + 1,
    sourceStart: index * 24,
    shotStart: index * 24 + 8,
    finishTime: index * 24 + 12,
    confirmationTime: index * 24 + 18,
    sourceEnd: index * 24 + 22,
  }));
  const twoPhaseGoals = segments.map((segment, index) => ({
    goalNumber: segment.goalNumber,
    ballFollowPassed: ![0, 2].includes(index),
    scorerFollowPassed: true,
    ballVisibilityCoverage: 1,
    ballCenterCoverage: 1,
    wideSafeFallbackFrames: [0, 2].includes(index) ? 1 : 0,
    trackingConfidence: { ballFollow: [0, 2].includes(index) ? 0.79 : 0.88, scorerFollow: 0.8 },
    passed: ![0, 2].includes(index),
  }));
  const report = baseProof({
    proof: {
      ffprobe: { status: "passed", sizeBytes: 123456, durationSeconds: 106, width: 1080, height: 1920 },
    },
    renderPlan: {
      segmentCount: 5,
      segments,
      renderedGoalProof: {
        passed: true,
        clearGoalCount: 5,
        failedGoalCount: 0,
      },
      cropPlan: {
        mode: "ball_follow",
        cropMode: "ball_follow",
        fallbackUsed: false,
        trackingConfidence: 0.69,
        maxPanSpeed: 0.18,
        maxPanAcceleration: 0.12,
        keyframes: Array.from({ length: 20 }, () => ({})),
        actionSafeZones: [],
        textObstructionRisk: false,
      },
      visualTrackingSummary: {
        trackingProviderMode: "ffmpeg-football-tracking",
        trackingConfidence: 0.69,
        ballCandidateConfidence: 0.86,
        playerClusterConfidence: 0.84,
        ballTrackCount: 12,
        playerClusterCount: 20,
        fallbackUsed: false,
      },
      renderPolishQA: {
        ...renderPlan().renderPolishQA,
        transitionRenderedCount: 4,
        hardCutFallbackCount: 0,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackCount: 4,
        celebrationHeadKeyframeCount: 4,
        celebrationHeadTrackedGoalCount: 3,
        celebrationHeadFollowRendered: true,
        twoPhaseGoalCameraPassed: false,
        twoPhaseGoalCamera: {
          passed: false,
          goalCount: 5,
          coveredGoalCount: 3,
          missingGoalNumbers: [1, 3],
          goals: twoPhaseGoals,
        },
      },
    },
    videoOutputQA: videoOutputQA({
      expectedGoalCount: 5,
      actualConfirmedGoalSegmentCount: 5,
      coveredGoalCount: 5,
      renderedGoalVisibility: {
        passed: true,
        goalCount: 5,
        visibleGoalCount: 5,
        clearGoalCount: 5,
        borderlineGoalCount: 0,
        failedGoalCount: 0,
        humanVisibleGoalsClear: 5,
        humanVisibleGoalsBorderline: 0,
        humanVisibleGoalsFailed: 0,
        goals: [],
        failedGoals: [],
        reasons: [],
      },
    }),
  });

  assert.equal(report.renderedActionFraming.passed, true);
  assert.equal(report.renderedActionFraming.twoPhaseGracePassed, true);
  assert.equal(report.renderedActionFraming.celebrationFollowPassed, true);
});
