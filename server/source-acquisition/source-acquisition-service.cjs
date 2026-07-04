const { statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("../errors.cjs");
const { sanitizeText } = require("../media.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { normalizeYouTubeUrl, youtubeIngestHealth } = require("../youtube-ingest.cjs");

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logError(logger, payload) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(JSON.stringify(redactForLogs({ level: "error", ...payload })));
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeString(value, maxLength = 80) {
  return sanitizeText(String(value || ""), maxLength) || null;
}

function assertRightsConfirmed(value) {
  if (value !== true) {
    throw new AppError("YOUTUBE_RIGHTS_REQUIRED", SAFE_MESSAGES.YOUTUBE_RIGHTS_REQUIRED, 400);
  }
}

function assertYouTubeSource(source) {
  const candidate = source && typeof source === "object" ? source : normalizeYouTubeUrl(source);
  if (
    !candidate ||
    candidate.sourceType !== "youtube" ||
    !/^[A-Za-z0-9_-]{11}$/.test(String(candidate.videoId || "")) ||
    candidate.canonicalUrl !== `https://www.youtube.com/watch?v=${candidate.videoId}`
  ) {
    throw new AppError("YOUTUBE_URL_INVALID", SAFE_MESSAGES.YOUTUBE_URL_INVALID, 400);
  }
  return candidate;
}

function validateSourceAcquisitionRequest(input = {}) {
  assertRightsConfirmed(input.rightsConfirmed);
  const source = input.source ? assertYouTubeSource(input.source) : normalizeYouTubeUrl(input.url);
  const outputPath = assertStoragePath(input.outputPath, "staging");
  return {
    source,
    outputPath,
    signal: input.signal,
    requestId: safeString(input.requestId, 120),
    uploadId: safeString(input.uploadId, 120),
    projectId: safeString(input.projectId, 120),
  };
}

function adapterAcquireFunction(adapter) {
  if (!adapter || typeof adapter !== "object") return null;
  if (typeof adapter.acquireSource === "function") return adapter.acquireSource;
  if (typeof adapter.acquire === "function") return adapter.acquire;
  if (typeof adapter.ingest === "function") return adapter.ingest;
  return null;
}

function assertSourceAcquisitionAdapter(adapter) {
  if (!adapterAcquireFunction(adapter)) {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  return adapter;
}

function fileSizeIfPresent(outputPath) {
  try {
    const stats = statSync(assertStoragePath(outputPath, "staging"));
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function safeProgressSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    heartbeatIntervalMs: safeNumber(value.heartbeatIntervalMs),
    noProgressTimeoutMs: safeNumber(value.noProgressTimeoutMs),
    progressHeartbeatCount: safeNumber(value.progressHeartbeatCount),
    progressEventCount: safeNumber(value.progressEventCount),
    progressBytesObserved: safeNumber(value.progressBytesObserved),
    stallClassification: safeString(value.stallClassification, 80),
  };
}

function safeFormatStrategy(health = {}, result = {}) {
  const strategy = health && typeof health.formatStrategy === "object" ? health.formatStrategy : {};
  return {
    formatSelector: safeString(result.formatSelector || strategy.formatSelector, 180),
    fallbackFormatSelector: safeString(result.fallbackFormatSelector || strategy.fallbackFormatSelector, 180),
    fallbackUsed: result.fallbackUsed === true,
    attempts: safeNumber(result.attempts),
    attemptsConfigured: safeNumber(result.attemptsConfigured || strategy.attemptsConfigured),
    timeoutMs: safeNumber(result.timeoutMs || strategy.timeoutMs),
    playerClient: safeString(result.playerClient || strategy.playerClient, 40),
  };
}

function safeCacheDiagnostics(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {
    cacheChecked: false,
    cacheHit: false,
    cacheValidated: false,
    cacheFailureCode: null,
    downloaderFallbackUsed: false,
    checksumSha256: null,
  };
  return {
    cacheChecked: value.cacheChecked === true,
    cacheHit: value.cacheHit === true,
    cacheValidated: value.cacheValidated === true,
    cacheFailureCode: safeString(value.cacheFailureCode, 80),
    downloaderFallbackUsed: value.downloaderFallbackUsed === true,
    checksumSha256: typeof value.checksumSha256 === "string" && /^[a-f0-9]{64}$/.test(value.checksumSha256)
      ? value.checksumSha256
      : null,
  };
}

function sourceAcquisitionSummary({ result = {}, health = {}, elapsedMs, outputPath }) {
  const progress = safeProgressSummary(result.progressSummary || result.sourceAcquisition?.progress);
  const cache = safeCacheDiagnostics(result);
  return {
    phase: "source_acquisition",
    status: "acquired",
    step: "download_staging",
    providerMode: safeString(health.mode || result.providerMode || "local", 40),
    elapsedMs: safeNumber(elapsedMs),
    outputValidated: result.cacheValidated === true,
    outputBytes: safeNumber(result.size || fileSizeIfPresent(outputPath)),
    sourceAcquisitionStrategy: safeString(result.sourceAcquisitionStrategy || "downloader", 80),
    ...cache,
    strategy: safeFormatStrategy(health, result),
    progress,
  };
}

function applyCacheDiagnosticsToError(error, diagnostics = {}) {
  if (!error || typeof error !== "object") return error;
  const existing = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : {};
  const cache = safeCacheDiagnostics(diagnostics);
  error.details = {
    ...existing,
    sourceAcquisitionStrategy: existing.sourceAcquisitionStrategy || diagnostics.sourceAcquisitionStrategy || "failed",
    cacheChecked: typeof existing.cacheChecked === "boolean" ? existing.cacheChecked : cache.cacheChecked,
    cacheHit: typeof existing.cacheHit === "boolean" ? existing.cacheHit : cache.cacheHit,
    cacheValidated: typeof existing.cacheValidated === "boolean" ? existing.cacheValidated : cache.cacheValidated,
    cacheFailureCode: existing.cacheFailureCode || cache.cacheFailureCode,
    downloaderFallbackUsed: typeof existing.downloaderFallbackUsed === "boolean"
      ? existing.downloaderFallbackUsed
      : cache.downloaderFallbackUsed,
    checksumSha256: existing.checksumSha256 || cache.checksumSha256,
  };
  return error;
}

function attachSourceAcquisitionFailureDetails(error, details = {}) {
  if (!error || typeof error !== "object") return error;
  const existing = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : {};
  error.details = {
    ...existing,
    sourceAcquisitionStatus: "failed",
    elapsedMs: Number.isFinite(Number(existing.elapsedMs)) ? Number(existing.elapsedMs) : details.elapsedMs,
    phase: existing.phase || "ingest",
    step: existing.step || "download_source",
    substep: existing.substep || "youtube_downloader",
  };
  return error;
}

function createSourceAcquisitionService(options = {}) {
  const adapter = assertSourceAcquisitionAdapter(options.adapter);
  const cacheAdapter = options.cacheAdapter || null;
  const acquire = adapterAcquireFunction(adapter);
  const logger = options.logger || null;

  async function tryCache(request) {
    if (!cacheAdapter || typeof cacheAdapter.acquireSource !== "function") {
      return {
        hit: false,
        diagnostics: {
          sourceAcquisitionStrategy: "downloader",
          cacheChecked: false,
          cacheHit: false,
          cacheValidated: false,
          cacheFailureCode: null,
          downloaderFallbackUsed: false,
        },
      };
    }
    try {
      const result = await cacheAdapter.acquireSource(request.source, {
        outputPath: request.outputPath,
        signal: request.signal,
      });
      return { hit: true, result };
    } catch (error) {
      const details = error && error.details && typeof error.details === "object" ? error.details : {};
      const diagnostics = {
        sourceAcquisitionStrategy: "cache_miss_downloader",
        cacheChecked: true,
        cacheHit: details.cacheHit === true,
        cacheValidated: false,
        cacheFailureCode: error && error.code ? error.code : details.cacheFailureCode || "SOURCE_CACHE_FILE_INVALID",
        downloaderFallbackUsed: error && error.code === "SOURCE_CACHE_MISS",
      };
      if (error && error.code === "SOURCE_CACHE_MISS") return { hit: false, diagnostics };
      applyCacheDiagnosticsToError(error, {
        ...diagnostics,
        sourceAcquisitionStrategy: "failed",
        downloaderFallbackUsed: false,
      });
      throw error;
    }
  }

  async function acquireSource(input = {}) {
    const request = validateSourceAcquisitionRequest(input);
    const startedAt = Date.now();
    const health = youtubeIngestHealth(adapter);
    logInfo(logger, {
      event: "source_acquisition_step",
      requestId: request.requestId,
      uploadId: request.uploadId,
      projectId: request.projectId,
      sourceType: "youtube",
      videoId: request.source.videoId,
      phase: "source_acquisition",
      step: "download_staging",
      status: "started",
      providerMode: health.mode,
    });
    let cacheDiagnosticsForFailure = null;
    try {
      const cacheAttempt = await tryCache(request);
      cacheDiagnosticsForFailure = cacheAttempt.diagnostics || null;
      if (cacheAttempt.hit) {
        const elapsedMs = Date.now() - startedAt;
        const summary = sourceAcquisitionSummary({
          result: cacheAttempt.result || {},
          health: { mode: "source-cache" },
          elapsedMs,
          outputPath: request.outputPath,
        });
        logInfo(logger, {
          event: "source_acquisition_step",
          requestId: request.requestId,
          uploadId: request.uploadId,
          projectId: request.projectId,
          sourceType: "youtube",
          videoId: request.source.videoId,
          phase: "source_acquisition",
          step: "cache_acquire",
          status: "acquired",
          elapsedMs,
          cacheHit: true,
          cacheValidated: true,
        });
        return {
          ...(cacheAttempt.result || {}),
          outputPath: request.outputPath,
          sourceAcquisition: summary,
        };
      }
      const result = await acquire.call(adapter, request.source, {
        outputPath: request.outputPath,
        signal: request.signal,
      });
      const elapsedMs = Date.now() - startedAt;
      const cacheDiagnostics = cacheAttempt.diagnostics || {};
      const summary = sourceAcquisitionSummary({
        result: {
          ...(result || {}),
          sourceAcquisitionStrategy: cacheDiagnostics.cacheChecked ? "cache_miss_downloader" : "downloader",
          cacheChecked: cacheDiagnostics.cacheChecked,
          cacheHit: cacheDiagnostics.cacheHit,
          cacheValidated: cacheDiagnostics.cacheValidated,
          cacheFailureCode: cacheDiagnostics.cacheFailureCode,
          downloaderFallbackUsed: cacheDiagnostics.cacheChecked,
        },
        health,
        elapsedMs,
        outputPath: request.outputPath,
      });
      logInfo(logger, {
        event: "source_acquisition_step",
        requestId: request.requestId,
        uploadId: request.uploadId,
        projectId: request.projectId,
        sourceType: "youtube",
        videoId: request.source.videoId,
        phase: "source_acquisition",
        step: "download_staging",
        status: "acquired",
        elapsedMs,
        attempts: summary.strategy.attempts,
        attemptsConfigured: summary.strategy.attemptsConfigured,
        fallbackUsed: summary.strategy.fallbackUsed,
        cacheChecked: summary.cacheChecked,
        cacheHit: summary.cacheHit,
        downloaderFallbackUsed: summary.downloaderFallbackUsed,
      });
      return {
        ...(result || {}),
        sourceAcquisitionStrategy: summary.sourceAcquisitionStrategy,
        cacheChecked: summary.cacheChecked,
        cacheHit: summary.cacheHit,
        cacheValidated: summary.cacheValidated,
        cacheFailureCode: summary.cacheFailureCode,
        downloaderFallbackUsed: summary.downloaderFallbackUsed,
        outputPath: request.outputPath,
        sourceAcquisition: summary,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (cacheDiagnosticsForFailure) {
        applyCacheDiagnosticsToError(error, cacheDiagnosticsForFailure);
      }
      attachSourceAcquisitionFailureDetails(error, { elapsedMs });
      logError(logger, {
        event: "source_acquisition_failed",
        requestId: request.requestId,
        uploadId: request.uploadId,
        projectId: request.projectId,
        sourceType: "youtube",
        videoId: request.source.videoId,
        phase: "source_acquisition",
        step: "download_staging",
        status: "failed",
        elapsedMs,
        code: error && error.code ? error.code : "UNEXPECTED",
      });
      throw error;
    }
  }

  return { acquireSource };
}

module.exports = {
  assertSourceAcquisitionAdapter,
  attachSourceAcquisitionFailureDetails,
  createSourceAcquisitionService,
  safeProgressSummary,
  validateSourceAcquisitionRequest,
};
