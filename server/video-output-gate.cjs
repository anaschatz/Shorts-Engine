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

const OUTPUT_GATE_SCHEMA_VERSION = 1;
const MATCH_TOLERANCE_SECONDS = 2;
const MAX_PUBLIC_ITEMS = 12;
const MIN_SCORE_CHANGE_BACKTRACK_SECONDS = 8;
const MIN_PRE_SHOT_CONTEXT_SECONDS = 6;

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
    replayOnly: Boolean(segment.replayOnly || phaseCoverage.replayOnly),
    replayUsed: Boolean(segment.replayUsed || phaseCoverage.replayUsed),
    phaseCoverage: {
      hasBuildup: Boolean(phaseCoverage.hasBuildup),
      hasShot: Boolean(phaseCoverage.hasShot),
      hasFinish: Boolean(phaseCoverage.hasFinish),
      hasConfirmation: Boolean(phaseCoverage.hasConfirmation),
      replayOnly: Boolean(phaseCoverage.replayOnly),
    },
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
    readableCaptionCount === captions.length;
  const reasons = safeCodes([
    ...(!captions.length ? ["missing_dynamic_captions"] : []),
    ...(captions.length && !openingInHookWindow ? ["missing_readable_opening_hook_caption"] : []),
    ...(captions.length && dynamicCaptionCount !== captions.length ? ["caption_word_timing_invalid"] : []),
    ...(captions.length && readableCaptionCount !== captions.length ? ["caption_readability_failed"] : []),
  ], 8);
  return {
    passed,
    captionCount: captions.length,
    dynamicCaptionCount,
    readableCaptionCount,
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
    confidence: editPlan.confidence,
    replayOnly: editPlan.replayOnly,
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

function expectedGoalsFromTruth(matchEventTruth = {}) {
  const truth = publicMatchEventTruth(matchEventTruth);
  const scoreChanges = (Array.isArray(truth.scoreChanges) ? truth.scoreChanges : [])
    .filter((change) => change.outcome === "counted_goal")
    .sort((a, b) => Number(a.changeTime || 0) - Number(b.changeTime || 0));
  if (scoreChanges.length) {
    return scoreChanges.map((change, index) => ({
      goalNumber: index + 1,
      source: "score_change",
      anchorTime: scoreChangeAnchorTime(change),
      confirmationTime: numberOrNull(change.changeTime),
      sourceWindow: null,
      scoreBefore: change.startScore || null,
      scoreAfter: change.endScore || null,
    }));
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
  const actionAnchorTime = numberOrNull(change.actionAnchorTime);
  if (changeTime == null) return actionAnchorTime;
  if (actionAnchorTime == null) return changeTime;
  return Math.abs(changeTime - actionAnchorTime) <= 30 ? actionAnchorTime : changeTime;
}

function segmentFailureReasons(segment = {}, goalSelectionMode = "balanced") {
  const reasons = [];
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" ? segment.phaseCoverage : {};
  const shotStart = numberOrNull(segment.shotStart ?? phase.shotStart);
  const finishTime = numberOrNull(segment.finishTime ?? phase.finishTime);
  const confirmationTime = numberOrNull(segment.confirmationTime ?? phase.confirmationTime);
  const reasonCodes = new Set(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []);
  const confirmedGoal = isConfirmedGoalSegment(segment);

  if (goalSelectionMode === "valid_goals_only" && !confirmedGoal) reasons.push("non_goal_segment_in_valid_goals_only_output");
  if (confirmedGoal && (segment.replayOnly || phase.replayOnly)) reasons.push("replay_only_goal_segment");
  if (confirmedGoal && (!phase.hasBuildup || shotStart == null)) reasons.push("missing_buildup_or_shot_start");
  if (confirmedGoal && (!phase.hasShot || shotStart == null)) reasons.push("missing_visible_shot");
  if (confirmedGoal && (!phase.hasFinish || finishTime == null)) reasons.push("missing_visible_finish");
  if (confirmedGoal && (!phase.hasConfirmation || confirmationTime == null)) reasons.push("missing_goal_confirmation");
  if (
    confirmedGoal &&
    shotStart != null &&
    numberOrNull(segment.sourceStart) != null &&
    shotStart - numberOrNull(segment.sourceStart) < MIN_PRE_SHOT_CONTEXT_SECONDS
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
  return safeCodes(reasons, 8);
}

function scoreChangeMatchRequirements(segment = {}, expected = {}) {
  if (expected.source !== "score_change") return { matches: true, reasons: [] };
  const reasons = [];
  const sourceStart = numberOrNull(segment.sourceStart);
  const shotStart = numberOrNull(segment.shotStart ?? (segment.phaseCoverage && segment.phaseCoverage.shotStart));
  const confirmationTime = numberOrNull(expected.confirmationTime);
  const anchorTime = numberOrNull(expected.anchorTime);

  if (confirmationTime != null && !segmentContainsTime(segment, confirmationTime)) {
    reasons.push("missing_scoreboard_confirmation_window");
  }
  if (anchorTime != null && !segmentContainsTime(segment, anchorTime)) {
    reasons.push("missing_score_change_anchor_window");
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
  if (shotStart != null && sourceStart != null && shotStart - sourceStart < MIN_PRE_SHOT_CONTEXT_SECONDS) {
    reasons.push("insufficient_pre_shot_context");
  }
  return {
    matches: reasons.length === 0,
    reasons: safeCodes(reasons, 8),
  };
}

function matchExpectedGoals(expectedGoals = [], segments = []) {
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
        score: [
          numberOrNull(segment.goalNumber) === expected.goalNumber ? 4 : 0,
          segmentContainsTime(segment, expected.anchorTime) ? 3 : 0,
          segmentContainsTime(segment, expected.confirmationTime) ? 3 : 0,
          overlapSeconds(segment, expected) > 0.5 ? 2 : 0,
        ].reduce((sum, value) => sum + value, 0),
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
      ...segmentFailureReasons(selected.segment, "valid_goals_only"),
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

function assertVideoOutputCoverage({
  editPlan,
  matchEventTruth,
  goalSelectionMode = "balanced",
} = {}) {
  if (!editPlan || typeof editPlan !== "object" || hasUnsafeValue(editPlan)) {
    throw new AppError("VIDEO_OUTPUT_QA_FAILED", SAFE_MESSAGES.VIDEO_OUTPUT_QA_FAILED, 422);
  }
  const mode = sanitizeText(goalSelectionMode || "balanced", 40);
  const segments = segmentList(editPlan);
  const expectedGoals = expectedGoalsFromTruth(matchEventTruth);
  const publicSegments = segments.map(publicSegment);
  const invalidSegments = segments
    .map((segment, index) => ({
      index: index + 1,
      id: sanitizeText(segment.id || `segment_${index + 1}`, 80),
      reasons: segmentFailureReasons(segment, mode),
    }))
    .filter((item) => item.reasons.length)
    .slice(0, MAX_PUBLIC_ITEMS);
  const confirmedGoalSegments = segments.filter(isConfirmedGoalSegment);
  const matches = matchExpectedGoals(expectedGoals, segments);
  const coveredGoalCount = matches.filter((match) => match.covered).length;
  const hook = hookSummary(editPlan);
  const captions = captionStyleSummary(editPlan);
  const animations = animationSummary(editPlan);
  const audioPolicy = audioPolicySummary(editPlan);
  const creativeStyle = creativeStyleSummary(editPlan);
  const creativeContractPassed = hook.passed &&
    captions.passed &&
    animations.passed &&
    audioPolicy.passed &&
    creativeStyle.passed;
  const extraGoalSegmentCount = expectedGoals.length > 0
    ? Math.max(0, confirmedGoalSegments.length - expectedGoals.length)
    : confirmedGoalSegments.length;
  const failedReasons = safeCodes([
    ...(mode === "valid_goals_only" && expectedGoals.length === 0 ? ["no_counted_goal_truth"] : []),
    ...(mode === "valid_goals_only" && segments.some((segment) => !isConfirmedGoalSegment(segment)) ? ["non_goal_segments_present"] : []),
    ...(matches.some((match) => !match.covered) ? ["missing_or_invalid_counted_goal_segment"] : []),
    ...(extraGoalSegmentCount > 0 ? ["unexpected_extra_goal_segment"] : []),
    ...(invalidSegments.length ? ["invalid_segment_coverage"] : []),
    ...hook.reasons,
    ...captions.reasons,
    ...animations.reasons,
    ...audioPolicy.reasons,
    ...creativeStyle.reasons,
  ], 10);
  const passed = mode !== "valid_goals_only"
    ? invalidSegments.length === 0 && creativeContractPassed
    : expectedGoals.length > 0 &&
      coveredGoalCount === expectedGoals.length &&
      confirmedGoalSegments.length === expectedGoals.length &&
      invalidSegments.length === 0 &&
      segments.every(isConfirmedGoalSegment) &&
      creativeContractPassed;

  const report = {
    schemaVersion: OUTPUT_GATE_SCHEMA_VERSION,
    status: passed ? "passed" : "failed",
    passed,
    goalSelectionMode: mode,
    expectedGoalCount: expectedGoals.length,
    actualSegmentCount: segments.length,
    actualConfirmedGoalSegmentCount: confirmedGoalSegments.length,
    coveredGoalCount,
    missingGoalNumbers: matches
      .filter((match) => !match.covered)
      .map((match) => match.expected.goalNumber)
      .slice(0, MAX_PUBLIC_ITEMS),
    extraGoalSegmentCount,
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
};
