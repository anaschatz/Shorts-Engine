import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  buildOcrQaReviewReport,
  buildSkippedOcrQaReviewReport,
  runOcrQaReview,
  runOcrQaReviewFromFile,
  safeFailureReport,
  validateManifestRelativeRef,
  validateReviewInput,
} from "../demo/ocr-qa-review.mjs";

const ROOT_DIR = resolve(".");
const FIXED_NOW = Date.parse("2026-06-19T10:00:00.000Z");

function testRunId(name) {
  return `ocr-review-test-${name}`;
}

function manifestRefFor(runId) {
  return `demo/results/ocr-artifacts/${runId}/ocr-qa-manifest.json`;
}

function createManifest(name, files = ["crop-1", "crop-2", "crop-3"]) {
  const runId = testRunId(name);
  const directory = `demo/results/ocr-artifacts/${runId}`;
  const absoluteDir = resolve(ROOT_DIR, directory);
  mkdirSync(absoluteDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    kind: "ocr-crop-qa-artifacts",
    runId,
    generatedAt: "2026-06-19T09:59:00.000Z",
    directory,
    cropCount: files.length,
    maxCropCount: 12,
    maxArtifactBytes: 2097152,
    files: files.map((id, index) => ({
      id,
      kind: "scoreboard_crop",
      relativePath: `${directory}/ocr-crop-${String(index + 1).padStart(2, "0")}.png`,
      sizeBytes: 100 + index,
    })),
    relativeRefsOnly: true,
    fullFramesStored: false,
    ocrTextStored: false,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  writeFileSync(resolve(absoluteDir, "ocr-qa-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runId, directory, manifestRef: manifestRefFor(runId), absoluteDir };
}

function cleanupManifest(runId) {
  rmSync(resolve(ROOT_DIR, "demo", "results", "ocr-artifacts", runId), { recursive: true, force: true });
}

function validReviewInput(manifestRef) {
  return {
    manifestPath: manifestRef,
    operatorDecision: "useful",
    crops: [
      {
        id: "crop-1",
        scoreboardVisible: true,
        clockVisible: true,
        scoreVisible: true,
        readable: true,
        cropUsefulForDecision: true,
        notes: "scoreboard readable",
      },
      {
        id: "crop-2",
        scoreboardVisible: true,
        clockVisible: true,
        scoreVisible: true,
        readable: true,
        cropUsefulForDecision: true,
      },
      {
        id: "crop-3",
        scoreboardVisible: true,
        clockVisible: false,
        scoreVisible: true,
        readable: true,
        cropUsefulForDecision: true,
      },
    ],
  };
}

test("builds safe OCR QA review report with support-only calibration", () => {
  const { runId, manifestRef } = createManifest("valid");
  try {
    const report = buildOcrQaReviewReport(validReviewInput(manifestRef), { nowMs: FIXED_NOW });
    assert.equal(report.status, "passed");
    assert.equal(report.passed, true);
    assert.equal(report.skipped, false);
    assert.equal(report.manifest.relativePath, manifestRef);
    assert.equal(report.reviewedCropCount, 3);
    assert.equal(report.calibration.goalEvidencePolicy, "support_only");
    assert.equal(report.calibration.goalDecisionAllowed, false);
    assert.equal(report.calibration.noFalseGoalFromOcrOnly, true);
    assert.equal(report.calibration.decisionSupportLevel, "strong");
    assert.equal(report.calibration.ocrEvidenceUsable, true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    cleanupManifest(runId);
  }
});

test("rejects unsafe manifest refs before reading files", () => {
  assert.throws(
    () => validateManifestRelativeRef("../demo/results/ocr-artifacts/ocr-test/ocr-qa-manifest.json"),
    /unsafe/i,
  );
  assert.throws(
    () => validateManifestRelativeRef("/Users/example/demo/results/ocr-artifacts/ocr-test/ocr-qa-manifest.json"),
    /unsafe/i,
  );
  assert.throws(
    () => validateManifestRelativeRef("file:///tmp/ocr-qa-manifest.json"),
    /unsafe/i,
  );
});

test("rejects unsupported raw OCR fields in crop reviews", () => {
  const { runId, manifestRef } = createManifest("raw-field");
  try {
    const input = validReviewInput(manifestRef);
    input.crops[0].rawOcrText = "1-0";
    assert.throws(() => validateReviewInput(input), /unsupported field/i);
  } finally {
    cleanupManifest(runId);
  }
});

test("rejects sensitive or raw-provider notes", () => {
  const { runId, manifestRef } = createManifest("note-leak");
  try {
    const withPath = validReviewInput(manifestRef);
    withPath.crops[0].notes = "/Users/operator/private/crop.png";
    assert.throws(() => validateReviewInput(withPath), /unsafe data/i);
    const withRawOcr = validReviewInput(manifestRef);
    withRawOcr.crops[0].notes = "raw OCR text says 1-0";
    assert.throws(() => validateReviewInput(withRawOcr), /unsafe data/i);
  } finally {
    cleanupManifest(runId);
  }
});

test("low-quality review ignores OCR evidence for calibration", () => {
  const { runId, manifestRef } = createManifest("low-quality");
  try {
    const input = {
      manifestPath: manifestRef,
      operatorDecision: "not_useful",
      crops: [
        {
          id: "crop-1",
          scoreboardVisible: true,
          clockVisible: false,
          scoreVisible: false,
          readable: false,
          cropUsefulForDecision: false,
        },
        {
          id: "crop-2",
          scoreboardVisible: false,
          clockVisible: false,
          scoreVisible: false,
          readable: false,
          cropUsefulForDecision: false,
        },
      ],
    };
    const report = buildOcrQaReviewReport(input, { nowMs: FIXED_NOW });
    assert.equal(report.calibration.decisionSupportLevel, "ignore");
    assert.equal(report.calibration.ocrEvidenceUsable, false);
    assert.equal(report.calibration.goalDecisionAllowed, false);
  } finally {
    cleanupManifest(runId);
  }
});

test("report output is deterministic for fixed input and timestamp", () => {
  const { runId, manifestRef } = createManifest("deterministic");
  try {
    const first = buildOcrQaReviewReport(validReviewInput(manifestRef), { nowMs: FIXED_NOW });
    const second = buildOcrQaReviewReport(validReviewInput(manifestRef), { nowMs: FIXED_NOW });
    assert.deepEqual(first, second);
  } finally {
    cleanupManifest(runId);
  }
});

test("runner writes safe latest and timestamped reports", () => {
  const { runId, manifestRef } = createManifest("writer");
  try {
    const result = runOcrQaReview(validReviewInput(manifestRef), { nowMs: FIXED_NOW });
    assert.equal(result.passed, true);
    assert.match(result.latestPath, /^demo\/results\/ocr-qa-review-latest\.json$/);
    assert.match(result.reportPath, /^demo\/results\/ocr-qa-review-2026-06-19T10-00-00-000Z\.json$/);
    assert.equal(findSensitiveLeak(result), null);
  } finally {
    cleanupManifest(runId);
  }
});

test("runner skips safely when no manual review input is supplied", () => {
  const report = buildSkippedOcrQaReviewReport({ nowMs: FIXED_NOW });
  assert.equal(report.status, "passed");
  assert.equal(report.passed, true);
  assert.equal(report.skipped, true);
  assert.equal(report.calibration.decisionSupportLevel, "ignore");
  assert.equal(report.calibration.goalEvidencePolicy, "support_only");
  assert.equal(findSensitiveLeak(report), null);
});

test("file runner accepts relative JSON review input only", () => {
  const { runId, manifestRef } = createManifest("file-runner");
  const inputRef = "demo/results/ocr-qa-review-input-test.json";
  try {
    writeFileSync(resolve(ROOT_DIR, inputRef), `${JSON.stringify(validReviewInput(manifestRef), null, 2)}\n`);
    const result = runOcrQaReviewFromFile(inputRef, { nowMs: FIXED_NOW });
    assert.equal(result.passed, true);
    assert.equal(result.skipped, false);
    assert.equal(findSensitiveLeak(result), null);
    assert.throws(() => runOcrQaReviewFromFile("../review.json"), /unsafe/i);
  } finally {
    cleanupManifest(runId);
    rmSync(resolve(ROOT_DIR, inputRef), { force: true });
  }
});

test("safe failure report does not leak raw error details", () => {
  const error = new Error("Provider failed at /Users/operator/private/crop.png with token abc");
  error.code = "OCR_QA_REVIEW_TEST_FAILURE";
  const report = safeFailureReport(error, { nowMs: FIXED_NOW });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "OCR_QA_REVIEW_TEST_FAILURE");
  assert.equal(findSensitiveLeak(report), null);
});
