import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_FIXTURE_PATH,
  ensureDemoFixture,
  fixtureMetadata,
} from "./create-fixture.mjs";
import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";

const require = createRequire(import.meta.url);
const { CONFIG } = require("../server/config.cjs");
const { runFfmpeg } = require("../server/render.cjs");
const { storagePath } = require("../server/storage.cjs");
const { extractSampledFrames, cleanupSampledFrames, publicFrameSummary } = require("../server/frame-extraction.cjs");
const { analyzeScoreboardOcr, defaultScoreboardRegions, publicScoreboardOcr } = require("../server/scoreboard-ocr.cjs");
const { ocrCommandAvailable } = require("../server/adapters/local-ocr-adapter.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const OCR_ARTIFACTS_RELATIVE_DIR = "demo/results/ocr-artifacts";
const OCR_LATEST_RELATIVE_PATH = "demo/results/ocr-latest.json";
const OCR_QA_ARTIFACT_MANIFEST_FILE = "ocr-qa-manifest.json";
const MAX_QA_ROWS = 24;
const MAX_QA_ARTIFACT_CROPS = 12;
const MAX_QA_ARTIFACT_BYTES = 2 * 1024 * 1024;
const DEFAULT_QA_ARTIFACT_RETENTION = 8;

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

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseRetentionMax(value = process.env.SHORTSENGINE_OCR_QA_ARTIFACT_RETENTION) {
  if (value === undefined || value === null || value === "") return DEFAULT_QA_ARTIFACT_RETENTION;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    const error = new Error("OCR QA artifact retention is invalid.");
    error.code = "OCR_QA_ARTIFACT_RETENTION_INVALID";
    throw error;
  }
  return parsed;
}

function normalizeRunId(value = randomUUID()) {
  const raw = String(value || "").trim();
  if (
    !raw ||
    raw.includes("..") ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("\u0000") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw)
  ) {
    const error = new Error("OCR QA artifact run id is unsafe.");
    error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
    throw error;
  }
  return raw.startsWith("ocr-") ? raw : `ocr-${raw}`;
}

function isInside(baseDir, candidatePath) {
  const base = resolve(baseDir);
  const target = resolve(candidatePath);
  const fromBase = relative(base, target);
  return fromBase === "" || (!fromBase.startsWith("..") && !isAbsolute(fromBase));
}

function safeResolveInside(baseDir, candidate, code = "OCR_QA_ARTIFACT_PATH_UNSAFE") {
  const target = resolve(baseDir, candidate || ".");
  if (!isInside(baseDir, target)) {
    const error = new Error("OCR QA artifact path is unsafe.");
    error.code = code;
    throw error;
  }
  return target;
}

function safeFilePart(value, fallback = "item") {
  const safe = String(value || fallback)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64);
  return safe || fallback;
}

function ocrArtifactsRoot(resultsDir = RESULTS_DIR) {
  return safeResolveInside(resolve(resultsDir), "ocr-artifacts");
}

function resolveOcrArtifactRunDir({ resultsDir = RESULTS_DIR, runId } = {}) {
  const root = ocrArtifactsRoot(resultsDir);
  const safeRunId = normalizeRunId(runId);
  return {
    root,
    runId: safeRunId,
    runDir: safeResolveInside(root, safeRunId),
  };
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
  const scoreTimeline = scoreboardPublic.summary && Array.isArray(scoreboardPublic.summary.scoreTimeline)
    ? scoreboardPublic.summary.scoreTimeline
    : [];
  const rows = scoreTimeline.some((item) => item.status === "score_changed") ? scoreTimeline : evidence;
  if (!rows.length) {
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
  return rows.slice(0, MAX_QA_ROWS).map((item, index) => ({
    index: index + 1,
    timestamp: Number(item.timestamp || 0),
    status: String(item.status || "unknown").slice(0, 40),
    scoreBefore: item.scoreBefore || null,
    scoreAfter: item.scoreAfter || null,
    clock: item.clock || null,
    confidence: Number(item.confidence || 0),
    temporalConsistency: Boolean(item.temporalConsistency),
    layoutId: item.layoutId || null,
    scoreOnlyCropRef: item.scoreOnlyCropRef || null,
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

function cropFileName({ cropIndex, frameIndex, region }) {
  const index = String(cropIndex + 1).padStart(2, "0");
  return `ocr-crop-${index}-frame-${frameIndex + 1}-${safeFilePart(region.id, "scoreboard")}.png`;
}

function validateOcrQaArtifactRecord(record = {}, { runId, mustExist = true } = {}) {
  const safeRun = normalizeRunId(runId);
  const prefix = `${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRun}/`;
  if (!record || typeof record !== "object" || Array.isArray(record) || findSensitiveLeak(record)) {
    const error = new Error("OCR QA artifact metadata is unsafe.");
    error.code = "OCR_QA_ARTIFACT_METADATA_UNSAFE";
    throw error;
  }
  const relativePath = String(record.relativePath || "");
  if (
    !relativePath.startsWith(prefix) ||
    relativePath.includes("..") ||
    relativePath.includes("\\") ||
    relativePath.includes("\u0000") ||
    !relativePath.endsWith(".png")
  ) {
    const error = new Error("OCR QA artifact ref is unsafe.");
    error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
    throw error;
  }
  const runDir = resolve(ROOT_DIR, prefix);
  const absolutePath = resolve(ROOT_DIR, relativePath);
  if (!isInside(runDir, absolutePath)) {
    const error = new Error("OCR QA artifact path is unsafe.");
    error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
    throw error;
  }
  let sizeBytes = Math.max(0, Math.round(Number(record.sizeBytes || 0)));
  if (mustExist) {
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      const error = new Error("OCR QA artifact is missing.");
      error.code = "OCR_QA_ARTIFACT_MISSING";
      throw error;
    }
    sizeBytes = statSync(absolutePath).size;
  }
  if (sizeBytes > MAX_QA_ARTIFACT_BYTES) {
    const error = new Error("OCR QA artifact is too large.");
    error.code = "OCR_QA_ARTIFACT_TOO_LARGE";
    throw error;
  }
  return {
    id: safeFilePart(record.id, "ocr_crop").slice(0, 80),
    frameId: safeFilePart(record.frameId, "frame").slice(0, 80),
    timestamp: Number(record.timestamp || 0),
    regionId: safeFilePart(record.regionId, "scoreboard_region").slice(0, 80),
    width: Math.max(1, Math.min(2048, Math.round(Number(record.width || 0)))),
    height: Math.max(1, Math.min(2048, Math.round(Number(record.height || 0)))),
    sizeBytes,
    relativePath,
  };
}

function buildOcrQaArtifactManifest({
  runId,
  directory,
  files = [],
  generatedAt = new Date().toISOString(),
  mustExist = true,
} = {}) {
  const safeRun = normalizeRunId(runId);
  const safeDirectory = `${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRun}`;
  if (directory && directory !== safeDirectory) {
    const error = new Error("OCR QA artifact directory is unsafe.");
    error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
    throw error;
  }
  const safeFiles = (Array.isArray(files) ? files : [])
    .slice(0, MAX_QA_ARTIFACT_CROPS)
    .map((file) => validateOcrQaArtifactRecord(file, { runId: safeRun, mustExist }));
  const manifest = {
    schemaVersion: 1,
    kind: "ocr-crop-qa-artifacts",
    runId: safeRun,
    generatedAt,
    directory: safeDirectory,
    cropCount: safeFiles.length,
    maxCropCount: MAX_QA_ARTIFACT_CROPS,
    maxArtifactBytes: MAX_QA_ARTIFACT_BYTES,
    files: safeFiles,
    relativeRefsOnly: true,
    fullFramesStored: false,
    ocrTextStored: false,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  if (findSensitiveLeak(manifest)) {
    const error = new Error("OCR QA artifact manifest is unsafe.");
    error.code = "OCR_QA_ARTIFACT_MANIFEST_UNSAFE";
    throw error;
  }
  return manifest;
}

function writeOcrQaArtifactManifest({ runDir, runId, directory, files, generatedAt } = {}) {
  const manifest = buildOcrQaArtifactManifest({ runId, directory, files, generatedAt, mustExist: true });
  const manifestPath = safeResolveInside(runDir, OCR_QA_ARTIFACT_MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const relativePath = safeRelative(manifestPath);
  if (relativePath !== `${manifest.directory}/${OCR_QA_ARTIFACT_MANIFEST_FILE}`) {
    const error = new Error("OCR QA artifact manifest ref is unsafe.");
    error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
    throw error;
  }
  return {
    ...manifest,
    relativePath,
  };
}

async function writeOcrQaArtifacts({
  enabled = false,
  runId,
  frames = [],
  metadata = {},
  resultsDir = RESULTS_DIR,
  ffmpegRunner,
  signal,
} = {}) {
  const safeRun = normalizeRunId(runId);
  const directory = `${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRun}`;
  if (!enabled) {
    return {
      enabled: false,
      runId: safeRun,
      directory,
      cropCount: 0,
      files: [],
      manifest: null,
      unavailableReason: null,
    };
  }
  const runner = ffmpegRunner;
  const safeFrames = Array.isArray(frames) ? frames.filter((frame) => frame && frame.localPath && existsSync(frame.localPath)) : [];
  if (!safeFrames.length || typeof runner !== "function") {
    return {
      enabled: true,
      runId: safeRun,
      directory,
      cropCount: 0,
      files: [],
      manifest: null,
      unavailableReason: !safeFrames.length ? "no_sampled_frames" : "ffmpeg_runner_unavailable",
    };
  }
  const { runDir } = resolveOcrArtifactRunDir({ resultsDir, runId: safeRun });
  mkdirSync(runDir, { recursive: true });
  const files = [];
  let cropIndex = 0;
  for (const [frameIndex, frame] of safeFrames.entries()) {
    if (cropIndex >= MAX_QA_ARTIFACT_CROPS) break;
    const regions = defaultScoreboardRegions(metadata, frame).slice(0, 3);
    for (const region of regions) {
      if (cropIndex >= MAX_QA_ARTIFACT_CROPS) break;
      const outputFile = cropFileName({ cropIndex, frameIndex, region });
      const outputPath = safeResolveInside(runDir, outputFile);
      await runner([
        "-y",
        "-i",
        frame.localPath,
        "-vf",
        `crop=${region.width}:${region.height}:${region.x}:${region.y}`,
        "-frames:v",
        "1",
        outputPath,
      ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 20000) });
      if (!existsSync(outputPath) || !statSync(outputPath).isFile()) {
        const error = new Error("OCR QA artifact crop was not created.");
        error.code = "OCR_QA_ARTIFACT_WRITE_FAILED";
        throw error;
      }
      const artifactStat = statSync(outputPath);
      if (artifactStat.size > MAX_QA_ARTIFACT_BYTES) {
        const error = new Error("OCR QA artifact crop is too large.");
        error.code = "OCR_QA_ARTIFACT_TOO_LARGE";
        throw error;
      }
      const relativePath = safeRelative(outputPath);
      if (!relativePath.startsWith(`${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRun}/`)) {
        const error = new Error("OCR QA artifact ref is unsafe.");
        error.code = "OCR_QA_ARTIFACT_PATH_UNSAFE";
        throw error;
      }
      files.push({
        id: `ocr_crop_${cropIndex + 1}`,
        frameId: String(frame.id || `frame_${frameIndex + 1}`).slice(0, 80),
        timestamp: Number(frame.timestamp || 0),
        regionId: String(region.id || "scoreboard_region").slice(0, 80),
        width: Number(region.width || 0),
        height: Number(region.height || 0),
        sizeBytes: artifactStat.size,
        relativePath,
      });
      cropIndex += 1;
    }
  }
  const manifest = files.length
    ? writeOcrQaArtifactManifest({
        runDir,
        runId: safeRun,
        directory,
        files,
        generatedAt: new Date().toISOString(),
      })
    : null;
  return {
    enabled: true,
    runId: safeRun,
    directory,
    cropCount: files.length,
    manifest: manifest
      ? {
          relativePath: manifest.relativePath,
          cropCount: manifest.cropCount,
          maxCropCount: manifest.maxCropCount,
          maxArtifactBytes: manifest.maxArtifactBytes,
        }
      : null,
    files,
    unavailableReason: files.length ? null : "no_scoreboard_crops",
  };
}

function cleanupOcrQaArtifacts({
  resultsDir = RESULTS_DIR,
  retentionMax = DEFAULT_QA_ARTIFACT_RETENTION,
  currentRunId,
} = {}) {
  const root = ocrArtifactsRoot(resultsDir);
  if (!existsSync(root)) {
    return { retentionMax, removedCount: 0, removed: [], preservedCount: 0 };
  }
  const safeCurrent = currentRunId ? normalizeRunId(currentRunId) : null;
  const managed = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ocr-[A-Za-z0-9._-]+$/.test(entry.name) && !entry.name.includes(".."))
    .map((entry) => {
      const dir = safeResolveInside(root, entry.name);
      return {
        name: entry.name,
        dir,
        mtimeMs: statSync(dir).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set();
  if (safeCurrent) keep.add(safeCurrent);
  for (const entry of managed) {
    if (keep.size >= retentionMax) break;
    keep.add(entry.name);
  }
  const removed = [];
  for (const entry of managed) {
    if (keep.has(entry.name)) continue;
    rmSync(entry.dir, { recursive: true, force: true });
    removed.push(`${OCR_ARTIFACTS_RELATIVE_DIR}/${entry.name}`);
  }
  return {
    retentionMax,
    removedCount: removed.length,
    removed,
    preservedCount: keep.size,
  };
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
  const runId = normalizeRunId(options.runId || randomUUID());
  const scoreboardConfig = options.scoreboardConfig || CONFIG.scoreboardOcr;
  const localRequested = Boolean(scoreboardConfig.enabled && scoreboardConfig.provider === "local");
  const qaArtifactsEnabled = Object.prototype.hasOwnProperty.call(options, "qaArtifactsEnabled")
    ? Boolean(options.qaArtifactsEnabled)
    : boolFromEnv(process.env.SHORTSENGINE_OCR_QA_ARTIFACTS);
  const qaArtifactRetentionMax = parseRetentionMax(options.qaArtifactRetentionMax);
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
  let qaArtifacts = {
    enabled: false,
    runId,
    directory: `${OCR_ARTIFACTS_RELATIVE_DIR}/${runId}`,
    cropCount: 0,
    files: [],
    manifest: null,
    unavailableReason: null,
  };
  let qaArtifactCleanup = { retentionMax: qaArtifactRetentionMax, removedCount: 0, removed: [], preservedCount: 0 };
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

    qaArtifacts = await writeOcrQaArtifacts({
      enabled: qaArtifactsEnabled,
      runId,
      frames: frameResult.frames,
      metadata,
      resultsDir: options.resultsDir || RESULTS_DIR,
      ffmpegRunner: options.qaArtifactFfmpegRunner || options.ffmpegRunner || runFfmpeg,
      signal: options.signal,
    });
    if (qaArtifactsEnabled) {
      qaArtifactCleanup = cleanupOcrQaArtifacts({
        resultsDir: options.resultsDir || RESULTS_DIR,
        retentionMax: qaArtifactRetentionMax,
        currentRunId: runId,
      });
    }

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
  if (runError && ((localRequested && runtimeAvailable) || qaArtifactsEnabled)) criticalFailures.push(runError);
  if (qaArtifactsEnabled && qaArtifacts.cropCount === 0) {
    criticalFailures.push({
      code: "OCR_QA_ARTIFACTS_UNAVAILABLE",
      nextAction: "Verify FFmpeg/frame extraction, then rerun npm run ocr:smoke with SHORTSENGINE_OCR_QA_ARTIFACTS=1.",
      reason: qaArtifacts.unavailableReason || "no_crops",
    });
  }
  const qaRows = buildOcrQaRows(scoreboardPublic);
  const report = {
    schemaVersion: 1,
    runId,
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
    providerMode: localRequested ? "local-scoreboard-ocr-command" : "deterministic-scoreboard-ocr",
    localOcrEnabled: localRequested,
    runtimeAvailable,
    fixture: safeFixtureSummary(fixture),
    frameExtraction: framePublic,
    frameCount: Number(framePublic.summary && framePublic.summary.frameCount || 0),
    scoreboardOcr: scoreboardPublic,
    evidenceSummary: scoreboardPublic.summary,
    cropCount: qaArtifacts.cropCount,
    qaArtifactDirectory: qaArtifacts.directory,
    qaArtifactManifest: qaArtifacts.manifest,
    cropArtifacts: qaArtifacts.files,
    qa: {
      rowCount: qaRows.length,
      rows: qaRows,
      cropArtifacts: {
        enabled: qaArtifacts.enabled,
        directory: qaArtifacts.directory,
        manifest: qaArtifacts.manifest,
        files: qaArtifacts.files,
        unavailableReason: qaArtifacts.unavailableReason,
      },
    },
    cleanup: {
      sampledFramesCleaned: Number(frameCleanup.cleanedCount || 0),
      tempArtifactsDeleted: true,
      qaArtifactsRetention: qaArtifactCleanup,
    },
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    checks: [],
    failedCases: criticalFailures,
    limitations: [
      "Default OCR smoke proves fallback safety without requiring Tesseract.",
      qaArtifactsEnabled
        ? "OCR QA crop thumbnails are local debug artifacts and are ignored by git."
        : "Crop thumbnails are disabled by default to avoid persisting local frame data.",
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
  OCR_QA_ARTIFACT_MANIFEST_FILE,
  RESULTS_DIR,
  buildOcrQaRows,
  buildOcrQaArtifactManifest,
  candidateWindowsForFixture,
  cleanupOcrQaArtifacts,
  normalizeRunId,
  parseRetentionMax,
  resolveOcrArtifactRunDir,
  runOcrSmoke,
  safeFixtureSummary,
  validateOcrQaArtifactRecord,
  writeOcrQaArtifacts,
  writeOcrQaArtifactManifest,
  writeOcrSmokeReport,
};
