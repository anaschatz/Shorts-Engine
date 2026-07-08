const { randomUUID } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const { sanitizeText } = require("./media.cjs");
const { extractSampledFrames, publicFrameSummary } = require("./frame-extraction.cjs");
const { analyzeSemanticGoalFrames } = require("./semantic-goal-visibility.cjs");
const { safeResolve, storagePath, writeJsonAtomic } = require("./storage.cjs");

const MAX_GOALS = 8;
const MAX_BATCH_WINDOWS_PER_EXTRACTION = 24;
const FRAME_ROLES = Object.freeze(["pre_shot", "finish", "payoff", "confirmation"]);
const ROLE_HINT_PREFIX = "goal_role:";
const FINISH_FRAME_CODES = Object.freeze(["rendered_finish_frame_visible", "finish_frame_visible", "ball_in_net_or_payoff_visible"]);
const MIN_RENDERED_FINISH_PRE_CONTEXT_SECONDS = 4;
const FINISH_FRAME_LACKS_PRE_CONTEXT_REASON = "finish_frame_lacks_pre_context";
const PAYOFF_SEARCH_STEP_SECONDS = 0.5;
const PAYOFF_SEARCH_BEFORE_FINISH_SECONDS = 0.9;
const PAYOFF_SEARCH_AFTER_CONFIRMATION_SECONDS = 2;

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function nowMs() {
  return Date.now();
}

function safeCodes(values = [], max = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean))]
    .slice(0, max);
}

function denseTimeRange(start, end, step = PAYOFF_SEARCH_STEP_SECONDS, maxCount = 18) {
  const parsedStart = Number(start);
  const parsedEnd = Number(end);
  const parsedStep = Number(step);
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || !Number.isFinite(parsedStep) || parsedStep <= 0) {
    return [];
  }
  const min = Math.min(parsedStart, parsedEnd);
  const max = Math.max(parsedStart, parsedEnd);
  const values = [];
  for (let value = min; value <= max + 0.001 && values.length < maxCount; value += parsedStep) {
    values.push(round(value, 2));
  }
  if (values.length && Math.abs(values[values.length - 1] - max) > 0.2 && values.length < maxCount) {
    values.push(round(max, 2));
  }
  return values;
}

function isConfirmedGoalSegment(segment = {}) {
  return segment.highlightType === "goal" &&
    segment.goalOutcome &&
    segment.goalOutcome.eventType === "ball_in_net" &&
    segment.goalOutcome.outcome === "confirmed_goal";
}

function segmentTimeline(segment = {}, fallbackStart = 0) {
  const sourceStart = numberOrNull(segment.sourceStart) ?? 0;
  const sourceEnd = numberOrNull(segment.sourceEnd) ?? sourceStart;
  const duration = Math.max(0.1, numberOrNull(segment.duration) ?? sourceEnd - sourceStart);
  const timelineStart = numberOrNull(segment.timelineStart) ?? fallbackStart;
  const timelineEnd = numberOrNull(segment.timelineEnd) ?? timelineStart + duration;
  const localTime = (sourceTime, fallbackOffset = 0) => {
    const parsed = numberOrNull(sourceTime);
    if (parsed == null) return round(timelineStart + fallbackOffset);
    return round(Math.min(timelineEnd, Math.max(timelineStart, timelineStart + parsed - sourceStart)));
  };
  const shot = localTime(segment.shotStart, Math.min(4, duration * 0.35));
  const finish = localTime(segment.finishTime, Math.min(duration - 0.8, Math.max(shot + 1, duration * 0.65)));
  const confirmation = localTime(segment.confirmationTime, Math.min(duration - 0.2, Math.max(finish + 0.4, duration * 0.82)));
  return {
    sourceStart: round(sourceStart),
    sourceEnd: round(sourceEnd),
    duration: round(duration),
    timelineStart: round(timelineStart),
    timelineEnd: round(timelineEnd),
    preShot: round(Math.max(timelineStart + 0.15, Math.min(shot - 0.75, finish - 2))),
    shot,
    finish,
    payoff: round(Math.min(timelineEnd - 0.15, Math.max(finish + 0.55, finish))),
    confirmation,
  };
}

function hasStrongSourceGoalEvidence(segment = {}) {
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const payoff = phase.visualGoalPayoff && typeof phase.visualGoalPayoff === "object" && !Array.isArray(phase.visualGoalPayoff)
    ? phase.visualGoalPayoff
    : {};
  const codes = new Set(safeCodes([
    ...(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []),
    ...(Array.isArray(payoff.evidenceCodes) ? payoff.evidenceCodes : []),
  ], 24));
  const hasShot = phase.hasShot === true &&
    (codes.has("visual_shot_contact") || codes.has("visual_ball_toward_goal") || codes.has("shot_sequence_support"));
  const hasFinish = phase.hasFinish === true &&
    (
      codes.has("visual_ball_in_net") ||
      codes.has("ball_in_net") ||
      codes.has("live_shot_finish_sequence") ||
      payoff.hasLiveFinishSequence === true
    );
  const hasConfirmation = phase.hasConfirmation === true &&
    (codes.has("scoreboard_ocr_score_change") || codes.has("scoreboard_temporal_consistency") || codes.has("visual_scoreboard_goal_confirmed"));
  const disallowedShape = segment.replayOnly === true ||
    phase.replayOnly === true ||
    segment.celebrationOnly === true ||
    phase.celebrationOnly === true;
  return isConfirmedGoalSegment(segment) && !disallowedShape && phase.hasBuildup === true && hasShot && hasFinish && hasConfirmation;
}

function frameWindowsForGoal(segment = {}, timeline = {}) {
  const goalNumber = numberOrNull(segment.goalNumber);
  const duration = Math.max(0.1, Number(timeline.timelineEnd) - Number(timeline.timelineStart));
  const shotTime = numberOrNull(timeline.shot);
  const finishTime = numberOrNull(timeline.finish);
  const confirmationTime = numberOrNull(timeline.confirmation);
  const scoreChangeLeadTimes = confirmationTime == null
    ? []
    : [28, 25, 22, 19, 16, 13, 10, 7, 4]
        .map((lead) => Number(confirmationTime) - lead);
  const scoreChangePayoffTimes = confirmationTime == null
    ? []
    : [25, 22, 19, 16, 13, 10, 7, 4]
        .map((lead) => Number(confirmationTime) - lead);
  const finishProbeTimes = confirmationTime == null
    ? [
        Number(timeline.finish) - 6,
        Number(timeline.finish) - 4.5,
        Number(timeline.finish) - 3,
        Number(timeline.finish) - 2,
        Number(timeline.finish) - 1.35,
        Number(timeline.finish) - 0.65,
        Number(timeline.finish),
        Number(timeline.finish) + 0.55,
      ]
    : [
        Number(timeline.finish) - 2.5,
        Number(timeline.finish) - 1.2,
        Number(timeline.finish) - 0.35,
        Number(timeline.finish),
        Number(timeline.finish) + 0.55,
        ...scoreChangeLeadTimes.slice(0, 5),
      ];
  const finishAdjacentPayoffTimes = finishProbeTimes
    .flatMap((time) => [Number(time) - 0.55, Number(time) + 0.55, Number(time) + 1.05])
    .filter((time) => Number.isFinite(time));
  const densePayoffProbeTimes = finishTime == null
    ? []
    : denseTimeRange(
        Math.max(Number(timeline.timelineStart) + 0.08, Number(finishTime) - PAYOFF_SEARCH_BEFORE_FINISH_SECONDS),
        confirmationTime == null
          ? Number(finishTime) + 4.75
          : Math.min(Number(timeline.timelineEnd) - 0.15, Number(confirmationTime) + PAYOFF_SEARCH_AFTER_CONFIRMATION_SECONDS),
        PAYOFF_SEARCH_STEP_SECONDS,
        16,
      );
  const payoffProbeTimes = confirmationTime == null
    ? [
        Number(timeline.payoff),
        Number(timeline.finish) + 1.15,
        Number(timeline.finish) + 2.25,
        Number(timeline.finish) + 3.5,
        Number(timeline.finish) + 4.7,
        Number(timeline.confirmation) - 0.45,
        ...finishAdjacentPayoffTimes,
        ...densePayoffProbeTimes,
      ]
    : [
        Number(timeline.finish) + 0.55,
        Number(timeline.finish) + 1.15,
        Number(timeline.finish) + 2.25,
        ...finishAdjacentPayoffTimes,
        ...densePayoffProbeTimes,
        ...scoreChangePayoffTimes.slice(0, 4),
      ];
  const candidateGroups = [
    ["pre_shot", [
      Number(timeline.timelineStart) + 0.4,
      Number(timeline.preShot) - 0.9,
      Number(timeline.shot) - 0.35,
    ]],
    ["finish", finishProbeTimes],
    ["payoff", payoffProbeTimes],
    ["confirmation", [
      Number(timeline.confirmation),
      Number(timeline.confirmation) + 0.65,
      Number(timeline.confirmation) + 1.3,
      Number(timeline.timelineEnd) - 0.25,
    ]],
  ];
  const minTime = Math.max(0, Number(timeline.timelineStart) + 0.08);
  const maxTime = Math.max(minTime + 0.1, Number(timeline.timelineEnd) - 0.08);
  const delayedScoreChangePayoffStart = confirmationTime != null &&
    Number(timeline.timelineStart) != null &&
    confirmationTime - Number(timeline.timelineStart) > 22.65
    ? confirmationTime - 22.65
    : Number.POSITIVE_INFINITY;
  const actionPayoffStart = shotTime == null
    ? Number.POSITIVE_INFINITY
    : shotTime - 1.1;
  const earliestPayoffTime = Math.max(
    minTime,
    Math.min(
      finishTime == null ? Number.POSITIVE_INFINITY : finishTime - PAYOFF_SEARCH_BEFORE_FINISH_SECONDS - 0.05,
      delayedScoreChangePayoffStart,
      actionPayoffStart,
    ),
  );
  const roleTimeAllowed = (role, time) => {
    const parsed = Number(time);
    if (!Number.isFinite(parsed)) return false;
    if (role === "finish") {
      if (confirmationTime == null && shotTime != null && parsed < shotTime - 8) return false;
      if (finishTime != null && confirmationTime == null && parsed < finishTime - 2.5) return false;
      if (confirmationTime != null && parsed < confirmationTime - 30.25) return false;
      if (confirmationTime != null && parsed > confirmationTime + 0.25) return false;
    }
    if (role === "payoff") {
      if (parsed < earliestPayoffTime) return false;
      if (confirmationTime != null && parsed < confirmationTime - 28.25) return false;
      if (confirmationTime != null && parsed > confirmationTime + PAYOFF_SEARCH_AFTER_CONFIRMATION_SECONDS + 0.25) return false;
    }
    if (role === "confirmation" && finishTime != null && parsed < finishTime - 0.25) return false;
    return true;
  };
  const seen = new Set();
  return candidateGroups
    .flatMap(([role, times]) => times
      .filter((time) => Number.isFinite(Number(time)))
      .map((time) => Math.min(maxTime, Math.max(minTime, Number(time))))
      .filter((time) => roleTimeAllowed(role, time))
      .map((time) => {
        const rounded = round(time);
        const key = `${role}:${rounded}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const roleBoost = role === "finish" ? 0.06 : role === "payoff" ? 0.03 : 0;
        return {
          time: rounded,
          start: round(Math.max(0, Number(rounded) - 0.08)),
          end: round(Number(rounded) + 0.08),
          confidence: round(Math.min(0.95, 0.84 + roleBoost + Math.min(0.05, duration / 500))),
          source: "rendered_goal_visibility_rebind",
          visualHints: [role, `${ROLE_HINT_PREFIX}${role}`, "rendered_goal_proof"],
          role,
          goalNumber,
        };
      })
      .filter(Boolean))
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function publicFrameRef(frame = {}, role = "", time = null) {
  const semantic = semanticFrameVisibility(frame, role);
  return {
    role: sanitizeText(role, 40),
    time: round(time ?? frame.timestamp),
    status: frame && frame.localPath ? semantic.status : "missing",
    clear: Boolean(frame && frame.localPath && semantic.clear),
    frameId: sanitizeText(frame && frame.id || "", 64) || null,
    width: numberOrNull(frame && frame.width),
    height: numberOrNull(frame && frame.height),
    confidence: semantic.confidence,
    reason: semantic.reason,
  };
}

function evidenceObject(frame = {}) {
  const candidates = [
    frame.semanticGoalEvidence,
    frame.goalVisibility,
    frame.goalEvidence,
    frame.renderedGoalEvidence,
    frame.visibilityEvidence,
  ];
  return candidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function semanticFrameVisibility(frame = {}, role = "") {
  const evidence = evidenceObject(frame);
  const verdict = sanitizeText(
    evidence.visibilityVerdict || evidence.verdict || frame.visibilityVerdict || "",
    32,
  ).toLowerCase();
  const roles = Array.isArray(evidence.roles)
    ? evidence.roles.map((value) => sanitizeText(value, 40)).filter(Boolean)
    : [];
  const roleCovered = roles.length === 0 || roles.includes(role);
  const hasExplicitGoalEvidence = evidence.visibleGoal === true ||
    evidence.goalVisible === true ||
    evidence.hasVisibleFinish === true ||
    evidence.hasBallInNetOrPayoff === true ||
    evidence.ballInNetOrPayoffVisible === true ||
    evidence.hasClearPayoff === true;
  const forbidden = evidence.replayOnly === true ||
    evidence.celebrationOnly === true ||
    evidence.scoreboardOnly === true ||
    evidence.playerCloseupOnly === true ||
    evidence.labelOnly === true ||
    evidence.blurred === true ||
    evidence.overZoomed === true;
  const semanticClear = verdict === "clear" && roleCovered && hasExplicitGoalEvidence && !forbidden;
  const confidence = numberOrNull(evidence.confidence);
  if (semanticClear) return { clear: true, status: "clear", reason: null, confidence };
  if (!Object.keys(evidence).length) {
    return { clear: false, status: "unverified", reason: "semantic_frame_validation_missing", confidence };
  }
  if (!roleCovered) return { clear: false, status: "failed", reason: "semantic_frame_role_mismatch", confidence };
  if (forbidden) return { clear: false, status: "failed", reason: "semantic_frame_forbidden_content", confidence };
  if (verdict !== "clear") return { clear: false, status: "failed", reason: "semantic_frame_not_clear", confidence };
  return { clear: false, status: "failed", reason: "semantic_goal_evidence_missing", confidence };
}

function roleFromFrameHints(frame = {}, fallbackRole = "") {
  const hints = Array.isArray(frame.visualHints) ? frame.visualHints : [];
  const roleHint = hints.find((hint) => sanitizeText(hint, 64).startsWith(ROLE_HINT_PREFIX));
  if (!roleHint) return sanitizeText(fallbackRole, 40);
  return sanitizeText(roleHint.slice(ROLE_HINT_PREFIX.length), 40) || sanitizeText(fallbackRole, 40);
}

function frameWindowKey(window = {}) {
  const time = numberOrNull(window.time ?? window.timestamp);
  if (time == null) return null;
  const role = sanitizeText(window.role || roleFromFrameHints(window, ""), 40) || "any";
  return `t:${round(time, 2)}:r:${role}`;
}

function candidateFrameRefs({ frames = [], windows = [] } = {}) {
  return (Array.isArray(frames) ? frames : []).map((frame, index) => {
    const window = Array.isArray(windows) ? windows[index] : null;
    const role = roleFromFrameHints(frame, window && window.role);
    return publicFrameRef(frame, role, window && window.time);
  });
}

function missingFrameRef(role) {
  return {
    role: sanitizeText(role, 40),
    time: null,
    status: "missing",
    clear: false,
    frameId: null,
    width: null,
    height: null,
    confidence: null,
    reason: "role_frame_missing",
  };
}

function timelineTimeOrNull(timeline = {}, key = "") {
  return numberOrNull(timeline && timeline[key]);
}

function targetTimeForRole(role = "", timeline = {}) {
  if (role === "finish") return timelineTimeOrNull(timeline, "finish");
  if (role === "payoff") {
    return timelineTimeOrNull(timeline, "payoff") ?? timelineTimeOrNull(timeline, "finish");
  }
  if (role === "confirmation") return timelineTimeOrNull(timeline, "confirmation");
  if (role === "pre_shot") return timelineTimeOrNull(timeline, "shot") ?? timelineTimeOrNull(timeline, "preShot");
  return null;
}

function distanceFromRoleTarget(frame = {}, role = "", timeline = {}) {
  const time = numberOrNull(frame.time);
  const target = targetTimeForRole(role, timeline);
  if (time == null || target == null) return null;
  return Math.abs(time - target);
}

function selectBestFrameRefs(candidates = [], timeline = {}) {
  const selected = [];
  for (const role of FRAME_ROLES) {
    const roleCandidates = (Array.isArray(candidates) ? candidates : [])
      .filter((frame) => frame.role === role);
    if (!roleCandidates.length) {
      selected.push(missingFrameRef(role));
      continue;
    }
    const finishFrame = selected.find((frame) => frame.role === "finish" && frame.clear === true);
    const finishTime = numberOrNull(finishFrame && finishFrame.time);
    const best = roleCandidates
      .sort((a, b) => {
        if (Boolean(a.clear) !== Boolean(b.clear)) return a.clear ? -1 : 1;
        if (role === "payoff" && finishTime != null) {
          const aTime = numberOrNull(a.time);
          const bTime = numberOrNull(b.time);
          const aAfterDistinct = aTime != null && aTime >= finishTime + 0.3;
          const bAfterDistinct = bTime != null && bTime >= finishTime + 0.3;
          if (aAfterDistinct !== bAfterDistinct) return aAfterDistinct ? -1 : 1;
          const aDistinct = aTime != null && Math.abs(aTime - finishTime) >= 0.3;
          const bDistinct = bTime != null && Math.abs(bTime - finishTime) >= 0.3;
          if (aDistinct !== bDistinct) return aDistinct ? -1 : 1;
        }
        const targetDelta = (distanceFromRoleTarget(a, role, timeline) ?? Number.POSITIVE_INFINITY) -
          (distanceFromRoleTarget(b, role, timeline) ?? Number.POSITIVE_INFINITY);
        if (Math.abs(targetDelta) > 0.05) return targetDelta;
        const confidenceDelta = (numberOrNull(b.confidence) ?? 0) - (numberOrNull(a.confidence) ?? 0);
        if (Math.abs(confidenceDelta) > 0.0001) return confidenceDelta;
        if (a.status !== b.status) return a.status === "failed" ? 1 : -1;
        return (numberOrNull(a.time) ?? 0) - (numberOrNull(b.time) ?? 0);
      })[0];
    selected.push(best);
  }
  return selected;
}

function roleSearchDiagnostics({ role = "", candidates = [], selected = null, timeline = {} } = {}) {
  const roleCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((frame) => frame.role === role);
  const clearCandidates = roleCandidates.filter((frame) => frame.clear === true);
  const selectedTime = numberOrNull(selected && selected.time);
  const candidateTimes = roleCandidates.map((frame) => numberOrNull(frame.time)).filter((time) => time != null);
  const finishTime = numberOrNull(timeline && timeline.finish);
  const confirmationTime = numberOrNull(timeline && timeline.confirmation);
  return {
    role: sanitizeText(role, 40),
    required: true,
    searchStart: role === "payoff" && finishTime != null
      ? round(candidateTimes.length ? Math.min(...candidateTimes) : Math.max(Number(timeline.timelineStart || 0), finishTime - PAYOFF_SEARCH_BEFORE_FINISH_SECONDS))
      : null,
    searchEnd: role === "payoff" && confirmationTime != null
      ? round(candidateTimes.length ? Math.max(...candidateTimes) : Math.min(Number(timeline.timelineEnd) - 0.08, confirmationTime + PAYOFF_SEARCH_AFTER_CONFIRMATION_SECONDS))
      : null,
    candidateCount: roleCandidates.length,
    clearCandidateCount: clearCandidates.length,
    selectedTime: selectedTime == null ? null : round(selectedTime),
    selectedClear: Boolean(selected && selected.clear),
    selectedReason: selected && selected.reason ? sanitizeText(selected.reason, 80) : null,
    sampledCandidates: roleCandidates
      .slice(0, 24)
      .map((frame) => ({
        time: round(frame.time),
        clear: Boolean(frame.clear),
        status: sanitizeText(frame.status || "", 32) || null,
        reason: frame.reason ? sanitizeText(frame.reason, 80) : null,
        confidence: numberOrNull(frame.confidence),
      })),
    rejectedReasons: safeCodes(roleCandidates
      .filter((frame) => frame.clear !== true)
      .map((frame) => frame.reason || `${role}_not_clear`), 10),
  };
}

function contactSheetRef(contactSheetPath = null) {
  if (!contactSheetPath) return null;
  const ref = relative(process.cwd(), contactSheetPath).replace(/\\/g, "/");
  if (!ref || ref.startsWith("..") || ref.startsWith("/") || ref.includes("\0")) return null;
  return ref;
}

function renderedOutputDimensions(editPlan = {}) {
  const exportWidth = numberOrNull(editPlan && editPlan.export && editPlan.export.width);
  const exportHeight = numberOrNull(editPlan && editPlan.export && editPlan.export.height);
  if (exportWidth && exportHeight) {
    return { width: exportWidth, height: exportHeight };
  }
  const aspect = sanitizeText(editPlan && (editPlan.aspectRatio || editPlan.targetAspectRatio) || "", 16);
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

function cleanActionLayoutContract(editPlan = {}) {
  const qa = editPlan.renderPolishQA && typeof editPlan.renderPolishQA === "object" && !Array.isArray(editPlan.renderPolishQA)
    ? editPlan.renderPolishQA
    : null;
  const required = editPlan.mode === "valid_goals_only" ||
    editPlan.goalSelectionMode === "valid_goals_only" ||
    editPlan.validGoalsOnly === true;
  const actionLayoutMode = qa ? sanitizeText(qa.actionLayoutMode || "unknown", 60) : null;
  const splitLayoutCaptionCount = qa ? numberOrNull(qa.splitLayoutCaptionCount) : null;
  const allowedCleanModes = ["clean_action_letterbox", "clean_action_crop", "clean_action_full_frame"];
  const passed = !required || Boolean(
    qa &&
    qa.cleanActionLayoutRequired === true &&
    qa.cleanActionLayoutPassed === true &&
    allowedCleanModes.includes(actionLayoutMode) &&
    qa.blurredBackgroundUsed !== true &&
    qa.duplicateBackgroundUsed !== true &&
    (splitLayoutCaptionCount == null || splitLayoutCaptionCount === 0)
  );
  const reasons = safeCodes([
    ...(required && !qa ? ["render_layout_summary_missing"] : []),
    ...(required && qa && qa.cleanActionLayoutRequired !== true ? ["clean_action_layout_not_required_by_renderer"] : []),
    ...(required && qa && qa.cleanActionLayoutPassed !== true ? ["clean_action_layout_failed"] : []),
    ...(required && qa && !allowedCleanModes.includes(actionLayoutMode) ? ["non_clean_action_layout"] : []),
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

async function extractRenderedGoalFrames({
  outputPath,
  metadata,
  windows,
  extractFrames,
  signal,
  outputDir,
} = {}) {
  if (!windows.length) {
    return { providerMode: "rendered-goal-proof-empty", fallbackUsed: true, frames: [], summary: { frameCount: 0 } };
  }
  return extractFrames({
    inputPath: outputPath,
    metadata,
    candidateWindows: windows,
    outputDir,
    maxFrames: Math.min(24, Math.max(1, windows.length)),
    maxDimension: 480,
    signal,
  });
}

async function extractRenderedGoalFrameBatch({
  outputPath,
  metadata,
  goalItems = [],
  extractFrames,
  signal,
  outputDir,
} = {}) {
  const startedAt = nowMs();
  const records = [];
  const uniqueByKey = new Map();
  const frameByKey = new Map();
  const extractionSummaries = [];
  for (const [goalListIndex, item] of goalItems.entries()) {
    const windows = Array.isArray(item && item.windows) ? item.windows : [];
    for (const [windowIndex, window] of windows.entries()) {
      const key = frameWindowKey(window);
      if (!key) continue;
      const record = { goalListIndex, windowIndex, window, key };
      records.push(record);
      if (!uniqueByKey.has(key)) {
        uniqueByKey.set(key, { key, window, records: [] });
      }
      uniqueByKey.get(key).records.push(record);
    }
  }
  const uniqueWindows = [...uniqueByKey.values()];
  let extractionElapsedMs = 0;
  for (let start = 0; start < uniqueWindows.length; start += MAX_BATCH_WINDOWS_PER_EXTRACTION) {
    const chunk = uniqueWindows.slice(start, start + MAX_BATCH_WINDOWS_PER_EXTRACTION);
    const chunkOutputDir = safeResolve(outputDir, `batch_${String(Math.floor(start / MAX_BATCH_WINDOWS_PER_EXTRACTION) + 1).padStart(2, "0")}`);
    const chunkStartedAt = nowMs();
    // eslint-disable-next-line no-await-in-loop
    const extracted = await extractRenderedGoalFrames({
      outputPath,
      metadata,
      windows: chunk.map((item) => item.window),
      extractFrames,
      signal,
      outputDir: chunkOutputDir,
    });
    extractionElapsedMs += Math.max(0, nowMs() - chunkStartedAt);
    extractionSummaries.push(publicFrameSummary(extracted));
    const frames = Array.isArray(extracted && extracted.frames) ? extracted.frames : [];
    for (const [frameIndex, frame] of frames.entries()) {
      const timestampKey = frameWindowKey(frame);
      const fallbackKey = chunk[frameIndex] && chunk[frameIndex].key;
      const key = timestampKey && uniqueByKey.has(timestampKey) ? timestampKey : fallbackKey;
      if (key && !frameByKey.has(key)) frameByKey.set(key, frame);
    }
  }
  const framesByGoal = goalItems.map(() => []);
  let recordFrameCount = 0;
  for (const record of records) {
    const frame = frameByKey.get(record.key);
    if (!frame) continue;
    recordFrameCount += 1;
    framesByGoal[record.goalListIndex][record.windowIndex] = {
      ...frame,
      visualHints: Array.isArray(record.window.visualHints) ? record.window.visualHints : frame.visualHints,
      timestamp: numberOrNull(frame.timestamp) ?? numberOrNull(record.window.time),
    };
  }
  const uniqueExtractedFrameCount = frameByKey.size;
  return {
    framesByGoal,
    extractionSummaries,
    metrics: {
      candidateFrameWindowCount: records.length,
      uniqueFrameWindowCount: uniqueWindows.length,
      newlyExtractedFrameCount: uniqueExtractedFrameCount,
      reusedFrameCount: Math.max(0, recordFrameCount - uniqueExtractedFrameCount),
      skippedDuplicateFrameCount: Math.max(0, records.length - uniqueWindows.length),
      frameExtractionMs: extractionElapsedMs || Math.max(0, nowMs() - startedAt),
      batchExtractionCallCount: extractionSummaries.length,
    },
  };
}

function attachEvidenceToSegment(segment = {}, evidence = {}) {
  const frameTime = numberOrNull(evidence && evidence.frameTime);
  const sourceStart = numberOrNull(segment.sourceStart) ?? 0;
  const sourceEnd = numberOrNull(segment.sourceEnd) ?? sourceStart;
  const existingShotStart = numberOrNull(segment.shotStart);
  const finishFramePreContextSeconds = frameTime == null ? null : round(frameTime - sourceStart);
  const finishFrameHasPreContext = finishFramePreContextSeconds == null ||
    finishFramePreContextSeconds >= MIN_RENDERED_FINISH_PRE_CONTEXT_SECONDS;
  const finishFrameTimingReasons = finishFrameHasPreContext ? [] : [FINISH_FRAME_LACKS_PRE_CONTEXT_REASON];
  const segmentEvidence = finishFrameHasPreContext
    ? evidence
    : {
        ...evidence,
        visibilityVerdict: "failed",
        timingRejectReason: FINISH_FRAME_LACKS_PRE_CONTEXT_REASON,
        finishFramePreContextSeconds,
        minFinishFramePreContextSeconds: MIN_RENDERED_FINISH_PRE_CONTEXT_SECONDS,
        reasons: safeCodes([...(Array.isArray(evidence.reasons) ? evidence.reasons : []), ...finishFrameTimingReasons], 12),
      };
  const canBindFinishFrame = frameTime != null &&
    finishFrameHasPreContext &&
    evidence.visibilityVerdict === "clear" &&
    evidence.hasVisibleFinish === true &&
    evidence.hasBallInNetOrPayoff === true;
  const reboundFinishTime = canBindFinishFrame
    ? round(Math.min(Math.max(frameTime, sourceStart + 0.35), Math.max(sourceStart + 0.4, sourceEnd - 0.35)))
    : null;
  const reboundShotStart = reboundFinishTime == null
    ? null
    : round(Math.max(
        sourceStart + 0.25,
        Math.min(
          existingShotStart == null ? reboundFinishTime - 2.1 : existingShotStart,
          reboundFinishTime - 0.35,
        ),
      ));
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const visualGoalPayoff = phase.visualGoalPayoff && typeof phase.visualGoalPayoff === "object" && !Array.isArray(phase.visualGoalPayoff)
    ? phase.visualGoalPayoff
    : {};
  const mergedPayoff = { ...visualGoalPayoff, finishFrameEvidence: segmentEvidence };
  const mergedPhase = {
    ...phase,
    ...(reboundShotStart != null ? { shotStart: reboundShotStart } : {}),
    ...(reboundFinishTime != null ? { finishTime: reboundFinishTime } : {}),
    visualGoalPayoff: mergedPayoff,
    finishFrameEvidence: segmentEvidence,
  };
  return {
    ...segment,
    ...(reboundShotStart != null ? { shotStart: reboundShotStart } : {}),
    ...(reboundFinishTime != null ? { finishTime: reboundFinishTime } : {}),
    phaseCoverage: mergedPhase,
    finishFrameEvidence: segmentEvidence,
  };
}

async function analyzeRenderedGoalProof({
  outputPath,
  editPlan,
  signal = null,
  extractFrames = extractSampledFrames,
  semanticAnalyzer = analyzeSemanticGoalFrames,
  writeJson = writeJsonAtomic,
} = {}) {
  const proofStartedAt = nowMs();
  const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
  let cursor = 0;
  const runId = `rendered-goal-proof-${randomUUID()}`;
  const proofDir = storagePath("staging", join("rendered-goal-proof", runId));
  mkdirSync(proofDir, { recursive: true });
  const layoutContract = cleanActionLayoutContract(editPlan || {});
  const proofGoals = [];
  const updatedSegments = [...segments];
  const goalItems = [];
  for (const [index, segment] of segments.entries()) {
    const duration = Math.max(0, Number(segment.duration || Number(segment.sourceEnd) - Number(segment.sourceStart)) || 0);
    if (isConfirmedGoalSegment(segment)) {
      const timeline = segmentTimeline(segment, cursor);
      goalItems.push({
        segment,
        segmentIndex: index,
        timeline,
        windows: frameWindowsForGoal(segment, timeline),
      });
    }
    cursor += duration;
  }

  const renderedDimensions = renderedOutputDimensions(editPlan);
  const renderedMetadata = {
    durationSeconds: Number(editPlan && editPlan.totalDuration || 0),
    width: renderedDimensions.width,
    height: renderedDimensions.height,
  };
  const batch = await extractRenderedGoalFrameBatch({
    outputPath,
    metadata: renderedMetadata,
    goalItems,
    extractFrames,
    signal,
    outputDir: proofDir,
  });
  const semanticRecords = [];
  for (const [goalListIndex, item] of goalItems.entries()) {
    const framesByWindow = batch.framesByGoal[goalListIndex] || [];
    for (const [windowIndex, frame] of framesByWindow.entries()) {
      if (!frame) continue;
      const window = item.windows[windowIndex];
      if (!window) continue;
      semanticRecords.push({
        goalListIndex,
        windowIndex,
        frame,
        window,
        roleWindow: {
          ...window,
          role: roleFromFrameHints(frame, window.role),
        },
      });
    }
  }
  const semanticStartedAt = nowMs();
  const semantic = await semanticAnalyzer({
    frames: semanticRecords.map((record) => record.frame),
    roleWindows: semanticRecords.map((record) => record.roleWindow),
    signal,
    ignoreExistingEvidence: true,
  });
  const semanticAnalysisMs = Math.max(0, nowMs() - semanticStartedAt);
  const frameEvidence = Array.isArray(semantic && semantic.frameEvidence) ? semantic.frameEvidence : [];
  const semanticFramesByGoal = goalItems.map(() => []);
  semanticRecords.forEach((record, recordIndex) => {
    semanticFramesByGoal[record.goalListIndex][record.windowIndex] = {
      ...record.frame,
      semanticGoalEvidence: frameEvidence[recordIndex] || record.frame.semanticGoalEvidence || null,
    };
  });

  for (const [goalListIndex, item] of goalItems.entries()) {
    const goalStartedAt = nowMs();
    const { segment, segmentIndex: index, timeline, windows } = item;
    const pairedFrames = (semanticFramesByGoal[goalListIndex] || [])
      .map((frame, windowIndex) => (frame && windows[windowIndex] ? { frame, window: windows[windowIndex] } : null))
      .filter(Boolean);
    const semanticFrames = pairedFrames.map((item) => item.frame);
    const semanticWindows = pairedFrames.map((item) => item.window);
    const candidateRefs = candidateFrameRefs({ frames: semanticFrames, windows: semanticWindows });
    const frameRefs = selectBestFrameRefs(candidateRefs, timeline);
    const selectedFinishRef = frameRefs.find((frame) => frame.role === "finish" && frame.clear === true);
    const selectedFinishSourceTime = selectedFinishRef && numberOrNull(selectedFinishRef.time) != null
      ? round(Number(timeline.sourceStart) + Number(selectedFinishRef.time) - Number(timeline.timelineStart))
      : null;
    const selectedFinishPreContextSeconds = selectedFinishSourceTime == null
      ? null
      : round(Number(selectedFinishSourceTime) - Number(timeline.sourceStart));
    const selectedFinishHasPreContext = selectedFinishPreContextSeconds == null ||
      selectedFinishPreContextSeconds >= MIN_RENDERED_FINISH_PRE_CONTEXT_SECONDS;
    const frameCount = frameRefs.filter((frame) => frame.clear).length;
    const roleFrame = (role) => frameRefs.find((frame) => frame.role === role);
    const preShotFrame = roleFrame("pre_shot");
    const finishFrame = roleFrame("finish");
    const payoffFrame = roleFrame("payoff");
    const confirmationFrame = roleFrame("confirmation");
    const payoffSearch = roleSearchDiagnostics({
      role: "payoff",
      candidates: candidateRefs,
      selected: payoffFrame,
      timeline,
    });
    const allRoleFramesClear = [preShotFrame, finishFrame, payoffFrame, confirmationFrame]
      .every((frame) => frame && frame.clear === true);
    const finishTime = numberOrNull(finishFrame && finishFrame.time);
    const payoffTime = numberOrNull(payoffFrame && payoffFrame.time);
    const finishPayoffDistinct = finishTime != null && payoffTime != null && Math.abs(finishTime - payoffTime) >= 0.3;
    const unverifiedFrameCount = frameRefs.filter((frame) => frame.status === "unverified").length;
    const failedFrameReasons = safeCodes(frameRefs
      .filter((frame) => frame.clear !== true)
      .map((frame) => frame.reason || `${frame.role}_not_clear`)
      .concat(allRoleFramesClear ? [] : ["role_specific_goal_frame_missing"])
      .concat(finishPayoffDistinct ? [] : ["finish_payoff_frame_not_distinct"])
      .concat(selectedFinishHasPreContext ? [] : [FINISH_FRAME_LACKS_PRE_CONTEXT_REASON])
      .concat(layoutContract.passed ? [] : layoutContract.reasons), 12);
    const strongSourceEvidence = hasStrongSourceGoalEvidence(segment);
    const clear = layoutContract.passed && strongSourceEvidence && allRoleFramesClear && finishPayoffDistinct && selectedFinishHasPreContext;
    const borderline = !clear && layoutContract.passed && strongSourceEvidence && frameCount >= 2 && finishPayoffDistinct;
    const evidence = {
      frameTime: selectedFinishSourceTime ?? numberOrNull(segment.finishTime) ?? timeline.finish,
      confidence: clear ? 0.88 : borderline ? 0.62 : 0.2,
      visibilityVerdict: clear ? "clear" : borderline ? "borderline" : "failed",
      hasVisibleFinish: clear,
      hasBallInNetOrPayoff: clear,
      hasGoalMouth: clear || borderline,
      hasPreShotActionFrame: frameRefs.some((frame) => frame.role === "pre_shot" && frame.clear),
      hasFinishActionFrame: frameRefs.some((frame) => frame.role === "finish" && frame.clear),
      hasPayoffFrame: frameRefs.some((frame) => frame.role === "payoff" && frame.clear),
      hasConfirmationFrame: frameRefs.some((frame) => frame.role === "confirmation" && frame.clear),
      finishPayoffDistinct,
      continuousActionFrameCount: frameCount,
      supportFrames: frameRefs,
      isBlurred: false,
      isOverZoomed: false,
      isLabelOnly: false,
      isReplayOnly: segment.replayOnly === true || (segment.phaseCoverage && segment.phaseCoverage.replayOnly === true),
      isCelebrationOnly: segment.celebrationOnly === true || (segment.phaseCoverage && segment.phaseCoverage.celebrationOnly === true),
      isScoreboardOnly: false,
      isPlayerCloseupOnly: false,
      isFrameTooWideUnclear: false,
      evidenceCodes: clear ? FINISH_FRAME_CODES : ["rendered_frame_samples_semantically_unverified"],
      proofMethod: "rendered_timeline_frame_sampling",
      semanticFrameValidationRequired: true,
      semanticFrameValidationPassed: clear,
      cleanActionLayoutRequired: layoutContract.required,
      cleanActionLayoutPassed: layoutContract.passed,
      actionLayoutMode: layoutContract.actionLayoutMode,
      payoffSearch,
      finishFramePreContextSeconds: selectedFinishPreContextSeconds,
      minFinishFramePreContextSeconds: MIN_RENDERED_FINISH_PRE_CONTEXT_SECONDS,
      timingRejectReason: selectedFinishHasPreContext ? null : FINISH_FRAME_LACKS_PRE_CONTEXT_REASON,
      unverifiedFrameCount,
      reasons: failedFrameReasons,
      candidateFrameCount: candidateRefs.length,
    };
    updatedSegments[index] = attachEvidenceToSegment(segment, evidence);
    const goalProofMs = Math.max(0, nowMs() - goalStartedAt);
    const goalSemanticEvidence = semanticRecords
      .map((record, recordIndex) => ({ record, evidence: frameEvidence[recordIndex] }))
      .filter((entry) => entry.record.goalListIndex === goalListIndex)
      .map((entry) => entry.evidence)
      .filter(Boolean);
    proofGoals.push({
      goalNumber: numberOrNull(segment.goalNumber) || index + 1,
      segmentIndex: index + 1,
      segmentId: sanitizeText(segment.id || `segment_${index + 1}`, 80),
      verdict: evidence.visibilityVerdict,
      timeline,
      frameCount,
      frameRefs,
      candidateFrameCount: candidateRefs.length,
      sourceEvidenceStrong: strongSourceEvidence,
      unverifiedFrameCount,
      failedFrameReasons,
      payoffSearch,
      semanticSummary: {
        providerMode: sanitizeText(semantic && semantic.providerMode || "semantic-goal-visibility", 80),
        clearFrameCount: goalSemanticEvidence.filter((entry) => entry.visibilityVerdict === "clear").length,
        failedFrameCount: goalSemanticEvidence.filter((entry) => entry.visibilityVerdict !== "clear").length,
      },
      layoutContract,
      existingClearProofUsed: false,
      extraction: {
        providerMode: "rendered-goal-proof-batch",
        fallbackUsed: semanticFrames.length === 0,
        summary: {
          frameCount: semanticFrames.length,
          sampledWindows: semanticFrames.length,
          skippedWindows: Math.max(0, windows.length - semanticFrames.length),
          extractionMs: batch.metrics.frameExtractionMs,
        },
      },
      proofMs: goalProofMs,
    });
  }
  const renderedGoalProofMs = Math.max(0, nowMs() - proofStartedAt);
  const timing = {
    renderMs: null,
    renderedGoalProofMs,
    frameExtractionMs: batch.metrics.frameExtractionMs,
    semanticVisibilityMs: semanticAnalysisMs,
    rebindAttemptCount: numberOrNull(editPlan && editPlan.renderedGoalRebinding && editPlan.renderedGoalRebinding.attemptCount) || 0,
    framesExtracted: batch.metrics.newlyExtractedFrameCount,
    framesReused: batch.metrics.reusedFrameCount,
    skippedDuplicateFrameCount: batch.metrics.skippedDuplicateFrameCount,
    candidateFrameWindowCount: batch.metrics.candidateFrameWindowCount,
    uniqueFrameWindowCount: batch.metrics.uniqueFrameWindowCount,
    newlyExtractedFrameCount: batch.metrics.newlyExtractedFrameCount,
    batchExtractionCallCount: batch.metrics.batchExtractionCallCount,
    perGoalProofMs: proofGoals.map((goal) => ({
      goalNumber: goal.goalNumber,
      ms: goal.proofMs,
    })),
    bottleneckStep: semanticAnalysisMs >= batch.metrics.frameExtractionMs ? "semantic_visibility" : "frame_extraction",
  };
  const contactSheetPath = safeResolve(proofDir, "contact-sheet.json");
  const clearGoalCount = proofGoals.filter((goal) => goal.verdict === "clear").length;
  const borderlineGoalCount = proofGoals.filter((goal) => goal.verdict === "borderline").length;
  const failedGoalCount = proofGoals.filter((goal) => goal.verdict === "failed").length;
  const nonClearGoalCount = Math.max(0, proofGoals.length - clearGoalCount);
  const missingClearGoalNumbers = proofGoals
    .filter((goal) => goal.verdict !== "clear")
    .map((goal) => goal.goalNumber)
    .filter((goalNumber) => goalNumber != null);
  const summary = {
    schemaVersion: 1,
    providerMode: "rendered-goal-proof",
    outputRef: outputPath ? "rendered_output" : null,
    passed: proofGoals.length > 0 && nonClearGoalCount === 0,
    status: proofGoals.length > 0 && nonClearGoalCount === 0 ? "passed" : "failed",
    goalCount: proofGoals.length,
    clearGoalCount,
    borderlineGoalCount,
    failedGoalCount,
    nonClearGoalCount,
    missingClearGoalNumbers,
    contactSheetRef: contactSheetRef(contactSheetPath),
    layoutContract,
    timing,
    goals: proofGoals.map((goal) => ({
      goalNumber: goal.goalNumber,
      segmentIndex: goal.segmentIndex,
      verdict: goal.verdict,
      timeline: goal.timeline,
      frameCount: goal.frameCount,
      frameRefs: goal.frameRefs,
      candidateFrameCount: goal.candidateFrameCount,
      sourceEvidenceStrong: goal.sourceEvidenceStrong,
      unverifiedFrameCount: goal.unverifiedFrameCount,
      failedFrameReasons: goal.failedFrameReasons,
      payoffSearch: goal.payoffSearch,
      semanticSummary: goal.semanticSummary,
      existingClearProofUsed: goal.existingClearProofUsed,
      proofMs: goal.proofMs,
    })),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  writeJson(contactSheetPath, summary);
  return {
    editPlan: { ...editPlan, segments: updatedSegments, renderedGoalProof: summary },
    summary,
  };
}

module.exports = {
  analyzeRenderedGoalProof,
};
