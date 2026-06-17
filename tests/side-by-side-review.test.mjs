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
import {
  SIDE_BY_SIDE_RUBRIC,
  validateManualReview,
  validateRubricSchema,
} from "../demo/side-by-side-rubric.mjs";

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

function completeCriteria(score = 4) {
  return Object.fromEntries(
    SIDE_BY_SIDE_RUBRIC.map((criterion) => [
      criterion.id,
      {
        score: criterion.id === "false_goal_guard" ? Math.max(score, 5) : score,
        notes: `Example note for ${criterion.id}.`,
      },
    ])
  );
}

function reviewPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedRelativePath: "generated.mp4",
    referenceRelativePath: "reference.mp4",
    reviewer: "operator-example",
    reviewedAt: "2026-06-17T12:05:00.000Z",
    criteria: completeCriteria(4),
    flags: {
      falseGoalClaim: false,
      badCrop: false,
      captionMismatch: false,
      lowEnergy: false,
      wrongMoment: false,
      missingTrendEditing: false,
    },
    notes: "Operator scored this from playback and contact sheets.",
    ...overrides,
  };
}

test("side-by-side rubric schema is explicit and valid", () => {
  const result = validateRubricSchema();
  assert.equal(result.ok, true);
  assert.deepEqual(
    SIDE_BY_SIDE_RUBRIC.map((criterion) => criterion.id),
    [
      "moment_selection",
      "caption_action_alignment",
      "ball_player_framing",
      "reference_style_editing",
      "false_goal_guard",
      "hook_strength",
      "pacing_energy",
      "text_readability",
      "replay_or_context_use",
      "overall_short_quality",
    ]
  );
  assert.equal(SIDE_BY_SIDE_RUBRIC.every((criterion) => criterion.scoredBy === "human"), true);
});

test("manual side-by-side review validates complete operator input", () => {
  const validation = validateManualReview(reviewPayload(), {
    expectedGeneratedRelativePath: "generated.mp4",
    expectedReferenceRelativePath: "reference.mp4",
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.review.criteria.length, SIDE_BY_SIDE_RUBRIC.length);
  assert.equal(validation.review.flags.falseGoalClaim, false);
  assert.equal(findSensitiveLeak(validation.review), null);
});

test("manual side-by-side review rejects invalid scores and unknown criteria", () => {
  const criteria = completeCriteria(4);
  criteria.moment_selection.score = 6;
  criteria.unknown_criterion = { score: 3, notes: "Nope." };
  const validation = validateManualReview(reviewPayload({ criteria }), {
    expectedGeneratedRelativePath: "generated.mp4",
    expectedReferenceRelativePath: "reference.mp4",
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.failedCases.some((item) => item.code === "SIDE_BY_SIDE_REVIEW_SCORE_INVALID"), true);
  assert.equal(validation.failedCases.some((item) => item.code === "SIDE_BY_SIDE_REVIEW_UNKNOWN_CRITERION"), true);
});

test("manual side-by-side review rejects unsafe refs and long or leaking notes", () => {
  const criteria = completeCriteria(4);
  criteria.caption_action_alignment.notes = "x".repeat(501);
  const validation = validateManualReview(reviewPayload({
    generatedRelativePath: "../outside.mp4",
    criteria,
    notes: "/Users/example/private-token",
  }));
  assert.equal(validation.ok, false);
  assert.equal(validation.failedCases.some((item) => item.code === "SIDE_BY_SIDE_REVIEW_RELATIVE_REF_UNSAFE"), true);
  assert.equal(validation.failedCases.some((item) => item.code === "SIDE_BY_SIDE_REVIEW_NOTE_TOO_LONG"), true);
  assert.equal(validation.failedCases.some((item) => item.code === "SIDE_BY_SIDE_REVIEW_LEAK_GUARD"), true);
});

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
  assert.equal(report.quality.qualityStatus, "pending_human_review");
  assert.equal(report.quality.productReady, false);
  assert.equal(report.quality.pendingCriteria.length, SIDE_BY_SIDE_RUBRIC.length);
  assert.equal(report.comparison.generated.relativePath, "generated.mp4");
  assert.equal(report.comparison.reference.aspectLabel, "9:16");
  assert.equal(report.checklist.some((item) => item.status === "needs_human_review"), true);
  assert.equal(findSensitiveLeak(report), null);
});

test("side-by-side review with manual scores produces combined quality score", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-scored-"));
  createVideoFixture(rootDir, "generated.mp4");
  createVideoFixture(rootDir, "reference.mp4");

  const report = buildSideBySideReview({
    rootDir,
    generated: "generated.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
    reviewPayload: reviewPayload(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.operatorReview.present, true);
  assert.equal(report.metrics.humanReviewRequired, false);
  assert.equal(report.quality.humanScore, 83);
  assert.equal(report.quality.combinedScore, 85);
  assert.equal(report.quality.productReady, true);
  assert.equal(report.quality.failedCriteria.length, 0);
  assert.equal(findSensitiveLeak(report), null);
});

test("false goal and wrong moment flags fail product readiness even with strong structural metadata", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-side-review-flags-"));
  createVideoFixture(rootDir, "generated.mp4");
  createVideoFixture(rootDir, "reference.mp4");

  const falseGoalReport = buildSideBySideReview({
    rootDir,
    generated: "generated.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
    reviewPayload: reviewPayload({
      criteria: completeCriteria(5),
      flags: { falseGoalClaim: true },
    }),
  });
  assert.equal(falseGoalReport.quality.productReady, false);
  assert.equal(falseGoalReport.quality.combinedScore, 35);
  assert.equal(falseGoalReport.quality.failedCriteria.some((item) => item.id === "false_goal_guard"), true);

  const wrongMomentReport = buildSideBySideReview({
    rootDir,
    generated: "generated.mp4",
    reference: "reference.mp4",
    now: "2026-06-17T12:00:00.000Z",
    probeVideo: fakeProbe,
    createContactSheets: false,
    reviewPayload: reviewPayload({
      criteria: completeCriteria(5),
      flags: { wrongMoment: true },
    }),
  });
  assert.equal(wrongMomentReport.quality.productReady, false);
  assert.equal(wrongMomentReport.quality.combinedScore, 55);
  assert.equal(wrongMomentReport.quality.failedCriteria.some((item) => item.id === "moment_selection"), true);
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
