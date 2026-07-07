import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseMaxAgeMs,
  validateCiReports,
} from "../demo/validate-ci-reports.mjs";

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createReportDirs() {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-ci-reports-"));
  const demoResultsDir = join(root, "demo-results");
  const evalResultsDir = join(root, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  return { root, demoResultsDir, evalResultsDir };
}

function writeValidReports({ demoResultsDir, evalResultsDir, timestamp }) {
  writeJson(join(demoResultsDir, "latest.json"), {
    timestamp,
    status: "passed",
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    checks: [{ name: "server_health_ready", passed: true }],
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "ocr-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    skipped: true,
    degraded: true,
    runtime: {
      providerMode: "deterministic-scoreboard-ocr",
      localOcrEnabled: false,
      fallbackAvailable: true,
      networkRequired: false,
    },
    fixture: { relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    checks: [{ name: "scoreboard_ocr_output_valid", passed: true }],
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "ocr-qa-review-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:qa:review",
    phase: "ocr-qa-review-skipped",
    status: "passed",
    passed: true,
    skipped: true,
    calibration: {
      goalEvidencePolicy: "support_only",
      ocrEvidenceUsable: false,
      decisionSupportLevel: "ignore",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
    },
    checks: [{ name: "ocr_qa_review_skipped_without_manual_input", passed: true }],
    failedCases: [],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
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

function writePassingYouTubeLiveProof({ root, demoResultsDir, timestamp, relativePath = "manual-downloads/proof.mp4", writeMp4 = true }) {
  if (writeMp4) {
    const filePath = join(root, relativePath);
    mkdirSync(join(root, "manual-downloads"), { recursive: true });
    writeFileSync(filePath, Buffer.from("mp4-proof"));
  }
  writeJson(join(demoResultsDir, "youtube-live-e2e-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    failedCases: [],
    generatedArtifact: { relativePath },
    outputProof: {
      outputMp4: { relativePath },
      ffprobe: {
        status: "passed",
        relativePath,
        durationSeconds: 142.5,
        width: 1080,
        height: 1920,
      },
    },
    checks: [{ name: "youtube_live_e2e_output_artifact_exists", passed: true }],
  });
}

function writePassingVisualGoalQA({
  root,
  demoResultsDir,
  timestamp,
  relativePath = "manual-downloads/proof.mp4",
  contactSheetPath = "demo/results/visual-goal-contact-sheet-proof.json",
  writeMp4 = true,
  writeContactSheet = true,
}) {
  if (writeMp4) {
    const filePath = join(root, relativePath);
    mkdirSync(join(root, "manual-downloads"), { recursive: true });
    writeFileSync(filePath, Buffer.from("mp4-proof"));
  }
  if (writeContactSheet) {
    writeJson(join(root, contactSheetPath), {
      generatedAt: timestamp,
      status: "passed",
      goals: [],
    });
  }
  writeJson(join(demoResultsDir, "visual-goal-qa-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    failedCases: [],
    outputMp4: { relativePath },
    contactSheetPath,
    checks: [
      { name: "output_mp4_exists", passed: true },
      { name: "all_goals_have_clear_frame_refs", passed: true },
    ],
  });
}

function writePassingReferenceStyleQA({
  root,
  demoResultsDir,
  timestamp,
  relativePath = "manual-downloads/proof.mp4",
  visualReportPath = "demo/results/visual-goal-qa-latest.json",
  contactSheetPath = "demo/results/visual-goal-contact-sheet-proof.json",
  writeMp4 = true,
  writeVisualReport = true,
  writeContactSheet = true,
}) {
  if (writeMp4) {
    const filePath = join(root, relativePath);
    mkdirSync(join(root, "manual-downloads"), { recursive: true });
    writeFileSync(filePath, Buffer.from("mp4-proof"));
  }
  if (writeVisualReport) {
    writeJson(join(root, visualReportPath), {
      timestamp,
      generatedAt: timestamp,
      status: "passed",
      passed: true,
      outputMp4: { relativePath },
      contactSheetPath,
      failedCases: [],
    });
  }
  if (writeContactSheet) {
    writeJson(join(root, contactSheetPath), {
      generatedAt: timestamp,
      status: "passed",
      goals: [],
    });
  }
  writeJson(join(demoResultsDir, "reference-style-qa-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    outputMp4: { relativePath },
    visualGoalQAReport: visualReportPath,
    contactSheetPath,
    checks: [{ name: "fresh_mp4", passed: true }],
    failedCases: [],
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
    "ocr-smoke",
    "ocr-qa-review",
    "browser-contract",
    "playwright-browser",
    "evaluation",
    "reference-review",
  ]);
  assert.equal(result.artifacts.exists, false);
});

test("CI report validator checks optional passing YouTube live proof MP4 exists", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingYouTubeLiveProof({ ...dirs, timestamp });

  const result = validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 });
  assert.equal(result.ok, true);
  assert.equal(result.reports.some((report) => report.label === "youtube-live-proof" && report.status === "passed"), true);
});

test("CI report validator checks optional visual goal QA MP4 and contact sheet exist", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingVisualGoalQA({ ...dirs, timestamp });

  const result = validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 });
  assert.equal(result.ok, true);
  assert.equal(result.reports.some((report) => report.label === "visual-goal-qa" && report.status === "passed"), true);
});

test("CI report validator checks optional reference style QA MP4, visual report and contact sheet exist", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingReferenceStyleQA({ ...dirs, timestamp });

  const result = validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 });
  assert.equal(result.ok, true);
  assert.equal(result.reports.some((report) => report.label === "reference-style-qa" && report.status === "passed"), true);
});

test("CI report validator rejects optional reference style QA when visual report is missing", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingReferenceStyleQA({ ...dirs, timestamp, writeVisualReport: false });

  assert.throws(
    () => validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 }),
    /Passing reference style QA visual report is missing/,
  );
});

test("CI report validator rejects optional visual goal QA when contact sheet is missing", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingVisualGoalQA({ ...dirs, timestamp, writeContactSheet: false });

  assert.throws(
    () => validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 }),
    /Passing visual goal QA contact sheet is missing/,
  );
});

test("CI report validator rejects optional passing YouTube live proof when MP4 is missing", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingYouTubeLiveProof({ ...dirs, timestamp, writeMp4: false });

  assert.throws(
    () => validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 }),
    /Passing YouTube live proof MP4 is missing/,
  );
});

test("CI report validator rejects unsafe optional YouTube live proof MP4 refs", () => {
  const dirs = createReportDirs();
  const nowMs = Date.parse("2026-06-15T18:00:00.000Z");
  const timestamp = new Date(nowMs).toISOString();
  writeValidReports({ ...dirs, timestamp });
  writePassingYouTubeLiveProof({
    ...dirs,
    timestamp,
    relativePath: "../manual-downloads/proof.mp4",
    writeMp4: false,
  });

  assert.throws(
    () => validateCiReports({ ...dirs, artifactRootDir: dirs.root, nowMs, maxAgeMs: 60_000 }),
    /unsafe relative reference|sensitive data/i,
  );
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
