const assert = require("node:assert/strict");
const test = require("node:test");

const {
  R2ArtifactStore,
  artifactStorageKey,
  normalizeCompletedParts,
  rangeHeader,
  validateStorageKey,
} = require("../server/storage/r2-artifact-store.cjs");

function command(name) {
  return class {
    constructor(input) {
      this.name = name;
      this.input = input;
    }
  };
}

function fakeSdk() {
  return {
    AbortMultipartUploadCommand: command("AbortMultipartUpload"),
    CompleteMultipartUploadCommand: command("CompleteMultipartUpload"),
    CreateMultipartUploadCommand: command("CreateMultipartUpload"),
    DeleteObjectCommand: command("DeleteObject"),
    GetObjectCommand: command("GetObject"),
    HeadBucketCommand: command("HeadBucket"),
    HeadObjectCommand: command("HeadObject"),
    PutObjectCommand: command("PutObject"),
    S3Client: class {},
    UploadPartCommand: command("UploadPart"),
  };
}

function storageConfig() {
  return {
    bucket: "shortsengine-test",
    region: "auto",
    endpoint: "https://account.r2.cloudflarestorage.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    partSizeBytes: 5 * 1024 * 1024,
    presignTtlSeconds: 120,
  };
}

function fakeClient(responses = {}) {
  const commands = [];
  let destroyed = false;
  return {
    commands,
    get destroyed() {
      return destroyed;
    },
    async send(instance, options) {
      commands.push({ instance, options });
      const response = responses[instance.name];
      if (response instanceof Error) throw response;
      if (typeof response === "function") return await response(instance.input, options);
      return response || {};
    },
    destroy() {
      destroyed = true;
    },
  };
}

test("R2 storage keys are server-generated, owner-scoped and filename-free", () => {
  const first = artifactStorageKey({
    ownerId: "usr_one",
    artifactId: "art_123456",
    purpose: "source",
    extension: ".mp4",
  });
  const second = artifactStorageKey({
    ownerId: "usr_two",
    artifactId: "art_123456",
    purpose: "source",
    extension: "mp4",
  });
  assert.match(first, /^source\/[a-f0-9]{24}\/art_123456\/object\.mp4$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /usr_one|original|filename/i);
  assert.equal(validateStorageKey(first), first);
  for (const unsafe of [
    "../private",
    "/absolute/key",
    "source//object.mp4",
    "source\\object.mp4",
    "source/./object.mp4",
  ]) {
    assert.throws(
      () => validateStorageKey(unsafe),
      (error) => error.code === "ARTIFACT_KEY_INVALID",
    );
  }
});

test("completed multipart parts must be contiguous, unique and bounded", () => {
  assert.deepEqual(
    normalizeCompletedParts([
      { partNumber: 2, etag: "\"etag-two\"" },
      { partNumber: 1, etag: "\"etag-one\"" },
    ], 2),
    [
      { PartNumber: 1, ETag: "\"etag-one\"" },
      { PartNumber: 2, ETag: "\"etag-two\"" },
    ],
  );
  assert.throws(
    () => normalizeCompletedParts([{ partNumber: 2, etag: "etag" }]),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => normalizeCompletedParts([
      { partNumber: 1, etag: "same" },
      { partNumber: 1, etag: "same" },
    ]),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => normalizeCompletedParts([{ partNumber: 1, etag: "bad\netag" }]),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("R2 multipart flow uses official command objects and only presigns upload parts", async () => {
  const sdk = fakeSdk();
  const client = fakeClient({
    CreateMultipartUpload: { UploadId: "provider-upload-id" },
    CompleteMultipartUpload: {},
    HeadObject: {
      ContentLength: 10_000_000,
      ContentType: "video/mp4",
      ETag: "\"object-etag\"",
      LastModified: new Date("2026-07-26T12:00:00.000Z"),
    },
  });
  const presigned = [];
  const store = new R2ArtifactStore({
    config: storageConfig(),
    sdk,
    client,
    clock: { now: () => Date.parse("2026-07-26T12:00:00.000Z") },
    async getSignedUrl(presignClient, uploadPart, options) {
      assert.equal(presignClient, client);
      assert.equal(uploadPart.name, "UploadPart");
      presigned.push({ uploadPart, options });
      return "https://upload.example.test/opaque-signed-part";
    },
  });
  const key = artifactStorageKey({
    ownerId: "usr_test",
    artifactId: "art_test",
    purpose: "source",
    extension: "mp4",
  });
  const created = await store.createMultipartUpload({
    storageKey: key,
    contentType: "video/mp4",
    artifactId: "art_test",
  });
  assert.equal(created.uploadId, "provider-upload-id");
  const part = await store.presignUploadPart({
    storageKey: key,
    uploadId: created.uploadId,
    partNumber: 1,
  });
  assert.deepEqual(part, {
    partNumber: 1,
    url: "https://upload.example.test/opaque-signed-part",
    expiresAt: "2026-07-26T12:02:00.000Z",
  });
  assert.equal(presigned[0].options.expiresIn, 120);
  assert.deepEqual(presigned[0].uploadPart.input, {
    Bucket: "shortsengine-test",
    Key: key,
    UploadId: "provider-upload-id",
    PartNumber: 1,
  });

  const completed = await store.completeMultipartUpload({
    storageKey: key,
    uploadId: created.uploadId,
    parts: [
      { partNumber: 1, etag: "etag-one" },
      { partNumber: 2, etag: "etag-two" },
    ],
    expectedParts: 2,
  });
  assert.deepEqual(completed, { partCount: 2 });
  const head = await store.headObject(key);
  assert.deepEqual(head, {
    byteSize: 10_000_000,
    contentType: "video/mp4",
    etag: "\"object-etag\"",
    lastModified: "2026-07-26T12:00:00.000Z",
    metadata: {},
  });
  assert.deepEqual(
    client.commands.map(({ instance }) => instance.name),
    ["CreateMultipartUpload", "CompleteMultipartUpload", "HeadObject"],
  );
  assert.equal(client.commands.some(({ instance }) => /Presign|Download/.test(instance.name)), false);
});

test("R2 reads support bounded HTTP ranges and never return a download URL", async () => {
  const sdk = fakeSdk();
  const body = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("bytes");
    },
  };
  const client = fakeClient({
    GetObject: {
      Body: body,
      ContentLength: 100,
      ContentRange: "bytes 100-199/1000",
      ContentType: "video/mp4",
      ETag: "\"etag\"",
    },
  });
  const store = new R2ArtifactStore({
    config: storageConfig(),
    sdk,
    client,
    getSignedUrl: async () => {
      throw new Error("downloads must never be presigned");
    },
  });
  const response = await store.getObjectStream("export/scope/artifact/object.mp4", {
    range: { start: 100, end: 199 },
  });
  assert.equal(response.body, body);
  assert.equal(response.contentRange, "bytes 100-199/1000");
  assert.equal(response.contentLength, 100);
  assert.deepEqual(client.commands[0].instance.input, {
    Bucket: "shortsengine-test",
    Key: "export/scope/artifact/object.mp4",
    Range: "bytes=100-199",
  });
  assert.equal(rangeHeader({ start: 0 }), "bytes=0-");
  assert.throws(
    () => rangeHeader({ start: 10, end: 9 }),
    (error) => error.status === 416,
  );
});

test("R2 provider failures are reduced to safe bounded errors and readiness", async () => {
  const sdk = fakeSdk();
  const sensitive = new Error(
    "https://account.r2.cloudflarestorage.com secret-access-key private-object",
  );
  const client = fakeClient({
    HeadBucket: sensitive,
    AbortMultipartUpload: sensitive,
  });
  const store = new R2ArtifactStore({
    config: storageConfig(),
    sdk,
    client,
    getSignedUrl: async () => "unused",
  });
  assert.deepEqual(await store.health(), {
    ready: false,
    mode: "r2",
    async: true,
    multipart: true,
    directUpload: true,
    appProxiedDelivery: true,
  });
  await assert.rejects(
    store.abortMultipartUpload({
      storageKey: "source/scope/artifact/object.mp4",
      uploadId: "provider-upload-id",
    }),
    (error) => {
      assert.equal(error.code, "CLOUD_STORAGE_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /secret-access|private-object|cloudflarestorage/i);
      return true;
    },
  );
  assert.equal(await store.close(), true);
  assert.equal(client.destroyed, true);
});
