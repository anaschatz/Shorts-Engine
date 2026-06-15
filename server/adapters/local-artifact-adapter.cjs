const { LocalArtifactStore } = require("../storage/artifact-store.cjs");
const { artifactAdapterCapabilities, validateArtifactAdapter } = require("./artifact-adapter.cjs");

class LocalArtifactAdapter {
  constructor(options = {}) {
    this.store = options.store || new LocalArtifactStore(options);
    validateArtifactAdapter(this);
  }

  areaForType(type) {
    return this.store.areaForType(type);
  }

  pathFor(type, storageKey) {
    return this.store.pathFor(type, storageKey);
  }

  assertPathForType(type, filePath) {
    return this.store.assertPathForType(type, filePath);
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

  resolveArtifact(record) {
    return this.store.resolve(record);
  }

  resolve(record) {
    return this.resolveArtifact(record);
  }

  resolveLocalPath(record) {
    return this.store.resolveLocalPath(record);
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

  stageInputForProcessing(record, options) {
    return this.store.stageInputForProcessing(record, options);
  }

  stageInputForProcessingAsync(record, options) {
    return this.store.stageInputForProcessingAsync(record, options);
  }

  stageArtifactToLocalPath(record, options) {
    return this.store.stageArtifactToLocalPath(record, options);
  }

  createOutputStage(type, metadata) {
    return this.store.createOutputStage(type, metadata);
  }

  commitOutputStage(stage, metadata) {
    return this.store.commitOutputStage(stage, metadata);
  }

  commitOutputStageAsync(stage, metadata) {
    return this.store.commitOutputStageAsync(stage, metadata);
  }

  commitLocalArtifact(stage, metadata) {
    return this.store.commitLocalArtifact(stage, metadata);
  }

  cleanupStage(stage) {
    return this.store.cleanupStage(stage);
  }

  cleanupStagedArtifact(stage) {
    return this.store.cleanupStagedArtifact(stage);
  }

  streamArtifactToLocalPath(record, localPath, options) {
    return this.store.streamArtifactToLocalPath(record, localPath, options);
  }

  streamLocalPathToArtifact(localPath, input, options) {
    return this.store.streamLocalPathToArtifact(localPath, input, options);
  }

  deleteStagingArtifact(record) {
    return this.store.deleteStagingArtifact(record);
  }

  deleteTempArtifact(record) {
    return this.store.deleteTempArtifact(record);
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
    const local = this.store.health();
    return {
      ready: Boolean(local.ready),
      adapter: "local-artifact",
      mode: "local",
      objectStorage: false,
      signedUrls: local.signedUrls,
      signedDownloadTtlSeconds: local.signedDownloadTtlSeconds,
      maxSignedTokens: local.maxSignedTokens,
      activeSignedTokens: local.activeSignedTokens,
      durable: true,
      capabilities: artifactAdapterCapabilities(this),
      types: local.types,
      statuses: local.statuses,
      stagingCleanup: local.stagingCleanup,
      streamingSupported: local.streamingSupported,
      multipartSupported: local.multipartSupported,
      lifecycleCleanupSupported: local.lifecycleCleanupSupported,
      tempDeleteTypes: local.tempDeleteTypes,
      downloadableTypes: local.downloadableTypes,
      probe: local.probe,
      staging: local.staging,
    };
  }
}

module.exports = {
  LocalArtifactAdapter,
};
