import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import {
  BRANCH_PROTECTION_LATEST_RELATIVE_PATH,
  runBranchProtectionCheck,
  safeError as branchPolicySafeError,
} from "./check-branch-protection.mjs";
import { buildBranchRulesetSetupReference } from "./print-branch-ruleset-setup.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_RESULTS_RELATIVE_DIR = "release/results";
const DEFAULT_COMMAND_NAME = "branch:proof";

class BranchPolicyProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BranchPolicyProofError";
    this.code = code;
    this.details = details;
  }
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new BranchPolicyProofError("BRANCH_POLICY_PROOF_PATH_INVALID", "Branch policy proof path is outside the project root.");
  }
  return fromRoot;
}

function timestampSlug(isoTimestamp) {
  return String(isoTimestamp).replace(/[:.]/g, "-");
}

function assertNoSensitiveProof(proof) {
  const leak = findSensitiveLeak(proof);
  if (leak) {
    throw new BranchPolicyProofError("BRANCH_POLICY_PROOF_LEAK", "Branch policy proof contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function buildBranchPolicyTriage(summary) {
  return {
    phase: summary.phase,
    status: summary.status,
    nextAction: summary.nextAction,
    githubCli: {
      available: summary.githubCli?.available === true,
      authenticated: summary.githubCli?.authenticated === true,
    },
    branchProtection: {
      status: summary.branchProtection?.status || "unknown",
      code: summary.branchProtection?.code || null,
      nextAction: summary.branchProtection?.nextAction || "confirm-branch-protection-in-github-ui",
    },
    rulesets: {
      status: summary.rulesets?.status || "unknown",
      code: summary.rulesets?.code || null,
      nextAction: summary.rulesets?.nextAction || "confirm-rulesets-in-github-ui",
    },
    releasePolicy: {
      status: summary.releasePolicy?.status || "unknown",
      manualVerificationRequired: summary.releasePolicy?.manualVerificationRequired !== false,
    },
    logsDownloaded: false,
    artifactsDownloaded: false,
    remoteMutation: false,
  };
}

async function buildBranchPolicyProof(options = {}) {
  const summary = options.summary || await runBranchProtectionCheck(options);
  const proof = {
    schemaVersion: 1,
    timestamp: summary.checkedAt,
    generatedAt: summary.checkedAt,
    command: options.commandName || DEFAULT_COMMAND_NAME,
    phase: summary.phase,
    status: summary.status,
    passed: summary.passed,
    skipped: summary.skipped,
    nextAction: summary.nextAction,
    triage: buildBranchPolicyTriage(summary),
    repository: summary.repository,
    branch: summary.branch,
    commit: summary.commit,
    remoteMain: summary.remoteMain,
    githubCli: summary.githubCli,
    branchProtection: summary.branchProtection,
    rulesets: summary.rulesets,
    releasePolicy: summary.releasePolicy,
    uiSetupReference: buildBranchRulesetSetupReference({
      repository: summary.repository?.nameWithOwner,
      branch: summary.branch,
    }),
    logsDownloaded: false,
    artifactsDownloaded: false,
    remoteMutation: false,
  };
  assertNoSensitiveProof(proof);
  return proof;
}

async function writeBranchPolicyProof(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const outputDirRelative = safeRelativeFromRoot(rootDir, options.outputDir || RELEASE_RESULTS_RELATIVE_DIR);
  const outputDir = resolve(rootDir, outputDirRelative);
  const proof = await buildBranchPolicyProof({ ...options, rootDir });
  const fileName = `branch-protection-proof-${timestampSlug(proof.generatedAt)}.json`;
  const reportPath = `${outputDirRelative}/${fileName}`;
  const latestPath = safeRelativeFromRoot(rootDir, options.latestPath || BRANCH_PROTECTION_LATEST_RELATIVE_PATH);
  mkdirSync(outputDir, { recursive: true });
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  writeFileSync(resolve(rootDir, reportPath), body, "utf8");
  writeFileSync(resolve(rootDir, latestPath), body, "utf8");
  return {
    ok: true,
    reportPath,
    latestPath,
    generatedAt: proof.generatedAt,
    phase: proof.phase,
    status: proof.status,
    passed: proof.passed,
    skipped: proof.skipped,
    nextAction: proof.nextAction,
  };
}

function safeError(error) {
  const safe = branchPolicySafeError(error);
  return {
    ok: false,
    code: error && error.code ? error.code : "BRANCH_POLICY_PROOF_FAILED",
    phase: safe.phase || "proof",
    status: "failed",
    passed: false,
    skipped: false,
    message: safe.message || "Branch policy proof generation failed.",
    nextAction: safe.nextAction || "inspect-safe-summary",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await writeBranchPolicyProof(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  BranchPolicyProofError,
  buildBranchPolicyProof,
  safeError,
  writeBranchPolicyProof,
};
