const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  calibrationSummary,
  isFocusedScorebugRegion,
  readScorebugDigits,
  validateScorebugCalibration,
} = require("../server/scorebug-digit-reader.cjs");
const { CONFIG } = require("../server/config.cjs");
const { safeResolve } = require("../server/storage.cjs");

function writeMinimalScorebugPgm(filePath) {
  const width = 120;
  const height = 52;
  const pixels = Array.from({ length: width * height }, () => 255);
  const zones = {
    a: { x0: 0.22, x1: 0.78, y0: 0.04, y1: 0.18 },
    b: { x0: 0.68, x1: 0.88, y0: 0.14, y1: 0.46 },
    c: { x0: 0.68, x1: 0.88, y0: 0.54, y1: 0.86 },
    d: { x0: 0.22, x1: 0.78, y0: 0.82, y1: 0.96 },
    e: { x0: 0.12, x1: 0.32, y0: 0.54, y1: 0.86 },
    f: { x0: 0.12, x1: 0.32, y0: 0.14, y1: 0.46 },
    g: { x0: 0.36, x1: 0.64, y0: 0.43, y1: 0.57 },
  };
  const segments = { 0: "abcdef", 1: "bc" };
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) pixels[y * width + x] = 0;
    }
  };
  const draw = (digit, roi) => {
    for (const segment of segments[digit]) {
      const zone = zones[segment];
      fill(
        Math.floor(roi.x + zone.x0 * roi.width),
        Math.floor(roi.y + zone.y0 * roi.height),
        Math.ceil(roi.x + zone.x1 * roi.width),
        Math.ceil(roi.y + zone.y1 * roi.height),
      );
    }
  };
  draw(1, { x: 43, y: 8, width: 18, height: 36 });
  draw(0, { x: 67, y: 8, width: 18, height: 36 });
  writeFileSync(filePath, `P2\n${width} ${height}\n255\n${pixels.join(" ")}\n`, "utf8");
}

test("scorebug digit reader accepts focused calibrated digit boxes", () => {
  const calibration = validateScorebugCalibration({
    layoutId: "arg-alg-world-feed",
    minConfidence: 0.78,
    readings: [{
      timestamp: 24,
      regionId: "scorebug_broadcast_compact",
      score: { home: 1, away: 0 },
      confidence: 0.91,
      digitBoxes: [
        { role: "home", digit: 1, x: 0.42, y: 0.2, width: 0.08, height: 0.55, confidence: 0.9 },
        { role: "away", digit: 0, x: 0.58, y: 0.2, width: 0.08, height: 0.55, confidence: 0.89 },
      ],
    }],
  });

  const result = readScorebugDigits({
    timestamp: 24.2,
    regionId: "scorebug_broadcast_compact",
    calibration,
  });

  assert.equal(isFocusedScorebugRegion("scorebug_broadcast_compact"), true);
  assert.equal(result.status, "readable");
  assert.deepEqual(result.score, { home: 1, away: 0, text: "1-0" });
  assert.equal(result.digitBoxes.length, 2);
  assert.equal(result.method, "digit-segmentation");
  assert.deepEqual(calibrationSummary(calibration), {
    enabled: true,
    layoutId: "arg-alg-world-feed",
    minConfidence: 0.78,
    readingCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /\/Users|storageKey|localPath|token|secret|stdout|stderr|raw/i);
});

test("scorebug digit reader rejects broad regions and ambiguous boxes", () => {
  const calibration = {
    readings: [{
      timestamp: 10,
      regionId: "scorebug_broadcast_compact",
      score: { home: 2, away: 1 },
      confidence: 0.92,
      digitBoxes: [{ role: "home", digit: 2, confidence: 0.9, x: 0.4, y: 0.2, width: 0.08, height: 0.5 }],
    }],
  };

  const broad = readScorebugDigits({
    timestamp: 10,
    regionId: "scoreboard_top_left",
    calibration,
  });
  assert.equal(broad.status, "unreadable");
  assert.equal(broad.score, null);
  assert.ok(broad.reasons.includes("region_not_focused_for_truth"));

  const ambiguous = readScorebugDigits({
    timestamp: 10,
    regionId: "scorebug_broadcast_compact",
    calibration,
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.score, null);
  assert.ok(ambiguous.reasons.includes("home_or_away_digit_box_missing"));
});

test("scorebug calibration validation rejects unsafe payloads", () => {
  assert.throws(
    () => validateScorebugCalibration({ layoutId: "x", fullPath: "/Users/example/scorebug.json" }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("scorebug digit reader tries focused image segmentation before calibrated fallback", () => {
  const dir = safeResolve(CONFIG.stagingDir, `scorebug-reader-image-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const cropPath = join(dir, "scorebug.pgm");
    writeMinimalScorebugPgm(cropPath);
    const result = readScorebugDigits({
      timestamp: 25,
      regionId: "scorebug_broadcast_compact",
      crop: { cropPath },
      calibration: {
        minConfidence: 0.78,
        readings: [{
          timestamp: 25,
          regionId: "scorebug_broadcast_compact",
          score: { home: 0, away: 0 },
          confidence: 0.94,
          digitBoxes: [
            { role: "home", digit: 0, confidence: 0.9, x: 0.42, y: 0.2, width: 0.08, height: 0.5 },
            { role: "away", digit: 0, confidence: 0.9, x: 0.58, y: 0.2, width: 0.08, height: 0.5 },
          ],
        }],
      },
    });

    assert.equal(result.status, "readable");
    assert.equal(result.method, "image-digit-segmentation");
    assert.deepEqual(result.score, { home: 1, away: 0, text: "1-0" });
    assert.equal(result.imageSegmentation.status, "readable");
    const summary = calibrationSummary(result.calibrationUsed);
    assert.equal(summary.readingCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|localPath|token|secret|stdout|stderr/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
