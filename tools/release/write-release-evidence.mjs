import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { ROOT_DIR, verifyReleaseGate } from "./verify-release-gate.mjs";

const RELEASE_RESULTS_RELATIVE_DIR = "release/results";

class ReleaseEvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseEvidenceError";
    this.code = code;
    this.details = details;
  }
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new ReleaseEvidenceError("RELEASE_EVIDENCE_PATH_INVALID", "Release evidence path is outside the project root.");
  }
  return fromRoot;
}

function timestampSlug(isoTimestamp) {
  return String(isoTimestamp).replace(/[:.]/g, "-");
}

function assertNoSensitiveEvidence(evidence) {
  const leak = findSensitiveLeak(evidence);
  if (leak) {
    throw new ReleaseEvidenceError("RELEASE_EVIDENCE_LEAK", "Release evidence contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function buildReleaseEvidence(options = {}) {
  const gate = verifyReleaseGate(options);
  const evidence = {
    schemaVersion: 1,
    generatedAt: gate.checkedAt,
    project: gate.package,
    releaseGate: {
      ok: gate.ok,
      workflow: gate.workflow.workflow,
      workflowName: gate.workflow.name,
      commandsChecked: gate.workflow.commands,
      packageScripts: gate.packageScripts,
      realCloudIntegrationDefault: gate.workflow.realCloudIntegrationDefault,
      browserRuntimeSkipAllowed: gate.workflow.browserRuntimeSkipAllowed,
    },
    environmentReadiness: {
      ok: gate.environment.ok,
      checkedAt: gate.environment.checkedAt,
      variablesChecked: gate.environment.variablesChecked,
      docsComplete: gate.environment.docs.complete,
      storage: gate.environment.storage,
      persistence: gate.environment.persistence,
      transcription: gate.environment.transcription,
      cloudIntegration: gate.environment.cloudIntegration,
      ci: gate.environment.ci,
      safeDefaults: gate.environment.safeDefaults,
    },
    latestReports: gate.reports.reports.map((report) => ({
      label: report.label,
      relativePath: report.path,
      status: report.status,
    })),
    reportValidation: {
      checkedAt: gate.reports.checkedAt,
      ok: gate.reports.ok,
      playwrightArtifacts: gate.reports.artifacts,
    },
    artifactPolicy: {
      failureOnly: gate.artifactPolicy.failureOnly,
      allowlist: gate.artifactPolicy.allowlist,
      uploadsPassingRunArtifacts: false,
    },
    branchProtection: gate.branchProtection,
    remote: gate.remote,
    limitations: gate.limitations,
  };
  assertNoSensitiveEvidence(evidence);
  return evidence;
}

function writeReleaseEvidence(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const outputDirRelative = safeRelativeFromRoot(rootDir, options.outputDir || RELEASE_RESULTS_RELATIVE_DIR);
  const outputDir = resolve(rootDir, outputDirRelative);
  const evidence = buildReleaseEvidence({ ...options, rootDir });
  const fileName = `release-evidence-${timestampSlug(evidence.generatedAt)}.json`;
  const reportRelativePath = `${outputDirRelative}/${fileName}`;
  const latestRelativePath = `${outputDirRelative}/latest.json`;
  mkdirSync(outputDir, { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(resolve(rootDir, reportRelativePath), body, "utf8");
  writeFileSync(resolve(rootDir, latestRelativePath), body, "utf8");
  return {
    ok: true,
    report: reportRelativePath,
    latest: latestRelativePath,
    generatedAt: evidence.generatedAt,
    status: "passed",
  };
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "RELEASE_EVIDENCE_FAILED",
    message: error && error.message ? error.message : "Release evidence generation failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(writeReleaseEvidence(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  RELEASE_RESULTS_RELATIVE_DIR,
  ReleaseEvidenceError,
  buildReleaseEvidence,
  safeError,
  writeReleaseEvidence,
};
