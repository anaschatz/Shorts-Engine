const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { createCandidateEditPlans, detectHighlights } = require("../server/analysis.cjs");
const {
  CAPTION_EMPHASIS,
  CAPTION_LAYOUTS,
  CAPTION_ROLES,
  RENDER_STYLE_PRESETS,
  hasGoalLanguage,
} = require("../server/edit-plan.cjs");
const { AppError } = require("../server/errors.cjs");
const { validateVisualSignals } = require("../server/vision.cjs");

const DEFAULT_THRESHOLDS = Object.freeze({
  minAggregateScore: 78,
  minTop1Overlap: 0.35,
  minTop3Recall: 0.67,
  minReasonPrecision: 0.5,
  minRetentionScore: 55,
});

const REQUIRED_FIXTURE_FIELDS = Object.freeze([
  "id",
  "title",
  "language",
  "durationSeconds",
  "transcript",
  "mediaSignals",
  "expected",
  "thresholds",
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function scoreToPercent(score) {
  return Math.max(0, Math.min(100, Math.round(toNumber(score) * 100)));
}

function sanitizeReportText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/OPENAI_API_KEY=[^\s]+/g, "OPENAI_API_KEY=[redacted]")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validateWindow(window, label) {
  if (!window || typeof window !== "object") {
    throw new AppError("VALIDATION_ERROR", `${label} must be an object.`, 400);
  }
  const start = toNumber(window.start, Number.NaN);
  const end = toNumber(window.end, Number.NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new AppError("VALIDATION_ERROR", `${label} has an invalid start/end range.`, 400);
  }
  return { start, end };
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new AppError("VALIDATION_ERROR", "Fixture must be an object.", 400);
  }
  for (const field of REQUIRED_FIXTURE_FIELDS) {
    if (!(field in fixture)) throw new AppError("VALIDATION_ERROR", `Fixture missing ${field}.`, 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(String(fixture.id))) {
    throw new AppError("VALIDATION_ERROR", "Fixture id is invalid.", 400);
  }
  if (!Array.isArray(fixture.transcript.captions) || fixture.transcript.captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture transcript needs captions.", 400);
  }
  if (!Array.isArray(fixture.expected.highlights) || fixture.expected.highlights.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture expected highlights are required.", 400);
  }
  fixture.expected.highlights.forEach((highlight, index) => validateWindow(highlight, `expected.highlights[${index}]`));
  if (!Array.isArray(fixture.expected.reasonCodes) || fixture.expected.reasonCodes.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture expected reason codes are required.", 400);
  }
  return true;
}

function overlapRatio(candidate, expected) {
  const left = Math.max(toNumber(candidate.start), toNumber(expected.start));
  const right = Math.min(toNumber(candidate.end), toNumber(expected.end));
  const intersection = Math.max(0, right - left);
  const expectedDuration = Math.max(0.001, toNumber(expected.end) - toNumber(expected.start));
  return round(intersection / expectedDuration, 4);
}

function bestOverlap(candidate, expectedWindows) {
  return Math.max(0, ...(expectedWindows || []).map((expected) => overlapRatio(candidate, expected)));
}

function top3Recall(moments, expectedWindows, minOverlap) {
  const top = (moments || []).slice(0, 3);
  if (!expectedWindows || expectedWindows.length === 0) return 0;
  const covered = expectedWindows.filter((expected) => top.some((moment) => overlapRatio(moment, expected) >= minOverlap));
  return round(covered.length / expectedWindows.length, 4);
}

function reasonCodePrecision(actualReasons, expectedReasons) {
  const actual = [...new Set(actualReasons || [])];
  const expected = new Set(expectedReasons || []);
  if (!actual.length) return 0;
  const matches = actual.filter((reason) => expected.has(reason)).length;
  return round(matches / actual.length, 4);
}

function reasonCodeRecall(actualReasons, expectedReasons) {
  const actual = new Set(actualReasons || []);
  const expected = [...new Set(expectedReasons || [])];
  if (!expected.length) return 1;
  const matches = expected.filter((reason) => actual.has(reason)).length;
  return round(matches / expected.length, 4);
}

function visualReasonCodes(reasons = []) {
  return (Array.isArray(reasons) ? reasons : []).filter((reason) => /^visual_/.test(reason));
}

function captionsHaveValidTiming(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return false;
  const duration = toNumber(plan.sourceEnd) - toNumber(plan.sourceStart);
  return plan.captions.every((caption) => {
    const start = toNumber(caption.start, Number.NaN);
    const end = toNumber(caption.end, Number.NaN);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration + 0.25;
  });
}

function captionsHaveValidRoles(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return false;
  const roles = plan.captions.map((caption) => caption && caption.role);
  if (!roles.includes("opening_hook")) return false;
  if (!roles.includes("closing_punch")) return false;
  return plan.captions.every((caption) => (
    caption &&
    CAPTION_ROLES.includes(caption.role) &&
    CAPTION_EMPHASIS.includes(caption.emphasis) &&
    CAPTION_LAYOUTS.includes(caption.layout) &&
    caption.timing &&
    Number.isFinite(Number(caption.timing.entranceMs)) &&
    Number.isFinite(Number(caption.timing.exitMs)) &&
    caption.style &&
    Number.isFinite(Number(caption.style.fontScale)) &&
    Number.isFinite(Number(caption.style.stroke)) &&
    Number.isFinite(Number(caption.style.shadow)) &&
    Number.isFinite(Number(caption.style.maxLines))
  ));
}

function renderStylePresetIsValid(plan) {
  return Boolean(plan && RENDER_STYLE_PRESETS.includes(plan.stylePreset));
}

function planHasGoalLanguage(plan) {
  if (!plan || typeof plan !== "object") return false;
  const captionTexts = Array.isArray(plan.captions) ? plan.captions.map((caption) => caption.text) : [];
  const text = [plan.hook, ...captionTexts].filter(Boolean).join(" ");
  return hasGoalLanguage(text);
}

function framingIsSafe(plan, metadata = {}) {
  if (!plan || typeof plan !== "object") return false;
  if (!["wide_safe", "wide_safe_vertical", "safe_center", "action_bias"].includes(plan.framingMode)) return false;
  const crop = plan.cropStrategy;
  if (!crop || typeof crop !== "object") return false;
  const inputWidth = Math.max(1, toNumber(metadata.width, 1920));
  const inputHeight = Math.max(1, toNumber(metadata.height, 1080));
  const zoom = toNumber(crop.zoom, 1);
  if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 1.35) return false;
  if (["wide_safe", "wide_safe_vertical"].includes(plan.framingMode) && crop.preserveFullFrame !== true) return false;
  if (crop.maxCropPercent !== undefined && toNumber(crop.maxCropPercent, 1) > 0.35) return false;
  if (crop.bounds && typeof crop.bounds === "object") {
    const left = toNumber(crop.bounds.left, Number.NaN);
    const top = toNumber(crop.bounds.top, Number.NaN);
    const width = toNumber(crop.bounds.width, Number.NaN);
    const height = toNumber(crop.bounds.height, Number.NaN);
    if (![left, top, width, height].every(Number.isFinite)) return false;
    if (left < 0 || top < 0 || width <= 0 || height <= 0) return false;
    if (left + width > inputWidth + 1 || top + height > inputHeight + 1) return false;
  }
  return true;
}

function animationCuesAreValid(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.animationCues) || plan.animationCues.length === 0) return false;
  const duration = toNumber(plan.sourceEnd) - toNumber(plan.sourceStart);
  return plan.animationCues.every((cue) => {
    const start = toNumber(cue.start, Number.NaN);
    const end = toNumber(cue.end, Number.NaN);
    return (
      cue &&
      typeof cue.type === "string" &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= duration + 0.25
    );
  });
}

function frameExtractionFixtureSummary(fixture) {
  const value = fixture.frameExtraction || fixture.sampledFrames || null;
  if (!value || typeof value !== "object") {
    return { fallbackUsed: false, frameCount: 0 };
  }
  const summary = value.summary && typeof value.summary === "object" ? value.summary : {};
  return {
    fallbackUsed: Boolean(value.fallbackUsed),
    frameCount: toNumber(summary.frameCount ?? value.frameCount, 0),
  };
}

function scoreFixture(fixture) {
  validateFixture(fixture);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(fixture.thresholds || {}) };
  const metadata = {
    durationSeconds: fixture.durationSeconds,
    width: fixture.mediaSignals.width || 1920,
    height: fixture.mediaSignals.height || 1080,
    hasAudio: fixture.mediaSignals.hasAudio !== false,
  };
  const visualSignals = validateVisualSignals(
    fixture.visualSignals || fixture.mediaSignals.visualSignals || { providerMode: "fixture-none", fallbackUsed: true, windows: [] },
    metadata,
  );
  const highlightResult = detectHighlights({
    transcript: fixture.transcript,
    signals: fixture.mediaSignals,
    visualSignals,
    preset: fixture.expected.preset || "hype",
  });
  const candidatePlans = createCandidateEditPlans({
    moments: highlightResult.moments,
    metadata,
    transcript: fixture.transcript,
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    title: fixture.title,
    preset: fixture.expected.preset || "hype",
    language: fixture.language,
    styleTarget: fixture.expected.styleTarget || "vertical_9_16",
    editIntensity: fixture.expected.editIntensity || "balanced",
    stylePreset: fixture.expected.stylePreset || "social_sports_v1",
  });
  const topMoment = highlightResult.moments[0] || null;
  const topPlan = candidatePlans[0] || null;
  const top1Overlap = topMoment ? bestOverlap(topMoment, fixture.expected.highlights) : 0;
  const recall = top3Recall(highlightResult.moments, fixture.expected.highlights, thresholds.minTop1Overlap);
  const reasonPrecision = reasonCodePrecision(topMoment ? topMoment.reasonCodes : [], fixture.expected.reasonCodes);
  const reasonRecall = reasonCodeRecall(topMoment ? topMoment.reasonCodes : [], fixture.expected.reasonCodes);
  const expectedVisualReasons = visualReasonCodes(fixture.expected.reasonCodes);
  const actualVisualReasons = visualReasonCodes(topMoment ? topMoment.reasonCodes : []);
  const visualReasonPrecision = expectedVisualReasons.length ? reasonCodePrecision(actualVisualReasons, expectedVisualReasons) : 1;
  const visualReasonRecall = expectedVisualReasons.length ? reasonCodeRecall(actualVisualReasons, expectedVisualReasons) : 1;
  const retentionScore = topMoment ? toNumber(topMoment.retentionScore) : 0;
  const retentionSanity = retentionScore >= thresholds.minRetentionScore ? 1 : Math.max(0, retentionScore / thresholds.minRetentionScore);
  const expectedAspectRatio = fixture.expected.aspectRatio || "9:16";
  const candidatePlanValidity = candidatePlans.length > 0 &&
    candidatePlans.every((plan) => plan.aspectRatio === expectedAspectRatio && plan.export.format === "mp4")
    ? 1
    : 0;
  const captionTimingValidity = candidatePlans.every(captionsHaveValidTiming) ? 1 : 0;
  const captionRoleValidity = candidatePlans.every(captionsHaveValidRoles) ? 1 : 0;
  const renderStylePresetValidity = candidatePlans.every(renderStylePresetIsValid) ? 1 : 0;
  const unsupportedCueCount = topPlan && Array.isArray(topPlan.unsupportedAnimationCues) ? topPlan.unsupportedAnimationCues.length : 0;
  const animationCueCount = topPlan && Array.isArray(topPlan.animationCues) ? topPlan.animationCues.length : 0;
  const unsupportedCueRate = round(unsupportedCueCount / Math.max(1, unsupportedCueCount + animationCueCount), 4);
  const unsupportedCueScore = unsupportedCueRate <= 0.25 ? 1 : Math.max(0, 1 - unsupportedCueRate);
  const expectedHighlightType = fixture.expected.highlightType || null;
  const highlightTypeAccuracy = expectedHighlightType && topMoment ? (topMoment.highlightType === expectedHighlightType ? 1 : 0) : 1;
  const falseGoalCaption = expectedHighlightType !== "goal" && planHasGoalLanguage(topPlan) ? 1 : 0;
  const falseVisualGoal = topMoment &&
    topMoment.highlightType === "goal" &&
    !topMoment.reasonCodes.includes("goal") &&
    actualVisualReasons.length > 0
    ? 1
    : 0;
  const falseGoalCaptionRate = falseGoalCaption;
  const falseVisualGoalRate = falseVisualGoal;
  const captionSafety = falseGoalCaption ? 0 : 1;
  const framingSafety = topPlan && framingIsSafe(topPlan, metadata) ? 1 : 0;
  const animationCueValidity = topPlan && animationCuesAreValid(topPlan) ? 1 : 0;
  const fallbackUsed = Boolean(highlightResult.fallback);
  const visualFallbackUsed = Boolean(visualSignals.fallbackUsed);
  const frameExtraction = frameExtractionFixtureSummary(fixture);
  const frameExtractionFallbackUsed = frameExtraction.fallbackUsed;
  const fallbackScore = fallbackUsed ? 0 : 1;
  const weightedScore = Math.round(
    scoreToPercent(top1Overlap) * 0.17 +
      scoreToPercent(recall) * 0.13 +
      scoreToPercent(reasonPrecision) * 0.1 +
      scoreToPercent(reasonRecall) * 0.08 +
      scoreToPercent(highlightTypeAccuracy) * 0.11 +
      scoreToPercent(captionSafety) * 0.09 +
      scoreToPercent(framingSafety) * 0.06 +
      scoreToPercent(animationCueValidity) * 0.05 +
      scoreToPercent(retentionSanity) * 0.04 +
      scoreToPercent(candidatePlanValidity) * 0.04 +
      scoreToPercent(captionTimingValidity) * 0.03 +
      scoreToPercent(fallbackScore) * 0.02 +
      scoreToPercent(captionRoleValidity) * 0.04 +
      scoreToPercent(renderStylePresetValidity) * 0.02 +
      scoreToPercent(unsupportedCueScore) * 0.02,
  );
  const passed =
    weightedScore >= thresholds.minAggregateScore &&
    top1Overlap >= thresholds.minTop1Overlap &&
    recall >= thresholds.minTop3Recall &&
    reasonPrecision >= thresholds.minReasonPrecision &&
    visualReasonPrecision >= thresholds.minReasonPrecision &&
    candidatePlanValidity === 1 &&
    captionTimingValidity === 1 &&
    captionRoleValidity === 1 &&
    renderStylePresetValidity === 1 &&
    unsupportedCueRate <= 0.25 &&
    highlightTypeAccuracy === 1 &&
    captionSafety === 1 &&
    falseVisualGoalRate === 0 &&
    framingSafety === 1 &&
    animationCueValidity === 1;

  return {
    id: fixture.id,
    title: sanitizeReportText(fixture.title, 160),
    language: sanitizeReportText(fixture.language, 40),
    passed,
    score: weightedScore,
    thresholds,
    metrics: {
      top1Overlap,
      top3Recall: recall,
      reasonCodePrecision: reasonPrecision,
      reasonCodeRecall: reasonRecall,
      visualReasonPrecision,
      visualReasonRecall,
      visualLabelPrecision: visualReasonPrecision,
      visualLabelRecall: visualReasonRecall,
      retentionScore,
      retentionSanity: round(retentionSanity, 4),
      candidatePlanValidity,
      captionTimingValidity,
      captionRoleValidity,
      renderStylePresetValidity,
      unsupportedCueRate,
      highlightTypeAccuracy,
      falseGoalCaptionRate,
      falseVisualGoalRate,
      captionSafety,
      framingSafety,
      animationCueValidity,
      fallbackUsed,
      visualFallbackUsed,
      frameExtractionFallbackUsed,
      sampledFrameCount: frameExtraction.frameCount,
    },
    expected: {
      highlights: fixture.expected.highlights.map((item) => ({ start: item.start, end: item.end })),
      reasonCodes: [...fixture.expected.reasonCodes],
      highlightType: expectedHighlightType,
      stylePreset: fixture.expected.stylePreset,
      styleTarget: fixture.expected.styleTarget || "vertical_9_16",
      aspectRatio: expectedAspectRatio,
    },
    actual: {
      topMoment: topMoment
        ? {
            start: topMoment.start,
            end: topMoment.end,
            retentionScore: topMoment.retentionScore,
            reasonCodes: topMoment.reasonCodes,
            highlightType: topMoment.highlightType,
            visualEvidence: topMoment.evidence && topMoment.evidence.visual
              ? {
                  windowCount: topMoment.evidence.visual.windowCount,
                  topTypes: topMoment.evidence.visual.topTypes,
                  actionFocusConfidence: topMoment.evidence.visual.actionFocusConfidence,
                  goalClaimAllowed: false,
                }
              : null,
            source: topMoment.source,
          }
        : null,
      candidatePlans: candidatePlans.map((plan) => ({
        rank: plan.rank,
        sourceStart: plan.sourceStart,
        sourceEnd: plan.sourceEnd,
        retentionScore: plan.retentionScore,
        reasonCodes: plan.reasonCodes,
        highlightType: plan.highlightType,
        stylePreset: plan.stylePreset,
        styleTarget: plan.styleTarget,
        editIntensity: plan.editIntensity,
        aspectRatio: plan.aspectRatio,
        storyType: plan.footballStoryPlan && plan.footballStoryPlan.storyType,
        framingMode: plan.framingMode,
        framingReason: plan.framingReason,
        actionFocusConfidence: plan.actionFocusConfidence,
        visualEvidenceSummary: plan.visualEvidenceSummary,
        animationCueCount: Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
        unsupportedAnimationCueCount: Array.isArray(plan.unsupportedAnimationCues) ? plan.unsupportedAnimationCues.length : 0,
        captions: plan.captions.length,
        captionRoles: plan.captions.map((caption) => caption.role),
        effects: plan.effects,
      })),
    },
    notes: debuggingNotes({
      top1Overlap,
      recall,
      reasonPrecision,
      visualReasonPrecision,
      retentionScore,
      candidatePlanValidity,
      captionTimingValidity,
      captionRoleValidity,
      renderStylePresetValidity,
      unsupportedCueRate,
      highlightTypeAccuracy,
      captionSafety,
      falseVisualGoalRate,
      framingSafety,
      animationCueValidity,
      fallbackUsed,
      frameExtractionFallbackUsed,
      thresholds,
    }),
  };
}

function debuggingNotes(metrics) {
  const notes = [];
  if (metrics.top1Overlap < metrics.thresholds.minTop1Overlap) notes.push("Top-ranked moment misses the expected highlight window.");
  if (metrics.recall < metrics.thresholds.minTop3Recall) notes.push("Top-3 ranking does not cover enough expected moments.");
  if (metrics.reasonPrecision < metrics.thresholds.minReasonPrecision) notes.push("Reason codes are noisy against expected labels.");
  if (metrics.visualReasonPrecision < metrics.thresholds.minReasonPrecision) notes.push("Visual reason codes are noisy against expected labels.");
  if (metrics.retentionScore < metrics.thresholds.minRetentionScore) notes.push("Retention score looks too weak for a highlight candidate.");
  if (!metrics.candidatePlanValidity) notes.push("Candidate edit plan validation failed.");
  if (!metrics.captionTimingValidity) notes.push("Caption timings are outside the selected source window.");
  if (!metrics.captionRoleValidity) notes.push("Kinetic caption role/style contract is missing or invalid.");
  if (!metrics.renderStylePresetValidity) notes.push("Candidate edit plan is missing a supported render style preset.");
  if (metrics.unsupportedCueRate > 0.25) notes.push("Too many animation cues were ignored as unsupported.");
  if (!metrics.highlightTypeAccuracy) notes.push("Top-ranked moment has the wrong football highlight type.");
  if (!metrics.captionSafety) notes.push("No-goal fixture received misleading goal language.");
  if (metrics.falseVisualGoalRate) notes.push("Visual signals created goal classification without explicit goal evidence.");
  if (!metrics.framingSafety) notes.push("Candidate edit plan is missing safe vertical framing metadata.");
  if (!metrics.animationCueValidity) notes.push("Social edit animation cues are missing or invalid.");
  if (metrics.fallbackUsed) notes.push("Analysis fell back to deterministic fallback moments.");
  if (metrics.frameExtractionFallbackUsed) notes.push("Sampled frame extraction fell back to deterministic frame metadata.");
  return notes;
}

function loadFixtures(fixturesDir) {
  const files = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((fileName) => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, fileName), "utf8"));
    validateFixture(raw);
    return raw;
  });
}

function aggregateResults(results) {
  const count = results.length || 1;
  const avg = (selector) => round(results.reduce((sum, result) => sum + selector(result), 0) / count, 4);
  const aggregateScore = Math.round(results.reduce((sum, result) => sum + result.score, 0) / count);
  return {
    fixtureCount: results.length,
    aggregateScore,
    passRate: avg((result) => (result.passed ? 1 : 0)),
    top1Overlap: avg((result) => result.metrics.top1Overlap),
    top3Recall: avg((result) => result.metrics.top3Recall),
    reasonCodePrecision: avg((result) => result.metrics.reasonCodePrecision),
    reasonCodeRecall: avg((result) => result.metrics.reasonCodeRecall),
    visualReasonPrecision: avg((result) => result.metrics.visualReasonPrecision),
    visualReasonRecall: avg((result) => result.metrics.visualReasonRecall),
    visualLabelPrecision: avg((result) => result.metrics.visualLabelPrecision),
    visualLabelRecall: avg((result) => result.metrics.visualLabelRecall),
    highlightTypeAccuracy: avg((result) => result.metrics.highlightTypeAccuracy),
    falseGoalCaptionRate: avg((result) => result.metrics.falseGoalCaptionRate),
    falseVisualGoalRate: avg((result) => result.metrics.falseVisualGoalRate),
    captionSafety: avg((result) => result.metrics.captionSafety),
    framingSafety: avg((result) => result.metrics.framingSafety),
    animationCueValidity: avg((result) => result.metrics.animationCueValidity),
    captionRoleValidity: avg((result) => result.metrics.captionRoleValidity),
    renderStylePresetValidity: avg((result) => result.metrics.renderStylePresetValidity),
    unsupportedCueRate: avg((result) => result.metrics.unsupportedCueRate),
    fallbackUsageRate: avg((result) => (result.metrics.fallbackUsed ? 1 : 0)),
    visualFallbackUsageRate: avg((result) => (result.metrics.visualFallbackUsed ? 1 : 0)),
    frameExtractionFallbackUsageRate: avg((result) => (result.metrics.frameExtractionFallbackUsed ? 1 : 0)),
    sampledFrameCount: avg((result) => result.metrics.sampledFrameCount),
    candidatePlanValidity: avg((result) => result.metrics.candidatePlanValidity),
    captionTimingValidity: avg((result) => result.metrics.captionTimingValidity),
  };
}

function workspaceMetadata() {
  const metadata = {
    gitAvailable: false,
    commit: null,
    branch: null,
    dirty: null,
  };
  try {
    const gitOptions = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 };
    metadata.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], gitOptions).trim();
    metadata.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOptions).trim();
    const status = execFileSync("git", ["status", "--porcelain"], gitOptions).trim();
    metadata.dirty = Boolean(status);
    metadata.gitAvailable = true;
  } catch {
    metadata.gitAvailable = false;
  }
  return metadata;
}

function buildReport({ fixtures, results, minAggregateScore = DEFAULT_THRESHOLDS.minAggregateScore, timestamp = new Date().toISOString() }) {
  const aggregate = aggregateResults(results);
  const failedCases = results
    .filter((result) => !result.passed)
    .map((result) => ({
      id: result.id,
      score: result.score,
      notes: result.notes,
    }));
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    metadata: {
      workspace: workspaceMetadata(),
      fixtureCount: fixtures.length,
      runner: "matchcuts-local-eval",
    },
    thresholds: {
      minAggregateScore,
    },
    aggregate,
    passed: aggregate.aggregateScore >= minAggregateScore && failedCases.length === 0,
    failedCases,
    fixtures: results,
    suggestedDebuggingNotes: failedCases.length
      ? [...new Set(failedCases.flatMap((item) => item.notes))].slice(0, 10)
      : ["Evaluation passed. Track aggregate score and reason precision over time."],
  };
}

function runEvaluation({ fixturesDir, minAggregateScore = DEFAULT_THRESHOLDS.minAggregateScore } = {}) {
  if (!fixturesDir || !existsSync(fixturesDir)) {
    throw new AppError("VALIDATION_ERROR", "Evaluation fixtures directory is missing.", 400);
  }
  const fixtures = loadFixtures(fixturesDir);
  const results = fixtures.map(scoreFixture);
  return buildReport({ fixtures, results, minAggregateScore });
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // If rotation fails, the write attempt below will surface the filesystem problem.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function writeReport(report, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const fileName = `matchcuts-eval-${safeTimestamp}.json`;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const target = join(resultsDir, fileName);
  safeWriteReportFile(target, payload);
  safeWriteReportFile(join(resultsDir, "latest.json"), payload);
  return {
    fileName: basename(target),
    latest: "latest.json",
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  aggregateResults,
  animationCuesAreValid,
  bestOverlap,
  buildReport,
  captionsHaveValidRoles,
  captionsHaveValidTiming,
  framingIsSafe,
  loadFixtures,
  overlapRatio,
  planHasGoalLanguage,
  reasonCodePrecision,
  reasonCodeRecall,
  renderStylePresetIsValid,
  runEvaluation,
  sanitizeReportText,
  scoreFixture,
  top3Recall,
  validateFixture,
  writeReport,
};
