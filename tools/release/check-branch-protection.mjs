import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import {
  DEFAULT_REQUIRED_STATUS_CHECK,
  GithubCliDoctorError,
  runGithubCliDoctor,
  safeError as githubDoctorSafeError,
} from "./check-github-cli.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const BRANCH_PROTECTION_LATEST_RELATIVE_PATH = "release/results/branch-protection-latest.json";
const DEFAULT_BRANCH = "main";

const BRANCH_POLICY_PHASES = Object.freeze({
  GIT_CONTEXT: "git-context",
  GITHUB_DOCTOR: "github-doctor",
  RULESETS: "rulesets",
  COMPLETED: "completed",
});

const EXPECTED_BRANCH_POLICY = Object.freeze({
  branch: DEFAULT_BRANCH,
  requiredStatusChecks: [DEFAULT_REQUIRED_STATUS_CHECK],
  machineChecks: [
    "requiredStatusCheck",
    "pullRequestRequired",
    "forcePushBlocked",
    "deletionBlocked",
    "upToDateRequired",
  ],
  manualChecklist: [
    "Require pull request before merge.",
    "Require the GitHub Actions job named Release gate.",
    "Require branches to be up to date before merge.",
    "Block force pushes.",
    "Block branch deletions.",
    "Require conversation resolution before merge.",
    "Confirm bypass actors/direct-push exceptions are limited to trusted operator/admin policy.",
  ],
});

class BranchPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BranchPolicyError";
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

function assertNoSensitiveOutput(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new BranchPolicyError("BRANCH_POLICY_OUTPUT_UNSAFE", "Branch policy output contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function looksLikeNetworkFailure(error) {
  const code = String(error?.code || error?.exitCode || "").toUpperCase();
  if (["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)) return true;
  const text = sanitizeText(`${error?.message || ""} ${error?.stderr || ""} ${error?.stdout || ""}`, 500).toLowerCase();
  return /could not resolve|network|timed out|timeout|connection refused|connection reset|tls|temporary failure|failed to connect/.test(text);
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
      throw new BranchPolicyError("BRANCH_POLICY_OUTPUT_UNSAFE", "Branch policy command output is too large.");
    }
    return { stdout, stderr, exitCode: Number(result && result.exitCode) || 0 };
  } catch (error) {
    if (error instanceof BranchPolicyError || error instanceof GithubCliDoctorError) throw error;
    if (command === "gh" && error && error.code === "ENOENT") {
      throw new BranchPolicyError("GITHUB_CLI_MISSING", "GitHub CLI is not available.");
    }
    if (looksLikeNetworkFailure(error)) {
      throw new BranchPolicyError("GITHUB_NETWORK_UNAVAILABLE", "GitHub network access is unavailable.");
    }
    throw new BranchPolicyError(options.failureCode || "BRANCH_POLICY_COMMAND_FAILED", options.failureMessage || "Branch policy command failed.");
  }
}

function parseJson(text, code, message) {
  if (Buffer.byteLength(String(text || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new BranchPolicyError("BRANCH_POLICY_OUTPUT_UNSAFE", "Branch policy command output is too large.");
  }
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    throw new BranchPolicyError(code, message);
  }
  assertNoSensitiveOutput(payload);
  return payload;
}

function safeBranch(value) {
  const branch = sanitizeText(value, 120);
  if (!branch || branch.includes("..") || branch.includes("\\") || branch.startsWith("-") || /[\s~^:?*\[]/.test(branch)) {
    throw new BranchPolicyError("BRANCH_POLICY_BRANCH_INVALID", "Branch policy branch is invalid.");
  }
  return branch;
}

function safeSha(value, label = "commit SHA") {
  const sha = sanitizeText(value, 80);
  if (!/^[A-Fa-f0-9]{40}$/.test(sha)) {
    throw new BranchPolicyError("BRANCH_POLICY_GIT_CONTEXT_INVALID", `${label} is invalid.`);
  }
  return sha.toLowerCase();
}

async function loadCommitContext({ commandRunner, cwd, env, branch }) {
  const current = await runCommand(commandRunner, "git", ["rev-parse", "HEAD"], {
    cwd,
    env,
    failureCode: "BRANCH_POLICY_GIT_CONTEXT_INVALID",
    failureMessage: "Current commit is not readable.",
  });
  const remote = await runCommand(commandRunner, "git", ["ls-remote", "origin", `refs/heads/${branch}`], {
    cwd,
    env,
    failureCode: "BRANCH_POLICY_REMOTE_UNREADABLE",
    failureMessage: "Remote branch SHA is not readable.",
  });
  const remoteSha = String(remote.stdout || "").trim().split(/\s+/)[0] || "";
  return {
    currentSha: safeSha(current.stdout.trim(), "current commit SHA"),
    remoteSha: safeSha(remoteSha, "remote branch SHA"),
    exactRemoteMatch: safeSha(current.stdout.trim()) === safeSha(remoteSha, "remote branch SHA"),
  };
}

function unknownRulesets(branch, reasonCode = "permission-or-ruleset-unavailable") {
  return {
    mode: "read-only",
    branch,
    status: "unknown",
    code: "GITHUB_RULESET_UNREADABLE",
    reasonCode,
    matchingRulesets: 0,
    requiredStatusChecks: [DEFAULT_REQUIRED_STATUS_CHECK],
    detectedStatusChecks: [],
    checks: {
      requiredStatusCheck: null,
      pullRequestRequired: null,
      forcePushBlocked: null,
      deletionBlocked: null,
      upToDateRequired: null,
      conversationResolutionRequired: null,
      bypassActorsVisible: null,
      directPushBypassRestricted: null,
    },
    nextAction: "confirm-rulesets-in-github-ui",
  };
}

function safeRuleName(value) {
  return sanitizeText(value || "unnamed-ruleset", 120) || "unnamed-ruleset";
}

function ruleAppliesToBranch(ruleset, branch) {
  const conditions = ruleset && ruleset.conditions && typeof ruleset.conditions === "object"
    ? ruleset.conditions
    : {};
  const refName = conditions.ref_name && typeof conditions.ref_name === "object"
    ? conditions.ref_name
    : null;
  if (!refName) return true;
  const include = Array.isArray(refName.include) ? refName.include.map(String) : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude.map(String) : [];
  const branchRef = `refs/heads/${branch}`;
  const matches = (pattern) => (
    pattern === branchRef ||
    pattern === branch ||
    pattern === "~DEFAULT_BRANCH" ||
    pattern === "refs/heads/*" ||
    pattern === "*"
  );
  if (exclude.some(matches)) return false;
  return include.length === 0 || include.some(matches);
}

function normalizeRequiredStatusChecks(parameters) {
  const checks = Array.isArray(parameters && parameters.required_status_checks)
    ? parameters.required_status_checks
    : [];
  return checks
    .map((check) => sanitizeText(check && (check.context || check.name || check.pattern), 120))
    .filter(Boolean);
}

function rulesetReadiness(payload, branch) {
  if (!Array.isArray(payload)) return unknownRulesets(branch, "invalid-shape");
  const activeRulesets = payload.filter((ruleset) => (
    ruleset &&
    typeof ruleset === "object" &&
    sanitizeText(ruleset.target || "branch", 40).toLowerCase() === "branch" &&
    sanitizeText(ruleset.enforcement || "active", 40).toLowerCase() === "active" &&
    ruleAppliesToBranch(ruleset, branch)
  ));

  const ruleTypes = new Set();
  const statusChecks = new Set();
  let strictStatusChecks = false;
  let bypassActorsVisible = false;
  let bypassActorsCount = 0;
  const names = [];

  for (const ruleset of activeRulesets) {
    names.push(safeRuleName(ruleset.name));
    if (Array.isArray(ruleset.bypass_actors)) {
      bypassActorsVisible = true;
      bypassActorsCount += ruleset.bypass_actors.length;
    }
    const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
    for (const rule of rules) {
      const type = sanitizeText(rule && rule.type, 80).toLowerCase();
      if (!type) continue;
      ruleTypes.add(type);
      if (type === "required_status_checks") {
        for (const check of normalizeRequiredStatusChecks(rule.parameters)) statusChecks.add(check);
        if (rule.parameters && rule.parameters.strict_required_status_checks_policy === true) strictStatusChecks = true;
      }
    }
  }

  const checks = {
    requiredStatusCheck: statusChecks.has(DEFAULT_REQUIRED_STATUS_CHECK),
    pullRequestRequired: ruleTypes.has("pull_request"),
    forcePushBlocked: ruleTypes.has("non_fast_forward"),
    deletionBlocked: ruleTypes.has("deletion"),
    upToDateRequired: strictStatusChecks,
    conversationResolutionRequired: ruleTypes.has("required_conversation_resolution") ? true : null,
    bypassActorsVisible,
    directPushBypassRestricted: bypassActorsVisible ? bypassActorsCount === 0 : null,
  };
  const requiredMachineChecks = EXPECTED_BRANCH_POLICY.machineChecks.map((key) => checks[key]);
  const verified = requiredMachineChecks.every((value) => value === true);
  const incomplete = requiredMachineChecks.some((value) => value === false);
  return {
    mode: "read-only",
    branch,
    status: verified ? "verified" : (incomplete ? "incomplete" : "unknown"),
    matchingRulesets: activeRulesets.length,
    rulesetNames: names.slice(0, 20),
    requiredStatusChecks: [DEFAULT_REQUIRED_STATUS_CHECK],
    detectedStatusChecks: [...statusChecks].slice(0, 20),
    checks,
    nextAction: verified ? "none" : (incomplete ? "configure-rulesets-in-github-ui" : "confirm-rulesets-in-github-ui"),
  };
}

async function checkRulesets({ commandRunner, cwd, env, repository, branch }) {
  try {
    const result = await runCommand(commandRunner, "gh", [
      "api",
      `repos/${repository.owner}/${repository.name}/rulesets`,
    ], {
      cwd,
      env,
      failureCode: "GITHUB_RULESET_UNREADABLE",
      failureMessage: "GitHub ruleset metadata is not readable.",
    });
    return rulesetReadiness(parseJson(result.stdout, "GITHUB_RULESET_UNREADABLE", "GitHub ruleset output is not valid JSON."), branch);
  } catch (error) {
    if (error instanceof BranchPolicyError && error.code === "BRANCH_POLICY_OUTPUT_UNSAFE") throw error;
    return unknownRulesets(branch);
  }
}

function combinePolicyStatus({ branchProtection, rulesets }) {
  const statuses = [branchProtection?.status, rulesets?.status].filter(Boolean);
  let status = "unknown";
  if (statuses.includes("verified")) status = "verified";
  else if (statuses.includes("incomplete")) status = "incomplete";
  const nextAction = status === "verified"
    ? "none"
    : (status === "incomplete" ? "configure-branch-protection-or-rulesets-in-github-ui" : "confirm-branch-protection-and-rulesets-in-github-ui");
  return {
    status,
    passed: status === "verified",
    expected: EXPECTED_BRANCH_POLICY,
    requiredChecksDetected: {
      branchProtection: branchProtection?.detectedStatusChecks || [],
      rulesets: rulesets?.detectedStatusChecks || [],
    },
    manualVerificationRequired: status !== "verified" || rulesets?.checks?.conversationResolutionRequired !== true,
    manualChecklist: EXPECTED_BRANCH_POLICY.manualChecklist,
    nextAction,
  };
}

async function runBranchProtectionCheck(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const github = await runGithubCliDoctor({ env, cwd, nowMs, commandRunner });
  const branch = safeBranch(options.branch || github.git.branch || DEFAULT_BRANCH);
  const commit = await loadCommitContext({ commandRunner, cwd, env, branch });
  const rulesets = await checkRulesets({
    commandRunner,
    cwd,
    env,
    repository: github.repository,
    branch,
  });
  const releasePolicy = combinePolicyStatus({
    branchProtection: github.branchProtection,
    rulesets,
  });
  const status = releasePolicy.status === "verified" ? "passed" : releasePolicy.status;
  const summary = {
    ok: true,
    phase: BRANCH_POLICY_PHASES.COMPLETED,
    status,
    passed: releasePolicy.passed,
    skipped: false,
    checkedAt: new Date(nowMs).toISOString(),
    repository: {
      nameWithOwner: github.repository.nameWithOwner,
      url: github.repository.url,
    },
    branch,
    commit: {
      sha: commit.currentSha,
      shortSha: commit.currentSha.slice(0, 12),
    },
    remoteMain: {
      branch,
      sha: commit.remoteSha,
      shortSha: commit.remoteSha.slice(0, 12),
      matchesCurrentCommit: commit.exactRemoteMatch,
    },
    githubCli: {
      available: github.githubCli.available,
      authenticated: github.githubCli.authenticated,
      version: github.githubCli.version,
    },
    branchProtection: github.branchProtection,
    rulesets,
    releasePolicy,
    nextAction: releasePolicy.nextAction,
    logsDownloaded: false,
    artifactsDownloaded: false,
    remoteMutation: false,
  };
  assertNoSensitiveOutput(summary);
  return summary;
}

function phaseForCode(code) {
  if (code === "GITHUB_CLI_MISSING") return "github-cli";
  if (code === "GITHUB_AUTH_MISSING") return "github-auth";
  if (code === "GITHUB_NETWORK_UNAVAILABLE") return "network";
  if (String(code || "").includes("REPO")) return "repository";
  if (String(code || "").includes("RULESET")) return BRANCH_POLICY_PHASES.RULESETS;
  if (String(code || "").includes("GIT") || String(code || "").includes("REMOTE")) return BRANCH_POLICY_PHASES.GIT_CONTEXT;
  return BRANCH_POLICY_PHASES.GITHUB_DOCTOR;
}

function safeError(error) {
  if (error instanceof GithubCliDoctorError) return githubDoctorSafeError(error);
  const code = error && error.code ? error.code : "BRANCH_POLICY_FAILED";
  const rawMessage = sanitizeText(error && error.message ? error.message : "Branch policy verification failed.", 240);
  const nextActions = {
    BRANCH_POLICY_OUTPUT_UNSAFE: "inspect-safe-branch-policy-summary",
    BRANCH_POLICY_GIT_CONTEXT_INVALID: "confirm-local-git-state",
    BRANCH_POLICY_REMOTE_UNREADABLE: "confirm-origin-main-and-network",
    GITHUB_NETWORK_UNAVAILABLE: "check-network-and-github-connectivity-then-rerun",
  };
  return {
    ok: false,
    phase: phaseForCode(code),
    status: "failed",
    passed: false,
    skipped: false,
    code,
    message: findSensitiveLeak(rawMessage) ? "Branch policy verification failed." : rawMessage,
    nextAction: nextActions[code] || "inspect-safe-summary",
    logsDownloaded: false,
    artifactsDownloaded: false,
    remoteMutation: false,
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runBranchProtectionCheck(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  BRANCH_POLICY_PHASES,
  BRANCH_PROTECTION_LATEST_RELATIVE_PATH,
  BranchPolicyError,
  EXPECTED_BRANCH_POLICY,
  checkRulesets,
  combinePolicyStatus,
  runBranchProtectionCheck,
  rulesetReadiness,
  safeError,
};
