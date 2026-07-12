const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const {
  UltralyticsBallTrackingAdapter,
} = require("../server/adapters/ultralytics-ball-tracking-adapter.cjs");
const {
  publicTrackingProviderOutput,
} = require("../server/tracking-provider.cjs");

function baseTrackingOutput() {
  return {
    providerMode: "ffmpeg-football-tracking",
    fallbackUsed: false,
    frameCount: 3,
    ballTracks: [{
      timestamp: 1,
      label: "ball",
      confidence: 0.8,
      bounds: { x: 800, y: 500, width: 20, height: 20 },
    }],
    playerClusters: [{
      timestamp: 1,
      label: "player_cluster",
      confidence: 0.8,
      bounds: { x: 700, y: 300, width: 300, height: 500 },
    }],
    samples: [{
      time: 4,
      playerClusterBox: { x: 700, y: 300, width: 300, height: 500 },
      playerClusterConfidence: 0.8,
      actionCenter: { x: 850, y: 550 },
      cameraMotion: 0.2,
      source: "celebration_group_fallback",
      phase: "scorer_follow",
      reasonCodes: ["tracking_celebration_head_fallback"],
    }],
    actionBounds: { x: 650, y: 250, width: 400, height: 600 },
    actionCenter: { x: 850, y: 550 },
    cameraMotionLevel: 0.2,
    confidence: 0.82,
    reasonCodes: ["tracking_action_bounds"],
    failure: null,
    goalClaimAllowed: false,
  };
}

function denseSample(frameIndex, time) {
  return {
    time,
    frameIndex,
    ballBox: { x: 800 + frameIndex * 4, y: 500, width: 20, height: 20 },
    ballConfidence: 0.88,
    actionCenter: { x: 810 + frameIndex * 4, y: 510 },
    cameraMotion: 0.1,
    source: "ball_detection",
    phase: "ball_follow",
    reasonCodes: ["tracking_ball_visible"],
  };
}

function fixture() {
  mkdirSync(resolve(process.cwd(), "var", "runtimes"), { recursive: true });
  const runtimeDir = mkdtempSync(resolve(process.cwd(), "var", "runtimes", "dense-adapter-test-"));
  const stagingDir = mkdtempSync(join(CONFIG.stagingDir, "dense-adapter-test-"));
  const pythonBin = join(runtimeDir, "python");
  const modelPath = join(runtimeDir, "football.pt");
  const inputPath = join(stagingDir, "source.mp4");
  for (const path of [pythonBin, modelPath, inputPath]) writeFileSync(path, "fixture");
  return {
    runtimeDir,
    stagingDir,
    pythonBin,
    modelPath,
    inputPath,
    cleanup() {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(stagingDir, { recursive: true, force: true });
    },
  };
}

test("dense football adapter requires every effective BALL_FOLLOW frame and preserves scorer samples", async () => {
  const paths = fixture();
  try {
    const dense = {
      ok: true,
      sourceFrameRate: 25,
      inspectedFrameCount: 3,
      containedFrameCount: 3,
      perFrameBallContainmentPassed: true,
      goals: [{
        goalNumber: 1,
        sourceStart: 1,
        finishTime: 1.08,
        requestedFinishTime: 2.5,
        recommendedVisibleFinishTime: 1.08,
        targetSwitchRecommended: true,
        terminalBallLossFrameCount: 35,
        originalExpectedFrameCount: 39,
        expectedFrameCount: 3,
        inspectedFrameCount: 3,
        containedFrameCount: 3,
        missingFrameCount: 0,
        missingFrameIndexes: [],
        maxMissingFrameRun: 0,
        detectorFrameCount: 3,
        trackerFrameCount: 0,
        passed: true,
      }],
      samples: [denseSample(0, 1), denseSample(1, 1.04), denseSample(2, 1.08)],
    };
    const adapter = new UltralyticsBallTrackingAdapter({
      pythonBin: paths.pythonBin,
      modelPath: paths.modelPath,
      baseProvider: { analyzeTracking: async () => baseTrackingOutput() },
      commandRunner: async () => JSON.stringify(dense),
    });
    const output = await adapter.analyzeTracking({
      inputPath: paths.inputPath,
      metadata: { width: 1920, height: 1080, durationSeconds: 10 },
      segments: [{ goalNumber: 1, sourceStart: 1, finishTime: 2.5 }],
    });
    const safe = publicTrackingProviderOutput(output, {
      width: 1920,
      height: 1080,
      durationSeconds: 10,
    });

    assert.equal(safe.providerMode, "ultralytics-dense-ball-tracking");
    assert.equal(safe.perFrameBallContainmentPassed, true);
    assert.equal(safe.perGoalBallContainment[0].recommendedVisibleFinishTime, 1.08);
    assert.equal(safe.perGoalBallContainment[0].targetSwitchRecommended, true);
    assert.equal(safe.samples.filter((sample) => sample.phase === "ball_follow").length, 3);
    assert.equal(safe.samples.filter((sample) => sample.phase === "scorer_follow").length, 1);
  } finally {
    paths.cleanup();
  }
});

test("dense football adapter fails closed when even one effective frame is missing", async () => {
  const paths = fixture();
  try {
    const adapter = new UltralyticsBallTrackingAdapter({
      pythonBin: paths.pythonBin,
      modelPath: paths.modelPath,
      baseProvider: { analyzeTracking: async () => baseTrackingOutput() },
      commandRunner: async () => JSON.stringify({
        ok: true,
        sourceFrameRate: 25,
        inspectedFrameCount: 3,
        containedFrameCount: 2,
        perFrameBallContainmentPassed: false,
        goals: [{
          goalNumber: 1,
          sourceStart: 1,
          finishTime: 1.08,
          expectedFrameCount: 3,
          inspectedFrameCount: 3,
          containedFrameCount: 2,
          missingFrameCount: 1,
          missingFrameIndexes: [26],
          maxMissingFrameRun: 1,
          detectorFrameCount: 2,
          trackerFrameCount: 0,
          passed: false,
        }],
        samples: [denseSample(0, 1), denseSample(2, 1.08)],
      }),
    });
    const output = await adapter.analyzeTracking({
      inputPath: paths.inputPath,
      metadata: { width: 1920, height: 1080, durationSeconds: 10 },
      segments: [{ goalNumber: 1, sourceStart: 1, finishTime: 2.5 }],
    });

    assert.equal(output.perFrameBallContainmentPassed, false);
    assert.equal(output.failure.code, "DENSE_BALL_CONTAINMENT_INCOMPLETE");
    assert.equal(output.samples.some((sample) => sample.phase === "ball_follow"), false);
    assert.doesNotMatch(JSON.stringify(output), /\/Users\/|token|stderr|stdout/i);
  } finally {
    paths.cleanup();
  }
});
