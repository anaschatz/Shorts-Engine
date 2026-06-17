const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const VISUAL_SIGNAL_TYPES = Object.freeze([
  "ball_visible",
  "goal_area_visible",
  "penalty_box_visible",
  "shot_like_motion",
  "save_like_motion",
  "foul_like_contact",
  "fast_break_motion",
  "replay_indicator",
  "camera_pan",
  "player_cluster",
  "unknown_visual_action",
]);

const VISUAL_REASON_CODES = Object.freeze([
  "visual_ball_visible",
  "visual_goal_area",
  "visual_shot_like_motion",
  "visual_save_like_motion",
  "visual_foul_like_contact",
  "visual_fast_break",
  "visual_replay_indicator",
  "visual_unknown_action",
]);

const VISUAL_REASON_BY_TYPE = Object.freeze({
  ball_visible: "visual_ball_visible",
  goal_area_visible: "visual_goal_area",
  penalty_box_visible: "visual_goal_area",
  shot_like_motion: "visual_shot_like_motion",
  save_like_motion: "visual_save_like_motion",
  foul_like_contact: "visual_foul_like_contact",
  fast_break_motion: "visual_fast_break",
  replay_indicator: "visual_replay_indicator",
  camera_pan: "visual_unknown_action",
  player_cluster: "visual_unknown_action",
  unknown_visual_action: "visual_unknown_action",
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeVisualType(value) {
  const safe = sanitizeText(value, 48).toLowerCase();
  return VISUAL_SIGNAL_TYPES.includes(safe) ? safe : "unknown_visual_action";
}

function reasonCodeForVisualType(type) {
  return VISUAL_REASON_BY_TYPE[normalizeVisualType(type)] || "visual_unknown_action";
}

function visualReasonCodesForWindow(window) {
  if (!window || typeof window !== "object") return [];
  const types = Array.isArray(window.types) && window.types.length ? window.types : [window.type];
  return [...new Set(types.map(reasonCodeForVisualType).filter(Boolean))];
}

function visualHighlightTypeForReasons(reasons = []) {
  const reasonSet = new Set(reasons);
  if (reasonSet.has("visual_save_like_motion")) return "save";
  if (reasonSet.has("visual_foul_like_contact")) return "foul";
  if (reasonSet.has("visual_fast_break")) return "counter_attack";
  if (reasonSet.has("visual_shot_like_motion")) return "big_chance";
  if (reasonSet.has("visual_replay_indicator")) return "replay_or_reaction";
  return "unknown_action";
}

function normalizeVisualWindow(window, metadata = {}) {
  if (!window || typeof window !== "object") return null;
  const duration = seconds(metadata.durationSeconds || window.durationSeconds, 0);
  const center = seconds(window.center ?? window.time, Number.NaN);
  if (
    Number.isFinite(Number(window.start)) &&
    Number.isFinite(Number(window.end)) &&
    seconds(window.end) <= seconds(window.start)
  ) {
    return null;
  }
  const rawStart = Number.isFinite(Number(window.start)) ? seconds(window.start) : center - 1.5;
  const rawEnd = Number.isFinite(Number(window.end)) ? seconds(window.end) : center + 1.5;
  const start = Number(clamp(rawStart, 0, Math.max(0, duration || rawEnd)).toFixed(2));
  const end = Number(clamp(rawEnd, start + 0.4, duration || rawEnd).toFixed(2));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const types = Array.isArray(window.types) && window.types.length
    ? window.types.map(normalizeVisualType)
    : [normalizeVisualType(window.type)];
  const uniqueTypes = [...new Set(types)].slice(0, 4);
  const confidence = Number(clamp(window.confidence, 0.05, 0.95).toFixed(2));
  return {
    start,
    end,
    center: Number(((start + end) / 2).toFixed(2)),
    type: uniqueTypes[0],
    types: uniqueTypes,
    confidence,
    source: sanitizeText(window.source || "heuristic", 40),
    evidence: {
      providerMode: sanitizeText(window.providerMode || window.source || "heuristic", 40),
      label: sanitizeText(window.label || uniqueTypes[0], 80),
      motionScore: Number(clamp(window.motionScore ?? confidence, 0, 1).toFixed(2)),
      objectTracking: false,
      goalClaimAllowed: false,
    },
  };
}

function safeSummaryValue(windows, type) {
  const matching = windows.filter((window) => window.types.includes(type));
  if (!matching.length) return { present: false, confidence: 0 };
  return {
    present: true,
    confidence: Number(Math.max(...matching.map((window) => window.confidence)).toFixed(2)),
  };
}

function summarizeVisualSignals(input = {}) {
  const windows = Array.isArray(input.windows) ? input.windows : [];
  const reasonCodes = [...new Set(windows.flatMap(visualReasonCodesForWindow))];
  const topTypes = [...new Set(windows.flatMap((window) => window.types || [window.type]).map(normalizeVisualType))].slice(0, 8);
  const actionFocusConfidence = windows.length
    ? Number(Math.max(...windows.map((window) => Number(window.confidence || 0))).toFixed(2))
    : 0;
  return {
    providerMode: sanitizeText(input.providerMode || "mock", 40),
    fallbackUsed: Boolean(input.fallbackUsed),
    windowCount: windows.length,
    topTypes,
    reasonCodes,
    actionFocusConfidence,
    ballPresence: safeSummaryValue(windows, "ball_visible"),
    playerDensity: safeSummaryValue(windows, "player_cluster"),
    goalAreaPresence: safeSummaryValue(windows, "goal_area_visible"),
    penaltyBoxPresence: safeSummaryValue(windows, "penalty_box_visible"),
    shotLikeMotion: safeSummaryValue(windows, "shot_like_motion"),
    saveLikeMotion: safeSummaryValue(windows, "save_like_motion"),
    foulLikeContact: safeSummaryValue(windows, "foul_like_contact"),
    fastBreakMotion: safeSummaryValue(windows, "fast_break_motion"),
    cameraPanIntensity: safeSummaryValue(windows, "camera_pan"),
    replayIndicator: safeSummaryValue(windows, "replay_indicator"),
    goalClaimAllowed: false,
  };
}

function validateVisualSignals(signals, metadata = {}) {
  if (!signals || typeof signals !== "object") {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const rawWindows = Array.isArray(signals.windows) ? signals.windows : [];
  const windows = rawWindows
    .map((window) => normalizeVisualWindow(window, metadata))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .slice(0, 16);
  if (rawWindows.length !== windows.length) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const normalized = {
    providerMode: sanitizeText(signals.providerMode || "mock", 40),
    fallbackUsed: Boolean(signals.fallbackUsed),
    confidence: Number(clamp(signals.confidence ?? (windows.length ? 0.5 : 0), 0, 1).toFixed(2)),
    windows,
  };
  return {
    ...normalized,
    summary: summarizeVisualSignals(normalized),
  };
}

function candidateToVisualWindow(candidate, metadata = {}) {
  const hints = Array.isArray(candidate && candidate.visualHints) ? candidate.visualHints : [];
  if (hints.length) {
    return normalizeVisualWindow({
      start: candidate.start,
      end: candidate.end,
      time: candidate.time,
      center: candidate.center,
      confidence: candidate.confidence,
      types: hints,
      source: candidate.source || "fixture_hint",
      label: "fixture visual hint",
    }, metadata);
  }
  const confidence = Number(candidate && candidate.confidence || 0);
  if (confidence < 0.66) return null;
  return normalizeVisualWindow({
    time: candidate.time,
    center: candidate.center,
    start: candidate.start,
    end: candidate.end,
    confidence: Math.min(confidence, 0.72),
    type: "unknown_visual_action",
    source: candidate.source || "motion_candidate",
    label: "motion candidate without object tracking",
    motionScore: confidence,
  }, metadata);
}

function safeHeuristicWindows({ metadata = {}, candidateWindows = [] } = {}) {
  return (Array.isArray(candidateWindows) ? candidateWindows : [])
    .map((candidate) => candidateToVisualWindow(candidate, metadata))
    .filter(Boolean);
}

function candidateTimestamp(candidate) {
  return seconds(candidate && (candidate.timestamp ?? candidate.center ?? candidate.time), Number.NaN);
}

function closestCandidate(frame, candidateWindows = []) {
  const timestamp = seconds(frame && frame.timestamp, Number.NaN);
  if (!Number.isFinite(timestamp)) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of Array.isArray(candidateWindows) ? candidateWindows : []) {
    const candidateTime = candidateTimestamp(candidate);
    if (!Number.isFinite(candidateTime)) continue;
    const distance = Math.abs(candidateTime - timestamp);
    const start = seconds(candidate.start, Number.NaN);
    const end = seconds(candidate.end, Number.NaN);
    const insideWindow = Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp <= end;
    if ((insideWindow || distance <= 2) && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function frameToVisualWindow(frame, candidateWindows = [], metadata = {}) {
  if (!frame || typeof frame !== "object") return null;
  const timestamp = seconds(frame.timestamp, Number.NaN);
  const width = Number(frame.width);
  const height = Number(frame.height);
  if (!Number.isFinite(timestamp) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const matchedCandidate = closestCandidate(frame, candidateWindows);
  const rawHints = Array.isArray(frame.visualHints) && frame.visualHints.length
    ? frame.visualHints
    : Array.isArray(matchedCandidate && matchedCandidate.visualHints)
      ? matchedCandidate.visualHints
      : [];
  const types = rawHints.length ? rawHints : ["unknown_visual_action"];
  const confidence = Number(clamp(
    frame.confidence ?? (matchedCandidate && matchedCandidate.confidence) ?? 0.62,
    0.05,
    0.82,
  ).toFixed(2));
  return normalizeVisualWindow({
    start: frame.windowStart,
    end: frame.windowEnd,
    time: timestamp,
    center: timestamp,
    confidence,
    types,
    source: frame.source || "sampled_frame",
    providerMode: "frame-inspection-local",
    label: rawHints.length ? "sampled frame with fixture/provider hints" : "sampled frame context",
    motionScore: confidence,
  }, metadata);
}

function mergeWindows(windows) {
  const seen = new Set();
  return windows.filter((window) => {
    if (!window) return false;
    const key = `${window.start}:${window.end}:${(window.types || []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class SafeHeuristicVisionProvider {
  constructor({ mode = "safe-heuristic" } = {}) {
    this.mode = mode;
  }

  health() {
    return {
      ready: true,
      mode: this.mode,
      objectTracking: false,
      goalClaimAllowed: false,
      networkRequired: false,
    };
  }

  async analyzeFrames({ metadata = {}, candidateWindows = [] } = {}) {
    const windows = safeHeuristicWindows({ metadata, candidateWindows });
    return validateVisualSignals({
      providerMode: "safe-heuristic",
      fallbackUsed: true,
      confidence: windows.length ? Math.max(...windows.map((window) => window.confidence)) : 0,
      windows,
    }, metadata);
  }
}

class FrameInspectionLocalVisionProvider extends SafeHeuristicVisionProvider {
  constructor() {
    super({ mode: "frame-inspection-local" });
  }

  async analyzeFrames({ metadata = {}, candidateWindows = [], frames = [] } = {}) {
    const safeFrames = Array.isArray(frames) ? frames : [];
    const heuristicWindows = safeHeuristicWindows({ metadata, candidateWindows });
    const frameWindows = safeFrames
      .map((frame) => frameToVisualWindow(frame, candidateWindows, metadata))
      .filter(Boolean);
    const windows = mergeWindows([...frameWindows, ...heuristicWindows]).slice(0, 16);
    return validateVisualSignals({
      providerMode: safeFrames.length ? "frame-inspection-local" : "safe-heuristic",
      fallbackUsed: safeFrames.length === 0,
      confidence: windows.length ? Math.max(...windows.map((window) => window.confidence)) : 0,
      windows,
    }, metadata);
  }
}

class ExternalVisionProviderAdapter extends SafeHeuristicVisionProvider {
  constructor({ client = null } = {}) {
    super({ mode: client ? "external-vision-adapter" : "external-vision-disabled" });
    this.client = client;
  }

  health() {
    return {
      ready: Boolean(this.client),
      mode: this.mode,
      objectTracking: false,
      goalClaimAllowed: false,
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeFrames(input = {}) {
    if (!this.client || typeof this.client.analyzeFrames !== "function") {
      const fallback = new SafeHeuristicVisionProvider();
      return fallback.analyzeFrames(input);
    }
    const result = await this.client.analyzeFrames({
      metadata: input.metadata || {},
      candidateWindows: Array.isArray(input.candidateWindows) ? input.candidateWindows : [],
      frames: Array.isArray(input.frames) ? input.frames : [],
    });
    return validateVisualSignals({
      ...result,
      providerMode: "external-vision-adapter",
      fallbackUsed: Boolean(result && result.fallbackUsed),
    }, input.metadata || {});
  }
}

function normalizeVisionProviderMode(mode, frames = []) {
  const safe = sanitizeText(mode || "", 60).toLowerCase();
  if (safe === "safe-heuristic" || safe === "mock") return "safe-heuristic";
  if (safe === "external-vision-adapter" || safe === "external") return "external-vision-adapter";
  if (safe === "frame-inspection-local") return "frame-inspection-local";
  return Array.isArray(frames) && frames.length ? "frame-inspection-local" : "safe-heuristic";
}

function createVisionProvider({ mode, client, frames = [] } = {}) {
  const providerMode = normalizeVisionProviderMode(mode, frames);
  if (providerMode === "external-vision-adapter") return new ExternalVisionProviderAdapter({ client });
  if (providerMode === "frame-inspection-local") return new FrameInspectionLocalVisionProvider();
  return new SafeHeuristicVisionProvider();
}

async function analyzeFrames(input = {}) {
  const provider = createVisionProvider({
    mode: input.mode,
    client: input.client,
    frames: input.frames,
  });
  return provider.analyzeFrames(input);
}

function publicVisualSignals(signals) {
  const safe = validateVisualSignals(signals || { providerMode: "mock", fallbackUsed: true, windows: [] });
  return {
    providerMode: safe.providerMode,
    fallbackUsed: safe.fallbackUsed,
    confidence: safe.confidence,
    summary: safe.summary,
    windows: safe.windows.map((window) => ({
      start: window.start,
      end: window.end,
      type: window.type,
      types: window.types,
      confidence: window.confidence,
      reasonCodes: visualReasonCodesForWindow(window),
    })),
  };
}

function visionHealth() {
  const localProvider = createVisionProvider({ mode: "frame-inspection-local" });
  return {
    ready: true,
    mode: localProvider.health().mode,
    objectTracking: false,
    goalClaimAllowed: false,
    defaultProvider: "frame-inspection-local",
    fallbackProvider: "safe-heuristic",
    features: [
      "visual_signal_contract",
      "vision_provider_adapter",
      "sampled_frame_contract",
      "frame_inspection_local",
      "visual_reason_codes",
      "safe_no_goal_inference",
      "wide_safe_framing_support",
    ],
  };
}

module.exports = {
  VISUAL_REASON_CODES,
  VISUAL_SIGNAL_TYPES,
  analyzeFrames,
  createVisionProvider,
  frameToVisualWindow,
  publicVisualSignals,
  reasonCodeForVisualType,
  safeHeuristicWindows,
  summarizeVisualSignals,
  validateVisualSignals,
  visionHealth,
  visualHighlightTypeForReasons,
  visualReasonCodesForWindow,
};
