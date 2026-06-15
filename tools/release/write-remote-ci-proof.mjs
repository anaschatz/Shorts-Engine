import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { runRemoteCiCheck, safeError as remoteCiSafeError } from "./check-remote-ci.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_RESULTS_RELATIVE_DIR = "release/results";

class RemoteCiProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RemoteCiProofError";
    this.code = code;
    this.details = details;
  }
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_PATH_INVALID", "Remote CI proof path is outside the project root.");
  }
  return fromRoot;
}

function timestampSlug(isoTimestamp) {
  return String(isoTimestamp).replace(/[:.]/g, "-");
}

function assertNoSensitiveProof(proof) {
  const leak = findSensitiveLeak(proof);
  if (leak) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_LEAK", "Remote CI proof contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function sanitizeText(value, maxLength = 160) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", `Remote CI proof ${label} is invalid.`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", `Remote CI proof ${label} is invalid.`);
  }
  return value;
}

function requireText(value, label, pattern, maxLength = 160) {
  const text = sanitizeText(value, maxLength);
  if (!text || (pattern && !pattern.test(text))) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", `Remote CI proof ${label} is invalid.`);
  }
  return text;
}

function optionalText(value, label, pattern, maxLength = 160) {
  if (value === null || value === undefined || value === "") return null;
  return requireText(value, label, pattern, maxLength);
}

function requireSafeGithubUrl(value) {
  const text = optionalText(value, "workflow URL", /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+\/?$/, 240);
  return text ? text.replace(/\/$/, "") : null;
}

function requireNonNegativeInteger(value, label, min = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", `Remote CI proof ${label} is invalid.`);
  }
  return number;
}

function requireBranch(value) {
  const branch = requireText(value, "branch", /^[A-Za-z0-9_.\/-]{1,120}$/, 120);
  if (branch.includes("..") || branch.includes("\\") || branch.startsWith("-")) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", "Remote CI proof branch is invalid.");
  }
  return branch;
}

function requireIsoTimestamp(value, label) {
  return requireText(value, label, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 32);
}

function safeFailureCode(value) {
  const code = requireText(value, "failure code", /^[A-Z0-9_]{1,80}$/, 80);
  if (!code.startsWith("REMOTE_CI_") && !code.startsWith("GITHUB_")) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", "Remote CI proof failure code is invalid.");
  }
  return code;
}

function safeFailureMessage(value) {
  const message = sanitizeText(value || "Remote CI verification failed.", 240);
  if (!message || findSensitiveLeak(message)) {
    return "Remote CI verification failed.";
  }
  return message;
}

function validateRemoteCiSummaryForProof(summary) {
  const input = requireObject(summary, "summary");
  assertNoSensitiveProof(input);
  const repository = requireObject(input.repository, "repository");
  const commit = requireObject(input.commit, "commit");
  const workflow = requireObject(input.workflow, "workflow");
  const releaseJob = requireObject(input.releaseJob, "release job");
  const failedJobs = requireObject(input.failedJobs, "failed jobs");
  const polling = requireObject(input.polling, "polling metadata");
  const sha = requireText(commit.sha, "commit sha", /^[A-Fa-f0-9]{7,40}$/, 40);
  const shortSha = requireText(commit.shortSha || sha.slice(0, 12), "commit short sha", /^[A-Fa-f0-9]{7,12}$/, 12);
  const failedJobNames = Array.isArray(failedJobs.names)
    ? failedJobs.names.slice(0, 10).map((name) => requireText(name, "failed job name", /^[A-Za-z0-9 ._:/()#-]{1,120}$/, 120))
    : [];
  const failedJobCount = requireNonNegativeInteger(failedJobs.count, "failed job count");
  if (failedJobNames.length > failedJobCount) {
    throw new RemoteCiProofError("REMOTE_CI_PROOF_SUMMARY_INVALID", "Remote CI proof failed job metadata is invalid.");
  }
  return {
    ok: requireBoolean(input.ok, "status"),
    checkedAt: requireText(input.checkedAt, "timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 32),
    repository: {
      nameWithOwner: requireText(repository.nameWithOwner, "repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 120),
      url: optionalText(repository.url, "repository URL", /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/, 240)?.replace(/\/$/, "") || null,
    },
    branch: requireBranch(input.branch),
    commit: { sha, shortSha },
    workflow: {
      name: requireText(workflow.name, "workflow name", /^[A-Za-z0-9 ._:/()#-]{1,120}$/, 120),
      releaseJobName: requireText(workflow.releaseJobName, "release job name", /^[A-Za-z0-9 ._:/()#-]{1,120}$/, 120),
      runId: requireNonNegativeInteger(workflow.runId, "run id", 1),
      headBranch: requireBranch(workflow.headBranch || input.branch),
      headSha: requireText(workflow.headSha || sha, "workflow head sha", /^[A-Fa-f0-9]{7,40}$/, 40),
      status: requireText(workflow.status, "workflow status", /^[a-z_]{1,40}$/, 40),
      conclusion: optionalText(workflow.conclusion, "workflow conclusion", /^[a-z_]{1,40}$/, 40),
      url: requireSafeGithubUrl(workflow.url),
    },
    releaseJob: {
      name: requireText(releaseJob.name, "release job name", /^[A-Za-z0-9 ._:/()#-]{1,120}$/, 120),
      found: requireBoolean(releaseJob.found, "release job found"),
      status: requireText(releaseJob.status, "release job status", /^[a-z_]{1,40}$/, 40),
      conclusion: optionalText(releaseJob.conclusion, "release job conclusion", /^[a-z_]{1,40}$/, 40),
    },
    failedJobs: {
      count: failedJobCount,
      names: failedJobNames,
    },
    polling: {
      attempts: requireNonNegativeInteger(polling.attempts, "polling attempts", 1),
      startedAt: requireIsoTimestamp(polling.startedAt || input.checkedAt, "polling started timestamp"),
      waitedMs: requireNonNegativeInteger(polling.waitedMs || 0, "polling waited milliseconds"),
      timeoutMs: requireNonNegativeInteger(polling.timeoutMs, "polling timeout", 1),
      pollIntervalMs: requireNonNegativeInteger(polling.pollIntervalMs, "polling interval", 1),
    },
    nextAction: requireText(input.nextAction, "next action", /^[a-z0-9_-]{1,80}$/, 80),
  };
}

function buildRemoteCiProof(summary) {
  const safeSummary = validateRemoteCiSummaryForProof(summary);
  const proof = {
    schemaVersion: 1,
    generatedAt: safeSummary.checkedAt,
    remoteCi: {
      ok: safeSummary.ok,
      checkedAt: safeSummary.checkedAt,
      repository: {
        nameWithOwner: safeSummary.repository.nameWithOwner,
        url: safeSummary.repository.url,
      },
      branch: safeSummary.branch,
      commit: safeSummary.commit,
      workflow: safeSummary.workflow,
      releaseJob: safeSummary.releaseJob,
      failedJobs: safeSummary.failedJobs,
      polling: safeSummary.polling,
      nextAction: safeSummary.nextAction,
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    fixForward: {
      required: safeSummary.ok !== true,
      nextAction: safeSummary.ok === true ? "none" : "inspect-safe-summary-and-fix-forward",
      rawLogsRequired: false,
      rawArtifactsRequired: false,
    },
  };
  assertNoSensitiveProof(proof);
  return proof;
}

function buildRemoteCiFailureProof(summary, options = {}) {
  const safeSummary = requireObject(summary, "failure summary");
  assertNoSensitiveProof(safeSummary);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const generatedAt = requireIsoTimestamp(new Date(nowMs).toISOString(), "generated timestamp");
  const attempts = options.error && options.error.details
    ? Number(options.error.details.attempts || 0)
    : Number(safeSummary.attempts || 0);
  const proof = {
    schemaVersion: 1,
    generatedAt,
    remoteCi: {
      ok: false,
      checkedAt: generatedAt,
      repository: {
        nameWithOwner: null,
        url: null,
      },
      branch: null,
      commit: {
        sha: null,
        shortSha: null,
      },
      workflow: {
        name: null,
        releaseJobName: null,
        runId: null,
        status: "unknown",
        conclusion: null,
        url: null,
      },
      releaseJob: {
        name: null,
        found: false,
        status: "unknown",
        conclusion: null,
      },
      failedJobs: {
        count: 0,
        names: [],
      },
      polling: {
        attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
        startedAt: generatedAt,
        waitedMs: 0,
        timeoutMs: 0,
        pollIntervalMs: 0,
      },
      failure: {
        code: safeFailureCode(safeSummary.code || "REMOTE_CI_FAILED"),
        message: safeFailureMessage(safeSummary.message),
        nextAction: requireText(safeSummary.nextAction || "inspect-safe-summary", "failure next action", /^[a-z0-9_-]{1,80}$/, 80),
      },
      nextAction: requireText(safeSummary.nextAction || "inspect-safe-summary", "next action", /^[a-z0-9_-]{1,80}$/, 80),
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    fixForward: {
      required: true,
      nextAction: "inspect-safe-summary-and-fix-forward",
      rawLogsRequired: false,
      rawArtifactsRequired: false,
    },
  };
  assertNoSensitiveProof(proof);
  return proof;
}

function isSafeFailureSummary(summary) {
  return Boolean(summary && typeof summary === "object" && summary.ok === false && summary.code);
}

async function writeRemoteCiProof(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const outputDirRelative = safeRelativeFromRoot(rootDir, options.outputDir || RELEASE_RESULTS_RELATIVE_DIR);
  const outputDir = resolve(rootDir, outputDirRelative);
  let proof;
  if (options.summary) {
    proof = isSafeFailureSummary(options.summary)
      ? buildRemoteCiFailureProof(options.summary, options)
      : buildRemoteCiProof(options.summary);
  } else {
    try {
      const summary = await runRemoteCiCheck({ ...options, cwd: options.cwd || rootDir });
      proof = buildRemoteCiProof(summary);
    } catch (error) {
      proof = buildRemoteCiFailureProof(remoteCiSafeError(error), { ...options, error });
    }
  }
  const fileName = `remote-ci-proof-${timestampSlug(proof.generatedAt)}.json`;
  const reportPath = `${outputDirRelative}/${fileName}`;
  const latestPath = `${outputDirRelative}/remote-ci-latest.json`;
  mkdirSync(outputDir, { recursive: true });
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  writeFileSync(resolve(rootDir, reportPath), body, "utf8");
  writeFileSync(resolve(rootDir, latestPath), body, "utf8");
  const failure = proof.remoteCi.failure || null;
  return {
    ok: proof.remoteCi.ok,
    reportPath,
    latestPath,
    generatedAt: proof.generatedAt,
    status: proof.remoteCi.ok ? "passed" : "failed",
    code: failure ? failure.code : undefined,
    nextAction: proof.remoteCi.nextAction,
  };
}

function safeError(error) {
  if (
    error &&
    error.code &&
    (String(error.code).startsWith("REMOTE_CI_") || ["GITHUB_CLI_MISSING", "GITHUB_AUTH_MISSING"].includes(String(error.code)))
  ) {
    return remoteCiSafeError(error);
  }
  return {
    ok: false,
    code: error && error.code ? error.code : "REMOTE_CI_PROOF_FAILED",
    message: error && error.message ? error.message : "Remote CI proof generation failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = await writeRemoteCiProof();
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  RELEASE_RESULTS_RELATIVE_DIR,
  RemoteCiProofError,
  buildRemoteCiFailureProof,
  buildRemoteCiProof,
  safeError,
  validateRemoteCiSummaryForProof,
  writeRemoteCiProof,
};
