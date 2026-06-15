const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, unlinkSync } = require("node:fs");

const { validateArtifactAdapter } = require("../server/adapters/artifact-adapter.cjs");
const { createDefaultAdapters } = require("../server/adapters/local-persistence-adapter.cjs");
const { validatePersistenceAdapter } = require("../server/adapters/persistence-adapter.cjs");
const { storagePath, writeJsonAtomic } = require("../server/storage.cjs");

const PROJECT_ID = "prj_adapters1111-4111-8111-111111111111";
const UPLOAD_ID = "upl_adapters2222-4222-8222-222222222222";
const JOB_ID = "job_adapters3333-4333-8333-333333333333";
const EXPORT_ID = "exp_adapters4444-4444-8444-444444444444";

function uniqueKey(prefix, extension = "mp4") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
}

function cleanup(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort test cleanup.
  }
}

test("default local adapters satisfy explicit contracts and expose safe health", () => {
  const { artifactAdapter, persistenceAdapter } = createDefaultAdapters();

  assert.equal(validateArtifactAdapter(artifactAdapter), artifactAdapter);
  assert.equal(validatePersistenceAdapter(persistenceAdapter), persistenceAdapter);

  const artifactHealth = artifactAdapter.health();
  const persistenceHealth = persistenceAdapter.health();

  assert.equal(artifactHealth.mode, "local");
  assert.equal(artifactHealth.objectStorage, false);
  assert.equal(artifactHealth.capabilities.createArtifactRecord, true);
  assert.equal(persistenceHealth.mode, "local");
  assert.equal(persistenceHealth.database, false);
  assert.equal(persistenceHealth.capabilities.createProject, true);
  assert.equal(persistenceHealth.capabilities.createArtifact, true);
  assert.equal(persistenceHealth.capabilities.restoreState, true);
  assert.equal(persistenceHealth.repositories.artifacts.ready, true);
  assert.doesNotMatch(JSON.stringify({ artifactHealth, persistenceHealth }), /\/Users|\/private|storageKey|outputPath/);
});

test("adapter contract validation fails closed when required capabilities are missing", () => {
  assert.throws(() => validateArtifactAdapter({ health() {} }), (error) => error.code === "ADAPTER_CONTRACT_INVALID");
  assert.throws(() => validatePersistenceAdapter({ health() {} }), (error) => error.code === "ADAPTER_CONTRACT_INVALID");
});

test("persistence adapter creates records through repositories without public path leaks", () => {
  const { artifactAdapter, persistenceAdapter } = createDefaultAdapters();
  const uploadArtifact = artifactAdapter.writeBuffer({
    id: UPLOAD_ID,
    type: "upload",
    ownerProjectId: PROJECT_ID,
    storageKey: uniqueKey("adapter-upload"),
    buffer: Buffer.from("upload"),
  });
  const renderArtifact = artifactAdapter.writeBuffer({
    id: EXPORT_ID,
    type: "export",
    ownerProjectId: PROJECT_ID,
    ownerJobId: JOB_ID,
    storageKey: uniqueKey("adapter-export"),
    buffer: Buffer.from("rendered"),
  });
  const uploadPath = artifactAdapter.resolveArtifact(uploadArtifact);
  const outputPath = artifactAdapter.resolveArtifact(renderArtifact);

  try {
    const project = persistenceAdapter.createProject({
      id: PROJECT_ID,
      uploadId: UPLOAD_ID,
      title: "Adapter Derby",
      status: "draft",
    });
    const upload = persistenceAdapter.createUpload({
      id: UPLOAD_ID,
      projectId: PROJECT_ID,
      artifact: uploadArtifact,
      path: uploadPath,
      originalFilename: "adapter-derby.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      container: "mp4",
      byteSize: uploadArtifact.size,
      metadata: { durationSeconds: 12 },
    });
    const exportRecord = persistenceAdapter.createExport({
      id: EXPORT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      artifact: renderArtifact,
      outputPath,
    });

    assert.equal(persistenceAdapter.getProject(PROJECT_ID).id, project.id);
    assert.equal(persistenceAdapter.getUpload(UPLOAD_ID).id, upload.id);
    assert.equal(persistenceAdapter.getExport(EXPORT_ID).id, exportRecord.id);
    assert.equal(persistenceAdapter.getArtifact(UPLOAD_ID).id, UPLOAD_ID);
    assert.equal(persistenceAdapter.getArtifact(EXPORT_ID).id, EXPORT_ID);
    assert.equal(persistenceAdapter.resolveExportOutputPath(exportRecord), outputPath);
    assert.doesNotMatch(JSON.stringify(persistenceAdapter.publicUpload(upload)), /\/Users|\/private|storageKey|path/);
    assert.doesNotMatch(JSON.stringify(persistenceAdapter.publicExport(exportRecord)), /\/Users|\/private|storageKey|outputPath|path/);
    assert.doesNotMatch(JSON.stringify(artifactAdapter.publicArtifactRecord(renderArtifact)), /\/Users|\/private|storageKey|path/);
  } finally {
    cleanup(uploadPath);
    cleanup(outputPath);
  }
});

test("persistence adapter restoreState ignores unsafe and unrelated persisted metadata", () => {
  const { persistenceAdapter } = createDefaultAdapters();
  const unsafeProjectId = "prj_adapters5555-4555-8555-555555555555";
  const unsafeUploadId = "upl_adapters6666-4666-8666-666666666666";
  const recordPath = storagePath("projects", `${unsafeProjectId}.json`);
  const unrelatedPath = storagePath("projects", `adapter-unrelated-${Date.now()}.json`);
  writeJsonAtomic(recordPath, {
    project: { id: unsafeProjectId, uploadId: unsafeUploadId, title: "Unsafe Adapter", status: "draft" },
    upload: {
      id: unsafeUploadId,
      projectId: unsafeProjectId,
      path: "/etc/passwd",
      originalFilename: "unsafe.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      container: "mp4",
      byteSize: 10,
      metadata: { durationSeconds: 10 },
    },
  });
  writeJsonAtomic(unrelatedPath, { ok: true });

  try {
    const summary = persistenceAdapter.restoreState();

    assert.equal(persistenceAdapter.getProject(unsafeProjectId), null);
    assert.equal(persistenceAdapter.getUpload(unsafeUploadId), null);
    assert.equal(summary.ignored >= 2, true);
  } finally {
    cleanup(recordPath);
    cleanup(unrelatedPath);
  }
});
