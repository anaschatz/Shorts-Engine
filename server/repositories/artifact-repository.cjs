const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { basename } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath, storagePath, writeJsonAtomic } = require("../storage.cjs");
const {
  AREA_BY_TYPE,
  TEMP_ARTIFACT_TYPES,
  validateArtifactKey,
  validateArtifactType,
} = require("../storage/artifact-store.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const ARTIFACT_INDEX_FILE_RE = /^art_[A-Za-z0-9_-]{16,96}\.json$/;
const MAX_ARTIFACT_RECORD_BYTES = 128 * 1024;
const ARTIFACT_INDEX_STATUSES = Object.freeze(["staging", "available", "missing", "deleted"]);

function artifactFileName(artifactId) {
  const hash = createHash("sha256").update(String(artifactId)).digest("base64url").slice(0, 48);
  return `art_${hash}.json`;
}

function artifactRecordPath(artifactId) {
  return storagePath("artifacts", artifactFileName(artifactId));
}

function normalizeStorageMode(value) {
  const mode = sanitizeText(value || "local", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(mode)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return mode;
}

function normalizeArtifactId(value) {
  const safe = sanitizeText(value, 160);
  if (!safe || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function normalizeOptionalOwnerId(value, prefix) {
  if (!value) return null;
  return validateResourceId(value, prefix);
}

function normalizeOptionalSize(value) {
  if (value === null || value === undefined) return null;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.round(size);
}

function normalizeChecksum(value) {
  if (!value) return "";
  const checksum = sanitizeText(value, 128);
  if (!/^[a-f0-9]{32,128}$/i.test(checksum)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return checksum.toLowerCase();
}

function normalizeContentType(value) {
  if (!value) return "application/octet-stream";
  const contentType = sanitizeText(value, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,80}\/[a-z0-9][a-z0-9.+-]{0,80}$/.test(contentType)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return contentType;
}

function normalizeArtifactStatus(value) {
  const status = sanitizeText(value || "available", 40);
  if (!ARTIFACT_INDEX_STATUSES.includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return status;
}

function normalizeArtifactPath(value, type) {
  if (value === null || value === undefined || value === "") return null;
  const rawPath = String(value);
  if (rawPath.includes("\u0000")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const area = AREA_BY_TYPE[type];
  if (!area) {
    throw new AppError("ARTIFACT_TYPE_INVALID", SAFE_MESSAGES.ARTIFACT_TYPE_INVALID, 400);
  }
  return assertStoragePath(rawPath, area);
}

function normalizeArtifactRecord(record = {}, options = {}) {
  if (!record || typeof record !== "object") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const id = normalizeArtifactId(record.id);
  const type = validateArtifactType(record.type);
  const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
  return {
    id,
    type,
    status: normalizeArtifactStatus(record.status),
    ownerProjectId: normalizeOptionalOwnerId(record.ownerProjectId, "prj"),
    ownerJobId: normalizeOptionalOwnerId(record.ownerJobId, "job"),
    size: normalizeOptionalSize(record.size),
    contentType: normalizeContentType(record.contentType),
    checksumSha256: normalizeChecksum(record.checksumSha256),
    storageAdapterMode: normalizeStorageMode(record.storageAdapterMode || options.storageAdapterMode || "local"),
    storageKey: record.storageKey ? validateArtifactKey(record.storageKey) : "",
    path: normalizeArtifactPath(record.path, type),
    createdAt,
    updatedAt: sanitizeText(record.updatedAt || createdAt, 40),
  };
}

function publicArtifactRecord(record) {
  if (!record) return null;
  const safe = jsonClone(record);
  delete safe.storageKey;
  delete safe.path;
  return safe;
}

function artifactAgeMs(record, nowMs) {
  const timestamp = Date.parse(record.updatedAt || record.createdAt || "");
  if (!Number.isFinite(timestamp)) return null;
  return nowMs - timestamp;
}

function normalizeCleanupQuery(options = {}) {
  const allowedTypes = Array.isArray(options.allowedTypes) && options.allowedTypes.length
    ? options.allowedTypes.map(validateArtifactType).filter((type) => TEMP_ARTIFACT_TYPES.includes(type))
    : TEMP_ARTIFACT_TYPES;
  return {
    allowedTypes,
    maxAgeSeconds: Math.max(60, Math.min(Number(options.maxAgeSeconds || CONFIG.storage.lifecycleCleanupMaxAgeSeconds), 365 * 24 * 60 * 60)),
    limit: Math.max(1, Math.min(Math.floor(Number(options.limit || options.maxArtifacts || CONFIG.storage.lifecycleCleanupMaxPerRun)), 1000)),
    nowMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
    activeJobIds: new Set(Array.isArray(options.activeJobIds) ? options.activeJobIds : []),
  };
}

class InMemoryArtifactRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.persist = Boolean(options.persist);
    this.storageAdapterMode = normalizeStorageMode(options.storageAdapterMode || "local");
    this.artifactDir = CONFIG.artifactDir;
    if (this.persist) mkdirSync(this.artifactDir, { recursive: true });
  }

  persistRecord(record) {
    if (!this.persist) return;
    writeJsonAtomic(artifactRecordPath(record.id), record);
  }

  save(record) {
    const artifact = normalizeArtifactRecord(record, { storageAdapterMode: this.storageAdapterMode });
    this.records.set(artifact.id, artifact);
    this.persistRecord(artifact);
    return artifact;
  }

  create(record) {
    return this.save(record);
  }

  update(artifactId, patch = {}) {
    const current = this.get(artifactId);
    if (!current) throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    return this.save({ ...current, ...patch, id: current.id, updatedAt: patch.updatedAt || nowIso() });
  }

  get(artifactId) {
    return this.records.get(normalizeArtifactId(artifactId)) || null;
  }

  markDeleted(artifactId) {
    return this.update(artifactId, { status: "deleted" });
  }

  markMissing(artifactId) {
    return this.update(artifactId, { status: "missing" });
  }

  all() {
    return [...this.records.values()];
  }

  listByOwner({ projectId, jobId } = {}) {
    const safeProjectId = projectId ? validateResourceId(projectId, "prj") : null;
    const safeJobId = jobId ? validateResourceId(jobId, "job") : null;
    return this.all().filter((record) => {
      if (safeProjectId && record.ownerProjectId !== safeProjectId) return false;
      if (safeJobId && record.ownerJobId !== safeJobId) return false;
      return true;
    });
  }

  listByTypeStatus({ types = null, statuses = null } = {}) {
    const safeTypes = Array.isArray(types) && types.length ? types.map(validateArtifactType) : null;
    const safeStatuses = Array.isArray(statuses) && statuses.length ? statuses.map(normalizeArtifactStatus) : null;
    return this.all().filter((record) => {
      if (safeTypes && !safeTypes.includes(record.type)) return false;
      if (safeStatuses && !safeStatuses.includes(record.status)) return false;
      return true;
    });
  }

  listCleanupCandidates(options = {}) {
    const query = normalizeCleanupQuery(options);
    const candidates = [];
    for (const record of this.all()) {
      if (candidates.length >= query.limit) break;
      if (!query.allowedTypes.includes(record.type)) continue;
      if (record.status === "deleted" || record.status === "missing") continue;
      if (record.ownerJobId && query.activeJobIds.has(record.ownerJobId)) continue;
      const ageMs = artifactAgeMs(record, query.nowMs);
      if (ageMs === null || ageMs < query.maxAgeSeconds * 1000) continue;
      candidates.push(record);
    }
    return candidates;
  }

  publicArtifact(record) {
    return publicArtifactRecord(record ? normalizeArtifactRecord(record, { storageAdapterMode: this.storageAdapterMode }) : null);
  }

  restore() {
    if (!this.persist || !existsSync(this.artifactDir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.artifactDir).sort()) {
      if (!fileName.endsWith(".json")) continue;
      try {
        if (!ARTIFACT_INDEX_FILE_RE.test(basename(fileName))) {
          ignored += 1;
          continue;
        }
        const filePath = storagePath("artifacts", fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_ARTIFACT_RECORD_BYTES) {
          ignored += 1;
          continue;
        }
        this.save(JSON.parse(readFileSync(filePath, "utf8")));
        records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  health() {
    const byStatus = Object.fromEntries(ARTIFACT_INDEX_STATUSES.map((status) => [status, 0]));
    const byType = {};
    for (const record of this.records.values()) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byType[record.type] = (byType[record.type] || 0) + 1;
    }
    return {
      ready: true,
      repository: "artifact-index",
      durable: this.persist,
      total: this.records.size,
      statuses: byStatus,
      types: byType,
    };
  }
}

module.exports = {
  ARTIFACT_INDEX_STATUSES,
  InMemoryArtifactRepository,
  normalizeArtifactRecord,
  publicArtifactRecord,
};
