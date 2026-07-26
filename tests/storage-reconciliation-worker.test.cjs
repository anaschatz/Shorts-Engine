const assert = require("node:assert/strict");
const test = require("node:test");

const {
  StorageReconciliationWorker,
  retryDelayMs,
} = require("../server/storage/storage-reconciliation-worker.cjs");

function persistence(operation) {
  const calls = [];
  return {
    calls,
    async claimStorageOperation(record) {
      calls.push({ method: "claimStorageOperation", record });
      return operation ? { ...operation, leaseId: record.leaseId } : null;
    },
    async completeStorageOperation(record) {
      calls.push({ method: "completeStorageOperation", record });
      return true;
    },
    async failStorageOperation(record) {
      calls.push({ method: "failStorageOperation", record });
      return operation && operation.attempt >= operation.maxAttempts
        ? "dead_letter"
        : "queued";
    },
  };
}

function operation(overrides = {}) {
  return {
    id: "sop_test",
    ownerId: "usr_test",
    operation: "delete_object",
    attempt: 1,
    maxAttempts: 5,
    leaseId: "assigned-by-claim",
    storageKey: "source/scope/artifact/object.mp4",
    providerUploadId: null,
    ...overrides,
  };
}

test("storage reconciliation does no provider work when no operation is due", async () => {
  const database = persistence(null);
  const store = {
    async deleteObject() {
      throw new Error("must not execute");
    },
  };
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store,
    randomUUID: () => "lease-id",
  });
  assert.deepEqual(await worker.runOnce(), { claimed: false });
  assert.deepEqual(
    database.calls.map((call) => call.method),
    ["claimStorageOperation"],
  );
});

test("storage reconciliation deletes objects and completes only with its lease", async () => {
  const database = persistence(operation());
  const storeCalls = [];
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store: {
      async deleteObject(storageKey) {
        storeCalls.push({ method: "deleteObject", storageKey });
        return true;
      },
    },
    randomUUID: () => "lease-id",
  });
  assert.deepEqual(await worker.runOnce(), {
    claimed: true,
    completed: true,
    operation: "delete_object",
  });
  assert.deepEqual(storeCalls, [{
    method: "deleteObject",
    storageKey: "source/scope/artifact/object.mp4",
  }]);
  const completion = database.calls.at(-1);
  assert.equal(completion.method, "completeStorageOperation");
  assert.equal(completion.record.operationId, "sop_test");
  assert.equal(completion.record.leaseId, "slease_lease-id");
});

test("storage reconciliation aborts incomplete multipart uploads", async () => {
  const database = persistence(operation({
    operation: "abort_multipart",
    providerUploadId: "provider-upload-id",
  }));
  const calls = [];
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store: {
      async abortMultipartUpload(record) {
        calls.push(record);
        return true;
      },
    },
    randomUUID: () => "lease-id",
  });
  await worker.runOnce();
  assert.deepEqual(calls, [{
    storageKey: "source/scope/artifact/object.mp4",
    uploadId: "provider-upload-id",
  }]);
});

test("storage reconciliation retries safe provider failures with bounded backoff", async () => {
  const database = persistence(operation({ attempt: 3 }));
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store: {
      async deleteObject() {
        throw new Error("provider secret and storage URL");
      },
    },
    randomUUID: () => "lease-id",
  });
  assert.deepEqual(await worker.runOnce(), {
    claimed: true,
    completed: false,
    operation: "delete_object",
    status: "queued",
  });
  const failure = database.calls.at(-1);
  assert.equal(failure.method, "failStorageOperation");
  assert.equal(failure.record.errorCode, "CLOUD_STORAGE_FAILED");
  assert.equal(failure.record.retryDelayMs, 4000);
  assert.doesNotMatch(JSON.stringify(failure), /provider secret|storage URL/i);
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(20), 60000);
});

test("storage reconciliation transitions exhausted operations to dead letter", async () => {
  const database = persistence(operation({
    attempt: 5,
    maxAttempts: 5,
  }));
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store: {
      async deleteObject() {
        throw new Error("failed");
      },
    },
    randomUUID: () => "lease-id",
  });
  const result = await worker.runOnce();
  assert.equal(result.status, "dead_letter");
});

test("verify-delete succeeds only for a provider 404", async () => {
  const database = persistence(operation({ operation: "verify_delete" }));
  const worker = new StorageReconciliationWorker({
    persistence: database,
    store: {
      async headObject() {
        const error = new Error("not found");
        error.name = "NotFound";
        throw error;
      },
    },
    randomUUID: () => "lease-id",
  });
  assert.equal((await worker.runOnce()).completed, true);
});
