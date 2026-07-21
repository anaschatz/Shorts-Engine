const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const TEST_TMP_ROOT = resolve(__dirname, "..", "tmp");
mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_DATA_DIR = mkdtempSync(resolve(TEST_TMP_ROOT, "persistence-foundation-data-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;

test.after(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const { ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();

const { createLocalJobWorker, restoreExportsFromCompletedJobs } = require("../server/job-worker.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { InMemoryExportRepository } = require("../server/repositories/export-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const {
  compareAndSwapProjectRecord,
  loadPersistedProjectState,
  persistProjectUploadRecord,
  withProjectStateLock,
} = require("../server/repositories/project-state.cjs");
const { InMemoryUploadRepository } = require("../server/repositories/upload-repository.cjs");
const { LocalArtifactStore } = require("../server/storage/artifact-store.cjs");
const { readJsonFile, storagePath, writeJsonAtomic } = require("../server/storage.cjs");

const PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "upl_22222222-2222-4222-8222-222222222222";

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

test("artifact store validates keys and protects destructive deletion", () => {
  const store = new LocalArtifactStore();
  assert.throws(() => store.pathFor("upload", "../bad.mp4"), (error) => error.code === "ARTIFACT_KEY_INVALID");
  assert.throws(() => store.pathFor("upload", "/tmp/bad.mp4"), (error) => error.code === "ARTIFACT_KEY_INVALID");
  assert.throws(() => store.pathFor("upload", "bad\\name.mp4"), (error) => error.code === "ARTIFACT_KEY_INVALID");
  assert.throws(() => store.createRecord({ id: "../bad", type: "upload", storageKey: "safe.mp4" }), (error) => error.code === "RESOURCE_ID_INVALID");
  assert.throws(() => store.createRecord({ type: "upload", storageKey: "safe.mp4", size: Number.NaN }), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(() => store.writeBuffer({ type: "upload", storageKey: "safe.mp4", buffer: "not-buffer" }), (error) => error.code === "VALIDATION_ERROR");

  const uploadArtifact = store.writeBuffer({
    id: UPLOAD_ID,
    type: "upload",
    ownerProjectId: PROJECT_ID,
    storageKey: uniqueKey("staging-upload"),
    buffer: Buffer.from("upload"),
    status: "staging",
  });
  const uploadPath = store.resolve(uploadArtifact);
  assert.equal(store.exists(uploadArtifact), true);
  const deleted = store.deleteStagingArtifact(uploadArtifact);
  assert.equal(deleted.status, "deleted");
  assert.equal(existsSync(uploadPath), false);

  const renderArtifact = store.createRecord({
    id: "exp_33333333-3333-4333-8333-333333333333",
    type: "render",
    ownerProjectId: PROJECT_ID,
    ownerJobId: "job_44444444-4444-4444-8444-444444444444",
    storageKey: uniqueKey("protected-render"),
    status: "available",
  });
  assert.throws(() => store.deleteTempArtifact(renderArtifact), (error) => error.code === "ARTIFACT_DELETE_FORBIDDEN");
  assert.doesNotMatch(JSON.stringify(store.publicRecord(renderArtifact)), /storageKey|path|\/Users|\/private/);
});

test("repositories create public records without leaking internal paths", () => {
  const artifactStore = new LocalArtifactStore();
  const projects = new InMemoryProjectRepository();
  const uploads = new InMemoryUploadRepository({ artifactStore });
  const uploadArtifact = artifactStore.writeBuffer({
    id: UPLOAD_ID,
    type: "upload",
    ownerProjectId: PROJECT_ID,
    storageKey: uniqueKey("repo-upload"),
    buffer: Buffer.from("upload"),
  });
  const uploadPath = artifactStore.resolve(uploadArtifact);
  try {
    const project = projects.create({
      id: PROJECT_ID,
      uploadId: UPLOAD_ID,
      title: "Derby Final",
      status: "draft",
    });
    const upload = uploads.create({
      id: UPLOAD_ID,
      projectId: PROJECT_ID,
      artifact: uploadArtifact,
      path: uploadPath,
      originalFilename: "derby.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      container: "mp4",
      byteSize: uploadArtifact.size,
      metadata: { durationSeconds: 12 },
    });
    projects.update(PROJECT_ID, { status: "ready" });

    assert.equal(projects.get(PROJECT_ID).status, "ready");
    assert.equal(uploads.get(UPLOAD_ID).id, upload.id);
    assert.doesNotMatch(JSON.stringify(projects.publicProject(project)), /\/Users|\/private/);
    assert.doesNotMatch(JSON.stringify(uploads.publicUpload(upload)), /\/Users|\/private|storageKey|path/);
    assert.throws(
      () =>
        uploads.create({
          id: "upl_abababab-abab-4aba-8aba-abababababab",
          projectId: PROJECT_ID,
          artifact: uploadArtifact,
          path: storagePath("uploads", uniqueKey("mismatch-upload")),
          metadata: { durationSeconds: 12 },
        }),
      (error) => error.code === "ARTIFACT_PATH_MISMATCH",
    );
  } finally {
    cleanup(uploadPath);
  }
});

test("in-memory project compare-and-swap rejects a reused stale snapshot", () => {
  const projects = new InMemoryProjectRepository();
  const created = projects.create({
    id: PROJECT_ID,
    uploadId: UPLOAD_ID,
    title: "CAS Derby",
    status: "draft",
  });
  const expected = JSON.parse(JSON.stringify(created));

  const winner = projects.compareAndSwap(PROJECT_ID, expected, {
    title: "CAS Winner",
    status: "processing",
  });
  const stale = projects.compareAndSwap(PROJECT_ID, expected, {
    title: "Stale Overwrite",
    status: "failed",
  });

  assert.equal(winner.title, "CAS Winner");
  assert.equal(stale, null);
  assert.equal(projects.get(PROJECT_ID).title, "CAS Winner");
  assert.equal(projects.get(PROJECT_ID).status, "processing");
});

test("local project CAS fails closed on a live lock and preserves clip upload metadata", () => {
  const projectId = "prj_localcas11-1111-4111-8111-111111111111";
  const uploadId = "upl_localcas22-2222-4222-8222-222222222222";
  const projects = new InMemoryProjectRepository();
  const project = projects.create({
    id: projectId,
    uploadId,
    title: "Locked Clip",
    status: "draft",
  });
  const upload = {
    id: uploadId,
    projectId,
    marker: { preserve: "exactly" },
  };
  const recordPath = storagePath("projects", `${projectId}.json`);
  persistProjectUploadRecord({ project, upload });

  try {
    withProjectStateLock(projectId, () => {
      const busy = compareAndSwapProjectRecord({
        projectId,
        expectedProject: JSON.parse(JSON.stringify(project)),
        patch: { title: "Must Not Install" },
      });
      assert.equal(busy.matched, false);
      assert.equal(busy.busy, true);
    });
    const swapped = compareAndSwapProjectRecord({
      projectId,
      expectedProject: JSON.parse(JSON.stringify(project)),
      patch: { title: "Safe Clip Update" },
    });
    const envelope = readJsonFile(recordPath);

    assert.equal(swapped.matched, true);
    assert.equal(envelope.project.title, "Safe Clip Update");
    assert.deepEqual(envelope.upload, upload);
  } finally {
    cleanup(recordPath);
  }
});

test("export repository fails closed until render artifact exists", () => {
  const artifactStore = new LocalArtifactStore();
  const exports = new InMemoryExportRepository({ artifactStore });
  const jobId = "job_55555555-5555-4555-8555-555555555555";
  const exportId = "exp_66666666-6666-4666-8666-666666666666";
  const storageKey = uniqueKey("missing-render");

  assert.throws(
    () =>
      exports.create({
        id: exportId,
        projectId: PROJECT_ID,
        jobId,
        artifact: artifactStore.createRecord({
          id: exportId,
          type: "export",
          ownerProjectId: PROJECT_ID,
          ownerJobId: jobId,
          storageKey,
          status: "available",
        }),
      }),
    (error) => error.code === "ARTIFACT_NOT_FOUND",
  );
  assert.equal(exports.restore({ id: exportId, projectId: PROJECT_ID, jobId, storageKey }), null);
});

test("export public records omit storage keys and reject path mismatches", () => {
  const artifactStore = new LocalArtifactStore();
  const exports = new InMemoryExportRepository({ artifactStore });
  const jobId = "job_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const exportId = "exp_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const storageKey = uniqueKey("public-export");
  const outputPath = storagePath("renders", storageKey);
  writeFileSync(outputPath, Buffer.from("rendered"));
  try {
    const exportRecord = exports.create({
      id: exportId,
      projectId: PROJECT_ID,
      jobId,
      artifact: artifactStore.createRecord({
        id: exportId,
        type: "export",
        ownerProjectId: PROJECT_ID,
        ownerJobId: jobId,
        storageKey,
        status: "available",
      }),
      outputPath,
    });
    assert.doesNotMatch(JSON.stringify(exports.publicExport(exportRecord)), /storageKey|outputPath|path|\/Users|\/private/);
    assert.throws(
      () =>
        exports.create({
          id: "exp_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          projectId: PROJECT_ID,
          jobId,
          artifact: exportRecord.artifact,
          outputPath: storagePath("renders", uniqueKey("mismatch-render")),
        }),
      (error) => error.code === "ARTIFACT_PATH_MISMATCH",
    );
  } finally {
    cleanup(outputPath);
  }
});

test("completed jobs restore exports through the export repository", () => {
  const artifactStore = new LocalArtifactStore();
  const exports = new InMemoryExportRepository({ artifactStore });
  const jobs = new JobStore();
  const job = jobs.create({
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    action: "generate",
    idempotencyKey: "restore-export-foundation",
  });
  jobs.update(job, { status: "processing", progress: 80, step: "render_short" });
  const outputPath = storagePath("renders", `${job.id}.mp4`);
  writeFileSync(outputPath, Buffer.from("rendered"));
  try {
    jobs.complete(job, {
      exportId: "exp_77777777-7777-4777-8777-777777777777",
      outputPath,
    });
    const restored = restoreExportsFromCompletedJobs({ jobs, exportRepository: exports, artifactStore, logger: null });
    const exportRecord = exports.get(job.exportId);

    assert.equal(restored, 1);
    assert.equal(exportRecord.projectId, PROJECT_ID);
    assert.equal(exports.resolveOutputPath(exportRecord), outputPath);
    assert.doesNotMatch(JSON.stringify(exports.publicExport(exportRecord)), /\/Users|\/private|outputPath|path/);
  } finally {
    cleanup(outputPath);
  }
});

test("project state loader ignores corrupt or unsafe persisted metadata", () => {
  const artifactStore = new LocalArtifactStore();
  const projects = new InMemoryProjectRepository();
  const uploads = new InMemoryUploadRepository({ artifactStore });
  const exports = new InMemoryExportRepository({ artifactStore });
  const unsafeProjectId = "prj_88888888-8888-4888-8888-888888888888";
  const unsafeUploadId = "upl_99999999-9999-4999-8999-999999999999";
  const recordPath = storagePath("projects", `${unsafeProjectId}.json`);
  const unrelatedPath = storagePath("projects", `storage-test-${Date.now()}.json`);
  writeJsonAtomic(recordPath, {
    project: { id: unsafeProjectId, uploadId: unsafeUploadId, title: "Unsafe", status: "draft" },
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
  writeJsonAtomic(unrelatedPath, { ok: true, shouldNotLoad: true });
  try {
    const summary = loadPersistedProjectState({
      projectRepository: projects,
      uploadRepository: uploads,
      exportRepository: exports,
      artifactStore,
    });

    assert.equal(projects.get(unsafeProjectId), null);
    assert.equal(uploads.get(unsafeUploadId), null);
    assert.equal(summary.ignored >= 2, true);
  } finally {
    cleanup(recordPath);
    cleanup(unrelatedPath);
  }
});

test("worker can read queued jobs through repository boundaries", async () => {
  const artifactStore = new LocalArtifactStore();
  const projectRepository = new InMemoryProjectRepository();
  const uploadRepository = new InMemoryUploadRepository({ artifactStore });
  const exportRepository = new InMemoryExportRepository({ artifactStore });
  const jobs = new JobStore();
  const uploadArtifact = artifactStore.writeBuffer({
    id: UPLOAD_ID,
    type: "upload",
    ownerProjectId: PROJECT_ID,
    storageKey: uniqueKey("worker-repo-upload"),
    buffer: Buffer.from("upload"),
  });
  const uploadPath = artifactStore.resolve(uploadArtifact);
  try {
    projectRepository.create({ id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" });
    uploadRepository.create({
      id: UPLOAD_ID,
      projectId: PROJECT_ID,
      artifact: uploadArtifact,
      path: uploadPath,
      originalFilename: "derby.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      container: "mp4",
      byteSize: uploadArtifact.size,
      metadata: { durationSeconds: 12 },
    });
    const job = jobs.create({
      projectId: PROJECT_ID,
      uploadId: UPLOAD_ID,
      action: "generate",
      idempotencyKey: "worker-repository-foundation",
      payload: { title: "Derby Final", preset: "hype", language: "en" },
    });
    const worker = createLocalJobWorker({
      jobs,
      projectRepository,
      uploadRepository,
      exportRepository,
      artifactStore,
      dependencies: {
        logger: null,
        runRenderJob: async ({ jobs, job: runningJob }) => {
          jobs.complete(runningJob, {
            exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
            outputPath: storagePath("renders", "worker-repository-foundation.mp4"),
          });
        },
      },
    });

    await worker.process(job, { requestId: "req_worker_repository" });
    assert.equal(job.status, "completed");
  } finally {
    cleanup(uploadPath);
  }
});
