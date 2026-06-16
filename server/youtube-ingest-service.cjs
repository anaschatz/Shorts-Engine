const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const { isAbsolute, relative } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { probeMedia, sanitizeText, sha256, validateUploadCandidate } = require("./media.cjs");
const { assertStoragePath, safeResolve } = require("./storage.cjs");
const { validateYouTubeSource, youtubeIngestHealth } = require("./youtube-ingest.cjs");

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logError(logger, payload) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(JSON.stringify(redactForLogs({ level: "error", ...payload })));
}

function readFileHeader(filePath, byteLength = 32) {
  const safePath = assertStoragePath(filePath, "staging");
  const fd = openSync(safePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(Number(byteLength) || 32, 4096)));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function createYouTubeStagePaths(uploadId) {
  const safeUploadId = String(uploadId || "");
  if (!/^upl_[A-Za-z0-9-]{8,80}$/.test(safeUploadId)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  const stageDir = safeResolve(CONFIG.stagingDir, `youtube/${safeUploadId}`);
  const outputPath = safeResolve(stageDir, "source.mp4");
  assertStoragePath(outputPath, "staging");
  return { stageDir, outputPath };
}

function assertYouTubeStageDir(stageDir) {
  const safeDir = assertStoragePath(stageDir, "staging");
  const fromStaging = relative(CONFIG.stagingDir, safeDir);
  if (
    !fromStaging ||
    isAbsolute(fromStaging) ||
    fromStaging.startsWith("..") ||
    !fromStaging.startsWith("youtube/")
  ) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return safeDir;
}

function cleanupYouTubeStage(stageDir) {
  if (!stageDir) return { cleaned: false };
  try {
    rmSync(assertYouTubeStageDir(stageDir), { recursive: true, force: true });
    return { cleaned: true };
  } catch {
    return { cleaned: false };
  }
}

function assertDownloadedFile(outputPath, deps) {
  const safePath = assertStoragePath(outputPath, "staging");
  if (!existsSync(safePath)) {
    throw new AppError("FILE_TOO_SMALL", SAFE_MESSAGES.FILE_TOO_SMALL, 400);
  }
  const fileStat = statSync(safePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new AppError("FILE_TOO_SMALL", SAFE_MESSAGES.FILE_TOO_SMALL, 400);
  }
  if (fileStat.size > CONFIG.maxUploadBytes) {
    throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
  }
  const header = deps.readFileHeader(safePath);
  return { safePath, size: fileStat.size, header };
}

function publicSourceSummary(source, metadata) {
  return {
    sourceType: "youtube",
    kind: source.kind,
    videoId: source.videoId,
    canonicalUrl: source.canonicalUrl,
    title: source.title || null,
    durationSeconds: metadata.durationSeconds,
    ingestAvailable: true,
  };
}

function createDefaultDependencies(overrides = {}) {
  return {
    artifactStore: overrides.artifactStore,
    logger: overrides.logger || console,
    persistenceAdapter: overrides.persistenceAdapter,
    probeMedia: overrides.probeMedia || probeMedia,
    readFileHeader: overrides.readFileHeader || readFileHeader,
    sha256: overrides.sha256 || sha256,
    validateUploadCandidate: overrides.validateUploadCandidate || validateUploadCandidate,
  };
}

function createYouTubeIngestService(options = {}) {
  const adapter = options.adapter;
  const deps = createDefaultDependencies(options.dependencies || {});
  if (!adapter || typeof adapter.ingest !== "function") {
    throw new AppError("YOUTUBE_INGEST_NOT_ENABLED", SAFE_MESSAGES.YOUTUBE_INGEST_NOT_ENABLED, 503);
  }
  if (!deps.artifactStore || !deps.persistenceAdapter) {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }

  async function ingest(input = {}) {
    const requestId = sanitizeText(input.requestId || "", 120);
    const source = await validateYouTubeSource({
      url: input.url,
      rightsConfirmed: input.rightsConfirmed,
      adapter,
      maxDurationSeconds: CONFIG.maxDurationSeconds,
    });
    const health = youtubeIngestHealth(adapter);
    if (!health.enabled) {
      throw new AppError("YOUTUBE_INGEST_NOT_ENABLED", SAFE_MESSAGES.YOUTUBE_INGEST_NOT_ENABLED, 503);
    }
    if (!health.downloaderConfigured) {
      throw new AppError("YOUTUBE_DOWNLOADER_MISSING", SAFE_MESSAGES.YOUTUBE_DOWNLOADER_MISSING, 503);
    }

    const uploadId = `upl_${randomUUID()}`;
    const projectId = `prj_${randomUUID()}`;
    const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
    mkdirSync(stageDir, { recursive: true });
    logInfo(deps.logger, {
      event: "youtube_ingest_step",
      requestId,
      sourceType: "youtube",
      videoId: source.videoId,
      uploadId,
      projectId,
      step: "download_staging",
    });

    try {
      await adapter.ingest(source, { outputPath, signal: input.signal });
      const downloaded = assertDownloadedFile(outputPath, deps);
      const validated = deps.validateUploadCandidate({
        fileName: `${source.videoId}.mp4`,
        mimeType: "video/mp4",
        size: downloaded.size,
        buffer: downloaded.header,
      });
      const metadata = await deps.probeMedia(downloaded.safePath);
      const checksumSha256 = deps.sha256(downloaded.safePath);
      const uploadArtifact = await deps.artifactStore.streamLocalPathToArtifact(downloaded.safePath, {
        id: uploadId,
        type: "upload",
        ownerProjectId: projectId,
        storageKey: `${uploadId}.${validated.extension}`,
        size: validated.size,
        contentType: validated.mimeType || "video/mp4",
        checksumSha256,
        status: "available",
      });
      const title = sanitizeText(input.title || source.title || "YouTube Short", 120) || "YouTube Short";
      const createdAt = new Date().toISOString();
      const { project, upload } = deps.persistenceAdapter.createProjectUpload({
        upload: {
          id: uploadId,
          projectId,
          artifact: uploadArtifact,
          storageKey: uploadArtifact.storageKey,
          originalFilename: validated.safeName,
          mimeType: validated.mimeType || "video/mp4",
          extension: validated.extension,
          container: validated.container,
          byteSize: validated.size,
          checksumSha256,
          metadata: {
            ...metadata,
            sourceType: "youtube",
            videoId: source.videoId,
            title: source.title || null,
          },
          source: null,
          createdAt,
        },
        project: {
          id: projectId,
          uploadId,
          title,
          status: "draft",
          source: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      logInfo(deps.logger, {
        event: "youtube_ingest_step",
        requestId,
        sourceType: "youtube",
        videoId: source.videoId,
        uploadId,
        projectId,
        step: "artifact_committed",
        duration: metadata.durationSeconds,
      });
      return {
        upload: deps.persistenceAdapter.publicUpload(upload),
        project: deps.persistenceAdapter.publicProject(project),
        source: publicSourceSummary(source, metadata),
      };
    } catch (error) {
      logError(deps.logger, {
        event: "youtube_ingest_failed",
        requestId,
        sourceType: "youtube",
        videoId: source.videoId,
        uploadId,
        projectId,
        code: error && error.code ? error.code : "UNEXPECTED",
      });
      throw error;
    } finally {
      cleanupYouTubeStage(stageDir);
    }
  }

  return { ingest };
}

module.exports = {
  assertDownloadedFile,
  cleanupYouTubeStage,
  createYouTubeIngestService,
  createYouTubeStagePaths,
  readFileHeader,
};
