import test from "node:test";
import assert from "node:assert/strict";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  branchProtectionReadiness,
  runGithubCliDoctor,
  safeError,
} from "../tools/release/check-github-cli.mjs";

const NOW_MS = Date.parse("2026-06-16T13:00:00.000Z");

function commandKey(command, args) {
  return `${command} ${args.join(" ")}`;
}

function protectedBranchPayload(overrides = {}) {
  return {
    required_status_checks: {
      strict: true,
      contexts: ["Release gate"],
      checks: [],
    },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
    },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    ...overrides,
  };
}

function baseResponses(overrides = {}) {
  return {
    "git rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "git remote": { stdout: "origin\n" },
    "gh --version": { stdout: "gh version 2.0.0\n" },
    "gh auth status": { stdout: "Logged in to github.com\n" },
    "gh repo view --json nameWithOwner,url": {
      stdout: JSON.stringify({ nameWithOwner: "anaschatz/Shorts-Engine", url: "https://github.com/anaschatz/Shorts-Engine" }),
    },
    "gh run list --limit 1 --json databaseId,status,conclusion,workflowName,url,headBranch,headSha,createdAt,updatedAt,name": {
      stdout: JSON.stringify([{
        databaseId: 2002,
        status: "completed",
        conclusion: "success",
        workflowName: "ShortsEngine CI",
        url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/2002",
      }]),
    },
    "gh api repos/anaschatz/Shorts-Engine/branches/main/protection": {
      stdout: JSON.stringify(protectedBranchPayload()),
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
    if (response instanceof Error) throw response;
    if (!response) throw Object.assign(new Error(`Unexpected command: ${key}`), { exitCode: 1 });
    return response;
  };
  runner.calls = calls;
  return runner;
}

async function doctor(options = {}) {
  return await runGithubCliDoctor({
    env: options.env || {},
    nowMs: NOW_MS,
    commandRunner: options.commandRunner || mockRunner(options.responses || baseResponses()),
  });
}

test("GitHub CLI doctor returns safe readiness summary", async () => {
  const summary = await doctor();

  assert.equal(summary.ok, true);
  assert.equal(summary.githubCli.available, true);
  assert.equal(summary.githubCli.authenticated, true);
  assert.equal(summary.repository.nameWithOwner, "anaschatz/Shorts-Engine");
  assert.equal(summary.actions.readable, true);
  assert.equal(summary.actions.latestRunSeen, true);
  assert.equal(summary.branchProtection.status, "verified");
  assert.equal(summary.logsDownloaded, false);
  assert.equal(summary.artifactsDownloaded, false);
  assert.equal(summary.remoteMutation, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("GitHub CLI doctor fails safely when gh is missing or auth is missing", async () => {
  const missingGh = await doctor({
    commandRunner: mockRunner(baseResponses({
      "gh --version": Object.assign(new Error("not found"), { code: "ENOENT" }),
    })),
  }).catch((caught) => caught);
  const missingGhError = safeError(missingGh);
  assert.equal(missingGhError.code, "GITHUB_CLI_MISSING");
  assert.equal(missingGhError.nextAction, "run-npm-run-github-setup");
  assert.equal(findSensitiveLeak(missingGhError), null);

  const missingAuth = await doctor({
    commandRunner: mockRunner(baseResponses({
      "gh auth status": Object.assign(new Error("auth failed"), { exitCode: 1, stderr: "raw token never printed" }),
    })),
  }).catch((caught) => caught);
  const missingAuthError = safeError(missingAuth);
  assert.equal(missingAuthError.code, "GITHUB_AUTH_MISSING");
  assert.equal(missingAuthError.nextAction, "run-gh-auth-login-manually");
  assert.equal(findSensitiveLeak(missingAuthError), null);
});

test("GitHub CLI doctor fails safely when repo or Actions metadata is unreadable", async () => {
  const repoUnreadable = await doctor({
    commandRunner: mockRunner(baseResponses({
      "gh repo view --json nameWithOwner,url": Object.assign(new Error("forbidden"), { exitCode: 1 }),
    })),
  }).catch((caught) => caught);
  assert.equal(safeError(repoUnreadable).code, "GITHUB_REPO_UNREADABLE");

  const actionsUnreadable = await doctor({
    commandRunner: mockRunner(baseResponses({
      "gh run list --limit 1 --json databaseId,status,conclusion,workflowName,url,headBranch,headSha,createdAt,updatedAt,name": Object.assign(new Error("forbidden"), { exitCode: 1 }),
    })),
  }).catch((caught) => caught);
  assert.equal(safeError(actionsUnreadable).code, "GITHUB_ACTIONS_UNREADABLE");
  assert.equal(findSensitiveLeak(safeError(actionsUnreadable)), null);
});

test("GitHub CLI doctor rejects unsafe GitHub output", async () => {
  const leaked = await doctor({
    responses: baseResponses({
      "gh run list --limit 1 --json databaseId,status,conclusion,workflowName,url,headBranch,headSha,createdAt,updatedAt,name": {
        stdout: JSON.stringify([{ databaseId: 2002, workflowName: "/Users/example/leak", status: "completed" }]),
      },
    }),
  }).catch((caught) => caught);

  assert.equal(safeError(leaked).code, "GITHUB_OUTPUT_UNSAFE");
  assert.equal(findSensitiveLeak(safeError(leaked)), null);
});

test("branch protection readiness reports incomplete and unknown states safely", async () => {
  const incomplete = branchProtectionReadiness(protectedBranchPayload({
    required_status_checks: { strict: false, contexts: ["Other check"] },
    required_pull_request_reviews: null,
    allow_force_pushes: { enabled: true },
  }), "main");

  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.checks.requiredStatusCheck, false);
  assert.equal(incomplete.checks.pullRequestRequired, false);
  assert.equal(incomplete.checks.forcePushBlocked, false);
  assert.equal(incomplete.checks.deletionBlocked, true);
  assert.equal(incomplete.checks.upToDateRequired, false);
  assert.equal(findSensitiveLeak(incomplete), null);

  const unknown = await doctor({
    commandRunner: mockRunner(baseResponses({
      "gh api repos/anaschatz/Shorts-Engine/branches/main/protection": Object.assign(new Error("not permitted"), { exitCode: 1 }),
    })),
  });
  assert.equal(unknown.branchProtection.status, "unknown");
  assert.equal(unknown.branchProtection.nextAction, "confirm-branch-protection-in-github-ui");
  assert.equal(findSensitiveLeak(unknown), null);
});
