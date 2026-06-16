import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  runBranchProtectionCheck,
  rulesetReadiness,
  safeError,
} from "../tools/release/check-branch-protection.mjs";
import { buildBranchRulesetSetupGuide } from "../tools/release/print-branch-ruleset-setup.mjs";
import { writeBranchPolicyProof } from "../tools/release/write-branch-protection-proof.mjs";

const NOW_MS = Date.parse("2026-06-16T21:00:00.000Z");
const SHA = "3ab1492c3540f75000cca9df94111998d2af6af4";

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

function activeRuleset(overrides = {}) {
  return {
    name: "main release rules",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: ["refs/heads/main"],
        exclude: [],
      },
    },
    bypass_actors: [],
    rules: [
      { type: "pull_request" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "Release gate" }],
        },
      },
      { type: "non_fast_forward" },
      { type: "deletion" },
      { type: "required_conversation_resolution" },
    ],
    ...overrides,
  };
}

function baseResponses(overrides = {}) {
  return {
    "git rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "git remote": { stdout: "origin\n" },
    "git rev-parse HEAD": { stdout: `${SHA}\n` },
    "git ls-remote origin refs/heads/main": { stdout: `${SHA}\trefs/heads/main\n` },
    "gh --version": { stdout: "gh version 2.94.0\n" },
    "gh auth status": { stdout: "Logged in to github.com\n" },
    "gh repo view --json nameWithOwner,url": {
      stdout: JSON.stringify({ nameWithOwner: "anaschatz/Shorts-Engine", url: "https://github.com/anaschatz/Shorts-Engine" }),
    },
    "gh run list --limit 1 --json databaseId,status,conclusion,workflowName,url,headBranch,headSha,createdAt,updatedAt,name": {
      stdout: JSON.stringify([{
        databaseId: 27646269113,
        status: "completed",
        conclusion: "success",
        workflowName: "ShortsEngine CI",
        url: "https://github.com/anaschatz/Shorts-Engine/actions/runs/27646269113",
      }]),
    },
    "gh api repos/anaschatz/Shorts-Engine/branches/main/protection": {
      stdout: JSON.stringify(protectedBranchPayload()),
    },
    "gh api repos/anaschatz/Shorts-Engine/rulesets": {
      stdout: JSON.stringify([activeRuleset()]),
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

async function branchCheck(overrides = {}) {
  return await runBranchProtectionCheck({
    env: {},
    nowMs: NOW_MS,
    commandRunner: overrides.commandRunner || mockRunner(overrides.responses || baseResponses()),
  });
}

test("branch policy verifies classic protection and active rulesets read-only", async () => {
  const summary = await branchCheck();

  assert.equal(summary.ok, true);
  assert.equal(summary.phase, "completed");
  assert.equal(summary.status, "passed");
  assert.equal(summary.passed, true);
  assert.equal(summary.branch, "main");
  assert.equal(summary.commit.sha, SHA);
  assert.equal(summary.remoteMain.sha, SHA);
  assert.equal(summary.remoteMain.matchesCurrentCommit, true);
  assert.equal(summary.branchProtection.status, "verified");
  assert.equal(summary.rulesets.status, "verified");
  assert.equal(summary.rulesets.checks.requiredStatusCheck, true);
  assert.equal(summary.rulesets.checks.pullRequestRequired, true);
  assert.equal(summary.rulesets.checks.forcePushBlocked, true);
  assert.equal(summary.rulesets.checks.deletionBlocked, true);
  assert.equal(summary.rulesets.checks.upToDateRequired, true);
  assert.equal(summary.rulesets.checks.conversationResolutionRequired, true);
  assert.equal(summary.releasePolicy.status, "verified");
  assert.equal(summary.logsDownloaded, false);
  assert.equal(summary.artifactsDownloaded, false);
  assert.equal(summary.remoteMutation, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("branch policy reports unreadable branch protection and rulesets as safe unknown", async () => {
  const summary = await branchCheck({
    commandRunner: mockRunner(baseResponses({
      "gh api repos/anaschatz/Shorts-Engine/branches/main/protection": Object.assign(new Error("forbidden: raw provider detail"), { exitCode: 1 }),
      "gh api repos/anaschatz/Shorts-Engine/rulesets": Object.assign(new Error("forbidden: raw provider detail"), { exitCode: 1 }),
    })),
  });

  assert.equal(summary.status, "unknown");
  assert.equal(summary.passed, false);
  assert.equal(summary.branchProtection.status, "unknown");
  assert.equal(summary.branchProtection.code, "GITHUB_BRANCH_PROTECTION_UNREADABLE");
  assert.equal(summary.rulesets.status, "unknown");
  assert.equal(summary.rulesets.code, "GITHUB_RULESET_UNREADABLE");
  assert.equal(summary.releasePolicy.manualVerificationRequired, true);
  assert.match(summary.releasePolicy.manualChecklist.join(" "), /GitHub Actions job named Release gate/);
  assert.equal(summary.nextAction, "confirm-branch-protection-and-rulesets-in-github-ui");
  assert.equal(JSON.stringify(summary).includes("raw provider detail"), false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("branch policy fails closed as incomplete when required release rules are missing", async () => {
  const summary = await branchCheck({
    responses: baseResponses({
      "gh api repos/anaschatz/Shorts-Engine/branches/main/protection": {
        stdout: JSON.stringify(protectedBranchPayload({
          required_status_checks: { strict: false, contexts: ["Other check"] },
          required_pull_request_reviews: null,
          allow_force_pushes: { enabled: true },
          allow_deletions: { enabled: true },
        })),
      },
      "gh api repos/anaschatz/Shorts-Engine/rulesets": {
        stdout: JSON.stringify([activeRuleset({
          rules: [
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: false,
                required_status_checks: [{ context: "Other check" }],
              },
            },
          ],
        })]),
      },
    }),
  });

  assert.equal(summary.status, "incomplete");
  assert.equal(summary.passed, false);
  assert.equal(summary.branchProtection.checks.requiredStatusCheck, false);
  assert.equal(summary.branchProtection.checks.pullRequestRequired, false);
  assert.equal(summary.branchProtection.checks.forcePushBlocked, false);
  assert.equal(summary.branchProtection.checks.deletionBlocked, false);
  assert.equal(summary.rulesets.checks.requiredStatusCheck, false);
  assert.equal(summary.rulesets.checks.pullRequestRequired, false);
  assert.equal(summary.nextAction, "configure-branch-protection-or-rulesets-in-github-ui");
});

test("ruleset readiness handles branch targeting and bypass metadata safely", () => {
  const unrelated = activeRuleset({
    name: "feature rules",
    conditions: { ref_name: { include: ["refs/heads/feature"], exclude: [] } },
  });
  const matching = activeRuleset({
    name: "default branch rules",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }],
  });

  const readiness = rulesetReadiness([unrelated, matching], "main");
  assert.equal(readiness.status, "verified");
  assert.equal(readiness.matchingRulesets, 1);
  assert.deepEqual(readiness.rulesetNames, ["default branch rules"]);
  assert.equal(readiness.checks.bypassActorsVisible, true);
  assert.equal(readiness.checks.directPushBypassRestricted, false);
  assert.equal(findSensitiveLeak(readiness), null);
});

test("branch proof writer creates safe latest and timestamped reports", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-branch-proof-"));
  const result = await writeBranchPolicyProof({
    rootDir,
    cwd: rootDir,
    env: {},
    nowMs: NOW_MS,
    commandRunner: mockRunner(baseResponses()),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(result.latestPath, "release/results/branch-protection-latest.json");
  assert.equal(existsSync(join(rootDir, result.latestPath)), true);
  assert.equal(existsSync(join(rootDir, result.reportPath)), true);
  const latest = JSON.parse(readFileSync(join(rootDir, result.latestPath), "utf8"));
  assert.equal(latest.schemaVersion, 1);
  assert.equal(latest.command, "branch:proof");
  assert.equal(latest.branch, "main");
  assert.equal(latest.uiSetupReference.command, "branch:setup");
  assert.equal(latest.uiSetupReference.githubUiNavigation, "Settings -> Rules -> Rulesets");
  assert.deepEqual(latest.uiSetupReference.nextCommands, [
    "npm run branch:doctor",
    "npm run branch:proof",
    "npm run remote:ci",
    "npm run remote:ci:proof",
  ]);
  assert.equal(latest.remoteMutation, false);
  assert.equal(latest.logsDownloaded, false);
  assert.equal(latest.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(latest), null);
});

test("branch ruleset setup guide is safe documentation-only output", () => {
  const guide = buildBranchRulesetSetupGuide({ nowMs: NOW_MS });

  assert.equal(guide.ok, true);
  assert.equal(guide.command, "branch:setup");
  assert.equal(guide.mode, "documentation-only");
  assert.equal(guide.safety.networkCalls, false);
  assert.equal(guide.safety.authStarted, false);
  assert.equal(guide.safety.tokensRequested, false);
  assert.equal(guide.safety.remoteMutation, false);
  assert.equal(guide.safety.branchProtectionMutation, false);
  assert.equal(guide.safety.rulesetMutation, false);
  assert.equal(guide.repository.nameWithOwner, "anaschatz/Shorts-Engine");
  assert.equal(guide.githubUi.navigation, "Settings -> Rules -> Rulesets");
  assert.equal(guide.githubUi.targetBranch, "main");
  assert.equal(guide.githubUi.enforcement, "Active");
  assert.equal(guide.githubUi.requiredStatusCheck, "Release gate");
  assert.match(guide.githubUi.setupSteps.join(" "), /New branch ruleset|Create a new branch ruleset/);
  assert.match(guide.githubUi.setupSteps.join(" "), /Require pull request before merging/);
  assert.match(guide.githubUi.setupSteps.join(" "), /Require status checks to pass/);
  assert.match(guide.githubUi.setupSteps.join(" "), /Block force pushes/);
  assert.match(guide.githubUi.setupSteps.join(" "), /Block deletions/);
  assert.deepEqual(guide.verification.nextCommands, [
    "npm run branch:doctor",
    "npm run branch:proof",
    "npm run remote:ci",
    "npm run remote:ci:proof",
  ]);
  assert.equal(findSensitiveLeak(guide), null);
});

test("branch policy safe errors hide raw command output", async () => {
  const failed = await branchCheck({
    commandRunner: mockRunner(baseResponses({
      "gh repo view --json nameWithOwner,url": Object.assign(new Error("forbidden token=secret-value"), {
        exitCode: 1,
        stderr: "ghp_should_never_be_exposed",
      }),
    })),
  }).catch((caught) => caught);

  const error = safeError(failed);
  assert.equal(error.ok, false);
  assert.equal(error.code, "GITHUB_REPO_UNREADABLE");
  assert.equal(JSON.stringify(error).includes("secret-value"), false);
  assert.equal(JSON.stringify(error).includes("ghp_should_never_be_exposed"), false);
  assert.equal(findSensitiveLeak(error), null);
});
