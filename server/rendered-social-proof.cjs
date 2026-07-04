const { AppError } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const RENDERED_SOCIAL_PROOF_SCHEMA_VERSION = 1;
const MAX_REASONS = 14;
const MAX_ITEMS = 12;
const REQUIRED_CAPTION_MOTION = "ass_word_by_word_highlight";
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|api[_-]?key|token|secret|stderr|stdout|raw(?:Log|Error|Output)?|cookie/i;

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeString(value, maxLength = 100) {
  const text = sanitizeText(value || "", maxLength);
  if (!text || SENSITIVE_RE.test(text)) return null;
  return text;
}

function safeList(values = [], maxItems = MAX_ITEMS, maxLength = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function safeRelativeMp4(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !text.startsWith("manual-downloads/") ||
    !text.toLowerCase().endsWith(".mp4") ||
    SENSITIVE_RE.test(text)
  ) {
    return null;
  }
  return text;
}

function uniqueReasons(values = []) {
  return safeList(values, MAX_REASONS, 100);
}

function valueObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nestedVideoOutputQA(renderPlan = {}, videoOutputQA = null) {
  return valueObject(videoOutputQA || renderPlan.videoOutputQA);
}

function nestedRenderPolishQA(renderPlan = {}) {
  return valueObject(renderPlan.renderPolishQA);
}

function nestedReferenceStyleQA(renderPlan = {}) {
  return valueObject(renderPlan.visualPolishQA || renderPlan.referenceStyleQA);
}

function outputFreshnessSummary(outputMp4 = null, ffprobe = null) {
  const relativePath = safeRelativeMp4(outputMp4 && outputMp4.relativePath);
  const sizeBytes = numberOrNull(outputMp4 && outputMp4.sizeBytes) ?? numberOrNull(ffprobe && ffprobe.sizeBytes);
  const downloadVerified = Boolean(outputMp4 && outputMp4.downloadVerified);
  const ffprobeStatus = safeString(ffprobe && ffprobe.status, 40);
  const reasons = uniqueReasons([
    ...(!relativePath ? ["output_mp4_reference_missing_or_unsafe"] : []),
    ...(relativePath && /latest|cached|previous/i.test(relativePath) ? ["output_mp4_reference_not_unique"] : []),
    ...(!downloadVerified ? ["output_mp4_download_not_verified"] : []),
    ...(sizeBytes == null || sizeBytes <= 0 ? ["output_mp4_size_missing"] : []),
    ...(ffprobeStatus !== "passed" ? ["ffprobe_not_passed"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    relativePath,
    uniqueOutput: Boolean(relativePath && !/latest|cached|previous/i.test(relativePath)),
    sizeBytes,
    downloadVerified,
    ffprobeStatus,
    durationSeconds: round(ffprobe && ffprobe.durationSeconds),
    width: numberOrNull(ffprobe && ffprobe.width),
    height: numberOrNull(ffprobe && ffprobe.height),
    reasons,
  };
}

function hookSummary(renderPlan = {}, videoOutputQA = null) {
  const qa = nestedVideoOutputQA(renderPlan, videoOutputQA);
  const hook = valueObject(qa.hook || renderPlan.hookPlan);
  const hookStart = numberOrNull(hook.hookStart ?? hook.start);
  const hookEnd = numberOrNull(hook.hookEnd ?? hook.end);
  const evidenceCodes = safeList(hook.evidenceCodes || hook.reasonCodes, 10, 80);
  const reasons = uniqueReasons([
    ...(!hook || Object.keys(hook).length === 0 ? ["rendered_hook_missing"] : []),
    ...(hook.passed === false ? ["rendered_hook_gate_failed"] : []),
    ...(hookStart == null || hookStart > 0.25 ? ["hook_does_not_start_immediately"] : []),
    ...(hookEnd == null || hookEnd > 2.05 || hookEnd <= (hookStart ?? -1) ? ["hook_not_inside_first_two_seconds"] : []),
    ...(hook.noFalseGoalClaim === false ? ["hook_false_goal_claim_risk"] : []),
    ...(!evidenceCodes.length ? ["hook_not_evidence_backed"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    hookStart: hookStart == null ? null : round(hookStart, 2),
    hookEnd: hookEnd == null ? null : round(hookEnd, 2),
    hookType: safeString(hook.hookType || hook.type, 60),
    hookText: safeString(hook.hookText || hook.text, 120),
    relatedGoalNumber: numberOrNull(hook.relatedGoalNumber),
    relatedMomentId: safeString(hook.relatedMomentId, 80),
    evidenceCodes,
    noFalseGoalClaim: hook.noFalseGoalClaim !== false,
    reasons,
  };
}

function captionMetricsFromRenderPlan(renderPlan = {}) {
  const captions = Array.isArray(renderPlan.captions) ? renderPlan.captions : [];
  let wordBeatCount = 0;
  let wordCount = 0;
  let maxBeatDuration = null;
  for (const caption of captions) {
    const words = Array.isArray(caption && caption.words) ? caption.words : [];
    const timings = Array.isArray(caption && caption.activeWordTiming) ? caption.activeWordTiming : [];
    if (!words.length || timings.length !== words.length) continue;
    wordBeatCount += 1;
    wordCount += words.length;
    for (const timing of timings) {
      const start = numberOrNull(timing && timing.start);
      const end = numberOrNull(timing && timing.end);
      if (start == null || end == null || end <= start) continue;
      const duration = end - start;
      maxBeatDuration = maxBeatDuration == null ? duration : Math.max(maxBeatDuration, duration);
    }
  }
  return {
    avgWordsPerBeat: wordBeatCount ? round(wordCount / wordBeatCount, 2) : null,
    maxCaptionBeatDuration: maxBeatDuration == null ? null : round(maxBeatDuration, 2),
  };
}

function dynamicCaptionSummary(renderPlan = {}, videoOutputQA = null) {
  const qa = nestedVideoOutputQA(renderPlan, videoOutputQA);
  const captions = valueObject(qa.captions);
  const renderPolish = nestedRenderPolishQA(renderPlan);
  const dynamicWordCaptionCount = numberOrNull(renderPolish.dynamicWordCaptionCount) ?? numberOrNull(captions.dynamicCaptionCount);
  const captionCount = numberOrNull(captions.captionCount) ?? (Array.isArray(renderPlan.captions) ? renderPlan.captions.length : null);
  const readableCaptionCount = numberOrNull(captions.readableCaptionCount);
  const captionSafeArea = Array.isArray(captions.safeAreas) ? safeList(captions.safeAreas, 6, 40) : [];
  const textObstructionRisk = captions.textObstructionRisk === true ||
    safeList(captions.reasons, 8, 80).some((reason) => /obstruction|safe_area/i.test(reason));
  const timingMetrics = captionMetricsFromRenderPlan(renderPlan);
  const reasons = uniqueReasons([
    ...(captions.passed === false ? ["caption_output_gate_failed"] : []),
    ...(renderPolish.captionMotion !== REQUIRED_CAPTION_MOTION ? ["rendered_caption_motion_not_word_by_word"] : []),
    ...(dynamicWordCaptionCount == null || dynamicWordCaptionCount <= 0 ? ["dynamic_word_captions_missing"] : []),
    ...(captionCount != null && dynamicWordCaptionCount != null && dynamicWordCaptionCount < captionCount ? ["not_all_captions_have_word_timing"] : []),
    ...(captions.openingHookCaptionInFirstTwoSeconds !== true ? ["opening_hook_caption_not_rendered_in_first_two_seconds"] : []),
    ...(readableCaptionCount != null && captionCount != null && readableCaptionCount < captionCount ? ["caption_readability_failed"] : []),
    ...(textObstructionRisk ? ["caption_text_obstruction_risk"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    dynamicWordCaptionCount,
    captionCount,
    readableCaptionCount,
    openingHookCaptionRendered: captions.openingHookCaptionInFirstTwoSeconds === true,
    captionMotion: safeString(renderPolish.captionMotion, 80),
    activeWordHighlightRendered: renderPolish.captionMotion === REQUIRED_CAPTION_MOTION && (dynamicWordCaptionCount || 0) > 0,
    avgWordsPerBeat: timingMetrics.avgWordsPerBeat,
    maxCaptionBeatDuration: timingMetrics.maxCaptionBeatDuration,
    captionSafeArea,
    textObstructionRisk,
    reasons,
  };
}

function transitionSummary(renderPlan = {}) {
  const renderPolish = nestedRenderPolishQA(renderPlan);
  const visual = nestedReferenceStyleQA(renderPlan);
  const segmentCount = Array.isArray(renderPlan.segments)
    ? renderPlan.segments.length
    : numberOrNull(renderPlan.segmentCount) || 0;
  const transitionRenderedCount = numberOrNull(renderPolish.transitionRenderedCount);
  const hardCutFallbackCount = numberOrNull(renderPolish.hardCutFallbackCount);
  const abruptCutRiskCount = numberOrNull(visual.abruptCutRiskCount);
  const transitionCoverage = segmentCount <= 1
    ? true
    : transitionRenderedCount != null && transitionRenderedCount >= segmentCount - 1;
  const reasons = uniqueReasons([
    ...(hardCutFallbackCount == null || hardCutFallbackCount > 0 ? ["hard_cut_fallback_rendered"] : []),
    ...(!transitionCoverage ? ["multi_segment_transition_cues_missing"] : []),
    ...(abruptCutRiskCount != null && abruptCutRiskCount > 0 ? ["abrupt_cut_risk_detected"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    segmentCount,
    transitionRenderedCount,
    hardCutFallbackCount,
    transitionCoverage,
    abruptCutRiskCount,
    transitions: Array.isArray(renderPolish.transitions)
      ? renderPolish.transitions.slice(0, 8).map((transition, index) => ({
          index: index + 1,
          type: safeString(transition && transition.type, 60),
          timelineStart: round(transition && transition.timelineStart),
          durationSeconds: round(transition && transition.transitionDurationSeconds),
          renderedBy: safeString(transition && transition.renderedBy, 80),
        }))
      : [],
    reasons,
  };
}

function phaseVisibilitySummary(renderPlan = {}, videoOutputQA = null) {
  const qa = nestedVideoOutputQA(renderPlan, videoOutputQA);
  const segments = Array.isArray(renderPlan.segments) ? renderPlan.segments : [];
  const invalid = [];
  const goalSegments = segments.filter((segment) => {
    const outcome = valueObject(segment && segment.goalOutcome);
    return segment && segment.highlightType === "goal" && outcome.outcome === "confirmed_goal";
  });
  goalSegments.forEach((segment, index) => {
    const phase = valueObject(segment.phaseCoverage);
    const reasons = uniqueReasons([
      ...(!phase.hasBuildup ? ["missing_buildup"] : []),
      ...(!phase.hasShot || numberOrNull(segment.shotStart) == null ? ["missing_shot"] : []),
      ...(!phase.hasFinish || numberOrNull(segment.finishTime) == null ? ["missing_finish"] : []),
      ...(!phase.hasConfirmation || numberOrNull(segment.confirmationTime) == null ? ["missing_confirmation"] : []),
      ...(segment.replayOnly || phase.replayOnly ? ["replay_only_segment"] : []),
      ...(segment.celebrationOnly || phase.celebrationOnly ? ["celebration_only_segment"] : []),
    ]);
    if (reasons.length) {
      invalid.push({
        index: index + 1,
        goalNumber: numberOrNull(segment.goalNumber),
        reasons,
      });
    }
  });
  const randomChanceSegments = segments
    .filter((segment) => segment && segment.highlightType !== "goal")
    .slice(0, MAX_ITEMS)
    .map((segment, index) => ({
      index: index + 1,
      highlightType: safeString(segment.highlightType || "unknown", 60),
      sourceStart: round(segment.sourceStart),
      sourceEnd: round(segment.sourceEnd),
    }));
  const reasons = uniqueReasons([
    ...(qa.passed === false ? ["video_output_qa_failed"] : []),
    ...(goalSegments.length === 0 ? ["no_confirmed_goal_segments"] : []),
    ...(invalid.length ? ["goal_phase_coverage_failed"] : []),
    ...(randomChanceSegments.length ? ["non_goal_segments_present"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    expectedGoalCount: numberOrNull(qa.expectedGoalCount),
    actualConfirmedGoalSegmentCount: numberOrNull(qa.actualConfirmedGoalSegmentCount) ?? goalSegments.length,
    coveredGoalCount: numberOrNull(qa.coveredGoalCount),
    invalidGoalSegments: invalid.slice(0, MAX_ITEMS),
    randomChanceSegments,
    reasons,
  };
}

function rightsSafeStyleSummary(renderPlan = {}, videoOutputQA = null) {
  const qa = nestedVideoOutputQA(renderPlan, videoOutputQA);
  const audioPolicy = valueObject(qa.audioPolicy || renderPlan.audioPolicy);
  const creativeStyle = valueObject(qa.creativeStyle || renderPlan.creativeStyleTransforms);
  const audioPassed = audioPolicy.passed === true ||
    (audioPolicy.copyrightedTrackBundled === false && audioPolicy.externalAudioBundled !== true);
  const creativePassed = creativeStyle.passed === true ||
    (creativeStyle.mirror === false && creativeStyle.copyrightEvasion === false && creativeStyle.watermarkObscuring === false);
  const reasons = uniqueReasons([
    ...(!audioPassed ? ["unsafe_or_missing_audio_policy"] : []),
    ...(!creativePassed ? ["unsafe_or_missing_creative_style_policy"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    externalAudioBundled: Boolean(audioPolicy.externalAudioBundled),
    copyrightedTrackBundled: Boolean(audioPolicy.copyrightedTrackBundled),
    audioMode: safeString(audioPolicy.audioMode, 50),
    licenseStatus: safeString(audioPolicy.licenseStatus, 60),
    mirror: Boolean(creativeStyle.mirror),
    copyrightEvasion: Boolean(creativeStyle.copyrightEvasion),
    watermarkObscuring: Boolean(creativeStyle.watermarkObscuring),
    rightsSafeStyleScore: reasons.length === 0 ? 100 : Math.max(0, 100 - reasons.length * 35),
    reasons,
  };
}

function referenceStyleSummary(renderPlan = {}) {
  const visual = nestedReferenceStyleQA(renderPlan);
  return {
    hookStrength: numberOrNull(visual.hookStrengthScore) ?? null,
    captionReadability: numberOrNull(visual.captionReadabilityScore) ?? null,
    captionMotionTiming: numberOrNull(visual.captionMotionTimingScore) ?? null,
    pacing: numberOrNull(visual.referencePacingScore),
    actionVisibility: numberOrNull(visual.phaseCoverageScore),
    cropSafety: numberOrNull(visual.cropSafetyScore) ?? null,
    transitionSmoothness: numberOrNull(visual.cutSmoothnessScore),
    socialPolishScore: numberOrNull(visual.visualPolishScore),
    notes: safeList(visual.referenceSimilarityNotes, 8, 100),
  };
}

function scoreFromSections(sections) {
  const passedCount = sections.filter((section) => section && section.passed === true).length;
  return Math.round((passedCount / Math.max(1, sections.length)) * 100);
}

function collectFailedReasons(report) {
  return uniqueReasons([
    ...report.outputFreshness.reasons,
    ...report.renderedHook.reasons,
    ...report.dynamicCaptions.reasons,
    ...report.smoothEditing.reasons,
    ...report.phaseVisibility.reasons,
    ...report.rightsSafeStyle.reasons,
  ]);
}

function renderedSocialPolishProof({
  outputMp4 = null,
  ffprobe = null,
  renderPlan = null,
  videoOutputQA = null,
  generatedAt = null,
} = {}) {
  const safeRenderPlan = valueObject(renderPlan);
  const safeVideoQA = nestedVideoOutputQA(safeRenderPlan, videoOutputQA);
  if (hasUnsafeValue({ outputMp4, ffprobe, renderPlan: safeRenderPlan, videoOutputQA: safeVideoQA })) {
    return {
      schemaVersion: RENDERED_SOCIAL_PROOF_SCHEMA_VERSION,
      status: "failed",
      passed: false,
      generatedAt: safeString(generatedAt, 40),
      failedReasons: ["unsafe_social_polish_input"],
      logsDownloaded: false,
      artifactsDownloaded: false,
    };
  }
  const report = {
    schemaVersion: RENDERED_SOCIAL_PROOF_SCHEMA_VERSION,
    status: "failed",
    passed: false,
    generatedAt: safeString(generatedAt, 40),
    outputFreshness: outputFreshnessSummary(outputMp4, ffprobe),
    renderedHook: hookSummary(safeRenderPlan, safeVideoQA),
    dynamicCaptions: dynamicCaptionSummary(safeRenderPlan, safeVideoQA),
    smoothEditing: transitionSummary(safeRenderPlan),
    phaseVisibility: phaseVisibilitySummary(safeRenderPlan, safeVideoQA),
    rightsSafeStyle: rightsSafeStyleSummary(safeRenderPlan, safeVideoQA),
    referenceStyleComparison: referenceStyleSummary(safeRenderPlan),
    failedReasons: [],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  report.socialPolishScore = scoreFromSections([
    report.outputFreshness,
    report.renderedHook,
    report.dynamicCaptions,
    report.smoothEditing,
    report.phaseVisibility,
    report.rightsSafeStyle,
  ]);
  report.failedReasons = collectFailedReasons(report);
  report.passed = report.failedReasons.length === 0;
  report.status = report.passed ? "passed" : "failed";
  return report;
}

function assertRenderedSocialPolishProof(args = {}) {
  const report = renderedSocialPolishProof(args);
  if (!report.passed) {
    throw new AppError("RENDERED_SOCIAL_POLISH_QA_FAILED", "The rendered social polish proof did not pass.", 422, report);
  }
  return report;
}

module.exports = {
  RENDERED_SOCIAL_PROOF_SCHEMA_VERSION,
  assertRenderedSocialPolishProof,
  renderedSocialPolishProof,
};
