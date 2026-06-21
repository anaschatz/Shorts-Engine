import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";

const require = createRequire(import.meta.url);
const { normalizeYouTubeUrl } = require("../server/youtube-ingest.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const YOUTUBE_SMOKE_FLAG = "SHORTSENGINE_YOUTUBE_SMOKE";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_JOB_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_JSON_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 80 * 1024 * 1024;
const DEFAULT_DOWNLOAD_ARTIFACT_DIR = "manual-downloads";
const SAVE_DOWNLOAD_FLAG = "SHORTSENGINE_YOUTUBE_SMOKE_SAVE_DOWNLOAD";
const SMOKE_NEXT_ACTIONS = {
  YOUTUBE_SMOKE_DISABLED: "set-SHORTSENGINE_YOUTUBE_SMOKE-1-for-manual-real-ingest-smoke",
  YOUTUBE_SMOKE_INGEST_DISABLED: "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1",
  YOUTUBE_SMOKE_URL_MISSING: "set-SHORTSENGINE_YOUTUBE_SMOKE_URL-to-an-authorized-video",
  YOUTUBE_SMOKE_URL_NOT_ALLOWED: "set-SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS-or-SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED-1",
  YOUTUBE_SMOKE_BASE_URL_INVALID: "set-SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL-to-http-or-https",
  YOUTUBE_SMOKE_HEALTH_NOT_READY: "start-ready-server-with-youtube-ingest-enabled-and-downloader-configured",
  YOUTUBE_SMOKE_HEALTH_SHAPE_INVALID: "fix-health-response-shape-before-running-smoke",
  YOUTUBE_SMOKE_FFMPEG_UNAVAILABLE: "install-ffmpeg-and-ffprobe-before-running-smoke",
  YOUTUBE_DOWNLOADER_MISSING: "install-configure-downloader-or-set-SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN",
  YOUTUBE_SMOKE_FETCH_FAILED: "start-server-or-check-SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL",
  YOUTUBE_SMOKE_REQUEST_TIMEOUT: "check-server-readiness-or-increase-smoke-timeout",
  YOUTUBE_SMOKE_TIMEOUT: "check-server-and-smoke-timeout-before-rerun",
  YOUTUBE_SMOKE_JOB_TIMEOUT: "inspect-job-progress-and-increase-job-timeout-only-if-expected",
  YOUTUBE_SMOKE_RENDER_PLAN_MISSING: "check-job-public-edit-plan-before-trusting-the-live-proof",
  YOUTUBE_SMOKE_RENDER_PLAN_NOT_MULTI_MOMENT: "fix-multi-moment-selection-before-comparing-reference-style-shorts",
  YOUTUBE_SMOKE_DOWNLOAD_NOT_MP4: "check-render-export-download-contract",
  YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID: "check-render-output-and-download-contract",
  YOUTUBE_SMOKE_REPORT_LEAK: "inspect-report-leak-guard-and-remove-sensitive-output",
  YOUTUBE_SMOKE_RESPONSE_LEAK: "remove-sensitive-fields-from-public-api-response",
};

class YouTubeSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "YouTubeSmokeError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new YouTubeSmokeError(code, "YouTube smoke numeric configuration is out of bounds.");
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function classifyHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return "private";
  return "remote";
}

function configuredBaseUrl(env) {
  return String(
    rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL") ||
      rawValue(env, "SHORTSENGINE_STAGING_URL") ||
      `http://127.0.0.1:${rawValue(env, "PORT") || "4175"}`,
  ).trim();
}

function validateBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_BASE_URL_INVALID", "YouTube smoke base URL is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_BASE_URL_INVALID", "YouTube smoke base URL is invalid.");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function endpointUrl(baseUrl, apiEndpoint) {
  const parsed = new URL(baseUrl);
  const mount = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${mount}${apiEndpoint}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function safeTargetSummary(baseUrl) {
  const parsed = new URL(baseUrl);
  return {
    configured: true,
    protocol: parsed.protocol.replace(":", ""),
    hostType: classifyHost(parsed.hostname),
    mount: parsed.pathname && parsed.pathname !== "/" ? "custom" : "root",
  };
}

function allowedVideoIds(env) {
  return new Set(
    String(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS") || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function assertSmokeSourceAllowed(source, env) {
  if (boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED"))) return;
  if (allowedVideoIds(env).has(source.videoId)) return;
  throw new YouTubeSmokeError(
    "YOUTUBE_SMOKE_URL_NOT_ALLOWED",
    "YouTube smoke URL must be allowlisted or explicitly marked as a manual unlisted smoke target.",
    { nextAction: "set-SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS-or-SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED-1" },
  );
}

function validateSmokeSource(env) {
  const url = String(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_URL") || "").trim();
  if (!url) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_URL_MISSING", "YouTube smoke URL is required.");
  }
  const source = normalizeYouTubeUrl(url);
  assertSmokeSourceAllowed(source, env);
  return {
    sourceType: "youtube",
    kind: source.kind,
    videoId: source.videoId,
    canonicalUrl: source.canonicalUrl,
  };
}

function nextActionForCode(code) {
  return SMOKE_NEXT_ACTIONS[code] || "inspect-youtube-smoke-configuration";
}

async function readBoundedResponseBuffer(response, maxBytes, code) {
  const declaredLength = response.headers && typeof response.headers.get === "function"
    ? Number(response.headers.get("content-length"))
    : null;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new YouTubeSmokeError(code, "YouTube smoke response is too large.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new YouTubeSmokeError(code, "YouTube smoke response is too large.");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new YouTubeSmokeError(code, "YouTube smoke response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
      throw new YouTubeSmokeError(timeoutCode, "YouTube smoke request timed out.");
    }
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_FETCH_FAILED", "YouTube smoke request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    },
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    options.timeoutCode || "YOUTUBE_SMOKE_REQUEST_TIMEOUT",
  );
  if (!response || typeof response.status !== "number") {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_FETCH_INVALID", "YouTube smoke request returned an invalid response.");
  }
  const buffer = await readBoundedResponseBuffer(
    response,
    options.maxBytes || DEFAULT_JSON_RESPONSE_BYTES,
    "YOUTUBE_SMOKE_JSON_RESPONSE_TOO_LARGE",
  );
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_JSON_INVALID", "YouTube smoke response is not valid JSON.");
  }
  if (findSensitiveLeak(payload)) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_RESPONSE_LEAK", "YouTube smoke API response contains sensitive data.");
  }
  return {
    ok: response.ok && payload && payload.ok === true,
    status: response.status,
    requestId: response.headers?.get?.("x-request-id") || payload?.data?.requestId || null,
    payload,
  };
}

async function fetchDownload(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    { method: "GET", headers: { accept: "video/mp4" } },
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    "YOUTUBE_SMOKE_DOWNLOAD_TIMEOUT",
  );
  if (!response || typeof response.status !== "number") {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_DOWNLOAD_INVALID", "YouTube smoke download returned an invalid response.");
  }
  const buffer = await readBoundedResponseBuffer(
    response,
    options.maxBytes || DEFAULT_DOWNLOAD_MAX_BYTES,
    "YOUTUBE_SMOKE_DOWNLOAD_TOO_LARGE",
  );
  return {
    ok: response.ok,
    status: response.status,
    requestId: response.headers?.get?.("x-request-id") || null,
    contentType: response.headers?.get?.("content-type") || "",
    buffer,
  };
}

function assertApiOk(response, code, message) {
  if (response && response.ok === true && response.payload && response.payload.ok === true && response.payload.data) {
    return response.payload.data;
  }
  const apiCode = response?.payload?.error?.code;
  const nextAction = response?.payload?.error?.nextAction;
  throw new YouTubeSmokeError(apiCode || code, message, { httpStatus: response?.status || null, nextAction });
}

function assertId(value, prefix, code) {
  const text = String(value || "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(text)) {
    throw new YouTubeSmokeError(code, "YouTube smoke API response contains an invalid resource id.");
  }
  return text;
}

function validateHealthForSmoke(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_HEALTH_SHAPE_INVALID", "YouTube smoke health response shape is invalid.");
  }
  if (findSensitiveLeak(payload)) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_HEALTH_LEAK", "YouTube smoke health response contains sensitive data.");
  }
  const data = payload.data;
  const youtubeIngest = data.youtubeIngest || {};
  const ffmpegReady = Boolean(data.ffmpeg && data.ffmpeg.ffmpeg && data.ffmpeg.ffprobe);
  if (!ffmpegReady) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_FFMPEG_UNAVAILABLE", "YouTube smoke requires FFmpeg and FFprobe.");
  }
  if (!youtubeIngest.enabled) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_INGEST_DISABLED", "YouTube ingest must be enabled before running smoke.");
  }
  if (!youtubeIngest.downloaderConfigured || !youtubeIngest.ingestAvailable) {
    throw new YouTubeSmokeError("YOUTUBE_DOWNLOADER_MISSING", "YouTube smoke requires an available downloader.");
  }
  if (data.status !== "ready" || youtubeIngest.ready !== true) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_HEALTH_NOT_READY", "YouTube smoke requires ready health before ingest.");
  }
  return {
    status: data.status || null,
    ffmpeg: true,
    ffprobe: true,
    youtubeIngest: {
      enabled: true,
      downloaderConfigured: true,
      ingestAvailable: true,
      mode: youtubeIngest.mode || "local",
    },
    requestIdPresent: typeof data.requestId === "string" && data.requestId.length > 0,
  };
}

function validateSourceResponse(data, expected) {
  const source = data && data.source;
  if (!source || source.sourceType !== "youtube" || source.videoId !== expected.videoId) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_VALIDATE_RESPONSE_INVALID", "YouTube validation response is invalid.");
  }
  if (source.ingestAvailable !== true || source.downloaderConfigured !== true) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_VALIDATE_NOT_READY", "YouTube source validation is not ingest-ready.");
  }
  return {
    sourceType: "youtube",
    kind: source.kind || expected.kind,
    videoId: source.videoId,
    ingestAvailable: true,
  };
}

function validateIngestResponse(data, expected) {
  if (findSensitiveLeak(data)) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_INGEST_RESPONSE_LEAK", "YouTube ingest response contains sensitive data.");
  }
  const projectId = assertId(data?.project?.id, "prj", "YOUTUBE_SMOKE_INGEST_RESPONSE_INVALID");
  const uploadId = assertId(data?.upload?.id, "upl", "YOUTUBE_SMOKE_INGEST_RESPONSE_INVALID");
  const artifact = data?.upload?.artifact;
  const metadata = data?.upload?.metadata || {};
  const durationSeconds = Number(metadata.durationSeconds || data?.source?.durationSeconds);
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!artifact || artifact.type !== "upload" || artifact.status !== "available") {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_ARTIFACT_RESPONSE_INVALID", "YouTube ingest artifact public record is invalid.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_DURATION_MISSING", "YouTube ingest response is missing media duration metadata.");
  }
  if (data?.source?.sourceType !== "youtube" || data?.source?.videoId !== expected.videoId) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_SOURCE_RESPONSE_INVALID", "YouTube ingest source summary is invalid.");
  }
  return {
    projectId,
    uploadId,
    artifactId: artifact.id || uploadId,
    durationSeconds,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

function safeTimestamp(value) {
  return String(value || nowIso()).replace(/[:.]/g, "-").replace(/[^A-Za-z0-9TZ_-]/g, "-");
}

function sanitizeText(value, maxLength = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function safeStringList(values, maxItems = 8, maxLength = 80) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeGoalOutcome(goalOutcome) {
  if (!goalOutcome || typeof goalOutcome !== "object") return null;
  return {
    eventType: sanitizeText(goalOutcome.eventType || "none", 40),
    outcome: sanitizeText(goalOutcome.outcome || "none", 40),
    offsideStatus: sanitizeText(goalOutcome.offsideStatus || "none", 40),
    safeCaptionBadge: sanitizeText(goalOutcome.safeCaptionBadge || "", 80) || null,
  };
}

function safeRenderSegment(segment = {}, index = 0) {
  const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object"
    ? {
        hasBuildup: Boolean(segment.phaseCoverage.hasBuildup),
        hasShot: Boolean(segment.phaseCoverage.hasShot),
        hasFinish: Boolean(segment.phaseCoverage.hasFinish),
        hasConfirmation: Boolean(segment.phaseCoverage.hasConfirmation),
      }
    : null;
  return {
    index: index + 1,
    id: sanitizeText(segment.id || `segment_${index + 1}`, 64),
    sourceStart: safeNumber(segment.sourceStart),
    buildupStart: safeNumber(segment.buildupStart),
    shotStart: safeNumber(segment.shotStart),
    finishTime: safeNumber(segment.finishTime),
    confirmationTime: safeNumber(segment.confirmationTime),
    sourceEnd: safeNumber(segment.sourceEnd),
    duration: safeNumber(segment.duration || Number(segment.sourceEnd) - Number(segment.sourceStart)),
    timelineStart: safeNumber(segment.timelineStart),
    timelineEnd: safeNumber(segment.timelineEnd),
    goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Number(segment.goalNumber) : null,
    highlightType: sanitizeText(segment.highlightType || "generic_highlight", 60),
    goalOutcome: safeGoalOutcome(segment.goalOutcome),
    replayUsed: typeof segment.replayUsed === "boolean" ? segment.replayUsed : null,
    replayOnly: Boolean(segment.replayOnly),
    boundarySmoothing: segment.boundarySmoothing && typeof segment.boundarySmoothing === "object"
      ? {
          applied: Boolean(segment.boundarySmoothing.applied),
          smoothingLevel: sanitizeText(segment.boundarySmoothing.smoothingLevel || "", 40) || null,
          preActionPaddingSeconds: safeNumber(segment.boundarySmoothing.preActionPaddingSeconds),
          postConfirmationPaddingSeconds: safeNumber(segment.boundarySmoothing.postConfirmationPaddingSeconds),
          reason: sanitizeText(segment.boundarySmoothing.reason || "", 100) || null,
        }
      : null,
    phaseCoverage,
    reasonCodes: safeStringList(segment.reasonCodes, 10, 60),
    whySelected: sanitizeText(segment.whySelected || "", 180) || null,
    safetyFlags: safeStringList(segment.safetyFlags, 8, 80),
  };
}

function safeVisualPolishQA(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    contractVersion: Number.isFinite(Number(value.contractVersion)) ? Number(value.contractVersion) : 1,
    stylePreset: sanitizeText(value.stylePreset || "", 60) || null,
    countedGoalsIncluded: Number.isFinite(Number(value.countedGoalsIncluded)) ? Number(value.countedGoalsIncluded) : null,
    replayOnlySegments: Number.isFinite(Number(value.replayOnlySegments)) ? Number(value.replayOnlySegments) : null,
    averageGoalSegmentDuration: safeNumber(value.averageGoalSegmentDuration),
    abruptCutRiskCount: Number.isFinite(Number(value.abruptCutRiskCount)) ? Number(value.abruptCutRiskCount) : null,
    abruptCutRiskFlags: safeStringList(value.abruptCutRiskFlags, 8, 80),
    boundarySmoothingAppliedCount: Number.isFinite(Number(value.boundarySmoothingAppliedCount)) ? Number(value.boundarySmoothingAppliedCount) : null,
    averagePreActionPaddingSeconds: safeNumber(value.averagePreActionPaddingSeconds),
    averagePostConfirmationPaddingSeconds: safeNumber(value.averagePostConfirmationPaddingSeconds),
    boundarySmoothingScore: safeNumber(value.boundarySmoothingScore),
    cutSmoothnessScore: safeNumber(value.cutSmoothnessScore),
    tooShortGoalSegmentCount: Number.isFinite(Number(value.tooShortGoalSegmentCount)) ? Number(value.tooShortGoalSegmentCount) : null,
    tooLongDeadAirCount: Number.isFinite(Number(value.tooLongDeadAirCount)) ? Number(value.tooLongDeadAirCount) : null,
    missingPayoffCount: Number.isFinite(Number(value.missingPayoffCount)) ? Number(value.missingPayoffCount) : null,
    replayOnlyRiskCount: Number.isFinite(Number(value.replayOnlyRiskCount)) ? Number(value.replayOnlyRiskCount) : null,
    transitionCoverage: safeNumber(value.transitionCoverage),
    phaseCoverageScore: safeNumber(value.phaseCoverageScore),
    durationScore: safeNumber(value.durationScore),
    captionActionAlignmentScore: safeNumber(value.captionActionAlignmentScore),
    captionsAlignedCount: Number.isFinite(Number(value.captionsAlignedCount)) ? Number(value.captionsAlignedCount) : null,
    captionsMisalignedCount: Number.isFinite(Number(value.captionsMisalignedCount)) ? Number(value.captionsMisalignedCount) : null,
    visualPolishScore: Number.isFinite(Number(value.visualPolishScore)) ? Number(value.visualPolishScore) : null,
    score: safeNumber(value.score),
    totalDuration: safeNumber(value.totalDuration),
    referenceSimilarityNotes: safeStringList(value.referenceSimilarityNotes, 8, 80),
  };
}

function safeRenderTransition(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: index + 1,
    fromSegmentId: sanitizeText(value.fromSegmentId || "", 64) || null,
    toSegmentId: sanitizeText(value.toSegmentId || "", 64) || null,
    timelineStart: safeNumber(value.timelineStart),
    type: sanitizeText(value.type || "", 60) || null,
    transitionDurationSeconds: safeNumber(value.transitionDurationSeconds),
    renderedBy: sanitizeText(value.renderedBy || "", 80) || null,
  };
}

function safeRenderPolishQA(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    contractVersion: Number.isFinite(Number(value.contractVersion)) ? Number(value.contractVersion) : 1,
    renderStylePreset: sanitizeText(value.renderStylePreset || "", 80) || null,
    outputWidth: Number.isFinite(Number(value.outputWidth)) ? Number(value.outputWidth) : null,
    outputHeight: Number.isFinite(Number(value.outputHeight)) ? Number(value.outputHeight) : null,
    transitionMode: sanitizeText(value.transitionMode || "", 80) || null,
    transitionRenderedCount: Number.isFinite(Number(value.transitionRenderedCount)) ? Number(value.transitionRenderedCount) : null,
    hardCutFallbackCount: Number.isFinite(Number(value.hardCutFallbackCount)) ? Number(value.hardCutFallbackCount) : null,
    transitions: Array.isArray(value.transitions)
      ? value.transitions.map(safeRenderTransition).filter(Boolean).slice(0, 8)
      : [],
    animatedCaptionCount: Number.isFinite(Number(value.animatedCaptionCount)) ? Number(value.animatedCaptionCount) : null,
    staticCaptionFallbackCount: Number.isFinite(Number(value.staticCaptionFallbackCount)) ? Number(value.staticCaptionFallbackCount) : null,
    captionMotion: sanitizeText(value.captionMotion || "", 80) || null,
    overlayRenderedCount: Number.isFinite(Number(value.overlayRenderedCount)) ? Number(value.overlayRenderedCount) : null,
    overlayFallbackCount: Number.isFinite(Number(value.overlayFallbackCount)) ? Number(value.overlayFallbackCount) : null,
    overlayMode: sanitizeText(value.overlayMode || "", 80) || null,
    visualPolishScore: Number.isFinite(Number(value.visualPolishScore)) ? Number(value.visualPolishScore) : null,
    renderPolishWarnings: safeStringList(value.renderPolishWarnings, 8, 80),
  };
}

function safeEditAssembly(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    contractVersion: Number.isFinite(Number(value.contractVersion)) ? Number(value.contractVersion) : 1,
    segmentCount: Number.isFinite(Number(value.segmentCount)) ? Number(value.segmentCount) : null,
    segments: Array.isArray(value.segments)
      ? value.segments.slice(0, 8).map((segment, index) => ({
          index: index + 1,
          id: sanitizeText(segment.id || `segment_${index + 1}`, 64),
          goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Number(segment.goalNumber) : null,
          sourceStart: safeNumber(segment.sourceStart),
          buildupStart: safeNumber(segment.buildupStart),
          shotStart: safeNumber(segment.shotStart),
          finishTime: safeNumber(segment.finishTime),
          confirmationTime: safeNumber(segment.confirmationTime),
          sourceEnd: safeNumber(segment.sourceEnd),
          duration: safeNumber(segment.duration),
          replayUsed: Boolean(segment.replayUsed),
          replayOnly: Boolean(segment.replayOnly),
          phaseCoverage: segment.phaseCoverage && typeof segment.phaseCoverage === "object"
            ? {
                hasBuildup: Boolean(segment.phaseCoverage.hasBuildup),
                hasShot: Boolean(segment.phaseCoverage.hasShot),
                hasFinish: Boolean(segment.phaseCoverage.hasFinish),
                hasConfirmation: Boolean(segment.phaseCoverage.hasConfirmation),
              }
            : null,
          cutQuality: segment.cutQuality && typeof segment.cutQuality === "object"
            ? {
                abruptCutRisk: Boolean(segment.cutQuality.abruptCutRisk),
                riskFlags: safeStringList(segment.cutQuality.riskFlags, 8, 80),
                smoothingApplied: Boolean(segment.cutQuality.smoothingApplied),
                smoothingLevel: sanitizeText(segment.cutQuality.smoothingLevel || "", 40) || null,
                preActionPaddingSeconds: safeNumber(segment.cutQuality.preActionPaddingSeconds),
                postConfirmationPaddingSeconds: safeNumber(segment.cutQuality.postConfirmationPaddingSeconds),
              }
            : null,
          boundarySmoothing: segment.boundarySmoothing && typeof segment.boundarySmoothing === "object"
            ? {
                applied: Boolean(segment.boundarySmoothing.applied),
                smoothingLevel: sanitizeText(segment.boundarySmoothing.smoothingLevel || "", 40) || null,
                preActionPaddingSeconds: safeNumber(segment.boundarySmoothing.preActionPaddingSeconds),
                postConfirmationPaddingSeconds: safeNumber(segment.boundarySmoothing.postConfirmationPaddingSeconds),
                reason: sanitizeText(segment.boundarySmoothing.reason || "", 100) || null,
              }
            : null,
        }))
      : [],
    transitions: Array.isArray(value.transitions)
      ? value.transitions.slice(0, 8).map((transition) => ({
          fromSegmentId: sanitizeText(transition.fromSegmentId || "", 64) || null,
          toSegmentId: sanitizeText(transition.toSegmentId || "", 64) || null,
          timelineStart: safeNumber(transition.timelineStart),
          type: sanitizeText(transition.type || "", 60) || null,
          transitionDurationSeconds: safeNumber(transition.transitionDurationSeconds),
          continuity: sanitizeText(transition.continuity || "", 80) || null,
        }))
      : [],
  };
}

function safeRenderCaption(caption = {}, index = 0) {
  return {
    index: index + 1,
    start: safeNumber(caption.start),
    end: safeNumber(caption.end),
    text: sanitizeText(caption.text || "", 120),
    role: sanitizeText(caption.role || "caption", 60),
    riskFlags: safeStringList(caption.captionRiskFlags, 6, 80),
  };
}

function safeTruthEvent(event = {}, index = 0) {
  return {
    index: index + 1,
    id: sanitizeText(event.id || `truth_event_${index + 1}`, 64),
    eventType: sanitizeText(event.eventType || "", 40) || null,
    truthStatus: sanitizeText(event.truthStatus || "", 40) || null,
    type: sanitizeText(event.type || "", 48) || null,
    outcome: sanitizeText(event.outcome || "", 48) || null,
    sourceStart: safeNumber(event.sourceStart),
    sourceEnd: safeNumber(event.sourceEnd),
    decisionWindowStart: safeNumber(event.decisionWindowStart ?? event.decisionWindow?.start),
    decisionWindowEnd: safeNumber(event.decisionWindowEnd ?? event.decisionWindow?.end),
    evidence: safeStringList(event.evidence || event.evidenceCodes, 10, 80),
    disqualifiers: safeStringList(event.disqualifiers, 8, 80),
    confidence: safeNumber(event.confidence),
  };
}

function safeGoalEvidenceEvent(event = {}, index = 0) {
  return {
    index: index + 1,
    id: sanitizeText(event.id || `goal_evidence_${index + 1}`, 64),
    outcomeHint: sanitizeText(event.outcomeHint || "", 48) || null,
    start: safeNumber(event.start),
    end: safeNumber(event.end),
    reasonCodes: safeStringList(event.reasonCodes, 10, 80),
    confidence: safeNumber(event.confidence),
  };
}

function safeCountedGoalProofSummary(job = {}, segments = []) {
  const truth = job.matchEventTruth && typeof job.matchEventTruth === "object" ? job.matchEventTruth : {};
  const selectedEvents = Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [];
  const rejectedEvents = Array.isArray(truth.rejectedEvents) ? truth.rejectedEvents : [];
  const truthEvents = [...selectedEvents, ...rejectedEvents];
  const selectedValidGoals = selectedEvents
    .filter((event) => event.truthStatus === "valid_goal" || event.eventType === "valid_goal" || event.type === "confirmed_goal")
    .map(safeTruthEvent);
  const excludedOffsideOrNoGoal = truthEvents
    .filter((event) => (
      event.truthStatus === "disallowed_goal" ||
      event.eventType === "disallowed_goal" ||
      event.type === "disallowed_offside" ||
      event.type === "disallowed_no_goal"
    ))
    .map(safeTruthEvent);
  const excludedUnknowns = truthEvents
    .filter((event) => (
      event.truthStatus === "unknown" ||
      event.eventType === "goal_candidate" ||
      event.type === "possible_goal_unconfirmed"
    ))
    .map(safeTruthEvent);
  const goalEvidence = job.goalEvidence && typeof job.goalEvidence === "object" ? job.goalEvidence : {};
  const detectedGoalCandidates = Array.isArray(goalEvidence.events)
    ? goalEvidence.events
        .filter((event) => ["valid_goal", "offside_goal", "no_goal", "possible_goal_unconfirmed"].includes(event.outcomeHint))
        .map(safeGoalEvidenceEvent)
    : [];
  return {
    goalSelectionMode: sanitizeText(job.editPlan?.goalSelectionMode || "", 60) || null,
    finalSegmentCount: segments.length,
    selectedTimelineWindows: segments.map((segment) => ({
      index: segment.index,
      sourceStart: segment.sourceStart,
      shotStart: segment.shotStart,
      finishTime: segment.finishTime,
      confirmationTime: segment.confirmationTime,
      sourceEnd: segment.sourceEnd,
      goalNumber: segment.goalNumber,
      highlightType: segment.highlightType,
      goalOutcome: segment.goalOutcome,
      replayUsed: segment.replayUsed,
      replayOnly: segment.replayOnly,
      phaseCoverage: segment.phaseCoverage,
    })),
    detectedGoalCandidates,
    selectedValidGoals,
    excludedOffsideOrNoGoal,
    excludedUnknowns,
    summary: truth.summary
      ? {
          confirmedGoalCount: safeNumber(truth.summary.confirmedGoalCount),
          disallowedGoalCount: safeNumber(truth.summary.disallowedGoalCount),
          possibleGoalCount: safeNumber(truth.summary.possibleGoalCount),
          lateConfirmedGoalCount: safeNumber(truth.summary.lateConfirmedGoalCount),
          noFalseGoalFromOcrOnly: safeNumber(truth.summary.noFalseGoalFromOcrOnly),
        }
      : null,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function safeRenderPlanSummary(job) {
  const plan = job && job.editPlan && typeof job.editPlan === "object" ? job.editPlan : null;
  if (!plan) return null;
  const segments = Array.isArray(plan.segments) ? plan.segments.map(safeRenderSegment).slice(0, 8) : [];
  const captions = Array.isArray(plan.captions) ? plan.captions.map(safeRenderCaption).slice(0, 12) : [];
  const animationCueTypes = safeStringList(
    [...new Set((Array.isArray(plan.animationCues) ? plan.animationCues : []).map((cue) => cue && cue.type))],
    12,
    60,
  );
  const topCandidates = Array.isArray(job.candidatePlans)
    ? job.candidatePlans.slice(0, 4).map((candidate, index) => ({
        index: index + 1,
        mode: sanitizeText(candidate.mode || "single_moment", 60),
        highlightType: sanitizeText(candidate.highlightType || "generic_highlight", 60),
        segmentCount: Array.isArray(candidate.segments) ? candidate.segments.length : 0,
        totalDuration: safeNumber(candidate.totalDuration || Number(candidate.sourceEnd) - Number(candidate.sourceStart)),
      }))
    : [];
  return {
    mode: sanitizeText(plan.mode || (segments.length ? "multi_moment_compilation" : "single_moment"), 60),
    highlightType: sanitizeText(plan.highlightType || "generic_highlight", 60),
    sourceStart: safeNumber(plan.sourceStart),
    sourceEnd: safeNumber(plan.sourceEnd),
    totalDuration: safeNumber(plan.totalDuration || Number(plan.sourceEnd) - Number(plan.sourceStart)),
    segmentCount: segments.length,
    segments,
    captionCount: Array.isArray(plan.captions) ? plan.captions.length : 0,
    captions,
    animationCueCount: Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
    animationCueTypes,
    framingMode: sanitizeText(plan.framingMode || "", 60) || null,
    stylePreset: sanitizeText(plan.stylePreset || "", 60) || null,
    styleTarget: sanitizeText(plan.styleTarget || "", 60) || null,
    editIntensity: sanitizeText(plan.editIntensity || "", 60) || null,
    cropPlanMode: sanitizeText(plan.cropPlan && plan.cropPlan.mode ? plan.cropPlan.mode : "", 60) || null,
    candidateCount: Array.isArray(job.candidatePlans) ? job.candidatePlans.length : 0,
    goalSelectionMode: sanitizeText(plan.goalSelectionMode || "", 60) || null,
    countedGoalProof: safeCountedGoalProofSummary(job, segments),
    visualPolishQA: safeVisualPolishQA(plan.visualPolishQA),
    renderPolishQA: safeRenderPolishQA(plan.renderPolishQA),
    editAssembly: safeEditAssembly(plan.editAssembly),
    topCandidates,
  };
}

function validateRenderPlanSummary(job, ingested) {
  const summary = safeRenderPlanSummary(job);
  if (!summary) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_RENDER_PLAN_MISSING", "YouTube smoke completed job is missing a public render plan summary.");
  }
  const sourceDuration = Number(ingested?.durationSeconds || 0);
  if (sourceDuration >= 45 && (summary.mode !== "multi_moment_compilation" || summary.segmentCount < 2)) {
    throw new YouTubeSmokeError(
      "YOUTUBE_SMOKE_RENDER_PLAN_NOT_MULTI_MOMENT",
      "Long YouTube smoke sources must render as a multi-moment compilation.",
      { nextAction: nextActionForCode("YOUTUBE_SMOKE_RENDER_PLAN_NOT_MULTI_MOMENT") },
    );
  }
  return summary;
}

function safeDownloadArtifactRef(candidate) {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !text.startsWith(`${DEFAULT_DOWNLOAD_ARTIFACT_DIR}/`) ||
    extname(text).toLowerCase() !== ".mp4"
  ) {
    throw new YouTubeSmokeError(
      "YOUTUBE_SMOKE_DOWNLOAD_ARTIFACT_REF_UNSAFE",
      "YouTube smoke download artifact reference must stay under manual-downloads.",
    );
  }
  const resolvedRoot = resolve(ROOT_DIR);
  const resolvedFile = resolve(resolvedRoot, text);
  const rel = relative(resolvedRoot, resolvedFile);
  if (!rel || rel.startsWith("..") || resolve(rel).startsWith("..")) {
    throw new YouTubeSmokeError(
      "YOUTUBE_SMOKE_DOWNLOAD_ARTIFACT_REF_UNSAFE",
      "YouTube smoke download artifact reference must stay inside the workspace.",
    );
  }
  return { relativePath: text, resolvedFile };
}

function defaultDownloadArtifactRef(source, timestamp) {
  const videoId = String(source?.videoId || "unknown")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32) || "unknown";
  return `${DEFAULT_DOWNLOAD_ARTIFACT_DIR}/shortsengine-youtube-${videoId}-${safeTimestamp(timestamp)}.mp4`;
}

function maybeWriteDownloadArtifact({ buffer, downloadSummary, env, ids, ingested, source, timestamp }) {
  if (!boolFromEnv(rawValue(env, SAVE_DOWNLOAD_FLAG))) return null;
  if (!Buffer.isBuffer(buffer) || !downloadSummary) {
    throw new YouTubeSmokeError(
      "YOUTUBE_SMOKE_DOWNLOAD_ARTIFACT_MISSING",
      "YouTube smoke download artifact could not be written without a verified MP4.",
    );
  }
  const requestedRef = rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_ARTIFACT");
  const target = safeDownloadArtifactRef(requestedRef || defaultDownloadArtifactRef(source, timestamp));
  mkdirSync(dirname(target.resolvedFile), { recursive: true });
  writeFileSync(target.resolvedFile, buffer);
  return {
    type: "rendered_video",
    status: "available",
    relativePath: target.relativePath,
    sourceType: "youtube",
    videoId: source?.videoId || null,
    projectId: ids.projectId || null,
    uploadId: ids.uploadId || null,
    jobId: ids.jobId || null,
    exportId: ids.exportId || null,
    sizeBytes: downloadSummary.sizeBytes,
    contentType: downloadSummary.contentType,
    sha256Prefix: downloadSummary.sha256Prefix,
    durationSeconds: Number.isFinite(Number(ingested?.durationSeconds)) ? Number(ingested.durationSeconds) : null,
    width: Number.isFinite(Number(ingested?.width)) ? Number(ingested.width) : null,
    height: Number.isFinite(Number(ingested?.height)) ? Number(ingested.height) : null,
    downloadVerified: true,
    logsDownloaded: false,
    rawDownloaderOutputIncluded: false,
  };
}

function safeJobSnapshot(job) {
  if (!job || typeof job !== "object") return null;
  return {
    id: job.id || null,
    projectId: job.projectId || null,
    uploadId: job.uploadId || null,
    status: job.status || null,
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
    step: job.step || null,
    exportId: job.exportId || null,
    error: safeReportError(job.error),
  };
}

async function pollJob({ baseUrl, fetchImpl, jobId, jobTimeoutMs, pollIntervalMs }) {
  const started = Date.now();
  const lifecycle = [];
  let current = null;
  while (Date.now() - started < jobTimeoutMs) {
    const response = await fetchJson(fetchImpl, endpointUrl(baseUrl, `/api/jobs/${jobId}`), {
      method: "GET",
      timeoutMs: Math.min(15000, jobTimeoutMs),
    });
    current = response.payload?.data?.job || null;
    const snapshot = safeJobSnapshot(current);
    if (snapshot) lifecycle.push(snapshot);
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
      return { job: current, lifecycle, timeout: false };
    }
    await delay(pollIntervalMs);
  }
  return { job: current, lifecycle, timeout: true };
}

function validateCompletedJob(job) {
  if (!job || job.status !== "completed") {
    throw new YouTubeSmokeError(job?.error?.code || "YOUTUBE_SMOKE_JOB_FAILED", "YouTube smoke render job did not complete.");
  }
  const exportId = assertId(job.exportId, "exp", "YOUTUBE_SMOKE_EXPORT_MISSING");
  return { exportId };
}

function validateMp4Download(download) {
  if (!download.ok || !String(download.contentType || "").includes("video/mp4")) {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_DOWNLOAD_NOT_MP4", "YouTube smoke download did not return an MP4.");
  }
  const buffer = download.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new YouTubeSmokeError("YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID", "YouTube smoke download has an invalid MP4 signature.");
  }
  return {
    status: download.status,
    contentType: download.contentType,
    sizeBytes: buffer.length,
    sha256Prefix: createHash("sha256").update(buffer).digest("hex").slice(0, 16),
  };
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function addStep(steps, step, status, details = {}) {
  steps.push({ step, status, ...details });
}

function safeFailure(error) {
  const base = safeReportError(error) || { code: "YOUTUBE_SMOKE_FAILED", message: "YouTube smoke failed." };
  const code = error && error.code ? error.code : base.code;
  const nextAction = error?.details?.nextAction || nextActionForCode(code);
  return { code, message: base.message, nextAction };
}

function safeReport(report) {
  const leak = findSensitiveLeak(report);
  if (!leak) return report;
  return {
    timestamp: report.timestamp || nowIso(),
    status: "failed",
    durationMs: report.durationMs || 0,
    checks: [{ name: "youtube_smoke_report_no_sensitive_leaks", passed: false, code: "YOUTUBE_SMOKE_REPORT_LEAK", leakCode: leak.code, leakPath: leak.path }],
    failedCases: [{
      name: "youtube_smoke_report_no_sensitive_leaks",
      code: "YOUTUBE_SMOKE_REPORT_LEAK",
      leakCode: leak.code,
      leakPath: leak.path,
      nextAction: nextActionForCode("YOUTUBE_SMOKE_REPORT_LEAK"),
    }],
  };
}

function buildBaseReport({ status, started, source = null, target = null, checks = [], steps = [], ids = {}, health = null, lifecycle = [], download = null, generatedArtifact = null, renderPlan = null, failedCases = [] }) {
  return safeReport({
    timestamp: nowIso(),
    status,
    durationMs: Date.now() - started,
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    target,
    checks,
    steps,
    ids,
    health,
    jobLifecycle: lifecycle,
    renderPlan,
    export: download,
    generatedArtifact,
    failedCases,
  });
}

async function runYouTubeSmoke(options = {}) {
  const started = Date.now();
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const checks = [];
  const steps = [];
  const failedCases = [];
  const ids = {};
  let source = null;
  let target = null;
  let health = null;
  let lifecycle = [];
  let downloadSummary = null;
  let generatedArtifact = null;
  let renderPlan = null;
  let ingested = null;

  if (!boolFromEnv(rawValue(env, YOUTUBE_SMOKE_FLAG))) {
    addCheck(checks, "youtube_smoke_explicit_flag", true, {
      code: "YOUTUBE_SMOKE_DISABLED",
      nextAction: "set-SHORTSENGINE_YOUTUBE_SMOKE-1-for-manual-real-ingest-smoke",
    });
    return buildBaseReport({ status: "skipped", started, checks, steps, failedCases, source, target, ids, health, lifecycle, download: downloadSummary });
  }

  try {
    if (!boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED"))) {
      throw new YouTubeSmokeError("YOUTUBE_SMOKE_INGEST_DISABLED", "YouTube ingest must be enabled before running smoke.", {
        nextAction: nextActionForCode("YOUTUBE_SMOKE_INGEST_DISABLED"),
      });
    }
    if (typeof fetchImpl !== "function") {
      throw new YouTubeSmokeError("YOUTUBE_SMOKE_FETCH_UNAVAILABLE", "Fetch is not available for YouTube smoke.");
    }
    source = validateSmokeSource(env);
    addCheck(checks, "youtube_smoke_source_validated_before_network", true, {
      sourceType: "youtube",
      videoId: source.videoId,
    });
    const baseUrl = validateBaseUrl(configuredBaseUrl(env));
    target = safeTargetSummary(baseUrl);
    const jobTimeoutMs = parseInteger(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS"), DEFAULT_JOB_TIMEOUT_MS, 1000, 10 * 60 * 1000, "YOUTUBE_SMOKE_JOB_TIMEOUT_INVALID");
    const pollIntervalMs = parseInteger(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_POLL_INTERVAL_MS"), DEFAULT_POLL_INTERVAL_MS, 100, 10000, "YOUTUBE_SMOKE_POLL_INTERVAL_INVALID");
    const downloadMaxBytes = parseInteger(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_MAX_BYTES"), DEFAULT_DOWNLOAD_MAX_BYTES, 1024, 512 * 1024 * 1024, "YOUTUBE_SMOKE_DOWNLOAD_LIMIT_INVALID");

    const healthResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/health"), { method: "GET" });
    health = validateHealthForSmoke(healthResponse.payload);
    addStep(steps, "health", "passed", { requestIdPresent: Boolean(healthResponse.requestId), status: health.status });

    const validateResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/api/youtube/validate"), {
      method: "POST",
      body: JSON.stringify({ url: source.canonicalUrl, rightsConfirmed: true }),
    });
    const validatedSource = validateSourceResponse(assertApiOk(validateResponse, "YOUTUBE_SMOKE_VALIDATE_FAILED", "YouTube validation API failed."), source);
    addStep(steps, "validate", "passed", {
      requestIdPresent: Boolean(validateResponse.requestId),
      sourceType: validatedSource.sourceType,
      videoId: validatedSource.videoId,
    });

    const ingestResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/api/youtube/ingest"), {
      method: "POST",
      body: JSON.stringify({ url: source.canonicalUrl, rightsConfirmed: true, title: "ShortsEngine YouTube Smoke" }),
    });
    ingested = validateIngestResponse(assertApiOk(ingestResponse, "YOUTUBE_SMOKE_INGEST_FAILED", "YouTube ingest API failed."), source);
    ids.projectId = ingested.projectId;
    ids.uploadId = ingested.uploadId;
    ids.artifactId = ingested.artifactId;
    addStep(steps, "ingest", "passed", {
      requestIdPresent: Boolean(ingestResponse.requestId),
      projectId: ingested.projectId,
      uploadId: ingested.uploadId,
      durationSeconds: ingested.durationSeconds,
    });

    const generateResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, `/api/projects/${ingested.projectId}/generate`), {
      method: "POST",
      body: JSON.stringify({
        title: "ShortsEngine YouTube Smoke",
        preset: "hype",
        language: "English",
        rightsConfirmed: true,
        idempotencyKey: `youtube_smoke_${Date.now()}_${randomUUID()}`,
      }),
    });
    const generateData = assertApiOk(generateResponse, "YOUTUBE_SMOKE_GENERATE_FAILED", "YouTube smoke generate API failed.");
    ids.jobId = assertId(generateData?.job?.id, "job", "YOUTUBE_SMOKE_JOB_RESPONSE_INVALID");
    addStep(steps, "generate", "passed", { requestIdPresent: Boolean(generateResponse.requestId), jobId: ids.jobId });

    const polled = await pollJob({ baseUrl, fetchImpl, jobId: ids.jobId, jobTimeoutMs, pollIntervalMs });
    lifecycle = polled.lifecycle;
    if (polled.timeout) {
      throw new YouTubeSmokeError("YOUTUBE_SMOKE_JOB_TIMEOUT", "YouTube smoke render job timed out.");
    }
    const completed = validateCompletedJob(polled.job);
    ids.exportId = completed.exportId;
    renderPlan = validateRenderPlanSummary(polled.job, ingested);
    addStep(steps, "job", "passed", {
      jobId: ids.jobId,
      exportId: ids.exportId,
      renderMode: renderPlan.mode,
      segmentCount: renderPlan.segmentCount,
      totalDuration: renderPlan.totalDuration,
    });

    const download = await fetchDownload(fetchImpl, endpointUrl(baseUrl, `/api/exports/${ids.exportId}/download`), {
      maxBytes: downloadMaxBytes,
    });
    downloadSummary = validateMp4Download(download);
    generatedArtifact = maybeWriteDownloadArtifact({
      buffer: download.buffer,
      downloadSummary,
      env,
      ids,
      ingested,
      source,
      timestamp: nowIso(),
    });
    addStep(steps, "download", "passed", {
      requestIdPresent: Boolean(download.requestId),
      exportId: ids.exportId,
      sizeBytes: downloadSummary.sizeBytes,
      artifactSaved: Boolean(generatedArtifact),
    });

    for (const [name, passed] of [
      ["youtube_ingest_created_project", Boolean(ids.projectId)],
      ["youtube_ingest_created_upload", Boolean(ids.uploadId)],
      ["youtube_render_created_export", Boolean(ids.exportId)],
      ["youtube_render_plan_public_summary", Boolean(renderPlan)],
      ["youtube_download_mp4_signature_valid", Boolean(downloadSummary)],
    ]) {
      addCheck(checks, name, passed);
    }
  } catch (error) {
    const failure = safeFailure(error);
    failedCases.push({ name: "youtube_smoke", ...failure });
    addStep(steps, "failure", "failed", { code: failure.code, nextAction: failure.nextAction || null });
  }

  const status = failedCases.length ? "failed" : "passed";
  return buildBaseReport({ status, started, source, target, checks, steps, ids, health, lifecycle, download: downloadSummary, generatedArtifact, renderPlan, failedCases });
}

function relativeFromRoot(fileName) {
  return relative(ROOT_DIR, fileName).replace(/\\/g, "/");
}

function atomicWriteJson(fileName, payload) {
  mkdirSync(dirname(fileName), { recursive: true });
  const tempName = `${fileName}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempName, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempName, fileName);
}

function writeYouTubeSmokeReport(report, outputDir = RESULTS_DIR) {
  const safe = safeReport(report);
  mkdirSync(outputDir, { recursive: true });
  const stamp = safe.timestamp.replace(/[:.]/g, "-");
  const reportFile = resolve(outputDir, `youtube-smoke-${stamp}.json`);
  const latestFile = resolve(outputDir, "youtube-smoke-latest.json");
  atomicWriteJson(reportFile, safe);
  atomicWriteJson(latestFile, safe);
  return {
    reportPath: relativeFromRoot(reportFile),
    latestPath: relativeFromRoot(latestFile),
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const timeout = parseInteger(process.env.SHORTSENGINE_YOUTUBE_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 15 * 60 * 1000, "YOUTUBE_SMOKE_TIMEOUT_INVALID");
  let timeoutId;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => {
      resolveTimeout({
        timestamp: nowIso(),
        status: "failed",
        durationMs: timeout,
        source: null,
        target: null,
        checks: [{ name: "youtube_smoke_timeout", passed: false, code: "YOUTUBE_SMOKE_TIMEOUT" }],
        steps: [],
        ids: {},
        health: null,
        jobLifecycle: [],
        export: null,
        failedCases: [{
          name: "youtube_smoke_timeout",
          code: "YOUTUBE_SMOKE_TIMEOUT",
          nextAction: nextActionForCode("YOUTUBE_SMOKE_TIMEOUT"),
        }],
      });
    }, timeout);
    if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
  });
  const report = await Promise.race([runYouTubeSmoke(), timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  const written = writeYouTubeSmokeReport(report);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failedCases: report.failedCases, ...written }, null, 2));
  if (report.status === "failed") process.exitCode = 1;
}

export {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_JSON_RESPONSE_BYTES,
  RESULTS_DIR,
  YouTubeSmokeError,
  runYouTubeSmoke,
  safeDownloadArtifactRef,
  validateHealthForSmoke,
  validateMp4Download,
  validateSmokeSource,
  writeYouTubeSmokeReport,
};
