const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence } = require("./goal-evidence-provider.cjs");
const { visualReasonCodesForWindow } = require("./vision.cjs");

const DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS = 10000;
const MAX_SCOREBOARD_OCR_FRAMES = 12;
const MAX_SCOREBOARD_REGIONS = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function hasUnsafeValue(value) {
  const serialized = JSON.stringify(value || {});
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i.test(serialized);
}

function mediaDimensions(metadata = {}, frame = {}) {
  return {
    width: Math.max(1, Math.round(Number(frame.width || metadata.width || 1920))),
    height: Math.max(1, Math.round(Number(frame.height || metadata.height || 1080))),
  };
}

function normalizeRegion(region = {}, metadata = {}, frame = {}) {
  if (!region || typeof region !== "object" || Array.isArray(region) || hasUnsafeValue(region)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const { width: frameWidth, height: frameHeight } = mediaDimensions(metadata, frame);
  const ratioLike = [region.x, region.y, region.width, region.height].every((value) => Number(value) >= 0 && Number(value) <= 1);
  const rawX = Number(region.x ?? region.left ?? 0);
  const rawY = Number(region.y ?? region.top ?? 0);
  const rawWidth = Number(region.width ?? 0);
  const rawHeight = Number(region.height ?? 0);
  if (!ratioLike && (
    rawX < 0 ||
    rawY < 0 ||
    rawWidth <= 0 ||
    rawHeight <= 0 ||
    rawX >= frameWidth ||
    rawY >= frameHeight ||
    rawX + rawWidth > frameWidth ||
    rawY + rawHeight > frameHeight
  )) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const x = ratioLike ? rawX * frameWidth : rawX;
  const y = ratioLike ? rawY * frameHeight : rawY;
  const width = ratioLike ? rawWidth * frameWidth : rawWidth;
  const height = ratioLike ? rawHeight * frameHeight : rawHeight;
  const safeX = clamp(x, 0, frameWidth - 1);
  const safeY = clamp(y, 0, frameHeight - 1);
  const safeWidth = clamp(width, 8, frameWidth - safeX);
  const safeHeight = clamp(height, 8, frameHeight - safeY);
  const maxRegionArea = frameWidth * frameHeight * 0.28;
  if (safeWidth * safeHeight > maxRegionArea) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    id: sanitizeText(region.id || region.name || "scoreboard_region", 64),
    x: Math.round(safeX),
    y: Math.round(safeY),
    width: Math.round(safeWidth),
    height: Math.round(safeHeight),
    anchor: sanitizeText(region.anchor || "top", 40),
  };
}

function defaultScoreboardRegions(metadata = {}, frame = {}) {
  const { width, height } = mediaDimensions(metadata, frame);
  return [
    { id: "scoreboard_top_left", x: width * 0.02, y: height * 0.02, width: width * 0.34, height: height * 0.14, anchor: "top_left" },
    { id: "scoreboard_top_center", x: width * 0.33, y: height * 0.02, width: width * 0.34, height: height * 0.14, anchor: "top_center" },
    { id: "scoreboard_top_right", x: width * 0.64, y: height * 0.02, width: width * 0.34, height: height * 0.14, anchor: "top_right" },
  ].map((region) => normalizeRegion(region, metadata, frame));
}

function regionHintsForFrame(frame = {}, metadata = {}) {
  const hints = Array.isArray(frame.scoreboardRegions) && frame.scoreboardRegions.length
    ? frame.scoreboardRegions
    : Array.isArray(frame.regions) && frame.regions.length
      ? frame.regions
      : [];
  if (!hints.length) return defaultScoreboardRegions(metadata, frame);
  return hints
    .map((region) => normalizeRegion(region, metadata, frame))
    .slice(0, MAX_SCOREBOARD_REGIONS);
}

function frameTimestamp(frame = {}) {
  return seconds(frame.timestamp ?? frame.center ?? frame.time, Number.NaN);
}

function visualWindowCenter(window = {}) {
  const start = seconds(window.start, 0);
  const end = seconds(window.end, start);
  return seconds(window.center ?? (start + end) / 2, start);
}

function importantVisualWindow(window = {}) {
  const reasons = new Set(visualReasonCodesForWindow(window));
  return [
    "visual_ball_in_net",
    "visual_scoreboard_context",
    "visual_scoreboard_goal_confirmed",
    "visual_scoreboard_goal_removed",
    "visual_no_goal_decision",
    "visual_referee_goal_signal",
    "visual_referee_no_goal_signal",
    "visual_offside_flag",
    "visual_var_check",
    "visual_var_decision",
    "visual_replay_indicator",
    "visual_replay_angle",
    "visual_shot_contact",
    "visual_ball_toward_goal",
  ].some((reason) => reasons.has(reason));
}

function selectOcrFrames({ frames = [], visualSignals = {}, candidateWindows = [], metadata = {} } = {}) {
  const safeFrames = (Array.isArray(frames) ? frames : [])
    .filter((frame) => Number.isFinite(frameTimestamp(frame)))
    .sort((a, b) => frameTimestamp(a) - frameTimestamp(b));
  if (!safeFrames.length) return [];
  const importantTimes = [];
  const visualWindows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  for (const window of visualWindows.filter(importantVisualWindow)) importantTimes.push(visualWindowCenter(window));
  for (const candidate of Array.isArray(candidateWindows) ? candidateWindows : []) {
    const time = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
    if (Number.isFinite(time) && Number(candidate.confidence || 0) >= 0.72) importantTimes.push(time);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  if (duration > 0) {
    importantTimes.push(duration * 0.25, duration * 0.5, duration * 0.75);
  }
  const ranked = safeFrames
    .map((frame) => {
      const timestamp = frameTimestamp(frame);
      const distance = importantTimes.length
        ? Math.min(...importantTimes.map((time) => Math.abs(time - timestamp)))
        : 0;
      const hasHint = Array.isArray(frame.scoreboardOcr) || Array.isArray(frame.scoreboardEvidence) || frame.scoreboardHint;
      return {
        frame,
        score: (hasHint ? 2 : 0) + Math.max(0, 1 - distance / 18) + Number(frame.confidence || 0),
      };
    })
    .sort((a, b) => b.score - a.score || frameTimestamp(a.frame) - frameTimestamp(b.frame));
  const selected = [];
  for (const item of ranked) {
    if (selected.length >= MAX_SCOREBOARD_OCR_FRAMES) break;
    const timestamp = frameTimestamp(item.frame);
    if (selected.some((frame) => Math.abs(frameTimestamp(frame) - timestamp) < 1.25)) continue;
    selected.push(item.frame);
  }
  return selected.sort((a, b) => frameTimestamp(a) - frameTimestamp(b));
}

function evidenceHintsForFrame(frame = {}) {
  if (Array.isArray(frame.scoreboardOcr)) return frame.scoreboardOcr;
  if (Array.isArray(frame.scoreboardEvidence)) return frame.scoreboardEvidence;
  if (frame.scoreboardHint && typeof frame.scoreboardHint === "object") return [frame.scoreboardHint];
  return [];
}

function deterministicScoreboardOcr(input = {}) {
  const metadata = input.metadata || {};
  const frames = selectOcrFrames(input);
  const evidence = [];
  const explicitHints = Array.isArray(input.scoreboardOcr)
    ? input.scoreboardOcr
    : Array.isArray(input.ocrEvidence)
      ? input.ocrEvidence
      : Array.isArray(input.scoreboardEvidence)
        ? input.scoreboardEvidence
        : [];
  for (const [hintIndex, hint] of explicitHints.entries()) {
    if (hasUnsafeValue(hint)) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    evidence.push({
      ...hint,
      id: hint.id || `scoreboard_ocr_hint_${hintIndex + 1}`,
      source: "fixture_scoreboard_ocr_hint",
    });
  }
  for (const [index, frame] of frames.entries()) {
    const regions = regionHintsForFrame(frame, metadata);
    const hints = evidenceHintsForFrame(frame);
    for (const [hintIndex, hint] of hints.entries()) {
      if (hasUnsafeValue(hint)) {
        throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
      }
      evidence.push({
        ...hint,
        id: hint.id || `scoreboard_ocr_${index + 1}_${hintIndex + 1}`,
        timestamp: hint.timestamp ?? frameTimestamp(frame),
        start: hint.start ?? frame.windowStart ?? frameTimestamp(frame) - 0.8,
        end: hint.end ?? frame.windowEnd ?? frameTimestamp(frame) + 0.8,
        confidence: hint.confidence ?? frame.confidence ?? 0.72,
        source: "frame_scoreboard_hint",
        regionId: regions[0] && regions[0].id,
      });
    }
  }
  return validateScoreboardOcrOutput({
    providerMode: "deterministic-scoreboard-ocr",
    fallbackUsed: evidence.length === 0,
    evidence,
    sampledFrameCount: frames.length,
    regionCount: frames.reduce((sum, frame) => sum + regionHintsForFrame(frame, metadata).length, 0),
  }, metadata);
}

function validateScoreboardOcrOutput(output = {}, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const evidence = normalizeOcrEvidence(output.evidence || output.scoreboardOcr || output.ocrEvidence, metadata);
  const sampledFrameCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(output.sampledFrameCount || 0))));
  const regionCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES * MAX_SCOREBOARD_REGIONS, Math.round(Number(output.regionCount || 0))));
  return {
    providerMode: sanitizeText(output.providerMode || "deterministic-scoreboard-ocr", 60),
    fallbackUsed: Boolean(output.fallbackUsed || evidence.length === 0),
    confidence: round(clamp(output.confidence ?? (evidence.length ? Math.max(...evidence.map((item) => item.confidence)) : 0), 0, 1)),
    evidence,
    summary: {
      evidenceCount: evidence.length,
      scoreChangeCount: evidence.filter((item) => item.scoreChanged).length,
      scoreUnchangedCount: evidence.filter((item) => item.scoreUnchanged).length,
      ambiguousCount: evidence.filter((item) => item.ambiguous).length,
      sampledFrameCount,
      regionCount,
      fallbackUsed: Boolean(output.fallbackUsed || evidence.length === 0),
    },
  };
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithTimeout(promise, { signal, timeoutMs = DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS } = {}) {
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
      finish(reject, new AppError("SCOREBOARD_OCR_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, Math.max(250, Math.min(DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS)));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class DeterministicScoreboardOcrProvider {
  health() {
    return {
      ready: true,
      status: "degraded",
      providerMode: "deterministic-scoreboard-ocr",
      fallbackAvailable: true,
      realOcrEnabled: false,
      networkRequired: false,
      maxFrames: MAX_SCOREBOARD_OCR_FRAMES,
      maxRegions: MAX_SCOREBOARD_REGIONS,
      capabilities: [
        "scoreboard_region_sampling",
        "fixture_hint_ocr",
        "safe_empty_fallback",
      ],
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    return deterministicScoreboardOcr(input);
  }
}

class ExternalScoreboardOcrProviderAdapter extends DeterministicScoreboardOcrProvider {
  constructor({ client = null } = {}) {
    super();
    this.client = client;
  }

  health() {
    return {
      ...super.health(),
      status: this.client ? "ready" : "degraded",
      providerMode: this.client ? "external-scoreboard-ocr-adapter" : "external-scoreboard-ocr-disabled",
      realOcrEnabled: Boolean(this.client),
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    if (!this.client || typeof this.client.analyzeScoreboardOcr !== "function") {
      return validateScoreboardOcrOutput({
        ...deterministicScoreboardOcr(input),
        providerMode: "deterministic-scoreboard-ocr",
        fallbackUsed: true,
      }, input.metadata || {});
    }
    try {
      const output = await raceWithTimeout(this.client.analyzeScoreboardOcr(input), {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });
      return validateScoreboardOcrOutput({
        ...output,
        providerMode: "external-scoreboard-ocr-adapter",
        fallbackUsed: Boolean(output && output.fallbackUsed),
      }, input.metadata || {});
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      if (error && error.code === "AI_OUTPUT_INVALID") throw error;
      return validateScoreboardOcrOutput({
        ...deterministicScoreboardOcr(input),
        providerMode: "deterministic-scoreboard-ocr",
        fallbackUsed: true,
      }, input.metadata || {});
    }
  }
}

function createScoreboardOcrProvider({ mode, client } = {}) {
  const safeMode = sanitizeText(mode || "", 80).toLowerCase();
  if (safeMode === "external" || safeMode === "external-scoreboard-ocr-adapter") {
    return new ExternalScoreboardOcrProviderAdapter({ client });
  }
  return new DeterministicScoreboardOcrProvider();
}

async function analyzeScoreboardOcr(input = {}) {
  const provider = input.provider || createScoreboardOcrProvider({
    mode: input.providerMode || input.mode,
    client: input.providerClient || input.client,
  });
  return provider.analyzeScoreboardOcr(input);
}

function publicScoreboardOcr(scoreboardOcr) {
  const safe = scoreboardOcr && typeof scoreboardOcr === "object" ? scoreboardOcr : {};
  return {
    providerMode: sanitizeText(safe.providerMode || "deterministic-scoreboard-ocr", 60),
    fallbackUsed: Boolean(safe.fallbackUsed),
    confidence: round(clamp(safe.confidence, 0, 1)),
    summary: safe.summary && typeof safe.summary === "object"
      ? {
          evidenceCount: Number(safe.summary.evidenceCount || 0),
          scoreChangeCount: Number(safe.summary.scoreChangeCount || 0),
          scoreUnchangedCount: Number(safe.summary.scoreUnchangedCount || 0),
          ambiguousCount: Number(safe.summary.ambiguousCount || 0),
          sampledFrameCount: Number(safe.summary.sampledFrameCount || 0),
          regionCount: Number(safe.summary.regionCount || 0),
          fallbackUsed: Boolean(safe.summary.fallbackUsed),
        }
      : null,
    evidence: Array.isArray(safe.evidence)
      ? safe.evidence.map((item) => ({
          id: sanitizeText(item.id, 80),
          timestamp: Number(item.timestamp || 0),
          start: Number(item.start || 0),
          end: Number(item.end || 0),
          status: sanitizeText(item.status || "unknown", 40),
          scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
          scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
          confidence: Number(item.confidence || 0),
          temporalConsistency: Boolean(item.temporalConsistency),
          ambiguous: Boolean(item.ambiguous),
          scoreChanged: Boolean(item.scoreChanged),
          scoreUnchanged: Boolean(item.scoreUnchanged),
          source: sanitizeText(item.source || "scoreboard_ocr", 60),
        }))
      : [],
  };
}

function scoreboardOcrHealth() {
  return createScoreboardOcrProvider().health();
}

module.exports = {
  DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS,
  MAX_SCOREBOARD_OCR_FRAMES,
  MAX_SCOREBOARD_REGIONS,
  DeterministicScoreboardOcrProvider,
  ExternalScoreboardOcrProviderAdapter,
  analyzeScoreboardOcr,
  createScoreboardOcrProvider,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  normalizeRegion,
  publicScoreboardOcr,
  scoreboardOcrHealth,
  selectOcrFrames,
  validateScoreboardOcrOutput,
};
