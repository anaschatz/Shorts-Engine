import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";
import {
  RESULTS_DIR,
  runYouTubeSmoke,
  safeDownloadArtifactRef,
  validateSmokeSource,
} from "./run-youtube-smoke.mjs";
import { probeVideo } from "./run-side-by-side-review.mjs";
import { checkEnvironment } from "../tools/release/check-environment.mjs";
import { checkYouTubeIngest } from "../tools/release/check-youtube-ingest.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E";
const LIVE_RIGHTS_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED";
const LIVE_URL_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_URL";
const DEFAULT_COMMAND_NAME = "youtube:proof";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SERVER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SERVER_READY_POLL_INTERVAL_MS = 250;
const MANUAL_DOWNLOADS_DIR = "manual-downloads";
const LIVE_PROOF_SCHEMA_VERSION = 2;
const KNOWN_EXPECTED_COUNTED_GOALS = Object.freeze({
  gxiRyFZXJV8: 3,
});
const NEXT_ACTIONS = Object.freeze({
  ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED: "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1",
  ENV_YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED-1-after-rights-review",
  ENV_YOUTUBE_LIVE_E2E_URL_MISSING: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_URL-to-an-authorized-video",
  ENV_YOUTUBE_LIVE_E2E_URL_INVALID: "use-a-supported-authorized-youtube-watch-shorts-or-shortlink-url",
  ENV_YOUTUBE_LIVE_E2E_URL_NOT_ALLOWED: "set-SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS-or-SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED-1",
  YOUTUBE_LIVE_E2E_DISABLED: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E-1-for-manual-local-proof",
  YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED-1-after-rights-review",
  YOUTUBE_LIVE_E2E_INGEST_DISABLED: "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1",
  YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED: "run-outside-restricted-sandbox-or-use-an-available-local-port",
  YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT: "check-local-server-startup-health-and-rerun-youtube-proof",
  YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT_INVALID: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT_MS-within-safe-bounds",
  YOUTUBE_LIVE_E2E_DOCTOR_FAILED: "run-npm-run-youtube-doctor-and-fix-failed-checks",
  YOUTUBE_LIVE_E2E_SMOKE_FAILED: "inspect-demo-results-youtube-live-e2e-latest-json",
  YOUTUBE_LIVE_E2E_REPORT_LEAK: "remove-sensitive-output-from-live-e2e-report",
  YOUTUBE_LIVE_E2E_TIMEOUT: "check-local-server-and-downloader-before-rerun-or-increase-timeout-only-if-expected",
  YOUTUBE_LIVE_E2E_OUTPUT_NOT_READY: "check-generated-mp4-path-and-ffprobe-before-comparison",
  YOUTUBE_LIVE_E2E_CLEANUP_DIR_UNSAFE: "keep-live-proof-cleanup-inside-manual-downloads",
  NO_VALID_GOALS_FOUND: "inspect-valid-goal-selection-evidence-before-rerun",
  YOUTUBE_SMOKE_URL_MISSING: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_URL-or-SHORTSENGINE_YOUTUBE_SMOKE_URL",
  YOUTUBE_SMOKE_URL_NOT_ALLOWED: "set-SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS-or-SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED-1",
});

const PHASES = Object.freeze({
  ENV: "env",
  DOCTOR: "doctor",
  SERVER_BIND: "server-bind",
  VALIDATION: "validation",
  INGEST: "ingest",
  PROBE: "probe",
  RENDER: "render",
  DOWNLOAD: "download",
  BROWSER: "browser",
  REPORT: "report",
  SERVER_READY: "server-ready",
  SKIPPED: "skipped",
  COMPLETED: "completed",
});

class YouTubeLiveE2EError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "YouTubeLiveE2EError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new YouTubeLiveE2EError(code, "YouTube live E2E numeric configuration is out of bounds.");
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeString(value, maxLength = 80) {
  return String(value || "")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/token|secret|api[_-]?key/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function safeScoreboardOcrEvent(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    providerMode: safeString(value.providerMode, 80),
    fallbackUsed: safeBoolean(value.fallbackUsed),
    sampledFrameCount: safeNumber(value.sampledFrameCount),
    evidenceCount: safeNumber(value.evidenceCount),
    scoreChangeCount: safeNumber(value.scoreChangeCount),
    ambiguousCount: safeNumber(value.ambiguousCount),
  };
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function addStep(steps, step, status, details = {}) {
  steps.push({ step, status, ...details });
}

function nextActionForCode(code) {
  return NEXT_ACTIONS[code] || "inspect-youtube-live-e2e-configuration";
}

function phaseForCode(code) {
  const text = String(code || "");
  if (text.startsWith("ENV_") || [
    "YOUTUBE_LIVE_E2E_DISABLED",
    "YOUTUBE_LIVE_E2E_INGEST_DISABLED",
    "YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED",
    "YOUTUBE_LIVE_E2E_PORT_INVALID",
    "YOUTUBE_LIVE_E2E_TIMEOUT_INVALID",
    "YOUTUBE_SMOKE_URL_MISSING",
    "YOUTUBE_SMOKE_URL_NOT_ALLOWED",
    "YOUTUBE_PLAYLIST_UNSUPPORTED",
    "YOUTUBE_LIVE_UNSUPPORTED",
    "YOUTUBE_URL_INVALID",
  ].includes(text)) {
    return PHASES.ENV;
  }
  if (
    text.startsWith("YOUTUBE_DOCTOR") ||
    ["YOUTUBE_DOWNLOADER_MISSING", "FFMPEG_MISSING", "FFPROBE_MISSING", "YOUTUBE_STAGING_STORAGE_UNAVAILABLE"].includes(text)
  ) {
    return PHASES.DOCTOR;
  }
  if (text.includes("SERVER_READY")) return PHASES.SERVER_READY;
  if (text.includes("SERVER_BIND")) return PHASES.SERVER_BIND;
  if (text.includes("VALIDATE") || text.includes("VALIDATION")) return PHASES.VALIDATION;
  if (text.includes("INGEST") || text.includes("ARTIFACT") || text.includes("SOURCE_RESPONSE")) return PHASES.INGEST;
  if (text.startsWith("FILE_") || text.startsWith("VIDEO_") || text.includes("DURATION")) return PHASES.PROBE;
  if (text.includes("JOB") || text.includes("GENERATE") || text.includes("EXPORT_MISSING") || text === "NO_VALID_GOALS_FOUND") return PHASES.RENDER;
  if (text.includes("DOWNLOAD") || text.includes("MP4") || text.includes("OUTPUT")) return PHASES.DOWNLOAD;
  if (text.includes("BROWSER") || text.includes("PLAYWRIGHT")) return PHASES.BROWSER;
  if (text.includes("REPORT_LEAK")) return PHASES.REPORT;
  return "proof";
}

function safeFailure(error) {
  const safe = safeReportError(error) || { code: "YOUTUBE_LIVE_E2E_FAILED", message: "YouTube live E2E failed." };
  const code = error && error.code ? error.code : safe.code;
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    code,
    message: safe.message,
    nextAction: details.nextAction || nextActionForCode(code),
    phase: details.phase || phaseForCode(code),
    port: Number.isFinite(Number(details.port)) ? Number(details.port) : null,
    timeoutMs: Number.isFinite(Number(details.timeoutMs)) ? Number(details.timeoutMs) : null,
    attempts: Number.isFinite(Number(details.attempts)) ? Number(details.attempts) : null,
    waitedMs: Number.isFinite(Number(details.waitedMs)) ? Number(details.waitedMs) : null,
    httpStatus: Number.isFinite(Number(details.httpStatus)) ? Number(details.httpStatus) : null,
    causeCode: details.causeCode ? safeString(details.causeCode, 60) : null,
  };
}

function sanitizeServerEvents(events = []) {
  return events.slice(-40).map((event) => ({
    stream: event.stream || null,
    level: event.level || null,
    event: event.event || null,
    code: event.code || null,
    service: event.service || null,
    goalDiscovery: event.goalDiscovery || null,
    scoreboardOcr: safeScoreboardOcrEvent(event.scoreboardOcr),
  }));
}

function relativeFromRoot(fileName) {
  return relative(ROOT_DIR, fileName).replace(/\\/g, "/");
}

function isManagedLiveProofMp4(fileName) {
  const name = String(fileName || "");
  if (extname(name).toLowerCase() !== ".mp4") return false;
  if (name === "shortsengine-youtube-short.mp4" || name.includes("reference")) return false;
  return (
    /^shortsengine-youtube-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T[A-Za-z0-9_-]+\.mp4$/.test(name) ||
    /^shortsengine-youtube-[A-Za-z0-9_-]+-test-[A-Za-z0-9_-]+\.mp4$/.test(name) ||
    /^shortsengine-manual-approved-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T[A-Za-z0-9_-]+\.mp4$/.test(name)
  );
}

function cleanupGeneratedProofArtifacts(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const manualDir = resolve(rootDir, options.manualDir || MANUAL_DOWNLOADS_DIR);
  const manualRel = relative(rootDir, manualDir).replace(/\\/g, "/");
  if (manualRel !== MANUAL_DOWNLOADS_DIR || manualRel.startsWith("../") || manualRel === "..") {
    throw new YouTubeLiveE2EError(
      "YOUTUBE_LIVE_E2E_CLEANUP_DIR_UNSAFE",
      "Live YouTube proof cleanup directory is unsafe.",
      { phase: PHASES.REPORT },
    );
  }
  mkdirSync(manualDir, { recursive: true });
  const summary = {
    directory: MANUAL_DOWNLOADS_DIR,
    attempted: true,
    deletedCount: 0,
    deleted: [],
    skippedCount: 0,
    errors: [],
    destructiveOutsideManualDownloads: false,
  };
  for (const entry of readdirSync(manualDir)) {
    const filePath = resolve(manualDir, entry);
    const rel = relative(rootDir, filePath).replace(/\\/g, "/");
    let stats = null;
    try {
      stats = statSync(filePath);
    } catch {
      summary.skippedCount += 1;
      continue;
    }
    if (!stats.isFile() || !isManagedLiveProofMp4(entry)) {
      summary.skippedCount += 1;
      continue;
    }
    try {
      unlinkSync(filePath);
      summary.deletedCount += 1;
      summary.deleted.push(rel);
    } catch {
      summary.errors.push({ relativePath: rel, code: "DELETE_FAILED" });
    }
  }
  return summary;
}

function atomicWriteJson(fileName, payload) {
  mkdirSync(dirname(fileName), { recursive: true });
  const tempName = `${fileName}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempName, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempName, fileName);
}

function safeDoctorSummary(result) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: Boolean(result.ok),
    status: result.status || null,
    code: result.code || null,
    youtubeIngest: result.youtubeIngest
      ? {
          enabled: Boolean(result.youtubeIngest.enabled),
          mode: result.youtubeIngest.mode || null,
          downloaderConfigured: Boolean(result.youtubeIngest.downloaderConfigured),
          ingestAvailable: Boolean(result.youtubeIngest.ingestAvailable),
          defaultDisabled: Boolean(result.youtubeIngest.defaultDisabled),
        }
      : null,
    ffmpeg: result.ffmpeg
      ? {
          ffmpeg: Boolean(result.ffmpeg.ffmpeg),
          ffprobe: Boolean(result.ffmpeg.ffprobe),
        }
      : null,
    storage: result.storage
      ? {
          stagingReady: Boolean(result.storage.stagingReady),
          tmpReady: Boolean(result.storage.tmpReady),
          artifactsReady: Boolean(result.storage.artifactsReady),
        }
      : null,
    serverHealth: result.serverHealth
      ? {
          checked: Boolean(result.serverHealth.checked),
          status: result.serverHealth.status || null,
          code: result.serverHealth.code || null,
        }
      : null,
  };
}

function safeSmokeSummary(report) {
  if (!report || typeof report !== "object") return null;
  return {
    status: report.status || null,
    source: report.source || null,
    target: report.target || null,
    checks: Array.isArray(report.checks) ? report.checks : [],
    steps: Array.isArray(report.steps) ? report.steps : [],
    ids: report.ids || {},
    health: report.health || null,
    jobLifecycle: Array.isArray(report.jobLifecycle) ? report.jobLifecycle : [],
    renderPlan: report.renderPlan || null,
    export: report.export || null,
    generatedArtifact: report.generatedArtifact || null,
    failedCases: Array.isArray(report.failedCases) ? report.failedCases : [],
  };
}

function safePhaseCoverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    hasBuildup: Boolean(value.hasBuildup),
    hasShot: Boolean(value.hasShot),
    hasFinish: Boolean(value.hasFinish),
    hasConfirmation: Boolean(value.hasConfirmation),
  };
}

function safeSegmentWindow(segment = {}, index = 0) {
  return {
    index: Number.isFinite(Number(segment.index)) ? Number(segment.index) : index + 1,
    sourceStart: safeNumber(segment.sourceStart),
    shotStart: safeNumber(segment.shotStart),
    finishTime: safeNumber(segment.finishTime),
    confirmationTime: safeNumber(segment.confirmationTime),
    sourceEnd: safeNumber(segment.sourceEnd),
    goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Number(segment.goalNumber) : null,
    replayOnly: Boolean(segment.replayOnly),
    replayUsed: typeof segment.replayUsed === "boolean" ? segment.replayUsed : null,
    phaseCoverage: safePhaseCoverage(segment.phaseCoverage),
  };
}

function expectedCountedGoalsForSource(source, env) {
  const configured = Number(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS"));
  if (Number.isInteger(configured) && configured >= 0 && configured <= 20) return configured;
  const videoId = String(source?.videoId || "");
  return Object.prototype.hasOwnProperty.call(KNOWN_EXPECTED_COUNTED_GOALS, videoId)
    ? KNOWN_EXPECTED_COUNTED_GOALS[videoId]
    : null;
}

function countedGoalCoverageFromSmoke(smoke, source, env) {
  const renderPlan = smoke?.renderPlan && typeof smoke.renderPlan === "object" ? smoke.renderPlan : {};
  const proof = renderPlan.countedGoalProof && typeof renderPlan.countedGoalProof === "object"
    ? renderPlan.countedGoalProof
    : {};
  const segments = Array.isArray(renderPlan.segments) ? renderPlan.segments.map(safeSegmentWindow) : [];
  const selectedValidGoals = Array.isArray(proof.selectedValidGoals) ? proof.selectedValidGoals : [];
  const summary = proof.summary && typeof proof.summary === "object" ? proof.summary : {};
  const confirmedGoalCount = Number(summary.confirmedGoalCount);
  const countedGoalsFound = Number.isFinite(confirmedGoalCount)
    ? confirmedGoalCount
    : selectedValidGoals.length;
  const countedGoalsIncluded = segments.filter((segment) => segment.replayOnly !== true).length || Number(proof.finalSegmentCount || 0);
  const replayOnlySegments = segments.filter((segment) => segment.replayOnly === true).length;
  const expectedCountedGoals = expectedCountedGoalsForSource(source, env);
  return {
    countedGoalsFound,
    countedGoalsIncluded,
    expectedCountedGoals,
    replayOnlySegments,
    allExpectedCountedGoalsIncluded: expectedCountedGoals === null ? null : countedGoalsIncluded === expectedCountedGoals,
    segmentWindows: segments,
  };
}

function probeGeneratedMp4(artifact) {
  if (!artifact || typeof artifact !== "object" || !artifact.relativePath) {
    return {
      checked: false,
      status: "skipped",
      code: "OUTPUT_MP4_NOT_REPORTED",
    };
  }
  let target;
  try {
    target = safeDownloadArtifactRef(artifact.relativePath);
  } catch {
    return {
      checked: true,
      status: "failed",
      code: "OUTPUT_MP4_REF_UNSAFE",
      relativePath: null,
    };
  }
  if (!existsSync(target.resolvedFile)) {
    return {
      checked: true,
      status: "missing",
      code: "OUTPUT_MP4_MISSING",
      relativePath: target.relativePath,
    };
  }
  const probed = probeVideo({ ok: true, resolvedFile: target.resolvedFile, relativePath: target.relativePath });
  return {
    checked: true,
    status: probed.readable ? "passed" : "failed",
    code: probed.errorCode || null,
    relativePath: target.relativePath,
    sizeBytes: probed.sizeBytes || artifact.sizeBytes || null,
    durationSeconds: probed.durationSeconds,
    width: probed.width,
    height: probed.height,
    videoCodec: probed.videoCodec,
    audioPresent: probed.audioPresent,
  };
}

function buildComparisonReadiness({ source, outputMp4, ffprobe, coverage, reference }) {
  return {
    ready: Boolean(outputMp4?.relativePath && ffprobe?.status === "passed"),
    reference: reference
      ? { configured: true, type: reference.startsWith("http") ? "url" : "relative_path" }
      : { configured: false },
    generated: outputMp4?.relativePath ? { relativePath: outputMp4.relativePath } : null,
    source: source ? { sourceType: "youtube", videoId: source.videoId } : null,
    checklist: {
      countedGoals: coverage.expectedCountedGoals === null
        ? null
        : coverage.countedGoalsIncluded === coverage.expectedCountedGoals,
      livePhaseVsReplayOnly: coverage.replayOnlySegments === 0,
      noOffsideNoGoal: null,
      noHymnIntroFiller: null,
      cutSmoothness: null,
      duration: ffprobe?.durationSeconds || null,
    },
  };
}

function buildOutputProof({ env, smoke, source, staleArtifactCleanup }) {
  const generatedArtifact = smoke?.generatedArtifact || null;
  const ffprobe = probeGeneratedMp4(generatedArtifact);
  const coverage = countedGoalCoverageFromSmoke(smoke, source, env);
  const outputMp4 = generatedArtifact?.relativePath
    ? {
        relativePath: generatedArtifact.relativePath,
        sizeBytes: generatedArtifact.sizeBytes || ffprobe.sizeBytes || null,
        contentType: generatedArtifact.contentType || null,
        sha256Prefix: generatedArtifact.sha256Prefix || null,
        downloadVerified: Boolean(generatedArtifact.downloadVerified),
      }
    : null;
  const reference = String(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_REFERENCE") || "").trim();
  return {
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    outputMp4,
    ffprobe,
    countedGoalsFound: coverage.countedGoalsFound,
    countedGoalsIncluded: coverage.countedGoalsIncluded,
    expectedCountedGoals: coverage.expectedCountedGoals,
    replayOnlySegments: coverage.replayOnlySegments,
    segmentWindows: coverage.segmentWindows,
    staleArtifactCleanup,
    comparison: buildComparisonReadiness({ source, outputMp4, ffprobe, coverage, reference }),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function latestGoalDiscoveryEvent(serverEvents = []) {
  if (!Array.isArray(serverEvents)) return null;
  return [...serverEvents].reverse().find((event) => event && event.goalDiscovery) || null;
}

function buildFailedOutputProof({ env, source, serverEvents, staleArtifactCleanup }) {
  const event = latestGoalDiscoveryEvent(serverEvents);
  const discovery = event?.goalDiscovery || null;
  const countedGoalsFound = Number.isFinite(Number(discovery?.selectedValidGoalCount))
    ? Number(discovery.selectedValidGoalCount)
    : 0;
  const expectedCountedGoals = expectedCountedGoalsForSource(source, env);
  const coverage = {
    countedGoalsFound,
    countedGoalsIncluded: 0,
    expectedCountedGoals,
    replayOnlySegments: 0,
  };
  return {
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    outputMp4: null,
    ffprobe: {
      checked: false,
      status: "skipped",
      code: "OUTPUT_MP4_NOT_CREATED",
    },
    countedGoalsFound,
    countedGoalsIncluded: 0,
    expectedCountedGoals,
    replayOnlySegments: 0,
    segmentWindows: [],
    goalDiscovery: discovery,
    staleArtifactCleanup,
    comparison: buildComparisonReadiness({ source, outputMp4: null, ffprobe: null, coverage, reference: null }),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function safePreflightSummary(summary) {
  const youtube = summary?.youtubeIngest || {};
  const live = youtube.liveE2E || {};
  return {
    ok: Boolean(summary?.ok),
    ingestEnabled: Boolean(youtube.enabled),
    rightsConfirmed: Boolean(live.rightsConfirmed),
    sourceConfigured: Boolean(live.sourceConfigured),
    allowlistConfigured: Boolean(live.allowlistedSourceConfigured),
    manualUnlistedGate: Boolean(live.allowUnlisted),
    portConfigured: Boolean(live.portConfigured),
    timeoutMs: Number.isFinite(Number(live.timeoutMs)) ? Number(live.timeoutMs) : null,
  };
}

function safeDoctorTriage(result) {
  if (!result || typeof result !== "object") {
    return {
      checked: false,
      downloaderConfigured: false,
      ffmpegReady: false,
      ffprobeReady: false,
      storageReady: false,
    };
  }
  return {
    checked: true,
    status: result.status || null,
    code: result.code || null,
    downloaderConfigured: Boolean(result.youtubeIngest?.downloaderConfigured),
    ffmpegReady: Boolean(result.ffmpeg?.ffmpeg),
    ffprobeReady: Boolean(result.ffmpeg?.ffprobe),
    storageReady: Boolean(result.storage?.stagingReady && result.storage?.tmpReady && result.storage?.artifactsReady),
    ingestAvailable: Boolean(result.youtubeIngest?.ingestAvailable),
  };
}

function reportNextAction({ checks, failedCases, status }) {
  const failure = failedCases[0] || null;
  if (failure?.nextAction) return failure.nextAction;
  if (status === "skipped") return checks.find((check) => check.nextAction)?.nextAction || null;
  return null;
}

function buildTriage({ checks, doctor, envSummary, failedCases, status }) {
  const failure = failedCases[0] || null;
  return {
    status,
    failedPhase: failure?.phase || null,
    nextAction: reportNextAction({ checks, failedCases, status }),
    preflight: safePreflightSummary(envSummary),
    doctor: safeDoctorTriage(doctor),
  };
}

function safeReport(report) {
  const leak = findSensitiveLeak(report);
  if (!leak) return report;
  return {
    timestamp: report.timestamp || nowIso(),
    command: report.command || DEFAULT_COMMAND_NAME,
    status: "failed",
    passed: false,
    skipped: false,
    mode: "youtube-live-local-e2e",
    phase: PHASES.REPORT,
    nextAction: nextActionForCode("YOUTUBE_LIVE_E2E_REPORT_LEAK"),
    durationMs: report.durationMs || 0,
    source: report.source || null,
    checks: [{
      name: "youtube_live_e2e_report_no_sensitive_leaks",
      passed: false,
      code: "YOUTUBE_LIVE_E2E_REPORT_LEAK",
      leakCode: leak.code,
      leakPath: leak.path,
    }],
    steps: [],
    doctor: null,
    smoke: null,
    generatedArtifact: null,
    serverEvents: [],
    failedCases: [{
      name: "youtube_live_e2e_report_no_sensitive_leaks",
      code: "YOUTUBE_LIVE_E2E_REPORT_LEAK",
      leakCode: leak.code,
      leakPath: leak.path,
      phase: PHASES.REPORT,
      nextAction: nextActionForCode("YOUTUBE_LIVE_E2E_REPORT_LEAK"),
    }],
  };
}

function buildReport({
  checks,
  commandName,
  doctor,
  durationMs,
  env,
  failedCases,
  envSummary,
  outputProof,
  serverEvents,
  smoke,
  source,
  status,
  staleArtifactCleanup,
  steps,
}) {
  const failure = failedCases[0] || null;
  const phase = failure?.phase || (status === "skipped" ? PHASES.SKIPPED : status === "passed" ? PHASES.COMPLETED : null);
  const nextAction = reportNextAction({ checks, failedCases, status });
  const normalizedOutputProof = outputProof || (status === "failed"
    ? buildFailedOutputProof({ env: env || {}, source, serverEvents, staleArtifactCleanup })
    : null);
  return safeReport({
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    timestamp: nowIso(),
    generatedAt: nowIso(),
    command: commandName || DEFAULT_COMMAND_NAME,
    status,
    passed: status === "passed",
    skipped: status === "skipped",
    mode: "youtube-live-local-e2e",
    phase,
    nextAction,
    durationMs,
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    checks,
    steps,
    triage: buildTriage({ checks, doctor, envSummary, failedCases, status }),
    doctor: safeDoctorSummary(doctor),
    smoke: safeSmokeSummary(smoke),
    generatedArtifact: smoke?.generatedArtifact || null,
    outputProof: normalizedOutputProof,
    staleArtifactCleanup: staleArtifactCleanup || null,
    serverEvents: sanitizeServerEvents(serverEvents),
    failedCases,
  });
}

function liveSourceEnv(env) {
  return {
    ...env,
    SHORTSENGINE_YOUTUBE_SMOKE: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_URL: String(
      rawValue(env, LIVE_URL_FLAG) || rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_URL") || "",
    ).trim(),
  };
}

function validateLiveConfig(env) {
  if (!boolFromEnv(rawValue(env, LIVE_FLAG))) {
    return { skipped: true };
  }
  if (!boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED"))) {
    throw new YouTubeLiveE2EError(
      "YOUTUBE_LIVE_E2E_INGEST_DISABLED",
      "Live YouTube E2E requires explicit ingest enablement.",
    );
  }
  if (!boolFromEnv(rawValue(env, LIVE_RIGHTS_FLAG))) {
    throw new YouTubeLiveE2EError(
      "YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED",
      "Live YouTube E2E requires explicit rights confirmation.",
    );
  }
  return {
    skipped: false,
    source: validateSmokeSource(liveSourceEnv(env)),
  };
}

function smokeEnvForLive(env, baseUrl) {
  return {
    ...env,
    SHORTSENGINE_YOUTUBE_SMOKE: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_URL: String(
      rawValue(env, LIVE_URL_FLAG) || rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_URL") || "",
    ).trim(),
    SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL: baseUrl,
    SHORTSENGINE_YOUTUBE_SMOKE_SAVE_DOWNLOAD: "1",
  };
}

function healthEndpoint(baseUrl) {
  const parsed = new URL(baseUrl);
  const mount = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${mount}/health`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function fetchHealthAttempt(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return {
      ok: Boolean(response?.ok),
      status: typeof response?.status === "number" ? response.status : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      errorCode: error?.name === "AbortError" ? "ABORT_ERR" : error?.code || "FETCH_FAILED",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServerReady({
  baseUrl,
  child = null,
  events = [],
  fetchImpl,
  port = null,
  timeoutMs = DEFAULT_SERVER_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_SERVER_READY_POLL_INTERVAL_MS,
}) {
  if (typeof fetchImpl !== "function") {
    throw new YouTubeLiveE2EError(
      "YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT",
      "Live YouTube E2E could not verify local server readiness.",
    );
  }
  const started = Date.now();
  const healthUrl = healthEndpoint(baseUrl);
  let attempts = 0;
  let lastStatus = null;
  let lastErrorCode = null;

  while (Date.now() - started < timeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      const failedEvent = Array.isArray(events)
        ? [...events].reverse().find((event) => event && (event.code || event.event === "server_listen_failed"))
        : null;
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED",
        "Live YouTube E2E local server exited before readiness.",
        {
          phase: PHASES.SERVER_BIND,
          port,
          timeoutMs,
          attempts,
          waitedMs: Date.now() - started,
          causeCode: failedEvent?.code || child.signalCode || `exit_${child.exitCode}`,
        },
      );
    }
    attempts += 1;
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
    const attempt = await fetchHealthAttempt(fetchImpl, healthUrl, Math.min(1000, remainingMs));
    lastStatus = attempt.status;
    lastErrorCode = attempt.errorCode || null;
    if (attempt.ok) {
      return {
        attempts,
        waitedMs: Date.now() - started,
        status: attempt.status,
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }

  throw new YouTubeLiveE2EError(
    "YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT",
    "Live YouTube E2E local server did not become ready in time.",
    {
      phase: PHASES.SERVER_READY,
      port,
      timeoutMs,
      attempts,
      waitedMs: Date.now() - started,
      httpStatus: lastStatus,
      causeCode: lastErrorCode,
    },
  );
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

function startServer(port, env) {
  const tmpRoot = resolve(ROOT_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dataDir = mkdtempSync(resolve(tmpRoot, "shortsengine-youtube-live-data-"));
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env,
      MATCHCUTS_DATA_DIR: dataDir,
      PORT: String(port),
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
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
        if (parsed.event === "valid_goal_selection_empty") {
          event.goalDiscovery = {
            visualWindowCount: safeNumber(parsed.visualWindowCount),
            bucketCount: safeNumber(parsed.bucketCount),
            lateBucketInspected: safeBoolean(parsed.lateBucketInspected),
            selectedValidGoalCount: safeNumber(parsed.selectedValidGoalCount),
            excludedOffsideOrNoGoalCount: safeNumber(parsed.excludedOffsideOrNoGoalCount),
            excludedUnconfirmedBallInNetCount: safeNumber(parsed.excludedUnconfirmedBallInNetCount),
            goalEvidenceEventCount: safeNumber(parsed.goalEvidenceEventCount),
            validGoalEvidenceCount: safeNumber(parsed.validGoalEvidenceCount),
            offsideOrNoGoalEvidenceCount: safeNumber(parsed.offsideOrNoGoalEvidenceCount),
            celebrationOnlyEvidenceCount: safeNumber(parsed.celebrationOnlyEvidenceCount),
            anthemOrIntroEvidenceCount: safeNumber(parsed.anthemOrIntroEvidenceCount),
            ocrEvidenceCount: safeNumber(parsed.ocrEvidenceCount),
            scoreboardConfirmedGoalCount: safeNumber(parsed.scoreboardConfirmedGoalCount),
          };
        }
        if (parsed.event === "scoreboard_ocr_completed") {
          event.scoreboardOcr = {
            providerMode: safeString(parsed.providerMode, 80),
            fallbackUsed: safeBoolean(parsed.fallbackUsed),
            sampledFrameCount: safeNumber(parsed.sampledFrameCount),
            evidenceCount: safeNumber(parsed.evidenceCount),
            scoreChangeCount: safeNumber(parsed.scoreChangeCount),
            ambiguousCount: safeNumber(parsed.ambiguousCount),
          };
        }
      } catch {
        // Keep raw process output out of persisted reports.
      }
      events.push(event);
      if (events.length > 40) events.shift();
    }
  };
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  return { child, dataDir, events };
}

async function stopServer(child, dataDir = null) {
  if (child && child.exitCode === null && !child.signalCode) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveStop) => child.once("exit", resolveStop)),
      delay(2500).then(() => {
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }),
    ]);
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for isolated live proof storage.
    }
  }
}

async function runYouTubeLiveE2E(options = {}) {
  const started = Date.now();
  const env = options.env || process.env;
  const checks = [];
  const steps = [];
  const failedCases = [];
  const serverEvents = [];
  let source = null;
  let doctor = null;
  let smoke = null;
  let server = null;
  let envSummary = null;
  let outputProof = null;
  let staleArtifactCleanup = null;
  const commandName = options.commandName || DEFAULT_COMMAND_NAME;

  const deps = {
    checkYouTubeIngest: options.checkYouTubeIngest || checkYouTubeIngest,
    checkEnvironment: options.checkEnvironment || checkEnvironment,
    cleanupGeneratedArtifacts: options.cleanupGeneratedArtifacts || (options.runYouTubeSmoke
      ? () => ({
          directory: MANUAL_DOWNLOADS_DIR,
          attempted: false,
          deletedCount: 0,
          deleted: [],
          skippedCount: 0,
          errors: [],
          destructiveOutsideManualDownloads: false,
        })
      : cleanupGeneratedProofArtifacts),
    getFreePort: options.getFreePort || getFreePort,
    runYouTubeSmoke: options.runYouTubeSmoke || runYouTubeSmoke,
    startServer: options.startServer || startServer,
    stopServer: options.stopServer || stopServer,
    waitForServerReady: options.waitForServerReady || waitForServerReady,
  };

  try {
    envSummary = deps.checkEnvironment({ env });
    addStep(steps, "env", "passed", {
      liveE2E: Boolean(envSummary.youtubeIngest?.liveE2E?.enabled),
      sourceConfigured: Boolean(envSummary.youtubeIngest?.liveE2E?.sourceConfigured),
    });
    const config = validateLiveConfig(env);
    if (config.skipped) {
      addCheck(checks, "youtube_live_e2e_explicit_flag", true, {
        code: "YOUTUBE_LIVE_E2E_DISABLED",
        nextAction: nextActionForCode("YOUTUBE_LIVE_E2E_DISABLED"),
      });
      return buildReport({
        checks,
        commandName,
        doctor,
        durationMs: Date.now() - started,
        env,
        failedCases,
        envSummary,
        serverEvents,
        smoke,
        source,
        status: "skipped",
        steps,
      });
    }
    source = config.source;
    addCheck(checks, "youtube_live_e2e_explicit_flag", true);
    addCheck(checks, "youtube_live_e2e_rights_confirmed", true);
    addCheck(checks, "youtube_live_e2e_source_validated_before_server", true, { videoId: source.videoId });
    staleArtifactCleanup = deps.cleanupGeneratedArtifacts({ source, env });
    addStep(steps, "fresh-output-cleanup", "passed", {
      attempted: Boolean(staleArtifactCleanup?.attempted),
      deletedCount: safeNumber(staleArtifactCleanup?.deletedCount),
    });

    doctor = await deps.checkYouTubeIngest({ env });
    addStep(steps, "doctor", doctor?.ok === true && doctor.status === "passed" ? "passed" : "failed", {
      code: doctor?.code || null,
    });
    if (!doctor || doctor.ok !== true || doctor.status !== "passed") {
      throw new YouTubeLiveE2EError(
        doctor?.code || "YOUTUBE_LIVE_E2E_DOCTOR_FAILED",
        "Live YouTube E2E doctor did not pass.",
        { nextAction: doctor?.nextAction || nextActionForCode("YOUTUBE_LIVE_E2E_DOCTOR_FAILED") },
      );
    }

    let port;
    try {
      const configuredPort = options.port || rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT");
      port = configuredPort
        ? parseInteger(configuredPort, null, 1, 65535, "YOUTUBE_LIVE_E2E_PORT_INVALID")
        : await deps.getFreePort();
    } catch (error) {
      if (error instanceof YouTubeLiveE2EError) throw error;
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED",
        "Live YouTube E2E could not allocate a local server port.",
        { causeCode: error?.code || null },
      );
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    server = deps.startServer(port, env);
    addStep(steps, "server", "started", { target: "local" });
    const serverReadyTimeoutMs = parseInteger(
      rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT_MS"),
      DEFAULT_SERVER_READY_TIMEOUT_MS,
      1000,
      120_000,
      "YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT_INVALID",
    );
    const ready = await deps.waitForServerReady({
      baseUrl,
      child: server.child,
      events: server.events,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      port,
      timeoutMs: serverReadyTimeoutMs,
      pollIntervalMs: DEFAULT_SERVER_READY_POLL_INTERVAL_MS,
    });
    addStep(steps, "server-ready", "passed", {
      attempts: ready.attempts,
      waitedMs: ready.waitedMs,
      httpStatus: ready.status,
    });

    smoke = await deps.runYouTubeSmoke({
      env: smokeEnvForLive(env, baseUrl),
      fetchImpl: options.fetchImpl || globalThis.fetch,
    });
    if (smoke?.status !== "passed") {
      const failure = smoke?.failedCases?.[0] || {};
      const failureNextAction = failure.code && NEXT_ACTIONS[failure.code]
        ? nextActionForCode(failure.code)
        : failure.nextAction || nextActionForCode("YOUTUBE_LIVE_E2E_SMOKE_FAILED");
      throw new YouTubeLiveE2EError(
        failure.code || "YOUTUBE_LIVE_E2E_SMOKE_FAILED",
        "Live YouTube E2E smoke did not pass.",
        { nextAction: failureNextAction },
      );
    }
    outputProof = buildOutputProof({ env, smoke, source, staleArtifactCleanup });
    const strictOutputValidation = options.requireOutputValidation !== undefined
      ? Boolean(options.requireOutputValidation)
      : !options.runYouTubeSmoke;
    if (strictOutputValidation && outputProof.ffprobe?.status !== "passed") {
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_OUTPUT_NOT_READY",
        "Live YouTube E2E generated output did not pass ffprobe validation.",
        {
          phase: PHASES.DOWNLOAD,
          causeCode: outputProof.ffprobe?.code || outputProof.ffprobe?.status || "FFPROBE_FAILED",
        },
      );
    }
    addStep(steps, "smoke", "passed");
    addStep(steps, "ffprobe", outputProof.ffprobe?.status === "passed" ? "passed" : "skipped", {
      code: outputProof.ffprobe?.code || null,
      relativePath: outputProof.ffprobe?.relativePath || null,
      durationSeconds: outputProof.ffprobe?.durationSeconds || null,
      width: outputProof.ffprobe?.width || null,
      height: outputProof.ffprobe?.height || null,
    });
    for (const [name, passed] of [
      ["youtube_live_e2e_ingest_created_project", Boolean(smoke.ids?.projectId)],
      ["youtube_live_e2e_ingest_created_upload", Boolean(smoke.ids?.uploadId)],
      ["youtube_live_e2e_render_created_export", Boolean(smoke.ids?.exportId)],
      ["youtube_live_e2e_download_verified", Boolean(smoke.export)],
      ["youtube_live_e2e_output_fresh_path", Boolean(outputProof.outputMp4?.relativePath)],
      ["youtube_live_e2e_replay_only_segments_reported", Number.isFinite(Number(outputProof.replayOnlySegments))],
    ]) {
      addCheck(checks, name, passed);
    }
  } catch (error) {
    const failure = safeFailure(error);
    failedCases.push({ name: "youtube_live_e2e", ...failure });
    addStep(steps, "failure", "failed", { code: failure.code, phase: failure.phase, nextAction: failure.nextAction });
  } finally {
    if (server) {
      serverEvents.push(...(server.events || []));
      await deps.stopServer(server.child, server.dataDir);
    }
  }

  for (const check of checks) {
    if (!check.passed) failedCases.push({ name: check.name, code: check.code || "CHECK_FAILED" });
  }
  return buildReport({
    checks,
    commandName,
    doctor,
    durationMs: Date.now() - started,
    env,
    failedCases,
    envSummary,
    outputProof,
    serverEvents,
    smoke,
    source,
    status: failedCases.length ? "failed" : "passed",
    staleArtifactCleanup,
    steps,
  });
}

function writeYouTubeLiveE2EReport(report, outputDir = RESULTS_DIR) {
  const safe = safeReport(report);
  mkdirSync(outputDir, { recursive: true });
  const stamp = safe.timestamp.replace(/[:.]/g, "-");
  const reportFile = resolve(outputDir, `youtube-live-e2e-${stamp}.json`);
  const latestFile = resolve(outputDir, "youtube-live-e2e-latest.json");
  atomicWriteJson(reportFile, safe);
  atomicWriteJson(latestFile, safe);
  return {
    reportPath: relativeFromRoot(reportFile),
    latestPath: relativeFromRoot(latestFile),
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const commandName = process.argv.includes("--operator") ? "youtube:proof:operator" : DEFAULT_COMMAND_NAME;
  let timeout = DEFAULT_TIMEOUT_MS;
  try {
    timeout = parseInteger(
      process.env.SHORTSENGINE_YOUTUBE_LIVE_E2E_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      15 * 60 * 1000,
      "YOUTUBE_LIVE_E2E_TIMEOUT_INVALID",
    );
  } catch (error) {
    const failure = safeFailure(error);
    const report = buildReport({
      checks: [{ name: "youtube_live_e2e_timeout_config_valid", passed: false, code: failure.code }],
      commandName,
      doctor: null,
      durationMs: 0,
      env: process.env,
      failedCases: [{ name: "youtube_live_e2e_timeout_config_valid", ...failure }],
      serverEvents: [],
      smoke: null,
      source: null,
      status: "failed",
      steps: [{ step: "config", status: "failed", code: failure.code, nextAction: failure.nextAction }],
    });
    const written = writeYouTubeLiveE2EReport(report);
    console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
    process.exitCode = 1;
  }
  let timeoutId;
  if (!process.exitCode) {
    const timeoutPromise = new Promise((resolveTimeout) => {
      timeoutId = setTimeout(() => {
        resolveTimeout({
          timestamp: nowIso(),
          command: commandName,
          status: "failed",
          passed: false,
          skipped: false,
          mode: "youtube-live-local-e2e",
          phase: PHASES.RENDER,
          nextAction: "check-local-server-and-downloader-before-rerun",
          durationMs: timeout,
          source: null,
          checks: [{ name: "youtube_live_e2e_timeout", passed: false, code: "YOUTUBE_LIVE_E2E_TIMEOUT" }],
          steps: [],
          triage: {
            status: "failed",
            failedPhase: PHASES.RENDER,
            nextAction: "check-local-server-and-downloader-before-rerun",
            preflight: safePreflightSummary(null),
            doctor: safeDoctorTriage(null),
          },
          doctor: null,
          smoke: null,
          serverEvents: [],
          failedCases: [{
            name: "youtube_live_e2e_timeout",
            code: "YOUTUBE_LIVE_E2E_TIMEOUT",
            phase: PHASES.RENDER,
            nextAction: "check-local-server-and-downloader-before-rerun",
          }],
        });
      }, timeout);
      if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
    });
    const report = await Promise.race([runYouTubeLiveE2E({ commandName }), timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    const written = writeYouTubeLiveE2EReport(report);
    console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_COMMAND_NAME,
  LIVE_FLAG,
  LIVE_RIGHTS_FLAG,
  LIVE_URL_FLAG,
  YouTubeLiveE2EError,
  runYouTubeLiveE2E,
  validateLiveConfig,
  cleanupGeneratedProofArtifacts,
  isManagedLiveProofMp4,
  writeYouTubeLiveE2EReport,
};
