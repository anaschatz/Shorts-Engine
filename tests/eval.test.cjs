const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildReport,
  framingIsSafe,
  loadFixtures,
  overlapRatio,
  planHasGoalLanguage,
  reasonCodePrecision,
  reasonCodeRecall,
  runEvaluation,
  sanitizeReportText,
  scoreFixture,
  top3Recall,
  validateFixture,
} = require("../eval/scoring.cjs");

const fixturesDir = join(__dirname, "..", "eval", "fixtures");

test("evaluation fixtures pass schema validation", () => {
  const fixtures = loadFixtures(fixturesDir);
  assert.ok(fixtures.length >= 5);
  fixtures.forEach((fixture) => assert.equal(validateFixture(fixture), true));
});

test("overlap and recall scoring are deterministic", () => {
  assert.equal(overlapRatio({ start: 4, end: 12 }, { start: 6, end: 10 }), 1);
  assert.equal(overlapRatio({ start: 4, end: 8 }, { start: 6, end: 10 }), 0.5);
  assert.equal(
    top3Recall(
      [
        { start: 3, end: 8 },
        { start: 12, end: 18 },
      ],
      [
        { start: 4, end: 7 },
        { start: 13, end: 16 },
      ],
      0.5,
    ),
    1,
  );
});

test("reason code precision and recall score expected labels", () => {
  assert.equal(reasonCodePrecision(["goal", "audio_energy_spike", "noise"], ["goal", "audio_energy_spike"]), 0.6667);
  assert.equal(reasonCodeRecall(["goal"], ["goal", "audio_energy_spike"]), 0.5);
});

test("fixture scoring returns reportable metrics and candidate plans", () => {
  const fixture = loadFixtures(fixturesDir)[0];
  const result = scoreFixture(fixture);
  assert.equal(result.passed, true);
  assert.ok(result.score >= fixture.thresholds.minAggregateScore);
  assert.ok(result.metrics.top1Overlap >= fixture.thresholds.minTop1Overlap);
  assert.equal(result.metrics.highlightTypeAccuracy, 1);
  assert.equal(result.metrics.falseGoalCaptionRate, 0);
  assert.equal(result.metrics.falseVisualGoalRate, 0);
  assert.equal(result.metrics.visualReasonPrecision, 1);
  assert.equal(result.metrics.visualLabelPrecision, result.metrics.visualReasonPrecision);
  assert.equal(typeof result.metrics.frameExtractionFallbackUsed, "boolean");
  assert.equal(typeof result.metrics.sampledFrameCount, "number");
  assert.equal(result.metrics.framingSafety, 1);
  assert.equal(result.metrics.cropSafetyScore, 1);
  assert.equal(result.metrics.actionSafeZoneCoverage, 1);
  assert.equal(result.metrics.textObstructionRisk, 0);
  assert.equal(typeof result.metrics.wideSafeFallbackRate, "number");
  assert.equal(result.metrics.trackingConfidenceCalibration, 1);
  assert.equal(result.metrics.trackingOutputValidity, 1);
  assert.equal(result.metrics.ballTrackCoverage, 1);
  assert.equal(result.metrics.playerClusterCoverage, 1);
  assert.equal(result.metrics.softFollowPrecision, 1);
  assert.equal(result.metrics.wideSafeFallbackCorrectness, 1);
  assert.equal(result.metrics.falseGoalFromTrackingRate, 0);
  assert.equal(result.metrics.animationCueValidity, 1);
  assert.equal(result.metrics.animationCueRelevance, 1);
  assert.equal(typeof result.metrics.goalSequenceRecall, "number");
  assert.equal(typeof result.metrics.offsideOutcomeAccuracy, "number");
  assert.equal(typeof result.metrics.disallowedGoalIncluded, "number");
  assert.equal(typeof result.metrics.decisionContextCoverage, "number");
  assert.equal(typeof result.metrics.captionOutcomeAlignment, "number");
  assert.equal(typeof result.metrics.postGoalWindowCoverage, "number");
  assert.equal(typeof result.metrics.validGoalRecall, "number");
  assert.equal(typeof result.metrics.lateGoalRecall, "number");
  assert.equal(typeof result.metrics.falseGoalRate, "number");
  assert.equal(typeof result.metrics.offsideExclusionAccuracy, "number");
  assert.equal(typeof result.metrics.validGoalOnlyFillerRate, "number");
  assert.equal(typeof result.metrics.captionGoalClaimAccuracy, "number");
  assert.equal(typeof result.metrics.segmentTimingCoverage, "number");
  assert.equal(typeof result.metrics.celebrationOnlyExclusion, "number");
  assert.equal(typeof result.metrics.anthemIntroExclusion, "number");
  assert.equal(typeof result.metrics.ocrEvidenceCoverage, "number");
  assert.equal(typeof result.metrics.scoreboardScoreChangeRecall, "number");
  assert.equal(typeof result.metrics.ambiguousOcrFailClosed, "number");
  assert.equal(typeof result.metrics.noFalseGoalFromOcrOnly, "number");
  assert.equal(typeof result.metrics.ocrQaCalibrationSupport, "number");
  assert.equal(typeof result.metrics.shotToPayoffCoverage, "number");
  assert.equal(typeof result.metrics.actionWindowCoverage, "number");
  assert.equal(result.metrics.captionRoleValidity, 1);
  assert.equal(result.metrics.captionEvidenceMetadataCompleteness, 1);
  assert.equal(result.metrics.captionActionAlignment, 1);
  assert.equal(result.metrics.genericCaptionPenaltyRate, 0);
  assert.equal(result.metrics.captionSpecificityScore, 1);
  assert.equal(result.metrics.reactionAsSupportScore, 1);
  assert.equal(result.metrics.weakEvidenceNeutralityScore, 1);
  assert.equal(result.metrics.providerFallbackRate, 0);
  assert.equal(result.metrics.renderStylePresetValidity, 1);
  assert.equal(result.metrics.unsupportedCueRate, 0);
  assert.ok(result.actual.candidatePlans.length > 0);
  assert.equal(result.actual.candidatePlans[0].visualQA.goalClaimAllowed, false);
  assert.equal(typeof result.actual.candidatePlans[0].visualQA.trackingConfidence, "number");
  assert.ok(result.actual.candidatePlans[0].captionRoles.includes("opening_hook"));
  assert.ok(result.actual.candidatePlans[0].captionRoles.includes("closing_punch"));
});

test("late valid-goals-only fixture recalls every late confirmed goal without filler", () => {
  const fixture = loadFixtures(fixturesDir).find((item) => item.id === "late_valid_goals_only");
  assert.ok(fixture);
  const result = scoreFixture(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.validGoalRecall, 1);
  assert.equal(result.metrics.lateGoalRecall, 1);
  assert.equal(result.metrics.falseGoalRate, 0);
  assert.equal(result.metrics.offsideExclusionAccuracy, 1);
  assert.equal(result.metrics.validGoalOnlyFillerRate, 0);
  assert.equal(result.metrics.captionGoalClaimAccuracy, 1);
  assert.equal(result.metrics.segmentTimingCoverage, 1);
  assert.equal(result.metrics.celebrationOnlyExclusion, 1);
  assert.equal(result.metrics.anthemIntroExclusion, 1);
  assert.equal(result.actual.candidatePlans[0].mode, "multi_moment_compilation");
  assert.equal(result.actual.candidatePlans[0].selectedMomentCount, 3);
  assert.ok(result.actual.candidatePlans[0].segments.every((segment) => segment.highlightType === "goal"));
});

test("OCR-confirmed valid-goals fixture selects every goal and excludes intro/celebration", () => {
  const fixture = loadFixtures(fixturesDir).find((item) => item.id === "ocr_confirmed_valid_goals");
  assert.ok(fixture);
  const result = scoreFixture(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.validGoalRecall, 1);
  assert.equal(result.metrics.goalEvidenceCoverage, 1);
  assert.equal(result.metrics.ocrEvidenceCoverage, 1);
  assert.equal(result.metrics.scoreboardScoreChangeRecall, 1);
  assert.equal(result.metrics.ocrQaCalibrationSupport, 1);
  assert.equal(result.metrics.celebrationOnlyExclusion, 1);
  assert.equal(result.metrics.anthemIntroExclusion, 1);
  assert.equal(result.actual.scoreboardOcr.evidenceCount, 3);
  assert.equal(result.actual.scoreboardOcr.scoreChangeCount, 3);
  assert.equal(result.actual.goalEvidence.ocrEvidenceCount, 3);
  assert.equal(result.actual.goalEvidence.scoreboardConfirmedGoalCount, 3);
  assert.equal(result.actual.goalEvidence.ocrQaCalibration.decisionSupportLevel, "strong");
  assert.equal(result.actual.goalEvidence.ocrQaCalibration.goalDecisionAllowed, false);
  assert.equal(result.actual.candidatePlans[0].selectedMomentCount, 3);
});

test("OCR risk fixtures fail closed for ambiguous and OCR-only evidence", () => {
  const fixtures = loadFixtures(fixturesDir);
  const ambiguous = scoreFixture(fixtures.find((item) => item.id === "ambiguous_ocr_fail_closed"));
  const ocrOnly = scoreFixture(fixtures.find((item) => item.id === "ocr_only_score_change_no_goal"));
  const scoreUnchanged = scoreFixture(fixtures.find((item) => item.id === "ocr_score_unchanged_disallowed_goal"));
  assert.equal(ambiguous.passed, true);
  assert.equal(ambiguous.metrics.ambiguousOcrFailClosed, 1);
  assert.equal(ambiguous.actual.goalEvidence.validGoalCount, 0);
  assert.equal(ambiguous.actual.scoreboardOcr.ambiguousCount, 1);
  assert.equal(ocrOnly.passed, true);
  assert.equal(ocrOnly.metrics.noFalseGoalFromOcrOnly, 1);
  assert.equal(ocrOnly.actual.goalEvidence.validGoalCount, 0);
  assert.equal(ocrOnly.actual.scoreboardOcr.scoreChangeCount, 1);
  assert.equal(scoreUnchanged.passed, true);
  assert.equal(scoreUnchanged.metrics.offsideOutcomeAccuracy, 1);
  assert.equal(scoreUnchanged.metrics.captionOutcomeAlignment, 1);
  assert.equal(scoreUnchanged.actual.goalEvidence.validGoalCount, 0);
  assert.equal(scoreUnchanged.actual.goalEvidence.offsideOrNoGoalCount, 1);
  assert.equal(scoreUnchanged.actual.scoreboardOcr.scoreUnchangedCount, 1);
  assert.equal(scoreUnchanged.actual.scoreboardOcr.scoreChangeCount, 0);
  assert.equal(scoreUnchanged.actual.candidatePlans[0].goalOutcome.outcome, "disallowed_offside");
});

test("evaluation report has aggregate metrics and no local path leakage", () => {
  const report = runEvaluation({ fixturesDir, minAggregateScore: 70 });
  assert.equal(report.passed, true);
  assert.ok(report.aggregate.aggregateScore >= 70);
  assert.equal(report.aggregate.fixtureCount >= 5, true);
  assert.equal(report.aggregate.falseGoalCaptionRate, 0);
  assert.equal(report.aggregate.falseVisualGoalRate, 0);
  assert.equal(report.aggregate.visualReasonPrecision >= 0.99, true);
  assert.equal(report.aggregate.visualLabelPrecision >= 0.99, true);
  assert.equal(typeof report.aggregate.frameExtractionFallbackUsageRate, "number");
  assert.equal(typeof report.aggregate.sampledFrameCount, "number");
  assert.equal(report.aggregate.highlightTypeAccuracy, 1);
  assert.equal(report.aggregate.framingSafety, 1);
  assert.equal(report.aggregate.cropSafetyScore, 1);
  assert.equal(report.aggregate.actionSafeZoneCoverage, 1);
  assert.equal(report.aggregate.textObstructionRisk, 0);
  assert.equal(typeof report.aggregate.wideSafeFallbackRate, "number");
  assert.equal(report.aggregate.trackingConfidenceCalibration, 1);
  assert.equal(report.aggregate.trackingOutputValidity, 1);
  assert.equal(report.aggregate.ballTrackCoverage, 1);
  assert.equal(report.aggregate.playerClusterCoverage, 1);
  assert.equal(report.aggregate.softFollowPrecision, 1);
  assert.equal(report.aggregate.wideSafeFallbackCorrectness, 1);
  assert.equal(report.aggregate.falseGoalFromTrackingRate, 0);
  assert.equal(report.aggregate.animationCueValidity, 1);
  assert.equal(report.aggregate.animationCueRelevance, 1);
  assert.equal(report.aggregate.goalSequenceRecall >= 0.95, true);
  assert.equal(report.aggregate.offsideOutcomeAccuracy >= 0.9, true);
  assert.equal(report.aggregate.disallowedGoalIncluded, 1);
  assert.equal(report.aggregate.decisionContextCoverage >= 0.9, true);
  assert.equal(report.aggregate.captionOutcomeAlignment >= 0.95, true);
  assert.equal(report.aggregate.postGoalWindowCoverage >= 0.9, true);
  assert.equal(report.aggregate.validGoalRecall, 1);
  assert.equal(report.aggregate.lateGoalRecall, 1);
  assert.equal(report.aggregate.falseGoalRate, 0);
  assert.equal(report.aggregate.offsideExclusionAccuracy, 1);
  assert.equal(report.aggregate.validGoalOnlyFillerRate, 0);
  assert.equal(report.aggregate.captionGoalClaimAccuracy, 1);
  assert.equal(report.aggregate.segmentTimingCoverage >= 0.95, true);
  assert.equal(report.aggregate.celebrationOnlyExclusion, 1);
  assert.equal(report.aggregate.anthemIntroExclusion, 1);
  assert.equal(report.aggregate.ocrEvidenceCoverage, 1);
  assert.equal(report.aggregate.scoreboardScoreChangeRecall, 1);
  assert.equal(report.aggregate.ambiguousOcrFailClosed, 1);
  assert.equal(report.aggregate.noFalseGoalFromOcrOnly, 1);
  assert.equal(report.aggregate.ocrQaCalibrationSupport, 1);
  assert.equal(report.aggregate.shotToPayoffCoverage >= 0.95, true);
  assert.equal(report.aggregate.actionWindowCoverage >= 0.95, true);
  assert.equal(report.aggregate.captionRoleValidity, 1);
  assert.equal(report.aggregate.captionEvidenceMetadataCompleteness, 1);
  assert.equal(report.aggregate.captionActionAlignment, 1);
  assert.equal(report.aggregate.genericCaptionPenaltyRate, 0);
  assert.equal(report.aggregate.captionSpecificityScore, 1);
  assert.equal(report.aggregate.reactionAsSupportScore, 1);
  assert.equal(report.aggregate.weakEvidenceNeutralityScore, 1);
  assert.equal(report.aggregate.providerFallbackRate, 0);
  assert.equal(report.aggregate.renderStylePresetValidity, 1);
  assert.equal(report.aggregate.unsupportedCueRate, 0);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(report), /OPENAI_API_KEY/);
});

test("football-aware eval helpers detect misleading goal captions and unsafe framing", () => {
  assert.equal(
    planHasGoalLanguage({
      hook: "WHAT A GOAL",
      captions: [{ text: "Goal changes everything" }],
    }),
    true,
  );
  assert.equal(
    planHasGoalLanguage({
      hook: "THE CROWD FELT THIS ONE",
      captions: [{ text: "Replay the angle from behind the goal" }],
    }),
    false,
  );
  assert.equal(
    framingIsSafe(
      {
        framingMode: "wide_safe",
        cropStrategy: { type: "wide_safe_contain", zoom: 1, preserveFullFrame: true, maxCropPercent: 0 },
      },
      { width: 1920, height: 1080 },
    ),
    true,
  );
  assert.equal(
    framingIsSafe(
      {
        framingMode: "safe_center",
        cropStrategy: { type: "center_crop", zoom: 1.5, maxCropPercent: 0.5 },
      },
      { width: 1920, height: 1080 },
    ),
    false,
  );
});

test("report shape is deterministic for fixed inputs", () => {
  const fixtures = loadFixtures(fixturesDir).slice(0, 2);
  const results = fixtures.map(scoreFixture);
  const first = buildReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-14T00:00:00.000Z" });
  const second = buildReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-14T00:00:00.000Z" });
  first.metadata.workspace = {};
  second.metadata.workspace = {};
  assert.deepEqual(first, second);
});

test("runner writes a JSON report", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "matchcuts-eval-"));
  const result = spawnSync("node", ["eval/run-eval.mjs", `--results=${resultsDir}`, "--threshold=70"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  assert.equal(summary.falseGoalCaptionRate, 0);
  assert.equal(summary.falseVisualGoalRate, 0);
  assert.equal(summary.visualReasonPrecision >= 0.99, true);
  assert.equal(summary.visualLabelPrecision >= 0.99, true);
  assert.equal(typeof summary.frameExtractionFallbackUsageRate, "number");
  assert.equal(typeof summary.sampledFrameCount, "number");
  assert.equal(summary.highlightTypeAccuracy, 1);
  assert.equal(summary.cropSafetyScore, 1);
  assert.equal(summary.actionSafeZoneCoverage, 1);
  assert.equal(summary.textObstructionRisk, 0);
  assert.equal(typeof summary.wideSafeFallbackRate, "number");
  assert.equal(summary.trackingConfidenceCalibration, 1);
  assert.equal(summary.trackingOutputValidity, 1);
  assert.equal(summary.ballTrackCoverage, 1);
  assert.equal(summary.playerClusterCoverage, 1);
  assert.equal(summary.softFollowPrecision, 1);
  assert.equal(summary.wideSafeFallbackCorrectness, 1);
  assert.equal(summary.falseGoalFromTrackingRate, 0);
  assert.equal(summary.animationCueRelevance, 1);
  assert.equal(summary.goalSequenceRecall >= 0.95, true);
  assert.equal(summary.offsideOutcomeAccuracy >= 0.9, true);
  assert.equal(summary.disallowedGoalIncluded, 1);
  assert.equal(summary.decisionContextCoverage >= 0.9, true);
  assert.equal(summary.captionOutcomeAlignment >= 0.95, true);
  assert.equal(summary.postGoalWindowCoverage >= 0.9, true);
  assert.equal(summary.validGoalRecall, 1);
  assert.equal(summary.lateGoalRecall, 1);
  assert.equal(summary.falseGoalRate, 0);
  assert.equal(summary.offsideExclusionAccuracy, 1);
  assert.equal(summary.validGoalOnlyFillerRate, 0);
  assert.equal(summary.captionGoalClaimAccuracy, 1);
  assert.equal(summary.segmentTimingCoverage >= 0.95, true);
  assert.equal(summary.celebrationOnlyExclusion, 1);
  assert.equal(summary.anthemIntroExclusion, 1);
  assert.equal(summary.ocrEvidenceCoverage, 1);
  assert.equal(summary.scoreboardScoreChangeRecall, 1);
  assert.equal(summary.ambiguousOcrFailClosed, 1);
  assert.equal(summary.noFalseGoalFromOcrOnly, 1);
  assert.equal(summary.ocrQaCalibrationSupport, 1);
  assert.equal(summary.shotToPayoffCoverage >= 0.95, true);
  assert.equal(summary.actionWindowCoverage >= 0.95, true);
  assert.equal(summary.captionRoleValidity, 1);
  assert.equal(summary.captionEvidenceMetadataCompleteness, 1);
  assert.equal(summary.captionActionAlignment, 1);
  assert.equal(summary.genericCaptionPenaltyRate, 0);
  assert.equal(summary.captionSpecificityScore, 1);
  assert.equal(summary.reactionAsSupportScore, 1);
  assert.equal(summary.weakEvidenceNeutralityScore, 1);
  assert.equal(summary.providerFallbackRate, 0);
  assert.equal(summary.renderStylePresetValidity, 1);
  assert.equal(summary.unsupportedCueRate, 0);
  const latest = JSON.parse(readFileSync(join(resultsDir, "latest.json"), "utf8"));
  assert.equal(latest.aggregate.fixtureCount >= 5, true);
});

test("runner exits non-zero when aggregate threshold fails", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "matchcuts-eval-fail-"));
  const result = spawnSync("node", ["eval/run-eval.mjs", `--results=${resultsDir}`, "--threshold=101"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, false);
});

test("report sanitizer redacts secrets and local paths", () => {
  const text = sanitizeReportText("/Users/example/project OPENAI_API_KEY=secret Bearer token123 person@example.com");
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /person@example/);
});
