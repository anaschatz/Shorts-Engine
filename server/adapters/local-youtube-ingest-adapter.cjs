const { execFile, spawnSync } = require("node:child_process");
const { statSync } = require("node:fs");
const { basename } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath } = require("../storage.cjs");

const YOUTUBE_OUTPUT_FILE = "source.mp4";

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

function buildDownloaderArgs(source, outputPath) {
  const safeSource = assertValidatedYouTubeSource(source);
  const safeOutputPath = validateDownloaderOutputPath(outputPath);
  return [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--merge-output-format",
    "mp4",
    "--recode-video",
    "mp4",
    "--format",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
    "--output",
    safeOutputPath,
    safeSource.canonicalUrl,
  ];
}

function execFileSafe(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function toDownloaderError(error) {
  if (error && (error.code === "ENOENT" || error.code === "EACCES")) {
    return new AppError("YOUTUBE_DOWNLOADER_MISSING", SAFE_MESSAGES.YOUTUBE_DOWNLOADER_MISSING, 503, {
      reason: "downloader_unavailable",
    });
  }
  if (error && (error.killed || error.signal || error.code === "ETIMEDOUT")) {
    return new AppError("YOUTUBE_DOWNLOAD_TIMEOUT", SAFE_MESSAGES.YOUTUBE_DOWNLOAD_TIMEOUT, 504, {
      reason: "timeout",
    });
  }
  return new AppError("YOUTUBE_DOWNLOAD_FAILED", SAFE_MESSAGES.YOUTUBE_DOWNLOAD_FAILED, 502, {
    reason: "download_failed",
  });
}

function createLocalYouTubeIngestAdapter(options = {}) {
  const config = options.config || CONFIG.youtubeIngest;
  const execFileImpl = options.execFile || execFile;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const downloaderBin = config.downloaderBin;

  function health() {
    const configured = downloaderAvailable(downloaderBin, spawnSyncImpl);
    return {
      ready: Boolean(config.enabled && configured),
      mode: "local",
      enabled: Boolean(config.enabled),
      networkCalls: Boolean(config.enabled),
      downloaderConfigured: configured,
      ingestAvailable: Boolean(config.enabled && configured),
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
      return {
        title: null,
        durationSeconds: null,
        metadataStatus: currentHealth.ingestAvailable ? "local-deferred" : "downloader-unavailable",
        ingestAvailable: currentHealth.ingestAvailable,
      };
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
      const args = buildDownloaderArgs(source, outputPath);
      const startedAt = Date.now();
      try {
        await execFileSafe(execFileImpl, downloaderBin, args, {
          timeout: config.timeoutMs,
          maxBuffer: config.maxOutputBytes,
          windowsHide: true,
          signal: options.signal,
        });
      } catch (error) {
        throw toDownloaderError(error);
      }
      let size = 0;
      try {
        size = statSync(outputPath).size;
      } catch {
        throw new AppError("FILE_TOO_SMALL", SAFE_MESSAGES.FILE_TOO_SMALL, 400);
      }
      return {
        outputPath,
        size,
        durationMs: Date.now() - startedAt,
      };
    },
    buildDownloaderArgs,
    health,
  };
}

module.exports = {
  YOUTUBE_OUTPUT_FILE,
  buildDownloaderArgs,
  createLocalYouTubeIngestAdapter,
  downloaderAvailable,
  validateDownloaderOutputPath,
};
