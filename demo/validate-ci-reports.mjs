import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESULTS_DIR } from "./run-smoke.mjs";
import { findSensitiveLeak } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_RESULTS_DIR = resolve(ROOT_DIR, "eval", "results");
const DEFAULT_REPORT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAFE_RELATIVE_KEYS = new Set([
  "contactSheetPath",
  "directory",
  "generatedVideoPath",
  "latestPath",
  "outputRelativePath",
  "relativePath",
  "reportPath",
  "reviewPath",
]);
const SAFE_PLAYWRIGHT_ARTIFACT_RE = /^playwright-[A-Za-z0-9._-]+\.(png|zip|webm)$/;
const REPORT_RECOVERY_COMMANDS = Object.freeze({
  "api-demo": "npm run demo:smoke",
  "ocr-smoke": "npm run ocr:smoke",
  "ocr-qa-review": "npm run ocr:qa:review",
  "browser-contract": "npm run demo:browser",
  "playwright-browser": "npm run demo:browser:ci",
  "youtube-live-proof": "npm run youtube:proof:operator",
  evaluation: "npm run eval",
  "reference-review": "npm run eval:reference",
});

class CiReportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CiReportError";
    this.code = code;
    this.details = details;
  }
}

function parseMaxAgeMs(value = process.env.SHORTSENGINE_CI_REPORT_MAX_AGE_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_REPORT_MAX_AGE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) {
    throw new CiReportError("CI_REPORT_CONFIG_INVALID", "CI report max age is invalid.");
  }
  return Math.floor(parsed);
}

function relativeFromRoot(filePath) {
  const target = resolve(filePath);
  const fromRoot = relative(ROOT_DIR, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new CiReportError("CI_REPORT_PATH_INVALID", "CI report path is outside the project root.");
  }
  return fromRoot;
}

function safeReportRef(filePath) {
  try {
    return relativeFromRoot(filePath);
  } catch {
    return basename(filePath);
  }
}

function readJsonReport(filePath) {
  if (!existsSync(filePath)) {
    throw new CiReportError("CI_REPORT_MISSING", "Required CI report is missing.", { report: safeReportRef(filePath) });
  }
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REPORT_BYTES) {
    throw new CiReportError("CI_REPORT_INVALID", "Required CI report is empty or too large.", { report: safeReportRef(filePath) });
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new CiReportError("CI_REPORT_BAD_JSON", "Required CI report is not valid JSON.", { report: safeReportRef(filePath) });
  }
}

function assertFreshTimestamp(report, { label, maxAgeMs, nowMs }) {
  const timestamp = report && (report.timestamp || report.generatedAt);
  const parsed = Date.parse(timestamp || "");
  if (!Number.isFinite(parsed)) {
    throw new CiReportError("CI_REPORT_TIMESTAMP_INVALID", "CI report timestamp is invalid.", { label });
  }
  if (parsed > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new CiReportError("CI_REPORT_TIMESTAMP_INVALID", "CI report timestamp is in the future.", { label });
  }
  if (nowMs - parsed > maxAgeMs) {
    throw new CiReportError("CI_REPORT_STALE", "CI report is stale.", { label });
  }
}

function assertSafeRelativeReference(value, path) {
  const text = String(value || "");
  if (
    !text ||
    text.includes("\u0000") ||
    text.includes("\\") ||
    text.includes("..") ||
    text.startsWith("/") ||
    /^[A-Za-z]:\\/.test(text) ||
    /^file:/i.test(text)
  ) {
    throw new CiReportError("CI_REPORT_PATH_INVALID", "CI report contains an unsafe relative reference.", { path });
  }
}

function assertSafeRelativeReferences(value, path = "$", depth = 0) {
  if (value === null || value === undefined || depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeRelativeReferences(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (SAFE_RELATIVE_KEYS.has(key) && typeof item === "string") {
      assertSafeRelativeReference(item, nextPath);
    }
    assertSafeRelativeReferences(item, nextPath, depth + 1);
  }
}

function assertPassedReport(report, label) {
  if (Object.prototype.hasOwnProperty.call(report, "status") && report.status !== "passed") {
    throw new CiReportError("CI_REPORT_FAILED", "CI report did not pass.", { label, status: report.status });
  }
  if (Object.prototype.hasOwnProperty.call(report, "passed") && report.passed !== true) {
    throw new CiReportError("CI_REPORT_FAILED", "CI report did not pass.", { label, passed: report.passed });
  }
  if (Array.isArray(report.failedCases) && report.failedCases.length > 0) {
    throw new CiReportError("CI_REPORT_FAILED", "CI report contains failed cases.", { label });
  }
  if (Array.isArray(report.checks) && report.checks.some((check) => check && check.passed === false)) {
    throw new CiReportError("CI_REPORT_FAILED", "CI report contains failed checks.", { label });
  }
}

function assertPlaywrightArtifacts(report) {
  const artifacts = report.artifacts || {};
  if (artifacts.directory !== "demo/results/playwright-artifacts") {
    throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Playwright artifact directory is invalid.");
  }
  if (artifacts.traceOnFailure !== false || artifacts.videoOnFailure !== false) {
    throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Trace/video must stay disabled in the default release gate.");
  }
  if (report.status === "passed" && Array.isArray(artifacts.files) && artifacts.files.length > 0) {
    throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Passing Playwright runs must not publish artifact files.");
  }
  for (const artifact of artifacts.files || []) {
    if (!artifact || typeof artifact.relativePath !== "string") {
      throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Playwright artifact reference is invalid.");
    }
    if (!artifact.relativePath.startsWith("demo/results/playwright-artifacts/")) {
      throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Playwright artifact reference is outside the managed artifact directory.");
    }
    assertSafeRelativeReference(artifact.relativePath, "$.artifacts.files[].relativePath");
  }
}

function assertManagedArtifactDirectory(artifactsDir) {
  if (!existsSync(artifactsDir)) return { exists: false, files: 0 };
  const names = readdirSync(artifactsDir);
  for (const name of names) {
    if (!SAFE_PLAYWRIGHT_ARTIFACT_RE.test(name)) {
      throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Unexpected file in Playwright artifact directory.", { fileName: name });
    }
  }
  return { exists: true, files: names.length };
}

function resolveSafeProjectRef(relativePath, artifactRootDir = ROOT_DIR) {
  assertSafeRelativeReference(relativePath, "$.youtubeLiveProof.outputMp4.relativePath");
  const root = resolve(artifactRootDir);
  const resolved = resolve(root, relativePath);
  const fromRoot = relative(root, resolved);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new CiReportError("CI_REPORT_ARTIFACT_REF_INVALID", "CI report artifact reference is outside the project root.");
  }
  return resolved;
}

function outputMp4RefFromYouTubeLiveProof(report) {
  const outputProofRef = report?.outputProof?.outputMp4?.relativePath;
  if (typeof outputProofRef === "string" && outputProofRef) return outputProofRef;
  const generatedArtifactRef = report?.generatedArtifact?.relativePath;
  if (typeof generatedArtifactRef === "string" && generatedArtifactRef) return generatedArtifactRef;
  return null;
}

function assertYouTubeLiveProofArtifact(report, artifactRootDir = ROOT_DIR) {
  if (report.status !== "passed") return;
  const relativePath = outputMp4RefFromYouTubeLiveProof(report);
  if (!relativePath) {
    throw new CiReportError("CI_REPORT_ARTIFACT_MISSING", "Passing YouTube live proof report does not include an MP4 reference.", {
      label: "youtube-live-proof",
    });
  }
  if (report.outputProof?.ffprobe?.status !== "passed") {
    throw new CiReportError("CI_REPORT_ARTIFACT_UNVERIFIED", "Passing YouTube live proof report did not pass ffprobe.", {
      label: "youtube-live-proof",
      status: report.outputProof?.ffprobe?.status || null,
    });
  }
  const resolved = resolveSafeProjectRef(relativePath, artifactRootDir);
  if (!existsSync(resolved)) {
    throw new CiReportError("CI_REPORT_ARTIFACT_MISSING", "Passing YouTube live proof MP4 is missing.", {
      label: "youtube-live-proof",
      report: relativePath,
    });
  }
  const stats = statSync(resolved);
  if (!stats.isFile() || stats.size <= 0) {
    throw new CiReportError("CI_REPORT_ARTIFACT_INVALID", "Passing YouTube live proof MP4 is empty or invalid.", {
      label: "youtube-live-proof",
      report: relativePath,
    });
  }
}

function validateReport({ filePath, label, maxAgeMs, nowMs }) {
  const report = readJsonReport(filePath);
  const leak = findSensitiveLeak(report);
  if (leak) {
    throw new CiReportError("CI_REPORT_LEAK", "CI report contains sensitive data.", { label, leakCode: leak.code, leakPath: leak.path });
  }
  assertSafeRelativeReferences(report);
  assertFreshTimestamp(report, { label, maxAgeMs, nowMs });
  assertPassedReport(report, label);
  return report;
}

function validateCiReports(options = {}) {
  const demoResultsDir = resolve(options.demoResultsDir || RESULTS_DIR);
  const evalResultsDir = resolve(options.evalResultsDir || EVAL_RESULTS_DIR);
  const artifactRootDir = resolve(options.artifactRootDir || ROOT_DIR);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMs = options.maxAgeMs || parseMaxAgeMs();
  const reports = [
    { label: "api-demo", filePath: resolve(demoResultsDir, "latest.json") },
    { label: "ocr-smoke", filePath: resolve(demoResultsDir, "ocr-latest.json") },
    { label: "ocr-qa-review", filePath: resolve(demoResultsDir, "ocr-qa-review-latest.json") },
    { label: "browser-contract", filePath: resolve(demoResultsDir, "browser-latest.json") },
    { label: "playwright-browser", filePath: resolve(demoResultsDir, "playwright-latest.json") },
    { label: "evaluation", filePath: resolve(evalResultsDir, "latest.json") },
    { label: "reference-review", filePath: resolve(evalResultsDir, "reference-latest.json") },
  ];
  let playwrightStatus = "unknown";
  const validated = reports.map((entry) => {
    const report = validateReport({ ...entry, maxAgeMs, nowMs });
    if (entry.label === "playwright-browser") assertPlaywrightArtifacts(report);
    const status = report.status || (report.passed ? "passed" : "failed");
    if (entry.label === "playwright-browser") playwrightStatus = status;
    return {
      label: entry.label,
      path: safeReportRef(entry.filePath),
      status,
    };
  });
  const artifacts = assertManagedArtifactDirectory(resolve(demoResultsDir, "playwright-artifacts"));
  if (playwrightStatus === "passed" && artifacts.files > 0) {
    throw new CiReportError("CI_REPORT_ARTIFACTS_INVALID", "Passing Playwright runs must not leave failure artifact files.");
  }
  const youtubeLiveProofPath = resolve(demoResultsDir, "youtube-live-e2e-latest.json");
  if (existsSync(youtubeLiveProofPath)) {
    const report = validateReport({
      filePath: youtubeLiveProofPath,
      label: "youtube-live-proof",
      maxAgeMs,
      nowMs,
    });
    assertYouTubeLiveProofArtifact(report, artifactRootDir);
    validated.push({
      label: "youtube-live-proof",
      path: safeReportRef(youtubeLiveProofPath),
      status: report.status || (report.passed ? "passed" : "failed"),
    });
  }
  return {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    reports: validated,
    artifacts,
  };
}

function safeError(error) {
  const label = error?.details?.label || null;
  return {
    ok: false,
    code: error && error.code ? error.code : "CI_REPORTS_INVALID",
    message: error && error.message ? error.message : "CI reports did not pass validation.",
    label,
    report: error?.details?.report || error?.details?.path || null,
    nextAction: label && REPORT_RECOVERY_COMMANDS[label]
      ? REPORT_RECOVERY_COMMANDS[label]
      : "rerun-required-checks-and-inspect-safe-reports",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = validateCiReports();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_REPORT_MAX_AGE_MS,
  CiReportError,
  assertPlaywrightArtifacts,
  assertSafeRelativeReferences,
  assertYouTubeLiveProofArtifact,
  parseMaxAgeMs,
  REPORT_RECOVERY_COMMANDS,
  safeReportRef,
  validateCiReports,
  validateReport,
};
