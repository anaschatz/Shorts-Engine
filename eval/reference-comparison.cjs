const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, relative, resolve, sep } = require("node:path");
const { AppError } = require("../server/errors.cjs");
const { sanitizeReportText } = require("./scoring.cjs");

const REFERENCE_COMPARISON_SCHEMA_VERSION = 1;
const DEFAULT_PROOF_REPORT = "demo/results/youtube-live-e2e-latest.json";
const DEFAULT_REFERENCE_FIXTURE = "eval/reference-comparison-fixtures/football-multi-goal-reference.json";
const DEFAULT_RESULTS_DIR = "demo/results";
const DEFAULT_THRESHOLD = 75;

const SAFE_URL_PROTOCOLS = Object.freeze(["https:"]);
const SAFE_PATH_KEYS = new Set([
  "htmllatestpath",
  "htmlreportpath",
  "latestpath",
  "relativepath",
  "reportpath",
]);
const UNSAFE_KEY_RE =
  /(?:authorization|bearer|clientsecret|cookie|credential|privatekey|refresh|sessiontoken|signature|storagekey|accesstoken|accesskey|apikey|deploytoken|secret|token|rawlogs|rawerror|stderr|stdout|stack|outputpath|filepath|localpath|fullpath|absolutepath|password)/i;
const UNSAFE_VALUE_RE =
  /(?:\/Users\/|\/private\/|file:\/\/|Bearer\s+|gh[pousr]_|github_pat_|OPENAI_API_KEY|SHORTSENGINE_[A-Z0-9_]*(?:SECRET|TOKEN|ACCESS_KEY)\s*=|storageKey)/i;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, toNumber(value)));
}

function scoreToPercent(value) {
  return Math.round(clamp01(value) * 100);
}

function normalizeRelative(value) {
  return String(value || "").split(sep).join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function safeFailure(code, message, field) {
  return {
    code,
    message: sanitizeReportText(message, 220),
    ...(field ? { field: sanitizeReportText(field, 120) } : {}),
  };
}

function safeRelativeRef(rootDir, candidate, field = "relativePath") {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    /^file:\/\//i.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..")
  ) {
    return {
      ok: false,
      failure: safeFailure("REFERENCE_COMPARISON_REF_UNSAFE", "Reference comparison refs must be safe relative paths.", field),
    };
  }
  const resolvedRoot = resolve(rootDir);
  const resolvedFile = resolve(resolvedRoot, text);
  if (!isInside(resolvedRoot, resolvedFile)) {
    return {
      ok: false,
      failure: safeFailure("REFERENCE_COMPARISON_REF_UNSAFE", "Reference comparison refs must stay inside the workspace.", field),
    };
  }
  return {
    ok: true,
    relativePath: normalizeRelative(relative(resolvedRoot, resolvedFile)),
    resolvedFile,
  };
}

function safeOptionalRelativeRef(rootDir, candidate, field) {
  if (candidate === undefined || candidate === null || candidate === "") {
    return { ok: true, present: false, relativePath: null, resolvedFile: null };
  }
  const ref = safeRelativeRef(rootDir, candidate, field);
  return ref.ok ? { ...ref, present: true } : { ...ref, present: true };
}

function validateSafeUrl(value, field = "sourceUrl") {
  if (!value) return null;
  const text = sanitizeReportText(value, 240);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new AppError("VALIDATION_ERROR", `${field} must be a valid HTTPS URL.`, 400);
  }
  if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
    throw new AppError("VALIDATION_ERROR", `${field} must use HTTPS.`, 400);
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|signature|credential|api_key|access/i.test(key)) {
      throw new AppError("VALIDATION_ERROR", `${field} must not include secret-like query params.`, 400);
    }
  }
  return parsed.toString();
}

function validateRange(value, field, fallback) {
  const range = Array.isArray(value) ? value.map(Number) : fallback;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !range.every(Number.isFinite) ||
    range[0] < 0 ||
    range[1] < range[0]
  ) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a valid [min,max] range.`, 400);
  }
  return [round(range[0], 3), round(range[1], 3)];
}

function validateReferenceFixture(fixture, { rootDir = process.cwd() } = {}) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new AppError("VALIDATION_ERROR", "Reference comparison fixture must be an object.", 400);
  }
  if (fixture.schemaVersion !== undefined && Number(fixture.schemaVersion) !== REFERENCE_COMPARISON_SCHEMA_VERSION) {
    throw new AppError("VALIDATION_ERROR", "Reference comparison fixture schemaVersion must be 1.", 400);
  }
  const id = sanitizeReportText(fixture.id, 100);
  if (!/^[a-z0-9][a-z0-9_-]{2,100}$/i.test(id)) {
    throw new AppError("VALIDATION_ERROR", "Reference comparison fixture id is invalid.", 400);
  }
  const expected = fixture.expected;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new AppError("VALIDATION_ERROR", "Reference comparison fixture expected block is required.", 400);
  }
  const localReference = safeOptionalRelativeRef(rootDir, fixture.localReferenceRelativePath, "localReferenceRelativePath");
  if (!localReference.ok) {
    throw new AppError("VALIDATION_ERROR", localReference.failure.message, 400, localReference.failure);
  }
  const thresholds = expected.thresholds && typeof expected.thresholds === "object" ? expected.thresholds : {};
  return {
    schemaVersion: REFERENCE_COMPARISON_SCHEMA_VERSION,
    id,
    title: sanitizeReportText(fixture.title || id, 160),
    sport: sanitizeReportText(fixture.sport || "football", 40),
    sourceUrl: validateSafeUrl(fixture.sourceUrl),
    localReference: {
      present: localReference.present,
      relativePath: localReference.relativePath,
      exists: Boolean(localReference.present && existsSync(localReference.resolvedFile)),
    },
    expected: {
      durationRange: validateRange(expected.durationRange, "expected.durationRange", [45, 100]),
      aspectRatio: sanitizeReportText(expected.aspectRatio || "9:16", 20),
      expectedCountedGoals: Math.max(0, Math.floor(toNumber(expected.expectedCountedGoals, 0))),
      segmentDurationRange: validateRange(expected.segmentDurationRange, "expected.segmentDurationRange", [16, 32]),
      maxReplayOnlySegments: Math.max(0, Math.floor(toNumber(expected.maxReplayOnlySegments, 0))),
      minMotionEvents: Math.max(1, Math.floor(toNumber(expected.minMotionEvents, 5))),
      pacingProfile: sanitizeReportText(expected.pacingProfile || "multi_goal_story", 80),
      captionStyle: sanitizeReportText(expected.captionStyle || "specific_action_captions", 80),
      transitionStyle: sanitizeReportText(expected.transitionStyle || "smooth_short_fades", 80),
      goalPhaseBehavior: sanitizeReportText(expected.goalPhaseBehavior || "buildup_shot_finish_confirmation", 120),
      thresholds: {
        validGoalRecall: toNumber(thresholds.validGoalRecall, 1),
        replayOnlySegments: Math.max(0, Math.floor(toNumber(thresholds.replayOnlySegments, 0))),
        cropSafetyScore: toNumber(thresholds.cropSafetyScore, 0.9),
        phaseCoverageScore: toNumber(thresholds.phaseCoverageScore, 0.9),
        captionActionAlignment: toNumber(thresholds.captionActionAlignment, 0.9),
        transitionPolishScore: toNumber(thresholds.transitionPolishScore, 0.8),
        referenceSimilarityScore: toNumber(thresholds.referenceSimilarityScore, 0.75),
      },
    },
    notes: Array.isArray(fixture.notes)
      ? fixture.notes.slice(0, 12).map((note) => sanitizeReportText(note, 220)).filter(Boolean)
      : [],
  };
}

function loadJson(filePath, missingCode) {
  if (!existsSync(filePath)) {
    throw new AppError(missingCode, "Required reference comparison input is missing.", 400);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Reference comparison input is not valid JSON.", 400);
  }
}

function extractProofPayload(proofReport) {
  return proofReport.proofOutput || proofReport.outputProof || proofReport;
}

function extractRenderPlan(proofReport, proofOutput) {
  return (
    proofReport.smoke && proofReport.smoke.renderPlan ||
    proofOutput.renderPlan ||
    proofOutput.renderPlanSummary ||
    {}
  );
}

function extractSegments(renderPlan, proofOutput) {
  const candidates =
    proofOutput.segmentWindows ||
    renderPlan.segments ||
    renderPlan.countedGoalProof && renderPlan.countedGoalProof.selectedTimelineWindows ||
    [];
  return (Array.isArray(candidates) ? candidates : []).map((segment, index) => ({
    index: Math.floor(toNumber(segment.index, index + 1)),
    sourceStart: round(segment.sourceStart, 3),
    sourceEnd: round(segment.sourceEnd, 3),
    duration: round(segment.duration || toNumber(segment.sourceEnd) - toNumber(segment.sourceStart), 3),
    goalNumber: segment.goalNumber === undefined ? null : Math.floor(toNumber(segment.goalNumber, index + 1)),
    replayUsed: Boolean(segment.replayUsed),
    replayOnly: Boolean(segment.replayOnly),
    highlightType: sanitizeReportText(segment.highlightType || "", 80),
    outcome: sanitizeReportText(segment.goalOutcome && segment.goalOutcome.outcome || segment.outcome || "", 80),
    phaseCoverage: {
      hasBuildup: Boolean(segment.phaseCoverage && segment.phaseCoverage.hasBuildup),
      hasShot: Boolean(segment.phaseCoverage && segment.phaseCoverage.hasShot),
      hasFinish: Boolean(segment.phaseCoverage && segment.phaseCoverage.hasFinish),
      hasConfirmation: Boolean(segment.phaseCoverage && segment.phaseCoverage.hasConfirmation),
    },
  }));
}

function aspectLabel(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return "unknown";
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) <= 0.04) return "9:16";
  if (Math.abs(ratio - 16 / 9) <= 0.06) return "16:9";
  if (Math.abs(ratio - 1) <= 0.05) return "1:1";
  return `${Math.round(width)}:${Math.round(height)}`;
}

function rangeScore(value, [min, max]) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= min && value <= max) return 1;
  const span = Math.max(1, max - min);
  const distance = value < min ? min - value : value - max;
  return round(Math.max(0, 1 - distance / span));
}

function scorePhaseCoverage(segments) {
  if (!segments.length) return 0;
  const total = segments.length * 4;
  const covered = segments.reduce((sum, segment) => (
    sum +
    (segment.phaseCoverage.hasBuildup ? 1 : 0) +
    (segment.phaseCoverage.hasShot ? 1 : 0) +
    (segment.phaseCoverage.hasFinish ? 1 : 0) +
    (segment.phaseCoverage.hasConfirmation ? 1 : 0)
  ), 0);
  return round(covered / total);
}

function scoreCropSafety(renderPlan, proofOutput, generated) {
  const safetyFlags = (Array.isArray(renderPlan.segments) ? renderPlan.segments : [])
    .flatMap((segment) => Array.isArray(segment.safetyFlags) ? segment.safetyFlags : []);
  const wideSafe =
    /wide_safe/i.test(renderPlan.framingMode || "") ||
    /wide_safe/i.test(renderPlan.cropPlanMode || "") ||
    safetyFlags.some((flag) => /wide_safe/i.test(flag));
  if (wideSafe && generated.aspectLabel === "9:16") return 1;
  if (wideSafe) return 0.85;
  if (proofOutput.visualPolishQA && toNumber(proofOutput.visualPolishQA.replayOnlyRiskCount, 0) === 0) return 0.75;
  return 0.5;
}

function scoreCaptionAlignment(proofOutput) {
  const qa = proofOutput.visualPolishQA || proofOutput.referenceStyleQA || {};
  if (Number.isFinite(Number(qa.captionActionAlignmentScore))) {
    return clamp01(Number(qa.captionActionAlignmentScore));
  }
  const aligned = toNumber(proofOutput.captionsAlignedCount ?? qa.captionsAlignedCount, 0);
  const misaligned = toNumber(proofOutput.captionsMisalignedCount ?? qa.captionsMisalignedCount, 0);
  const total = aligned + misaligned;
  if (total > 0) return round(aligned / total);
  return 0.5;
}

function scoreTransitionPolish(proofOutput, segmentCount) {
  const expectedTransitions = Math.max(0, segmentCount - 1);
  if (expectedTransitions === 0) return 1;
  const rendered = toNumber(proofOutput.transitionRenderedCount ?? proofOutput.renderPolishQA?.transitionRenderedCount, 0);
  const hardFallback = toNumber(proofOutput.hardCutFallbackCount ?? proofOutput.renderPolishQA?.hardCutFallbackCount, 0);
  const coverage = Math.min(1, rendered / expectedTransitions);
  const hardPenalty = Math.min(1, hardFallback / expectedTransitions);
  return round(coverage * (1 - hardPenalty));
}

function scoreMotionDensity(proofOutput, expected) {
  const animated = toNumber(proofOutput.animatedCaptionCount ?? proofOutput.renderPolishQA?.animatedCaptionCount, 0);
  const overlays = toNumber(proofOutput.overlayRenderedCount ?? proofOutput.renderPolishQA?.overlayRenderedCount, 0);
  return round(Math.min(1, (animated + overlays) / expected.minMotionEvents));
}

function scoreCutSmoothness(proofOutput, segmentCount) {
  const abrupt = toNumber(proofOutput.abruptCutRiskCount ?? proofOutput.visualPolishQA?.abruptCutRiskCount, 0);
  if (abrupt <= 0) return 1;
  return round(Math.max(0, 1 - abrupt / Math.max(1, segmentCount * 2)));
}

function extractGeneratedVideo(rootDir, proofOutput) {
  const candidate =
    proofOutput.outputMp4 && proofOutput.outputMp4.relativePath ||
    proofOutput.generatedVideoPath ||
    proofOutput.referenceStyleQA && proofOutput.referenceStyleQA.generatedVideoPath ||
    proofOutput.ffprobe && proofOutput.ffprobe.relativePath;
  const ref = safeRelativeRef(rootDir, candidate, "generated.relativePath");
  if (!ref.ok) throw new AppError("VALIDATION_ERROR", ref.failure.message, 400, ref.failure);
  return {
    relativePath: ref.relativePath,
    exists: existsSync(ref.resolvedFile),
    sizeBytes: toNumber(proofOutput.outputMp4 && proofOutput.outputMp4.sizeBytes || proofOutput.ffprobe && proofOutput.ffprobe.sizeBytes, null),
  };
}

function analyzeGeneratedVideo({ proofReport, fixture, rootDir = process.cwd() }) {
  const proofOutput = extractProofPayload(proofReport);
  const renderPlan = extractRenderPlan(proofReport, proofOutput);
  const segments = extractSegments(renderPlan, proofOutput);
  const ffprobe = proofOutput.ffprobe || {};
  const width = toNumber(ffprobe.width, 0);
  const height = toNumber(ffprobe.height, 0);
  const generated = {
    ...extractGeneratedVideo(rootDir, proofOutput),
    durationSeconds: toNumber(ffprobe.durationSeconds || renderPlan.totalDuration || proofOutput.durationSeconds, 0),
    width,
    height,
    aspectRatio: height > 0 ? round(width / height, 4) : null,
    aspectLabel: aspectLabel(width, height),
    audioPresent: ffprobe.audioPresent === undefined ? null : Boolean(ffprobe.audioPresent),
    segmentCount: toNumber(renderPlan.segmentCount || segments.length, segments.length),
    countedGoalsFound: toNumber(proofOutput.countedGoalsFound, 0),
    countedGoalsIncluded: toNumber(proofOutput.countedGoalsIncluded, 0),
    expectedCountedGoals: toNumber(proofOutput.expectedCountedGoals, fixture.expected.expectedCountedGoals),
    replayOnlySegments: toNumber(proofOutput.replayOnlySegments, segments.filter((segment) => segment.replayOnly).length),
    averageSegmentDuration: segments.length
      ? round(segments.reduce((sum, segment) => sum + Math.max(0, segment.duration), 0) / segments.length, 3)
      : toNumber(proofOutput.averageGoalSegmentDuration, 0),
    renderStylePreset: sanitizeReportText(proofOutput.renderStylePreset || renderPlan.stylePreset || "", 80),
    captionCount: toNumber(renderPlan.captionCount || (Array.isArray(renderPlan.captions) ? renderPlan.captions.length : 0), 0),
    animatedCaptionCount: toNumber(proofOutput.animatedCaptionCount ?? proofOutput.renderPolishQA?.animatedCaptionCount, 0),
    overlayRenderedCount: toNumber(proofOutput.overlayRenderedCount ?? proofOutput.renderPolishQA?.overlayRenderedCount, 0),
    transitionRenderedCount: toNumber(proofOutput.transitionRenderedCount ?? proofOutput.renderPolishQA?.transitionRenderedCount, 0),
    hardCutFallbackCount: toNumber(proofOutput.hardCutFallbackCount ?? proofOutput.renderPolishQA?.hardCutFallbackCount, 0),
    abruptCutRiskCount: toNumber(proofOutput.abruptCutRiskCount ?? proofOutput.visualPolishQA?.abruptCutRiskCount, 0),
  };
  const expectedGoals = Math.max(1, fixture.expected.expectedCountedGoals || generated.expectedCountedGoals || 1);
  const validGoalRecall = fixture.expected.expectedCountedGoals > 0
    ? clamp01(generated.countedGoalsIncluded / expectedGoals)
    : 1;
  const phaseCoverageScore = scorePhaseCoverage(segments);
  const cropSafetyScore = scoreCropSafety(renderPlan, proofOutput, generated);
  const captionActionAlignment = scoreCaptionAlignment(proofOutput);
  const transitionPolishScore = scoreTransitionPolish(proofOutput, generated.segmentCount);
  const motionDensityScore = scoreMotionDensity(proofOutput, fixture.expected);
  const cutSmoothnessScore = scoreCutSmoothness(proofOutput, generated.segmentCount);
  const durationFitScore = rangeScore(generated.durationSeconds, fixture.expected.durationRange);
  const segmentPacingScore = rangeScore(generated.averageSegmentDuration, fixture.expected.segmentDurationRange);
  const pacingScore = round(durationFitScore * 0.4 + segmentPacingScore * 0.6);
  const replayDisciplineScore = generated.segmentCount > 0
    ? round(Math.max(0, generated.segmentCount - generated.replayOnlySegments) / generated.segmentCount)
    : 0;
  const aspectRatioScore = generated.aspectLabel === fixture.expected.aspectRatio ? 1 : 0;
  const referenceSimilarityScore = round(
    validGoalRecall * 0.18 +
      phaseCoverageScore * 0.16 +
      replayDisciplineScore * 0.12 +
      aspectRatioScore * 0.1 +
      cropSafetyScore * 0.1 +
      captionActionAlignment * 0.12 +
      transitionPolishScore * 0.08 +
      motionDensityScore * 0.08 +
      cutSmoothnessScore * 0.06,
  );
  return {
    generated,
    segments,
    metrics: {
      validGoalRecall: round(validGoalRecall),
      replayOnlySegmentCount: generated.replayOnlySegments,
      aspectRatioScore,
      cropSafetyScore,
      phaseCoverageScore,
      pacingScore,
      durationFitScore,
      segmentPacingScore,
      cutSmoothnessScore,
      captionActionAlignment,
      transitionPolishScore,
      motionDensityScore,
      referenceSimilarityScore,
      aggregateScore: scoreToPercent(referenceSimilarityScore),
    },
  };
}

function failedCriteriaFor(metrics, fixture) {
  const thresholds = fixture.expected.thresholds;
  const failed = [];
  const checks = [
    ["validGoalRecall", metrics.validGoalRecall, thresholds.validGoalRecall, "Valid counted goal recall is below the reference expectation."],
    ["cropSafetyScore", metrics.cropSafetyScore, thresholds.cropSafetyScore, "Crop safety is below the wide-safe reference threshold."],
    ["phaseCoverageScore", metrics.phaseCoverageScore, thresholds.phaseCoverageScore, "Goal phase coverage is missing buildup, shot, finish or confirmation."],
    ["captionActionAlignment", metrics.captionActionAlignment, thresholds.captionActionAlignment, "Captions are not aligned tightly enough to visible action."],
    ["transitionPolishScore", metrics.transitionPolishScore, thresholds.transitionPolishScore, "Transitions are not polished enough for the reference style."],
    ["referenceSimilarityScore", metrics.referenceSimilarityScore, thresholds.referenceSimilarityScore, "Overall reference-style similarity is below threshold."],
  ];
  for (const [metric, score, min, note] of checks) {
    if (score < min) failed.push({ metric, score: round(score), min, note });
  }
  if (metrics.replayOnlySegmentCount > thresholds.replayOnlySegments) {
    failed.push({
      metric: "replayOnlySegmentCount",
      score: metrics.replayOnlySegmentCount,
      max: thresholds.replayOnlySegments,
      note: "Replay-only segments exceed the reference goal-story contract.",
    });
  }
  if (metrics.aspectRatioScore < 1) {
    failed.push({
      metric: "aspectRatioScore",
      score: metrics.aspectRatioScore,
      min: 1,
      note: "Generated video is not in the expected short-form aspect ratio.",
    });
  }
  return failed;
}

function suggestedFixes(metrics, generated) {
  const fixes = [];
  if (metrics.validGoalRecall < 1) {
    fixes.push({
      id: "recover_missing_counted_goals",
      target: "analysis.match_event_truth_goal_coverage",
      note: "Use the score-change timeline and full-source sampling to recover every counted goal.",
    });
  }
  if (metrics.phaseCoverageScore < 0.95) {
    fixes.push({
      id: "extend_goal_phase_reconstruction",
      target: "analysis.goal_phase_reconstruction",
      note: "Backtrack from confirmation to include buildup, shot setup, finish and confirmation.",
    });
  }
  if (generated.replayOnlySegments > 0) {
    fixes.push({
      id: "demote_replay_only_segments",
      target: "analysis.replay_demotion",
      note: "Use replay as support only after the live action origin is found.",
    });
  }
  if (metrics.cutSmoothnessScore < 0.8 || generated.abruptCutRiskCount > 0) {
    fixes.push({
      id: "smooth_action_boundaries",
      target: "edit_plan.segment_boundaries",
      note: "Move segment starts earlier or add transition padding so cuts do not snap into action.",
    });
  }
  if (metrics.captionActionAlignment < 0.95) {
    fixes.push({
      id: "tighten_caption_action_alignment",
      target: "caption_generation.action_timing",
      note: "Generate captions from segment phase metadata instead of generic hype.",
    });
  }
  if (metrics.motionDensityScore < 0.8 || metrics.transitionPolishScore < 0.9) {
    fixes.push({
      id: "increase_reference_motion_polish",
      target: "render.reference_style_motion",
      note: "Add bounded kinetic captions, overlays and smooth transitions without hiding the ball.",
    });
  }
  return fixes.slice(0, 8);
}

function warningNotes(metrics, generated) {
  const warnings = [];
  if (generated.abruptCutRiskCount > 0) {
    warnings.push(`Abrupt cut risk reported on ${generated.abruptCutRiskCount} segment(s).`);
  }
  if (generated.averageSegmentDuration > 0 && generated.averageSegmentDuration < 18) {
    warnings.push("Average goal segment duration is shorter than a full goal phase reference.");
  }
  if (generated.hardCutFallbackCount > 0) {
    warnings.push("Renderer reported hard-cut fallback transitions.");
  }
  if (metrics.motionDensityScore < 1) {
    warnings.push("Motion density is below the reference target.");
  }
  return warnings.map((note) => sanitizeReportText(note, 180));
}

function buildReferenceComparisonReport({
  proofReport,
  fixture,
  rootDir = process.cwd(),
  timestamp = new Date().toISOString(),
  minAggregateScore = DEFAULT_THRESHOLD,
} = {}) {
  const analysis = analyzeGeneratedVideo({ proofReport, fixture, rootDir });
  const failedCriteria = failedCriteriaFor(analysis.metrics, fixture);
  const warnings = warningNotes(analysis.metrics, analysis.generated);
  const thresholdFailed = analysis.metrics.aggregateScore < minAggregateScore;
  const passed = !thresholdFailed && failedCriteria.length === 0;
  const report = {
    schemaVersion: REFERENCE_COMPARISON_SCHEMA_VERSION,
    timestamp,
    generatedAt: timestamp,
    command: "npm run compare:reference",
    phase: "reference_video_comparison",
    status: passed ? "passed" : "failed",
    passed,
    skipped: false,
    threshold: minAggregateScore,
    input: {
      proofReport: {
        relativePath: DEFAULT_PROOF_REPORT,
      },
      referenceFixture: {
        id: fixture.id,
        title: fixture.title,
        sport: fixture.sport,
        sourceUrl: fixture.sourceUrl,
        localReference: fixture.localReference,
        referenceMode: fixture.localReference.present && fixture.localReference.exists ? "local_reference_video" : "metadata_reference",
      },
    },
    reference: {
      expected: fixture.expected,
      notes: fixture.notes,
    },
    generated: analysis.generated,
    segments: analysis.segments,
    metrics: analysis.metrics,
    failedCriteria: [
      ...failedCriteria,
      ...(thresholdFailed
        ? [{
            metric: "aggregateScore",
            score: analysis.metrics.aggregateScore,
            min: minAggregateScore,
            note: "Aggregate reference comparison score is below threshold.",
          }]
        : []),
    ],
    warnings,
    suggestedNextFixes: suggestedFixes(analysis.metrics, analysis.generated),
    sideBySide: {
      htmlLatestPath: null,
      htmlReportPath: null,
      generatedVideo: { relativePath: analysis.generated.relativePath },
      referenceVideo: fixture.localReference.present
        ? { relativePath: fixture.localReference.relativePath, exists: fixture.localReference.exists }
        : null,
      referenceUrl: fixture.sourceUrl,
    },
    artifacts: {
      logsDownloaded: false,
      artifactsDownloaded: false,
      rawProviderOutputIncluded: false,
      externalReferenceDownloaded: false,
      rawExternalVideoStored: false,
    },
    nextAction: passed
      ? (warnings.length ? "Inspect warnings, especially cut smoothness, then prioritize the suggested next fixes." : "Use this as reference comparison evidence.")
      : "Fix failed criteria and rerun npm run compare:reference.",
  };
  const leak = findReferenceComparisonLeak(report);
  if (leak) {
    report.status = "failed";
    report.passed = false;
    report.failedCriteria.push({
      metric: "reportSafety",
      score: 0,
      min: 1,
      note: "Reference comparison report contained unsafe data.",
    });
    report.failedCases = [{
      code: "REFERENCE_COMPARISON_REPORT_LEAK",
      message: "Reference comparison report contained unsafe data.",
      leakCode: leak.code,
      leakPath: leak.path,
    }];
    report.nextAction = "Remove unsafe report fields and rerun npm run compare:reference.";
  }
  return report;
}

function findReferenceComparisonLeak(value, state = {}) {
  const path = state.path || "$";
  const depth = state.depth || 0;
  const seen = state.seen || new WeakSet();
  if (value === null || value === undefined || depth > 12) return null;
  if (typeof value === "string") {
    return UNSAFE_VALUE_RE.test(value) ? { code: "UNSAFE_VALUE", path } : null;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findReferenceComparisonLeak(value[index], { path: `${path}[${index}]`, depth: depth + 1, seen });
      if (leak) return leak;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!SAFE_PATH_KEYS.has(normalized) && UNSAFE_KEY_RE.test(normalized)) {
      return { code: "UNSAFE_KEY", path: `${path}.${key}` };
    }
    const leak = findReferenceComparisonLeak(item, { path: `${path}.${key}`, depth: depth + 1, seen });
    if (leak) return leak;
  }
  return null;
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // The write below will surface the real filesystem failure.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlVideoSrc(rootDir, resultsDir, relativePath) {
  if (!relativePath) return null;
  return normalizeRelative(relative(resolve(resultsDir), resolve(rootDir, relativePath)));
}

function renderMetricRows(metrics) {
  return Object.entries(metrics)
    .map(([key, value]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("\n");
}

function renderList(items, emptyText) {
  if (!items || !items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item.note || item)}</li>`).join("")}</ul>`;
}

function buildReferenceComparisonHtml(report, resultsDir, rootDir = process.cwd()) {
  const generatedSrc = htmlVideoSrc(rootDir, resultsDir, report.generated.relativePath);
  const referenceSrc = report.sideBySide.referenceVideo && report.sideBySide.referenceVideo.exists
    ? htmlVideoSrc(rootDir, resultsDir, report.sideBySide.referenceVideo.relativePath)
    : null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ShortsEngine Reference Comparison</title>
  <style>
    :root { color-scheme: dark; --bg: #101214; --panel: #171b20; --text: #f4f7fb; --muted: #aeb8c5; --line: #2c3540; --good: #65d488; --warn: #f2c46d; --bad: #ff8b8b; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 40px; }
    header { display: grid; gap: 8px; margin-bottom: 20px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: clamp(1.5rem, 2vw + 1rem, 2.4rem); }
    h2 { font-size: 1rem; }
    .muted { color: var(--muted); margin: 0; }
    .status { display: inline-flex; width: fit-content; align-items: center; min-height: 32px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; color: ${report.passed ? "var(--good)" : "var(--bad)"}; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    section { margin-top: 16px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    video { width: 100%; max-height: 70vh; background: #000; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 8px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-weight: 600; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    a { color: #8cc8ff; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } main { width: min(100vw - 20px, 1180px); } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Reference Comparison</h1>
      <p class="muted">${escapeHtml(report.input.referenceFixture.title)}</p>
      <span class="status">${escapeHtml(report.status)} · score ${escapeHtml(report.metrics.aggregateScore)}/100</span>
    </header>
    <div class="grid">
      <section>
        <h2>Generated Short</h2>
        ${generatedSrc ? `<video controls preload="metadata" src="${escapeHtml(generatedSrc)}"></video>` : `<p class="muted">Generated video ref missing.</p>`}
        <p class="muted">${escapeHtml(report.generated.relativePath)}</p>
      </section>
      <section>
        <h2>Reference</h2>
        ${referenceSrc ? `<video controls preload="metadata" src="${escapeHtml(referenceSrc)}"></video>` : `<p class="muted">Reference video is metadata-only. External videos are not downloaded automatically.</p>`}
        ${report.sideBySide.referenceUrl ? `<p><a href="${escapeHtml(report.sideBySide.referenceUrl)}" rel="noreferrer">Open reference URL</a></p>` : ""}
      </section>
    </div>
    <section>
      <h2>Metrics</h2>
      <table><tbody>${renderMetricRows(report.metrics)}</tbody></table>
    </section>
    <section>
      <h2>Differences</h2>
      ${renderList(report.failedCriteria, "No failed criteria.")}
      ${renderList(report.warnings, "No warnings.")}
    </section>
    <section>
      <h2>Next Fixes</h2>
      ${renderList(report.suggestedNextFixes, "No suggested fixes.")}
    </section>
  </main>
</body>
</html>
`;
}

function writeReferenceComparisonReport(report, {
  resultsDir = DEFAULT_RESULTS_DIR,
  rootDir = process.cwd(),
} = {}) {
  const outputRef = safeRelativeRef(rootDir, resultsDir, "resultsDir");
  if (!outputRef.ok) throw new AppError("VALIDATION_ERROR", outputRef.failure.message, 400);
  mkdirSync(outputRef.resolvedFile, { recursive: true });
  const stamp = safeTimestamp(report.generatedAt);
  const latestRef = safeRelativeRef(rootDir, join(resultsDir, "reference-comparison-latest.json"), "latest");
  const reportRef = safeRelativeRef(rootDir, join(resultsDir, `reference-comparison-${stamp}.json`), "report");
  const htmlLatestRef = safeRelativeRef(rootDir, join(resultsDir, "reference-comparison-latest.html"), "htmlLatest");
  const htmlReportRef = safeRelativeRef(rootDir, join(resultsDir, `reference-comparison-${stamp}.html`), "htmlReport");
  for (const ref of [latestRef, reportRef, htmlLatestRef, htmlReportRef]) {
    if (!ref.ok) throw new AppError("VALIDATION_ERROR", ref.failure.message, 400);
  }
  const reportWithArtifacts = {
    ...report,
    sideBySide: {
      ...report.sideBySide,
      htmlLatestPath: htmlLatestRef.relativePath,
      htmlReportPath: htmlReportRef.relativePath,
    },
  };
  const leak = findReferenceComparisonLeak(reportWithArtifacts);
  if (leak) {
    const failedReport = {
      schemaVersion: REFERENCE_COMPARISON_SCHEMA_VERSION,
      timestamp: report.generatedAt || new Date().toISOString(),
      generatedAt: report.generatedAt || new Date().toISOString(),
      command: "npm run compare:reference",
      phase: "reference_video_comparison",
      status: "failed",
      passed: false,
      skipped: false,
      failedCases: [{
        code: "REFERENCE_COMPARISON_REPORT_LEAK",
        message: "Reference comparison report contained unsafe data and was not written.",
        leakCode: leak.code,
        leakPath: leak.path,
      }],
    };
    const payload = `${JSON.stringify(failedReport, null, 2)}\n`;
    safeWriteReportFile(latestRef.resolvedFile, payload);
    safeWriteReportFile(reportRef.resolvedFile, payload);
    return { latestPath: latestRef.relativePath, reportPath: reportRef.relativePath, htmlLatestPath: null, htmlReportPath: null, report: failedReport };
  }
  const jsonPayload = `${JSON.stringify(reportWithArtifacts, null, 2)}\n`;
  const htmlPayload = buildReferenceComparisonHtml(reportWithArtifacts, outputRef.resolvedFile, rootDir);
  safeWriteReportFile(latestRef.resolvedFile, jsonPayload);
  safeWriteReportFile(reportRef.resolvedFile, jsonPayload);
  safeWriteReportFile(htmlLatestRef.resolvedFile, htmlPayload);
  safeWriteReportFile(htmlReportRef.resolvedFile, htmlPayload);
  return {
    latestPath: latestRef.relativePath,
    reportPath: reportRef.relativePath,
    htmlLatestPath: htmlLatestRef.relativePath,
    htmlReportPath: htmlReportRef.relativePath,
    report: reportWithArtifacts,
  };
}

function runReferenceComparison({
  rootDir = process.cwd(),
  proofReport = DEFAULT_PROOF_REPORT,
  fixturePath = DEFAULT_REFERENCE_FIXTURE,
  resultsDir = DEFAULT_RESULTS_DIR,
  minAggregateScore = DEFAULT_THRESHOLD,
  timestamp,
  write = true,
} = {}) {
  const proofRef = safeRelativeRef(rootDir, proofReport, "proofReport");
  if (!proofRef.ok) throw new AppError("VALIDATION_ERROR", proofRef.failure.message, 400);
  const fixtureRef = safeRelativeRef(rootDir, fixturePath, "fixturePath");
  if (!fixtureRef.ok) throw new AppError("VALIDATION_ERROR", fixtureRef.failure.message, 400);
  const proof = loadJson(proofRef.resolvedFile, "REFERENCE_COMPARISON_REPORT_MISSING");
  const fixture = validateReferenceFixture(loadJson(fixtureRef.resolvedFile, "REFERENCE_COMPARISON_FIXTURE_MISSING"), { rootDir });
  const report = buildReferenceComparisonReport({
    proofReport: proof,
    fixture,
    rootDir,
    timestamp,
    minAggregateScore,
  });
  report.input.proofReport.relativePath = proofRef.relativePath;
  const output = write ? writeReferenceComparisonReport(report, { resultsDir, rootDir }) : null;
  return { fixture, report: output ? output.report : report, output };
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "REFERENCE_COMPARISON_FAILED",
    message: sanitizeReportText(error && (error.userMessage || error.message) || "Reference comparison failed.", 240),
    nextAction: "rerun-youtube-proof-or-fix-reference-fixture-then-run-compare-reference",
  };
}

module.exports = {
  DEFAULT_PROOF_REPORT,
  DEFAULT_REFERENCE_FIXTURE,
  DEFAULT_RESULTS_DIR,
  DEFAULT_THRESHOLD,
  REFERENCE_COMPARISON_SCHEMA_VERSION,
  analyzeGeneratedVideo,
  buildReferenceComparisonHtml,
  buildReferenceComparisonReport,
  findReferenceComparisonLeak,
  runReferenceComparison,
  safeError,
  safeRelativeRef,
  validateReferenceFixture,
  writeReferenceComparisonReport,
};
