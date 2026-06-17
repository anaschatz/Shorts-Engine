const test = require("node:test");
const assert = require("node:assert/strict");

const { ApprovalOutboxRepository } = require("../server/repositories/approval-outbox-repository.cjs");
const { createOutboxWorker, outboxBackoffMs } = require("../server/outbox-worker.cjs");

const IDS = Object.freeze({
  projectId: "prj_outboxproject01",
  approvalId: "appr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  jobId: "job_outboxrender01",
  exportId: "exp_outboxexport01",
});

function createEvent(repo, overrides = {}) {
  return repo.create({
    eventType: overrides.eventType || "render_completed",
    approvalId: IDS.approvalId,
    maxAttempts: overrides.maxAttempts,
    payload: {
      approvalId: IDS.approvalId,
      projectId: IDS.projectId,
      newRenderJobId: IDS.jobId,
      completedExportId: IDS.exportId,
      status: "render_completed",
      path: "/Users/example/secret.mp4",
      storageKey: "secret-storage-key",
      token: "secret-token",
    },
  });
}

test("approval outbox repository claims due events and protects terminal states", () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const event = createEvent(repo);

  const claimed = repo.claimDue({
    workerId: "obw_unit-worker-0001",
    nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "processing");
  assert.equal(claimed[0].attempts, 1);
  assert.equal(claimed[0].lockOwner, "obw_unit-worker-0001");
  assert.equal(repo.claimDue({ workerId: "obw_unit-worker-0002" }).length, 0);

  const delivered = repo.markDelivered(event.id, {
    workerId: "obw_unit-worker-0001",
    updatedAt: "2026-06-18T00:00:01.000Z",
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(repo.claimDue({ workerId: "obw_unit-worker-0003" }).length, 0);
  assert.throws(
    () => repo.markFailed(event.id, { errorCode: "OUTBOX_DELIVERY_FAILED" }),
    (error) => error.code === "OUTBOX_STATE_INVALID",
  );
  assert.doesNotMatch(JSON.stringify(repo.publicEvent(delivered)), /\/Users|secret|storageKey|token/i);
});

test("outbox worker delivers events with the no-op handler by default", async () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const first = createEvent(repo);
  const second = createEvent(repo, { eventType: "render_failed" });
  const worker = createOutboxWorker({
    repository: repo,
    workerId: "obw_worker-success-01",
    logger: null,
  });

  const result = await worker.runOnce({ nowMs: Date.parse("2026-06-18T00:00:00.000Z") });

  assert.equal(result.claimed, 2);
  assert.equal(result.delivered, 2);
  assert.equal(repo.get(first.id).status, "delivered");
  assert.equal(repo.get(second.id).status, "delivered");
  assert.equal(worker.health().pending, 0);
});

test("outbox worker retries and dead-letters after max attempts", async () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const event = createEvent(repo, { maxAttempts: 2 });
  const worker = createOutboxWorker({
    repository: repo,
    workerId: "obw_worker-retry-001",
    retryInitialDelayMs: 1000,
    retryMaxDelayMs: 1000,
    handler: {
      name: "retry-test",
      async handle() {
        return { status: "retry", errorCode: "OUTBOX_TEST_RETRY" };
      },
    },
  });

  const first = await worker.runOnce({ nowMs: Date.parse("2026-06-18T00:00:00.000Z") });
  assert.equal(first.retried, 1);
  assert.equal(repo.get(event.id).status, "failed");
  assert.equal(repo.get(event.id).attempts, 1);

  const second = await worker.runOnce({ nowMs: Date.parse("2026-06-18T00:00:02.000Z") });
  assert.equal(second.deadLettered + second.retried, 1);
  assert.equal(repo.get(event.id).status, "dead_letter");
  assert.equal(repo.get(event.id).lastErrorCode, "OUTBOX_TEST_RETRY");
  assert.equal(outboxBackoffMs(3, { initialDelayMs: 1000, maxDelayMs: 5000 }), 4000);
});

test("outbox worker handles thrown handler failures without leaking raw errors", async () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const event = createEvent(repo);
  const logs = [];
  const worker = createOutboxWorker({
    repository: repo,
    workerId: "obw_worker-fail-0001",
    logger: { warn: (line) => logs.push(line), info() {} },
    handler: {
      name: "throwing-test",
      async handle() {
        const error = new Error("/Users/example token raw stderr");
        error.code = "OUTBOX_TEST_FAILURE";
        throw error;
      },
    },
  });

  const result = await worker.runOnce({ nowMs: Date.parse("2026-06-18T00:00:00.000Z") });

  assert.equal(result.errors, 1);
  assert.equal(repo.get(event.id).status, "failed");
  assert.equal(repo.get(event.id).lastErrorCode, "OUTBOX_TEST_FAILURE");
  assert.doesNotMatch(logs.join("\n"), /\/Users|token|stderr|secret|storageKey/i);
});

test("outbox repository recovers stale processing locks safely", () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const event = createEvent(repo);
  repo.claimDue({
    workerId: "obw_stale-worker-01",
    nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
  });

  const recovered = repo.recoverStaleLocks({
    nowMs: Date.parse("2026-06-18T00:10:00.000Z"),
    staleLockMs: 60 * 1000,
  });

  assert.equal(recovered.length, 1);
  assert.equal(repo.get(event.id).status, "failed");
  assert.equal(repo.get(event.id).lastErrorCode, "OUTBOX_LOCK_STALE");
});

test("outbox worker cancellation releases claimed event for retry", async () => {
  const repo = new ApprovalOutboxRepository({ persist: false });
  const event = createEvent(repo);
  const controller = new AbortController();
  controller.abort();
  const worker = createOutboxWorker({
    repository: repo,
    workerId: "obw_worker-cancel-01",
    logger: null,
  });

  const result = await worker.runOnce({
    nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
    signal: controller.signal,
  });

  assert.equal(result.cancelled, true);
  assert.equal(repo.get(event.id).status, "failed");
  assert.equal(repo.get(event.id).lastErrorCode, "OUTBOX_WORKER_CANCELLED");
});
