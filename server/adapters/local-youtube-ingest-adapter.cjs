const { execFile, spawnSync } = require("node:child_process");
const { statSync } = require("node:fs");
const { basename } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath } = require("../storage.cjs");
const {
  metadataWarningFromFailure,
  toSafeYouTubeDownloaderError,
} = require("../youtube-downloader-errors.cjs");

const YOUTUBE_OUTPUT_FILE = "source.mp4";
const METADATA_TIMEOUT_MS = 15 * 1000;

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

function normalizePlayerClient(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["android", "ios", "web"].includes(text) ? text : "";
}

function youtubeExtractorArgs(config = {}) {
  const playerClient = normalizePlayerClient(config.playerClient);
  return playerClient ? ["--extractor-args", `youtube:player_client=${playerClient}`] : [];
}

function buildDownloaderArgs(source, outputPath, config = {}) {
  const safeSource = assertValidatedYouTubeSource(source);
  const safeOutputPath = validateDownloaderOutputPath(outputPath);
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
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
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
    return {
      ready: Boolean(config.enabled && configured),
      mode: "local",
      enabled: Boolean(config.enabled),
      networkCalls: Boolean(config.enabled),
      downloaderConfigured: configured,
      ingestAvailable: Boolean(config.enabled && configured),
      authorizedImportAvailable: false,
      playerClient: config.playerClient || null,
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
      const args = buildDownloaderArgs(source, outputPath, config);
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
  buildMetadataArgs,
  createLocalYouTubeIngestAdapter,
  downloaderAvailable,
  parseMetadataOutput,
  validateDownloaderOutputPath,
  youtubeExtractorArgs,
};
