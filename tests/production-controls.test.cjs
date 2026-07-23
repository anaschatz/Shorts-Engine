const assert = require("node:assert/strict");
const test = require("node:test");
const { join } = require("node:path");

const { createAnalysisCache, analysisCacheKey } = require(join(__dirname, "../server/shared/core/analysis-cache.cjs"));
const { createExecutionControls } = require(join(__dirname, "../server/shared/core/execution-controls.cjs"));
const { createMetricsCollector } = require(join(__dirname, "../server/shared/core/metrics.cjs"));

const CHECKSUM = "a".repeat(64);

test("analysis cache invalidates on source, version, evidence contract, and settings", () => {
  const metrics = createMetricsCollector();
  const cache = createAnalysisCache({ metrics, maxEntries: 2, ttlMs: 1000 });
  const descriptor = {
    sourceChecksum: CHECKSUM,
    pipelineVersion: "planner-v1",
    evidenceContractVersion: "evidence-v1",
    configuration: { preset: "hype", mode: "balanced" },
  };
  cache.put(descriptor, [{ id: "candidate-a" }], 100);
  assert.deepEqual(cache.get(descriptor, 101), [{ id: "candidate-a" }]);
  assert.equal(cache.get({ ...descriptor, sourceChecksum: "b".repeat(64) }, 101), null);
  assert.equal(cache.get({ ...descriptor, pipelineVersion: "planner-v2" }, 101), null);
  assert.equal(cache.get({ ...descriptor, evidenceContractVersion: "evidence-v2" }, 101), null);
  assert.equal(cache.get({ ...descriptor, configuration: { preset: "clean", mode: "balanced" } }, 101), null);
  assert.equal(cache.get(descriptor, 1101), null);
  assert.equal(metrics.snapshot().find((metric) => metric.name === "analysis_cache_hits_total").sum, 1);
});

test("analysis cache key is stable across configuration property order", () => {
  const left = analysisCacheKey({
    sourceChecksum: CHECKSUM,
    pipelineVersion: "planner-v1",
    evidenceContractVersion: "evidence-v1",
    configuration: { preset: "hype", nested: { b: 2, a: 1 } },
  });
  const right = analysisCacheKey({
    sourceChecksum: CHECKSUM,
    pipelineVersion: "planner-v1",
    evidenceContractVersion: "evidence-v1",
    configuration: { nested: { a: 1, b: 2 }, preset: "hype" },
  });
  assert.equal(left.key, right.key);
});

test("execution controls enforce global, per-user, and daily bounds while permitting idempotent replay", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  const jobs = [
    { id: "job_a", action: "generate", ownerId: "usr_a", status: "processing", createdAt: "2026-07-23T08:00:00.000Z", idempotencyKey: "same-key" },
    { id: "job_b", action: "generate", ownerId: "usr_b", status: "queued", createdAt: "2026-07-23T09:00:00.000Z", idempotencyKey: "other-key" },
  ];
  const globalControls = createExecutionControls({
    jobsProvider: () => jobs,
    perUserDailyQuota: 10,
    perUserConcurrency: 2,
    globalConcurrency: 2,
  });
  assert.deepEqual(globalControls.assertCanEnqueue({ ownerId: "usr_a", idempotencyKey: "same-key", nowMs: now }), {
    allowed: true,
    replayed: true,
    existingJobId: "job_a",
  });
  assert.throws(
    () => globalControls.assertCanEnqueue({ ownerId: "usr_c", idempotencyKey: "new-key", nowMs: now }),
    (error) => error.code === "RENDER_CONCURRENCY_EXCEEDED" && error.details.scope === "global",
  );

  const userControls = createExecutionControls({
    jobsProvider: () => jobs.slice(0, 1),
    perUserDailyQuota: 10,
    perUserConcurrency: 1,
    globalConcurrency: 10,
  });
  assert.throws(
    () => userControls.assertCanEnqueue({ ownerId: "usr_a", idempotencyKey: "new-key", nowMs: now }),
    (error) => error.code === "RENDER_CONCURRENCY_EXCEEDED" && error.details.scope === "user",
  );

  const quotaControls = createExecutionControls({
    jobsProvider: () => [{ ...jobs[0], status: "completed" }],
    perUserDailyQuota: 1,
    perUserConcurrency: 2,
    globalConcurrency: 10,
  });
  assert.throws(
    () => quotaControls.assertCanEnqueue({ ownerId: "usr_a", idempotencyKey: "new-key", nowMs: now }),
    (error) => error.code === "RENDER_QUOTA_EXCEEDED" && error.details.scope === "user",
  );
});

test("metrics keep an allowlisted, bounded-cardinality series set", () => {
  const metrics = createMetricsCollector();
  metrics.observe("queue_latency_ms", 15, { pipeline: "clip", outcome: "success", stage: "queue", userId: "not-recorded" });
  metrics.increment("job_failures_total", { pipeline: "unbounded-custom-pipeline", outcome: "failure", stage: "render" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot[0].labels, { pipeline: "clip", outcome: "success", stage: "queue" });
  assert.equal(snapshot[1].labels.pipeline, "unknown");
  assert.throws(() => metrics.increment("arbitrary_metric", {}), /allowlisted/);
});
