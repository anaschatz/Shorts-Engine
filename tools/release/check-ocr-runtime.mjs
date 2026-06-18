import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const require = createRequire(import.meta.url);
const { CONFIG } = require("../../server/config.cjs");
const { commandAvailable } = require("../../server/media.cjs");
const { storageHealth } = require("../../server/storage.cjs");
const { frameExtractionHealth } = require("../../server/frame-extraction.cjs");
const { createScoreboardOcrProvider } = require("../../server/scoreboard-ocr.cjs");
const { ocrCommandAvailable } = require("../../server/adapters/local-ocr-adapter.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NEXT_ACTIONS = Object.freeze({
  deterministic:
    "Keep deterministic OCR fallback for CI/demo, or enable local OCR manually after installing a runtime.",
  enableLocal:
    "Set SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local and SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 only after the OCR runtime is installed.",
  installRuntime:
    "Install Tesseract manually, verify tesseract --version, then rerun npm run ocr:doctor.",
  verifySmoke:
    "Run npm run ocr:smoke to write a safe local proof report.",
});

function safeStorageSummary(health = {}) {
  const entries = Object.entries(health || {});
  return {
    ready: entries.every(([, item]) => item && item.exists && item.readable && item.writable),
    areasChecked: entries.length,
  };
}

function buildChecks({ localRequested, runtimeAvailable, ffmpegAvailable, ffprobeAvailable, storageReady }) {
  const checks = [
    {
      name: "ocr_default_fallback_available",
      passed: true,
      required: true,
      status: "ready",
    },
    {
      name: "ocr_runtime_not_required_by_default",
      passed: true,
      required: true,
      status: localRequested ? "operator-enabled" : "default-disabled",
    },
    {
      name: "ffmpeg_available_for_crop_qa",
      passed: true,
      required: false,
      status: ffmpegAvailable ? "available" : "fallback",
    },
    {
      name: "ffprobe_available_for_media_metadata",
      passed: true,
      required: false,
      status: ffprobeAvailable ? "available" : "fallback",
    },
    {
      name: "storage_ready_for_staging",
      passed: storageReady,
      required: true,
      status: storageReady ? "ready" : "failed",
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

function summarizeScoreboardConfig(scoreboardConfig = CONFIG.scoreboardOcr) {
  const provider = String(scoreboardConfig.provider || "deterministic").toLowerCase();
  const enabled = Boolean(scoreboardConfig.enabled);
  return {
    providerMode: provider === "local" && enabled ? "local-scoreboard-ocr-command" : "deterministic-scoreboard-ocr",
    localOcrEnabled: provider === "local" && enabled,
    deterministicFallbackAvailable: true,
    networkRequired: false,
    timeoutMs: Number(scoreboardConfig.timeoutMs || 0),
  };
}

function assertSafeReport(report) {
  const leak = findSensitiveLeak(report);
  if (leak) {
    const error = new Error("OCR doctor output contains sensitive data.");
    error.code = "OCR_OUTPUT_UNSAFE";
    error.details = { leakCode: leak.code, leakPath: leak.path };
    throw error;
  }
}

function checkOcrRuntime(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const scoreboardConfig = options.scoreboardConfig || CONFIG.scoreboardOcr;
  const commandChecker = options.ocrCommandChecker || ocrCommandAvailable;
  const toolChecker = options.toolCommandChecker || commandAvailable;
  const storageSummary = safeStorageSummary(
    typeof options.storageHealth === "function" ? options.storageHealth() : storageHealth(),
  );
  const frameHealth = typeof options.frameExtractionHealth === "function"
    ? options.frameExtractionHealth()
    : frameExtractionHealth();
  const configSummary = summarizeScoreboardConfig(scoreboardConfig);
  const localRequested = configSummary.localOcrEnabled;
  const runtimeAvailable = localRequested ? Boolean(commandChecker(scoreboardConfig.bin)) : false;
  const ffmpegAvailable = Boolean(
    Object.prototype.hasOwnProperty.call(frameHealth, "ffmpegAvailable")
      ? frameHealth.ffmpegAvailable
      : toolChecker(CONFIG.ffmpegBin),
  );
  const ffprobeAvailable = Boolean(toolChecker(CONFIG.ffprobeBin));
  const providerHealth = localRequested
    ? createScoreboardOcrProvider({
        mode: "local",
        enabled: true,
        commandChecker: () => runtimeAvailable,
      }).health()
    : createScoreboardOcrProvider({ mode: "deterministic", enabled: false }).health();

  const checks = buildChecks({
    localRequested,
    runtimeAvailable,
    ffmpegAvailable,
    ffprobeAvailable,
    storageReady: storageSummary.ready,
  });
  const failedRequired = checks.filter((check) => check.required && check.passed === false);
  const status = failedRequired.length ? "failed" : localRequested && runtimeAvailable ? "ready" : "degraded";
  const report = {
    schemaVersion: 1,
    timestamp: new Date(nowMs).toISOString(),
    command: "npm run ocr:doctor",
    phase: "ocr-runtime-readiness",
    status,
    passed: failedRequired.length === 0,
    skipped: false,
    code: failedRequired.length ? "OCR_RUNTIME_NOT_READY" : null,
    nextAction: failedRequired.length
      ? NEXT_ACTIONS.installRuntime
      : localRequested
        ? NEXT_ACTIONS.verifySmoke
        : NEXT_ACTIONS.deterministic,
    runtime: {
      providerMode: configSummary.providerMode,
      localOcrEnabled: configSummary.localOcrEnabled,
      runtimeChecked: localRequested,
      runtimeAvailable,
      commandConfigured: Boolean(scoreboardConfig.bin),
      fallbackAvailable: true,
      networkRequired: false,
      timeoutMs: configSummary.timeoutMs,
    },
    frameExtraction: {
      mode: "ffmpeg-frame-sampling",
      ffmpegAvailable,
      fallbackMode: "mock",
      maxFrames: Number(frameHealth.maxFrames || 0),
      maxDimension: Number(frameHealth.maxDimension || 0),
    },
    storage: storageSummary,
    providerHealth: {
      status: providerHealth.status,
      providerMode: providerHealth.providerMode,
      fallbackAvailable: Boolean(providerHealth.fallbackAvailable),
      realOcrEnabled: Boolean(providerHealth.realOcrEnabled),
      localOcrEnabled: Boolean(providerHealth.localOcrEnabled),
      runtimeAvailable: Boolean(providerHealth.runtimeAvailable),
      networkRequired: Boolean(providerHealth.networkRequired),
      maxFrames: Number(providerHealth.maxFrames || 0),
      maxRegions: Number(providerHealth.maxRegions || 0),
    },
    checks,
    failedCases: failedRequired.map((check) => ({
      code: check.name === "local_ocr_runtime_available" ? "OCR_RUNTIME_MISSING" : "OCR_READINESS_FAILED",
      check: check.name,
      nextAction: check.name === "local_ocr_runtime_available" ? NEXT_ACTIONS.installRuntime : NEXT_ACTIONS.verifySmoke,
    })),
    limitations: [
      "Local OCR remains opt-in and is never installed by ShortsEngine.",
      "The doctor checks readiness only; OCR quality is proven by smoke/eval reports.",
    ],
    root: ROOT_DIR ? "project-root" : "unknown",
  };
  assertSafeReport(report);
  return report;
}

function safeError(error) {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    command: "npm run ocr:doctor",
    phase: "ocr-runtime-readiness",
    status: "failed",
    passed: false,
    skipped: false,
    code: error && error.code ? error.code : "OCR_DOCTOR_FAILED",
    message: "OCR runtime readiness failed safely.",
    nextAction: NEXT_ACTIONS.deterministic,
    failedCases: [{
      code: error && error.code ? error.code : "OCR_DOCTOR_FAILED",
      nextAction: NEXT_ACTIONS.deterministic,
    }],
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = checkOcrRuntime();
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  NEXT_ACTIONS,
  checkOcrRuntime,
  safeError,
  safeStorageSummary,
};
