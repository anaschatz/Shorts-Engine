import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";
import {
  RESULTS_DIR,
  runYouTubeSmoke,
  validateSmokeSource,
} from "./run-youtube-smoke.mjs";
import { checkEnvironment } from "../tools/release/check-environment.mjs";
import { checkYouTubeIngest } from "../tools/release/check-youtube-ingest.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E";
const LIVE_RIGHTS_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED";
const LIVE_URL_FLAG = "SHORTSENGINE_YOUTUBE_LIVE_E2E_URL";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
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
  YOUTUBE_LIVE_E2E_DOCTOR_FAILED: "run-npm-run-youtube-doctor-and-fix-failed-checks",
  YOUTUBE_LIVE_E2E_SMOKE_FAILED: "inspect-demo-results-youtube-live-e2e-latest-json",
  YOUTUBE_LIVE_E2E_REPORT_LEAK: "remove-sensitive-output-from-live-e2e-report",
  YOUTUBE_LIVE_E2E_TIMEOUT: "check-local-server-and-downloader-before-rerun-or-increase-timeout-only-if-expected",
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
  if (text.includes("SERVER_BIND")) return PHASES.SERVER_BIND;
  if (text.includes("VALIDATE") || text.includes("VALIDATION")) return PHASES.VALIDATION;
  if (text.includes("INGEST") || text.includes("ARTIFACT") || text.includes("SOURCE_RESPONSE")) return PHASES.INGEST;
  if (text.startsWith("FILE_") || text.startsWith("VIDEO_") || text.includes("DURATION")) return PHASES.PROBE;
  if (text.includes("JOB") || text.includes("GENERATE") || text.includes("EXPORT_MISSING")) return PHASES.RENDER;
  if (text.includes("DOWNLOAD") || text.includes("MP4")) return PHASES.DOWNLOAD;
  if (text.includes("BROWSER") || text.includes("PLAYWRIGHT")) return PHASES.BROWSER;
  if (text.includes("REPORT_LEAK")) return PHASES.REPORT;
  return "proof";
}

function safeFailure(error) {
  const safe = safeReportError(error) || { code: "YOUTUBE_LIVE_E2E_FAILED", message: "YouTube live E2E failed." };
  const code = error && error.code ? error.code : safe.code;
  return {
    code,
    message: safe.message,
    nextAction: error?.details?.nextAction || nextActionForCode(code),
    phase: error?.details?.phase || phaseForCode(code),
  };
}

function sanitizeServerEvents(events = []) {
  return events.slice(-40).map((event) => ({
    stream: event.stream || null,
    level: event.level || null,
    event: event.event || null,
    code: event.code || null,
    service: event.service || null,
  }));
}

function relativeFromRoot(fileName) {
  return relative(ROOT_DIR, fileName).replace(/\\/g, "/");
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
    export: report.export || null,
    failedCases: Array.isArray(report.failedCases) ? report.failedCases : [],
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
    status: "failed",
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
  doctor,
  durationMs,
  failedCases,
  envSummary,
  serverEvents,
  smoke,
  source,
  status,
  steps,
}) {
  const failure = failedCases[0] || null;
  const phase = failure?.phase || (status === "skipped" ? PHASES.SKIPPED : status === "passed" ? PHASES.COMPLETED : null);
  const nextAction = reportNextAction({ checks, failedCases, status });
  return safeReport({
    timestamp: nowIso(),
    status,
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
  };
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
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
      MATCHCUTS_PERSISTENCE_ADAPTER: "sqlite",
      MATCHCUTS_SQLITE_FILE: "youtube-live-e2e.sqlite",
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
      } catch {
        // Keep raw process output out of persisted reports.
      }
      events.push(event);
      if (events.length > 40) events.shift();
    }
  };
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  return { child, events };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", resolveStop)),
    delay(2500).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }),
  ]);
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

  const deps = {
    checkYouTubeIngest: options.checkYouTubeIngest || checkYouTubeIngest,
    checkEnvironment: options.checkEnvironment || checkEnvironment,
    getFreePort: options.getFreePort || getFreePort,
    runYouTubeSmoke: options.runYouTubeSmoke || runYouTubeSmoke,
    startServer: options.startServer || startServer,
    stopServer: options.stopServer || stopServer,
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
        doctor,
        durationMs: Date.now() - started,
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

    smoke = await deps.runYouTubeSmoke({
      env: smokeEnvForLive(env, baseUrl),
      fetchImpl: options.fetchImpl || globalThis.fetch,
    });
    if (smoke?.status !== "passed") {
      const failure = smoke?.failedCases?.[0] || {};
      throw new YouTubeLiveE2EError(
        failure.code || "YOUTUBE_LIVE_E2E_SMOKE_FAILED",
        "Live YouTube E2E smoke did not pass.",
        { nextAction: failure.nextAction || nextActionForCode("YOUTUBE_LIVE_E2E_SMOKE_FAILED") },
      );
    }
    addStep(steps, "smoke", "passed");
    for (const [name, passed] of [
      ["youtube_live_e2e_ingest_created_project", Boolean(smoke.ids?.projectId)],
      ["youtube_live_e2e_ingest_created_upload", Boolean(smoke.ids?.uploadId)],
      ["youtube_live_e2e_render_created_export", Boolean(smoke.ids?.exportId)],
      ["youtube_live_e2e_download_verified", Boolean(smoke.export)],
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
      await deps.stopServer(server.child);
    }
  }

  for (const check of checks) {
    if (!check.passed) failedCases.push({ name: check.name, code: check.code || "CHECK_FAILED" });
  }
  return buildReport({
    checks,
    doctor,
    durationMs: Date.now() - started,
    failedCases,
    envSummary,
    serverEvents,
    smoke,
    source,
    status: failedCases.length ? "failed" : "passed",
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
      doctor: null,
      durationMs: 0,
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
          status: "failed",
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
    const report = await Promise.race([runYouTubeLiveE2E(), timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    const written = writeYouTubeLiveE2EReport(report);
    console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  LIVE_FLAG,
  LIVE_RIGHTS_FLAG,
  LIVE_URL_FLAG,
  YouTubeLiveE2EError,
  runYouTubeLiveE2E,
  validateLiveConfig,
  writeYouTubeLiveE2EReport,
};
