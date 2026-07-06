const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { CONFIG } = require("./config.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { assertStoragePath } = require("./storage.cjs");

const SAMPLE_WIDTH = 72;
const SAMPLE_HEIGHT = 128;
const MAX_REASON_CODES = 8;

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

function runFfmpegRawFrame(framePath, runner = execFile) {
  return new Promise((resolve, reject) => {
    runner(CONFIG.ffmpegBin, [
      "-v",
      "error",
      "-i",
      framePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`,
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
    if (g > 48 && g > r * 1.06 && g > b * 1.05) green += 1;
    if (r > 155 && g > 155 && b > 155 && max - min < 60) white += 1;
    if (r + g + b < 95) dark += 1;
    if (r > 95 && g > 50 && b > 30 && r > g * 1.05 && g > b * 1.02 && r - b > 30) skin += 1;
    if (max > 145 && max - min > 70) saturated += 1;
    if (r < 12 && g < 12 && b < 12) blackBars += 1;
  }
  const ratio = (value) => round(value / total, 4);
  return {
    greenRatio: ratio(green),
    whiteRatio: ratio(white),
    darkRatio: ratio(dark),
    skinRatio: ratio(skin),
    saturatedColorRatio: ratio(saturated),
    blackBarRatio: ratio(blackBars),
  };
}

function classifyFeatures(features = {}, role = "") {
  const green = numberOrNull(features.greenRatio) ?? 0;
  const white = numberOrNull(features.whiteRatio) ?? 0;
  const dark = numberOrNull(features.darkRatio) ?? 0;
  const skin = numberOrNull(features.skinRatio) ?? 0;
  const saturated = numberOrNull(features.saturatedColorRatio) ?? 0;
  const blackBars = numberOrNull(features.blackBarRatio) ?? 0;
  const goalRole = ["finish", "payoff"].includes(role);
  const playerCloseupOnly = (green < 0.09 && skin > 0.035) ||
    (green < 0.06 && saturated > 0.18) ||
    (goalRole && green < 0.18 && skin > 0.018) ||
    (goalRole && green < 0.16 && saturated > 0.16);
  const scoreboardOnly = green < 0.04 && white > 0.08 && dark > 0.28;
  const tooBlurred = saturated < 0.035 && white < 0.012 && green < 0.16;
  const tooZoomed = (green < 0.07 && white < 0.018) || (goalRole && green < 0.13);
  const tooWideUnclear = green > 0.58 && white < (goalRole ? 0.018 : 0.012) && saturated < 0.12;
  const hasGoalMouth = white >= 0.018 || (white >= 0.012 && green >= 0.14);
  const hasActionSurface = green >= 0.10 && blackBars < 0.25;
  const hasVisibleAction = hasActionSurface && !playerCloseupOnly && !scoreboardOnly && !tooBlurred;
  const hasGoalRoleScale = !goalRole || (green >= 0.14 && white >= 0.018);
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
  const existing = existingEvidence(frame);
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
    const raw = await runFfmpegRawFrame(framePath, options.runner || execFile);
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
} = {}) {
  const safeFrames = Array.isArray(frames) ? frames : [];
  const safeWindows = Array.isArray(roleWindows) ? roleWindows : [];
  const frameEvidence = [];
  for (let index = 0; index < safeWindows.length; index += 1) {
    if (signal && signal.aborted) {
      frameEvidence.push(failedEvidence(sanitizeText(safeWindows[index]?.role || "", 40), "semantic_frame_analysis_cancelled"));
      continue;
    }
    const role = sanitizeText(safeWindows[index]?.role || "", 40) || `frame_${index + 1}`;
    // eslint-disable-next-line no-await-in-loop
    frameEvidence.push(await frameAnalyzer(safeFrames[index], role, { runner }));
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
