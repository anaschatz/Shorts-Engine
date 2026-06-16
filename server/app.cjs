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
const { validateUploadCandidate, probeMedia, toolHealth, sha256, sanitizeText } = require("./media.cjs");
const { HOOKS } = require("./edit-plan.cjs");
const { transcriptionHealth } = require("./transcription.cjs");
const { JobStore, idempotencyKey } = require("./jobs.cjs");
const { normalizeSmokeSource } = require("./staging-smoke-metadata.cjs");
const { createReleaseReadiness } = require("./release-readiness.cjs");
const { createLocalJobWorker, restoreExportsFromCompletedJobs } = require("./job-worker.cjs");
const { createWorkerSupervisor } = require("./worker-supervisor.cjs");
const { createLocalJobQueue } = require("./queue/local-job-queue.cjs");
const { createArtifactCleanupWorker } = require("./artifact-cleanup-worker.cjs");
const { createYouTubeIngestAdapter } = require("./adapters/youtube-ingest-adapter.cjs");
const { validateYouTubeSource, youtubeIngestHealth } = require("./youtube-ingest.cjs");
const { createYouTubeIngestService } = require("./youtube-ingest-service.cjs");
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
const restoredState = persistenceAdapter.restoreState();
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
const workerSupervisor = createWorkerSupervisor({
  jobs,
  queue: jobQueue,
  worker: jobWorker,
  logger: console,
});
const recoveredExports = restoreExportsFromCompletedJobs({ jobs, exportRepository, artifactStore, logger: console });
if (restoredState.records > 0) {
  console.info(JSON.stringify({ level: "info", event: "state_rehydrated", records: restoredState.records }));
}
if (recoveredJobs.records > 0 || recoveredJobs.ignored > 0) {
  console.info(JSON.stringify({ level: "info", event: "jobs_rehydrated", ...recoveredJobs, exports: recoveredExports }));
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
  const source = payload.source !== undefined ? normalizeSmokeSource(payload.source) : normalizeSmokeSource(project.source);
  if (payload.idempotencyKey !== undefined) {
    const providedKey = sanitizeText(payload.idempotencyKey, 120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(providedKey)) {
      throw new AppError("VALIDATION_ERROR", "Idempotency key is invalid.", 400);
    }
    return { title, preset, language, source, idempotencyKey: providedKey, rightsConfirmed: Boolean(payload.rightsConfirmed) };
  }
  return { title, preset, language, source, idempotencyKey: "", rightsConfirmed: Boolean(payload.rightsConfirmed) };
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

async function handleHealth(req, res, rid) {
  const tools = toolHealth();
  const storage = storageHealth();
  const artifacts = artifactAdapter.health();
  const repositories = {
    projects: projectRepository.health(),
    uploads: uploadRepository.health(),
    artifacts: artifactRepository.health(),
    exports: exportRepository.health(),
  };
  const adapters = {
    artifacts,
    persistence: persistenceAdapter.health(),
  };
  const provider = transcriptionHealth();
  const analysis = analysisHealth();
  const youtubeIngest = youtubeIngestHealth(youtubeIngestAdapter);
  const cleanup = artifactCleanupWorker.health();
  const worker = jobWorker.health();
  const supervisor = workerSupervisor.health();
  const queue = jobQueue.health();
  const releaseReadiness = createReleaseReadiness({ rootDir: CONFIG.rootDir });
  const storageReady = Object.values(storage).every((entry) => entry.exists && entry.readable && entry.writable);
  const repositoriesReady = Object.values(repositories).every((entry) => entry.ready);
  const adaptersReady = Object.values(adapters).every((entry) => entry.ready);
  const ready = tools.ffmpeg && tools.ffprobe && storageReady && repositoriesReady && adaptersReady && provider.ready && analysis.ready && youtubeIngest.ready;
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
    worker,
    supervisor,
    cleanup,
    artifactIndexReady: repositories.artifacts.ready,
    cleanupWorkerConfigured: cleanup.configured,
    cleanupLastRunAt: cleanup.lastRunAt,
    cleanupLastResult: cleanup.lastResult,
    realCloudIntegrationEnabled: CONFIG.realCloudIntegrationEnabled,
    releaseReadiness,
    transcription: provider,
    analysis,
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
  artifactCleanupWorker,
  workerSupervisor,
  stopWorkers,
};
