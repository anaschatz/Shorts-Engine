const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const {
  REQUIRED_RELEASE_SCRIPTS,
  createReleaseReadiness,
} = require("../server/release-readiness.cjs");

const VALID_WORKFLOW = `
name: ShortsEngine CI
jobs:
  release:
    steps:
      - run: npm run release:check
      - uses: actions/upload-artifact@v4
        if: failure()
`;

function validPackage(overrides = {}) {
  return {
    scripts: {
      ...REQUIRED_RELEASE_SCRIPTS,
      ...(overrides.scripts || {}),
    },
  };
}

function hasSensitiveLeak(value) {
  return /\/Users|\/private|file:\/\/|storageKey|secret|ghp_|github_pat_|Bearer\s+|sk-[A-Za-z0-9_-]{10,}/i.test(JSON.stringify(value));
}

test("release readiness exposes safe no-network CI and GitHub proof capability", () => {
  const summary = createReleaseReadiness({
    packageJson: validPackage(),
    workflowText: VALID_WORKFLOW,
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.mode, "local-static-readiness");
  assert.equal(summary.networkCalls, false);
  assert.equal(summary.authStarted, false);
  assert.equal(summary.remoteMutation, false);
  assert.equal(summary.tokensRequested, false);
  assert.equal(summary.logsDownloaded, false);
  assert.equal(summary.artifactsDownloaded, false);
  assert.equal(summary.scripts["github:setup"], true);
  assert.equal(summary.scripts["remote:ci:proof"], true);
  assert.equal(summary.workflow.configured, true);
  assert.equal(summary.workflow.failureArtifactsOnly, true);
  assert.equal(summary.remoteProof.requiresGithubCli, true);
  assert.equal(summary.remoteProof.automaticAuth, false);
  assert.equal(summary.nextAction, "run-release-checks-before-push");
  assert.equal(hasSensitiveLeak(summary), false);
});

test("release readiness fails closed when required scripts or workflow markers are missing", () => {
  const summary = createReleaseReadiness({
    packageJson: validPackage({
      scripts: { "remote:ci:proof": "node unsafe.js" },
    }),
    workflowText: "name: missing release gate",
  });

  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing.scripts, ["remote:ci:proof"]);
  assert.equal(summary.missing.workflowMarkers.includes("npm run release:check"), true);
  assert.equal(summary.nextAction, "fix-release-readiness-contract");
  assert.equal(hasSensitiveLeak(summary), false);
});

test("release readiness reads local files without exposing absolute paths", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-release-readiness-"));
  writeFileSync(join(rootDir, "package.json"), `${JSON.stringify(validPackage(), null, 2)}\n`, "utf8");
  const workflowDir = join(rootDir, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "ci.yml"), VALID_WORKFLOW, "utf8");

  const summary = createReleaseReadiness({ rootDir });
  assert.equal(summary.ready, true);
  assert.equal(JSON.stringify(summary).includes(rootDir), false);
  assert.equal(hasSensitiveLeak(summary), false);
});
