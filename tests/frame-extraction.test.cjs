const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const {
  cleanupSampledFrames,
  extractSampledFrames,
  frameExtractionHealth,
  normalizeCandidateWindow,
  publicFrameSummary,
  scaledDimensions,
} = require("../server/frame-extraction.cjs");
const { storagePath } = require("../server/storage.cjs");

const metadata = { durationSeconds: 30, width: 1920, height: 1080 };

function uniquePath(area, name) {
  return storagePath(area, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
}

async function fakeFfmpegRunner(args) {
  const outputPath = args[args.length - 1];
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.from("synthetic-frame"));
}

test("sampled frame extraction validates candidate windows and dimensions", () => {
  const window = normalizeCandidateWindow({ time: 12, confidence: 0.9 }, metadata);
  assert.deepEqual(
    { start: window.start, end: window.end, timestamp: window.timestamp, confidence: window.confidence },
    { start: 10.5, end: 13.5, timestamp: 12, confidence: 0.9 },
  );
  assert.deepEqual(scaledDimensions({ width: 1920, height: 1080 }, 640), { width: 640, height: 360 });
  assert.deepEqual(scaledDimensions({}, 640), { width: 640, height: 360 });
});

test("extractSampledFrames creates bounded frame records and public summary hides paths", async () => {
  const inputPath = uniquePath("uploads", "source.mp4");
  const outputDir = uniquePath("staging", "frames");
  writeFileSync(inputPath, Buffer.from("synthetic-video"));

  const result = await extractSampledFrames({
    inputPath,
    outputDir,
    metadata,
    ffmpegRunner: fakeFfmpegRunner,
    maxFrames: 2,
    candidateWindows: [
      { time: 6, confidence: 0.8, source: "motion", visualHints: ["shot_like_motion"] },
      { time: 12, confidence: 0.7, source: "audio_peak_context" },
      { time: 18, confidence: 0.6, source: "scene_change_context" },
    ],
  });

  assert.equal(result.providerMode, "ffmpeg-frame-sampling");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].visualHints[0], "shot_like_motion");
  assert.equal(result.outputDir, outputDir);

  const publicSummary = publicFrameSummary(result);
  assert.equal(publicSummary.summary.frameCount, 2);
  assert.doesNotMatch(JSON.stringify(publicSummary), /localPath|\/Users|storageKey/i);

  const cleanup = cleanupSampledFrames(result);
  assert.equal(cleanup.cleanedCount, 2);
  assert.equal(existsSync(outputDir), false);
});

test("extractSampledFrames falls back safely when input is unavailable", async () => {
  const result = await extractSampledFrames({
    inputPath: uniquePath("uploads", "missing.mp4"),
    metadata,
    candidateWindows: [{ time: 4, confidence: 0.8 }],
    ffmpegRunner: fakeFfmpegRunner,
  });

  assert.equal(result.providerMode, "mock");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.frames.length, 0);
  assert.equal(publicFrameSummary(result).summary.frameCount, 0);
});

test("extractSampledFrames rejects unsafe output directories", async () => {
  await assert.rejects(
    () => extractSampledFrames({
      inputPath: uniquePath("uploads", "source.mp4"),
      outputDir: "/tmp/unsafe-frames",
      metadata,
      candidateWindows: [{ time: 4, confidence: 0.8 }],
      ffmpegRunner: fakeFfmpegRunner,
    }),
    (error) => error.code === "STORAGE_PATH_UNSAFE",
  );
});

test("extractSampledFrames honors cancellation before work starts", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => extractSampledFrames({
      inputPath: uniquePath("uploads", "source.mp4"),
      metadata,
      candidateWindows: [{ time: 4, confidence: 0.8 }],
      ffmpegRunner: fakeFfmpegRunner,
      signal: controller.signal,
    }),
    (error) => error.code === "JOB_CANCELLED",
  );
});

test("frame extraction health is safe and exposes fallback mode", () => {
  const health = frameExtractionHealth();
  assert.equal(health.ready, true);
  assert.equal(health.fallbackMode, "mock");
  assert.equal(health.objectTracking, false);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|storageKey|secret/i);
});
