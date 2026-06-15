const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, unlinkSync } = require("node:fs");

const { ArtifactCleanupWorker } = require("../server/artifact-cleanup-worker.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { LocalArtifactStore } = require("../server/storage/artifact-store.cjs");
const { storagePath, writeJsonAtomic } = require("../server/storage.cjs");

const PROJECT_ID = "prj_cleanup1111-4111-8111-111111111111";

function uniqueKey(prefix, extension = "txt") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
}

function oldIso() {
  return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
}

function cleanupFile(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort test cleanup.
  }
}

function createTempArtifact({ store, repository, ownerJobId = null, status = "available" } = {}) {
  const artifact = store.writeBuffer({
    id: `render_temp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: "render_temp",
    ownerProjectId: PROJECT_ID,
    ownerJobId,
    storageKey: uniqueKey("cleanup-temp"),
    contentType: "text/plain",
    buffer: Buffer.from("temporary"),
    status,
    createdAt: oldIso(),
    updatedAt: oldIso(),
  });
  repository.create(artifact);
  return artifact;
}

test("artifact repository indexes records without public path or storage key leaks", () => {
  const store = new LocalArtifactStore();
  const repository = new InMemoryArtifactRepository();
  const artifact = createTempArtifact({ store, repository });
  const artifactPath = store.resolve(artifact);

  try {
    const indexed = repository.get(artifact.id);
    const publicRecord = repository.publicArtifact(indexed);

    assert.equal(indexed.id, artifact.id);
    assert.equal(indexed.type, "render_temp");
    assert.equal(repository.listCleanupCandidates({ maxAgeSeconds: 60, limit: 5 }).length, 1);
    assert.doesNotMatch(JSON.stringify(publicRecord), /storageKey|path|\/Users|\/private/);
  } finally {
    cleanupFile(artifactPath);
  }
});

test("artifact repository restore ignores corrupt persisted index metadata", () => {
  const corruptPath = storagePath("artifacts", `art_${"A".repeat(16)}.json`);
  writeJsonAtomic(corruptPath, { id: "../bad", type: "upload", storageKey: "../bad.mp4" });
  try {
    const repository = new InMemoryArtifactRepository({ persist: true });
    const restored = repository.restore();

    assert.equal(restored.ignored >= 1, true);
    assert.equal(repository.all().some((record) => record.id === "../bad"), false);
  } finally {
    cleanupFile(corruptPath);
  }
});

test("artifact repository rejects persisted paths outside the artifact type storage area", () => {
  const repository = new InMemoryArtifactRepository();

  assert.throws(
    () =>
      repository.create({
        id: "render_temp_path_safety",
        type: "render_temp",
        storageKey: uniqueKey("path-safety"),
        path: "/etc/passwd",
        status: "available",
      }),
    (error) => error.code === "STORAGE_PATH_UNSAFE",
  );

  assert.throws(
    () =>
      repository.create({
        id: "render_temp_wrong_area",
        type: "render_temp",
        storageKey: uniqueKey("wrong-area"),
        path: storagePath("uploads", uniqueKey("wrong-area", "mp4")),
        status: "available",
      }),
    (error) => error.code === "STORAGE_PATH_UNSAFE",
  );
});

test("cleanup worker dry run reports eligible artifacts without deleting files", async () => {
  const store = new LocalArtifactStore();
  const repository = new InMemoryArtifactRepository();
  const artifact = createTempArtifact({ store, repository });
  const artifactPath = store.resolve(artifact);
  const worker = new ArtifactCleanupWorker({ artifactStore: store, artifactRepository: repository, jobs: new JobStore() });

  try {
    const result = await worker.runOnce({ dryRun: true, maxAgeSeconds: 60, nowMs: Date.now() });

    assert.equal(result.dryRun, true);
    assert.equal(result.eligible, 1);
    assert.equal(result.deleted, 0);
    assert.equal(existsSync(artifactPath), true);
    assert.equal(repository.get(artifact.id).status, "available");
    assert.doesNotMatch(JSON.stringify(worker.health()), /storageKey|path|\/Users|\/private/);
  } finally {
    cleanupFile(artifactPath);
  }
});

test("cleanup worker deletes only old temp artifacts and updates index status", async () => {
  const store = new LocalArtifactStore();
  const repository = new InMemoryArtifactRepository();
  const artifact = createTempArtifact({ store, repository });
  const protectedUpload = store.writeBuffer({
    id: `upl_cleanup2222-4222-8222-222222222222`,
    type: "upload",
    ownerProjectId: PROJECT_ID,
    storageKey: uniqueKey("cleanup-upload", "mp4"),
    buffer: Buffer.from("upload"),
    status: "available",
    createdAt: oldIso(),
    updatedAt: oldIso(),
  });
  repository.create(protectedUpload);
  const artifactPath = store.resolve(artifact);
  const uploadPath = store.resolve(protectedUpload);
  const worker = new ArtifactCleanupWorker({ artifactStore: store, artifactRepository: repository, jobs: new JobStore() });

  try {
    const result = await worker.runOnce({ dryRun: false, maxAgeSeconds: 60, nowMs: Date.now() });

    assert.equal(result.deleted, 1);
    assert.equal(existsSync(artifactPath), false);
    assert.equal(existsSync(uploadPath), true);
    assert.equal(repository.get(artifact.id).status, "deleted");
    assert.equal(repository.get(protectedUpload.id).status, "available");
  } finally {
    cleanupFile(artifactPath);
    cleanupFile(uploadPath);
  }
});

test("cleanup worker protects artifacts owned by active jobs", async () => {
  const store = new LocalArtifactStore();
  const repository = new InMemoryArtifactRepository();
  const jobs = new JobStore();
  const job = jobs.create({
    projectId: PROJECT_ID,
    uploadId: "upl_cleanup3333-4333-8333-333333333333",
    action: "generate",
    idempotencyKey: "cleanup-active-job",
  });
  jobs.update(job, { status: "processing", progress: 20, step: "render_short" });
  const artifact = createTempArtifact({ store, repository, ownerJobId: job.id });
  const artifactPath = store.resolve(artifact);
  const worker = new ArtifactCleanupWorker({ artifactStore: store, artifactRepository: repository, jobs });

  try {
    const result = await worker.runOnce({ dryRun: false, maxAgeSeconds: 60, nowMs: Date.now() });

    assert.equal(result.deleted, 0);
    assert.equal(result.scanned, 0);
    assert.equal(result.activeJobs, 1);
    assert.equal(existsSync(artifactPath), true);
    assert.equal(repository.get(artifact.id).status, "available");
  } finally {
    cleanupFile(artifactPath);
  }
});

test("cleanup worker scheduler can start and stop without running when interval is disabled", () => {
  const worker = new ArtifactCleanupWorker({
    artifactRepository: new InMemoryArtifactRepository(),
    artifactStore: new LocalArtifactStore(),
    intervalMs: 0,
  });

  assert.equal(worker.start(), false);
  assert.equal(worker.health().running, false);
  assert.equal(worker.stop(), false);
});
