import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_REQUIRED_STATUS_CHECK = "Release gate";

class GithubCliDoctorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GithubCliDoctorError";
    this.code = code;
    this.details = details;
  }
}

function sanitizeText(value, maxLength = 160) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validateBranch(value) {
  const branch = sanitizeText(value, 120);
  if (!branch || branch.includes("..") || branch.includes("\\") || branch.startsWith("-") || /[\s~^:?*\[]/.test(branch)) {
    throw new GithubCliDoctorError("GITHUB_REPO_UNREADABLE", "Git branch name is invalid.");
  }
  return branch;
}

function safeGithubUrl(value) {
  const text = sanitizeText(value, 240);
  if (!text) return null;
  if (findSensitiveLeak(text)) {
    throw new GithubCliDoctorError("GITHUB_OUTPUT_UNSAFE", "GitHub CLI output contains sensitive data.");
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/actions\/runs\/[0-9]+)?\/?$/.test(parsed.pathname)) {
    return null;
  }
  return parsed.toString().replace(/\/$/, "");
}

function assertNoSensitiveOutput(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new GithubCliDoctorError("GITHUB_OUTPUT_UNSAFE", "GitHub CLI output contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

async function defaultCommandRunner(command, args, options = {}) {
  return await new Promise((resolveCommand, rejectCommand) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs || 30_000,
      maxBuffer: options.maxOutputBytes || MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) {
        error.exitCode = error.code;
        error.stdout = stdout;
        error.stderr = stderr;
        rejectCommand(error);
        return;
      }
      resolveCommand({ stdout: String(stdout || ""), stderr: String(stderr || ""), exitCode: 0 });
    });
  });
}

async function runCommand(commandRunner, command, args, options = {}) {
  try {
    const result = await commandRunner(command, args, options);
    const stdout = String((result && result.stdout) || "");
    const stderr = String((result && result.stderr) || "");
    if (Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES || Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
      throw new GithubCliDoctorError("GITHUB_OUTPUT_UNSAFE", "GitHub CLI output is too large.");
    }
    return { stdout, stderr, exitCode: Number(result && result.exitCode) || 0 };
  } catch (error) {
    if (error instanceof GithubCliDoctorError) throw error;
    if (command === "gh" && error && error.code === "ENOENT") {
      throw new GithubCliDoctorError("GITHUB_CLI_MISSING", "GitHub CLI is not available.");
    }
    throw new GithubCliDoctorError(options.failureCode || "GITHUB_COMMAND_FAILED", options.failureMessage || "GitHub readiness command failed.");
  }
}

function parseJson(text, code, message) {
  if (Buffer.byteLength(String(text || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new GithubCliDoctorError("GITHUB_OUTPUT_UNSAFE", "GitHub CLI output is too large.");
  }
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    throw new GithubCliDoctorError(code, message);
  }
  assertNoSensitiveOutput(payload);
  return payload;
}

async function loadGitContext({ commandRunner, cwd, env }) {
  await runCommand(commandRunner, "git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    env,
    failureCode: "GITHUB_REPO_UNREADABLE",
    failureMessage: "Git repository metadata is not readable.",
  });
  const branchResult = await runCommand(commandRunner, "git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    env,
    failureCode: "GITHUB_REPO_UNREADABLE",
    failureMessage: "Git branch metadata is not readable.",
  });
  const remoteResult = await runCommand(commandRunner, "git", ["remote"], {
    cwd,
    env,
    failureCode: "GITHUB_REPO_UNREADABLE",
    failureMessage: "Git remote metadata is not readable.",
  });
  const remotes = remoteResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!remotes.includes("origin")) {
    throw new GithubCliDoctorError("GITHUB_REPO_UNREADABLE", "Git remote origin is not configured.");
  }
  return {
    branch: validateBranch(branchResult.stdout.trim()),
    originConfigured: true,
  };
}

async function checkGhVersion({ commandRunner, cwd, env }) {
  const result = await runCommand(commandRunner, "gh", ["--version"], {
    cwd,
    env,
    failureCode: "GITHUB_CLI_MISSING",
    failureMessage: "GitHub CLI is not available.",
  });
  const firstLine = sanitizeText(result.stdout.split(/\r?\n/)[0] || "gh detected", 120);
  assertNoSensitiveOutput(firstLine);
  return firstLine || "gh detected";
}

async function checkGhAuth({ commandRunner, cwd, env }) {
  await runCommand(commandRunner, "gh", ["auth", "status"], {
    cwd,
    env,
    failureCode: "GITHUB_AUTH_MISSING",
    failureMessage: "GitHub CLI is not authenticated.",
  });
  return true;
}

function parseNameWithOwner(value) {
  const nameWithOwner = sanitizeText(value, 120);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) {
    throw new GithubCliDoctorError("GITHUB_REPO_UNREADABLE", "GitHub repository name is invalid.");
  }
  const [owner, repo] = nameWithOwner.split("/");
  return { owner, repo, nameWithOwner };
}

async function loadRepository({ commandRunner, cwd, env }) {
  const result = await runCommand(commandRunner, "gh", ["repo", "view", "--json", "nameWithOwner,url"], {
    cwd,
    env,
    failureCode: "GITHUB_REPO_UNREADABLE",
    failureMessage: "GitHub repository metadata is not readable.",
  });
  const payload = parseJson(result.stdout, "GITHUB_REPO_UNREADABLE", "GitHub repository output is not valid JSON.");
  const parsed = parseNameWithOwner(payload.nameWithOwner);
  return {
    readable: true,
    owner: parsed.owner,
    name: parsed.repo,
    nameWithOwner: parsed.nameWithOwner,
    url: safeGithubUrl(payload.url),
  };
}

async function loadActionsMetadata({ commandRunner, cwd, env }) {
  const result = await runCommand(commandRunner, "gh", [
    "run",
    "list",
    "--limit",
    "1",
    "--json",
    "databaseId,status,conclusion,workflowName,url,headBranch,headSha,createdAt,updatedAt,name",
  ], {
    cwd,
    env,
    failureCode: "GITHUB_ACTIONS_UNREADABLE",
    failureMessage: "GitHub Actions metadata is not readable.",
  });
  const payload = parseJson(result.stdout, "GITHUB_ACTIONS_UNREADABLE", "GitHub Actions output is not valid JSON.");
  if (!Array.isArray(payload)) {
    throw new GithubCliDoctorError("GITHUB_ACTIONS_UNREADABLE", "GitHub Actions output has an invalid shape.");
  }
  const latest = payload.find((run) => run && typeof run === "object") || null;
  return {
    readable: true,
    latestRunSeen: Boolean(latest),
    latestRun: latest ? {
      runId: Number.isInteger(Number(latest.databaseId)) ? Number(latest.databaseId) : null,
      workflowName: sanitizeText(latest.workflowName || latest.name || "unknown", 120),
      status: sanitizeText(latest.status || "unknown", 40).toLowerCase(),
      conclusion: sanitizeText(latest.conclusion || "", 40).toLowerCase() || null,
      url: safeGithubUrl(latest.url),
    } : null,
  };
}

function unknownBranchProtection(branch, reasonCode = "permission-or-ruleset-unavailable") {
  return {
    mode: "read-only",
    branch,
    status: "unknown",
    reasonCode,
    requiredStatusChecks: [DEFAULT_REQUIRED_STATUS_CHECK],
    checks: {
      requiredStatusCheck: null,
      pullRequestRequired: null,
      forcePushBlocked: null,
      deletionBlocked: null,
      upToDateRequired: null,
    },
    nextAction: "confirm-branch-protection-in-github-ui",
  };
}

function normalizeProtectionCheckNames(requiredStatusChecks) {
  const contexts = Array.isArray(requiredStatusChecks && requiredStatusChecks.contexts)
    ? requiredStatusChecks.contexts
    : [];
  const checks = Array.isArray(requiredStatusChecks && requiredStatusChecks.checks)
    ? requiredStatusChecks.checks.map((check) => check && (check.context || check.name)).filter(Boolean)
    : [];
  return [...new Set([...contexts, ...checks].map((name) => sanitizeText(name, 120)).filter(Boolean))];
}

function branchProtectionReadiness(payload, branch) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return unknownBranchProtection(branch, "invalid-shape");
  }
  const statusCheckNames = normalizeProtectionCheckNames(payload.required_status_checks);
  const checks = {
    requiredStatusCheck: statusCheckNames.includes(DEFAULT_REQUIRED_STATUS_CHECK),
    pullRequestRequired: Boolean(payload.required_pull_request_reviews),
    forcePushBlocked: !(payload.allow_force_pushes && payload.allow_force_pushes.enabled === true),
    deletionBlocked: !(payload.allow_deletions && payload.allow_deletions.enabled === true),
    upToDateRequired: Boolean(payload.required_status_checks && payload.required_status_checks.strict === true),
  };
  const verified = Object.values(checks).every((value) => value === true);
  return {
    mode: "read-only",
    branch,
    status: verified ? "verified" : "incomplete",
    requiredStatusChecks: [DEFAULT_REQUIRED_STATUS_CHECK],
    detectedStatusChecks: statusCheckNames.slice(0, 20),
    checks,
    nextAction: verified ? "none" : "configure-branch-protection-in-github-ui",
  };
}

async function checkBranchProtection({ commandRunner, cwd, env, repository, branch }) {
  const encodedBranch = encodeURIComponent(branch);
  try {
    const result = await runCommand(commandRunner, "gh", [
      "api",
      `repos/${repository.owner}/${repository.name}/branches/${encodedBranch}/protection`,
    ], {
      cwd,
      env,
      failureCode: "GITHUB_BRANCH_PROTECTION_UNREADABLE",
      failureMessage: "GitHub branch protection metadata is not readable.",
    });
    const payload = parseJson(result.stdout, "GITHUB_BRANCH_PROTECTION_UNREADABLE", "GitHub branch protection output is not valid JSON.");
    return branchProtectionReadiness(payload, branch);
  } catch (error) {
    if (error instanceof GithubCliDoctorError && error.code === "GITHUB_OUTPUT_UNSAFE") throw error;
    return unknownBranchProtection(branch);
  }
}

async function runGithubCliDoctor(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const git = await loadGitContext({ commandRunner, cwd, env });
  const version = await checkGhVersion({ commandRunner, cwd, env });
  await checkGhAuth({ commandRunner, cwd, env });
  const repository = await loadRepository({ commandRunner, cwd, env });
  const actions = await loadActionsMetadata({ commandRunner, cwd, env });
  const branchProtection = await checkBranchProtection({
    commandRunner,
    cwd,
    env,
    repository,
    branch: git.branch,
  });
  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    githubCli: {
      available: true,
      authenticated: true,
      version,
    },
    git: {
      originConfigured: git.originConfigured,
      branch: git.branch,
    },
    repository,
    actions,
    branchProtection,
    logsDownloaded: false,
    artifactsDownloaded: false,
    remoteMutation: false,
    nextAction: branchProtection.nextAction,
  };
  assertNoSensitiveOutput(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "GITHUB_DOCTOR_FAILED",
    message: error && error.message ? error.message : "GitHub CLI readiness check failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runGithubCliDoctor(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_REQUIRED_STATUS_CHECK,
  GithubCliDoctorError,
  branchProtectionReadiness,
  runGithubCliDoctor,
  safeError,
};
