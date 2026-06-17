const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  buildReviewComparisonReport,
  buildReviewSummaryReport,
  findReviewSensitiveLeak,
  runReviewComparison,
  runReviewSummary,
  validateHumanReview,
  validateReviewInput,
} = require("../eval/review-comparison.cjs");

function createVideoFixture(rootDir, relativePath = "media/generated.mp4") {
  const target = join(rootDir, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, Buffer.from("fake-mp4-review-fixture"));
  return relativePath;
}

function baseEditPlan(overrides = {}) {
  return {
    sourceStart: 4,
    sourceEnd: 12,
    sourceWidth: 1920,
    sourceHeight: 1080,
    aspectRatio: "9:16",
    stylePreset: "punchy_highlight",
    styleTarget: "vertical_9_16_reference_style",
    highlightType: "big_chance",
    reasonCodes: ["big_chance", "audio_energy_spike", "visual_shot_like_motion"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      zoom: 1,
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    captions: [
      { start: 0, end: 1.2, role: "opening_hook", text: "THE CHANCE OPENS" },
      { start: 1.3, end: 3, role: "context", text: "Pressure builds around the box" },
      { start: 3.1, end: 5, role: "action_callout", text: "Almost punished in one touch" },
      { start: 5.1, end: 6.5, role: "reaction", text: "The crowd felt that" },
      { start: 6.6, end: 8, role: "closing_punch", text: "Replay the timing" },
    ],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1 },
      { type: "kinetic_caption", start: 0.2, end: 2 },
      { type: "punch_zoom", start: 3, end: 4 },
      { type: "end_replay_prompt", start: 6.7, end: 7.8 },
    ],
    ...overrides,
  };
}

function baseFixture(rootDir, overrides = {}) {
  const generated = createVideoFixture(rootDir, "media/generated.mp4");
  const source = createVideoFixture(rootDir, "media/source.mp4");
  return {
    schemaVersion: 1,
    id: "unit_review_fixture",
    title: "Unit review fixture",
    language: "English",
    media: {
      generated: { relativePath: generated },
      source: { relativePath: source },
      reference: null,
    },
    expected: {
      styleTarget: "vertical_9_16_reference_style",
      stylePreset: "punchy_highlight",
      momentType: "big_chance",
      acceptedMomentTypes: ["big_chance", "near_miss"],
      selectedMomentWindow: { start: 4, end: 12 },
      aspectRatio: "9:16",
      durationRange: [6, 14],
      requiredAnimationCues: ["intro_hook", "kinetic_caption", "punch_zoom", "end_replay_prompt"],
      captionMustMentionAny: [
        { role: "opening_hook", terms: ["chance"] },
        { role: "action_callout", terms: ["almost", "pressure"] },
        { role: "closing_punch", terms: ["replay", "timing"] },
      ],
      safety: { noFalseGoalClaim: true, allowGoalClaim: false },
      threshold: 82,
      referenceStyleFallbackAllowed: true,
    },
    generatedMetadata: {
      selectedMoment: {
        start: 4,
        end: 12,
        momentType: "big_chance",
        reasonCodes: ["big_chance", "audio_energy_spike", "visual_shot_like_motion"],
        retentionScore: 88,
      },
      editPlan: baseEditPlan(),
    },
    consent: {
      rightsConfirmed: true,
      reviewPurpose: "local_quality_review",
      source: "unit_test",
    },
    ...overrides,
  };
}

test("real-video review input validates safe media refs and fallback reference mode", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-"));
  const input = validateReviewInput(baseFixture(rootDir), { rootDir });
  assert.equal(input.failedCases.length, 0);
  assert.equal(input.media.generated.readable, true);
  assert.equal(input.media.reference.errorCode, "REFERENCE_STYLE_RUBRIC_FALLBACK");

  const report = buildReviewComparisonReport(input, { timestamp: "2026-06-17T10:00:00.000Z" });
  assert.equal(report.passed, true);
  assert.equal(report.input.referenceMode, "reference_style_rubric");
  assert.equal(report.metrics.overallScore >= 95, true);
  assert.equal(report.metrics.noFalseGoalClaim, 1);
  assert.equal(findReviewSensitiveLeak(report), null);
});

test("review input rejects path traversal and missing media safely", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-unsafe-"));
  const fixture = baseFixture(rootDir);
  fixture.media.generated.relativePath = "../outside.mp4";
  fixture.media.source.relativePath = "missing.mp4";

  const input = validateReviewInput(fixture, { rootDir });
  const report = buildReviewComparisonReport(input, { timestamp: "2026-06-17T10:00:00.000Z" });

  assert.equal(report.passed, false);
  assert.equal(report.failedCases.some((item) => item.code === "REVIEW_MEDIA_REF_UNSAFE"), true);
  assert.equal(report.failedCases.some((item) => item.code === "REVIEW_MEDIA_MISSING"), true);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|Bearer\s+|OPENAI_API_KEY/);
});

test("review comparison fails false goal language without explicit evidence", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-goal-"));
  const fixture = baseFixture(rootDir);
  fixture.generatedMetadata.editPlan = baseEditPlan({
    hook: "WHAT A GOAL",
    captions: baseEditPlan().captions.map((caption, index) => (
      index === 0 ? { ...caption, text: "WHAT A GOAL" } : caption
    )),
  });

  const input = validateReviewInput(fixture, { rootDir });
  const report = buildReviewComparisonReport(input, { timestamp: "2026-06-17T10:00:00.000Z" });

  assert.equal(report.passed, false);
  assert.equal(report.metrics.noFalseGoalClaim, 0);
  assert.equal(report.failedCriteria.some((item) => item.metric === "noFalseGoalClaim"), true);
});

test("human review bridge can confirm or fail creative readiness", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-human-"));
  const passingFixture = baseFixture(rootDir, {
    humanReview: {
      reviewer: "operator",
      reviewedAt: "2026-06-17T10:05:00.000Z",
      selectedMomentCorrect: true,
      captionMatchesAction: true,
      ballPlayerVisible: true,
      textObstructsAction: false,
      animationFeelsReferenceLike: 5,
      falseClaim: false,
      notes: "Looks ready for this review sample.",
    },
  });
  const passInput = validateReviewInput(passingFixture, { rootDir });
  const passReport = buildReviewComparisonReport(passInput, { timestamp: "2026-06-17T10:06:00.000Z" });
  assert.equal(passReport.humanReview.present, true);
  assert.equal(passReport.metrics.reviewerReadinessScore, 1);
  assert.equal(passReport.passed, true);

  const failingValidation = validateHumanReview({
    selectedMomentCorrect: true,
    captionMatchesAction: true,
    ballPlayerVisible: true,
    textObstructsAction: false,
    falseClaim: false,
    animationFeelsReferenceLike: 6,
  });
  assert.equal(failingValidation.ok, false);
  assert.equal(failingValidation.failedCases.some((item) => item.code === "REVIEW_HUMAN_REVIEW_SCORE_INVALID"), true);
});

test("review comparison runner writes latest and timestamped reports", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-runner-"));
  const fixture = baseFixture(rootDir);
  writeFileSync(join(rootDir, "review.json"), `${JSON.stringify(fixture, null, 2)}\n`);

  const { report, output } = runReviewComparison({
    rootDir,
    inputPath: "review.json",
    resultsDir: "eval/review-results",
    timestamp: "2026-06-17T10:00:00.000Z",
  });

  assert.equal(report.passed, true);
  assert.equal(output.latestPath, "eval/review-results/review-latest.json");
  assert.match(output.reportPath, /eval\/review-results\/review-comparison-2026-06-17T10-00-00-000Z\.json/);
  assert.equal(existsSync(join(rootDir, output.latestPath)), true);
  assert.equal(JSON.parse(readFileSync(join(rootDir, output.latestPath), "utf8")).metrics.overallScore >= 95, true);
});

test("review comparison CLI fails thresholds deterministically", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-cli-"));
  const fixture = baseFixture(rootDir);
  writeFileSync(join(rootDir, "review.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  const script = join(__dirname, "..", "eval", "run-review-comparison.mjs");

  const pass = spawnSync("node", [script, "--input=review.json", "--results=eval/review-results", "--threshold=80"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).passed, true);

  const fail = spawnSync("node", [script, "--input=review.json", "--results=eval/review-results", "--threshold=101"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).passed, false);
});

test("review summary aggregates safe comparison reports", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-review-summary-"));
  const fixture = baseFixture(rootDir);
  writeFileSync(join(rootDir, "review.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  runReviewComparison({
    rootDir,
    inputPath: "review.json",
    resultsDir: "eval/review-results",
    timestamp: "2026-06-17T10:00:00.000Z",
  });

  const { report, output } = runReviewSummary({
    rootDir,
    resultsDir: "eval/review-results",
    timestamp: "2026-06-17T11:00:00.000Z",
  });
  assert.equal(report.passed, true);
  assert.equal(report.aggregate.sampleCount, 1);
  assert.equal(report.aggregate.noFalseGoalClaim, 1);
  assert.equal(output.latestPath, "eval/review-results/review-summary-latest.json");

  const deterministic = buildReviewSummaryReport({
    reports: [JSON.parse(readFileSync(join(rootDir, "eval/review-results/review-latest.json"), "utf8"))],
    timestamp: "2026-06-17T11:00:00.000Z",
  });
  assert.deepEqual(report, deterministic);
});
