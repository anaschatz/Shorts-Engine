const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ExternalTrackingProviderAdapter,
  MockTrackingProvider,
  analyzeTracking,
  publicTrackingProviderOutput,
  validateTrackingProviderOutput,
} = require("../server/tracking-provider.cjs");
const {
  analyzeVisualTracking,
  calibrateCropPlan,
} = require("../server/visual-tracking.cjs");

const metadata = { durationSeconds: 18, width: 1920, height: 1080 };

function visualSignals(overrides = {}) {
  return {
    providerMode: "fixture-visual",
    fallbackUsed: false,
    windows: [
      {
        start: 4,
        end: 7,
        types: ["ball_visible", "shot_contact", "player_cluster"],
        confidence: 0.98,
        bounds: { x: 820, y: 300, width: 300, height: 340 },
      },
    ],
    ...overrides,
  };
}

test("default tracking provider returns deterministic ball and player tracks", () => {
  const output = analyzeTracking({
    metadata,
    visualSignals: visualSignals(),
    frames: [{ timestamp: 5.2, width: 640, height: 360 }],
  });
  const safe = validateTrackingProviderOutput(output, metadata);

  assert.equal(safe.fallbackUsed, false);
  assert.equal(safe.ballTracks.length > 0, true);
  assert.equal(safe.playerClusters.length > 0, true);
  assert.equal(safe.goalClaimAllowed, false);
  assert.equal(safe.reasonCodes.includes("tracking_ball_visible"), true);
});

test("mock tracking provider is deterministic and local", () => {
  const provider = new MockTrackingProvider();
  const first = provider.analyzeTracking({ metadata, visualSignals: visualSignals() });
  const second = provider.analyzeTracking({ metadata, visualSignals: visualSignals() });

  assert.deepEqual(first, second);
  assert.equal(provider.health().networkRequired, false);
});

test("tracking provider output rejects unsafe boxes unknown labels and leaked values", () => {
  assert.throws(
    () => validateTrackingProviderOutput({
      providerMode: "fixture",
      fallbackUsed: false,
      frameCount: 1,
      ballTracks: [{ timestamp: 2, label: "referee", confidence: 0.9, bounds: { x: 1, y: 1, width: 10, height: 10 } }],
      playerClusters: [{ timestamp: 2, confidence: 0.9, bounds: { x: 1, y: 1, width: 10, height: 10 } }],
      actionBounds: { x: 1, y: 1, width: 10, height: 10 },
      actionCenter: { x: 6, y: 6 },
      confidence: 0.9,
      reasonCodes: ["tracking_ball_visible"],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );

  assert.throws(
    () => validateTrackingProviderOutput({
      providerMode: "fixture",
      fallbackUsed: false,
      frameCount: 1,
      ballTracks: [{ timestamp: 2, confidence: 0.9, bounds: { x: 1900, y: 1, width: 100, height: 10 } }],
      playerClusters: [{ timestamp: 2, confidence: 0.9, bounds: { x: 1, y: 1, width: 10, height: 10 } }],
      actionBounds: { x: 1, y: 1, width: 10, height: 10 },
      actionCenter: { x: 6, y: 6 },
      confidence: 0.9,
      reasonCodes: ["tracking_ball_visible"],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );

  assert.throws(
    () => validateTrackingProviderOutput({
      providerMode: "fixture",
      fallbackUsed: true,
      frameCount: 0,
      ballTracks: [],
      playerClusters: [],
      confidence: 0,
      reasonCodes: ["tracking_provider_failed"],
      raw: "/Users/example/token-secret",
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("external tracking provider falls back safely when disabled or failing", async () => {
  const disabled = await new ExternalTrackingProviderAdapter().analyzeTracking({ metadata });
  assert.equal(disabled.fallbackUsed, true);
  assert.equal(disabled.failure.code, "TRACKING_PROVIDER_DISABLED");

  const failed = await new ExternalTrackingProviderAdapter({
    client: {
      analyzeTracking: async () => {
        throw new Error("/Users/example raw provider token");
      },
    },
  }).analyzeTracking({ metadata });
  const publicOutput = publicTrackingProviderOutput(failed, metadata);

  assert.equal(publicOutput.fallbackUsed, true);
  assert.equal(publicOutput.failure.code, "TRACKING_PROVIDER_FAILED");
  assert.doesNotMatch(JSON.stringify(publicOutput), /\/Users|token|secret|raw provider/i);
});

test("external tracking provider timeout and cancellation are safe", async () => {
  const timedOut = await new ExternalTrackingProviderAdapter({
    client: {
      analyzeTracking: () => new Promise(() => {}),
    },
  }).analyzeTracking({ metadata, timeoutMs: 250 });

  assert.equal(timedOut.fallbackUsed, true);
  assert.equal(timedOut.failure.code, "TRACKING_PROVIDER_TIMEOUT");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => new ExternalTrackingProviderAdapter({
      client: {
        analyzeTracking: async () => ({}),
      },
    }).analyzeTracking({ metadata, signal: controller.signal }),
    (error) => error.code === "JOB_CANCELLED",
  );
});

test("provider-backed tracking feeds safe crop calibration without goal claims", () => {
  const output = analyzeTracking({ metadata, visualSignals: visualSignals() });
  const tracking = analyzeVisualTracking({ metadata, trackingProviderOutput: output });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(tracking.goalClaimAllowed, false);
  assert.equal(tracking.ballTrackCount > 0, true);
  assert.equal(tracking.playerClusterCount > 0, true);
  assert.equal(cropPlan.mode, "soft_follow");
  assert.equal(cropPlan.fallbackUsed, false);
});
