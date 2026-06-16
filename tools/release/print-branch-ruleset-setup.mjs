import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { EXPECTED_BRANCH_POLICY } from "./check-branch-protection.mjs";

const DEFAULT_REPOSITORY = "anaschatz/Shorts-Engine";
const DEFAULT_BRANCH = "main";
const DEFAULT_COMMAND_NAME = "branch:setup";

class BranchRulesetSetupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BranchRulesetSetupError";
    this.code = code;
    this.details = details;
  }
}

const GITHUB_UI_STEPS = Object.freeze([
  "Open GitHub repository anaschatz/Shorts-Engine.",
  "Go to Settings -> Rules -> Rulesets.",
  "Create a new branch ruleset.",
  "Set target branch to main.",
  "Set enforcement to Active.",
  "Enable Require pull request before merging.",
  "Enable Require status checks to pass.",
  "Add required status check: Release gate.",
  "Enable Require branches to be up to date before merging.",
  "Enable Block force pushes.",
  "Enable Block deletions.",
  "Enable Require conversation resolution before merge.",
  "Review bypass actors and direct-push exceptions; keep only trusted operator/admin policy.",
  "Save the ruleset.",
]);

const NEXT_COMMANDS = Object.freeze([
  "npm run branch:doctor",
  "npm run branch:proof",
  "npm run remote:ci",
  "npm run remote:ci:proof",
]);

function assertNoSensitiveGuide(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new BranchRulesetSetupError("BRANCH_RULESET_SETUP_OUTPUT_UNSAFE", "Branch ruleset setup guide contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function buildBranchRulesetSetupReference(options = {}) {
  const repository = options.repository || DEFAULT_REPOSITORY;
  const branch = options.branch || DEFAULT_BRANCH;
  return {
    command: DEFAULT_COMMAND_NAME,
    repository,
    branch,
    docs: "docs/RELEASE.md#branch-protection-checklist",
    githubUiNavigation: "Settings -> Rules -> Rulesets",
    requiredStatusCheck: "Release gate",
    manualOnly: true,
    automaticMutation: false,
    nextCommands: NEXT_COMMANDS,
  };
}

function buildBranchRulesetSetupGuide(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const reference = buildBranchRulesetSetupReference(options);
  const guide = {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    command: DEFAULT_COMMAND_NAME,
    mode: "documentation-only",
    purpose: "Guide the operator through manual GitHub Ruleset setup for ShortsEngine release governance.",
    safety: {
      networkCalls: false,
      authStarted: false,
      tokensRequested: false,
      logsDownloaded: false,
      artifactsDownloaded: false,
      remoteMutation: false,
      repositoryMutation: false,
      branchProtectionMutation: false,
      rulesetMutation: false,
      secretsIncluded: false,
    },
    repository: {
      nameWithOwner: reference.repository,
      branch: reference.branch,
    },
    expectedPolicy: {
      ...EXPECTED_BRANCH_POLICY,
      branch: reference.branch,
    },
    githubUi: {
      navigation: reference.githubUiNavigation,
      setupSteps: GITHUB_UI_STEPS,
      enforcement: "Active",
      targetBranch: reference.branch,
      requiredStatusCheck: reference.requiredStatusCheck,
    },
    verification: {
      nextCommands: reference.nextCommands,
      expectedVerifiedStatus: "verified",
      currentIncompleteMeaning: "No matching active ruleset or readable branch protection currently proves the required Release gate policy.",
      unknownMeaning: "GitHub did not expose enough classic branch protection or ruleset metadata; confirm the checklist manually in GitHub UI.",
    },
    reportContract: {
      latestBranchProof: "release/results/branch-protection-latest.json",
      latestRemoteCiProof: "release/results/remote-ci-latest.json",
      logsDownloaded: false,
      artifactsDownloaded: false,
      remoteMutation: false,
    },
    limitations: [
      "This helper does not call GitHub APIs.",
      "This helper does not create, edit or delete GitHub rulesets.",
      "This helper does not change branch protection.",
      "This helper does not start GitHub auth or request tokens.",
      "Repository admins must apply the ruleset manually in the GitHub UI.",
    ],
    nextAction: "configure-ruleset-in-github-ui-then-run-branch-proof",
  };
  assertNoSensitiveGuide(guide);
  return guide;
}

function safeError(error) {
  const response = {
    ok: false,
    code: error && error.code ? error.code : "BRANCH_RULESET_SETUP_FAILED",
    message: error && error.message ? error.message : "Branch ruleset setup guide failed.",
    nextAction: "inspect-setup-guide-safely",
  };
  if (findSensitiveLeak(response.message)) {
    response.message = "Branch ruleset setup guide failed.";
  }
  return response;
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(buildBranchRulesetSetupGuide(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  BranchRulesetSetupError,
  buildBranchRulesetSetupGuide,
  buildBranchRulesetSetupReference,
  safeError,
};
