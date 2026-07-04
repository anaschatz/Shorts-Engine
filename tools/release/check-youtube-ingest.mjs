import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const require = createRequire(import.meta.url);
const { CONFIG } = require("../../server/config.cjs");
const { commandAvailable } = require("../../server/media.cjs");
const { storageHealth } = require("../../server/storage.cjs");
const {
  downloaderAvailable,
  downloaderVersion,
  formatStrategySummary,
} = require("../../server/adapters/local-youtube-ingest-adapter.cjs");

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const DOCTOR_NEXT_ACTIONS = {
  YOUTUBE_INGEST_DISABLED: "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1-and-configure-downloader-for-real-ingest",
  YOUTUBE_DOWNLOADER_MISSING: "install-configure-downloader-or-set-SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN",
  SOURCE_CACHE_MISS: "place-rights-cleared-source-in-cache-or-configure-downloader-fallback",
  SOURCE_CACHE_FILE_INVALID: "replace-invalid-source-cache-file",
  SOURCE_CACHE_CHECKSUM_MISMATCH: "fix-cache-metadata-or-checksum",
  FFMPEG_MISSING: "install-ffmpeg-or-set-FFMPEG_BIN",
  FFPROBE_MISSING: "install-ffprobe-or-set-FFPROBE_BIN",
  YOUTUBE_STAGING_STORAGE_UNAVAILABLE: "check-data-directory-permissions-and-staging-storage",
  YOUTUBE_DOCTOR_HEALTH_URL_NOT_CONFIGURED: "set-SHORTSENGINE_YOUTUBE_DOCTOR_URL-to-check-live-/health",
  YOUTUBE_DOCTOR_HEALTH_URL_INVALID: "set-SHORTSENGINE_YOUTUBE_DOCTOR_URL-to-a-http-or-https-base-url",
  YOUTUBE_DOCTOR_HEALTH_TIMEOUT: "start-server-or-set-SHORTSENGINE_YOUTUBE_DOCTOR_URL-and-timeout",
  YOUTUBE_DOCTOR_HEALTH_FETCH_FAILED: "start-server-or-set-SHORTSENGINE_YOUTUBE_DOCTOR_URL",
  YOUTUBE_DOCTOR_HEALTH_FETCH_INVALID: "check-live-health-server-response",
  YOUTUBE_DOCTOR_HEALTH_HTTP_FAILED: "check-live-health-server-status",
  YOUTUBE_DOCTOR_HEALTH_JSON_INVALID: "fix-live-health-json-or-use-local-doctor",
  YOUTUBE_DOCTOR_HEALTH_SHAPE_INVALID: "fix-live-health-youtubeIngest-shape-or-use-local-doctor",
  YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING: "fix-live-health-youtubeIngest-shape-or-use-local-doctor",
  YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID: "fix-live-health-youtubeIngest-shape-or-use-local-doctor",
  YOUTUBE_DOCTOR_HEALTH_LEAK: "remove-sensitive-fields-from-live-health-output",
  YOUTUBE_DOCTOR_HEALTH_TOO_LARGE: "reduce-live-health-response-size",
};

class YouTubeDoctorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "YouTubeDoctorError";
    this.code = code;
    this.details = details;
  }
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
    throw new YouTubeDoctorError(code, "YouTube ingest doctor numeric configuration is out of bounds.");
  }
  return parsed;
}

function classifyHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return "private";
  return "remote";
}

function safeTargetSummary(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_URL_INVALID", "YouTube doctor health URL is invalid.");
  }
  return {
    configured: true,
    protocol: parsed.protocol.replace(":", ""),
    hostType: classifyHost(parsed.hostname),
    endpoint: "/health",
  };
}

function healthUrlFor(value) {
  const parsed = new URL(value);
  parsed.pathname = "/health";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function readBoundedResponseText(response, maxBytes = MAX_HEALTH_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_TOO_LARGE", "YouTube doctor health response is too large.");
    }
    return text;
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
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_TOO_LARGE", "YouTube doctor health response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function validateHealthYoutubeShape(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_SHAPE_INVALID", "YouTube doctor health response shape is invalid.");
  }
  const youtubeIngest = payload.data.youtubeIngest;
  if (!youtubeIngest || typeof youtubeIngest !== "object") {
    throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING", "Health response is missing youtubeIngest readiness.");
  }
  for (const key of ["enabled", "downloaderConfigured", "ingestAvailable", "ready"]) {
    if (typeof youtubeIngest[key] !== "boolean") {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID", "Health youtubeIngest readiness shape is invalid.");
    }
  }
  const leak = findSensitiveLeak(payload);
  if (leak) {
    throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_LEAK", "Health response contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
  return {
    service: payload.data.service || null,
    status: payload.data.status || null,
    youtubeIngest: {
      enabled: youtubeIngest.enabled,
      mode: youtubeIngest.mode || "unknown",
      downloaderConfigured: youtubeIngest.downloaderConfigured,
      sourceCacheAvailable: youtubeIngest.sourceCacheAvailable === true || youtubeIngest.sourceCacheEnabled === true,
      sourceCacheRequiresChecksum: youtubeIngest.sourceCacheRequiresChecksum === true,
      ingestAvailable: youtubeIngest.ingestAvailable,
      ready: youtubeIngest.ready,
    },
  };
}

function nextActionForCode(code) {
  return DOCTOR_NEXT_ACTIONS[code] || "inspect-youtube-doctor-configuration";
}

async function fetchHealthSummary(fetchImpl, healthUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== "number") {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_FETCH_INVALID", "Health fetch returned an invalid response.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_HTTP_FAILED", "Health endpoint returned a non-success status.");
    }
    const text = await readBoundedResponseText(response);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_JSON_INVALID", "Health endpoint returned invalid JSON.");
    }
    return validateHealthYoutubeShape(payload);
  } catch (error) {
    if (error instanceof YouTubeDoctorError) throw error;
    if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
      throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_TIMEOUT", "Health endpoint timed out.");
    }
    throw new YouTubeDoctorError("YOUTUBE_DOCTOR_HEALTH_FETCH_FAILED", "Health endpoint fetch failed.");
  } finally {
    clearTimeout(timer);
  }
}

function addCheck(checks, name, status, details = {}) {
  const check = { name, status, passed: status === "passed" || status === "skipped", ...details };
  if (check.code && !check.nextAction) {
    check.nextAction = nextActionForCode(check.code);
  }
  checks.push(check);
}

function safeCommandAvailable(command, checker = commandAvailable) {
  try {
    return Boolean(checker(command));
  } catch {
    return false;
  }
}

function safeDownloaderAvailable(command, checker = downloaderAvailable) {
  try {
    return Boolean(checker(command));
  } catch {
    return false;
  }
}

function safeDownloaderVersion(command, checker = downloaderVersion) {
  try {
    const result = checker(command);
    return {
      available: Boolean(result && result.available),
      version: typeof result?.version === "string" ? result.version : null,
    };
  } catch {
    return { available: false, version: null };
  }
}

function summarizeStorage(storage) {
  const staging = storage.staging || {};
  const tmp = storage.tmp || {};
  const artifacts = storage.artifacts || {};
  return {
    stagingReady: Boolean(staging.exists && staging.readable && staging.writable),
    tmpReady: Boolean(tmp.exists && tmp.readable && tmp.writable),
    artifactsReady: Boolean(artifacts.exists && artifacts.readable && artifacts.writable),
  };
}

function safeReport(summary) {
  const leak = findSensitiveLeak(summary);
  if (!leak) return summary;
  return {
    ok: false,
    status: "failed",
    code: "YOUTUBE_DOCTOR_SUMMARY_LEAK",
    message: "YouTube ingest doctor summary contains sensitive data.",
    leakCode: leak.code,
    leakPath: leak.path,
  };
}

async function checkYouTubeIngest(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const checks = [];
  const enabled = boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED"));
  const sourceCacheEnabled = boolFromEnv(rawValue(env, "SHORTSENGINE_SOURCE_CACHE_ENABLED")) ||
    (CONFIG.sourceCache && CONFIG.sourceCache.enabled === true);
  const sourceCacheRequireChecksum = boolFromEnv(rawValue(env, "SHORTSENGINE_SOURCE_CACHE_REQUIRE_CHECKSUM")) ||
    (CONFIG.sourceCache && CONFIG.sourceCache.requireChecksum === true);
  const downloaderBin = String(rawValue(env, "SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN") || CONFIG.youtubeIngest.downloaderBin || "yt-dlp").trim();
  const healthUrl = String(rawValue(env, "SHORTSENGINE_YOUTUBE_DOCTOR_URL") || "").trim();
  const healthTimeoutMs = parseInteger(
    rawValue(env, "SHORTSENGINE_YOUTUBE_DOCTOR_TIMEOUT_MS"),
    DEFAULT_HEALTH_TIMEOUT_MS,
    1000,
    120000,
    "YOUTUBE_DOCTOR_TIMEOUT_INVALID",
  );

  addCheck(checks, "youtube_ingest_flag", enabled ? "passed" : "skipped", {
    code: enabled ? null : "YOUTUBE_INGEST_DISABLED",
  });
  addCheck(checks, "source_cache_configured", sourceCacheEnabled ? "passed" : "skipped", {
    code: sourceCacheEnabled ? null : "SOURCE_CACHE_MISS",
    nextAction: sourceCacheEnabled ? null : "enable-source-cache-only-for-operator-approved-local-source-proof",
  });

  const ffmpegReady = safeCommandAvailable(CONFIG.ffmpegBin, options.commandAvailable);
  const ffprobeReady = safeCommandAvailable(CONFIG.ffprobeBin, options.commandAvailable);
  addCheck(checks, "ffmpeg_available", ffmpegReady ? "passed" : "failed", { code: ffmpegReady ? null : "FFMPEG_MISSING" });
  addCheck(checks, "ffprobe_available", ffprobeReady ? "passed" : "failed", { code: ffprobeReady ? null : "FFPROBE_MISSING" });

  const storage = summarizeStorage(options.storageHealth ? options.storageHealth() : storageHealth());
  addCheck(checks, "storage_staging_ready", storage.stagingReady ? "passed" : "failed", {
    code: storage.stagingReady ? null : "YOUTUBE_STAGING_STORAGE_UNAVAILABLE",
  });

  let downloaderConfigured = false;
  let versionSummary = { available: false, version: null };
  if (enabled) {
    downloaderConfigured = safeDownloaderAvailable(downloaderBin, options.downloaderAvailable);
    versionSummary = downloaderConfigured
      ? safeDownloaderVersion(downloaderBin, options.downloaderVersion)
      : { available: false, version: null };
    addCheck(checks, "downloader_available", downloaderConfigured ? "passed" : sourceCacheEnabled ? "skipped" : "failed", {
      code: downloaderConfigured ? null : sourceCacheEnabled ? "SOURCE_CACHE_MISS" : "YOUTUBE_DOWNLOADER_MISSING",
      nextAction: downloaderConfigured
        ? null
        : sourceCacheEnabled
          ? "place-rights-cleared-source-in-cache-or-configure-downloader-fallback"
          : undefined,
    });
  } else {
    addCheck(checks, "downloader_available", "skipped", {
      code: "YOUTUBE_INGEST_DISABLED",
      nextAction: "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1-before-checking-downloader",
    });
  }

  let serverHealth = { checked: false };
  if (healthUrl) {
    const target = safeTargetSummary(healthUrl);
    try {
      serverHealth = {
        checked: true,
        target,
        summary: await fetchHealthSummary(options.fetchImpl || globalThis.fetch, healthUrlFor(healthUrl), healthTimeoutMs),
      };
      addCheck(checks, "server_health_youtube_ingest_shape", "passed");
    } catch (error) {
      const code = error && error.code ? error.code : "YOUTUBE_DOCTOR_HEALTH_FETCH_FAILED";
      serverHealth = {
        checked: true,
        target,
        status: "failed",
        code,
        nextAction: nextActionForCode(code),
      };
      addCheck(checks, "server_health_youtube_ingest_shape", "failed", { code });
    }
  } else {
    addCheck(checks, "server_health_youtube_ingest_shape", "skipped", {
      code: "YOUTUBE_DOCTOR_HEALTH_URL_NOT_CONFIGURED",
      nextAction: "set-SHORTSENGINE_YOUTUBE_DOCTOR_URL-to-check-live-/health",
    });
  }

  const failed = checks.filter((check) => check.status === "failed");
  const disabled = !enabled;
  const formatStrategy = formatStrategySummary({
    ...CONFIG.youtubeIngest,
    formatSelector: rawValue(env, "SHORTSENGINE_YOUTUBE_FORMAT_SELECTOR") || CONFIG.youtubeIngest.formatSelector,
    fallbackFormatSelector: rawValue(env, "SHORTSENGINE_YOUTUBE_FALLBACK_FORMAT_SELECTOR") ||
      CONFIG.youtubeIngest.fallbackFormatSelector,
    downloadAttempts: rawValue(env, "SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS") ||
      CONFIG.youtubeIngest.downloadAttempts,
    timeoutMs: rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS") || CONFIG.youtubeIngest.timeoutMs,
    playerClient: rawValue(env, "SHORTSENGINE_YOUTUBE_PLAYER_CLIENT") || CONFIG.youtubeIngest.playerClient,
  });
  const summary = {
    ok: disabled ? true : failed.length === 0,
    status: disabled ? "skipped" : failed.length === 0 ? "passed" : "failed",
    code: disabled ? "YOUTUBE_INGEST_DISABLED" : failed[0]?.code || null,
    checkedAt: new Date(nowMs).toISOString(),
    durationMs: 0,
    youtubeIngest: {
      enabled,
      mode: enabled ? "local" : "mock",
      downloaderConfigured,
      downloaderVersion: versionSummary.version,
      ingestAvailable: Boolean(enabled && (downloaderConfigured || sourceCacheEnabled) && ffmpegReady && ffprobeReady && storage.stagingReady),
      defaultDisabled: !enabled,
      formatStrategy,
      sourceCache: {
        enabled: sourceCacheEnabled,
        configured: sourceCacheEnabled,
        networkCalls: false,
        requireChecksum: sourceCacheRequireChecksum,
      },
    },
    ffmpeg: {
      ffmpeg: ffmpegReady,
      ffprobe: ffprobeReady,
    },
    storage,
    serverHealth,
    checks,
    nextAction: disabled
      ? "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1-and-configure-downloader-for-real-ingest"
      : failed[0]?.nextAction || (failed.length ? "fix-failed-youtube-doctor-checks" : "run-npm-run-youtube-smoke-with-explicit-manual-flags"),
  };
  return safeReport(summary);
}

function safeError(error) {
  const code = error && error.code ? error.code : "YOUTUBE_DOCTOR_FAILED";
  const message = error && error.message ? error.message : "YouTube ingest doctor failed.";
  return safeReport({
    ok: false,
    status: "failed",
    code,
    message,
    nextAction: nextActionForCode(code),
  });
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const started = Date.now();
    const result = await checkYouTubeIngest();
    result.durationMs = Date.now() - started;
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  MAX_HEALTH_RESPONSE_BYTES,
  YouTubeDoctorError,
  checkYouTubeIngest,
  readBoundedResponseText,
  safeError,
  validateHealthYoutubeShape,
};
