const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { normalizeOwnerId } = require("../auth.cjs");
const { normalizeSmokeSource } = require("../staging-smoke-metadata.cjs");
const { DOWNLOAD_ARTIFACT_TYPES, LocalArtifactStore } = require("../storage/artifact-store.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const EXPORT_STATUSES = Object.freeze(["completed"]);
const DEFAULT_SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;

function createArtifactRecord(artifactStore, input) {
  if (artifactStore && typeof artifactStore.createArtifactRecord === "function") {
    return artifactStore.createArtifactRecord(input);
  }
  return artifactStore.createRecord(input);
}

function resolveLocalArtifactPath(artifactStore, artifact) {
  try {
    if (artifactStore && typeof artifactStore.resolveLocalPath === "function") {
      return artifactStore.resolveLocalPath(artifact);
    }
    if (artifactStore && typeof artifactStore.resolveArtifact === "function") {
      return artifactStore.resolveArtifact(artifact);
    }
    return artifactStore.resolve(artifact);
  } catch {
    return null;
  }
}

function artifactIsFile(artifactStore, artifact) {
  if (artifactStore && typeof artifactStore.isFile === "function") {
    return artifactStore.isFile(artifact);
  }
  return false;
}

function artifactMetadata(artifactStore, artifact) {
  if (artifactStore && typeof artifactStore.getArtifactMetadata === "function") {
    return artifactStore.getArtifactMetadata(artifact);
  }
  const stat = artifactStore.stat(artifact);
  return createArtifactRecord(artifactStore, { ...artifact, size: stat.size, status: "available" });
}

function assertArtifactPathMatch(artifactStore, artifact, candidatePath) {
  const expectedPath = resolveLocalArtifactPath(artifactStore, artifact);
  if (!expectedPath && !candidatePath) return null;
  if (!expectedPath && candidatePath) {
    throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
  }
  const safePath = candidatePath ? artifactStore.assertPathForType("export", candidatePath) : expectedPath;
  if (safePath !== expectedPath) {
    throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
  }
  return safePath;
}

function normalizeExport(record = {}, options = {}) {
  const artifactStore = options.artifactStore || new LocalArtifactStore();
  const id = validateResourceId(record.id, "exp");
  const projectId = validateResourceId(record.projectId, "prj");
  const jobId = validateResourceId(record.jobId, "job");
  const status = sanitizeText(record.status || "completed", 40);
  if (!EXPORT_STATUSES.includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const artifact = record.artifact
    ? createArtifactRecord(artifactStore, record.artifact)
    : createArtifactRecord(artifactStore, {
        id,
        type: "export",
        ownerProjectId: projectId,
        ownerJobId: jobId,
        storageKey: record.storageKey || `${jobId}.mp4`,
        size: record.size,
        status: "available",
        createdAt: record.createdAt,
      });
  const outputPath = assertArtifactPathMatch(artifactStore, artifact, record.outputPath);
  const createdAt = record.createdAt || artifact.createdAt || nowIso();
  return {
    id,
    projectId,
    jobId,
    ownerId: record.ownerId ? normalizeOwnerId(record.ownerId) : null,
    artifact,
    storageKey: artifact.storageKey,
    outputPath,
    fileName: sanitizeText(record.fileName || `${projectId}-short.mp4`, 180),
    status,
    source: normalizeSmokeSource(record.source || artifact.source),
    createdAt,
  };
}

function assertCompletedJobForExport(exportRecord, job) {
  if (!job || job.status !== "completed" || job.id !== exportRecord.jobId || job.projectId !== exportRecord.projectId) {
    throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  }
  if (job.exportId && job.exportId !== exportRecord.id) {
    throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  }
}

function assertDownloadableArtifact(exportRecord) {
  const artifact = exportRecord.artifact;
  if (!artifact || !DOWNLOAD_ARTIFACT_TYPES.includes(artifact.type)) {
    throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  }
  if (
    artifact.ownerProjectId !== exportRecord.projectId ||
    (artifact.ownerJobId && artifact.ownerJobId !== exportRecord.jobId) ||
    artifact.status !== "available"
  ) {
    throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
  }
}

class InMemoryExportRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.artifactStore = options.artifactStore || new LocalArtifactStore();
  }

  create(record) {
    const exportRecord = normalizeExport(record, { artifactStore: this.artifactStore });
    if (!artifactIsFile(this.artifactStore, exportRecord.artifact)) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    this.records.set(exportRecord.id, exportRecord);
    return exportRecord;
  }

  restore(record) {
    const exportRecord = normalizeExport(record, { artifactStore: this.artifactStore });
    if (!artifactIsFile(this.artifactStore, exportRecord.artifact)) {
      return null;
    }
    this.records.set(exportRecord.id, exportRecord);
    return exportRecord;
  }

  get(exportId) {
    return this.records.get(validateResourceId(exportId, "exp")) || null;
  }

  delete(exportId) {
    return this.records.delete(validateResourceId(exportId, "exp"));
  }

  all() {
    return [...this.records.values()];
  }

  health() {
    return {
      ready: true,
      total: this.records.size,
      completed: this.records.size,
    };
  }

  resolveOutputPath(exportRecord) {
    if (!exportRecord) {
      throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
    }
    const normalized = normalizeExport(exportRecord, { artifactStore: this.artifactStore });
    if (!artifactIsFile(this.artifactStore, normalized.artifact)) {
      throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
    }
    const localPath = resolveLocalArtifactPath(this.artifactStore, normalized.artifact);
    if (!localPath) {
      throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
    }
    return localPath;
  }

  getDownloadDescriptor(exportRecord, options = {}) {
    if (!exportRecord) {
      throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
    }
    const normalized = normalizeExport(exportRecord, { artifactStore: this.artifactStore });
    assertCompletedJobForExport(normalized, options.job);
    assertDownloadableArtifact(normalized);
    if (!artifactIsFile(this.artifactStore, normalized.artifact)) {
      throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 404);
    }
    const metadata = artifactMetadata(this.artifactStore, normalized.artifact);
    return {
      id: normalized.id,
      projectId: normalized.projectId,
      jobId: normalized.jobId,
      artifact: normalized.artifact,
      fileName: normalized.fileName,
      contentType: metadata.contentType || "video/mp4",
      size: metadata.size,
      status: normalized.status,
    };
  }

  createSignedDownload(exportRecord, options = {}) {
    if (!this.artifactStore || typeof this.artifactStore.createSignedDownloadUrl !== "function") {
      throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
    }
    const descriptor = this.getDownloadDescriptor(exportRecord, options);
    const signed = this.artifactStore.createSignedDownloadUrl(descriptor.artifact, {
      basePath: options.basePath || "/api/artifacts/download",
      ttlSeconds: options.ttlSeconds || DEFAULT_SIGNED_DOWNLOAD_TTL_SECONDS,
    });
    return {
      exportId: descriptor.id,
      projectId: descriptor.projectId,
      jobId: descriptor.jobId,
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt,
      ttlSeconds: signed.ttlSeconds,
    };
  }

  publicExport(exportRecord) {
    if (!exportRecord) return null;
    const safe = jsonClone(normalizeExport(exportRecord, { artifactStore: this.artifactStore }));
    delete safe.outputPath;
    delete safe.path;
    delete safe.storageKey;
    safe.artifact = {
      id: safe.artifact.id,
      type: safe.artifact.type,
      status: safe.artifact.status,
      size: safe.artifact.size,
      contentType: safe.artifact.contentType,
      source: safe.artifact.source,
      createdAt: safe.artifact.createdAt,
    };
    return safe;
  }
}

module.exports = {
  EXPORT_STATUSES,
  InMemoryExportRepository,
  normalizeExport,
};
