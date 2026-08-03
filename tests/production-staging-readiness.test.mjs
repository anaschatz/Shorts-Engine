import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_CONFIGURATION,
  checkProductionStagingReadiness,
  validateReport,
} from "../tools/release/check-production-staging-readiness.mjs";

const COMMIT = "a".repeat(40);
const BLUEPRINT = readFileSync("render.yaml", "utf8");
const DOCKERFILE = readFileSync("Dockerfile.production", "utf8");
const WORKFLOW = readFileSync(".github/workflows/staging.yml", "utf8");

function strictEnv() {
  return {
    SHORTSENGINE_ENVIRONMENT: "staging",
    MATCHCUTS_PERSISTENCE_ADAPTER: "postgres",
    MATCHCUTS_QUEUE_ADAPTER: "postgres",
    MATCHCUTS_STORAGE_ADAPTER: "r2",
    SHORTSENGINE_AUTH_MODE: "oidc",
    SHORTSENGINE_TELEMETRY_ADAPTER: "postgres",
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_PROOF_COMMIT_SHA: COMMIT,
  };
}

function completeEnv() {
  return {
    ...strictEnv(),
    DATABASE_URL: "postgresql://app:placeholder@db.example.test:5432/app",
    SHORTSENGINE_OIDC_ISSUER_URL: "https://identity.example.test/",
    SHORTSENGINE_OIDC_CLIENT_ID: "staging-client",
    SHORTSENGINE_OIDC_CLIENT_SECRET: "placeholder-client-secret",
    SHORTSENGINE_OIDC_REDIRECT_URI: "https://staging.example.test/auth/callback",
    SHORTSENGINE_PUBLIC_BASE_URL: "https://staging.example.test/",
    SHORTSENGINE_SESSION_SECRET: "placeholder-session-secret-at-least-32-bytes",
    MATCHCUTS_STORAGE_BUCKET: "staging-private-bucket",
    MATCHCUTS_STORAGE_ENDPOINT: "https://account.r2.example.test",
    MATCHCUTS_STORAGE_ACCESS_KEY_ID: "placeholder-access",
    MATCHCUTS_STORAGE_SECRET_ACCESS_KEY: "placeholder-storage-secret",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-placeholder1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  };
}

test("production staging readiness fails closed and reports exact missing names", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-staging-readiness-"));
  const reportPath = "readiness.json";
  assert.throws(
    () => checkProductionStagingReadiness({
      rootDir,
      reportPath,
      env: strictEnv(),
      commitSha: COMMIT,
      blueprintText: BLUEPRINT,
      dockerfileText: DOCKERFILE,
      workflowText: WORKFLOW,
    }),
    (error) => {
      assert.equal(error.code, "STAGING_CREDENTIALS_REQUIRED");
      assert.deepEqual(error.report.missingConfiguration, [...REQUIRED_CONFIGURATION].sort());
      assert.equal(error.report.productionReady, false);
      return true;
    },
  );
  const report = JSON.parse(readFileSync(join(rootDir, reportPath), "utf8"));
  assert.equal(validateReport(report), true);
  assert.equal(report.blockerCodes.includes("STAGING_CREDENTIALS_REQUIRED"), true);
});

test("production staging readiness accepts only complete strict runtime configuration", () => {
  const report = checkProductionStagingReadiness({
    env: completeEnv(),
    commitSha: COMMIT,
    blueprintText: BLUEPRINT,
    dockerfileText: DOCKERFILE,
    workflowText: WORKFLOW,
    writeReport: false,
    nowMs: Date.parse("2026-07-27T10:00:00.000Z"),
  });
  assert.equal(report.checks.protectedConfigurationComplete, true);
  assert.equal(report.checks.strictRuntimeConfigurationValid, true);
  assert.equal(report.blockerCodes.includes("REAL_STAGING_NOT_PROVED"), true);
  assert.equal(report.productionReady, false);
});

test("production staging readiness rejects a different proof commit", () => {
  assert.throws(
    () => checkProductionStagingReadiness({
      env: { ...completeEnv(), SHORTSENGINE_PROOF_COMMIT_SHA: "b".repeat(40) },
      commitSha: COMMIT,
      blueprintText: BLUEPRINT,
      dockerfileText: DOCKERFILE,
      workflowText: WORKFLOW,
      writeReport: false,
    }),
    (error) => error.code === "STAGING_COMMIT_MISMATCH",
  );
});
