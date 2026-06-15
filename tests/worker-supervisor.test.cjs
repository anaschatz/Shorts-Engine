const test = require("node:test");
const assert = require("node:assert/strict");

const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { createLocalJobWorker } = require("../server/job-worker.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { createLocalJobQueue } = require("../server/queue/local-job-queue.cjs");
const { storagePath } = require("../server/storage.cjs");
const { createWorkerSupervisor } = require("../server/worker-supervisor.cjs");

const PROJECT_ID = "prj_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const UPLOAD_ID = "upl_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_ID = "wrk_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, timeoutMs = 250) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for supervisor test condition.");
    }
    await tick();
  }
}

function createJob(store, key = `supervisor-${Math.random().toString(16).slice(2)}`) {
  return store.create({
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    action: "generate",
    idempotencyKey: key,
    payload: { title: "Derby Final", preset: "hype", language: "en" },
  });
}

function createRecords(uploadFileName = "supervisor.mp4") {
  return {
    projects: new Map([[PROJECT_ID, { id: PROJECT_ID, uploadId: UPLOAD_ID, title: "Derby Final", status: "draft" }]]),
    uploads: new Map([[UPLOAD_ID, { id: UPLOAD_ID, projectId: PROJECT_ID, metadata: { durationSeconds: 12 }, path: storagePath("uploads", uploadFileName) }]]),
    exportsById: new Map(),
  };
}

function createContext(options = {}) {
  const store = new JobStore({ maxAttempts: options.maxAttempts || 2, leaseDurationMs: options.leaseDurationMs || 2000 });
  const records = createRecords(options.uploadFileName);
  const logs = [];
  const logger = {
    info(line) {
      logs.push(JSON.parse(line));
    },
    warn(line) {
      logs.push(JSON.parse(line));
    },
  };
  const renderCalls = [];
  const queue = createLocalJobQueue({ jobs: store, logger: null });
  const worker = createLocalJobWorker({
    jobs: store,
    queue,
    projects: records.projects,
    uploads: records.uploads,
    exportsById: records.exportsById,
    dependencies: {
      workerId: WORKER_ID,
      logger: null,
      heartbeatIntervalMs: 0,
      nowMs: options.dependencies && options.dependencies.nowMs,
      runRenderJob: async (context) => {
        renderCalls.push(context.job.id);
        if (options.runRenderJob) return await options.runRenderJob(context, { renderCalls });
        context.jobs.complete(context.job, {
          exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          outputPath: storagePath("renders", "supervisor-success.mp4"),
        });
        return undefined;
      },
    },
  });
  const supervisor = createWorkerSupervisor({
    jobs: store,
    queue,
    worker,
    logger,
    options: {
      pollIntervalMs: 0,
      shutdownTimeoutMs: 100,
      retryPolicy: {
        initialDelayMs: 50,
        maxDelayMs: 50,
        maxAttempts: options.maxAttempts || 2,
        ...(options.retryPolicy || {}),
      },
      ...(options.supervisorOptions || {}),
    },
    dependencies: {
      scheduler: (fn) => fn(),
      ...(options.dependencies || {}),
    },
  });
  return { logs, queue, records, renderCalls, store, supervisor, worker };
}

test("worker supervisor starts queued jobs and stops cleanly", async () => {
  const context = createContext();
  const job = createJob(context.store, "supervisor-start-stop");

  const start = context.supervisor.start({ requestId: "req_supervisor_start" });
  await context.supervisor.waitForIdle({ timeoutMs: 250 });
  const stopped = await context.supervisor.stop({ requestId: "req_supervisor_stop" });

  assert.equal(start.state, "running");
  assert.equal(job.status, "completed");
  assert.equal(context.renderCalls.length, 1);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.retry.scheduled, 0);
  assert.equal(context.logs.some((entry) => entry.event === "supervisor_started"), true);
  assert.equal(context.logs.some((entry) => entry.event === "supervisor_stopped"), true);
});

test("drain mode blocks new jobs while active work continues", async () => {
  let releaseRender;
  const renderReleased = new Promise((resolve) => {
    releaseRender = resolve;
  });
  const context = createContext({
    runRenderJob: async ({ jobs, job }) => {
      await renderReleased;
      jobs.complete(job, {
        exportId: "exp_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        outputPath: storagePath("renders", "supervisor-drain.mp4"),
      });
    },
  });
  const activeJob = createJob(context.store, "supervisor-drain-active");
  context.supervisor.start({ requestId: "req_supervisor_drain_start" });
  await waitUntil(() => context.supervisor.health().activeJobs === 1);

  const drainHealth = context.supervisor.drain({ requestId: "req_supervisor_drain" });
  const blockedJob = createJob(context.store, "supervisor-drain-blocked");
  context.supervisor.enqueue(blockedJob, { requestId: "req_supervisor_blocked" });

  assert.equal(drainHealth.state, "draining");
  assert.equal(drainHealth.drainMode, true);
  assert.equal(blockedJob.status, "queued");
  assert.equal(context.renderCalls.length, 1);

  releaseRender();
  await context.supervisor.waitForIdle({ timeoutMs: 250 });
  await context.supervisor.stop({ requestId: "req_supervisor_drain_stop" });

  assert.equal(activeJob.status, "completed");
  assert.equal(blockedJob.status, "queued");
});

test("shutdown timeout aborts active jobs safely and clears timers", async () => {
  let observedAbort = false;
  const context = createContext({
    runRenderJob: async ({ job }) => {
      await new Promise((resolve, reject) => {
        job._controller.signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
        }, { once: true });
      });
    },
  });
  const job = createJob(context.store, "supervisor-shutdown-timeout");
  context.supervisor.start({ requestId: "req_supervisor_timeout_start" });
  await waitUntil(() => context.supervisor.health().activeJobs === 1);

  await context.supervisor.stop({ requestId: "req_supervisor_timeout_stop", timeoutMs: 0 });
  await waitUntil(() => context.supervisor.health().activeJobs === 0);

  assert.equal(observedAbort, true);
  assert.equal(job.status, "cancelled");
  assert.equal(context.supervisor.health().state, "stopped");
  assert.equal(context.logs.some((entry) => entry.event === "worker_shutdown_timeout"), true);
});

test("retryable failures schedule bounded backoff and retry only when due", async () => {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  let retryCallback = null;
  let retryDelay = null;
  let attempts = 0;
  const context = createContext({
    dependencies: {
      nowMs: () => now,
      setRetryTimeout: (fn, delayMs) => {
        retryCallback = fn;
        retryDelay = delayMs;
        return "retry-timer";
      },
      clearRetryTimeout: () => {},
    },
    runRenderJob: async ({ jobs, job }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 503);
      }
      jobs.complete(job, {
        exportId: "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc",
        outputPath: storagePath("renders", "supervisor-retry.mp4"),
      });
    },
  });
  const job = createJob(context.store, "supervisor-retryable");

  context.supervisor.start({ requestId: "req_supervisor_retry_start" });
  await context.supervisor.waitForIdle({ timeoutMs: 250 });

  assert.equal(job.status, "queued");
  assert.equal(job.error.code, "JOB_RETRY_SCHEDULED");
  assert.equal(job.lastRetryCode, "TRANSCRIPTION_TIMEOUT");
  assert.equal(job.backoffMs, 50);
  assert.equal(retryDelay, 50);
  assert.equal(attempts, 1);
  assert.ok(Date.parse(job.nextRetryAt) > now);

  now += retryDelay;
  retryCallback();
  await context.supervisor.waitForIdle({ timeoutMs: 250 });

  assert.equal(job.status, "completed");
  assert.equal(job.attempts, 2);
  assert.equal(attempts, 2);
  assert.equal(context.supervisor.health().retry.scheduled, 0);
});

test("non-retryable and exhausted failures become terminal failed jobs", async () => {
  const invalidContext = createContext({
    runRenderJob: async () => {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 400);
    },
  });
  const invalidJob = createJob(invalidContext.store, "supervisor-non-retryable");
  invalidContext.supervisor.start({ requestId: "req_supervisor_non_retryable" });
  await invalidContext.supervisor.waitForIdle({ timeoutMs: 250 });

  assert.equal(invalidJob.status, "failed");
  assert.equal(invalidJob.error.code, "AI_OUTPUT_INVALID");
  assert.equal(invalidContext.supervisor.health().retry.scheduled, 0);

  const exhaustedContext = createContext({
    maxAttempts: 1,
    runRenderJob: async () => {
      throw new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 503);
    },
  });
  const exhaustedJob = createJob(exhaustedContext.store, "supervisor-exhausted");
  exhaustedContext.supervisor.start({ requestId: "req_supervisor_exhausted" });
  await exhaustedContext.supervisor.waitForIdle({ timeoutMs: 250 });

  assert.equal(exhaustedJob.status, "failed");
  assert.equal(exhaustedJob.error.code, "TRANSCRIPTION_TIMEOUT");
  assert.equal(exhaustedContext.supervisor.health().retry.scheduled, 0);
});

test("supervisor health exposes safe aggregate metrics only", () => {
  const context = createContext();
  createJob(context.store, "supervisor-health");
  context.supervisor.start({ requestId: "req_supervisor_health" });
  const health = context.supervisor.health();

  assert.equal(health.state, "running");
  assert.equal(typeof health.queuedJobs, "number");
  assert.equal(typeof health.processingJobs, "number");
  assert.equal(typeof health.retryScheduled, "number");
  assert.equal(typeof health.activeLeases, "number");
  assert.equal(health.queue.backend, "local-jobstore");
  assert.equal(typeof health.queue.activeWorkers, "number");
  assert.equal(typeof health.worker.heartbeat.enabled, "boolean");
  assert.doesNotMatch(JSON.stringify(health), /\/Users|\/private|storageKey|outputPath|secret/i);
});
