const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const { dirname, extname, isAbsolute } = require("node:path");
const { pipeline } = require("node:stream/promises");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath, storagePath } = require("../storage.cjs");

const ARTIFACT_TYPES = Object.freeze([
  "upload",
  "extracted_audio",
  "audio",
  "subtitle_temp",
  "subtitles",
  "render_temp",
  "rendered_video",
  "render",
  "export",
  "evaluation_report",
]);
const ARTIFACT_STATUSES = Object.freeze(["staging", "available", "missing", "deleted"]);
const TEMP_ARTIFACT_TYPES = Object.freeze(["extracted_audio", "audio", "subtitle_temp", "subtitles", "render_temp"]);
const DOWNLOAD_ARTIFACT_TYPES = Object.freeze(["rendered_video", "render", "export"]);
const DEFAULT_SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_SIGNED_DOWNLOAD_TOKENS = 500;
const MAX_READ_ARTIFACT_BYTES = 25 * 1024 * 1024;

const AREA_BY_TYPE = Object.freeze({
  upload: "uploads",
  extracted_audio: "audio",
  audio: "audio",
  subtitle_temp: "tmp",
  subtitles: "tmp",
  render_temp: "tmp",
  rendered_video: "renders",
  render: "renders",
  export: "renders",
  evaluation_report: "data",
});

const CONTENT_TYPE_BY_TYPE = Object.freeze({
  upload: "video/mp4",
  extracted_audio: "audio/wav",
  audio: "audio/wav",
  subtitle_temp: "text/x-ass",
  subtitles: "text/x-ass",
  render_temp: "video/mp4",
  rendered_video: "video/mp4",
  render: "video/mp4",
  export: "video/mp4",
  evaluation_report: "application/json",
});

function nowIso() {
  return new Date().toISOString();
}

function validateArtifactType(type) {
  const safeType = String(type || "");
  if (!ARTIFACT_TYPES.includes(safeType)) {
    throw new AppError("ARTIFACT_TYPE_INVALID", SAFE_MESSAGES.ARTIFACT_TYPE_INVALID, 400);
  }
  return safeType;
}

function validateArtifactStatus(status) {
  const safeStatus = String(status || "available");
  if (!ARTIFACT_STATUSES.includes(safeStatus)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safeStatus;
}

function validateArtifactContentType(contentType, type) {
  const fallback = CONTENT_TYPE_BY_TYPE[type] || "application/octet-stream";
  if (contentType === null || contentType === undefined || contentType === "") return fallback;
  const safe = String(contentType).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,80}\/[a-z0-9][a-z0-9.+-]{0,80}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe;
}

function validateStorageKey(storageKey) {
  const safeKey = String(storageKey || "");
  if (
    !safeKey ||
    safeKey.length > 220 ||
    safeKey.includes("\u0000") ||
    safeKey.includes("\\") ||
    isAbsolute(safeKey) ||
    safeKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new AppError("ARTIFACT_KEY_INVALID", SAFE_MESSAGES.ARTIFACT_KEY_INVALID, 400);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(safeKey)) {
    throw new AppError("ARTIFACT_KEY_INVALID", SAFE_MESSAGES.ARTIFACT_KEY_INVALID, 400);
  }
  return safeKey;
}

function validateOptionalId(value, prefix) {
  if (!value) return null;
  const safe = String(value);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateArtifactId(value, fallback) {
  const safe = String(value || fallback || "");
  if (!safe || safe.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function normalizeOptionalSize(value) {
  if (value === null || value === undefined) return null;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.round(size);
}

function validateOptionalChecksum(value) {
  if (!value) return "";
  const safe = String(value);
  if (!/^[a-f0-9]{32,128}$/i.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safe.toLowerCase();
}

function defaultArtifactId(type, storageKey) {
  return `${type}_${storageKey.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 80)}`;
}

function extensionForStorageKey(storageKey, fallback = ".bin") {
  const ext = extname(String(storageKey || "")).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : fallback;
}

function rejectSignedToken() {
  throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
}

function assertSignedDownloadTokenScope(artifact, options = {}) {
  const expectedTypes = Array.isArray(options.expectedTypes) && options.expectedTypes.length
    ? options.expectedTypes
    : DOWNLOAD_ARTIFACT_TYPES;
  if (!artifact || !expectedTypes.includes(artifact.type)) rejectSignedToken();
  if (options.expectedArtifactId && artifact.id !== options.expectedArtifactId) rejectSignedToken();
  if (options.expectedProjectId && artifact.ownerProjectId !== options.expectedProjectId) rejectSignedToken();
  if (options.expectedJobId && artifact.ownerJobId !== options.expectedJobId) rejectSignedToken();
  return artifact;
}

function assertNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
}

function artifactAgeMs(artifact, nowMs) {
  const timestamp = Date.parse(artifact.updatedAt || artifact.createdAt || "");
  if (!Number.isFinite(timestamp)) return null;
  return nowMs - timestamp;
}

function normalizeCleanupPolicy(options = {}) {
  const allowedTypes = Array.isArray(options.allowedTypes) && options.allowedTypes.length
    ? options.allowedTypes.map(validateArtifactType).filter((type) => TEMP_ARTIFACT_TYPES.includes(type))
    : TEMP_ARTIFACT_TYPES;
  const maxAgeSeconds = Math.max(60, Math.min(Number(options.maxAgeSeconds || 24 * 60 * 60), 365 * 24 * 60 * 60));
  const maxArtifacts = Math.max(1, Math.min(Math.floor(Number(options.maxArtifacts || 100)), 1000));
  return {
    allowedTypes,
    dryRun: options.dryRun !== false,
    maxAgeSeconds,
    maxArtifacts,
    nowMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
  };
}

class LocalArtifactStore {
  constructor(options = {}) {
    this.clock = options.clock || nowIso;
    this.tokenTtlSeconds = Math.max(1, Number(options.tokenTtlSeconds || DEFAULT_SIGNED_DOWNLOAD_TTL_SECONDS));
    this.maxSignedTokens = Math.max(1, Math.min(Number(options.maxSignedTokens || DEFAULT_MAX_SIGNED_DOWNLOAD_TOKENS), 5000));
    this.signedTokens = options.signedTokens || new Map();
  }

  areaForType(type) {
    return AREA_BY_TYPE[validateArtifactType(type)];
  }

  pathFor(type, storageKey) {
    return storagePath(this.areaForType(type), validateStorageKey(storageKey));
  }

  assertPathForType(type, filePath) {
    return assertStoragePath(filePath, this.areaForType(type));
  }

  createRecord(input = {}) {
    const type = validateArtifactType(input.type);
    const storageKey = validateStorageKey(input.storageKey);
    const filePath = this.pathFor(type, storageKey);
    const createdAt = input.createdAt || this.clock();
    return {
      id: validateArtifactId(input.id, defaultArtifactId(type, storageKey)),
      type,
      ownerProjectId: validateOptionalId(input.ownerProjectId, "prj"),
      ownerJobId: validateOptionalId(input.ownerJobId, "job"),
      storageKey,
      size: normalizeOptionalSize(input.size),
      contentType: validateArtifactContentType(input.contentType, type),
      checksumSha256: validateOptionalChecksum(input.checksumSha256),
      status: validateArtifactStatus(input.status),
      createdAt,
      updatedAt: input.updatedAt || createdAt,
      path: filePath,
    };
  }

  publicRecord(record) {
    if (!record) return null;
    const { path, storageKey, ...safe } = this.createRecord(record);
    return safe;
  }

  resolve(record) {
    if (!record || typeof record !== "object") {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    return this.pathFor(record.type, record.storageKey);
  }

  resolveLocalPath(record) {
    return this.resolve(record);
  }

  stagingPath(storageKey, prefix = "stage") {
    const ext = extensionForStorageKey(storageKey);
    return storagePath("staging", `${prefix}-${randomUUID()}${ext}`);
  }

  assertStagingPath(filePath) {
    return assertStoragePath(filePath, "staging");
  }

  exists(record) {
    try {
      return existsSync(this.resolve(record));
    } catch {
      return false;
    }
  }

  artifactExists(record) {
    return this.exists(record);
  }

  isFile(record) {
    try {
      return statSync(this.resolve(record)).isFile();
    } catch {
      return false;
    }
  }

  stat(record) {
    return statSync(this.resolve(record));
  }

  getArtifactMetadata(record) {
    const artifact = this.createRecord(record);
    if (!this.exists(artifact)) {
      return this.createRecord({ ...artifact, status: "missing", size: artifact.size ?? null, updatedAt: this.clock() });
    }
    const fileStat = this.stat(artifact);
    return this.createRecord({ ...artifact, size: fileStat.size, status: "available", updatedAt: artifact.updatedAt });
  }

  assertReadableArtifact(record) {
    const artifact = this.getArtifactMetadata(record);
    if (artifact.status !== "available" || !this.isFile(artifact)) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    return artifact;
  }

  createReadStream(record) {
    const artifact = this.assertReadableArtifact(record);
    return createReadStream(this.resolve(artifact));
  }

  readArtifact(record, options = {}) {
    const artifact = this.assertReadableArtifact(record);
    const maxBytes = Number(options.maxBytes || MAX_READ_ARTIFACT_BYTES);
    if (Number.isFinite(maxBytes) && artifact.size !== null && artifact.size > maxBytes) {
      throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
    }
    return readFileSync(this.resolve(artifact));
  }

  createWriteStream(input = {}) {
    const record = this.createRecord({ ...input, status: input.status || "staging" });
    const filePath = this.resolve(record);
    mkdirSync(dirname(filePath), { recursive: true });
    return {
      record,
      stream: createWriteStream(filePath),
    };
  }

  writeBuffer(input = {}) {
    if (!Buffer.isBuffer(input.buffer)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const record = this.createRecord(input);
    const filePath = this.resolve(record);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, input.buffer || Buffer.alloc(0));
    const stat = statSync(filePath);
    return this.createRecord({ ...record, size: stat.size, status: input.status || "available" });
  }

  writeArtifact(input = {}) {
    if (Buffer.isBuffer(input.buffer)) return this.writeBuffer(input);
    if (typeof input.body === "string" || Buffer.isBuffer(input.body)) {
      return this.writeBuffer({ ...input, buffer: Buffer.from(input.body) });
    }
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }

  putArtifact(input = {}) {
    return this.writeArtifact(input);
  }

  stageInputForProcessing(record, options = {}) {
    const artifact = this.assertReadableArtifact(record);
    return {
      id: `stage_${randomUUID()}`,
      purpose: "input",
      adapterMode: "local",
      artifact,
      localPath: this.resolveLocalPath(artifact),
      permanentLocal: true,
      cleanupRequired: false,
      createdAt: this.clock(),
      step: options.step || "stage_input",
    };
  }

  async stageInputForProcessingAsync(record, options = {}) {
    return this.stageInputForProcessing(record, options);
  }

  stageArtifactToLocalPath(record, options = {}) {
    return this.stageInputForProcessing(record, options);
  }

  createOutputStage(type, metadata = {}) {
    const artifact = this.createRecord({
      ...metadata,
      type,
      storageKey: metadata.storageKey || `${type}-${randomUUID()}`,
      status: "staging",
    });
    const localPath = this.resolveLocalPath(artifact);
    mkdirSync(dirname(localPath), { recursive: true });
    return {
      id: `stage_${randomUUID()}`,
      purpose: "output",
      adapterMode: "local",
      artifact,
      localPath,
      permanentLocal: true,
      cleanupRequired: TEMP_ARTIFACT_TYPES.includes(artifact.type),
      createdAt: this.clock(),
    };
  }

  commitOutputStage(stage, metadata = {}) {
    const safeStage = this.validateStage(stage);
    if (!safeStage.artifact || !this.isFile(safeStage.artifact)) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    const stat = this.stat(safeStage.artifact);
    return this.createRecord({
      ...safeStage.artifact,
      ...metadata,
      size: metadata.size ?? stat.size,
      status: "available",
      updatedAt: this.clock(),
    });
  }

  async commitOutputStageAsync(stage, metadata = {}) {
    return this.commitOutputStage(stage, metadata);
  }

  commitLocalArtifact(stage, metadata = {}) {
    return this.commitOutputStage(stage, metadata);
  }

  markAvailable(record) {
    return this.createRecord({ ...record, status: "available", updatedAt: this.clock() });
  }

  deleteStagingArtifact(record) {
    const artifact = this.createRecord(record);
    if (artifact.status !== "staging") {
      throw new AppError("ARTIFACT_DELETE_FORBIDDEN", SAFE_MESSAGES.ARTIFACT_DELETE_FORBIDDEN, 403);
    }
    try {
      unlinkSync(this.resolve(artifact));
    } catch {
      // Best-effort cleanup of an uncommitted artifact.
    }
    return this.createRecord({ ...artifact, status: "deleted", updatedAt: this.clock() });
  }

  deleteTempArtifact(record) {
    const artifact = this.createRecord(record);
    if (!TEMP_ARTIFACT_TYPES.includes(artifact.type)) {
      throw new AppError("ARTIFACT_DELETE_FORBIDDEN", SAFE_MESSAGES.ARTIFACT_DELETE_FORBIDDEN, 403);
    }
    try {
      unlinkSync(this.resolve(artifact));
    } catch {
      // Best-effort cleanup of temporary render artifacts.
    }
    return this.createRecord({ ...artifact, status: "deleted", updatedAt: this.clock() });
  }

  validateStage(stage) {
    if (!stage || typeof stage !== "object" || !stage.id || !stage.localPath) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    if (stage.permanentLocal) {
      if (stage.artifact) this.assertPathForType(stage.artifact.type, stage.localPath);
    } else {
      this.assertStagingPath(stage.localPath);
    }
    return stage;
  }

  cleanupStage(stage) {
    if (!stage) return { cleaned: false };
    const safeStage = this.validateStage(stage);
    if (!safeStage.cleanupRequired) return { cleaned: false };
    try {
      if (safeStage.artifact && TEMP_ARTIFACT_TYPES.includes(safeStage.artifact.type) && safeStage.permanentLocal) {
        this.deleteTempArtifact(safeStage.artifact);
      } else {
        unlinkSync(this.assertStagingPath(safeStage.localPath));
      }
      return { cleaned: true };
    } catch {
      return { cleaned: false };
    }
  }

  cleanupStagedArtifact(stage) {
    return this.cleanupStage(stage);
  }

  async streamArtifactToLocalPath(record, localPath, options = {}) {
    assertNotAborted(options.signal);
    const artifact = this.assertReadableArtifact(record);
    const target = options.allowPermanentLocal
      ? this.assertPathForType(artifact.type, localPath)
      : this.assertStagingPath(localPath);
    mkdirSync(dirname(target), { recursive: true });
    const startedAt = Date.now();
    await pipeline(this.createReadStream(artifact), createWriteStream(target));
    assertNotAborted(options.signal);
    const size = statSync(target).size;
    return {
      artifact,
      bytes: size,
      durationMs: Date.now() - startedAt,
      localPath: target,
      operation: "stream_download",
      strategy: "local-stream",
    };
  }

  async streamLocalPathToArtifact(localPath, input = {}, options = {}) {
    assertNotAborted(options.signal);
    const record = this.createRecord(input);
    const sourcePath = options.allowPermanentLocal
      ? assertStoragePath(localPath, this.areaForType(record.type))
      : this.assertStagingPath(localPath);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    const targetPath = this.resolve(record);
    mkdirSync(dirname(targetPath), { recursive: true });
    const startedAt = Date.now();
    if (sourcePath !== targetPath) {
      await pipeline(createReadStream(sourcePath), createWriteStream(targetPath));
    }
    assertNotAborted(options.signal);
    const size = statSync(targetPath).size;
    return this.createRecord({
      ...record,
      size,
      status: input.status || "available",
      updatedAt: this.clock(),
      transfer: {
        bytes: size,
        durationMs: Date.now() - startedAt,
        operation: "stream_upload",
        strategy: "local-stream",
      },
    });
  }

  cleanupArtifactsByPolicy(records = [], options = {}) {
    const policy = normalizeCleanupPolicy(options);
    const result = {
      dryRun: policy.dryRun,
      scanned: 0,
      eligible: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      maxArtifacts: policy.maxArtifacts,
      maxAgeSeconds: policy.maxAgeSeconds,
      allowedTypes: policy.allowedTypes,
    };
    for (const rawRecord of Array.isArray(records) ? records : []) {
      if (result.deleted >= policy.maxArtifacts || result.eligible >= policy.maxArtifacts) break;
      result.scanned += 1;
      let artifact;
      try {
        artifact = this.createRecord(rawRecord);
        const ageMs = artifactAgeMs(artifact, policy.nowMs);
        if (!policy.allowedTypes.includes(artifact.type) || ageMs === null || ageMs < policy.maxAgeSeconds * 1000) {
          result.skipped += 1;
          continue;
        }
        result.eligible += 1;
        if (!policy.dryRun) {
          this.deleteTempArtifact(artifact);
          result.deleted += 1;
        }
      } catch {
        result.errors += 1;
      }
    }
    this.pruneSignedTokens(policy.nowMs);
    return result;
  }

  pruneSignedTokens(nowMs = Date.now()) {
    const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    for (const [token, entry] of this.signedTokens.entries()) {
      if (!entry || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= safeNowMs) {
        this.signedTokens.delete(token);
      }
    }
    while (this.signedTokens.size > this.maxSignedTokens) {
      const oldestToken = this.signedTokens.keys().next().value;
      if (!oldestToken) break;
      this.signedTokens.delete(oldestToken);
    }
    return this.signedTokens.size;
  }

  createSignedDownloadUrl(record, options = {}) {
    this.pruneSignedTokens();
    const artifact = this.assertReadableArtifact(record);
    if (!DOWNLOAD_ARTIFACT_TYPES.includes(artifact.type)) {
      throw new AppError("ARTIFACT_TYPE_INVALID", SAFE_MESSAGES.ARTIFACT_TYPE_INVALID, 400);
    }
    const ttlSeconds = Math.max(1, Math.min(Number(options.ttlSeconds || this.tokenTtlSeconds), 15 * 60));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const token = `adt_${randomUUID()}_${randomUUID().replace(/-/g, "")}`;
    this.signedTokens.set(token, {
      artifact: this.createRecord(artifact),
      expiresAtMs: Date.parse(expiresAt),
      createdAt: this.clock(),
    });
    this.pruneSignedTokens();
    const basePath = String(options.basePath || "/api/artifacts/download");
    return {
      url: `${basePath}?token=${encodeURIComponent(token)}`,
      token,
      expiresAt,
      ttlSeconds,
    };
  }

  validateSignedDownloadToken(token, options = {}) {
    const safeToken = String(token || "");
    if (!/^adt_[A-Fa-f0-9-]{36}_[A-Fa-f0-9]{32}$/.test(safeToken)) {
      throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
    }
    const entry = this.signedTokens.get(safeToken);
    const nowMs = Number(options.nowMs ?? Date.now());
    if (!entry || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= nowMs) {
      this.signedTokens.delete(safeToken);
      throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
    }
    return assertSignedDownloadTokenScope(this.assertReadableArtifact(entry.artifact), options);
  }

  healthProbe() {
    const artifact = this.writeArtifact({
      id: `health_${randomUUID()}`,
      type: "render_temp",
      storageKey: `health-${randomUUID()}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from("ok"),
      status: "staging",
    });
    const body = this.readArtifact(artifact, { maxBytes: 64 }).toString("utf8");
    const deleted = this.deleteTempArtifact(artifact);
    return {
      write: true,
      read: body === "ok",
      cleanup: deleted.status === "deleted",
    };
  }

  stagingHealthProbe() {
    const stage = this.createOutputStage("render_temp", {
      storageKey: `stage-health-${randomUUID()}.txt`,
      contentType: "text/plain",
    });
    writeFileSync(stage.localPath, "ok", "utf8");
    const committed = this.commitOutputStage(stage, { contentType: "text/plain" });
    const body = this.readArtifact(committed, { maxBytes: 64 }).toString("utf8");
    const cleanup = this.cleanupStage(stage);
    return {
      stage: true,
      commit: committed.status === "available" && body === "ok",
      cleanup: Boolean(cleanup.cleaned),
    };
  }

  health() {
    let probe = { write: false, read: false, cleanup: false };
    let staging = { stage: false, commit: false, cleanup: false };
    try {
      probe = this.healthProbe();
    } catch {
      probe = { write: false, read: false, cleanup: false };
    }
    try {
      staging = this.stagingHealthProbe();
    } catch {
      staging = { stage: false, commit: false, cleanup: false };
    }
    this.pruneSignedTokens();
    return {
      ready: Boolean(probe.write && probe.read && probe.cleanup && staging.stage && staging.commit && staging.cleanup),
      adapter: "local-artifact",
      mode: "local",
      objectStorage: false,
      signedUrls: true,
      signedDownloadTtlSeconds: this.tokenTtlSeconds,
      maxSignedTokens: this.maxSignedTokens,
      activeSignedTokens: this.signedTokens.size,
      types: ARTIFACT_TYPES.length,
      statuses: ARTIFACT_STATUSES.length,
      stagingCleanup: true,
      streamingSupported: true,
      multipartSupported: false,
      lifecycleCleanupSupported: true,
      tempDeleteTypes: TEMP_ARTIFACT_TYPES.length,
      downloadableTypes: DOWNLOAD_ARTIFACT_TYPES.length,
      probe,
      staging,
    };
  }
}

module.exports = {
  AREA_BY_TYPE,
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  CONTENT_TYPE_BY_TYPE,
  DEFAULT_MAX_SIGNED_DOWNLOAD_TOKENS,
  DEFAULT_SIGNED_DOWNLOAD_TTL_SECONDS,
  DOWNLOAD_ARTIFACT_TYPES,
  LocalArtifactStore,
  TEMP_ARTIFACT_TYPES,
  assertSignedDownloadTokenScope,
  validateArtifactKey: validateStorageKey,
  validateArtifactType,
};
