const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  defaultOcrQaCalibration,
  loadOcrQaCalibration,
  normalizeOcrQaCalibrationReport,
  publicOcrQaCalibration,
} = require("../server/ocr-qa-calibration.cjs");
const { deterministicGoalEvidence } = require("../server/goal-evidence-provider.cjs");

const FIXED_NOW = Date.parse("2026-06-19T10:00:00.000Z");

function strongReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-19T09:58:00.000Z",
    timestamp: "2026-06-19T09:58:00.000Z",
    command: "npm run ocr:qa:review",
    phase: "ocr-qa-review",
    status: "passed",
    passed: true,
    skipped: false,
    scores: {
      visibilityScore: 1,
      readabilityScore: 1,
      usefulnessScore: 1,
      decisionSupportScore: 1,
    },
    calibration: {
      goalEvidencePolicy: "support_only",
      ocrEvidenceUsable: true,
      decisionSupportLevel: "strong",
      scoreboardCropQuality: "high",
      operatorDecision: "useful",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
    },
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
    ...overrides,
  };
}

function visualBallInNetInput(ocrQaCalibration) {
  return {
    metadata: { durationSeconds: 30, width: 1920, height: 1080 },
    transcript: { captions: [{ start: 8, end: 9, text: "The shot hits the net" }] },
    visualSignals: {
      providerMode: "fixture",
      fallbackUsed: false,
      windows: [
        { start: 6.5, end: 8, labels: ["shot_contact", "ball_toward_goal"], confidence: 0.9 },
        { start: 8, end: 9.5, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      ],
    },
    ocrEvidence: [{
      timestamp: 10,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.9,
    }],
    ocrQaCalibration,
  };
}

test("OCR QA calibration normalizes strong support-only review reports", () => {
  const calibration = normalizeOcrQaCalibrationReport(strongReport(), { nowMs: FIXED_NOW });
  assert.equal(calibration.status, "available");
  assert.equal(calibration.usable, true);
  assert.equal(calibration.decisionSupportLevel, "strong");
  assert.equal(calibration.goalEvidencePolicy, "support_only");
  assert.equal(calibration.goalDecisionAllowed, false);
  assert.equal(calibration.noFalseGoalFromOcrOnly, true);
  assert.equal(publicOcrQaCalibration(calibration).supportWeight, 1);
});

test("OCR QA calibration fails closed for skipped, stale, invalid and leaking reports", () => {
  assert.equal(normalizeOcrQaCalibrationReport(strongReport({ skipped: true }), { nowMs: FIXED_NOW }).usable, false);
  assert.equal(
    normalizeOcrQaCalibrationReport(strongReport({ generatedAt: "2026-05-01T00:00:00.000Z" }), { nowMs: FIXED_NOW }).status,
    "stale",
  );
  assert.equal(
    normalizeOcrQaCalibrationReport(strongReport({ calibration: { goalEvidencePolicy: "support_only" } }), { nowMs: FIXED_NOW }).status,
    "invalid",
  );
  assert.equal(
    normalizeOcrQaCalibrationReport(strongReport({ reviewedCrops: [{ notes: "/Users/operator/private.png" }] }), { nowMs: FIXED_NOW }).status,
    "invalid",
  );
});

test("OCR QA calibration loader reads only bounded project-relative reports", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-qa-calibration-"));
  const reportRef = "demo/results/ocr-qa-review-latest.json";
  const reportPath = join(root, "demo", "results", "ocr-qa-review-latest.json");
  require("node:fs").mkdirSync(join(root, "demo", "results"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(strongReport(), null, 2)}\n`);

  const calibration = loadOcrQaCalibration({ rootDir: root, reportRef, nowMs: FIXED_NOW });
  assert.equal(calibration.usable, true);
  assert.equal(loadOcrQaCalibration({ rootDir: root, reportRef: "../secret.json", nowMs: FIXED_NOW }).status, "invalid");
  assert.equal(loadOcrQaCalibration({ rootDir: root, reportRef: "demo/results/missing.json", nowMs: FIXED_NOW }).status, "missing");
});

test("strong OCR QA supports action-backed ball-in-net confirmation", () => {
  const calibration = normalizeOcrQaCalibrationReport(strongReport(), { nowMs: FIXED_NOW });
  const result = deterministicGoalEvidence(visualBallInNetInput(calibration));
  assert.equal(result.summary.validGoalCount, 1);
  assert.equal(result.summary.scoreboardConfirmedGoalCount, 1);
  assert.equal(result.summary.ocrQaUsable, true);
  assert.equal(result.events[0].outcomeHint, "valid_goal");
});

test("missing OCR QA does not let OCR score changes confirm goals", () => {
  const result = deterministicGoalEvidence(visualBallInNetInput(defaultOcrQaCalibration("missing")));
  assert.equal(result.summary.validGoalCount, 0);
  assert.equal(result.summary.scoreboardConfirmedGoalCount, 0);
  assert.equal(result.summary.ocrQaUsable, false);
  assert.equal(result.events[0].outcomeHint, "possible_goal_unconfirmed");
});

test("strong OCR QA still cannot create an OCR-only goal", () => {
  const calibration = normalizeOcrQaCalibrationReport(strongReport(), { nowMs: FIXED_NOW });
  const result = deterministicGoalEvidence({
    metadata: { durationSeconds: 30, width: 1920, height: 1080 },
    transcript: { captions: [] },
    visualSignals: { providerMode: "fixture", fallbackUsed: false, windows: [] },
    ocrEvidence: [{
      timestamp: 10,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.9,
    }],
    ocrQaCalibration: calibration,
  });
  assert.equal(result.summary.validGoalCount, 0);
  assert.equal(result.summary.eventCount, 0);
});
