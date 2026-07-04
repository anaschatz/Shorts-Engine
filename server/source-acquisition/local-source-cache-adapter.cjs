const {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, isAbsolute, relative, resolve } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sha256, validateUploadCandidate } = require("../media.cjs");
const { assertStoragePath } = require("../storage.cjs");

const SOURCE_CACHE_FILE_EXTENSION = "mp4";

function isInside(baseDir, candidatePath) {
  const fromBase = relative(resolve(baseDir), resolve(candidatePath));
  return fromBase === "" || (!fromBase.startsWith("..") && !isAbsolute(fromBase));
}

function assertSourceCacheDir(cacheDir) {
  const safeDir = resolve(String(cacheDir || ""));
  if (!safeDir || (!isInside(CONFIG.dataDir, safeDir) && !isInside(tmpdir(), safeDir))) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403, {
      sourceAcquisitionStrategy: "cache",
      cacheChecked: true,
      cacheHit: false,
      cacheValidated: false,
      cacheFailureCode: "SOURCE_CACHE_DIR_INVALID",
      nextAction: "fix-source-cache-dir-configuration",
    });
  }
  return safeDir;
}

function sourceCacheKeyForVideoId(videoId) {
  const id = String(videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new AppError("YOUTUBE_URL_INVALID", SAFE_MESSAGES.YOUTUBE_URL_INVALID, 400);
  }
  return id;
}

function cacheFileNameForVideoId(videoId) {
  return `${sourceCacheKeyForVideoId(videoId)}.${SOURCE_CACHE_FILE_EXTENSION}`;
}

function checksumFileNameForVideoId(videoId) {
  return `${sourceCacheKeyForVideoId(videoId)}.sha256`;
}

function safeCachePath(cacheDir, fileName) {
  const safeDir = assertSourceCacheDir(cacheDir);
  const safeName = basename(String(fileName || ""));
  if (safeName !== fileName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const target = resolve(safeDir, safeName);
  if (!isInside(safeDir, target)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return target;
}

function readFileHeader(filePath, byteLength = 32) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(Number(byteLength) || 32, 4096)));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readExpectedChecksum(cacheDir, videoId) {
  const checksumPath = safeCachePath(cacheDir, checksumFileNameForVideoId(videoId));
  if (!existsSync(checksumPath)) return null;
  const text = readFileSync(checksumPath, "utf8");
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  return match ? match[0].toLowerCase() : null;
}

function safeSourceCacheFailure(code, details = {}) {
  const message = SAFE_MESSAGES[code] || SAFE_MESSAGES.SOURCE_CACHE_FILE_INVALID;
  return new AppError(code, message, code === "SOURCE_CACHE_MISS" ? 404 : 400, {
    sourceAcquisitionStrategy: "cache",
    cacheChecked: true,
    cacheHit: details.cacheHit === true,
    cacheValidated: false,
    cacheFailureCode: code,
    retryable: code === "SOURCE_CACHE_MISS",
    nextAction: details.nextAction || "place-rights-cleared-source-in-cache",
  });
}

function createLocalSourceCacheAdapter(options = {}) {
  const config = options.config || CONFIG.sourceCache;
  const deps = {
    sha256: options.dependencies?.sha256 || sha256,
    validateUploadCandidate: options.dependencies?.validateUploadCandidate || validateUploadCandidate,
  };

  function health() {
    return {
      ready: Boolean(config.enabled),
      mode: "source-cache",
      enabled: Boolean(config.enabled),
      networkCalls: false,
      cacheConfigured: Boolean(config.enabled),
      cacheAvailable: Boolean(config.enabled),
      requireChecksum: Boolean(config.requireChecksum),
    };
  }

  async function acquireSource(source, input = {}) {
    const videoId = sourceCacheKeyForVideoId(source && source.videoId);
    const outputPath = assertStoragePath(input.outputPath, "staging");
    if (!config.enabled) {
      throw safeSourceCacheFailure("SOURCE_CACHE_MISS", {
        cacheHit: false,
        nextAction: "enable-source-cache-or-use-downloader",
      });
    }
    const cachePath = safeCachePath(config.dir, cacheFileNameForVideoId(videoId));
    if (!existsSync(cachePath)) {
      throw safeSourceCacheFailure("SOURCE_CACHE_MISS", {
        cacheHit: false,
        nextAction: "place-rights-cleared-source-in-cache",
      });
    }
    let stats;
    try {
      stats = statSync(cachePath);
    } catch {
      throw safeSourceCacheFailure("SOURCE_CACHE_FILE_INVALID", {
        cacheHit: true,
        nextAction: "replace-invalid-source-cache-file",
      });
    }
    if (!stats.isFile() || stats.size <= 0) {
      throw safeSourceCacheFailure("SOURCE_CACHE_FILE_INVALID", {
        cacheHit: true,
        nextAction: "replace-empty-source-cache-file",
      });
    }
    if (stats.size > Math.min(config.maxBytes, CONFIG.maxUploadBytes)) {
      throw safeSourceCacheFailure("FILE_TOO_LARGE", {
        cacheHit: true,
        nextAction: "use-smaller-authorized-source",
      });
    }
    const checksumSha256 = deps.sha256(cachePath);
    if (config.requireChecksum) {
      const expected = readExpectedChecksum(config.dir, videoId);
      if (!expected || expected !== checksumSha256) {
        throw safeSourceCacheFailure("SOURCE_CACHE_CHECKSUM_MISMATCH", {
          cacheHit: true,
          nextAction: "fix-cache-metadata-or-checksum",
        });
      }
    }
    try {
      deps.validateUploadCandidate({
        fileName: cacheFileNameForVideoId(videoId),
        mimeType: "video/mp4",
        size: stats.size,
        buffer: readFileHeader(cachePath),
      });
    } catch (error) {
      throw safeSourceCacheFailure(error.code || "SOURCE_CACHE_FILE_INVALID", {
        cacheHit: true,
        nextAction: "replace-invalid-source-cache-file",
      });
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(cachePath, outputPath);
    return {
      outputPath,
      size: stats.size,
      checksumSha256,
      sourceAcquisitionStrategy: "cache",
      cacheChecked: true,
      cacheHit: true,
      cacheValidated: true,
      cacheFailureCode: null,
      downloaderFallbackUsed: false,
      formatSelector: null,
      fallbackFormatSelector: null,
      fallbackUsed: false,
      attempts: 0,
      attemptsConfigured: 0,
      timeoutMs: null,
      providerMode: "source-cache",
    };
  }

  return {
    mode: "source-cache",
    enabled: Boolean(config.enabled),
    networkCalls: false,
    acquireSource,
    health,
  };
}

module.exports = {
  SOURCE_CACHE_FILE_EXTENSION,
  cacheFileNameForVideoId,
  checksumFileNameForVideoId,
  createLocalSourceCacheAdapter,
  sourceCacheKeyForVideoId,
};
