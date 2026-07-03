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
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
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
  YOUTUBE_DOWNLOAD_FAILED: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
  YOUTUBE_SMOKE_FETCH_FAILED: "start-server-or-check-SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL",
  YOUTUBE_SMOKE_REQUEST_TIMEOUT: "check-server-readiness-or-increase-smoke-timeout",
  YOUTUBE_SMOKE_HEALTH_TIMEOUT: "check-server-readiness-before-running-youtube-smoke",
  YOUTUBE_SMOKE_VALIDATE_TIMEOUT: "check-youtube-validation-route-and-request-timeout",
  YOUTUBE_SMOKE_INGEST_TIMEOUT: "increase-ingest-request-timeout-only-for-authorized-long-source-or-fix-downloader",
  YOUTUBE_SMOKE_GENERATE_TIMEOUT: "check-generate-route-readiness-and-server-load",
  YOUTUBE_SMOKE_JOB_STATUS_TIMEOUT: "check-job-status-route-readiness-and-server-load",
  YOUTUBE_SMOKE_TIMEOUT: "check-server-and-smoke-timeout-before-rerun",
  YOUTUBE_SMOKE_JOB_TIMEOUT: "inspect-job-progress-and-increase-job-timeout-only-if-expected",
  JOB_PROGRESS_STALLED: "inspect-active-job-substep-before-rerun-or-split-long-source-analysis",
  SCOREBOARD_OCR_TIMEOUT: "reduce-scorebug-ocr-sampling-or-disable-live-scoreboard-ocr-and-rerun-proof",
  YOUTUBE_SMOKE_RENDER_PLAN_MISSING: "check-job-public-edit-plan-before-trusting-the-live-proof",
  YOUTUBE_SMOKE_RENDER_PLAN_NOT_MULTI_MOMENT: "fix-multi-moment-selection-before-comparing-reference-style-shorts",
  VIDEO_OUTPUT_QA_FAILED: "inspect-video-output-qa-missing-goals-and-fix-final-edit-plan-before-release",
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

function phaseDetails(details = {}) {
  return {
    phase: sanitizeText(details.phase || "proof", 40),
    step: sanitizeText(details.step || "request", 80),
    substep: details.substep ? sanitizeText(details.substep, 80) : null,
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, timeoutCode, timeoutDetails = {}) {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
      throw new YouTubeSmokeError(timeoutCode, "YouTube smoke request timed out.", {
        ...phaseDetails(timeoutDetails),
        elapsedMs: Date.now() - started,
        timeoutMs,
        nextAction: nextActionForCode(timeoutCode),
      });
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
    options.timeoutDetails || { phase: "proof", step: "request" },
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
    options.timeoutDetails || { phase: "download", step: "download_export" },
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

function assertApiOk(response, code, message, details = {}) {
  if (response && response.ok === true && response.payload && response.payload.ok === true && response.payload.data) {
    return response.payload.data;
  }
  const apiError = response?.payload?.error || {};
  const apiCode = apiError.code;
  const safeApiDetails = {};
  for (const key of [
    "attempts",
    "attemptsConfigured",
    "timeoutMs",
  ]) {
    if (Number.isFinite(Number(apiError[key]))) safeApiDetails[key] = Number(apiError[key]);
  }
  for (const key of [
    "fallbackUsed",
    "retryable",
    "authorizedImportRequired",
    "downloaderConfigured",
  ]) {
    if (typeof apiError[key] === "boolean") safeApiDetails[key] = apiError[key];
  }
  for (const key of [
    "fallbackFormatSelector",
    "fileValidation",
    "formatSelector",
    "ingestRisk",
    "metadataStatus",
    "nextAction",
    "playerClient",
  ]) {
    if (typeof apiError[key] === "string") safeApiDetails[key] = sanitizeText(apiError[key], 180);
  }
  throw new YouTubeSmokeError(apiCode || code, message, { ...details, ...safeApiDetails, httpStatus: response?.status || null });
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

function safeGoalEvidenceCandidate(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: safeNumber(value.index) || index + 1,
    id: sanitizeText(value.id || `goal_evidence_${index + 1}`, 80),
    outcomeHint: sanitizeText(value.outcomeHint || "unknown", 48),
    start: safeNumber(value.start),
    end: safeNumber(value.end),
    reasonCodes: safeStringList(value.reasonCodes, 12, 80),
    missingEvidence: safeStringList(value.missingEvidence, 8, 80),
    recoveryEligibility: sanitizeText(value.recoveryEligibility || "not_recoverable", 60),
    rejectionReason: value.rejectionReason ? sanitizeText(value.rejectionReason, 80) : null,
    confidence: safeNumber(value.confidence),
  };
}

function safeTopRejectionReasons(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      return {
        reason: sanitizeText(item.reason || "", 80),
        count: safeNumber(item.count) || 0,
      };
    })
    .filter((item) => item && item.reason)
    .slice(0, 8);
}

function safeOcrChunkSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chunks = Array.isArray(value.chunks)
    ? value.chunks.slice(0, 40).map((chunk, index) => ({
        index: safeNumber(chunk && chunk.index) || index + 1,
        start: safeNumber(chunk && chunk.start),
        end: safeNumber(chunk && chunk.end),
        status: sanitizeText(chunk && chunk.status || "unknown", 40),
        sampledFrameCount: safeNumber(chunk && chunk.sampledFrameCount),
        sampledFrameTimestamps: Array.isArray(chunk && chunk.sampledFrameTimestamps)
          ? chunk.sampledFrameTimestamps.map((timestamp) => safeNumber(timestamp)).filter((timestamp) => timestamp !== null).slice(0, 16)
          : [],
        roiCandidateIds: safeStringList(chunk && chunk.roiCandidateIds, 8, 80),
        roiDetected: Boolean(chunk && chunk.roiDetected),
        selectedRoiId: chunk && chunk.selectedRoiId ? sanitizeText(chunk.selectedRoiId, 80) : null,
        ocrTextCandidateCount: safeNumber(chunk && chunk.ocrTextCandidateCount),
        evidenceCount: safeNumber(chunk && chunk.evidenceCount),
        scoreChangeCount: safeNumber(chunk && chunk.scoreChangeCount),
        textPresentObservationCount: safeNumber(chunk && chunk.textPresentObservationCount),
        readableObservationCount: safeNumber(chunk && chunk.readableObservationCount),
        clockOnlyObservationCount: safeNumber(chunk && chunk.clockOnlyObservationCount),
        rejectedObservationCount: safeNumber(chunk && chunk.rejectedObservationCount),
        stableScoreDecision: sanitizeText(chunk && chunk.stableScoreDecision || "unknown", 80),
        normalizedScoreCandidates: safeStringList(chunk && chunk.normalizedScoreCandidates, 12, 16),
        rejectedScoreCandidateReasons: safeStringList(chunk && chunk.rejectedScoreCandidateReasons, 12, 80),
        skippedReason: chunk && chunk.skippedReason ? sanitizeText(chunk.skippedReason, 80) : null,
        nextAction: chunk && chunk.nextAction ? sanitizeText(chunk.nextAction, 180) : null,
        elapsedMs: safeNumber(chunk && chunk.elapsedMs),
        timeoutMs: safeNumber(chunk && chunk.timeoutMs),
      }))
    : [];
  return {
    mode: sanitizeText(value.mode || "chunked_scorebug_first_ocr", 60),
    chunkCount: safeNumber(value.chunkCount),
    scannedChunks: safeNumber(value.scannedChunks),
    skippedChunks: safeNumber(value.skippedChunks),
    timedOutChunks: safeNumber(value.timedOutChunks) ?? chunks.filter((chunk) => chunk.status === "timed_out").length,
    failedChunks: safeNumber(value.failedChunks) ?? chunks.filter((chunk) => chunk.status === "failed").length,
    scannedDurationSeconds: safeNumber(value.scannedDurationSeconds),
    discoveredScoreChanges: safeNumber(value.discoveredScoreChanges),
    totalBudgetMs: safeNumber(value.totalBudgetMs),
    chunkTimeoutMs: safeNumber(value.chunkTimeoutMs),
    chunks,
  };
}

function safeScorebugDebug(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const safeRoi = (roi) => roi && typeof roi === "object" && !Array.isArray(roi)
    ? {
        regionId: sanitizeText(roi.regionId || "scoreboard_region", 80),
        layoutId: roi.layoutId ? sanitizeText(roi.layoutId, 80) : null,
        observationCount: safeNumber(roi.observationCount),
        readableObservationCount: safeNumber(roi.readableObservationCount),
        scoreChangeCount: safeNumber(roi.scoreChangeCount),
        diagnosis: roi.diagnosis ? sanitizeText(roi.diagnosis, 80) : null,
        reasonCodes: safeStringList(roi.reasonCodes, 8, 80),
      }
    : null;
  return {
    attemptedRoiCount: safeNumber(value.attemptedRoiCount),
    attemptedObservationCount: safeNumber(value.attemptedObservationCount),
    textPresentObservationCount: safeNumber(value.textPresentObservationCount),
    readableObservationCount: safeNumber(value.readableObservationCount),
    state: sanitizeText(value.state || "unknown", 80),
    nextAction: sanitizeText(value.nextAction || "", 180) || null,
    qaRecommended: Boolean(value.qaRecommended),
    reasonCodes: safeStringList(value.reasonCodes, 10, 80),
    selectedRoi: safeRoi(value.selectedRoi),
    rejectedRois: Array.isArray(value.rejectedRois)
      ? value.rejectedRois.map(safeRoi).filter(Boolean).slice(0, 8)
      : [],
  };
}

function safeScoreboardOcrSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value.summary && typeof value.summary === "object" && !Array.isArray(value.summary)
    ? value.summary
    : {};
  return {
    providerMode: sanitizeText(value.providerMode || "scoreboard-ocr", 80),
    fallbackUsed: Boolean(value.fallbackUsed),
    confidence: safeNumber(value.confidence),
    evidenceCount: safeNumber(summary.evidenceCount),
    scoreChangeCount: safeNumber(summary.scoreChangeCount),
    scoreRevertedCount: safeNumber(summary.scoreRevertedCount),
    ambiguousCount: safeNumber(summary.ambiguousCount),
    unreadableCount: safeNumber(summary.unreadableCount),
    sampledFrameCount: safeNumber(summary.sampledFrameCount),
    regionCount: safeNumber(summary.regionCount),
    regionIdsUsed: safeStringList(summary.regionIdsUsed, 8, 80),
    preprocessingVariantCount: safeNumber(summary.preprocessingVariantCount),
    chunkSummary: safeOcrChunkSummary(value.chunkSummary || summary.chunkSummary),
    scorebugDebug: safeScorebugDebug(summary.scorebugDebug),
  };
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

function safeHumanVisibleGoalGate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    passed: Boolean(value.passed),
    confidence: safeNumber(value.confidence),
    failureCode: value.failureCode ? sanitizeText(value.failureCode, 60) : null,
    evidence: value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? {
          hasBuildupFrames: Boolean(value.evidence.hasBuildupFrames),
          hasShotFrames: Boolean(value.evidence.hasShotFrames),
          hasGoalmouthFrames: Boolean(value.evidence.hasGoalmouthFrames),
          hasPayoffFrames: Boolean(value.evidence.hasPayoffFrames),
          hasConfirmationAfterFinish: Boolean(value.evidence.hasConfirmationAfterFinish),
        }
      : null,
    sampledFrames: Array.isArray(value.sampledFrames)
      ? value.sampledFrames.slice(0, 8).map((frame) => ({
          label: sanitizeText(frame && frame.label, 40),
          time: safeNumber(frame && frame.time),
        })).filter((frame) => frame.label && frame.time !== null)
      : [],
  };
}

function safeRenderSegment(segment = {}, index = 0) {
  const phaseCoverage = segment.phaseCoverage && typeof segment.phaseCoverage === "object"
    ? {
        hasBuildup: Boolean(segment.phaseCoverage.hasBuildup),
        hasShot: Boolean(segment.phaseCoverage.hasShot),
        hasFinish: Boolean(segment.phaseCoverage.hasFinish),
        hasConfirmation: Boolean(segment.phaseCoverage.hasConfirmation),
        visualGoalPayoff: segment.phaseCoverage.visualGoalPayoff && typeof segment.phaseCoverage.visualGoalPayoff === "object"
          ? {
              hasVisibleGoalPayoff: Boolean(segment.phaseCoverage.visualGoalPayoff.hasVisibleGoalPayoff),
              hasBallInNetEvidence: Boolean(segment.phaseCoverage.visualGoalPayoff.hasBallInNetEvidence),
              hasLiveFinishSequence: Boolean(segment.phaseCoverage.visualGoalPayoff.hasLiveFinishSequence),
              scoreboardOnly: Boolean(segment.phaseCoverage.visualGoalPayoff.scoreboardOnly),
              evidenceCodes: safeStringList(segment.phaseCoverage.visualGoalPayoff.evidenceCodes, 8, 80),
            }
          : null,
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
    visualGoalGate: safeHumanVisibleGoalGate(segment.visualGoalGate),
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
    countedGoalRecall: safeNumber(value.countedGoalRecall),
    humanVisibleGoalsIncluded: Number.isFinite(Number(value.humanVisibleGoalsIncluded)) ? Number(value.humanVisibleGoalsIncluded) : null,
    humanVisibleGoalRecall: safeNumber(value.humanVisibleGoalRecall),
    passedVisualGate: typeof value.passedVisualGate === "boolean" ? value.passedVisualGate : null,
    failedVisibleGoalSegments: Array.isArray(value.failedVisibleGoalSegments)
      ? value.failedVisibleGoalSegments.slice(0, 8).map((segment) => ({
          index: Number.isFinite(Number(segment.index)) ? Number(segment.index) : null,
          segmentId: sanitizeText(segment.segmentId || "", 64) || null,
          failureCode: segment.failureCode ? sanitizeText(segment.failureCode, 60) : null,
          confidence: safeNumber(segment.confidence),
          evidence: segment.evidence && typeof segment.evidence === "object"
            ? {
                hasBuildupFrames: Boolean(segment.evidence.hasBuildupFrames),
                hasShotFrames: Boolean(segment.evidence.hasShotFrames),
                hasGoalmouthFrames: Boolean(segment.evidence.hasGoalmouthFrames),
                hasPayoffFrames: Boolean(segment.evidence.hasPayoffFrames),
                hasConfirmationAfterFinish: Boolean(segment.evidence.hasConfirmationAfterFinish),
              }
            : null,
          sampledFrames: Array.isArray(segment.sampledFrames)
            ? segment.sampledFrames.slice(0, 8).map((frame) => ({
                label: sanitizeText(frame && frame.label, 40),
                time: safeNumber(frame && frame.time),
              })).filter((frame) => frame.label && frame.time !== null)
            : [],
        }))
      : [],
    replayOnlySegments: Number.isFinite(Number(value.replayOnlySegments)) ? Number(value.replayOnlySegments) : null,
    replayOnlyGoalRate: safeNumber(value.replayOnlyGoalRate),
    averageGoalSegmentDuration: safeNumber(value.averageGoalSegmentDuration),
    targetGoalSegmentDuration: safeNumber(value.targetGoalSegmentDuration),
    referenceMaxGoalSegmentDuration: safeNumber(value.referenceMaxGoalSegmentDuration),
    excessiveTailCount: Number.isFinite(Number(value.excessiveTailCount)) ? Number(value.excessiveTailCount) : null,
    excessiveTailRate: safeNumber(value.excessiveTailRate),
    nonGoalFillerCount: Number.isFinite(Number(value.nonGoalFillerCount)) ? Number(value.nonGoalFillerCount) : null,
    nonGoalFillerRate: safeNumber(value.nonGoalFillerRate),
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
    actionBoundaryScore: safeNumber(value.actionBoundaryScore),
    referencePacingScore: safeNumber(value.referencePacingScore),
    captionActionAlignmentScore: safeNumber(value.captionActionAlignmentScore),
    captionsAlignedCount: Number.isFinite(Number(value.captionsAlignedCount)) ? Number(value.captionsAlignedCount) : null,
    captionsMisalignedCount: Number.isFinite(Number(value.captionsMisalignedCount)) ? Number(value.captionsMisalignedCount) : null,
    visualPolishScore: Number.isFinite(Number(value.visualPolishScore)) ? Number(value.visualPolishScore) : null,
    score: safeNumber(value.score),
    totalDuration: safeNumber(value.totalDuration),
    referenceSimilarityNotes: safeStringList(value.referenceSimilarityNotes, 8, 80),
  };
}

function safeVideoOutputQA(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    schemaVersion: Number.isFinite(Number(value.schemaVersion)) ? Number(value.schemaVersion) : null,
    status: value.status ? String(value.status).slice(0, 40) : null,
    passed: typeof value.passed === "boolean" ? value.passed : null,
    goalSelectionMode: value.goalSelectionMode ? String(value.goalSelectionMode).slice(0, 60) : null,
    expectedGoalCount: safeNumber(value.expectedGoalCount),
    actualSegmentCount: safeNumber(value.actualSegmentCount),
    actualConfirmedGoalSegmentCount: safeNumber(value.actualConfirmedGoalSegmentCount),
    coveredGoalCount: safeNumber(value.coveredGoalCount),
    missingGoalNumbers: Array.isArray(value.missingGoalNumbers)
      ? value.missingGoalNumbers.map((goal) => Number(goal)).filter(Number.isFinite).slice(0, 12)
      : [],
    extraGoalSegmentCount: safeNumber(value.extraGoalSegmentCount),
    failedReasons: safeStringList(value.failedReasons, 12, 80),
    invalidSegments: Array.isArray(value.invalidSegments)
      ? value.invalidSegments.slice(0, 8).map((segment, index) => ({
          index: Number.isFinite(Number(segment.index)) ? Number(segment.index) : index + 1,
          id: segment.id ? String(segment.id).slice(0, 80) : null,
          reasons: safeStringList(segment.reasons, 8, 80),
        }))
      : [],
    matches: Array.isArray(value.matches)
      ? value.matches.slice(0, 12).map((match, index) => ({
          goalNumber: Number.isFinite(Number(match.goalNumber)) ? Number(match.goalNumber) : index + 1,
          segmentIndex: Number.isFinite(Number(match.segmentIndex)) ? Number(match.segmentIndex) : null,
          covered: Boolean(match.covered),
          reasons: safeStringList(match.reasons, 8, 80),
        }))
      : [],
    logsDownloaded: false,
    artifactsDownloaded: false,
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
          visualGoalGate: safeHumanVisibleGoalGate(segment.visualGoalGate),
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

function safeScoreChangeAnchor(anchor = {}, index = 0) {
  return {
    index: index + 1,
    id: sanitizeText(anchor.id || `score_change_anchor_${index + 1}`, 96),
    scoreBefore: anchor.scoreBefore ? sanitizeText(anchor.scoreBefore, 16) : null,
    scoreAfter: anchor.scoreAfter ? sanitizeText(anchor.scoreAfter, 16) : null,
    firstSeenAt: safeNumber(anchor.firstSeenAt),
    confirmedAt: safeNumber(anchor.confirmedAt),
    stableUntil: safeNumber(anchor.stableUntil),
    reverted: Boolean(anchor.reverted),
    revertedAt: safeNumber(anchor.revertedAt),
    confidence: safeNumber(anchor.confidence),
    source: "scoreboard_ocr",
    roiId: anchor.roiId ? sanitizeText(anchor.roiId, 80) : null,
    layoutId: anchor.layoutId ? sanitizeText(anchor.layoutId, 80) : null,
    outcome: sanitizeText(anchor.outcome || "uncertain_review", 48),
    selectedForRender: Boolean(anchor.selectedForRender),
    linkedEventType: anchor.linkedEventType ? sanitizeText(anchor.linkedEventType, 48) : null,
    hasLiveAction: Boolean(anchor.hasLiveAction),
    hasVisibleFinish: Boolean(anchor.hasVisibleFinish),
    replayOnly: Boolean(anchor.replayOnly),
    missingEvidence: safeStringList(anchor.missingEvidence, 8, 80),
    evidenceCodes: safeStringList(anchor.evidenceCodes, 16, 80),
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
    missingEvidence: safeStringList(event.missingEvidence, 8, 80),
    recoveryEligibility: sanitizeText(event.recoveryEligibility || "not_recoverable", 60),
    rejectionReason: event.rejectionReason ? sanitizeText(event.rejectionReason, 80) : null,
    confidence: safeNumber(event.confidence),
  };
}

function safeCountedGoalProofSummary(job = {}, segments = []) {
  const truth = job.matchEventTruth && typeof job.matchEventTruth === "object" ? job.matchEventTruth : {};
  const selectedEvents = Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [];
  const rejectedEvents = Array.isArray(truth.rejectedEvents) ? truth.rejectedEvents : [];
  const truthEvents = [...selectedEvents, ...rejectedEvents];
  const scoreChangeAnchors = Array.isArray(truth.scoreChangeAnchors)
    ? truth.scoreChangeAnchors.map(safeScoreChangeAnchor).slice(0, 12)
    : [];
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
      visualGoalGate: segment.visualGoalGate,
    })),
    detectedGoalCandidates,
    selectedValidGoals,
    excludedOffsideOrNoGoal,
    excludedUnknowns,
    scoreChangeAnchors,
    summary: truth.summary
      ? {
          confirmedGoalCount: safeNumber(truth.summary.confirmedGoalCount),
          disallowedGoalCount: safeNumber(truth.summary.disallowedGoalCount),
          possibleGoalCount: safeNumber(truth.summary.possibleGoalCount),
          lateConfirmedGoalCount: safeNumber(truth.summary.lateConfirmedGoalCount),
          scoreChangeAnchorsFound: safeNumber(truth.summary.scoreChangeAnchorsFound),
          stableScoreChangeAnchorCount: safeNumber(truth.summary.stableScoreChangeAnchorCount),
          revertedScoreChangeAnchorCount: safeNumber(truth.summary.revertedScoreChangeAnchorCount),
          anchorsLinkedToGoalPhaseCount: safeNumber(truth.summary.anchorsLinkedToGoalPhaseCount),
          anchorsMissingVisualSupportCount: safeNumber(truth.summary.anchorsMissingVisualSupportCount),
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
  const videoOutputQA = safeVideoOutputQA(job.videoOutputQA || job.editPlan?.videoOutputQA);
  const progressMeta = job.progressMeta && typeof job.progressMeta === "object" && !Array.isArray(job.progressMeta)
    ? {
        phase: sanitizeText(job.progressMeta.phase || "", 40) || null,
        step: sanitizeText(job.progressMeta.step || job.step || "", 80) || null,
        substep: sanitizeText(job.progressMeta.substep || "", 80) || null,
        startedAt: sanitizeText(job.progressMeta.startedAt || "", 40) || null,
        longSource: typeof job.progressMeta.longSource === "boolean" ? job.progressMeta.longSource : null,
        scorebugFirst: typeof job.progressMeta.scorebugFirst === "boolean" ? job.progressMeta.scorebugFirst : null,
        budgetMs: Number.isFinite(Number(job.progressMeta.budgetMs)) ? Number(job.progressMeta.budgetMs) : null,
        chunkIndex: Number.isFinite(Number(job.progressMeta.chunkIndex)) ? Number(job.progressMeta.chunkIndex) : null,
        chunkCount: Number.isFinite(Number(job.progressMeta.chunkCount)) ? Number(job.progressMeta.chunkCount) : null,
        chunkStart: Number.isFinite(Number(job.progressMeta.chunkStart)) ? Number(job.progressMeta.chunkStart) : null,
        chunkEnd: Number.isFinite(Number(job.progressMeta.chunkEnd)) ? Number(job.progressMeta.chunkEnd) : null,
        scannedChunks: Number.isFinite(Number(job.progressMeta.scannedChunks)) ? Number(job.progressMeta.scannedChunks) : null,
        discoveredScoreChanges: Number.isFinite(Number(job.progressMeta.discoveredScoreChanges)) ? Number(job.progressMeta.discoveredScoreChanges) : null,
        elapsedMs: Number.isFinite(Number(job.progressMeta.elapsedMs)) ? Number(job.progressMeta.elapsedMs) : null,
        totalBudgetMs: Number.isFinite(Number(job.progressMeta.totalBudgetMs)) ? Number(job.progressMeta.totalBudgetMs) : null,
        chunkTimeoutMs: Number.isFinite(Number(job.progressMeta.chunkTimeoutMs)) ? Number(job.progressMeta.chunkTimeoutMs) : null,
        sampledFrameTimestamps: Array.isArray(job.progressMeta.sampledFrameTimestamps)
          ? job.progressMeta.sampledFrameTimestamps
            .map((timestamp) => safeNumber(timestamp))
            .filter((timestamp) => timestamp !== null)
            .slice(0, 16)
          : [],
        roiCandidateIds: safeStringList(job.progressMeta.roiCandidateIds, 8, 80),
      }
    : null;
  return {
    id: job.id || null,
    projectId: job.projectId || null,
    uploadId: job.uploadId || null,
    status: job.status || null,
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
    step: job.step || null,
    progressMeta,
    exportId: job.exportId || null,
    error: safeReportError(job.error),
    scoreboardOcr: safeScoreboardOcrSnapshot(job.scoreboardOcr),
    videoOutputQA,
  };
}

function snapshotProgressKey(snapshot) {
  if (!snapshot) return "missing";
  const meta = snapshot.progressMeta || {};
  return [
    snapshot.status || "",
    snapshot.progress || 0,
    snapshot.step || "",
    meta.substep || "",
    meta.chunkIndex || "",
    meta.scannedChunks || "",
    meta.discoveredScoreChanges || "",
  ].join("|");
}

async function pollJob({ baseUrl, fetchImpl, jobId, jobTimeoutMs, pollIntervalMs, stallTimeoutMs }) {
  const started = Date.now();
  const lifecycle = [];
  let current = null;
  let currentSnapshot = null;
  let currentKey = null;
  let lastProgressAt = started;
  while (Date.now() - started < jobTimeoutMs) {
    let response;
    try {
      response = await fetchJson(fetchImpl, endpointUrl(baseUrl, `/api/jobs/${jobId}`), {
        method: "GET",
        timeoutMs: Math.min(15000, jobTimeoutMs),
        timeoutCode: "YOUTUBE_SMOKE_JOB_STATUS_TIMEOUT",
        timeoutDetails: { phase: "render", step: "poll_job_status" },
      });
    } catch (error) {
      if (currentSnapshot) {
        return {
          job: current,
          lifecycle,
          timeout: true,
          stalled: false,
          code: currentSnapshot.error?.code || error?.code || "YOUTUBE_SMOKE_FETCH_FAILED",
          fetchFailureCode: error?.code || "YOUTUBE_SMOKE_FETCH_FAILED",
          elapsedMs: Date.now() - started,
          timeoutMs: null,
          lastProgressAt: new Date(lastProgressAt).toISOString(),
          currentJob: currentSnapshot,
        };
      }
      throw error;
    }
    current = response.payload?.data?.job || null;
    const snapshot = safeJobSnapshot(current);
    if (snapshot) {
      lifecycle.push(snapshot);
      const nextKey = snapshotProgressKey(snapshot);
      if (nextKey !== currentKey) {
        currentKey = nextKey;
        lastProgressAt = Date.now();
      }
      currentSnapshot = snapshot;
    }
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
      return { job: current, lifecycle, timeout: false };
    }
    if (currentSnapshot && Date.now() - lastProgressAt >= stallTimeoutMs) {
      return {
        job: current,
        lifecycle,
        timeout: true,
        stalled: true,
        code: "JOB_PROGRESS_STALLED",
        elapsedMs: Date.now() - started,
        timeoutMs: stallTimeoutMs,
        lastProgressAt: new Date(lastProgressAt).toISOString(),
        currentJob: currentSnapshot,
      };
    }
    await delay(pollIntervalMs);
  }
  return {
    job: current,
    lifecycle,
    timeout: true,
    stalled: false,
    code: "YOUTUBE_SMOKE_JOB_TIMEOUT",
    elapsedMs: Date.now() - started,
    timeoutMs: jobTimeoutMs,
    lastProgressAt: new Date(lastProgressAt).toISOString(),
    currentJob: currentSnapshot,
  };
}

function validateCompletedJob(job) {
  if (!job || job.status !== "completed") {
    const videoOutputQA = safeVideoOutputQA(job?.videoOutputQA || job?.editPlan?.videoOutputQA);
    const errorDetails = job?.error?.details && typeof job.error.details === "object" && !Array.isArray(job.error.details)
      ? job.error.details
      : {};
    const progressMeta = job && job.progressMeta && typeof job.progressMeta === "object" && !Array.isArray(job.progressMeta)
      ? job.progressMeta
      : {};
    throw new YouTubeSmokeError(job?.error?.code || "YOUTUBE_SMOKE_JOB_FAILED", "YouTube smoke render job did not complete.", {
      ...errorDetails,
      phase: errorDetails.phase || progressMeta.phase || "render",
      step: errorDetails.step || progressMeta.step || job?.step || "render_job",
      substep: errorDetails.substep || progressMeta.substep || null,
      timeoutMs: Number.isFinite(Number(errorDetails.timeoutMs))
        ? Number(errorDetails.timeoutMs)
        : Number.isFinite(Number(progressMeta.budgetMs))
          ? Number(progressMeta.budgetMs)
          : null,
      chunkIndex: Number.isFinite(Number(errorDetails.chunkIndex))
        ? Number(errorDetails.chunkIndex)
        : Number.isFinite(Number(progressMeta.chunkIndex))
          ? Number(progressMeta.chunkIndex)
          : null,
      chunkCount: Number.isFinite(Number(errorDetails.chunkCount))
        ? Number(errorDetails.chunkCount)
        : Number.isFinite(Number(progressMeta.chunkCount))
          ? Number(progressMeta.chunkCount)
          : null,
      chunkStart: Number.isFinite(Number(errorDetails.chunkStart))
        ? Number(errorDetails.chunkStart)
        : Number.isFinite(Number(progressMeta.chunkStart))
          ? Number(progressMeta.chunkStart)
          : null,
      chunkEnd: Number.isFinite(Number(errorDetails.chunkEnd))
        ? Number(errorDetails.chunkEnd)
        : Number.isFinite(Number(progressMeta.chunkEnd))
          ? Number(progressMeta.chunkEnd)
          : null,
      scannedChunks: Number.isFinite(Number(errorDetails.scannedChunks))
        ? Number(errorDetails.scannedChunks)
        : Number.isFinite(Number(progressMeta.scannedChunks))
          ? Number(progressMeta.scannedChunks)
          : null,
      discoveredScoreChanges: Number.isFinite(Number(errorDetails.discoveredScoreChanges))
        ? Number(errorDetails.discoveredScoreChanges)
        : Number.isFinite(Number(progressMeta.discoveredScoreChanges))
          ? Number(progressMeta.discoveredScoreChanges)
          : null,
      totalBudgetMs: Number.isFinite(Number(errorDetails.totalBudgetMs))
        ? Number(errorDetails.totalBudgetMs)
        : Number.isFinite(Number(progressMeta.totalBudgetMs))
          ? Number(progressMeta.totalBudgetMs)
          : null,
      chunkTimeoutMs: Number.isFinite(Number(errorDetails.chunkTimeoutMs))
        ? Number(errorDetails.chunkTimeoutMs)
        : Number.isFinite(Number(progressMeta.chunkTimeoutMs))
          ? Number(progressMeta.chunkTimeoutMs)
          : null,
      videoOutputQA,
      countedGoalEventCount: videoOutputQA ? videoOutputQA.expectedGoalCount : errorDetails.countedGoalEventCount ?? null,
      actualConfirmedGoalSegmentCount: videoOutputQA ? videoOutputQA.actualConfirmedGoalSegmentCount : errorDetails.actualConfirmedGoalSegmentCount ?? null,
      coveredGoalCount: videoOutputQA ? videoOutputQA.coveredGoalCount : errorDetails.coveredGoalCount ?? null,
      missingGoalNumbers: videoOutputQA ? videoOutputQA.missingGoalNumbers : errorDetails.missingGoalNumbers || [],
      failedReasons: videoOutputQA ? videoOutputQA.failedReasons : errorDetails.failedReasons || [],
      currentJob: safeJobSnapshot(job),
      nextAction: errorDetails.nextAction || (videoOutputQA ? nextActionForCode("VIDEO_OUTPUT_QA_FAILED") : nextActionForCode(job?.error?.code || "YOUTUBE_SMOKE_JOB_FAILED")),
    });
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
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    code,
    message: base.message,
    nextAction,
    phase: details.phase ? sanitizeText(details.phase, 40) : null,
    step: details.step ? sanitizeText(details.step, 80) : null,
    substep: details.substep ? sanitizeText(details.substep, 80) : null,
    elapsedMs: Number.isFinite(Number(details.elapsedMs)) ? Number(details.elapsedMs) : null,
    timeoutMs: Number.isFinite(Number(details.timeoutMs)) ? Number(details.timeoutMs) : null,
    attempts: Number.isFinite(Number(details.attempts)) ? Number(details.attempts) : null,
    attemptsConfigured: Number.isFinite(Number(details.attemptsConfigured)) ? Number(details.attemptsConfigured) : null,
    retryable: typeof details.retryable === "boolean" ? details.retryable : null,
    authorizedImportRequired: typeof details.authorizedImportRequired === "boolean" ? details.authorizedImportRequired : null,
    fallbackUsed: typeof details.fallbackUsed === "boolean" ? details.fallbackUsed : null,
    formatSelector: details.formatSelector ? sanitizeText(details.formatSelector, 180) : null,
    fallbackFormatSelector: details.fallbackFormatSelector ? sanitizeText(details.fallbackFormatSelector, 180) : null,
    playerClient: details.playerClient ? sanitizeText(details.playerClient, 40) : null,
    ingestRisk: details.ingestRisk ? sanitizeText(details.ingestRisk, 80) : null,
    metadataStatus: details.metadataStatus ? sanitizeText(details.metadataStatus, 80) : null,
    fileValidation: details.fileValidation ? sanitizeText(details.fileValidation, 80) : null,
    chunkIndex: Number.isFinite(Number(details.chunkIndex)) ? Number(details.chunkIndex) : null,
    chunkCount: Number.isFinite(Number(details.chunkCount)) ? Number(details.chunkCount) : null,
    chunkStart: Number.isFinite(Number(details.chunkStart)) ? Number(details.chunkStart) : null,
    chunkEnd: Number.isFinite(Number(details.chunkEnd)) ? Number(details.chunkEnd) : null,
    scannedChunks: Number.isFinite(Number(details.scannedChunks)) ? Number(details.scannedChunks) : null,
    discoveredScoreChanges: Number.isFinite(Number(details.discoveredScoreChanges)) ? Number(details.discoveredScoreChanges) : null,
    totalBudgetMs: Number.isFinite(Number(details.totalBudgetMs)) ? Number(details.totalBudgetMs) : null,
    chunkTimeoutMs: Number.isFinite(Number(details.chunkTimeoutMs)) ? Number(details.chunkTimeoutMs) : null,
    stalled: typeof details.stalled === "boolean" ? details.stalled : null,
    lastProgressAt: details.lastProgressAt ? sanitizeText(details.lastProgressAt, 40) : null,
    causeCode: details.causeCode ? sanitizeText(details.causeCode, 60) : null,
    currentJob: safeJobSnapshot(details.currentJob),
    countedGoalEventCount: safeNumber(details.countedGoalEventCount),
    discoveredCountedGoals: safeNumber(details.discoveredCountedGoals),
    expectedCountedGoals: safeNumber(details.expectedCountedGoals),
    actualConfirmedGoalSegmentCount: safeNumber(details.actualConfirmedGoalSegmentCount),
    coveredGoalCount: safeNumber(details.coveredGoalCount),
    sourceValidated: typeof details.sourceValidated === "boolean" ? details.sourceValidated : null,
    downloadedSourceReady: typeof details.downloadedSourceReady === "boolean" ? details.downloadedSourceReady : null,
    scoreboardOcrAttempted: typeof details.scoreboardOcrAttempted === "boolean" ? details.scoreboardOcrAttempted : null,
    scoreboardOcrEnabled: typeof details.scoreboardOcrEnabled === "boolean" ? details.scoreboardOcrEnabled : null,
    scoreboardOcrProviderMode: details.scoreboardOcrProviderMode ? sanitizeText(details.scoreboardOcrProviderMode, 80) : null,
    sourceDuration: safeNumber(details.sourceDuration),
    scoreboardObservationCount: safeNumber(details.scoreboardObservationCount),
    scoreboardSampledFrameCount: safeNumber(details.scoreboardSampledFrameCount),
    scoreChangeCount: safeNumber(details.scoreChangeCount),
    stableScoreChangeCount: safeNumber(details.stableScoreChangeCount),
    chunksScanned: safeNumber(details.chunksScanned),
    scoreChangesFound: safeNumber(details.scoreChangesFound),
    visualWindowCount: safeNumber(details.visualWindowCount),
    bucketCount: safeNumber(details.bucketCount),
    lateBucketInspected: typeof details.lateBucketInspected === "boolean" ? details.lateBucketInspected : null,
    selectedValidGoalCount: safeNumber(details.selectedValidGoalCount),
    candidateCount: safeNumber(details.candidateCount),
    rejectedCandidateCount: safeNumber(details.rejectedCandidateCount),
    topRejectionReasons: safeTopRejectionReasons(details.topRejectionReasons),
    missingEvidenceByCandidate: Array.isArray(details.missingEvidenceByCandidate)
      ? details.missingEvidenceByCandidate.map(safeGoalEvidenceCandidate).filter(Boolean).slice(0, 12)
      : [],
    goalEvidenceCandidates: Array.isArray(details.goalEvidenceCandidates)
      ? details.goalEvidenceCandidates.map(safeGoalEvidenceCandidate).filter(Boolean).slice(0, 12)
      : [],
    missingGoalNumbers: Array.isArray(details.missingGoalNumbers)
      ? details.missingGoalNumbers.map((goal) => Number(goal)).filter(Number.isFinite).slice(0, 12)
      : [],
    failedReasons: safeStringList(details.failedReasons, 12, 80),
    videoOutputQA: safeVideoOutputQA(details.videoOutputQA),
  };
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
    const stallTimeoutMs = parseInteger(
      rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_STALL_TIMEOUT_MS"),
      Math.min(jobTimeoutMs, 120_000),
      1000,
      10 * 60 * 1000,
      "YOUTUBE_SMOKE_STALL_TIMEOUT_INVALID",
    );
    const downloadMaxBytes = parseInteger(rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_MAX_BYTES"), DEFAULT_DOWNLOAD_MAX_BYTES, 1024, 512 * 1024 * 1024, "YOUTUBE_SMOKE_DOWNLOAD_LIMIT_INVALID");
    const requestTimeoutMs = parseInteger(
      rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS"),
      DEFAULT_REQUEST_TIMEOUT_MS,
      1000,
      15 * 60 * 1000,
      "YOUTUBE_SMOKE_REQUEST_TIMEOUT_INVALID",
    );

    const healthResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/health"), {
      method: "GET",
      timeoutMs: requestTimeoutMs,
      timeoutCode: "YOUTUBE_SMOKE_HEALTH_TIMEOUT",
      timeoutDetails: { phase: "health", step: "health" },
    });
    health = validateHealthForSmoke(healthResponse.payload);
    addStep(steps, "health", "passed", { requestIdPresent: Boolean(healthResponse.requestId), status: health.status });

    const validateResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/api/youtube/validate"), {
      method: "POST",
      body: JSON.stringify({ url: source.canonicalUrl, rightsConfirmed: true }),
      timeoutMs: requestTimeoutMs,
      timeoutCode: "YOUTUBE_SMOKE_VALIDATE_TIMEOUT",
      timeoutDetails: { phase: "validation", step: "validate_youtube_source" },
    });
    const validatedSource = validateSourceResponse(assertApiOk(
      validateResponse,
      "YOUTUBE_SMOKE_VALIDATE_FAILED",
      "YouTube validation API failed.",
      { phase: "validation", step: "validate_youtube_source" },
    ), source);
    addStep(steps, "validate", "passed", {
      requestIdPresent: Boolean(validateResponse.requestId),
      sourceType: validatedSource.sourceType,
      videoId: validatedSource.videoId,
    });

    const ingestResponse = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/api/youtube/ingest"), {
      method: "POST",
      body: JSON.stringify({ url: source.canonicalUrl, rightsConfirmed: true, title: "ShortsEngine YouTube Smoke" }),
      timeoutMs: requestTimeoutMs,
      timeoutCode: "YOUTUBE_SMOKE_INGEST_TIMEOUT",
      timeoutDetails: { phase: "ingest", step: "download_source", substep: "youtube_downloader" },
    });
    ingested = validateIngestResponse(assertApiOk(
      ingestResponse,
      "YOUTUBE_SMOKE_INGEST_FAILED",
      "YouTube ingest API failed.",
      { phase: "ingest", step: "download_source", substep: "youtube_downloader" },
    ), source);
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
      timeoutMs: requestTimeoutMs,
      timeoutCode: "YOUTUBE_SMOKE_GENERATE_TIMEOUT",
      timeoutDetails: { phase: "render", step: "generate_render_job" },
    });
    const generateData = assertApiOk(
      generateResponse,
      "YOUTUBE_SMOKE_GENERATE_FAILED",
      "YouTube smoke generate API failed.",
      { phase: "render", step: "generate_render_job" },
    );
    ids.jobId = assertId(generateData?.job?.id, "job", "YOUTUBE_SMOKE_JOB_RESPONSE_INVALID");
    addStep(steps, "generate", "passed", { requestIdPresent: Boolean(generateResponse.requestId), jobId: ids.jobId });

    const polled = await pollJob({ baseUrl, fetchImpl, jobId: ids.jobId, jobTimeoutMs, pollIntervalMs, stallTimeoutMs });
    lifecycle = polled.lifecycle;
    if (polled.timeout) {
      const active = polled.currentJob || safeJobSnapshot(polled.job);
      const meta = active && active.progressMeta ? active.progressMeta : {};
      throw new YouTubeSmokeError(polled.code || "YOUTUBE_SMOKE_JOB_TIMEOUT", "YouTube smoke render job timed out.", {
        phase: "render",
        step: active && active.step ? active.step : "poll_job_status",
        substep: meta.substep || null,
        elapsedMs: polled.elapsedMs,
        timeoutMs: polled.timeoutMs,
        causeCode: polled.fetchFailureCode || null,
        stalled: Boolean(polled.stalled),
        lastProgressAt: polled.lastProgressAt,
        currentJob: active,
        nextAction: nextActionForCode(polled.code || "YOUTUBE_SMOKE_JOB_TIMEOUT"),
      });
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
      timeoutMs: requestTimeoutMs,
      timeoutDetails: { phase: "download", step: "download_export" },
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
    addStep(steps, "failure", "failed", {
      code: failure.code,
      nextAction: failure.nextAction || null,
      phase: failure.phase,
      activeStep: failure.step,
      substep: failure.substep,
    });
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
