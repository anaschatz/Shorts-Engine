const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const DEFAULT_TRACKING_TIMEOUT_MS = 12000;
const MAX_TRACKING_FRAMES = 24;
const MAX_BALL_TRACKS = 24;
const MAX_PLAYER_CLUSTERS = 24;
const MAX_TRACKING_SAMPLES = 24;
const MAX_REASON_CODES = 10;

const TRACKING_REASON_CODES = Object.freeze([
  "tracking_ball_visible",
  "tracking_player_cluster",
  "tracking_action_bounds",
  "tracking_camera_motion",
  "tracking_action_uncertain",
  "tracking_fallback_no_ball_player_evidence",
  "tracking_provider_disabled",
  "tracking_provider_failed",
  "tracking_provider_timeout",
  "tracking_provider_output_invalid",
  "tracking_ball_interpolated",
  "tracking_ball_occluded",
  "tracking_player_cluster_fallback",
  "tracking_scoreboard_excluded",
  "tracking_camera_cut",
  "tracking_implausible_jump_rejected",
  "tracking_celebration_head_visible",
  "tracking_celebration_head_ambiguous",
  "tracking_celebration_head_fallback",
]);

const TRACKING_LABELS = Object.freeze(["ball", "player_cluster", "action"]);
const TRACKING_SAMPLE_SOURCES = Object.freeze([
  "ball_detection",
  "ball_interpolation",
  "player_cluster_fallback",
  "action_fallback",
  "celebration_head_detection",
  "celebration_face_detection",
  "celebration_person_head_estimate",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function dimensions(metadata = {}) {
  return {
    width: Math.max(1, Math.round(Number(metadata.width || 1920))),
    height: Math.max(1, Math.round(Number(metadata.height || 1080))),
    durationSeconds: Math.max(0, Number(metadata.durationSeconds || 0)),
  };
}

function unsafeValueFound(value) {
  const serialized = JSON.stringify(value || {});
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret/i.test(serialized);
}

function safeFailure(code, phase = "tracking_provider", retryable = false) {
  return {
    code: sanitizeText(code || "TRACKING_PROVIDER_FAILED", 80),
    phase: sanitizeText(phase, 80),
    retryable: Boolean(retryable),
  };
}

function validateBox(box, metadata = {}) {
  if (!box || typeof box !== "object" || Array.isArray(box)) return null;
  const { width: mediaWidth, height: mediaHeight } = dimensions(metadata);
  const x = Number(box.x ?? box.left);
  const y = Number(box.y ?? box.top);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (x + width > mediaWidth + 0.25 || y + height > mediaHeight + 0.25) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function boxCenter(box) {
  return {
    x: round(Number(box.x || 0) + Number(box.width || 0) / 2, 4),
    y: round(Number(box.y || 0) + Number(box.height || 0) / 2, 4),
  };
}

function unionBoxes(boxes, metadata = {}) {
  const safeBoxes = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
  if (!safeBoxes.length) return null;
  const { width: mediaWidth, height: mediaHeight } = dimensions(metadata);
  const left = Math.max(0, Math.min(...safeBoxes.map((box) => box.x)));
  const top = Math.max(0, Math.min(...safeBoxes.map((box) => box.y)));
  const right = Math.min(mediaWidth, Math.max(...safeBoxes.map((box) => box.x + box.width)));
  const bottom = Math.min(mediaHeight, Math.max(...safeBoxes.map((box) => box.y + box.height)));
  return validateBox({ x: left, y: top, width: right - left, height: bottom - top }, metadata);
}

function expandBox(box, metadata = {}, paddingRatio = 0.08) {
  if (!box) return null;
  return validateBox({
    x: Number(box.x || 0) - Number(box.width || 0) * paddingRatio,
    y: Number(box.y || 0) - Number(box.height || 0) * paddingRatio,
    width: Number(box.width || 0) * (1 + paddingRatio * 2),
    height: Number(box.height || 0) * (1 + paddingRatio * 2),
  }, metadata);
}

function validateTimestamp(value, metadata = {}) {
  const timestamp = Number(value);
  const { durationSeconds } = dimensions(metadata);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  if (durationSeconds && timestamp > durationSeconds + 0.25) return null;
  return round(timestamp, 2);
}

function validateLabel(value) {
  const label = sanitizeText(value || "", 40).toLowerCase();
  if (!TRACKING_LABELS.includes(label)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return label;
}

function validateReasons(value = []) {
  const reasons = (Array.isArray(value) ? value : [])
    .map((reason) => sanitizeText(reason, 80).toLowerCase())
    .filter(Boolean);
  if (reasons.some((reason) => reason === "goal" || reason.startsWith("goal_") || reason.includes("goal_claim"))) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (reasons.some((reason) => !TRACKING_REASON_CODES.includes(reason))) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return [...new Set(reasons)].slice(0, MAX_REASON_CODES);
}

function validateTrack(track, metadata = {}, expectedLabel = "ball") {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  if (track.label || track.type) {
    const label = validateLabel(track.label || track.type);
    if (label !== expectedLabel) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
  }
  const timestamp = validateTimestamp(track.timestamp ?? track.time ?? track.center, metadata);
  const bounds = validateBox(track.bounds || track.box, metadata);
  if (timestamp === null || !bounds) return null;
  return {
    timestamp,
    label: expectedLabel,
    confidence: round(clamp(track.confidence, 0, 1), 2),
    bounds,
  };
}

function validateCluster(cluster, metadata = {}) {
  return validateTrack(cluster, metadata, "player_cluster");
}

function validateTrackingSample(sample, metadata = {}) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return null;
  const time = validateTimestamp(sample.time ?? sample.timestamp, metadata);
  if (time === null) return null;
  const hasBallBox = sample.ballBox !== null && sample.ballBox !== undefined;
  const hasPlayerClusterBox = sample.playerClusterBox !== null && sample.playerClusterBox !== undefined;
  const hasCelebrationHeadBox = sample.celebrationHeadBox !== null && sample.celebrationHeadBox !== undefined;
  const ballBox = hasBallBox ? validateBox(sample.ballBox, metadata) : null;
  const playerClusterBox = hasPlayerClusterBox ? validateBox(sample.playerClusterBox, metadata) : null;
  const celebrationHeadBox = hasCelebrationHeadBox ? validateBox(sample.celebrationHeadBox, metadata) : null;
  if (
    (hasBallBox && !ballBox) ||
    (hasPlayerClusterBox && !playerClusterBox) ||
    (hasCelebrationHeadBox && !celebrationHeadBox)
  ) return null;
  const actionCenter = sample.actionCenter && typeof sample.actionCenter === "object"
    ? {
        x: round(clamp(sample.actionCenter.x, 0, dimensions(metadata).width), 2),
        y: round(clamp(sample.actionCenter.y, 0, dimensions(metadata).height), 2),
      }
    : celebrationHeadBox
      ? boxCenter(celebrationHeadBox)
      : ballBox
      ? boxCenter(ballBox)
      : playerClusterBox
        ? boxCenter(playerClusterBox)
        : null;
  if (!actionCenter || (!ballBox && !playerClusterBox && !celebrationHeadBox)) return null;
  const source = sanitizeText(sample.source || (ballBox ? "ball_detection" : "player_cluster_fallback"), 48).toLowerCase();
  if (!TRACKING_SAMPLE_SOURCES.includes(source)) return null;
  return {
    time,
    ballBox,
    ballConfidence: ballBox ? round(clamp(sample.ballConfidence, 0, 1), 2) : 0,
    playerClusterBox,
    playerClusterConfidence: playerClusterBox ? round(clamp(sample.playerClusterConfidence, 0, 1), 2) : 0,
    celebrationHeadBox,
    celebrationHeadConfidence: celebrationHeadBox ? round(clamp(sample.celebrationHeadConfidence, 0, 1), 2) : 0,
    actionCenter,
    cameraMotion: round(clamp(sample.cameraMotion, 0, 1), 2),
    source,
    reasonCodes: validateReasons(sample.reasonCodes || []),
  };
}

function validateTrackingSamples(rawSamples, metadata = {}) {
  const raw = Array.isArray(rawSamples) ? rawSamples : [];
  if (raw.length > MAX_TRACKING_SAMPLES) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const samples = raw.map((sample) => validateTrackingSample(sample, metadata)).filter(Boolean);
  if (samples.length !== raw.length) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const mediaWidth = dimensions(metadata).width;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsed = current.time - previous.time;
    if (elapsed <= 0) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    const actionJump = Math.abs(current.actionCenter.x - previous.actionCenter.x) / mediaWidth;
    if (elapsed < 0.75 && actionJump > 0.7 && !current.reasonCodes.includes("tracking_camera_cut")) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
  }
  return samples;
}

function trackingFallback({ metadata = {}, reason = "tracking_fallback_no_ball_player_evidence", frames = [], failure = null } = {}) {
  const safeFrames = Array.isArray(frames) ? frames : [];
  return validateTrackingProviderOutput({
    providerMode: "safe-tracking-fallback",
    fallbackUsed: true,
    frameCount: safeFrames.length,
    ballTracks: [],
    playerClusters: [],
    actionBounds: null,
    actionCenter: null,
    cameraMotionLevel: 0,
    confidence: 0,
    reasonCodes: [reason],
    failure,
    goalClaimAllowed: false,
  }, metadata);
}

function validateTrackingProviderOutput(output, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || unsafeValueFound(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const rawBallTracks = Array.isArray(output.ballTracks) ? output.ballTracks : [];
  const rawPlayerClusters = Array.isArray(output.playerClusters) ? output.playerClusters : [];
  const samples = validateTrackingSamples(output.samples || [], metadata);
  const ballTracks = rawBallTracks.map((track) => validateTrack(track, metadata, "ball")).filter(Boolean).slice(0, MAX_BALL_TRACKS);
  const playerClusters = rawPlayerClusters.map((cluster) => validateCluster(cluster, metadata)).filter(Boolean).slice(0, MAX_PLAYER_CLUSTERS);
  if (rawBallTracks.length !== ballTracks.length || rawPlayerClusters.length !== playerClusters.length) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const hasProvidedActionBounds = output.actionBounds !== null && output.actionBounds !== undefined;
  const providedActionBounds = hasProvidedActionBounds ? validateBox(output.actionBounds, metadata) : null;
  if (hasProvidedActionBounds && !providedActionBounds) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const actionBounds = providedActionBounds || expandBox(unionBoxes([
    ...ballTracks.map((track) => track.bounds),
    ...playerClusters.map((cluster) => cluster.bounds),
  ], metadata), metadata, 0.06);
  const fallbackUsed = Boolean(output.fallbackUsed);
  let actionCenter = actionBounds ? boxCenter(actionBounds) : null;
  if (output.actionCenter !== null && output.actionCenter !== undefined) {
    if (
      !output.actionCenter ||
      typeof output.actionCenter !== "object" ||
      !Number.isFinite(Number(output.actionCenter.x)) ||
      !Number.isFinite(Number(output.actionCenter.y))
    ) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    actionCenter = {
      x: round(clamp(output.actionCenter.x, 0, dimensions(metadata).width), 2),
      y: round(clamp(output.actionCenter.y, 0, dimensions(metadata).height), 2),
    };
  }
  const reasonCodes = validateReasons(output.reasonCodes || []);
  if (!reasonCodes.length) reasonCodes.push(fallbackUsed ? "tracking_fallback_no_ball_player_evidence" : "tracking_action_bounds");
  const normalized = {
    providerMode: sanitizeText(output.providerMode || "safe-tracking-fallback", 60),
    fallbackUsed,
    frameCount: Math.max(0, Math.min(MAX_TRACKING_FRAMES, Math.round(Number(output.frameCount || 0)))),
    ballTracks,
    playerClusters,
    samples,
    celebrationHeadTrackCount: samples.filter((sample) => (
      sample.celebrationHeadBox && sample.celebrationHeadConfidence >= 0.66
    )).length,
    actionBounds,
    actionCenter,
    cameraMotionLevel: round(clamp(output.cameraMotionLevel, 0, 1), 2),
    confidence: round(clamp(output.confidence, 0, 1), 2),
    reasonCodes,
    failure: output.failure ? safeFailure(output.failure.code, output.failure.phase, output.failure.retryable) : null,
    goalClaimAllowed: false,
  };
  if (!normalized.fallbackUsed && (!normalized.ballTracks.length || !normalized.playerClusters.length || !normalized.actionBounds)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return normalized;
}

function windowReasons(window = {}) {
  const types = Array.isArray(window.types) ? window.types : Array.isArray(window.labels) ? window.labels : [window.type || window.label].filter(Boolean);
  return types.map((type) => sanitizeText(type, 60).toLowerCase());
}

function boxForWindow(window, metadata = {}) {
  const explicit = validateBox(window && (window.actionBounds || window.bounds || window.box), metadata);
  if (explicit) return explicit;
  const { width, height } = dimensions(metadata);
  const types = windowReasons(window);
  const narrowAction = types.some((type) => ["shot_contact", "ball_toward_goal", "save_like_motion", "keeper_action", "foul_like_contact", "fast_break_motion"].includes(type));
  const boxWidth = width * (narrowAction ? 0.48 : 0.62);
  const boxHeight = height * (narrowAction ? 0.56 : 0.68);
  return validateBox({
    x: (width - boxWidth) / 2,
    y: height * 0.16,
    width: boxWidth,
    height: boxHeight,
  }, metadata);
}

function candidateWindowsFrom(input = {}) {
  const fromSignals = input.visualSignals && Array.isArray(input.visualSignals.windows) ? input.visualSignals.windows : [];
  const fromCandidates = Array.isArray(input.candidateWindows) ? input.candidateWindows : [];
  return [...fromSignals, ...fromCandidates].slice(0, 16);
}

function deterministicTrackingFromSignals(input = {}) {
  const metadata = input.metadata || {};
  const windows = candidateWindowsFrom(input);
  const frames = Array.isArray(input.frames) ? input.frames.slice(0, MAX_TRACKING_FRAMES) : [];
  const actionWindows = windows.filter((window) => {
    const types = windowReasons(window);
    const hasAction = types.some((type) => [
      "ball_visible",
      "shot_contact",
      "ball_toward_goal",
      "save_like_motion",
      "keeper_action",
      "foul_like_contact",
      "fast_break_motion",
      "player_cluster",
    ].includes(type));
    const reactionOnly = types.some((type) => ["crowd_reaction", "replay_indicator", "scoreboard_context"].includes(type)) && !hasAction;
    return hasAction && !reactionOnly && Number(window.confidence || 0) >= 0.55;
  }).slice(0, MAX_TRACKING_FRAMES);
  const ballTracks = [];
  const playerClusters = [];
  for (const window of actionWindows) {
    const types = windowReasons(window);
    const bounds = boxForWindow(window, metadata);
    const timestamp = validateTimestamp(window.center ?? ((Number(window.start || 0) + Number(window.end || 0)) / 2), metadata);
    if (!bounds || timestamp === null) continue;
    const confidence = round(clamp(window.confidence, 0, 1), 2);
    if (types.some((type) => ["ball_visible", "shot_contact", "ball_toward_goal", "save_like_motion", "keeper_action"].includes(type))) {
      ballTracks.push({ timestamp, label: "ball", confidence, bounds });
    }
    if (types.includes("player_cluster") || types.some((type) => ["shot_contact", "save_like_motion", "keeper_action", "foul_like_contact", "fast_break_motion"].includes(type))) {
      playerClusters.push({ timestamp, label: "player_cluster", confidence: Math.max(0.58, confidence - 0.03), bounds });
    }
  }
  const actionBounds = expandBox(unionBoxes([
    ...ballTracks.map((track) => track.bounds),
    ...playerClusters.map((cluster) => cluster.bounds),
  ], metadata), metadata, 0.05);
  const cameraMotionLevel = windows.some((window) => windowReasons(window).includes("camera_pan")) ? 0.82 : 0;
  const ballConfidence = ballTracks.reduce((max, track) => Math.max(max, track.confidence), 0);
  const playerConfidence = playerClusters.reduce((max, cluster) => Math.max(max, cluster.confidence), 0);
  const confidence = round(clamp(ballConfidence * 0.45 + playerConfidence * 0.35 - cameraMotionLevel * 0.25 + (actionBounds ? 0.12 : 0), 0, 1), 2);
  if (!ballTracks.length || !playerClusters.length || !actionBounds || confidence < 0.5) {
    return trackingFallback({ metadata, frames, reason: cameraMotionLevel >= 0.75 ? "tracking_camera_motion" : "tracking_fallback_no_ball_player_evidence" });
  }
  return validateTrackingProviderOutput({
    providerMode: frames.length ? "local-tracking-provider" : "safe-tracking-provider",
    fallbackUsed: false,
    frameCount: frames.length,
    ballTracks,
    playerClusters,
    actionBounds,
    actionCenter: boxCenter(actionBounds),
    cameraMotionLevel,
    confidence,
    reasonCodes: [
      "tracking_ball_visible",
      "tracking_player_cluster",
      "tracking_action_bounds",
      ...(cameraMotionLevel >= 0.75 ? ["tracking_camera_motion"] : []),
    ],
    goalClaimAllowed: false,
  }, metadata);
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithTimeout(promise, { signal, timeoutMs = DEFAULT_TRACKING_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return Promise.reject(cancellationError());
  let timer = null;
  let abortListener = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => finish(reject, cancellationError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => {
      finish(reject, new AppError("TRACKING_PROVIDER_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, Math.max(250, Math.min(DEFAULT_TRACKING_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TRACKING_TIMEOUT_MS)));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class SafeTrackingProvider {
  constructor({ mode = "safe-tracking-provider" } = {}) {
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

  analyzeTracking(input = {}) {
    return deterministicTrackingFromSignals({ ...input, providerMode: this.mode });
  }
}

class MockTrackingProvider extends SafeTrackingProvider {
  constructor() {
    super({ mode: "mock-tracking-provider" });
  }

  analyzeTracking(input = {}) {
    return validateTrackingProviderOutput({
      ...deterministicTrackingFromSignals(input),
      providerMode: "mock-tracking-provider",
    }, input.metadata || {});
  }
}

class ExternalTrackingProviderAdapter extends SafeTrackingProvider {
  constructor({ client = null } = {}) {
    super({ mode: client ? "external-tracking-adapter" : "external-tracking-disabled" });
    this.client = client;
  }

  health() {
    return {
      ready: Boolean(this.client),
      mode: this.mode,
      objectTracking: Boolean(this.client),
      goalClaimAllowed: false,
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeTracking(input = {}) {
    if (!this.client || typeof this.client.analyzeTracking !== "function") {
      return trackingFallback({
        metadata: input.metadata,
        frames: input.frames,
        reason: "tracking_provider_disabled",
        failure: safeFailure("TRACKING_PROVIDER_DISABLED", "tracking_provider", false),
      });
    }
    try {
      const result = await raceWithTimeout(
        this.client.analyzeTracking({
          frames: Array.isArray(input.frames) ? input.frames.slice(0, MAX_TRACKING_FRAMES) : [],
          metadata: input.metadata || {},
          candidateWindows: Array.isArray(input.candidateWindows) ? input.candidateWindows : [],
          visualSignals: input.visualSignals || {},
          mediaSignals: input.mediaSignals || {},
        }),
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
      return validateTrackingProviderOutput({
        ...result,
        providerMode: "external-tracking-adapter",
        goalClaimAllowed: false,
      }, input.metadata || {});
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      return trackingFallback({
        metadata: input.metadata,
        frames: input.frames,
        reason: error && error.code === "TRACKING_PROVIDER_TIMEOUT" ? "tracking_provider_timeout" : "tracking_provider_failed",
        failure: safeFailure(error && error.code ? error.code : "TRACKING_PROVIDER_FAILED", "tracking_provider", true),
      });
    }
  }
}

function createTrackingProvider({ mode, client } = {}) {
  const defaultMode = process.env.SHORTSENGINE_TRACKING_PROVIDER || "";
  const safeMode = sanitizeText(mode || defaultMode || "", 60).toLowerCase();
  if (safeMode === "mock" || safeMode === "mock-tracking-provider") return new MockTrackingProvider();
  if (safeMode === "external" || safeMode === "external-tracking-adapter") return new ExternalTrackingProviderAdapter({ client });
  if (safeMode === "opencv" || safeMode === "opencv-object-tracking") {
    const { OpenCvTrackingAdapter } = require("./adapters/opencv-tracking-adapter.cjs");
    return new OpenCvTrackingAdapter({
      enabled: true,
      client,
    });
  }
  if (safeMode === "ffmpeg" || safeMode === "ffmpeg-football" || safeMode === "ffmpeg-football-tracking") {
    const { FfmpegFootballTrackingAdapter } = require("./adapters/ffmpeg-football-tracking-adapter.cjs");
    return new FfmpegFootballTrackingAdapter({ enabled: true });
  }
  return new SafeTrackingProvider();
}

function analyzeTracking(input = {}) {
  const explicitMode = input.providerMode || input.mode || process.env.SHORTSENGINE_TRACKING_PROVIDER;
  const hasLocalFrames = Boolean(
    input.inputPath &&
    Array.isArray(input.frames) &&
    input.frames.some((frame) => frame && typeof frame.localPath === "string"),
  );
  let provider = input.provider && typeof input.provider.analyzeTracking === "function"
    ? input.provider
    : null;
  if (!provider && !explicitMode && !input.providerClient && !input.client && hasLocalFrames) {
    const { FfmpegFootballTrackingAdapter } = require("./adapters/ffmpeg-football-tracking-adapter.cjs");
    provider = new FfmpegFootballTrackingAdapter({ enabled: true });
  }
  if (!provider) {
    provider = createTrackingProvider({ mode: explicitMode, client: input.providerClient || input.client });
  }
  return provider.analyzeTracking(input);
}

function publicTrackingProviderOutput(output, metadata = {}) {
  const safe = validateTrackingProviderOutput(output || trackingFallback({ metadata }), metadata);
  return {
    providerMode: safe.providerMode,
    fallbackUsed: safe.fallbackUsed,
    frameCount: safe.frameCount,
    ballTracks: safe.ballTracks,
    playerClusters: safe.playerClusters,
    samples: safe.samples,
    ballTrackCount: safe.ballTracks.length,
    playerClusterCount: safe.playerClusters.length,
    celebrationHeadTrackCount: safe.celebrationHeadTrackCount,
    actionBounds: safe.actionBounds,
    actionCenter: safe.actionCenter,
    cameraMotionLevel: safe.cameraMotionLevel,
    confidence: safe.confidence,
    reasonCodes: safe.reasonCodes,
    failure: safe.failure,
    goalClaimAllowed: false,
  };
}

function trackingProviderHealth(options = {}) {
  const provider = createTrackingProvider(options);
  if (!provider || typeof provider.health !== "function") {
    return {
      ready: true,
      mode: "safe-tracking-provider",
      objectTracking: false,
      fallbackMode: "safe-tracking-fallback",
      goalClaimAllowed: false,
      networkRequired: false,
    };
  }
  return provider.health();
}

module.exports = {
  ExternalTrackingProviderAdapter,
  MockTrackingProvider,
  SafeTrackingProvider,
  TRACKING_REASON_CODES,
  TRACKING_SAMPLE_SOURCES,
  analyzeTracking,
  createTrackingProvider,
  publicTrackingProviderOutput,
  trackingFallback,
  trackingProviderHealth,
  validateTrackingProviderOutput,
};
