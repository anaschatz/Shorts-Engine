const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, extname } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath, storagePath } = require("../storage.cjs");
const {
  LocalArtifactStore,
  TEMP_ARTIFACT_TYPES,
} = require("../storage/artifact-store.cjs");
const { artifactAdapterCapabilities, validateArtifactAdapter } = require("./artifact-adapter.cjs");

function stageExtension(storageKey) {
  const ext = extname(String(storageKey || "")).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : ".bin";
}

class MockCloudArtifactAdapter {
  constructor(options = {}) {
    this.store = options.store || new LocalArtifactStore(options);
    this.mode = "mock-cloud";
    validateArtifactAdapter(this);
  }

  createArtifactRecord(input) {
    return this.store.createRecord(input);
  }

  createRecord(input) {
    return this.createArtifactRecord(input);
  }

  publicArtifactRecord(record) {
    return this.store.publicRecord(record);
  }

  publicRecord(record) {
    return this.publicArtifactRecord(record);
  }

  getArtifactMetadata(record) {
    return this.store.getArtifactMetadata(record);
  }

  artifactExists(record) {
    return this.store.artifactExists(record);
  }

  resolveArtifact() {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }

  resolve() {
    return this.resolveArtifact();
  }

  resolveLocalPath() {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }

  exists(record) {
    return this.store.exists(record);
  }

  isFile(record) {
    return this.store.isFile(record);
  }

  stat(record) {
    return this.store.stat(record);
  }

  createReadStream(record) {
    return this.store.createReadStream(record);
  }

  readArtifact(record, options) {
    return this.store.readArtifact(record, options);
  }

  createWriteStream(input) {
    return this.store.createWriteStream(input);
  }

  writeArtifact(input) {
    return this.store.writeArtifact(input);
  }

  putArtifact(input) {
    return this.store.putArtifact(input);
  }

  writeBuffer(input) {
    return this.store.writeBuffer(input);
  }

  markAvailable(record) {
    return this.store.markAvailable(record);
  }

  stagingPath(storageKey, prefix = "mock-cloud-stage") {
    return storagePath("staging", `${prefix}-${randomUUID()}${stageExtension(storageKey)}`);
  }

  assertStagingPath(filePath) {
    return assertStoragePath(filePath, "staging");
  }

  stageInputForProcessing(record, options = {}) {
    const artifact = this.store.assertReadableArtifact(record);
    const localPath = this.stagingPath(artifact.storageKey, "mock-cloud-input");
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, this.store.readArtifact(artifact));
    return {
      id: `stage_${randomUUID()}`,
      purpose: "input",
      adapterMode: this.mode,
      artifact,
      localPath,
      permanentLocal: false,
      cleanupRequired: true,
      createdAt: new Date().toISOString(),
      step: options.step || "stage_input",
    };
  }

  async stageInputForProcessingAsync(record, options = {}) {
    return this.stageInputForProcessing(record, options);
  }

  stageArtifactToLocalPath(record, options) {
    return this.stageInputForProcessing(record, options);
  }

  createOutputStage(type, metadata = {}) {
    const artifact = this.createArtifactRecord({
      ...metadata,
      type,
      storageKey: metadata.storageKey || `${type}-${randomUUID()}`,
      status: "staging",
    });
    const localPath = this.stagingPath(artifact.storageKey, "mock-cloud-output");
    mkdirSync(dirname(localPath), { recursive: true });
    return {
      id: `stage_${randomUUID()}`,
      purpose: "output",
      adapterMode: this.mode,
      artifact,
      localPath,
      permanentLocal: false,
      cleanupRequired: true,
      createdAt: new Date().toISOString(),
    };
  }

  validateStage(stage) {
    if (!stage || typeof stage !== "object" || !stage.id || !stage.localPath) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    this.assertStagingPath(stage.localPath);
    return stage;
  }

  commitOutputStage(stage, metadata = {}) {
    const safeStage = this.validateStage(stage);
    if (!existsSync(safeStage.localPath) || !statSync(safeStage.localPath).isFile()) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    const stat = statSync(safeStage.localPath);
    return this.store.writeArtifact({
      ...safeStage.artifact,
      ...metadata,
      buffer: readFileSync(safeStage.localPath),
      size: metadata.size ?? stat.size,
      status: "available",
    });
  }

  async commitOutputStageAsync(stage, metadata = {}) {
    return this.commitOutputStage(stage, metadata);
  }

  commitLocalArtifact(stage, metadata) {
    return this.commitOutputStage(stage, metadata);
  }

  cleanupStage(stage) {
    if (!stage) return { cleaned: false };
    const safeStage = this.validateStage(stage);
    if (!safeStage.cleanupRequired) return { cleaned: false };
    try {
      unlinkSync(this.assertStagingPath(safeStage.localPath));
      return { cleaned: true };
    } catch {
      return { cleaned: false };
    }
  }

  cleanupStagedArtifact(stage) {
    return this.cleanupStage(stage);
  }

  streamArtifactToLocalPath(record, localPath, options = {}) {
    return this.store.streamArtifactToLocalPath(record, localPath, {
      ...options,
      allowPermanentLocal: false,
    });
  }

  streamLocalPathToArtifact(localPath, input = {}, options = {}) {
    return this.store.streamLocalPathToArtifact(localPath, input, {
      ...options,
      allowPermanentLocal: false,
    });
  }

  deleteStagingArtifact(record) {
    return this.store.deleteStagingArtifact(record);
  }

  deleteTempArtifact(record) {
    return this.store.deleteTempArtifact(record);
  }

  deleteMarkedArtifact(record, options) {
    return this.store.deleteMarkedArtifact(record, options);
  }

  createSignedDownloadUrl(record, options) {
    return this.store.createSignedDownloadUrl(record, options);
  }

  validateSignedDownloadToken(token, options) {
    return this.store.validateSignedDownloadToken(token, options);
  }

  pruneSignedTokens(nowMs) {
    return this.store.pruneSignedTokens(nowMs);
  }

  cleanupArtifactsByPolicy(records, options) {
    return this.store.cleanupArtifactsByPolicy(records, options);
  }

  health() {
    let staging = { stage: false, commit: false, cleanup: false };
    let tempArtifact = null;
    try {
      const stage = this.createOutputStage("render_temp", {
        storageKey: `mock-cloud-health-${randomUUID()}.txt`,
        contentType: "text/plain",
      });
      writeFileSync(stage.localPath, "ok", "utf8");
      tempArtifact = this.commitOutputStage(stage, { contentType: "text/plain" });
      const body = this.readArtifact(tempArtifact, { maxBytes: 64 }).toString("utf8");
      const cleanup = this.cleanupStage(stage);
      if (tempArtifact && TEMP_ARTIFACT_TYPES.includes(tempArtifact.type)) this.deleteTempArtifact(tempArtifact);
      staging = { stage: true, commit: body === "ok", cleanup: cleanup.cleaned };
    } catch {
      if (tempArtifact && TEMP_ARTIFACT_TYPES.includes(tempArtifact.type)) {
        try {
          this.deleteTempArtifact(tempArtifact);
        } catch {
          // Best-effort health cleanup.
        }
      }
      staging = { stage: false, commit: false, cleanup: false };
    }
    const local = this.store.health();
    return {
      ready: Boolean(local.ready && staging.stage && staging.commit && staging.cleanup),
      adapter: "mock-cloud-artifact",
      mode: this.mode,
      objectStorage: true,
      signedUrls: true,
      signedDownloadTtlSeconds: local.signedDownloadTtlSeconds,
      maxSignedTokens: local.maxSignedTokens,
      activeSignedTokens: local.activeSignedTokens,
      durable: false,
      credentialsConfigured: false,
      bucketConfigured: false,
      endpointConfigured: false,
      capabilities: artifactAdapterCapabilities(this),
      types: local.types,
      statuses: local.statuses,
      streamingSupported: true,
      multipartSupported: false,
      lifecycleCleanupSupported: true,
      staging,
    };
  }
}

module.exports = {
  MockCloudArtifactAdapter,
};
