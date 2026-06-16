import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  FAILURE_ARTIFACT_ALLOWLIST,
  REQUIRED_WORKFLOW_COMMANDS,
  verifyReleaseGate,
} from "../tools/release/verify-release-gate.mjs";
import {
  buildReleaseEvidence,
  writeReleaseEvidence,
} from "../tools/release/write-release-evidence.mjs";

const VALID_WORKFLOW = readFileSync(".github/workflows/ci.yml", "utf8");
const VALID_STAGING_WORKFLOW = readFileSync(".github/workflows/staging.yml", "utf8");
const VALID_PACKAGE = JSON.parse(readFileSync("package.json", "utf8"));
const ENV_DOCS = readFileSync("docs/ENVIRONMENT.md", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");
const STAGING_DOCS = readFileSync("docs/STAGING_DEPLOYMENT.md", "utf8");

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createFixtureRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-release-gate-"));
  const demoResultsDir = join(rootDir, "demo-results");
  const evalResultsDir = join(rootDir, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  const nowMs = Date.parse("2026-06-15T18:30:00.000Z");
  const timestamp = new Date(nowMs).toISOString();

  writeJson(join(demoResultsDir, "latest.json"), {
    timestamp,
    status: "passed",
    reportPath: "demo/results/latest.json",
    checks: [{ name: "download_returns_rendered_video", passed: true }],
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
      screenshotOnFailure: true,
      traceOnFailure: false,
      videoOnFailure: false,
      files: [],
    },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 99, fixtureCount: 6 },
    failedCases: [],
  });

  return { rootDir, demoResultsDir, evalResultsDir, nowMs };
}

function verifyWithFixture(overrides = {}) {
  const fixture = createFixtureRoot();
  return verifyReleaseGate({
    rootDir: fixture.rootDir,
    packageJson: VALID_PACKAGE,
    workflowText: VALID_WORKFLOW,
    demoResultsDir: fixture.demoResultsDir,
    evalResultsDir: fixture.evalResultsDir,
    maxAgeMs: 60_000,
    nowMs: fixture.nowMs,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: VALID_STAGING_WORKFLOW,
    ...overrides,
  });
}

test("release gate verifier accepts the valid workflow contract", () => {
  const result = verifyWithFixture();
  assert.equal(result.ok, true);
  assert.deepEqual(result.workflow.commands, REQUIRED_WORKFLOW_COMMANDS);
  assert.deepEqual(result.artifactPolicy.allowlist, FAILURE_ARTIFACT_ALLOWLIST);
  assert.equal(result.workflow.realCloudIntegrationDefault, false);
  assert.equal(result.workflow.browserRuntimeSkipAllowed, false);
  assert.deepEqual(result.workflow.runtimeTools, {
    ffmpegInstallRequired: true,
    ffmpegVerifyRequired: true,
  });
  assert.equal(result.releaseReadiness.ready, true);
  assert.equal(result.releaseReadiness.networkCalls, false);
  assert.equal(result.releaseReadiness.remoteProof.automaticAuth, false);
  assert.equal(result.staging.ok, true);
  assert.equal(result.staging.workflow.environment, "staging");
});

test("release gate verifier rejects missing required commands", () => {
  const workflowText = VALID_WORKFLOW.replace("npm run eval", "npm run eval:missing");
  assert.throws(
    () => verifyWithFixture({ workflowText }),
    /CI workflow is missing a required command/,
  );
});

test("release gate verifier rejects browser runtime skip flags", () => {
  const workflowText = `${VALID_WORKFLOW}\n      SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP: "1"\n`;
  assert.throws(
    () => verifyWithFixture({ workflowText }),
    /Release gate must not skip missing Playwright runtime/,
  );
});

test("release gate verifier rejects missing FFmpeg runtime setup", () => {
  const workflowText = VALID_WORKFLOW.replace(/      - name: Install FFmpeg tools[\s\S]*?(?=      - name: Verify runtime tools)/, "");
  assert.throws(
    () => verifyWithFixture({ workflowText }),
    /CI workflow must install FFmpeg tools before runtime verification/,
  );
});

test("release gate verifier rejects unsafe artifact upload globs", () => {
  const workflowText = VALID_WORKFLOW.replace("demo/results/latest.json", "demo/results/*.json");
  assert.throws(
    () => verifyWithFixture({ workflowText }),
    /CI artifact upload path is unsafe|CI artifact upload allowlist is invalid/,
  );
});

test("release gate verifier rejects real cloud integration in default CI", () => {
  const workflowText = `${VALID_WORKFLOW}\n      - name: Real cloud\n        run: npm run integration:cloud\n`;
  assert.throws(
    () => verifyWithFixture({ workflowText }),
    /Real cloud integration must stay out of the default CI gate/,
  );
});

test("release evidence JSON has safe shape and no sensitive leakage", () => {
  const fixture = createFixtureRoot();
  const evidence = buildReleaseEvidence({
    rootDir: fixture.rootDir,
    packageJson: VALID_PACKAGE,
    workflowText: VALID_WORKFLOW,
    demoResultsDir: fixture.demoResultsDir,
    evalResultsDir: fixture.evalResultsDir,
    maxAgeMs: 60_000,
    nowMs: fixture.nowMs,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: VALID_STAGING_WORKFLOW,
  });

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.releaseGate.ok, true);
  assert.equal(evidence.releaseReadiness.ready, true);
  assert.equal(evidence.releaseReadiness.remoteMutation, false);
  assert.equal(evidence.stagingReadiness.ok, true);
  assert.equal(evidence.latestReports.length, 4);
  assert.equal(evidence.latestReports[0].relativePath, "latest.json");
  assert.equal(findSensitiveLeak(evidence), null);
});

test("release evidence writer writes latest and timestamped reports", () => {
  const fixture = createFixtureRoot();
  const result = writeReleaseEvidence({
    rootDir: fixture.rootDir,
    packageJson: VALID_PACKAGE,
    workflowText: VALID_WORKFLOW,
    demoResultsDir: fixture.demoResultsDir,
    evalResultsDir: fixture.evalResultsDir,
    maxAgeMs: 60_000,
    nowMs: fixture.nowMs,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: VALID_STAGING_WORKFLOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.latest, "release/results/latest.json");
  assert.equal(existsSync(join(fixture.rootDir, result.latest)), true);
  assert.equal(existsSync(join(fixture.rootDir, result.report)), true);
  const latest = JSON.parse(readFileSync(join(fixture.rootDir, result.latest), "utf8"));
  assert.equal(findSensitiveLeak(latest), null);
});

test("release gate handles missing git remote safely", () => {
  const result = verifyWithFixture();
  assert.equal(result.remote.isRepository, false);
  assert.match(result.limitations.join(" "), /No local git repository metadata was detected/);
});

test("release gate verifier is deterministic for fixed inputs", () => {
  const fixture = createFixtureRoot();
  const options = {
    rootDir: fixture.rootDir,
    packageJson: VALID_PACKAGE,
    workflowText: VALID_WORKFLOW,
    demoResultsDir: fixture.demoResultsDir,
    evalResultsDir: fixture.evalResultsDir,
    maxAgeMs: 60_000,
    nowMs: fixture.nowMs,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: VALID_STAGING_WORKFLOW,
  };
  assert.deepEqual(verifyReleaseGate(options), verifyReleaseGate(options));
});
