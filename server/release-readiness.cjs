const { existsSync, readFileSync } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");

const REQUIRED_RELEASE_SCRIPTS = Object.freeze({
  "branch:doctor": "node tools/release/check-branch-protection.mjs",
  "branch:proof": "node tools/release/write-branch-protection-proof.mjs",
  "branch:setup": "node tools/release/print-branch-ruleset-setup.mjs",
  "ci:reports": "node demo/validate-ci-reports.mjs",
  "github:doctor": "node tools/release/check-github-cli.mjs",
  "github:setup": "node tools/release/print-github-cli-setup.mjs",
  "release:check": "node tools/release/verify-release-gate.mjs",
  "release:evidence": "node tools/release/write-release-evidence.mjs",
  "release:readiness": "node tools/release/check-release-readiness.mjs",
  "remote:ci": "node tools/release/check-remote-ci.mjs",
  "remote:ci:proof": "node tools/release/write-remote-ci-proof.mjs",
});

const REQUIRED_WORKFLOW_MARKERS = Object.freeze([
  "npm run release:check",
  "if: failure()",
  "actions/upload-artifact@v4",
]);

const SAFE_RELATIVE_REPORTS = Object.freeze({
  branchProtectionProofLatest: "release/results/branch-protection-latest.json",
  releaseEvidenceLatest: "release/results/latest.json",
  remoteCiProofLatest: "release/results/remote-ci-latest.json",
});

function isInside(rootDir, candidatePath) {
  const root = resolve(rootDir);
  const target = resolve(candidatePath);
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function safeReadText(rootDir, relativeFile) {
  const target = resolve(rootDir, relativeFile);
  if (!isInside(rootDir, target) || !existsSync(target)) return null;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

function safePackageJson(rootDir, packageJson) {
  if (packageJson && typeof packageJson === "object") return packageJson;
  const text = safeReadText(rootDir, "package.json");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requiredScriptStatus(packageJson) {
  const scripts = packageJson && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const status = {};
  const missing = [];
  for (const [name, expected] of Object.entries(REQUIRED_RELEASE_SCRIPTS)) {
    const ok = scripts[name] === expected;
    status[name] = ok;
    if (!ok) missing.push(name);
  }
  return { status, missing };
}

function workflowStatus(workflowText) {
  const text = String(workflowText || "");
  const markers = {};
  const missing = [];
  for (const marker of REQUIRED_WORKFLOW_MARKERS) {
    const ok = text.includes(marker);
    markers[marker] = ok;
    if (!ok) missing.push(marker);
  }
  return {
    configured: Boolean(text),
    failureArtifactsOnly: /if:\s*failure\(\)/.test(text),
    markers,
    missing,
  };
}

function assertNoSensitiveReleaseReadiness(summary) {
  const text = JSON.stringify(summary);
  if (
    /(?:^|[\s"'=])\/(?:Users|private|var\/folders|tmp)\/[^\s"']*/i.test(text) ||
    /file:\/\/[^\s"']+/i.test(text) ||
    /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text) ||
    /Bearer\s+[A-Za-z0-9._-]+/i.test(text) ||
    /sk-[A-Za-z0-9_-]{10,}/.test(text)
  ) {
    return {
      ready: false,
      code: "RELEASE_READINESS_OUTPUT_UNSAFE",
      message: "Release readiness summary contains sensitive data.",
    };
  }
  return null;
}

function createReleaseReadiness(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const packageJson = safePackageJson(rootDir, options.packageJson);
  const workflowText = options.workflowText ?? safeReadText(rootDir, ".github/workflows/ci.yml");
  const scripts = requiredScriptStatus(packageJson);
  const workflow = workflowStatus(workflowText);
  const missing = {
    scripts: scripts.missing,
    workflowMarkers: workflow.missing,
  };
  const ready = Boolean(packageJson) && scripts.missing.length === 0 && workflow.configured && workflow.missing.length === 0;
  const summary = {
    ready,
    mode: "local-static-readiness",
    networkCalls: false,
    authStarted: false,
    remoteMutation: false,
    tokensRequested: false,
    logsDownloaded: false,
    artifactsDownloaded: false,
    packageAvailable: Boolean(packageJson),
    scripts: scripts.status,
    workflow: {
      configured: workflow.configured,
      failureArtifactsOnly: workflow.failureArtifactsOnly,
      requiredMarkersPresent: Object.values(workflow.markers).every(Boolean),
    },
    reports: SAFE_RELATIVE_REPORTS,
    remoteProof: {
      requiresGithubCli: true,
      setupCommand: "npm run github:setup",
      doctorCommand: "npm run github:doctor",
      verifyCommand: "npm run remote:ci",
      proofCommand: "npm run remote:ci:proof",
      automaticAuth: false,
      safeMissingDependencyCode: "GITHUB_CLI_MISSING",
      safeMissingAuthCode: "GITHUB_AUTH_MISSING",
      exactCommitRequired: true,
      failureProofReports: true,
    },
    branchPolicyProof: {
      requiresGithubCli: true,
      setupCommand: "npm run branch:setup",
      doctorCommand: "npm run branch:doctor",
      proofCommand: "npm run branch:proof",
      setupMode: "documentation-only",
      automaticAuth: false,
      remoteMutation: false,
      automaticRulesetMutation: false,
      safeUnknownBranchProtectionCode: "GITHUB_BRANCH_PROTECTION_UNREADABLE",
      safeUnknownRulesetCode: "GITHUB_RULESET_UNREADABLE",
      manualVerificationFallback: true,
    },
    missing,
    nextAction: ready ? "run-release-checks-before-push" : "fix-release-readiness-contract",
  };
  const unsafe = assertNoSensitiveReleaseReadiness(summary);
  return unsafe || summary;
}

module.exports = {
  REQUIRED_RELEASE_SCRIPTS,
  REQUIRED_WORKFLOW_MARKERS,
  createReleaseReadiness,
};
