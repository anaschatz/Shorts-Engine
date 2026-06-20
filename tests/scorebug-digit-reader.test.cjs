const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calibrationSummary,
  isFocusedScorebugRegion,
  readScorebugDigits,
  validateScorebugCalibration,
} = require("../server/scorebug-digit-reader.cjs");

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
