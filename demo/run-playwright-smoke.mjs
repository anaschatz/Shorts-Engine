import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FIXTURE_PATH,
  ensureDemoFixture,
  fixtureMetadata,
  relativeFromRoot,
} from "./create-fixture.mjs";
import { RESULTS_DIR } from "./run-smoke.mjs";
import { findSensitiveLeak, safeError } from "./report-safety.mjs";
import { validateSmokeSource } from "./run-youtube-smoke.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_LATEST = resolve(RESULTS_DIR, "playwright-latest.json");
const PLAYWRIGHT_ARTIFACTS_DIR = resolve(RESULTS_DIR, "playwright-artifacts");
const DEFAULT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 90_000;
const DEFAULT_RETENTION_COUNT = 20;
const YOUTUBE_LIVE_BROWSER_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER";
const YOUTUBE_LIVE_RIGHTS_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED";
const YOUTUBE_LIVE_URL_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_URL";
const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]);
const SAFE_ARTIFACT_EXTENSIONS = new Set([".png", ".zip", ".webm"]);

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function safeFailure(name, code = "CHECK_FAILED", details = {}) {
  return { name, code, ...details };
}

function isSkipAllowed(options = {}) {
  return Boolean(options.allowSkip || process.env.SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP === "1");
}

function boundedInteger(value, { fallback, min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function resolveYouTubeLiveBrowserConfig(env = process.env) {
  if (!boolFlag(rawValue(env, YOUTUBE_LIVE_BROWSER_FLAG))) return { enabled: false };
  if (!boolFlag(rawValue(env, YOUTUBE_LIVE_RIGHTS_FLAG))) {
    const error = new Error("YouTube live browser E2E requires explicit rights confirmation.");
    error.code = "YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED";
    throw error;
  }
  const source = validateSmokeSource({
    ...env,
    SHORTSENGINE_YOUTUBE_SMOKE: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_URL: String(
      rawValue(env, YOUTUBE_LIVE_URL_FLAG) || rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_URL") || "",
    ).trim(),
  });
  return {
    enabled: true,
    url: source.canonicalUrl,
    kind: source.kind,
    videoId: source.videoId,
  };
}

function safeStamp(value = nowIso()) {
  return String(value)
    .replace(/[:.]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 80);
}

function isInside(baseDir, candidatePath) {
  const base = resolve(baseDir);
  const target = resolve(candidatePath);
  const fromBase = relative(base, target);
  return fromBase === "" || (!fromBase.startsWith("..") && !isAbsolute(fromBase));
}

function safeArtifactName(label, extension) {
  const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  if (!SAFE_ARTIFACT_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported Playwright artifact extension.");
  }
  const safeLabel = String(label || "artifact")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120) || "artifact";
  return `playwright-${safeLabel}${ext}`;
}

function artifactFilePath(label, extension, artifactsDir = PLAYWRIGHT_ARTIFACTS_DIR) {
  const filePath = resolve(artifactsDir, safeArtifactName(label, extension));
  if (!isInside(artifactsDir, filePath)) {
    throw new Error("Unsafe Playwright artifact path.");
  }
  return filePath;
}

function safeArtifactRef(filePath, type) {
  const relativePath = relativeFromRoot(filePath);
  if (!relativePath.startsWith("demo/results/playwright-artifacts/") || relativePath.includes("..") || relativePath.includes("\\")) {
    throw new Error("Unsafe Playwright artifact reference.");
  }
  return { type, relativePath };
}

function buildArtifactOptions(options = {}) {
  const retentionMax = boundedInteger(options.retentionMax ?? process.env.SHORTSENGINE_BROWSER_E2E_RETENTION_MAX, {
    fallback: DEFAULT_RETENTION_COUNT,
    min: 1,
    max: 200,
  });
  return {
    artifactsDir: resolve(options.artifactsDir || PLAYWRIGHT_ARTIFACTS_DIR),
    screenshotOnFailure: options.screenshotOnFailure !== false,
    traceOnFailure: options.traceOnFailure ?? boolFlag(process.env.SHORTSENGINE_BROWSER_E2E_TRACE),
    videoOnFailure: options.videoOnFailure ?? boolFlag(process.env.SHORTSENGINE_BROWSER_E2E_VIDEO),
    retentionMax,
  };
}

function buildArtifactSummary(options = {}, files = [], cleanup = null) {
  return {
    directory: relativeFromRoot(options.artifactsDir || PLAYWRIGHT_ARTIFACTS_DIR),
    screenshotOnFailure: options.screenshotOnFailure !== false,
    traceOnFailure: Boolean(options.traceOnFailure),
    videoOnFailure: Boolean(options.videoOnFailure),
    retentionMax: options.retentionMax || DEFAULT_RETENTION_COUNT,
    files,
    cleanup,
  };
}

function allowedReportFileName(fileName) {
  return /^playwright-smoke-[A-Za-z0-9._-]+\.json$/.test(fileName);
}

function allowedArtifactFileName(fileName) {
  return /^playwright-[A-Za-z0-9._-]+\.(png|zip|webm)$/.test(fileName);
}

function listManagedFiles(dir, matcher) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(matcher)
    .map((fileName) => {
      const filePath = resolve(dir, fileName);
      if (!isInside(dir, filePath)) return null;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) return null;
        return { fileName, filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));
}

function cleanupPlaywrightArtifacts({ outputDir = RESULTS_DIR, artifactsDir = PLAYWRIGHT_ARTIFACTS_DIR, retentionMax = DEFAULT_RETENTION_COUNT } = {}) {
  const max = boundedInteger(retentionMax, { fallback: DEFAULT_RETENTION_COUNT, min: 1, max: 200 });
  const removed = [];
  const reportDir = resolve(outputDir);
  const safeArtifactsDir = resolve(artifactsDir);
  for (const entry of listManagedFiles(reportDir, allowedReportFileName).slice(max)) {
    unlinkSync(entry.filePath);
    removed.push(relativeFromRoot(entry.filePath));
  }
  for (const entry of listManagedFiles(safeArtifactsDir, allowedArtifactFileName).slice(max)) {
    unlinkSync(entry.filePath);
    removed.push(relativeFromRoot(entry.filePath));
  }
  return { retentionMax: max, removedCount: removed.length, removed };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok && payload && payload.ok === true,
    status: response.status,
    payload,
  };
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error("Could not allocate local port."));
      });
    });
  });
}

function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(port),
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
      MATCHCUTS_PERSISTENCE_ADAPTER: "sqlite",
      MATCHCUTS_SQLITE_FILE: "playwright-smoke.sqlite",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  const collect = (chunk, stream) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      let event = { stream, level: stream === "stderr" ? "error" : "info", event: "server_output" };
      try {
        const parsed = JSON.parse(line);
        event = {
          stream,
          level: parsed.level || event.level,
          event: parsed.event || null,
          code: parsed.code || null,
          service: parsed.service || null,
        };
      } catch {
        // Keep server output structured and path-safe in persisted reports.
      }
      events.push(event);
      if (events.length > 40) events.shift();
    }
  };
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  return { child, events };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", resolveStop)),
    delay(2500).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }),
  ]);
}

async function waitForHealth(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await requestJson(baseUrl, "/health");
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, error: safeError(error) };
    }
    await delay(300);
  }
  return last || { ok: false, error: { code: "HEALTH_TIMEOUT", message: "Health endpoint did not respond." } };
}

async function resolvePlaywrightRuntime(options = {}) {
  if (options.forceMissingRuntime) {
    return {
      ok: false,
      code: "PLAYWRIGHT_NOT_AVAILABLE",
      message: "Playwright runtime was forced unavailable by the caller.",
    };
  }
  if (options.playwright) return { ok: true, playwright: options.playwright, source: "injected" };
  try {
    const playwright = await import("playwright");
    return { ok: true, playwright, source: "dependency" };
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_NOT_AVAILABLE",
      message: "Playwright is not installed. Run npm install before browser E2E checks.",
    };
  }
}

function normalizeRuntime(runtime) {
  if (runtime && runtime.ok) {
    return {
      available: true,
      engine: "chromium",
      source: runtime.source || "dependency",
      headless: true,
    };
  }
  return {
    available: false,
    engine: "chromium",
    source: runtime && runtime.source ? runtime.source : "missing",
    headless: true,
  };
}

function buildPlaywrightReport({
  artifacts = null,
  checks,
  durationMs,
  failedCases,
  fixture,
  health,
  mode = "playwright-browser-e2e",
  notes = [],
  runtime,
  server,
  status,
  uploadGenerateDownloadChecks = [],
  uiStateChecks = [],
  viewportChecks = [],
}) {
  const report = {
    timestamp: nowIso(),
    status,
    mode,
    browserAutomation: normalizeRuntime(runtime),
    durationMs,
    fixture,
    server: {
      origin: server?.origin || "http://127.0.0.1:<port>",
      healthStatus: health?.payload?.data?.status || null,
      ffmpeg: Boolean(health?.payload?.data?.ffmpeg?.ffmpeg),
      ffprobe: Boolean(health?.payload?.data?.ffmpeg?.ffprobe),
    },
    viewportChecks,
    uiStateChecks,
    uploadGenerateDownloadChecks,
    artifacts,
    checks,
    failedCases,
    debuggingNotes: notes,
  };
  const leak = findSensitiveLeak(report);
  if (leak) {
    return {
      timestamp: report.timestamp,
      status: "failed",
      mode,
      browserAutomation: normalizeRuntime(runtime),
      durationMs,
      fixture,
      viewportChecks: [],
      uiStateChecks: [],
      uploadGenerateDownloadChecks: [],
      artifacts: buildArtifactSummary(artifacts || {}, []),
      checks: [{ name: "playwright_report_no_sensitive_leaks", passed: false, code: "REPORT_LEAK_GUARD", leakCode: leak.code, leakPath: leak.path }],
      failedCases: [{ name: "playwright_report_no_sensitive_leaks", code: "REPORT_LEAK_GUARD", leakCode: leak.code, leakPath: leak.path }],
      debuggingNotes: ["Report leak guard redacted the full report."],
    };
  }
  return report;
}

async function captureFailureScreenshot(page, runStamp, artifactOptions) {
  if (!page || !artifactOptions.screenshotOnFailure) return null;
  mkdirSync(artifactOptions.artifactsDir, { recursive: true });
  const target = artifactFilePath(`${runStamp}-failure`, ".png", artifactOptions.artifactsDir);
  await page.screenshot({ path: target, fullPage: true });
  return safeArtifactRef(target, "screenshot");
}

async function stopTrace(context, runStamp, artifactOptions, keep) {
  if (!context || !artifactOptions.traceOnFailure) return null;
  if (!keep) {
    await context.tracing.stop().catch(() => {});
    return null;
  }
  mkdirSync(artifactOptions.artifactsDir, { recursive: true });
  const target = artifactFilePath(`${runStamp}-trace`, ".zip", artifactOptions.artifactsDir);
  await context.tracing.stop({ path: target });
  return safeArtifactRef(target, "trace");
}

async function saveFailureVideo(video, runStamp, artifactOptions, keep) {
  if (!video || !artifactOptions.videoOnFailure) return null;
  if (!keep) {
    await video.delete().catch(() => {});
    return null;
  }
  mkdirSync(artifactOptions.artifactsDir, { recursive: true });
  const target = artifactFilePath(`${runStamp}-video`, ".webm", artifactOptions.artifactsDir);
  await video.saveAs(target);
  await video.delete().catch(() => {});
  return safeArtifactRef(target, "video");
}

async function captureFailureArtifacts({ artifactOptions, context, page, runStamp, traceStarted }) {
  const files = [];
  const screenshot = await captureFailureScreenshot(page, runStamp, artifactOptions).catch(() => null);
  if (screenshot) files.push(screenshot);
  if (traceStarted) {
    const trace = await stopTrace(context, runStamp, artifactOptions, true).catch(() => null);
    if (trace) files.push(trace);
  }
  return files;
}

function buildRuntimeUnavailableReport({ allowSkip = false, durationMs = 0, fixture, runtime }) {
  const status = allowSkip ? "skipped" : "failed";
  const code = runtime?.code || "PLAYWRIGHT_NOT_AVAILABLE";
  const checks = [{ name: "playwright_runtime_available", passed: false, code }];
  const artifactOptions = buildArtifactOptions();
  return buildPlaywrightReport({
    checks,
    durationMs,
    failedCases: [safeFailure("playwright_runtime_available", code)],
    fixture,
    health: null,
    notes: [
      allowSkip
        ? "Browser E2E was explicitly skipped because Playwright runtime is unavailable."
        : "Install Playwright and its browser runtime before running browser E2E.",
    ],
    runtime,
    artifacts: buildArtifactSummary(artifactOptions, []),
    server: { origin: "http://127.0.0.1:<port>" },
    status,
  });
}

async function isHidden(locator) {
  return locator.evaluate((element) => element.hidden || window.getComputedStyle(element).display === "none");
}

async function measureOverflow(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  return {
    name: `viewport_${viewport.name}_no_horizontal_overflow`,
    passed: metrics.documentWidth <= metrics.viewportWidth && metrics.bodyWidth <= metrics.viewportWidth,
    viewport: viewport.name,
    width: viewport.width,
    height: viewport.height,
  };
}

async function runBrowserFlow({ baseUrl, fixturePath, page, timeoutMs, youtubeLive = null }) {
  const checks = [];
  const viewportChecks = [];
  const uiStateChecks = [];
  const uploadGenerateDownloadChecks = [];

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="generate-button"]', { timeout: 10_000 });

  const title = await page.title();
  addCheck(uiStateChecks, "page_title_shortengine", title === "ShortsEngine Studio", { title });
  addCheck(uiStateChecks, "page_h1_shortengine", (await page.locator("h1").first().textContent()) === "ShortsEngine");

  for (const viewport of VIEWPORTS) {
    viewportChecks.push(await measureOverflow(page, viewport));
  }
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });

  const uploadInput = page.getByTestId("video-upload-input");
  const sourceYoutubeButton = page.getByTestId("source-youtube-button");
  const sourceLocalButton = page.getByTestId("source-local-button");
  const youtubeUrlInput = page.getByTestId("youtube-url-input");
  const youtubeRightsCheckbox = page.getByTestId("youtube-rights-checkbox");
  const youtubeValidateButton = page.getByTestId("youtube-validate-button");
  const youtubeIngestButton = page.getByTestId("youtube-ingest-button");
  const youtubeIngestStatus = page.getByTestId("youtube-ingest-status");
  const youtubePreview = page.getByTestId("youtube-preview");
  const rightsCheckbox = page.getByTestId("rights-checkbox");
  const generateButton = page.getByTestId("generate-button");
  const cancelButton = page.getByTestId("cancel-job-button");
  const exportButton = page.getByTestId("export-button");
  const downloadLink = page.getByTestId("download-link");
  const errorPanel = page.getByTestId("error-panel");
  const progress = page.getByTestId("job-progress");
  const progressBar = page.getByTestId("job-progress-bar");
  const projectStatus = page.getByTestId("project-status");

  addCheck(uiStateChecks, "initial_export_disabled", await exportButton.isDisabled());
  addCheck(uiStateChecks, "initial_download_hidden", await isHidden(downloadLink));
  addCheck(uiStateChecks, "initial_cancel_hidden", await isHidden(cancelButton));
  addCheck(uiStateChecks, "initial_progress_hidden", await isHidden(progress));

  if (youtubeLive && youtubeLive.enabled) {
    await sourceYoutubeButton.click();
    addCheck(uiStateChecks, "youtube_live_source_generate_disabled_before_ingest", await generateButton.isDisabled());
    addCheck(uiStateChecks, "youtube_live_url_input_visible", !(await isHidden(youtubeUrlInput)));
    await youtubeUrlInput.fill(youtubeLive.url);
    addCheck(uiStateChecks, "youtube_live_validate_disabled_until_rights", await youtubeValidateButton.isDisabled());
    await youtubeRightsCheckbox.check();
    await youtubeValidateButton.click();
    await youtubePreview.waitFor({ state: "visible", timeout: 10_000 });
    const previewText = await youtubePreview.textContent();
    addCheck(uiStateChecks, "youtube_live_preview_visible", !(await isHidden(youtubePreview)));
    addCheck(uiStateChecks, "youtube_live_preview_safe", previewText.includes(youtubeLive.videoId) && !/https?:\/\//i.test(previewText));
    addCheck(uiStateChecks, "youtube_live_ingest_enabled_after_ready_validation", !(await youtubeIngestButton.isDisabled()));
    if (!(await youtubeIngestButton.isDisabled())) {
      await youtubeIngestButton.click();
      await page.waitForFunction(() => {
        const status = document.querySelector('[data-testid="project-status"]')?.textContent || "";
        const generate = document.querySelector('[data-testid="generate-button"]');
        return status === "YouTube ingested" || (generate && !generate.disabled);
      }, null, { timeout: 120_000 });
    }
    addCheck(uploadGenerateDownloadChecks, "youtube_live_ingest_created_project_state", (await projectStatus.textContent()) === "YouTube ingested");
    addCheck(uploadGenerateDownloadChecks, "youtube_live_generate_enabled_after_ingest", !(await generateButton.isDisabled()));

    await rightsCheckbox.check();
    await generateButton.click();
    await progress.waitFor({ state: "visible", timeout: 10_000 });
    addCheck(uploadGenerateDownloadChecks, "youtube_live_job_progress_visible", !(await isHidden(progress)));
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="project-status"]')?.textContent || "";
      const error = document.querySelector('[data-testid="error-panel"]');
      return status === "Rendered" || (error && !error.hidden && error.textContent);
    }, null, { timeout: timeoutMs });

    const finalStatus = await projectStatus.textContent();
    addCheck(uploadGenerateDownloadChecks, "youtube_live_job_completed_with_rendered_status", finalStatus === "Rendered", { status: finalStatus });
    addCheck(uploadGenerateDownloadChecks, "youtube_live_download_hidden_until_completed_render", finalStatus === "Rendered" && !(await isHidden(downloadLink)));
    let download = { status: 0, contentType: "", sizeBytes: 0 };
    if (finalStatus === "Rendered") {
      download = await page.evaluate(async () => {
        const href = document.querySelector('[data-testid="download-link"]')?.getAttribute("href") || "";
        const response = await fetch(href);
        const buffer = await response.arrayBuffer();
        return {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          sizeBytes: buffer.byteLength,
        };
      });
    }
    addCheck(uploadGenerateDownloadChecks, "youtube_live_download_endpoint_returns_video", download.status === 200 && download.contentType.includes("video/mp4") && download.sizeBytes > 0, {
      status: download.status,
      contentType: download.contentType,
      sizeBytes: download.sizeBytes,
    });
    checks.push(...viewportChecks, ...uiStateChecks, ...uploadGenerateDownloadChecks);
    return { checks, viewportChecks, uiStateChecks, uploadGenerateDownloadChecks };
  }

  await sourceYoutubeButton.click();
  addCheck(uiStateChecks, "youtube_source_generate_disabled", await generateButton.isDisabled());
  addCheck(uiStateChecks, "youtube_url_input_visible", !(await isHidden(youtubeUrlInput)));
  addCheck(uiStateChecks, "youtube_ingest_disabled_by_default", await youtubeIngestButton.isDisabled());
  addCheck(uiStateChecks, "youtube_ingest_status_visible", /disabled by default|unavailable/i.test(await youtubeIngestStatus.textContent()));
  await youtubeUrlInput.fill("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  await youtubeValidateButton.click();
  await errorPanel.waitFor({ state: "visible", timeout: 5000 });
  addCheck(uiStateChecks, "youtube_rights_required_safe_error", /YOUTUBE_RIGHTS_REQUIRED/.test(await errorPanel.textContent()));
  await youtubeRightsCheckbox.check();
  await youtubeValidateButton.click();
  await youtubePreview.waitFor({ state: "visible", timeout: 5000 });
  addCheck(uiStateChecks, "youtube_validate_only_preview_visible", !(await isHidden(youtubePreview)));
  addCheck(uiStateChecks, "youtube_generate_stays_disabled_after_validation", await generateButton.isDisabled());
  addCheck(uiStateChecks, "youtube_ingest_stays_disabled_after_validation_without_adapter", await youtubeIngestButton.isDisabled());
  await sourceLocalButton.click();

  await generateButton.click();
  await errorPanel.waitFor({ state: "visible", timeout: 5000 });
  addCheck(uiStateChecks, "missing_upload_safe_error", /UPLOAD_EMPTY/.test(await errorPanel.textContent()));

  await uploadInput.setInputFiles(fixturePath);
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent === "Uploaded", null, { timeout: 30_000 });
  addCheck(uploadGenerateDownloadChecks, "fixture_uploaded_from_browser", (await projectStatus.textContent()) === "Uploaded");

  await generateButton.click();
  await errorPanel.waitFor({ state: "visible", timeout: 5000 });
  addCheck(uiStateChecks, "rights_required_safe_error", /RIGHTS_REQUIRED/.test(await errorPanel.textContent()));

  await rightsCheckbox.check();
  await generateButton.click();
  await progress.waitFor({ state: "visible", timeout: 10_000 });
  addCheck(uploadGenerateDownloadChecks, "job_progress_visible", !(await isHidden(progress)));
  addCheck(uploadGenerateDownloadChecks, "cancel_visible_while_busy", !(await isHidden(cancelButton)));
  addCheck(uploadGenerateDownloadChecks, "progress_bar_bounded", await progressBar.evaluate((element) => {
    const width = Number.parseFloat(element.style.width || "0");
    return Number.isFinite(width) && width >= 0 && width <= 100;
  }));

  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="project-status"]')?.textContent || "";
    const error = document.querySelector('[data-testid="error-panel"]');
    return status === "Rendered" || (error && !error.hidden && error.textContent);
  }, null, { timeout: timeoutMs });

  const finalStatus = await projectStatus.textContent();
  addCheck(uploadGenerateDownloadChecks, "job_completed_with_rendered_status", finalStatus === "Rendered", { status: finalStatus });
  addCheck(uploadGenerateDownloadChecks, "export_enabled_after_completed_render", finalStatus === "Rendered" && !(await exportButton.isDisabled()));
  addCheck(uploadGenerateDownloadChecks, "download_visible_after_completed_render", finalStatus === "Rendered" && !(await isHidden(downloadLink)));

  let download = { status: 0, contentType: "", sizeBytes: 0 };
  if (finalStatus === "Rendered") {
    download = await page.evaluate(async () => {
      const href = document.querySelector('[data-testid="download-link"]')?.getAttribute("href") || "";
      const response = await fetch(href);
      const buffer = await response.arrayBuffer();
      return {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        sizeBytes: buffer.byteLength,
      };
    });
  }
  addCheck(uploadGenerateDownloadChecks, "download_endpoint_returns_video", download.status === 200 && download.contentType.includes("video/mp4") && download.sizeBytes > 0, {
    status: download.status,
    contentType: download.contentType,
    sizeBytes: download.sizeBytes,
  });

  checks.push(...viewportChecks, ...uiStateChecks, ...uploadGenerateDownloadChecks);
  return { checks, viewportChecks, uiStateChecks, uploadGenerateDownloadChecks };
}

async function runPlaywrightSmoke(options = {}) {
  const started = Date.now();
  const runStamp = safeStamp(nowIso());
  const artifactOptions = buildArtifactOptions(options);
  const fixturePath = resolve(options.fixturePath || DEFAULT_FIXTURE_PATH);
  const fixtureResult = ensureDemoFixture({ outputPath: fixturePath });
  const fixture = fixtureResult.fixture || fixtureMetadata(fixturePath);
  if (!fixtureResult.ok) {
    return buildPlaywrightReport({
      checks: [{ name: "demo_fixture_ready", passed: false, code: fixtureResult.error?.code || "FIXTURE_NOT_READY" }],
      durationMs: Date.now() - started,
      failedCases: [safeFailure("demo_fixture_ready", fixtureResult.error?.code || "FIXTURE_NOT_READY")],
      fixture,
      health: null,
      notes: ["The deterministic demo fixture could not be prepared."],
      runtime: { ok: false, code: "FIXTURE_NOT_READY" },
      artifacts: buildArtifactSummary(artifactOptions, []),
      server: { origin: "http://127.0.0.1:<port>" },
      status: "failed",
    });
  }

  const runtime = await resolvePlaywrightRuntime(options);
  if (!runtime.ok) {
    return buildRuntimeUnavailableReport({
      allowSkip: isSkipAllowed(options),
      durationMs: Date.now() - started,
      fixture,
      runtime,
    });
  }

  let browser = null;
  let context = null;
  let page = null;
  let video = null;
  let server = null;
  let baseUrl = null;
  let health = null;
  let traceStarted = false;
  const notes = [];
  let youtubeLive = null;
  try {
    youtubeLive = resolveYouTubeLiveBrowserConfig(options.env || process.env);
    const port = Number(options.port || process.env.PLAYWRIGHT_SMOKE_PORT) || await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(port, youtubeLive.enabled
      ? { ...(options.env || {}), SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1" }
      : {});
    health = await waitForHealth(baseUrl);
    if (!health || !health.ok || health.payload?.data?.status !== "ready") {
      return buildPlaywrightReport({
        checks: [{ name: "server_health_ready", passed: false, status: health?.payload?.data?.status || null }],
        durationMs: Date.now() - started,
        failedCases: [safeFailure("server_health_ready", "HEALTH_NOT_READY")],
        fixture,
        health,
        notes: ["Local server did not become ready before browser automation."],
        runtime,
        artifacts: buildArtifactSummary(artifactOptions, []),
        server: { origin: "http://127.0.0.1:<port>", events: server.events },
        status: "failed",
      });
    }

    try {
      browser = await runtime.playwright.chromium.launch({ headless: true });
    } catch (error) {
      return buildPlaywrightReport({
        checks: [{ name: "playwright_browser_launch", passed: false, code: "PLAYWRIGHT_LAUNCH_FAILED" }],
        durationMs: Date.now() - started,
        failedCases: [safeFailure("playwright_browser_launch", "PLAYWRIGHT_LAUNCH_FAILED")],
        fixture,
        health,
        notes: ["Playwright is installed but Chromium could not launch. Run the documented browser install step."],
        runtime,
        artifacts: buildArtifactSummary(artifactOptions, []),
        server: { origin: "http://127.0.0.1:<port>", events: server.events },
        status: "failed",
      });
    }

    const contextOptions = { acceptDownloads: false, viewport: { width: 1280, height: 900 } };
    if (artifactOptions.videoOnFailure) {
      mkdirSync(artifactOptions.artifactsDir, { recursive: true });
      contextOptions.recordVideo = { dir: artifactOptions.artifactsDir, size: { width: 1280, height: 900 } };
    }
    context = await browser.newContext(contextOptions);
    if (artifactOptions.traceOnFailure) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      traceStarted = true;
    }
    page = await context.newPage();
    video = artifactOptions.videoOnFailure && typeof page.video === "function" ? page.video() : null;
    const flow = await runBrowserFlow({
      baseUrl,
      fixturePath,
      page,
      timeoutMs: Number(options.jobTimeoutMs || process.env.PLAYWRIGHT_SMOKE_JOB_TIMEOUT_MS) || JOB_TIMEOUT_MS,
      youtubeLive,
    });
    const failedCases = flow.checks
      .filter((check) => !check.passed)
      .map((check) => safeFailure(check.name, check.code || "CHECK_FAILED"));
    const failed = failedCases.length > 0;
    let artifactFiles = failed
      ? await captureFailureArtifacts({ artifactOptions, context, page, runStamp, traceStarted })
      : [];
    if (traceStarted) {
      if (!failed) await stopTrace(context, runStamp, artifactOptions, false);
      traceStarted = false;
    }
    await context.close();
    context = null;
    const videoRef = await saveFailureVideo(video, runStamp, artifactOptions, failed);
    if (videoRef) artifactFiles = [...artifactFiles, videoRef];
    await browser.close();
    browser = null;
    return buildPlaywrightReport({
      checks: flow.checks,
      durationMs: Date.now() - started,
      failedCases,
      fixture,
      health,
      notes,
      runtime,
      artifacts: buildArtifactSummary(artifactOptions, artifactFiles),
      server: { origin: "http://127.0.0.1:<port>", events: server.events },
      status: failed ? "failed" : "passed",
      uploadGenerateDownloadChecks: flow.uploadGenerateDownloadChecks,
      uiStateChecks: flow.uiStateChecks,
      viewportChecks: flow.viewportChecks,
    });
  } catch (error) {
    let artifactFiles = [];
    if (page) {
      artifactFiles = await captureFailureArtifacts({ artifactOptions, context, page, runStamp, traceStarted });
      traceStarted = false;
    }
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    const videoRef = await saveFailureVideo(video, runStamp, artifactOptions, Boolean(video));
    if (videoRef) artifactFiles.push(videoRef);
    return buildPlaywrightReport({
      checks: [{ name: "playwright_smoke_unexpected", passed: false, code: safeError(error).code }],
      durationMs: Date.now() - started,
      failedCases: [{ name: "playwright_smoke_unexpected", ...safeError(error) }],
      fixture,
      health,
      notes: ["Browser E2E failed with a safe structured error."],
      runtime,
      artifacts: buildArtifactSummary(artifactOptions, artifactFiles),
      server: { origin: "http://127.0.0.1:<port>" },
      status: "failed",
    });
  } finally {
    if (traceStarted && context) await stopTrace(context, runStamp, artifactOptions, false).catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server.child);
  }
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function writePlaywrightReport(report, outputDir = RESULTS_DIR) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = resolve(outputDir, `playwright-smoke-${stamp}.json`);
  const latestPath = outputDir === RESULTS_DIR ? PLAYWRIGHT_LATEST : resolve(outputDir, "playwright-latest.json");
  const artifactsDir = outputDir === RESULTS_DIR ? PLAYWRIGHT_ARTIFACTS_DIR : resolve(outputDir, "playwright-artifacts");
  const retentionMax = report.artifacts && report.artifacts.retentionMax ? report.artifacts.retentionMax : DEFAULT_RETENTION_COUNT;
  atomicWriteJson(reportPath, report);
  atomicWriteJson(latestPath, report);
  const cleanup = cleanupPlaywrightArtifacts({ outputDir, artifactsDir, retentionMax });
  const finalReport = report.artifacts
    ? { ...report, artifacts: { ...report.artifacts, cleanup } }
    : report;
  atomicWriteJson(reportPath, finalReport);
  atomicWriteJson(latestPath, finalReport);
  return {
    reportPath: relativeFromRoot(reportPath),
    latestPath: relativeFromRoot(latestPath),
    cleanup,
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const timeout = Number(process.env.PLAYWRIGHT_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  let timeoutId;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => {
      resolveTimeout(buildPlaywrightReport({
        artifacts: buildArtifactSummary(buildArtifactOptions(), []),
        checks: [{ name: "playwright_smoke_timeout", passed: false, code: "PLAYWRIGHT_SMOKE_TIMEOUT" }],
        durationMs: timeout,
        failedCases: [safeFailure("playwright_smoke_timeout", "PLAYWRIGHT_SMOKE_TIMEOUT")],
        fixture: fixtureMetadata(),
        health: null,
        notes: ["The browser E2E runner exceeded its bounded timeout."],
        runtime: { ok: false, code: "PLAYWRIGHT_SMOKE_TIMEOUT" },
        server: { origin: "http://127.0.0.1:<port>" },
        status: "failed",
      }));
    }, timeout);
    if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
  });
  const report = await Promise.race([runPlaywrightSmoke(), timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  const written = writePlaywrightReport(report);
  console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
  if (report.status === "failed") process.exitCode = 1;
}

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETENTION_COUNT,
  JOB_TIMEOUT_MS,
  PLAYWRIGHT_ARTIFACTS_DIR,
  PLAYWRIGHT_LATEST,
  VIEWPORTS,
  artifactFilePath,
  buildArtifactOptions,
  buildArtifactSummary,
  buildPlaywrightReport,
  buildRuntimeUnavailableReport,
  cleanupPlaywrightArtifacts,
  runBrowserFlow,
  runPlaywrightSmoke,
  resolveYouTubeLiveBrowserConfig,
  safeArtifactName,
  safeArtifactRef,
  writePlaywrightReport,
};
