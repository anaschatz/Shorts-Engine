import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCiReports } from "../../demo/validate-ci-reports.mjs";
import { checkEnvironment } from "./check-environment.mjs";
import { checkStagingReadiness } from "./check-staging-readiness.mjs";
import { createRequire } from "node:module";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { createReleaseReadiness } = require("../../server/release-readiness.cjs");
const CI_WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";
const PACKAGE_JSON_RELATIVE_PATH = "package.json";

const REQUIRED_WORKFLOW_COMMANDS = Object.freeze([
  "npm run env:check",
  "npm run staging:check",
  "npm run youtube:doctor",
  "npm run lint",
  "npm run build",
  "npm test",
  "npm run eval",
  "npm run brain:health",
  "npm run demo:fixture",
  "npm run demo:smoke",
  "npm run demo:browser",
  "npm run demo:browser:ci",
  "npm run ci:reports",
  "npm run release:check",
]);

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  "ci:reports": "node demo/validate-ci-reports.mjs",
  "env:check": "node tools/release/check-environment.mjs",
  "github:doctor": "node tools/release/check-github-cli.mjs",
  "github:setup": "node tools/release/print-github-cli-setup.mjs",
  "render:check": "node tools/release/check-render-staging.mjs",
  "render:manual": "node tools/release/print-render-staging-checklist.mjs",
  "render:proof": "node tools/release/render-staging-proof.mjs",
  "release:check": "node tools/release/verify-release-gate.mjs",
  "release:evidence": "node tools/release/write-release-evidence.mjs",
  "release:readiness": "node tools/release/check-release-readiness.mjs",
  "remote:ci": "node tools/release/check-remote-ci.mjs",
  "remote:ci:proof": "node tools/release/write-remote-ci-proof.mjs",
  "staging:check": "node tools/release/check-staging-readiness.mjs",
  "staging:smoke": "node tools/release/check-staging-smoke.mjs",
  "staging:smoke:cleanup": "node tools/release/cleanup-staging-full-smoke.mjs",
  "staging:smoke:full": "node tools/release/check-staging-full-smoke.mjs",
  "youtube:doctor": "node tools/release/check-youtube-ingest.mjs",
  "youtube:smoke": "node demo/run-youtube-smoke.mjs",
});

const FAILURE_ARTIFACT_ALLOWLIST = Object.freeze([
  "demo/results/latest.json",
  "demo/results/browser-latest.json",
  "demo/results/playwright-latest.json",
  "demo/results/playwright-artifacts/",
  "eval/results/latest.json",
]);

const BRANCH_PROTECTION_GUIDANCE = Object.freeze([
  "Require pull request before merge.",
  "Require the GitHub Actions job named Release gate.",
  "Require branches to be up to date before merge.",
  "Block force pushes.",
  "Block branch deletions.",
  "Require conversation resolution before merge.",
  "Keep signed commits or signed tags optional until the team commits to that policy.",
]);

class ReleaseGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseGateError";
    this.code = code;
    this.details = details;
  }
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new ReleaseGateError("RELEASE_PATH_INVALID", "Release gate path is outside the project root.");
  }
  return fromRoot;
}

function readTextFile(rootDir, relativePath, label) {
  const safePath = safeRelativeFromRoot(rootDir, relativePath);
  const filePath = resolve(rootDir, safePath);
  if (!existsSync(filePath)) {
    throw new ReleaseGateError("RELEASE_FILE_MISSING", `${label} is missing.`, { file: safePath });
  }
  return readFileSync(filePath, "utf8");
}

function readPackageJson(rootDir, packageJson) {
  if (packageJson) return packageJson;
  const text = readTextFile(rootDir, PACKAGE_JSON_RELATIVE_PATH, "package.json");
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseGateError("RELEASE_PACKAGE_INVALID", "package.json is not valid JSON.");
  }
}

function assert(condition, code, message, details = {}) {
  if (!condition) throw new ReleaseGateError(code, message, details);
}

function normalizeCommand(command) {
  return String(command || "").replace(/\s+/g, " ").trim();
}

function workflowContainsCommand(workflowText, command) {
  const escaped = String(command).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*run:\\s*${escaped}\\s*$`, "m").test(workflowText);
}

function extractArtifactPaths(workflowText) {
  const lines = String(workflowText || "").split(/\r?\n/);
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*path:\s*\|\s*$/.test(line)) continue;
    const pathIndent = line.match(/^\s*/)[0].length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next];
      if (!candidate.trim()) continue;
      const indent = candidate.match(/^\s*/)[0].length;
      if (indent <= pathIndent) break;
      paths.push(candidate.trim());
    }
  }
  return paths;
}

function assertSafeArtifactPath(relativePath) {
  const text = String(relativePath || "");
  const unsafePattern = /(^\/|\\|\.\.|node_modules|^data\/|^var\/|\.env|secrets?|storage|uploads|renders|db|\*|\0)/i;
  assert(text && !unsafePattern.test(text), "RELEASE_ARTIFACT_PATH_UNSAFE", "CI artifact upload path is unsafe.", {
    artifact: text || "missing",
  });
}

function assertExactArtifactAllowlist(paths) {
  const normalized = paths.map((entry) => entry.trim()).filter(Boolean);
  for (const entry of normalized) assertSafeArtifactPath(entry);
  assert(
    normalized.length === FAILURE_ARTIFACT_ALLOWLIST.length &&
      FAILURE_ARTIFACT_ALLOWLIST.every((expected, index) => normalized[index] === expected),
    "RELEASE_ARTIFACT_ALLOWLIST_INVALID",
    "CI artifact upload allowlist is invalid.",
    { expected: FAILURE_ARTIFACT_ALLOWLIST, actual: normalized },
  );
  return normalized;
}

function verifyPackageScripts(packageJson) {
  const scripts = packageJson.scripts || {};
  for (const [name, expected] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    assert(
      scripts[name] === expected,
      "RELEASE_SCRIPT_MISSING",
      "Required release script is missing or unexpected.",
      { script: name },
    );
  }
  return Object.keys(REQUIRED_PACKAGE_SCRIPTS);
}

function verifyWorkflowContract(workflowText) {
  assert(/pull_request:/.test(workflowText), "RELEASE_CI_TRIGGER_MISSING", "CI workflow must run on pull requests.");
  assert(/push:[\s\S]*branches:[\s\S]*main[\s\S]*master/.test(workflowText), "RELEASE_CI_TRIGGER_MISSING", "CI workflow must run on main/master pushes.");
  assert(/node-version:\s*"?(?:18|20|22)"?/.test(workflowText), "RELEASE_NODE_VERSION_INVALID", "CI workflow must use Node.js 18 or newer.");
  assert(/npm ci/.test(workflowText), "RELEASE_INSTALL_INVALID", "CI workflow must use npm ci when a lockfile exists.");
  assert(/npm install/.test(workflowText), "RELEASE_INSTALL_INVALID", "CI workflow must retain npm install fallback.");
  assert(/npm run demo:browser:install/.test(workflowText), "RELEASE_PLAYWRIGHT_INSTALL_MISSING", "CI workflow must install Playwright Chromium.");
  assert(/apt-get\s+install[\s\S]*\bffmpeg\b/.test(workflowText), "RELEASE_FFMPEG_INSTALL_MISSING", "CI workflow must install FFmpeg tools before runtime verification.");
  assert(/ffmpeg\s+-version/.test(workflowText) && /ffprobe\s+-version/.test(workflowText), "RELEASE_RUNTIME_VERIFY_MISSING", "CI workflow must verify FFmpeg and FFprobe availability.");
  assert(/uses:\s*actions\/upload-artifact@v4/.test(workflowText), "RELEASE_ARTIFACT_UPLOAD_MISSING", "CI workflow must upload diagnostics on failure.");
  assert(/if:\s*failure\(\)/.test(workflowText), "RELEASE_ARTIFACT_UPLOAD_UNSAFE", "CI workflow must upload artifacts only on failure.");
  assert(!/SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/.test(workflowText), "RELEASE_BROWSER_SKIP_UNSAFE", "Release gate must not skip missing Playwright runtime.");
  assert(!/integration:cloud|MATCHCUTS_RUN_REAL_CLOUD_TESTS/.test(workflowText), "RELEASE_CLOUD_INTEGRATION_UNSAFE", "Real cloud integration must stay out of the default CI gate.");

  const missingCommands = REQUIRED_WORKFLOW_COMMANDS.filter((command) => !workflowContainsCommand(workflowText, command));
  assert(missingCommands.length === 0, "RELEASE_COMMAND_MISSING", "CI workflow is missing a required command.", {
    missingCommands,
  });

  const artifactPaths = assertExactArtifactAllowlist(extractArtifactPaths(workflowText));
  return {
    name: "Release gate",
    workflow: CI_WORKFLOW_RELATIVE_PATH,
    commands: REQUIRED_WORKFLOW_COMMANDS.map(normalizeCommand),
    artifactUpload: {
      failureOnly: true,
      allowlist: artifactPaths,
    },
    runtimeTools: {
      ffmpegInstallRequired: true,
      ffmpegVerifyRequired: true,
    },
    realCloudIntegrationDefault: false,
    browserRuntimeSkipAllowed: false,
  };
}

function parseGitRemotes(configText) {
  const remotes = [];
  let current = null;
  for (const line of String(configText || "").split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote "([^"]+)"\]\s*$/);
    if (section) {
      current = { name: section[1], hasUrl: false };
      remotes.push(current);
      continue;
    }
    if (current && /^\s*url\s*=/.test(line)) current.hasUrl = true;
  }
  return remotes;
}

function readGitRemoteState(rootDir) {
  const gitDir = resolve(rootDir, ".git");
  const configPath = resolve(gitDir, "config");
  if (!existsSync(gitDir) || !existsSync(configPath)) {
    return {
      isRepository: false,
      detected: false,
      remotes: [],
      mode: "local-read-only",
    };
  }
  const remotes = parseGitRemotes(readFileSync(configPath, "utf8"));
  return {
    isRepository: true,
    detected: remotes.length > 0,
    remotes: remotes.map((remote) => ({ name: remote.name, hasUrl: remote.hasUrl })),
    mode: "read-only-config-inspection",
  };
}

function buildLimitations(remoteState) {
  const limitations = [
    "Branch protection settings must be enabled in GitHub by a repository admin.",
    "This release check does not mutate remote repository settings.",
  ];
  if (!remoteState.isRepository) limitations.push("No local git repository metadata was detected.");
  if (remoteState.isRepository && !remoteState.detected) limitations.push("No git remote was detected locally.");
  return limitations;
}

function packageSummary(packageJson) {
  return {
    name: packageJson.name || "unknown",
    version: packageJson.version || "0.0.0",
    private: packageJson.private === true,
    description: packageJson.description || "",
  };
}

function verifyReleaseGate(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const packageJson = readPackageJson(rootDir, options.packageJson);
  const workflowText = options.workflowText ?? readTextFile(rootDir, CI_WORKFLOW_RELATIVE_PATH, "CI workflow");
  const packageScripts = verifyPackageScripts(packageJson);
  const workflow = verifyWorkflowContract(workflowText);
  const releaseReadiness = createReleaseReadiness({ rootDir, packageJson, workflowText });
  assert(releaseReadiness.ready === true, "RELEASE_READINESS_INVALID", "Release readiness contract is invalid.", {
    missing: releaseReadiness.missing,
  });
  const environment = checkEnvironment({
    env: options.env,
    rootDir,
    nowMs,
    exampleText: options.exampleText,
    docsText: options.docsText,
  });
  const staging = checkStagingReadiness({
    env: options.env,
    rootDir,
    nowMs,
    environmentExampleText: options.exampleText,
    environmentDocsText: options.docsText,
    docsText: options.stagingDocsText,
    workflowText: options.stagingWorkflowText,
  });
  const reportValidation = validateCiReports({
    demoResultsDir: options.demoResultsDir,
    evalResultsDir: options.evalResultsDir,
    maxAgeMs: options.maxAgeMs,
    nowMs,
  });
  const remote = readGitRemoteState(rootDir);
  return {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    package: packageSummary(packageJson),
    packageScripts,
    environment,
    staging,
    releaseReadiness,
    workflow,
    reports: reportValidation,
    artifactPolicy: workflow.artifactUpload,
    branchProtection: {
      mode: "manual-read-only",
      requiredStatusChecks: [workflow.name],
      guidance: BRANCH_PROTECTION_GUIDANCE,
    },
    remote,
    limitations: buildLimitations(remote),
  };
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "RELEASE_GATE_INVALID",
    message: error && error.message ? error.message : "Release gate validation failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(verifyReleaseGate(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  BRANCH_PROTECTION_GUIDANCE,
  CI_WORKFLOW_RELATIVE_PATH,
  FAILURE_ARTIFACT_ALLOWLIST,
  PACKAGE_JSON_RELATIVE_PATH,
  REQUIRED_PACKAGE_SCRIPTS,
  REQUIRED_WORKFLOW_COMMANDS,
  ROOT_DIR,
  ReleaseGateError,
  extractArtifactPaths,
  parseGitRemotes,
  safeError,
  verifyReleaseGate,
  verifyWorkflowContract,
};
