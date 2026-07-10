const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { SQLitePersistenceAdapter, SQLITE_AVAILABLE } = require("../server/adapters/sqlite-persistence-adapter.cjs");
const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { createLocalJobWorker } = require("../server/job-worker.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { storagePath } = require("../server/storage.cjs");

const PROJECT_ID = "prj_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const UPLOAD_ID = "upl_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_A = "wrk_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WORKER_B = "wrk_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const sqliteTest = SQLITE_AVAILABLE ? test : test.skip;

function tempJobDir() {
  return mkdtempSync(join(tmpdir(), "matchcuts-jobs-"));
}

function persistedJob(jobDir, jobId) {
  return JSON.parse(readFileSync(join(jobDir, `${jobId}.json`), "utf8"));
}

function createPersistentStore(jobDir, options = {}) {
  return new JobStore({
    persist: true,
    jobDir,
    logger: null,
    staleProcessingMs: 1000,
    maxAttempts: 2,
    ...options,
  });
}

function createJob(store, key = "persist-key", payload = {}) {
  return store.create({
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    action: "generate",
    idempotencyKey: key,
    payload: { title: "Derby Final", preset: "hype", language: "en", ...payload },
  });
}

function createWorkerRecords(uploadFileName = "worker.mp4") {
  return {
    projects: new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]),
    uploads: new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", uploadFileName) }]]),
    exportsById: new Map(),
  };
}

function cleanupPath(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort cleanup for test-owned files.
  }
}

function cleanupDatabase(databasePath) {
  cleanupPath(databasePath);
  cleanupPath(`${databasePath}-shm`);
  cleanupPath(`${databasePath}-wal`);
}

function tempDatabasePath() {
  mkdirSync(CONFIG.dbDir, { recursive: true });
  const filePath = storagePath("db", `jobstore-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  cleanupDatabase(filePath);
  return filePath;
}

function createDbJobStore(options = {}) {
  const databasePath = options.databasePath || tempDatabasePath();
  const adapter = new SQLitePersistenceAdapter({
    artifactAdapter: new LocalArtifactAdapter(),
    databasePath,
  });
  const store = createPersistentStore(options.jobDir || tempJobDir(), {
    persistenceAdapter: adapter,
    ...options.storeOptions,
  });
  return { adapter, databasePath, store };
}

function closeDbStore(adapter, databasePath) {
  if (adapter && typeof adapter.close === "function") adapter.close();
  cleanupDatabase(databasePath);
}

function insertRawJob(adapter, recordJson) {
  const now = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  adapter.prepare(
    `INSERT INTO jobs (
      id, projectId, uploadId, action, idempotencyKey, status, progress, step,
      errorJson, outputPath, exportId, payloadJson, createdAt, updatedAt, recordJson
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    PROJECT_ID,
    UPLOAD_ID,
    "generate",
    null,
    "queued",
    0,
    "queued",
    "null",
    null,
    null,
    "null",
    now,
    now,
    recordJson,
  );
  return jobId;
}

test("durable job store persists create/update and excludes controllers", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store);
  store.update(job, { status: "processing", progress: 33, step: "transcribe" });

  const raw = persistedJob(jobDir, job.id);
  assert.equal(raw.id, job.id);
  assert.equal(raw.projectId, PROJECT_ID);
  assert.equal(raw.uploadId, UPLOAD_ID);
  assert.equal(raw.status, "processing");
  assert.equal(raw.progress, 33);
  assert.equal(raw.attempts, 1);
  assert.equal(typeof raw.lastHeartbeatAt, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(raw, "_controller"), false);

  const publicJob = store.publicJob(job);
  assert.equal(Object.prototype.hasOwnProperty.call(publicJob, "_controller"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicJob, "outputPath"), false);
});

test("public job keeps safe render QA metadata from large edit plans", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "public-render-qa");
  store.update(job, { status: "processing", progress: 86, step: "render_short" });
  const manyPlanFields = Object.fromEntries(
    Array.from({ length: 36 }, (_, index) => [`field${index}`, `value-${index}`]),
  );
  store.complete(job, {
    exportId: "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc",
    editPlan: {
      ...manyPlanFields,
      mode: "multi_moment_compilation",
      stylePreset: "reference_football_multi_goal_v1",
      renderPolishQA: {
        contractVersion: 1,
        renderProfile: "proof_fast",
        encoderPreset: "ultrafast",
        encoderCrf: 28,
        renderStylePreset: "reference_football_multi_goal_v1",
        transitionRenderedCount: 2,
        hardCutFallbackCount: 0,
        animatedCaptionCount: 5,
        overlayRenderedCount: 5,
        cleanActionLayoutRequired: true,
        cleanActionLayoutPassed: true,
        actionLayoutMode: "ball_follow_with_synchronized_scorebug",
        fullHeightActionCrop: true,
        dynamicCropRendered: true,
        cropKeyframeCount: 22,
        maxPanSpeed: 0.18,
        trackingProviderMode: "ffmpeg-football-tracking",
        trackingConfidence: 0.92,
        ballCandidateConfidence: 0.88,
        playerClusterConfidence: 0.84,
        ballTrackCount: 12,
        playerClusterCount: 12,
        celebrationHeadTrackCount: 8,
        celebrationHeadKeyframeCount: 8,
        celebrationHeadTrackedGoalCount: 5,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: true,
        celebrationHeadFollowRendered: true,
        scoreboardOverlayRendered: true,
        scoreboardOverlayRegionId: "scorebug_broadcast_compact",
        sourceScoreboardDuplicateSuppressed: true,
        blurredBackgroundUsed: false,
        duplicateBackgroundUsed: false,
        splitLayoutCaptionCount: 0,
        renderPolishWarnings: [],
        outputPath: "/Users/operator/private/render.mp4",
      },
      visualPolishQA: {
        contractVersion: 1,
        countedGoalsIncluded: 3,
        replayOnlySegments: 0,
        visualPolishScore: 100,
      },
      editAssembly: {
        contractVersion: 1,
        segmentCount: 3,
        transitions: [{ fromSegmentId: "goal_1", toSegmentId: "goal_2" }],
      },
    },
  });

  const publicJob = store.publicJob(job);
  assert.equal(publicJob.editPlan.renderPolishQA.renderStylePreset, "reference_football_multi_goal_v1");
  assert.equal(publicJob.editPlan.renderPolishQA.transitionRenderedCount, 2);
  assert.equal(publicJob.editPlan.renderPolishQA.cleanActionLayoutPassed, true);
  assert.equal(publicJob.editPlan.renderPolishQA.sourceScoreboardDuplicateSuppressed, true);
  assert.equal(publicJob.editPlan.renderPolishQA.cropKeyframeCount, 22);
  assert.equal(publicJob.editPlan.renderPolishQA.celebrationHeadTrackedGoalCount, 5);
  assert.equal(publicJob.editPlan.renderPolishQA.celebrationHeadTrackingPassed, true);
  assert.equal(publicJob.editPlan.visualPolishQA.countedGoalsIncluded, 3);
  assert.equal(publicJob.editPlan.editAssembly.segmentCount, 3);
  assert.doesNotMatch(JSON.stringify(publicJob), /\/Users|OPENAI_API_KEY|storageKey|outputPath|localPath/i);
});

test("public job summary stays bounded for polling while preserving render proof metadata", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "public-summary");
  store.update(job, { status: "processing", progress: 86, step: "render_short" });
  store.complete(job, {
    exportId: "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd",
    editPlan: {
      mode: "multi_moment_compilation",
      highlightType: "goal",
      totalDuration: 142,
      stylePreset: "reference_football_multi_goal_v1",
      goalSelectionMode: "valid_goals_only",
      captions: Array.from({ length: 80 }, (_, index) => ({ text: `caption ${index}` })),
      animationCues: Array.from({ length: 80 }, (_, index) => ({ type: `cue_${index}` })),
      segments: Array.from({ length: 5 }, (_, index) => ({
        goalNumber: index + 1,
        highlightType: "goal",
        sourceStart: 100 + index * 20,
        sourceEnd: 116 + index * 20,
        duration: 16,
        phaseCoverage: { replayOnly: false },
      })),
      videoOutputQA: {
        status: "passed",
        passed: true,
        expectedGoalCount: 5,
        actualConfirmedGoalSegmentCount: 5,
        coveredGoalCount: 5,
        missingGoalNumbers: [],
      },
      renderPolishQA: {
        contractVersion: 1,
        renderProfile: "proof_fast",
        renderStylePreset: "reference_football_multi_goal_v1",
        cleanActionLayoutRequired: true,
        cleanActionLayoutPassed: true,
        actionLayoutMode: "ball_follow_with_synchronized_scorebug",
        fullHeightActionCrop: true,
        dynamicCropRendered: true,
        cropKeyframeCount: 22,
        maxPanSpeed: 0.18,
        trackingProviderMode: "ffmpeg-football-tracking",
        celebrationHeadTrackCount: 8,
        celebrationHeadKeyframeCount: 8,
        celebrationHeadTrackedGoalCount: 5,
        celebrationHeadTrackingRequired: true,
        celebrationHeadTrackingPassed: true,
        celebrationHeadFollowRendered: true,
        scoreboardOverlayRendered: true,
        scoreboardOverlayRegionId: "scorebug_broadcast_compact",
        sourceScoreboardDuplicateSuppressed: true,
      },
    },
    candidatePlans: Array.from({ length: 30 }, (_, index) => ({ id: `candidate_${index}`, body: "x".repeat(2000) })),
  });

  const summary = store.publicJobSummary(job);
  assert.equal(summary.status, "completed");
  assert.equal(summary.exportId, "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd");
  assert.equal(summary.renderPlanSummary.segmentCount, 5);
  assert.equal(summary.renderPlanSummary.videoOutputQA.coveredGoalCount, 5);
  assert.equal(summary.renderPlanSummary.renderPolishQA.cleanActionLayoutPassed, true);
  assert.equal(summary.renderPlanSummary.renderPolishQA.sourceScoreboardDuplicateSuppressed, true);
  assert.equal(summary.renderPlanSummary.renderPolishQA.cropKeyframeCount, 22);
  assert.equal(summary.renderPlanSummary.renderPolishQA.celebrationHeadTrackedGoalCount, 5);
  assert.equal(summary.renderPlanSummary.renderPolishQA.celebrationHeadTrackingPassed, true);
  assert.deepEqual(summary.renderPlanSummary.segments.map((segment) => segment.goalNumber), [1, 2, 3, 4, 5]);
  assert.equal(Object.hasOwn(summary, "editPlan"), false);
  assert.equal(Object.hasOwn(summary, "candidatePlans"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") < 12000);
  assert.doesNotMatch(JSON.stringify(summary), /\/Users|OPENAI_API_KEY|storageKey|outputPath|localPath/i);
});

test("job summaries and durable records preserve safe scoreboard OCR diagnostics", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "scoreboard-ocr-summary");
  const scoreboardOcr = {
    providerMode: "chunked-scoreboard-ocr",
    fallbackUsed: false,
    summary: {
      evidenceCount: 5,
      scoreChangeCount: 5,
      sampledFrameCount: 40,
      chunkSummary: {
        mode: "chunked_scorebug_first_ocr",
        chunkCount: 8,
        scannedChunks: 8,
        discoveredScoreChanges: 5,
      },
      scoreTimeline: [
        { timestamp: 236.25, status: "score_changed", scoreBefore: "0-0", scoreAfter: "1-0", temporalConsistency: true },
        { timestamp: 260.5, status: "score_changed", scoreBefore: "1-0", scoreAfter: "1-1", temporalConsistency: true },
      ],
    },
  };

  store.update(job, {
    status: "processing",
    progress: 30,
    step: "scoreboard_ocr_completed",
    scoreboardOcr,
  });
  store.fail(job, {
    code: "VIDEO_OUTPUT_QA_FAILED",
    userMessage: "The generated video plan did not cover the required valid goals.",
  });

  const summary = store.publicJobSummary(job);
  assert.equal(summary.scoreboardOcr.providerMode, "chunked-scoreboard-ocr");
  assert.equal(summary.scoreboardOcr.summary.scoreChangeCount, 5);
  assert.equal(summary.scoreboardOcr.summary.chunkSummary.discoveredScoreChanges, 5);

  const persisted = persistedJob(jobDir, job.id);
  assert.equal(persisted.scoreboardOcr.summary.evidenceCount, 5);
  assert.equal(persisted.scoreboardOcr.summary.scoreTimeline[1].scoreAfter, "1-1");

  const recoveredStore = createPersistentStore(jobDir);
  recoveredStore.recover();
  const recovered = recoveredStore.get(job.id);
  assert.equal(recovered.scoreboardOcr.summary.sampledFrameCount, 40);
  assert.doesNotMatch(JSON.stringify(summary), /\/Users|OPENAI_API_KEY|storageKey|outputPath|localPath|rawText|stdout|stderr/i);
});

test("idempotency survives durable store reload", () => {
  const jobDir = tempJobDir();
  const firstStore = createPersistentStore(jobDir);
  const first = createJob(firstStore, "same-after-reload");

  const secondStore = createPersistentStore(jobDir);
  const summary = secondStore.recover();
  const second = createJob(secondStore, "same-after-reload");

  assert.equal(summary.records, 1);
  assert.equal(second.id, first.id);
  assert.equal(secondStore.get(first.id).id, first.id);
});

test("job payload persistence preserves style target edit intensity and render style", () => {
  const jobDir = tempJobDir();
  const firstStore = createPersistentStore(jobDir);
  const first = firstStore.create({
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    action: "generate",
    idempotencyKey: "style-settings",
    payload: {
      title: "Derby Final",
      preset: "hype",
      language: "el",
      styleTarget: "square_1_1",
      editIntensity: "punchy",
      stylePreset: "punchy_highlight",
    },
  });

  const raw = persistedJob(jobDir, first.id);
  assert.equal(raw.payload.styleTarget, "square_1_1");
  assert.equal(raw.payload.editIntensity, "punchy");
  assert.equal(raw.payload.stylePreset, "punchy_highlight");

  const secondStore = createPersistentStore(jobDir);
  const summary = secondStore.recover();
  const recovered = secondStore.get(first.id);

  assert.equal(summary.records, 1);
  assert.equal(recovered.payload.styleTarget, "square_1_1");
  assert.equal(recovered.payload.editIntensity, "punchy");
  assert.equal(recovered.payload.stylePreset, "punchy_highlight");
});

test("recovery requeues stale processing jobs and keeps terminal jobs terminal", () => {
  const jobDir = tempJobDir();
  const firstStore = createPersistentStore(jobDir);
  const stale = createJob(firstStore, "stale-processing");
  firstStore.update(stale, {
    status: "processing",
    progress: 42,
    step: "render_short",
    lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
  });

  const completed = createJob(firstStore, "terminal-completed");
  firstStore.update(completed, { status: "processing", progress: 20, step: "render_short" });
  firstStore.complete(completed, {
    exportId: "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc",
    outputPath: storagePath("renders", "terminal-completed.mp4"),
  });

  const recoveredStore = createPersistentStore(jobDir);
  const summary = recoveredStore.recover({ nowMs: Date.parse("2026-01-01T00:00:00.000Z") });
  const recoveredStale = recoveredStore.get(stale.id);
  const recoveredCompleted = recoveredStore.get(completed.id);

  assert.equal(summary.records, 2);
  assert.equal(recoveredStale.status, "queued");
  assert.equal(recoveredStale.error.code, "JOB_RETRY_SCHEDULED");
  assert.equal(recoveredCompleted.status, "completed");
  assert.equal(recoveredCompleted.exportId, "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc");
});

test("stale processing jobs fail after max attempts", () => {
  const jobDir = tempJobDir();
  const firstStore = createPersistentStore(jobDir);
  const job = createJob(firstStore, "stale-max-attempts");
  firstStore.update(job, {
    status: "processing",
    progress: 50,
    step: "render_short",
    attempts: 2,
    lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
  });

  const recoveredStore = createPersistentStore(jobDir, { maxAttempts: 2 });
  recoveredStore.recover({ nowMs: Date.parse("2026-01-01T00:00:00.000Z") });
  const recovered = recoveredStore.get(job.id);

  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "JOB_STALE");
});

test("corrupt and unsafe persisted job records are ignored safely", () => {
  const jobDir = tempJobDir();
  writeFileSync(join(jobDir, "job_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json"), "{not-json", "utf8");
  writeFileSync(
    join(jobDir, "job_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.json"),
    JSON.stringify({ id: "../bad", projectId: PROJECT_ID, status: "queued" }),
    "utf8",
  );

  const store = createPersistentStore(jobDir);
  const summary = store.recover();

  assert.equal(summary.records, 0);
  assert.equal(summary.ignored, 2);
  assert.throws(() => store.get("../bad"), (error) => error.code === "RESOURCE_ID_INVALID");
});

test("worker processes queued durable jobs with mocked render", async () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "worker-success", {
    styleTarget: "square_1_1",
    editIntensity: "punchy",
    stylePreset: "punchy_highlight",
  });
  const projects = new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]);
  const uploads = new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", "worker.mp4") }]]);
  const exportsById = new Map();
  let observedPayload = null;
  const worker = createLocalJobWorker({
    jobs: store,
    projects,
    uploads,
    exportsById,
    dependencies: {
      logger: null,
      runRenderJob: async ({ jobs, job: runningJob, payload }) => {
        observedPayload = payload;
        jobs.complete(runningJob, {
          exportId: "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd",
          outputPath: storagePath("renders", "worker-success.mp4"),
        });
      },
    },
  });

  await worker.process(job, { requestId: "req_worker_test" });
  const raw = persistedJob(jobDir, job.id);

  assert.equal(job.status, "completed");
  assert.equal(raw.status, "completed");
  assert.equal(raw.attempts, 1);
  assert.equal(raw.exportId, "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd");
  assert.equal(observedPayload.styleTarget, "square_1_1");
  assert.equal(observedPayload.editIntensity, "punchy");
  assert.equal(observedPayload.stylePreset, "punchy_highlight");
});

test("worker failures increment attempts and persist safe failed state", async () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "worker-failure");
  const projects = new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]);
  const uploads = new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", "worker-fail.mp4") }]]);
  const exportsById = new Map();
  const worker = createLocalJobWorker({
    jobs: store,
    projects,
    uploads,
    exportsById,
    dependencies: {
      logger: null,
      runRenderJob: async () => {
        throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, {
          stderr: "/Users/example OPENAI_API_KEY=secret",
        });
      },
    },
  });

  await worker.process(job, { requestId: "req_worker_failure" });
  const raw = persistedJob(jobDir, job.id);

  assert.equal(job.status, "failed");
  assert.equal(raw.status, "failed");
  assert.equal(raw.attempts, 1);
  assert.equal(raw.error.code, "RENDER_FAILED");
  assert.doesNotMatch(JSON.stringify(raw), /OPENAI_API_KEY|secret/);
});

test("worker heartbeat renews the active lease during processing and clears its timer", async () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir, { leaseDurationMs: 2000 });
  const job = createJob(store, "worker-heartbeat-renew");
  const { projects, uploads, exportsById } = createWorkerRecords("worker-heartbeat.mp4");
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  let heartbeatTick = null;
  let intervalSeen = null;
  let clearedTimer = null;
  let unrefCalled = false;
  const timer = { unref: () => { unrefCalled = true; } };
  const worker = createLocalJobWorker({
    jobs: store,
    projects,
    uploads,
    exportsById,
    dependencies: {
      workerId: WORKER_A,
      logger: null,
      heartbeatIntervalMs: 500,
      nowMs: () => now,
      setHeartbeatInterval: (fn, intervalMs) => {
        heartbeatTick = fn;
        intervalSeen = intervalMs;
        return timer;
      },
      clearHeartbeatInterval: (handle) => {
        clearedTimer = handle;
      },
      runRenderJob: async ({ jobs, job: runningJob }) => {
        const firstExpiry = Date.parse(runningJob.leaseExpiresAt);
        now += 600;
        await heartbeatTick();
        assert.equal(runningJob.status, "processing");
        assert.equal(Date.parse(runningJob.leaseExpiresAt), now + 2000);
        assert.ok(Date.parse(runningJob.leaseExpiresAt) > firstExpiry);
        jobs.complete(runningJob, {
          exportId: "exp_eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
          outputPath: storagePath("renders", "worker-heartbeat.mp4"),
        });
      },
    },
  });

  const health = worker.health();
  assert.equal(health.workerId, WORKER_A);
  assert.equal(health.heartbeat.enabled, true);
  assert.equal(health.heartbeat.intervalMs, 500);
  assert.equal(health.heartbeat.leaseDurationMs, 2000);

  await worker.process(job, { requestId: "req_worker_heartbeat" });
  const raw = persistedJob(jobDir, job.id);

  assert.equal(intervalSeen, 500);
  assert.equal(unrefCalled, true);
  assert.equal(clearedTimer, timer);
  assert.equal(job.status, "completed");
  assert.equal(raw.status, "completed");
  assert.equal(raw.lastHeartbeatAt, "2030-01-01T00:00:00.600Z");
  assert.doesNotMatch(JSON.stringify(health), /\/Users|\/private|storageKey|outputPath|secret/i);
});

test("worker heartbeat aborts stale processing when the lease is lost", async () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir, { leaseDurationMs: 2000 });
  const job = createJob(store, "worker-heartbeat-lost-lease");
  const { projects, uploads, exportsById } = createWorkerRecords("worker-heartbeat-lost.mp4");
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  let heartbeatTick = null;
  let clearCount = 0;
  let staleWriteRejected = false;
  const worker = createLocalJobWorker({
    jobs: store,
    projects,
    uploads,
    exportsById,
    dependencies: {
      workerId: WORKER_A,
      logger: null,
      heartbeatIntervalMs: 500,
      nowMs: () => now,
      setHeartbeatInterval: (fn) => {
        heartbeatTick = fn;
        return "timer";
      },
      clearHeartbeatInterval: () => {
        clearCount += 1;
      },
      runRenderJob: async ({ jobs, job: runningJob }) => {
        store.update(runningJob, {
          workerId: WORKER_B,
          leaseId: "lease_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
          leaseExpiresAt: new Date(now + 2000).toISOString(),
        });
        await heartbeatTick();
        assert.equal(runningJob._controller.signal.aborted, true);
        assert.throws(
          () => jobs.complete(runningJob, {
            exportId: "exp_ffffffff-ffff-4fff-ffff-ffffffffffff",
            outputPath: storagePath("renders", "stale-worker-heartbeat.mp4"),
          }),
          (error) => error.code === "JOB_LEASE_INVALID",
        );
        staleWriteRejected = true;
        throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
      },
    },
  });

  await worker.process(job, { requestId: "req_worker_heartbeat_lost" });
  const raw = persistedJob(jobDir, job.id);

  assert.equal(staleWriteRejected, true);
  assert.equal(clearCount, 1);
  assert.equal(job.status, "processing");
  assert.equal(job.workerId, WORKER_B);
  assert.equal(job.exportId, null);
  assert.equal(raw.status, "processing");
  assert.equal(raw.workerId, WORKER_B);
  assert.equal(raw.exportId, null);
  assert.equal(worker.running.size, 0);
});

test("cancellation persists and idempotent reload returns the cancelled job", () => {
  const jobDir = tempJobDir();
  const firstStore = createPersistentStore(jobDir);
  const job = createJob(firstStore, "cancel-reload");
  firstStore.update(job, { status: "processing", progress: 10, step: "analyze_media" });
  firstStore.cancel(job.id);

  const secondStore = createPersistentStore(jobDir);
  secondStore.recover();
  const same = createJob(secondStore, "cancel-reload");
  const raw = persistedJob(jobDir, job.id);

  assert.equal(same.id, job.id);
  assert.equal(same.status, "cancelled");
  assert.equal(raw.status, "cancelled");
  assert.equal(raw.error.code, "JOB_CANCELLED");
});

test("claiming leases queued jobs and blocks a second active worker", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "claim-once");
  const claim = store.claimJob(job.id, { workerId: WORKER_A });

  assert.equal(claim.job.id, job.id);
  assert.equal(job.status, "processing");
  assert.equal(job.workerId, WORKER_A);
  assert.equal(job.leaseId, claim.lease.leaseId);
  assert.equal(job.attempts, 1);
  assert.throws(() => store.claimJob(job.id, { workerId: WORKER_B }), (error) => error.code === "JOB_LEASE_INVALID");

  const publicJob = store.publicJob(job);
  assert.equal(Object.prototype.hasOwnProperty.call(publicJob, "workerId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicJob, "leaseId"), false);

  const health = store.health();
  assert.equal(health.claimingSupported, true);
  assert.equal(health.activeLeases, 1);
  assert.equal(health.expiredLeases, 0);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|\/private|storageKey|outputPath|filePath|secret/i);
});

test("expired leases can be reclaimed and stale workers cannot write terminal states", () => {
  const base = Date.now();
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir, { leaseDurationMs: 1000, maxAttempts: 3 });
  const job = createJob(store, "claim-expired");
  const first = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  const second = store.claimJob(job.id, { workerId: WORKER_B, nowMs: base + 1500, leaseMs: 1000 });

  assert.equal(second.job.id, job.id);
  assert.equal(job.workerId, WORKER_B);
  assert.equal(job.attempts, 2);
  assert.throws(
    () => store.completeWithLease(job, { exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", outputPath: storagePath("renders", "stale-worker.mp4") }, first.lease, { nowMs: base + 1500 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
  assert.throws(
    () => store.failWithLease(job, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500), first.lease, { nowMs: base + 1500 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );

  store.completeWithLease(job, {
    exportId: "exp_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    outputPath: storagePath("renders", "fresh-worker.mp4"),
  }, second.lease, { nowMs: base + 1500 });
  assert.equal(job.status, "completed");
  assert.equal(job.workerId, null);
  assert.equal(job.leaseId, null);
});

test("lease heartbeat renews only for the matching worker lease", () => {
  const base = Date.now();
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir, { leaseDurationMs: 1000 });
  const job = createJob(store, "heartbeat-lease");
  const claim = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  const originalExpiry = job.leaseExpiresAt;

  store.heartbeatWithLease(job, claim.lease, { nowMs: base + 500, leaseMs: 2000 });
  assert.notEqual(job.leaseExpiresAt, originalExpiry);
  assert.equal(Date.parse(job.leaseExpiresAt), base + 2500);
  assert.throws(
    () => store.heartbeatWithLease(job, { ...claim.lease, workerId: WORKER_B }, { nowMs: base + 600 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
});

test("queued jobs with future retry schedule cannot be claimed early", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir, { leaseDurationMs: 1000 });
  const job = createJob(store, "future-retry-claim");
  store.update(job, {
    nextRetryAt: new Date(base + 5000).toISOString(),
    backoffMs: 5000,
    error: { code: "JOB_RETRY_SCHEDULED", message: SAFE_MESSAGES.JOB_RETRY_SCHEDULED },
  });

  assert.throws(
    () => store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );

  const claim = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base + 5000, leaseMs: 1000 });
  assert.equal(claim.job.status, "processing");
  assert.equal(claim.job.nextRetryAt, null);
  assert.equal(claim.job.backoffMs, null);
});

test("cancellation clears the active lease and blocks stale completion", () => {
  const base = Date.now();
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "cancel-active-lease");
  const claim = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base });
  store.cancel(job.id);

  assert.equal(job.status, "cancelled");
  assert.equal(job.workerId, null);
  assert.throws(
    () => store.completeWithLease(job, { exportId: "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc", outputPath: storagePath("renders", "cancelled.mp4") }, claim.lease, { nowMs: base + 1 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
});

test("terminal jobs cannot be claimed", () => {
  const jobDir = tempJobDir();
  const store = createPersistentStore(jobDir);
  const job = createJob(store, "terminal-claim");
  store.update(job, { status: "processing", progress: 5 });
  store.complete(job, {
    exportId: "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd",
    outputPath: storagePath("renders", "terminal-claim.mp4"),
  });

  assert.throws(() => store.claimJob(job.id, { workerId: WORKER_A }), (error) => error.code === "JOB_STATE_INVALID");
});

sqliteTest("DB-backed JobStore persists lifecycle updates and safe failures", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const job = createJob(store, "db-lifecycle");
    store.update(job, { status: "processing", progress: 45, step: "transcribe" });
    assert.equal(adapter.getPersistedJob(job.id).status, "processing");
    assert.equal(adapter.getPersistedJob(job.id).progress, 45);

    store.complete(job, {
      exportId: "exp_11111111-1111-4111-8111-111111111111",
      outputPath: storagePath("renders", "db-lifecycle.mp4"),
    });
    assert.equal(adapter.getPersistedJob(job.id).status, "completed");
    assert.equal(adapter.getPersistedJob(job.id).exportId, "exp_11111111-1111-4111-8111-111111111111");

    const failed = createJob(store, "db-failure");
    store.update(failed, { status: "processing", progress: 10 });
    store.fail(failed, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, {
      stderr: "/Users/example OPENAI_API_KEY=secret",
    }));
    const persistedFailed = adapter.getPersistedJob(failed.id);
    assert.equal(persistedFailed.status, "failed");
    assert.equal(persistedFailed.error.code, "RENDER_FAILED");
    assert.doesNotMatch(JSON.stringify(persistedFailed), /OPENAI_API_KEY|secret|\/Users/);

    const cancelled = createJob(store, "db-cancel");
    store.cancel(cancelled.id);
    assert.equal(adapter.getPersistedJob(cancelled.id).status, "cancelled");

    const health = store.health();
    assert.equal(health.mode, "adapter");
    assert.equal(health.backend, "sqlite");
    assert.equal(health.repository.ready, true);
    assert.doesNotMatch(JSON.stringify(health), /\/Users|\/private|storageKey|outputPath|filePath|secret/i);
  } finally {
    closeDbStore(adapter, databasePath);
  }
});

sqliteTest("DB-backed atomic claim blocks active workers and allows expired reclaim", () => {
  const base = Date.now();
  const { adapter, databasePath, store } = createDbJobStore({ storeOptions: { leaseDurationMs: 1000, maxAttempts: 3 } });
  try {
    const job = createJob(store, "db-atomic-claim");
    const first = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
    assert.equal(adapter.getPersistedJob(job.id).workerId, WORKER_A);

    const secondAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const secondStore = createPersistentStore(tempJobDir(), {
        persistenceAdapter: secondAdapter,
        leaseDurationMs: 1000,
        maxAttempts: 3,
      });
      assert.throws(
        () => secondStore.claimJob(job.id, { workerId: WORKER_B, nowMs: base + 500, leaseMs: 1000 }),
        (error) => error.code === "JOB_LEASE_INVALID",
      );

      const second = secondStore.claimJob(job.id, { workerId: WORKER_B, nowMs: base + 1500, leaseMs: 1000 });
      assert.equal(second.job.workerId, WORKER_B);
      assert.equal(second.job.attempts, 2);
      assert.equal(secondAdapter.getPersistedJob(job.id).workerId, WORKER_B);

      assert.throws(
        () => store.completeWithLease(job, { exportId: "exp_55555555-5555-4555-8555-555555555555", outputPath: storagePath("renders", "db-stale-worker.mp4") }, first.lease, { nowMs: base + 1500 }),
        (error) => error.code === "JOB_LEASE_INVALID",
      );
      assert.equal(secondAdapter.getPersistedJob(job.id).status, "processing");
      assert.equal(secondAdapter.getPersistedJob(job.id).workerId, WORKER_B);

      secondStore.completeWithLease(second.job, {
        exportId: "exp_66666666-6666-4666-8666-666666666666",
        outputPath: storagePath("renders", "db-fresh-worker.mp4"),
      }, second.lease, { nowMs: base + 1500 });
      const completed = secondAdapter.getPersistedJob(job.id);
      assert.equal(completed.status, "completed");
      assert.equal(completed.workerId, null);
      assert.equal(completed.leaseId, null);
    } finally {
      secondAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});

sqliteTest("DB-backed heartbeat and failure require the active lease holder", () => {
  const base = Date.now();
  const { adapter, databasePath, store } = createDbJobStore({ storeOptions: { leaseDurationMs: 1000 } });
  try {
    const job = createJob(store, "db-heartbeat-guard");
    const claim = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
    store.heartbeatWithLease(job, claim.lease, { nowMs: base + 500, leaseMs: 2000 });
    assert.equal(Date.parse(adapter.getPersistedJob(job.id).leaseExpiresAt), base + 2500);

    assert.throws(
      () => store.failWithLease(job, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500), { ...claim.lease, leaseId: "lease_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }, { nowMs: base + 600 }),
      (error) => error.code === "JOB_LEASE_INVALID",
    );
    assert.equal(adapter.getPersistedJob(job.id).status, "processing");

    store.cancel(job.id);
    assert.throws(
      () => store.completeWithLease(job, { exportId: "exp_77777777-7777-4777-8777-777777777777", outputPath: storagePath("renders", "db-cancelled.mp4") }, claim.lease, { nowMs: base + 700 }),
      (error) => error.code === "JOB_LEASE_INVALID",
    );
    assert.equal(adapter.getPersistedJob(job.id).status, "cancelled");
  } finally {
    closeDbStore(adapter, databasePath);
  }
});

sqliteTest("DB-backed claim respects future retry schedules", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { adapter, databasePath, store } = createDbJobStore({ storeOptions: { leaseDurationMs: 1000 } });
  try {
    const job = createJob(store, "db-future-retry-claim");
    store.update(job, {
      nextRetryAt: new Date(base + 5000).toISOString(),
      backoffMs: 5000,
      error: { code: "JOB_RETRY_SCHEDULED", message: SAFE_MESSAGES.JOB_RETRY_SCHEDULED },
    });

    assert.throws(
      () => store.claimJob(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 }),
      (error) => error.code === "JOB_LEASE_INVALID",
    );

    const claim = store.claimJob(job.id, { workerId: WORKER_A, nowMs: base + 5000, leaseMs: 1000 });
    assert.equal(claim.job.status, "processing");
    assert.equal(adapter.getPersistedJob(job.id).nextRetryAt, null);
    assert.equal(adapter.getPersistedJob(job.id).backoffMs, null);
  } finally {
    closeDbStore(adapter, databasePath);
  }
});

sqliteTest("DB-backed idempotency survives reload without JSON recovery", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const first = createJob(store, "db-same-after-reload");
    adapter.close();

    const reloadedAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const reloadedStore = createPersistentStore(tempJobDir(), { persistenceAdapter: reloadedAdapter });
      const summary = reloadedStore.recover();
      const second = createJob(reloadedStore, "db-same-after-reload");

      assert.equal(summary.records, 1);
      assert.equal(second.id, first.id);
      assert.equal(reloadedStore.get(first.id).id, first.id);
      assert.equal(reloadedAdapter.getIdempotencyJobId("db-same-after-reload"), first.id);
    } finally {
      reloadedAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});

sqliteTest("DB-backed recovery requeues stale processing jobs and keeps terminal jobs terminal", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const stale = createJob(store, "db-stale-processing");
    store.update(stale, {
      status: "processing",
      progress: 42,
      step: "render_short",
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    const exhausted = createJob(store, "db-stale-max");
    store.update(exhausted, {
      status: "processing",
      progress: 50,
      step: "render_short",
      attempts: 2,
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    const completed = createJob(store, "db-terminal-completed");
    store.update(completed, { status: "processing", progress: 20, step: "render_short" });
    store.complete(completed, {
      exportId: "exp_22222222-2222-4222-8222-222222222222",
      outputPath: storagePath("renders", "db-terminal-completed.mp4"),
    });
    adapter.close();

    const recoveredAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const recoveredStore = createPersistentStore(tempJobDir(), {
        persistenceAdapter: recoveredAdapter,
        maxAttempts: 2,
      });
      const summary = recoveredStore.recover({ nowMs: Date.parse("2026-01-01T00:00:00.000Z") });

      assert.equal(summary.records, 3);
      assert.equal(summary.queued, 1);
      assert.equal(summary.failed, 1);
      assert.equal(summary.terminal, 1);
      assert.equal(recoveredStore.get(stale.id).status, "queued");
      assert.equal(recoveredStore.get(stale.id).error.code, "JOB_RETRY_SCHEDULED");
      assert.equal(recoveredStore.get(exhausted.id).status, "failed");
      assert.equal(recoveredStore.get(exhausted.id).error.code, "JOB_STALE");
      assert.equal(recoveredStore.get(completed.id).status, "completed");
      assert.throws(() => recoveredStore.update(recoveredStore.get(completed.id), { progress: 80 }), (error) => error.code === "JOB_STATE_INVALID");
      assert.equal(recoveredAdapter.getPersistedJob(stale.id).status, "queued");
      assert.equal(recoveredAdapter.getPersistedJob(exhausted.id).status, "failed");
    } finally {
      recoveredAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});

sqliteTest("DB-backed recovery ignores corrupt and unsafe job records safely", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const valid = createJob(store, "db-valid-record");
    insertRawJob(adapter, "{not-json");
    insertRawJob(adapter, JSON.stringify({
      id: `job_${randomUUID()}`,
      projectId: PROJECT_ID,
      uploadId: UPLOAD_ID,
      action: "generate",
      status: "queued",
      progress: 0,
      outputPath: "/etc/passwd",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    adapter.close();

    const recoveredAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const recoveredStore = createPersistentStore(tempJobDir(), { persistenceAdapter: recoveredAdapter });
      const summary = recoveredStore.recover();

      assert.equal(summary.records, 1);
      assert.equal(summary.ignored, 2);
      assert.equal(recoveredStore.get(valid.id).id, valid.id);
      assert.throws(() => recoveredStore.get("../bad"), (error) => error.code === "RESOURCE_ID_INVALID");
    } finally {
      recoveredAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});

sqliteTest("DB-backed JobStore rejects unsafe output paths and rolls back runtime state", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const job = createJob(store, "db-unsafe-output");
    store.update(job, { status: "processing", progress: 10 });
    assert.throws(
      () => store.complete(job, { outputPath: "/etc/passwd", exportId: "exp_33333333-3333-4333-8333-333333333333" }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );

    assert.equal(job.status, "processing");
    assert.equal(adapter.getPersistedJob(job.id).status, "processing");
    assert.equal(adapter.getPersistedJob(job.id).exportId, null);
  } finally {
    closeDbStore(adapter, databasePath);
  }
});

sqliteTest("worker processes recovered DB-backed queued jobs and persists completion", async () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const job = createJob(store, "db-worker-success");
    adapter.close();

    const recoveredAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const recoveredStore = createPersistentStore(tempJobDir(), { persistenceAdapter: recoveredAdapter });
      recoveredStore.recover();
      const recoveredJob = recoveredStore.get(job.id);
      const worker = createLocalJobWorker({
        jobs: recoveredStore,
        projects: new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]),
        uploads: new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", "worker-db.mp4") }]]),
        exportsById: new Map(),
        dependencies: {
          logger: null,
          runRenderJob: async ({ jobs, job: runningJob }) => {
            jobs.complete(runningJob, {
              exportId: "exp_44444444-4444-4444-8444-444444444444",
              outputPath: storagePath("renders", "worker-db-success.mp4"),
            });
          },
        },
      });

      await worker.process(recoveredJob, { requestId: "req_worker_db_success" });

      assert.equal(recoveredJob.status, "completed");
      assert.equal(recoveredAdapter.getPersistedJob(job.id).status, "completed");
      assert.equal(recoveredAdapter.getPersistedJob(job.id).exportId, "exp_44444444-4444-4444-8444-444444444444");
    } finally {
      recoveredAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});

sqliteTest("worker failures persist safe failed state in DB-backed mode", async () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const job = createJob(store, "db-worker-failure");
    const worker = createLocalJobWorker({
      jobs: store,
      projects: new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]),
      uploads: new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", "worker-db-fail.mp4") }]]),
      exportsById: new Map(),
      dependencies: {
        logger: null,
        runRenderJob: async () => {
          throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, {
            stderr: "/Users/example OPENAI_API_KEY=secret",
          });
        },
      },
    });

    await worker.process(job, { requestId: "req_worker_db_failure" });
    const persisted = adapter.getPersistedJob(job.id);

    assert.equal(job.status, "failed");
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error.code, "RENDER_FAILED");
    assert.doesNotMatch(JSON.stringify(persisted), /\/Users|OPENAI_API_KEY|secret/);
  } finally {
    closeDbStore(adapter, databasePath);
  }
});

sqliteTest("DB-backed cancellation persists and idempotent reload returns cancelled job", () => {
  const { adapter, databasePath, store } = createDbJobStore();
  try {
    const job = createJob(store, "db-cancel-reload");
    store.update(job, { status: "processing", progress: 10, step: "analyze_media" });
    store.cancel(job.id);
    adapter.close();

    const recoveredAdapter = new SQLitePersistenceAdapter({
      artifactAdapter: new LocalArtifactAdapter(),
      databasePath,
    });
    try {
      const recoveredStore = createPersistentStore(tempJobDir(), { persistenceAdapter: recoveredAdapter });
      recoveredStore.recover();
      const same = createJob(recoveredStore, "db-cancel-reload");

      assert.equal(same.id, job.id);
      assert.equal(same.status, "cancelled");
      assert.equal(recoveredAdapter.getPersistedJob(job.id).status, "cancelled");
    } finally {
      recoveredAdapter.close();
    }
  } finally {
    cleanupDatabase(databasePath);
  }
});
