const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  analyzeScoreboardOcr,
  createScoreboardOcrProvider,
  cropScoreOnlyRegion,
  cropScoreboardRegion,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  extractOcrFramesFromSource,
  LocalScoreboardOcrProviderAdapter,
  normalizeRegion,
  publicScoreboardOcr,
  scorebugFirstPreprocessVariants,
  scoreboardOcrHealth,
  scoreboardOcrPreprocessVariants,
  selectScorebugLayoutProfile,
  selectOcrFrames,
  selectOcrSamplingWindows,
  validateScoreboardOcrOutput,
  SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH,
  SCOREBOARD_OCR_QA_RELATIVE_DIR,
} = require("../server/scoreboard-ocr.cjs");
const {
  buildScoreboardEvidenceFromObservations,
  buildScoreboardTimelineFromObservations,
  parseClock,
  parseScoreboardScore,
  parseScoreOnlyScore,
  scoreAllowedForRegion,
} = require("../server/adapters/local-ocr-adapter.cjs");
const {
  buildStableScoreTimeline,
  readScoreboardCandidate,
} = require("../server/scoreboard-reader.cjs");
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

const SCOREBUG_SEGMENTS = Object.freeze({
  0: "abcdef",
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgecd",
  7: "abc",
  8: "abcdefg",
  9: "abfgcd",
});

const SCOREBUG_ZONES = Object.freeze({
  a: { x0: 0.22, x1: 0.78, y0: 0.04, y1: 0.18 },
  b: { x0: 0.68, x1: 0.88, y0: 0.14, y1: 0.46 },
  c: { x0: 0.68, x1: 0.88, y0: 0.54, y1: 0.86 },
  d: { x0: 0.22, x1: 0.78, y0: 0.82, y1: 0.96 },
  e: { x0: 0.12, x1: 0.32, y0: 0.54, y1: 0.86 },
  f: { x0: 0.12, x1: 0.32, y0: 0.14, y1: 0.46 },
  g: { x0: 0.22, x1: 0.78, y0: 0.43, y1: 0.57 },
});

function drawScorebugDigit(pixels, width, height, digit, roi) {
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
        pixels[y * width + x] = 0;
      }
    }
  };
  for (const segment of SCOREBUG_SEGMENTS[digit]) {
    const zone = SCOREBUG_ZONES[segment];
    fill(
      Math.floor(roi.x + zone.x0 * roi.width),
      Math.floor(roi.y + zone.y0 * roi.height),
      Math.ceil(roi.x + zone.x1 * roi.width),
      Math.ceil(roi.y + zone.y1 * roi.height),
    );
  }
}

function writeScorebugCrop(filePath, { home, away }) {
  const width = 120;
  const height = 52;
  const pixels = Array.from({ length: width * height }, () => 255);
  drawScorebugDigit(pixels, width, height, home, { x: 43, y: 8, width: 18, height: 36 });
  drawScorebugDigit(pixels, width, height, away, { x: 67, y: 8, width: 18, height: 36 });
  writeFileSync(filePath, `P2\n${width} ${height}\n255\n${pixels.join(" ")}\n`, "utf8");
}

function writeNoisyBroadcastScorebugCrop(filePath, { home, away }) {
  const width = 512;
  const height = 96;
  const pixels = Array.from({ length: width * height }, () => 255);
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
        pixels[y * width + x] = 0;
      }
    }
  };
  fill(12, 8, 96, 28);
  fill(146, 34, 194, 46);
  fill(250, 6, 278, 88);
  fill(322, 18, 430, 38);
  fill(454, 52, 496, 72);
  drawScorebugDigit(pixels, width, height, home, { x: 212, y: 18, width: 38, height: 58 });
  drawScorebugDigit(pixels, width, height, away, { x: 279, y: 18, width: 28, height: 58 });
  writeFileSync(filePath, `P2\n${width} ${height}\n255\n${pixels.join(" ")}\n`, "utf8");
}

function writeFakeScorebugPng(filePath) {
  writeFileSync(filePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
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
  const regions = defaultScoreboardRegions(metadata);
  assert.equal(regions.length, 6);
  assert.equal(regions[0].id, "scorebug_broadcast_compact");
  assert.equal(regions.some((item) => item.id === "broadcast_top_band"), true);
  assert.throws(
    () => normalizeRegion({ x: 0, y: 0, width: 1920, height: 1080 }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
  assert.throws(
    () => normalizeRegion({ x: 1900, y: 20, width: 200, height: 80 }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("local scoreboard OCR scorebug-first mode bounds ROI search and preprocessing variants", async () => {
  const { dir, frames } = createFrameFixtures();
  const cropAttempts = [];
  const ocrCalls = [];
  const adapter = new LocalScoreboardOcrProviderAdapter({
    enabled: true,
    ocrAdapter: {
      health: () => ({
        status: "ready",
        providerMode: "mock-local-ocr",
        runtimeAvailable: true,
        commandConfigured: true,
      }),
      runtimeAvailable: () => true,
      readTextFromImage: async ({ imagePath, psm }) => {
        ocrCalls.push({ imagePath, psm });
        return psm === "10"
          ? { text: "", confidence: 0.05, rejected: true }
          : { text: "23:11", confidence: 0.66, rejected: false };
      },
    },
    cropper: async ({ outputDir, frameIndex, region, variant }) => {
      cropAttempts.push({ regionId: region.id, variantId: variant.id, frameIndex });
      mkdirSync(outputDir, { recursive: true });
      const cropPath = safeResolve(outputDir, `mock_${frameIndex}_${region.id}_${variant.id}.png`);
      writeFileSync(cropPath, "fake-crop", "utf8");
      return cropPath;
    },
    ffmpegRunner: async (args) => {
      const outputPath = args[args.length - 1];
      writeFileSync(outputPath, "fake-derived-crop", "utf8");
    },
    digitReader: async () => ({
      status: "unreadable",
      confidence: 0,
      reasons: ["mock_digit_reader_unreadable"],
    }),
  });

  try {
    const result = await adapter.analyzeScoreboardOcr({
      metadata,
      frames,
      scorebugFirstOnly: true,
      timeoutMs: 900,
    });
    const regionIds = new Set(cropAttempts.map((attempt) => attempt.regionId));
    const variantIds = new Set(cropAttempts.map((attempt) => attempt.variantId));

    assert.equal(variantIds.size > 0, true);
    assert.equal(variantIds.size <= scorebugFirstPreprocessVariants().length, true);
    assert.equal(cropAttempts.length > 0, true);
    assert.equal(regionIds.has("scorebug_broadcast_compact"), true);
    assert.equal([...regionIds].every((regionId) => [
      "scorebug_broadcast_compact",
      "scorebug_left_compact",
      "scoreboard_top_left",
      "scoreboard_top_center",
      "scoreboard_top_right",
    ].includes(regionId)), true);
    assert.equal(regionIds.has("broadcast_top_band"), false);
    assert.equal(cropAttempts.length <= frames.length * 5 * scorebugFirstPreprocessVariants().length, true);
    assert.equal(ocrCalls.length > 0, true);
    assert.doesNotMatch(JSON.stringify(publicScoreboardOcr(result)), /\/Users|storageKey|localPath|token|secret|rawOcr|rawText|stderr|stdout/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(parseScoreboardScore("HOME O - I AWAY"), { home: 0, away: 1, text: "0-1" });
  assert.deepEqual(parseScoreboardScore("HOME 1:0 AWAY"), { home: 1, away: 0, text: "1-0" });
  assert.deepEqual(parseScoreboardScore("36:09 ARG 1 0 ALG"), { home: 1, away: 0, text: "1-0" });
  assert.deepEqual(parseScoreboardScore("36: 09 ARG 1 FIFA 0 ALG2"), { home: 1, away: 0, text: "1-0" });
  assert.equal(parseScoreboardScore("16:38 ARG 0 O68 ALG"), null);
  assert.equal(parseScoreboardScore("GET:32: ALGO"), null);
  assert.equal(parseScoreboardScore("Y A P W29 : AS 8 M S A I OZ 5 73"), null);
  assert.equal(parseScoreboardScore("P A 333 LS PY BARG O 7 DP A L OQ"), null);
  assert.equal(parseScoreboardScore("SF 4 SY KS 24 04:40 ALG3 X TG W MAT H"), null);
  assert.equal(parseScoreboardScore("C : O Y AS TH AOUA 5 V 7 ARG YT 5 A 7 W"), null);
  assert.equal(parseScoreboardScore("BF SOP P 4 J A WJ A Y A AY 44 TS"), null);
  assert.equal(parseScoreboardScore("23:11 first half"), null);
  assert.equal(parseScoreboardScore("HOME 0-0 AWAY 1-0 replay"), null);
  assert.deepEqual(parseScoreOnlyScore("1 0"), { home: 1, away: 0, text: "1-0" });
  assert.deepEqual(parseScoreOnlyScore("O-I"), { home: 0, away: 1, text: "0-1" });
  assert.equal(parseScoreOnlyScore("45:00"), null);
  assert.equal(parseScoreOnlyScore("ARG 1 ALG 0"), null);
  assert.equal(parseScoreOnlyScore("1 0 44"), null);
  assert.equal(scoreAllowedForRegion({
    regionId: "scoreboard_top_left",
    text: "7 L N2 2 7 ARG ALG F 7 1 2A",
    score: parseScoreboardScore("7 L N2 2 7 ARG ALG F 7 1 2A"),
  }), null);
  assert.deepEqual(scoreAllowedForRegion({
    regionId: "scorebug_broadcast_compact",
    text: "ARG 1 0 ALG",
    score: parseScoreboardScore("ARG 1 0 ALG"),
  }), { home: 1, away: 0, text: "1-0" });
  assert.equal(parseClock("12:34 first half"), "12:34");
  const evidence = buildScoreboardEvidenceFromObservations([
    { timestamp: 10, text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 24, text: "HOME 1-0 AWAY", confidence: 0.8 },
    { timestamp: 38, text: "HOME 1-0 AWAY", confidence: 0.8 },
  ]);
  assert.equal(evidence[0].status, "ambiguous");
  assert.equal(evidence[1].status, "ambiguous");
  assert.equal(evidence[1].ambiguityReasons.includes("score_change_needs_confirmation"), true);
  assert.equal(evidence[2].status, "score_changed");
  assert.equal(evidence[2].scoreBefore, "0-0");
  assert.equal(evidence[2].scoreAfter, "1-0");

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
    { timestamp: 44, text: "HOME 0-0 AWAY", confidence: 0.8 },
  ]);
  assert.equal(revertedGoal[1].status, "ambiguous");
  assert.equal(revertedGoal[2].status, "score_unchanged");
  assert.equal(revertedGoal[3].status, "score_unchanged");
});

test("scoreboard OCR calibrates the best ROI timeline instead of mixing noisy regions", () => {
  const noisyBroadBand = [
    { timestamp: 8, regionId: "broadcast_top_band", text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 22, regionId: "broadcast_top_band", text: "HOME 3-0 AWAY", confidence: 0.86 },
    { timestamp: 36, regionId: "broadcast_top_band", text: "HOME 3-0 AWAY", confidence: 0.86 },
  ];
  const lateScorebug = [
    { timestamp: 100, regionId: "scorebug_broadcast_compact", layoutId: "broadcast-compact-score-only-v1", score: { home: 0, away: 0 }, confidence: 0.91 },
    { timestamp: 214, regionId: "scorebug_broadcast_compact", layoutId: "broadcast-compact-score-only-v1", score: { home: 1, away: 0 }, confidence: 0.92 },
    { timestamp: 226, regionId: "scorebug_broadcast_compact", layoutId: "broadcast-compact-score-only-v1", score: { home: 1, away: 0 }, confidence: 0.93 },
    { timestamp: 520, regionId: "scorebug_broadcast_compact", layoutId: "broadcast-compact-score-only-v1", score: { home: 2, away: 0 }, confidence: 0.94 },
    { timestamp: 532, regionId: "scorebug_broadcast_compact", layoutId: "broadcast-compact-score-only-v1", score: { home: 2, away: 0 }, confidence: 0.95 },
  ];

  const timeline = buildScoreboardTimelineFromObservations([...noisyBroadBand, ...lateScorebug]);

  assert.equal(timeline.roiCalibration.selectedRoi.regionId, "scorebug_broadcast_compact");
  assert.equal(timeline.roiCalibration.selectedRoi.scoreChangeCount, 2);
  assert.equal(timeline.roiCalibration.selectedRoi.diagnosis, "score_changes_detected");
  assert.equal(timeline.roiCalibration.selectedRoi.reasonCodes.includes("scorebug_region_readable"), true);
  assert.equal(timeline.evidence.filter((item) => item.status === "score_changed").length, 2);
  assert.equal(timeline.evidence.some((item) => item.scoreAfter === "2-0" && item.timestamp >= 532), true);
  assert.equal(timeline.roiCalibration.rejectedRois.some((roi) => roi.regionId === "broadcast_top_band"), true);
  assert.equal(timeline.roiCalibration.rejectedRois.some((roi) =>
    roi.regionId === "broadcast_top_band" &&
    roi.reasonCodes.includes("broad_top_band_demoted")), true);
  assert.equal(timeline.scorebugDebug.state, "score_changes_detected");
  assert.equal(timeline.scorebugDebug.qaRecommended, false);
  assert.equal(timeline.scorebugDebug.attemptedRoiCount, 2);
  assert.equal(timeline.scorebugDebug.selectedRoi.regionId, "scorebug_broadcast_compact");
  assert.equal(timeline.scorebugDebug.rejectedRois.some((roi) => roi.regionId === "broadcast_top_band"), true);
  assert.doesNotMatch(JSON.stringify(timeline.roiCalibration), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
  assert.doesNotMatch(JSON.stringify(timeline.scorebugDebug), /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i);
});

test("scorebug debug distinguishes static and unreadable OCR timelines safely", () => {
  const staticTimeline = buildScoreboardTimelineFromObservations([
    { timestamp: 10, regionId: "scorebug_broadcast_compact", text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 24, regionId: "scorebug_broadcast_compact", text: "HOME 0-0 AWAY", confidence: 0.8 },
    { timestamp: 38, regionId: "scorebug_broadcast_compact", text: "HOME 0-0 AWAY", confidence: 0.8 },
  ]);

  assert.equal(staticTimeline.scorebugDebug.state, "scorebug_static");
  assert.equal(staticTimeline.scorebugDebug.qaRecommended, true);
  assert.equal(staticTimeline.scorebugDebug.selectedRoi.diagnosis, "scorebug_static");
  assert.equal(staticTimeline.scorebugDebug.reasonCodes.includes("static_score_timeline"), true);
  assert.equal(
    staticTimeline.scorebugDebug.nextAction,
    "inspect-sampling-windows-around-goal-times-or-expand-scorebug-temporal-coverage",
  );

  const unreadableTimeline = buildScoreboardTimelineFromObservations([
    { timestamp: 10, regionId: "scorebug_broadcast_compact", text: "45:00 ARG ALG", confidence: 0.8 },
    { timestamp: 24, regionId: "scorebug_broadcast_compact", text: "46:00 ARG ALG", confidence: 0.8 },
  ]);

  assert.equal(unreadableTimeline.scorebugDebug.state, "scorebug_unreadable");
  assert.equal(unreadableTimeline.scorebugDebug.qaRecommended, true);
  assert.equal(unreadableTimeline.scorebugDebug.readableObservationCount, 0);
  assert.equal(unreadableTimeline.scorebugDebug.textPresentObservationCount, 2);
  assert.equal(unreadableTimeline.scorebugDebug.reasonCodes.includes("score_not_readable"), true);
  assert.equal(
    unreadableTimeline.scorebugDebug.nextAction,
    "enable-scoreboard-ocr-qa-artifacts-and-inspect-crops-for-wrong-roi-or-small-scorebug",
  );

  assert.doesNotMatch(
    JSON.stringify({ staticTimeline, unreadableTimeline }),
    /\/Users|\/private|token|secret|rawOcr|rawText|stderr|stdout/i,
  );
});

test("scoreboard reader contract normalizes candidates and requires stable score changes", () => {
  const readable = readScoreboardCandidate({
    timestamp: 12,
    text: "ARG 1 0 ALG",
    score: { home: 1, away: 0 },
    confidence: 0.8,
    regionId: "scorebug_broadcast_compact",
    preprocessingVariant: "gray_line",
  });
  assert.equal(readable.status, "readable");
  assert.equal(readable.homeScore, 1);
  assert.equal(readable.awayScore, 0);
  assert.equal(readable.scoreText, "1-0");
  assert.doesNotMatch(JSON.stringify(readable), /\/Users|storageKey|token|secret|stdout|stderr/i);

  const timeline = buildStableScoreTimeline([
    { timestamp: 5, text: "HOME 0-0 AWAY", score: { home: 0, away: 0 }, confidence: 0.8 },
    { timestamp: 20, text: "HOME 1-0 AWAY", score: { home: 1, away: 0 }, confidence: 0.8 },
    { timestamp: 26, text: "HOME 1-0 AWAY", score: { home: 1, away: 0 }, confidence: 0.8 },
    { timestamp: 34, text: "HOME 0-0 AWAY", score: { home: 0, away: 0 }, confidence: 0.8 },
    { timestamp: 38, text: "HOME 0-0 AWAY", score: { home: 0, away: 0 }, confidence: 0.8 },
    { timestamp: 42, text: "HOME 3-0 AWAY", score: { home: 3, away: 0 }, confidence: 0.8 },
  ]);
  assert.equal(timeline[0].status, "ambiguous");
  assert.equal(timeline[1].status, "ambiguous");
  assert.equal(timeline[1].ambiguityReasons.includes("score_change_needs_confirmation"), true);
  assert.equal(timeline[1].transitionDecision, "score_change_pending_confirmation");
  assert.equal(timeline[2].status, "score_changed");
  assert.equal(timeline[2].scoreBefore, "0-0");
  assert.equal(timeline[2].scoreAfter, "1-0");
  assert.equal(timeline[2].transitionDecision, "score_changed");
  assert.equal(timeline[3].status, "ambiguous");
  assert.equal(timeline[3].ambiguityReasons.includes("score_change_needs_confirmation"), true);
  assert.equal(timeline[4].status, "goal_removed");
  assert.equal(timeline[4].scoreBefore, "1-0");
  assert.equal(timeline[4].scoreAfter, "0-0");
  assert.equal(timeline[4].transitionDecision, "score_reverted_or_disallowed");
  assert.equal(timeline[5].status, "ambiguous");
  assert.equal(timeline[5].ambiguityReasons.includes("impossible_or_non_unit_score_transition"), true);
  assert.equal(timeline[5].transitionDecision, "rejected_impossible_transition");
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
        const text = calls === 0 ? "HOME 0-0 AWAY 10:00" : "HOME 1-0 AWAY 24:00";
        calls += 1;
        return { stdout: text };
      },
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.ambiguousCount >= 2, true);
    assert.equal(result.summary.sampledFrameCount, 3);
    assert.equal(result.summary.preprocessingVariantCount, 4);
    assert.equal(result.summary.regionIdsUsed.length >= 1, true);
    assert.equal(result.summary.scoreTimeline.some((item) => item.status === "score_changed"), true);
    assert.equal(result.summary.scorebugDebug.state, "score_changes_detected");
    assert.equal(result.summary.scorebugDebug.selectedRoi.scoreChangeCount, 1);
    assert.equal(publicScoreboardOcr(result).summary.scorebugDebug.state, "score_changes_detected");
    assert.doesNotMatch(JSON.stringify(publicScoreboardOcr(result)), /\/Users|storageKey|localPath|token|secret|stdout|stderr|raw/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local scoreboard OCR keeps scanning the primary scorebug region after an earlier frame score", async () => {
  const { dir, frames } = createFrameFixtures();
  const cropCalls = [];
  try {
    await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      commandChecker: () => true,
      frames,
      cropper: async ({ outputDir, frameIndex, region }) => {
        cropCalls.push({ frameIndex, regionId: region.id });
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(cropPath, "fake-crop", "utf8");
        return cropPath;
      },
      ocrRunner: async (_command, args) => {
        const frameMatch = /crop_(\d+)_/.exec(args[0]);
        const frameIndex = frameMatch ? Number(frameMatch[1]) : 0;
        return { stdout: frameIndex === 0 ? "HOME 0-0 AWAY" : "HOME 1-0 AWAY" };
      },
    });

    const primaryFrameIndexes = cropCalls
      .filter((call) => call.regionId === "scorebug_broadcast_compact")
      .map((call) => call.frameIndex);
    assert.deepEqual(primaryFrameIndexes, [0, 1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local scoreboard OCR can use calibrated scorebug digit readings instead of loose OCR text", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-digit-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      digitCalibration: {
        layoutId: "fixture-scorebug",
        minConfidence: 0.78,
        readings: [
          {
            timestamp: 10,
            regionId: "scorebug_broadcast_compact",
            score: { home: 0, away: 0 },
            confidence: 0.92,
            digitBoxes: [
              { role: "home", digit: 0, x: 0.42, y: 0.2, width: 0.08, height: 0.55, confidence: 0.9 },
              { role: "away", digit: 0, x: 0.58, y: 0.2, width: 0.08, height: 0.55, confidence: 0.91 },
            ],
          },
          {
            timestamp: 24,
            regionId: "scorebug_broadcast_compact",
            score: { home: 1, away: 0 },
            confidence: 0.93,
            digitBoxes: [
              { role: "home", digit: 1, x: 0.42, y: 0.2, width: 0.08, height: 0.55, confidence: 0.92 },
              { role: "away", digit: 0, x: 0.58, y: 0.2, width: 0.08, height: 0.55, confidence: 0.9 },
            ],
          },
          {
            timestamp: 38,
            regionId: "scorebug_broadcast_compact",
            score: { home: 1, away: 0 },
            confidence: 0.94,
            digitBoxes: [
              { role: "home", digit: 1, x: 0.42, y: 0.2, width: 0.08, height: 0.55, confidence: 0.92 },
              { role: "away", digit: 0, x: 0.58, y: 0.2, width: 0.08, height: 0.55, confidence: 0.91 },
            ],
          },
        ],
      },
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(cropPath, "fake-crop", "utf8");
        return cropPath;
      },
      ocrRunner: async () => ({ stdout: "24:00" }),
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.roiCalibration.selectedRoi.regionId, "scorebug_broadcast_compact");
    assert.equal(publicScoreboardOcr(result).summary.roiCalibration.selectedRoi.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) => item.status === "score_changed" && item.scoreAfter === "1-0"), true);
    assert.equal(result.summary.regionIdsUsed.includes("scorebug_broadcast_compact"), true);
    assert.equal(result.qaReport.enabled, true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.digitReader.readableCount >= 3, true);
    assert.equal(report.calibrationUsed.layoutId, "fixture-scorebug");
    assert.equal(report.evidenceSummary.roiCalibration.selectedRoi.regionId, "scorebug_broadcast_compact");
    assert.equal(report.evidenceSummary.scoreChangeEvents.length, 1);
    assert.equal(report.ocrAttempts.some((attempt) => attempt.digitReaderStatus === "readable" && attempt.score === "1-0"), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR can derive score-change evidence from focused image segmentation", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-image-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.pgm`);
        mkdirSync(outputDir, { recursive: true });
        writeScorebugCrop(cropPath, frameIndex === 0 ? { home: 0, away: 0 } : { home: 1, away: 0 });
        return cropPath;
      },
      ocrRunner: async () => ({ stdout: "24:00" }),
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) => item.status === "score_changed" && item.scoreAfter === "1-0"), true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.digitReader.imageSegmentationReadableCount >= 3, true);
    assert.equal(report.ocrAttempts.some((attempt) => attempt.imageSegmentationStatus === "readable" && attempt.score === "1-0"), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR reads focused score digits when broadcast crop includes clock and team noise", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-noisy-image-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.pgm`);
        mkdirSync(outputDir, { recursive: true });
        writeNoisyBroadcastScorebugCrop(cropPath, frameIndex === 0 ? { home: 0, away: 0 } : { home: 1, away: 0 });
        return cropPath;
      },
      ocrRunner: async () => ({ stdout: "45:00 ARG ALG" }),
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) => item.status === "score_changed" && item.scoreAfter === "1-0"), true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.digitReader.imageSegmentationReadableCount >= 3, true);
    assert.equal(report.ocrAttempts.some((attempt) =>
      attempt.imageSegmentationStatus === "readable" &&
      attempt.score === "1-0" &&
      attempt.imageSegmentationReasons.includes("focused_digit_roi_used")), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR extracts score-only crops before parsing noisy broadcast OCR", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-score-only-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      ffmpegRunner: async (args) => {
        const inputPath = args[2];
        const outputPath = args[args.length - 1];
        if (/score_only_/.test(outputPath)) {
          writeFakeScorebugPng(outputPath);
          return;
        }
        const frameMatch = /(?:crop|score_only)_(\d+)_/.exec(inputPath);
        const frameIndex = frameMatch ? Number(frameMatch[1]) : 0;
        writeScorebugCrop(outputPath, frameIndex === 0 ? { home: 0, away: 0 } : { home: 1, away: 0 });
      },
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(cropPath, "full broadcast crop with clock/team noise", "utf8");
        return cropPath;
      },
      digitReader: () => ({
        status: "unreadable",
        score: null,
        confidence: 0.1,
        reasons: ["digit_reader_stubbed_unreadable"],
      }),
      ocrRunner: async (_command, args) => {
        const imagePath = args[0];
        if (/score_only_01_/.test(imagePath)) return { stdout: "0 0" };
        if (/score_only_/.test(imagePath)) return { stdout: "1 0" };
        return { stdout: "45:00 ARG ALG" };
      },
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) =>
      item.status === "score_changed" &&
      item.scoreAfter === "1-0" &&
      item.layoutId === "broadcast-compact-score-only-v1" &&
      item.scoreOnlyCropRef), true);
    assert.equal(publicScoreboardOcr(result).summary.scoreTimeline.some((item) => item.scoreOnlyCropRef), true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.scoreOnlyExtraction.cropCount >= 3, true);
    assert.equal(report.scoreOnlyExtraction.readableCount >= 3, true);
    assert.equal(report.evidenceSummary.scoreChangeCount, 1);
    assert.equal(report.ocrAttempts.some((attempt) =>
      attempt.scoreSource === "local_scorebug_score_only_ocr_color_whitelist" &&
      attempt.scoreOnlyScore === "1-0" &&
      attempt.scoreOnlyCropRef &&
      attempt.finalScoreCandidate === "1-0" &&
      attempt.transitionDecision), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR can recover score changes from profile digit OCR crops", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-profile-digit-ocr-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      ffmpegRunner: async (args) => {
        const outputPath = args[args.length - 1];
        writeFakeScorebugPng(outputPath);
      },
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(cropPath, "full broadcast crop with clock/team noise", "utf8");
        return cropPath;
      },
      digitReader: () => ({
        status: "unreadable",
        score: null,
        confidence: 0.1,
        reasons: ["digit_reader_stubbed_unreadable"],
      }),
      ocrRunner: async (_command, args) => {
        const imagePath = args[0];
        if (/score_only_/.test(imagePath)) return { stdout: "ARG ALG" };
        if (/profile_digit_home_01_/.test(imagePath)) return { stdout: "0" };
        if (/profile_digit_away_01_/.test(imagePath)) return { stdout: "0" };
        if (/profile_digit_home_/.test(imagePath)) return { stdout: "1" };
        if (/profile_digit_away_/.test(imagePath)) return { stdout: "0" };
        return { stdout: "45:00 ARG ALG" };
      },
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) =>
      item.status === "score_changed" &&
      item.scoreAfter === "1-0" &&
      item.transitionDecision === "score_changed"), true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.evidenceSummary.scoreChangeCount, 1);
    assert.equal(report.ocrAttempts.some((attempt) => attempt.finalScoreCandidate === "1-0"), true);
    assert.equal(report.digitReader.profileDigitOcrReadableCount >= 3, true);
    assert.equal(report.digitReader.profileDigitCropCount >= 3, true);
    assert.equal(report.ocrAttempts.some((attempt) =>
      attempt.profileDigitOcrStatus === "readable" &&
      attempt.homeDigitCropRef &&
      attempt.awayDigitCropRef &&
      attempt.homeDigitOcrText &&
      attempt.awayDigitOcrText), true);
    assert.equal(report.cropArtifacts.files.some((artifact) => artifact.artifactType === "profile_digit_crop" && artifact.role === "home"), true);
    assert.equal(report.cropArtifacts.files.some((artifact) => artifact.artifactType === "profile_digit_crop" && artifact.role === "away"), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR can process PNG crops before focused image segmentation", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scorebug-png-decoder-test-${Date.now()}`;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      ffmpegRunner: async (args) => {
        const inputPath = args[2];
        const outputPath = args[args.length - 1];
        const frameMatch = /crop_(\d+)_/.exec(inputPath);
        const frameIndex = frameMatch ? Number(frameMatch[1]) : 0;
        writeScorebugCrop(outputPath, frameIndex === 0 ? { home: 0, away: 0 } : { home: 1, away: 0 });
      },
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFakeScorebugPng(cropPath);
        return cropPath;
      },
      ocrRunner: async () => ({ stdout: "24:00" }),
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.summary.scoreChangeCount, 1);
    assert.equal(result.summary.scoreTimeline.some((item) => item.status === "score_changed" && item.scoreAfter === "1-0"), true);
    const report = JSON.parse(readFileSync(join(process.cwd(), result.qaReport.reportPath), "utf8"));
    assert.equal(report.digitReader.imageSegmentationReadableCount >= 3, true);
    assert.equal(report.ocrAttempts.some((attempt) =>
      attempt.imageSegmentationStatus === "readable" &&
      attempt.score === "1-0" &&
      attempt.layoutId), true);
    assert.equal(report.scoreOnlyExtraction.cropCount >= 3, true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("local scoreboard OCR writes opt-in crop QA report with safe relative refs", async () => {
  const { dir, frames } = createFrameFixtures();
  const runId = `scoreboard-qa-test-${Date.now()}`;
  let calls = 0;
  try {
    const result = await analyzeScoreboardOcr({
      metadata,
      mode: "local",
      enabled: true,
      qaArtifactsEnabled: true,
      qaRunId: runId,
      commandChecker: () => true,
      frames,
      cropper: async ({ outputDir, frameIndex, region }) => {
        const cropPath = safeResolve(outputDir, `crop_${frameIndex}_${region.id}.png`);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(cropPath, "fake-crop", "utf8");
        return cropPath;
      },
      ocrRunner: async () => {
        const text = calls === 0 ? "HOME 0-0 AWAY 10:00" : "HOME 1-0 AWAY 24:00";
        calls += 1;
        return { stdout: text };
      },
    });

    assert.equal(result.providerMode, "local-scoreboard-ocr-command");
    assert.equal(result.qaReport.enabled, true);
    assert.equal(result.qaReport.latestPath, SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH);
    assert.match(result.qaReport.reportPath, /^demo\/results\/ocr-scoreboard-qa-/);
    assert.match(result.qaReport.contactSheetPath, new RegExp(`^${SCOREBOARD_OCR_QA_RELATIVE_DIR}/ocr-scoreboard-`));
    assert.match(result.qaReport.reviewPath, new RegExp(`^${SCOREBOARD_OCR_QA_RELATIVE_DIR}/ocr-scoreboard-`));
    assert.equal(result.qaReport.cropCount > 0, true);
    assert.equal(result.qaReport.attemptCount > 0, true);
    assert.equal(result.summary.sampledFrameCount, 3);
    assert.equal(result.summary.preprocessingVariantCount, 4);
    const reportPath = join(process.cwd(), result.qaReport.reportPath);
    const latestPath = join(process.cwd(), result.qaReport.latestPath);
    const contactPath = join(process.cwd(), result.qaReport.contactSheetPath);
    const reviewPath = join(process.cwd(), result.qaReport.reviewPath);
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(latestPath), true);
    assert.equal(existsSync(contactPath), true);
    assert.equal(existsSync(reviewPath), true);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.kind, "scoreboard-ocr-qa-report");
    assert.equal(report.relativeRefsOnly, true);
    assert.equal(report.review.relativePath, result.qaReport.reviewPath);
    assert.equal(report.cropArtifacts.cropCount, result.qaReport.cropCount);
    assert.equal(report.evidenceSummary.scorebugDebug.state, "score_changes_detected");
    assert.equal(report.evidenceSummary.scorebugDebug.selectedRoi.scoreChangeCount, 1);
    assert.equal(report.evidenceSummary.scorebugDebug.qaRecommended, false);
    assert.equal(report.ocrAttempts.some((attempt) => attempt.ocrText), true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
    assert.doesNotMatch(readFileSync(reviewPath, "utf8"), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.cwd(), SCOREBOARD_OCR_QA_RELATIVE_DIR, `ocr-scoreboard-${runId}`), { recursive: true, force: true });
  }
});

test("scoreboard OCR sampling covers full source and late-game windows", () => {
  const windows = selectOcrSamplingWindows({
    metadata: { ...metadata, durationSeconds: 360 },
    mediaSignals: {
      audioPeaks: [{ time: 318, energyScore: 0.92 }],
      sceneChanges: [{ time: 326, confidence: 0.8 }],
    },
    visualSignals: {
      windows: [{ start: 316, end: 320, types: ["shot_contact", "ball_in_net"], confidence: 0.9 }],
    },
  });

  assert.equal(windows.length <= 48, true);
  assert.equal(windows.some((window) => window.source === "full_source_periodic_scoreboard_sample"), true);
  assert.equal(windows.some((window) => window.timestamp > 320), true);
  assert.equal(windows.some((window) => window.source === "visual_decision_scoreboard_sample"), true);
});

test("scoreboard OCR explicit sampling windows bypass full-source periodic sampling", () => {
  const windows = selectOcrSamplingWindows({
    metadata: { ...metadata, durationSeconds: 644 },
    ocrSamplingWindows: [
      { timestamp: 548, start: 546, end: 550, confidence: 0.7, source: "scorebug_chunk_periodic_sample" },
      { timestamp: 586, start: 584, end: 588, confidence: 0.7, source: "scorebug_chunk_periodic_sample" },
      { timestamp: 628, start: 626, end: 630, confidence: 0.7, source: "scorebug_chunk_periodic_sample" },
    ],
    mediaSignals: {
      audioPeaks: [{ time: 98, energyScore: 0.99 }, { time: 572, energyScore: 0.99 }],
    },
  });

  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map((window) => window.timestamp), [548, 586, 628]);
  assert.equal(windows.every((window) => window.source === "scorebug_chunk_periodic_sample"), true);
  assert.equal(windows.some((window) => window.source === "full_source_periodic_scoreboard_sample"), false);
});

test("scoreboard OCR sampling keeps enough checkpoints for five-goal YouTube highlights", () => {
  const windows = selectOcrSamplingWindows({
    metadata: { ...metadata, durationSeconds: 644 },
    mediaSignals: {
      audioPeaks: [
        { time: 98, energyScore: 0.9 },
        { time: 224, energyScore: 0.91 },
        { time: 318, energyScore: 0.92 },
        { time: 455, energyScore: 0.9 },
        { time: 572, energyScore: 0.93 },
      ],
      sceneChanges: [
        { time: 104, confidence: 0.8 },
        { time: 232, confidence: 0.78 },
        { time: 326, confidence: 0.82 },
        { time: 462, confidence: 0.8 },
        { time: 580, confidence: 0.84 },
      ],
    },
    visualSignals: {
      windows: [
        { start: 94, end: 101, types: ["shot_contact", "ball_in_net"], confidence: 0.9 },
        { start: 220, end: 227, types: ["shot_contact", "ball_in_net"], confidence: 0.91 },
        { start: 314, end: 321, types: ["shot_contact", "ball_in_net"], confidence: 0.92 },
        { start: 451, end: 458, types: ["shot_contact", "ball_in_net"], confidence: 0.9 },
        { start: 568, end: 575, types: ["shot_contact", "ball_in_net"], confidence: 0.93 },
      ],
    },
  });

  assert.equal(windows.length <= 48, true);
  assert.equal(windows.length > 24, true);
  assert.equal(windows.some((window) => /^full_source_/.test(window.source)), true);
  for (const expected of [98, 224, 318, 455, 572]) {
    assert.equal(windows.some((window) => Math.abs(window.timestamp - expected) <= 12), true);
  }
  assert.equal(windows.some((window) => window.timestamp > 600), true);
});

test("local scoreboard OCR can extract OCR-specific frames from source video safely", async () => {
  const { dir } = createFrameFixtures();
  try {
    const inputPath = safeResolve(dir, "source.mp4");
    writeFileSync(inputPath, "fake-source", "utf8");
    const outputDir = safeResolve(dir, "ocr_frames");
    const frames = await extractOcrFramesFromSource({
      inputPath,
      outputDir,
      metadata: { durationSeconds: 180, width: 1920, height: 1080 },
      visualSignals: {
        windows: [{ start: 150, end: 154, types: ["ball_in_net"], confidence: 0.9 }],
      },
      ffmpegRunner: async (args) => {
        writeFileSync(args[args.length - 1], "frame", "utf8");
      },
    });

    assert.equal(frames.length > 8, true);
    assert.equal(frames.length <= 48, true);
    assert.equal(frames.some((frame) => frame.timestamp > 150), true);
    assert.equal(frames[0].width, 1280);
    assert.doesNotMatch(JSON.stringify(frames.map(({ localPath, ...frame }) => frame)), /\/Users|storageKey|token|secret/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoreboard OCR preprocessing variants are bounded and safe", () => {
  const variants = scoreboardOcrPreprocessVariants();
  assert.equal(variants.length, 4);
  assert.deepEqual(variants.map((variant) => variant.psm), ["11", "7", "6", "11"]);
  assert.equal(variants.every((variant) => variant.id && variant.filter.length < 180), true);
  assert.equal(variants.every((variant) => !variant.whitelist || /^[A-Z0-9:]+$/.test(variant.whitelist)), true);
  assert.doesNotMatch(JSON.stringify(variants), /\/Users|storageKey|token|secret|raw/i);
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

test("scoreboard OCR scorebug layout profile extracts bounded score-only crop", async () => {
  const { dir } = createFrameFixtures();
  try {
    const outputDir = safeResolve(CONFIG.stagingDir, `ocr_${Date.now()}_score_only_crop_test`);
    mkdirSync(outputDir, { recursive: true });
    const region = defaultScoreboardRegions({ width: 640, height: 360 })[0];
    const profile = selectScorebugLayoutProfile(region);
    const cropPath = safeResolve(outputDir, "full_scorebug_crop.png");
    writeFileSync(cropPath, "full-scorebug", "utf8");
    let sawCropFilter = false;
    const scoreOnly = await cropScoreOnlyRegion({
      cropPath,
      outputDir,
      frameIndex: 0,
      region,
      variant: { id: "gray_line" },
      profile,
      ffmpegRunner: async (args) => {
        sawCropFilter = args.some((arg) => String(arg).includes("crop=iw*0.19:ih*0.82:iw*0.405:ih*0.08"));
        writeFileSync(args[args.length - 1], "score-only", "utf8");
      },
    });

    assert.equal(profile.layoutId, "broadcast-compact-score-only-v1");
    assert.deepEqual(profile.fullHomeDigitRoi, { x: 0.415, y: 0.18, width: 0.075, height: 0.62 });
    assert.deepEqual(profile.fullAwayDigitRoi, { x: 0.545, y: 0.18, width: 0.052, height: 0.62 });
    assert.deepEqual(profile.separatorRoi, { x: 0.49, y: 0.08, width: 0.055, height: 0.82 });
    assert.equal(sawCropFilter, true);
    assert.equal(existsSync(scoreOnly.cropPath), true);
    assert.doesNotMatch(scoreOnly.cropPath, /\.\./);
    assert.doesNotMatch(JSON.stringify({ layoutId: scoreOnly.layoutId, roi: scoreOnly.scoreOnlyRoi }), /\/Users|storageKey|token|secret/i);
    rmSync(outputDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
