import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  buildHumanVisualReview,
  generatedArtifactFromProof,
  writeHumanVisualReviewReport,
} from "../demo/run-human-visual-review.mjs";
import { SIDE_BY_SIDE_RUBRIC } from "../demo/side-by-side-rubric.mjs";

function createVideoFixture(rootDir, relativePath) {
  const file = join(rootDir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from("fake-mp4-human-visual-review"));
  return file;
}

function fakeProbe(input, { role }) {
  if (!input.ok || !existsSync(input.resolvedFile)) {
    return { exists: false, readable: false, errorCode: "SIDE_BY_SIDE_INPUT_MISSING" };
  }
  return {
    exists: true,
    readable: true,
    sizeBytes: role === "generated" ? 1234 : 2345,
    durationSeconds: role === "generated" ? 16 : 18,
    width: role === "generated" ? 1080 : 720,
    height: role === "generated" ? 1920 : 1280,
    fps: 30,
    aspectRatio: 0.5625,
    aspectLabel: "9:16",
    orientation: "vertical",
    videoCodec: "h264",
    audioPresent: true,
    errorCode: null,
  };
}

function completeCriteria(score = 5) {
  return Object.fromEntries(
    SIDE_BY_SIDE_RUBRIC.map((criterion) => [
      criterion.id,
      {
        score: criterion.id === "false_goal_guard" ? 5 : score,
        notes: `Review note for ${criterion.id}.`,
      },
    ]),
  );
}

function reviewPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedRelativePath: "manual-downloads/generated.mp4",
    referenceRelativePath: "manual-downloads/reference.mp4",
    reviewer: "operator",
    reviewedAt: "2026-06-18T10:00:00.000Z",
    criteria: completeCriteria(5),
    flags: {
      falseGoalClaim: false,
      badCrop: false,
      captionMismatch: false,
      lowEnergy: false,
      wrongMoment: false,
      missingTrendEditing: false,
    },
    notes: "Human review confirms the action-first sequence is visible.",
    ...overrides,
  };
}

function liveProof(overrides = {}) {
  return {
    status: "passed",
    passed: true,
    phase: "completed",
    command: "youtube:proof:operator",
    source: { sourceType: "youtube", kind: "watch", videoId: "dQw4w9WgXcQ" },
    generatedArtifact: {
      type: "rendered_video",
      status: "available",
      relativePath: "manual-downloads/generated.mp4",
      sourceType: "youtube",
      videoId: "dQw4w9WgXcQ",
      projectId: "prj_12345678",
      uploadId: "upl_12345678",
      jobId: "job_12345678",
      exportId: "exp_12345678",
      sizeBytes: 1234,
      contentType: "video/mp4",
      sha256Prefix: "abc123",
      durationSeconds: 16,
      width: 1080,
      height: 1920,
      downloadVerified: true,
    },
    logsDownloaded: false,
    artifactsDownloaded: false,
    ...overrides,
  };
}

test("generated artifact extraction from live proof is strict", () => {
  const extracted = generatedArtifactFromProof(liveProof());
  assert.equal(extracted.ok, true);
  assert.equal(extracted.artifact.relativePath, "manual-downloads/generated.mp4");
  assert.equal(extracted.artifact.exportId, "exp_12345678");

  const missing = generatedArtifactFromProof(liveProof({ generatedArtifact: null }));
  assert.equal(missing.ok, false);
  assert.equal(missing.failedCase.code, "HUMAN_VISUAL_REVIEW_GENERATED_ARTIFACT_MISSING");

  const failed = generatedArtifactFromProof(liveProof({ status: "failed", passed: false }));
  assert.equal(failed.ok, false);
  assert.equal(failed.failedCase.code, "HUMAN_VISUAL_REVIEW_PROOF_NOT_PASSED");
});

test("human visual review builds pending report from live proof artifact", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-human-review-"));
  createVideoFixture(rootDir, "manual-downloads/generated.mp4");
  createVideoFixture(rootDir, "manual-downloads/reference.mp4");
  writeFileSync(join(rootDir, "proof.json"), JSON.stringify(liveProof(), null, 2));

  const report = buildHumanVisualReview({
    rootDir,
    proof: "proof.json",
    reference: "manual-downloads/reference.mp4",
    now: "2026-06-18T10:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });

  assert.equal(report.status, "pending_human_review");
  assert.equal(report.passed, true);
  assert.equal(report.productReady, false);
  assert.equal(report.source.mode, "live_proof");
  assert.equal(report.source.generatedArtifact.relativePath, "manual-downloads/generated.mp4");
  assert.equal(report.comparison.generated.relativePath, "manual-downloads/generated.mp4");
  assert.equal(report.humanReview.status, "pending_human_review");
  assert.equal(report.checklist.every((item) => item.status === "needs_human_review"), true);
  assert.equal(findSensitiveLeak(report), null);
});

test("human visual review applies operator scores and can become product ready", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-human-review-scored-"));
  createVideoFixture(rootDir, "manual-downloads/generated.mp4");
  createVideoFixture(rootDir, "manual-downloads/reference.mp4");

  const report = buildHumanVisualReview({
    rootDir,
    generated: "manual-downloads/generated.mp4",
    reference: "manual-downloads/reference.mp4",
    now: "2026-06-18T10:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
    reviewPayload: reviewPayload(),
  });

  assert.equal(report.status, "product_ready");
  assert.equal(report.productReady, true);
  assert.equal(report.humanReview.present, true);
  assert.equal(report.humanReview.humanScore, 100);
  assert.equal(report.checklist.every((item) => item.status === "passed"), true);
  assert.equal(findSensitiveLeak(report), null);
});

test("human visual review fails closed when proof has no generated artifact", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-human-review-missing-"));
  writeFileSync(join(rootDir, "proof.json"), JSON.stringify(liveProof({ generatedArtifact: null }), null, 2));
  const report = buildHumanVisualReview({
    rootDir,
    proof: "proof.json",
    now: "2026-06-18T10:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.passed, false);
  assert.equal(report.failedCases[0].code, "HUMAN_VISUAL_REVIEW_GENERATED_ARTIFACT_MISSING");
  assert.equal(findSensitiveLeak(report), null);
});

test("human visual review writer writes latest and timestamped reports", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-human-review-write-"));
  createVideoFixture(rootDir, "manual-downloads/generated.mp4");
  createVideoFixture(rootDir, "manual-downloads/reference.mp4");
  const report = buildHumanVisualReview({
    rootDir,
    generated: "manual-downloads/generated.mp4",
    reference: "manual-downloads/reference.mp4",
    now: "2026-06-18T10:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
  });
  const written = writeHumanVisualReviewReport(report, "demo/results", rootDir);
  assert.equal(written.latestPath, "demo/results/human-visual-review-latest.json");
  assert.match(written.reportPath, /demo\/results\/human-visual-review-2026-06-18T10-00-00-000Z\.json/);
  const persisted = JSON.parse(readFileSync(join(rootDir, written.latestPath), "utf8"));
  assert.equal(persisted.status, "pending_human_review");
  assert.equal(findSensitiveLeak(persisted), null);
});
