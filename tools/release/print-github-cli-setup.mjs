import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

class GithubCliSetupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GithubCliSetupError";
    this.code = code;
    this.details = details;
  }
}

const INSTALL_OPTIONS = Object.freeze([
  {
    platform: "macos",
    commands: ["brew install gh"],
    notes: ["Use the official GitHub CLI package if Homebrew is not available."],
  },
  {
    platform: "linux",
    commands: ["Install gh from the official GitHub CLI package repository for your distro."],
    notes: ["Prefer your distro package manager or the official GitHub CLI instructions."],
  },
  {
    platform: "windows",
    commands: ["winget install --id GitHub.cli"],
    notes: ["GitHub Desktop or the official MSI installer are also acceptable."],
  },
]);

const EXPECTED_REMOTE = Object.freeze({
  repository: "anaschatz/Shorts-Engine",
  workflow: "ShortsEngine CI",
  releaseJob: "Release gate",
});

const REQUIRED_COMMANDS = Object.freeze([
  "gh auth status",
  "npm run github:doctor",
  "npm run remote:ci",
  "npm run remote:ci:proof",
]);

const ERROR_GUIDANCE = Object.freeze({
  GITHUB_CLI_MISSING: "Install GitHub CLI, then run gh --version and npm run github:doctor.",
  GITHUB_AUTH_MISSING: "Run gh auth login yourself, verify gh auth status, then rerun npm run github:doctor.",
  GITHUB_NETWORK_UNAVAILABLE: "Check network and GitHub connectivity, then rerun npm run github:doctor.",
  REMOTE_CI_RUN_NOT_FOUND: "Wait for GitHub Actions to create a run for the pushed commit, or confirm branch/SHA.",
  REMOTE_CI_TIMEOUT: "Wait for the bounded CI run to finish, then rerun npm run remote:ci.",
  REMOTE_CI_SHA_MISMATCH: "Confirm that the GitHub Actions run is for the exact pushed commit SHA.",
  GITHUB_BRANCH_PROTECTION_UNKNOWN: "Confirm branch protection in the GitHub UI when rulesets or permissions hide metadata.",
});

function assertNoSensitiveGuide(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new GithubCliSetupError("GITHUB_SETUP_OUTPUT_UNSAFE", "GitHub CLI setup guide contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function buildGithubCliSetupGuide(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const guide = {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    mode: "documentation-only",
    purpose: "Prepare local GitHub CLI access for read-only remote CI proof checks.",
    safety: {
      networkCalls: false,
      authStarted: false,
      remoteMutation: false,
      tokensRequested: false,
      logsDownloaded: false,
      artifactsDownloaded: false,
      secretsIncluded: false,
    },
    install: {
      officialDocs: "https://cli.github.com/",
      manualDownload: "https://github.com/cli/cli#installation",
      options: INSTALL_OPTIONS,
      verifyCommand: "gh --version",
    },
    authSetup: {
      manualOnly: true,
      commands: ["gh auth login", "gh auth status"],
      guidance: [
        "Run auth from your terminal; this helper never starts auth automatically.",
        "Use the browser or device flow presented by GitHub CLI.",
        "Do not paste personal access tokens into project files, reports or chats.",
      ],
      requiredAccess: [
        "Read repository metadata for the ShortsEngine repository.",
        "Read GitHub Actions workflow runs and job status.",
        "Read branch protection or ruleset metadata only when your account already has permission.",
      ],
      expectedRepository: EXPECTED_REMOTE.repository,
      requiredScopes: ["repo metadata read", "actions read"],
      writeAccessRequired: false,
    },
    expectedRemote: {
      repository: EXPECTED_REMOTE.repository,
      branch: options.branch || "current-branch",
      workflow: EXPECTED_REMOTE.workflow,
      releaseJob: EXPECTED_REMOTE.releaseJob,
      exactCommitRequired: true,
    },
    postPushVerification: {
      commands: REQUIRED_COMMANDS,
      expectedReports: ["release/results/remote-ci-latest.json"],
      notes: [
        "Run local validation before pushing.",
        "Run remote proof after the pushed commit appears in GitHub Actions.",
        "If branch protection is unknown, confirm the release-gate settings in the GitHub UI.",
      ],
    },
    errorGuidance: ERROR_GUIDANCE,
    limitations: [
      "This helper does not install GitHub CLI.",
      "This helper does not authenticate GitHub CLI.",
      "This helper does not call GitHub APIs.",
      "This helper does not change repository settings, branch protection, secrets or environments.",
    ],
    nextAction: "install-or-authenticate-gh-then-run-github-doctor",
  };
  assertNoSensitiveGuide(guide);
  return guide;
}

function safeError(error) {
  const response = {
    ok: false,
    code: error && error.code ? error.code : "GITHUB_SETUP_FAILED",
    message: error && error.message ? error.message : "GitHub CLI setup guide failed.",
    nextAction: "inspect-setup-guide-safely",
  };
  if (findSensitiveLeak(response.message)) {
    response.message = "GitHub CLI setup guide failed.";
  }
  return response;
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(buildGithubCliSetupGuide(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  GithubCliSetupError,
  buildGithubCliSetupGuide,
  safeError,
};
