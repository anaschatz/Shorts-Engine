const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const {
  ANIMATION_CUE_TYPES,
  AUDIO_LICENSE_STATUSES,
  AUDIO_MODES,
  CAPTION_CONTRAST_MODES,
  CAPTION_SAFE_AREAS,
  CAPTION_STYLE_PRESETS,
} = require("./edit-plan.cjs");
const { sanitizeText } = require("./media.cjs");
const { publicMatchEventTruth } = require("./match-event-truth.cjs");
const { publicHumanVisibleGoalGate, validateHumanVisibleGoalSequence } = require("./human-visible-goal-gate.cjs");

const OUTPUT_GATE_SCHEMA_VERSION = 1;
const MATCH_TOLERANCE_SECONDS = 2;
const MAX_PUBLIC_ITEMS = 12;
const MIN_SCORE_CHANGE_BACKTRACK_SECONDS = 8;
const MIN_PRE_SHOT_CONTEXT_SECONDS = 4;
const MAX_GOAL_SEGMENT_OVERLAP_RATIO = 0.2;
const DUPLICATE_FINISH_TOLERANCE_SECONDS = 4;
const DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS = 2;
const CLOSE_SCORE_CHANGE_OVERLAP_SECONDS = 20;
const REFERENCE_STYLE_GOAL_COUNT = 5;
const REFERENCE_STYLE_MIN_DURATION_SECONDS = 55;
const REFERENCE_STYLE_MAX_DURATION_SECONDS = 125;
const DEBUG_CAPTION_RE = /\b(FINISH\s*\+\s*BUILD[- ]?UP|BUILD[- ]?UP\s*\+\s*FINISH|GOAL\s*\d+\s*CONFIRMED)\b/i;

const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeCodes(values = [], max = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean)
    .filter((value) => !SENSITIVE_RE.test(value)))]
    .slice(0, max);
}

function hasAny(values = [], expected = []) {
  const set = new Set(Array.isArray(values) ? values : []);
  return expected.some((value) => set.has(value));
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function publicWindow(value = {}) {
  const start = numberOrNull(value.start ?? value.sourceStart);
  const end = numberOrNull(value.end ?? value.sourceEnd);
  return {
    start: start == null ? null : round(start),
    end: end == null ? null : round(end),
  };
}

function publicExpectedGoal(goal = {}) {
  return {
    goalNumber: goal.goalNumber,
    source: sanitizeText(goal.source || "unknown", 40),
    anchorTime: goal.anchorTime == null ? null : round(goal.anchorTime),
    confirmationTime: goal.confirmationTime == null ? null : round(goal.confirmationTime),
    sourceWindow: goal.sourceWindow || null,
    scoreBefore: goal.scoreBefore ? sanitizeText(goal.scoreBefore, 16) : null,
    scoreAfter: goal.scoreAfter ? sanitizeText(goal.scoreAfter, 16) : null,
  };
}

function publicSegment(segment = {}, index = 0) {
  const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const goalOutcome = segment.goalOutcome && typeof segment.goalOutcome === "object" && !Array.isArray(segment.goalOutcome)
    ? segment.goalOutcome
    : null;
  return {
    index: index + 1,
    id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
    sourceStart: round(segment.sourceStart),
    sourceEnd: round(segment.sourceEnd),
    highlightType: sanitizeText(segment.highlightType || "unknown", 48),
    goalNumber: numberOrNull(segment.goalNumber),
    outcome: goalOutcome ? sanitizeText(goalOutcome.outcome || "unknown", 48) : null,
    shotStart: numberOrNull(segment.shotStart),
    finishTime: numberOrNull(segment.finishTime),
    confirmationTime: numberOrNull(segment.confirmationTime),
    scoreBefore: sanitizeText(segment.scoreBefore || (goalOutcome && goalOutcome.scoreBefore) || "", 16) || null,
    scoreAfter: sanitizeText(segment.scoreAfter || (goalOutcome && goalOutcome.scoreAfter) || "", 16) || null,
    scoreChangeTime: numberOrNull(segment.scoreChangeTime ?? (goalOutcome && goalOutcome.scoreChangeTime)),
    replayOnly: Boolean(segment.replayOnly || phaseCoverage.replayOnly),
    celebrationOnly: Boolean(segment.celebrationOnly || phaseCoverage.celebrationOnly),
    replayUsed: Boolean(segment.replayUsed || phaseCoverage.replayUsed),
    phaseCoverage: {
      hasBuildup: Boolean(phaseCoverage.hasBuildup),
      hasShot: Boolean(phaseCoverage.hasShot),
      hasFinish: Boolean(phaseCoverage.hasFinish),
      hasConfirmation: Boolean(phaseCoverage.hasConfirmation),
      replayOnly: Boolean(phaseCoverage.replayOnly),
      celebrationOnly: Boolean(phaseCoverage.celebrationOnly),
    },
    visualGoalGate: isConfirmedGoalSegment(segment)
      ? publicHumanVisibleGoalGate(validateHumanVisibleGoalSequence({ segment }))
      : null,
    reasonCodes: safeCodes(segment.reasonCodes, 10),
    safetyFlags: safeCodes(segment.safetyFlags, 8),
  };
}

function hookSummary(editPlan = {}) {
  const hook = editPlan.hookPlan && typeof editPlan.hookPlan === "object" && !Array.isArray(editPlan.hookPlan)
    ? editPlan.hookPlan
    : null;
  const evidenceCodes = hook && Array.isArray(hook.evidenceCodes) ? safeCodes(hook.evidenceCodes, 8) : [];
  const hookStart = hook ? numberOrNull(hook.hookStart) : null;
  const hookEnd = hook ? numberOrNull(hook.hookEnd) : null;
  const sourceStart = hook ? numberOrNull(hook.sourceStart) : null;
  const sourceEnd = hook ? numberOrNull(hook.sourceEnd) : null;
  const passed = Boolean(
    hook &&
    hook.coldOpen === true &&
    hook.timelinePlacement === "first_two_seconds" &&
    hook.noFalseGoalClaim === true &&
    hookStart != null &&
    hookEnd != null &&
    hookStart <= 0.25 &&
    hookEnd > hookStart &&
    hookEnd <= 2.05 &&
    sourceStart != null &&
    sourceEnd != null &&
    sourceEnd > sourceStart &&
    evidenceCodes.length > 0
  );
  const reasons = safeCodes([
    ...(!hook ? ["missing_first_two_second_hook"] : []),
    ...(hook && hook.noFalseGoalClaim !== true ? ["hook_false_goal_claim_risk"] : []),
    ...(hook && (hookStart == null || hookEnd == null || hookStart > 0.25 || hookEnd > 2.05 || hookEnd <= hookStart) ? ["hook_not_in_first_two_seconds"] : []),
    ...(hook && !evidenceCodes.length ? ["hook_not_evidence_backed"] : []),
    ...(hook && (sourceStart == null || sourceEnd == null || sourceEnd <= sourceStart) ? ["hook_source_window_missing"] : []),
  ], 8);
  return {
    passed,
    hookType: hook ? sanitizeText(hook.hookType || "unknown", 40) : null,
    hookStart: hookStart == null ? null : round(hookStart),
    hookEnd: hookEnd == null ? null : round(hookEnd),
    sourceStart: sourceStart == null ? null : round(sourceStart),
    sourceEnd: sourceEnd == null ? null : round(sourceEnd),
    evidenceCodes,
    reasons,
  };
}

function captionHasSafeWordTiming(caption = {}) {
  const words = Array.isArray(caption.words) ? caption.words.map((word) => sanitizeText(word, 24)).filter(Boolean) : [];
  const timings = Array.isArray(caption.activeWordTiming) ? caption.activeWordTiming : [];
  const start = numberOrNull(caption.start);
  const end = numberOrNull(caption.end);
  if (!words.length || timings.length !== words.length || start == null || end == null || end <= start) return false;
  return timings.every((timing, index) => {
    const timingStart = numberOrNull(timing && timing.start);
    const timingEnd = numberOrNull(timing && timing.end);
    const word = sanitizeText(timing && timing.word, 24);
    return word &&
      word === words[index] &&
      timingStart != null &&
      timingEnd != null &&
      timingStart >= start - 0.05 &&
      timingEnd <= end + 0.05 &&
      timingEnd > timingStart &&
      timingEnd - timingStart >= 0.08;
  });
}

function captionStyleSummary(editPlan = {}) {
  const captions = Array.isArray(editPlan.captions) ? editPlan.captions : [];
  const opening = captions.find((caption) => caption && caption.role === "opening_hook") || null;
  const dynamicCaptionCount = captions.filter(captionHasSafeWordTiming).length;
  const debugCaptionCount = captions.filter((caption) => DEBUG_CAPTION_RE.test(sanitizeText(caption && caption.text, 120))).length;
  const readableCaptionCount = captions.filter((caption) => {
    const text = sanitizeText(caption && caption.text, 120);
    const start = numberOrNull(caption && caption.start);
    const end = numberOrNull(caption && caption.end);
    const duration = start == null || end == null ? null : end - start;
    const dynamicTiming = captionHasSafeWordTiming(caption);
    const beatTimingReadable = dynamicTiming
      ? caption.activeWordTiming.every((timing) => {
          const timingStart = numberOrNull(timing && timing.start);
          const timingEnd = numberOrNull(timing && timing.end);
          return timingStart != null && timingEnd != null && timingEnd > timingStart && timingEnd - timingStart <= 1.4;
        })
      : duration != null && duration >= 0.35 && duration <= 4.5;
    const fontScale = numberOrNull(caption && caption.style && caption.style.fontScale);
    const maxLines = numberOrNull(caption && caption.style && caption.style.maxLines);
    const safeArea = caption && caption.safeArea && typeof caption.safeArea === "object" && !Array.isArray(caption.safeArea)
      ? caption.safeArea
      : null;
    return text &&
      text.length <= 96 &&
      beatTimingReadable &&
      fontScale != null &&
      fontScale >= 0.72 &&
      maxLines != null &&
      maxLines <= 3 &&
      safeArea &&
      CAPTION_SAFE_AREAS.includes(safeArea.name) &&
      CAPTION_STYLE_PRESETS.includes(caption.stylePreset) &&
      CAPTION_CONTRAST_MODES.includes(caption.contrastMode);
  }).length;
  const openingStart = opening ? numberOrNull(opening.start) : null;
  const openingEnd = opening ? numberOrNull(opening.end) : null;
  const openingInHookWindow = Boolean(opening && openingStart != null && openingEnd != null && openingStart <= 0.35 && openingEnd <= 2.3);
  const passed = captions.length > 0 &&
    openingInHookWindow &&
    dynamicCaptionCount === captions.length &&
    readableCaptionCount === captions.length &&
    debugCaptionCount === 0;
  const reasons = safeCodes([
    ...(!captions.length ? ["missing_dynamic_captions"] : []),
    ...(captions.length && !openingInHookWindow ? ["missing_readable_opening_hook_caption"] : []),
    ...(captions.length && dynamicCaptionCount !== captions.length ? ["caption_word_timing_invalid"] : []),
    ...(captions.length && readableCaptionCount !== captions.length ? ["caption_readability_failed"] : []),
    ...(debugCaptionCount > 0 ? ["debug_caption_label_rendered"] : []),
  ], 8);
  return {
    passed,
    captionCount: captions.length,
    dynamicCaptionCount,
    readableCaptionCount,
    debugCaptionCount,
    openingHookCaptionInFirstTwoSeconds: openingInHookWindow,
    stylePresets: safeCodes(captions.map((caption) => caption && caption.stylePreset), 6),
    safeAreas: safeCodes(captions.map((caption) => caption && caption.safeArea && caption.safeArea.name), 6),
    reasons,
  };
}

function animationSummary(editPlan = {}) {
  const cues = Array.isArray(editPlan.animationCues) ? editPlan.animationCues : [];
  const unsafe = cues
    .map((cue) => {
      const type = sanitizeText(cue && cue.type, 40);
      const start = numberOrNull(cue && cue.start);
      const end = numberOrNull(cue && cue.end);
      if (!ANIMATION_CUE_TYPES.includes(type)) return "unsupported_animation_cue";
      if (start == null || end == null || end <= start) return "invalid_animation_timing";
      if (cue.safeForMotion === false) return "unsafe_animation_cue";
      return null;
    })
    .filter(Boolean);
  const hookCues = cues.filter((cue) => ["intro_hook", "caption_word_pop", "kinetic_caption"].includes(cue && cue.type));
  const passed = cues.length > 0 && unsafe.length === 0 && hookCues.length >= 2;
  return {
    passed,
    cueCount: cues.length,
    hookCueCount: hookCues.length,
    cueTypes: safeCodes(cues.map((cue) => cue && cue.type), 10),
    reasons: safeCodes([
      ...(!cues.length ? ["missing_animation_cues"] : []),
      ...(hookCues.length < 2 ? ["missing_hook_caption_animation_cues"] : []),
      ...unsafe,
    ], 8),
  };
}

function audioPolicySummary(editPlan = {}) {
  const policy = editPlan.audioPolicy && typeof editPlan.audioPolicy === "object" && !Array.isArray(editPlan.audioPolicy)
    ? editPlan.audioPolicy
    : null;
  const audioMode = policy ? sanitizeText(policy.audioMode, 40) : null;
  const licenseStatus = policy ? sanitizeText(policy.licenseStatus, 48) : null;
  const source = policy ? sanitizeText(policy.source, 80).toLowerCase() : "";
  const unsafeSource = /trending|copyrighted|spotify|apple_music|youtube_music|commercial_track/.test(source);
  const passed = Boolean(
    policy &&
    AUDIO_MODES.includes(audioMode) &&
    AUDIO_LICENSE_STATUSES.includes(licenseStatus) &&
    policy.copyrightedTrackBundled === false &&
    !unsafeSource &&
    !policy.copyrightEvasion &&
    !policy.bypassDetection &&
    !policy.avoidCopyrightDetection
  );
  return {
    passed,
    audioMode,
    licenseStatus,
    externalAudioBundled: Boolean(policy && policy.externalAudioBundled),
    copyrightedTrackBundled: Boolean(policy && policy.copyrightedTrackBundled),
    operatorActionRequired: Boolean(policy && policy.operatorActionRequired),
    reasons: safeCodes([
      ...(!policy ? ["missing_audio_policy"] : []),
      ...(policy && !AUDIO_MODES.includes(audioMode) ? ["audio_mode_invalid"] : []),
      ...(policy && !AUDIO_LICENSE_STATUSES.includes(licenseStatus) ? ["audio_license_status_invalid"] : []),
      ...(policy && policy.copyrightedTrackBundled !== false ? ["copyrighted_audio_bundled"] : []),
      ...(policy && unsafeSource ? ["unsafe_audio_source"] : []),
      ...(policy && (policy.copyrightEvasion || policy.bypassDetection || policy.avoidCopyrightDetection) ? ["audio_policy_unsafe"] : []),
    ], 8),
  };
}

function creativeStyleSummary(editPlan = {}) {
  const style = editPlan.creativeStyleTransforms && typeof editPlan.creativeStyleTransforms === "object" && !Array.isArray(editPlan.creativeStyleTransforms)
    ? editPlan.creativeStyleTransforms
    : null;
  const mildZoom = style ? numberOrNull(style.mildZoom) : null;
  const passed = Boolean(
    style &&
    style.mirror === false &&
    style.copyrightEvasion === false &&
    style.watermarkObscuring === false &&
    mildZoom != null &&
    mildZoom >= 1 &&
    mildZoom <= 1.05
  );
  return {
    passed,
    colorGrade: style ? sanitizeText(style.colorGrade || "unknown", 40) : null,
    mildZoom: mildZoom == null ? null : round(mildZoom, 2),
    mirror: Boolean(style && style.mirror),
    copyrightEvasion: Boolean(style && style.copyrightEvasion),
    watermarkObscuring: Boolean(style && style.watermarkObscuring),
    reasons: safeCodes([
      ...(!style ? ["missing_creative_style_transforms"] : []),
      ...(style && style.mirror !== false ? ["mirror_transform_not_allowed"] : []),
      ...(style && style.copyrightEvasion !== false ? ["copyright_evasion_style"] : []),
      ...(style && style.watermarkObscuring !== false ? ["watermark_obscuring_style"] : []),
      ...(style && (mildZoom == null || mildZoom < 1 || mildZoom > 1.05) ? ["creative_zoom_out_of_bounds"] : []),
    ], 8),
  };
}

function renderLayoutSummary(editPlan = {}, goalSelectionMode = "balanced", options = {}) {
  const qa = editPlan.renderPolishQA && typeof editPlan.renderPolishQA === "object" && !Array.isArray(editPlan.renderPolishQA)
    ? editPlan.renderPolishQA
    : null;
  const required = sanitizeText(goalSelectionMode || "balanced", 40) === "valid_goals_only" &&
    options.requireRenderedGoalVisibility !== false;
  const actionLayoutMode = qa ? sanitizeText(qa.actionLayoutMode || "unknown", 60) : null;
  const splitLayoutCaptionCount = qa ? numberOrNull(qa.splitLayoutCaptionCount) : null;
  const allowedCleanModes = ["clean_action_letterbox", "clean_action_crop", "clean_action_full_frame"];
  const referenceVerticalFillValid = Boolean(
    qa &&
    actionLayoutMode === "scorebug_preserved_vertical_fill" &&
    qa.fullHeightActionCrop === true &&
    qa.scoreboardOverlayRendered === true &&
    sanitizeText(qa.scoreboardOverlayRegionId || "", 80)
  );
  const cleanModeValid = allowedCleanModes.includes(actionLayoutMode) || referenceVerticalFillValid;
  const passed = !required || Boolean(
    qa &&
    qa.cleanActionLayoutRequired === true &&
    qa.cleanActionLayoutPassed === true &&
    cleanModeValid &&
    qa.blurredBackgroundUsed !== true &&
    qa.duplicateBackgroundUsed !== true &&
    (splitLayoutCaptionCount == null || splitLayoutCaptionCount === 0)
  );
  const reasons = safeCodes([
    ...(required && !qa ? ["render_layout_summary_missing"] : []),
    ...(required && qa && qa.cleanActionLayoutRequired !== true ? ["clean_action_layout_not_required_by_renderer"] : []),
    ...(required && qa && qa.cleanActionLayoutPassed !== true ? ["clean_action_layout_failed"] : []),
    ...(required && qa && !cleanModeValid ? ["non_clean_action_layout"] : []),
    ...(required && qa && actionLayoutMode === "scorebug_preserved_vertical_fill" && !referenceVerticalFillValid
      ? ["invalid_scorebug_vertical_fill_contract"]
      : []),
    ...(required && qa && qa.blurredBackgroundUsed === true ? ["blurred_duplicate_background_used"] : []),
    ...(required && qa && qa.duplicateBackgroundUsed === true ? ["duplicate_background_used"] : []),
    ...(required && qa && splitLayoutCaptionCount != null && splitLayoutCaptionCount > 0 ? ["split_caption_layout_used"] : []),
  ], 8);
  return {
    passed,
    required,
    actionLayoutMode,
    cleanActionLayoutRequired: qa ? Boolean(qa.cleanActionLayoutRequired) : null,
    cleanActionLayoutPassed: qa ? Boolean(qa.cleanActionLayoutPassed) : null,
    blurredBackgroundUsed: qa ? Boolean(qa.blurredBackgroundUsed) : null,
    duplicateBackgroundUsed: qa ? Boolean(qa.duplicateBackgroundUsed) : null,
    splitLayoutCaptionCount,
    reasons,
  };
}

function segmentList(editPlan = {}) {
  if (Array.isArray(editPlan.segments) && editPlan.segments.length) return editPlan.segments;
  if (!editPlan || typeof editPlan !== "object") return [];
  return [{
    id: editPlan.candidateId || "single_segment",
    sourceStart: editPlan.sourceStart,
    sourceEnd: editPlan.sourceEnd,
    highlightType: editPlan.highlightType,
    reasonCodes: editPlan.reasonCodes,
    goalOutcome: editPlan.goalOutcome,
    goalNumber: editPlan.goalNumber,
    scoreBefore: editPlan.scoreBefore,
    scoreAfter: editPlan.scoreAfter,
    scoreChangeTime: editPlan.scoreChangeTime,
    confidence: editPlan.confidence,
    replayOnly: editPlan.replayOnly,
    replayUsed: editPlan.replayUsed,
    finishFrameEvidence: editPlan.finishFrameEvidence,
    phaseCoverage: editPlan.phaseCoverage,
    shotStart: editPlan.shotStart,
    finishTime: editPlan.finishTime,
    confirmationTime: editPlan.confirmationTime,
  }];
}

function isConfirmedGoalSegment(segment = {}) {
  return segment.highlightType === "goal" &&
    segment.goalOutcome &&
    segment.goalOutcome.eventType === "ball_in_net" &&
    segment.goalOutcome.outcome === "confirmed_goal";
}

function segmentContainsTime(segment = {}, time) {
  if (time == null) return false;
  const start = numberOrNull(segment.sourceStart);
  const end = numberOrNull(segment.sourceEnd);
  return start != null && end != null && time >= start - MATCH_TOLERANCE_SECONDS && time <= end + MATCH_TOLERANCE_SECONDS;
}

function overlapSeconds(segment = {}, expected = {}) {
  if (!expected.sourceWindow) return 0;
  const start = numberOrNull(segment.sourceStart);
  const end = numberOrNull(segment.sourceEnd);
  if (start == null || end == null) return 0;
  const left = Math.max(start, expected.sourceWindow.start);
  const right = Math.min(end, expected.sourceWindow.end);
  return Math.max(0, right - left);
}

function segmentDuration(segment = {}) {
  const start = numberOrNull(segment.sourceStart);
  const end = numberOrNull(segment.sourceEnd);
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

function pairOverlap(leftSegment = {}, rightSegment = {}) {
  const leftStart = numberOrNull(leftSegment.sourceStart);
  const leftEnd = numberOrNull(leftSegment.sourceEnd);
  const rightStart = numberOrNull(rightSegment.sourceStart);
  const rightEnd = numberOrNull(rightSegment.sourceEnd);
  if (leftStart == null || leftEnd == null || rightStart == null || rightEnd == null) {
    return { seconds: 0, ratio: 0 };
  }
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  const shortest = Math.min(segmentDuration(leftSegment) || 0, segmentDuration(rightSegment) || 0);
  return {
    seconds: overlap,
    ratio: shortest > 0 ? overlap / shortest : 0,
  };
}

function scoreChangeIdentity(segment = {}) {
  const goalOutcome = segment.goalOutcome && typeof segment.goalOutcome === "object" && !Array.isArray(segment.goalOutcome)
    ? segment.goalOutcome
    : {};
  const scoreBefore = sanitizeText(segment.scoreBefore || goalOutcome.scoreBefore || "", 16);
  const scoreAfter = sanitizeText(segment.scoreAfter || goalOutcome.scoreAfter || "", 16);
  const scoreChangeTime = numberOrNull(segment.scoreChangeTime ?? goalOutcome.scoreChangeTime);
  if (!scoreBefore || !scoreAfter || scoreChangeTime == null) return null;
  return {
    scoreBefore,
    scoreAfter,
    scoreChangeTime,
    key: `${scoreBefore}->${scoreAfter}@${Math.round(scoreChangeTime / DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS)}`,
  };
}

function hasScoreboardBacktrackContext(segment = {}, confirmationTime = null) {
  const sourceStart = numberOrNull(segment.sourceStart);
  const confirmedAt = numberOrNull(
    confirmationTime ??
    segment.scoreChangeTime ??
    segment.confirmationTime ??
    (segment.phaseCoverage && segment.phaseCoverage.scoreChangeTime) ??
    (segment.phaseCoverage && segment.phaseCoverage.confirmationTime) ??
    (segment.goalOutcome && segment.goalOutcome.scoreChangeTime) ??
    (segment.goalOutcome && segment.goalOutcome.decisionTimestamp),
  );
  return sourceStart != null &&
    confirmedAt != null &&
    sourceStart <= confirmedAt - MIN_SCORE_CHANGE_BACKTRACK_SECONDS;
}

function publicGoalIdentity(segment = {}, index = 0) {
  const identity = scoreChangeIdentity(segment);
  return {
    segmentIndex: index + 1,
    id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
    goalNumber: numberOrNull(segment.goalNumber),
    sourceStart: round(segment.sourceStart),
    sourceEnd: round(segment.sourceEnd),
    finishTime: numberOrNull(segment.finishTime),
    confirmationTime: numberOrNull(segment.confirmationTime),
    scoreBefore: identity ? identity.scoreBefore : null,
    scoreAfter: identity ? identity.scoreAfter : null,
    scoreChangeTime: identity ? round(identity.scoreChangeTime) : null,
  };
}

function isDistinctConfirmedGoalPair(leftSegment = {}, rightSegment = {}, leftFinish = null, rightFinish = null, leftScore = null, rightScore = null) {
  const leftGoalNumber = numberOrNull(leftSegment.goalNumber);
  const rightGoalNumber = numberOrNull(rightSegment.goalNumber);
  const differentGoalNumbers = leftGoalNumber != null &&
    rightGoalNumber != null &&
    leftGoalNumber !== rightGoalNumber;
  const differentScoreChanges = leftScore &&
    rightScore &&
    (
      leftScore.scoreBefore !== rightScore.scoreBefore ||
      leftScore.scoreAfter !== rightScore.scoreAfter ||
      Math.abs(leftScore.scoreChangeTime - rightScore.scoreChangeTime) > DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS
    );
  const distinctFinishFrames = leftFinish != null &&
    rightFinish != null &&
    Math.abs(leftFinish - rightFinish) > DUPLICATE_FINISH_TOLERANCE_SECONDS;
  return differentGoalNumbers && (differentScoreChanges || distinctFinishFrames);
}

function isCloseDistinctScoreChangePair(leftScore = null, rightScore = null) {
  if (!leftScore || !rightScore) return false;
  const differentTransition = leftScore.scoreBefore !== rightScore.scoreBefore ||
    leftScore.scoreAfter !== rightScore.scoreAfter;
  const gap = Math.abs(leftScore.scoreChangeTime - rightScore.scoreChangeTime);
  return differentTransition &&
    gap > DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS &&
    gap <= CLOSE_SCORE_CHANGE_OVERLAP_SECONDS;
}

function distinctGoalIdentitySummary(segments = []) {
  const confirmed = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => isConfirmedGoalSegment(segment));
  const duplicatePairs = [];
  const duplicateGoalNumbers = [];
  const outOfOrder = [];
  const seenGoalNumbers = new Map();

  confirmed.forEach(({ segment, index }, orderIndex) => {
    const goalNumber = numberOrNull(segment.goalNumber);
    if (goalNumber != null) {
      if (seenGoalNumbers.has(goalNumber)) {
        duplicateGoalNumbers.push({
          goalNumber,
          firstSegmentIndex: seenGoalNumbers.get(goalNumber) + 1,
          duplicateSegmentIndex: index + 1,
          reason: "duplicate_goal_number",
        });
      } else {
        seenGoalNumbers.set(goalNumber, index);
      }
    }
    if (orderIndex > 0) {
      const previous = confirmed[orderIndex - 1].segment;
      const previousStart = numberOrNull(previous.sourceStart);
      const currentStart = numberOrNull(segment.sourceStart);
      const previousConfirmation = numberOrNull(previous.confirmationTime);
      const currentConfirmation = numberOrNull(segment.confirmationTime);
      if (
        (previousStart != null && currentStart != null && currentStart < previousStart) ||
        (previousConfirmation != null && currentConfirmation != null && currentConfirmation < previousConfirmation)
      ) {
        outOfOrder.push({
          segmentIndex: index + 1,
          previousSegmentIndex: confirmed[orderIndex - 1].index + 1,
          reason: "goal_segments_not_chronological",
        });
      }
    }
  });

  for (let leftIndex = 0; leftIndex < confirmed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < confirmed.length; rightIndex += 1) {
      const left = confirmed[leftIndex];
      const right = confirmed[rightIndex];
      const overlap = pairOverlap(left.segment, right.segment);
      const leftFinish = numberOrNull(left.segment.finishTime);
      const rightFinish = numberOrNull(right.segment.finishTime);
      const leftScore = scoreChangeIdentity(left.segment);
      const rightScore = scoreChangeIdentity(right.segment);
      const reasons = [];
      const distinctPair = isDistinctConfirmedGoalPair(left.segment, right.segment, leftFinish, rightFinish, leftScore, rightScore);
      const closeDistinctScoreChanges = isCloseDistinctScoreChangePair(leftScore, rightScore);
      if (overlap.ratio > MAX_GOAL_SEGMENT_OVERLAP_RATIO && !closeDistinctScoreChanges) {
        reasons.push(distinctPair ? "overlapping_goal_windows_need_separate_live_phases" : "duplicate_goal_window_overlap");
      }
      if (leftFinish != null && rightFinish != null && Math.abs(leftFinish - rightFinish) <= DUPLICATE_FINISH_TOLERANCE_SECONDS) {
        reasons.push("duplicate_finish_time");
      }
      if (
        leftScore &&
        rightScore &&
        leftScore.scoreBefore === rightScore.scoreBefore &&
        leftScore.scoreAfter === rightScore.scoreAfter &&
        Math.abs(leftScore.scoreChangeTime - rightScore.scoreChangeTime) <= DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS
      ) {
        reasons.push("duplicate_score_change_identity");
      }
      if (reasons.length) {
        duplicatePairs.push({
          leftSegmentIndex: left.index + 1,
          rightSegmentIndex: right.index + 1,
          leftGoalNumber: numberOrNull(left.segment.goalNumber),
          rightGoalNumber: numberOrNull(right.segment.goalNumber),
          overlapSeconds: round(overlap.seconds),
          overlapRatio: round(overlap.ratio, 3),
          finishDeltaSeconds: leftFinish == null || rightFinish == null ? null : round(Math.abs(leftFinish - rightFinish)),
          reasons: safeCodes(reasons, 4),
        });
      }
    }
  }

  const duplicateSegmentIndexes = [...new Set([
    ...duplicatePairs.map((pair) => pair.rightSegmentIndex),
    ...duplicateGoalNumbers.map((item) => item.duplicateSegmentIndex),
  ])].sort((a, b) => a - b);
  const uniqueConfirmedGoalCount = Math.max(0, confirmed.length - duplicateSegmentIndexes.length);
  const failedReasons = safeCodes([
    ...(duplicatePairs.length ? ["duplicate_goal_segments_detected"] : []),
    ...(duplicateGoalNumbers.length ? ["duplicate_goal_numbers_detected"] : []),
    ...(outOfOrder.length ? ["goal_segments_not_chronological"] : []),
  ], 8);

  return {
    passed: failedReasons.length === 0,
    confirmedGoalSegmentCount: confirmed.length,
    uniqueConfirmedGoalCount,
    maxAllowedOverlapRatio: MAX_GOAL_SEGMENT_OVERLAP_RATIO,
    duplicateSegmentIndexes: duplicateSegmentIndexes.slice(0, MAX_PUBLIC_ITEMS),
    goalIdentities: confirmed.map(({ segment, index }) => publicGoalIdentity(segment, index)).slice(0, MAX_PUBLIC_ITEMS),
    duplicatePairs: duplicatePairs.slice(0, MAX_PUBLIC_ITEMS),
    duplicateGoalNumbers: duplicateGoalNumbers.slice(0, MAX_PUBLIC_ITEMS),
    outOfOrder: outOfOrder.slice(0, MAX_PUBLIC_ITEMS),
    failedReasons,
  };
}

function referenceStyleDurationSummary(editPlan = {}, expectedGoals = []) {
  const totalDuration = numberOrNull(editPlan.totalDuration ?? editPlan.durationSeconds ?? editPlan.timelineDuration);
  const targetApplies = expectedGoals.length >= REFERENCE_STYLE_GOAL_COUNT;
  const reasons = safeCodes([
    ...(targetApplies && totalDuration == null ? ["reference_style_duration_missing"] : []),
    ...(targetApplies && totalDuration != null && (
      totalDuration < REFERENCE_STYLE_MIN_DURATION_SECONDS ||
      totalDuration > REFERENCE_STYLE_MAX_DURATION_SECONDS
    ) ? ["reference_style_duration_out_of_bounds"] : []),
  ], 6);
  return {
    passed: reasons.length === 0,
    targetApplies,
    totalDuration: totalDuration == null ? null : round(totalDuration),
    targetMinSeconds: targetApplies ? REFERENCE_STYLE_MIN_DURATION_SECONDS : null,
    targetMaxSeconds: targetApplies ? REFERENCE_STYLE_MAX_DURATION_SECONDS : null,
    reasons,
  };
}

function expectedGoalsFromTruth(matchEventTruth = {}) {
  const truth = publicMatchEventTruth(matchEventTruth);
  const scoreChanges = (Array.isArray(truth.scoreChanges) ? truth.scoreChanges : [])
    .filter((change) => change.outcome === "counted_goal")
    .sort((a, b) => Number(a.changeTime || 0) - Number(b.changeTime || 0));
  if (scoreChanges.length) {
    return scoreChanges.map((change, index) => {
      const anchorTime = scoreChangeAnchorTime(change);
      return {
        goalNumber: index + 1,
        source: "score_change",
        anchorTime,
        confirmationTime: anchorTime,
        stableConfirmationTime: numberOrNull(change.changeTime),
        sourceWindow: null,
        scoreBefore: change.startScore || null,
        scoreAfter: change.endScore || null,
      };
    });
  }

  const selectedGoals = (Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [])
    .filter((event) => event.type === "confirmed_goal" && event.outcome === "confirmed_goal")
    .sort((a, b) => Number(a.sourceStart || 0) - Number(b.sourceStart || 0));
  if (selectedGoals.length) {
    return selectedGoals.map((event, index) => ({
      goalNumber: numberOrNull(event.goalNumber) || index + 1,
      source: "match_event_truth",
      anchorTime: numberOrNull(event.shotStart ?? event.scoreChangeTime ?? event.sourceStart),
      confirmationTime: numberOrNull(event.confirmationTime ?? event.scoreChangeTime ?? event.sourceEnd),
      sourceWindow: publicWindow(event),
      scoreBefore: event.scoreBefore || null,
      scoreAfter: event.scoreAfter || null,
    }));
  }

  const countedGoalCount = Number(truth.summary && truth.summary.countedGoalEventCount || 0);
  return Array.from({ length: Math.max(0, Math.min(7, countedGoalCount)) }, (_, index) => ({
    goalNumber: index + 1,
    source: "summary_count",
    anchorTime: null,
    confirmationTime: null,
    sourceWindow: null,
    scoreBefore: null,
    scoreAfter: null,
  }));
}

function scoreChangeAnchorTime(change = {}) {
  const changeTime = numberOrNull(change.changeTime);
  const firstSeenAt = numberOrNull(change.firstSeenAt);
  const actionAnchorTime = numberOrNull(change.actionAnchorTime);
  if (
    change.hasPendingObservation === true &&
    firstSeenAt != null &&
    (changeTime == null || (
      firstSeenAt <= changeTime &&
      changeTime - firstSeenAt <= 70
    ))
  ) {
    return firstSeenAt;
  }
  return changeTime == null ? actionAnchorTime : changeTime;
}

function segmentFailureReasons(segment = {}, goalSelectionMode = "balanced", options = {}) {
  const requireRenderedGoalVisibility = options.requireRenderedGoalVisibility !== false;
  const reasons = [];
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" ? segment.phaseCoverage : {};
  const visualGoalPayoff = phase.visualGoalPayoff &&
    typeof phase.visualGoalPayoff === "object" &&
    !Array.isArray(phase.visualGoalPayoff)
    ? phase.visualGoalPayoff
    : {};
  const requiresRenderedFinishProof = Boolean(
    phase.requiresRenderedFinishProof ||
    visualGoalPayoff.requiresRenderedFinishProof ||
    segment.requiresRenderedFinishProof
  );
  const allowPreRenderFinishProbe = !requireRenderedGoalVisibility && requiresRenderedFinishProof;
  const shotStart = numberOrNull(segment.shotStart ?? phase.shotStart);
  const finishTime = numberOrNull(segment.finishTime ?? phase.finishTime);
  const confirmationTime = numberOrNull(segment.confirmationTime ?? phase.confirmationTime);
  const reasonCodes = new Set(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []);
  const confirmedGoal = isConfirmedGoalSegment(segment);
  const humanVisibleGoalGate = confirmedGoal && requireRenderedGoalVisibility
    ? validateHumanVisibleGoalSequence({ segment })
    : null;

  if (goalSelectionMode === "valid_goals_only" && !confirmedGoal) reasons.push("non_goal_segment_in_valid_goals_only_output");
  if (confirmedGoal && (segment.replayOnly || phase.replayOnly)) reasons.push("replay_only_goal_segment");
  if (confirmedGoal && (segment.celebrationOnly || phase.celebrationOnly)) reasons.push("celebration_only_goal_segment");
  if (confirmedGoal && (!phase.hasBuildup || shotStart == null)) reasons.push("missing_buildup_or_shot_start");
  if (confirmedGoal && (!phase.hasShot || shotStart == null)) reasons.push("missing_visible_shot");
  if (confirmedGoal && (!phase.hasFinish || finishTime == null) && !allowPreRenderFinishProbe) {
    reasons.push("missing_visible_finish");
  }
  if (confirmedGoal && (!phase.hasConfirmation || confirmationTime == null)) reasons.push("missing_goal_confirmation");
  if (confirmedGoal && humanVisibleGoalGate && humanVisibleGoalGate.passed !== true) {
    reasons.push("rendered_goal_visibility_failed");
    if (humanVisibleGoalGate.failureCode) reasons.push(String(humanVisibleGoalGate.failureCode).toLowerCase());
  }
  if (
    confirmedGoal &&
    shotStart != null &&
    numberOrNull(segment.sourceStart) != null &&
    shotStart - numberOrNull(segment.sourceStart) < MIN_PRE_SHOT_CONTEXT_SECONDS &&
    !hasScoreboardBacktrackContext(segment, confirmationTime)
  ) {
    reasons.push("insufficient_pre_shot_context");
  }
  if (
    confirmedGoal &&
    (reasonCodes.has("visual_celebration_after_shot") || reasonCodes.has("visual_celebration_after_whistle")) &&
    (!phase.hasShot || !phase.hasFinish)
  ) {
    reasons.push("celebration_only_goal_segment");
  }
  if (
    confirmedGoal &&
    goalSelectionMode === "valid_goals_only" &&
    !hasAny([...reasonCodes], [
      "scoreboard_ocr_score_change",
      "scoreboard_backed_goal_sequence",
      "scoreboard_temporal_consistency",
      "visual_scoreboard_goal_confirmed",
    ])
  ) {
    reasons.push("missing_score_change_evidence");
  }
  return safeCodes(reasons, 8);
}

function scoreChangeMatchRequirements(segment = {}, expected = {}) {
  if (expected.source !== "score_change") return { matches: true, reasons: [] };
  const reasons = [];
  const sourceStart = numberOrNull(segment.sourceStart);
  const shotStart = numberOrNull(segment.shotStart ?? (segment.phaseCoverage && segment.phaseCoverage.shotStart));
  const finishTime = numberOrNull(segment.finishTime ?? (segment.phaseCoverage && segment.phaseCoverage.finishTime));
  const confirmationTime = numberOrNull(expected.confirmationTime);
  const anchorTime = numberOrNull(expected.anchorTime);
  const segmentScore = scoreChangeIdentity(segment);

  if (segmentScore && expected.scoreBefore && segmentScore.scoreBefore !== expected.scoreBefore) {
    reasons.push("score_before_mismatch");
  }
  if (segmentScore && expected.scoreAfter && segmentScore.scoreAfter !== expected.scoreAfter) {
    reasons.push("score_after_mismatch");
  }
  if (
    confirmationTime != null &&
    segmentScore &&
    Math.abs(segmentScore.scoreChangeTime - confirmationTime) > DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS
  ) {
    reasons.push("score_change_time_mismatch");
  }
  if (
    confirmationTime != null &&
    sourceStart != null &&
    sourceStart > confirmationTime - MIN_SCORE_CHANGE_BACKTRACK_SECONDS
  ) {
    reasons.push("missing_scoreboard_backtrack_context");
  }
  if (shotStart != null && confirmationTime != null && shotStart >= confirmationTime - 1) {
    reasons.push("shot_not_before_scoreboard_change");
  }
  if (finishTime != null && confirmationTime != null && finishTime >= confirmationTime - 0.25) {
    reasons.push("finish_not_before_scoreboard_change");
  }
  if (
    shotStart != null &&
    sourceStart != null &&
    shotStart - sourceStart < MIN_PRE_SHOT_CONTEXT_SECONDS &&
    !hasScoreboardBacktrackContext(segment, confirmationTime)
  ) {
    reasons.push("insufficient_pre_shot_context");
  }
  return {
    matches: reasons.length === 0,
    reasons: safeCodes(reasons, 8),
  };
}

function matchExpectedGoals(expectedGoals = [], segments = [], options = {}) {
  const matches = [];
  const usedSegments = new Set();
  for (const expected of expectedGoals) {
    const candidates = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ index }) => !usedSegments.has(index))
      .filter(({ segment }) => isConfirmedGoalSegment(segment))
      .map(({ segment, index }) => ({
        segment,
        index,
        score: (() => {
          const segmentScore = scoreChangeIdentity(segment);
          const sameScoreTransition = segmentScore &&
            expected.scoreBefore &&
            expected.scoreAfter &&
            segmentScore.scoreBefore === expected.scoreBefore &&
            segmentScore.scoreAfter === expected.scoreAfter;
          const sameScoreChangeTime = sameScoreTransition &&
            expected.confirmationTime != null &&
            Math.abs(segmentScore.scoreChangeTime - expected.confirmationTime) <= DUPLICATE_SCORE_CHANGE_TOLERANCE_SECONDS;
          return [
            numberOrNull(segment.goalNumber) === expected.goalNumber ? 4 : 0,
            sameScoreTransition ? 5 : 0,
            sameScoreChangeTime ? 3 : 0,
            segmentContainsTime(segment, expected.anchorTime) ? 3 : 0,
            segmentContainsTime(segment, expected.confirmationTime) ? 2 : 0,
            overlapSeconds(segment, expected) > 0.5 ? 2 : 0,
          ].reduce((sum, value) => sum + value, 0);
        })(),
        scoreChangeRequirements: scoreChangeMatchRequirements(segment, expected),
      }))
      .filter((candidate) => {
        if (expected.source === "score_change") return candidate.score > 0 && candidate.scoreChangeRequirements.matches;
        return candidate.score > 0 || expected.anchorTime == null;
      })
      .sort((a, b) => b.score - a.score || Number(a.segment.sourceStart || 0) - Number(b.segment.sourceStart || 0));
    const selected = candidates[0] || null;
    if (!selected) {
      const unmatchedReasons = segments
        .filter(isConfirmedGoalSegment)
        .flatMap((segment) => scoreChangeMatchRequirements(segment, expected).reasons);
      matches.push({
        expected,
        segmentIndex: null,
        covered: false,
        reasons: safeCodes(["missing_goal_segment", ...unmatchedReasons], 8),
      });
      continue;
    }
    usedSegments.add(selected.index);
    const failures = safeCodes([
      ...segmentFailureReasons(selected.segment, "valid_goals_only", options),
      ...selected.scoreChangeRequirements.reasons,
    ], 8);
    matches.push({
      expected,
      segmentIndex: selected.index + 1,
      covered: failures.length === 0,
      reasons: failures,
    });
  }
  return matches;
}

function renderedGoalVisibilitySummary(segments = [], options = {}) {
  const requireRenderedGoalVisibility = options.requireRenderedGoalVisibility !== false;
  const goals = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => isConfirmedGoalSegment(segment))
    .map(({ segment, index }) => {
      const gate = validateHumanVisibleGoalSequence({ segment });
      const publicGate = publicHumanVisibleGoalGate(gate);
      return {
        index: index + 1,
        goalNumber: numberOrNull(segment.goalNumber),
        segmentId: sanitizeText(segment.id || `segment_${index + 1}`, 80),
        sourceStart: round(segment.sourceStart),
        sourceEnd: round(segment.sourceEnd),
        finishTime: numberOrNull(segment.finishTime),
        passed: Boolean(gate.passed),
        confidence: numberOrNull(gate.confidence),
        failureCode: gate.failureCode ? sanitizeText(gate.failureCode, 60) : null,
        evidence: publicGate.evidence,
        finishFrameEvidence: publicGate.finishFrameEvidence,
        contactSheetFrames: Array.isArray(gate.sampledFrames)
          ? gate.sampledFrames.map((frame) => ({
              label: sanitizeText(frame && frame.label, 40),
              time: numberOrNull(frame && frame.time),
            })).filter((frame) => frame.label && frame.time != null).slice(0, 8)
          : [],
      };
    });
  const clear = goals.filter((goal) => goal.passed === true && goal.finishFrameEvidence?.visibilityVerdict === "clear");
  const borderline = goals.filter((goal) => goal.finishFrameEvidence?.visibilityVerdict === "borderline");
  const failed = goals.filter((goal) => goal.passed !== true && goal.finishFrameEvidence?.visibilityVerdict !== "borderline");
  const strictPassed = failed.length === 0 && borderline.length === 0 && clear.length === goals.length;
  return {
    passed: requireRenderedGoalVisibility ? strictPassed : true,
    required: requireRenderedGoalVisibility,
    status: requireRenderedGoalVisibility ? (strictPassed ? "passed" : "failed") : "pre_render_skipped",
    goalCount: goals.length,
    visibleGoalCount: clear.length,
    clearGoalCount: clear.length,
    borderlineGoalCount: borderline.length,
    failedGoalCount: failed.length,
    humanVisibleGoalsClear: clear.length,
    humanVisibleGoalsBorderline: borderline.length,
    humanVisibleGoalsFailed: failed.length,
    finishFrameContactSheetRequired: goals.length > 0,
    contactSheetFramesByGoal: goals.map((goal) => ({
      goalNumber: goal.goalNumber,
      segmentIndex: goal.index,
      frames: goal.contactSheetFrames,
    })).slice(0, MAX_PUBLIC_ITEMS),
    goals: goals.slice(0, MAX_PUBLIC_ITEMS),
    clearGoals: clear.slice(0, MAX_PUBLIC_ITEMS),
    borderlineGoals: borderline.slice(0, MAX_PUBLIC_ITEMS),
    failedGoals: failed.slice(0, MAX_PUBLIC_ITEMS),
    reasons: requireRenderedGoalVisibility
      ? safeCodes([
          ...(failed.length ? ["rendered_goal_visibility_failed"] : []),
          ...(borderline.length ? ["borderline_goal_visibility"] : []),
          ...(clear.length !== goals.length ? ["human_visible_clear_goal_count_mismatch"] : []),
          ...failed.map((goal) => goal.failureCode && goal.failureCode.toLowerCase()).filter(Boolean),
        ], 10)
      : [],
  };
}

function assertVideoOutputCoverage({
  editPlan,
  matchEventTruth,
  goalSelectionMode = "balanced",
  requireRenderedGoalVisibility = true,
} = {}) {
  if (!editPlan || typeof editPlan !== "object" || hasUnsafeValue(editPlan)) {
    throw new AppError("VIDEO_OUTPUT_QA_FAILED", SAFE_MESSAGES.VIDEO_OUTPUT_QA_FAILED, 422);
  }
  const mode = sanitizeText(goalSelectionMode || "balanced", 40);
  const gateOptions = { requireRenderedGoalVisibility: requireRenderedGoalVisibility !== false };
  const segments = segmentList(editPlan);
  const expectedGoals = expectedGoalsFromTruth(matchEventTruth);
  const publicSegments = segments.map(publicSegment);
  const invalidSegments = segments
    .map((segment, index) => ({
      index: index + 1,
      id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
      reasons: segmentFailureReasons(segment, mode, gateOptions),
    }))
    .filter((item) => item.reasons.length)
    .slice(0, MAX_PUBLIC_ITEMS);
  const confirmedGoalSegments = segments.filter(isConfirmedGoalSegment);
  const matches = matchExpectedGoals(expectedGoals, segments, gateOptions);
  const coveredGoalCount = matches.filter((match) => match.covered).length;
  const hook = hookSummary(editPlan);
  const captions = captionStyleSummary(editPlan);
  const animations = animationSummary(editPlan);
  const audioPolicy = audioPolicySummary(editPlan);
  const creativeStyle = creativeStyleSummary(editPlan);
  const renderLayout = renderLayoutSummary(editPlan, mode, gateOptions);
  const distinctGoalIdentity = distinctGoalIdentitySummary(segments);
  const referenceStyleDuration = referenceStyleDurationSummary(editPlan, expectedGoals);
  const renderedGoalVisibility = renderedGoalVisibilitySummary(segments, gateOptions);
  const creativeContractPassed = hook.passed &&
    captions.passed &&
    animations.passed &&
    audioPolicy.passed &&
    creativeStyle.passed &&
    renderLayout.passed &&
    referenceStyleDuration.passed &&
    renderedGoalVisibility.passed;
  const extraGoalSegmentCount = expectedGoals.length > 0
    ? Math.max(0, confirmedGoalSegments.length - expectedGoals.length)
    : confirmedGoalSegments.length;
  const failedReasons = safeCodes([
    ...(mode === "valid_goals_only" && expectedGoals.length === 0 ? ["no_counted_goal_truth"] : []),
    ...(mode === "valid_goals_only" && segments.some((segment) => !isConfirmedGoalSegment(segment)) ? ["non_goal_segments_present"] : []),
    ...(matches.some((match) => !match.covered) ? ["missing_or_invalid_counted_goal_segment"] : []),
    ...(extraGoalSegmentCount > 0 ? ["unexpected_extra_goal_segment"] : []),
    ...distinctGoalIdentity.failedReasons,
    ...(invalidSegments.length ? ["invalid_segment_coverage"] : []),
    ...hook.reasons,
    ...captions.reasons,
    ...animations.reasons,
    ...audioPolicy.reasons,
    ...creativeStyle.reasons,
    ...renderLayout.reasons,
    ...referenceStyleDuration.reasons,
    ...renderedGoalVisibility.reasons,
  ], 10);
  const passed = mode !== "valid_goals_only"
    ? invalidSegments.length === 0 && distinctGoalIdentity.passed && creativeContractPassed
    : expectedGoals.length > 0 &&
      coveredGoalCount === expectedGoals.length &&
      confirmedGoalSegments.length === expectedGoals.length &&
      distinctGoalIdentity.passed &&
      renderedGoalVisibility.passed &&
      invalidSegments.length === 0 &&
      segments.every(isConfirmedGoalSegment) &&
      creativeContractPassed;

  const report = {
    schemaVersion: OUTPUT_GATE_SCHEMA_VERSION,
    status: passed ? "passed" : "failed",
    passed,
    goalSelectionMode: mode,
    requireRenderedGoalVisibility: gateOptions.requireRenderedGoalVisibility,
    expectedGoalCount: expectedGoals.length,
    actualSegmentCount: segments.length,
    actualConfirmedGoalSegmentCount: confirmedGoalSegments.length,
    coveredGoalCount,
    humanVisibleGoalsClear: renderedGoalVisibility.humanVisibleGoalsClear,
    humanVisibleGoalsBorderline: renderedGoalVisibility.humanVisibleGoalsBorderline,
    humanVisibleGoalsFailed: renderedGoalVisibility.humanVisibleGoalsFailed,
    missingGoalNumbers: matches
      .filter((match) => !match.covered)
      .map((match) => match.expected.goalNumber)
      .slice(0, MAX_PUBLIC_ITEMS),
    extraGoalSegmentCount,
    distinctGoalIdentity,
    referenceStyleDuration,
    renderedGoalVisibility,
    expectedGoals: expectedGoals.map(publicExpectedGoal).slice(0, MAX_PUBLIC_ITEMS),
    matches: matches.map((match) => ({
      goalNumber: match.expected.goalNumber,
      segmentIndex: match.segmentIndex,
      covered: match.covered,
      reasons: safeCodes(match.reasons, 8),
    })).slice(0, MAX_PUBLIC_ITEMS),
    invalidSegments,
    segments: publicSegments.slice(0, MAX_PUBLIC_ITEMS),
    hook,
    captions,
    animations,
    audioPolicy,
    creativeStyle,
    renderLayout,
    failedReasons,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };

  if (!passed) {
    throw new AppError("VIDEO_OUTPUT_QA_FAILED", SAFE_MESSAGES.VIDEO_OUTPUT_QA_FAILED, 422, report);
  }
  return report;
}

module.exports = {
  assertVideoOutputCoverage,
  animationSummary,
  audioPolicySummary,
  captionStyleSummary,
  creativeStyleSummary,
  expectedGoalsFromTruth,
  hookSummary,
  renderLayoutSummary,
  renderedGoalVisibilitySummary,
};
