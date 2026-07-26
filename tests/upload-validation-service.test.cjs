const assert = require("node:assert/strict");
const test = require("node:test");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");

const {
  UploadValidationService,
} = require("../server/storage/upload-validation-service.cjs");

function mp4Bytes() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftyp", "ascii"),
    Buffer.from("isom", "ascii"),
    Buffer.alloc(256, 9),
  ]);
}

function persistenceFor(buffer, overrides = {}) {
  const calls = [];
  const checksum = createHash("sha256").update(buffer).digest("hex");
  return {
    calls,
    async getMultipartUploadOwnedBy(uploadId, ownerId) {
      calls.push({
        method: "getMultipartUploadOwnedBy",
        record: { uploadId, ownerId },
      });
      if (ownerId !== "usr_test" || uploadId !== "upl_test") return null;
      return {
        id: "ups_test",
        ownerId,
        uploadId,
        artifactId: "art_test",
        projectId: "prj_test",
        providerUploadId: "provider-upload-id",
        status: overrides.status || "completed",
        partSizeBytes: 5 * 1024 * 1024,
        expectedParts: 1,
        expectedByteSize: overrides.expectedByteSize ?? buffer.length,
        expectedChecksumSha256: overrides.expectedChecksumSha256 ?? checksum,
        storageKey: "source/scope/art_test/object.mp4",
        contentType: "video/mp4",
      };
    },
    async publishValidatedUpload(record) {
      calls.push({ method: "publishValidatedUpload", record });
      return overrides.publishResult !== false;
    },
    async failMultipartUpload(record) {
      calls.push({ method: "failMultipartUpload", record });
      return true;
    },
  };
}

function storeFor(buffer, overrides = {}) {
  const calls = [];
  return {
    calls,
    async getObjectStream(storageKey, options) {
      calls.push({ method: "getObjectStream", record: { storageKey, options } });
      if (overrides.error) throw overrides.error;
      return {
        body: Readable.from([
          buffer.subarray(0, 17),
          buffer.subarray(17),
        ]),
        contentLength: buffer.length,
        contentType: "video/mp4",
      };
    },
  };
}

function stagingRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "shorts-validation-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("upload validation streams SHA-256, checks signature, probes media and publishes", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const store = storeFor(buffer);
  const root = stagingRoot(t);
  let probedPath = null;
  const service = new UploadValidationService({
    persistence,
    store,
    stagingRoot: root,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    async probeMedia(path) {
      probedPath = path;
      assert.equal(existsSync(path), true);
      return {
        durationSeconds: 45,
        width: 1920,
        height: 1080,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      };
    },
  });
  const result = await service.validateUpload({
    ownerId: "usr_test",
    uploadId: "upl_test",
  });
  assert.equal(result.status, "available");
  assert.equal(result.byteSize, buffer.length);
  assert.equal(result.checksumSha256, createHash("sha256").update(buffer).digest("hex"));
  assert.equal(existsSync(probedPath), false);
  const published = persistence.calls.find(
    (call) => call.method === "publishValidatedUpload",
  );
  assert.deepEqual(published.record.metadata, {
    container: "mp4",
    durationSeconds: 45,
    width: 1920,
    height: 1080,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
  });
  assert.equal(
    persistence.calls.some((call) => call.method === "failMultipartUpload"),
    false,
  );
});

test("upload validation checksum mismatch fails safely and queues object deletion", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer, {
    expectedChecksumSha256: "0".repeat(64),
  });
  const store = storeFor(buffer);
  const service = new UploadValidationService({
    persistence,
    store,
    stagingRoot: stagingRoot(t),
    randomUUID: () => "00000000-0000-4000-8000-000000000002",
    async probeMedia() {
      throw new Error("probe should not execute");
    },
  });
  await assert.rejects(
    service.validateUpload({
      ownerId: "usr_test",
      uploadId: "upl_test",
    }),
    (error) => error.code === "FILE_SIGNATURE_MISMATCH",
  );
  const failure = persistence.calls.find(
    (call) => call.method === "failMultipartUpload",
  );
  assert.equal(failure.record.operation, "delete_object");
  assert.equal(failure.record.errorCode, "FILE_SIGNATURE_MISMATCH");
});

test("production validation atomically publishes and enqueues idempotent analysis", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const transaction = { query() {} };
  persistence.withTransaction = async (callback) => await callback(transaction);
  persistence.publishValidatedUploadInTransaction = async (received, record) => {
    assert.equal(received, transaction);
    persistence.calls.push({
      method: "publishValidatedUploadInTransaction",
      record,
    });
    return true;
  };
  const queueCalls = [];
  const jobQueue = {
    async enqueueInTransaction(received, record, options) {
      assert.equal(received, transaction);
      queueCalls.push({ record, options });
      return {
        job: { id: "job_analysis123" },
        replayed: false,
      };
    },
  };
  const service = new UploadValidationService({
    persistence,
    store: storeFor(buffer),
    jobQueue,
    stagingRoot: stagingRoot(t),
    randomUUID: () => "00000000-0000-4000-8000-000000000004",
    async probeMedia() {
      return {
        durationSeconds: 45,
        width: 1920,
        height: 1080,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      };
    },
  });
  const result = await service.validateUpload({
    ownerId: "usr_test",
    uploadId: "upl_test",
  });
  assert.equal(result.analysisJobId, "job_analysis123");
  assert.equal(queueCalls[0].record.action, "analyze_football");
  assert.equal(queueCalls[0].record.projectId, "prj_test");
  assert.equal(
    queueCalls[0].options.idempotencyKey,
    "analyze-football-upl_test",
  );
});

test("transient publish failures preserve staged source for a worker retry", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const transaction = { query() {} };
  persistence.withTransaction = async (callback) => await callback(transaction);
  persistence.publishValidatedUploadInTransaction = async () => {
    throw new Error("private database diagnostic");
  };
  const service = new UploadValidationService({
    persistence,
    store: storeFor(buffer),
    jobQueue: {
      async enqueueInTransaction() {
        throw new Error("must not enqueue");
      },
    },
    stagingRoot: stagingRoot(t),
    async probeMedia() {
      return {
        durationSeconds: 45,
        width: 1920,
        height: 1080,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      };
    },
  });
  await assert.rejects(
    service.validateUpload({
      ownerId: "usr_test",
      uploadId: "upl_test",
    }),
    (error) => {
      assert.equal(error.code, "CLOUD_STORAGE_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /private database diagnostic/);
      return true;
    },
  );
  assert.equal(
    persistence.calls.some((call) => call.method === "failMultipartUpload"),
    false,
  );
});

test("upload validation rejects cross-owner lookup exactly like a missing upload", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const store = storeFor(buffer);
  const service = new UploadValidationService({
    persistence,
    store,
    stagingRoot: stagingRoot(t),
  });
  await assert.rejects(
    service.validateUpload({
      ownerId: "usr_other",
      uploadId: "upl_test",
    }),
    (error) => error.code === "UPLOAD_NOT_FOUND" && error.status === 404,
  );
  assert.equal(store.calls.length, 0);
});

test("upload validation cancellation is terminal, safe and cleans staging", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const store = storeFor(buffer);
  const root = stagingRoot(t);
  const controller = new AbortController();
  controller.abort();
  const service = new UploadValidationService({
    persistence,
    store,
    stagingRoot: root,
  });
  await assert.rejects(
    service.validateUpload({
      ownerId: "usr_test",
      uploadId: "upl_test",
      signal: controller.signal,
    }),
    (error) => error.code === "JOB_CANCELLED",
  );
  assert.equal(persistence.calls.length, 0);
  assert.equal(store.calls.length, 0);
});

test("raw R2 stream failures never escape provider details", async (t) => {
  const buffer = mp4Bytes();
  const persistence = persistenceFor(buffer);
  const store = storeFor(buffer, {
    error: new Error(
      "https://account.r2.cloudflarestorage.com secret-key source/private",
    ),
  });
  const service = new UploadValidationService({
    persistence,
    store,
    stagingRoot: stagingRoot(t),
    randomUUID: () => "00000000-0000-4000-8000-000000000003",
  });
  await assert.rejects(
    service.validateUpload({
      ownerId: "usr_test",
      uploadId: "upl_test",
    }),
    (error) => {
      assert.equal(error.code, "CLOUD_STORAGE_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /secret-key|cloudflarestorage|source\/private/i);
      return true;
    },
  );
  assert.equal(
    persistence.calls.some((call) => call.method === "failMultipartUpload"),
    false,
  );
});
