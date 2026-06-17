import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseMaxAgeMs,
  validateCiReports,
} from "../demo/validate-ci-reports.mjs";

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createReportDirs() {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-ci-reports-"));
  const demoResultsDir = join(root, "demo-results");
  const evalResultsDir = join(root, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  return { demoResultsDir, evalResultsDir };
}

function writeValidReports({ demoResultsDir, evalResultsDir, timestamp }) {
  writeJson(join(demoResultsDir, "latest.json"), {
    timestamp,
    status: "passed",
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    checks: [{ name: "server_health_ready", passed: true }],
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "browser-latest.json"), {
    timestamp,
    status: "passed",
    mode: "dependency-light-browser-contract",
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "playwright-latest.json"), {
    timestamp,
    status: "passed",
    mode: "playwright-browser-e2e",
    artifacts: {
      directory: "demo/results/playwright-artifacts",
      screenshotOnFailure: true,
      traceOnFailure: false,
      videoOnFailure: false,
      retentionMax: 20,
      files: [],
    },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 99, fixtureCount: 6 },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "reference-latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 95, fixtureCount: 8 },
    failedCases: [],
    borderlineCases: [],
  });
}

test("CI report validator accepts fresh safe reports", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  writeValidReports({ ...dirs, timestamp: new Date(nowMs).toISOString() });

  const result = validateCiReports({ ...dirs, nowMs, maxAgeMs: 60_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reports.map((report) => report.label), [
    "api-demo",
    "browser-contract",
    "playwright-browser",
    "evaluation",
    "reference-review",
  ]);
  assert.equal(result.artifacts.exists, false);
});

test("CI report validator rejects stale reports", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  writeValidReports({ ...dirs, timestamp: "2026-06-15T15:00:00.000Z" });

  assert.throws(
    () => validateCiReports({ ...dirs, nowMs, maxAgeMs: 60_000 }),
    /CI report is stale/,
  );
});

test("CI report validator rejects sensitive report contents", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  writeValidReports({ ...dirs, timestamp: new Date(nowMs).toISOString() });
  writeJson(join(dirs.demoResultsDir, "latest.json"), {
    timestamp: new Date(nowMs).toISOString(),
    status: "passed",
    fixture: { relativePath: "/Users/example/private.mp4" },
    failedCases: [],
  });

  assert.throws(
    () => validateCiReports({ ...dirs, nowMs, maxAgeMs: 60_000 }),
    /CI report contains sensitive data/,
  );
});

test("CI report validator rejects passing Playwright artifact files", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  writeValidReports({ ...dirs, timestamp: new Date(nowMs).toISOString() });
  writeJson(join(dirs.demoResultsDir, "playwright-latest.json"), {
    timestamp: new Date(nowMs).toISOString(),
    status: "passed",
    artifacts: {
      directory: "demo/results/playwright-artifacts",
      screenshotOnFailure: true,
      traceOnFailure: false,
      videoOnFailure: false,
      files: [{ type: "screenshot", relativePath: "demo/results/playwright-artifacts/playwright-failure.png" }],
    },
    failedCases: [],
  });

  assert.throws(
    () => validateCiReports({ ...dirs, nowMs, maxAgeMs: 60_000 }),
    /Passing Playwright runs must not publish artifact files/,
  );
});

test("CI report validator rejects stale files in the Playwright artifact directory", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  writeValidReports({ ...dirs, timestamp: new Date(nowMs).toISOString() });
  const artifactDir = join(dirs.demoResultsDir, "playwright-artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "playwright-failure.png"), "fake-png", "utf8");

  assert.throws(
    () => validateCiReports({ ...dirs, nowMs, maxAgeMs: 60_000 }),
    /Passing Playwright runs must not leave failure artifact files/,
  );
});

test("CI report max age config is bounded", () => {
  assert.equal(parseMaxAgeMs("60000"), 60_000);
  assert.throws(() => parseMaxAgeMs("10"), /CI report max age is invalid/);
  assert.throws(() => parseMaxAgeMs("not-a-number"), /CI report max age is invalid/);
});
