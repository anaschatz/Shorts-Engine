import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FIXTURE_PATH, fixtureMetadata, relativeFromRoot } from "./create-fixture.mjs";
import { RESULTS_DIR, runDemoSmoke } from "./run-smoke.mjs";
import { findSensitiveLeak, hasSensitiveLeak } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_LATEST = resolve(RESULTS_DIR, "browser-latest.json");
const MANUAL_DOC = resolve(ROOT_DIR, "demo", "MANUAL_TESTING.md");

const REQUIRED_TEST_IDS = Object.freeze({
  sourceLocalButton: "source-local-button",
  sourceYoutubeButton: "source-youtube-button",
  localSourcePanel: "local-source-panel",
  youtubeSourcePanel: "youtube-source-panel",
  youtubeUrlInput: "youtube-url-input",
  youtubeRightsCheckbox: "youtube-rights-checkbox",
  youtubeValidateButton: "youtube-validate-button",
  youtubePreview: "youtube-preview",
  youtubeError: "youtube-error",
  uploadInput: "video-upload-input",
  rightsCheckbox: "rights-checkbox",
  generateButton: "generate-button",
  cancelJobButton: "cancel-job-button",
  exportButton: "export-button",
  downloadLink: "download-link",
  errorPanel: "error-panel",
  jobProgress: "job-progress",
  progressBar: "job-progress-bar",
  projectStatus: "project-status",
});

function nowIso() {
  return new Date().toISOString();
}

function readProjectFile(fileName) {
  return readFileSync(resolve(ROOT_DIR, fileName), "utf8");
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function hasTestId(html, testId) {
  return new RegExp(`data-testid=["']${testId}["']`).test(html);
}

function elementWithTestIdHasAttribute(html, testId, attribute) {
  const pattern = new RegExp(`<[^>]+data-testid=["']${testId}["'][^>]*\\s${attribute}(?:\\s|>|=)`, "i");
  const reversed = new RegExp(`<[^>]+\\s${attribute}(?:\\s|>|=)[^>]*data-testid=["']${testId}["'][^>]*>`, "i");
  return pattern.test(html) || reversed.test(html);
}

function collectStaticBrowserChecks({ app, css, html, manual }) {
  const checks = [];
  addCheck(checks, "page_title_shortengine", /<title>ShortsEngine Studio<\/title>/.test(html));
  addCheck(checks, "page_h1_shortengine", /<h1>ShortsEngine<\/h1>/.test(html));
  addCheck(checks, "csp_present", /Content-Security-Policy/.test(html));
  for (const [name, testId] of Object.entries(REQUIRED_TEST_IDS)) {
    addCheck(checks, `selector_${name}`, hasTestId(html, testId), { testId });
  }
  addCheck(checks, "initial_export_disabled_in_markup", elementWithTestIdHasAttribute(html, REQUIRED_TEST_IDS.exportButton, "disabled"));
  addCheck(checks, "initial_download_hidden_in_markup", elementWithTestIdHasAttribute(html, REQUIRED_TEST_IDS.downloadLink, "hidden"));
  addCheck(checks, "initial_cancel_hidden_in_markup", elementWithTestIdHasAttribute(html, REQUIRED_TEST_IDS.cancelJobButton, "hidden"));
  addCheck(checks, "initial_progress_hidden_in_markup", elementWithTestIdHasAttribute(html, REQUIRED_TEST_IDS.jobProgress, "hidden"));
  addCheck(checks, "missing_upload_safe_error_contract", /UPLOAD_EMPTY/.test(app) && /showSafeError/.test(app));
  addCheck(checks, "completed_job_export_gate_contract", /validateCompletedJobForExport/.test(app) && /downloadLink\.href/.test(app));
  addCheck(checks, "download_route_contract", /\/api\/exports\/\$\{exportId\}\/download/.test(app));
  addCheck(checks, "youtube_validate_only_contract", /\/api\/youtube\/validate/.test(app) && /YOUTUBE_INGEST_NOT_ENABLED/.test(app));
  addCheck(checks, "youtube_render_disabled_contract", /state\.sourceType === "youtube"/.test(app) && /Ingest disabled/.test(app));
  addCheck(checks, "youtube_ui_shared_gate_contract", /deriveYouTubeUiState/.test(app) && /currentYouTubeUiState/.test(app));
  addCheck(checks, "youtube_validate_requires_url_and_rights_contract", /validateYoutubeBtn\.disabled = !youtubeUi\.canValidate/.test(app));
  addCheck(checks, "youtube_auto_validate_debounce_contract", /YOUTUBE_AUTO_VALIDATE_DELAY_MS/.test(app) && /scheduleYouTubeAutoValidate/.test(app));
  addCheck(checks, "youtube_ingest_requires_health_contract", /ingestYoutubeBtn\.disabled = !youtubeUi\.canIngest/.test(app));
  addCheck(checks, "youtube_generate_after_ingest_contract", /generateBtn\.disabled = !youtubeUi\.canGenerate/.test(app));
  addCheck(checks, "youtube_preview_safe_summary_contract", /createYouTubePreviewSummary/.test(app) && /youtubePreviewUrl\.textContent = summary\.label/.test(app));
  addCheck(checks, "youtube_frontend_no_downloader_contract", !/yt-dlp|youtube-dl|execFile|spawn|child_process|stdout|stderr|storageKey|document\.cookie/i.test(app));
  addCheck(checks, "responsive_css_contract", /@media\s*\(/.test(css) && /min-width:\s*320px/.test(css));
  addCheck(checks, "hidden_css_contract", /\[hidden\]\s*{[^}]*display:\s*none\s*!important/s.test(css));
  addCheck(checks, "manual_doc_exists", Boolean(manual));
  addCheck(checks, "manual_doc_has_commands", /npm run demo:fixture/.test(manual) && /npm run demo:browser/.test(manual));
  addCheck(checks, "manual_doc_has_troubleshooting", /FFmpeg missing/.test(manual) && /port already used/i.test(manual));
  return checks;
}

function apiChecksFromReport(apiReport) {
  const names = new Set([
    "server_health_ready",
    "invalid_upload_rejected",
    "valid_fixture_upload_accepted",
    "generate_job_started",
    "job_completed_with_export",
    "download_url_created_after_success",
    "download_returns_rendered_video",
  ]);
  return (apiReport?.checks || []).filter((check) => names.has(check.name));
}

function groupBrowserChecks(staticChecks, apiReport) {
  return {
    viewportChecks: staticChecks.filter((check) => ["responsive_css_contract", "hidden_css_contract"].includes(check.name)),
    uiStateChecks: staticChecks.filter((check) => (
      check.name.startsWith("page_") ||
      check.name.startsWith("selector_") ||
      check.name.startsWith("initial_") ||
      check.name.includes("_contract")
    )),
    uploadGenerateDownloadChecks: apiChecksFromReport(apiReport),
    documentationChecks: staticChecks.filter((check) => check.name.startsWith("manual_")),
  };
}

function buildBrowserReport({ apiReport, durationMs, fixture, mode, notes, staticChecks }) {
  const grouped = groupBrowserChecks(staticChecks, apiReport);
  const checks = [
    ...staticChecks,
    { name: "api_demo_smoke_passed", passed: apiReport?.status === "passed", apiStatus: apiReport?.status || null },
  ];
  const failedCases = [];
  for (const check of checks) {
    if (!check.passed) failedCases.push({ name: check.name, code: check.code || "CHECK_FAILED" });
  }
  const report = {
    timestamp: nowIso(),
    status: failedCases.length ? "failed" : "passed",
    mode,
    browserAutomation: {
      available: false,
      reason: "No repository browser automation dependency is configured.",
      fallback: "Static browser contracts plus full API E2E smoke. Use the manual checklist for true browser interaction.",
      manualChecklistRequired: true,
    },
    durationMs,
    fixture,
    viewportChecks: grouped.viewportChecks,
    uiStateChecks: grouped.uiStateChecks,
    uploadGenerateDownloadChecks: grouped.uploadGenerateDownloadChecks,
    documentationChecks: grouped.documentationChecks,
    apiSmoke: {
      status: apiReport?.status || null,
      server: apiReport?.server || null,
      export: apiReport?.export || null,
    },
    failedCases,
    debuggingNotes: notes,
  };
  const leak = findSensitiveLeak(report);
  if (leak) {
    return {
      timestamp: report.timestamp,
      status: "failed",
      mode,
      durationMs,
      fixture,
      viewportChecks: [],
      uiStateChecks: [],
      uploadGenerateDownloadChecks: [],
      documentationChecks: [],
      apiSmoke: null,
      failedCases: [{ name: "browser_report_no_sensitive_leaks", code: "REPORT_LEAK_GUARD", leakCode: leak.code, leakPath: leak.path }],
      debuggingNotes: ["Report leak guard redacted the full report."],
    };
  }
  return report;
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function writeBrowserReport(report, outputDir = RESULTS_DIR) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = resolve(outputDir, `browser-smoke-${stamp}.json`);
  const latestPath = outputDir === RESULTS_DIR ? BROWSER_LATEST : resolve(outputDir, "browser-latest.json");
  atomicWriteJson(reportPath, report);
  atomicWriteJson(latestPath, report);
  return {
    reportPath: relativeFromRoot(reportPath),
    latestPath: relativeFromRoot(latestPath),
  };
}

async function runBrowserSmoke(options = {}) {
  const started = Date.now();
  const html = readProjectFile("index.html");
  const app = readProjectFile("app.js");
  const css = readProjectFile("styles.css");
  const manual = existsSync(MANUAL_DOC) ? readFileSync(MANUAL_DOC, "utf8") : "";
  const staticChecks = collectStaticBrowserChecks({ app, css, html, manual });
  let apiReport = null;
  const notes = [
    "This runner is dependency-light and does not drive a real browser by itself.",
    "It validates browser-facing contracts and requires the manual checklist for real user-path QA.",
  ];
  if (options.skipApiSmoke) {
    apiReport = { status: options.skipApiSmokeStatus || "skipped", checks: [], server: null, export: null };
    notes.push("API smoke was skipped by caller.");
  } else {
    apiReport = await runDemoSmoke({ fixturePath: options.fixturePath || DEFAULT_FIXTURE_PATH, jobTimeoutMs: options.jobTimeoutMs });
  }
  return buildBrowserReport({
    apiReport,
    durationMs: Date.now() - started,
    fixture: fixtureMetadata(options.fixturePath || DEFAULT_FIXTURE_PATH),
    mode: "dependency-light-browser-contract",
    notes,
    staticChecks,
  });
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const report = await runBrowserSmoke();
  const written = writeBrowserReport(report);
  console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

export {
  BROWSER_LATEST,
  REQUIRED_TEST_IDS,
  buildBrowserReport,
  collectStaticBrowserChecks,
  groupBrowserChecks,
  runBrowserSmoke,
  writeBrowserReport,
};
