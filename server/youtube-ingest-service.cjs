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
const { normalizeOwnerId } = require("./auth.cjs");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { probeMedia, sanitizeText, sha256, validateUploadCandidate } = require("./media.cjs");
const { createLocalSourceCacheAdapter } = require("./source-acquisition/local-source-cache-adapter.cjs");
const { createSourceAcquisitionService } = require("./source-acquisition/source-acquisition-service.cjs");
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

function safeDownloaderFailureDetails(error) {
  const details = error && error.details && typeof error.details === "object" ? error.details : {};
  return {
    phase: typeof details.phase === "string" ? sanitizeText(details.phase, 40) : null,
    step: typeof details.step === "string" ? sanitizeText(details.step, 80) : null,
    substep: typeof details.substep === "string" ? sanitizeText(details.substep, 80) : null,
    elapsedMs: Number.isFinite(Number(details.elapsedMs)) ? Number(details.elapsedMs) : null,
    retryable: details.retryable === true,
    authorizedImportRequired: details.authorizedImportRequired === true,
    attempts: Number.isFinite(Number(details.attempts)) ? Number(details.attempts) : null,
    attemptsConfigured: Number.isFinite(Number(details.attemptsConfigured)) ? Number(details.attemptsConfigured) : null,
    timeoutMs: Number.isFinite(Number(details.timeoutMs)) ? Number(details.timeoutMs) : null,
    formatSelector: typeof details.formatSelector === "string" ? details.formatSelector : null,
    fallbackFormatSelector: typeof details.fallbackFormatSelector === "string" ? details.fallbackFormatSelector : null,
    fallbackUsed: details.fallbackUsed === true,
    playerClient: typeof details.playerClient === "string" ? details.playerClient || null : null,
    partialCleanupSucceeded: typeof details.partialCleanupSucceeded === "boolean" ? details.partialCleanupSucceeded : null,
    partialCleanupRemovedCount: Number.isFinite(Number(details.partialCleanupRemovedCount))
      ? Number(details.partialCleanupRemovedCount)
      : null,
    cleanupSucceeded: typeof details.cleanupSucceeded === "boolean" ? details.cleanupSucceeded : null,
    sourceAcquisitionStatus: typeof details.sourceAcquisitionStatus === "string"
      ? sanitizeText(details.sourceAcquisitionStatus, 80)
      : null,
    sourceAcquisitionStrategy: typeof details.sourceAcquisitionStrategy === "string"
      ? sanitizeText(details.sourceAcquisitionStrategy, 80)
      : null,
    cacheChecked: typeof details.cacheChecked === "boolean" ? details.cacheChecked : null,
    cacheHit: typeof details.cacheHit === "boolean" ? details.cacheHit : null,
    cacheValidated: typeof details.cacheValidated === "boolean" ? details.cacheValidated : null,
    cacheFailureCode: typeof details.cacheFailureCode === "string" ? sanitizeText(details.cacheFailureCode, 80) : null,
    downloaderFallbackUsed: typeof details.downloaderFallbackUsed === "boolean" ? details.downloaderFallbackUsed : null,
    checksumSha256: typeof details.checksumSha256 === "string" && /^[a-f0-9]{64}$/.test(details.checksumSha256)
      ? details.checksumSha256
      : null,
    heartbeatIntervalMs: Number.isFinite(Number(details.heartbeatIntervalMs)) ? Number(details.heartbeatIntervalMs) : null,
    noProgressTimeoutMs: Number.isFinite(Number(details.noProgressTimeoutMs)) ? Number(details.noProgressTimeoutMs) : null,
    progressHeartbeatCount: Number.isFinite(Number(details.progressHeartbeatCount))
      ? Number(details.progressHeartbeatCount)
      : null,
    progressEventCount: Number.isFinite(Number(details.progressEventCount)) ? Number(details.progressEventCount) : null,
    progressBytesObserved: Number.isFinite(Number(details.progressBytesObserved))
      ? Number(details.progressBytesObserved)
      : null,
    lastProgressAgeMs: Number.isFinite(Number(details.lastProgressAgeMs)) ? Number(details.lastProgressAgeMs) : null,
    timeoutClassification: typeof details.timeoutClassification === "string"
      ? sanitizeText(details.timeoutClassification, 80)
      : null,
    bytesStillMovingAtTimeout: typeof details.bytesStillMovingAtTimeout === "boolean"
      ? details.bytesStillMovingAtTimeout
      : null,
    stallClassification: typeof details.stallClassification === "string"
      ? sanitizeText(details.stallClassification, 80)
      : null,
    continueEnabled: typeof details.continueEnabled === "boolean" ? details.continueEnabled : null,
    continueAttempted: typeof details.continueAttempted === "boolean" ? details.continueAttempted : null,
    resumableStateEnabled: typeof details.resumableStateEnabled === "boolean" ? details.resumableStateEnabled : null,
    resumeStateRetained: typeof details.resumeStateRetained === "boolean" ? details.resumeStateRetained : null,
    nextAction: typeof details.nextAction === "string" ? details.nextAction : null,
  };
}

function attachIngestFailureDetails(error, details = {}) {
  if (!error || typeof error !== "object") return error;
  const existing = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : {};
  error.details = {
    ...existing,
    phase: existing.phase || details.phase || "ingest",
    step: existing.step || details.step || "download_source",
    substep: existing.substep || details.substep || "youtube_downloader",
    elapsedMs: Number.isFinite(Number(existing.elapsedMs)) ? Number(existing.elapsedMs) : details.elapsedMs,
    metadataPreflightStatus: details.metadataPreflightStatus || existing.metadataPreflightStatus,
    metadataPreflightDurationSeconds: Number.isFinite(Number(details.metadataPreflightDurationSeconds))
      ? Number(details.metadataPreflightDurationSeconds)
      : existing.metadataPreflightDurationSeconds,
    downloadedOutputReady: details.downloadedOutputReady === true || existing.downloadedOutputReady === true,
    partialCleanupSucceeded: typeof existing.partialCleanupSucceeded === "boolean"
      ? existing.partialCleanupSucceeded
      : details.partialCleanupSucceeded,
    partialCleanupRemovedCount: Number.isFinite(Number(existing.partialCleanupRemovedCount))
      ? Number(existing.partialCleanupRemovedCount)
      : details.partialCleanupRemovedCount,
    cleanupSucceeded: details.cleanupSucceeded,
    sourceAcquisitionStatus: existing.sourceAcquisitionStatus || details.sourceAcquisitionStatus,
    sourceAcquisitionStrategy: existing.sourceAcquisitionStrategy || details.sourceAcquisitionStrategy,
    cacheChecked: typeof existing.cacheChecked === "boolean" ? existing.cacheChecked : details.cacheChecked,
    cacheHit: typeof existing.cacheHit === "boolean" ? existing.cacheHit : details.cacheHit,
    cacheValidated: typeof existing.cacheValidated === "boolean" ? existing.cacheValidated : details.cacheValidated,
    cacheFailureCode: existing.cacheFailureCode || details.cacheFailureCode,
    downloaderFallbackUsed: typeof existing.downloaderFallbackUsed === "boolean"
      ? existing.downloaderFallbackUsed
      : details.downloaderFallbackUsed,
    checksumSha256: existing.checksumSha256 || details.checksumSha256,
  };
  return error;
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
  const cacheAdapter = options.cacheAdapter || createLocalSourceCacheAdapter({
    config: CONFIG.sourceCache,
    dependencies: {
      sha256: deps.sha256,
      validateUploadCandidate: deps.validateUploadCandidate,
    },
  });
  const sourceAcquisition = createSourceAcquisitionService({ adapter, cacheAdapter, logger: deps.logger });

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
    const sourceCacheEnabled = CONFIG.sourceCache.enabled === true;
    if (!health.downloaderConfigured && !sourceCacheEnabled) {
      throw new AppError("YOUTUBE_DOWNLOADER_MISSING", SAFE_MESSAGES.YOUTUBE_DOWNLOADER_MISSING, 503);
    }

    const uploadId = `upl_${randomUUID()}`;
    const projectId = `prj_${randomUUID()}`;
    const ownerId = input.ownerId ? normalizeOwnerId(input.ownerId) : null;
    const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
    mkdirSync(stageDir, { recursive: true });
    const ingestStartedAt = Date.now();
    let activeStep = "metadata_preflight";
    let activeSubstep = "source_metadata";
    let stageCleaned = false;
    let acquisitionCompleted = false;
    let acquisitionSummary = null;
    logInfo(deps.logger, {
      event: "youtube_ingest_step",
      requestId,
      sourceType: "youtube",
      videoId: source.videoId,
      uploadId,
      projectId,
      step: "metadata_preflight",
      metadataStatus: source.metadataStatus || null,
      durationSeconds: source.durationSeconds === null || source.durationSeconds === undefined
        ? null
        : Number.isFinite(Number(source.durationSeconds))
          ? Number(source.durationSeconds)
          : null,
      ingestRisk: source.ingestRisk || null,
    });
    activeStep = "download_staging";
    activeSubstep = "youtube_downloader";
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
      const downloadResult = await sourceAcquisition.acquireSource({
        source,
        url: source.canonicalUrl,
        rightsConfirmed: true,
        outputPath,
        signal: input.signal,
        requestId,
        uploadId,
        projectId,
      });
      acquisitionSummary = downloadResult?.sourceAcquisition || null;
      acquisitionCompleted = true;
      activeStep = "download_validate_signature";
      activeSubstep = "file_signature";
      const downloaded = assertDownloadedFile(outputPath, deps);
      logInfo(deps.logger, {
        event: "youtube_ingest_step",
        requestId,
        sourceType: "youtube",
        videoId: source.videoId,
        uploadId,
        projectId,
        step: "download_validated",
        attempts: Number.isFinite(Number(downloadResult?.attempts)) ? Number(downloadResult.attempts) : null,
        attemptsConfigured: Number.isFinite(Number(downloadResult?.attemptsConfigured))
          ? Number(downloadResult.attemptsConfigured)
          : null,
        timeoutMs: Number.isFinite(Number(downloadResult?.timeoutMs)) ? Number(downloadResult.timeoutMs) : null,
        formatSelector: typeof downloadResult?.formatSelector === "string" ? downloadResult.formatSelector : null,
        fallbackFormatSelector: typeof downloadResult?.fallbackFormatSelector === "string"
          ? downloadResult.fallbackFormatSelector
          : null,
        fallbackUsed: downloadResult?.fallbackUsed === true,
        sourceAcquisitionStatus: downloadResult?.sourceAcquisition?.status || null,
        sourceAcquisitionStrategy: downloadResult?.sourceAcquisition?.sourceAcquisitionStrategy || null,
        cacheChecked: downloadResult?.sourceAcquisition?.cacheChecked === true,
        cacheHit: downloadResult?.sourceAcquisition?.cacheHit === true,
        cacheValidated: downloadResult?.sourceAcquisition?.cacheValidated === true,
        downloaderFallbackUsed: downloadResult?.sourceAcquisition?.downloaderFallbackUsed === true,
      });
      const validated = deps.validateUploadCandidate({
        fileName: `${source.videoId}.mp4`,
        mimeType: "video/mp4",
        size: downloaded.size,
        buffer: downloaded.header,
      });
      activeStep = "ffprobe_validate";
      activeSubstep = "media_probe";
      const metadata = await deps.probeMedia(downloaded.safePath);
      const checksumSha256 = deps.sha256(downloaded.safePath);
      activeStep = "artifact_commit";
      activeSubstep = "stream_upload_artifact";
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
          ownerId,
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
          ownerId,
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
      const cleanup = cleanupYouTubeStage(stageDir);
      stageCleaned = true;
      attachIngestFailureDetails(error, {
        phase: "ingest",
        step: activeStep,
        substep: activeSubstep,
        elapsedMs: Date.now() - ingestStartedAt,
        metadataPreflightStatus: source.metadataStatus || null,
        metadataPreflightDurationSeconds: source.durationSeconds || null,
        cleanupSucceeded: cleanup.cleaned === true,
        sourceAcquisitionStatus: acquisitionCompleted ? "acquired" : "failed",
        sourceAcquisitionStrategy: acquisitionSummary?.sourceAcquisitionStrategy || null,
        cacheChecked: typeof acquisitionSummary?.cacheChecked === "boolean" ? acquisitionSummary.cacheChecked : undefined,
        cacheHit: typeof acquisitionSummary?.cacheHit === "boolean" ? acquisitionSummary.cacheHit : undefined,
        cacheValidated: typeof acquisitionSummary?.cacheValidated === "boolean" ? acquisitionSummary.cacheValidated : undefined,
        cacheFailureCode: acquisitionSummary?.cacheFailureCode || undefined,
        downloaderFallbackUsed: typeof acquisitionSummary?.downloaderFallbackUsed === "boolean"
          ? acquisitionSummary.downloaderFallbackUsed
          : undefined,
        checksumSha256: acquisitionSummary?.checksumSha256 || undefined,
      });
      logError(deps.logger, {
        event: "youtube_ingest_failed",
        requestId,
        sourceType: "youtube",
        videoId: source.videoId,
        uploadId,
        projectId,
        step: activeStep,
        substep: activeSubstep,
        code: error && error.code ? error.code : "UNEXPECTED",
        ...safeDownloaderFailureDetails(error),
      });
      throw error;
    } finally {
      if (!stageCleaned) cleanupYouTubeStage(stageDir);
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
