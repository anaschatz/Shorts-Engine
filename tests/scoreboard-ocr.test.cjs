const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeScoreboardOcr,
  createScoreboardOcrProvider,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  normalizeRegion,
  publicScoreboardOcr,
  scoreboardOcrHealth,
  selectOcrFrames,
  validateScoreboardOcrOutput,
} = require("../server/scoreboard-ocr.cjs");

const metadata = { durationSeconds: 120, width: 1920, height: 1080 };

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

test("scoreboard OCR health is safe and explicit about fallback mode", () => {
  const health = scoreboardOcrHealth();
  assert.equal(health.ready, true);
  assert.equal(health.status, "degraded");
  assert.equal(health.realOcrEnabled, false);
  assert.equal(createScoreboardOcrProvider().health().networkRequired, false);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|token|secret|storageKey/i);
});
