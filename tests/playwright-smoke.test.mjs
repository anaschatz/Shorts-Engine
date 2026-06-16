import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  artifactFilePath,
  buildArtifactOptions,
  buildArtifactSummary,
  buildPlaywrightReport,
  buildRuntimeUnavailableReport,
  cleanupPlaywrightArtifacts,
  resolveYouTubeLiveBrowserConfig,
  runPlaywrightSmoke,
  safeArtifactName,
  safeArtifactRef,
  writePlaywrightReport,
} from "../demo/run-playwright-smoke.mjs";

const VIDEO_ID = "dQw4w9WgXcQ";
const SAFE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

test("playwright report shape is safe and groups browser E2E checks", () => {
  const report = buildPlaywrightReport({
    checks: [
      { name: "page_title_shortengine", passed: true },
      { name: "download_endpoint_returns_video", passed: true },
    ],
    durationMs: 42,
    failedCases: [],
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4", exists: true },
    health: { payload: { data: { status: "ready", ffmpeg: { ffmpeg: true, ffprobe: true } } } },
    notes: ["safe"],
    runtime: { ok: true, source: "injected" },
    server: { origin: "http://127.0.0.1:<port>" },
    status: "passed",
    artifacts: buildArtifactSummary(buildArtifactOptions({ retentionMax: 20 }), []),
    uploadGenerateDownloadChecks: [{ name: "download_endpoint_returns_video", passed: true }],
    uiStateChecks: [{ name: "initial_export_disabled", passed: true }],
    viewportChecks: [{ name: "viewport_desktop_no_horizontal_overflow", passed: true }],
  });

  assert.equal(report.status, "passed");
  assert.equal(report.browserAutomation.available, true);
  assert.equal(report.browserAutomation.engine, "chromium");
  assert.equal(report.uploadGenerateDownloadChecks.length, 1);
  assert.deepEqual(report.artifacts.files, []);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|adt_|OPENAI_API_KEY/);
});

test("playwright report leak guard fails closed with safe metadata", () => {
  const report = buildPlaywrightReport({
    checks: [],
    durationMs: 1,
    failedCases: [],
    fixture: { relativePath: "/Users/example/private.mp4" },
    health: null,
    notes: [],
    runtime: { ok: true, source: "injected" },
    server: { origin: "http://127.0.0.1:<port>" },
    status: "passed",
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "REPORT_LEAK_GUARD");
  assert.equal(report.failedCases[0].leakCode, "LOCAL_PATH");
  assert.equal(report.failedCases[0].leakPath, "$.fixture.relativePath");
});

test("playwright artifact helpers only expose safe relative artifact references", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-playwright-artifacts-"));
  const screenshotPath = artifactFilePath("2026-06-15T18-00-00-000Z-failure", ".png", tempDir);
  writeFileSync(screenshotPath, "png");

  assert.equal(safeArtifactName("../bad", ".png"), "playwright--bad.png");
  assert.throws(() => artifactFilePath("bad", ".txt", tempDir), /Unsupported Playwright artifact extension/);
  assert.throws(() => safeArtifactRef(screenshotPath, "screenshot"), /Unsafe Playwright artifact reference/);

  const report = buildPlaywrightReport({
    checks: [{ name: "failure_screenshot_created", passed: true }],
    durationMs: 10,
    failedCases: [{ name: "forced_failure", code: "CHECK_FAILED" }],
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    health: null,
    notes: [],
    runtime: { ok: true, source: "injected" },
    server: { origin: "http://127.0.0.1:<port>" },
    status: "failed",
    artifacts: buildArtifactSummary(
      buildArtifactOptions({ retentionMax: 20 }),
      [{ type: "screenshot", relativePath: "demo/results/playwright-artifacts/playwright-safe-failure.png" }],
    ),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.artifacts.files[0].relativePath, "demo/results/playwright-artifacts/playwright-safe-failure.png");
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|storageKey|adt_|OPENAI_API_KEY/);
});

test("trace and video artifacts require explicit options", () => {
  const defaults = buildArtifactOptions({});
  assert.equal(defaults.traceOnFailure, false);
  assert.equal(defaults.videoOnFailure, false);

  const enabled = buildArtifactOptions({ traceOnFailure: true, videoOnFailure: true, retentionMax: 2 });
  assert.equal(enabled.traceOnFailure, true);
  assert.equal(enabled.videoOnFailure, true);
  assert.equal(enabled.retentionMax, 2);
});

test("retention cleanup deletes only managed Playwright demo artifacts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-playwright-retention-"));
  const artifactDir = join(tempDir, "playwright-artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(tempDir, "playwright-smoke-001.json"), "{}");
  writeFileSync(join(tempDir, "playwright-smoke-002.json"), "{}");
  writeFileSync(join(tempDir, "keep-me.json"), "{}");
  writeFileSync(join(artifactDir, "playwright-001-failure.png"), "one");
  writeFileSync(join(artifactDir, "playwright-002-failure.png"), "two");
  writeFileSync(join(artifactDir, "not-playwright.png"), "keep");

  const result = cleanupPlaywrightArtifacts({ outputDir: tempDir, artifactsDir: artifactDir, retentionMax: 1 });
  assert.equal(result.retentionMax, 1);
  assert.equal(result.removedCount, 2);
  assert.equal(existsSync(join(tempDir, "keep-me.json")), true);
  assert.equal(existsSync(join(artifactDir, "not-playwright.png")), true);
  assert.equal(readdirSync(tempDir).filter((name) => /^playwright-smoke-/.test(name)).length, 1);
  assert.equal(readdirSync(artifactDir).filter((name) => /^playwright-.*\.png$/.test(name)).length, 1);
});

test("missing Playwright runtime fails by default and can skip only when explicit", async () => {
  const missingRuntime = {
    ok: false,
    code: "PLAYWRIGHT_NOT_AVAILABLE",
    message: "Playwright is not installed.",
  };
  const failed = await runPlaywrightSmoke({ forceMissingRuntime: true, allowSkip: false, fixturePath: "demo/fixtures/shortsengine-demo-source.mp4" });
  assert.equal(failed.status, "failed");
  assert.ok(failed.failedCases.some((failure) => failure.name === "playwright_runtime_available"));

  const skipped = buildRuntimeUnavailableReport({
    allowSkip: true,
    durationMs: 1,
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    runtime: missingRuntime,
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.failedCases[0].code, "PLAYWRIGHT_NOT_AVAILABLE");
});

test("youtube live browser config is explicit and validates rights and URL before browser work", () => {
  assert.deepEqual(resolveYouTubeLiveBrowserConfig({}), { enabled: false });
  assert.throws(
    () => resolveYouTubeLiveBrowserConfig({
      SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    }),
    (error) => error.code === "ENV_YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED",
  );
  assert.throws(
    () => resolveYouTubeLiveBrowserConfig({
      SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
      SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    }),
    (error) => error.code === "ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED",
  );
  assert.throws(
    () => resolveYouTubeLiveBrowserConfig({
      SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER: "1",
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: `${SAFE_URL}&list=PL123`,
    }),
    (error) => error.code === "ENV_YOUTUBE_LIVE_E2E_URL_INVALID",
  );
  const config = resolveYouTubeLiveBrowserConfig({
    SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.videoId, VIDEO_ID);
  assert.equal(config.url, SAFE_URL);
});

test("playwright report writer creates latest report", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-playwright-demo-"));
  const report = {
    timestamp: "2026-06-15T18:00:00.000Z",
    status: "passed",
    failedCases: [],
  };
  const written = writePlaywrightReport(report, tempDir);
  assert.match(written.reportPath, /playwright-smoke-2026-06-15T18-00-00-000Z\.json$/);
  const latest = JSON.parse(readFileSync(join(tempDir, "playwright-latest.json"), "utf8"));
  assert.equal(latest.status, "passed");
});
