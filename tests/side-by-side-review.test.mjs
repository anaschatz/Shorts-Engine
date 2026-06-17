import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  buildMetrics,
  buildSideBySideReview,
  safeRelativeRef,
  writeSideBySideReviewReport,
} from "../demo/run-side-by-side-review.mjs";

function createVideoFixture(rootDir, relativePath) {
  const file = join(rootDir, relativePath);
  writeFileSync(file, Buffer.from("not-a-real-mp4-but-probed-by-test"));
  return file;
}

function fakeProbe(input, { role }) {
  if (!input.ok || !existsSync(input.resolvedFile)) {
    return { exists: false, readable: false, errorCode: "SIDE_BY_SIDE_INPUT_MISSING" };
  }
  if (role === "generated") {
    return {
      exists: true,
      readable: true,
      sizeBytes: 1234,
      durationSeconds: 16,
      width: 1080,
      height: 1920,
      fps: 30,
      aspectRatio: 0.5625,
      aspectLabel: "9:16",
      orientation: "vertical",
      videoCodec: "h264",
      audioPresent: true,
      errorCode: null,
    };
  }
  return {
    exists: true,
    readable: true,
    sizeBytes: 2345,
    durationSeconds: 18,
    width: 720,
    height: 1280,
    fps: 30,
    aspectRatio: 0.5625,
    aspectLabel: "9:16",
    orientation: "vertical",
    videoCodec: "h264",
    audioPresent: true,
    errorCode: null,
  };
}

test("side-by-side review builds safe deterministic report shape", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-"));
  createVideoFixture(rootDir, "generated.mp4");
  createVideoFixture(rootDir, "reference.mp4");

  const report = buildSideBySideReview({
    rootDir,
    generated: "generated.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });

  assert.equal(report.status, "passed");
  assert.equal(report.passed, true);
  assert.equal(report.metrics.machineScore, 90);
  assert.equal(report.metrics.humanReviewRequired, true);
  assert.equal(report.comparison.generated.relativePath, "generated.mp4");
  assert.equal(report.comparison.reference.aspectLabel, "9:16");
  assert.equal(report.checklist.some((item) => item.status === "needs_human_review"), true);
  assert.equal(findSensitiveLeak(report), null);
});

test("side-by-side metrics penalize horizontal generated output", () => {
  const metrics = buildMetrics(
    {
      readable: true,
      width: 1920,
      height: 1080,
      durationSeconds: 16,
      aspectRatio: 1.7778,
      orientation: "horizontal",
    },
    {
      readable: true,
      width: 720,
      height: 1280,
      durationSeconds: 16,
      aspectRatio: 0.5625,
      orientation: "vertical",
    },
    []
  );

  assert.equal(metrics.aspectRatioFit, 0.2);
  assert.equal(metrics.resolutionFit, 0.25);
  assert.ok(metrics.machineScore < 65);
});

test("side-by-side review fails closed for missing inputs", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-missing-"));
  createVideoFixture(rootDir, "reference.mp4");

  const report = buildSideBySideReview({
    rootDir,
    generated: "missing.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.passed, false);
  assert.equal(report.failedCases.some((item) => item.code === "SIDE_BY_SIDE_INPUT_MISSING"), true);
  assert.equal(findSensitiveLeak(report), null);
});

test("side-by-side input references reject path traversal", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-safe-"));
  const result = safeRelativeRef(rootDir, "../outside.mp4");
  assert.equal(result.ok, false);
  assert.equal(result.code, "SIDE_BY_SIDE_UNSAFE_RELATIVE_REF");
});

test("side-by-side report writer writes latest and timestamped reports", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-write-"));
  createVideoFixture(rootDir, "generated.mp4");
  createVideoFixture(rootDir, "reference.mp4");
  const report = buildSideBySideReview({
    rootDir,
    generated: "generated.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });

  const written = writeSideBySideReviewReport(report, "demo/results", rootDir);
  assert.equal(written.latestPath, "demo/results/side-by-side-latest.json");
  assert.match(written.reportPath, /demo\/results\/side-by-side-2026-06-17T12-00-00-000Z\.json/);
  assert.equal(JSON.parse(readFileSync(join(rootDir, written.latestPath), "utf8")).status, "passed");
  assert.equal(JSON.parse(readFileSync(join(rootDir, written.reportPath), "utf8")).metrics.machineScore, 90);
});
