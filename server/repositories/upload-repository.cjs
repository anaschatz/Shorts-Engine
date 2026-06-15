const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { LocalArtifactStore } = require("../storage/artifact-store.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return jsonClone(metadata);
}

function normalizeByteSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.round(size);
}

function assertArtifactPathMatch(artifactStore, artifact, candidatePath) {
  let expectedPath = null;
  try {
    expectedPath = artifactStore.resolveLocalPath
      ? artifactStore.resolveLocalPath(artifact)
      : artifactStore.resolve(artifact);
  } catch {
    expectedPath = null;
  }
  if (!expectedPath && !candidatePath) return null;
  if (!expectedPath && candidatePath) {
    throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
  }
  const safePath = candidatePath ? artifactStore.assertPathForType("upload", candidatePath) : expectedPath;
  if (safePath !== expectedPath) {
    throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
  }
  return safePath;
}

function normalizeUpload(record = {}, options = {}) {
  const artifactStore = options.artifactStore || new LocalArtifactStore();
  const id = validateResourceId(record.id, "upl");
  const projectId = validateResourceId(record.projectId, "prj");
  const artifact = record.artifact
    ? artifactStore.createRecord(record.artifact)
    : artifactStore.createRecord({
        id,
        type: "upload",
        ownerProjectId: projectId,
        storageKey: record.storageKey || `${id}.${sanitizeText(record.extension || "mp4", 12)}`,
        size: record.byteSize,
        status: "available",
        createdAt: record.createdAt,
      });
  const path = assertArtifactPathMatch(artifactStore, artifact, record.path);
  const byteSize = normalizeByteSize(record.byteSize ?? artifact.size ?? 0);
  const createdAt = record.createdAt || artifact.createdAt || nowIso();
  return {
    id,
    projectId,
    artifact,
    storageKey: artifact.storageKey,
    path,
    originalFilename: sanitizeText(record.originalFilename || record.fileName || "upload.mp4", 180),
    mimeType: sanitizeText(record.mimeType || "video/mp4", 80).toLowerCase(),
    extension: sanitizeText(record.extension || "mp4", 12).toLowerCase(),
    container: sanitizeText(record.container || record.extension || "mp4", 24).toLowerCase(),
    byteSize,
    checksumSha256: sanitizeText(record.checksumSha256 || "", 128),
    metadata: normalizeMetadata(record.metadata),
    createdAt,
  };
}

class InMemoryUploadRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.artifactStore = options.artifactStore || new LocalArtifactStore();
  }

  create(record) {
    const upload = normalizeUpload(record, { artifactStore: this.artifactStore });
    this.records.set(upload.id, upload);
    return upload;
  }

  save(record) {
    return this.create(record);
  }

  get(uploadId) {
    return this.records.get(validateResourceId(uploadId, "upl")) || null;
  }

  getForProject(projectId) {
    const safeProjectId = validateResourceId(projectId, "prj");
    return this.all().find((upload) => upload.projectId === safeProjectId) || null;
  }

  delete(uploadId) {
    return this.records.delete(validateResourceId(uploadId, "upl"));
  }

  all() {
    return [...this.records.values()];
  }

  publicUpload(upload) {
    if (!upload) return null;
    return {
      id: upload.id,
      projectId: upload.projectId,
      originalFilename: upload.originalFilename,
      byteSize: upload.byteSize,
      mimeType: upload.mimeType,
      metadata: jsonClone(upload.metadata),
      artifact: {
        id: upload.artifact.id,
        type: upload.artifact.type,
        status: upload.artifact.status,
        size: upload.artifact.size,
        createdAt: upload.artifact.createdAt,
      },
    };
  }

  health() {
    return {
      ready: true,
      total: this.records.size,
    };
  }
}

module.exports = {
  InMemoryUploadRepository,
  normalizeUpload,
};
