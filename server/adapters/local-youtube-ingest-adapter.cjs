const { execFile, spawnSync } = require("node:child_process");
const { existsSync, readdirSync, rmSync, statSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath } = require("../storage.cjs");
const {
  metadataWarningFromFailure,
  toSafeYouTubeDownloaderError,
} = require("../youtube-downloader-errors.cjs");

const YOUTUBE_OUTPUT_FILE = "source.mp4";
const METADATA_TIMEOUT_MS = 15 * 1000;
const DEFAULT_FORMAT_SELECTOR = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best";
const DEFAULT_FALLBACK_FORMAT_SELECTOR = "best[ext=mp4]/best";

function downloaderAvailable(downloaderBin, spawnSyncImpl = spawnSync) {
  try {
    const result = spawnSyncImpl(downloaderBin, ["--version"], {
      stdio: "ignore",
      timeout: 2000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function downloaderVersion(downloaderBin, spawnSyncImpl = spawnSync) {
  try {
    const result = spawnSyncImpl(downloaderBin, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    const raw = result && result.status === 0 ? String(result.stdout || "").trim() : "";
    return {
      available: Boolean(result && result.status === 0),
      version: raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80) || null,
    };
  } catch {
    return { available: false, version: null };
  }
}

function assertValidatedYouTubeSource(source) {
  if (
    !source ||
    source.sourceType !== "youtube" ||
    !/^[A-Za-z0-9_-]{11}$/.test(String(source.videoId || "")) ||
    source.canonicalUrl !== `https://www.youtube.com/watch?v=${source.videoId}`
  ) {
    throw new AppError("YOUTUBE_URL_INVALID", SAFE_MESSAGES.YOUTUBE_URL_INVALID, 400);
  }
  return source;
}

function validateDownloaderOutputPath(outputPath) {
  const safePath = assertStoragePath(outputPath, "staging");
  if (basename(safePath) !== YOUTUBE_OUTPUT_FILE) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return safePath;
}

function normalizePlayerClient(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["android", "ios", "web"].includes(text) ? text : "";
}

function normalizeFormatSelector(value, fallback = DEFAULT_FORMAT_SELECTOR) {
  const selector = String(value || fallback).trim();
  return /^[A-Za-z0-9*+/\[\]=._:,-]{1,180}$/.test(selector) ? selector : fallback;
}

function youtubeExtractorArgs(config = {}) {
  const playerClient = normalizePlayerClient(config.playerClient);
  return playerClient ? ["--extractor-args", `youtube:player_client=${playerClient}`] : [];
}

function formatStrategySummary(config = {}) {
  const formatSelector = normalizeFormatSelector(config.formatSelector, DEFAULT_FORMAT_SELECTOR);
  const fallbackFormatSelector = normalizeFormatSelector(config.fallbackFormatSelector, DEFAULT_FALLBACK_FORMAT_SELECTOR);
  return {
    formatSelector,
    fallbackFormatSelector,
    attemptsConfigured: Math.max(1, Math.min(Number(config.downloadAttempts) || 1, 4)),
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : null,
    playerClient: normalizePlayerClient(config.playerClient) || null,
  };
}

function buildDownloaderArgs(source, outputPath, config = {}, attempt = {}) {
  const safeSource = assertValidatedYouTubeSource(source);
  const safeOutputPath = validateDownloaderOutputPath(outputPath);
  const formatSelector = normalizeFormatSelector(attempt.formatSelector || config.formatSelector, DEFAULT_FORMAT_SELECTOR);
  return [
    "--no-playlist",
    "--no-warnings",
    ...youtubeExtractorArgs(config),
    "--restrict-filenames",
    "--merge-output-format",
    "mp4",
    "--recode-video",
    "mp4",
    "--format",
    formatSelector,
    "--output",
    safeOutputPath,
    safeSource.canonicalUrl,
  ];
}

function buildMetadataArgs(source, config = {}) {
  const safeSource = assertValidatedYouTubeSource(source);
  return [
    "--no-playlist",
    "--no-warnings",
    ...youtubeExtractorArgs(config),
    "--skip-download",
    "--print",
    "title:%(title)s",
    "--print",
    "duration:%(duration)s",
    safeSource.canonicalUrl,
  ];
}

function execFileSafe(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        if (stdout !== undefined) error.stdout = stdout;
        if (stderr !== undefined) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function toDownloaderError(error) {
  return toSafeYouTubeDownloaderError(error);
}

function delay(ms) {
  const safeMs = Math.max(0, Math.min(Number(ms) || 0, 10_000));
  if (safeMs <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => setTimeout(resolveDelay, safeMs));
}

function removePartialOutputs(outputPath) {
  const safePath = validateDownloaderOutputPath(outputPath);
  const stageDir = dirname(safePath);
  const safeBaseName = basename(safePath);
  let removedCount = 0;
  const removeCandidate = (candidatePath) => {
    try {
      assertStoragePath(candidatePath, "staging");
      if (!existsSync(candidatePath)) return;
      rmSync(candidatePath, { force: true });
      removedCount += 1;
    } catch {
      // Best effort only. The validation boundary still rejects stale or invalid output.
    }
  };
  removeCandidate(safePath);
  try {
    for (const entry of readdirSync(stageDir)) {
      if (
        entry === safeBaseName ||
        entry.startsWith("source.") ||
        entry.endsWith(".part") ||
        entry.endsWith(".tmp") ||
        entry.endsWith(".ytdl")
      ) {
        removeCandidate(join(stageDir, entry));
      }
    }
  } catch {
    // Best effort only. The validation boundary still rejects stale or invalid output.
  }
  return { cleaned: true, removedCount };
}

function buildDownloadAttempts(config = {}) {
  const strategy = formatStrategySummary(config);
  const attempts = [];
  for (let index = 0; index < strategy.attemptsConfigured; index += 1) {
    const fallbackUsed = index > 0 && strategy.fallbackFormatSelector !== strategy.formatSelector;
    attempts.push({
      attempt: index + 1,
      formatSelector: fallbackUsed ? strategy.fallbackFormatSelector : strategy.formatSelector,
      fallbackUsed,
    });
  }
  return attempts;
}

function attachDownloaderDetails(error, details = {}) {
  if (!error || typeof error !== "object") return error;
  error.details = {
    ...(error.details || {}),
    phase: details.phase || "ingest",
    step: details.step || "download_source",
    substep: details.substep || "youtube_downloader",
    elapsedMs: details.elapsedMs,
    attempts: details.attempts,
    attemptsConfigured: details.attemptsConfigured,
    timeoutMs: details.timeoutMs,
    formatSelector: details.formatSelector,
    fallbackFormatSelector: details.fallbackFormatSelector,
    fallbackUsed: details.fallbackUsed === true,
    playerClient: details.playerClient || "",
    partialCleanupSucceeded: details.partialCleanupSucceeded !== false,
    partialCleanupRemovedCount: details.partialCleanupRemovedCount,
  };
  return error;
}

function shouldRetryDownload(error, hasNextAttempt) {
  if (!hasNextAttempt || !error || typeof error !== "object") return false;
  return error.code === "YOUTUBE_FORMAT_UNAVAILABLE" || Boolean(error.details && error.details.retryable);
}

function safeMetadataTitle(value) {
  const title = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return title || null;
}

function parseMetadataOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const parsed = {};
  for (const line of lines) {
    if (line.startsWith("title:")) parsed.title = line.slice("title:".length);
    if (line.startsWith("duration:")) parsed.durationSeconds = Number(line.slice("duration:".length));
  }
  return {
    title: safeMetadataTitle(parsed.title),
    durationSeconds: Number.isFinite(parsed.durationSeconds) && parsed.durationSeconds > 0
      ? parsed.durationSeconds
      : null,
  };
}

function createLocalYouTubeIngestAdapter(options = {}) {
  const config = options.config || CONFIG.youtubeIngest;
  const execFileImpl = options.execFile || execFile;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const downloaderBin = config.downloaderBin;

  function health() {
    const configured = downloaderAvailable(downloaderBin, spawnSyncImpl);
    const version = configured ? downloaderVersion(downloaderBin, spawnSyncImpl).version : null;
    const formatStrategy = formatStrategySummary(config);
    return {
      ready: Boolean(config.enabled && configured),
      mode: "local",
      enabled: Boolean(config.enabled),
      networkCalls: Boolean(config.enabled),
      downloaderConfigured: configured,
      downloaderVersion: version,
      ingestAvailable: Boolean(config.enabled && configured),
      authorizedImportAvailable: false,
      playerClient: formatStrategy.playerClient,
      formatStrategy,
    };
  }

  return {
    mode: "local",
    enabled: Boolean(config.enabled),
    networkCalls: Boolean(config.enabled),
    get downloaderConfigured() {
      return downloaderAvailable(downloaderBin, spawnSyncImpl);
    },
    async getMetadata(source) {
      assertValidatedYouTubeSource(source);
      const currentHealth = health();
      if (!currentHealth.ingestAvailable) {
        return {
          title: null,
          durationSeconds: null,
          metadataStatus: "downloader-unavailable",
          ingestAvailable: false,
        };
      }
      try {
        const result = await execFileSafe(execFileImpl, downloaderBin, buildMetadataArgs(source, config), {
          timeout: Math.min(config.timeoutMs, METADATA_TIMEOUT_MS),
          maxBuffer: config.maxOutputBytes,
          windowsHide: true,
        });
        const metadata = parseMetadataOutput(result.stdout);
        return {
          ...metadata,
          metadataStatus: metadata.title || metadata.durationSeconds ? "local" : "local-unavailable",
          ingestAvailable: true,
        };
      } catch (error) {
        const warning = metadataWarningFromFailure(error);
        if (warning) return warning;
        return {
          title: null,
          durationSeconds: null,
          metadataStatus: "local-unavailable",
          ingestAvailable: true,
        };
      }
    },
    async ingest(source, options = {}) {
      assertValidatedYouTubeSource(source);
      const outputPath = validateDownloaderOutputPath(options.outputPath);
      if (!config.enabled) {
        throw new AppError("YOUTUBE_INGEST_NOT_ENABLED", SAFE_MESSAGES.YOUTUBE_INGEST_NOT_ENABLED, 503);
      }
      if (!downloaderAvailable(downloaderBin, spawnSyncImpl)) {
        throw new AppError("YOUTUBE_DOWNLOADER_MISSING", SAFE_MESSAGES.YOUTUBE_DOWNLOADER_MISSING, 503, {
          reason: "downloader_unavailable",
        });
      }
      const startedAt = Date.now();
      const attempts = buildDownloadAttempts(config);
      const strategy = formatStrategySummary(config);
      let finalAttempt = attempts[0];
      let lastError = null;
      for (const attempt of attempts) {
        finalAttempt = attempt;
        removePartialOutputs(outputPath);
        const attemptStartedAt = Date.now();
        const args = buildDownloaderArgs(source, outputPath, config, attempt);
        try {
          await execFileSafe(execFileImpl, downloaderBin, args, {
            timeout: config.timeoutMs,
            maxBuffer: config.maxOutputBytes,
            windowsHide: true,
            signal: options.signal,
          });
          lastError = null;
          break;
        } catch (error) {
          const cleanup = removePartialOutputs(outputPath);
          const safeError = attachDownloaderDetails(toDownloaderError(error), {
            phase: "ingest",
            step: "download_source",
            substep: "youtube_downloader",
            elapsedMs: Date.now() - attemptStartedAt,
            attempts: attempt.attempt,
            attemptsConfigured: strategy.attemptsConfigured,
            timeoutMs: strategy.timeoutMs,
            formatSelector: attempt.formatSelector,
            fallbackFormatSelector: strategy.fallbackFormatSelector,
            fallbackUsed: attempt.fallbackUsed,
            playerClient: strategy.playerClient || "",
            partialCleanupSucceeded: cleanup.cleaned === true,
            partialCleanupRemovedCount: cleanup.removedCount,
          });
          lastError = safeError;
          if (!shouldRetryDownload(safeError, attempt.attempt < attempts.length)) break;
          await delay(config.retryBackoffMs);
        }
      }
      if (lastError) {
        throw lastError;
      }
      let size = 0;
      try {
        size = statSync(outputPath).size;
      } catch {
        throw new AppError("YOUTUBE_OUTPUT_INVALID", SAFE_MESSAGES.YOUTUBE_OUTPUT_INVALID, 502, {
          phase: "ingest",
          step: "download_validate_signature",
          substep: "downloaded_file_stat",
          elapsedMs: Date.now() - startedAt,
          retryable: true,
          nextAction: "retry-ingest-or-check-downloader-output-format",
          attempts: finalAttempt.attempt,
          attemptsConfigured: strategy.attemptsConfigured,
          timeoutMs: strategy.timeoutMs,
          formatSelector: finalAttempt.formatSelector,
          fallbackFormatSelector: strategy.fallbackFormatSelector,
          fallbackUsed: finalAttempt.fallbackUsed,
          playerClient: strategy.playerClient || "",
          partialCleanupSucceeded: true,
        });
      }
      return {
        outputPath,
        size,
        durationMs: Date.now() - startedAt,
        attempts: finalAttempt.attempt,
        formatSelector: finalAttempt.formatSelector,
        fallbackUsed: finalAttempt.fallbackUsed,
        timeoutMs: strategy.timeoutMs,
        attemptsConfigured: strategy.attemptsConfigured,
        fallbackFormatSelector: strategy.fallbackFormatSelector,
        playerClient: strategy.playerClient || "",
      };
    },
    buildDownloaderArgs,
    formatStrategySummary,
    health,
  };
}

module.exports = {
  YOUTUBE_OUTPUT_FILE,
  buildDownloaderArgs,
  buildMetadataArgs,
  createLocalYouTubeIngestAdapter,
  downloaderAvailable,
  downloaderVersion,
  formatStrategySummary,
  parseMetadataOutput,
  validateDownloaderOutputPath,
  youtubeExtractorArgs,
};
