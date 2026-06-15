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

function buildRemoteCiProof(summary) {
  const proof = {
    schemaVersion: 1,
    generatedAt: summary.checkedAt,
    remoteCi: {
      ok: summary.ok,
      checkedAt: summary.checkedAt,
      repository: {
        nameWithOwner: summary.repository.nameWithOwner,
        url: summary.repository.url,
      },
      branch: summary.branch,
      commit: summary.commit,
      workflow: summary.workflow,
      releaseJob: summary.releaseJob,
      failedJobs: summary.failedJobs,
      polling: summary.polling,
      nextAction: summary.nextAction,
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    fixForward: {
      required: summary.ok !== true,
      nextAction: summary.ok === true ? "none" : "inspect-safe-summary-and-fix-forward",
      rawLogsRequired: false,
      rawArtifactsRequired: false,
    },
  };
  assertNoSensitiveProof(proof);
  return proof;
}

async function writeRemoteCiProof(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const outputDirRelative = safeRelativeFromRoot(rootDir, options.outputDir || RELEASE_RESULTS_RELATIVE_DIR);
  const outputDir = resolve(rootDir, outputDirRelative);
  const summary = options.summary || await runRemoteCiCheck({ ...options, cwd: options.cwd || rootDir });
  const proof = buildRemoteCiProof(summary);
  const fileName = `remote-ci-proof-${timestampSlug(proof.generatedAt)}.json`;
  const reportPath = `${outputDirRelative}/${fileName}`;
  const latestPath = `${outputDirRelative}/remote-ci-latest.json`;
  mkdirSync(outputDir, { recursive: true });
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  writeFileSync(resolve(rootDir, reportPath), body, "utf8");
  writeFileSync(resolve(rootDir, latestPath), body, "utf8");
  return {
    ok: proof.remoteCi.ok,
    reportPath,
    latestPath,
    generatedAt: proof.generatedAt,
    status: proof.remoteCi.ok ? "passed" : "failed",
  };
}

function safeError(error) {
  if (error && error.code && String(error.code).startsWith("REMOTE_CI_")) return remoteCiSafeError(error);
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
  buildRemoteCiProof,
  safeError,
  writeRemoteCiProof,
};
