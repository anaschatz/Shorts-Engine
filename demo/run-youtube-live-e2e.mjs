import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";
import { analyzeRenderedVisualFrameQA } from "./rendered-visual-frame-qa.mjs";
import {
  RESULTS_DIR,
  computedIngestRequestTimeoutMs,
  runYouTubeSmoke,
  safeDownloadArtifactRef,
  validateSmokeSource,
} from "./run-youtube-smoke.mjs";
import { checkEnvironment } from "../tools/release/check-environment.mjs";
import { checkYouTubeIngest } from "../tools/release/check-youtube-ingest.mjs";

const require = createRequire(import.meta.url);
const { renderedSocialPolishProof } = require("../server/rendered-social-proof.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E";
const LIVE_RIGHTS_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED";
const LIVE_URL_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_URL";
const LIVE_DOWNLOAD_TIMEOUT_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS";
const DEFAULT_COMMAND_NAME = "youtube:proof";
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS;
const MAX_LIVE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_LIVE_SCOREBOARD_OCR_JOB_TIMEOUT_MS = 5 * 60 * 1000;
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
  ENV_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_INVALID: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS-between-1000-and-900000",
  YOUTUBE_LIVE_E2E_DOCTOR_FAILED: "run-npm-run-youtube-doctor-and-fix-failed-checks",
  YOUTUBE_LIVE_E2E_SMOKE_FAILED: "inspect-demo-results-youtube-live-e2e-latest-json",
  YOUTUBE_LIVE_E2E_REPORT_LEAK: "remove-sensitive-output-from-live-e2e-report",
  YOUTUBE_LIVE_E2E_TIMEOUT: "check-local-server-and-downloader-before-rerun-or-increase-timeout-only-if-expected",
  YOUTUBE_LIVE_E2E_OUTPUT_NOT_READY: "check-generated-mp4-path-and-ffprobe-before-comparison",
  YOUTUBE_LIVE_E2E_GOAL_COVERAGE_INCOMPLETE: "inspect-counted-goal-proof-and-fix-valid-goal-selection-before-release",
  YOUTUBE_LIVE_E2E_HUMAN_VISIBLE_GOAL_INCOMPLETE: "inspect-human-visible-goal-gate-contact-sheets-and-fix-goal-sequence-selection",
  YOUTUBE_LIVE_E2E_SOCIAL_POLISH_FAILED: "inspect-rendered-social-polish-qa-and-fix-hook-captions-transitions-before-release",
  YOUTUBE_LIVE_E2E_CLEANUP_DIR_UNSAFE: "keep-live-proof-cleanup-inside-manual-downloads",
  YOUTUBE_DOWNLOAD_TIMEOUT: "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS-for-authorized-long-source-or-use-source-cache",
  YOUTUBE_DOWNLOAD_FAILED: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
  YOUTUBE_NO_PROGRESS_TIMEOUT: "retry-with-longer-no-progress-timeout-or-use-authorized-source-cache",
  SOURCE_CACHE_MISS: "place-rights-cleared-source-in-cache-or-enable-downloader-fallback",
  SOURCE_CACHE_FILE_INVALID: "replace-invalid-source-cache-file",
  SOURCE_CACHE_CHECKSUM_MISMATCH: "fix-cache-metadata-or-checksum",
  SCOREBOARD_OCR_TIMEOUT: "reduce-scorebug-ocr-sampling-or-disable-live-scoreboard-ocr-and-rerun-proof",
  VIDEO_OUTPUT_QA_FAILED: "inspect-video-output-qa-missing-goals-and-fix-final-edit-plan-before-release",
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

function parseLiveProofTimeoutMs(env, fallback = DEFAULT_TIMEOUT_MS) {
  return parseInteger(
    rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_TIMEOUT_MS"),
    fallback,
    1000,
    MAX_TIMEOUT_MS,
    "YOUTUBE_LIVE_E2E_TIMEOUT_INVALID",
  );
}

function parseLiveDownloadTimeoutMs(env) {
  const raw = rawValue(env, LIVE_DOWNLOAD_TIMEOUT_FLAG);
  if (raw === undefined || raw === null || raw === "") return null;
  return parseInteger(
    raw,
    null,
    1000,
    MAX_LIVE_DOWNLOAD_TIMEOUT_MS,
    "ENV_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_INVALID",
  );
}

function liveScoreboardOcrEnabled(env) {
  return boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR"));
}

function liveScoreboardOcrQaEnabled(env) {
  return boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR_QA"));
}

function liveScoreboardOcrJobTimeoutEnv(env) {
  const explicitJobTimeout = rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS");
  if (
    !liveScoreboardOcrEnabled(env) ||
    (explicitJobTimeout !== undefined && explicitJobTimeout !== null && explicitJobTimeout !== "")
  ) {
    return {};
  }
  return { SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS: String(DEFAULT_LIVE_SCOREBOARD_OCR_JOB_TIMEOUT_MS) };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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

function safeStringList(values = [], maxItems = 8, maxLength = 80) {
  return (Array.isArray(values) ? values : [])
    .map((value) => safeString(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeGoalEvidenceCandidate(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: safeNumber(value.index) || index + 1,
    id: safeString(value.id || `goal_evidence_${index + 1}`, 80),
    outcomeHint: safeString(value.outcomeHint || "", 48) || null,
    start: safeNumber(value.start),
    end: safeNumber(value.end),
    reasonCodes: safeStringList(value.reasonCodes, 12, 80),
    missingEvidence: safeStringList(value.missingEvidence, 8, 80),
    recoveryEligibility: safeString(value.recoveryEligibility || "not_recoverable", 60),
    rejectionReason: value.rejectionReason ? safeString(value.rejectionReason, 80) : null,
    combinedGoalConfirmation: safeBoolean(value.combinedGoalConfirmation),
    replayGoalConfirmation: safeBoolean(value.replayGoalConfirmation),
    crowdReactionSupport: safeBoolean(value.crowdReactionSupport),
    offsideFlag: safeBoolean(value.offsideFlag),
    noGoalSignal: safeBoolean(value.noGoalSignal),
    confidence: safeNumber(value.confidence),
  };
}

function safeTruthCandidate(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: safeNumber(value.index) || index + 1,
    id: safeString(value.id || `truth_event_${index + 1}`, 80),
    type: safeString(value.type || "", 48) || null,
    outcome: safeString(value.outcome || "", 48) || null,
    sourceStart: safeNumber(value.sourceStart),
    sourceEnd: safeNumber(value.sourceEnd),
    replayOnly: safeBoolean(value.replayOnly),
    evidenceCodes: safeStringList(value.evidenceCodes, 12, 80),
    missingEvidence: safeStringList(value.missingEvidence, 8, 80),
    disqualifiers: safeStringList(value.disqualifiers, 8, 80),
  };
}

function safeScoreChangeAnchor(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: safeNumber(value.index) || index + 1,
    id: safeString(value.id || `score_change_anchor_${index + 1}`, 96),
    scoreBefore: value.scoreBefore ? safeString(value.scoreBefore, 16) : null,
    scoreAfter: value.scoreAfter ? safeString(value.scoreAfter, 16) : null,
    firstSeenAt: safeNumber(value.firstSeenAt),
    confirmedAt: safeNumber(value.confirmedAt),
    stableUntil: safeNumber(value.stableUntil),
    reverted: safeBoolean(value.reverted),
    revertedAt: safeNumber(value.revertedAt),
    confidence: safeNumber(value.confidence),
    source: "scoreboard_ocr",
    roiId: value.roiId ? safeString(value.roiId, 80) : null,
    layoutId: value.layoutId ? safeString(value.layoutId, 80) : null,
    outcome: safeString(value.outcome || "uncertain_review", 48),
    selectedForRender: safeBoolean(value.selectedForRender),
    linkedEventType: value.linkedEventType ? safeString(value.linkedEventType, 48) : null,
    hasLiveAction: safeBoolean(value.hasLiveAction),
    hasVisibleFinish: safeBoolean(value.hasVisibleFinish),
    replayOnly: safeBoolean(value.replayOnly),
    missingEvidence: safeStringList(value.missingEvidence, 8, 80),
    evidenceCodes: safeStringList(value.evidenceCodes, 16, 80),
  };
}

function safeOcrChunkSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chunks = Array.isArray(value.chunks) ? value.chunks : [];
  return {
    mode: safeString(value.mode || "chunked_scorebug_ocr", 60),
    chunkCount: safeNumber(value.chunkCount),
    scannedChunks: safeNumber(value.scannedChunks),
    skippedChunks: safeNumber(value.skippedChunks),
    scannedDurationSeconds: safeNumber(value.scannedDurationSeconds),
    discoveredScoreChanges: safeNumber(value.discoveredScoreChanges),
    plannedFrameCount: safeNumber(value.plannedFrameCount),
    attemptedRoiCount: safeNumber(value.attemptedRoiCount),
    attemptedObservationCount: safeNumber(value.attemptedObservationCount),
    totalBudgetMs: safeNumber(value.totalBudgetMs),
    chunkTimeoutMs: safeNumber(value.chunkTimeoutMs),
    chunks: chunks.map((chunk, index) => ({
      index: safeNumber(chunk && chunk.index) || index + 1,
      start: safeNumber(chunk && chunk.start),
      end: safeNumber(chunk && chunk.end),
      status: safeString(chunk && chunk.status, 40),
      plannedFrameCount: safeNumber(chunk && chunk.plannedFrameCount),
      sampledFrameCount: safeNumber(chunk && chunk.sampledFrameCount),
      sampledFrameTimestamps: Array.isArray(chunk && chunk.sampledFrameTimestamps)
        ? chunk.sampledFrameTimestamps.map((timestamp) => safeNumber(timestamp)).filter((timestamp) => timestamp !== null).slice(0, 16)
        : [],
      roiCandidateIds: safeStringList(chunk && chunk.roiCandidateIds, 8, 80),
      attemptedRoiCount: safeNumber(chunk && chunk.attemptedRoiCount),
      attemptedObservationCount: safeNumber(chunk && chunk.attemptedObservationCount),
      roiDetected: safeBoolean(chunk && chunk.roiDetected),
      selectedRoiId: chunk && chunk.selectedRoiId ? safeString(chunk.selectedRoiId, 80) : null,
      ocrTextCandidateCount: safeNumber(chunk && chunk.ocrTextCandidateCount),
      evidenceCount: safeNumber(chunk && chunk.evidenceCount),
      scoreChangeCount: safeNumber(chunk && chunk.scoreChangeCount),
      textPresentObservationCount: safeNumber(chunk && chunk.textPresentObservationCount),
      readableObservationCount: safeNumber(chunk && chunk.readableObservationCount),
      clockOnlyObservationCount: safeNumber(chunk && chunk.clockOnlyObservationCount),
      rejectedObservationCount: safeNumber(chunk && chunk.rejectedObservationCount),
      stableScoreDecision: safeString(chunk && chunk.stableScoreDecision || "unknown", 80),
      normalizedScoreCandidates: safeStringList(chunk && chunk.normalizedScoreCandidates, 12, 16),
      rejectedScoreCandidateReasons: safeStringList(chunk && chunk.rejectedScoreCandidateReasons, 12, 80),
      skippedReason: chunk && chunk.skippedReason ? safeString(chunk.skippedReason, 80) : null,
      nextAction: chunk && chunk.nextAction ? safeString(chunk.nextAction, 180) : null,
    })).slice(0, 40),
  };
}

function safeProgressMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    phase: safeString(value.phase || "", 40) || null,
    step: safeString(value.step || "", 80) || null,
    substep: safeString(value.substep || "", 80) || null,
    longSource: safeBoolean(value.longSource),
    scorebugFirst: safeBoolean(value.scorebugFirst),
    budgetMs: safeNumber(value.budgetMs),
    chunkIndex: safeNumber(value.chunkIndex),
    chunkCount: safeNumber(value.chunkCount),
    chunkStart: safeNumber(value.chunkStart),
    chunkEnd: safeNumber(value.chunkEnd),
    scannedChunks: safeNumber(value.scannedChunks),
    discoveredScoreChanges: safeNumber(value.discoveredScoreChanges),
    elapsedMs: safeNumber(value.elapsedMs),
    totalBudgetMs: safeNumber(value.totalBudgetMs),
    chunkTimeoutMs: safeNumber(value.chunkTimeoutMs),
    sampledFrameTimestamps: Array.isArray(value.sampledFrameTimestamps)
      ? value.sampledFrameTimestamps
        .map((timestamp) => safeNumber(timestamp))
        .filter((timestamp) => timestamp !== null)
        .slice(0, 16)
      : [],
    roiCandidateIds: safeStringList(value.roiCandidateIds, 8, 80),
  };
}

function hasProgressMetaFields(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    value.step ||
      value.substep ||
      value.chunkIndex !== null ||
      value.chunkCount !== null ||
      value.scannedChunks !== null ||
      value.discoveredScoreChanges !== null,
  );
}

function safeMissingEvidenceCandidate(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    index: safeNumber(value.index) || index + 1,
    id: safeString(value.id || `goal_evidence_${index + 1}`, 80),
    outcomeHint: safeString(value.outcomeHint || "", 48) || null,
    start: safeNumber(value.start),
    end: safeNumber(value.end),
    missingEvidence: safeStringList(value.missingEvidence, 8, 80),
    rejectionReason: value.rejectionReason ? safeString(value.rejectionReason, 80) : null,
  };
}

function safeScoreboardOcrEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value.summary && typeof value.summary === "object" && !Array.isArray(value.summary)
    ? value.summary
    : {};
  const scorebugDebug = value.scorebugDebug || summary.scorebugDebug;
  const selectedRoi = scorebugDebug && typeof scorebugDebug === "object" && !Array.isArray(scorebugDebug)
    ? scorebugDebug.selectedRoi
    : null;
  const safeQaReport = value.qaReport && typeof value.qaReport === "object" && !Array.isArray(value.qaReport)
    ? {
        enabled: safeBoolean(value.qaReport.enabled),
        runId: safeString(value.qaReport.runId, 120),
        status: safeString(value.qaReport.status, 40),
        reportPath: value.qaReport.reportPath ? safeString(value.qaReport.reportPath, 180) : null,
        latestPath: value.qaReport.latestPath ? safeString(value.qaReport.latestPath, 180) : null,
        contactSheetPath: value.qaReport.contactSheetPath ? safeString(value.qaReport.contactSheetPath, 180) : null,
        reviewPath: value.qaReport.reviewPath ? safeString(value.qaReport.reviewPath, 180) : null,
        cropCount: safeNumber(value.qaReport.cropCount),
        attemptCount: safeNumber(value.qaReport.attemptCount),
      }
    : null;
  return {
    providerMode: safeString(value.providerMode, 80),
    fallbackUsed: safeBoolean(value.fallbackUsed),
    sampledFrameCount: safeNumber(value.sampledFrameCount),
    evidenceCount: safeNumber(value.evidenceCount),
    scoreChangeCount: safeNumber(value.scoreChangeCount),
    scoreRevertedCount: safeNumber(value.scoreRevertedCount),
    ambiguousCount: safeNumber(value.ambiguousCount),
    unreadableCount: safeNumber(value.unreadableCount),
    regionIdsUsed: safeStringList(value.regionIdsUsed, 8, 80),
    preprocessingVariantCount: safeNumber(value.preprocessingVariantCount),
    chunkSummary: safeOcrChunkSummary(value.chunkSummary || summary.chunkSummary),
    qaReport: safeQaReport,
    scorebugDebug: scorebugDebug && typeof scorebugDebug === "object" && !Array.isArray(scorebugDebug)
      ? {
          attemptedRoiCount: safeNumber(scorebugDebug.attemptedRoiCount),
          attemptedObservationCount: safeNumber(scorebugDebug.attemptedObservationCount),
          textPresentObservationCount: safeNumber(scorebugDebug.textPresentObservationCount),
          readableObservationCount: safeNumber(scorebugDebug.readableObservationCount),
          state: safeString(scorebugDebug.state, 80),
          nextAction: safeString(scorebugDebug.nextAction, 180),
          qaRecommended: safeBoolean(scorebugDebug.qaRecommended),
          reasonCodes: safeStringList(scorebugDebug.reasonCodes, 10, 80),
          selectedRoi: selectedRoi && typeof selectedRoi === "object"
            ? {
                regionId: safeString(selectedRoi.regionId, 80),
                layoutId: selectedRoi.layoutId ? safeString(selectedRoi.layoutId, 80) : null,
                observationCount: safeNumber(selectedRoi.observationCount),
                readableCount: safeNumber(selectedRoi.readableCount),
                readableObservationCount: safeNumber(selectedRoi.readableObservationCount),
                scoreChangeCount: safeNumber(selectedRoi.scoreChangeCount),
                revertedCount: safeNumber(selectedRoi.revertedCount),
                unchangedCount: safeNumber(selectedRoi.unchangedCount),
                ambiguousCount: safeNumber(selectedRoi.ambiguousCount),
                diagnosis: safeString(selectedRoi.diagnosis, 80),
                reasonCodes: safeStringList(selectedRoi.reasonCodes, 8, 80),
              }
            : null,
          rejectedRois: Array.isArray(scorebugDebug.rejectedRois)
            ? scorebugDebug.rejectedRois.slice(0, 8).map((roi) => ({
                regionId: safeString(roi && roi.regionId, 80),
                layoutId: roi && roi.layoutId ? safeString(roi.layoutId, 80) : null,
                observationCount: safeNumber(roi && roi.observationCount),
                readableObservationCount: safeNumber(roi && roi.readableObservationCount),
                scoreChangeCount: safeNumber(roi && roi.scoreChangeCount),
                diagnosis: safeString(roi && roi.diagnosis, 80),
                reasonCodes: safeStringList(roi && roi.reasonCodes, 8, 80),
              }))
            : [],
        }
      : null,
    scoreTimeline: Array.isArray(value.scoreTimeline)
      ? value.scoreTimeline.map((item) => ({
          timestamp: safeNumber(item && item.timestamp),
          status: safeString(item && item.status, 40),
          scoreBefore: item && item.scoreBefore ? safeString(item.scoreBefore, 16) : null,
          scoreAfter: item && item.scoreAfter ? safeString(item.scoreAfter, 16) : null,
          temporalConsistency: safeBoolean(item && item.temporalConsistency),
        })).slice(0, 24)
      : [],
  };
}

function safeCurrentJobSnapshot(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  return {
    id: job.id ? safeString(job.id, 80) : null,
    projectId: job.projectId ? safeString(job.projectId, 80) : null,
    uploadId: job.uploadId ? safeString(job.uploadId, 80) : null,
    status: job.status ? safeString(job.status, 40) : null,
    progress: safeNumber(job.progress),
    step: job.step ? safeString(job.step, 80) : null,
    progressMeta: safeProgressMeta(job.progressMeta),
    exportId: job.exportId ? safeString(job.exportId, 80) : null,
    error: job.error ? safeReportError(job.error) : null,
    scoreboardOcr: safeScoreboardOcrEvent(job.scoreboardOcr),
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
  if (text === "VIDEO_OUTPUT_QA_FAILED") return PHASES.RENDER;
  if (text.startsWith("FILE_") || text.startsWith("VIDEO_") || text.includes("DURATION")) return PHASES.PROBE;
  if (
    text.includes("JOB") ||
    text.includes("GENERATE") ||
    text.includes("EXPORT_MISSING") ||
    text.includes("GOAL_COVERAGE") ||
    text.includes("HUMAN_VISIBLE_GOAL") ||
    text.includes("SOCIAL_POLISH") ||
    text === "SCOREBOARD_OCR_TIMEOUT" ||
    text === "NO_VALID_GOALS_FOUND"
  ) return PHASES.RENDER;
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
    step: details.step ? safeString(details.step, 80) : null,
    substep: details.substep ? safeString(details.substep, 80) : null,
    port: Number.isFinite(Number(details.port)) ? Number(details.port) : null,
    timeoutMs: Number.isFinite(Number(details.timeoutMs)) ? Number(details.timeoutMs) : null,
    elapsedMs: Number.isFinite(Number(details.elapsedMs)) ? Number(details.elapsedMs) : null,
    stalled: typeof details.stalled === "boolean" ? details.stalled : null,
    lastProgressAt: details.lastProgressAt ? safeString(details.lastProgressAt, 40) : null,
    attempts: Number.isFinite(Number(details.attempts)) ? Number(details.attempts) : null,
    attemptsConfigured: Number.isFinite(Number(details.attemptsConfigured)) ? Number(details.attemptsConfigured) : null,
    waitedMs: Number.isFinite(Number(details.waitedMs)) ? Number(details.waitedMs) : null,
    httpStatus: Number.isFinite(Number(details.httpStatus)) ? Number(details.httpStatus) : null,
    causeCode: details.causeCode ? safeString(details.causeCode, 60) : null,
    retryable: safeBoolean(details.retryable),
    authorizedImportRequired: safeBoolean(details.authorizedImportRequired),
    fallbackUsed: safeBoolean(details.fallbackUsed),
    formatSelector: details.formatSelector ? safeString(details.formatSelector, 180) : null,
    fallbackFormatSelector: details.fallbackFormatSelector ? safeString(details.fallbackFormatSelector, 180) : null,
    playerClient: details.playerClient ? safeString(details.playerClient, 40) : null,
    sourceAcquisitionStatus: details.sourceAcquisitionStatus ? safeString(details.sourceAcquisitionStatus, 80) : null,
    sourceAcquisitionStrategy: details.sourceAcquisitionStrategy ? safeString(details.sourceAcquisitionStrategy, 80) : null,
    cacheChecked: safeBoolean(details.cacheChecked),
    cacheHit: safeBoolean(details.cacheHit),
    cacheValidated: safeBoolean(details.cacheValidated),
    cacheFailureCode: details.cacheFailureCode ? safeString(details.cacheFailureCode, 80) : null,
    downloaderFallbackUsed: safeBoolean(details.downloaderFallbackUsed),
    checksumSha256: typeof details.checksumSha256 === "string" && /^[a-f0-9]{64}$/.test(details.checksumSha256)
      ? details.checksumSha256
      : null,
    heartbeatIntervalMs: safeNumber(details.heartbeatIntervalMs),
    noProgressTimeoutMs: safeNumber(details.noProgressTimeoutMs),
    progressHeartbeatCount: safeNumber(details.progressHeartbeatCount),
    progressEventCount: safeNumber(details.progressEventCount),
    progressBytesObserved: safeNumber(details.progressBytesObserved),
    lastProgressAgeMs: safeNumber(details.lastProgressAgeMs),
    timeoutClassification: details.timeoutClassification ? safeString(details.timeoutClassification, 80) : null,
    bytesStillMovingAtTimeout: safeBoolean(details.bytesStillMovingAtTimeout),
    continueEnabled: safeBoolean(details.continueEnabled),
    continueAttempted: safeBoolean(details.continueAttempted),
    resumableStateEnabled: safeBoolean(details.resumableStateEnabled),
    resumeStateRetained: safeBoolean(details.resumeStateRetained),
    metadataPreflightStatus: details.metadataPreflightStatus ? safeString(details.metadataPreflightStatus, 80) : null,
    metadataPreflightDurationSeconds: safeNumber(details.metadataPreflightDurationSeconds),
    cleanupSucceeded: safeBoolean(details.cleanupSucceeded),
    partialCleanupSucceeded: safeBoolean(details.partialCleanupSucceeded),
    partialCleanupRemovedCount: safeNumber(details.partialCleanupRemovedCount),
    downloadedOutputReady: safeBoolean(details.downloadedOutputReady),
    countedGoalEventCount: safeNumber(details.countedGoalEventCount),
    actualConfirmedGoalSegmentCount: safeNumber(details.actualConfirmedGoalSegmentCount),
    coveredGoalCount: safeNumber(details.coveredGoalCount),
    missingGoalNumbers: Array.isArray(details.missingGoalNumbers)
      ? details.missingGoalNumbers.map((goal) => Number(goal)).filter(Number.isFinite).slice(0, 12)
      : [],
    failedReasons: safeStringList(details.failedReasons, 12, 80),
    currentJob: safeCurrentJobSnapshot(details.currentJob),
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
    progressMeta: safeProgressMeta(event.progressMeta),
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

function safeHumanVisibleGoalGate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    passed: Boolean(value.passed),
    confidence: safeNumber(value.confidence),
    failureCode: value.failureCode ? safeString(value.failureCode, 60) : null,
    evidence: value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? {
          hasBuildupFrames: Boolean(value.evidence.hasBuildupFrames),
          hasShotFrames: Boolean(value.evidence.hasShotFrames),
          hasGoalmouthFrames: Boolean(value.evidence.hasGoalmouthFrames),
          hasPayoffFrames: Boolean(value.evidence.hasPayoffFrames),
          hasConfirmationAfterFinish: Boolean(value.evidence.hasConfirmationAfterFinish),
        }
      : null,
    sampledFrames: Array.isArray(value.sampledFrames)
      ? value.sampledFrames.slice(0, 8).map((frame) => ({
          label: safeString(frame && frame.label, 40),
          time: safeNumber(frame && frame.time),
        })).filter((frame) => frame.label && frame.time !== null)
      : [],
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
    boundarySmoothing: segment.boundarySmoothing && typeof segment.boundarySmoothing === "object"
      ? {
          applied: Boolean(segment.boundarySmoothing.applied),
          smoothingLevel: safeString(segment.boundarySmoothing.smoothingLevel || "", 40) || null,
          preActionPaddingSeconds: safeNumber(segment.boundarySmoothing.preActionPaddingSeconds),
          postConfirmationPaddingSeconds: safeNumber(segment.boundarySmoothing.postConfirmationPaddingSeconds),
        }
      : null,
    phaseCoverage: safePhaseCoverage(segment.phaseCoverage),
    visualGoalGate: safeHumanVisibleGoalGate(segment.visualGoalGate),
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
  const qa = renderPlan.visualPolishQA && typeof renderPlan.visualPolishQA === "object"
    ? renderPlan.visualPolishQA
    : {};
  const segmentVisibleCount = segments.filter((segment) => segment.visualGoalGate && segment.visualGoalGate.passed === true).length;
  const humanVisibleGoalsIncluded = Number.isFinite(Number(qa.humanVisibleGoalsIncluded))
    ? Number(qa.humanVisibleGoalsIncluded)
    : segmentVisibleCount;
  const failedVisibleGoalSegments = Array.isArray(qa.failedVisibleGoalSegments)
    ? qa.failedVisibleGoalSegments.map((segment, index) => ({
        index: Number.isFinite(Number(segment.index)) ? Number(segment.index) : index + 1,
        segmentId: safeString(segment.segmentId || "", 64) || null,
        failureCode: segment.failureCode ? safeString(segment.failureCode, 60) : null,
        confidence: safeNumber(segment.confidence),
        evidence: segment.evidence && typeof segment.evidence === "object"
          ? {
              hasBuildupFrames: Boolean(segment.evidence.hasBuildupFrames),
              hasShotFrames: Boolean(segment.evidence.hasShotFrames),
              hasGoalmouthFrames: Boolean(segment.evidence.hasGoalmouthFrames),
              hasPayoffFrames: Boolean(segment.evidence.hasPayoffFrames),
              hasConfirmationAfterFinish: Boolean(segment.evidence.hasConfirmationAfterFinish),
            }
          : null,
        sampledFrames: Array.isArray(segment.sampledFrames)
          ? segment.sampledFrames.slice(0, 8).map((frame) => ({
              label: safeString(frame && frame.label, 40),
              time: safeNumber(frame && frame.time),
            })).filter((frame) => frame.label && frame.time !== null)
          : [],
      }))
    : segments
        .filter((segment) => !segment.visualGoalGate || segment.visualGoalGate.passed !== true)
        .map((segment) => ({
          index: segment.index,
          segmentId: null,
          failureCode: segment.visualGoalGate ? segment.visualGoalGate.failureCode : "GOAL_NOT_VISIBLE",
          confidence: segment.visualGoalGate ? segment.visualGoalGate.confidence : null,
          evidence: segment.visualGoalGate ? segment.visualGoalGate.evidence : null,
          sampledFrames: segment.visualGoalGate ? segment.visualGoalGate.sampledFrames : [],
        }));
  const failedGateByIndex = new Map(failedVisibleGoalSegments.map((segment) => [
    Number(segment.index),
    {
      passed: false,
      confidence: segment.confidence,
      failureCode: segment.failureCode || "GOAL_NOT_VISIBLE",
      evidence: segment.evidence,
      sampledFrames: segment.sampledFrames,
    },
  ]));
  const segmentWindows = segments.map((segment) => (
    segment.visualGoalGate
      ? segment
      : {
          ...segment,
          visualGoalGate: failedGateByIndex.get(Number(segment.index)) || null,
        }
  ));
  const humanVisibleGoalRecall = Number.isFinite(Number(qa.humanVisibleGoalRecall))
    ? Number(qa.humanVisibleGoalRecall)
    : countedGoalsIncluded > 0
      ? Number((humanVisibleGoalsIncluded / countedGoalsIncluded).toFixed(4))
      : 1;
  return {
    countedGoalsFound,
    countedGoalsIncluded,
    humanVisibleGoalsIncluded,
    humanVisibleGoalRecall,
    passedVisualGate: humanVisibleGoalsIncluded === countedGoalsIncluded && humanVisibleGoalRecall === 1,
    failedVisibleGoalSegments,
    visualGateFailures: failedVisibleGoalSegments,
    expectedCountedGoals,
    replayOnlySegments,
    allExpectedCountedGoalsIncluded: expectedCountedGoals === null ? null : countedGoalsIncluded === expectedCountedGoals,
    segmentWindows,
  };
}

function referenceStyleQaFromSmoke(smoke, outputMp4 = null) {
  const renderPlan = smoke?.renderPlan && typeof smoke.renderPlan === "object" ? smoke.renderPlan : {};
  const qa = renderPlan.visualPolishQA ||
    (renderPlan.reviewMetadata && renderPlan.reviewMetadata.multiMoment && renderPlan.reviewMetadata.multiMoment.visualPolishQA) ||
    {};
  const segments = Array.isArray(renderPlan.segments) ? renderPlan.segments : [];
  const captions = Array.isArray(renderPlan.captions) ? renderPlan.captions : [];
  const durations = segments
    .map((segment) => safeNumber(Number(segment.sourceEnd) - Number(segment.sourceStart)))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const averageGoalSegmentDuration = Number.isFinite(Number(qa.averageGoalSegmentDuration))
    ? Number(qa.averageGoalSegmentDuration)
    : durations.length
      ? Number((durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(2))
      : null;
  const replayOnlySegments = Number.isFinite(Number(qa.replayOnlySegments))
    ? Number(qa.replayOnlySegments)
    : segments.filter((segment) => segment && segment.replayOnly === true).length;
  const countedGoalRecall = Number.isFinite(Number(qa.countedGoalRecall)) ? Number(qa.countedGoalRecall) : null;
  const humanVisibleGoalsIncluded = Number.isFinite(Number(qa.humanVisibleGoalsIncluded))
    ? Number(qa.humanVisibleGoalsIncluded)
    : segments.filter((segment) => segment && segment.visualGoalGate && segment.visualGoalGate.passed === true).length;
  const humanVisibleGoalRecall = Number.isFinite(Number(qa.humanVisibleGoalRecall)) ? Number(qa.humanVisibleGoalRecall) : null;
  const passedVisualGate = typeof qa.passedVisualGate === "boolean" ? qa.passedVisualGate : null;
  const failedVisibleGoalSegments = Array.isArray(qa.failedVisibleGoalSegments)
    ? qa.failedVisibleGoalSegments.slice(0, 8).map((segment, index) => ({
        index: Number.isFinite(Number(segment.index)) ? Number(segment.index) : index + 1,
        segmentId: safeString(segment.segmentId || "", 64) || null,
        failureCode: segment.failureCode ? safeString(segment.failureCode, 60) : null,
        confidence: safeNumber(segment.confidence),
        evidence: segment.evidence && typeof segment.evidence === "object"
          ? {
              hasBuildupFrames: Boolean(segment.evidence.hasBuildupFrames),
              hasShotFrames: Boolean(segment.evidence.hasShotFrames),
              hasGoalmouthFrames: Boolean(segment.evidence.hasGoalmouthFrames),
              hasPayoffFrames: Boolean(segment.evidence.hasPayoffFrames),
              hasConfirmationAfterFinish: Boolean(segment.evidence.hasConfirmationAfterFinish),
            }
          : null,
        sampledFrames: Array.isArray(segment.sampledFrames)
          ? segment.sampledFrames.slice(0, 8).map((frame) => ({
              label: safeString(frame && frame.label, 40),
              time: safeNumber(frame && frame.time),
            })).filter((frame) => frame.label && frame.time !== null)
          : [],
      }))
    : [];
  const replayOnlyGoalRate = Number.isFinite(Number(qa.replayOnlyGoalRate)) ? Number(qa.replayOnlyGoalRate) : null;
  const excessiveTailCount = Number.isFinite(Number(qa.excessiveTailCount)) ? Number(qa.excessiveTailCount) : null;
  const excessiveTailRate = Number.isFinite(Number(qa.excessiveTailRate)) ? Number(qa.excessiveTailRate) : null;
  const nonGoalFillerCount = Number.isFinite(Number(qa.nonGoalFillerCount)) ? Number(qa.nonGoalFillerCount) : null;
  const nonGoalFillerRate = Number.isFinite(Number(qa.nonGoalFillerRate)) ? Number(qa.nonGoalFillerRate) : null;
  const actionBoundaryScore = Number.isFinite(Number(qa.actionBoundaryScore)) ? Number(qa.actionBoundaryScore) : null;
  const referencePacingScore = Number.isFinite(Number(qa.referencePacingScore)) ? Number(qa.referencePacingScore) : null;
  const abruptCutRiskCount = Number.isFinite(Number(qa.abruptCutRiskCount))
    ? Number(qa.abruptCutRiskCount)
    : segments.filter((segment) => {
        const duration = Number(segment.duration || Number(segment.sourceEnd) - Number(segment.sourceStart));
        const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" ? segment.phaseCoverage : {};
        return segment.replayOnly === true ||
          !phase.hasShot ||
          !phase.hasFinish ||
          !phase.hasConfirmation ||
          !Number.isFinite(duration) ||
          duration < 18 ||
          duration > 32;
      }).length;
  const captionsMisalignedCount = Number.isFinite(Number(qa.captionsMisalignedCount))
    ? Number(qa.captionsMisalignedCount)
    : captions.filter((caption) => Array.isArray(caption.riskFlags) && caption.riskFlags.length > 0).length;
  const captionsAlignedCount = Number.isFinite(Number(qa.captionsAlignedCount))
    ? Number(qa.captionsAlignedCount)
    : Math.max(0, captions.length - captionsMisalignedCount);
  const boundarySmoothingAppliedCount = Number.isFinite(Number(qa.boundarySmoothingAppliedCount))
    ? Number(qa.boundarySmoothingAppliedCount)
    : segments.filter((segment) => segment && segment.boundarySmoothing && segment.boundarySmoothing.applied === true).length;
  const averagePreActionPaddingSeconds = Number.isFinite(Number(qa.averagePreActionPaddingSeconds))
    ? Number(qa.averagePreActionPaddingSeconds)
    : null;
  const averagePostConfirmationPaddingSeconds = Number.isFinite(Number(qa.averagePostConfirmationPaddingSeconds))
    ? Number(qa.averagePostConfirmationPaddingSeconds)
    : null;
  const cutSmoothnessScore = Number.isFinite(Number(qa.cutSmoothnessScore))
    ? Number(qa.cutSmoothnessScore)
    : Number(Math.max(0, 1 - abruptCutRiskCount / Math.max(1, segments.length * 2)).toFixed(4));
  const visualPolishScore = Number.isFinite(Number(qa.visualPolishScore))
    ? Number(qa.visualPolishScore)
    : Number(Math.max(
        0,
        100 -
          replayOnlySegments * 25 -
          abruptCutRiskCount * 20 -
          captionsMisalignedCount * 10 -
          (averageGoalSegmentDuration !== null && (averageGoalSegmentDuration < 18 || averageGoalSegmentDuration > 30) ? 8 : 0),
      ).toFixed(2));
  return {
    countedGoalsExpected: null,
    countedGoalsIncluded: Number.isFinite(Number(qa.countedGoalsIncluded)) ? Number(qa.countedGoalsIncluded) : null,
    countedGoalRecall,
    humanVisibleGoalsIncluded,
    humanVisibleGoalRecall,
    passedVisualGate,
    failedVisibleGoalSegments,
    visualGateFailures: failedVisibleGoalSegments,
    replayOnlySegments,
    replayOnlyGoalRate,
    averageGoalSegmentDuration,
    targetGoalSegmentDuration: Number.isFinite(Number(qa.targetGoalSegmentDuration)) ? Number(qa.targetGoalSegmentDuration) : null,
    referenceMaxGoalSegmentDuration: Number.isFinite(Number(qa.referenceMaxGoalSegmentDuration)) ? Number(qa.referenceMaxGoalSegmentDuration) : null,
    excessiveTailCount,
    excessiveTailRate,
    nonGoalFillerCount,
    nonGoalFillerRate,
    abruptCutRiskCount,
    boundarySmoothingAppliedCount,
    averagePreActionPaddingSeconds,
    averagePostConfirmationPaddingSeconds,
    cutSmoothnessScore,
    actionBoundaryScore,
    referencePacingScore,
    captionsAlignedCount,
    captionsMisalignedCount,
    visualPolishScore,
    referenceSimilarityNotes: Array.isArray(qa.referenceSimilarityNotes)
      ? qa.referenceSimilarityNotes.map((note) => safeString(note, 80)).filter(Boolean).slice(0, 8)
      : [],
    generatedVideoPath: outputMp4 && outputMp4.relativePath ? outputMp4.relativePath : null,
  };
}

function renderPolishQaFromSmoke(smoke) {
  const renderPlan = smoke?.renderPlan && typeof smoke.renderPlan === "object" ? smoke.renderPlan : {};
  const qa = renderPlan.renderPolishQA && typeof renderPlan.renderPolishQA === "object" && !Array.isArray(renderPlan.renderPolishQA)
    ? renderPlan.renderPolishQA
    : {};
  const transitionRenderedCount = Number.isFinite(Number(qa.transitionRenderedCount))
    ? Number(qa.transitionRenderedCount)
    : null;
  const hardCutFallbackCount = Number.isFinite(Number(qa.hardCutFallbackCount))
    ? Number(qa.hardCutFallbackCount)
    : null;
  const animatedCaptionCount = Number.isFinite(Number(qa.animatedCaptionCount))
    ? Number(qa.animatedCaptionCount)
    : null;
  const dynamicWordCaptionCount = Number.isFinite(Number(qa.dynamicWordCaptionCount))
    ? Number(qa.dynamicWordCaptionCount)
    : null;
  const overlayRenderedCount = Number.isFinite(Number(qa.overlayRenderedCount))
    ? Number(qa.overlayRenderedCount)
    : null;
  return {
    contractVersion: Number.isFinite(Number(qa.contractVersion)) ? Number(qa.contractVersion) : 1,
    renderStylePreset: safeString(qa.renderStylePreset || renderPlan.stylePreset || "", 80) || null,
    outputWidth: safeNumber(qa.outputWidth),
    outputHeight: safeNumber(qa.outputHeight),
    transitionMode: safeString(qa.transitionMode || "", 80) || null,
    transitionRenderedCount,
    hardCutFallbackCount,
    transitions: Array.isArray(qa.transitions)
      ? qa.transitions.slice(0, 8).map((transition, index) => ({
          index: index + 1,
          fromSegmentId: safeString(transition && transition.fromSegmentId, 64) || null,
          toSegmentId: safeString(transition && transition.toSegmentId, 64) || null,
          timelineStart: safeNumber(transition && transition.timelineStart),
          type: safeString(transition && transition.type, 60) || null,
          transitionDurationSeconds: safeNumber(transition && transition.transitionDurationSeconds),
          renderedBy: safeString(transition && transition.renderedBy, 80) || null,
        }))
      : [],
    animatedCaptionCount,
    dynamicWordCaptionCount,
    staticCaptionFallbackCount: Number.isFinite(Number(qa.staticCaptionFallbackCount))
      ? Number(qa.staticCaptionFallbackCount)
      : null,
    captionMotion: safeString(qa.captionMotion || "", 80) || null,
    overlayRenderedCount,
    overlayFallbackCount: Number.isFinite(Number(qa.overlayFallbackCount))
      ? Number(qa.overlayFallbackCount)
      : null,
    overlayMode: safeString(qa.overlayMode || "", 80) || null,
    visualPolishScore: Number.isFinite(Number(qa.visualPolishScore))
      ? Number(qa.visualPolishScore)
      : null,
    renderPolishWarnings: safeStringList(qa.renderPolishWarnings, 8, 80),
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
  const probed = probeVideoFile(target.resolvedFile);
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

function probeVideoFile(filePath) {
  const stats = statSync(filePath);
  const ffprobeBin = process.env.FFPROBE_PATH || "ffprobe";
  const result = spawnSync(ffprobeBin, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      readable: false,
      errorCode: result.error && result.error.code === "ENOENT" ? "FFPROBE_MISSING" : "FFPROBE_FAILED",
      sizeBytes: stats.size,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video") || {};
    const audio = streams.find((stream) => stream.codec_type === "audio") || null;
    return {
      readable: Boolean(video.codec_name),
      errorCode: video.codec_name ? null : "VIDEO_STREAM_MISSING",
      sizeBytes: stats.size,
      durationSeconds: safeNumber(parsed.format && parsed.format.duration),
      width: safeNumber(video.width),
      height: safeNumber(video.height),
      videoCodec: safeString(video.codec_name || "", 40) || null,
      audioPresent: Boolean(audio),
    };
  } catch {
    return {
      readable: false,
      errorCode: "FFPROBE_JSON_INVALID",
      sizeBytes: stats.size,
    };
  }
}

function buildComparisonReadiness({ source, outputMp4, ffprobe, coverage, reference, referenceStyleQA = null }) {
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
      humanVisibleGoals: coverage.expectedCountedGoals === null
        ? coverage.passedVisualGate
        : coverage.humanVisibleGoalsIncluded === coverage.expectedCountedGoals,
      livePhaseVsReplayOnly: coverage.replayOnlySegments === 0,
      noOffsideNoGoal: null,
      noHymnIntroFiller: null,
      cutSmoothness: referenceStyleQA && Number.isFinite(Number(referenceStyleQA.cutSmoothnessScore))
        ? Number(referenceStyleQA.cutSmoothnessScore) >= 0.9
        : null,
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
  const referenceStyleQA = referenceStyleQaFromSmoke(smoke, outputMp4);
  const renderPolishQA = renderPolishQaFromSmoke(smoke);
  const renderedSocialPolishQA = renderedSocialPolishProof({
    outputMp4,
    ffprobe,
    renderPlan: smoke?.renderPlan || null,
    videoOutputQA: smoke?.renderPlan?.videoOutputQA || null,
    generatedAt: nowIso(),
  });
  const visualFrameQA = analyzeRenderedVisualFrameQA({
    rootDir: ROOT_DIR,
    outputMp4,
    ffprobe,
    renderPlan: smoke?.renderPlan || null,
    renderedSocialPolishQA,
  });
  const countedGoalProof = smoke && smoke.renderPlan && smoke.renderPlan.countedGoalProof
    ? smoke.renderPlan.countedGoalProof
    : null;
  const countedGoalProofSummary = countedGoalProof && countedGoalProof.summary ? countedGoalProof.summary : null;
  referenceStyleQA.countedGoalsExpected = coverage.expectedCountedGoals;
  referenceStyleQA.countedGoalsIncluded = coverage.countedGoalsIncluded;
  referenceStyleQA.humanVisibleGoalsIncluded = coverage.humanVisibleGoalsIncluded;
  referenceStyleQA.humanVisibleGoalRecall = coverage.humanVisibleGoalRecall;
  referenceStyleQA.passedVisualGate = coverage.passedVisualGate;
  referenceStyleQA.failedVisibleGoalSegments = coverage.failedVisibleGoalSegments;
  referenceStyleQA.visualGateFailures = coverage.visualGateFailures;
  referenceStyleQA.replayOnlySegments = coverage.replayOnlySegments;
  const reference = String(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_REFERENCE") || "").trim();
  return {
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    outputMp4,
    ffprobe,
    countedGoalsFound: coverage.countedGoalsFound,
    countedGoalsIncluded: coverage.countedGoalsIncluded,
    humanVisibleGoalsIncluded: coverage.humanVisibleGoalsIncluded,
    humanVisibleGoalRecall: coverage.humanVisibleGoalRecall,
    passedVisualGate: coverage.passedVisualGate,
    scoreChangeAnchors: Array.isArray(countedGoalProof && countedGoalProof.scoreChangeAnchors)
      ? countedGoalProof.scoreChangeAnchors.map(safeScoreChangeAnchor).filter(Boolean).slice(0, 12)
      : [],
    stableScoreChangeAnchorCount: safeNumber(countedGoalProofSummary && countedGoalProofSummary.stableScoreChangeAnchorCount),
    revertedScoreChangeAnchorCount: safeNumber(countedGoalProofSummary && countedGoalProofSummary.revertedScoreChangeAnchorCount),
    anchorsLinkedToGoalPhaseCount: safeNumber(countedGoalProofSummary && countedGoalProofSummary.anchorsLinkedToGoalPhaseCount),
    anchorsMissingVisualSupportCount: safeNumber(countedGoalProofSummary && countedGoalProofSummary.anchorsMissingVisualSupportCount),
    failedVisibleGoalSegments: coverage.failedVisibleGoalSegments,
    visualGateFailures: coverage.visualGateFailures,
    expectedCountedGoals: coverage.expectedCountedGoals,
    replayOnlySegments: coverage.replayOnlySegments,
    averageGoalSegmentDuration: referenceStyleQA.averageGoalSegmentDuration,
    targetGoalSegmentDuration: referenceStyleQA.targetGoalSegmentDuration,
    referenceMaxGoalSegmentDuration: referenceStyleQA.referenceMaxGoalSegmentDuration,
    excessiveTailCount: referenceStyleQA.excessiveTailCount,
    excessiveTailRate: referenceStyleQA.excessiveTailRate,
    nonGoalFillerCount: referenceStyleQA.nonGoalFillerCount,
    nonGoalFillerRate: referenceStyleQA.nonGoalFillerRate,
    replayOnlyGoalRate: referenceStyleQA.replayOnlyGoalRate,
    abruptCutRiskCount: referenceStyleQA.abruptCutRiskCount,
    boundarySmoothingAppliedCount: referenceStyleQA.boundarySmoothingAppliedCount,
    averagePreActionPaddingSeconds: referenceStyleQA.averagePreActionPaddingSeconds,
    averagePostConfirmationPaddingSeconds: referenceStyleQA.averagePostConfirmationPaddingSeconds,
    cutSmoothnessScore: referenceStyleQA.cutSmoothnessScore,
    actionBoundaryScore: referenceStyleQA.actionBoundaryScore,
    referencePacingScore: referenceStyleQA.referencePacingScore,
    captionsAlignedCount: referenceStyleQA.captionsAlignedCount,
    captionsMisalignedCount: referenceStyleQA.captionsMisalignedCount,
    visualPolishScore: referenceStyleQA.visualPolishScore,
    transitionRenderedCount: renderPolishQA.transitionRenderedCount,
    hardCutFallbackCount: renderPolishQA.hardCutFallbackCount,
    animatedCaptionCount: renderPolishQA.animatedCaptionCount,
    staticCaptionFallbackCount: renderPolishQA.staticCaptionFallbackCount,
    overlayRenderedCount: renderPolishQA.overlayRenderedCount,
    overlayFallbackCount: renderPolishQA.overlayFallbackCount,
    renderStylePreset: renderPolishQA.renderStylePreset,
    dynamicWordCaptionCount: renderedSocialPolishQA.dynamicCaptions?.dynamicWordCaptionCount ?? null,
    openingHookCaptionRendered: renderedSocialPolishQA.dynamicCaptions?.openingHookCaptionRendered ?? null,
    avgWordsPerBeat: renderedSocialPolishQA.dynamicCaptions?.avgWordsPerBeat ?? null,
    maxCaptionBeatDuration: renderedSocialPolishQA.dynamicCaptions?.maxCaptionBeatDuration ?? null,
    captionSafeArea: renderedSocialPolishQA.dynamicCaptions?.captionSafeArea || [],
    textObstructionRisk: renderedSocialPolishQA.dynamicCaptions?.textObstructionRisk ?? null,
    hookFirstTwoSecondsPassed: renderedSocialPolishQA.renderedHook?.passed ?? false,
    socialPolishScore: renderedSocialPolishQA.socialPolishScore,
    rightsSafeStyleScore: renderedSocialPolishQA.rightsSafeStyle?.rightsSafeStyleScore ?? null,
    renderPolishWarnings: renderPolishQA.renderPolishWarnings,
    referenceSimilarityNotes: referenceStyleQA.referenceSimilarityNotes,
    generatedVideoPath: referenceStyleQA.generatedVideoPath,
    referenceStyleQA,
    renderPolishQA,
    renderedSocialPolishQA,
    visualFrameQA,
    actionFramingVerdict: renderedSocialPolishQA.renderedActionFraming || null,
    referenceStyleComparisonSummary: renderedSocialPolishQA.referenceStyleComparison || null,
    segmentWindows: coverage.segmentWindows,
    staleArtifactCleanup,
    comparison: buildComparisonReadiness({ source, outputMp4, ffprobe, coverage, reference, referenceStyleQA }),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function latestGoalDiscoveryEvent(serverEvents = []) {
  if (!Array.isArray(serverEvents)) return null;
  return [...serverEvents].reverse().find((event) => event && event.goalDiscovery) || null;
}

function goalDiscoveryFromSmokeFailure(failure = null) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const hasPlanningEvidence =
    failure.code === "NO_VALID_GOALS_FOUND" ||
    failure.candidateCount !== null ||
    failure.scoreChangesFound !== null ||
    (Array.isArray(failure.goalEvidenceCandidates) && failure.goalEvidenceCandidates.length > 0);
  if (!hasPlanningEvidence) return null;
  return {
    sourceValidated: safeBoolean(failure.sourceValidated),
    downloadedSourceReady: safeBoolean(failure.downloadedSourceReady),
    sourceDuration: safeNumber(failure.sourceDuration),
    scoreboardOcrAttempted: safeBoolean(failure.scoreboardOcrAttempted),
    scoreboardOcrEnabled: safeBoolean(failure.scoreboardOcrEnabled),
    scoreboardOcrProviderMode: safeString(failure.scoreboardOcrProviderMode, 80),
    scoreboardObservationCount: safeNumber(failure.scoreboardObservationCount),
    scoreboardSampledFrameCount: safeNumber(failure.scoreboardSampledFrameCount),
    scoreChangeCount: safeNumber(failure.scoreChangeCount),
    stableScoreChangeCount: safeNumber(failure.stableScoreChangeCount),
    scoreChangesFound: safeNumber(failure.scoreChangesFound),
    chunksScanned: safeNumber(failure.chunksScanned),
    countedGoalEventCount: safeNumber(failure.countedGoalEventCount),
    discoveredCountedGoals: safeNumber(failure.discoveredCountedGoals),
    expectedCountedGoals: safeNumber(failure.expectedCountedGoals),
    visualWindowCount: safeNumber(failure.visualWindowCount),
    bucketCount: safeNumber(failure.bucketCount),
    lateBucketInspected: safeBoolean(failure.lateBucketInspected),
    selectedValidGoalCount: safeNumber(failure.selectedValidGoalCount),
    candidateCount: safeNumber(failure.candidateCount),
    rejectedCandidateCount: safeNumber(failure.rejectedCandidateCount),
    topRejectionReasons: Array.isArray(failure.topRejectionReasons)
      ? failure.topRejectionReasons.map((item) => ({
          reason: safeString(item && item.reason, 80),
          count: safeNumber(item && item.count),
        })).filter((item) => item.reason).slice(0, 8)
      : [],
    missingEvidenceByCandidate: Array.isArray(failure.missingEvidenceByCandidate)
      ? failure.missingEvidenceByCandidate.map(safeMissingEvidenceCandidate).filter(Boolean).slice(0, 12)
      : [],
    goalEvidenceCandidates: Array.isArray(failure.goalEvidenceCandidates)
      ? failure.goalEvidenceCandidates.map(safeGoalEvidenceCandidate).filter(Boolean).slice(0, 12)
      : [],
    nextAction: failure.nextAction ? safeString(failure.nextAction, 180) : null,
  };
}

function latestScoreboardOcrEvent(serverEvents = []) {
  if (!Array.isArray(serverEvents)) return null;
  return [...serverEvents].reverse().find((event) => event && event.scoreboardOcr) || null;
}

function latestProgressMetaEvent(serverEvents = []) {
  if (!Array.isArray(serverEvents)) return null;
  return [...serverEvents].reverse().find((event) => event && event.progressMeta) || null;
}

function stableScoreChangeCountFromOcr(scoreboardOcr = null) {
  if (!scoreboardOcr || typeof scoreboardOcr !== "object") return 0;
  return (Array.isArray(scoreboardOcr.scoreTimeline) ? scoreboardOcr.scoreTimeline : [])
    .filter((item) => item && item.status === "score_changed" && item.temporalConsistency)
    .length;
}

function scorebugDebugFromChunkSummary(chunkSummary = null) {
  const summary = safeOcrChunkSummary(chunkSummary);
  if (!summary || !Array.isArray(summary.chunks) || !summary.chunks.length) return null;
  const attemptedRoiIds = [...new Set(summary.chunks.flatMap((chunk) => Array.isArray(chunk.roiCandidateIds) ? chunk.roiCandidateIds : []))]
    .filter(Boolean)
    .slice(0, 8);
  const attemptedObservationCount = summary.chunks.reduce((sum, chunk) => sum + Number(chunk.attemptedObservationCount || 0), 0);
  if (!attemptedRoiIds.length && !attemptedObservationCount) return null;
  const timedOutChunks = summary.chunks.filter((chunk) => chunk.status === "timed_out").length;
  const failedChunks = summary.chunks.filter((chunk) => chunk.status === "failed").length;
  const readableObservationCount = summary.chunks.reduce((sum, chunk) => sum + Number(chunk.readableObservationCount || 0), 0);
  const textPresentObservationCount = summary.chunks.reduce((sum, chunk) => sum + Number(chunk.textPresentObservationCount || 0), 0);
  const scoreChangeCount = summary.chunks.reduce((sum, chunk) => sum + Number(chunk.scoreChangeCount || 0), 0);
  const state = scoreChangeCount > 0
    ? "score_changes_detected"
    : timedOutChunks > 0 && summary.scannedChunks === 0
      ? "scorebug_all_chunks_timed_out"
      : timedOutChunks > 0 || failedChunks > 0
        ? "scorebug_partial_chunk_failures"
        : readableObservationCount > 0
          ? "scorebug_static_or_ambiguous"
          : "scorebug_unreadable";
  return {
    attemptedRoiCount: attemptedRoiIds.length,
    attemptedObservationCount,
    textPresentObservationCount,
    readableObservationCount,
    state,
    nextAction: scoreChangeCount > 0
      ? "feed-scorebug-score-changes-into-match-event-truth"
      : "enable-scoreboard-ocr-qa-artifacts-and-inspect-crops-for-wrong-roi-or-small-scorebug",
    qaRecommended: scoreChangeCount === 0,
    reasonCodes: [
      "chunked_scorebug_first_ocr",
      "scorebug_roi_candidates_attempted",
      ...(timedOutChunks > 0 ? ["scorebug_chunk_timeout_recorded"] : []),
      ...(failedChunks > 0 ? ["scorebug_chunk_failure_recorded"] : []),
      ...(scoreChangeCount > 0 ? ["score_changes_detected"] : ["scorebug_no_readable_roi"]),
    ],
    selectedRoi: null,
    rejectedRois: attemptedRoiIds.map((regionId) => ({
      regionId: safeString(regionId, 80),
      layoutId: null,
      observationCount: summary.chunks
        .filter((chunk) => Array.isArray(chunk.roiCandidateIds) && chunk.roiCandidateIds.includes(regionId))
        .reduce((sum, chunk) => sum + Number(chunk.plannedFrameCount || 0), 0),
      readableObservationCount: 0,
      scoreChangeCount: 0,
      diagnosis: scoreChangeCount > 0 ? "score_changes_detected_elsewhere" : "scorebug_unreadable",
      reasonCodes: scoreChangeCount > 0 ? ["lower_roi_score_than_selected"] : ["scorebug_no_readable_roi"],
    })),
  };
}

function scoreboardOcrEnabledForProof(scoreboardOcr = null) {
  const mode = safeString(scoreboardOcr && scoreboardOcr.providerMode, 80);
  return Boolean(mode) && ![
    "deterministic-scoreboard-ocr",
    "external-scoreboard-ocr-disabled",
  ].includes(mode);
}

function evidenceRecoveryNextAction(discovery = null, scoreboardOcr = null, smokeFailure = null) {
  const configured = discovery && discovery.nextAction ? safeString(discovery.nextAction, 180) : null;
  if (configured) return configured;
  if (!discovery && smokeFailure) {
    return smokeFailure.nextAction
      ? safeString(smokeFailure.nextAction, 180)
      : nextActionForCode(smokeFailure.code || "YOUTUBE_LIVE_E2E_SMOKE_FAILED");
  }
  if (!scoreboardOcrEnabledForProof(scoreboardOcr)) {
    return "enable-live-scoreboard-ocr-with-SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR-1-and-local-ocr-runtime";
  }
  if (!safeNumber(scoreboardOcr && scoreboardOcr.evidenceCount)) {
    return "inspect-scoreboard-ocr-crops-or-enable-SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS-1-for-local-debug";
  }
  if (!stableScoreChangeCountFromOcr(scoreboardOcr)) {
    return "inspect-score-timeline-for-unreadable-or-ambiguous-scorebug";
  }
  return "connect-stable-score-changes-to-live-action-windows-before-render";
}

function ingestDiagnosticsFromFailure(failure = null) {
  if (!failure || failure.phase !== "ingest") return null;
  return {
    phase: "ingest",
    step: failure.step ? safeString(failure.step, 80) : null,
    substep: failure.substep ? safeString(failure.substep, 80) : null,
    code: failure.code ? safeString(failure.code, 80) : null,
    elapsedMs: safeNumber(failure.elapsedMs),
    timeoutMs: safeNumber(failure.timeoutMs),
    attempts: safeNumber(failure.attempts),
    attemptsConfigured: safeNumber(failure.attemptsConfigured),
    retryable: safeBoolean(failure.retryable),
    authorizedImportRequired: safeBoolean(failure.authorizedImportRequired),
    fallbackUsed: safeBoolean(failure.fallbackUsed),
    formatSelector: failure.formatSelector ? safeString(failure.formatSelector, 180) : null,
    fallbackFormatSelector: failure.fallbackFormatSelector ? safeString(failure.fallbackFormatSelector, 180) : null,
    playerClient: failure.playerClient ? safeString(failure.playerClient, 40) : null,
    sourceAcquisitionStatus: failure.sourceAcquisitionStatus ? safeString(failure.sourceAcquisitionStatus, 80) : null,
    sourceAcquisitionStrategy: failure.sourceAcquisitionStrategy ? safeString(failure.sourceAcquisitionStrategy, 80) : null,
    cacheChecked: safeBoolean(failure.cacheChecked),
    cacheHit: safeBoolean(failure.cacheHit),
    cacheValidated: safeBoolean(failure.cacheValidated),
    cacheFailureCode: failure.cacheFailureCode ? safeString(failure.cacheFailureCode, 80) : null,
    downloaderFallbackUsed: safeBoolean(failure.downloaderFallbackUsed),
    checksumSha256: typeof failure.checksumSha256 === "string" && /^[a-f0-9]{64}$/.test(failure.checksumSha256)
      ? failure.checksumSha256
      : null,
    stallClassification: failure.stallClassification ? safeString(failure.stallClassification, 80) : null,
    heartbeatIntervalMs: safeNumber(failure.heartbeatIntervalMs),
    noProgressTimeoutMs: safeNumber(failure.noProgressTimeoutMs),
    progressHeartbeatCount: safeNumber(failure.progressHeartbeatCount),
    progressEventCount: safeNumber(failure.progressEventCount),
    progressBytesObserved: safeNumber(failure.progressBytesObserved),
    lastProgressAgeMs: safeNumber(failure.lastProgressAgeMs),
    timeoutClassification: failure.timeoutClassification ? safeString(failure.timeoutClassification, 80) : null,
    bytesStillMovingAtTimeout: safeBoolean(failure.bytesStillMovingAtTimeout),
    continueEnabled: safeBoolean(failure.continueEnabled),
    continueAttempted: safeBoolean(failure.continueAttempted),
    resumableStateEnabled: safeBoolean(failure.resumableStateEnabled),
    resumeStateRetained: safeBoolean(failure.resumeStateRetained),
    metadataPreflightStatus: failure.metadataPreflightStatus ? safeString(failure.metadataPreflightStatus, 80) : null,
    metadataPreflightDurationSeconds: safeNumber(failure.metadataPreflightDurationSeconds),
    cleanupSucceeded: safeBoolean(failure.cleanupSucceeded),
    partialCleanupSucceeded: safeBoolean(failure.partialCleanupSucceeded),
    partialCleanupRemovedCount: safeNumber(failure.partialCleanupRemovedCount),
    downloadedOutputReady: safeBoolean(failure.downloadedOutputReady),
    outputMp4Created: false,
    nextAction: failure.nextAction ? safeString(failure.nextAction, 180) : null,
  };
}

function latestVideoOutputQAFromSmoke(smoke) {
  if (!smoke || typeof smoke !== "object") return null;
  const lifecycle = Array.isArray(smoke.jobLifecycle) ? smoke.jobLifecycle : [];
  const snapshot = [...lifecycle].reverse().find((item) => item && item.videoOutputQA);
  return snapshot?.videoOutputQA || smoke.failedCases?.[0]?.videoOutputQA || null;
}

function buildFailedOutputProof({ env, source, smoke = null, serverEvents, staleArtifactCleanup }) {
  const event = latestGoalDiscoveryEvent(serverEvents);
  const smokeFailure = smoke?.failedCases?.[0] || null;
  const discovery = event?.goalDiscovery || goalDiscoveryFromSmokeFailure(smokeFailure);
  const ocrEvent = latestScoreboardOcrEvent(serverEvents);
  const latestSmokeJob = latestJobSnapshotFromSmoke(smoke);
  const scoreboardOcr = ocrEvent?.scoreboardOcr ||
    safeScoreboardOcrEvent(smokeFailure?.currentJob?.scoreboardOcr) ||
    safeScoreboardOcrEvent(latestSmokeJob?.scoreboardOcr) ||
    null;
  const serverProgressMeta = latestProgressMetaEvent(serverEvents)?.progressMeta || null;
  const smokeFailureStep = Array.isArray(smoke?.steps)
    ? [...smoke.steps].reverse().find((step) => step && step.status === "failed")
    : null;
  const progressMeta = smokeFailure && smokeFailure.currentJob && smokeFailure.currentJob.progressMeta
    ? smokeFailure.currentJob.progressMeta
    : latestSmokeJob && latestSmokeJob.progressMeta
      ? latestSmokeJob.progressMeta
    : serverProgressMeta && serverProgressMeta.chunkCount
      ? serverProgressMeta
      : null;
  const progressLooksLikeScoreboardOcr = progressMeta &&
    (progressMeta.step === "run_scorebug_ocr" ||
      progressMeta.scorebugFirst === true ||
      Number.isFinite(Number(progressMeta.chunkCount)));
  const failureLooksLikeScoreboardOcr = smokeFailure &&
    (smokeFailure.step === "run_scorebug_ocr" ||
      smokeFailure.step === "run_scoreboard_ocr" ||
      (typeof smokeFailure.substep === "string" && smokeFailure.substep.startsWith("scorebug_")));
  const outputQA = latestVideoOutputQAFromSmoke(smoke);
  const outputExpectedGoalCount = Number.isFinite(Number(outputQA?.expectedGoalCount))
    ? Number(outputQA.expectedGoalCount)
    : null;
  const discoverySelectedGoalCount = Number.isFinite(Number(discovery?.selectedValidGoalCount))
    ? Number(discovery.selectedValidGoalCount)
    : null;
  const countedGoalsFound = outputExpectedGoalCount ?? discoverySelectedGoalCount ?? 0;
  const actualConfirmedGoalSegmentCount = Number.isFinite(Number(outputQA?.actualConfirmedGoalSegmentCount))
    ? Number(outputQA.actualConfirmedGoalSegmentCount)
    : 0;
  const coveredGoalCount = Number.isFinite(Number(outputQA?.coveredGoalCount))
    ? Number(outputQA.coveredGoalCount)
    : 0;
  const expectedCountedGoals = expectedCountedGoalsForSource(source, env);
  const coverage = {
    countedGoalsFound,
    countedGoalsIncluded: actualConfirmedGoalSegmentCount,
    expectedCountedGoals,
    replayOnlySegments: 0,
  };
  const scoreboardOcrAttempted = discovery &&
    discovery.scoreboardOcrAttempted !== undefined &&
    discovery.scoreboardOcrAttempted !== null
    ? Boolean(discovery.scoreboardOcrAttempted)
    : Boolean(scoreboardOcr || progressLooksLikeScoreboardOcr || failureLooksLikeScoreboardOcr);
  const scoreboardOcrEnabled = discovery &&
    discovery.scoreboardOcrEnabled !== undefined &&
    discovery.scoreboardOcrEnabled !== null
    ? Boolean(discovery.scoreboardOcrEnabled)
    : Boolean(scoreboardOcrEnabledForProof(scoreboardOcr) || progressLooksLikeScoreboardOcr || failureLooksLikeScoreboardOcr);
  const scoreboardObservationCount = safeNumber(discovery && discovery.scoreboardObservationCount) ??
    safeNumber(scoreboardOcr && scoreboardOcr.evidenceCount) ??
    0;
  const scoreChangeCount = safeNumber(discovery && discovery.scoreChangeCount) ??
    safeNumber(scoreboardOcr && scoreboardOcr.scoreChangeCount) ??
    0;
  const stableScoreChangeCount = safeNumber(discovery && discovery.stableScoreChangeCount) ??
    stableScoreChangeCountFromOcr(scoreboardOcr);
  const scoreboardOcrProviderMode = discovery?.scoreboardOcrProviderMode ||
    scoreboardOcr?.providerMode ||
    (progressLooksLikeScoreboardOcr || failureLooksLikeScoreboardOcr ? "chunked-scoreboard-ocr" : null);
  const ocrChunkSummary = scoreboardOcr && scoreboardOcr.chunkSummary
    ? scoreboardOcr.chunkSummary
    : progressMeta && progressMeta.chunkCount
      ? {
          mode: "chunked_scorebug_first_ocr",
          chunkCount: safeNumber(progressMeta.chunkCount),
          scannedChunks: safeNumber(progressMeta.scannedChunks),
          skippedChunks: null,
          scannedDurationSeconds: null,
          discoveredScoreChanges: safeNumber(progressMeta.discoveredScoreChanges),
          totalBudgetMs: safeNumber(progressMeta.totalBudgetMs),
          chunkTimeoutMs: safeNumber(progressMeta.chunkTimeoutMs),
          chunks: [{
            index: safeNumber(progressMeta.chunkIndex),
            start: safeNumber(progressMeta.chunkStart),
            end: safeNumber(progressMeta.chunkEnd),
            status: smokeFailure?.code === "SCOREBOARD_OCR_TIMEOUT" ? "timed_out" : "active",
            plannedFrameCount: Array.isArray(progressMeta.sampledFrameTimestamps) ? progressMeta.sampledFrameTimestamps.length : null,
            sampledFrameCount: null,
            sampledFrameTimestamps: progressMeta.sampledFrameTimestamps || [],
            roiCandidateIds: progressMeta.roiCandidateIds || [],
            attemptedRoiCount: Array.isArray(progressMeta.roiCandidateIds) ? progressMeta.roiCandidateIds.length : null,
            attemptedObservationCount: Array.isArray(progressMeta.sampledFrameTimestamps) && Array.isArray(progressMeta.roiCandidateIds)
              ? progressMeta.sampledFrameTimestamps.length * progressMeta.roiCandidateIds.length
              : null,
            roiDetected: false,
            selectedRoiId: null,
            ocrTextCandidateCount: null,
            textPresentObservationCount: null,
            readableObservationCount: null,
            clockOnlyObservationCount: null,
            rejectedObservationCount: null,
            stableScoreDecision: smokeFailure?.code === "SCOREBOARD_OCR_TIMEOUT" ? "timed_out" : "active_scan",
            normalizedScoreCandidates: [],
            rejectedScoreCandidateReasons: smokeFailure?.code ? [safeString(smokeFailure.code, 80)] : [],
            evidenceCount: null,
            scoreChangeCount: null,
            skippedReason: smokeFailure?.code || null,
            nextAction: smokeFailure?.code === "SCOREBOARD_OCR_TIMEOUT"
              ? "reduce-scorebug-ocr-workload-or-enable-scoreboard-ocr-qa-artifacts"
              : "wait-for-terminal-scorebug-chunk-report-or-increase-smoke-job-timeout",
          }],
        }
      : null;
  const countedGoalEventCount = safeNumber(discovery && discovery.countedGoalEventCount) ??
    safeNumber(discovery && discovery.matchEventTruthCountedGoalEventCount) ??
    0;
  const scoreChangeAnchors = Array.isArray(discovery && discovery.matchEventTruthScoreChangeAnchors)
    ? discovery.matchEventTruthScoreChangeAnchors.map(safeScoreChangeAnchor).filter(Boolean).slice(0, 12)
    : [];
  const missingEvidenceByCandidate = Array.isArray(discovery && discovery.missingEvidenceByCandidate) &&
    discovery.missingEvidenceByCandidate.length > 0
    ? discovery.missingEvidenceByCandidate
    : Array.isArray(discovery && discovery.goalEvidenceCandidates)
      ? discovery.goalEvidenceCandidates
        .map(safeMissingEvidenceCandidate)
        .filter((candidate) => candidate && (candidate.missingEvidence.length || candidate.rejectionReason))
        .slice(0, 12)
      : [];
  const nextAction = evidenceRecoveryNextAction(discovery, scoreboardOcr, smokeFailure);
  const ingestDiagnostics = ingestDiagnosticsFromFailure(smokeFailure);
  return {
    schemaVersion: LIVE_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    phase: smokeFailure?.phase || smokeFailureStep?.step || (discovery ? "render" : "pre-render"),
    step: smokeFailure?.step || smokeFailureStep?.activeStep || smokeFailureStep?.step || null,
    substep: smokeFailure?.substep || smokeFailureStep?.substep || null,
    code: smokeFailure?.code || null,
    source: source ? { sourceType: "youtube", kind: source.kind, videoId: source.videoId } : null,
    outputMp4: null,
    ffprobe: {
      checked: false,
      status: "skipped",
      code: "OUTPUT_MP4_NOT_CREATED",
    },
    countedGoalsFound,
    countedGoalsIncluded: actualConfirmedGoalSegmentCount,
    actualConfirmedGoalSegmentCount,
    coveredGoalCount,
    missingGoalNumbers: Array.isArray(outputQA?.missingGoalNumbers) ? outputQA.missingGoalNumbers : [],
    failedReasons: Array.isArray(outputQA?.failedReasons) ? outputQA.failedReasons : [],
    ingest: ingestDiagnostics,
    scoreboardOcrAttempted,
    scoreboardOcrEnabled,
    scoreboardOcrProviderMode,
    ocrChunkSummary,
    scorebugDebug: scoreboardOcr?.scorebugDebug || scorebugDebugFromChunkSummary(ocrChunkSummary),
    scoreboardObservationCount,
    scoreboardSampledFrameCount: safeNumber(discovery && discovery.scoreboardSampledFrameCount) ??
      safeNumber(scoreboardOcr && scoreboardOcr.sampledFrameCount) ??
      0,
    scoreChangeCount,
    stableScoreChangeCount,
    countedGoalEventCount,
    scoreChangeAnchors,
    stableScoreChangeAnchorCount: safeNumber(discovery && discovery.matchEventTruthStableScoreChangeAnchorCount),
    revertedScoreChangeAnchorCount: safeNumber(discovery && discovery.matchEventTruthRevertedScoreChangeAnchorCount),
    anchorsLinkedToGoalPhaseCount: safeNumber(discovery && discovery.matchEventTruthAnchorsLinkedToGoalPhaseCount),
    anchorsMissingVisualSupportCount: safeNumber(discovery && discovery.matchEventTruthAnchorsMissingVisualSupportCount),
    missingEvidenceByCandidate,
    nextAction,
    expectedCountedGoals,
    replayOnlySegments: 0,
    videoOutputQA: outputQA,
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
    downloadTimeoutMs: Number.isFinite(Number(live.downloadTimeoutMs)) ? Number(live.downloadTimeoutMs) : null,
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
    outputProof: null,
    currentJob: null,
    logsDownloaded: false,
    artifactsDownloaded: false,
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

function latestJobSnapshotFromSmoke(smoke) {
  if (!smoke || typeof smoke !== "object") return null;
  const failedJob = smoke.failedCases?.[0]?.currentJob;
  if (failedJob) return safeCurrentJobSnapshot(failedJob);
  const lifecycle = Array.isArray(smoke.jobLifecycle) ? smoke.jobLifecycle : [];
  const snapshot = [...lifecycle].reverse().find((item) => item && typeof item === "object");
  return safeCurrentJobSnapshot(snapshot);
}

function currentJobFromProgressEvent(serverEvents = []) {
  const progressMeta = latestProgressMetaEvent(serverEvents)?.progressMeta || null;
  if (!progressMeta) return null;
  return safeCurrentJobSnapshot({
    status: "processing",
    progress: null,
    step: progressMeta.step || "live_proof",
    progressMeta,
  });
}

function currentJobFromContext({ smoke, serverEvents }) {
  return latestJobSnapshotFromSmoke(smoke) || currentJobFromProgressEvent(serverEvents);
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
    ? buildFailedOutputProof({ env: env || {}, source, smoke, serverEvents, staleArtifactCleanup })
    : null);
  const safeServerEvents = sanitizeServerEvents(serverEvents);
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
    currentJob: status === "failed" ? currentJobFromContext({ smoke, serverEvents: safeServerEvents }) : null,
    staleArtifactCleanup: staleArtifactCleanup || null,
    logsDownloaded: false,
    artifactsDownloaded: false,
    serverEvents: safeServerEvents,
    failedCases,
  });
}

function liveProofTimeoutError({ started, timeoutMs, phase = PHASES.RENDER, step = "live_proof", substep = null }) {
  return new YouTubeLiveE2EError(
    "YOUTUBE_LIVE_E2E_TIMEOUT",
    "Live YouTube E2E exceeded the configured proof timeout.",
    {
      phase,
      step,
      substep,
      elapsedMs: Date.now() - started,
      timeoutMs,
      nextAction: nextActionForCode("YOUTUBE_LIVE_E2E_TIMEOUT"),
    },
  );
}

async function withLiveProofDeadline(work, { deadlineAt, started, timeoutMs, phase, step, substep = null }) {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs <= 0) {
    throw liveProofTimeoutError({ started, timeoutMs, phase, step, substep });
  }
  let timeoutId = null;
  const workPromise = Promise.resolve().then(work);
  workPromise.catch(() => {
    // The race may already have failed on timeout. Keep late worker rejection out of process-level noise.
  });
  try {
    return await Promise.race([
      workPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(liveProofTimeoutError({ started, timeoutMs, phase, step, substep }));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
      "ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED",
      "Live YouTube E2E requires explicit ingest enablement.",
    );
  }
  if (!boolFromEnv(rawValue(env, LIVE_RIGHTS_FLAG))) {
    throw new YouTubeLiveE2EError(
      "ENV_YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED",
      "Live YouTube E2E requires explicit rights confirmation.",
    );
  }
  let source;
  try {
    source = validateSmokeSource(liveSourceEnv(env));
  } catch (error) {
    const mappedCode = {
      YOUTUBE_SMOKE_URL_MISSING: "ENV_YOUTUBE_LIVE_E2E_URL_MISSING",
      YOUTUBE_URL_INVALID: "ENV_YOUTUBE_LIVE_E2E_URL_INVALID",
      YOUTUBE_PLAYLIST_UNSUPPORTED: "ENV_YOUTUBE_LIVE_E2E_URL_INVALID",
      YOUTUBE_LIVE_UNSUPPORTED: "ENV_YOUTUBE_LIVE_E2E_URL_INVALID",
      YOUTUBE_SMOKE_URL_NOT_ALLOWED: "ENV_YOUTUBE_LIVE_E2E_URL_NOT_ALLOWED",
    }[error?.code] || "ENV_YOUTUBE_LIVE_E2E_URL_INVALID";
    throw new YouTubeLiveE2EError(
      mappedCode,
      "Live YouTube E2E source configuration is not ready.",
    );
  }
  const downloadTimeoutMs = parseLiveDownloadTimeoutMs(env);
  return {
    skipped: false,
    source,
    downloadTimeoutMs,
  };
}

function smokeEnvForLive(env, baseUrl) {
  return {
    ...env,
    ...liveScoreboardOcrJobTimeoutEnv(env),
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

function liveServerEnvironment({ port, dataDir, env = {} } = {}) {
  const scoreboardOcrEnabled = liveScoreboardOcrEnabled(env);
  const scoreboardOcrQaEnabled = liveScoreboardOcrQaEnabled(env);
  const liveDownloadTimeoutMs = parseLiveDownloadTimeoutMs(env);
  const timeoutEnv = liveDownloadTimeoutMs
    ? { ...env, SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS: String(liveDownloadTimeoutMs) }
    : env;
  return {
    ...process.env,
    ...env,
    ...(liveDownloadTimeoutMs
      ? {
          SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS: String(liveDownloadTimeoutMs),
          SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS: String(liveDownloadTimeoutMs),
        }
      : {}),
    ...(scoreboardOcrEnabled
      ? {
          SHORTSENGINE_SCOREBOARD_OCR_ENABLED: "1",
          SHORTSENGINE_SCOREBOARD_OCR_PROVIDER: String(
            rawValue(env, "SHORTSENGINE_SCOREBOARD_OCR_PROVIDER") || "local",
          ),
        }
      : {}),
    ...(scoreboardOcrQaEnabled
      ? {
          SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS: "1",
        }
      : {}),
    ...liveScoreboardOcrJobTimeoutEnv(env),
    MATCHCUTS_DATA_DIR: dataDir,
    PORT: String(port),
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS: String(computedIngestRequestTimeoutMs(timeoutEnv)),
    MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
  };
}

function startServer(port, env) {
  const tmpRoot = resolve(ROOT_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dataDir = mkdtempSync(resolve(tmpRoot, "shortsengine-youtube-live-data-"));
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: liveServerEnvironment({ port, dataDir, env }),
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
        const parsedProgressMeta = safeProgressMeta(parsed.progressMeta || parsed);
        if (hasProgressMetaFields(parsedProgressMeta)) {
          event.progressMeta = parsedProgressMeta;
        }
        if (parsed.event === "valid_goal_selection_empty") {
          event.goalDiscovery = {
            sourceValidated: safeBoolean(parsed.sourceValidated),
            downloadedSourceReady: safeBoolean(parsed.downloadedSourceReady),
            sourceDuration: safeNumber(parsed.sourceDuration),
            scoreboardOcrAttempted: safeBoolean(parsed.scoreboardOcrAttempted),
            scoreboardOcrEnabled: safeBoolean(parsed.scoreboardOcrEnabled),
            scoreboardOcrProviderMode: safeString(parsed.scoreboardOcrProviderMode, 80),
            scoreboardObservationCount: safeNumber(parsed.scoreboardObservationCount),
            scoreboardSampledFrameCount: safeNumber(parsed.scoreboardSampledFrameCount),
            scoreChangeCount: safeNumber(parsed.scoreChangeCount),
            stableScoreChangeCount: safeNumber(parsed.stableScoreChangeCount),
            scoreChangesFound: safeNumber(parsed.scoreChangesFound),
            chunksScanned: safeNumber(parsed.chunksScanned),
            countedGoalEventCount: safeNumber(parsed.countedGoalEventCount),
            discoveredCountedGoals: safeNumber(parsed.discoveredCountedGoals),
            expectedCountedGoals: safeNumber(parsed.expectedCountedGoals),
            visualWindowCount: safeNumber(parsed.visualWindowCount),
            bucketCount: safeNumber(parsed.bucketCount),
            lateBucketInspected: safeBoolean(parsed.lateBucketInspected),
            selectedValidGoalCount: safeNumber(parsed.selectedValidGoalCount),
            candidateCount: safeNumber(parsed.candidateCount),
            rejectedCandidateCount: safeNumber(parsed.rejectedCandidateCount),
            topRejectionReasons: Array.isArray(parsed.topRejectionReasons)
              ? parsed.topRejectionReasons.map((item) => ({
                  reason: safeString(item && item.reason, 80),
                  count: safeNumber(item && item.count),
                })).filter((item) => item.reason).slice(0, 8)
              : [],
            excludedOffsideOrNoGoalCount: safeNumber(parsed.excludedOffsideOrNoGoalCount),
            excludedUnconfirmedBallInNetCount: safeNumber(parsed.excludedUnconfirmedBallInNetCount),
            goalEvidenceEventCount: safeNumber(parsed.goalEvidenceEventCount),
            validGoalEvidenceCount: safeNumber(parsed.validGoalEvidenceCount),
            offsideOrNoGoalEvidenceCount: safeNumber(parsed.offsideOrNoGoalEvidenceCount),
            celebrationOnlyEvidenceCount: safeNumber(parsed.celebrationOnlyEvidenceCount),
            anthemOrIntroEvidenceCount: safeNumber(parsed.anthemOrIntroEvidenceCount),
            ocrEvidenceCount: safeNumber(parsed.ocrEvidenceCount),
            scoreboardConfirmedGoalCount: safeNumber(parsed.scoreboardConfirmedGoalCount),
            recoverableGoalEvidenceCandidateCount: safeNumber(parsed.recoverableGoalEvidenceCandidateCount),
            rejectedGoalEvidenceCandidateCount: safeNumber(parsed.rejectedGoalEvidenceCandidateCount),
            matchEventTruthConfirmedGoalCount: safeNumber(parsed.matchEventTruthConfirmedGoalCount),
            matchEventTruthDisallowedGoalCount: safeNumber(parsed.matchEventTruthDisallowedGoalCount),
            matchEventTruthPossibleGoalCount: safeNumber(parsed.matchEventTruthPossibleGoalCount),
            matchEventTruthScoreTimelineObservationCount: safeNumber(parsed.matchEventTruthScoreTimelineObservationCount),
            matchEventTruthScoreChangeCount: safeNumber(parsed.matchEventTruthScoreChangeCount),
            matchEventTruthCountedGoalEventCount: safeNumber(parsed.matchEventTruthCountedGoalEventCount),
            matchEventTruthDisallowedGoalEventCount: safeNumber(parsed.matchEventTruthDisallowedGoalEventCount),
            matchEventTruthSelectedGoalCount: safeNumber(parsed.matchEventTruthSelectedGoalCount),
            matchEventTruthScoreChangeAnchorsFound: safeNumber(parsed.matchEventTruthScoreChangeAnchorsFound),
            matchEventTruthStableScoreChangeAnchorCount: safeNumber(parsed.matchEventTruthStableScoreChangeAnchorCount),
            matchEventTruthRevertedScoreChangeAnchorCount: safeNumber(parsed.matchEventTruthRevertedScoreChangeAnchorCount),
            matchEventTruthAnchorsLinkedToGoalPhaseCount: safeNumber(parsed.matchEventTruthAnchorsLinkedToGoalPhaseCount),
            matchEventTruthAnchorsMissingVisualSupportCount: safeNumber(parsed.matchEventTruthAnchorsMissingVisualSupportCount),
            matchEventTruthAnchorsWithLiveActionEvidence: safeNumber(parsed.matchEventTruthAnchorsWithLiveActionEvidence),
            matchEventTruthAnchorsRejected: safeNumber(parsed.matchEventTruthAnchorsRejected),
            matchEventTruthSelectedCountedGoals: safeNumber(parsed.matchEventTruthSelectedCountedGoals),
            matchEventTruthOcrOnlyBlockedCount: safeNumber(parsed.matchEventTruthOcrOnlyBlockedCount),
            matchEventTruthMissingActionEvidenceCount: safeNumber(parsed.matchEventTruthMissingActionEvidenceCount),
            matchEventTruthMissedGoalReasons: safeStringList(parsed.matchEventTruthMissedGoalReasons, 8, 80),
            missingEvidenceByCandidate: Array.isArray(parsed.missingEvidenceByCandidate)
              ? parsed.missingEvidenceByCandidate.map(safeMissingEvidenceCandidate).filter(Boolean).slice(0, 12)
              : [],
            nextAction: parsed.nextAction ? safeString(parsed.nextAction, 180) : null,
            goalEvidenceCandidates: Array.isArray(parsed.goalEvidenceCandidates)
              ? parsed.goalEvidenceCandidates.map(safeGoalEvidenceCandidate).filter(Boolean).slice(0, 12)
              : [],
            matchTruthCandidates: Array.isArray(parsed.matchTruthCandidates)
              ? parsed.matchTruthCandidates.map(safeTruthCandidate).filter(Boolean).slice(0, 16)
              : [],
            matchEventTruthScoreChangeAnchors: Array.isArray(parsed.matchEventTruthScoreChangeAnchors)
              ? parsed.matchEventTruthScoreChangeAnchors.map(safeScoreChangeAnchor).filter(Boolean).slice(0, 12)
              : [],
          };
        }
        if (parsed.event === "scoreboard_ocr_completed") {
          event.scoreboardOcr = {
            providerMode: safeString(parsed.providerMode, 80),
            fallbackUsed: safeBoolean(parsed.fallbackUsed),
            sampledFrameCount: safeNumber(parsed.sampledFrameCount),
            evidenceCount: safeNumber(parsed.evidenceCount),
            scoreChangeCount: safeNumber(parsed.scoreChangeCount),
            scoreRevertedCount: safeNumber(parsed.scoreRevertedCount),
            ambiguousCount: safeNumber(parsed.ambiguousCount),
            unreadableCount: safeNumber(parsed.unreadableCount),
            regionIdsUsed: safeStringList(parsed.regionIdsUsed, 8, 80),
            preprocessingVariantCount: safeNumber(parsed.preprocessingVariantCount),
            chunkSummary: safeOcrChunkSummary(parsed.chunkSummary),
            scorebugDebug: parsed.scorebugDebug && typeof parsed.scorebugDebug === "object"
              ? safeScoreboardOcrEvent({ scorebugDebug: parsed.scorebugDebug }).scorebugDebug
              : null,
            qaReport: parsed.qaReport && typeof parsed.qaReport === "object"
              ? {
                  enabled: safeBoolean(parsed.qaReport.enabled),
                  runId: safeString(parsed.qaReport.runId, 120),
                  status: safeString(parsed.qaReport.status, 40),
                  reportPath: parsed.qaReport.reportPath ? safeString(parsed.qaReport.reportPath, 180) : null,
                  latestPath: parsed.qaReport.latestPath ? safeString(parsed.qaReport.latestPath, 180) : null,
                  contactSheetPath: parsed.qaReport.contactSheetPath ? safeString(parsed.qaReport.contactSheetPath, 180) : null,
                  reviewPath: parsed.qaReport.reviewPath ? safeString(parsed.qaReport.reviewPath, 180) : null,
                  cropCount: safeNumber(parsed.qaReport.cropCount),
                  attemptCount: safeNumber(parsed.qaReport.attemptCount),
                }
              : null,
            scoreTimeline: Array.isArray(parsed.scoreTimeline)
              ? parsed.scoreTimeline.map((item) => ({
                  timestamp: safeNumber(item && item.timestamp),
                  status: safeString(item && item.status, 40),
                  scoreBefore: item && item.scoreBefore ? safeString(item.scoreBefore, 16) : null,
                  scoreAfter: item && item.scoreAfter ? safeString(item.scoreAfter, 16) : null,
                  temporalConsistency: safeBoolean(item && item.temporalConsistency),
                })).slice(0, 24)
              : [],
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
  let proofTimeoutMs = DEFAULT_TIMEOUT_MS;
  let proofDeadlineAt = started + DEFAULT_TIMEOUT_MS;

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

    proofTimeoutMs = options.timeoutMs === undefined || options.timeoutMs === null
      ? parseLiveProofTimeoutMs(env)
      : parseInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, "YOUTUBE_LIVE_E2E_TIMEOUT_INVALID");
    proofDeadlineAt = Date.now() + proofTimeoutMs;
    const withDeadline = (work, details) => withLiveProofDeadline(work, {
      deadlineAt: proofDeadlineAt,
      started,
      timeoutMs: proofTimeoutMs,
      ...details,
    });

    envSummary = deps.checkEnvironment({ env });
    addStep(steps, "env", "passed", {
      liveE2E: Boolean(envSummary.youtubeIngest?.liveE2E?.enabled),
      sourceConfigured: Boolean(envSummary.youtubeIngest?.liveE2E?.sourceConfigured),
    });
    source = config.source;
    addCheck(checks, "youtube_live_e2e_explicit_flag", true);
    addCheck(checks, "youtube_live_e2e_rights_confirmed", true);
    addCheck(checks, "youtube_live_e2e_source_validated_before_server", true, { videoId: source.videoId });
    staleArtifactCleanup = deps.cleanupGeneratedArtifacts({ source, env });
    addStep(steps, "fresh-output-cleanup", "passed", {
      attempted: Boolean(staleArtifactCleanup?.attempted),
      deletedCount: safeNumber(staleArtifactCleanup?.deletedCount),
    });

    doctor = await withDeadline(
      () => deps.checkYouTubeIngest({ env }),
      { phase: PHASES.DOCTOR, step: "youtube_ingest_doctor" },
    );
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
    const ready = await withDeadline(
      () => deps.waitForServerReady({
        baseUrl,
        child: server.child,
        events: server.events,
        fetchImpl: options.fetchImpl || globalThis.fetch,
        port,
        timeoutMs: serverReadyTimeoutMs,
        pollIntervalMs: DEFAULT_SERVER_READY_POLL_INTERVAL_MS,
      }),
      { phase: PHASES.SERVER_READY, step: "wait_for_server_ready" },
    );
    addStep(steps, "server-ready", "passed", {
      attempts: ready.attempts,
      waitedMs: ready.waitedMs,
      httpStatus: ready.status,
    });

    smoke = await withDeadline(
      () => deps.runYouTubeSmoke({
        env: smokeEnvForLive(env, baseUrl),
        fetchImpl: options.fetchImpl || globalThis.fetch,
      }),
      { phase: PHASES.RENDER, step: "run_youtube_smoke", substep: "job_lifecycle" },
    );
    if (smoke?.status !== "passed") {
      const failure = smoke?.failedCases?.[0] || {};
      const outputQA = latestVideoOutputQAFromSmoke(smoke);
      outputProof = buildFailedOutputProof({ env, source, smoke, serverEvents, staleArtifactCleanup });
      const failureNextAction = failure.code && NEXT_ACTIONS[failure.code]
        ? nextActionForCode(failure.code)
        : failure.nextAction || nextActionForCode("YOUTUBE_LIVE_E2E_SMOKE_FAILED");
      throw new YouTubeLiveE2EError(
        failure.code || "YOUTUBE_LIVE_E2E_SMOKE_FAILED",
        "Live YouTube E2E smoke did not pass.",
        {
          nextAction: failureNextAction,
          phase: failure.phase || phaseForCode(failure.code),
          step: failure.step || null,
          substep: failure.substep || null,
          elapsedMs: failure.elapsedMs,
          timeoutMs: failure.timeoutMs,
          stalled: failure.stalled,
          lastProgressAt: failure.lastProgressAt,
          currentJob: failure.currentJob || null,
          countedGoalEventCount: Number.isFinite(Number(outputQA?.expectedGoalCount)) ? Number(outputQA.expectedGoalCount) : null,
          actualConfirmedGoalSegmentCount: Number.isFinite(Number(outputQA?.actualConfirmedGoalSegmentCount))
            ? Number(outputQA.actualConfirmedGoalSegmentCount)
            : null,
          coveredGoalCount: Number.isFinite(Number(outputQA?.coveredGoalCount)) ? Number(outputQA.coveredGoalCount) : null,
          missingGoalNumbers: Array.isArray(outputQA?.missingGoalNumbers) ? outputQA.missingGoalNumbers : [],
          failedReasons: Array.isArray(outputQA?.failedReasons) ? outputQA.failedReasons : [],
        },
      );
    }
    outputProof = buildOutputProof({ env, smoke, source, staleArtifactCleanup });
    const strictOutputValidation = options.requireOutputValidation !== undefined
      ? Boolean(options.requireOutputValidation)
      : !options.runYouTubeSmoke;
    const expectedCountedGoals = Number(outputProof.expectedCountedGoals);
    const countedGoalsIncluded = Number(outputProof.countedGoalsIncluded);
    const countedGoalCoveragePassed = !Number.isFinite(expectedCountedGoals) ||
      countedGoalsIncluded === expectedCountedGoals;
    addCheck(checks, "youtube_live_e2e_counted_goal_coverage_complete", countedGoalCoveragePassed, {
      code: countedGoalCoveragePassed ? null : "YOUTUBE_LIVE_E2E_GOAL_COVERAGE_INCOMPLETE",
      expectedCountedGoals: Number.isFinite(expectedCountedGoals) ? expectedCountedGoals : null,
      countedGoalsIncluded: Number.isFinite(countedGoalsIncluded) ? countedGoalsIncluded : null,
    });
    if (strictOutputValidation && !countedGoalCoveragePassed) {
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_GOAL_COVERAGE_INCOMPLETE",
        "Live YouTube E2E did not include every expected counted goal.",
        {
          phase: PHASES.RENDER,
          expectedCountedGoals,
          countedGoalsIncluded,
        },
      );
    }
    const humanVisibleGoalsIncluded = Number(outputProof.humanVisibleGoalsIncluded);
    const humanVisibleGoalCoveragePassed = !Number.isFinite(expectedCountedGoals) ||
      humanVisibleGoalsIncluded === expectedCountedGoals;
    addCheck(checks, "youtube_live_e2e_human_visible_goal_coverage_complete", humanVisibleGoalCoveragePassed, {
      code: humanVisibleGoalCoveragePassed ? null : "YOUTUBE_LIVE_E2E_HUMAN_VISIBLE_GOAL_INCOMPLETE",
      expectedCountedGoals: Number.isFinite(expectedCountedGoals) ? expectedCountedGoals : null,
      humanVisibleGoalsIncluded: Number.isFinite(humanVisibleGoalsIncluded) ? humanVisibleGoalsIncluded : null,
      failedVisibleGoalSegments: Array.isArray(outputProof.failedVisibleGoalSegments)
        ? outputProof.failedVisibleGoalSegments.map((segment) => ({
            index: segment.index,
            failureCode: segment.failureCode,
          })).slice(0, 8)
        : [],
    });
    if (strictOutputValidation && !humanVisibleGoalCoveragePassed) {
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_HUMAN_VISIBLE_GOAL_INCOMPLETE",
        "Live YouTube E2E did not include every expected human-visible goal sequence.",
        {
          phase: PHASES.RENDER,
          expectedCountedGoals,
          humanVisibleGoalsIncluded,
        },
      );
    }
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
    const renderedSocialPolishPassed = outputProof.renderedSocialPolishQA?.passed === true;
    if (strictOutputValidation || outputProof.ffprobe?.status === "passed") {
      addCheck(checks, "youtube_live_e2e_rendered_social_polish_passed", renderedSocialPolishPassed, {
        code: renderedSocialPolishPassed ? null : "YOUTUBE_LIVE_E2E_SOCIAL_POLISH_FAILED",
        failedReasons: Array.isArray(outputProof.renderedSocialPolishQA?.failedReasons)
          ? outputProof.renderedSocialPolishQA.failedReasons
          : [],
        socialPolishScore: outputProof.renderedSocialPolishQA?.socialPolishScore ?? null,
      });
    }
    if (strictOutputValidation && !renderedSocialPolishPassed) {
      throw new YouTubeLiveE2EError(
        "YOUTUBE_LIVE_E2E_SOCIAL_POLISH_FAILED",
        "Live YouTube E2E rendered MP4 did not pass social polish proof.",
        {
          phase: PHASES.RENDER,
          failedReasons: Array.isArray(outputProof.renderedSocialPolishQA?.failedReasons)
            ? outputProof.renderedSocialPolishQA.failedReasons
            : [],
          socialPolishScore: outputProof.renderedSocialPolishQA?.socialPolishScore ?? null,
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
      ["youtube_live_e2e_replay_only_segments_reported", hasFiniteNumber(outputProof.replayOnlySegments)],
      ["youtube_live_e2e_human_visible_goal_gate_reported", hasFiniteNumber(outputProof.humanVisibleGoalsIncluded)],
      ["youtube_live_e2e_visual_polish_reported", hasFiniteNumber(outputProof.visualPolishScore)],
      ["youtube_live_e2e_abrupt_cut_risk_reported", hasFiniteNumber(outputProof.abruptCutRiskCount)],
      ["youtube_live_e2e_render_polish_reported", Boolean(outputProof.renderPolishQA)],
      ["youtube_live_e2e_social_polish_reported", Boolean(outputProof.renderedSocialPolishQA)],
      ["youtube_live_e2e_dynamic_word_captions_reported", hasFiniteNumber(outputProof.dynamicWordCaptionCount)],
      ["youtube_live_e2e_transition_rendered_reported", hasFiniteNumber(outputProof.transitionRenderedCount)],
      ["youtube_live_e2e_overlay_rendered_reported", hasFiniteNumber(outputProof.overlayRenderedCount)],
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
    if ((!outputProof || outputProof.outputMp4 === null) && serverEvents.length) {
      const refreshedOutputProof = buildFailedOutputProof({ env, source, smoke, serverEvents, staleArtifactCleanup });
      if (
        !outputProof ||
        refreshedOutputProof.goalDiscovery ||
        refreshedOutputProof.videoOutputQA ||
        refreshedOutputProof.ocrChunkSummary
      ) {
        outputProof = refreshedOutputProof;
      }
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
    timeout = parseLiveProofTimeoutMs(process.env);
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
  if (!process.exitCode) {
    const report = await runYouTubeLiveE2E({ commandName, timeoutMs: timeout });
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
  liveServerEnvironment,
  writeYouTubeLiveE2EReport,
};
