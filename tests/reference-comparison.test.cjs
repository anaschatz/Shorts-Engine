const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  buildReferenceComparisonReport,
  findReferenceComparisonLeak,
  runReferenceComparison,
  safeError,
  validateReferenceFixture,
} = require("../eval/reference-comparison.cjs");

function assertNoUnsafeText(value) {
  assert.doesNotMatch(JSON.stringify(value), /\/Users\/|\/private\/|Bearer\s+|gh[pousr]_|OPENAI_API_KEY|storageKey/);
}

function baseFixture(overrides = {}) {
  return validateReferenceFixture({
    schemaVersion: 1,
    id: "unit_reference_fixture",
    title: "Unit reference fixture",
    sport: "football",
    sourceUrl: "https://www.youtube.com/shorts/SfN80wMlT6U",
    localReferenceRelativePath: null,
    expected: {
      durationRange: [55, 100],
      aspectRatio: "9:16",
      expectedCountedGoals: 3,
      segmentDurationRange: [18, 32],
      maxReplayOnlySegments: 0,
      minMotionEvents: 8,
      pacingProfile: "chronological_multi_goal_story",
      captionStyle: "specific_goal_phase_captions",
      transitionStyle: "smooth_short_fades",
      goalPhaseBehavior: "buildup_shot_finish_confirmation",
      thresholds: {
        validGoalRecall: 1,
        replayOnlySegments: 0,
        cropSafetyScore: 0.9,
        phaseCoverageScore: 0.9,
        captionActionAlignment: 0.9,
        transitionPolishScore: 0.8,
        referenceSimilarityScore: 0.75,
      },
    },
    notes: ["Metadata-only reference."],
    ...overrides,
  });
}

function segment(index, overrides = {}) {
  return {
    index,
    sourceStart: index * 30,
    sourceEnd: index * 30 + 28,
    duration: 28,
    goalNumber: index,
    highlightType: "goal",
    goalOutcome: { outcome: "confirmed_goal" },
    replayUsed: index > 1,
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
    },
    safetyFlags: ["wide_safe_full_frame"],
    ...overrides,
  };
}

function baseProof(overrides = {}) {
  const renderPlan = {
    stylePreset: "reference_football_multi_goal_v1",
    framingMode: "wide_safe_vertical",
    cropPlanMode: "wide_safe",
    segmentCount: 3,
    totalDuration: 84,
    captionCount: 5,
    segments: [segment(1), segment(2), segment(3)],
  };
  return {
    schemaVersion: 2,
    generatedAt: "2026-06-21T16:00:00.000Z",
    status: "passed",
    proofOutput: {
      outputMp4: {
        relativePath: "manual-downloads/unit-generated.mp4",
        sizeBytes: 1200,
      },
      ffprobe: {
        relativePath: "manual-downloads/unit-generated.mp4",
        durationSeconds: 84,
        width: 1080,
        height: 1920,
        audioPresent: true,
      },
      countedGoalsFound: 3,
      countedGoalsIncluded: 3,
      expectedCountedGoals: 3,
      replayOnlySegments: 0,
      averageGoalSegmentDuration: 28,
      abruptCutRiskCount: 0,
      captionsAlignedCount: 5,
      captionsMisalignedCount: 0,
      transitionRenderedCount: 2,
      hardCutFallbackCount: 0,
      animatedCaptionCount: 5,
      overlayRenderedCount: 5,
      renderStylePreset: "reference_football_multi_goal_v1",
      segmentWindows: [segment(1), segment(2), segment(3)],
      renderPolishQA: {
        transitionRenderedCount: 2,
        hardCutFallbackCount: 0,
        animatedCaptionCount: 5,
        overlayRenderedCount: 5,
      },
    },
    smoke: { renderPlan },
    ...overrides,
  };
}

function makeRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-reference-comparison-"));
  mkdirSync(join(rootDir, "manual-downloads"), { recursive: true });
  mkdirSync(join(rootDir, "demo", "results"), { recursive: true });
  mkdirSync(join(rootDir, "eval", "reference-comparison-fixtures"), { recursive: true });
  writeFileSync(join(rootDir, "manual-downloads", "unit-generated.mp4"), Buffer.from("fake-video"));
  return rootDir;
}

test("reference comparison fixture validates safe metadata-only references", () => {
  const fixture = baseFixture();
  assert.equal(fixture.id, "unit_reference_fixture");
  assert.equal(fixture.localReference.present, false);
  assert.equal(fixture.expected.thresholds.validGoalRecall, 1);
  assert.equal(findReferenceComparisonLeak(fixture), null);
});

test("reference comparison rejects unsafe fixture URL query secrets", () => {
  assert.throws(() => baseFixture({ sourceUrl: "https://example.com/watch?token=abc" }), /sourceUrl/);
});

test("reference comparison scores a clean generated proof and stays leak-free", () => {
  const rootDir = makeRoot();
  const report = buildReferenceComparisonReport({
    rootDir,
    fixture: baseFixture(),
    proofReport: baseProof(),
    timestamp: "2026-06-21T16:00:00.000Z",
  });

  assert.equal(report.passed, true);
  assert.equal(report.metrics.validGoalRecall, 1);
  assert.equal(report.metrics.replayOnlySegmentCount, 0);
  assert.equal(report.metrics.aspectRatioScore, 1);
  assert.equal(report.metrics.phaseCoverageScore, 1);
  assert.equal(report.metrics.referenceSimilarityScore >= 0.95, true);
  assert.equal(findReferenceComparisonLeak(report), null);
  assertNoUnsafeText(report);
});

test("reference comparison penalizes replay-only, wrong aspect and poor phase coverage", () => {
  const rootDir = makeRoot();
  const broken = baseProof({
    proofOutput: {
      ...baseProof().proofOutput,
      ffprobe: {
        relativePath: "manual-downloads/unit-generated.mp4",
        durationSeconds: 84,
        width: 1920,
        height: 1080,
      },
      countedGoalsIncluded: 2,
      replayOnlySegments: 1,
      captionsAlignedCount: 2,
      captionsMisalignedCount: 3,
      transitionRenderedCount: 0,
      hardCutFallbackCount: 2,
      animatedCaptionCount: 1,
      overlayRenderedCount: 1,
      segmentWindows: [
        segment(1, { replayOnly: true }),
        segment(2, { phaseCoverage: { hasBuildup: false, hasShot: true, hasFinish: false, hasConfirmation: true } }),
        segment(3),
      ],
    },
  });
  const report = buildReferenceComparisonReport({
    rootDir,
    fixture: baseFixture(),
    proofReport: broken,
    timestamp: "2026-06-21T16:00:00.000Z",
  });

  assert.equal(report.passed, false);
  assert.equal(report.metrics.validGoalRecall < 1, true);
  assert.equal(report.metrics.aspectRatioScore, 0);
  assert.equal(report.metrics.phaseCoverageScore < 1, true);
  assert.equal(report.metrics.captionActionAlignment < 0.9, true);
  assert.equal(report.failedCriteria.some((item) => item.metric === "replayOnlySegmentCount"), true);
  assert.equal(report.suggestedNextFixes.some((item) => item.id === "recover_missing_counted_goals"), true);
});

test("reference comparison applies an abrupt-cut penalty without making paths unsafe", () => {
  const rootDir = makeRoot();
  const proof = baseProof({
    proofOutput: {
      ...baseProof().proofOutput,
      abruptCutRiskCount: 3,
    },
  });
  const report = buildReferenceComparisonReport({
    rootDir,
    fixture: baseFixture(),
    proofReport: proof,
    timestamp: "2026-06-21T16:00:00.000Z",
  });

  assert.equal(report.metrics.cutSmoothnessScore < 1, true);
  assert.equal(report.warnings.some((note) => /Abrupt cut risk/.test(note)), true);
  assert.equal(report.suggestedNextFixes.some((item) => item.id === "smooth_action_boundaries"), true);
  assertNoUnsafeText(report);
});

test("reference comparison uses reported boundary smoothness metadata", () => {
  const rootDir = makeRoot();
  const proof = baseProof({
    proofOutput: {
      ...baseProof().proofOutput,
      cutSmoothnessScore: 0.96,
      boundarySmoothingAppliedCount: 3,
      averagePreActionPaddingSeconds: 2.8,
      averagePostConfirmationPaddingSeconds: 1.5,
      segmentWindows: [
        segment(1, { boundarySmoothing: { applied: true, smoothingLevel: "minimum", preActionPaddingSeconds: 2.4, postConfirmationPaddingSeconds: 1.4 } }),
        segment(2, { boundarySmoothing: { applied: true, smoothingLevel: "minimum", preActionPaddingSeconds: 2.8, postConfirmationPaddingSeconds: 1.5 } }),
        segment(3, { boundarySmoothing: { applied: true, smoothingLevel: "minimum", preActionPaddingSeconds: 3.2, postConfirmationPaddingSeconds: 1.6 } }),
      ],
    },
  });
  const report = buildReferenceComparisonReport({
    rootDir,
    fixture: baseFixture(),
    proofReport: proof,
    timestamp: "2026-06-21T16:00:00.000Z",
  });

  assert.equal(report.metrics.cutSmoothnessScore, 0.96);
  assert.equal(report.generated.boundarySmoothingAppliedCount, 3);
  assert.equal(report.generated.averagePreActionPaddingSeconds, 2.8);
  assert.equal(report.generated.averagePostConfirmationPaddingSeconds, 1.5);
  assert.equal(report.suggestedNextFixes.some((item) => item.id === "smooth_action_boundaries"), false);
  assertNoUnsafeText(report);
});

test("reference comparison runner writes latest json and side-by-side html", () => {
  const rootDir = makeRoot();
  writeFileSync(join(rootDir, "demo", "results", "youtube-live-e2e-latest.json"), `${JSON.stringify(baseProof(), null, 2)}\n`);
  writeFileSync(
    join(rootDir, "eval", "reference-comparison-fixtures", "fixture.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "unit_reference_fixture",
      title: "Unit reference fixture",
      sport: "football",
      sourceUrl: "https://www.youtube.com/shorts/SfN80wMlT6U",
      localReferenceRelativePath: null,
      expected: baseFixture().expected,
    }, null, 2)}\n`
  );

  const { report, output } = runReferenceComparison({
    rootDir,
    proofReport: "demo/results/youtube-live-e2e-latest.json",
    fixturePath: "eval/reference-comparison-fixtures/fixture.json",
    resultsDir: "demo/results",
    timestamp: "2026-06-21T16:00:00.000Z",
  });

  assert.equal(report.passed, true);
  assert.equal(output.latestPath, "demo/results/reference-comparison-latest.json");
  assert.equal(output.htmlLatestPath, "demo/results/reference-comparison-latest.html");
  assert.equal(existsSync(join(rootDir, output.latestPath)), true);
  assert.equal(existsSync(join(rootDir, output.htmlLatestPath)), true);
  const html = readFileSync(join(rootDir, output.htmlLatestPath), "utf8");
  assert.match(html, /Reference Comparison/);
  assert.doesNotMatch(html, /\/Users\/|Bearer\s+|OPENAI_API_KEY|storageKey/);
});

test("reference comparison missing inputs produce safe operator errors", () => {
  const error = safeError({ code: "REFERENCE_COMPARISON_REPORT_MISSING", userMessage: "Missing /Users/example/report.json" });
  assert.equal(error.ok, false);
  assert.equal(error.code, "REFERENCE_COMPARISON_REPORT_MISSING");
  assert.doesNotMatch(JSON.stringify(error), /\/Users\/|Bearer\s+|OPENAI_API_KEY/);
});
