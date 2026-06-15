const test = require("node:test");
const assert = require("node:assert/strict");

const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { createLocalJobQueue } = require("../server/queue/local-job-queue.cjs");
const { validateQueueContract } = require("../server/queue/queue-contracts.cjs");
const { storagePath } = require("../server/storage.cjs");

const PROJECT_ID = "prj_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const UPLOAD_ID = "upl_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_A = "wrk_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WORKER_B = "wrk_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function createQueue(options = {}) {
  const store = new JobStore({
    leaseDurationMs: options.leaseDurationMs || 1000,
    maxAttempts: options.maxAttempts || 3,
    logger: null,
  });
  const queue = createLocalJobQueue({ jobs: store, logger: null });
  return { queue, store };
}

function createJob(queue, key = "queue-contract") {
  return queue.create({
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    action: "generate",
    idempotencyKey: key,
    payload: { title: "Derby Final", preset: "hype", language: "en" },
  });
}

test("local job queue validates the worker contract and completes with an active lease", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  validateQueueContract(queue);
  const job = createJob(queue, "queue-complete");

  assert.equal(queue.enqueue(job, { requestId: "req_queue_enqueue" }).id, job.id);
  const claim = queue.claim(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000, requestId: "req_queue_claim" });
  queue.heartbeat(claim.job, claim.lease, { nowMs: base + 500, leaseMs: 2000 });
  queue.complete(claim.job, {
    exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    outputPath: storagePath("renders", "queue-complete.mp4"),
  }, claim.lease, { nowMs: base + 600 });

  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(job.workerId, null);
  assert.equal(queue.publicJob(job).leaseId, undefined);
});

test("local job queue prevents duplicate active claims and reclaims expired leases", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  const job = createJob(queue, "queue-duplicate-claim");
  const first = queue.claim(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });

  assert.equal(first.job.workerId, WORKER_A);
  assert.throws(
    () => queue.claim(job.id, { workerId: WORKER_B, nowMs: base + 500, leaseMs: 1000 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );

  const second = queue.claim(job.id, { workerId: WORKER_B, nowMs: base + 1500, leaseMs: 1000 });
  assert.equal(second.job.workerId, WORKER_B);
  assert.equal(second.job.attempts, 2);
  assert.throws(
    () => queue.complete(job, {
      exportId: "exp_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      outputPath: storagePath("renders", "stale-claim.mp4"),
    }, first.lease, { nowMs: base + 1500 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
});

test("local job queue rejects invalid leases for complete fail heartbeat and retry", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  const job = createJob(queue, "queue-invalid-lease");
  const claim = queue.claim(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  const staleLease = { ...claim.lease, leaseId: "lease_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" };

  assert.throws(
    () => queue.heartbeat(job, staleLease, { nowMs: base + 100 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
  assert.throws(
    () => queue.fail(job, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500), staleLease, { nowMs: base + 100 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
  assert.throws(
    () => queue.retry(job, new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 503), staleLease, {
      nowMs: base + 100,
      backoffMs: 1000,
      nextRetryAt: new Date(base + 1100).toISOString(),
    }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
  assert.throws(
    () => queue.complete(job, {
      exportId: "exp_cccccccc-cccc-4ccc-cccc-cccccccccccc",
      outputPath: storagePath("renders", "invalid-lease.mp4"),
    }, staleLease, { nowMs: base + 100 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );

  assert.equal(job.status, "processing");
  assert.equal(job.workerId, WORKER_A);
});

test("local job queue schedules retry through the adapter and blocks early claim", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  const job = createJob(queue, "queue-retry");
  const claim = queue.claim(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  queue.retry(job, new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 503), claim.lease, {
    nowMs: base + 100,
    backoffMs: 5000,
    nextRetryAt: new Date(base + 5100).toISOString(),
  });

  assert.equal(job.status, "queued");
  assert.equal(job.error.code, "JOB_RETRY_SCHEDULED");
  assert.equal(job.lastRetryCode, "TRANSCRIPTION_TIMEOUT");
  assert.equal(job.backoffMs, 5000);
  assert.throws(
    () => queue.claim(job.id, { workerId: WORKER_B, nowMs: base + 500, leaseMs: 1000 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );

  const retryClaim = queue.claim(job.id, { workerId: WORKER_B, nowMs: base + 5100, leaseMs: 1000 });
  assert.equal(retryClaim.job.status, "processing");
  assert.equal(retryClaim.job.workerId, WORKER_B);
  assert.equal(retryClaim.job.nextRetryAt, null);
});

test("local job queue cancellation clears active lease and protects terminal states", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  const job = createJob(queue, "queue-cancel");
  const claim = queue.claim(job.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  queue.cancel(job.id, { requestId: "req_queue_cancel" });

  assert.equal(job.status, "cancelled");
  assert.equal(job.workerId, null);
  assert.throws(
    () => queue.fail(job, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500), claim.lease, { nowMs: base + 100 }),
    (error) => error.code === "JOB_LEASE_INVALID",
  );
  assert.throws(
    () => queue.claim(job.id, { workerId: WORKER_B, nowMs: base + 1500, leaseMs: 1000 }),
    (error) => error.code === "JOB_STATE_INVALID",
  );
});

test("local job queue releases expired leases with bounded terminal behavior", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue({ maxAttempts: 2 });
  const retryable = createJob(queue, "queue-release-expired");
  const exhausted = createJob(queue, "queue-release-exhausted");
  queue.claim(retryable.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });
  queue.claim(exhausted.id, { workerId: WORKER_B, nowMs: base, leaseMs: 1000 });
  queue.update(exhausted, { attempts: 2 }, {
    jobId: exhausted.id,
    workerId: WORKER_B,
    leaseId: exhausted.leaseId,
  }, { nowMs: base + 100 });

  const released = queue.releaseExpiredLeases({ nowMs: base + 2000, requestId: "req_queue_release" });

  assert.equal(released.inspected, 2);
  assert.equal(released.released, 1);
  assert.equal(released.failed, 1);
  assert.equal(retryable.status, "queued");
  assert.equal(retryable.error.code, "JOB_RETRY_SCHEDULED");
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.error.code, "JOB_STALE");
});

test("local job queue health exposes safe multi-worker aggregate metrics", () => {
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  const { queue } = createQueue();
  const active = createJob(queue, "queue-health-active");
  createJob(queue, "queue-health-queued");
  queue.claim(active.id, { workerId: WORKER_A, nowMs: base, leaseMs: 1000 });

  const health = queue.health(base + 500);

  assert.equal(health.ready, true);
  assert.equal(health.adapter, "local-job-queue");
  assert.equal(health.workerRuntime.multiWorkerSafe, true);
  assert.equal(health.workers.active, 1);
  assert.equal(health.leases.active, 1);
  assert.equal(health.jobs.queued, 1);
  assert.equal(health.capabilities.claim, true);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|\/private|storageKey|outputPath|filePath|secret/i);
});
