const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeFrames,
  publicVisualSignals,
  reasonCodeForVisualType,
  validateVisualSignals,
  visionHealth,
  visualHighlightTypeForReasons,
  visualReasonCodesForWindow,
} = require("../server/vision.cjs");

const metadata = { durationSeconds: 20, width: 1920, height: 1080 };

test("visual signal validation normalizes safe action windows", () => {
  const signals = validateVisualSignals({
    providerMode: "fixture-provider",
    fallbackUsed: false,
    windows: [
      {
        start: 7.2,
        end: 10.4,
        types: ["shot_like_motion", "goal_area_visible", "ball_visible"],
        confidence: 0.91,
        source: "fixture",
      },
    ],
  }, metadata);

  assert.equal(signals.summary.goalClaimAllowed, false);
  assert.deepEqual(visualReasonCodesForWindow(signals.windows[0]), [
    "visual_shot_like_motion",
    "visual_goal_area",
    "visual_ball_visible",
  ]);
  assert.equal(signals.summary.actionFocusConfidence, 0.91);
});

test("visual reasons map to non-goal football moment types", () => {
  assert.equal(reasonCodeForVisualType("save_like_motion"), "visual_save_like_motion");
  assert.equal(visualHighlightTypeForReasons(["visual_shot_like_motion", "visual_goal_area"]), "big_chance");
  assert.equal(visualHighlightTypeForReasons(["visual_save_like_motion"]), "save");
  assert.equal(visualHighlightTypeForReasons(["visual_foul_like_contact"]), "foul");
  assert.equal(visualHighlightTypeForReasons(["visual_goal_area"]), "unknown_action");
});

test("safe heuristic frame analysis does not claim tracking or goals", async () => {
  const result = await analyzeFrames({
    inputPath: "/Users/example/private.mp4",
    metadata,
    candidateWindows: [{ time: 8.1, confidence: 0.74, source: "signal_cluster" }],
  });

  assert.equal(result.providerMode, "safe-heuristic");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.summary.goalClaimAllowed, false);
  assert.equal(result.windows[0].type, "unknown_visual_action");
  assert.doesNotMatch(JSON.stringify(publicVisualSignals(result)), /\/Users|private\.mp4|secret/i);
});

test("vision health is safe and explicit about heuristic mode", () => {
  const health = visionHealth();
  assert.equal(health.ready, true);
  assert.equal(health.objectTracking, false);
  assert.equal(health.goalClaimAllowed, false);
  assert.equal(health.features.includes("safe_no_goal_inference"), true);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|storageKey|secret/i);
});
