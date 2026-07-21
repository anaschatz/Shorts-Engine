const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const PERSISTENCE_ADAPTER_METHODS = Object.freeze([
  "createProject",
  "getProject",
  "updateProject",
  "compareAndSwapProject",
  "publicProject",
  "createUpload",
  "getUpload",
  "publicUpload",
  "createArtifact",
  "getArtifact",
  "updateArtifact",
  "publicArtifact",
  "listArtifactsForOwner",
  "listCleanupArtifactCandidates",
  "markArtifactDeleted",
  "markArtifactMissing",
  "createExport",
  "getExport",
  "publicExport",
  "getExportDownloadDescriptor",
  "createSignedExportDownload",
  "resolveExportOutputPath",
  "transaction",
  "createProjectUpload",
  "persistProjectUpload",
  "persistJob",
  "getPersistedJob",
  "listPersistedJobs",
  "claimPersistedJob",
  "persistClaimedJob",
  "persistIdempotencyKey",
  "getIdempotencyJobId",
  "persistRenderRecord",
  "restoreState",
  "getRegenerationDraftRepository",
  "getRegenerationApprovalRepository",
  "getApprovalOutboxRepository",
  "health",
]);

function assertAdapterMethod(adapter, method) {
  if (!adapter || typeof adapter[method] !== "function") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
}

function validatePersistenceAdapter(adapter) {
  for (const method of PERSISTENCE_ADAPTER_METHODS) {
    assertAdapterMethod(adapter, method);
  }
  return adapter;
}

function persistenceAdapterCapabilities(adapter) {
  return Object.fromEntries(
    PERSISTENCE_ADAPTER_METHODS.map((method) => [method, Boolean(adapter && typeof adapter[method] === "function")]),
  );
}

module.exports = {
  PERSISTENCE_ADAPTER_METHODS,
  persistenceAdapterCapabilities,
  validatePersistenceAdapter,
};
