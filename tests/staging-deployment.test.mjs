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
  checkStagingSmoke,
  healthUrlFor,
  safeError as safeSmokeError,
  validateHealthPayload,
} from "../tools/release/check-staging-smoke.mjs";
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

test("staging readiness accepts explicit provider target with protected credential", () => {
  const summary = checkStagingReadiness(readinessOptions({
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "custom",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  }));
  assert.equal(summary.deployment.target, "staging");
  assert.equal(summary.deployment.providerConfigured, true);
  assert.equal(summary.deployment.deployCredentialConfigured, true);
  assert.equal(summary.deployment.stagingUrlHostType, "remote");
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging URL validation rejects invalid and credentialed URLs", () => {
  assert.throws(() => validateStagingUrl("ftp://staging.example.test", { required: true }), /http or https/);
  assert.throws(() => validateStagingUrl("https://user:pass@staging.example.test", { required: true }), /must not embed credentials/);
});

test("staging URL validation rejects localhost unless explicit local mode is enabled", () => {
  assert.throws(() => validateStagingUrl("http://127.0.0.1:4175", { required: true }), /Local staging URLs require explicit local mode/);
  assert.equal(validateStagingUrl("http://127.0.0.1:4175", { required: true, allowLocal: true }).hostType, "local");
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
