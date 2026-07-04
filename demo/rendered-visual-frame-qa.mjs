import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { commandAvailable } = require("../server/media.cjs");

const VISUAL_FRAME_QA_SCHEMA_VERSION = 1;
const DEFAULT_MAX_SAMPLES = 5;
const DEFAULT_FRAME_TIMEOUT_MS = 5000;
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|api[_-]?key|token|secret|stderr|stdout|raw(?:Log|Error|Output)?|cookie/i;

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : null;
}

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function safeString(value, maxLength = 100) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || SENSITIVE_RE.test(text)) return null;
  return text;
}

function safeList(values = [], maxItems = 12, maxLength = 80) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function safeRelativeMp4Ref(rootDir, candidate, allowedPrefix = "manual-downloads/") {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !text.startsWith(allowedPrefix) ||
    extname(text).toLowerCase() !== ".mp4" ||
    SENSITIVE_RE.test(text)
  ) {
    return { ok: false, code: "VISUAL_FRAME_QA_OUTPUT_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  const resolvedRoot = resolve(rootDir || process.cwd());
  const resolvedFile = resolve(resolvedRoot, text);
  if (!isInside(resolvedRoot, resolvedFile)) {
    return { ok: false, code: "VISUAL_FRAME_QA_OUTPUT_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  return { ok: true, code: null, relativePath: text, resolvedFile };
}

function sampleTimestamps(ffprobe = {}, maxSamples = DEFAULT_MAX_SAMPLES) {
  const duration = Number(ffprobe.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const safeDuration = Math.max(0.5, duration);
  const candidates = [
    Math.min(0.5, safeDuration * 0.1),
    Math.min(1.75, Math.max(0.35, safeDuration * 0.2)),
    safeDuration * 0.42,
    safeDuration * 0.68,
    Math.max(0.1, safeDuration - 0.5),
  ];
  return [...new Set(candidates
    .map((value) => Math.max(0, Math.min(safeDuration - 0.05, value)))
    .map((value) => Number(value.toFixed(2))))]
    .slice(0, Math.max(1, Math.min(DEFAULT_MAX_SAMPLES, Number(maxSamples) || DEFAULT_MAX_SAMPLES)));
}

function defaultFrameSampler({ resolvedFile, timestamp, ffmpegBin = "ffmpeg", timeoutMs = DEFAULT_FRAME_TIMEOUT_MS }) {
  if (!commandAvailable(ffmpegBin)) {
    return { decoded: false, status: "failed", code: "FFMPEG_UNAVAILABLE" };
  }
  const result = spawnSync(
    ffmpegBin,
    [
      "-hide_banner",
      "-v",
      "error",
      "-ss",
      String(timestamp),
      "-i",
      resolvedFile,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: timeoutMs,
    },
  );
  if (result.error && result.error.name === "Error" && result.error.code === "ETIMEDOUT") {
    return { decoded: false, status: "failed", code: "FRAME_SAMPLE_TIMEOUT" };
  }
  if (result.signal) {
    return { decoded: false, status: "failed", code: result.signal === "SIGTERM" ? "FRAME_SAMPLE_TIMEOUT" : "FRAME_SAMPLE_FAILED" };
  }
  if (result.status !== 0) {
    return { decoded: false, status: "failed", code: "FRAME_SAMPLE_DECODE_FAILED" };
  }
  return { decoded: true, status: "passed", code: null };
}

function firstTextZone(renderPlan = {}) {
  const zones = Array.isArray(renderPlan?.cropPlan?.textSafeZones) ? renderPlan.cropPlan.textSafeZones : [];
  const zone = zones[0] || null;
  if (!zone || typeof zone !== "object" || Array.isArray(zone)) return null;
  return {
    name: safeString(zone.name || "text_zone", 60) || "text_zone",
    x: safeNumber(zone.x),
    y: safeNumber(zone.y),
    width: safeNumber(zone.width),
    height: safeNumber(zone.height),
  };
}

function actionCenter(renderPlan = {}) {
  const crop = renderPlan && typeof renderPlan.cropPlan === "object" ? renderPlan.cropPlan : {};
  const x = safeNumber(crop.actionCenterX);
  const y = safeNumber(crop.actionCenterY);
  if (x === null || y === null) return null;
  return { x, y };
}

function failedReasonsFor({ ref, exists, ffprobe, frameResults, framing, renderedSocialPolishQA }) {
  const failedFrameReasons = frameResults
    .filter((frame) => frame.decoded !== true)
    .map((frame) => frame.code || "FRAME_SAMPLE_FAILED");
  return safeList([
    ...(!ref.ok ? [ref.code] : []),
    ...(ref.relativePath && /latest|cached|previous/i.test(ref.relativePath) ? ["output_mp4_reference_not_unique"] : []),
    ...(ref.ok && !exists ? ["output_mp4_missing"] : []),
    ...(ffprobe?.status !== "passed" ? ["ffprobe_not_passed"] : []),
    ...(!frameResults.length ? ["visual_frame_samples_missing"] : []),
    ...failedFrameReasons,
    ...(renderedSocialPolishQA?.passed !== true ? ["rendered_social_polish_not_passed"] : []),
    ...(framing?.passed !== true ? ["rendered_action_framing_not_passed"] : []),
    ...(framing?.textObstructionRisk ? ["caption_text_obstruction_risk"] : []),
    ...(framing?.abruptCropPanRisk ? ["abrupt_crop_pan_risk"] : []),
    ...(Number(framing?.actionSafeZoneCoverage) !== 1 ? ["action_safe_zone_not_contained"] : []),
  ], 16, 90);
}

function analyzeRenderedVisualFrameQA({
  rootDir = process.cwd(),
  outputMp4 = null,
  ffprobe = null,
  renderPlan = null,
  renderedSocialPolishQA = null,
  frameSampler = defaultFrameSampler,
  ffmpegBin = "ffmpeg",
  maxSamples = DEFAULT_MAX_SAMPLES,
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
} = {}) {
  const ref = safeRelativeMp4Ref(rootDir, outputMp4 && outputMp4.relativePath);
  const exists = Boolean(ref.ok && existsSync(ref.resolvedFile));
  const timestamps = ref.ok && exists ? sampleTimestamps(ffprobe, maxSamples) : [];
  const frames = timestamps.map((timestamp, index) => {
    let result = { decoded: false, status: "failed", code: "FRAME_SAMPLE_FAILED" };
    try {
      result = frameSampler({
        resolvedFile: ref.resolvedFile,
        relativePath: ref.relativePath,
        timestamp,
        ffmpegBin,
        timeoutMs: frameTimeoutMs,
      }) || result;
    } catch {
      result = { decoded: false, status: "failed", code: "FRAME_SAMPLE_FAILED" };
    }
    return {
      index: index + 1,
      timestamp,
      status: result.decoded === true ? "passed" : "failed",
      decoded: result.decoded === true,
      code: safeString(result.code, 80),
    };
  });
  const framing = renderedSocialPolishQA?.renderedActionFraming || {};
  const failedReasons = failedReasonsFor({ ref, exists, ffprobe, frameResults: frames, framing, renderedSocialPolishQA });
  return {
    schemaVersion: VISUAL_FRAME_QA_SCHEMA_VERSION,
    status: failedReasons.length ? "failed" : "passed",
    passed: failedReasons.length === 0,
    outputRelativePath: ref.ok ? ref.relativePath : null,
    sampledFrameCount: frames.length,
    decodedFrameCount: frames.filter((frame) => frame.decoded).length,
    frameTimestamps: frames.map((frame) => frame.timestamp),
    frames,
    cropSafetyVerdict: framing?.passed === true ? "passed" : "failed",
    cropMode: safeString(framing?.cropMode, 50),
    trackingProviderMode: safeString(framing?.trackingProviderMode, 80),
    trackingConfidence: round(framing?.trackingConfidence),
    fallbackUsed: typeof framing?.fallbackUsed === "boolean" ? framing.fallbackUsed : null,
    visibleActionCenter: actionCenter(renderPlan),
    captionBoxPosition: firstTextZone(renderPlan),
    ballPlayerVisibilityEstimate: framing?.ballPlayerVisibilityScore == null ? null : round(framing.ballPlayerVisibilityScore),
    actionSafeZoneCoverage: round(framing?.actionSafeZoneCoverage),
    obstructionRisk: Boolean(framing?.textObstructionRisk || renderedSocialPolishQA?.dynamicCaptions?.textObstructionRisk),
    abruptCropPanRisk: Boolean(framing?.abruptCropPanRisk),
    failedFrameReasons: failedReasons,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

export {
  VISUAL_FRAME_QA_SCHEMA_VERSION,
  analyzeRenderedVisualFrameQA,
  defaultFrameSampler,
  sampleTimestamps,
  safeRelativeMp4Ref,
};
