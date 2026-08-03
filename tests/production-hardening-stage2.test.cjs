const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  createPostgresObservabilityAdapter,
} = require("../server/observability/postgres-observability-adapter.cjs");
const {
  loadRuntimeConfig,
} = require("../server/runtime/runtime-config.cjs");
const {
  MultipartUploadService,
} = require("../server/storage/multipart-upload-service.cjs");
const {
  DistributedWorkerRunner,
} = require("../server/worker/distributed-worker-runner.cjs");

function productionEnvironment(overrides = {}) {
  return {
    SHORTSENGINE_ENVIRONMENT: "production",
    SHORTSENGINE_PROCESS_ROLE: "web",
    MATCHCUTS_PERSISTENCE_ADAPTER: "postgres",
    MATCHCUTS_QUEUE_ADAPTER: "postgres",
    MATCHCUTS_STORAGE_ADAPTER: "r2",
    SHORTSENGINE_AUTH_MODE: "oidc",
    SHORTSENGINE_TELEMETRY_ADAPTER: "postgres",
    DATABASE_URL: "postgresql://user:password@db.example/shortsengine",
    SHORTSENGINE_OIDC_ISSUER_URL: "https://tenant.example/",
    SHORTSENGINE_OIDC_CLIENT_ID: "shortsengine",
    SHORTSENGINE_OIDC_CLIENT_SECRET: "client-secret-value",
    SHORTSENGINE_OIDC_REDIRECT_URI: "https://app.example/auth/callback",
    SHORTSENGINE_PUBLIC_BASE_URL: "https://app.example/",
    SHORTSENGINE_SESSION_SECRET: "s".repeat(48),
    MATCHCUTS_STORAGE_BUCKET: "shortsengine",
    MATCHCUTS_STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    MATCHCUTS_STORAGE_ACCESS_KEY_ID: "access-key",
    MATCHCUTS_STORAGE_SECRET_ACCESS_KEY: "secret-access-key",
    ...overrides,
  };
}

test("production config rejects in-memory telemetry and validates bounded controls", () => {
  assert.throws(
    () => loadRuntimeConfig(productionEnvironment({
      SHORTSENGINE_TELEMETRY_ADAPTER: "memory",
    })),
    (error) => error.code === "CONFIGURATION_INVALID"
      && error.details.field === "SHORTSENGINE_TELEMETRY_ADAPTER",
  );
  const config = loadRuntimeConfig(productionEnvironment({
    SHORTSENGINE_MAX_UPLOAD_BYTES: "104857600",
    SHORTSENGINE_MAX_VIDEO_DURATION_SECONDS: "3600",
    SHORTSENGINE_DAILY_RENDER_LIMIT: "12",
    SHORTSENGINE_MONTHLY_RENDER_LIMIT: "120",
    SHORTSENGINE_USER_CONCURRENCY_LIMIT: "2",
    SHORTSENGINE_GLOBAL_CONCURRENCY_LIMIT: "6",
    SHORTSENGINE_PROVIDER_MONTHLY_BUDGET_USD: "25.50",
  }));
  assert.equal(config.telemetry.mode, "postgres");
  assert.equal(config.quotas.maxUploadBytes, 104857600);
  assert.equal(config.quotas.maxVideoDurationSeconds, 3600);
  assert.equal(config.quotas.dailyRenderLimit, 12);
  assert.equal(config.quotas.monthlyRenderLimit, 120);
  assert.equal(config.quotas.globalConcurrency, 6);
  assert.equal(config.quotas.providerBudgetUsd, 25.5);
});

test("upload size control is enforced by the server before storage work", async () => {
  let storageCalls = 0;
  const service = new MultipartUploadService({
    maxUploadBytes: 100,
    persistence: {
      async getQuotaPolicy() {
        return { uploadSizeLimitBytes: 10 };
      },
    },
    store: {
      async createMultipartUpload() {
        storageCalls += 1;
      },
    },
  });
  await assert.rejects(
    service.createUpload({
      rightsConfirmed: true,
      contentType: "video/mp4",
      byteSize: 11,
      ownerId: "usr_test",
    }),
    (error) => error.code === "FILE_TOO_LARGE",
  );
  assert.equal(storageCalls, 0);
});

test("PostgreSQL telemetry persists allowlisted bounded metrics and usage", async () => {
  const metrics = [];
  const usage = [];
  const persistence = {
    async recordMetric(record) {
      metrics.push(record);
    },
    async recordUsage(record) {
      usage.push(record);
    },
    async getJobCost() {
      return { totalUsd: 0.25, pricedEvents: 1, totalEvents: 1, coverage: 1 };
    },
    async readiness() {
      return { ready: true };
    },
  };
  const telemetry = createPostgresObservabilityAdapter({ persistence });
  assert.equal(telemetry.increment("render_success_total", {
    pipeline: "football",
    owner_id: "must_not_be_persisted",
  }), true);
  assert.equal(telemetry.increment("unknown_metric", {}), false);
  telemetry.recordUsage({
    ownerId: "usr_internal",
    jobId: "job_internal",
    provider: "ffmpeg",
    operation: "render",
    unit: "second",
    count: 12,
    costUsd: 0.25,
  });
  await telemetry.shutdown();
  assert.deepEqual(metrics[0].labels, { pipeline: "football" });
  assert.equal(usage.length, 1);
  assert.equal((await telemetry.jobCost({ jobId: "job_internal" })).totalUsd, 0.25);
});

test("worker processing timeout is retried under the active fenced lease", async () => {
  const calls = [];
  const metrics = [];
  const job = { id: "job_timeout", action: "render", pipelineType: "football" };
  const lease = {
    jobId: job.id,
    workerId: "worker-timeout",
    leaseId: "lease-timeout",
    attempt: 1,
  };
  const queue = {
    async claimNext() {
      calls.push("claim");
      return { job, lease };
    },
    async heartbeat() {
      return job;
    },
    async retry(activeJob, error, activeLease) {
      calls.push(error.code);
      assert.equal(activeJob, job);
      assert.equal(activeLease, lease);
      return { status: "queued" };
    },
  };
  const runner = new DistributedWorkerRunner({
    queue,
    workerId: "worker-timeout",
    observability: {
      increment(name, labels) {
        metrics.push({ kind: "counter", name, labels });
      },
      observe(name, value, labels) {
        metrics.push({ kind: "histogram", name, value, labels });
      },
    },
    processingTimeouts: { render: 20 },
    handlers: {
      render(activeJob, context) {
        return new Promise((resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason));
        });
      },
    },
  });
  assert.deepEqual(await runner.runOnce(), {
    claimed: true,
    status: "retry_scheduled",
    jobId: job.id,
  });
  assert.deepEqual(calls, ["claim", "JOB_TIMEOUT"]);
  assert.ok(metrics.some((metric) => metric.name === "retry_total"));
  assert.ok(metrics.some((metric) => metric.name === "processing_time_ms"));
  assert.ok(metrics.every((metric) => !("jobId" in metric.labels)));
});

test("worker emits durable outcome, latency and attributed-cost metrics", async () => {
  const metrics = [];
  const job = {
    id: "job_metric",
    action: "render",
    pipelineType: "football",
    createdAt: new Date(Date.now() - 25).toISOString(),
  };
  const lease = {
    jobId: job.id,
    workerId: "worker-metric",
    leaseId: "lease-metric",
    attempt: 1,
  };
  const observability = {
    increment(name, labels) {
      metrics.push({ kind: "counter", name, labels });
    },
    observe(name, value, labels) {
      metrics.push({ kind: "histogram", name, value, labels });
    },
    async jobCost() {
      return { totalUsd: 0.125, totalEvents: 1, pricedEvents: 1, coverage: 1 };
    },
  };
  const runner = new DistributedWorkerRunner({
    queue: {
      async claimNext() {
        return { job, lease };
      },
      async heartbeat() {
        return job;
      },
      async complete() {
        return { status: "completed" };
      },
    },
    workerId: lease.workerId,
    observability,
    handlers: {
      async render() {
        return { rendered: true };
      },
    },
  });
  assert.equal((await runner.runOnce()).status, "completed");
  for (const metricName of [
    "queue_wait_ms",
    "processing_time_ms",
    "render_success_total",
    "completed_video_cost_usd",
  ]) {
    assert.ok(metrics.some((metric) => metric.name === metricName));
  }
  assert.ok(metrics.every((metric) => !("jobId" in metric.labels)));
});

test("migration 0007 defines durable attempts, quotas, costs, metrics and ownership", () => {
  const migration = readFileSync(
    "server/migrations/postgres/0007_production_controls_telemetry.sql",
    "utf8",
  );
  for (const table of [
    "project_memberships",
    "job_attempts",
    "quota_policies",
    "job_cost_records",
    "metric_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /production_metric_summary/);
  assert.match(migration, /production_job_outcomes/);

  const queueSource = readFileSync("server/queue/postgres-job-queue.cjs", "utf8");
  assert.match(queueSource, /FOR UPDATE OF job, owner SKIP LOCKED/);
  assert.match(queueSource, /pg_advisory_xact_lock/);
  assert.match(queueSource, /globalConcurrency/);
  assert.match(queueSource, /quota_policies/);
  assert.match(queueSource, /quota_rejection_total/);
  assert.match(queueSource, /queue_depth/);
  assert.match(queueSource, /INSERT INTO job_attempts/);

  const proofRunner = readFileSync("scripts/run-production-integration.mjs", "utf8");
  const proofWorkflow = readFileSync(
    ".github/workflows/production-integration.yml",
    "utf8",
  );
  assert.match(proofRunner, /git",\s*\["rev-parse", "HEAD"\]/);
  assert.match(proofRunner, /SHORTSENGINE_PROOF_COMMIT_SHA/);
  assert.match(proofRunner, /commitSha !== expectedCommitSha/);
  assert.doesNotMatch(proofRunner, /process\.env\.GITHUB_SHA\s*\|\|/);
  assert.match(
    proofWorkflow,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
  );
});
