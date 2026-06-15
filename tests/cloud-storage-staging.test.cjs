const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } = require("node:fs");

const { createArtifactAdapterFromConfig, publicStorageConfig } = require("../server/adapters/object-storage-adapter.cjs");
const { createDefaultAdapters } = require("../server/adapters/local-persistence-adapter.cjs");
const { MockCloudArtifactAdapter } = require("../server/adapters/mock-cloud-artifact-adapter.cjs");
const { validateArtifactAdapter } = require("../server/adapters/artifact-adapter.cjs");
const { CONFIG, validateByteConfig, validatePositiveIntegerConfig, validateStorageConfig } = require("../server/config.cjs");
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

function cleanupBacking(adapter, artifact) {
  try {
    const filePath = adapter.store ? adapter.store.resolve(artifact) : adapter.resolveArtifact(artifact);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort test cleanup.
  }
}

function validTranscript() {
  return {
    provider: "mock",
    language: "en",
    text: "Goal from the edge of the box",
    captions: [
      { start: 0, end: 2, text: "Goal from the edge" },
      { start: 2.2, end: 4.2, text: "The stadium explodes" },
    ],
    segments: [{ start: 0, end: 2, text: "Goal from the edge" }],
  };
}

function validMoment() {
  return {
    id: "mom_cloud_1",
    rank: 1,
    start: 0,
    end: 8,
    center: 4,
    title: "Decisive goal",
    summary: "Goal from the edge",
    reasonCodes: ["goal_like_phrase", "crowd_reaction"],
    confidence: 0.9,
    retentionScore: 91,
    suggestedPreset: "hype",
    hook: "ΤΟ ΓΚΟΛ ΤΗΣ ΒΡΑΔΙΑΣ",
    captionBeats: [
      { start: 0, end: 2, text: "Goal from the edge" },
      { start: 2.2, end: 4.2, text: "The stadium explodes" },
    ],
  };
}

function validPlan() {
  return {
    sourceStart: 0,
    sourceEnd: 8,
    aspectRatio: "9:16",
    hook: "ΤΟ ΓΚΟΛ ΤΗΣ ΒΡΑΔΙΑΣ",
    title: "Cloud Derby",
    captions: [
      { start: 0, end: 2, text: "Goal from the edge" },
      { start: 2.2, end: 4.2, text: "The stadium explodes" },
    ],
    effects: ["center_crop_9_16", "punch_captions"],
    export: { width: 1080, height: 1920, format: "mp4" },
  };
}

function makeCloudRenderContext(options = {}) {
  const artifactAdapter = new MockCloudArtifactAdapter();
  const exportRepository = new InMemoryExportRepository({ artifactStore: artifactAdapter });
  const projectRepository = new InMemoryProjectRepository();
  const jobs = new JobStore();
  const projectId = id("prj");
  const uploadId = id("upl");
  const project = projectRepository.create({
    id: projectId,
    uploadId,
    title: "Cloud Derby",
    status: "draft",
  });
  const uploadArtifact = artifactAdapter.writeArtifact({
    id: uploadId,
    type: "upload",
    ownerProjectId: projectId,
    storageKey: uniqueKey("cloud-source"),
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
      hasAudio: options.hasAudio !== false,
    },
  };
  const job = jobs.create({
    projectId,
    uploadId,
    action: "generate",
    idempotencyKey: `cloud-staging-${randomUUID()}`,
    payload: { title: "Cloud Derby", preset: "hype", language: "en" },
  });
  const logs = [];
  const dependencies = {
    artifactStore: artifactAdapter,
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
      audioPeaks: [{ time: 4, energyScore: 0.86 }],
      sceneChanges: [{ time: 4.1, confidence: 0.8 }],
      highMotionCandidates: [{ time: 4, confidence: 0.77 }],
    }),
    chooseTranscriptionProvider: () => ({
      transcribe: async () => validTranscript(),
    }),
    detectHighlights: () => ({ fallback: false, moments: [validMoment()] }),
    createCandidateEditPlans: () => [validPlan()],
    validateEditPlan,
    renderShort: async ({ outputPath }) => {
      if (options.skipRenderedFile) return;
      writeFileSync(outputPath, Buffer.from("rendered-cloud-short"));
    },
    persistRenderRecord(record) {
      logs.push({ event: "persist_render_record", exportId: record.exportId });
    },
  };
  return { artifactAdapter, dependencies, exportRepository, job, jobs, logs, project, upload, uploadArtifact };
}

test("storage adapter config validates cloud-ready modes without exposing secrets", () => {
  const config = validateStorageConfig({
    adapter: "r2",
    bucket: "matchcuts-prod-bucket",
    region: "auto",
    endpoint: "https://storage.example.test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    forcePathStyle: true,
    signedUrlTtlSeconds: 10000,
  });
  const safe = publicStorageConfig(config);

  assert.equal(config.adapter, "r2");
  assert.equal(config.signedUrlTtlSeconds, 15 * 60);
  assert.deepEqual(safe, {
    adapter: "r2",
    bucketConfigured: true,
    regionConfigured: true,
    endpointConfigured: true,
    credentialsConfigured: true,
    forcePathStyle: true,
    signedUrlTtlSeconds: 15 * 60,
    multipartThresholdBytes: 64 * 1024 * 1024,
    multipartPartSizeBytes: 16 * 1024 * 1024,
    lifecycleCleanupMaxAgeSeconds: 24 * 60 * 60,
    lifecycleCleanupMaxPerRun: 100,
  });
  assert.doesNotMatch(JSON.stringify(safe), /matchcuts-prod-bucket|storage\.example\.test|test-access|test-secret/);
  assert.throws(() => validateStorageConfig({ adapter: "ftp" }), /Invalid MATCHCUTS_STORAGE_ADAPTER/);
  assert.throws(() => validateStorageConfig({ adapter: "s3", bucket: "../bad" }), /Invalid storage bucket/);
  assert.throws(() => validateStorageConfig({ adapter: "gcs", endpoint: "file:///etc/passwd" }), /Invalid storage endpoint/);
  assert.throws(() => validateStorageConfig({ adapter: "s3", bucket: "matchcuts-prod", region: "us-east-1" }), /credentials are required/);
});

test("server numeric config helpers fail closed for unsafe env values", () => {
  assert.equal(validatePositiveIntegerConfig("", { name: "port", fallback: 4175, min: 1, max: 65535 }), 4175);
  assert.equal(validatePositiveIntegerConfig("0", { name: "retries", fallback: 1, min: 0, max: 5 }), 0);
  assert.throws(
    () => validatePositiveIntegerConfig("nan", { name: "server port", fallback: 4175, min: 1, max: 65535 }),
    /Invalid server port configuration/,
  );
  assert.throws(
    () => validatePositiveIntegerConfig("70000", { name: "server port", fallback: 4175, min: 1, max: 65535 }),
    /Invalid server port configuration/,
  );
  assert.throws(
    () => validateByteConfig("abc", { name: "max upload bytes", fallback: 1024, min: 1, max: 2048 }),
    /Invalid max upload bytes configuration/,
  );
});

test("adapter factory keeps local and mock-cloud defaults while GCS fails closed", () => {
  const local = createArtifactAdapterFromConfig({ storageAdapterMode: "local" });
  const mockCloud = createArtifactAdapterFromConfig({ storageAdapterMode: "mock-cloud" });

  assert.equal(validateArtifactAdapter(local), local);
  assert.equal(validateArtifactAdapter(mockCloud), mockCloud);
  assert.equal(local.health().mode, "local");
  assert.equal(mockCloud.health().mode, "mock-cloud");
  assert.equal(mockCloud.health().objectStorage, true);
  assert.throws(
    () => createArtifactAdapterFromConfig({ storageAdapterMode: "gcs", bucket: "matchcuts-prod" }),
    (error) => error.code === "ADAPTER_CONTRACT_INVALID",
  );
});

test("default adapters can boot in mock-cloud mode without path leaks", () => {
  const { artifactAdapter, persistenceAdapter } = createDefaultAdapters({
    storageAdapterMode: "mock-cloud",
    bucket: "private-prod-bucket",
    endpoint: "https://storage.example.test",
  });
  const health = {
    artifact: artifactAdapter.health(),
    persistence: persistenceAdapter.health(),
  };

  assert.equal(validateArtifactAdapter(artifactAdapter), artifactAdapter);
  assert.equal(artifactAdapter.health().objectStorage, true);
  assert.equal(persistenceAdapter.health().ready, true);
  assert.doesNotMatch(JSON.stringify(health), /private-prod-bucket|storage\.example\.test|storageKey|\/Users|\/private/);
});

test("mock-cloud adapter stages input locally and hides permanent object paths", () => {
  const adapter = new MockCloudArtifactAdapter();
  const artifact = adapter.writeArtifact({
    id: id("upl"),
    type: "upload",
    ownerProjectId: id("prj"),
    storageKey: uniqueKey("mock-cloud-upload"),
    buffer: Buffer.from("video-bytes"),
  });
  let stage = null;

  try {
    assert.throws(() => adapter.resolveLocalPath(artifact), (error) => error.code === "STORAGE_PATH_UNSAFE");
    stage = adapter.stageInputForProcessing(artifact, { step: "ffmpeg_probe" });
    assert.equal(stage.permanentLocal, false);
    assert.equal(stage.cleanupRequired, true);
    assert.equal(adapter.assertStagingPath(stage.localPath), stage.localPath);
    assert.equal(readFileSync(stage.localPath).toString("utf8"), "video-bytes");

    const cleanup = adapter.cleanupStage(stage);
    assert.equal(cleanup.cleaned, true);
    assert.equal(existsSync(stage.localPath), false);
    assert.throws(
      () => adapter.cleanupStage({ id: "stage_bad", localPath: "/etc/passwd", cleanupRequired: true }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );
  } finally {
    if (stage) adapter.cleanupStage(stage);
    cleanupBacking(adapter, artifact);
  }
});

test("mock-cloud adapter commits FFmpeg local output and cleans only staging files", () => {
  const adapter = new MockCloudArtifactAdapter();
  const stage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: id("prj"),
    ownerJobId: id("job"),
    storageKey: uniqueKey("mock-cloud-render"),
    contentType: "video/mp4",
  });
  let artifact = null;

  try {
    assert.equal(stage.permanentLocal, false);
    assert.equal(stage.cleanupRequired, true);
    assert.equal(adapter.assertStagingPath(stage.localPath), stage.localPath);
    writeFileSync(stage.localPath, Buffer.from("rendered-video"));

    artifact = adapter.commitOutputStage(stage, { status: "available", contentType: "video/mp4" });
    assert.equal(adapter.artifactExists(artifact), true);
    assert.equal(adapter.readArtifact(artifact).toString("utf8"), "rendered-video");
    assert.doesNotMatch(JSON.stringify(adapter.publicArtifactRecord(artifact)), /storageKey|\/Users|\/private/);

    const cleanup = adapter.cleanupStage(stage);
    assert.equal(cleanup.cleaned, true);
    assert.equal(existsSync(stage.localPath), false);
    assert.equal(adapter.artifactExists(artifact), true);
  } finally {
    adapter.cleanupStage(stage);
    cleanupBacking(adapter, artifact);
  }
});

test("local adapter uses stable render paths while temporary stages remain cleanup-bounded", () => {
  const adapter = createArtifactAdapterFromConfig({ storageAdapterMode: "local" });
  const renderStage = adapter.createOutputStage("rendered_video", {
    id: id("exp"),
    ownerProjectId: id("prj"),
    ownerJobId: id("job"),
    storageKey: uniqueKey("local-render"),
  });
  const tempStage = adapter.createOutputStage("subtitle_temp", {
    ownerProjectId: id("prj"),
    ownerJobId: id("job"),
    storageKey: uniqueKey("local-subtitles", "ass"),
  });
  let renderArtifact = null;

  try {
    assert.equal(renderStage.permanentLocal, true);
    assert.equal(renderStage.cleanupRequired, false);
    assert.equal(tempStage.permanentLocal, true);
    assert.equal(tempStage.cleanupRequired, true);
    writeFileSync(renderStage.localPath, Buffer.from("local-render"));
    writeFileSync(tempStage.localPath, "subtitles", "utf8");
    renderArtifact = adapter.commitOutputStage(renderStage, { contentType: "video/mp4" });

    assert.equal(adapter.artifactExists(renderArtifact), true);
    assert.equal(adapter.cleanupStage(renderStage).cleaned, false);
    assert.equal(adapter.cleanupStage(tempStage).cleaned, true);
    assert.equal(existsSync(tempStage.localPath), false);
  } finally {
    cleanupBacking(adapter, renderArtifact || renderStage.artifact);
    adapter.cleanupStage(tempStage);
  }
});

test("render orchestration works through mock-cloud staging without public path output", async () => {
  const context = makeCloudRenderContext();

  try {
    await runRenderJob({
      jobs: context.jobs,
      exportRepository: context.exportRepository,
      projectRepository: new InMemoryProjectRepository(),
      job: context.job,
      project: context.project,
      upload: context.upload,
      payload: { title: "Cloud Derby", preset: "hype", language: "en" },
      requestId: "req_cloud_staging_test",
      dependencies: context.dependencies,
    });

    const exportRecord = context.exportRepository.get(context.job.exportId);
    assert.equal(context.job.status, "completed");
    assert.equal(context.project.status, "ready");
    assert.equal(context.job.outputPath, null);
    assert.equal(exportRecord.outputPath, null);
    assert.equal(context.artifactAdapter.readArtifact(exportRecord.artifact).toString("utf8"), "rendered-cloud-short");
    assert.doesNotMatch(JSON.stringify(context.exportRepository.publicExport(exportRecord)), /storageKey|outputPath|\/Users|\/private/);
    assert.doesNotMatch(JSON.stringify(context.logs), /storageKey|outputPath|\/Users|\/private|secret/);
  } finally {
    const exportRecord = context.exportRepository.get(context.job.exportId);
    cleanupBacking(context.artifactAdapter, exportRecord && exportRecord.artifact);
    cleanupBacking(context.artifactAdapter, context.uploadArtifact);
  }
});

test("render orchestration fails closed when staged output is missing", async () => {
  const context = makeCloudRenderContext({ skipRenderedFile: true });

  try {
    await runRenderJob({
      jobs: context.jobs,
      exportRepository: context.exportRepository,
      projectRepository: new InMemoryProjectRepository(),
      job: context.job,
      project: context.project,
      upload: context.upload,
      payload: { title: "Cloud Derby", preset: "hype", language: "en" },
      requestId: "req_cloud_missing_render_test",
      dependencies: context.dependencies,
    });

    assert.equal(context.job.status, "failed");
    assert.equal(context.job.error.code, "RENDER_FAILED");
    assert.equal(context.project.status, "failed");
    assert.equal(context.exportRepository.all().length, 0);
    assert.doesNotMatch(JSON.stringify(context.job.error), /storageKey|\/Users|\/private|secret/);
  } finally {
    cleanupBacking(context.artifactAdapter, context.uploadArtifact);
  }
});
