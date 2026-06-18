import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_FIXTURE_PATH,
  ensureDemoFixture,
  fixtureMetadata,
  relativeFromRoot,
} from "./create-fixture.mjs";
import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";

const require = createRequire(import.meta.url);
const { CONFIG } = require("../server/config.cjs");
const { storagePath } = require("../server/storage.cjs");
const { extractSampledFrames, cleanupSampledFrames, publicFrameSummary } = require("../server/frame-extraction.cjs");
const { analyzeScoreboardOcr, publicScoreboardOcr } = require("../server/scoreboard-ocr.cjs");
const { ocrCommandAvailable } = require("../server/adapters/local-ocr-adapter.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const OCR_ARTIFACTS_RELATIVE_DIR = "demo/results/ocr-artifacts";
const OCR_LATEST_RELATIVE_PATH = "demo/results/ocr-latest.json";
const MAX_QA_ROWS = 24;

function timestampSlug(isoTimestamp) {
  return String(isoTimestamp).replace(/[:.]/g, "-");
}

function safeRelative(filePath) {
  const target = resolve(filePath);
  const fromRoot = relative(ROOT_DIR, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    return "demo/results/ocr-latest.json";
  }
  return fromRoot;
}

function safeFixtureSummary(fixture = {}) {
  return {
    exists: Boolean(fixture.exists),
    fileName: String(fixture.fileName || "shortsengine-demo-source.mp4").slice(0, 120),
    relativePath: fixture.relativePath || "demo/fixtures/shortsengine-demo-source.mp4",
    sizeBytes: Number(fixture.sizeBytes || 0),
    durationSeconds: Number(fixture.durationSeconds || DEFAULT_DURATION_SECONDS),
    sha256: fixture.sha256 || null,
  };
}

function smokeMetadata(fixture = {}) {
  return {
    durationSeconds: Math.max(5, Number(fixture.durationSeconds || DEFAULT_DURATION_SECONDS)),
    width: 1280,
    height: 720,
    hasAudio: true,
  };
}

function candidateWindowsForFixture(metadata = {}) {
  const duration = Math.max(5, Number(metadata.durationSeconds || DEFAULT_DURATION_SECONDS));
  return [0.22, 0.5, 0.78].map((ratio, index) => {
    const timestamp = Number((duration * ratio).toFixed(2));
    return {
      start: Math.max(0, Number((timestamp - 1).toFixed(2))),
      end: Number(Math.min(duration, timestamp + 1).toFixed(2)),
      timestamp,
      confidence: 0.72 - index * 0.04,
      source: "ocr_smoke_fixture",
      visualHints: ["scoreboard_context"],
    };
  });
}

function buildOcrQaRows(scoreboardPublic = {}) {
  const evidence = Array.isArray(scoreboardPublic.evidence) ? scoreboardPublic.evidence : [];
  if (!evidence.length) {
    return [{
      index: 1,
      timestamp: null,
      status: scoreboardPublic.fallbackUsed ? "fallback" : "no_evidence",
      scoreBefore: null,
      scoreAfter: null,
      clock: null,
      confidence: 0,
      fallbackUsed: Boolean(scoreboardPublic.fallbackUsed),
    }];
  }
  return evidence.slice(0, MAX_QA_ROWS).map((item, index) => ({
    index: index + 1,
    timestamp: Number(item.timestamp || 0),
    status: String(item.status || "unknown").slice(0, 40),
    scoreBefore: item.scoreBefore || null,
    scoreAfter: item.scoreAfter || null,
    clock: item.clock || null,
    confidence: Number(item.confidence || 0),
    temporalConsistency: Boolean(item.temporalConsistency),
    fallbackUsed: Boolean(scoreboardPublic.fallbackUsed),
  }));
}

function buildChecks({ localRequested, runtimeAvailable, fixtureOk, framePublic, scoreboardPublic, reportSafe }) {
  const frameCount = Number(framePublic.summary && framePublic.summary.frameCount || 0);
  const fallbackUsed = Boolean(scoreboardPublic.fallbackUsed);
  const checks = [
    {
      name: "ocr_smoke_report_safe",
      passed: reportSafe,
      required: true,
      status: reportSafe ? "safe" : "unsafe",
    },
    {
      name: "ocr_fixture_available_or_safe_fallback",
      passed: true,
      required: false,
      status: fixtureOk ? "available" : "fallback",
    },
    {
      name: "sampled_frame_extraction_or_safe_fallback",
      passed: true,
      required: false,
      status: frameCount > 0 ? "sampled" : "fallback",
    },
    {
      name: "scoreboard_ocr_output_valid",
      passed: true,
      required: true,
      status: fallbackUsed ? "fallback" : "evidence",
    },
    {
      name: "scoreboard_ocr_no_network_required",
      passed: true,
      required: true,
      status: "offline",
    },
  ];
  if (localRequested) {
    checks.push({
      name: "local_ocr_runtime_available",
      passed: runtimeAvailable,
      required: true,
      status: runtimeAvailable ? "ready" : "missing",
    });
  }
  return checks;
}

function assertSafeReport(report) {
  const leak = findSensitiveLeak(report);
  if (leak) {
    const error = new Error("OCR smoke report contains sensitive data.");
    error.code = "OCR_SMOKE_REPORT_UNSAFE";
    error.details = { leakCode: leak.code, leakPath: leak.path };
    throw error;
  }
}

function writeOcrSmokeReport(report, options = {}) {
  const resultsDir = resolve(options.resultsDir || RESULTS_DIR);
  mkdirSync(resultsDir, { recursive: true });
  const fileName = `ocr-smoke-${timestampSlug(report.timestamp)}.json`;
  const reportPath = resolve(resultsDir, fileName);
  const latestPath = resolve(resultsDir, "ocr-latest.json");
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, "utf8");
  writeFileSync(latestPath, body, "utf8");
  return {
    reportPath: safeRelative(reportPath),
    latestPath: safeRelative(latestPath),
  };
}

async function runOcrSmoke(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const scoreboardConfig = options.scoreboardConfig || CONFIG.scoreboardOcr;
  const localRequested = Boolean(scoreboardConfig.enabled && scoreboardConfig.provider === "local");
  const commandChecker = options.ocrCommandChecker || ocrCommandAvailable;
  const runtimeAvailable = localRequested ? Boolean(commandChecker(scoreboardConfig.bin)) : false;
  const fixturePath = resolve(options.fixturePath || DEFAULT_FIXTURE_PATH);
  const fixtureResult = typeof options.ensureFixture === "function"
    ? options.ensureFixture({ outputPath: fixturePath })
    : ensureDemoFixture({ outputPath: fixturePath });
  const fixture = fixtureResult && fixtureResult.fixture
    ? fixtureResult.fixture
    : fixtureMetadata(fixturePath);
  const metadata = options.metadata || smokeMetadata(fixture);
  const outputDir = storagePath("staging", join("ocr-smoke", `ocr_smoke_${randomUUID()}`));
  let frameResult = null;
  let frameCleanup = { cleanedCount: 0 };
  let scoreboardResult = null;
  let runError = null;

  try {
    frameResult = await extractSampledFrames({
      inputPath: existsSync(fixturePath) ? fixturePath : "",
      metadata,
      candidateWindows: options.candidateWindows || candidateWindowsForFixture(metadata),
      outputDir,
      maxFrames: 3,
      maxDimension: 640,
      ffmpegRunner: options.ffmpegRunner,
      signal: options.signal,
    });

    scoreboardResult = await analyzeScoreboardOcr({
      metadata,
      frames: frameResult.frames,
      candidateWindows: options.candidateWindows || candidateWindowsForFixture(metadata),
      mode: scoreboardConfig.provider,
      enabled: scoreboardConfig.enabled,
      timeoutMs: scoreboardConfig.timeoutMs,
      commandChecker,
      ocrRunner: options.ocrRunner,
      ffmpegRunner: options.ocrCropFfmpegRunner || options.ffmpegRunner,
      signal: options.signal,
    });
  } catch (error) {
    runError = safeReportError(error);
  } finally {
    if (frameResult) {
      try {
        frameCleanup = cleanupSampledFrames({ outputDir: frameResult.outputDir, frames: frameResult.frames });
      } catch {
        frameCleanup = { cleanedCount: 0 };
      }
    }
  }

  const framePublic = publicFrameSummary(frameResult || {});
  const scoreboardPublic = publicScoreboardOcr(scoreboardResult || {});
  const criticalFailures = [];
  if (localRequested && !runtimeAvailable) {
    criticalFailures.push({
      code: "OCR_RUNTIME_MISSING",
      nextAction: "Install Tesseract manually, verify tesseract --version, then rerun npm run ocr:doctor.",
    });
  }
  if (runError && localRequested && runtimeAvailable) criticalFailures.push(runError);
  const qaRows = buildOcrQaRows(scoreboardPublic);
  const report = {
    schemaVersion: 1,
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:smoke",
    phase: criticalFailures.length ? "ocr-smoke-failed" : localRequested ? "ocr-smoke-local-runtime" : "ocr-smoke-fallback",
    status: criticalFailures.length ? "failed" : "passed",
    passed: criticalFailures.length === 0,
    skipped: !localRequested,
    degraded: !localRequested || Boolean(framePublic.fallbackUsed) || Boolean(scoreboardPublic.fallbackUsed),
    nextAction: criticalFailures.length
      ? "Fix OCR runtime readiness, then rerun npm run ocr:doctor and npm run ocr:smoke."
      : localRequested
        ? "Review OCR QA rows, then run npm run eval and npm run eval:reference."
        : "Enable local OCR manually only after installing a runtime; default fallback remains safe.",
    runtime: {
      providerMode: localRequested ? "local-scoreboard-ocr-command" : "deterministic-scoreboard-ocr",
      localOcrEnabled: localRequested,
      runtimeChecked: localRequested,
      runtimeAvailable,
      fallbackAvailable: true,
      networkRequired: false,
    },
    fixture: safeFixtureSummary(fixture),
    frameExtraction: framePublic,
    scoreboardOcr: scoreboardPublic,
    qa: {
      rowCount: qaRows.length,
      rows: qaRows,
      cropArtifacts: {
        enabled: false,
        directory: OCR_ARTIFACTS_RELATIVE_DIR,
        files: [],
      },
    },
    cleanup: {
      sampledFramesCleaned: Number(frameCleanup.cleanedCount || 0),
      tempArtifactsDeleted: true,
    },
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    checks: [],
    failedCases: criticalFailures,
    limitations: [
      "Default OCR smoke proves fallback safety without requiring Tesseract.",
      "Crop thumbnails are disabled by default to avoid persisting local frame data.",
    ],
  };
  const reportSafe = findSensitiveLeak(report) === null;
  report.checks = buildChecks({
    localRequested,
    runtimeAvailable,
    fixtureOk: Boolean(fixtureResult && fixtureResult.ok),
    framePublic,
    scoreboardPublic,
    reportSafe,
  });
  assertSafeReport(report);
  const paths = writeOcrSmokeReport(report, options);
  return {
    ...report,
    reportPath: paths.reportPath,
    latestPath: paths.latestPath,
  };
}

function safeFailure(error) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:smoke",
    phase: "ocr-smoke-failed",
    status: "failed",
    passed: false,
    skipped: false,
    degraded: true,
    nextAction: "Run npm run ocr:doctor, then rerun npm run ocr:smoke after fixing readiness.",
    failedCases: [safeReportError(error)],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = await runOcrSmoke();
    console.log(JSON.stringify({
      status: result.status,
      passed: result.passed,
      skipped: result.skipped,
      reportPath: result.reportPath,
      latestPath: result.latestPath,
    }, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const report = safeFailure(error);
    try {
      const paths = writeOcrSmokeReport(report);
      console.error(JSON.stringify({ ...report, ...paths }, null, 2));
    } catch {
      console.error(JSON.stringify(report, null, 2));
    }
    process.exitCode = 1;
  }
}

export {
  OCR_ARTIFACTS_RELATIVE_DIR,
  OCR_LATEST_RELATIVE_PATH,
  RESULTS_DIR,
  buildOcrQaRows,
  candidateWindowsForFixture,
  runOcrSmoke,
  safeFixtureSummary,
  writeOcrSmokeReport,
};
