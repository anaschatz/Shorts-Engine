const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { existsSync, createReadStream, statSync } = require("node:fs");
const { extname } = require("node:path");
const { URL } = require("node:url");
const { CONFIG, ensureDataDirs } = require("./config.cjs");
const {
  AppError,
  SAFE_MESSAGES,
  SAFE_RESPONSE_HEADERS,
  redactForLogs,
  requestId,
  sendOk,
  sendError,
  readRequestBody,
  readJsonBody,
} = require("./errors.cjs");
const { createRateLimiter } = require("./rate-limit.cjs");
const { analysisHealth } = require("./analysis.cjs");
const { EDIT_INTENSITIES, STYLE_TARGETS, normalizeEditIntensity, normalizeStyleTarget } = require("./football-story-planner.cjs");
const { frameExtractionHealth } = require("./frame-extraction.cjs");
const { visionHealth } = require("./vision.cjs");
const { validateUploadCandidate, probeMedia, toolHealth, sha256, sanitizeText } = require("./media.cjs");
const { HOOKS, RENDER_STYLE_PRESETS, normalizeStylePreset } = require("./edit-plan.cjs");
const { transcriptionHealth } = require("./transcription.cjs");
const { JobStore, idempotencyKey } = require("./jobs.cjs");
const { normalizeSmokeSource } = require("./staging-smoke-metadata.cjs");
const { createReleaseReadiness } = require("./release-readiness.cjs");
const { createLocalJobWorker, restoreExportsFromCompletedJobs } = require("./job-worker.cjs");
const { createWorkerSupervisor } = require("./worker-supervisor.cjs");
const { createOutboxWorker } = require("./outbox-worker.cjs");
const { createLocalJobQueue } = require("./queue/local-job-queue.cjs");
const { recoverApprovalAudits } = require("./approval-audit-recovery.cjs");
const { createArtifactCleanupWorker } = require("./artifact-cleanup-worker.cjs");
const { createYouTubeIngestAdapter } = require("./adapters/youtube-ingest-adapter.cjs");
const { validateYouTubeSource, youtubeIngestHealth } = require("./youtube-ingest.cjs");
const { createYouTubeIngestService } = require("./youtube-ingest-service.cjs");
const { registerReviewDraft } = require("../eval/review-registration.cjs");
const { approveRegenerationDraft, publicApprovalResult } = require("./regeneration-approval.cjs");
const { createRegenerationPlanFromReviewRegistration } = require("./regeneration-plan.cjs");
const {
  safeResolve,
  storageHealth,
} = require("./storage.cjs");
const { createDefaultAdapters } = require("./adapters/local-persistence-adapter.cjs");

ensureDataDirs();

const { artifactAdapter, persistenceAdapter } = createDefaultAdapters();
const artifactStore = artifactAdapter;
const projectRepository = persistenceAdapter.projectRepository;
const uploadRepository = persistenceAdapter.uploadRepository;
const artifactRepository = persistenceAdapter.artifactRepository;
const exportRepository = persistenceAdapter.exportRepository;
const regenerationDraftRepository = persistenceAdapter.getRegenerationDraftRepository();
const regenerationApprovalRepository = persistenceAdapter.getRegenerationApprovalRepository();
const approvalOutboxRepository = persistenceAdapter.getApprovalOutboxRepository();
const uploads = uploadRepository.records;
const projects = projectRepository.records;
const artifacts = artifactRepository.records;
const exportsById = exportRepository.records;
const persistenceHealth = persistenceAdapter.health();
const jobPersistenceAdapter = persistenceHealth.database ? persistenceAdapter : null;
const jobs = new JobStore({
  persist: true,
  logger: console,
  persistenceAdapter: jobPersistenceAdapter,
  maxAttempts: CONFIG.workerRetryMaxAttempts,
});
const jobQueue = createLocalJobQueue({ jobs, logger: console });
const uploadLimiter = createRateLimiter({ limit: 12, windowMs: 60 * 1000 });
const generateLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });
const youtubeValidateLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 1000 });
const youtubeIngestLimiter = createRateLimiter({ limit: 6, windowMs: 60 * 1000 });
const reviewLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });
const youtubeIngestAdapter = createYouTubeIngestAdapter();
const youtubeIngestService = createYouTubeIngestService({
  adapter: youtubeIngestAdapter,
  dependencies: {
    artifactStore,
    persistenceAdapter,
    logger: console,
  },
});
const STATIC_ASSETS = new Set(["index.html", "styles.css", "hardening.js", "app.js"]);
const BLOCKED_STATIC_PREFIXES = ["/server/", "/data/", "/tests/", "/OpenViking/", "/promptfoo/", "/pm-skills/", "/viking-brain/"];
const MAX_MULTIPART_FIELDS = 12;
const MAX_MULTIPART_FILES = 1;
const MAX_MULTIPART_BOUNDARY_BYTES = 100;
const MAX_MULTIPART_FIELD_BYTES = 4 * 1024;
const MAX_MULTIPART_HEADER_BYTES = 8 * 1024;
const MAX_UPLOAD_BODY_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const UPLOAD_FILE_FIELD = "video";
const REVIEW_MEDIA_PREFIX = "manual-downloads/";
const restoredState = persistenceAdapter.restoreState();
function restoreSummary(value) {
  if (value && typeof value === "object") {
    return {
      records: Number(value.records || 0),
      ignored: Number(value.ignored || 0),
    };
  }
  return {
    records: Number(value || 0),
    ignored: 0,
  };
}
const restoredDraftAudits = restoreSummary(restoredState.draftAudits);
const restoredApprovalAudits = restoreSummary(restoredState.approvalAudits);
const restoredApprovalOutbox = restoreSummary(restoredState.approvalOutbox);
const recoveredJobs = jobs.recover();
const jobWorker = createLocalJobWorker({
  jobs,
  queue: jobQueue,
  projectRepository,
  uploadRepository,
  exportRepository,
  artifactStore,
  dependencies: {
    artifactRepository,
    regenerationApprovalRepository,
    approvalOutboxRepository,
    persistenceAdapter,
    persistRenderRecord: (record) => persistenceAdapter.persistRenderRecord(record),
  },
});
const artifactCleanupWorker = createArtifactCleanupWorker({
  artifactRepository,
  artifactStore,
  jobs,
  logger: console,
});
const outboxWorker = createOutboxWorker({
  repository: approvalOutboxRepository,
  logger: console,
});
const workerSupervisor = createWorkerSupervisor({
  jobs,
  queue: jobQueue,
  worker: jobWorker,
  logger: console,
});
const recoveredExports = restoreExportsFromCompletedJobs({ jobs, exportRepository, artifactStore, logger: console });
const recoveredApprovalAudits = recoverApprovalAudits({
  regenerationApprovalRepository,
  approvalOutboxRepository,
  jobs,
  logger: console,
  requestId: "startup_recovery",
});
if (restoredState.records > 0) {
  console.info(JSON.stringify({ level: "info", event: "state_rehydrated", records: restoredState.records }));
}
if (recoveredJobs.records > 0 || recoveredJobs.ignored > 0) {
  console.info(JSON.stringify({ level: "info", event: "jobs_rehydrated", ...recoveredJobs, exports: recoveredExports }));
}
if (
  restoredDraftAudits.records > 0 ||
  restoredDraftAudits.ignored > 0 ||
  restoredApprovalAudits.records > 0 ||
  restoredApprovalAudits.ignored > 0 ||
  restoredApprovalOutbox.records > 0 ||
  restoredApprovalOutbox.ignored > 0
) {
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "review_audit_rehydrated",
    drafts: restoredDraftAudits,
    approvals: restoredApprovalAudits,
    outbox: restoredApprovalOutbox,
  })));
}
const { queued: queuedOnStartup } = workerSupervisor.start({ requestId: "startup_recovery" });
if (queuedOnStartup > 0) {
  console.info(JSON.stringify({ level: "info", event: "supervisor_recovered_queue", queued: queuedOnStartup }));
}
artifactCleanupWorker.start({ dryRun: true });

function clientKey(req) {
  return req.socket.remoteAddress || "local";
}

function mimeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

function safeStaticPath(pathname) {
  try {
    const clean = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    if (clean.includes("\u0000")) return null;
    const assetName = clean.replace(/^\/+/, "");
    if (!STATIC_ASSETS.has(assetName) || assetName.includes("/") || assetName.includes("\\") || assetName.includes("..")) {
      return null;
    }
    return safeResolve(CONFIG.rootDir, assetName);
  } catch {
    return null;
  }
}

function blocksStaticFallback(pathname) {
  try {
    const clean = decodeURIComponent(pathname);
    const normalized = clean.startsWith("/") ? clean : `/${clean}`;
    return (
      clean.includes("\u0000") ||
      normalized.includes("\\") ||
      normalized.includes("/..") ||
      BLOCKED_STATIC_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  } catch {
    return true;
  }
}

function validateRouteId(value, prefix) {
  const safe = String(value || "");
  const matcher = new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`);
  if (!matcher.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function enforceContentLength(req, maxBytes) {
  const declaredLength = req.headers["content-length"];
  if (declaredLength === undefined) return;
  const byteLength = Number(declaredLength);
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new AppError("VALIDATION_ERROR", "Content-Length is invalid.", 400);
  }
  if (byteLength > maxBytes) {
    throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
  }
}

function validateJsonContentType(req) {
  const contentType = req.headers["content-type"];
  if (contentType && !String(contentType).toLowerCase().includes("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must be application/json.", 415);
  }
}

function validateMultipartBoundary(value) {
  const boundaryText = String(value || "");
  if (
    !boundaryText ||
    boundaryText.length > MAX_MULTIPART_BOUNDARY_BYTES ||
    boundaryText.includes("\u0000") ||
    !/^[A-Za-z0-9'()+_,./:=?-]+$/.test(boundaryText)
  ) {
    throw new AppError("VALIDATION_ERROR", "Multipart boundary is invalid.", 400);
  }
  return boundaryText;
}

function validateGeneratePayload(payload, project) {
  const title = sanitizeText(payload.title || project.title, 120);
  if (title.length < 3) {
    throw new AppError("VALIDATION_ERROR", "Title must be at least 3 characters.", 400);
  }
  const preset = sanitizeText(payload.preset || "hype", 40).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(HOOKS, preset)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported edit preset.", 400);
  }
  const language = sanitizeText(payload.language || "auto", 32) || "auto";
  const rawStyleTarget = sanitizeText(payload.styleTarget || "vertical_9_16", 40).toLowerCase();
  const styleTargetAliases = ["vertical", "shorts", "square"];
  if (payload.styleTarget !== undefined && !STYLE_TARGETS.includes(rawStyleTarget) && !styleTargetAliases.includes(rawStyleTarget)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported style target.", 400);
  }
  const styleTarget = normalizeStyleTarget(rawStyleTarget);
  const editIntensity = normalizeEditIntensity(payload.editIntensity || payload.intensity || "balanced");
  if (
    payload.editIntensity !== undefined &&
    !EDIT_INTENSITIES.includes(sanitizeText(payload.editIntensity, 40).toLowerCase())
  ) {
    throw new AppError("VALIDATION_ERROR", "Unsupported edit intensity.", 400);
  }
  const rawStylePreset = sanitizeText(payload.stylePreset || "social_sports_v1", 40).toLowerCase();
  if (payload.stylePreset !== undefined && !RENDER_STYLE_PRESETS.includes(rawStylePreset)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported render style preset.", 400);
  }
  const stylePreset = normalizeStylePreset(rawStylePreset);
  const source = payload.source !== undefined ? normalizeSmokeSource(payload.source) : normalizeSmokeSource(project.source);
  if (payload.idempotencyKey !== undefined) {
    const providedKey = sanitizeText(payload.idempotencyKey, 120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(providedKey)) {
      throw new AppError("VALIDATION_ERROR", "Idempotency key is invalid.", 400);
    }
    return { title, preset, language, styleTarget, editIntensity, stylePreset, source, idempotencyKey: providedKey, rightsConfirmed: Boolean(payload.rightsConfirmed) };
  }
  return { title, preset, language, styleTarget, editIntensity, stylePreset, source, idempotencyKey: "", rightsConfirmed: Boolean(payload.rightsConfirmed) };
}

function parseMultipart(buffer, contentType, options = {}) {
  const {
    allowedFileFields = [UPLOAD_FILE_FIELD],
    maxBoundaryBytes = MAX_MULTIPART_BOUNDARY_BYTES,
    maxFieldBytes = MAX_MULTIPART_FIELD_BYTES,
    maxFields = MAX_MULTIPART_FIELDS,
    maxFiles = MAX_MULTIPART_FILES,
    maxHeaderBytes = MAX_MULTIPART_HEADER_BYTES,
  } = options;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new AppError("VALIDATION_ERROR", "Multipart boundary is missing.", 400);
  const boundaryText = validateMultipartBoundary(match[1] || match[2]);
  if (boundaryText.length > maxBoundaryBytes) {
    throw new AppError("VALIDATION_ERROR", "Multipart boundary is invalid.", 400);
  }
  const boundary = Buffer.from(`--${boundaryText}`);
  const parts = { fields: {}, files: [] };
  let fieldCount = 0;
  let position = buffer.indexOf(boundary);
  while (position !== -1) {
    position += boundary.length;
    if (buffer.subarray(position, position + 2).toString("latin1") === "--") break;
    if (buffer.subarray(position, position + 2).toString("latin1") === "\r\n") position += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), position);
    if (headerEnd === -1) break;
    if (headerEnd - position > maxHeaderBytes) {
      throw new AppError("UPLOAD_FIELD_INVALID", SAFE_MESSAGES.UPLOAD_FIELD_INVALID, 400);
    }
    const headerText = buffer.subarray(position, headerEnd).toString("latin1");
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary === -1) break;
    let content = buffer.subarray(headerEnd + 4, nextBoundary);
    if (content.length >= 2 && content.subarray(content.length - 2).toString("latin1") === "\r\n") {
      content = content.subarray(0, content.length - 2);
    }
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText);
    const name = /name="([^"]+)"/i.exec(disposition ? disposition[1] : "");
    const filename = /filename="([^"]*)"/i.exec(disposition ? disposition[1] : "");
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText);
    if (name) {
      const fieldName = name[1];
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(fieldName)) {
        throw new AppError("UPLOAD_FIELD_INVALID", SAFE_MESSAGES.UPLOAD_FIELD_INVALID, 400);
      }
      if (filename) {
        if (!allowedFileFields.includes(fieldName)) {
          throw new AppError("UPLOAD_FIELD_INVALID", SAFE_MESSAGES.UPLOAD_FIELD_INVALID, 400);
        }
        if (parts.files.length >= maxFiles) {
          throw new AppError("UPLOAD_FIELD_INVALID", "Only one video file can be uploaded.", 400);
        }
        if (!filename[1]) {
          throw new AppError("FILE_NAME_UNSAFE", SAFE_MESSAGES.FILE_NAME_UNSAFE, 400);
        }
        parts.files.push({
          fieldName,
          fileName: filename[1],
          mimeType: type ? type[1].trim().toLowerCase() : "",
          buffer: content,
        });
      } else {
        if (!Object.prototype.hasOwnProperty.call(parts.fields, fieldName)) {
          fieldCount += 1;
        }
        if (fieldCount > maxFields) {
          throw new AppError("UPLOAD_FIELD_INVALID", "Too many upload fields.", 400);
        }
        if (content.length > maxFieldBytes) {
          throw new AppError("UPLOAD_FIELD_INVALID", "Upload field is too large.", 400);
        }
        parts.fields[fieldName] = content.toString("utf8");
      }
    }
    position = nextBoundary;
  }
  return parts;
}

const PUBLIC_ARTIFACT_CAPABILITY_ALIASES = Object.freeze({
  createSignedDownloadUrl: "createSignedDownloadLink",
  validateSignedDownloadToken: "validateSignedDownloadAccess",
  pruneSignedTokens: "pruneSignedDownloadAccess",
});

function publicCapabilityName(key) {
  return String(PUBLIC_ARTIFACT_CAPABILITY_ALIASES[key] || key)
    .replace(/Output/g, "Result")
    .replace(/Paths/g, "References")
    .replace(/Path/g, "Reference")
    .replace(/Tokens/g, "AccessEntries")
    .replace(/Token/g, "Access")
    .replace(/URLs/g, "Links")
    .replace(/URL/g, "Link")
    .replace(/Urls/g, "Links")
    .replace(/Url/g, "Link");
}

function publicArtifactCapabilities(capabilities = {}) {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => [
      publicCapabilityName(key),
      Boolean(value),
    ]),
  );
}

function publicPersistenceCapabilities(capabilities = {}) {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => [
      publicCapabilityName(key),
      Boolean(value),
    ]),
  );
}

function publicArtifactHealth(health = {}) {
  const { activeSignedTokens, maxSignedTokens, capabilities, ...safeHealth } = health;
  return {
    ...safeHealth,
    maxSignedDownloads: Number.isFinite(Number(maxSignedTokens)) ? Number(maxSignedTokens) : 0,
    activeSignedDownloads: Number.isFinite(Number(activeSignedTokens)) ? Number(activeSignedTokens) : 0,
    capabilities: publicArtifactCapabilities(capabilities),
  };
}

function publicPersistenceHealth(health = {}) {
  const { capabilities, ...safeHealth } = health;
  return {
    ...safeHealth,
    capabilities: publicPersistenceCapabilities(capabilities),
  };
}

async function handleHealth(req, res, rid) {
  const tools = toolHealth();
  const storage = storageHealth();
  const artifacts = publicArtifactHealth(artifactAdapter.health());
  const repositories = {
    projects: projectRepository.health(),
    uploads: uploadRepository.health(),
    artifacts: artifactRepository.health(),
    exports: exportRepository.health(),
    regenerationDrafts: regenerationDraftRepository.health(),
    regenerationApprovals: regenerationApprovalRepository.health(),
    approvalOutbox: approvalOutboxRepository.health(),
  };
  const adapters = {
    artifacts,
    persistence: publicPersistenceHealth(persistenceAdapter.health()),
  };
  const provider = transcriptionHealth();
  const analysis = analysisHealth();
  const frameExtraction = frameExtractionHealth();
  const vision = visionHealth();
  const youtubeIngest = youtubeIngestHealth(youtubeIngestAdapter);
  const cleanup = artifactCleanupWorker.health();
  const outbox = outboxWorker.health();
  const worker = jobWorker.health();
  const supervisor = workerSupervisor.health();
  const queue = jobQueue.health();
  const releaseReadiness = createReleaseReadiness({ rootDir: CONFIG.rootDir });
  const storageReady = Object.values(storage).every((entry) => entry.exists && entry.readable && entry.writable);
  const repositoriesReady = Object.values(repositories).every((entry) => entry.ready);
  const adaptersReady = Object.values(adapters).every((entry) => entry.ready);
  const ready =
    tools.ffmpeg &&
    tools.ffprobe &&
    storageReady &&
    repositoriesReady &&
    adaptersReady &&
    provider.ready &&
    analysis.ready &&
    frameExtraction.ready &&
    vision.ready &&
    youtubeIngest.ready;
  sendOk(res, {
    service: "shortsengine-mvp",
    status: ready ? "ready" : "degraded",
    ffmpeg: {
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      configured: Boolean(tools.ffmpegBin && tools.ffprobeBin),
    },
    storage,
    artifacts,
    repositories,
    adapters,
    jobs: jobs.health(),
    queue,
    outbox,
    worker,
    supervisor,
    cleanup,
    approvalRecovery: recoveredApprovalAudits,
    artifactIndexReady: repositories.artifacts.ready,
    cleanupWorkerConfigured: cleanup.configured,
    cleanupLastRunAt: cleanup.lastRunAt,
    cleanupLastResult: cleanup.lastResult,
    realCloudIntegrationEnabled: CONFIG.realCloudIntegrationEnabled,
    releaseReadiness,
    transcription: provider,
    analysis,
    frameExtraction,
    vision,
    youtubeIngest,
    requestId: rid,
  });
}

async function handleYouTubeValidate(req, res, rid) {
  if (!youtubeValidateLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const source = await validateYouTubeSource({
    url: payload.url,
    rightsConfirmed: payload.rightsConfirmed,
    adapter: youtubeIngestAdapter,
    maxDurationSeconds: CONFIG.maxDurationSeconds,
  });
  console.info(JSON.stringify({
    level: "info",
    event: "youtube_source_validated",
    requestId: rid,
    sourceType: source.sourceType,
    videoId: source.videoId,
    metadataStatus: source.metadataStatus,
    ingestRisk: source.ingestRisk,
    warningCode: source.warningCode,
    ingestAvailable: source.ingestAvailable,
  }));
  sendOk(res, { source });
}

async function handleYouTubeIngest(req, res, rid) {
  if (!youtubeIngestLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const result = await youtubeIngestService.ingest({
    url: payload.url,
    rightsConfirmed: payload.rightsConfirmed,
    title: payload.title,
    requestId: rid,
  });
  console.info(JSON.stringify({
    level: "info",
    event: "youtube_ingest_accepted",
    requestId: rid,
    sourceType: "youtube",
    videoId: result.source.videoId,
    projectId: result.project.id,
    uploadId: result.upload.id,
  }));
  sendOk(res, result, 201);
}

async function handleUpload(req, res, rid) {
  if (!uploadLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError("VALIDATION_ERROR", "Upload must be multipart/form-data.", 400);
  }
  const maxUploadBodyBytes = CONFIG.maxUploadBytes + MAX_UPLOAD_BODY_OVERHEAD_BYTES;
  enforceContentLength(req, maxUploadBodyBytes);
  const body = await readRequestBody(req, maxUploadBodyBytes);
  const multipart = parseMultipart(body, contentType);
  const file = multipart.files.find((entry) => entry.fieldName === UPLOAD_FILE_FIELD);
  if (!file) throw new AppError("MISSING_UPLOAD", SAFE_MESSAGES.MISSING_UPLOAD, 400);
  const validated = validateUploadCandidate({
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.buffer.length,
    buffer: file.buffer,
  });
  const uploadId = `upl_${randomUUID()}`;
  const projectId = `prj_${randomUUID()}`;
  const source = multipart.fields.source === undefined || multipart.fields.source === ""
    ? null
    : normalizeSmokeSource(multipart.fields.source);
  let uploadArtifact = artifactStore.writeBuffer({
    id: uploadId,
    type: "upload",
    ownerProjectId: projectId,
    storageKey: `${uploadId}.${validated.extension}`,
    buffer: file.buffer,
    size: validated.size,
    source,
    status: "staging",
  });
  let uploadStage;
  let uploadPath;
  let checksumSha256 = validated.sha256;
  let metadata;
  try {
    uploadStage = artifactStore.stageInputForProcessing(uploadArtifact, { step: "probe_upload" });
    uploadPath = uploadStage.localPath;
    metadata = await probeMedia(uploadPath);
    checksumSha256 = checksumSha256 || sha256(uploadPath);
  } catch (error) {
    artifactStore.deleteStagingArtifact(uploadArtifact);
    throw error;
  } finally {
    if (uploadStage && uploadStage.cleanupRequired) {
      artifactStore.cleanupStage(uploadStage);
    }
  }
  uploadArtifact = artifactStore.markAvailable(uploadArtifact);
  const createdAt = new Date().toISOString();
  const { project, upload } = persistenceAdapter.createProjectUpload({
    upload: {
      id: uploadId,
      projectId,
      artifact: uploadArtifact,
      storageKey: uploadArtifact.storageKey,
      originalFilename: validated.safeName,
      mimeType: validated.mimeType,
      extension: validated.extension,
      container: validated.container,
      byteSize: validated.size,
      checksumSha256,
      path: uploadStage && uploadStage.permanentLocal ? uploadPath : null,
      metadata,
      source,
      createdAt,
    },
    project: {
      id: projectId,
      uploadId,
      title: sanitizeText(multipart.fields.title || "ShortsEngine Short", 120),
      status: "draft",
      source,
      createdAt,
      updatedAt: createdAt,
    },
  });
  console.info(JSON.stringify({ level: "info", event: "upload_accepted", requestId: rid, projectId, uploadId }));
  sendOk(res, {
    upload: persistenceAdapter.publicUpload(upload),
    project: persistenceAdapter.publicProject(project),
  }, 201);
}

async function handleGenerate(req, res, rid, projectId) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  const upload = persistenceAdapter.getUpload(project.uploadId);
  if (!upload) throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const validatedPayload = validateGeneratePayload(payload, project);
  if (!validatedPayload.rightsConfirmed) {
    throw new AppError("VALIDATION_ERROR", "Confirm footage rights before generating.", 400);
  }
  const key = validatedPayload.idempotencyKey || idempotencyKey("generate", {
    projectId: safeProjectId,
    uploadId: upload.id,
    preset: validatedPayload.preset,
    styleTarget: validatedPayload.styleTarget,
    editIntensity: validatedPayload.editIntensity,
    stylePreset: validatedPayload.stylePreset,
    title: validatedPayload.title,
  });
  const job = jobQueue.create({
    projectId: safeProjectId,
    uploadId: upload.id,
    action: "generate",
    idempotencyKey: key,
    payload: validatedPayload,
  });
  if (job.status === "queued") {
    workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: rid }), { requestId: rid });
  }
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handleGetJob(req, res, jobId) {
  const safeJobId = validateRouteId(jobId, "job");
  const job = jobQueue.get(safeJobId);
  if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
  sendOk(res, { job: jobQueue.publicJob(job) });
}

async function handleCancelJob(req, res, jobId) {
  const safeJobId = validateRouteId(jobId, "job");
  const job = jobQueue.cancel(safeJobId);
  sendOk(res, { job: jobQueue.publicJob(job) });
}

function completedExportDescriptor(exportId) {
  const safeExportId = validateRouteId(exportId, "exp");
  const record = persistenceAdapter.getExport(safeExportId);
  if (!record) throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  const job = jobQueue.get(record.jobId);
  return persistenceAdapter.getExportDownloadDescriptor(record, { job });
}

function streamExportDescriptor(res, descriptor) {
  const fileName = safeDownloadFileName(descriptor.fileName, `${descriptor.projectId}-short.mp4`);
  const stream = artifactAdapter.createReadStream(descriptor.artifact);
  res.writeHead(200, {
    ...SAFE_RESPONSE_HEADERS,
    "content-type": descriptor.contentType || "video/mp4",
    "content-length": descriptor.size,
    "content-disposition": `attachment; filename="${fileName}"`,
  });
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}

async function handleDownload(req, res, exportId) {
  streamExportDescriptor(res, completedExportDescriptor(exportId));
}

async function handleDownloadUrl(req, res, exportId) {
  const descriptor = completedExportDescriptor(exportId);
  const signed = persistenceAdapter.createSignedExportDownload(
    { id: descriptor.id, projectId: descriptor.projectId, jobId: descriptor.jobId, artifact: descriptor.artifact, fileName: descriptor.fileName },
    { job: jobQueue.get(descriptor.jobId), basePath: "/api/artifacts/download" },
  );
  sendOk(res, signed);
}

function publicReviewRegistrationResult(result) {
  const report = result.comparisonPreview || {};
  const metrics = report.metrics || {};
  const suggestions = Array.isArray(report.suggestions)
    ? report.suggestions.slice(0, 12).map((item) => ({
        id: sanitizeText(item.id, 100),
        type: sanitizeText(item.type, 80),
        severity: sanitizeText(item.severity, 40),
        target: sanitizeText(item.target, 40),
        message: sanitizeText(item.message, 180),
        reasonCode: sanitizeText(item.reasonCode, 80),
        safeAction: sanitizeText(item.safeAction, 220),
        canAutoApply: false,
        requiresHumanReview: item.requiresHumanReview !== false,
        relatedMetric: item.relatedMetric ? sanitizeText(item.relatedMetric, 80) : null,
        relatedFailureCode: item.relatedFailureCode ? sanitizeText(item.relatedFailureCode, 80) : null,
      }))
    : [];
  const blockingSuggestionCount = suggestions.filter((item) => item.severity === "blocking").length;
  return {
    status: "registered",
    draft: result.output
      ? {
          latest: result.output.latestPath,
          report: result.output.draftPath,
        }
      : null,
    compareCommand: result.compareCommand,
    review: {
      passed: Boolean(report.passed),
      status: sanitizeText(report.status || "unknown", 40),
      overallScore: Number.isFinite(Number(metrics.overallScore)) ? Number(metrics.overallScore) : 0,
      threshold: Number.isFinite(Number(report.threshold)) ? Number(report.threshold) : 0,
      metrics: {
        noFalseGoalClaim: Number.isFinite(Number(metrics.noFalseGoalClaim)) ? Number(metrics.noFalseGoalClaim) : 0,
        captionActionAlignment: Number.isFinite(Number(metrics.captionActionAlignment)) ? Number(metrics.captionActionAlignment) : 0,
        framingSafety: Number.isFinite(Number(metrics.framingSafety)) ? Number(metrics.framingSafety) : 0,
        aspectRatioCorrectness: Number.isFinite(Number(metrics.aspectRatioCorrectness)) ? Number(metrics.aspectRatioCorrectness) : 0,
        animationCueCoverage: Number.isFinite(Number(metrics.animationCueCoverage)) ? Number(metrics.animationCueCoverage) : 0,
        reviewerReadinessScore: Number.isFinite(Number(metrics.reviewerReadinessScore)) ? Number(metrics.reviewerReadinessScore) : 0,
      },
      failedCriteria: Array.isArray(report.failedCriteria)
        ? report.failedCriteria.slice(0, 12).map((item) => ({
            metric: sanitizeText(item.metric, 80),
            score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
            min: Number.isFinite(Number(item.min)) ? Number(item.min) : 0,
            note: sanitizeText(item.note, 180),
          }))
        : [],
      failedCases: Array.isArray(report.failedCases)
        ? report.failedCases.slice(0, 12).map((item) => ({
            code: sanitizeText(item.code, 80),
            message: sanitizeText(item.message, 180),
            field: item.field ? sanitizeText(item.field, 100) : undefined,
          }))
        : [],
      suggestions,
      blockingSuggestionCount,
      regenerationAvailable: suggestions.length > 0,
      regenerationPlan: null,
      nextAction: sanitizeText(report.nextAction || "Run review comparison and inspect failed criteria.", 180),
    },
  };
}

function publicRegenerationEditPlan(plan = {}) {
  return {
    sourceStart: Number.isFinite(Number(plan.sourceStart)) ? Number(plan.sourceStart) : 0,
    sourceEnd: Number.isFinite(Number(plan.sourceEnd)) ? Number(plan.sourceEnd) : 0,
    aspectRatio: sanitizeText(plan.aspectRatio || "9:16", 20),
    highlightType: sanitizeText(plan.highlightType || "generic_highlight", 80),
    framingMode: sanitizeText(plan.framingMode || "wide_safe_vertical", 80),
    stylePreset: sanitizeText(plan.stylePreset || "social_sports_v1", 80),
    export: plan.export && typeof plan.export === "object"
      ? {
          width: Number.isFinite(Number(plan.export.width)) ? Number(plan.export.width) : 1080,
          height: Number.isFinite(Number(plan.export.height)) ? Number(plan.export.height) : 1920,
          format: sanitizeText(plan.export.format || "mp4", 20),
        }
      : null,
    cropStrategy: plan.cropStrategy && typeof plan.cropStrategy === "object"
      ? {
          type: sanitizeText(plan.cropStrategy.type || "wide_safe_contain", 80),
          preserveFullFrame: plan.cropStrategy.preserveFullFrame !== false,
          maxCropPercent: Number.isFinite(Number(plan.cropStrategy.maxCropPercent)) ? Number(plan.cropStrategy.maxCropPercent) : 0,
        }
      : null,
    captions: Array.isArray(plan.captions)
      ? plan.captions.slice(0, 12).map((caption) => ({
          start: Number.isFinite(Number(caption.start)) ? Number(caption.start) : 0,
          end: Number.isFinite(Number(caption.end)) ? Number(caption.end) : 0,
          role: sanitizeText(caption.role || "caption", 60),
          text: sanitizeText(caption.text || "", 120),
        }))
      : [],
    animationCues: Array.isArray(plan.animationCues)
      ? plan.animationCues.slice(0, 10).map((cue) => ({
          type: sanitizeText(cue.type || "unknown", 60),
          start: Number.isFinite(Number(cue.start)) ? Number(cue.start) : 0,
          end: Number.isFinite(Number(cue.end)) ? Number(cue.end) : 0,
        }))
      : [],
  };
}

function publicRegenerationPlanResult(result, draftRecord = null) {
  const plan = result.regenerationPlan || {};
  const report = result.registered && result.registered.comparisonPreview || {};
  const suggestions = Array.isArray(report.suggestions) ? report.suggestions : [];
  return {
    status: sanitizeText(plan.status || "draft", 40),
    review: {
      passed: Boolean(report.passed),
      suggestionCount: suggestions.length,
      blockingSuggestionCount: suggestions.filter((item) => item.severity === "blocking").length,
    },
    regenerationPlan: {
      schemaVersion: Number.isFinite(Number(plan.schemaVersion)) ? Number(plan.schemaVersion) : 1,
      regenerationPlanId: sanitizeText(plan.regenerationPlanId || "", 120),
      draftHash: plan.draftHash ? sanitizeText(plan.draftHash, 80) : null,
      status: sanitizeText(plan.status || "draft", 40),
      sourceReviewId: plan.sourceReviewId ? sanitizeText(plan.sourceReviewId, 120) : null,
      projectId: plan.projectId ? sanitizeText(plan.projectId, 120) : null,
      jobId: plan.jobId ? sanitizeText(plan.jobId, 120) : null,
      exportId: plan.exportId ? sanitizeText(plan.exportId, 120) : null,
      appliedSuggestionIds: Array.isArray(plan.appliedSuggestionIds) ? plan.appliedSuggestionIds.slice(0, 12).map((id) => sanitizeText(id, 100)) : [],
      skippedSuggestionIds: Array.isArray(plan.skippedSuggestionIds) ? plan.skippedSuggestionIds.slice(0, 12).map((id) => sanitizeText(id, 100)) : [],
      proposedChanges: Array.isArray(plan.proposedChanges) ? plan.proposedChanges.slice(0, 12).map((item) => sanitizeText(item, 120)) : [],
      blockingReasons: Array.isArray(plan.blockingReasons)
        ? plan.blockingReasons.slice(0, 12).map((item) => ({
            code: sanitizeText(item.code || "MANUAL_REVIEW_REQUIRED", 100),
            suggestionId: item.suggestionId ? sanitizeText(item.suggestionId, 100) : null,
            message: sanitizeText(item.message || "Manual review is required.", 180),
          }))
        : [],
      safetyChecks: Array.isArray(plan.safetyChecks)
        ? plan.safetyChecks.slice(0, 12).map((item) => ({
            code: sanitizeText(item.code || "CHECK", 100),
            status: sanitizeText(item.status || "unknown", 40),
          }))
        : [],
      proposedEditPlan: plan.proposedEditPlan ? publicRegenerationEditPlan(plan.proposedEditPlan) : null,
      canRender: false,
      requiresHumanApproval: true,
      createdAt: sanitizeText(plan.createdAt || "", 80),
      nextAction: sanitizeText(plan.nextAction || "Review this draft manually before rendering.", 180),
    },
    draftRecord: draftRecord
      ? {
          id: sanitizeText(draftRecord.id || "", 80),
          version: Number.isFinite(Number(draftRecord.version)) ? Number(draftRecord.version) : 1,
          draftHash: draftRecord.draftHash ? sanitizeText(draftRecord.draftHash, 80) : null,
          status: sanitizeText(draftRecord.status || "draft", 40),
          validationStatus: sanitizeText(draftRecord.validationStatus || "valid", 40),
          createdAt: sanitizeText(draftRecord.createdAt || "", 80),
          updatedAt: sanitizeText(draftRecord.updatedAt || "", 80),
        }
      : null,
  };
}

async function handleReviewRegister(req, res, rid) {
  if (!reviewLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const projectId = validateRouteId(payload.projectId, "prj");
  const jobId = validateRouteId(payload.jobId, "job");
  const exportId = payload.exportId === undefined || payload.exportId === null || payload.exportId === ""
    ? null
    : validateRouteId(payload.exportId, "exp");
  const result = registerReviewDraft({
    projectId,
    jobId,
    exportId,
    rightsConfirmed: payload.rightsConfirmed,
    reference: payload.reference,
    reviewerNotes: payload.reviewerNotes,
    title: payload.title,
    rootDir: CONFIG.rootDir,
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "review_registered",
    requestId: rid,
    projectId,
    jobId,
    exportId: exportId || (result.draft && result.draft.generatedMetadata && result.draft.generatedMetadata.registration.exportId),
    status: result.comparisonPreview && result.comparisonPreview.status,
    passed: Boolean(result.comparisonPreview && result.comparisonPreview.passed),
    suggestionCount: Array.isArray(result.comparisonPreview && result.comparisonPreview.suggestions)
      ? result.comparisonPreview.suggestions.length
      : 0,
    blockingSuggestionCount: result.comparisonPreview && result.comparisonPreview.suggestionSummary
      ? result.comparisonPreview.suggestionSummary.blockingSuggestionCount
      : 0,
    suggestionTypes: Array.isArray(result.comparisonPreview && result.comparisonPreview.suggestions)
      ? result.comparisonPreview.suggestions.map((item) => item.type).slice(0, 12)
      : [],
  })));
  sendOk(res, publicReviewRegistrationResult(result), 201);
}

async function handleReviewRegenerationPlan(req, res, rid) {
  if (!reviewLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const projectId = validateRouteId(payload.projectId, "prj");
  const jobId = validateRouteId(payload.jobId, "job");
  const exportId = payload.exportId === undefined || payload.exportId === null || payload.exportId === ""
    ? null
    : validateRouteId(payload.exportId, "exp");
  const result = createRegenerationPlanFromReviewRegistration({
    projectId,
    jobId,
    exportId,
    rightsConfirmed: payload.rightsConfirmed,
    reference: payload.reference,
    reviewerNotes: payload.reviewerNotes,
    humanNotes: payload.humanNotes,
    title: payload.title,
    rootDir: CONFIG.rootDir,
  });
  const plan = result.regenerationPlan || {};
  const draftRecord = regenerationDraftRepository.createFromPlan(plan, {
    projectId,
    sourceJobId: jobId,
    sourceExportId: exportId || plan.exportId,
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "review_regeneration_plan_created",
    requestId: rid,
    projectId,
    jobId,
    exportId: exportId || plan.exportId,
    regenerationPlanId: plan.regenerationPlanId,
    draftRecordId: draftRecord.id,
    draftVersion: draftRecord.version,
    draftValidationStatus: draftRecord.validationStatus,
    suggestionCount: Array.isArray(result.registered && result.registered.comparisonPreview && result.registered.comparisonPreview.suggestions)
      ? result.registered.comparisonPreview.suggestions.length
      : 0,
    appliedSuggestionCount: Array.isArray(plan.appliedSuggestionIds) ? plan.appliedSuggestionIds.length : 0,
    blockedSuggestionCount: Array.isArray(plan.blockingReasons) ? plan.blockingReasons.length : 0,
    canRender: false,
  })));
  sendOk(res, publicRegenerationPlanResult(result, draftRecord), 201);
}

async function handleReviewRegenerationApproval(req, res, rid) {
  if (!reviewLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const projectId = validateRouteId(payload.projectId, "prj");
  const sourceJobId = validateRouteId(payload.sourceJobId || payload.jobId, "job");
  const exportId = validateRouteId(payload.exportId, "exp");
  const regenerationPlanId = validateRouteId(payload.regenerationPlanId, "regen");
  const result = approveRegenerationDraft({
    request: {
      projectId,
      sourceJobId,
      exportId,
      regenerationPlanId,
      idempotencyKey: payload.idempotencyKey,
      approve: payload.approve,
      rightsConfirmed: payload.rightsConfirmed,
      selectedDraftHash: payload.selectedDraftHash || payload.draftHash,
      operatorNote: payload.operatorNote,
      reviewerNotes: payload.reviewerNotes,
      humanNotes: payload.humanNotes,
      title: payload.title,
      reference: payload.reference,
    },
    rootDir: CONFIG.rootDir,
    persistenceAdapter,
    regenerationDraftRepository,
    regenerationApprovalRepository,
    approvalOutboxRepository,
    jobQueue,
    workerSupervisor,
    requestId: rid,
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "review_regeneration_approved",
    requestId: rid,
    projectId,
    sourceJobId,
    exportId,
    regenerationPlanId,
    approvalId: result.approvalId,
    draftRecordId: result.draftRecord && result.draftRecord.id,
    approvalStatus: result.approvalRecord && result.approvalRecord.status,
    newRenderJobId: result.job && result.job.id,
    status: result.status,
    renderQueued: result.renderQueued,
    blockingSuggestionCount: result.blockingSuggestionCount,
  })));
  sendOk(res, publicApprovalResult(result), 202);
}

async function handleSignedArtifactDownload(req, res, url) {
  const artifact = artifactAdapter.validateSignedDownloadToken(url.searchParams.get("token"));
  if (!artifact || !artifact.id || !String(artifact.id).startsWith("exp_")) {
    throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
  }
  const descriptor = completedExportDescriptor(artifact.id);
  if (descriptor.artifact.id !== artifact.id) {
    throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
  }
  streamExportDescriptor(res, descriptor);
}

function safeDownloadFileName(value, fallback = "shortsengine-short.mp4") {
  const fallbackName = String(fallback || "shortsengine-short.mp4").replace(/[^A-Za-z0-9._-]/g, "_");
  const normalized = sanitizeText(value || fallbackName, 180)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 180);
  const withExtension = normalized.toLowerCase().endsWith(".mp4") ? normalized : `${normalized || fallbackName}.mp4`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.mp4$/i.test(withExtension)) {
    return fallbackName.toLowerCase().endsWith(".mp4") ? fallbackName : `${fallbackName}.mp4`;
  }
  return withExtension;
}

async function loadHumanReviewModule() {
  return import("../demo/run-human-visual-review.mjs");
}

function safeReviewMediaRef(value) {
  const text = sanitizeText(value || "", 260).replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !text.startsWith(REVIEW_MEDIA_PREFIX) ||
    extname(text).toLowerCase() !== ".mp4"
  ) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, {
      nextAction: "use-safe-manual-downloads-mp4-reference",
    });
  }
  return {
    relativePath: text,
    resolvedPath: safeResolve(CONFIG.rootDir, text),
  };
}

function publicHumanVisualReviewReport(report = {}) {
  const humanReview = report.humanReview || {};
  const sourceArtifact = report.source && report.source.generatedArtifact;
  const generated = report.comparison && report.comparison.generated;
  const reference = report.comparison && report.comparison.reference;
  return {
    schemaVersion: Number.isFinite(Number(report.schemaVersion)) ? Number(report.schemaVersion) : 1,
    generatedAt: sanitizeText(report.generatedAt || "", 80),
    status: sanitizeText(report.status || "pending_human_review", 60),
    passed: report.passed === true,
    productReady: report.productReady === true && humanReview.present === true,
    source: {
      mode: sanitizeText(report.source && report.source.mode || "direct_refs", 40),
      generatedArtifact: sourceArtifact
        ? {
            relativePath: sanitizeText(sourceArtifact.relativePath || "", 260),
            sourceType: sanitizeText(sourceArtifact.sourceType || "direct", 40),
            videoId: sourceArtifact.videoId ? sanitizeText(sourceArtifact.videoId, 80) : null,
            durationSeconds: Number.isFinite(Number(sourceArtifact.durationSeconds)) ? Number(sourceArtifact.durationSeconds) : null,
            width: Number.isFinite(Number(sourceArtifact.width)) ? Number(sourceArtifact.width) : null,
            height: Number.isFinite(Number(sourceArtifact.height)) ? Number(sourceArtifact.height) : null,
            downloadVerified: sourceArtifact.downloadVerified === true,
          }
        : null,
    },
    comparison: report.comparison
      ? {
          generated: generated
            ? {
                relativePath: sanitizeText(generated.relativePath || "", 260),
                readable: generated.readable === true,
                durationSeconds: Number.isFinite(Number(generated.durationSeconds)) ? Number(generated.durationSeconds) : null,
                width: Number.isFinite(Number(generated.width)) ? Number(generated.width) : null,
                height: Number.isFinite(Number(generated.height)) ? Number(generated.height) : null,
                orientation: sanitizeText(generated.orientation || "unknown", 40),
              }
            : null,
          reference: reference
            ? {
                relativePath: sanitizeText(reference.relativePath || "", 260),
                readable: reference.readable === true,
                durationSeconds: Number.isFinite(Number(reference.durationSeconds)) ? Number(reference.durationSeconds) : null,
                width: Number.isFinite(Number(reference.width)) ? Number(reference.width) : null,
                height: Number.isFinite(Number(reference.height)) ? Number(reference.height) : null,
                orientation: sanitizeText(reference.orientation || "unknown", 40),
              }
            : null,
        }
      : null,
    machineStructuralMetrics: report.machineStructuralMetrics || null,
    humanReview: {
      status: sanitizeText(humanReview.status || "pending_human_review", 80),
      present: humanReview.present === true,
      humanScore: Number.isFinite(Number(humanReview.humanScore)) ? Number(humanReview.humanScore) : null,
      combinedScore: Number.isFinite(Number(humanReview.combinedScore)) ? Number(humanReview.combinedScore) : null,
      productReady: humanReview.productReady === true,
      failedCriteria: Array.isArray(humanReview.failedCriteria) ? humanReview.failedCriteria.slice(0, 12) : [],
      borderlineCriteria: Array.isArray(humanReview.borderlineCriteria) ? humanReview.borderlineCriteria.slice(0, 12) : [],
      improvementHints: Array.isArray(humanReview.improvementHints) ? humanReview.improvementHints.slice(0, 12) : [],
      operatorReview: humanReview.operatorReview && humanReview.operatorReview.present === true
        ? {
            present: true,
            reviewer: sanitizeText(humanReview.operatorReview.reviewer || "operator", 80),
            reviewedAt: sanitizeText(humanReview.operatorReview.reviewedAt || "", 80),
            flags: humanReview.operatorReview.flags || {},
          }
        : { present: false },
    },
    checklist: Array.isArray(report.checklist)
      ? report.checklist.slice(0, 16).map((item) => ({
          id: sanitizeText(item.id || "", 100),
          label: sanitizeText(item.label || "", 160),
          status: sanitizeText(item.status || "unknown", 80),
          evidence: sanitizeText(item.evidence || "", 240),
        }))
      : [],
    recommendedNextFix: sanitizeText(report.recommendedNextFix || "complete-human-visual-review", 120),
    failedCases: Array.isArray(report.failedCases)
      ? report.failedCases.slice(0, 12).map((item) => ({
          code: sanitizeText(item.code || "", 100),
          message: sanitizeText(item.message || "", 180),
          field: item.field ? sanitizeText(item.field, 100) : undefined,
        }))
      : [],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

async function handleHumanReviewLatest(req, res) {
  const review = await loadHumanReviewModule();
  const result = review.loadLatestHumanVisualReviewReport({ rootDir: CONFIG.rootDir });
  if (!result.ok) {
    throw new AppError(result.error.code, result.error.message, 400, { nextAction: result.error.nextAction });
  }
  sendOk(res, {
    status: result.exists ? "available" : "missing",
    latestPath: result.latestPath,
    review: publicHumanVisualReviewReport(result.report),
  });
}

async function handleHumanReviewSubmit(req, res, rid) {
  if (!reviewLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const review = await loadHumanReviewModule();
  const result = review.writeHumanVisualReviewFromPayload(payload, { rootDir: CONFIG.rootDir });
  if (!result.ok) {
    throw new AppError(result.error.code, result.error.message, 400, { nextAction: result.error.nextAction });
  }
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "human_visual_review_submitted",
    requestId: rid,
    status: result.report && result.report.status,
    productReady: Boolean(result.report && result.report.productReady),
    humanReviewPresent: Boolean(result.report && result.report.humanReview && result.report.humanReview.present),
    recommendedNextFix: result.report && result.report.recommendedNextFix,
  })));
  sendOk(res, {
    latestPath: result.latestPath,
    reportPath: result.reportPath,
    review: publicHumanVisualReviewReport(result.report),
  }, 201);
}

async function handleHumanReviewMedia(req, res, url) {
  const media = safeReviewMediaRef(url.searchParams.get("ref"));
  if (!existsSync(media.resolvedPath) || statSync(media.resolvedPath).isDirectory()) {
    throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
  }
  res.writeHead(200, {
    ...SAFE_RESPONSE_HEADERS,
    "content-type": "video/mp4",
    "content-disposition": `inline; filename="${safeDownloadFileName(media.relativePath.split("/").pop(), "review-video.mp4")}"`,
  });
  const stream = createReadStream(media.resolvedPath);
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  const target = safeStaticPath(pathname);
  if (!target || !existsSync(target) || statSync(target).isDirectory()) return false;
  res.writeHead(200, { ...SAFE_RESPONSE_HEADERS, "content-type": mimeFor(target) });
  createReadStream(target).pipe(res);
  return true;
}

async function route(req, res) {
  const rid = requestId();
  res.setHeader("x-request-id", rid);
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  try {
    if (req.method === "GET" && pathname === "/health") return await handleHealth(req, res, rid);
    if (req.method === "POST" && pathname === "/api/youtube/validate") return await handleYouTubeValidate(req, res, rid);
    if (req.method === "POST" && pathname === "/api/youtube/ingest") return await handleYouTubeIngest(req, res, rid);
    if (req.method === "POST" && pathname === "/api/uploads") return await handleUpload(req, res, rid);
    if (req.method === "POST" && pathname === "/api/review/register") return await handleReviewRegister(req, res, rid);
    if (req.method === "GET" && pathname === "/api/review/latest") return await handleHumanReviewLatest(req, res);
    if (req.method === "POST" && pathname === "/api/review/human") return await handleHumanReviewSubmit(req, res, rid);
    if (req.method === "GET" && pathname === "/api/review/media") return await handleHumanReviewMedia(req, res, url);
    if (req.method === "POST" && pathname === "/api/review/regeneration-plan") return await handleReviewRegenerationPlan(req, res, rid);
    if (req.method === "POST" && pathname === "/api/review/regeneration-approval") return await handleReviewRegenerationApproval(req, res, rid);

    const generateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/generate$/);
    if (req.method === "POST" && generateMatch) return await handleGenerate(req, res, rid, generateMatch[1]);

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) return await handleGetJob(req, res, jobMatch[1]);

    const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) return await handleCancelJob(req, res, cancelMatch[1]);

    const downloadMatch = pathname.match(/^\/api\/exports\/([^/]+)\/download$/);
    if (req.method === "GET" && downloadMatch) return await handleDownload(req, res, downloadMatch[1]);

    const downloadUrlMatch = pathname.match(/^\/api\/exports\/([^/]+)\/download-url$/);
    if (req.method === "GET" && downloadUrlMatch) return await handleDownloadUrl(req, res, downloadUrlMatch[1]);

    if (req.method === "GET" && pathname === "/api/artifacts/download") {
      return await handleSignedArtifactDownload(req, res, url);
    }

    if (req.method === "GET" && serveStatic(req, res, pathname)) return undefined;

    if (pathname.startsWith("/api/")) {
      throw new AppError("ROUTE_NOT_FOUND", SAFE_MESSAGES.ROUTE_NOT_FOUND, 404);
    }
    if (req.method !== "GET") {
      throw new AppError("METHOD_NOT_ALLOWED", SAFE_MESSAGES.METHOD_NOT_ALLOWED, 405);
    }
    if (blocksStaticFallback(pathname)) {
      throw new AppError("ROUTE_NOT_FOUND", SAFE_MESSAGES.ROUTE_NOT_FOUND, 404);
    }
    if (!serveStatic(req, res, "/index.html")) {
      throw new AppError("ROUTE_NOT_FOUND", SAFE_MESSAGES.ROUTE_NOT_FOUND, 404);
    }
  } catch (error) {
    sendError(res, error, { requestId: rid });
  }
}

function createAppServer() {
  return createServer(route);
}

function safeListenPort(port) {
  const value = Number(port);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : CONFIG.port;
}

function serverListenFailurePayload(error, port = CONFIG.port) {
  return redactForLogs({
    level: "error",
    event: "server_listen_failed",
    service: "shortsengine-mvp",
    code: sanitizeText(error && error.code ? error.code : "SERVER_LISTEN_FAILED", 80),
    syscall: sanitizeText(error && error.syscall ? error.syscall : "listen", 80),
    port: safeListenPort(port),
    message: "Server failed to start.",
  });
}

function logServerEvent(logger, payload, level = "info") {
  const target = logger && typeof logger[level] === "function" ? logger : console;
  target[level](JSON.stringify(redactForLogs(payload)));
}

function attachServerErrorHandler(server, options = {}) {
  const { logger = console, port = CONFIG.port, exitOnError = false } = options;
  server.on("error", (error) => {
    logServerEvent(logger, serverListenFailurePayload(error, port), "error");
    if (exitOnError) process.exitCode = 1;
  });
  return server;
}

function startServer(port = CONFIG.port, options = {}) {
  const server = createAppServer();
  const logger = options.logger || console;
  attachServerErrorHandler(server, {
    logger,
    port,
    exitOnError: Boolean(options.exitOnError),
  });
  server.listen(port, () => {
    logServerEvent(logger, {
      level: "info",
      event: "server_listening",
      service: "shortsengine-mvp",
      port: safeListenPort(port),
    });
  });
  return server;
}

async function stopWorkers(options = {}) {
  return workerSupervisor.stop(options);
}

if (require.main === module) {
  const server = startServer(CONFIG.port, { exitOnError: true });
  const shutdown = async (signal) => {
    logServerEvent(console, {
      level: "info",
      event: "server_shutdown_requested",
      service: "shortsengine-mvp",
      signal,
    });
    server.close(() => {});
    await stopWorkers({ requestId: `shutdown_${String(signal || "signal").toLowerCase()}` });
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").finally(() => process.exit(0));
  });
}

module.exports = {
  createAppServer,
  startServer,
  serverListenFailurePayload,
  attachServerErrorHandler,
  route,
  parseMultipart,
  safeDownloadFileName,
  MAX_JSON_BODY_BYTES,
  MAX_MULTIPART_FIELD_BYTES,
  MAX_UPLOAD_BODY_OVERHEAD_BYTES,
  uploads,
  projects,
  artifacts,
  jobs,
  jobQueue,
  exportsById,
  artifactStore,
  artifactAdapter,
  persistenceAdapter,
  projectRepository,
  uploadRepository,
  artifactRepository,
  exportRepository,
  regenerationDraftRepository,
  regenerationApprovalRepository,
  approvalOutboxRepository,
  artifactCleanupWorker,
  outboxWorker,
  workerSupervisor,
  stopWorkers,
};
