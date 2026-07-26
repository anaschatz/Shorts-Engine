const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MultipartUploadService,
  parseHttpRange,
} = require("../server/storage/multipart-upload-service.cjs");

function deterministicUuid() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

function deterministicBytes(length) {
  return Buffer.alloc(length, 7);
}

function fakePersistence() {
  const calls = [];
  let session = null;
  let delivery = null;
  return {
    calls,
    async createMultipartUploadSession(record) {
      calls.push({ method: "createMultipartUploadSession", record });
      session = {
        id: record.sessionId,
        ownerId: record.ownerId,
        uploadId: record.uploadId,
        artifactId: record.artifactId,
        projectId: record.projectId,
        providerUploadId: null,
        status: "created",
        partSizeBytes: record.partSizeBytes,
        expectedParts: record.expectedParts,
        expectedByteSize: record.expectedByteSize,
        expectedChecksumSha256: record.expectedChecksumSha256,
        storageKey: record.storageKey,
        contentType: record.contentType,
        expiresAt: record.expiresAt,
      };
      return { ...session };
    },
    async attachMultipartUpload(record) {
      calls.push({ method: "attachMultipartUpload", record });
      if (!session || session.ownerId !== record.ownerId) return null;
      session.providerUploadId = record.providerUploadId;
      session.status = "uploading";
      return { ...session };
    },
    async getMultipartUploadOwnedBy(uploadId, ownerId) {
      calls.push({
        method: "getMultipartUploadOwnedBy",
        record: { uploadId, ownerId },
      });
      return session && session.uploadId === uploadId && session.ownerId === ownerId
        ? { ...session }
        : null;
    },
    async markMultipartUploadComplete(record) {
      calls.push({ method: "markMultipartUploadComplete", record });
      if (!session || session.uploadId !== record.uploadId) return null;
      session.status = "completed";
      return { ...session };
    },
    async failMultipartUpload(record) {
      calls.push({ method: "failMultipartUpload", record });
      if (session) session.status = "failed";
      return true;
    },
    async createDeliveryGrant(record) {
      calls.push({ method: "createDeliveryGrant", record });
      if (record.artifactId !== "art_export") return null;
      delivery = {
        ownerId: record.ownerId,
        tokenHash: record.tokenHash,
      };
      return {
        id: record.id,
        artifactId: record.artifactId,
        purpose: record.purpose,
        expiresAt: record.expiresAt,
      };
    },
    async resolveDeliveryGrant(record) {
      calls.push({ method: "resolveDeliveryGrant", record });
      if (
        !delivery
        || delivery.ownerId !== record.ownerId
        || delivery.tokenHash !== record.tokenHash
      ) {
        return null;
      }
      return {
        id: "dgr_test",
        purpose: "export",
        expiresAt: "2026-07-26T12:05:00.000Z",
        artifact: {
          id: "art_export",
          storageKey: "export/scope/art_export/object.mp4",
          contentType: "video/mp4",
          byteSize: 1000,
          checksumSha256: "a".repeat(64),
        },
      };
    },
  };
}

function fakeStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    partSizeBytes: 5 * 1024 * 1024,
    async createMultipartUpload(record) {
      calls.push({ method: "createMultipartUpload", record });
      return { uploadId: "provider-upload-id" };
    },
    async presignUploadPart(record) {
      calls.push({ method: "presignUploadPart", record });
      if (overrides.presignFailure && record.partNumber === overrides.presignFailure) {
        throw new Error("sensitive provider failure");
      }
      return {
        partNumber: record.partNumber,
        url: `https://upload.example.test/part-${record.partNumber}?signature=opaque`,
        expiresAt: "2026-07-26T12:10:00.000Z",
      };
    },
    async abortMultipartUpload(record) {
      calls.push({ method: "abortMultipartUpload", record });
      return true;
    },
    async completeMultipartUpload(record) {
      calls.push({ method: "completeMultipartUpload", record });
      return { partCount: record.parts.length };
    },
    async headObject(storageKey) {
      calls.push({ method: "headObject", record: { storageKey } });
      return {
        byteSize: overrides.headByteSize ?? 6 * 1024 * 1024,
        contentType: "video/mp4",
        etag: "\"etag\"",
        lastModified: "2026-07-26T12:00:00.000Z",
        metadata: {},
      };
    },
    async getObjectStream(storageKey, options) {
      calls.push({ method: "getObjectStream", record: { storageKey, options } });
      return {
        body: { stream: true },
        contentLength: options.range.end - options.range.start + 1,
        contentRange: `bytes ${options.range.start}-${options.range.end}/1000`,
        contentType: "video/mp4",
      };
    },
  };
}

function service(options = {}) {
  return new MultipartUploadService({
    persistence: options.persistence || fakePersistence(),
    store: options.store || fakeStore(),
    clock: { now: () => Date.parse("2026-07-26T12:00:00.000Z") },
    randomBytes: deterministicBytes,
    randomUUID: deterministicUuid(),
    partSizeBytes: 5 * 1024 * 1024,
  });
}

test("multipart upload creates owner-scoped staging records before presigning R2 parts", async () => {
  const persistence = fakePersistence();
  const store = fakeStore();
  const uploadService = service({ persistence, store });
  const created = await uploadService.createUpload({
    ownerId: "usr_test",
    contentType: "video/mp4",
    filename: "../../private match.mp4",
    byteSize: 6 * 1024 * 1024,
    rightsConfirmed: true,
    title: "Test match",
  });
  assert.equal(created.project.status, "uploading");
  assert.equal(created.upload.status, "uploading");
  assert.equal(created.multipart.expectedParts, 2);
  assert.equal(created.multipart.parts.length, 2);
  assert.match(created.multipart.parts[0].url, /^https:\/\/upload\.example\.test\/part-1/);
  assert.doesNotMatch(JSON.stringify(created), /storageKey|provider-upload-id|private match|usr_test/);

  const databaseCreate = persistence.calls[0].record;
  assert.equal(databaseCreate.ownerId, "usr_test");
  assert.equal(databaseCreate.originalFilename, "private match.mp4");
  assert.match(
    databaseCreate.storageKey,
    /^source\/[a-f0-9]{24}\/art_[A-Za-z0-9-]+\/object\.mp4$/,
  );
  assert.deepEqual(
    persistence.calls.map((call) => call.method),
    ["createMultipartUploadSession", "attachMultipartUpload"],
  );
  assert.deepEqual(
    store.calls.map((call) => call.method),
    ["createMultipartUpload", "presignUploadPart", "presignUploadPart"],
  );
});

test("multipart upload rejects missing rights and unsupported media before mutations", async () => {
  const persistence = fakePersistence();
  const store = fakeStore();
  const uploadService = service({ persistence, store });
  await assert.rejects(
    uploadService.createUpload({
      ownerId: "usr_test",
      contentType: "video/mp4",
      byteSize: 100,
      rightsConfirmed: false,
    }),
    (error) => error.code === "FOOTBALL_REVIEW_RIGHTS_REQUIRED",
  );
  await assert.rejects(
    uploadService.createUpload({
      ownerId: "usr_test",
      contentType: "application/octet-stream",
      byteSize: 100,
      rightsConfirmed: true,
    }),
    (error) => error.code === "FILE_TYPE_UNSUPPORTED",
  );
  assert.equal(persistence.calls.length, 0);
  assert.equal(store.calls.length, 0);
});

test("presigning failure aborts provider upload and durably schedules cleanup", async () => {
  const persistence = fakePersistence();
  const store = fakeStore({ presignFailure: 2 });
  const uploadService = service({ persistence, store });
  await assert.rejects(
    uploadService.createUpload({
      ownerId: "usr_test",
      contentType: "video/mp4",
      byteSize: 6 * 1024 * 1024,
      rightsConfirmed: true,
    }),
    (error) => {
      assert.equal(error.code, "CLOUD_STORAGE_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /sensitive provider/i);
      return true;
    },
  );
  assert.equal(
    store.calls.some((call) => call.method === "abortMultipartUpload"),
    true,
  );
  const failure = persistence.calls.find((call) => call.method === "failMultipartUpload");
  assert.equal(failure.record.operation, "abort_multipart");
});

test("completed upload verifies exact object size before entering validation", async () => {
  const persistence = fakePersistence();
  const store = fakeStore();
  const uploadService = service({ persistence, store });
  const created = await uploadService.createUpload({
    ownerId: "usr_test",
    contentType: "video/mp4",
    byteSize: 6 * 1024 * 1024,
    rightsConfirmed: true,
  });
  const completed = await uploadService.completeUpload({
    ownerId: "usr_test",
    uploadId: created.upload.id,
    parts: [
      { partNumber: 1, etag: "etag-one" },
      { partNumber: 2, etag: "etag-two" },
    ],
  });
  assert.equal(completed.upload.status, "validating");
  assert.equal(completed.validation.jobType, "validate_upload");
  assert.equal(
    persistence.calls.some((call) => call.method === "markMultipartUploadComplete"),
    true,
  );
});

test("completed object size mismatch fails upload and queues object deletion", async () => {
  const persistence = fakePersistence();
  const store = fakeStore({ headByteSize: 1 });
  const uploadService = service({ persistence, store });
  const created = await uploadService.createUpload({
    ownerId: "usr_test",
    contentType: "video/mp4",
    byteSize: 6 * 1024 * 1024,
    rightsConfirmed: true,
  });
  await assert.rejects(
    uploadService.completeUpload({
      ownerId: "usr_test",
      uploadId: created.upload.id,
      parts: [
        { partNumber: 1, etag: "etag-one" },
        { partNumber: 2, etag: "etag-two" },
      ],
    }),
    (error) => error.code === "FILE_SIGNATURE_MISMATCH",
  );
  const failure = persistence.calls.findLast(
    (call) => call.method === "failMultipartUpload",
  );
  assert.equal(failure.record.operation, "delete_object");
});

test("delivery grants are opaque, owner-bound, short-lived and app-proxied with ranges", async () => {
  const persistence = fakePersistence();
  const store = fakeStore();
  const uploadService = service({ persistence, store });
  const grant = await uploadService.issueDeliveryGrant({
    ownerId: "usr_test",
    artifactId: "art_export",
    purpose: "export",
  });
  assert.match(grant.url, /^\/api\/delivery\//);
  assert.doesNotMatch(grant.url, /r2|cloudflare|storage|art_export/i);
  assert.equal(grant.expiresAt, "2026-07-26T12:05:00.000Z");
  const persistedGrant = persistence.calls[0].record;
  assert.notEqual(persistedGrant.tokenHash, grant.token);
  assert.doesNotMatch(JSON.stringify(persistedGrant), new RegExp(grant.token));

  const opened = await uploadService.openDelivery({
    ownerId: "usr_test",
    token: grant.token,
    rangeHeader: "bytes=100-199",
  });
  assert.equal(opened.status, 206);
  assert.equal(opened.headers["content-range"], "bytes 100-199/1000");
  assert.equal(opened.headers["content-length"], "100");
  assert.equal(opened.headers["cache-control"], "private, no-store");
  assert.deepEqual(opened.body, { stream: true });
  const objectRead = store.calls.at(-1);
  assert.deepEqual(objectRead.record.options.range, { start: 100, end: 199 });

  await assert.rejects(
    uploadService.openDelivery({
      ownerId: "usr_other",
      token: grant.token,
    }),
    (error) => error.code === "ARTIFACT_TOKEN_INVALID" && error.status === 404,
  );
});

test("HTTP Range parsing handles full, open and suffix ranges safely", () => {
  assert.deepEqual(parseHttpRange("", 1000), {
    range: null,
    status: 200,
    contentLength: 1000,
    contentRange: null,
  });
  assert.deepEqual(parseHttpRange("bytes=900-", 1000), {
    range: { start: 900, end: 999 },
    status: 206,
    contentLength: 100,
    contentRange: "bytes 900-999/1000",
  });
  assert.deepEqual(parseHttpRange("bytes=-50", 1000), {
    range: { start: 950, end: 999 },
    status: 206,
    contentLength: 50,
    contentRange: "bytes 950-999/1000",
  });
  for (const unsafe of ["bytes=100-99", "bytes=0-1,2-3", "items=0-1"]) {
    assert.throws(
      () => parseHttpRange(unsafe, 1000),
      (error) => error.status === 416,
    );
  }
});
