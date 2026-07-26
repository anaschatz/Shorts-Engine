const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deterministicRetryDelayMs,
  requestHash,
} = require("../server/queue/postgres-job-queue.cjs");
const {
  DistributedWorkerRunner,
} = require("../server/worker/distributed-worker-runner.cjs");

function claim(overrides = {}) {
  const job = {
    id: "job_test",
    action: "validate_upload",
    pipelineType: "upload",
    ...overrides.job,
  };
  return {
    job,
    lease: {
      jobId: job.id,
      workerId: "worker-a",
      leaseId: "lease-a",
      attempt: 1,
      ...overrides.lease,
    },
  };
}

function queueHarness(overrides = {}) {
  const calls = [];
  const claims = overrides.claims ? [...overrides.claims] : [claim()];
  return {
    calls,
    async claimNext(record) {
      calls.push({ method: "claimNext", record });
      return claims.shift() || null;
    },
    async heartbeat(job, lease, options) {
      calls.push({ method: "heartbeat", job, lease, options });
      if (overrides.heartbeatError) throw overrides.heartbeatError;
      return {
        ...job,
        cancelRequestedAt: overrides.cancelRequestedAt || null,
      };
    },
    async update(job, patch, lease) {
      calls.push({ method: "update", job, patch, lease });
      return { ...job, ...patch };
    },
    async complete(job, patch, lease) {
      calls.push({ method: "complete", job, patch, lease });
      return {
        ...job,
        status: overrides.completeStatus || "completed",
      };
    },
    async completeAtomically(job, patch, lease, mutation) {
      calls.push({ method: "completeAtomically", job, patch, lease });
      const completed = {
        ...job,
        status: overrides.completeStatus || "completed",
      };
      if (completed.status === "completed") {
        await mutation({ query() {} }, completed);
      }
      return completed;
    },
    async retry(job, error, lease) {
      calls.push({ method: "retry", job, error, lease });
      return { ...job, status: overrides.retryStatus || "queued" };
    },
    async fail(job, error, lease) {
      calls.push({ method: "fail", job, error, lease });
      return { ...job, status: "failed" };
    },
    async acknowledgeCancellation(job, lease) {
      calls.push({ method: "acknowledgeCancellation", job, lease });
      return { ...job, status: "cancelled" };
    },
  };
}

test("retry jitter is deterministic, bounded and capped", () => {
  const first = deterministicRetryDelayMs("job-a", 1);
  assert.equal(first, deterministicRetryDelayMs("job-a", 1));
  assert.ok(first >= 800 && first <= 1200);
  const third = deterministicRetryDelayMs("job-a", 3);
  assert.ok(third >= 3200 && third <= 4800);
  assert.ok(deterministicRetryDelayMs("job-a", 99) <= 60_000);
});

test("idempotency request hashes use canonical object key order", () => {
  assert.equal(
    requestHash({ nested: { beta: 2, alpha: 1 }, list: [3, 2, 1] }),
    requestHash({ list: [3, 2, 1], nested: { alpha: 1, beta: 2 } }),
  );
  assert.notEqual(requestHash({ value: 1 }), requestHash({ value: 2 }));
});

test("distributed runner reports progress and completes with the same lease", async () => {
  const queue = queueHarness();
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      async validate_upload(job, context) {
        assert.equal(context.signal.aborted, false);
        await context.update({ progress: 50, step: "validating" });
        return { artifactId: "art_test" };
      },
    },
  });

  assert.deepEqual(await runner.runOnce(), {
    claimed: true,
    status: "completed",
    jobId: "job_test",
  });
  assert.deepEqual(
    queue.calls.map((entry) => entry.method),
    ["claimNext", "update", "complete"],
  );
  assert.deepEqual(queue.calls.at(-1).patch, {
    result: { artifactId: "art_test" },
  });
});

test("distributed runner retries safe failures and fails explicit non-retryable errors", async () => {
  const retryQueue = queueHarness();
  const retryRunner = new DistributedWorkerRunner({
    queue: retryQueue,
    workerId: "worker-a",
    handlers: {
      validate_upload() {
        throw new Error("raw provider details must not enter queue state");
      },
    },
  });
  assert.equal((await retryRunner.runOnce()).status, "retry_scheduled");
  assert.equal(retryQueue.calls.at(-1).method, "retry");

  const failQueue = queueHarness();
  const failure = new Error("invalid input");
  failure.code = "UPLOAD_VALIDATION_FAILED";
  failure.retryable = false;
  const failRunner = new DistributedWorkerRunner({
    queue: failQueue,
    workerId: "worker-a",
    handlers: {
      validate_upload() {
        throw failure;
      },
    },
  });
  assert.equal((await failRunner.runOnce()).status, "failed");
  assert.equal(failQueue.calls.at(-1).method, "fail");
});

test("heartbeat cancellation is acknowledged under the active lease", async () => {
  const queue = queueHarness({ cancelRequestedAt: new Date().toISOString() });
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      async validate_upload(job, context) {
        await context.heartbeat();
        assert.equal(context.signal.aborted, true);
      },
    },
  });
  assert.equal((await runner.runOnce()).status, "cancelled");
  assert.deepEqual(
    queue.calls.map((entry) => entry.method),
    ["claimNext", "heartbeat", "acknowledgeCancellation"],
  );
});

test("completion observes a cancellation that races after the last heartbeat", async () => {
  const queue = queueHarness({ completeStatus: "cancelled" });
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      async validate_upload() {
        return { ignored: true };
      },
    },
  });
  assert.equal((await runner.runOnce()).status, "cancelled");
  assert.deepEqual(
    queue.calls.map((entry) => entry.method),
    ["claimNext", "complete"],
  );
});

test("handler-owned atomic completion runs its mutation once and skips ordinary completion", async () => {
  const queue = queueHarness();
  let mutations = 0;
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      async validate_upload(job, context) {
        await context.completeAtomically(
          { exportId: "exp_test" },
          async (transaction, completed) => {
            assert.equal(typeof transaction.query, "function");
            assert.equal(completed.status, "completed");
            mutations += 1;
          },
        );
        return { ignoredAfterAtomicCompletion: true };
      },
    },
  });
  assert.equal((await runner.runOnce()).status, "completed");
  assert.equal(mutations, 1);
  assert.deepEqual(
    queue.calls.map((entry) => entry.method),
    ["claimNext", "completeAtomically"],
  );
});

test("lease loss aborts work without stale completion or retry", async () => {
  const leaseError = new Error("lost");
  leaseError.code = "JOB_LEASE_INVALID";
  const queue = queueHarness({ heartbeatError: leaseError });
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      async validate_upload(job, context) {
        await context.heartbeat();
      },
    },
  });
  assert.equal((await runner.runOnce()).status, "lease_lost");
  assert.deepEqual(
    queue.calls.map((entry) => entry.method),
    ["claimNext", "heartbeat"],
  );
});

test("distributed runner rejects missing queue and worker identity", () => {
  assert.throws(
    () => new DistributedWorkerRunner({ workerId: "worker-a" }),
    (error) => error.code === "ADAPTER_CONTRACT_INVALID",
  );
  assert.throws(
    () => new DistributedWorkerRunner({ queue: queueHarness() }),
    (error) => error.code === "CONFIGURATION_INVALID",
  );
});

test("distributed runner fails closed before polling when it has no handlers", async () => {
  const queue = queueHarness();
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
  });
  await assert.rejects(
    runner.start(),
    (error) => error.code === "CONFIGURATION_INVALID",
  );
  assert.equal(queue.calls.length, 0);
});

test("zero-drain shutdown does not cancel in-flight work", async () => {
  let finish;
  const queue = queueHarness();
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-a",
    handlers: {
      validate_upload() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const processing = runner.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.health().inFlight, 1);
  assert.equal(await runner.stop({ drainMs: 0 }), true);
  assert.equal(
    queue.calls.some((entry) => entry.method === "acknowledgeCancellation"),
    false,
  );
  finish({ ok: true });
  assert.equal((await processing).status, "completed");
});
