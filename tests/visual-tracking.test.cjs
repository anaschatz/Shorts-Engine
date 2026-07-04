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
