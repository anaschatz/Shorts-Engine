const test = require("node:test");
const assert = require("node:assert/strict");

const { validateEditPlan } = require("../server/edit-plan.cjs");
const {
  analyzeVisualTracking,
  calibrateCropPlan,
  publicVisualTrackingSummary,
  validateCropPlan,
} = require("../server/visual-tracking.cjs");

const metadata = { durationSeconds: 18, width: 1920, height: 1080 };

function validEditPlan(overrides = {}) {
  return {
    sourceStart: 2,
    sourceEnd: 12,
    aspectRatio: "9:16",
    highlightType: "big_chance",
    confidence: 0.86,
    hook: "Η ΜΕΓΑΛΗ ΦΑΣΗ",
    title: "Tracking test",
    captions: [
      { start: 0, end: 1.5, text: "THE CHANCE OPENS", role: "opening_hook" },
      { start: 1.8, end: 4.2, text: "THE RUN CREATES THE WINDOW", role: "action_callout" },
      { start: 7.5, end: 9.8, text: "RUN IT BACK", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "social_caption_pop", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "social_sports_v1",
    reasonCodes: ["big_chance", "visual_shot_contact", "visual_ball_visible"],
    export: { width: 1080, height: 1920, format: "mp4" },
    ...overrides,
  };
}

test("stable ball and player action tracking can create a soft-follow crop plan", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [5.2, 6.4, 7.1],
      estimatedActionBounds: { x: 820, y: 300, width: 280, height: 320 },
      ballCandidateConfidence: 0.92,
      playerClusterConfidence: 0.88,
      cameraMotionLevel: 0.12,
      trackingConfidence: 0.91,
      recommendedFramingMode: "soft_follow",
      cropSafetyReason: "fixture_stable_action",
      fallbackUsed: false,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(tracking.goalClaimAllowed, false);
  assert.equal(cropPlan.mode, "soft_follow");
  assert.equal(cropPlan.cropMode, "soft_follow");
  assert.equal(cropPlan.fallbackUsed, false);
  assert.ok(cropPlan.actionCenterX > 0);
  assert.ok(cropPlan.actionCenterY > 0);
  assert.equal(cropPlan.trackingConfidence, cropPlan.confidence);
  assert.equal(cropPlan.maxPanSpeed > 0, true);
  assert.equal(typeof cropPlan.safeMargins.left, "number");
  assert.equal(cropPlan.cropBox.x >= 0, true);
  assert.equal(cropPlan.cropBox.x + cropPlan.cropBox.width <= metadata.width, true);
  assert.equal(cropPlan.actionSafeZones.length, 1);
  assert.equal(cropPlan.textObstructionRisk, false);
});

test("validated ball timeline creates bounded dynamic crop keyframes", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [3, 6, 9, 11],
      trackingSamples: [
        { time: 3, ballBox: { x: 280, y: 450, width: 24, height: 24 }, ballConfidence: 0.82, playerClusterBox: { x: 220, y: 330, width: 320, height: 380 }, playerClusterConfidence: 0.74, actionCenter: { x: 330, y: 520 }, source: "ball_detection" },
        { time: 6, ballBox: { x: 720, y: 430, width: 24, height: 24 }, ballConfidence: 0.86, playerClusterBox: { x: 620, y: 310, width: 360, height: 390 }, playerClusterConfidence: 0.78, actionCenter: { x: 760, y: 510 }, source: "ball_detection" },
        { time: 9, ballBox: null, ballConfidence: 0, playerClusterBox: { x: 980, y: 300, width: 380, height: 400 }, playerClusterConfidence: 0.68, actionCenter: { x: 1150, y: 500 }, source: "player_cluster_fallback" },
        { time: 11, ballBox: { x: 1460, y: 410, width: 24, height: 24 }, ballConfidence: 0.84, playerClusterBox: { x: 1320, y: 290, width: 400, height: 420 }, playerClusterConfidence: 0.8, actionCenter: { x: 1510, y: 500 }, source: "ball_detection" },
      ],
      estimatedActionBounds: { x: 200, y: 280, width: 1540, height: 440 },
      ballCandidateConfidence: 0.86,
      playerClusterConfidence: 0.8,
      trackingConfidence: 0.82,
      recommendedFramingMode: "ball_follow",
      cropSafetyReason: "ball_follow_validated_tracking_timeline",
      fallbackUsed: false,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(cropPlan.mode, "ball_follow");
  assert.equal(cropPlan.fallbackUsed, false);
  assert.equal(cropPlan.keyframes.length, 4);
  assert.equal(cropPlan.keyframes.filter((item) => item.source === "ball_detection").length, 3);
  assert.ok(cropPlan.keyframes[0].centerX < cropPlan.keyframes.at(-1).centerX);
  assert.ok(cropPlan.maxPanSpeed > 0 && cropPlan.maxPanSpeed <= 0.22);
  assert.equal(cropPlan.hysteresis > 0, true);
  assert.equal(cropPlan.actionSafeZones.length, 0);
});

test("ball-follow hands off to bounded celebration head tracking after payoff", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [3, 7, 10, 12],
      trackingSamples: [
        { time: 3, ballBox: { x: 300, y: 450, width: 24, height: 24 }, ballConfidence: 0.84, playerClusterBox: { x: 220, y: 330, width: 320, height: 380 }, playerClusterConfidence: 0.74, actionCenter: { x: 330, y: 520 }, source: "ball_detection" },
        { time: 7, ballBox: { x: 900, y: 430, width: 24, height: 24 }, ballConfidence: 0.87, playerClusterBox: { x: 760, y: 310, width: 360, height: 390 }, playerClusterConfidence: 0.78, actionCenter: { x: 910, y: 510 }, source: "ball_detection" },
        { time: 10, celebrationHeadBox: { x: 1500, y: 120, width: 120, height: 150 }, celebrationHeadConfidence: 0.84, actionCenter: { x: 1560, y: 195 }, source: "celebration_face_detection", phase: "scorer_follow" },
        { time: 12, celebrationHeadBox: { x: 1600, y: 130, width: 110, height: 140 }, celebrationHeadConfidence: 0.82, actionCenter: { x: 1655, y: 200 }, source: "celebration_face_detection", phase: "scorer_follow" },
      ],
      estimatedActionBounds: { x: 200, y: 120, width: 1510, height: 650 },
      ballCandidateConfidence: 0.87,
      playerClusterConfidence: 0.78,
      trackingConfidence: 0.82,
      recommendedFramingMode: "ball_follow",
      cropSafetyReason: "ball_follow_validated_tracking_timeline",
      fallbackUsed: false,
      celebrationHeadTrackCount: 2,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });
  const headKeyframes = cropPlan.keyframes.filter((item) => item.trackingTarget === "celebration_head");

  assert.equal(cropPlan.mode, "ball_follow");
  assert.equal(headKeyframes.length, 2);
  assert.equal(headKeyframes[0].phase, "scorer_follow");
  assert.equal(headKeyframes[0].reset, false);
  assert.ok(headKeyframes[0].centerX > cropPlan.keyframes[1].centerX);
  assert.ok(cropPlan.reasonCodes.includes("celebration_head_follow_bounded"));
  assert.equal(tracking.goalClaimAllowed, false);
});

test("scorer phase ignores a lingering ball and follows an honest celebration group fallback", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [2, 8, 13, 17],
      trackingSamples: [
        { time: 2, ballBox: { x: 300, y: 440, width: 24, height: 24 }, ballConfidence: 0.86, playerClusterBox: { x: 220, y: 300, width: 320, height: 420 }, playerClusterConfidence: 0.76, actionCenter: { x: 312, y: 452 }, source: "ball_detection", phase: "ball_follow" },
        { time: 8, ballBox: { x: 900, y: 430, width: 24, height: 24 }, ballConfidence: 0.88, playerClusterBox: { x: 760, y: 300, width: 360, height: 420 }, playerClusterConfidence: 0.8, actionCenter: { x: 912, y: 442 }, source: "ball_detection", phase: "ball_follow" },
        { time: 13, ballBox: { x: 180, y: 500, width: 24, height: 24 }, ballConfidence: 0.91, playerClusterBox: { x: 1320, y: 170, width: 360, height: 650 }, playerClusterConfidence: 0.82, actionCenter: { x: 1500, y: 495 }, source: "ball_detection", phase: "scorer_follow" },
        { time: 17, ballBox: { x: 160, y: 500, width: 24, height: 24 }, ballConfidence: 0.9, playerClusterBox: { x: 1380, y: 170, width: 360, height: 650 }, playerClusterConfidence: 0.84, actionCenter: { x: 1560, y: 495 }, source: "ball_detection", phase: "scorer_follow" },
      ],
      estimatedActionBounds: { x: 160, y: 170, width: 1580, height: 650 },
      ballCandidateConfidence: 0.91,
      playerClusterConfidence: 0.84,
      trackingConfidence: 0.84,
      recommendedFramingMode: "ball_follow",
      cropSafetyReason: "ball_follow_validated_tracking_timeline",
      fallbackUsed: false,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });
  const scorerKeyframes = cropPlan.keyframes.filter((item) => item.phase === "scorer_follow");

  assert.equal(scorerKeyframes.length, 2);
  assert.equal(scorerKeyframes.every((item) => item.source === "celebration_group_fallback"), true);
  assert.equal(scorerKeyframes.every((item) => item.trackingTarget !== "ball"), true);
  assert.ok(cropPlan.maxPanAcceleration > 0 && cropPlan.maxPanAcceleration <= 0.18);
});

test("low confidence tracking falls back to wide-safe framing", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualSignals: {
      providerMode: "fixture",
      fallbackUsed: false,
      windows: [{ start: 4, end: 7, types: ["unknown_visual_action", "player_cluster"], confidence: 0.55 }],
    },
    frames: [{ timestamp: 5.5, width: 640, height: 360 }],
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(cropPlan.mode, "wide_safe");
  assert.equal(cropPlan.cropMode, "wide_safe");
  assert.equal(cropPlan.fallbackUsed, true);
  assert.equal(cropPlan.maxPanSpeed, 0);
  assert.equal(cropPlan.cropBox.width, metadata.width);
  assert.equal(cropPlan.cropBox.height, metadata.height);
});

test("high camera motion locks framing wide instead of following uncertain action", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualSignals: {
      providerMode: "fixture",
      fallbackUsed: false,
      windows: [{ start: 4, end: 7, types: ["camera_pan", "player_cluster"], confidence: 0.9 }],
    },
    frames: [{ timestamp: 5.5, width: 640, height: 360 }],
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(tracking.recommendedFramingMode, "locked_wide");
  assert.equal(cropPlan.mode, "locked_wide");
  assert.equal(cropPlan.fallbackUsed, true);
});

test("caption obstruction risk falls back to wide-safe framing", () => {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [4.8, 5.4, 6.1],
      estimatedActionBounds: { x: 840, y: 760, width: 260, height: 230 },
      ballCandidateConfidence: 0.94,
      playerClusterConfidence: 0.89,
      cameraMotionLevel: 0.08,
      trackingConfidence: 0.92,
      recommendedFramingMode: "soft_follow",
      cropSafetyReason: "fixture_action_under_caption_zone",
      fallbackUsed: false,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(cropPlan.mode, "wide_safe");
  assert.equal(cropPlan.fallbackUsed, true);
  assert.equal(cropPlan.textObstructionRisk, false);
  assert.deepEqual(cropPlan.reasonCodes, ["wide_safe_caption_action_overlap"]);
});

test("crop plan validation rejects unsafe boxes and soft-follow without contained action", () => {
  assert.throws(
    () => validateCropPlan({
      mode: "soft_follow",
      targetAspectRatio: "9:16",
      confidence: 0.91,
      cropBox: { x: 100, y: 100, width: 300, height: 600 },
      safeArea: { x: 100, y: 100, width: 300, height: 600 },
      actionSafeZones: [{ x: 900, y: 200, width: 300, height: 300 }],
      textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
    }, metadata),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("edit-plan validation accepts safe crop plans and rejects overconfident fallback plans", () => {
  const tracking = publicVisualTrackingSummary({
    frameCount: 3,
    estimatedActionBounds: { x: 820, y: 300, width: 280, height: 320 },
    ballCandidateConfidence: 0.92,
    playerClusterConfidence: 0.88,
    cameraMotionLevel: 0.08,
    trackingConfidence: 0.91,
    recommendedFramingMode: "soft_follow",
    cropSafetyReason: "fixture_stable_action",
    fallbackUsed: false,
  }, metadata);
  const safeCrop = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });
  const validated = validateEditPlan(validEditPlan({ cropPlan: safeCrop }), metadata);

  assert.equal(validated.cropPlan.mode, "soft_follow");
  assert.equal(validated.cropStrategy.preserveFullFrame, false);

  assert.throws(
    () => validateEditPlan(validEditPlan({
      cropPlan: {
        mode: "wide_safe",
        targetAspectRatio: "9:16",
        confidence: 0.99,
        cropBox: { x: 0, y: 0, width: 1920, height: 1080 },
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        actionSafeZones: [],
        textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
        fallbackUsed: true,
      },
    }), metadata),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
