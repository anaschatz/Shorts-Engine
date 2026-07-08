const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { CONFIG } = require("./config.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { assertStoragePath } = require("./storage.cjs");

const SAMPLE_WIDTH = 72;
const SAMPLE_HEIGHT = 128;
const MAX_REASON_CODES = 8;
const DEFAULT_MAX_PARALLEL_FRAME_ANALYSIS = 4;

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function safeReasons(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean))]
    .slice(0, MAX_REASON_CODES);
}

function existingEvidence(frame = {}) {
  const values = [
    frame.semanticGoalEvidence,
    frame.goalVisibility,
    frame.goalEvidence,
    frame.renderedGoalEvidence,
    frame.visibilityEvidence,
  ];
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function normalizeExistingEvidence(evidence = {}, role = "") {
  const verdict = sanitizeText(evidence.visibilityVerdict || evidence.verdict || "", 32).toLowerCase();
  const forbidden = evidence.replayOnly === true ||
    evidence.celebrationOnly === true ||
    evidence.scoreboardOnly === true ||
    evidence.playerCloseupOnly === true ||
    evidence.labelOnly === true ||
    evidence.blurred === true ||
    evidence.overZoomed === true ||
    evidence.tooZoomed === true;
  const visibleGoal = evidence.visibleGoal === true ||
    evidence.goalVisible === true ||
    evidence.hasVisibleFinish === true ||
    evidence.hasBallInNetOrPayoff === true ||
    evidence.ballInNetOrPayoffVisible === true ||
    evidence.hasClearPayoff === true;
  const clear = verdict === "clear" && visibleGoal && !forbidden;
  return {
    role,
    visibilityVerdict: clear ? "clear" : verdict === "borderline" ? "borderline" : "failed",
    visibleGoal: clear,
    hasVisibleFinish: evidence.hasVisibleFinish === true || (clear && role === "finish"),
    hasBallInNetOrPayoff: evidence.hasBallInNetOrPayoff === true || evidence.ballInNetOrPayoffVisible === true || (clear && ["finish", "payoff"].includes(role)),
    hasGoalMouth: evidence.hasGoalMouth === true || evidence.goalMouthVisible === true || clear,
    replayOnly: evidence.replayOnly === true,
    celebrationOnly: evidence.celebrationOnly === true,
    scoreboardOnly: evidence.scoreboardOnly === true,
    playerCloseupOnly: evidence.playerCloseupOnly === true,
    tooBlurred: evidence.blurred === true || evidence.tooBlurred === true,
    tooZoomed: evidence.overZoomed === true || evidence.tooZoomed === true,
    confidence: numberOrNull(evidence.confidence) ?? (clear ? 0.82 : 0.2),
    reasons: clear ? [] : safeReasons(evidence.reasons || ["semantic_existing_evidence_not_clear"]),
    roles: [role],
    providerMode: "semantic-existing-evidence",
  };
}

function failedEvidence(role, reason, confidence = 0.1) {
  return {
    role,
    visibilityVerdict: "failed",
    visibleGoal: false,
    hasVisibleFinish: false,
    hasBallInNetOrPayoff: false,
    hasGoalMouth: false,
    replayOnly: false,
    celebrationOnly: false,
    scoreboardOnly: false,
    playerCloseupOnly: false,
    tooBlurred: false,
    tooZoomed: false,
    confidence,
    reasons: safeReasons([reason]),
    roles: [role],
    providerMode: "semantic-goal-visibility",
  };
}

function runFfmpegRawFrame(framePath, runner = execFile, videoFilter = `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`) {
  return new Promise((resolve, reject) => {
    runner(CONFIG.ffmpegBin, [
      "-v",
      "error",
      "-i",
      framePath,
      "-frames:v",
      "1",
      "-vf",
      videoFilter,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ], {
      encoding: "buffer",
      timeout: Math.min(12000, CONFIG.analysisTimeoutMs || 12000),
      maxBuffer: SAMPLE_WIDTH * SAMPLE_HEIGHT * 3 + 4096,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""));
    });
  });
}

function analyzeRgbBuffer(buffer) {
  const expectedLength = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3;
  if (!Buffer.isBuffer(buffer) || buffer.length < expectedLength) {
    return null;
  }
  let green = 0;
  let white = 0;
  let dark = 0;
  let skin = 0;
  let saturated = 0;
  let blackBars = 0;
  const total = SAMPLE_WIDTH * SAMPLE_HEIGHT;
  for (let offset = 0; offset < expectedLength; offset += 3) {
    const r = buffer[offset];
    const g = buffer[offset + 1];
    const b = buffer[offset + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const blackBarPixel = r < 12 && g < 12 && b < 12;
    if (blackBarPixel) {
      blackBars += 1;
      continue;
    }
    if (g > 48 && g > r * 1.06 && g > b * 1.05) green += 1;
    if (r > 155 && g > 155 && b > 155 && max - min < 60) white += 1;
    if (r + g + b < 95) dark += 1;
    if (r > 95 && g > 50 && b > 30 && r > g * 1.05 && g > b * 1.02 && r - b > 30) skin += 1;
    if (max > 145 && max - min > 70) saturated += 1;
  }
  const activePixels = Math.max(0, total - blackBars);
  const contentTotal = activePixels > 0 ? activePixels : total;
  const ratio = (value) => round(value / contentTotal, 4);
  return {
    greenRatio: ratio(green),
    whiteRatio: ratio(white),
    darkRatio: ratio(dark),
    skinRatio: ratio(skin),
    saturatedColorRatio: ratio(saturated),
    blackBarRatio: round(blackBars / total, 4),
    activeContentRatio: round(activePixels / total, 4),
  };
}

function classifyFeatures(features = {}, role = "") {
  const green = numberOrNull(features.greenRatio) ?? 0;
  const white = numberOrNull(features.whiteRatio) ?? 0;
  const dark = numberOrNull(features.darkRatio) ?? 0;
  const skin = numberOrNull(features.skinRatio) ?? 0;
  const saturated = numberOrNull(features.saturatedColorRatio) ?? 0;
  const blackBars = numberOrNull(features.blackBarRatio) ?? 0;
  const activeContent = numberOrNull(features.activeContentRatio) ?? Math.max(0, 1 - blackBars);
  const activeContentTooSmall = activeContent < 0.18;
  const goalRole = ["finish", "payoff"].includes(role);
  const goalRoleWideLiveFinish = goalRole &&
    green >= 0.62 &&
    green <= 0.74 &&
    white >= 0.008 &&
    white <= 0.0145 &&
    saturated >= 0.04 &&
    saturated <= 0.12 &&
    skin < 0.01 &&
    dark < 0.045 &&
    activeContent >= 0.72;
  const goalRoleBenchOrCelebrationCloseup = goalRole &&
    skin > 0.065 &&
    green >= 0.24 &&
    green < 0.4 &&
    white < 0.035 &&
    saturated < 0.08 &&
    dark > 0.14;
  const goalRoleSidelineBenchCloseup = goalRole &&
    skin >= 0.055 &&
    green >= 0.24 &&
    green <= 0.36 &&
    white < 0.032 &&
    saturated < 0.07 &&
    dark > 0.2;
  const goalRoleGreenOnlyPlayerOrFieldCloseup = goalRole &&
    green > 0.7 &&
    white < 0.065 &&
    saturated < 0.065 &&
    skin < 0.018;
  const goalRoleCloseupSignature = goalRole && (
    (skin > 0.03 && white > 0.07 && green < 0.42) ||
    (skin > 0.06 && saturated > 0.22) ||
    (skin > 0.025 && saturated < 0.07 && white > 0.12) ||
    (green >= 0.32 && green <= 0.5 && white > 0.045 && dark < 0.09 && saturated < 0.08 && skin > 0.01) ||
    (green > 0.62 && skin > 0.02 && saturated < 0.07) ||
    (green > 0.6 && white > 0.08 && skin > 0.01 && saturated < 0.08) ||
    (green > 0.6 && saturated > 0.45 && white > 0.025 && skin > 0.01) ||
    (skin > 0.035 && saturated > 0.2 && white > 0.045) ||
    (skin > 0.035 && white > 0.065 && saturated > 0.18) ||
    (green > 0.62 && skin > 0.015 && saturated < 0.03 && dark > 0.1) ||
    (green >= 0.32 && green <= 0.5 && dark > 0.22 && skin > 0.02 && white < 0.04 && saturated < 0.08) ||
    goalRoleBenchOrCelebrationCloseup ||
    goalRoleSidelineBenchCloseup ||
    (goalRoleGreenOnlyPlayerOrFieldCloseup && !goalRoleWideLiveFinish)
  );
  const playerCloseupOnly = (green < 0.09 && skin > 0.035) ||
    (green < 0.06 && saturated > 0.18) ||
    (goalRole && green < 0.18 && skin > 0.018) ||
    (goalRole && green < 0.16 && saturated > 0.16) ||
    goalRoleCloseupSignature;
  const scoreboardOnly = green < 0.04 && white > 0.08 && dark > 0.28;
  const tooBlurred = saturated < 0.035 && white < 0.012 && green < 0.16;
  const tooZoomed = (green < 0.07 && white < 0.018) || (goalRole && green < 0.13);
  const tooWideUnclear = green > 0.58 && white < (goalRole ? 0.018 : 0.012) && saturated < 0.12 && !goalRoleWideLiveFinish;
  const hasGoalMouth = white >= 0.018 || (white >= 0.012 && green >= 0.14) || goalRoleWideLiveFinish;
  const hasActionSurface = green >= 0.10 && !activeContentTooSmall;
  const hasVisibleAction = hasActionSurface && !playerCloseupOnly && !scoreboardOnly && !tooBlurred;
  const hasGoalRoleScale = !goalRole ||
    goalRoleWideLiveFinish ||
    (green >= 0.14 && (white >= 0.018 || (white >= 0.014 && saturated >= 0.14 && skin < 0.012)));
  const roleClear = role === "pre_shot"
    ? hasVisibleAction && green >= 0.14
    : role === "confirmation"
      ? hasVisibleAction && (green >= 0.12 || hasGoalMouth)
      : hasVisibleAction && hasGoalMouth && hasGoalRoleScale && !tooWideUnclear && !tooZoomed;
  const reasons = [
    ...(!hasVisibleAction ? ["semantic_action_surface_not_visible"] : []),
    ...(role !== "pre_shot" && !hasGoalMouth ? ["semantic_goalmouth_or_payoff_not_visible"] : []),
    ...(role !== "pre_shot" && !hasGoalRoleScale ? ["semantic_goal_finish_scale_not_visible"] : []),
    ...(playerCloseupOnly ? ["semantic_player_closeup_only"] : []),
    ...(scoreboardOnly ? ["semantic_scoreboard_only"] : []),
    ...(tooBlurred ? ["semantic_frame_too_blurred"] : []),
    ...(tooZoomed ? ["semantic_frame_too_zoomed"] : []),
    ...(tooWideUnclear ? ["semantic_frame_too_wide_unclear"] : []),
    ...(activeContentTooSmall ? ["semantic_active_content_too_small"] : []),
  ];
  const confidence = roleClear
    ? Math.min(0.91, 0.52 + green * 0.55 + white * 2.2 + saturated * 0.18)
    : Math.max(0.1, Math.min(0.52, 0.18 + green * 0.35 + white * 0.9));
  return {
    role,
    visibilityVerdict: roleClear ? "clear" : "failed",
    visibleGoal: roleClear,
    hasVisibleFinish: roleClear && role === "finish",
    hasBallInNetOrPayoff: roleClear && ["finish", "payoff"].includes(role),
    hasGoalMouth: roleClear && (hasGoalMouth || role === "pre_shot" || role === "confirmation"),
    replayOnly: false,
    celebrationOnly: playerCloseupOnly && role === "confirmation",
    scoreboardOnly,
    playerCloseupOnly,
    tooBlurred,
    tooZoomed,
    confidence: round(confidence, 2),
    reasons: roleClear ? [] : safeReasons(reasons.length ? reasons : ["semantic_goal_visibility_not_clear"]),
    roles: [role],
    providerMode: "semantic-goal-visibility",
    features,
  };
}

async function analyzeFrame(frame = {}, role = "", options = {}) {
  const ignoreExistingEvidence = options.ignoreExistingEvidence === true &&
    sanitizeText(frame && frame.source || "", 40) === "ffmpeg";
  const existing = ignoreExistingEvidence ? null : existingEvidence(frame);
  if (existing) return normalizeExistingEvidence(existing, role);
  if (!frame || !frame.localPath) return failedEvidence(role, "semantic_frame_missing");
  let framePath;
  try {
    framePath = assertStoragePath(frame.localPath, "staging");
  } catch {
    return failedEvidence(role, "semantic_frame_path_unsafe");
  }
  if (!existsSync(framePath)) return failedEvidence(role, "semantic_frame_file_missing");
  if (!commandAvailable(CONFIG.ffmpegBin)) return failedEvidence(role, "semantic_frame_ffmpeg_missing");
  try {
    const width = numberOrNull(frame.width);
    const height = numberOrNull(frame.height);
    const portraitRenderedFrame = width != null && height != null && height > width * 1.25;
    const videoFilter = portraitRenderedFrame
      ? `crop=iw:ih*0.34:0:(ih-oh)/2,scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`
      : `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`;
    const raw = await runFfmpegRawFrame(framePath, options.runner || execFile, videoFilter);
    const features = analyzeRgbBuffer(raw);
    if (!features) return failedEvidence(role, "semantic_frame_decode_failed");
    return classifyFeatures(features, role);
  } catch {
    return failedEvidence(role, "semantic_frame_decode_failed");
  }
}

async function analyzeSemanticGoalFrames({
  frames = [],
  roleWindows = [],
  signal = null,
  frameAnalyzer = analyzeFrame,
  runner = execFile,
  maxConcurrency = DEFAULT_MAX_PARALLEL_FRAME_ANALYSIS,
  ignoreExistingEvidence = false,
} = {}) {
  const safeFrames = Array.isArray(frames) ? frames : [];
  const safeWindows = Array.isArray(roleWindows) ? roleWindows : [];
  const limit = Math.max(1, Math.min(Number.isFinite(Number(maxConcurrency)) ? Math.floor(Number(maxConcurrency)) : DEFAULT_MAX_PARALLEL_FRAME_ANALYSIS, 8));
  const frameEvidence = new Array(safeWindows.length);
  for (let start = 0; start < safeWindows.length; start += limit) {
    const chunk = safeWindows.slice(start, start + limit);
    // eslint-disable-next-line no-await-in-loop
    const chunkEvidence = await Promise.all(chunk.map(async (window, offset) => {
      const index = start + offset;
      const role = sanitizeText(window?.role || "", 40) || `frame_${index + 1}`;
      if (signal && signal.aborted) {
        return failedEvidence(role, "semantic_frame_analysis_cancelled");
      }
      return frameAnalyzer(safeFrames[index], role, { runner, ignoreExistingEvidence });
    }));
    chunkEvidence.forEach((evidence, offset) => {
      frameEvidence[start + offset] = evidence;
    });
  }
  const clearFrameCount = frameEvidence.filter((item) => item.visibilityVerdict === "clear").length;
  return {
    providerMode: "semantic-goal-visibility",
    clearFrameCount,
    failedFrameCount: frameEvidence.length - clearFrameCount,
    frameEvidence,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

module.exports = {
  analyzeRgbBuffer,
  analyzeSemanticGoalFrames,
  classifyFeatures,
  normalizeExistingEvidence,
};
