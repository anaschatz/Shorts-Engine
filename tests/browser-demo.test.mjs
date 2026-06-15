import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  REQUIRED_TEST_IDS,
  buildBrowserReport,
  collectStaticBrowserChecks,
  runBrowserSmoke,
  writeBrowserReport,
} from "../demo/run-browser-smoke.mjs";

const html = readFileSync("index.html", "utf8");
const app = readFileSync("app.js", "utf8");
const css = readFileSync("styles.css", "utf8");
const manual = readFileSync("demo/MANUAL_TESTING.md", "utf8");

test("browser demo selectors exist and initial UI is fail-closed", () => {
  for (const testId of Object.values(REQUIRED_TEST_IDS)) {
    assert.match(html, new RegExp(`data-testid="${testId}"`));
  }
  assert.match(html, /data-testid="export-button"[^>]*disabled/);
  assert.match(html, /data-testid="download-link"[^>]*hidden/);
  assert.match(html, /data-testid="cancel-job-button"[^>]*hidden/);
  assert.match(html, /data-testid="job-progress"[^>]*hidden/);
});

test("static browser contract checks cover UI, docs and safe states", () => {
  const checks = collectStaticBrowserChecks({ app, css, html, manual });
  assert.ok(checks.length >= 20);
  assert.equal(checks.every((check) => check.passed), true);
  assert.ok(checks.some((check) => check.name === "missing_upload_safe_error_contract"));
  assert.ok(checks.some((check) => check.name === "manual_doc_has_troubleshooting"));
});

test("browser report shape is safe and groups checks", () => {
  const checks = collectStaticBrowserChecks({ app, css, html, manual });
  const report = buildBrowserReport({
    apiReport: {
      status: "passed",
      checks: [
        { name: "server_health_ready", passed: true },
        { name: "valid_fixture_upload_accepted", passed: true },
        { name: "download_returns_rendered_video", passed: true },
      ],
      server: { origin: "http://127.0.0.1:<port>", healthStatus: "ready" },
      export: { status: 200, contentType: "video/mp4", sizeBytes: 10 },
    },
    durationMs: 12,
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    mode: "dependency-light-browser-contract",
    notes: ["safe"],
    staticChecks: checks,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.browserAutomation.available, false);
  assert.equal(report.browserAutomation.manualChecklistRequired, true);
  assert.ok(report.viewportChecks.length >= 1);
  assert.ok(report.uiStateChecks.length >= 1);
  assert.ok(report.uploadGenerateDownloadChecks.length >= 1);
  assert.doesNotMatch(JSON.stringify(report), /\/Users|\/private|OPENAI_API_KEY|storageKey/);
});

test("browser report fails closed on leaks or missing API smoke", () => {
  const checks = collectStaticBrowserChecks({ app, css, html, manual });
  const leaked = buildBrowserReport({
    apiReport: { status: "passed", checks: [], server: null, export: null },
    durationMs: 1,
    fixture: { relativePath: "/Users/example/secret.mp4" },
    mode: "dependency-light-browser-contract",
    notes: [],
    staticChecks: checks,
  });
  assert.equal(leaked.status, "failed");
  assert.equal(leaked.failedCases[0].code, "REPORT_LEAK_GUARD");
  assert.equal(leaked.failedCases[0].leakCode, "LOCAL_PATH");
  assert.equal(leaked.failedCases[0].leakPath, "$.fixture.relativePath");

  const noApi = buildBrowserReport({
    apiReport: { status: "failed", checks: [], server: null, export: null },
    durationMs: 1,
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    mode: "dependency-light-browser-contract",
    notes: [],
    staticChecks: checks,
  });
  assert.equal(noApi.status, "failed");
  assert.ok(noApi.failedCases.some((failure) => failure.name === "api_demo_smoke_passed"));
});

test("browser smoke runner can produce a fail-closed report without server work", async () => {
  const report = await runBrowserSmoke({ skipApiSmoke: true, skipApiSmokeStatus: "failed" });
  assert.equal(report.status, "failed");
  assert.ok(report.failedCases.some((failure) => failure.name === "api_demo_smoke_passed"));
  assert.equal(report.browserAutomation.manualChecklistRequired, true);
});

test("browser report writer creates browser latest report", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-browser-demo-"));
  const report = {
    timestamp: "2026-06-15T17:00:00.000Z",
    status: "passed",
    failedCases: [],
  };
  const written = writeBrowserReport(report, tempDir);
  assert.match(written.reportPath, /browser-smoke-2026-06-15T17-00-00-000Z\.json$/);
  const latest = JSON.parse(readFileSync(join(tempDir, "browser-latest.json"), "utf8"));
  assert.equal(latest.status, "passed");
});
