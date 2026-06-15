import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  STAGING_ENV_CONTRACT,
  checkStagingReadiness,
  safeError as safeReadinessError,
  validateStagingUrl,
  verifyStagingWorkflowContract,
} from "../tools/release/check-staging-readiness.mjs";
import {
  MAX_HEALTH_RESPONSE_BYTES,
  checkStagingSmoke,
  healthUrlFor,
  safeError as safeSmokeError,
  validateHealthPayload,
} from "../tools/release/check-staging-smoke.mjs";
import {
  runStagingDeploy,
  safeError as safeDeployError,
  validateRenderServiceId,
} from "../tools/release/staging-deploy.mjs";
import {
  checkRenderStaging,
  safeError as safeRenderCheckError,
} from "../tools/release/check-render-staging.mjs";
import { buildRenderStagingChecklist } from "../tools/release/print-render-staging-checklist.mjs";
import { runRenderStagingProof } from "../tools/release/render-staging-proof.mjs";
import { buildReleaseEvidence } from "../tools/release/write-release-evidence.mjs";

const ENV_DOCS = readFileSync("docs/ENVIRONMENT.md", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");
const STAGING_DOCS = readFileSync("docs/STAGING_DEPLOYMENT.md", "utf8");
const STAGING_WORKFLOW = readFileSync(".github/workflows/staging.yml", "utf8");
const CI_WORKFLOW = readFileSync(".github/workflows/ci.yml", "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync("package.json", "utf8"));

function readinessOptions(env = {}) {
  return {
    env,
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    environmentDocsText: ENV_DOCS,
    environmentExampleText: ENV_EXAMPLE,
    docsText: STAGING_DOCS,
    workflowText: STAGING_WORKFLOW,
  };
}

function healthPayload(overrides = {}) {
  return {
    ok: true,
    data: {
      service: "shortsengine-mvp",
      status: "ready",
      ffmpeg: { ffmpeg: true, ffprobe: true, configured: true },
      storage: { uploads: { readable: true, writable: true } },
      artifacts: { ready: true, mode: "local" },
      repositories: { projects: { ready: true } },
      adapters: { artifacts: { ready: true }, persistence: { ready: true } },
      transcription: { ready: true, provider: "mock" },
      analysis: { ready: true },
      requestId: "req_staging_smoke",
      ...overrides,
    },
  };
}

function okFetch(payload = healthPayload()) {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createReportDirs(nowMs) {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-staging-evidence-"));
  const demoResultsDir = join(root, "demo-results");
  const evalResultsDir = join(root, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  const timestamp = new Date(nowMs).toISOString();
  writeJson(join(demoResultsDir, "latest.json"), { timestamp, status: "passed", failedCases: [] });
  writeJson(join(demoResultsDir, "browser-latest.json"), { timestamp, status: "passed", failedCases: [] });
  writeJson(join(demoResultsDir, "playwright-latest.json"), {
    timestamp,
    status: "passed",
    artifacts: {
      directory: "demo/results/playwright-artifacts",
      traceOnFailure: false,
      videoOnFailure: false,
      files: [],
    },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 99 },
    failedCases: [],
  });
  return { demoResultsDir, evalResultsDir };
}

test("staging docs mention all staging environment variables", () => {
  for (const spec of STAGING_ENV_CONTRACT) {
    assert.match(STAGING_DOCS, new RegExp(`\\b${spec.name}\\b`), `${spec.name} should be documented`);
    assert.match(ENV_EXAMPLE, new RegExp(`^${spec.name}=`, "m"), `${spec.name} should be present in .env.example`);
  }
});

test("staging readiness passes in default readiness-only mode", () => {
  const summary = checkStagingReadiness(readinessOptions());
  assert.equal(summary.ok, true);
  assert.equal(summary.deployment.target, "local");
  assert.equal(summary.deployment.provider, "none");
  assert.equal(summary.deployment.mode, "readiness-only");
  assert.equal(summary.smoke.uploadsVideo, false);
  assert.equal(summary.smoke.expensiveRender, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging readiness fails closed when staging target lacks required values", () => {
  let error;
  try {
    checkStagingReadiness(readinessOptions({ SHORTSENGINE_DEPLOY_TARGET: "staging" }));
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /Staging URL is required/);
  assert.equal(safeReadinessError(error).code, "STAGING_URL_REQUIRED");
  assert.equal(findSensitiveLeak(safeReadinessError(error)), null);
});

test("staging readiness accepts Render target with protected credential and service id", () => {
  const summary = checkStagingReadiness(readinessOptions({
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  }));
  assert.equal(summary.deployment.target, "staging");
  assert.equal(summary.deployment.provider, "render");
  assert.equal(summary.deployment.providerConfigured, true);
  assert.equal(summary.deployment.deployCredentialConfigured, true);
  assert.equal(summary.deployment.deployServiceIdConfigured, true);
  assert.equal(summary.deployment.stagingUrlHostType, "remote");
  assert.equal(findSensitiveLeak(summary), null);
});

test("Render staging configuration check passes default readiness-only mode without network", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("render check should not fetch");
  };
  try {
    const summary = checkRenderStaging({
      env: {},
      nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
      environmentDocsText: ENV_DOCS,
      environmentExampleText: ENV_EXAMPLE,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.provider, "none");
    assert.equal(summary.readinessOnly, true);
    assert.equal(summary.networkCalls, false);
    assert.equal(summary.render.supported, false);
    assert.equal(summary.render.buildCommand, "npm ci");
    assert.equal(summary.render.startCommand, "npm start");
    assert.equal(summary.render.healthCheckPath, "/health");
    assert.equal(findSensitiveLeak(summary), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Render staging configuration check accepts valid mocked Render env", () => {
  const summary = checkRenderStaging({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
      MATCHCUTS_PERSISTENCE_ADAPTER: "sqlite",
      MATCHCUTS_STORAGE_ADAPTER: "mock-cloud",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    environmentDocsText: ENV_DOCS,
    environmentExampleText: ENV_EXAMPLE,
  });
  assert.equal(summary.mode, "render-staging");
  assert.equal(summary.render.supported, true);
  assert.equal(summary.render.serviceIdConfigured, true);
  assert.equal(summary.render.deployTokenConfigured, true);
  assert.equal(summary.render.stagingUrlHostType, "remote");
  assert.equal(summary.safeDefaults.transcriptionProvider, "mock");
  assert.equal(summary.safeDefaults.storageAdapter, "mock-cloud");
  assert.equal(summary.safeDefaults.persistenceAdapter, "sqlite");
  assert.equal(findSensitiveLeak(summary), null);
});

test("Render staging configuration check fails safely for missing token url and private URL", () => {
  const baseEnv = {
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
  };
  const missingUrl = (() => {
    try {
      checkRenderStaging({ env: { ...baseEnv, SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token" } });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(missingUrl).code, "STAGING_URL_REQUIRED");

  const missingToken = (() => {
    try {
      checkRenderStaging({ env: { ...baseEnv, SHORTSENGINE_STAGING_URL: "https://staging.example.test" } });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(missingToken).code, "STAGING_CREDENTIAL_MISSING");

  const privateUrl = (() => {
    try {
      checkRenderStaging({
        env: {
          ...baseEnv,
          SHORTSENGINE_STAGING_URL: "http://10.0.0.5",
          SHORTSENGINE_STAGING_ALLOW_LOCAL_URL: "1",
          SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
        },
      });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(privateUrl).code, "RENDER_STAGING_URL_PUBLIC_REQUIRED");
  assert.equal(findSensitiveLeak(safeRenderCheckError(privateUrl)), null);
});

test("Render manual checklist contains no secrets or real service ids", () => {
  const checklist = buildRenderStagingChecklist();
  assert.equal(checklist.ok, true);
  assert.equal(checklist.secretsIncluded, false);
  assert.equal(checklist.networkCalls, false);
  assert.equal(checklist.renderService.buildCommand, "npm ci");
  assert.equal(checklist.renderService.startCommand, "npm start");
  assert.equal(checklist.renderService.healthCheckPath, "/health");
  assert.equal(JSON.stringify(checklist).includes("copy-from-render-dashboard"), true);
  assert.doesNotMatch(JSON.stringify(checklist), /srv-[A-Za-z0-9_-]{6,80}/);
  assert.equal(findSensitiveLeak(checklist), null);
});

test("Render local proof runs in provider none mode without network", async () => {
  const summary = await runRenderStagingProof({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-wouldnotbeused",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async () => {
      throw new Error("proof must not fetch");
    },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.networkCalls, false);
  assert.equal(summary.deployTriggered, false);
  assert.equal(summary.checks.environment, true);
  assert.equal(summary.checks.staging, true);
  assert.equal(summary.checks.render, true);
  assert.equal(summary.checks.deployReadinessOnly, true);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging readiness rejects unsupported provider safely", () => {
  assert.throws(
    () => checkStagingReadiness(readinessOptions({
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "custom",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    })),
    /not supported/,
  );
});

test("staging readiness rejects Render target without service id", () => {
  assert.throws(
    () => checkStagingReadiness(readinessOptions({
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    })),
    /service id/,
  );
});

test("staging deploy passes readiness-only mode without network", async () => {
  const summary = await runStagingDeploy({
    env: {},
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async () => {
      throw new Error("should not fetch in readiness-only mode");
    },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.provider, "none");
  assert.equal(summary.mode, "readiness-only");
  assert.equal(summary.deployTriggered, false);
  assert.equal(summary.providerResult, null);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy triggers Render with sanitized output", async () => {
  let request;
  const summary = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "dep_123", status: "created" }), { status: 201 });
    },
  });
  assert.equal(request.url, "https://api.render.com/v1/services/srv-shortsengine1/deploys");
  assert.equal(request.options.method, "POST");
  assert.match(request.options.headers.authorization, /^Bearer /);
  assert.equal(summary.provider, "render");
  assert.equal(summary.deployTriggered, true);
  assert.equal(summary.providerResult.providerRequestAccepted, true);
  assert.equal(summary.providerResult.deployIdPresent, true);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy fails safely for missing Render service id", async () => {
  const error = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
  }).catch((caught) => caught);
  assert.equal(safeDeployError(error).code, "STAGING_SERVICE_ID_MISSING");
  assert.equal(findSensitiveLeak(safeDeployError(error)), null);
});

test("staging deploy fails safely for Render non-2xx and fetch failures", async () => {
  const env = {
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  };
  const nonSuccess = await runStagingDeploy({
    env,
    fetchImpl: async () => new Response("raw provider error should stay hidden", { status: 500 }),
  }).catch((caught) => caught);
  assert.equal(safeDeployError(nonSuccess).code, "STAGING_RENDER_DEPLOY_HTTP_FAILED");
  assert.equal(findSensitiveLeak(safeDeployError(nonSuccess)), null);

  const fetchFailure = await runStagingDeploy({
    env,
    fetchImpl: async () => {
      throw new Error("raw provider connection failure");
    },
  }).catch((caught) => caught);
  assert.equal(safeDeployError(fetchFailure).code, "STAGING_RENDER_DEPLOY_REQUEST_FAILED");
  assert.equal(findSensitiveLeak(safeDeployError(fetchFailure)), null);
});

test("Render service id validation is strict", () => {
  assert.equal(validateRenderServiceId("srv-shortsengine1"), "srv-shortsengine1");
  assert.throws(() => validateRenderServiceId("service-123"), /valid service id/);
});

test("staging URL validation rejects invalid and credentialed URLs", () => {
  assert.throws(() => validateStagingUrl("ftp://staging.example.test", { required: true }), /http or https/);
  assert.throws(() => validateStagingUrl("https://user:pass@staging.example.test", { required: true }), /must not embed credentials/);
});

test("staging URL validation rejects localhost unless explicit local mode is enabled", () => {
  assert.throws(() => validateStagingUrl("http://127.0.0.1:4175", { required: true }), /Private or local staging URLs require explicit local mode/);
  assert.equal(validateStagingUrl("http://127.0.0.1:4175", { required: true, allowLocal: true }).hostType, "local");
});

test("staging URL validation rejects private and link-local IPs unless explicit local mode is enabled", () => {
  for (const url of [
    "http://10.0.0.5",
    "http://172.16.0.5",
    "http://192.168.1.5",
    "http://169.254.169.254",
    "http://[fd00::1]",
  ]) {
    assert.throws(() => validateStagingUrl(url, { required: true }), /Private or local staging URLs require explicit local mode/);
  }
  assert.equal(validateStagingUrl("http://10.0.0.5", { required: true, allowLocal: true }).hostType, "private");
});

test("staging workflow contract is protected and does not publish artifacts", () => {
  const workflow = verifyStagingWorkflowContract(STAGING_WORKFLOW);
  assert.equal(workflow.environment, "staging");
  assert.equal(workflow.artifactUploadDefault, false);
  assert.equal(workflow.browserRuntimeSkipAllowed, false);
  assert.equal(workflow.realCloudIntegrationDefault, false);
});

test("staging smoke validates deployed health response safely", async () => {
  const summary = await checkStagingSmoke({
    env: {
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
    },
    fetchImpl: okFetch(),
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.health.status, "ready");
  assert.equal(summary.target.hostType, "remote");
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging smoke rejects missing URL and keeps safe errors", async () => {
  await assert.rejects(
    () => checkStagingSmoke({ env: {}, fetchImpl: okFetch() }),
    /Staging URL is required/,
  );
  const error = await checkStagingSmoke({ env: {}, fetchImpl: okFetch() }).catch((caught) => caught);
  assert.equal(safeSmokeError(error).code, "STAGING_URL_REQUIRED");
  assert.equal(findSensitiveLeak(safeSmokeError(error)), null);
});

test("staging smoke rejects health response leaks", () => {
  assert.throws(
    () => validateHealthPayload(healthPayload({ storageKey: "renders/private/object.mp4" })),
    /contains sensitive data/,
  );
});

test("staging smoke rejects oversized and invalid JSON health responses safely", async () => {
  await assert.rejects(
    () => checkStagingSmoke({
      env: {
        SHORTSENGINE_STAGING_URL: "https://staging.example.test",
        SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
      },
      fetchImpl: async () => new Response("x".repeat(MAX_HEALTH_RESPONSE_BYTES + 1), { status: 200 }),
    }),
    /Staging health response is too large/,
  );
  await assert.rejects(
    () => checkStagingSmoke({
      env: {
        SHORTSENGINE_STAGING_URL: "https://staging.example.test",
        SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
      },
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    }),
    /not valid JSON/,
  );
});

test("staging smoke health URL is derived without query strings", () => {
  assert.equal(
    healthUrlFor("https://staging.example.test/app?token=redacted#frag"),
    "https://staging.example.test/app/health",
  );
});

test("release evidence includes staging readiness safely", () => {
  const nowMs = Date.parse("2026-06-15T19:30:00.000Z");
  const reportDirs = createReportDirs(nowMs);
  const evidence = buildReleaseEvidence({
    env: {},
    nowMs,
    packageJson: PACKAGE_JSON,
    workflowText: CI_WORKFLOW,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: STAGING_WORKFLOW,
    demoResultsDir: reportDirs.demoResultsDir,
    evalResultsDir: reportDirs.evalResultsDir,
    maxAgeMs: 60_000,
  });
  assert.equal(evidence.stagingReadiness.ok, true);
  assert.equal(evidence.stagingReadiness.deployment.provider, "none");
  assert.equal(findSensitiveLeak(evidence.stagingReadiness), null);
});
