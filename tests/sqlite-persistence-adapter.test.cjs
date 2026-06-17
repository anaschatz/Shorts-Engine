const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, unlinkSync } = require("node:fs");

const { CONFIG, validateDatabaseConfig } = require("../server/config.cjs");
const { createDefaultAdapters } = require("../server/adapters/local-persistence-adapter.cjs");
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { SQLitePersistenceAdapter, LATEST_SCHEMA_VERSION, SQLITE_AVAILABLE } = require("../server/adapters/sqlite-persistence-adapter.cjs");
const { validatePersistenceAdapter } = require("../server/adapters/persistence-adapter.cjs");
const { storagePath } = require("../server/storage.cjs");

const PUBLIC_LEAK_RE = /\/Users|\/private|"(storageKey|outputPath|filePath|path)"\s*:|secret/i;
const sqliteTest = SQLITE_AVAILABLE ? test : test.skip;

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function uniqueKey(prefix, extension = "mp4") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
}

function cleanupPath(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort test cleanup.
  }
}

function cleanupDatabase(databasePath) {
  cleanupPath(databasePath);
  cleanupPath(`${databasePath}-shm`);
  cleanupPath(`${databasePath}-wal`);
}

function databasePath() {
  mkdirSync(CONFIG.dbDir, { recursive: true });
  const fileName = `sqlite-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
  const filePath = storagePath("db", fileName);
  cleanupDatabase(filePath);
  return filePath;
}

function makeAdapter(options = {}) {
  const dbPath = options.databasePath || databasePath();
  const artifactAdapter = options.artifactAdapter || new LocalArtifactAdapter();
  const adapter = new SQLitePersistenceAdapter({ artifactAdapter, databasePath: dbPath });
  return { adapter, artifactAdapter, databasePath: dbPath };
}

function closeAdapter(adapter) {
  if (adapter && typeof adapter.close === "function") adapter.close();
}

function validUpload({ artifactAdapter, projectId, uploadId } = {}) {
  const safeProjectId = projectId || id("prj");
  const safeUploadId = uploadId || id("upl");
  const artifact = artifactAdapter.writeBuffer({
    id: safeUploadId,
    type: "upload",
    ownerProjectId: safeProjectId,
    storageKey: uniqueKey("sqlite-upload"),
    buffer: Buffer.from("upload"),
  });
  return {
    projectId: safeProjectId,
    uploadId: safeUploadId,
    artifact,
    path: artifactAdapter.resolveArtifact(artifact),
    cleanup: () => cleanupPath(artifactAdapter.resolveArtifact(artifact)),
    record: {
      id: safeUploadId,
      projectId: safeProjectId,
      artifact,
      path: artifactAdapter.resolveArtifact(artifact),
      originalFilename: "sqlite-upload.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      container: "mp4",
      byteSize: artifact.size,
      checksumSha256: "a".repeat(64),
      metadata: { durationSeconds: 12, width: 1280, height: 720 },
    },
  };
}

sqliteTest("sqlite persistence adapter runs migrations and satisfies the adapter contract", () => {
  const { adapter, databasePath: dbPath } = makeAdapter();
  try {
    assert.equal(validatePersistenceAdapter(adapter), adapter);
    assert.equal(adapter.migrate(), LATEST_SCHEMA_VERSION);
    const health = adapter.health();

    assert.equal(health.mode, "sqlite");
    assert.equal(health.database, true);
    assert.equal(health.dbEnabled, true);
    assert.equal(health.transactions, true);
    assert.equal(health.migrations.ready, true);
    assert.equal(health.migrations.currentVersion, LATEST_SCHEMA_VERSION);
    assert.equal(health.capabilities.transaction, true);
    assert.equal(health.repositories.projects.ready, true);
    assert.doesNotMatch(JSON.stringify(health), PUBLIC_LEAK_RE);
  } finally {
    closeAdapter(adapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("createDefaultAdapters can opt into sqlite without changing the local default", () => {
  const local = createDefaultAdapters();
  assert.equal(local.persistenceAdapter.health().mode, "local");
  assert.throws(() => createDefaultAdapters({ persistenceAdapterMode: "postgres" }), /Invalid MATCHCUTS_PERSISTENCE_ADAPTER/);

  const dbPath = databasePath();
  const { persistenceAdapter } = createDefaultAdapters({ persistenceAdapterMode: "sqlite", databasePath: dbPath });
  try {
    assert.equal(persistenceAdapter.health().mode, "sqlite");
    assert.equal(persistenceAdapter.health().database, true);
  } finally {
    closeAdapter(persistenceAdapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite project and upload records persist through repository facades", () => {
  const { adapter, artifactAdapter, databasePath: dbPath } = makeAdapter();
  const upload = validUpload({ artifactAdapter });
  try {
    const created = adapter.createProjectUpload({
      upload: upload.record,
      project: {
        id: upload.projectId,
        uploadId: upload.uploadId,
        title: "SQLite Derby",
        status: "draft",
      },
    });

    assert.equal(created.project.id, upload.projectId);
    assert.equal(created.upload.id, upload.uploadId);
    assert.equal(adapter.getProject(upload.projectId).title, "SQLite Derby");
    assert.equal(adapter.getUpload(upload.uploadId).metadata.durationSeconds, 12);
    assert.equal(adapter.getArtifact(upload.uploadId).type, "upload");
    assert.doesNotMatch(JSON.stringify(adapter.publicUpload(created.upload)), /\/Users|\/private|storageKey|path/);

    closeAdapter(adapter);
    const restored = new SQLitePersistenceAdapter({ artifactAdapter, databasePath: dbPath });
    try {
      const summary = restored.restoreState();
      assert.equal(restored.getProject(upload.projectId).id, upload.projectId);
      assert.equal(restored.getUpload(upload.uploadId).id, upload.uploadId);
      assert.equal(summary.ignored, 0);
      assert.equal(summary.records >= 3, true);
    } finally {
      closeAdapter(restored);
    }
  } finally {
    upload.cleanup();
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite transactions rollback db rows and in-memory facades together", () => {
  const { adapter, databasePath: dbPath } = makeAdapter();
  const projectId = id("prj");
  const uploadId = id("upl");
  try {
    assert.throws(
      () =>
        adapter.transaction(() => {
          adapter.createProject({ id: projectId, uploadId, title: "Rollback", status: "draft" });
          throw new Error("synthetic failure");
        }),
      (error) => error.code === "DB_TRANSACTION_FAILED",
    );

    assert.equal(adapter.getProject(projectId), null);
    assert.equal(adapter.projects.has(projectId), false);
  } finally {
    closeAdapter(adapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite export creation rolls back and only exposes completed safe public records", () => {
  const { adapter, artifactAdapter, databasePath: dbPath } = makeAdapter();
  const projectId = id("prj");
  const uploadId = id("upl");
  const jobId = id("job");
  const exportId = id("exp");
  const upload = validUpload({ artifactAdapter, projectId, uploadId });
  const renderArtifact = artifactAdapter.writeBuffer({
    id: exportId,
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: jobId,
    storageKey: uniqueKey("sqlite-export"),
    buffer: Buffer.from("rendered"),
  });
  const outputPath = artifactAdapter.resolveArtifact(renderArtifact);
  try {
    adapter.createProjectUpload({
      upload: upload.record,
      project: { id: projectId, uploadId, title: "Export Derby", status: "draft" },
    });

    assert.throws(
      () =>
        adapter.transaction(() => {
          adapter.createExport({
            id: exportId,
            projectId,
            jobId,
            artifact: renderArtifact,
            outputPath,
            fileName: "export-derby.mp4",
          });
          throw new Error("rollback export");
        }),
      (error) => error.code === "DB_TRANSACTION_FAILED",
    );
    assert.equal(adapter.getExport(exportId), null);
    assert.equal(adapter.getArtifact(exportId), null);

    const exportRecord = adapter.createExport({
      id: exportId,
      projectId,
      jobId,
      artifact: renderArtifact,
      outputPath,
      fileName: "export-derby.mp4",
    });
    adapter.updateProject(projectId, { status: "ready" });
    adapter.persistRenderRecord({ project: adapter.getProject(projectId), job: { id: jobId }, exportRecord });

    assert.equal(adapter.getExport(exportId).id, exportId);
    assert.equal(adapter.getProject(projectId).status, "ready");
    assert.doesNotMatch(JSON.stringify(adapter.publicExport(exportRecord)), /\/Users|\/private|storageKey|outputPath|path/);
  } finally {
    upload.cleanup();
    cleanupPath(outputPath);
    closeAdapter(adapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite artifact records reject path traversal and unsafe database config", () => {
  const { adapter, databasePath: dbPath } = makeAdapter();
  try {
    assert.throws(
      () =>
        adapter.createArtifact({
          id: "artifact_bad_path_123456",
          type: "upload",
          storageKey: "safe.mp4",
          path: "/etc/passwd",
          status: "available",
        }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );
    assert.throws(() => validateDatabaseConfig({ adapter: "sqlite", fileName: "../bad.sqlite" }), /Invalid SQLite database file/);
    assert.throws(() => validateDatabaseConfig({ adapter: "postgres", fileName: "bad.sqlite" }), /Invalid MATCHCUTS_PERSISTENCE_ADAPTER/);
  } finally {
    closeAdapter(adapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite stores idempotency and sanitized job records without public leaks", () => {
  const { adapter, databasePath: dbPath } = makeAdapter();
  const projectId = id("prj");
  const uploadId = id("upl");
  const jobId = id("job");
  try {
    adapter.persistJob({
      id: jobId,
      projectId,
      uploadId,
      action: "generate",
      idempotencyKey: "sqlite-job-key-123456",
      status: "queued",
      progress: 0,
      step: "queued",
      payload: { title: "SQLite Derby", preset: "hype", language: "en" },
      outputPath: null,
      exportId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _controller: { shouldNotPersist: true },
    });

    assert.equal(adapter.getIdempotencyJobId("sqlite-job-key-123456"), jobId);
    const persisted = adapter.getPersistedJob(jobId);
    assert.equal(persisted.id, jobId);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, "_controller"), false);
    assert.doesNotMatch(JSON.stringify(adapter.health()), PUBLIC_LEAK_RE);
  } finally {
    closeAdapter(adapter);
    cleanupDatabase(dbPath);
  }
});

sqliteTest("sqlite persists regeneration drafts approvals and approval outbox events", () => {
  const { adapter, databasePath: dbPath } = makeAdapter();
  const projectId = id("prj");
  const sourceJobId = id("job");
  const sourceExportId = id("exp");
  const renderJobId = id("job");
  const completedExportId = id("exp");
  const regenerationPlanId = id("regen");
  const approvalId = "appr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const draftHash = "abcdefabcdefabcdefabcdefabcdefab";
  try {
    const draft = adapter.regenerationDraftRepository.createFromPlan({
      projectId,
      jobId: sourceJobId,
      exportId: sourceExportId,
      regenerationPlanId,
      draftHash,
      status: "draft",
      proposedChanges: ["captions"],
      safetyChecks: [{ code: "NO_FALSE_GOAL", status: "passed" }],
      proposedEditPlan: {
        aspectRatio: "9:16",
        highlightType: "big_chance",
        framingMode: "wide_safe",
        stylePreset: "social_sports_v1",
        styleTarget: "vertical_9_16",
        editIntensity: "balanced",
        sourceStart: 1,
        sourceEnd: 8,
        captions: [{ start: 0, end: 1, text: "/Users/example should never persist raw text" }],
      },
    });
    const approval = adapter.regenerationApprovalRepository.createIdempotent({
      approvalId,
      regenerationPlanId,
      draftHash,
      projectId,
      sourceJobId,
      sourceExportId,
      idempotencyKey: "sqliteapprovalkey123",
      approvedBy: "operator/manual/local",
      status: "approved",
      draftRecordId: draft.id,
    });
    const queued = adapter.regenerationApprovalRepository.markRenderQueued(approval.approvalId, renderJobId);
    const completed = adapter.regenerationApprovalRepository.markRenderCompleted(approval.approvalId, {
      jobId: renderJobId,
      exportId: completedExportId,
    });
    const outbox = adapter.approvalOutboxRepository.createLifecycleEvent({
      eventType: "render_completed",
      requestId: "req_sqlite_outbox",
      approvalRecord: completed,
      jobId: renderJobId,
      exportId: completedExportId,
    });

    assert.equal(queued.status, "render_queued");
    assert.equal(completed.completedExportId, completedExportId);
    assert.equal(adapter.regenerationDraftRepository.get(draft.id).id, draft.id);
    assert.equal(adapter.regenerationApprovalRepository.getByRenderJobId(renderJobId).approvalId, approvalId);
    assert.equal(adapter.approvalOutboxRepository.get(outbox.id).eventType, "render_completed");
    assert.doesNotMatch(JSON.stringify(adapter.regenerationDraftRepository.publicDraft(draft)), PUBLIC_LEAK_RE);
    assert.doesNotMatch(JSON.stringify(adapter.approvalOutboxRepository.publicEvent(outbox)), PUBLIC_LEAK_RE);

    closeAdapter(adapter);
    const restored = new SQLitePersistenceAdapter({ databasePath: dbPath });
    try {
      const summary = restored.restoreState();
      assert.equal(summary.draftAudits, 1);
      assert.equal(summary.approvalAudits, 1);
      assert.equal(summary.approvalOutbox, 1);
      assert.equal(restored.regenerationApprovalRepository.getByRenderJobId(renderJobId).status, "render_completed");
      assert.equal(restored.approvalOutboxRepository.listPending().length, 1);
      const claimed = restored.approvalOutboxRepository.claimDue({
        workerId: "obw_sqlite-worker-0001",
        nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].status, "processing");
      restored.approvalOutboxRepository.markDelivered(claimed[0].id, {
        workerId: "obw_sqlite-worker-0001",
        updatedAt: "2026-06-18T00:00:01.000Z",
      });
      assert.equal(restored.approvalOutboxRepository.get(outbox.id).status, "delivered");
      assert.equal(restored.health().repositories.approvalOutbox.ready, true);
      assert.equal(restored.health().repositories.approvalOutbox.statuses.delivered, 1);
      assert.doesNotMatch(JSON.stringify(restored.health()), PUBLIC_LEAK_RE);
    } finally {
      closeAdapter(restored);
    }
  } finally {
    cleanupDatabase(dbPath);
  }
});
