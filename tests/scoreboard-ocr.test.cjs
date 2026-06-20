const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  analyzeScoreboardOcr,
  createScoreboardOcrProvider,
  cropScoreboardRegion,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  LocalScoreboardOcrProviderAdapter,
  normalizeRegion,
  publicScoreboardOcr,
  scoreboardOcrHealth,
  selectOcrFrames,
  validateScoreboardOcrOutput,
} = require("../server/scoreboard-ocr.cjs");
const {
  buildScoreboardEvidenceFromObservations,
  parseClock,
  parseScoreboardScore,
} = require("../server/adapters/local-ocr-adapter.cjs");
const { CONFIG } = require("../server/config.cjs");
const { safeResolve } = require("../server/storage.cjs");

const metadata = { durationSeconds: 120, width: 1920, height: 1080 };

function createFrameFixtures() {
  const dir = join(CONFIG.stagingDir, `scoreboard-ocr-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const frames = [10, 24, 38].map((timestamp, index) => {
    const localPath = safeResolve(dir, `frame_${index + 1}.jpg`);
    writeFileSync(localPath, "fake-frame", "utf8");
    return {
      id: `frame_${index + 1}`,
      timestamp,
      windowStart: timestamp - 1,
      windowEnd: timestamp + 1,
      width: 640,
      height: 360,
      localPath,
    };
  });
  return { dir, frames };
}

test("scoreboard OCR normalizes safe scoreboard regions and bounds crop size", () => {
  const region = normalizeRegion({ x: 0.02, y: 0.02, width: 0.3, height: 0.12, anchor: "top_left" }, metadata);
  assert.deepEqual(region, {
    id: "scoreboard_region",
    x: 38,
    y: 22,
    width: 576,
    height: 130,
    anchor: "top_left",
  });
  assert.equal(defaultScoreboardRegions(metadata).length, 3);
  assert.throws(
    () => normalizeRegion({ x: 0, y: 0, width: 1920, height: 1080 }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
  assert.throws(
    () => normalizeRegion({ x: 1900, y: 20, width: 200, height: 80 }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("scoreboard OCR rejects unsafe path-like region and provider output values", () => {
  assert.throws(
    () => normalizeRegion({ x: 0, y: 0, width: 200, height: 80, localPath: "/Users/example/frame.jpg" }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
  assert.throws(
    () => validateScoreboardOcrOutput({
      providerMode: "external",
      evidence: [{
        timestamp: 10,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        status: "score_changed",
        temporalConsistency: true,
        confidence: 0.9,
        rawOcr: "GOAL /Users/example",
      }],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("deterministic scoreboard OCR uses fixture hints and returns safe public output", () => {
  const result = deterministicScoreboardOcr({
    metadata,
    scoreboardOcr: [{
      timestamp: 44,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.91,
    }],
  });

  assert.equal(result.providerMode, "deterministic-scoreboard-ocr");
  assert.equal(result.summary.evidenceCount, 1);
  assert.equal(result.summary.scoreChangeCount, 1);
  assert.equal(result.evidence[0].scoreChanged, true);
  assert.doesNotMatch(JSON.stringify(publicScoreboardOcr(result)), /\/Users|storageKey|localPath|token|secret|rawOcr|rawText/i);
});

test("deterministic scoreboard OCR can return an empty safe fallback", () => {
  const result = deterministicScoreboardOcr({
    metadata,
    frames: [{ id: "frame_1", timestamp: 20, width: 640, height: 360, visualHints: ["scoreboard_context"] }],
  });

  assert.equal(result.summary.evidenceCount, 0);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.summary.sampledFrameCount, 1);
});

test("local OCR parsing extracts scores clocks and transitions safely", () => {
  assert.deepEqual(parseScoreboardScore("ARS 0-0 CHE 23:11"), { home: 0, away: 0, text: "0-0" });
  assert.equal(parseClock("12:34 first half"), "12:34");
  const evidence = buildScoreboardEvidenceFromObservations([
    { timestamp: 10, text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 24, text: "HOME 1-0 AWAY", confidence: 0.8 },
    { timestamp: 38, text: "HOME 1-0 AWAY", confidence: 0.8 },
  ]);
  assert.equal(evidence[0].status, "ambiguous");
  assert.equal(evidence[1].status, "score_changed");
  assert.equal(evidence[1].scoreBefore, "0-0");
  assert.equal(evidence[1].scoreAfter, "1-0");
  assert.equal(evidence[2].status, "score_unchanged");

  const clockOnly = buildScoreboardEvidenceFromObservations([
    { timestamp: 12, text: "12:44", confidence: 0.8 },
  ]);
  assert.equal(clockOnly[0].status, "clock_only");

  const impossibleJump = buildScoreboardEvidenceFromObservations([
    { timestamp: 10, text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 24, text: "HOME 3-0 AWAY", confidence: 0.8 },
  ]);
  assert.equal(impossibleJump[1].status, "ambiguous");
  assert.equal(impossibleJump[1].temporalConsistency, false);

  const revertedGoal = buildScoreboardEvidenceFromObservations([
    { timestamp: 10, text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 24, text: "HOME 1-0 AWAY", confidence: 0.8 },
    { timestamp: 38, text: "HOME 0-0 AWAY", confidence: 0.8 },
  ]);
  assert.equal(revertedGoal[1].status, "score_changed");
  assert.equal(revertedGoal[2].status, "goal_removed");
  assert.equal(revertedGoal[2].scoreBefore, "1-0");
  assert.equal(revertedGoal[2].scoreAfter, "0-0");
});

test("local scoreboard OCR falls back when disabled or binary is unavailable", async () => {
  const disabled = await analyzeScoreboardOcr({
    metadata,
    mode: "local",
    enabled: false,
    scoreboardOcr: [{
      timestamp: 50,
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.88,
    }],
  });
  assert.equal(disabled.providerMode, "deterministic-scoreboard-ocr");
  assert.equal(disabled.fallbackUsed, true);
  assert.equal(disabled.summary.scoreChangeCount, 1);

  const missing = await analyzeScoreboardOcr({
    metadata,
    mode: "local",
    enabled: true,
    commandChecker: () => false,
  });
  assert.equal(missing.providerMode, "deterministic-scoreboard-ocr");
  assert.equal(missing.fallbackUsed, true);
});

test("local scoreboard OCR reads cropped frame text into score-change evidence", async () => {
  const { dir, frames } = createFrameFixtures();
  let calls = 0;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      commandChecker: () => true,
      frames,
      cropper: async ({ outputDir, frameIndex, region }) => safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`),
      ocrRunner: async () => {
        const text = calls < 3 ? "HOME 0-0 AWAY 10:00" : calls < 6 ? "HOME 1-0 AWAY 24:00" : "HOME 1-0 AWAY 38:00";
        calls += 1;
        return { stdout: text };
      },
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreUnchangedCount >= 1, true);
    assert.equal(result.summary.sampledFrameCount, 3);
    assert.doesNotMatch(JSON.stringify(publicScoreboardOcr(result)), /\/Users|storageKey|localPath|token|secret|stdout|stderr|raw/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local scoreboard OCR treats unsafe stdout as unreadable without leaking it", async () => {
  const { dir, frames } = createFrameFixtures();
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      commandChecker: () => true,
      frames: frames.slice(0, 1),
      cropper: async ({ outputDir, frameIndex, region }) => safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`),
      ocrRunner: async () => ({ stdout: "/Users/private token=secret 1-0" }),
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 0);
    assert.equal(result.summary.unreadableCount >= 1, true);
    assert.doesNotMatch(JSON.stringify(publicScoreboardOcr(result)), /\/Users|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoreboard OCR selects frames near visual decision and ball-in-net windows", () => {
  const frames = [
    { id: "f1", timestamp: 8, width: 640, height: 360 },
    { id: "f2", timestamp: 35, width: 640, height: 360, scoreboardHint: { timestamp: 35, status: "ambiguous", confidence: 0.4 } },
    { id: "f3", timestamp: 80, width: 640, height: 360 },
  ];
  const selected = selectOcrFrames({
    metadata,
    frames,
    visualSignals: {
      windows: [{ start: 34, end: 36, types: ["ball_in_net"], confidence: 0.9 }],
    },
  });

  assert.equal(selected.some((frame) => frame.id === "f2"), true);
});

test("external scoreboard OCR provider falls back safely on provider failure", async () => {
  const result = await analyzeScoreboardOcr({
    metadata,
    mode: "external",
    client: {
      analyzeScoreboardOcr: async () => {
        throw new Error("provider blew up /Users/example");
      },
    },
    scoreboardOcr: [{
      timestamp: 50,
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.88,
    }],
  });

  assert.equal(result.providerMode, "deterministic-scoreboard-ocr");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.summary.scoreChangeCount, 1);
});

test("scoreboard OCR timeout falls back and cancellation is safe", async () => {
  const timedOut = await analyzeScoreboardOcr({
    metadata,
    mode: "external",
    timeoutMs: 5,
    client: { analyzeScoreboardOcr: () => new Promise(() => {}) },
  });
  assert.equal(timedOut.providerMode, "deterministic-scoreboard-ocr");
  assert.equal(timedOut.fallbackUsed, true);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    analyzeScoreboardOcr({
      metadata,
      mode: "external",
      signal: controller.signal,
      client: { analyzeScoreboardOcr: () => new Promise(() => {}) },
    }),
    (error) => error.code === "JOB_CANCELLED",
  );
});

test("local scoreboard OCR timeout falls back and cancellation is safe", async () => {
  const { dir, frames } = createFrameFixtures();
  try {
    const timedOut = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      commandChecker: () => true,
      frames: frames.slice(0, 1),
      timeoutMs: 5,
      cropper: async ({ outputDir, frameIndex, region }) => safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`),
      ocrRunner: () => new Promise(() => {}),
    });
    assert.equal(timedOut.providerMode, "deterministic-scoreboard-ocr");
    assert.equal(timedOut.fallbackUsed, true);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      analyzeScoreboardOcr({
        metadata,
        mode: "local",
        enabled: true,
        commandChecker: () => true,
        signal: controller.signal,
        frames: frames.slice(0, 1),
        cropper: async ({ outputDir, frameIndex, region }) => safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`),
        ocrRunner: async () => ({ stdout: "0-0" }),
      }),
      (error) => error.code === "JOB_CANCELLED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoreboard OCR health is safe and explicit about fallback mode", () => {
  const health = scoreboardOcrHealth();
  assert.equal(health.ready, true);
  assert.equal(health.status, "degraded");
  assert.equal(health.realOcrEnabled, false);
  assert.equal(createScoreboardOcrProvider().health().networkRequired, false);
  const local = new LocalScoreboardOcrProviderAdapter({ enabled: true, commandChecker: () => true }).health();
  assert.equal(local.localOcrEnabled, true);
  assert.equal(local.runtimeAvailable, true);
  assert.equal(local.networkRequired, false);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|token|secret|storageKey/i);
});

test("scoreboard OCR crop helper only writes inside staging paths", async () => {
  const { dir, frames } = createFrameFixtures();
  try {
    const outputDir = safeResolve(CONFIG.stagingDir, `ocr_${Date.now()}_crop_test`);
    const region = defaultScoreboardRegions({ width: 640, height: 360 })[0];
    const cropPath = await cropScoreboardRegion({
      frame: frames[0],
      region,
      outputDir,
      ffmpegRunner: async (args) => {
        writeFileSync(args[args.length - 1], "crop", "utf8");
      },
    });
    assert.match(cropPath, /ocr_.*crop_test/);
    assert.doesNotMatch(cropPath, /\.\./);
    rmSync(outputDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
