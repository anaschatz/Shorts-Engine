import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  ENV_CONTRACT,
  checkEnvironment,
  safeError,
  validateExampleSecrets,
} from "../tools/release/check-environment.mjs";
import { buildReleaseEvidence } from "../tools/release/write-release-evidence.mjs";

const ENV_DOCS = readFileSync("docs/ENVIRONMENT.md", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");
const WORKFLOW = readFileSync(".github/workflows/ci.yml", "utf8");
const STAGING_DOCS = readFileSync("docs/STAGING_DEPLOYMENT.md", "utf8");
const STAGING_WORKFLOW = readFileSync(".github/workflows/staging.yml", "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync("package.json", "utf8"));

function safeOptions(env = {}) {
  return {
    env,
    nowMs: Date.parse("2026-06-15T18:45:00.000Z"),
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
  };
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createReportDirs(nowMs) {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-env-release-"));
  const demoResultsDir = join(root, "demo-results");
  const evalResultsDir = join(root, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  const timestamp = new Date(nowMs).toISOString();
  writeJson(join(demoResultsDir, "latest.json"), {
    timestamp,
    status: "passed",
    reportPath: "demo/results/latest.json",
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "browser-latest.json"), {
    timestamp,
    status: "passed",
    reportPath: "demo/results/browser-latest.json",
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "playwright-latest.json"), {
    timestamp,
    status: "passed",
    reportPath: "demo/results/playwright-latest.json",
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

function validReportOptions() {
  const nowMs = Date.parse("2026-06-15T18:45:00.000Z");
  const reportDirs = createReportDirs(nowMs);
  return {
    env: {},
    nowMs,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    packageJson: PACKAGE_JSON,
    workflowText: WORKFLOW,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: STAGING_WORKFLOW,
    demoResultsDir: reportDirs.demoResultsDir,
    evalResultsDir: reportDirs.evalResultsDir,
    maxAgeMs: 60_000,
  };
}

test(".env.example exists and contains no real secrets", () => {
  assert.match(ENV_EXAMPLE, /MATCHCUTS_TRANSCRIPTION_PROVIDER=mock/);
  assert.doesNotMatch(ENV_EXAMPLE, /sk-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(ENV_EXAMPLE, /AKIA[A-Z0-9]{12,}/);
  assert.doesNotThrow(() => validateExampleSecrets(ENV_EXAMPLE));
});

test("environment docs mention all known env vars", () => {
  for (const spec of ENV_CONTRACT) {
    assert.match(ENV_DOCS, new RegExp(`\\b${spec.name}\\b`), `${spec.name} should be documented`);
  }
});

test("environment check passes with default safe config", () => {
  const summary = checkEnvironment(safeOptions());
  assert.equal(summary.ok, true);
  assert.equal(summary.storage.adapter, "local");
  assert.equal(summary.transcription.activeProvider, "mock");
  assert.equal(summary.cloudIntegration.enabled, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("environment check rejects invalid numeric config", () => {
  assert.throws(
    () => checkEnvironment(safeOptions({ PORT: "-1" })),
    /Numeric environment value is out of bounds/,
  );
});

test("environment check rejects unsupported storage adapter", () => {
  assert.throws(
    () => checkEnvironment(safeOptions({ MATCHCUTS_STORAGE_ADAPTER: "ftp" })),
    /Environment value is not supported/,
  );
});

test("environment check rejects real provider without key", () => {
  const error = assert.throws(
    () => checkEnvironment(safeOptions({ MATCHCUTS_TRANSCRIPTION_PROVIDER: "openai" })),
    /Real transcription provider requires a configured credential/,
  );
  const payload = safeError(error);
  assert.equal(findSensitiveLeak(payload), null);
  assert.doesNotMatch(JSON.stringify(payload), /OPENAI_API_KEY|sk-/);
});

test("environment check rejects cloud storage without credentials", () => {
  assert.throws(
    () => checkEnvironment(safeOptions({
      MATCHCUTS_STORAGE_ADAPTER: "s3",
      MATCHCUTS_STORAGE_BUCKET: "shortsengine-staging",
      MATCHCUTS_STORAGE_REGION: "us-east-1",
    })),
    /Cloud storage adapter requires bucket and credentials/,
  );
});

test("environment check rejects signed URL TTL out of bounds", () => {
  assert.throws(
    () => checkEnvironment(safeOptions({ MATCHCUTS_STORAGE_SIGNED_URL_TTL_SECONDS: "99999" })),
    /Numeric environment value is out of bounds/,
  );
});

test("environment check rejects unsafe browser skip flag", () => {
  assert.throws(
    () => checkEnvironment(safeOptions({ SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP: "1" })),
    /Browser runtime skip is not allowed/,
  );
});

test("release evidence includes safe environment readiness summary", () => {
  const evidence = buildReleaseEvidence(validReportOptions());
  assert.equal(evidence.environmentReadiness.ok, true);
  assert.equal(evidence.environmentReadiness.safeDefaults.mockTranscriptionDefault, true);
  assert.equal(findSensitiveLeak(evidence.environmentReadiness), null);
});
