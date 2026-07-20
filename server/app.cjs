const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { existsSync, createReadStream, readFileSync, statSync } = require("node:fs");
const { extname, isAbsolute, join, relative, resolve } = require("node:path");
const { URL } = require("node:url");
const { CONFIG, ensureDataDirs } = require("./config.cjs");
const {
  assertPrincipalCanAccessOwner,
  authenticateRequest,
  publicAuthHealth,
  safePrincipal,
} = require("./auth.cjs");
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
const { createGoalEvidenceProvider } = require("./goal-evidence-provider.cjs");
const { scoreboardOcrHealth } = require("./scoreboard-ocr.cjs");
const { visionHealth } = require("./vision.cjs");
const { validateUploadCandidate, probeMedia, toolHealth, sha256, sanitizeText } = require("./media.cjs");
const { HOOKS, RENDER_STYLE_PRESETS, normalizeStylePreset } = require("./edit-plan.cjs");
const { transcriptionHealth } = require("./transcription.cjs");
const { trackingProviderHealth } = require("./tracking-provider.cjs");
const { JobStore, idempotencyKey } = require("./jobs.cjs");
const { normalizeSmokeSource } = require("./staging-smoke-metadata.cjs");
const { createReleaseReadiness } = require("./release-readiness.cjs");
const {
  createProductionBetaReadiness,
  loadBetaEvaluationSummary,
} = require("./production-beta-readiness.cjs");
const { createLocalJobWorker, restoreExportsFromCompletedJobs } = require("./job-worker.cjs");
const { createWorkerSupervisor } = require("./worker-supervisor.cjs");
const { createOutboxWorker } = require("./outbox-worker.cjs");
const { createLocalJobQueue } = require("./queue/local-job-queue.cjs");
const { ContentArtifactRepository } = require("./repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("./repositories/content-approval-repository.cjs");
const { PublishApprovalRepository } = require("./repositories/publish-approval-repository.cjs");
const { normalizeDraftBundle } = require("./pipelines/narrated-short/contracts.cjs");
const { fasterWhisperVersion } = require("./adapters/faster-whisper-adapter.cjs");
const { runNarratedDraftJob } = require("./pipelines/narrated-short/draft-job.cjs");
const { runNarratedRenderJob } = require("./pipelines/narrated-short/render-job.cjs");
const { runNarratedAnimationPreplanJob } = require("./pipelines/narrated-short/animation/preplan-job.cjs");
const { CAPTION_RENDERER_VERSION, CAPTION_PROFILE_VERSION } = require("./pipelines/narrated-short/captions/contract.cjs");
const { AUDIO_PROFILE_VERSION } = require("./pipelines/narrated-short/audio-normalization.cjs");
const { NARRATED_COMPOSITOR_VERSION } = require("./pipelines/narrated-short/video-compositor.cjs");
const { QA_PROFILE_VERSION, normalizeQaReport } = require("./pipelines/narrated-short/qa/contract.cjs");
const { EVIDENCE_PROFILE_VERSION } = require("./pipelines/narrated-short/evidence/contract.cjs");
const { buildProductionAnimationPayloadBindings } = require("./pipelines/narrated-short/animation/payload-bindings.cjs");
const { SEMANTIC_SENTENCE_PROFILE_TOKEN } = require("./pipelines/narrated-short/animation/semantic-render-profile.cjs");
const { createLocalLlmScenePlanner } = require("./pipelines/narrated-short/animation/providers/local-llm-scene-planner.cjs");
const { SCENE_PLAN_ARTIFACT_TYPE } = require("./pipelines/narrated-short/animation/scene-plan-artifact.cjs");
const { publicInvalidationSummary, reviseNarratedProject } = require("./pipelines/narrated-short/invalidation.cjs");
const { publicQaSummary } = require("./pipelines/narrated-short/qa/qa-orchestrator.cjs");
const { createPublishApproval, verifyReleaseEligibility } = require("./pipelines/narrated-short/publish/service.cjs");
const { runNarrationAlignmentJob } = require("./pipelines/narrated-short/narration/align-job.cjs");
const {
  ingestUploadedNarration,
  MAX_NARRATION_BYTES,
  NARRATION_FILE_FIELD,
} = require("./pipelines/narrated-short/narration/upload.cjs");
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
const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
const contentApprovalRepository = new ContentApprovalRepository();
contentApprovalRepository.recover();
const publishApprovalRepository = new PublishApprovalRepository();
publishApprovalRepository.recover();
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

function publicYouTubeIngestHealth(adapter) {
  const health = youtubeIngestHealth(adapter);
  const sourceCacheEnabled = Boolean(CONFIG.sourceCache && CONFIG.sourceCache.enabled);
  const sourceCacheAvailable = Boolean(CONFIG.youtubeIngest.enabled && sourceCacheEnabled);
  return {
    ...health,
    sourceCacheEnabled,
    sourceCacheAvailable,
    sourceCacheRequiresChecksum: Boolean(CONFIG.sourceCache && CONFIG.sourceCache.requireChecksum),
    ingestAvailable: Boolean(health.ingestAvailable || sourceCacheAvailable),
    ready: Boolean(health.ready || sourceCacheAvailable),
  };
}

const STATIC_ASSETS = new Set(["index.html", "styles.css", "hardening.js", "app.js"]);
const BLOCKED_STATIC_PREFIXES = ["/server/", "/data/", "/tests/", "/OpenViking/", "/promptfoo/", "/pm-skills/", "/viking-brain/"];
const MAX_MULTIPART_FIELDS = 12;
const MAX_MULTIPART_FILES = 1;
const MAX_MULTIPART_BOUNDARY_BYTES = 100;
const MAX_MULTIPART_FIELD_BYTES = 4 * 1024;
const MAX_MULTIPART_HEADER_BYTES = 8 * 1024;
const MAX_UPLOAD_BODY_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_NARRATED_JSON_BODY_BYTES = 128 * 1024;
const UPLOAD_FILE_FIELD = "video";
const GOAL_SELECTION_MODES = Object.freeze(["balanced", "valid_goals_only"]);
const COMPOSITION_MODES = Object.freeze(["auto", "single_moment", "multi_moment"]);
const REVIEW_MEDIA_PREFIX = "manual-downloads/";
const OCR_QA_MANIFEST_REF_RE = /^demo\/results\/ocr-artifacts\/ocr-[A-Za-z0-9._-]+\/ocr-qa-manifest\.json$/;
const OCR_QA_CROP_ID_RE = /^[A-Za-z0-9._-]{1,96}$/;
const OCR_QA_LATEST_REPORT_REF = "demo/results/ocr-latest.json";
const OCR_QA_REVIEW_LATEST_REPORT_REF = "demo/results/ocr-qa-review-latest.json";
const OCR_QA_MAX_REPORT_BYTES = 512 * 1024;
const OCR_QA_MAX_PUBLIC_CROP_BYTES = 512 * 1024;
const OCR_QA_SUPPORT_POLICY = Object.freeze({
  goalEvidencePolicy: "support_only",
  ocrOnlyGoalAllowed: false,
  noFalseGoalFromOcrOnly: true,
});
const HUMAN_REVIEW_PUBLIC_FLAGS = Object.freeze([
  "falseGoalClaim",
  "wrongMoment",
  "badCrop",
  "captionMismatch",
  "textBlocksAction",
  "missingPayoff",
  "reactionOnly",
  "lowEnergy",
  "missingTrendEditing",
]);

function safeRootRelativePath(filePath) {
  const fromRoot = relative(CONFIG.rootDir, resolve(filePath)).replace(/\\/g, "/");
  if (!fromRoot || fromRoot.startsWith("../") || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new AppError("STORAGE_PATH_UNSAFE", "Review records must stay inside the workspace.", 500);
  }
  return fromRoot;
}

function reviewRecordRefs(projectId) {
  return {
    projectRecord: safeRootRelativePath(join(CONFIG.projectDir, `${projectId}.json`)),
    renderRecord: safeRootRelativePath(join(CONFIG.projectDir, `${projectId}.render.json`)),
  };
}

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
    contentArtifactRepository,
    contentApprovalRepository,
    runNarratedDraftJob,
    runNarrationAlignmentJob,
    runNarratedAnimationPreplanJob,
    runNarratedRenderJob,
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

function requirePrincipal(req) {
  return authenticateRequest(req, CONFIG.auth);
}

function publicPrincipal(principal) {
  return safePrincipal(principal);
}

function assertOwnerAccess(principal, ownerId, resource) {
  return assertPrincipalCanAccessOwner(principal, ownerId, { resource });
}

function assertProjectAccess(project, principal) {
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertOwnerAccess(principal, project.ownerId, "project");
  return project;
}

function assertUploadAccess(upload, principal) {
  if (!upload) throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  if (upload.ownerId) return assertOwnerAccess(principal, upload.ownerId, "upload");
  const project = persistenceAdapter.getProject(upload.projectId);
  assertProjectAccess(project, principal);
  return true;
}

function assertJobAccess(job, principal) {
  if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
  if (job.ownerId) return assertOwnerAccess(principal, job.ownerId, "job");
  const project = persistenceAdapter.getProject(job.projectId);
  assertProjectAccess(project, principal);
  return true;
}

function assertExportAccess(exportRecord, principal) {
  if (!exportRecord) throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  if (exportRecord.ownerId) return assertOwnerAccess(principal, exportRecord.ownerId, "export");
  const project = persistenceAdapter.getProject(exportRecord.projectId);
  assertProjectAccess(project, principal);
  return true;
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
  const goalSelectionMode = payload.goalSelectionMode === undefined
    ? null
    : sanitizeText(payload.goalSelectionMode, 40).toLowerCase();
  if (goalSelectionMode !== null && !GOAL_SELECTION_MODES.includes(goalSelectionMode)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported goal selection mode.", 400);
  }
  const compositionMode = payload.compositionMode === undefined
    ? "auto"
    : sanitizeText(payload.compositionMode, 40).toLowerCase();
  if (!COMPOSITION_MODES.includes(compositionMode)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported composition mode.", 400);
  }
  const expectedCountedGoals = payload.expectedCountedGoals === undefined
    ? null
    : Number(payload.expectedCountedGoals);
  if (expectedCountedGoals !== null && (!Number.isInteger(expectedCountedGoals) || expectedCountedGoals < 0 || expectedCountedGoals > 20)) {
    throw new AppError("VALIDATION_ERROR", "Expected counted goals must be between 0 and 20.", 400);
  }
  const expectedFinalScore = payload.expectedFinalScore === undefined
    ? null
    : sanitizeText(payload.expectedFinalScore, 16);
  if (expectedFinalScore !== null && !/^\d{1,2}-\d{1,2}$/.test(expectedFinalScore)) {
    throw new AppError("VALIDATION_ERROR", "Expected final score is invalid.", 400);
  }
  if (expectedFinalScore !== null && expectedCountedGoals !== null) {
    const [home, away] = expectedFinalScore.split("-").map(Number);
    if (home + away !== expectedCountedGoals) {
      throw new AppError("VALIDATION_ERROR", "Expected final score does not match the counted goal total.", 400);
    }
  }
  const source = payload.source !== undefined ? normalizeSmokeSource(payload.source) : normalizeSmokeSource(project.source);
  if (payload.idempotencyKey !== undefined) {
    const providedKey = sanitizeText(payload.idempotencyKey, 120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(providedKey)) {
      throw new AppError("VALIDATION_ERROR", "Idempotency key is invalid.", 400);
    }
    return { title, preset, language, styleTarget, editIntensity, stylePreset, goalSelectionMode, compositionMode, expectedCountedGoals, expectedFinalScore, source, idempotencyKey: providedKey, rightsConfirmed: Boolean(payload.rightsConfirmed) };
  }
  return { title, preset, language, styleTarget, editIntensity, stylePreset, goalSelectionMode, compositionMode, expectedCountedGoals, expectedFinalScore, source, idempotencyKey: "", rightsConfirmed: Boolean(payload.rightsConfirmed) };
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
  const trackingProvider = trackingProviderHealth();
  const scoreboardOcr = scoreboardOcrHealth();
  const goalEvidence = createGoalEvidenceProvider().health();
  const youtubeIngest = publicYouTubeIngestHealth(youtubeIngestAdapter);
  const auth = publicAuthHealth(CONFIG.auth);
  const cleanup = artifactCleanupWorker.health();
  const outbox = outboxWorker.health();
  const worker = jobWorker.health();
  const supervisor = workerSupervisor.health();
  const queue = jobQueue.health();
  const releaseReadiness = createReleaseReadiness({ rootDir: CONFIG.rootDir });
  const productionBeta = createProductionBetaReadiness({
    persistence: adapters.persistence,
    artifacts,
    queue,
    auth,
    evaluation: loadBetaEvaluationSummary({ rootDir: CONFIG.rootDir }),
    humanReviewGateAvailable: true,
  });
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
    trackingProvider.ready &&
    scoreboardOcr.ready &&
    goalEvidence.ready &&
    auth.ready &&
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
    productionBeta,
    auth,
    transcription: provider,
    analysis,
    frameExtraction,
    vision,
    trackingProvider,
    scoreboardOcr,
    goalEvidence,
    youtubeIngest,
    requestId: rid,
  });
}

async function handleYouTubeValidate(req, res, rid, principal) {
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
    principal: publicPrincipal(principal),
  }));
  sendOk(res, { source });
}

async function handleYouTubeIngest(req, res, rid, principal) {
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
    ownerId: principal.id,
  });
  console.info(JSON.stringify({
    level: "info",
    event: "youtube_ingest_accepted",
    requestId: rid,
    sourceType: "youtube",
    videoId: result.source.videoId,
    projectId: result.project.id,
    uploadId: result.upload.id,
    principal: publicPrincipal(principal),
  }));
  sendOk(res, result, 201);
}

async function handleUpload(req, res, rid, principal) {
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
      ownerId: principal.id,
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
      ownerId: principal.id,
      source,
      createdAt,
      updatedAt: createdAt,
    },
  });
  console.info(JSON.stringify({ level: "info", event: "upload_accepted", requestId: rid, projectId, uploadId, principal: publicPrincipal(principal) }));
  sendOk(res, {
    upload: persistenceAdapter.publicUpload(upload),
    project: persistenceAdapter.publicProject(project),
  }, 201);
}

function narratedArtifactSummary(project) {
  const ids = [
    project.input.briefArtifactId,
    project.input.claimLedgerArtifactId,
    project.input.scriptArtifactId,
    project.input.storyboardArtifactId,
    project.input.activeNarration && project.input.activeNarration.manifestArtifactId,
    project.input.lastInvalidation && project.input.lastInvalidation.artifactId,
  ].filter(Boolean);
  return ids.map((artifactId) => contentArtifactRepository.publicRecord(artifactId)).filter(Boolean);
}

async function handleUploadNarration(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!uploadLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError("VALIDATION_ERROR", "Narration upload must be multipart/form-data.", 400);
  }
  const maxBodyBytes = MAX_NARRATION_BYTES + MAX_UPLOAD_BODY_OVERHEAD_BYTES;
  enforceContentLength(req, maxBodyBytes);
  const body = await readRequestBody(req, maxBodyBytes);
  const multipart = parseMultipart(body, contentType, { allowedFileFields: [NARRATION_FILE_FIELD], maxFiles: 1 });
  if (multipart.files.length !== 1 || multipart.files[0].fieldName !== NARRATION_FILE_FIELD) {
    throw new AppError("NARRATION_WAV_INVALID", SAFE_MESSAGES.NARRATION_WAV_INVALID, 400);
  }
  const result = await ingestUploadedNarration({ project, fields: multipart.fields, file: multipart.files[0] }, {
    artifactStore,
    artifactRepository,
    contentArtifactRepository,
    contentApprovalRepository,
    projectRepository,
    persistenceAdapter,
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "narration_uploaded",
    requestId: rid,
    projectId: project.id,
    projectRevision: project.input.revision,
    narrationStatus: result.narration.status,
    audioArtifactId: result.audioArtifact.id,
  })));
  sendOk(res, {
    project: persistenceAdapter.publicProject(result.project),
    narration: result.narration,
    audioArtifact: artifactRepository.publicArtifact(result.audioArtifact),
    manifestArtifact: contentArtifactRepository.publicRecord(result.manifestArtifact.artifact.id),
  }, 201);
}

async function handleCreateNarratedProject(req, res, rid, principal) {
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_NARRATED_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_NARRATED_JSON_BODY_BYTES);
  const bundle = normalizeDraftBundle(payload.bundle || payload);
  const projectId = `prj_${randomUUID()}`;
  const revision = 1;
  const createArtifact = (type, body, dependencyHashes = []) => contentArtifactRepository.createJson({
    type,
    projectId,
    revision,
    body,
    dependencyHashes,
  });
  const brief = createArtifact("content_brief", bundle.brief);
  const claimLedger = createArtifact("claim_ledger", bundle.claimLedger, [brief.envelope.contentHash]);
  const script = createArtifact("narrative_script", bundle.script, [brief.envelope.contentHash, claimLedger.envelope.contentHash]);
  const storyboard = createArtifact("storyboard", bundle.storyboard, [script.envelope.contentHash]);
  const createdAt = new Date().toISOString();
  const project = persistenceAdapter.persistProject({
    project: {
      id: projectId,
      projectType: "narrated_short",
      title: bundle.script.title,
      language: bundle.brief.language,
      input: {
        type: "content_brief",
        briefArtifactId: brief.artifact.id,
        claimLedgerArtifactId: claimLedger.artifact.id,
        scriptArtifactId: script.artifact.id,
        storyboardArtifactId: storyboard.artifact.id,
        revision,
      },
      status: "draft",
      ownerId: principal.id,
      createdAt,
      updatedAt: createdAt,
    },
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "narrated_project_created",
    requestId: rid,
    projectId,
    formatId: bundle.brief.formatId,
    revision,
  })));
  sendOk(res, {
    project: persistenceAdapter.publicProject(project),
    artifacts: narratedArtifactSummary(project),
  }, 201);
}

async function handleGetNarratedProject(req, res, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  const approval = contentApprovalRepository.findApproved(project.id, project.input.revision);
  sendOk(res, {
    project: persistenceAdapter.publicProject(project),
    artifacts: narratedArtifactSummary(project),
    approval: contentApprovalRepository.publicApproval(approval),
    invalidation: publicInvalidationSummary(project),
  });
}

async function handleReviseNarratedProject(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_NARRATED_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_NARRATED_JSON_BODY_BYTES);
  const allowed = new Set(["expectedRevision", "changeType", "bundle", "idempotencyKey"]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key });
  const idempotencyValue = payload.idempotencyKey === undefined ? null : sanitizeText(payload.idempotencyKey, 120);
  if (idempotencyValue !== null && !/^[A-Za-z0-9_-]{8,120}$/.test(idempotencyValue)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "idempotencyKey" });
  const result = reviseNarratedProject({ project, expectedRevision: payload.expectedRevision, changeType: payload.changeType, bundle: payload.bundle, idempotencyKey: idempotencyValue }, { contentArtifacts: contentArtifactRepository, artifactRepository, projectRepository, approvalRepository: contentApprovalRepository, publishApprovalRepository, persistenceAdapter });
  console.info(JSON.stringify(redactForLogs({ level: "info", event: "narrated_project_revised", requestId: rid, projectId: project.id, fromRevision: Number(payload.expectedRevision), toRevision: result.project.input.revision, changeType: payload.changeType, replayed: result.replayed, narrationReused: result.project.input.lastInvalidation && result.project.input.lastInvalidation.narrationReused, principal: publicPrincipal(principal) })));
  sendOk(res, { project: persistenceAdapter.publicProject(result.project), invalidation: publicInvalidationSummary(result.project), invalidationArtifact: contentArtifactRepository.publicRecord(result.reportArtifact.artifact.id), draft: result.artifacts ? contentArtifactRepository.publicRecord(result.artifacts.approvalBundle.artifact.id) : null, replayed: result.replayed }, result.replayed ? 200 : 201);
}

async function handleDraftNarratedProject(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const requestPayload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const payload = {
    projectRevision: project.input.revision,
    language: project.language,
    providerMode: "manual",
    briefArtifactId: project.input.briefArtifactId,
    claimLedgerArtifactId: project.input.claimLedgerArtifactId,
    scriptArtifactId: project.input.scriptArtifactId,
    storyboardArtifactId: project.input.storyboardArtifactId,
  };
  const key = requestPayload.idempotencyKey || idempotencyKey("draft_narrated_short", {
    projectId: project.id,
    revision: project.input.revision,
    artifacts: [payload.briefArtifactId, payload.claimLedgerArtifactId, payload.scriptArtifactId, payload.storyboardArtifactId],
  });
  const job = jobQueue.create({
    projectId: project.id,
    ownerId: principal.id,
    action: "draft_narrated_short",
    pipelineType: "narrated_short",
    idempotencyKey: key,
    payload,
  });
  if (job.status === "queued") workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: rid }), { requestId: rid });
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handleApproveNarratedProject(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const envelope = contentArtifactRepository.readJson(payload.draftArtifactId);
  if (envelope.artifactType !== "approval_bundle" || envelope.projectId !== project.id || envelope.revision !== project.input.revision) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Draft artifact does not match the project revision.", 409);
  }
  const suppliedHash = sanitizeText(payload.draftHash || envelope.contentHash, 80).toLowerCase().replace(/^sha256:/, "");
  if (suppliedHash !== envelope.contentHash) throw new AppError("ARTIFACT_CONTENT_INVALID", "Draft hash does not match the approval bundle.", 409);
  const approval = contentApprovalRepository.approve({
    projectId: project.id,
    projectRevision: project.input.revision,
    draftArtifactId: payload.draftArtifactId,
    draftHash: envelope.contentHash,
    voiceProfileId: payload.voiceProfileId,
    renderProfile: payload.renderProfile,
    operatorNote: payload.operatorNote,
  });
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "narrated_draft_approved",
    requestId: rid,
    projectId: project.id,
    approvalId: approval.approvalId,
    projectRevision: project.input.revision,
  })));
  sendOk(res, { approval: contentApprovalRepository.publicApproval(approval) }, 201);
}

async function handleAlignNarration(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const requestPayload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  for (const key of Object.keys(requestPayload)) if (key !== "idempotencyKey") throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key });
  const active = project.input.activeNarration;
  if (!active) throw new AppError("NARRATION_ALIGNMENT_REQUIRED", SAFE_MESSAGES.NARRATION_ALIGNMENT_REQUIRED, 409);
  const approval = contentApprovalRepository.findApproved(project.id, project.input.revision);
  if (!approval || active.draftArtifactId !== approval.draftArtifactId || active.draftHash !== approval.draftHash) throw new AppError("NARRATION_ALIGNMENT_STALE", SAFE_MESSAGES.NARRATION_ALIGNMENT_STALE, 409);
  const payload = {
    projectRevision: project.input.revision, language: project.language,
    approvedDraftArtifactId: approval.draftArtifactId, approvedDraftHash: approval.draftHash,
    narrationManifestArtifactId: active.manifestArtifactId, narrationManifestHash: active.manifestHash,
    audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, scriptHash: active.scriptHash,
    alignerVersion: fasterWhisperVersion(process.env),
  };
  const key = requestPayload.idempotencyKey || idempotencyKey("align_narration", { projectId: project.id, ...payload });
  const job = jobQueue.create({ projectId: project.id, ownerId: principal.id, action: "align_narration", pipelineType: "narrated_short", idempotencyKey: key, payload });
  if (job.status === "queued") workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: rid }), { requestId: rid });
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handlePlanNarratedAnimation(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) {
    throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  }
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") {
    throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const requestPayload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  if (
    !requestPayload
    || typeof requestPayload !== "object"
    || Array.isArray(requestPayload)
  ) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "body" });
  }
  for (const key of Object.keys(requestPayload)) {
    if (key !== "animationProfile") {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key });
    }
  }
  const animationProfile = requestPayload.animationProfile
    ?? SEMANTIC_SENTENCE_PROFILE_TOKEN;
  if (animationProfile !== SEMANTIC_SENTENCE_PROFILE_TOKEN) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "animationProfile" });
  }
  const approval = contentApprovalRepository.findApproved(
    project.id,
    project.input.revision,
  );
  const active = project.input.activeNarration;
  if (!approval) {
    throw new AppError("CONTENT_APPROVAL_REQUIRED", "Approve the narrated draft before animation preplanning.", 409);
  }
  if (
    !active
    || active.status !== "aligned"
    || active.aligned !== true
    || active.timingReady !== true
    || !active.alignmentArtifactId
    || active.projectRevision !== project.input.revision
    || active.draftArtifactId !== approval.draftArtifactId
    || active.draftHash !== approval.draftHash
    || !active.alignmentHash
  ) {
    throw new AppError("NARRATION_ALIGNMENT_REQUIRED", SAFE_MESSAGES.NARRATION_ALIGNMENT_REQUIRED, 409);
  }
  const plannerHealth = createLocalLlmScenePlanner({ env: process.env }).health();
  if (String(CONFIG.environment).toLowerCase() === "production" && plannerHealth.mode === "mock") {
    throw new AppError(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field: "mode" },
    );
  }
  const payload = {
    projectRevision: project.input.revision,
    language: project.language,
    approvedDraftArtifactId: approval.draftArtifactId,
    approvedDraftHash: approval.draftHash,
    alignmentArtifactId: active.alignmentArtifactId,
    alignmentHash: active.alignmentHash,
    renderProfile: approval.renderProfile,
    animationProfile,
    plannerMode: plannerHealth.mode,
    promptProfileId: plannerHealth.promptProfileId,
    plannerConfigurationHash: plannerHealth.configurationHash,
  };
  const operationKey = idempotencyKey("plan_narrated_animation", {
    projectId: project.id,
    ...payload,
  });
  const jobsByIdempotencyKey = new Map(
    jobQueue.all().map((candidate) => [candidate.idempotencyKey, candidate]),
  );
  const visitedKeys = new Set();
  let key = operationKey;
  while (true) {
    if (visitedKeys.has(key)) {
      throw new AppError(
        "JOB_STATE_INVALID",
        SAFE_MESSAGES.JOB_STATE_INVALID,
        409,
      );
    }
    visitedKeys.add(key);
    const existingJob = jobsByIdempotencyKey.get(key);
    if (!existingJob) break;
    const activePlan = project.input.activeAnimationScenePlan;
    const completedPlanIsActive = Boolean(
      existingJob.status === "completed"
      && existingJob.animationScenePlan?.required === true
      && activePlan
      && activePlan.planArtifactId
        === existingJob.animationScenePlan.artifactId
      && activePlan.planHash === existingJob.animationScenePlan.contentHash
      && activePlan.draftHash === payload.approvedDraftHash
      && activePlan.alignmentHash === payload.alignmentHash
      && activePlan.plannerMode === payload.plannerMode
      && activePlan.promptProfileId === payload.promptProfileId
      && activePlan.plannerConfigurationHash
        === payload.plannerConfigurationHash
    );
    if (completedPlanIsActive) {
      let envelope;
      try {
        envelope = contentArtifactRepository.readJson(
          activePlan.planArtifactId,
        );
      } catch {
        throw new AppError(
          "ANIMATION_SCENE_PLAN_ARTIFACT_INVALID",
          "The persisted animation scene plan is invalid or stale.",
          409,
          { reason: "active_artifact_unreadable" },
        );
      }
      if (
        envelope.artifactType !== SCENE_PLAN_ARTIFACT_TYPE
        || envelope.projectId !== project.id
        || envelope.revision !== payload.projectRevision
        || envelope.contentHash !== activePlan.planHash
        || envelope.body?.contentHash !== activePlan.planHash
        || !envelope.dependencyHashes.includes(payload.approvedDraftHash)
        || !envelope.dependencyHashes.includes(payload.alignmentHash)
        || !envelope.dependencyHashes.includes(
          payload.plannerConfigurationHash,
        )
      ) {
        throw new AppError(
          "ANIMATION_SCENE_PLAN_ARTIFACT_INVALID",
          "The persisted animation scene plan is invalid or stale.",
          409,
          { reason: "active_artifact_binding_mismatch" },
        );
      }
    }
    if (
      ["queued", "processing"].includes(existingJob.status)
      || completedPlanIsActive
      || (
        existingJob.status === "completed"
        && existingJob.animationScenePlan?.required === false
      )
    ) break;
    key = idempotencyKey("plan_narrated_animation_retry", {
      operationKey,
      previousJobId: existingJob.id,
    });
  }
  const job = jobQueue.create({
    projectId: project.id,
    ownerId: principal.id,
    action: "plan_narrated_animation",
    pipelineType: "narrated_short",
    idempotencyKey: key,
    payload,
  });
  if (job.status === "queued") {
    workerSupervisor.enqueue(
      jobQueue.enqueue(job, { requestId: rid }),
      { requestId: rid },
    );
  }
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handleRenderNarratedProject(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const requestPayload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  for (const key of Object.keys(requestPayload)) if (!["idempotencyKey", "animationProfile"].includes(key)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key });
  const animationProfile = requestPayload.animationProfile === undefined || requestPayload.animationProfile === null || requestPayload.animationProfile === ""
    ? null
    : requestPayload.animationProfile;
  if (animationProfile !== null && animationProfile !== SEMANTIC_SENTENCE_PROFILE_TOKEN) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "animationProfile" });
  }
  const suppliedIdempotencyKey = requestPayload.idempotencyKey === undefined || requestPayload.idempotencyKey === null || requestPayload.idempotencyKey === ""
    ? null
    : sanitizeText(requestPayload.idempotencyKey, 120);
  if (animationProfile && suppliedIdempotencyKey !== null && !/^[A-Za-z0-9_-]{8,120}$/.test(suppliedIdempotencyKey)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "idempotencyKey" });
  }
  const approval = contentApprovalRepository.findApproved(project.id, project.input.revision);
  if (!approval) throw new AppError("CONTENT_APPROVAL_REQUIRED", "Approve the narrated draft before rendering.", 409);
  const activeNarration = project.input.activeNarration;
  if (animationProfile && (
    !activeNarration
    || activeNarration.status !== "aligned"
    || activeNarration.aligned !== true
    || activeNarration.timingReady !== true
    || !activeNarration.alignmentArtifactId
  )) {
    throw new AppError("NARRATION_ALIGNMENT_REQUIRED", SAFE_MESSAGES.NARRATION_ALIGNMENT_REQUIRED, 409);
  }
  const payload = {
    projectRevision: project.input.revision,
    language: project.language,
    approvedDraftArtifactId: approval.draftArtifactId,
    approvedDraftHash: approval.draftHash,
    renderProfile: approval.renderProfile,
    narrationManifestHash: project.input.activeNarration && project.input.activeNarration.manifestHash || null,
    audioHash: project.input.activeNarration && project.input.activeNarration.audioHash || null,
    alignmentHash: project.input.activeNarration && project.input.activeNarration.alignmentHash || null,
    captionRendererVersion: CAPTION_RENDERER_VERSION,
    captionProfileVersion: CAPTION_PROFILE_VERSION,
    audioNormalizationProfileVersion: AUDIO_PROFILE_VERSION,
    compositorVersion: NARRATED_COMPOSITOR_VERSION,
    qaProfileVersion: QA_PROFILE_VERSION,
    evidenceProfileVersion: EVIDENCE_PROFILE_VERSION,
  };
  if (animationProfile) payload.animationProfile = animationProfile;
  const renderPlannerHealth = animationProfile
    ? createLocalLlmScenePlanner({ env: process.env }).health()
    : null;
  if (
    renderPlannerHealth
    && String(CONFIG.environment).toLowerCase() === "production"
    && renderPlannerHealth.mode === "mock"
  ) {
    throw new AppError(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field: "mode" },
    );
  }
  Object.assign(payload, buildProductionAnimationPayloadBindings({
    project,
    approval,
    renderProfile: approval.renderProfile,
    animationProfile,
    contentArtifacts: contentArtifactRepository,
  }, {
    requirePersistedScenePlan: Boolean(renderPlannerHealth),
    expectedScenePlanner: renderPlannerHealth,
  }));
  const renderIdentity = {
    projectId: project.id,
    revision: project.input.revision,
    draftHash: approval.draftHash,
    renderProfile: approval.renderProfile,
    narrationManifestHash: payload.narrationManifestHash,
    audioHash: payload.audioHash,
    alignmentHash: payload.alignmentHash,
    captionRendererVersion: payload.captionRendererVersion,
    captionProfileVersion: payload.captionProfileVersion,
    audioNormalizationProfileVersion: payload.audioNormalizationProfileVersion,
    compositorVersion: payload.compositorVersion,
    qaProfileVersion: payload.qaProfileVersion,
    evidenceProfileVersion: payload.evidenceProfileVersion,
    timingContextHash: payload.timingContextHash,
    animationPlanHash: payload.animationPlanHash,
    animationIRHash: payload.animationIRHash,
    animationProvider: payload.animationProvider,
    animationRuntimeVersion: payload.animationRuntimeVersion,
    animationStyleVersion: payload.animationStyleVersion,
    ...(payload.animationScenePlanArtifactId
      ? {
        animationScenePlanArtifactId: payload.animationScenePlanArtifactId,
        animationScenePlanHash: payload.animationScenePlanHash,
      }
      : {}),
  };
  const key = animationProfile
    ? idempotencyKey(
      suppliedIdempotencyKey ? "render_narrated_short_profile_request" : "render_narrated_short",
      { ...(suppliedIdempotencyKey ? { suppliedIdempotencyKey } : {}), ...renderIdentity, animationProfile },
    )
    : requestPayload.idempotencyKey || idempotencyKey("render_narrated_short", renderIdentity);
  const job = jobQueue.create({
    projectId: project.id,
    ownerId: principal.id,
    action: "render_narrated_short",
    pipelineType: "narrated_short",
    idempotencyKey: key,
    payload,
  });
  if (job.status === "queued") workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: rid }), { requestId: rid });
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handleNarratedProjectQa(req, res, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  const approval = contentApprovalRepository.findApproved(project.id, project.input.revision);
  const candidates = artifactRepository.listByOwner({ projectId: project.id }).filter((record) => record.type === "qa_report" && record.status === "available").map((record) => {
    try {
      const envelope = contentArtifactRepository.readJson(record.id);
      const report = normalizeQaReport(envelope.body);
      if (envelope.revision !== project.input.revision || report.projectRevision !== project.input.revision || !approval || report.bindings.draftArtifactId !== approval.draftArtifactId || report.bindings.draftHash !== approval.draftHash) return null;
      if (project.input.activeNarration && (report.bindings.audioHash !== project.input.activeNarration.audioHash || report.bindings.alignmentHash !== project.input.activeNarration.alignmentHash)) return null;
      return { record, envelope, report };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.envelope.createdAt).localeCompare(String(a.envelope.createdAt)));
  if (!candidates.length) throw new AppError("QA_REQUIRED", SAFE_MESSAGES.QA_REQUIRED, 409);
  const latest = candidates[0];
  sendOk(res, { qa: publicQaSummary(latest.report, { artifact: latest.record, envelope: latest.envelope }) });
}

async function handlePublishApprove(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  const project = persistenceAdapter.getProject(safeProjectId); if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal); if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req); enforceContentLength(req, MAX_JSON_BODY_BYTES); const request = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const result = createPublishApproval({ project, operatorId: principal.id, request }, { publishApprovalRepository, contentArtifactRepository, contentApprovalRepository, artifactRepository, exportRepository });
  console.info(JSON.stringify(redactForLogs({ level: "info", event: "publish_approval_created", requestId: rid, projectId: project.id, projectRevision: project.input.revision, publishApprovalId: result.approval.publishApprovalId, outputHash: result.approval.outputHash, replayed: result.replayed, principal: publicPrincipal(principal) })));
  sendOk(res, { approval: result.approval, eligible: true, releaseToken: result.releaseToken, expiresAt: result.approval.expiresAt, outputHash: result.approval.outputHash, projectRevision: result.approval.projectRevision, warningAcknowledgements: result.approval.warningAcknowledgements, replayed: result.replayed }, result.replayed ? 200 : 201);
}

async function releaseEligibilityForRequest(req, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj"); const project = persistenceAdapter.getProject(safeProjectId); if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal); if (project.projectType !== "narrated_short") throw new AppError("PROJECT_TYPE_MISMATCH", "Project is not a narrated Short.", 409);
  validateJsonContentType(req); enforceContentLength(req, MAX_JSON_BODY_BYTES); const request = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const eligibility = verifyReleaseEligibility({ project, request }, { publishApprovalRepository, contentApprovalRepository, artifactRepository }); return { project, eligibility };
}

async function handleReleaseVerify(req, res, projectId, principal) {
  const { eligibility } = await releaseEligibilityForRequest(req, projectId, principal);
  sendOk(res, { eligible: true, projectId: eligibility.projectId, projectRevision: eligibility.projectRevision, outputHash: eligibility.outputHash, expiresAt: eligibility.expiresAt, publishApprovalId: eligibility.publishApprovalId });
}

async function handleFinalDownloadUrl(req, res, projectId, principal) {
  const { eligibility } = await releaseEligibilityForRequest(req, projectId, principal); const exportRecord = exportRepository.all().find((value) => value.projectId === eligibility.projectId && value.artifact && value.artifact.id === eligibility.artifact.id && value.status === "completed");
  if (!exportRecord) throw new AppError("FINAL_DOWNLOAD_BLOCKED", SAFE_MESSAGES.FINAL_DOWNLOAD_BLOCKED, 409);
  const remainingSeconds = Math.floor((Date.parse(eligibility.expiresAt) - Date.now()) / 1000); if (remainingSeconds <= 0) throw new AppError("RELEASE_TOKEN_EXPIRED", SAFE_MESSAGES.RELEASE_TOKEN_EXPIRED, 409, { expiresAt: eligibility.expiresAt });
  const job = jobQueue.get(exportRecord.jobId); assertJobAccess(job, principal); const signed = persistenceAdapter.createSignedExportDownload(exportRecord, { job, basePath: "/api/artifacts/download", ttlSeconds: Math.min(300, remainingSeconds) });
  sendOk(res, { eligible: true, projectId: eligibility.projectId, projectRevision: eligibility.projectRevision, outputHash: eligibility.outputHash, publishApprovalId: eligibility.publishApprovalId, downloadUrl: signed.downloadUrl, expiresAt: signed.expiresAt, ttlSeconds: signed.ttlSeconds });
}

async function handleGenerate(req, res, rid, projectId, principal) {
  const safeProjectId = validateRouteId(projectId, "prj");
  if (!generateLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  const project = persistenceAdapter.getProject(safeProjectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  assertProjectAccess(project, principal);
  const upload = persistenceAdapter.getUpload(project.uploadId);
  if (!upload) throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  assertUploadAccess(upload, principal);
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
    goalSelectionMode: validatedPayload.goalSelectionMode,
    compositionMode: validatedPayload.compositionMode,
    expectedCountedGoals: validatedPayload.expectedCountedGoals,
    expectedFinalScore: validatedPayload.expectedFinalScore,
    title: validatedPayload.title,
  });
  const job = jobQueue.create({
    projectId: safeProjectId,
    uploadId: upload.id,
    ownerId: principal.id,
    action: "generate",
    idempotencyKey: key,
    payload: validatedPayload,
  });
  if (job.status === "queued") {
    workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: rid }), { requestId: rid });
  }
  sendOk(res, { job: jobQueue.publicJob(job) }, 202);
}

async function handleGetJob(req, res, jobId, principal) {
  const safeJobId = validateRouteId(jobId, "job");
  const job = jobQueue.get(safeJobId);
  if (!job) throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
  assertJobAccess(job, principal);
  const url = new URL(req.url, "http://localhost");
  const view = sanitizeText(url.searchParams.get("view") || "", 40);
  const publicJob = view === "summary" ? jobQueue.publicJobSummary(job) : jobQueue.publicJob(job);
  sendOk(res, { job: publicJob });
}

async function handleCancelJob(req, res, jobId, principal) {
  const safeJobId = validateRouteId(jobId, "job");
  const existing = jobQueue.get(safeJobId);
  assertJobAccess(existing, principal);
  const job = jobQueue.cancel(safeJobId);
  sendOk(res, { job: jobQueue.publicJob(job) });
}

function completedExportDescriptor(exportId, principal) {
  const safeExportId = validateRouteId(exportId, "exp");
  const record = persistenceAdapter.getExport(safeExportId);
  if (!record) throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  assertExportAccess(record, principal);
  const job = jobQueue.get(record.jobId);
  assertJobAccess(job, principal);
  if (job && job.pipelineType === "narrated_short" && job.narratedRender && job.narratedRender.technicalFinal === true) throw new AppError("FINAL_DOWNLOAD_BLOCKED", SAFE_MESSAGES.FINAL_DOWNLOAD_BLOCKED, 409, { nextAction: "create-and-use-current-release-token" });
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

async function handleDownload(req, res, exportId, principal) {
  streamExportDescriptor(res, completedExportDescriptor(exportId, principal));
}

async function handleDownloadUrl(req, res, exportId, principal) {
  const descriptor = completedExportDescriptor(exportId, principal);
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

async function handleReviewRegister(req, res, rid, principal) {
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
  const project = persistenceAdapter.getProject(projectId);
  assertProjectAccess(project, principal);
  const job = jobQueue.get(jobId);
  if (job) assertJobAccess(job, principal);
  if (exportId) assertExportAccess(persistenceAdapter.getExport(exportId), principal);
  const result = registerReviewDraft({
    projectId,
    jobId,
    exportId,
    ...reviewRecordRefs(projectId),
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
    principal: publicPrincipal(principal),
  })));
  sendOk(res, publicReviewRegistrationResult(result), 201);
}

async function handleReviewRegenerationPlan(req, res, rid, principal) {
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
  const project = persistenceAdapter.getProject(projectId);
  assertProjectAccess(project, principal);
  const job = jobQueue.get(jobId);
  if (job) assertJobAccess(job, principal);
  if (exportId) assertExportAccess(persistenceAdapter.getExport(exportId), principal);
  const result = createRegenerationPlanFromReviewRegistration({
    projectId,
    jobId,
    exportId,
    ...reviewRecordRefs(projectId),
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
    principal: publicPrincipal(principal),
  })));
  sendOk(res, publicRegenerationPlanResult(result, draftRecord), 201);
}

async function handleReviewRegenerationApproval(req, res, rid, principal) {
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
  const project = persistenceAdapter.getProject(projectId);
  assertProjectAccess(project, principal);
  const sourceJob = jobQueue.get(sourceJobId);
  if (sourceJob) assertJobAccess(sourceJob, principal);
  assertExportAccess(persistenceAdapter.getExport(exportId), principal);
  const recordRefs = reviewRecordRefs(projectId);
  const result = approveRegenerationDraft({
    request: {
      projectId,
      sourceJobId,
      exportId,
      regenerationPlanId,
      ownerId: principal.id,
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
    projectRecord: recordRefs.projectRecord,
    renderRecord: recordRefs.renderRecord,
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
    principal: publicPrincipal(principal),
  })));
  sendOk(res, publicApprovalResult(result), 202);
}

async function handleSignedArtifactDownload(req, res, url, principal) {
  const artifact = artifactAdapter.validateSignedDownloadToken(url.searchParams.get("token"));
  if (!artifact || !artifact.id || !String(artifact.id).startsWith("exp_")) {
    throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
  }
  const descriptor = completedExportDescriptor(artifact.id, principal);
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

async function loadOcrQaReviewModule() {
  return import("../demo/ocr-qa-review.mjs");
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

function safeOcrQaManifestRef(value) {
  const text = sanitizeText(value || "", 260).replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    /^file:/i.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !OCR_QA_MANIFEST_REF_RE.test(text)
  ) {
    throw new AppError("OCR_QA_REVIEW_MANIFEST_REF_INVALID", "OCR QA manifest ref is invalid.", 400, {
      nextAction: "run-ocr-smoke-with-qa-artifacts",
    });
  }
  return text;
}

function safeOcrQaCropId(value) {
  const text = sanitizeText(value || "", 96);
  if (!OCR_QA_CROP_ID_RE.test(text)) {
    throw new AppError("OCR_QA_REVIEW_CROP_INVALID", "OCR QA crop id is invalid.", 400, {
      nextAction: "refresh-ocr-qa-manifest",
    });
  }
  return text;
}

function publicRelativeMp4Ref(value) {
  const text = sanitizeText(value || "", 260).replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    extname(text).toLowerCase() !== ".mp4"
  ) {
    return null;
  }
  return text;
}

function safeInlinePngFileName(value, fallback = "ocr-crop.png") {
  const fallbackName = String(fallback || "ocr-crop.png").replace(/[^A-Za-z0-9._-]/g, "_");
  const normalized = sanitizeText(value || fallbackName, 120)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 120);
  const withExtension = normalized.toLowerCase().endsWith(".png") ? normalized : `${normalized || fallbackName}.png`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.png$/i.test(withExtension)) {
    return fallbackName.toLowerCase().endsWith(".png") ? fallbackName : `${fallbackName}.png`;
  }
  return withExtension;
}

function publicFiniteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function publicOcrQaScores(scores = {}) {
  if (!scores || typeof scores !== "object") return null;
  return {
    visibilityScore: publicFiniteNumber(scores.visibilityScore),
    readabilityScore: publicFiniteNumber(scores.readabilityScore),
    usefulnessScore: publicFiniteNumber(scores.usefulnessScore),
    decisionSupportScore: publicFiniteNumber(scores.decisionSupportScore),
    counts: scores.counts && typeof scores.counts === "object"
      ? {
          reviewed: publicFiniteNumber(scores.counts.reviewed),
          scoreboardVisible: publicFiniteNumber(scores.counts.scoreboardVisible),
          clockVisible: publicFiniteNumber(scores.counts.clockVisible),
          scoreVisible: publicFiniteNumber(scores.counts.scoreVisible),
          readable: publicFiniteNumber(scores.counts.readable),
          useful: publicFiniteNumber(scores.counts.useful),
        }
      : null,
  };
}

function publicOcrQaCalibration(calibration = {}) {
  return {
    goalEvidencePolicy: sanitizeText(calibration.goalEvidencePolicy || OCR_QA_SUPPORT_POLICY.goalEvidencePolicy, 80),
    ocrEvidenceUsable: calibration.ocrEvidenceUsable === true,
    decisionSupportLevel: sanitizeText(calibration.decisionSupportLevel || "ignore", 40),
    scoreboardCropQuality: sanitizeText(calibration.scoreboardCropQuality || "unknown", 40),
    operatorDecision: sanitizeText(calibration.operatorDecision || "not_useful", 40),
    goalDecisionAllowed: calibration.goalDecisionAllowed === true,
    noFalseGoalFromOcrOnly: calibration.noFalseGoalFromOcrOnly !== false,
    calibrationNotes: Array.isArray(calibration.calibrationNotes)
      ? calibration.calibrationNotes.slice(0, 4).map((note) => sanitizeText(note, 180))
      : [],
  };
}

function publicOcrQaManifest(manifest = {}) {
  if (!manifest || typeof manifest !== "object") return null;
  const relativePath = safeOcrQaManifestRef(manifest.relativePath);
  return {
    relativePath,
    runId: sanitizeText(manifest.runId || "", 96),
    directory: sanitizeText(manifest.directory || "", 180),
    cropCount: publicFiniteNumber(manifest.cropCount),
    maxCropCount: publicFiniteNumber(manifest.maxCropCount),
    maxArtifactBytes: publicFiniteNumber(manifest.maxArtifactBytes),
    files: Array.isArray(manifest.files)
      ? manifest.files.slice(0, 12).map((file) => ({
          id: sanitizeText(file.id || "", 96),
          kind: sanitizeText(file.kind || "scoreboard_crop", 48),
          sizeBytes: publicFiniteNumber(file.sizeBytes),
          cropUrl: `/api/ocr-qa/crop?manifest=${encodeURIComponent(relativePath)}&id=${encodeURIComponent(file.id || "")}`,
        }))
      : [],
    relativeRefsOnly: true,
    fullFramesStored: false,
    ocrTextStored: false,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function publicOcrQaReportManifest(manifest = {}) {
  if (!manifest || typeof manifest !== "object") return null;
  return {
    relativePath: manifest.relativePath ? safeOcrQaManifestRef(manifest.relativePath) : null,
    runId: sanitizeText(manifest.runId || "", 96),
    directory: sanitizeText(manifest.directory || "", 180),
    cropCount: publicFiniteNumber(manifest.cropCount),
    maxCropCount: publicFiniteNumber(manifest.maxCropCount),
    maxArtifactBytes: publicFiniteNumber(manifest.maxArtifactBytes),
  };
}

function publicOcrQaReviewReport(report = {}) {
  if (!report || typeof report !== "object") return null;
  return {
    schemaVersion: Number.isFinite(Number(report.schemaVersion)) ? Number(report.schemaVersion) : 1,
    generatedAt: sanitizeText(report.generatedAt || "", 80),
    status: sanitizeText(report.status || "missing", 60),
    passed: report.passed === true,
    skipped: report.skipped === true,
    degraded: report.degraded === true,
    nextAction: sanitizeText(report.nextAction || "Run OCR QA review when crop artifacts are available.", 180),
    manifest: publicOcrQaReportManifest(report.manifest),
    cropCount: publicFiniteNumber(report.cropCount),
    reviewedCropCount: publicFiniteNumber(report.reviewedCropCount),
    scores: publicOcrQaScores(report.scores),
    calibration: publicOcrQaCalibration(report.calibration),
    reviewedCrops: Array.isArray(report.reviewedCrops)
      ? report.reviewedCrops.slice(0, 12).map((crop) => ({
          id: sanitizeText(crop.id || "", 96),
          scoreboardVisible: crop.scoreboardVisible === true,
          clockVisible: crop.clockVisible === true,
          scoreVisible: crop.scoreVisible === true,
          readable: crop.readable === true,
          cropUsefulForDecision: crop.cropUsefulForDecision === true,
          notes: crop.notes ? sanitizeText(crop.notes, 160) : null,
        }))
      : [],
    failedCases: Array.isArray(report.failedCases)
      ? report.failedCases.slice(0, 8).map((item) => ({
          code: sanitizeText(item.code || "", 100),
          message: sanitizeText(item.message || "", 180),
          field: item.field ? sanitizeText(item.field, 100) : undefined,
        }))
      : [],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
  };
}

function publicHumanReviewFlags(flags = {}) {
  const output = {};
  for (const flag of HUMAN_REVIEW_PUBLIC_FLAGS) output[flag] = Boolean(flags[flag]);
  return output;
}

function publicHumanReviewCriterion(item = {}) {
  return {
    id: sanitizeText(item.id || "", 100),
    score: publicFiniteNumber(item.score),
    status: sanitizeText(item.status || "unknown", 40),
  };
}

function publicImprovementHint(item = {}) {
  return {
    id: sanitizeText(item.id || "", 100),
    target: sanitizeText(item.target || "", 120),
    note: sanitizeText(item.note || "", 240),
  };
}

function publicHumanReviewMetrics(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  return {
    structuralScore: publicFiniteNumber(metrics.structuralScore),
    aspectRatioFit: metrics.aspectRatioFit === null || metrics.aspectRatioFit === undefined ? null : Boolean(metrics.aspectRatioFit),
    durationFit: metrics.durationFit === null || metrics.durationFit === undefined ? null : Boolean(metrics.durationFit),
    resolutionFit: metrics.resolutionFit === null || metrics.resolutionFit === undefined ? null : Boolean(metrics.resolutionFit),
    fileReadable: metrics.fileReadable === null || metrics.fileReadable === undefined ? null : Boolean(metrics.fileReadable),
    contactSheetAvailable: metrics.contactSheetAvailable === null || metrics.contactSheetAvailable === undefined ? null : Boolean(metrics.contactSheetAvailable),
  };
}

function reviewMediaExists(relativePath) {
  try {
    const media = safeReviewMediaRef(relativePath);
    return existsSync(media.resolvedPath) && !statSync(media.resolvedPath).isDirectory();
  } catch {
    return false;
  }
}

function publicHumanReviewVideoMetadata(video = {}, options = {}) {
  const relativePath = publicRelativeMp4Ref(video.relativePath);
  if (!relativePath) return null;
  if (options.verifyMediaExists && !reviewMediaExists(relativePath)) return null;
  return {
    relativePath,
    readable: video.readable === true,
    durationSeconds: publicFiniteNumber(video.durationSeconds),
    width: publicFiniteNumber(video.width),
    height: publicFiniteNumber(video.height),
    orientation: sanitizeText(video.orientation || "unknown", 40),
  };
}

function publicHumanReviewSourceArtifact(artifact = {}, options = {}) {
  const relativePath = publicRelativeMp4Ref(artifact.relativePath);
  if (!relativePath) return null;
  if (options.verifyMediaExists && !reviewMediaExists(relativePath)) return null;
  return {
    relativePath,
    sourceType: sanitizeText(artifact.sourceType || "direct", 40),
    videoId: artifact.videoId ? sanitizeText(artifact.videoId, 80) : null,
    durationSeconds: publicFiniteNumber(artifact.durationSeconds),
    width: publicFiniteNumber(artifact.width),
    height: publicFiniteNumber(artifact.height),
    downloadVerified: artifact.downloadVerified === true,
  };
}

function publicHumanVisualReviewReport(report = {}, options = {}) {
  const humanReview = report.humanReview || {};
  const sourceArtifact = report.source && report.source.generatedArtifact;
  const generated = report.comparison && report.comparison.generated;
  const reference = report.comparison && report.comparison.reference;
  const publicSourceArtifact = sourceArtifact ? publicHumanReviewSourceArtifact(sourceArtifact, options) : null;
  const publicGenerated = generated ? publicHumanReviewVideoMetadata(generated, options) : null;
  const publicReference = reference ? publicHumanReviewVideoMetadata(reference, options) : null;
  const comparisonSafe = !report.comparison || Boolean(publicGenerated && publicReference);
  return {
    schemaVersion: Number.isFinite(Number(report.schemaVersion)) ? Number(report.schemaVersion) : 1,
    generatedAt: sanitizeText(report.generatedAt || "", 80),
    status: sanitizeText(report.status || "pending_human_review", 60),
    passed: report.passed === true,
    productReady: report.productReady === true && humanReview.present === true && comparisonSafe,
    source: {
      mode: sanitizeText(report.source && report.source.mode || "direct_refs", 40),
      generatedArtifact: publicSourceArtifact,
    },
    comparison: report.comparison
      ? {
          generated: publicGenerated,
          reference: publicReference,
        }
      : null,
    machineStructuralMetrics: publicHumanReviewMetrics(report.machineStructuralMetrics),
    humanReview: {
      status: sanitizeText(humanReview.status || "pending_human_review", 80),
      present: humanReview.present === true,
      humanScore: Number.isFinite(Number(humanReview.humanScore)) ? Number(humanReview.humanScore) : null,
      combinedScore: Number.isFinite(Number(humanReview.combinedScore)) ? Number(humanReview.combinedScore) : null,
      productReady: humanReview.productReady === true && comparisonSafe,
      failedCriteria: Array.isArray(humanReview.failedCriteria)
        ? humanReview.failedCriteria.slice(0, 12).map(publicHumanReviewCriterion)
        : [],
      borderlineCriteria: Array.isArray(humanReview.borderlineCriteria)
        ? humanReview.borderlineCriteria.slice(0, 12).map(publicHumanReviewCriterion)
        : [],
      improvementHints: Array.isArray(humanReview.improvementHints)
        ? humanReview.improvementHints.slice(0, 12).map(publicImprovementHint)
        : [],
      operatorReview: humanReview.operatorReview && humanReview.operatorReview.present === true
        ? {
            present: true,
            reviewer: sanitizeText(humanReview.operatorReview.reviewer || "operator", 80),
            reviewedAt: sanitizeText(humanReview.operatorReview.reviewedAt || "", 80),
            flags: publicHumanReviewFlags(humanReview.operatorReview.flags),
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

function readSafeJsonRef(relativeRef, maxBytes = OCR_QA_MAX_REPORT_BYTES) {
  const target = safeResolve(CONFIG.rootDir, relativeRef);
  if (!existsSync(target)) return null;
  const stat = statSync(target);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function findLatestOcrQaManifestRef() {
  const latest = readSafeJsonRef(OCR_QA_LATEST_REPORT_REF);
  if (!latest || typeof latest !== "object") return null;
  const candidates = [
    latest.qaArtifactManifest,
    latest.qa && latest.qa.cropArtifacts && latest.qa.cropArtifacts.manifest,
  ];
  for (const candidate of candidates) {
    const ref = typeof candidate === "string" ? candidate : candidate && candidate.relativePath;
    if (!ref) continue;
    return safeOcrQaManifestRef(ref);
  }
  return null;
}

function loadLatestOcrQaReviewReport() {
  return publicOcrQaReviewReport(readSafeJsonRef(OCR_QA_REVIEW_LATEST_REPORT_REF));
}

function ocrQaReviewAppError(error) {
  const code = sanitizeText(error && error.code ? error.code : "OCR_QA_REVIEW_INVALID", 100);
  return new AppError(code, "OCR QA review failed validation.", 400, {
    nextAction: "refresh-ocr-qa-manifest-and-review-input",
  });
}

async function handleOcrQaLatest(req, res) {
  const review = await loadOcrQaReviewModule();
  const latestReview = loadLatestOcrQaReviewReport();
  const manifestRef = findLatestOcrQaManifestRef();
  if (!manifestRef) {
    return sendOk(res, {
      status: "missing",
      manifest: null,
      latestReview,
      policy: OCR_QA_SUPPORT_POLICY,
      nextAction: "Run SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke.",
    });
  }
  try {
    const manifest = review.readOcrQaManifest(manifestRef);
    return sendOk(res, {
      status: "available",
      manifest: publicOcrQaManifest(manifest),
      latestReview,
      policy: OCR_QA_SUPPORT_POLICY,
      nextAction: "Review OCR crop thumbnails, then submit support-only calibration.",
    });
  } catch {
    return sendOk(res, {
      status: "missing",
      manifest: null,
      latestReview,
      policy: OCR_QA_SUPPORT_POLICY,
      nextAction: "Regenerate OCR QA artifacts before submitting review.",
    });
  }
}

async function handleOcrQaReviewSubmit(req, res, rid) {
  if (!reviewLimiter.check(clientKey(req))) {
    throw new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED, 429);
  }
  validateJsonContentType(req);
  enforceContentLength(req, MAX_JSON_BODY_BYTES);
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const review = await loadOcrQaReviewModule();
  let result;
  try {
    result = review.runOcrQaReview(payload);
  } catch (error) {
    throw ocrQaReviewAppError(error);
  }
  console.info(JSON.stringify(redactForLogs({
    level: "info",
    event: "ocr_qa_review_submitted",
    requestId: rid,
    status: result.status,
    passed: result.passed === true,
    reviewedCropCount: Number(result.reviewedCropCount || 0),
    decisionSupportLevel: result.calibration && result.calibration.decisionSupportLevel,
  })));
  return sendOk(res, {
    latestPath: sanitizeText(result.latestPath || OCR_QA_REVIEW_LATEST_REPORT_REF, 180),
    reportPath: sanitizeText(result.reportPath || "", 180),
    review: publicOcrQaReviewReport(result),
  }, 201);
}

async function handleOcrQaCrop(req, res, url) {
  const manifestRef = safeOcrQaManifestRef(url.searchParams.get("manifest"));
  const cropId = safeOcrQaCropId(url.searchParams.get("id"));
  const review = await loadOcrQaReviewModule();
  let manifest;
  try {
    manifest = review.readOcrQaManifest(manifestRef);
  } catch (error) {
    throw ocrQaReviewAppError(error);
  }
  const file = Array.isArray(manifest.files) ? manifest.files.find((item) => item.id === cropId) : null;
  if (!file || !file.relativePath || !file.relativePath.startsWith(`${manifest.directory}/`) || extname(file.relativePath).toLowerCase() !== ".png") {
    throw new AppError("OCR_QA_REVIEW_CROP_NOT_FOUND", "OCR QA crop is unavailable.", 404, {
      nextAction: "refresh-ocr-qa-manifest",
    });
  }
  const target = safeResolve(CONFIG.rootDir, file.relativePath);
  if (!existsSync(target) || statSync(target).isDirectory()) {
    throw new AppError("OCR_QA_REVIEW_CROP_NOT_FOUND", "OCR QA crop is unavailable.", 404, {
      nextAction: "refresh-ocr-qa-manifest",
    });
  }
  const size = statSync(target).size;
  const maxBytes = Math.min(
    OCR_QA_MAX_PUBLIC_CROP_BYTES,
    Math.max(1, Number(manifest.maxArtifactBytes || OCR_QA_MAX_PUBLIC_CROP_BYTES)),
  );
  if (size <= 0 || size > maxBytes) {
    throw new AppError("OCR_QA_REVIEW_CROP_INVALID", "OCR QA crop is invalid.", 400, {
      nextAction: "regenerate-ocr-qa-artifacts",
    });
  }
  res.writeHead(200, {
    ...SAFE_RESPONSE_HEADERS,
    "content-type": "image/png",
    "content-disposition": `inline; filename="${safeInlinePngFileName(`${cropId}.png`)}"`,
  });
  const stream = createReadStream(target);
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
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
    review: publicHumanVisualReviewReport(result.report, { verifyMediaExists: true }),
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
  const principal = () => requirePrincipal(req);
  try {
    if (req.method === "GET" && pathname === "/health") return await handleHealth(req, res, rid);
    if (req.method === "POST" && pathname === "/api/youtube/validate") return await handleYouTubeValidate(req, res, rid, principal());
    if (req.method === "POST" && pathname === "/api/youtube/ingest") return await handleYouTubeIngest(req, res, rid, principal());
    if (req.method === "POST" && pathname === "/api/uploads") return await handleUpload(req, res, rid, principal());
    if (req.method === "POST" && pathname === "/api/narrated-projects") return await handleCreateNarratedProject(req, res, rid, principal());
    if (req.method === "POST" && pathname === "/api/review/register") return await handleReviewRegister(req, res, rid, principal());
    if (req.method === "GET" && pathname === "/api/review/latest") return await handleHumanReviewLatest(req, res, principal());
    if (req.method === "POST" && pathname === "/api/review/human") return await handleHumanReviewSubmit(req, res, rid, principal());
    if (req.method === "GET" && pathname === "/api/review/media") return await handleHumanReviewMedia(req, res, url, principal());
    if (req.method === "GET" && pathname === "/api/ocr-qa/latest") return await handleOcrQaLatest(req, res, principal());
    if (req.method === "POST" && pathname === "/api/ocr-qa/review") return await handleOcrQaReviewSubmit(req, res, rid, principal());
    if (req.method === "GET" && pathname === "/api/ocr-qa/crop") return await handleOcrQaCrop(req, res, url, principal());
    if (req.method === "POST" && pathname === "/api/review/regeneration-plan") return await handleReviewRegenerationPlan(req, res, rid, principal());
    if (req.method === "POST" && pathname === "/api/review/regeneration-approval") return await handleReviewRegenerationApproval(req, res, rid, principal());

    const narratedDraftMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/draft$/);
    if (req.method === "POST" && narratedDraftMatch) return await handleDraftNarratedProject(req, res, rid, narratedDraftMatch[1], principal());

    const narratedReviseMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/revise$/);
    if (req.method === "POST" && narratedReviseMatch) return await handleReviseNarratedProject(req, res, rid, narratedReviseMatch[1], principal());

    const narratedApprovalMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/approve$/);
    if (req.method === "POST" && narratedApprovalMatch) return await handleApproveNarratedProject(req, res, rid, narratedApprovalMatch[1], principal());

    const narratedNarrationMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/narration$/);
    if (req.method === "POST" && narratedNarrationMatch) return await handleUploadNarration(req, res, rid, narratedNarrationMatch[1], principal());

    const narratedAlignmentMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/narration\/align$/);
    if (req.method === "POST" && narratedAlignmentMatch) return await handleAlignNarration(req, res, rid, narratedAlignmentMatch[1], principal());

    const narratedAnimationPlanMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/animation-plan$/);
    if (req.method === "POST" && narratedAnimationPlanMatch) return await handlePlanNarratedAnimation(req, res, rid, narratedAnimationPlanMatch[1], principal());
    const narratedRenderMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/render$/);
    if (req.method === "POST" && narratedRenderMatch) return await handleRenderNarratedProject(req, res, rid, narratedRenderMatch[1], principal());
    const narratedQaMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/qa$/);
    if (req.method === "GET" && narratedQaMatch) return await handleNarratedProjectQa(req, res, narratedQaMatch[1], principal());

    const narratedPublishApproveMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/publish-approve$/);
    if (req.method === "POST" && narratedPublishApproveMatch) return await handlePublishApprove(req, res, rid, narratedPublishApproveMatch[1], principal());
    const narratedReleaseVerifyMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/release-verify$/);
    if (req.method === "POST" && narratedReleaseVerifyMatch) return await handleReleaseVerify(req, res, narratedReleaseVerifyMatch[1], principal());
    const narratedFinalDownloadMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)\/final-download-url$/);
    if (req.method === "POST" && narratedFinalDownloadMatch) return await handleFinalDownloadUrl(req, res, narratedFinalDownloadMatch[1], principal());

    const narratedProjectMatch = pathname.match(/^\/api\/narrated-projects\/([^/]+)$/);
    if (req.method === "GET" && narratedProjectMatch) return await handleGetNarratedProject(req, res, narratedProjectMatch[1], principal());

    const generateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/generate$/);
    if (req.method === "POST" && generateMatch) return await handleGenerate(req, res, rid, generateMatch[1], principal());

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) return await handleGetJob(req, res, jobMatch[1], principal());

    const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) return await handleCancelJob(req, res, cancelMatch[1], principal());

    const downloadMatch = pathname.match(/^\/api\/exports\/([^/]+)\/download$/);
    if (req.method === "GET" && downloadMatch) return await handleDownload(req, res, downloadMatch[1], principal());

    const downloadUrlMatch = pathname.match(/^\/api\/exports\/([^/]+)\/download-url$/);
    if (req.method === "GET" && downloadUrlMatch) return await handleDownloadUrl(req, res, downloadUrlMatch[1], principal());

    if (req.method === "GET" && pathname === "/api/artifacts/download") {
      return await handleSignedArtifactDownload(req, res, url, principal());
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
  publicHumanVisualReviewReport,
  publicOcrQaReviewReport,
  publicOcrQaManifest,
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
  contentArtifactRepository,
  contentApprovalRepository,
  artifactCleanupWorker,
  outboxWorker,
  workerSupervisor,
  stopWorkers,
};
