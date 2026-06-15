const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");

const { validateArtifactAdapter } = require("../server/adapters/artifact-adapter.cjs");
const { createArtifactAdapterFromConfig, publicStorageConfig } = require("../server/adapters/object-storage-adapter.cjs");
const { S3CompatibleArtifactAdapter } = require("../server/adapters/s3-artifact-adapter.cjs");
const { validateStorageConfig } = require("../server/config.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { runRenderJob } = require("../server/render-job.cjs");
const { InMemoryExportRepository } = require("../server/repositories/export-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function uniqueKey(prefix, extension = "mp4") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
}

function storageConfig(overrides = {}) {
  return validateStorageConfig({
    adapter: "s3",
    bucket: "matchcuts-prod-private",
    region: "us-east-1",
    accessKeyId: "AKIATESTKEY123456",
    secretAccessKey: "test-secret-key-value",
    signedUrlTtlSeconds: 300,
    ...overrides,
  });
}

class MockS3Client {
  constructor() {
    this.objects = new Map();
    this.multipartUploads = new Map();
    this.calls = [];
    this.failNext = null;
  }

  failOnce(method, error = new Error("raw provider /Users/example AKIATESTKEY123456 secret")) {
    this.failNext = { method, error };
  }

  maybeFail(method) {
    this.calls.push(method);
    if (this.failNext && this.failNext.method === method) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  headObject(key) {
    this.maybeFail("HEAD");
    const object = this.objects.get(key);
    if (!object) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    return {
      statusCode: 200,
      headers: {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
      },
      body: Buffer.alloc(0),
    };
  }

  getObject(key) {
    this.maybeFail("GET");
    const object = this.objects.get(key);
    if (!object) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    return {
      statusCode: 200,
      headers: {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
      },
      body: Buffer.from(object.body),
    };
  }

  putObject(key, options = {}) {
    this.maybeFail("PUT");
    this.objects.set(key, {
      body: Buffer.from(options.body || Buffer.alloc(0)),
      contentType: options.contentType || "application/octet-stream",
    });
    return { statusCode: 200, headers: { etag: `"${key}"` }, body: Buffer.alloc(0) };
  }

  deleteObject(key) {
    this.maybeFail("DELETE");
    this.objects.delete(key);
    return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
  }

  downloadObjectToFile(key, filePath) {
    this.maybeFail("DOWNLOAD_FILE");
    const object = this.objects.get(key);
    if (!object) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    writeFileSync(filePath, object.body);
    return {
      statusCode: 200,
      headers: {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
      },
      bytes: object.body.length,
    };
  }

  uploadFileFromPath(key, filePath, options = {}) {
    this.maybeFail("PUT");
    const body = readFileSync(filePath);
    this.objects.set(key, {
      body,
      contentType: options.contentType || "application/octet-stream",
    });
    return { statusCode: 200, headers: { etag: `"${key}"` }, bytes: body.length, body: Buffer.alloc(0) };
  }

  createMultipartUpload(key, options = {}) {
    this.maybeFail("CREATE_MULTIPART");
    const uploadId = `upload-${this.multipartUploads.size + 1}`;
    this.multipartUploads.set(uploadId, {
      aborted: false,
      completed: false,
      contentType: options.contentType || "application/octet-stream",
      key,
      parts: new Map(),
    });
    return { statusCode: 200, headers: {}, body: Buffer.alloc(0), uploadId };
  }

  uploadPart(key, options = {}) {
    this.maybeFail("UPLOAD_PART");
    const upload = this.multipartUploads.get(options.uploadId);
    if (!upload || upload.key !== key || upload.aborted) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    upload.parts.set(options.partNumber, Buffer.from(options.body || Buffer.alloc(0)));
    return { statusCode: 200, headers: { etag: `"part-${options.partNumber}"` }, body: Buffer.alloc(0) };
  }

  completeMultipartUpload(key, options = {}) {
    this.maybeFail("COMPLETE_MULTIPART");
    const upload = this.multipartUploads.get(options.uploadId);
    if (!upload || upload.key !== key || upload.aborted) return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
    const ordered = [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, body]) => body);
    this.objects.set(key, {
      body: Buffer.concat(ordered),
      contentType: upload.contentType,
    });
    upload.completed = true;
    return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  }

  abortMultipartUpload(key, options = {}) {
    this.maybeFail("ABORT_MULTIPART");
    const upload = this.multipartUploads.get(options.uploadId);
    if (upload && upload.key === key) upload.aborted = true;
    return { statusCode: 204, headers: {}, body: Buffer.alloc(0) };
  }
}

function makeAdapter(options = {}) {
  const client = options.client || new MockS3Client();
  const adapter = new S3CompatibleArtifactAdapter({
    client,
    config: storageConfig(options.config),
    mode: options.mode || "s3",
    tokenTtlSeconds: 300,
  });
  return { adapter, client };
}

function validTranscript() {
  return {
    provider: "mock",
    language: "en",
    text: "A huge goal in stoppage time",
    captions: [
      { start: 0, end: 2, text: "A huge goal" },
      { start: 2.2, end: 4.2, text: "Stoppage time scenes" },
    ],
    segments: [{ start: 0, end: 2, text: "A huge goal" }],
  };
}

function validMoment() {
  return {
    id: "mom_s3_1",
    rank: 1,
    start: 0,
    end: 8,
    center: 4,
    title: "Stoppage time goal",
    summary: "A huge goal",
    reasonCodes: ["goal_like_phrase", "crowd_reaction"],
    confidence: 0.91,
    retentionScore: 92,
    suggestedPreset: "hype",
    hook: "ΤΟ ΓΚΟΛ ΣΤΙΣ ΚΑΘΥΣΤΕΡΗΣΕΙΣ",
    captionBeats: [
      { start: 0, end: 2, text: "A huge goal" },
      { start: 2.2, end: 4.2, text: "Stoppage time scenes" },
    ],
  };
}

function validPlan() {
  return {
    sourceStart: 0,
    sourceEnd: 8,
    aspectRatio: "9:16",
    hook: "ΤΟ ΓΚΟΛ ΣΤΙΣ ΚΑΘΥΣΤΕΡΗΣΕΙΣ",
    title: "S3 Derby",
    captions: [
      { start: 0, end: 2, text: "A huge goal" },
      { start: 2.2, end: 4.2, text: "Stoppage time scenes" },
    ],
    effects: ["center_crop_9_16", "punch_captions"],
    export: { width: 1080, height: 1920, format: "mp4" },
  };
}

function makeRenderContext(options = {}) {
  const { adapter, client } = makeAdapter(options);
  const exportRepository = new InMemoryExportRepository({ artifactStore: adapter });
  const projectRepository = new InMemoryProjectRepository();
  const jobs = new JobStore();
  const projectId = id("prj");
  const uploadId = id("upl");
  const project = projectRepository.create({
    id: projectId,
    uploadId,
    title: "S3 Derby",
    status: "draft",
  });
  const uploadArtifact = adapter.writeArtifact({
    id: uploadId,
    type: "upload",
    ownerProjectId: projectId,
    storageKey: uniqueKey("s3-source"),
    buffer: Buffer.from("synthetic-video"),
  });
  const upload = {
    id: uploadId,
    projectId,
    artifact: uploadArtifact,
    metadata: {
      durationSeconds: 12,
      width: 1280,
      height: 720,
      hasAudio: true,
    },
  };
  const job = jobs.create({
    projectId,
    uploadId,
    action: "generate",
    idempotencyKey: `s3-render-${randomUUID()}`,
    payload: { title: "S3 Derby", preset: "hype", language: "en" },
  });
  const logs = [];
  const dependencies = {
    artifactStore: adapter,
    exportRepository,
    projectRepository,
    logger: {
      info(line) {
        logs.push(JSON.parse(line));
      },
    },
    createExportId: () => id("exp"),
    extractAudio: async () => {},
    extractMediaSignals: async () => ({
      durationSeconds: upload.metadata.durationSeconds,
      width: upload.metadata.width,
      height: upload.metadata.height,
      hasAudio: upload.metadata.hasAudio,
      audioPeaks: [{ time: 4, energyScore: 0.9 }],
      sceneChanges: [{ time: 4.2, confidence: 0.78 }],
      highMotionCandidates: [{ time: 4, confidence: 0.73 }],
    }),
    chooseTranscriptionProvider: () => ({ transcribe: async () => validTranscript() }),
    detectHighlights: () => ({ fallback: false, moments: [validMoment()] }),
    createCandidateEditPlans: () => [validPlan()],
    validateEditPlan,
    renderShort: async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from("rendered-s3-short"));
    },
    persistRenderRecord(record) {
      logs.push({ event: "persist_render_record", exportId: record.exportId });
    },
  };
  return { adapter, client, dependencies, exportRepository, job, jobs, logs, project, upload, uploadArtifact };
}

test("S3/R2 storage config validates credentials and keeps public config safe", () => {
  const config = storageConfig({
    adapter: "r2",
    region: "auto",
    endpoint: "https://account-id.r2.cloudflarestorage.com",
  });
  const safe = publicStorageConfig(config);

  assert.equal(config.adapter, "r2");
  assert.equal(config.credentialsConfigured, true);
  assert.equal(safe.credentialsConfigured, true);
  assert.doesNotMatch(JSON.stringify(safe), /matchcuts-prod-private|account-id|AKIATEST|secret/);
  assert.throws(() => validateStorageConfig({ adapter: "s3", bucket: "prod", region: "us-east-1" }), /credentials are required/);
  assert.throws(
    () => validateStorageConfig({ adapter: "local", signedUrlTtlSeconds: "soon" }),
    /signed URL TTL/,
  );
  assert.throws(
    () => validateStorageConfig({ adapter: "local", multipartThresholdBytes: 1024 }),
    /multipart threshold/,
  );
  assert.throws(
    () => validateStorageConfig({ adapter: "local", multipartThresholdBytes: 8 * 1024 * 1024, multipartPartSizeBytes: 9 * 1024 * 1024 }),
    /multipart configuration/,
  );
  assert.throws(
    () => validateStorageConfig({ adapter: "r2", bucket: "prod", accessKeyId: "key123", secretAccessKey: "secret-key" }),
    /endpoint is required/,
  );
});

test("S3 artifact adapter satisfies contract with mocked client and no path leaks", () => {
  const { adapter } = makeAdapter();
  const projectId = id("prj");
  const artifact = adapter.writeArtifact({
    id: id("exp"),
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-contract"),
    contentType: "video/mp4",
    buffer: Buffer.from("cloud-video"),
  });
  const health = adapter.health();

  assert.equal(validateArtifactAdapter(adapter), adapter);
  assert.equal(adapter.artifactExists(artifact), true);
  assert.equal(adapter.getArtifactMetadata(artifact).size, "cloud-video".length);
  assert.equal(adapter.readArtifact(artifact).toString("utf8"), "cloud-video");
  assert.equal(health.ready, true);
  assert.equal(health.mode, "s3");
  assert.equal(health.objectStorage, true);
  assert.throws(() => adapter.resolveLocalPath(artifact), (error) => error.code === "STORAGE_PATH_UNSAFE");
  assert.throws(
    () => adapter.writeArtifact({ type: "upload", storageKey: "../bad.mp4", buffer: Buffer.from("x") }),
    (error) => error.code === "ARTIFACT_KEY_INVALID",
  );
  assert.doesNotMatch(JSON.stringify(adapter.publicArtifactRecord(artifact)), /storageKey|\/Users|\/private|AKIATEST|secret/);
  assert.doesNotMatch(JSON.stringify(health), /matchcuts-prod-private|storageKey|\/Users|\/private|AKIATEST|secret/);
});

test("S3 signed delivery uses bounded opaque server-side tokens", () => {
  const { adapter } = makeAdapter();
  const ownerProjectId = id("prj");
  const ownerJobId = id("job");
  const artifact = adapter.writeArtifact({
    id: id("exp"),
    type: "export",
    ownerProjectId,
    ownerJobId,
    storageKey: uniqueKey("s3-signed"),
    buffer: Buffer.from("download"),
  });
  const signed = adapter.createSignedDownloadUrl(artifact, { ttlSeconds: 99_999 });

  assert.match(signed.url, /^\/api\/artifacts\/download\?token=adt_/);
  assert.equal(signed.ttlSeconds, 15 * 60);
  assert.equal(adapter.validateSignedDownloadToken(signed.token, {
    expectedArtifactId: artifact.id,
    expectedProjectId: ownerProjectId,
    expectedJobId: ownerJobId,
  }).id, artifact.id);
  assert.throws(
    () => adapter.validateSignedDownloadToken(signed.token, { expectedProjectId: id("prj") }),
    (error) => error.code === "ARTIFACT_TOKEN_INVALID",
  );
  assert.throws(
    () => adapter.validateSignedDownloadToken(signed.token, { expectedTypes: ["upload"] }),
    (error) => error.code === "ARTIFACT_TOKEN_INVALID",
  );
  assert.throws(
    () => adapter.validateSignedDownloadToken(signed.token, { nowMs: Date.parse(signed.expiresAt) + 1 }),
    (error) => error.code === "ARTIFACT_TOKEN_INVALID",
  );
  assert.doesNotMatch(JSON.stringify(signed), /storageKey|matchcuts-prod-private|AKIATEST|secret/);
});

test("S3 adapter stages input, commits output, and cleans only local staging files", () => {
  const { adapter, client } = makeAdapter();
  const upload = adapter.writeArtifact({
    id: id("upl"),
    type: "upload",
    ownerProjectId: id("prj"),
    storageKey: uniqueKey("s3-upload"),
    buffer: Buffer.from("video-bytes"),
  });
  const inputStage = adapter.stageInputForProcessing(upload, { step: "ffmpeg_probe" });
  const outputStage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: upload.ownerProjectId,
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-render"),
  });

  try {
    assert.equal(inputStage.permanentLocal, false);
    assert.equal(inputStage.cleanupRequired, true);
    assert.equal(readFileSync(inputStage.localPath).toString("utf8"), "video-bytes");
    assert.ok(client.calls.includes("DOWNLOAD_FILE"));
    writeFileSync(outputStage.localPath, Buffer.from("rendered-video"));
    const rendered = adapter.commitOutputStage(outputStage, { contentType: "video/mp4" });
    assert.equal(adapter.readArtifact(rendered).toString("utf8"), "rendered-video");
    assert.ok(client.calls.includes("PUT"));

    assert.equal(adapter.cleanupStage(inputStage).cleaned, true);
    assert.equal(adapter.cleanupStage(outputStage).cleaned, true);
    assert.equal(existsSync(inputStage.localPath), false);
    assert.equal(existsSync(outputStage.localPath), false);
    assert.equal(adapter.artifactExists(upload), true);
    assert.equal(adapter.artifactExists(rendered), true);
  } finally {
    adapter.cleanupStage(inputStage);
    adapter.cleanupStage(outputStage);
  }
});

test("S3 multipart upload strategy completes large staged renders with mocked client", () => {
  const { adapter, client } = makeAdapter({
    config: {
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartSizeBytes: 5 * 1024 * 1024,
    },
  });
  const stage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: id("prj"),
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-multipart"),
  });
  const body = Buffer.alloc(6 * 1024 * 1024 + 123, "m");

  try {
    writeFileSync(stage.localPath, body);
    const artifact = adapter.commitOutputStage(stage, { contentType: "video/mp4" });
    assert.equal(adapter.readArtifact(artifact).length, body.length);
    assert.ok(client.calls.includes("CREATE_MULTIPART"));
    assert.ok(client.calls.includes("UPLOAD_PART"));
    assert.ok(client.calls.includes("COMPLETE_MULTIPART"));
    assert.equal(client.calls.includes("ABORT_MULTIPART"), false);
  } finally {
    adapter.cleanupStage(stage);
  }
});

test("S3 multipart upload aborts and does not create artifacts on part failure", () => {
  const { adapter, client } = makeAdapter({
    config: {
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartSizeBytes: 5 * 1024 * 1024,
    },
  });
  const stage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: id("prj"),
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-multipart-fail"),
  });
  writeFileSync(stage.localPath, Buffer.alloc(6 * 1024 * 1024, "x"));
  client.failOnce("UPLOAD_PART");

  try {
    assert.throws(() => adapter.commitOutputStage(stage, { contentType: "video/mp4" }), (error) => error.code === "CLOUD_STORAGE_FAILED");
    assert.ok(client.calls.includes("ABORT_MULTIPART"));
    assert.equal(adapter.artifactExists(stage.artifact), false);
  } finally {
    adapter.cleanupStage(stage);
  }
});

test("S3 streaming operations fail closed when cancellation is already requested", () => {
  const { adapter } = makeAdapter();
  const controller = new AbortController();
  controller.abort();
  const artifact = adapter.writeArtifact({
    id: id("upl"),
    type: "upload",
    ownerProjectId: id("prj"),
    storageKey: uniqueKey("s3-cancelled"),
    buffer: Buffer.from("video"),
  });
  const stage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: artifact.ownerProjectId,
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-cancelled-output"),
  });

  try {
    assert.throws(
      () => adapter.streamArtifactToLocalPath(artifact, stage.localPath, { signal: controller.signal }),
      (error) => error.code === "JOB_CANCELLED",
    );
    writeFileSync(stage.localPath, Buffer.from("rendered"));
    assert.throws(
      () => adapter.streamLocalPathToArtifact(stage.localPath, stage.artifact, { signal: controller.signal }),
      (error) => error.code === "JOB_CANCELLED",
    );
  } finally {
    adapter.cleanupStage(stage);
  }
});

test("S3 lifecycle cleanup is bounded, dry-run capable and temp-only", () => {
  const { adapter } = makeAdapter();
  const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const projectId = id("prj");
  const temp = adapter.writeArtifact({
    id: `render_temp_${randomUUID()}`,
    type: "render_temp",
    ownerProjectId: projectId,
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-temp"),
    buffer: Buffer.from("temp"),
    createdAt: oldDate,
    updatedAt: oldDate,
  });
  const upload = adapter.writeArtifact({
    id: id("upl"),
    type: "upload",
    ownerProjectId: projectId,
    storageKey: uniqueKey("s3-upload-retain"),
    buffer: Buffer.from("upload"),
    createdAt: oldDate,
    updatedAt: oldDate,
  });
  const exported = adapter.writeArtifact({
    id: id("exp"),
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: id("job"),
    storageKey: uniqueKey("s3-export-retain"),
    buffer: Buffer.from("export"),
    createdAt: oldDate,
    updatedAt: oldDate,
  });
  const records = [
    { ...temp, updatedAt: oldDate },
    { ...upload, updatedAt: oldDate },
    { ...exported, updatedAt: oldDate },
  ];

  const dryRun = adapter.cleanupArtifactsByPolicy(records, { dryRun: true, maxAgeSeconds: 60, maxArtifacts: 10 });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.eligible, 1);
  assert.equal(dryRun.deleted, 0);
  assert.equal(adapter.artifactExists(temp), true);

  const cleanup = adapter.cleanupArtifactsByPolicy(records, { dryRun: false, maxAgeSeconds: 60, maxArtifacts: 10 });
  assert.equal(cleanup.dryRun, false);
  assert.equal(cleanup.deleted, 1);
  assert.equal(adapter.artifactExists(temp), false);
  assert.equal(adapter.artifactExists(upload), true);
  assert.equal(adapter.artifactExists(exported), true);
});

test("render orchestration completes through S3-compatible staging and cloud commit", async () => {
  const context = makeRenderContext();

  await runRenderJob({
    jobs: context.jobs,
    exportRepository: context.exportRepository,
    projectRepository: new InMemoryProjectRepository(),
    job: context.job,
    project: context.project,
    upload: context.upload,
    payload: { title: "S3 Derby", preset: "hype", language: "en" },
    requestId: "req_s3_render_test",
    dependencies: context.dependencies,
  });

  const exportRecord = context.exportRepository.get(context.job.exportId);
  assert.equal(context.job.status, "completed");
  assert.equal(context.project.status, "ready");
  assert.equal(context.job.outputPath, null);
  assert.equal(exportRecord.outputPath, null);
  assert.equal(context.adapter.readArtifact(exportRecord.artifact).toString("utf8"), "rendered-s3-short");
  assert.ok(context.client.calls.includes("PUT"));
  assert.doesNotMatch(JSON.stringify(context.exportRepository.publicExport(exportRecord)), /storageKey|outputPath|\/Users|\/private/);
  assert.doesNotMatch(JSON.stringify(context.logs), /storageKey|outputPath|AKIATEST|secret|\/Users|\/private/);
});

test("S3 cloud provider failures become safe structured job errors", async () => {
  const context = makeRenderContext();
  context.client.failOnce("PUT");

  await runRenderJob({
    jobs: context.jobs,
    exportRepository: context.exportRepository,
    projectRepository: new InMemoryProjectRepository(),
    job: context.job,
    project: context.project,
    upload: context.upload,
    payload: { title: "S3 Derby", preset: "hype", language: "en" },
    requestId: "req_s3_failure_test",
    dependencies: context.dependencies,
  });

  assert.equal(context.job.status, "failed");
  assert.equal(context.job.error.code, "CLOUD_STORAGE_FAILED");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportRepository.all().length, 0);
  assert.doesNotMatch(JSON.stringify(context.job.error), /AKIATEST|secret|\/Users|storageKey/);
});

test("factory creates S3 and R2 adapters with mocked clients", () => {
  const s3 = createArtifactAdapterFromConfig({
    storageAdapterMode: "s3",
    bucket: "matchcuts-prod-private",
    region: "us-east-1",
    accessKeyId: "AKIATESTKEY123456",
    secretAccessKey: "test-secret-key-value",
    client: new MockS3Client(),
  });
  const r2 = createArtifactAdapterFromConfig({
    storageAdapterMode: "r2",
    bucket: "matchcuts-prod-private",
    region: "auto",
    endpoint: "https://account-id.r2.cloudflarestorage.com",
    accessKeyId: "r2-access-key",
    secretAccessKey: "r2-secret-key-value",
    client: new MockS3Client(),
  });

  assert.equal(s3.health().mode, "s3");
  assert.equal(r2.health().mode, "r2");
  assert.equal(s3.health().objectStorage, true);
  assert.equal(r2.health().objectStorage, true);
});
