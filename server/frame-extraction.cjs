const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, rmSync, statSync } = require("node:fs");
const { basename, join, relative } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { runFfmpeg } = require("./render.cjs");
const { assertStoragePath, safeResolve, storagePath } = require("./storage.cjs");

const DEFAULT_MAX_FRAMES = 10;
const DEFAULT_MAX_DIMENSION = 640;
const DEFAULT_FRAME_FORMAT = "jpg";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 2));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function scaledDimensions(metadata = {}, maxDimension = DEFAULT_MAX_DIMENSION) {
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: DEFAULT_MAX_DIMENSION, height: even(DEFAULT_MAX_DIMENSION * 9 / 16) };
  }
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}

function normalizeCandidateWindow(candidate, metadata = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const duration = seconds(metadata.durationSeconds, 0);
  const center = seconds(candidate.center ?? candidate.time, Number.NaN);
  if (
    Number.isFinite(Number(candidate.start)) &&
    Number.isFinite(Number(candidate.end)) &&
    seconds(candidate.end) <= seconds(candidate.start)
  ) {
    return null;
  }
  const start = Number.isFinite(Number(candidate.start)) ? seconds(candidate.start) : center - 1.5;
  const end = Number.isFinite(Number(candidate.end)) ? seconds(candidate.end) : center + 1.5;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const boundedStart = Number(clamp(start, 0, Math.max(0, duration || end)).toFixed(2));
  const boundedEnd = Number(clamp(end, boundedStart + 0.4, duration || end).toFixed(2));
  if (boundedEnd <= boundedStart) return null;
  const timestamp = Number(clamp(candidate.timestamp ?? center, boundedStart, boundedEnd).toFixed(2));
  return {
    start: boundedStart,
    end: boundedEnd,
    timestamp,
    confidence: Number(clamp(candidate.confidence, 0.05, 0.95).toFixed(2)),
    source: sanitizeText(candidate.source || "candidate_window", 40),
    visualHints: Array.isArray(candidate.visualHints)
      ? candidate.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
      : [],
  };
}

function fallbackWindows(metadata = {}) {
  const duration = seconds(metadata.durationSeconds, 0);
  if (duration <= 0) return [];
  return [duration * 0.25, duration * 0.5, duration * 0.75].map((time) => ({
    start: Math.max(0, Number((time - 1.5).toFixed(2))),
    end: Number(Math.min(duration, time + 1.5).toFixed(2)),
    timestamp: Number(time.toFixed(2)),
    confidence: 0.45,
    source: "duration_sample",
    visualHints: [],
  }));
}

function selectTemporalCoverage(windows = [], { maxItems = DEFAULT_MAX_FRAMES, duration = 0 } = {}) {
  const safeWindows = (Array.isArray(windows) ? windows : [])
    .filter((window) => Number.isFinite(Number(window.timestamp)))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (safeWindows.length <= maxItems) return safeWindows;
  const mediaDuration = Math.max(0, Number(duration) || safeWindows[safeWindows.length - 1].timestamp || 0);
  const minGap = mediaDuration > 0 ? Math.max(3, mediaDuration / maxItems * 0.45) : 3;
  const selected = [];
  const ranked = [...safeWindows].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || a.timestamp - b.timestamp);
  for (const window of ranked) {
    if (selected.length >= maxItems) break;
    if (selected.some((existing) => Math.abs(existing.timestamp - window.timestamp) < minGap)) continue;
    selected.push(window);
  }
  for (const window of safeWindows) {
    if (selected.length >= maxItems) break;
    if (selected.includes(window)) continue;
    selected.push(window);
  }
  return selected.sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeFrameExtractionInput(input = {}) {
  const metadata = input.metadata || {};
  const maxFrames = Math.max(1, Math.min(DEFAULT_MAX_FRAMES, Math.floor(Number(input.maxFrames || DEFAULT_MAX_FRAMES))));
  const maxDimension = Math.max(160, Math.min(DEFAULT_MAX_DIMENSION, Math.floor(Number(input.maxDimension || DEFAULT_MAX_DIMENSION))));
  const outputDir = input.outputDir
    ? assertStoragePath(input.outputDir, "staging")
    : storagePath("staging", join("frames", `frames_${randomUUID()}`));
  const rawWindows = Array.isArray(input.candidateWindows) ? input.candidateWindows : [];
  const windows = rawWindows
    .map((candidate) => normalizeCandidateWindow(candidate, metadata))
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
  const coveredWindows = selectTemporalCoverage(windows, {
    maxItems: maxFrames,
    duration: seconds(metadata.durationSeconds, 0),
  });
  const sampledWindows = coveredWindows.length ? coveredWindows : fallbackWindows(metadata).slice(0, maxFrames);
  if (rawWindows.length && !windows.length) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return {
    inputPath: input.inputPath,
    metadata,
    outputDir,
    windows: sampledWindows,
    maxFrames,
    maxDimension,
    ffmpegRunner: input.ffmpegRunner || runFfmpeg,
    signal: input.signal || null,
  };
}

function frameOutputPath(outputDir, index) {
  return safeResolve(outputDir, `frame_${String(index + 1).padStart(2, "0")}.${DEFAULT_FRAME_FORMAT}`);
}

function publicFrameSummary(result) {
  const safe = result && typeof result === "object" ? result : {};
  return {
    providerMode: sanitizeText(safe.providerMode || "mock", 40),
    fallbackUsed: Boolean(safe.fallbackUsed),
    summary: {
      frameCount: Number(safe.summary && safe.summary.frameCount || 0),
      sampledWindows: Number(safe.summary && safe.summary.sampledWindows || 0),
      skippedWindows: Number(safe.summary && safe.summary.skippedWindows || 0),
      extractionMs: Number(safe.summary && safe.summary.extractionMs || 0),
    },
    frames: Array.isArray(safe.frames)
      ? safe.frames.map((frame) => ({
          id: sanitizeText(frame.id, 64),
          windowStart: Number(frame.windowStart || 0),
          windowEnd: Number(frame.windowEnd || 0),
          timestamp: Number(frame.timestamp || 0),
          width: Number(frame.width || 0),
          height: Number(frame.height || 0),
          purpose: sanitizeText(frame.purpose || "vision_context", 40),
          source: sanitizeText(frame.source || "unknown", 40),
        }))
      : [],
  };
}

function mockFrameExtraction({ outputDir = null, startedAt, windows = [], reason = "ffmpeg_unavailable" } = {}) {
  const extractionMs = Math.max(0, Date.now() - (startedAt || Date.now()));
  return {
    providerMode: "mock",
    fallbackUsed: true,
    outputDir,
    frames: [],
    summary: {
      frameCount: 0,
      sampledWindows: 0,
      skippedWindows: windows.length,
      extractionMs,
      reason: sanitizeText(reason, 60),
    },
  };
}

function assertFrameLocalPath(framePath, outputDir) {
  if (!framePath) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  if (!outputDir) return assertStoragePath(framePath, "staging");
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  const safeFramePath = safeResolve(safeOutputDir, basename(framePath));
  if (safeFramePath !== framePath) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return safeFramePath;
}

function validateExtractedFrames(result, outputDir) {
  if (!result || typeof result !== "object") {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  const frames = Array.isArray(result.frames) ? result.frames : [];
  const safeFrames = frames.map((frame, index) => {
    const localPath = assertFrameLocalPath(frame.localPath, outputDir);
    const timestamp = seconds(frame.timestamp, Number.NaN);
    const width = Number(frame.width);
    const height = Number(frame.height);
    if (!Number.isFinite(timestamp) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
    }
    return {
      id: sanitizeText(frame.id || `frame_${index + 1}`, 64),
      windowStart: seconds(frame.windowStart, 0),
      windowEnd: seconds(frame.windowEnd, 0),
      timestamp: Number(timestamp.toFixed(2)),
      width,
      height,
      localPath,
      purpose: sanitizeText(frame.purpose || "vision_context", 40),
      source: sanitizeText(frame.source || "ffmpeg", 40),
      visualHints: Array.isArray(frame.visualHints)
        ? frame.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
        : [],
    };
  });
  return {
    providerMode: sanitizeText(result.providerMode || "ffmpeg-frame-sampling", 40),
    fallbackUsed: Boolean(result.fallbackUsed),
    outputDir: outputDir ? assertStoragePath(outputDir, "staging") : null,
    frames: safeFrames,
    summary: {
      frameCount: safeFrames.length,
      sampledWindows: Number(result.summary && result.summary.sampledWindows || safeFrames.length),
      skippedWindows: Number(result.summary && result.summary.skippedWindows || 0),
      extractionMs: Number(result.summary && result.summary.extractionMs || 0),
    },
  };
}

async function extractSampledFrames(input = {}) {
  const startedAt = Date.now();
  const normalized = normalizeFrameExtractionInput(input);
  if (normalized.signal && normalized.signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  if (!normalized.inputPath || !existsSync(normalized.inputPath)) {
    return mockFrameExtraction({
      outputDir: normalized.outputDir,
      startedAt,
      windows: normalized.windows,
      reason: "input_unavailable",
    });
  }
  if (normalized.ffmpegRunner === runFfmpeg && !commandAvailable(CONFIG.ffmpegBin)) {
    return mockFrameExtraction({
      outputDir: normalized.outputDir,
      startedAt,
      windows: normalized.windows,
      reason: "ffmpeg_unavailable",
    });
  }
  mkdirSync(normalized.outputDir, { recursive: true });
  const dimensions = scaledDimensions(normalized.metadata, normalized.maxDimension);
  const frames = [];
  try {
    for (const [index, window] of normalized.windows.entries()) {
      if (normalized.signal && normalized.signal.aborted) {
        throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      }
      const localPath = frameOutputPath(normalized.outputDir, index);
      await normalized.ffmpegRunner(
        [
          "-y",
          "-ss",
          String(window.timestamp),
          "-i",
          normalized.inputPath,
          "-frames:v",
          "1",
          "-vf",
          `scale=${dimensions.width}:${dimensions.height}`,
          "-q:v",
          "4",
          localPath,
        ],
        { signal: normalized.signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 30000) },
      );
      if (!existsSync(localPath) || !statSync(localPath).isFile()) continue;
      frames.push({
        id: `frame_${index + 1}`,
        windowStart: window.start,
        windowEnd: window.end,
        timestamp: window.timestamp,
        width: dimensions.width,
        height: dimensions.height,
        localPath,
        purpose: "vision_context",
        source: window.source,
        visualHints: window.visualHints,
      });
    }
  } catch (error) {
    if (error && error.code === "JOB_CANCELLED") throw error;
    cleanupSampledFrames({ outputDir: normalized.outputDir, frames });
    return mockFrameExtraction({
      outputDir: normalized.outputDir,
      startedAt,
      windows: normalized.windows,
      reason: "frame_extraction_failed",
    });
  }
  return validateExtractedFrames({
    providerMode: "ffmpeg-frame-sampling",
    fallbackUsed: frames.length === 0,
    frames,
    summary: {
      frameCount: frames.length,
      sampledWindows: frames.length,
      skippedWindows: Math.max(0, normalized.windows.length - frames.length),
      extractionMs: Date.now() - startedAt,
    },
  }, normalized.outputDir);
}

function cleanupSampledFrames({ outputDir, frames = [] } = {}) {
  const cleaned = [];
  const safeOutputDir = outputDir ? assertStoragePath(outputDir, "staging") : null;
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!frame || !frame.localPath) continue;
    const localPath = assertFrameLocalPath(frame.localPath, safeOutputDir);
    try {
      rmSync(localPath, { force: true });
      cleaned.push(relative(CONFIG.stagingDir, localPath).replace(/\\/g, "/"));
    } catch {
      // Best-effort temp cleanup. Missing files are acceptable.
    }
  }
  if (safeOutputDir) {
    try {
      rmSync(safeOutputDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup. The next cleanup pass can remove empty dirs.
    }
  }
  return {
    cleanedCount: cleaned.length,
    cleaned,
  };
}

function frameExtractionHealth() {
  return {
    ready: true,
    mode: "ffmpeg-frame-sampling",
    ffmpegAvailable: commandAvailable(CONFIG.ffmpegBin),
    fallbackMode: "mock",
    objectTracking: false,
    maxFrames: DEFAULT_MAX_FRAMES,
    maxDimension: DEFAULT_MAX_DIMENSION,
  };
}

module.exports = {
  DEFAULT_MAX_DIMENSION,
  DEFAULT_MAX_FRAMES,
  cleanupSampledFrames,
  extractSampledFrames,
  frameExtractionHealth,
  normalizeCandidateWindow,
  publicFrameSummary,
  scaledDimensions,
  validateExtractedFrames,
};
