const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const { createLocalJobQueue } = require("../server/queue/local-job-queue.cjs");
const { JobStore } = require("../server/jobs.cjs");
const {
  loadRuntimeConfig,
  publicRuntimeConfig,
} = require("../server/runtime/runtime-config.cjs");
const { createRuntime } = require("../server/runtime/create-runtime.cjs");
const {
  createMemoryObservabilityAdapter,
} = require("../server/observability/memory-observability-adapter.cjs");

function productionEnvironment(overrides = {}) {
  return {
    SHORTSENGINE_ENVIRONMENT: "production",
    SHORTSENGINE_PROCESS_ROLE: "web",
    MATCHCUTS_PERSISTENCE_ADAPTER: "postgres",
    MATCHCUTS_QUEUE_ADAPTER: "postgres",
    MATCHCUTS_STORAGE_ADAPTER: "r2",
    SHORTSENGINE_AUTH_MODE: "oidc",
    DATABASE_URL: "postgresql://runtime-user:runtime-password@db.example/shortsengine",
    SHORTSENGINE_OIDC_ISSUER_URL: "https://tenant.example/",
    SHORTSENGINE_OIDC_CLIENT_ID: "shortsengine-web",
    SHORTSENGINE_OIDC_CLIENT_SECRET: "client-secret-value",
    SHORTSENGINE_OIDC_REDIRECT_URI: "https://app.example/auth/callback",
    SHORTSENGINE_PUBLIC_BASE_URL: "https://app.example/",
    SHORTSENGINE_SESSION_SECRET: "s".repeat(48),
    ...overrides,
  };
}

test("production runtime config fails closed unless every production adapter is selected", () => {
  assert.throws(
    () => loadRuntimeConfig(productionEnvironment({ MATCHCUTS_QUEUE_ADAPTER: "local-jobstore" })),
    (error) => error.code === "CONFIGURATION_INVALID"
      && error.details.field === "MATCHCUTS_QUEUE_ADAPTER",
  );
  assert.throws(
    () => loadRuntimeConfig(productionEnvironment({ SHORTSENGINE_AUTH_MODE: "operator" })),
    (error) => error.code === "CONFIGURATION_INVALID"
      && error.details.field === "SHORTSENGINE_AUTH_MODE",
  );
  assert.throws(
    () => loadRuntimeConfig(productionEnvironment({ DATABASE_URL: "" })),
    (error) => error.code === "CONFIGURATION_INVALID"
      && error.details.field === "DATABASE_URL",
  );
});

test("public runtime config exposes readiness booleans without connection or OIDC secrets", () => {
  const config = loadRuntimeConfig(productionEnvironment());
  const publicConfig = publicRuntimeConfig(config);
  const serialized = JSON.stringify(publicConfig);
  assert.equal(publicConfig.adapters.persistence, "postgres");
  assert.equal(publicConfig.configured.database, true);
  assert.equal(publicConfig.configured.oidc, true);
  assert.doesNotMatch(
    serialized,
    /runtime-user|runtime-password|client-secret|ssssssss|postgresql:|tenant\.example/,
  );
});

test("local queue preserves owner and explicit pipeline identity", () => {
  const queue = createLocalJobQueue({
    jobs: new JobStore({ persist: false, logger: null }),
    logger: null,
  });
  const job = queue.create({
    projectId: "prj_runtime1111-4111-8111-111111111111",
    ownerId: "owner-runtime",
    action: "generate",
    pipelineType: "clip",
    idempotencyKey: "runtime-owner-key",
    payload: null,
  });
  assert.equal(job.ownerId, "owner-runtime");
  assert.equal(job.pipelineType, "clip");
  assert.equal(queue.health().workerRuntime.multiWorkerSafe, false);
});

test("memory observability keeps bounded labels and unknown costs explicit", async () => {
  const telemetry = createMemoryObservabilityAdapter({ maxSeries: 20 });
  const span = telemetry.startSpan("queue.claim", {
    pipeline: "clip",
    correlation_id: "must_not_be_a_metric_label",
  });
  telemetry.increment("queue_claims_total", {
    pipeline: "clip",
    owner_id: "usr_unsafe",
  });
  telemetry.recordUsage({
    provider: "ffmpeg",
    operation: "preview",
    unit: "second",
    count: 12,
  });
  span.end("success");
  assert.equal(telemetry.jobCost().totalUsd, null);
  assert.equal(telemetry.jobCost().coverage, 0);
  assert.equal(telemetry.health().activeSpans, 0);
  await telemetry.shutdown();
  assert.equal(telemetry.health().ready, false);
});

test("createRuntime exposes async lifecycle without starting work on construction", async () => {
  const runtime = await createRuntime({
    env: {
      SHORTSENGINE_ENVIRONMENT: "test",
      SHORTSENGINE_PROCESS_ROLE: "web",
      MATCHCUTS_PERSISTENCE_ADAPTER: "local",
      MATCHCUTS_QUEUE_ADAPTER: "local-jobstore",
      MATCHCUTS_STORAGE_ADAPTER: "local",
      SHORTSENGINE_AUTH_MODE: "operator",
    },
    logger: null,
  });
  const readiness = await runtime.readiness();
  assert.equal(runtime.role, "web");
  assert.equal(readiness.adapters.persistence.mode, "local");
  assert.equal(readiness.adapters.queue.workerRuntime.multiWorkerSafe, false);
  assert.equal(await runtime.start(), true);
  assert.equal(await runtime.start(), false);
  assert.equal(await runtime.close(), true);
});

test("importing the legacy app no longer starts the worker supervisor", () => {
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      "process.env.MATCHCUTS_DATA_DIR=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'shorts-runtime-import-'));process.env.SHORTSENGINE_AUTH_MODE='local';const app=require('./server/app.cjs');process.stdout.write(app.workerSupervisor.health().state);",
    ],
    {
      cwd: require("node:path").resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(output, "stopped");
});
