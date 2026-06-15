const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const ARTIFACT_ADAPTER_METHODS = Object.freeze([
  "createArtifactRecord",
  "publicArtifactRecord",
  "getArtifactMetadata",
  "artifactExists",
  "resolveArtifact",
  "resolveLocalPath",
  "exists",
  "isFile",
  "stat",
  "createReadStream",
  "readArtifact",
  "createWriteStream",
  "writeArtifact",
  "putArtifact",
  "writeBuffer",
  "markAvailable",
  "stageInputForProcessing",
  "stageInputForProcessingAsync",
  "stageArtifactToLocalPath",
  "createOutputStage",
  "commitOutputStage",
  "commitOutputStageAsync",
  "commitLocalArtifact",
  "cleanupStage",
  "cleanupStagedArtifact",
  "streamArtifactToLocalPath",
  "streamLocalPathToArtifact",
  "createSignedDownloadUrl",
  "validateSignedDownloadToken",
  "pruneSignedTokens",
  "cleanupArtifactsByPolicy",
  "deleteStagingArtifact",
  "deleteTempArtifact",
  "health",
]);

function assertAdapterMethod(adapter, method) {
  if (!adapter || typeof adapter[method] !== "function") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
}

function validateArtifactAdapter(adapter) {
  for (const method of ARTIFACT_ADAPTER_METHODS) {
    assertAdapterMethod(adapter, method);
  }
  return adapter;
}

function artifactAdapterCapabilities(adapter) {
  return Object.fromEntries(
    ARTIFACT_ADAPTER_METHODS.map((method) => [method, Boolean(adapter && typeof adapter[method] === "function")]),
  );
}

module.exports = {
  ARTIFACT_ADAPTER_METHODS,
  artifactAdapterCapabilities,
  validateArtifactAdapter,
};
