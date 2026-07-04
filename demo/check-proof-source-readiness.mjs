import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "./report-safety.mjs";
import { validateLocalProofConfig } from "./run-local-video-proof.mjs";
import {
  LIVE_FLAG,
  LIVE_RIGHTS_FLAG,
  LIVE_URL_FLAG,
  validateLiveConfig,
} from "./run-youtube-live-e2e.mjs";
import { checkYouTubeIngest } from "../tools/release/check-youtube-ingest.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const SCHEMA_VERSION = 1;
const DEFAULT_COMMAND_NAME = "proof:readiness";
const LATEST_REPORT_REF = "demo/results/proof-source-readiness-latest.json";

const NEXT_ACTIONS = Object.freeze({
  PROOF_SOURCE_NOT_CONFIGURED:
    "configure-SHORTSENGINE_LOCAL_PROOF_SOURCE-or-SHORTSENGINE_YOUTUBE_LIVE_E2E_URL-with-explicit-rights-confirmation",
  PROOF_LOCAL_SOURCE_NOT_CONFIGURED:
    "set-SHORTSENGINE_LOCAL_PROOF_SOURCE-to-a-rights-cleared-mp4",
  PROOF_YOUTUBE_LIVE_NOT_CONFIGURED:
    "set-SHORTSENGINE_YOUTUBE_LIVE_E2E-1-with-rights-url-ingest-and-allowlist-for-live-proof",
  PROOF_YOUTUBE_EXPECTED_COUNT_REQUIRED:
    "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS-to-the-known-counted-goal-count",
  PROOF_YOUTUBE_EXPECTED_COUNT_INVALID:
    "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS-between-1-and-20",
  PROOF_READINESS_REPORT_LEAK:
    "remove-sensitive-fields-from-proof-readiness-report",
  LOCAL_VIDEO_PROOF_RIGHTS_REQUIRED:
    "set-SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED-1-after-rights-review",
  LOCAL_VIDEO_PROOF_SOURCE_NOT_FOUND:
    "check-the-local-rights-cleared-mp4-exists-and-is-readable",
  LOCAL_VIDEO_PROOF_SOURCE_EXTENSION_UNSUPPORTED:
    "use-a-rights-cleared-mp4-file",
  LOCAL_VIDEO_PROOF_SOURCE_SIGNATURE_INVALID:
    "use-a-valid-mp4-with-an-ftyp-container-signature",
  LOCAL_VIDEO_PROOF_EXPECTED_COUNT_REQUIRED:
    "set-SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS-to-the-known-counted-goal-count",
  LOCAL_VIDEO_PROOF_EXPECTED_COUNT_INVALID:
    "set-SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS-between-1-and-20",
  ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED:
    "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1-for-authorized-live-proof",
  ENV_YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED:
    "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED-1-after-rights-review",
  ENV_YOUTUBE_LIVE_E2E_URL_MISSING:
    "set-SHORTSENGINE_YOUTUBE_LIVE_E2E_URL-to-an-authorized-youtube-video",
  ENV_YOUTUBE_LIVE_E2E_URL_INVALID:
    "use-a-supported-authorized-youtube-watch-shorts-or-shortlink-url",
  ENV_YOUTUBE_LIVE_E2E_URL_NOT_ALLOWED:
    "set-SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS-or-SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED-1",
  YOUTUBE_INGEST_DISABLED:
    "set-SHORTSENGINE_YOUTUBE_INGEST_ENABLED-1-and-configure-downloader-or-source-cache",
  YOUTUBE_DOWNLOADER_MISSING:
    "install-configure-downloader-or-use-operator-approved-source-cache",
  FFMPEG_MISSING:
    "install-ffmpeg-or-set-FFMPEG_BIN",
  FFPROBE_MISSING:
    "install-ffprobe-or-set-FFPROBE_BIN",
  YOUTUBE_STAGING_STORAGE_UNAVAILABLE:
    "check-data-directory-permissions-and-staging-storage",
});

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function safeString(value, maxLength = 140) {
  return String(value || "")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/\b(?:token|secret|cookie|api[_-]?key)\b/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeCode(value, fallback = "PROOF_READINESS_FAILED") {
  return safeString(value || fallback, 96).replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 96) || fallback;
}

function nextActionForCode(code) {
  return NEXT_ACTIONS[code] || "inspect-proof-source-readiness-report";
}

function parseExpectedCount(raw, codePrefix = "PROOF_YOUTUBE") {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return {
      ok: false,
      code: `${codePrefix}_EXPECTED_COUNT_REQUIRED`,
      nextAction: nextActionForCode(`${codePrefix}_EXPECTED_COUNT_REQUIRED`),
    };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    return {
      ok: false,
      code: `${codePrefix}_EXPECTED_COUNT_INVALID`,
      nextAction: nextActionForCode(`${codePrefix}_EXPECTED_COUNT_INVALID`),
    };
  }
  return { ok: true, value: parsed };
}

function localConfigured(env) {
  return Boolean(String(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SOURCE") || "").trim());
}

function youtubeConfigured(env) {
  return Boolean(
    boolFromEnv(rawValue(env, LIVE_FLAG)) ||
      String(rawValue(env, LIVE_URL_FLAG) || rawValue(env, "SHORTSENGINE_YOUTUBE_SMOKE_URL") || "").trim() ||
      boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED")) ||
      boolFromEnv(rawValue(env, LIVE_RIGHTS_FLAG)),
  );
}

function localSourceSummary(source) {
  if (!source) return null;
  return {
    sourceType: "local_mp4",
    fileName: safeString(source.fileName, 96),
    label: safeString(source.label || "rights-cleared-local-mp4", 80),
    extension: ".mp4",
    sizeBytes: Number.isFinite(Number(source.sizeBytes)) ? Number(source.sizeBytes) : null,
    sha256Prefix: safeString(source.sha256Prefix, 24),
  };
}

function youtubeSourceSummary(source) {
  if (!source) return null;
  return {
    sourceType: "youtube",
    host: "youtube",
    kind: safeString(source.kind || "watch", 24),
    videoId: safeString(source.videoId, 24),
  };
}

function errorSummary(error) {
  const code = safeCode(error && error.code);
  return {
    code,
    message: safeString(error && error.message ? error.message : "Proof source readiness failed."),
    nextAction: nextActionForCode(code),
  };
}

function checkLocalProofSource(env) {
  if (!localConfigured(env)) {
    return {
      status: "skipped",
      passed: false,
      skipped: true,
      configured: false,
      canRun: false,
      code: "PROOF_LOCAL_SOURCE_NOT_CONFIGURED",
      nextAction: nextActionForCode("PROOF_LOCAL_SOURCE_NOT_CONFIGURED"),
    };
  }
  try {
    const config = validateLocalProofConfig(env);
    return {
      status: "ready",
      passed: true,
      skipped: false,
      configured: true,
      canRun: true,
      source: localSourceSummary(config.source),
      expectedCountedGoals: config.expectedCountedGoals,
      scoreboardOcrEnabled: Boolean(config.scoreboardOcrEnabled),
      scoreboardOcrQaEnabled: Boolean(config.scoreboardOcrQaEnabled),
      nextCommand: "npm run proof:local-video",
    };
  } catch (error) {
    const safe = errorSummary(error);
    return {
      status: "failed",
      passed: false,
      skipped: false,
      configured: true,
      canRun: false,
      ...safe,
    };
  }
}

async function checkYouTubeProofSource(env, options = {}) {
  if (!youtubeConfigured(env)) {
    return {
      status: "skipped",
      passed: false,
      skipped: true,
      configured: false,
      canRun: false,
      code: "PROOF_YOUTUBE_LIVE_NOT_CONFIGURED",
      nextAction: nextActionForCode("PROOF_YOUTUBE_LIVE_NOT_CONFIGURED"),
    };
  }

  let config;
  try {
    config = validateLiveConfig(env);
    if (config.skipped) {
      return {
        status: "skipped",
        passed: false,
        skipped: true,
        configured: true,
        canRun: false,
        code: "PROOF_YOUTUBE_LIVE_NOT_CONFIGURED",
        nextAction: nextActionForCode("PROOF_YOUTUBE_LIVE_NOT_CONFIGURED"),
      };
    }
  } catch (error) {
    const safe = errorSummary(error);
    return {
      status: "failed",
      passed: false,
      skipped: false,
      configured: true,
      canRun: false,
      ...safe,
    };
  }

  const expected = parseExpectedCount(rawValue(env, "SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS"));
  if (!expected.ok) {
    return {
      status: "failed",
      passed: false,
      skipped: false,
      configured: true,
      canRun: false,
      source: youtubeSourceSummary(config.source),
      code: expected.code,
      nextAction: expected.nextAction,
    };
  }

  const checkYouTubeIngestImpl = options.checkYouTubeIngestImpl || checkYouTubeIngest;
  const doctor = await checkYouTubeIngestImpl({
    ...(options.youtubeDoctorOptions || {}),
    env,
    nowMs: options.nowMs,
  });
  const doctorReady = doctor && doctor.ok === true && doctor.youtubeIngest && doctor.youtubeIngest.ingestAvailable === true;
  if (!doctorReady) {
    const code = safeCode(doctor && doctor.code ? doctor.code : "YOUTUBE_INGEST_NOT_READY");
    return {
      status: "failed",
      passed: false,
      skipped: false,
      configured: true,
      canRun: false,
      source: youtubeSourceSummary(config.source),
      expectedCountedGoals: expected.value,
      runtime: safeYouTubeDoctorSummary(doctor),
      code,
      nextAction: nextActionForCode(code),
    };
  }

  return {
    status: "ready",
    passed: true,
    skipped: false,
    configured: true,
    canRun: true,
    source: youtubeSourceSummary(config.source),
    expectedCountedGoals: expected.value,
    runtime: safeYouTubeDoctorSummary(doctor),
    nextCommand: "npm run youtube:proof:operator",
  };
}

function safeYouTubeDoctorSummary(doctor) {
  if (!doctor || typeof doctor !== "object") return null;
  return {
    status: safeString(doctor.status || "unknown", 32),
    code: doctor.code ? safeCode(doctor.code) : null,
    ingestAvailable: Boolean(doctor.youtubeIngest && doctor.youtubeIngest.ingestAvailable),
    ingestEnabled: Boolean(doctor.youtubeIngest && doctor.youtubeIngest.enabled),
    downloaderConfigured: Boolean(doctor.youtubeIngest && doctor.youtubeIngest.downloaderConfigured),
    sourceCacheConfigured: Boolean(doctor.youtubeIngest && doctor.youtubeIngest.sourceCache && doctor.youtubeIngest.sourceCache.configured),
    ffmpeg: doctor.ffmpeg
      ? {
          ffmpeg: Boolean(doctor.ffmpeg.ffmpeg),
          ffprobe: Boolean(doctor.ffmpeg.ffprobe),
        }
      : null,
    storage: doctor.storage
      ? {
          stagingReady: Boolean(doctor.storage.stagingReady),
          tmpReady: Boolean(doctor.storage.tmpReady),
          artifactsReady: Boolean(doctor.storage.artifactsReady),
        }
      : null,
  };
}

function summarizeOverall(localProof, youtubeProof) {
  const ready = [localProof, youtubeProof].filter((entry) => entry && entry.canRun === true);
  const failures = [localProof, youtubeProof].filter((entry) => entry && entry.status === "failed");
  const configured = [localProof, youtubeProof].filter((entry) => entry && entry.configured === true);
  if (ready.length > 0) {
    return {
      status: "ready",
      passed: true,
      skipped: false,
      code: null,
      nextAction: ready[0].nextCommand || "run-the-ready-proof-command",
    };
  }
  if (failures.length > 0) {
    return {
      status: "failed",
      passed: false,
      skipped: false,
      code: failures[0].code || "PROOF_SOURCE_NOT_READY",
      nextAction: failures[0].nextAction || nextActionForCode(failures[0].code),
    };
  }
  return {
    status: "skipped",
    passed: false,
    skipped: true,
    code: configured.length > 0 ? "PROOF_SOURCE_NOT_READY" : "PROOF_SOURCE_NOT_CONFIGURED",
    nextAction: nextActionForCode("PROOF_SOURCE_NOT_CONFIGURED"),
  };
}

function stableRunId(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

async function checkProofSourceReadiness(options = {}) {
  const env = options.env || process.env;
  const checkedAt = nowIso(options.nowMs);
  const localProof = checkLocalProofSource(env);
  const youtubeProof = await checkYouTubeProofSource(env, options);
  const overall = summarizeOverall(localProof, youtubeProof);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    command: options.commandName || DEFAULT_COMMAND_NAME,
    checkedAt,
    runId: stableRunId(`${checkedAt}:${overall.status}:${localProof.status}:${youtubeProof.status}`),
    phase: "source-readiness",
    status: overall.status,
    passed: overall.passed,
    skipped: overall.skipped,
    code: overall.code,
    nextAction: overall.nextAction,
    localProof,
    youtubeProof,
    outputPolicy: {
      networkCallsStarted: false,
      downloaderStarted: false,
      serverStarted: false,
      mp4Produced: false,
      oldMp4Reused: false,
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    reportRefs: {
      latest: LATEST_REPORT_REF,
    },
  };
  const leak = findSensitiveLeak(report);
  if (!leak) return report;
  return {
    schemaVersion: SCHEMA_VERSION,
    command: options.commandName || DEFAULT_COMMAND_NAME,
    checkedAt,
    phase: "source-readiness",
    status: "failed",
    passed: false,
    skipped: false,
    code: "PROOF_READINESS_REPORT_LEAK",
    nextAction: nextActionForCode("PROOF_READINESS_REPORT_LEAK"),
    outputPolicy: {
      networkCallsStarted: false,
      downloaderStarted: false,
      serverStarted: false,
      mp4Produced: false,
      oldMp4Reused: false,
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
  };
}

function atomicWriteJson(fileName, payload) {
  mkdirSync(dirname(fileName), { recursive: true });
  const tempName = `${fileName}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempName, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempName, fileName);
}

function writeProofSourceReadinessReport(report, options = {}) {
  const resultsDir = resolve(options.resultsDir || RESULTS_DIR);
  const timestamp = String(report.checkedAt || nowIso()).replace(/[:.]/g, "-");
  const timestamped = resolve(resultsDir, `proof-source-readiness-${timestamp}.json`);
  const latest = resolve(resultsDir, "proof-source-readiness-latest.json");
  const payload = {
    ...report,
    reportRefs: {
      latest: LATEST_REPORT_REF,
      timestamped: `demo/results/proof-source-readiness-${timestamp}.json`,
    },
  };
  const leak = findSensitiveLeak(payload);
  if (leak) {
    const failed = {
      schemaVersion: SCHEMA_VERSION,
      command: report.command || DEFAULT_COMMAND_NAME,
      checkedAt: report.checkedAt || nowIso(),
      phase: "source-readiness",
      status: "failed",
      passed: false,
      skipped: false,
      code: "PROOF_READINESS_REPORT_LEAK",
      nextAction: nextActionForCode("PROOF_READINESS_REPORT_LEAK"),
    };
    atomicWriteJson(latest, failed);
    return { latestRef: LATEST_REPORT_REF, timestampedRef: null, report: failed };
  }
  atomicWriteJson(timestamped, payload);
  atomicWriteJson(latest, payload);
  return {
    latestRef: LATEST_REPORT_REF,
    timestampedRef: payload.reportRefs.timestamped,
    report: payload,
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const report = await checkProofSourceReadiness();
    const written = writeProofSourceReadinessReport(report);
    console.log(JSON.stringify({
      ...written.report,
      reportRefs: {
        latest: written.latestRef,
        timestamped: written.timestampedRef,
      },
    }, null, 2));
    if (written.report.status === "failed") process.exitCode = 1;
  } catch {
    const failed = {
      schemaVersion: SCHEMA_VERSION,
      command: DEFAULT_COMMAND_NAME,
      checkedAt: nowIso(),
      phase: "source-readiness",
      status: "failed",
      passed: false,
      skipped: false,
      code: "PROOF_READINESS_FAILED",
      nextAction: "inspect-proof-source-readiness-script",
    };
    const written = writeProofSourceReadinessReport(failed);
    console.error(JSON.stringify(written.report, null, 2));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_COMMAND_NAME,
  LATEST_REPORT_REF,
  checkLocalProofSource,
  checkProofSourceReadiness,
  checkYouTubeProofSource,
  writeProofSourceReadinessReport,
};
