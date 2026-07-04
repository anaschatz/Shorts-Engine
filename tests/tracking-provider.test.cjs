const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ExternalTrackingProviderAdapter,
  MockTrackingProvider,
  analyzeTracking,
  createTrackingProvider,
  publicTrackingProviderOutput,
  trackingProviderHealth,
  validateTrackingProviderOutput,
} = require("../server/tracking-provider.cjs");
const {
  OpenCvTrackingAdapter,
  analyzeWithOpenCvTracking,
  detectOpenCvRuntime,
} = require("../server/adapters/opencv-tracking-adapter.cjs");
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

test("opencv tracking adapter stays optional and falls back when disabled or missing", async () => {
  const disabled = await analyzeWithOpenCvTracking({
    enabled: false,
    metadata,
    frames: [{ timestamp: 5, width: 640, height: 360 }],
  });
  assert.equal(disabled.fallbackUsed, true);
  assert.equal(disabled.failure.code, "OPENCV_TRACKING_DISABLED");

  const health = detectOpenCvRuntime({
    enabled: true,
    commandRunnerSync: () => ({ status: 1, errorCode: "ENOENT" }),
  });
  assert.equal(health.ready, false);
  assert.equal(health.failure.code, "OPENCV_RUNTIME_MISSING");
  assert.doesNotMatch(JSON.stringify(health), /\/Users|stderr|stdout|token|secret/i);

  const missing = await new OpenCvTrackingAdapter({
    enabled: true,
    commandRunnerSync: () => ({ status: 1, errorCode: "ENOENT" }),
  }).analyzeTracking({ metadata, frames: [] });
  assert.equal(missing.fallbackUsed, true);
  assert.equal(missing.failure.code, "OPENCV_RUNTIME_MISSING");
});

test("opencv tracking adapter validates injected runtime output", async () => {
  const adapter = new OpenCvTrackingAdapter({
    enabled: true,
    client: {
      analyzeTracking: async () => ({
        fallbackUsed: false,
        frameCount: 2,
        ballTracks: [{ timestamp: 5.2, label: "ball", confidence: 0.88, bounds: { x: 840, y: 420, width: 34, height: 34 } }],
        playerClusters: [{ timestamp: 5.2, label: "player_cluster", confidence: 0.82, bounds: { x: 760, y: 300, width: 360, height: 360 } }],
        actionBounds: { x: 740, y: 280, width: 420, height: 420 },
        actionCenter: { x: 950, y: 490 },
        cameraMotionLevel: 0.1,
        confidence: 0.9,
        reasonCodes: ["tracking_ball_visible", "tracking_player_cluster", "tracking_action_bounds"],
      }),
    },
  });
  const output = await adapter.analyzeTracking({ metadata, frames: [{ timestamp: 5.2, width: 640, height: 360 }] });
  const tracking = analyzeVisualTracking({ metadata, trackingProviderOutput: output });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });

  assert.equal(output.providerMode, "opencv-object-tracking");
  assert.equal(output.goalClaimAllowed, false);
  assert.equal(cropPlan.mode, "soft_follow");
});

test("opencv tracking adapter rejects invalid output and timeouts safely", async () => {
  const invalid = await new OpenCvTrackingAdapter({
    enabled: true,
    client: {
      analyzeTracking: async () => ({
        fallbackUsed: false,
        frameCount: 1,
        ballTracks: [{ timestamp: 5, label: "goal_claim", confidence: 1, bounds: { x: 1, y: 1, width: 10, height: 10 } }],
        playerClusters: [],
        confidence: 1,
        reasonCodes: ["goal_claim"],
      }),
    },
  }).analyzeTracking({ metadata, frames: [{ timestamp: 5, width: 640, height: 360 }] });
  assert.equal(invalid.fallbackUsed, true);
  assert.equal(invalid.failure.code, "AI_OUTPUT_INVALID");

  const timedOut = await new OpenCvTrackingAdapter({
    enabled: true,
    commandRunnerSync: () => ({ status: 0 }),
    commandRunner: () => {
      const error = new Error("timeout");
      error.killed = true;
      return Promise.reject(error);
    },
  }).analyzeTracking({
    metadata,
    frames: [{ timestamp: 5, width: 640, height: 360, localPath: "unsafe" }],
  });
  assert.equal(timedOut.fallbackUsed, true);
  assert.ok(["OPENCV_OUTPUT_INVALID", "OPENCV_TRACKING_TIMEOUT"].includes(timedOut.failure.code));
});

test("tracking provider factory exposes opencv health without changing default", () => {
  assert.equal(createTrackingProvider().health().mode, "safe-tracking-provider");
  const provider = createTrackingProvider({
    mode: "opencv",
    client: {
      analyzeTracking: async () => ({
        fallbackUsed: true,
        frameCount: 0,
        ballTracks: [],
        playerClusters: [],
        confidence: 0,
        reasonCodes: ["tracking_action_uncertain"],
      }),
    },
  });
  assert.equal(provider.health().mode, "opencv-object-tracking");
  const health = trackingProviderHealth({ mode: "mock" });
  assert.equal(health.mode, "mock-tracking-provider");
  assert.equal(health.goalClaimAllowed, false);
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
