const { randomUUID } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

function persistenceMethod(persistence, method) {
  if (persistence && typeof persistence[method] === "function") {
    return persistence[method].bind(persistence);
  }
  if (persistence && typeof persistence.call === "function") {
    return (...args) => persistence.call(method, ...args);
  }
  throw new AppError(
    "ADAPTER_CONTRACT_INVALID",
    SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
    500,
  );
}

function retryDelayMs(attempt) {
  return Math.min(60_000, 1000 * (2 ** Math.max(0, Number(attempt || 1) - 1)));
}

class StorageReconciliationWorker {
  constructor(options = {}) {
    this.persistence = options.persistence;
    this.store = options.store;
    this.randomUUID = options.randomUUID || randomUUID;
    this.leaseMs = Math.max(10_000, Math.min(5 * 60_000, Number(options.leaseMs || 60_000)));
  }

  async execute(operation) {
    if (operation.operation === "abort_multipart") {
      if (!operation.providerUploadId) return true;
      return await this.store.abortMultipartUpload({
        storageKey: operation.storageKey,
        uploadId: operation.providerUploadId,
      });
    }
    if (operation.operation === "delete_object") {
      return await this.store.deleteObject(operation.storageKey);
    }
    if (operation.operation === "verify_delete") {
      try {
        await this.store.headObject(operation.storageKey);
      } catch (error) {
        if (
          error
          && (
            error.name === "NotFound"
            || error.$metadata && error.$metadata.httpStatusCode === 404
          )
        ) {
          return true;
        }
        throw error;
      }
      throw new AppError(
        "CLOUD_STORAGE_FAILED",
        SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
        502,
      );
    }
    throw new AppError(
      "ADAPTER_CONTRACT_INVALID",
      SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
      500,
    );
  }

  async runOnce() {
    const leaseId = `slease_${this.randomUUID()}`;
    const operation = await persistenceMethod(
      this.persistence,
      "claimStorageOperation",
    )({
      leaseId,
      leaseMs: this.leaseMs,
    });
    if (!operation) return { claimed: false };
    try {
      await this.execute(operation);
      const completed = await persistenceMethod(
        this.persistence,
        "completeStorageOperation",
      )({
        operationId: operation.id,
        leaseId: operation.leaseId,
      });
      if (!completed) {
        throw new AppError(
          "JOB_LEASE_INVALID",
          SAFE_MESSAGES.JOB_LEASE_INVALID,
          409,
        );
      }
      return {
        claimed: true,
        completed: true,
        operation: operation.operation,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "JOB_LEASE_INVALID") throw error;
      const status = await persistenceMethod(
        this.persistence,
        "failStorageOperation",
      )({
        operationId: operation.id,
        leaseId: operation.leaseId,
        errorCode: error instanceof AppError ? error.code : "CLOUD_STORAGE_FAILED",
        retryDelayMs: retryDelayMs(operation.attempt),
      });
      return {
        claimed: true,
        completed: false,
        operation: operation.operation,
        status,
      };
    }
  }
}

module.exports = {
  StorageReconciliationWorker,
  retryDelayMs,
};
