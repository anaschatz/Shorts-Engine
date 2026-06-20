const { randomUUID } = require("node:crypto");
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { basename, isAbsolute, join, relative, resolve } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { CONFIG } = require("./config.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence } = require("./goal-evidence-provider.cjs");
const { runFfmpeg } = require("./render.cjs");
const { assertStoragePath, safeResolve, storagePath } = require("./storage.cjs");
const {
  LocalOcrCommandAdapter,
  buildScoreboardEvidenceFromObservations,
  parseClock,
  parseScoreboardScore,
  scoreAllowedForRegion,
} = require("./adapters/local-ocr-adapter.cjs");
const { readScoreboardCandidate } = require("./scoreboard-reader.cjs");
const {
  calibrationSummary,
  digitReaderSummary,
  readScorebugDigits,
  validateScorebugCalibration,
} = require("./scorebug-digit-reader.cjs");
const { visualReasonCodesForWindow } = require("./vision.cjs");

const DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS = 10000;
const MAX_SCOREBOARD_OCR_FRAMES = 24;
const MAX_SCOREBOARD_REGIONS = 6;
const MAX_SCOREBOARD_OCR_CROPS = 72;
const DEFAULT_OCR_FRAME_MAX_DIMENSION = 1280;
const ROOT_DIR = resolve(__dirname, "..");
const SCOREBOARD_OCR_QA_RELATIVE_DIR = "demo/results/scoreboard-ocr-artifacts";
const SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH = "demo/results/ocr-scoreboard-qa-latest.json";
const MAX_SCOREBOARD_OCR_QA_ATTEMPTS = 72;
const MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SCOREBOARD_OCR_QA_RETENTION = 8;
const OCR_PREPROCESS_VARIANTS = Object.freeze([
  {
    id: "color_whitelist",
    psm: "11",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*4:ih*4",
  },
  {
    id: "gray_line",
    psm: "7",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.35:brightness=0.03,unsharp=5:5:0.7",
  },
  {
    id: "contrast_block",
    psm: "6",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.65:brightness=0.05,unsharp=5:5:1.0",
  },
  {
    id: "sparse_text",
    psm: "11",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.45:brightness=0.04,unsharp=5:5:0.8",
  },
]);

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

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 2));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function scaledOcrFrameDimensions(metadata = {}, maxDimension = DEFAULT_OCR_FRAME_MAX_DIMENSION) {
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: DEFAULT_OCR_FRAME_MAX_DIMENSION, height: even(DEFAULT_OCR_FRAME_MAX_DIMENSION * 9 / 16) };
  }
  const scale = Math.min(1, Math.max(320, Math.min(DEFAULT_OCR_FRAME_MAX_DIMENSION, Number(maxDimension) || DEFAULT_OCR_FRAME_MAX_DIMENSION)) / Math.max(sourceWidth, sourceHeight));
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}

function hasUnsafeValue(value) {
  const serialized = JSON.stringify(value || {});
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i.test(serialized);
}

function deterministicFallback(input = {}) {
  return validateScoreboardOcrOutput({
    ...deterministicScoreboardOcr(input),
    providerMode: "deterministic-scoreboard-ocr",
    fallbackUsed: true,
  }, input.metadata || {});
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
    { id: "scorebug_broadcast_compact", x: width * 0.035, y: height * 0.035, width: width * 0.40, height: height * 0.095, anchor: "scorebug_top_left" },
    { id: "scorebug_left_compact", x: width * 0.01, y: height * 0.01, width: width * 0.26, height: height * 0.11, anchor: "top_left" },
    { id: "scoreboard_top_left", x: width * 0.01, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_left" },
    { id: "scoreboard_top_center", x: width * 0.28, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_center" },
    { id: "scoreboard_top_right", x: width * 0.55, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_right" },
    { id: "broadcast_top_band", x: width * 0.01, y: height * 0.005, width: width * 0.98, height: height * 0.18, anchor: "top_band" },
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

function normalizeOcrSamplingWindow(candidate = {}, metadata = {}) {
  const duration = seconds(metadata.durationSeconds, 0);
  const center = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
  if (!Number.isFinite(center)) return null;
  const boundedCenter = round(clamp(center, 0, duration || center));
  const start = round(clamp(candidate.start ?? boundedCenter - 1.2, 0, duration || boundedCenter + 1.2));
  const end = round(clamp(candidate.end ?? boundedCenter + 1.2, Math.min(duration || boundedCenter + 1.2, start + 0.4), duration || boundedCenter + 1.2));
  return {
    timestamp: boundedCenter,
    start,
    end,
    confidence: round(clamp(candidate.confidence ?? 0.55, 0.05, 0.98)),
    source: sanitizeText(candidate.source || "scoreboard_ocr_sample", 48),
    visualHints: Array.isArray(candidate.visualHints)
      ? candidate.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
      : [],
  };
}

function pushSamplingTime(windows, time, metadata = {}, input = {}) {
  const window = normalizeOcrSamplingWindow({
    timestamp: time,
    start: input.start,
    end: input.end,
    confidence: input.confidence,
    source: input.source,
    visualHints: input.visualHints,
  }, metadata);
  if (window) windows.push(window);
}

function mediaSignalTimes(mediaSignals = {}) {
  const times = [];
  for (const peak of Array.isArray(mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : []) {
    const time = seconds(peak.time ?? peak.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(peak.energyScore ?? peak.confidence ?? 0) >= 0.62) {
      times.push({ time, confidence: Number(peak.energyScore ?? peak.confidence), source: "audio_peak" });
    }
  }
  for (const change of Array.isArray(mediaSignals.sceneChanges) ? mediaSignals.sceneChanges : []) {
    const time = seconds(change.time ?? change.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(change.confidence ?? 0) >= 0.55) {
      times.push({ time, confidence: Number(change.confidence), source: "scene_change" });
    }
  }
  for (const motion of Array.isArray(mediaSignals.highMotionCandidates) ? mediaSignals.highMotionCandidates : []) {
    const time = seconds(motion.time ?? motion.center ?? motion.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(motion.confidence ?? motion.score ?? 0) >= 0.5) {
      times.push({ time, confidence: Number(motion.confidence ?? motion.score), source: "high_motion" });
    }
  }
  return times;
}

function selectOcrSamplingWindows({ frames = [], visualSignals = {}, candidateWindows = [], mediaSignals = {}, metadata = {} } = {}) {
  const duration = seconds(metadata.durationSeconds, 0);
  const windows = [];
  if (duration > 0) {
    const periodicCount = duration >= 120 ? 18 : Math.min(8, MAX_SCOREBOARD_OCR_FRAMES);
    for (let index = 0; index < periodicCount; index += 1) {
      const ratio = (index + 0.5) / periodicCount;
      pushSamplingTime(windows, duration * ratio, metadata, {
        confidence: 0.52,
        source: "full_source_periodic_scoreboard_sample",
      });
    }
  }
  for (const frame of Array.isArray(frames) ? frames : []) {
    const timestamp = frameTimestamp(frame);
    if (!Number.isFinite(timestamp)) continue;
    pushSamplingTime(windows, timestamp, metadata, {
      start: frame.windowStart,
      end: frame.windowEnd,
      confidence: Number(frame.confidence || 0.58),
      source: "existing_frame_scoreboard_sample",
      visualHints: frame.visualHints,
    });
  }
  const visualWindows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  for (const window of visualWindows.filter(importantVisualWindow)) {
    const center = visualWindowCenter(window);
    for (const offset of [-3, 0, 5, 12]) {
      pushSamplingTime(windows, center + offset, metadata, {
        start: seconds(window.start, center) + offset,
        end: seconds(window.end, center) + offset,
        confidence: Number(window.confidence || 0.7),
        source: "visual_decision_scoreboard_sample",
        visualHints: visualReasonCodesForWindow(window).slice(0, 4),
      });
    }
  }
  for (const candidate of Array.isArray(candidateWindows) ? candidateWindows : []) {
    const time = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
    if (!Number.isFinite(time) || Number(candidate.confidence || 0) < 0.55) continue;
    for (const offset of [0, 8]) {
      pushSamplingTime(windows, time + offset, metadata, {
        confidence: Number(candidate.confidence),
        source: "candidate_scoreboard_sample",
        visualHints: candidate.visualHints,
      });
    }
  }
  for (const signal of mediaSignalTimes(mediaSignals)) {
    for (const offset of [0, 8]) {
      pushSamplingTime(windows, signal.time + offset, metadata, {
        confidence: signal.confidence,
        source: `${signal.source}_scoreboard_sample`,
      });
    }
  }

  const selected = [];
  const sorted = windows
    .filter((window) => Number.isFinite(window.timestamp))
    .sort((a, b) => b.confidence - a.confidence || a.timestamp - b.timestamp);
  const minGap = duration >= 120 ? Math.max(5, duration / MAX_SCOREBOARD_OCR_FRAMES * 0.45) : 2;
  const takeWindow = (window, gap) => {
    if (selected.length >= MAX_SCOREBOARD_OCR_FRAMES) return;
    if (selected.some((item) => Math.abs(item.timestamp - window.timestamp) < gap)) return;
    selected.push(window);
  };
  for (const window of windows.filter((item) => item.source === "full_source_periodic_scoreboard_sample")) {
    takeWindow(window, minGap);
  }
  for (const window of sorted) takeWindow(window, Math.min(3, minGap));
  return selected.sort((a, b) => a.timestamp - b.timestamp);
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

function normalizeQaReportSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  return {
    enabled: Boolean(value.enabled),
    runId: sanitizeText(value.runId || "", 120) || null,
    status: sanitizeText(value.status || "unknown", 40),
    reportPath: value.reportPath ? sanitizeText(value.reportPath, 180) : null,
    latestPath: value.latestPath ? sanitizeText(value.latestPath, 180) : null,
    contactSheetPath: value.contactSheetPath ? sanitizeText(value.contactSheetPath, 180) : null,
    reviewPath: value.reviewPath ? sanitizeText(value.reviewPath, 180) : null,
    cropCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_QA_ATTEMPTS, Math.round(Number(value.cropCount || 0)))),
    attemptCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_QA_ATTEMPTS, Math.round(Number(value.attemptCount || 0)))),
  };
}

function summarizeDigitReaderRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const statuses = safeRows.reduce((acc, row) => {
    const status = sanitizeText(row.digitReaderStatus || "unreadable", 32);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    readableCount: Number(statuses.readable || 0),
    ambiguousCount: Number(statuses.ambiguous || 0),
    unreadableCount: Number(statuses.unreadable || 0),
    digitBoxCount: safeRows.reduce((sum, row) => sum + Math.max(0, Number(row.digitBoxCount || 0)), 0),
    failClosedReasons: [...new Set(safeRows
      .flatMap((row) => Array.isArray(row.digitReaderReasons) ? row.digitReaderReasons : [])
      .map((reason) => sanitizeText(reason, 60))
      .filter(Boolean))]
      .slice(0, 12),
  };
}

function validateScoreboardOcrOutput(output = {}, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const evidence = normalizeOcrEvidence(output.evidence || output.scoreboardOcr || output.ocrEvidence, metadata);
  const sampledFrameCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(output.sampledFrameCount || 0))));
  const regionCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES * MAX_SCOREBOARD_REGIONS, Math.round(Number(output.regionCount || 0))));
  const regionIdsUsed = Array.isArray(output.regionIdsUsed)
    ? output.regionIdsUsed.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, MAX_SCOREBOARD_REGIONS)
    : [];
  const scoreTimeline = evidence
    .filter((item) => item.scoreBefore || item.scoreAfter || item.status === "clock_only")
    .map((item) => ({
      timestamp: round(item.timestamp),
      status: sanitizeText(item.status || "unknown", 40),
      scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
      scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
      temporalConsistency: Boolean(item.temporalConsistency),
    }))
    .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
  const qaReport = normalizeQaReportSummary(output.qaReport);
  return {
    providerMode: sanitizeText(output.providerMode || "deterministic-scoreboard-ocr", 60),
    fallbackUsed: Boolean(output.fallbackUsed || evidence.length === 0),
    confidence: round(clamp(output.confidence ?? (evidence.length ? Math.max(...evidence.map((item) => item.confidence)) : 0), 0, 1)),
    evidence,
    qaReport,
    summary: {
      evidenceCount: evidence.length,
      scoreChangeCount: evidence.filter((item) => item.scoreChanged).length,
      scoreUnchangedCount: evidence.filter((item) => item.scoreUnchanged).length,
      scoreRevertedCount: evidence.filter((item) => item.scoreReverted).length,
      ambiguousCount: evidence.filter((item) => item.ambiguous).length,
      clockOnlyCount: evidence.filter((item) => item.status === "clock_only").length,
      unreadableCount: evidence.filter((item) => item.status === "unreadable").length,
      sampledFrameCount,
      regionCount,
      regionIdsUsed,
      preprocessingVariantCount: Math.max(0, Math.min(8, Math.round(Number(output.preprocessingVariantCount || 0)))),
      scoreTimeline,
      qaReport,
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
      localOcrEnabled: false,
      runtimeAvailable: false,
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
      return deterministicFallback(input);
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
      return deterministicFallback(input);
    }
  }
}

function safeFilePart(value, fallback = "item") {
  return sanitizeText(value || fallback, 80).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || fallback;
}

function boolFromInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function rootRelative(filePath) {
  const target = resolve(filePath);
  const fromRoot = relative(ROOT_DIR, target).replace(/\\/g, "/");
  if (!fromRoot || fromRoot.startsWith("../") || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return fromRoot;
}

function safeQaRunId(value = randomUUID()) {
  const raw = sanitizeText(value || randomUUID(), 96).replace(/[^A-Za-z0-9._-]/g, "_");
  const id = raw.startsWith("ocr-scoreboard-") ? raw : `ocr-scoreboard-${raw}`;
  if (!/^ocr-scoreboard-[A-Za-z0-9._-]{1,96}$/.test(id) || id.includes("..")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return id.slice(0, 112);
}

function safeResolveRootRelative(relativePath) {
  const safeRelative = String(relativePath || "").replace(/\\/g, "/");
  if (!safeRelative || safeRelative.includes("..") || safeRelative.startsWith("/") || safeRelative.includes("\u0000")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const target = resolve(ROOT_DIR, safeRelative);
  if (rootRelative(target) !== safeRelative) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return target;
}

function qaRetentionMax(value = CONFIG.scoreboardOcr.qaArtifactRetention) {
  const parsed = Math.round(Number(value || DEFAULT_SCOREBOARD_OCR_QA_RETENTION));
  return Math.max(1, Math.min(50, Number.isFinite(parsed) ? parsed : DEFAULT_SCOREBOARD_OCR_QA_RETENTION));
}

function scoreboardOcrQaEnabled(input = {}) {
  return boolFromInput(input.qaArtifactsEnabled, CONFIG.scoreboardOcr.qaArtifactsEnabled);
}

function createScoreboardOcrQaContext(input = {}) {
  const enabled = scoreboardOcrQaEnabled(input);
  const runId = safeQaRunId(input.qaRunId || randomUUID());
  const directory = `${SCOREBOARD_OCR_QA_RELATIVE_DIR}/${runId}`;
  if (!enabled) {
    return {
      enabled: false,
      runId,
      directory,
      attempts: [],
      files: [],
      contactSheetRows: [],
    };
  }
  const runDir = safeResolveRootRelative(directory);
  mkdirSync(runDir, { recursive: true });
  return {
    enabled: true,
    runId,
    directory,
    runDir,
    attempts: [],
    files: [],
    contactSheetRows: [],
  };
}

function cleanupScoreboardOcrQaArtifacts({ currentRunId, retentionMax = DEFAULT_SCOREBOARD_OCR_QA_RETENTION } = {}) {
  const root = safeResolveRootRelative(SCOREBOARD_OCR_QA_RELATIVE_DIR);
  if (!existsSync(root)) return { retentionMax: qaRetentionMax(retentionMax), removedCount: 0, removed: [] };
  const keep = new Set(currentRunId ? [safeQaRunId(currentRunId)] : []);
  const managed = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ocr-scoreboard-[A-Za-z0-9._-]+$/.test(entry.name) && !entry.name.includes(".."))
    .map((entry) => {
      const dir = resolve(root, entry.name);
      return { name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of managed) {
    if (keep.size >= qaRetentionMax(retentionMax)) break;
    keep.add(entry.name);
  }
  const removed = [];
  for (const entry of managed) {
    if (keep.has(entry.name)) continue;
    rmSync(entry.dir, { recursive: true, force: true });
    removed.push(`${SCOREBOARD_OCR_QA_RELATIVE_DIR}/${entry.name}`);
  }
  return {
    retentionMax: qaRetentionMax(retentionMax),
    removedCount: removed.length,
    removed,
  };
}

function safeOcrTextPreview(value) {
  return sanitizeText(value || "", 120);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function qaCropFileName({ attemptIndex, frameIndex, regionId, variantId }) {
  return `ocr-attempt-${String(attemptIndex + 1).padStart(2, "0")}-frame-${String(frameIndex + 1).padStart(2, "0")}-${safeFilePart(regionId, "region")}-${safeFilePart(variantId, "variant")}.png`;
}

function recordScoreboardOcrQaAttempt({
  qa,
  cropPath,
  frame = {},
  frameIndex = 0,
  region = {},
  variant = {},
  ocr = {},
  reader = {},
  digitReading = null,
} = {}) {
  if (!qa || !qa.enabled) return;
  if (qa.attempts.length >= MAX_SCOREBOARD_OCR_QA_ATTEMPTS) return;
  const attemptIndex = qa.attempts.length;
  let cropRef = null;
  let sizeBytes = 0;
  if (cropPath && existsSync(cropPath)) {
    const cropStat = statSync(cropPath);
    if (cropStat.isFile() && cropStat.size <= MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES) {
      const fileName = qaCropFileName({
        attemptIndex,
        frameIndex,
        regionId: region.id,
        variantId: variant.id,
      });
      const targetPath = safeResolveRootRelative(`${qa.directory}/${fileName}`);
      copyFileSync(cropPath, targetPath);
      cropRef = rootRelative(targetPath);
      sizeBytes = statSync(targetPath).size;
      qa.files.push({
        id: `scoreboard_ocr_crop_${attemptIndex + 1}`,
        timestamp: round(frame.timestamp),
        regionId: sanitizeText(region.id || "scoreboard_region", 80),
        preprocessingVariant: sanitizeText(variant.id || "default", 60),
        width: Math.max(1, Math.round(Number(region.width || 0))),
        height: Math.max(1, Math.round(Number(region.height || 0))),
        sizeBytes,
        relativePath: cropRef,
      });
    }
  }
  const row = {
    index: attemptIndex + 1,
    timestamp: round(frame.timestamp),
    regionId: sanitizeText(region.id || "scoreboard_region", 80),
    preprocessingVariant: sanitizeText(variant.id || "default", 60),
    status: sanitizeText(reader.status || "unreadable", 40),
    score: reader.scoreText || null,
    clock: reader.clock || null,
    confidence: round(ocr.confidence || reader.confidence || 0),
    ...digitReaderSummary(digitReading || {}),
    ambiguityReasons: Array.isArray(reader.ambiguityReasons)
      ? reader.ambiguityReasons.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 6)
      : [],
    ocrText: safeOcrTextPreview(ocr.text),
    cropRef,
  };
  qa.attempts.push(row);
  qa.contactSheetRows.push(row);
}

function safeScoreboardOcrQaReport(report = {}) {
  const serialized = JSON.stringify(report || {});
  if (/\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i.test(serialized)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return report;
}

function writeScoreboardOcrReviewHtml({ qa, reportRelativePath, contactSheetRelativePath, status = "completed" } = {}) {
  if (!qa || !qa.enabled) return null;
  const reviewRelativePath = `${qa.directory}/review.html`;
  const rows = qa.contactSheetRows.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS).map((row) => `
      <tr>
        <td>${escapeHtml(row.index)}</td>
        <td>${escapeHtml(row.timestamp)}</td>
        <td>${escapeHtml(row.regionId)}</td>
        <td>${escapeHtml(row.preprocessingVariant)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.score || "")}</td>
        <td>${escapeHtml(row.clock || "")}</td>
        <td>${escapeHtml(row.confidence)}</td>
        <td>${escapeHtml(row.digitReaderStatus || "")}</td>
        <td>${escapeHtml(row.digitBoxCount || 0)}</td>
        <td>${escapeHtml(row.scoreConfidence || 0)}</td>
        <td>${escapeHtml((row.digitReaderReasons || []).join(", "))}</td>
        <td>${escapeHtml((row.ambiguityReasons || []).join(", "))}</td>
        <td>${escapeHtml(row.ocrText || "")}</td>
        <td>${row.cropRef ? `<img alt="crop ${escapeHtml(row.index)}" src="${escapeHtml(relative(qa.directory, row.cropRef).replace(/\\/g, "/"))}">` : ""}</td>
      </tr>`).join("");
  const html = safeScoreboardOcrQaReport(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scoreboard OCR QA Review</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #151515; background: #f7f7f4; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #d8d8d2; padding: 6px; font-size: 12px; vertical-align: top; }
    th { background: #ecece4; text-align: left; position: sticky; top: 0; }
    img { max-width: 280px; max-height: 90px; object-fit: contain; display: block; }
    code { background: #ecece4; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Scoreboard OCR QA Review</h1>
  <p>Status: <code>${escapeHtml(status)}</code> | Run: <code>${escapeHtml(qa.runId)}</code></p>
  <p>JSON report: <code>${escapeHtml(reportRelativePath)}</code> | Contact sheet: <code>${escapeHtml(contactSheetRelativePath)}</code></p>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Time</th><th>Region</th><th>Variant</th><th>Status</th><th>Score</th><th>Clock</th><th>Conf</th><th>Digit Status</th><th>Digit Boxes</th><th>Score Conf</th><th>Digit Reasons</th><th>Reasons</th><th>OCR Text</th><th>Crop</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`);
  writeFileSync(safeResolveRootRelative(reviewRelativePath), html, "utf8");
  return reviewRelativePath;
}

function writeScoreboardOcrQaReport({ qa, scoreboardOcr, status = "completed" } = {}) {
  if (!qa || !qa.enabled) return null;
  const generatedAt = new Date().toISOString();
  const contactSheetRelativePath = `${qa.directory}/contact-sheet.json`;
  const reportRelativePath = `demo/results/ocr-scoreboard-qa-${generatedAt.replace(/[:.]/g, "-")}.json`;
  const latestRelativePath = SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH;
  const cleanup = cleanupScoreboardOcrQaArtifacts({
    currentRunId: qa.runId,
    retentionMax: qaRetentionMax(CONFIG.scoreboardOcr.qaArtifactRetention),
  });
  const digitReader = summarizeDigitReaderRows(qa.contactSheetRows);
  const contactSheet = safeScoreboardOcrQaReport({
    schemaVersion: 1,
    kind: "scoreboard-ocr-contact-sheet",
    generatedAt,
    runId: qa.runId,
    rowCount: qa.contactSheetRows.length,
    rows: qa.contactSheetRows.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    relativeRefsOnly: true,
  });
  writeFileSync(safeResolveRootRelative(contactSheetRelativePath), `${JSON.stringify(contactSheet, null, 2)}\n`, "utf8");
  const reviewRelativePath = writeScoreboardOcrReviewHtml({
    qa,
    reportRelativePath,
    contactSheetRelativePath,
    status,
  });
  const report = safeScoreboardOcrQaReport({
    schemaVersion: 1,
    kind: "scoreboard-ocr-qa-report",
    generatedAt,
    status: sanitizeText(status, 40),
    runId: qa.runId,
    directory: qa.directory,
    contactSheet: {
      relativePath: contactSheetRelativePath,
      rowCount: contactSheet.rowCount,
    },
    review: reviewRelativePath
      ? {
          relativePath: reviewRelativePath,
          rowCount: contactSheet.rowCount,
        }
      : null,
    cropArtifacts: {
      enabled: true,
      cropCount: qa.files.length,
      maxCropCount: MAX_SCOREBOARD_OCR_QA_ATTEMPTS,
      maxArtifactBytes: MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES,
      files: qa.files.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    },
    ocrAttempts: qa.attempts.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    digitReader,
    calibrationUsed: qa.digitCalibrationSummary || null,
    evidenceSummary: scoreboardOcr && scoreboardOcr.summary
      ? {
          evidenceCount: Number(scoreboardOcr.summary.evidenceCount || 0),
          scoreChangeCount: Number(scoreboardOcr.summary.scoreChangeCount || 0),
          scoreChangeEvents: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.filter((item) => item.status === "score_changed").slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          revertedScoreEvents: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.filter((item) => item.status === "goal_removed").slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          ambiguousCount: Number(scoreboardOcr.summary.ambiguousCount || 0),
          unreadableCount: Number(scoreboardOcr.summary.unreadableCount || 0),
          scoreTimeline: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
        }
      : null,
    cleanup,
    relativeRefsOnly: true,
    logsDownloaded: false,
    artifactsDownloaded: false,
  });
  const reportPath = safeResolveRootRelative(reportRelativePath);
  const latestPath = safeResolveRootRelative(latestRelativePath);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    enabled: true,
    runId: qa.runId,
    reportPath: reportRelativePath,
    latestPath: latestRelativePath,
    contactSheetPath: contactSheetRelativePath,
    reviewPath: reviewRelativePath,
    cropCount: qa.files.length,
    attemptCount: qa.attempts.length,
    status: report.status,
  };
}

function ocrCropOutputDir(input = {}) {
  if (input.ocrOutputDir) return assertStoragePath(input.ocrOutputDir, "staging");
  return storagePath("staging", join("scoreboard-ocr", `ocr_${randomUUID()}`));
}

function assertOcrFrame(frame = {}) {
  const timestamp = frameTimestamp(frame);
  if (!Number.isFinite(timestamp)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (!frame.localPath) return null;
  const localPath = assertStoragePath(frame.localPath, "staging");
  if (!existsSync(localPath)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return {
    ...frame,
    localPath,
    timestamp,
  };
}

function assertProcessingInputPath(inputPath) {
  try {
    return assertStoragePath(inputPath, "uploads");
  } catch {
    return assertStoragePath(inputPath, "staging");
  }
}

function ocrFramePath(outputDir, index) {
  return safeResolve(outputDir, `ocr_frame_${String(index + 1).padStart(2, "0")}.jpg`);
}

async function extractOcrFramesFromSource({
  inputPath,
  outputDir,
  metadata = {},
  frames = [],
  visualSignals = {},
  candidateWindows = [],
  mediaSignals = {},
  ffmpegRunner = runFfmpeg,
  signal = null,
} = {}) {
  if (!inputPath || !existsSync(inputPath)) return [];
  if (ffmpegRunner === runFfmpeg && !commandAvailable(CONFIG.ffmpegBin)) return [];
  const safeInputPath = assertProcessingInputPath(inputPath);
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  const windows = selectOcrSamplingWindows({ frames, visualSignals, candidateWindows, mediaSignals, metadata });
  if (!windows.length) return [];
  mkdirSync(safeOutputDir, { recursive: true });
  const dimensions = scaledOcrFrameDimensions(metadata);
  const extracted = [];
  for (const [index, window] of windows.entries()) {
    if (signal && signal.aborted) throw cancellationError();
    const localPath = ocrFramePath(safeOutputDir, index);
    await ffmpegRunner([
      "-y",
      "-ss",
      String(window.timestamp),
      "-i",
      safeInputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${dimensions.width}:${dimensions.height}`,
      "-q:v",
      "3",
      localPath,
    ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 30000) });
    if (!existsSync(localPath)) continue;
    extracted.push({
      id: `ocr_frame_${index + 1}`,
      timestamp: window.timestamp,
      windowStart: window.start,
      windowEnd: window.end,
      width: dimensions.width,
      height: dimensions.height,
      localPath,
      purpose: "scoreboard_ocr",
      source: window.source,
      visualHints: window.visualHints,
    });
  }
  return extracted.slice(0, MAX_SCOREBOARD_OCR_FRAMES);
}

function cropPathForRegion(outputDir, frameIndex, region) {
  const name = `crop_${String(frameIndex + 1).padStart(2, "0")}_${safeFilePart(region.id, "region")}.png`;
  return safeResolve(outputDir, name);
}

function scoreboardOcrPreprocessVariants() {
  return OCR_PREPROCESS_VARIANTS.map((variant) => ({
    id: sanitizeText(variant.id, 48),
    psm: sanitizeText(variant.psm || "7", 4),
    whitelist: sanitizeText(variant.whitelist || "", 120),
    filter: sanitizeText(variant.filter, 180),
  }));
}

async function cropScoreboardRegion({
  frame,
  region,
  outputDir,
  frameIndex = 0,
  variant = null,
  ffmpegRunner = runFfmpeg,
  signal = null,
} = {}) {
  const safeFrame = assertOcrFrame(frame);
  if (!safeFrame || !safeFrame.localPath) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  mkdirSync(safeOutputDir, { recursive: true });
  const cropPath = cropPathForRegion(safeOutputDir, frameIndex, region);
  await ffmpegRunner([
    "-y",
    "-i",
    safeFrame.localPath,
    "-vf",
    [`crop=${region.width}:${region.height}:${region.x}:${region.y}`, variant && variant.filter].filter(Boolean).join(","),
    "-frames:v",
    "1",
    cropPath,
  ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 20000) });
  if (!existsSync(cropPath)) {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  return cropPath;
}

function cleanupOcrCrops(outputDir) {
  if (!outputDir) return { cleaned: false };
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  if (!basename(safeOutputDir).startsWith("ocr_")) return { cleaned: false };
  try {
    rmSync(safeOutputDir, { recursive: true, force: true });
    return { cleaned: true };
  } catch {
    return { cleaned: false };
  }
}

class LocalScoreboardOcrProviderAdapter extends DeterministicScoreboardOcrProvider {
  constructor({
    enabled = CONFIG.scoreboardOcr.enabled,
    bin = CONFIG.scoreboardOcr.bin,
    timeoutMs = CONFIG.scoreboardOcr.timeoutMs,
    ocrAdapter = null,
    ocrRunner = null,
    commandChecker = null,
    cropper = null,
    ffmpegRunner = null,
    digitReader = null,
    digitCalibration = null,
  } = {}) {
    super();
    this.enabled = Boolean(enabled);
    this.timeoutMs = Math.max(250, Math.min(60000, Number(timeoutMs) || DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS));
    this.ocrAdapter = ocrAdapter || new LocalOcrCommandAdapter({
      bin,
      enabled: this.enabled,
      timeoutMs: this.timeoutMs,
      runner: ocrRunner,
      commandChecker,
    });
    this.cropperInjected = Boolean(cropper);
    this.cropper = cropper || cropScoreboardRegion;
    this.ffmpegRunner = ffmpegRunner || runFfmpeg;
    this.digitReader = digitReader || readScorebugDigits;
    this.digitCalibration = digitCalibration;
  }

  health() {
    const adapterHealth = this.ocrAdapter.health();
    return {
      ...super.health(),
      status: adapterHealth.status,
      providerMode: adapterHealth.providerMode,
      realOcrEnabled: this.enabled,
      localOcrEnabled: this.enabled,
      runtimeAvailable: Boolean(adapterHealth.runtimeAvailable),
      fallbackAvailable: true,
      networkRequired: false,
      commandConfigured: Boolean(adapterHealth.commandConfigured),
      capabilities: [
        "scoreboard_region_sampling",
        "full_source_periodic_sampling",
        "ocr_preprocessing_variants",
        "focused_scorebug_digit_reader",
        "local_command_ocr",
        "safe_empty_fallback",
      ],
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    if (input.signal && input.signal.aborted) throw cancellationError();
    if (!this.enabled || !this.ocrAdapter.runtimeAvailable()) return deterministicFallback(input);
    if (!this.cropperInjected && this.ffmpegRunner === runFfmpeg && !commandAvailable(CONFIG.ffmpegBin)) return deterministicFallback(input);

    const metadata = input.metadata || {};
    const outputDir = ocrCropOutputDir(input);
    const qa = createScoreboardOcrQaContext(input);
    const digitCalibration = validateScorebugCalibration(input.digitCalibration || input.scorebugDigitCalibration || this.digitCalibration);
    qa.digitCalibrationSummary = calibrationSummary(digitCalibration);
    let frames = [];
    try {
      frames = await extractOcrFramesFromSource({
        ...input,
        outputDir,
        ffmpegRunner: this.ffmpegRunner,
      });
      if (!frames.length) {
        frames = selectOcrFrames(input);
      }
      frames = frames
        .map((frame) => assertOcrFrame(frame))
        .filter((frame) => frame && frame.localPath)
        .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
    } catch {
      return deterministicFallback(input);
    }
    if (!frames.length) return deterministicFallback(input);

    const observations = [];
    let cropCount = 0;
    const regionIdsUsed = new Set();
    const variants = scoreboardOcrPreprocessVariants();
    try {
      const regionsByFrame = frames.map((frame) => regionHintsForFrame(frame, metadata).slice(0, MAX_SCOREBOARD_REGIONS));
      const frameScoreFound = new Set();
      for (const variant of variants) {
        for (let regionIndex = 0; regionIndex < MAX_SCOREBOARD_REGIONS; regionIndex += 1) {
          for (const [frameIndex, frame] of frames.entries()) {
            if (frameScoreFound.has(frameIndex)) continue;
            if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
            const region = regionsByFrame[frameIndex] && regionsByFrame[frameIndex][regionIndex];
            if (!region) continue;
            regionIdsUsed.add(region.id);
            if (input.signal && input.signal.aborted) throw cancellationError();
            const cropPath = await this.cropper({
              frame,
              region,
              outputDir,
              frameIndex,
              variant,
              ffmpegRunner: this.ffmpegRunner,
              signal: input.signal,
            });
            const safeCropPath = assertStoragePath(cropPath, "staging");
            const ocr = await raceWithTimeout(this.ocrAdapter.readTextFromImage({
              imagePath: safeCropPath,
              psm: variant.psm,
              whitelist: variant.whitelist,
              signal: input.signal,
              timeoutMs: this.timeoutMs,
            }), { signal: input.signal, timeoutMs: this.timeoutMs });
            const digitReading = this.digitReader({
              frame,
              crop: { timestamp: frame.timestamp },
              regionId: region.id,
              timestamp: frame.timestamp,
              metadata,
              calibration: digitCalibration,
              signal: input.signal,
            });
            const digitScore = digitReading.status === "readable" ? digitReading.score : null;
            const parsedScore = digitScore ||
              (ocr.rejected
                ? null
                : scoreAllowedForRegion({
                    regionId: region.id,
                    text: ocr.text,
                    score: parseScoreboardScore(ocr.text),
                  }));
            const parsedClock = ocr.rejected ? null : parseClock(ocr.text);
            const reader = readScoreboardCandidate({
              id: `ocr_${frameIndex + 1}_${cropCount + 1}`,
              timestamp: frame.timestamp,
              start: frame.windowStart ?? frame.timestamp - 0.8,
              end: frame.windowEnd ?? frame.timestamp + 0.8,
              regionId: region.id,
              preprocessingVariant: variant.id,
              source: `local_scoreboard_ocr_${variant.id}`,
              text: ocr.text,
              score: parsedScore,
              clock: parsedClock,
              rejected: ocr.rejected,
              confidence: digitScore ? digitReading.confidence : ocr.confidence,
            });
            if (digitScore) reader.source = `local_scorebug_digit_reader_${variant.id}`;
            observations.push({
              id: `ocr_${frameIndex + 1}_${cropCount + 1}`,
              timestamp: frame.timestamp,
              start: frame.windowStart ?? frame.timestamp - 0.8,
              end: frame.windowEnd ?? frame.timestamp + 0.8,
              regionId: region.id,
              preprocessingVariant: variant.id,
              text: ocr.text,
              score: digitScore,
              confidence: digitScore ? digitReading.confidence : ocr.confidence,
              rejected: ocr.rejected,
              source: digitScore ? `local_scorebug_digit_reader_${variant.id}` : `local_scoreboard_ocr_${variant.id}`,
            });
            recordScoreboardOcrQaAttempt({
              qa,
              cropPath: safeCropPath,
              frame,
              frameIndex,
              region,
              variant,
              ocr,
              reader,
              digitReading,
            });
            cropCount += 1;
            if (parsedScore) {
              frameScoreFound.add(frameIndex);
              break;
            }
          }
          if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
        }
        if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
      }
      const evidence = buildScoreboardEvidenceFromObservations(observations);
      const result = validateScoreboardOcrOutput({
        providerMode: "local-scoreboard-ocr-command",
        fallbackUsed: evidence.length === 0,
        evidence,
        sampledFrameCount: frames.length,
        regionCount: cropCount,
        regionIdsUsed: [...regionIdsUsed],
        preprocessingVariantCount: variants.length,
      }, metadata);
      const qaReport = writeScoreboardOcrQaReport({ qa, scoreboardOcr: result, status: "completed" });
      return qaReport
        ? validateScoreboardOcrOutput({
            providerMode: result.providerMode,
            fallbackUsed: result.fallbackUsed,
            evidence: result.evidence,
            sampledFrameCount: result.summary.sampledFrameCount,
            regionCount: result.summary.regionCount,
            regionIdsUsed: result.summary.regionIdsUsed,
            preprocessingVariantCount: result.summary.preprocessingVariantCount,
            qaReport,
          }, metadata)
        : result;
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      return deterministicFallback(input);
    } finally {
      cleanupOcrCrops(outputDir);
    }
  }
}

function createScoreboardOcrProvider(options = {}) {
  const { mode, client } = options;
  const safeMode = sanitizeText(mode || CONFIG.scoreboardOcr.provider || "", 80).toLowerCase();
  if (safeMode === "external" || safeMode === "external-scoreboard-ocr-adapter") {
    return new ExternalScoreboardOcrProviderAdapter({ client });
  }
  if (safeMode === "local" || safeMode === "local-scoreboard-ocr-command") {
    return new LocalScoreboardOcrProviderAdapter(options);
  }
  return new DeterministicScoreboardOcrProvider();
}

async function analyzeScoreboardOcr(input = {}) {
  const provider = input.provider || createScoreboardOcrProvider({
    ...input,
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
          scoreRevertedCount: Number(safe.summary.scoreRevertedCount || 0),
          ambiguousCount: Number(safe.summary.ambiguousCount || 0),
          clockOnlyCount: Number(safe.summary.clockOnlyCount || 0),
          unreadableCount: Number(safe.summary.unreadableCount || 0),
          sampledFrameCount: Number(safe.summary.sampledFrameCount || 0),
          regionCount: Number(safe.summary.regionCount || 0),
          regionIdsUsed: Array.isArray(safe.summary.regionIdsUsed)
            ? safe.summary.regionIdsUsed.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, MAX_SCOREBOARD_REGIONS)
            : [],
          preprocessingVariantCount: Number(safe.summary.preprocessingVariantCount || 0),
          qaReport: normalizeQaReportSummary(safe.summary.qaReport),
          scoreTimeline: Array.isArray(safe.summary.scoreTimeline)
            ? safe.summary.scoreTimeline.map((item) => ({
                timestamp: Number(item.timestamp || 0),
                status: sanitizeText(item.status || "unknown", 40),
                scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
                scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
                temporalConsistency: Boolean(item.temporalConsistency),
              })).slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          fallbackUsed: Boolean(safe.summary.fallbackUsed),
        }
      : null,
    qaReport: normalizeQaReportSummary(safe.qaReport),
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
          scoreReverted: Boolean(item.scoreReverted),
          clock: item.clock ? sanitizeText(item.clock, 16) : null,
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
  MAX_SCOREBOARD_OCR_CROPS,
  SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH,
  SCOREBOARD_OCR_QA_RELATIVE_DIR,
  DeterministicScoreboardOcrProvider,
  ExternalScoreboardOcrProviderAdapter,
  LocalScoreboardOcrProviderAdapter,
  analyzeScoreboardOcr,
  cleanupOcrCrops,
  cropScoreboardRegion,
  createScoreboardOcrProvider,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  extractOcrFramesFromSource,
  normalizeRegion,
  publicScoreboardOcr,
  scoreboardOcrHealth,
  scoreboardOcrPreprocessVariants,
  selectOcrFrames,
  selectOcrSamplingWindows,
  validateScoreboardOcrOutput,
  writeScoreboardOcrQaReport,
};
