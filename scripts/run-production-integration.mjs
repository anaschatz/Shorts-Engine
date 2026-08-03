#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const env = {
  ...process.env,
  TEST_POSTGRES_URL: process.env.TEST_POSTGRES_URL
    || "postgresql://shortsengine:local-integration-only@127.0.0.1:55432/shortsengine_test",
  TEST_S3_ENDPOINT: process.env.TEST_S3_ENDPOINT || "http://127.0.0.1:59000",
  TEST_S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID || "shortsengine-test",
  TEST_S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY
    || "local-integration-secret",
};

const files = [
  "tests/postgres-production-foundation.test.cjs",
  "tests/postgres-job-queue.integration.test.cjs",
  "tests/postgres-football-review.integration.test.cjs",
  "tests/s3-object-storage.integration.test.cjs",
  "tests/production-hardening-stage2.test.cjs",
];

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  cwd: process.cwd(),
  env,
  shell: false,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Production integration runner failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  const successful = !signal && code === 0;
  if (successful) {
    const commitSha = String(execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf8" },
    )).trim().toLowerCase();
    const expectedCommitSha = String(
      process.env.SHORTSENGINE_PROOF_COMMIT_SHA || commitSha,
    ).trim().toLowerCase();
    if (
      !/^[a-f0-9]{40}$/.test(commitSha)
      || !/^[a-f0-9]{40}$/.test(expectedCommitSha)
      || commitSha !== expectedCommitSha
    ) {
      console.error("Production integration proof commit binding failed.");
      process.exitCode = 1;
      return;
    }
    const report = {
      schemaVersion: 1,
      proofType: "stage2_reduced_local_integration",
      commitSha,
      environment: "disposable_postgres_and_s3",
      checks: {
        migrations: true,
        multiWorkerQueue: true,
        leaseRecovery: true,
        retryAndCancellation: true,
        ownershipIsolation: true,
        objectStorageSharedAccess: true,
        footballReviewTransactions: true,
        jobAttemptHistory: true,
        durableCostAndMetricSchema: true,
        externalOidcProvider: false,
        realStagingDeployment: false,
      },
      productionReady: false,
      blockerCodes: [
        "EXTERNAL_OIDC_NOT_PROVED",
        "REAL_STAGING_NOT_PROVED",
        "REAL_PROVIDER_COSTS_NOT_PROVED",
      ],
    };
    const output = resolve("release/results/stage2-local-integration-proof.json");
    mkdirSync(resolve("release/results"), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(JSON.stringify({
      status: "passed",
      productionReady: false,
      report: "release/results/stage2-local-integration-proof.json",
      blockerCodes: report.blockerCodes,
    }));
  }
  process.exitCode = successful ? 0 : 1;
});
