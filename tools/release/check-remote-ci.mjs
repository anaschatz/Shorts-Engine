import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const DEFAULT_WORKFLOW_NAME = "ShortsEngine CI";
const DEFAULT_RELEASE_JOB_NAME = "Release gate";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const COMPLETED_STATUS = "completed";
const PENDING_STATUSES = new Set(["queued", "in_progress", "requested", "pending", "waiting"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

class RemoteCiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RemoteCiError";
    this.code = code;
    this.details = details;
  }
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RemoteCiError(code, "Remote CI numeric configuration is out of bounds.");
  }
  return parsed;
}

function sanitizeText(value, maxLength = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validateSha(value, { required = true } = {}) {
  const text = sanitizeText(value, 80);
  if (!text) {
    if (required) throw new RemoteCiError("REMOTE_CI_SHA_INVALID", "Remote CI commit SHA is invalid.");
    return "";
  }
  if (!/^[A-Fa-f0-9]{7,40}$/.test(text)) {
    throw new RemoteCiError("REMOTE_CI_SHA_INVALID", "Remote CI commit SHA is invalid.");
  }
  return text;
}

function validateBranch(value) {
  const branch = sanitizeText(value, 120);
  if (!branch || branch.includes("..") || branch.includes("\\") || branch.startsWith("-") || /[\s~^:?*\[]/.test(branch)) {
    throw new RemoteCiError("REMOTE_CI_BRANCH_INVALID", "Remote CI branch name is invalid.");
  }
  return branch;
}

function validateWorkflowName(value) {
  const workflowName = sanitizeText(value || DEFAULT_WORKFLOW_NAME, 120);
  if (!workflowName || workflowName.includes("\u0000") || findSensitiveLeak(workflowName)) {
    throw new RemoteCiError("REMOTE_CI_WORKFLOW_INVALID", "Remote CI workflow name is invalid.");
  }
  return workflowName;
}

function validateJobName(value) {
  const jobName = sanitizeText(value || DEFAULT_RELEASE_JOB_NAME, 120);
  if (!jobName || jobName.includes("\u0000") || findSensitiveLeak(jobName)) {
    throw new RemoteCiError("REMOTE_CI_JOB_INVALID", "Remote CI job name is invalid.");
  }
  return jobName;
}

function safeGithubUrl(value) {
  const text = sanitizeText(value, 240);
  if (!text) return null;
  if (findSensitiveLeak(text)) {
    throw new RemoteCiError("REMOTE_CI_OUTPUT_LEAK", "Remote CI output contains sensitive data.");
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

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new RemoteCiError("REMOTE_CI_SUMMARY_LEAK", "Remote CI summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function commandFailureCode(command, error) {
  if (error && error.code === "ENOENT") return command === "gh" ? "REMOTE_CI_GH_MISSING" : "REMOTE_CI_GIT_MISSING";
  if (command === "gh" && error && Number(error.exitCode || error.code) !== 0) return "REMOTE_CI_GH_COMMAND_FAILED";
  if (command === "git" && error && Number(error.exitCode || error.code) !== 0) return "REMOTE_CI_GIT_COMMAND_FAILED";
  return "REMOTE_CI_COMMAND_FAILED";
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
      throw new RemoteCiError("REMOTE_CI_OUTPUT_TOO_LARGE", "Remote CI command output is too large.");
    }
    return { stdout, stderr, exitCode: Number(result && result.exitCode) || 0 };
  } catch (error) {
    if (error instanceof RemoteCiError) throw error;
    throw new RemoteCiError(commandFailureCode(command, error), command === "gh" ? "GitHub CLI command failed." : "Git command failed.");
  }
}

function parseJson(text, code, message) {
  if (Buffer.byteLength(String(text || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new RemoteCiError("REMOTE_CI_OUTPUT_TOO_LARGE", "Remote CI command output is too large.");
  }
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    throw new RemoteCiError(code, message);
  }
  if (findSensitiveLeak(payload)) {
    throw new RemoteCiError("REMOTE_CI_OUTPUT_LEAK", "Remote CI output contains sensitive data.");
  }
  return payload;
}

function parseRemoteCiConfig(options = {}) {
  const env = options.env || process.env;
  const timeoutMs = parseInteger(rawValue(env, "SHORTSENGINE_REMOTE_CI_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 1_000, 30 * 60 * 1000, "REMOTE_CI_TIMEOUT_INVALID");
  const pollIntervalMs = parseInteger(rawValue(env, "SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS"), DEFAULT_POLL_INTERVAL_MS, 500, 60 * 1000, "REMOTE_CI_POLL_INTERVAL_INVALID");
  if (pollIntervalMs > timeoutMs) {
    throw new RemoteCiError("REMOTE_CI_POLL_INTERVAL_INVALID", "Remote CI poll interval cannot exceed the timeout.");
  }
  return {
    timeoutMs,
    pollIntervalMs,
    workflowName: validateWorkflowName(options.workflowName || rawValue(env, "SHORTSENGINE_REMOTE_CI_WORKFLOW") || DEFAULT_WORKFLOW_NAME),
    releaseJobName: validateJobName(options.releaseJobName || rawValue(env, "SHORTSENGINE_REMOTE_CI_JOB") || DEFAULT_RELEASE_JOB_NAME),
    branch: options.branch || rawValue(env, "SHORTSENGINE_REMOTE_CI_BRANCH") || "",
    sha: options.sha || rawValue(env, "SHORTSENGINE_REMOTE_CI_SHA") || "",
  };
}

async function inspectGitContext({ commandRunner, cwd, env, config }) {
  await runCommand(commandRunner, "git", ["rev-parse", "--is-inside-work-tree"], { cwd, env });
  const branchResult = await runCommand(commandRunner, "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, env });
  const shaResult = await runCommand(commandRunner, "git", ["rev-parse", "HEAD"], { cwd, env });
  const remoteResult = await runCommand(commandRunner, "git", ["remote"], { cwd, env });
  const remotes = remoteResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!remotes.includes("origin")) {
    throw new RemoteCiError("REMOTE_CI_REMOTE_MISSING", "Git remote origin is not configured.");
  }
  const branch = config.branch ? validateBranch(config.branch) : validateBranch(branchResult.stdout.trim());
  const sha = config.sha ? validateSha(config.sha) : validateSha(shaResult.stdout.trim());
  return {
    repositoryDetected: true,
    branch,
    sha,
  };
}

async function verifyGhReady({ commandRunner, cwd, env }) {
  await runCommand(commandRunner, "gh", ["--version"], { cwd, env });
  try {
    await runCommand(commandRunner, "gh", ["auth", "status"], { cwd, env });
  } catch (error) {
    if (error instanceof RemoteCiError && error.code === "REMOTE_CI_GH_COMMAND_FAILED") {
      throw new RemoteCiError("REMOTE_CI_GH_AUTH_MISSING", "GitHub CLI is not authenticated.");
    }
    throw error;
  }
}

async function loadRepositorySummary({ commandRunner, cwd, env }) {
  const result = await runCommand(commandRunner, "gh", ["repo", "view", "--json", "nameWithOwner,url"], { cwd, env });
  const payload = parseJson(result.stdout, "REMOTE_CI_REPOSITORY_JSON_INVALID", "GitHub repository output is not valid JSON.");
  const nameWithOwner = sanitizeText(payload.nameWithOwner, 120);
  const url = safeGithubUrl(payload.url);
  return {
    detected: Boolean(nameWithOwner),
    nameWithOwner: nameWithOwner || "unknown",
    url,
  };
}

function normalizeRunList(payload, sha) {
  if (!Array.isArray(payload)) {
    throw new RemoteCiError("REMOTE_CI_RUNS_SHAPE_INVALID", "GitHub workflow runs output has an invalid shape.");
  }
  return payload
    .filter((run) => run && typeof run === "object")
    .filter((run) => !sha || String(run.headSha || "").toLowerCase() === sha.toLowerCase())
    .sort((a, b) => String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || "")));
}

async function findWorkflowRun({ commandRunner, cwd, env, config, context }) {
  const result = await runCommand(commandRunner, "gh", [
    "run",
    "list",
    "--workflow",
    config.workflowName,
    "--branch",
    context.branch,
    "--limit",
    "20",
    "--json",
    "databaseId,headBranch,headSha,status,conclusion,workflowName,url,createdAt,updatedAt,name",
  ], { cwd, env });
  const runs = normalizeRunList(
    parseJson(result.stdout, "REMOTE_CI_RUNS_JSON_INVALID", "GitHub workflow runs output is not valid JSON."),
    context.sha,
  );
  return runs[0] || null;
}

function sanitizeJob(job) {
  const name = sanitizeText(job && job.name ? job.name : "unknown", 120);
  const status = sanitizeText(job && job.status ? job.status : "unknown", 40).toLowerCase();
  const conclusion = sanitizeText(job && job.conclusion ? job.conclusion : "", 40).toLowerCase();
  return { name, status, conclusion };
}

function normalizeRunDetails(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RemoteCiError("REMOTE_CI_RUN_SHAPE_INVALID", "GitHub workflow run output has an invalid shape.");
  }
  const databaseId = Number(payload.databaseId);
  if (!Number.isInteger(databaseId) || databaseId <= 0) {
    throw new RemoteCiError("REMOTE_CI_RUN_SHAPE_INVALID", "GitHub workflow run id is invalid.");
  }
  const status = sanitizeText(payload.status || "unknown", 40).toLowerCase();
  const conclusion = sanitizeText(payload.conclusion || "", 40).toLowerCase();
  const jobs = Array.isArray(payload.jobs) ? payload.jobs.map(sanitizeJob) : [];
  return {
    databaseId,
    headBranch: sanitizeText(payload.headBranch || "", 120),
    headSha: validateSha(payload.headSha || "", { required: false }),
    status,
    conclusion,
    workflowName: validateWorkflowName(payload.workflowName || DEFAULT_WORKFLOW_NAME),
    url: safeGithubUrl(payload.url),
    jobs,
  };
}

async function loadRunDetails({ commandRunner, cwd, env, runId }) {
  const result = await runCommand(commandRunner, "gh", [
    "run",
    "view",
    String(runId),
    "--json",
    "databaseId,headBranch,headSha,status,conclusion,workflowName,url,jobs",
  ], { cwd, env });
  return normalizeRunDetails(
    parseJson(result.stdout, "REMOTE_CI_RUN_JSON_INVALID", "GitHub workflow run output is not valid JSON."),
  );
}

function failedJobsFor(details, releaseJobName) {
  const failed = details.jobs.filter((job) => (
    FAILURE_CONCLUSIONS.has(job.conclusion) ||
    (details.conclusion && details.conclusion !== "success" && job.name === releaseJobName && job.conclusion !== "success")
  ));
  return {
    count: failed.length,
    names: failed.slice(0, 10).map((job) => job.name),
  };
}

function nextActionFor(details) {
  if (details.status !== COMPLETED_STATUS || PENDING_STATUSES.has(details.status)) return "wait-for-remote-ci";
  if (details.conclusion === "success") return "none";
  return "inspect-safe-summary-and-fix-forward";
}

function buildSummary({ config, context, repository, details, attempts, checkedAt }) {
  const failedJobs = failedJobsFor(details, config.releaseJobName);
  const ok = details.status === COMPLETED_STATUS && details.conclusion === "success";
  const summary = {
    ok,
    checkedAt,
    repository: {
      detected: repository.detected,
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
    },
    branch: context.branch,
    commit: {
      sha: context.sha,
      shortSha: context.sha.slice(0, 12),
    },
    workflow: {
      name: details.workflowName || config.workflowName,
      releaseJobName: config.releaseJobName,
      runId: details.databaseId,
      status: details.status,
      conclusion: details.conclusion || null,
      url: details.url,
    },
    failedJobs,
    polling: {
      attempts,
      timeoutMs: config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    },
    nextAction: nextActionFor(details),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runRemoteCiCheck(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const sleep = options.sleep || delay;
  const config = parseRemoteCiConfig(options);
  const context = await inspectGitContext({ commandRunner, cwd, env, config });
  await verifyGhReady({ commandRunner, cwd, env });
  const repository = await loadRepositorySummary({ commandRunner, cwd, env });
  const startedMs = nowMs;
  let currentMs = startedMs;
  let attempts = 0;
  let lastRun = null;

  while (currentMs - startedMs <= config.timeoutMs) {
    attempts += 1;
    lastRun = await findWorkflowRun({ commandRunner, cwd, env, config, context });
    if (lastRun) {
      const runId = Number(lastRun.databaseId);
      const details = await loadRunDetails({ commandRunner, cwd, env, runId });
      if (details.status === COMPLETED_STATUS || !PENDING_STATUSES.has(details.status)) {
        return buildSummary({
          config,
          context,
          repository,
          details,
          attempts,
          checkedAt: new Date(currentMs).toISOString(),
        });
      }
    }
    if (currentMs - startedMs + config.pollIntervalMs > config.timeoutMs) break;
    await sleep(config.pollIntervalMs);
    currentMs += config.pollIntervalMs;
  }

  throw new RemoteCiError(lastRun ? "REMOTE_CI_TIMEOUT" : "REMOTE_CI_RUN_NOT_FOUND", lastRun
    ? "Remote CI did not complete before the timeout."
    : "Remote CI run was not found before the timeout.", {
      attempts,
    });
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "REMOTE_CI_FAILED",
    message: error && error.message ? error.message : "Remote CI verification failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = await runRemoteCiCheck();
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RELEASE_JOB_NAME,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_NAME,
  RemoteCiError,
  parseRemoteCiConfig,
  runRemoteCiCheck,
  safeError,
};
