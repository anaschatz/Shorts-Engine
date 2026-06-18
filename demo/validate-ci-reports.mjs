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
const SAFE_RELATIVE_KEYS = new Set(["directory", "latestPath", "relativePath", "reportPath"]);
const SAFE_PLAYWRIGHT_ARTIFACT_RE = /^playwright-[A-Za-z0-9._-]+\.(png|zip|webm)$/;

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
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMs = options.maxAgeMs || parseMaxAgeMs();
  const reports = [
    { label: "api-demo", filePath: resolve(demoResultsDir, "latest.json") },
    { label: "ocr-smoke", filePath: resolve(demoResultsDir, "ocr-latest.json") },
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
  return {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    reports: validated,
    artifacts,
  };
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "CI_REPORTS_INVALID",
    message: error && error.message ? error.message : "CI reports did not pass validation.",
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
  parseMaxAgeMs,
  safeReportRef,
  validateCiReports,
  validateReport,
};
