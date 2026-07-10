const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { safeResolve } = require("../server/storage.cjs");
const {
  segmentScorebugDigits,
  segmentScorebugDigitsAsync,
} = require("../server/scorebug-image-segmentation.cjs");

const SEGMENTS = Object.freeze({
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

const ZONES = Object.freeze({
  a: { x0: 0.22, x1: 0.78, y0: 0.04, y1: 0.18 },
  b: { x0: 0.68, x1: 0.88, y0: 0.14, y1: 0.46 },
  c: { x0: 0.68, x1: 0.88, y0: 0.54, y1: 0.86 },
  d: { x0: 0.22, x1: 0.78, y0: 0.82, y1: 0.96 },
  e: { x0: 0.12, x1: 0.32, y0: 0.54, y1: 0.86 },
  f: { x0: 0.12, x1: 0.32, y0: 0.14, y1: 0.46 },
  g: { x0: 0.36, x1: 0.64, y0: 0.43, y1: 0.57 },
});

function createFixtureDir(name) {
  const dir = safeResolve(CONFIG.stagingDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fillRect(pixels, width, height, x0, y0, x1, y1, value) {
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
      pixels[y * width + x] = value;
    }
  }
}

function drawDigit(pixels, width, height, digit, roi) {
  for (const segment of SEGMENTS[digit]) {
    const zone = ZONES[segment];
    fillRect(
      pixels,
      width,
      height,
      Math.floor(roi.x + zone.x0 * roi.width),
      Math.floor(roi.y + zone.y0 * roi.height),
      Math.ceil(roi.x + zone.x1 * roi.width),
      Math.ceil(roi.y + zone.y1 * roi.height),
      0,
    );
  }
}

function writeScorebugPgm(filePath, { home = 1, away = 0, clock = false, noisy = false } = {}) {
  const width = clock ? 180 : 120;
  const height = 52;
  const pixels = Array.from({ length: width * height }, () => 255);
  if (noisy) {
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = index % 3 === 0 ? 0 : 255;
    }
  } else if (clock) {
    [
      { digit: 1, x: 14 },
      { digit: 2, x: 50 },
      { digit: 3, x: 98 },
      { digit: 4, x: 134 },
    ].forEach(({ digit, x }) => drawDigit(pixels, width, height, digit, { x, y: 8, width: 24, height: 36 }));
  } else {
    drawDigit(pixels, width, height, home, { x: 43, y: 8, width: 18, height: 36 });
    drawDigit(pixels, width, height, away, { x: 67, y: 8, width: 18, height: 36 });
  }
  const body = pixels.map(String).join(" ");
  writeFileSync(filePath, `P2\n${width} ${height}\n255\n${body}\n`, "utf8");
}

function writeFakePng(filePath) {
  writeFileSync(filePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
}

test("image segmentation reads a focused synthetic scorebug crop", () => {
  const dir = createFixtureDir("scorebug-segmentation-readable");
  try {
    const cropPath = join(dir, "scorebug.pgm");
    writeScorebugPgm(cropPath, { home: 1, away: 0 });
    const result = segmentScorebugDigits({
      cropPath,
      regionId: "scorebug_broadcast_compact",
      timestamp: 24,
    });

    assert.equal(result.status, "readable");
    assert.deepEqual(result.score, { home: 1, away: 0, text: "1-0" });
    assert.equal(result.method, "image-digit-segmentation");
    assert.equal(result.imageSegmentation.status, "readable");
    assert.equal(result.imageSegmentation.imageFormat, "pgm-p2");
    assert.equal(result.imageSegmentation.digitSignatures.home.bits.length, 160);
    assert.equal(result.imageSegmentation.digitSignatures.away.bits.length, 160);
    assert.equal(result.digitBoxes.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image segmentation rejects broad regions and unsafe crop paths", () => {
  const dir = createFixtureDir("scorebug-segmentation-safe");
  try {
    const cropPath = join(dir, "scorebug.pgm");
    writeScorebugPgm(cropPath, { home: 2, away: 1 });
    const broad = segmentScorebugDigits({
      cropPath,
      regionId: "broadcast_top_band",
      timestamp: 10,
    });

    assert.equal(broad.status, "unreadable");
    assert.ok(broad.reasons.includes("region_not_focused_for_truth"));
    assert.throws(
      () => segmentScorebugDigits({
        cropPath: "/tmp/scorebug-outside-staging.pgm",
        regionId: "scorebug_broadcast_compact",
      }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image segmentation rejects clock-like, noisy and missing crops", () => {
  const dir = createFixtureDir("scorebug-segmentation-rejections");
  try {
    const clockPath = join(dir, "clock.pgm");
    const noisyPath = join(dir, "noisy.pgm");
    writeScorebugPgm(clockPath, { clock: true });
    writeScorebugPgm(noisyPath, { noisy: true });

    const clock = segmentScorebugDigits({
      cropPath: clockPath,
      regionId: "scorebug_broadcast_compact",
      timestamp: 12,
    });
    assert.equal(clock.status, "ambiguous");
    assert.ok(clock.reasons.includes("clock_like_digit_group_rejected"));

    const noisy = segmentScorebugDigits({
      cropPath: noisyPath,
      regionId: "scorebug_broadcast_compact",
      timestamp: 12,
    });
    assert.equal(noisy.status, "ambiguous");
    assert.equal(noisy.score, null);
    assert.equal(noisy.reasons.length > 0, true);

    const missing = segmentScorebugDigits({
      cropPath: join(dir, "missing.pgm"),
      regionId: "scorebug_broadcast_compact",
      timestamp: 12,
    });
    assert.equal(missing.status, "unreadable");
    assert.ok(missing.reasons.includes("crop_missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image segmentation can read a decoded live-like PNG crop", async () => {
  const dir = createFixtureDir("scorebug-segmentation-decoded");
  let ffmpegCalls = 0;
  try {
    const cropPath = join(dir, "scorebug.png");
    writeFakePng(cropPath);
    const result = await segmentScorebugDigitsAsync({
      cropPath,
      outputDir: dir,
      regionId: "scorebug_broadcast_compact",
      timestamp: 32,
      ffmpegRunner: async (args) => {
        ffmpegCalls += 1;
        writeScorebugPgm(args[args.length - 1], { home: 2, away: 1 });
      },
    });

    assert.equal(ffmpegCalls, 1);
    assert.equal(result.status, "readable");
    assert.deepEqual(result.score, { home: 2, away: 1, text: "2-1" });
    assert.equal(result.imageSegmentation.decoderStatus, "decoded");
    assert.equal(result.imageSegmentation.decoderMode, "ffmpeg-pgm");
    assert.equal(result.imageSegmentation.imageFormat, "png");
    assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image segmentation rejects broad regions before decoding PNG crops", async () => {
  const dir = createFixtureDir("scorebug-segmentation-broad-decoder");
  let ffmpegCalls = 0;
  try {
    const cropPath = join(dir, "scorebug.png");
    writeFakePng(cropPath);
    const result = await segmentScorebugDigitsAsync({
      cropPath,
      outputDir: dir,
      regionId: "broadcast_top_band",
      timestamp: 32,
      ffmpegRunner: async () => {
        ffmpegCalls += 1;
      },
    });

    assert.equal(ffmpegCalls, 0);
    assert.equal(result.status, "unreadable");
    assert.ok(result.reasons.includes("region_not_focused_for_truth"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
