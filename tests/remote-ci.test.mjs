import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  parseRemoteCiConfig,
  runRemoteCiCheck,
  safeError,
} from "../tools/release/check-remote-ci.mjs";
import {
  buildRemoteCiProof,
  writeRemoteCiProof,
} from "../tools/release/write-remote-ci-proof.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW_MS = Date.parse("2026-06-16T12:00:00.000Z");

function commandKey(command, args) {
  return `${command} ${args.join(" ")}`;
}

function baseResponses(overrides = {}) {
  return {
    "git rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "git rev-parse HEAD": { stdout: `${SHA}\n` },
    "git remote": { stdout: "origin\n" },
    "gh --version": { stdout: "gh version 2.0.0\n" },
    "gh auth status": { stdout: "Logged in to github.com\n" },
    "gh repo view --json nameWithOwner,url": {
      stdout: JSON.stringify({ nameWithOwner: "anaschatz/Shorts-Engine", url: "https://github.com/anaschatz/Shorts-Engine" }),
    },
    "gh run list --workflow ShortsEngine CI --branch main --limit 20 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,createdAt,updatedAt,name": {
      stdout: JSON.stringify([{
        databaseId: 1001,
        headBranch: "main",
        headSha: SHA,
        status: "completed",
        conclusion: "success",
        workflowName: "ShortsEngine CI",
        url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
        createdAt: "2026-06-16T11:59:00.000Z",
      }]),
    },
    "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": {
      stdout: JSON.stringify({
        databaseId: 1001,
        headBranch: "main",
        headSha: SHA,
        status: "completed",
        conclusion: "success",
        workflowName: "ShortsEngine CI",
        url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
        jobs: [{ name: "Release gate", status: "completed", conclusion: "success" }],
      }),
    },
    ...overrides,
  };
}

function mockRunner(responses = baseResponses()) {
  const calls = [];
  const runner = async (command, args) => {
    const key = commandKey(command, args);
    calls.push(key);
    const response = responses[key];
    if (Array.isArray(response)) {
      const next = response.shift();
      if (next instanceof Error) throw next;
      return next || { stdout: "" };
    }
    if (response instanceof Error) throw response;
    if (!response) throw Object.assign(new Error(`Unexpected command: ${key}`), { exitCode: 1 });
    return response;
  };
  runner.calls = calls;
  return runner;
}

async function check(options = {}) {
  return await runRemoteCiCheck({
    env: {
      SHORTSENGINE_REMOTE_CI_TIMEOUT_MS: "1000",
      SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS: "500",
      ...(options.env || {}),
    },
    nowMs: NOW_MS,
    commandRunner: options.commandRunner || mockRunner(options.responses || baseResponses()),
    sleep: async () => {},
  });
}

test("remote CI verifier returns safe success summary", async () => {
  const summary = await check();

  assert.equal(summary.ok, true);
  assert.equal(summary.repository.detected, true);
  assert.equal(summary.repository.nameWithOwner, "anaschatz/Shorts-Engine");
  assert.equal(summary.branch, "main");
  assert.equal(summary.commit.sha, SHA);
  assert.equal(summary.workflow.name, "ShortsEngine CI");
  assert.equal(summary.workflow.releaseJobName, "Release gate");
  assert.equal(summary.workflow.status, "completed");
  assert.equal(summary.workflow.conclusion, "success");
  assert.deepEqual(summary.releaseJob, {
    name: "Release gate",
    found: true,
    status: "completed",
    conclusion: "success",
  });
  assert.equal(summary.failedJobs.count, 0);
  assert.equal(summary.logsDownloaded, false);
  assert.equal(summary.artifactsDownloaded, false);
  assert.equal(summary.nextAction, "none");
  assert.equal(findSensitiveLeak(summary), null);
});

test("remote CI verifier reports failed release gate without raw logs", async () => {
  const summary = await check({
    responses: baseResponses({
      "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "completed",
          conclusion: "failure",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [
            { name: "Release gate", status: "completed", conclusion: "failure" },
            { name: "Upload failure reports", status: "completed", conclusion: "skipped" },
          ],
        }),
      },
    }),
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.workflow.conclusion, "failure");
  assert.deepEqual(summary.releaseJob, {
    name: "Release gate",
    found: true,
    status: "completed",
    conclusion: "failure",
  });
  assert.equal(summary.failedJobs.count, 1);
  assert.deepEqual(summary.failedJobs.names, ["Release gate"]);
  assert.equal(summary.nextAction, "inspect-safe-summary-and-fix-forward");
  assert.equal(summary.logsDownloaded, false);
  assert.equal(summary.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("remote CI verifier polls queued runs until completion", async () => {
  const runner = mockRunner(baseResponses({
    "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": [
      {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "in_progress",
          conclusion: "",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [{ name: "Release gate", status: "in_progress", conclusion: "" }],
        }),
      },
      {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "completed",
          conclusion: "success",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [{ name: "Release gate", status: "completed", conclusion: "success" }],
        }),
      },
    ],
  }));

  const summary = await check({ commandRunner: runner });

  assert.equal(summary.ok, true);
  assert.equal(summary.polling.attempts, 2);
  assert.equal(runner.calls.filter((call) => call.startsWith("gh run view")).length, 2);
});

test("remote CI verifier fails safely when gh is missing or unauthenticated", async () => {
  const missingGh = await check({
    commandRunner: mockRunner(baseResponses({
      "gh --version": Object.assign(new Error("not found"), { code: "ENOENT" }),
    })),
  }).catch((caught) => caught);
  assert.equal(safeError(missingGh).code, "REMOTE_CI_GH_MISSING");
  assert.equal(findSensitiveLeak(safeError(missingGh)), null);

  const unauthenticated = await check({
    commandRunner: mockRunner(baseResponses({
      "gh auth status": Object.assign(new Error("auth failed"), { exitCode: 1, stderr: "token is not shown" }),
    })),
  }).catch((caught) => caught);
  assert.equal(safeError(unauthenticated).code, "REMOTE_CI_GH_AUTH_MISSING");
  assert.equal(findSensitiveLeak(safeError(unauthenticated)), null);
});

test("remote CI verifier fails safely when git remote or run is missing", async () => {
  const noRemote = await check({
    commandRunner: mockRunner(baseResponses({ "git remote": { stdout: "" } })),
  }).catch((caught) => caught);
  assert.equal(safeError(noRemote).code, "REMOTE_CI_REMOTE_MISSING");

  const noRun = await check({
    responses: baseResponses({
      "gh run list --workflow ShortsEngine CI --branch main --limit 20 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,createdAt,updatedAt,name": {
        stdout: "[]",
      },
    }),
  }).catch((caught) => caught);
  assert.equal(safeError(noRun).code, "REMOTE_CI_RUN_NOT_FOUND");
  assert.equal(findSensitiveLeak(safeError(noRun)), null);
});

test("remote CI verifier rejects invalid JSON and unsafe GitHub output", async () => {
  const invalidJson = await check({
    responses: baseResponses({
      "gh run list --workflow ShortsEngine CI --branch main --limit 20 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,createdAt,updatedAt,name": {
        stdout: "not-json",
      },
    }),
  }).catch((caught) => caught);
  assert.equal(safeError(invalidJson).code, "REMOTE_CI_RUNS_JSON_INVALID");

  const leakedOutput = await check({
    responses: baseResponses({
      "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "completed",
          conclusion: "failure",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [{ name: "/Users/example/leaky-job", status: "completed", conclusion: "failure" }],
        }),
      },
    }),
  }).catch((caught) => caught);
  assert.equal(safeError(leakedOutput).code, "REMOTE_CI_OUTPUT_LEAK");
  assert.equal(findSensitiveLeak(safeError(leakedOutput)), null);
});

test("remote CI verifier times out while run is pending", async () => {
  const pending = await runRemoteCiCheck({
    env: {
      SHORTSENGINE_REMOTE_CI_TIMEOUT_MS: "1000",
      SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS: "500",
    },
    nowMs: NOW_MS,
    commandRunner: mockRunner(baseResponses({
      "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "queued",
          conclusion: "",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [{ name: "Release gate", status: "queued", conclusion: "" }],
        }),
      },
    })),
    sleep: async () => {},
  }).catch((caught) => caught);

  assert.equal(safeError(pending).code, "REMOTE_CI_TIMEOUT");
  assert.equal(findSensitiveLeak(safeError(pending)), null);
});

test("remote CI verifier config is bounded", () => {
  assert.equal(parseRemoteCiConfig({ env: {} }).workflowName, "ShortsEngine CI");
  assert.throws(
    () => parseRemoteCiConfig({ env: { SHORTSENGINE_REMOTE_CI_TIMEOUT_MS: "10" } }),
    /out of bounds/,
  );
  assert.throws(
    () => parseRemoteCiConfig({ env: { SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS: "999999" } }),
    /out of bounds/,
  );
});

test("remote CI proof has safe release evidence shape", async () => {
  const summary = await check();
  const proof = buildRemoteCiProof(summary);

  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.remoteCi.ok, true);
  assert.equal(proof.remoteCi.repository.nameWithOwner, "anaschatz/Shorts-Engine");
  assert.equal(proof.remoteCi.commit.shortSha, SHA.slice(0, 12));
  assert.equal(proof.remoteCi.workflow.runId, 1001);
  assert.equal(proof.remoteCi.releaseJob.conclusion, "success");
  assert.equal(proof.remoteCi.logsDownloaded, false);
  assert.equal(proof.remoteCi.artifactsDownloaded, false);
  assert.equal(proof.fixForward.required, false);
  assert.equal(findSensitiveLeak(proof), null);
});

test("remote CI proof writer writes latest and timestamped reports", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-remote-ci-proof-"));
  const result = await writeRemoteCiProof({
    rootDir,
    env: {
      SHORTSENGINE_REMOTE_CI_TIMEOUT_MS: "1000",
      SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS: "500",
    },
    nowMs: NOW_MS,
    commandRunner: mockRunner(baseResponses()),
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.latestPath, "release/results/remote-ci-latest.json");
  assert.equal(existsSync(join(rootDir, result.latestPath)), true);
  assert.equal(existsSync(join(rootDir, result.reportPath)), true);
  const latest = JSON.parse(readFileSync(join(rootDir, result.latestPath), "utf8"));
  assert.equal(latest.remoteCi.releaseJob.status, "completed");
  assert.equal(findSensitiveLeak(latest), null);
});

test("remote CI proof writer preserves failed CI guidance without logs or artifacts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-remote-ci-failed-proof-"));
  const result = await writeRemoteCiProof({
    rootDir,
    env: {
      SHORTSENGINE_REMOTE_CI_TIMEOUT_MS: "1000",
      SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS: "500",
    },
    nowMs: NOW_MS,
    commandRunner: mockRunner(baseResponses({
      "gh run view 1001 --json databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs": {
        stdout: JSON.stringify({
          databaseId: 1001,
          headBranch: "main",
          headSha: SHA,
          status: "completed",
          conclusion: "failure",
          workflowName: "ShortsEngine CI",
          url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/1001",
          jobs: [{ name: "Release gate", status: "completed", conclusion: "failure" }],
        }),
      },
    })),
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  const latest = JSON.parse(readFileSync(join(rootDir, result.latestPath), "utf8"));
  assert.equal(latest.remoteCi.failedJobs.count, 1);
  assert.equal(latest.remoteCi.logsDownloaded, false);
  assert.equal(latest.remoteCi.artifactsDownloaded, false);
  assert.equal(latest.fixForward.required, true);
  assert.equal(findSensitiveLeak(latest), null);
});
