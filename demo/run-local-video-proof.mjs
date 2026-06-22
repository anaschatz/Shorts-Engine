import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";
import { probeVideo } from "./run-side-by-side-review.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const MANUAL_DOWNLOADS_DIR = "manual-downloads";
const LOCAL_PROOF_SOURCE_MARKER = "local-video-proof";
const LOCAL_PROOF_SCHEMA_VERSION = 1;
const DEFAULT_COMMAND_NAME = "proof:local-video";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SERVER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_SOURCE_MAX_BYTES = 512 * 1024 * 1024;

const NEXT_ACTIONS = Object.freeze({
  LOCAL_VIDEO_PROOF_SKIPPED: "set-SHORTSENGINE_LOCAL_PROOF_SOURCE-and-rights-confirmation-for-manual-proof",
  LOCAL_VIDEO_PROOF_RIGHTS_REQUIRED: "set-SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED-1-after-rights-review",
  LOCAL_VIDEO_PROOF_SOURCE_MISSING: "set-SHORTSENGINE_LOCAL_PROOF_SOURCE-to-a-rights-cleared-mp4",
  LOCAL_VIDEO_PROOF_SOURCE_UNSAFE: "use-a-direct-safe-mp4-file-path-without-traversal-or-control-characters",
  LOCAL_VIDEO_PROOF_SOURCE_NOT_FOUND: "check-the-local-mp4-file-exists-and-is-readable",
  LOCAL_VIDEO_PROOF_SOURCE_NOT_FILE: "use-a-regular-mp4-file",
  LOCAL_VIDEO_PROOF_SOURCE_TOO_LARGE: "use-a-shorter-rights-cleared-mp4-or-raise-the-bound-with-operator-review",
  LOCAL_VIDEO_PROOF_SOURCE_EXTENSION_UNSUPPORTED: "use-a-rights-cleared-mp4-file",
  LOCAL_VIDEO_PROOF_SOURCE_SIGNATURE_INVALID: "use-a-valid-mp4-with-an-ftyp-container-signature",
  LOCAL_VIDEO_PROOF_EXPECTED_COUNT_REQUIRED: "set-SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS-to-the-known-counted-goal-count",
  LOCAL_VIDEO_PROOF_EXPECTED_COUNT_INVALID: "set-SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS-between-1-and-20",
  LOCAL_VIDEO_PROOF_SERVER_BIND_FAILED: "run-outside-restricted-sandbox-or-use-an-available-local-port",
  LOCAL_VIDEO_PROOF_SERVER_READY_TIMEOUT: "check-local-server-startup-health-and-rerun-local-proof",
  LOCAL_VIDEO_PROOF_HEALTH_NOT_READY: "inspect-health-readiness-before-running-local-proof",
  LOCAL_VIDEO_PROOF_UPLOAD_FAILED: "inspect-upload-validation-and-use-a-valid-rights-cleared-mp4",
  LOCAL_VIDEO_PROOF_GENERATE_FAILED: "inspect-generate-contract-and-rights-confirmation",
  LOCAL_VIDEO_PROOF_JOB_TIMEOUT: "inspect-job-progress-or-increase-timeout-only-if-expected",
  LOCAL_VIDEO_PROOF_JOB_FAILED: "inspect-video-output-qa-and-goal-evidence-before-rerun",
  LOCAL_VIDEO_PROOF_OUTPUT_QA_FAILED: "fix-counted-goal-selection-before-writing-a-proof-mp4",
  LOCAL_VIDEO_PROOF_DOWNLOAD_NOT_MP4: "check-render-export-download-contract",
  LOCAL_VIDEO_PROOF_MP4_SIGNATURE_INVALID: "check-render-output-and-download-contract",
  LOCAL_VIDEO_PROOF_REPORT_LEAK: "remove-sensitive-output-from-local-video-proof-report",
  LOCAL_VIDEO_PROOF_TIMEOUT: "check-local-server-and-render-pipeline-before-rerun",
});

const PHASES = Object.freeze({
  CONFIG: "config",
  SERVER_BIND: "server-bind",
  SERVER_READY: "server-ready",
  HEALTH: "health",
  UPLOAD: "upload",
  RENDER: "render",
  DOWNLOAD: "download",
  REPORT: "report",
  SKIPPED: "skipped",
  COMPLETED: "completed",
});

class LocalVideoProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LocalVideoProofError";
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

function safeString(value, maxLength = 120) {
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

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function safeList(values = [], maxItems = 12, maxLength = 80) {
  return (Array.isArray(values) ? values : [])
    .map((value) => safeString(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function addStep(steps, step, status, details = {}) {
  steps.push({ step, status, ...details });
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new LocalVideoProofError(code, "Local video proof numeric configuration is out of bounds.");
  }
  return parsed;
}

function nextActionForCode(code) {
  return NEXT_ACTIONS[code] || "inspect-local-video-proof-report";
}

function phaseForCode(code) {
  const text = String(code || "");
  if (text.includes("SERVER_BIND")) return PHASES.SERVER_BIND;
  if (text.includes("SERVER_READY")) return PHASES.SERVER_READY;
  if (text.includes("HEALTH")) return PHASES.HEALTH;
  if (text.includes("UPLOAD") || text.includes("SOURCE")) return PHASES.UPLOAD;
  if (text.includes("DOWNLOAD") || text.includes("MP4")) return PHASES.DOWNLOAD;
  if (text.includes("REPORT")) return PHASES.REPORT;
  if (text.includes("JOB") || text.includes("OUTPUT_QA") || text.includes("GENERATE")) return PHASES.RENDER;
  if (text.includes("SKIPPED")) return PHASES.SKIPPED;
  return PHASES.CONFIG;
}

function fileSha256Prefix(fileName) {
  return createHash("sha256").update(readFileSync(fileName)).digest("hex").slice(0, 16);
}

function readMp4Header(fileName, byteLength = 32) {
  const fd = openSync(fileName, "r");
  try {
    const buffer = Buffer.alloc(Math.max(12, Math.min(Number(byteLength) || 32, 4096)));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function validateSafeSourceText(value) {
  const text = String(value || "").trim();
  if (
    !text ||
    text.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(text) ||
    text.split(/[\\/]+/).some((part) => part === "..")
  ) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_SOURCE_UNSAFE",
      "Local proof source reference is unsafe.",
    );
  }
  return text;
}

function sanitizeFileName(value) {
  const name = basename(String(value || "")).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return name || "local-proof-source.mp4";
}

function validateExpectedCount(env) {
  const raw = rawValue(env, "SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS");
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_EXPECTED_COUNT_REQUIRED",
      "Local video proof requires an expected counted-goal count.",
    );
  }
  return parseInteger(raw, null, 1, 20, "LOCAL_VIDEO_PROOF_EXPECTED_COUNT_INVALID");
}

function validateLocalProofConfig(env = process.env, options = {}) {
  const rawSource = String(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SOURCE") || "").trim();
  if (!rawSource) return { skipped: true };
  if (!boolFromEnv(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED"))) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_RIGHTS_REQUIRED",
      "Local video proof requires explicit rights confirmation.",
    );
  }
  const expectedCountedGoals = validateExpectedCount(env);
  const safeText = validateSafeSourceText(rawSource);
  const resolvedFile = resolve(safeText);
  const fileName = sanitizeFileName(resolvedFile);
  if (extname(fileName).toLowerCase() !== ".mp4") {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_SOURCE_EXTENSION_UNSUPPORTED",
      "Local proof source must be an MP4 file.",
    );
  }
  if (!existsSync(resolvedFile)) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_SOURCE_NOT_FOUND",
      "Local proof source file was not found.",
    );
  }
  const stats = statSync(resolvedFile);
  if (!stats.isFile()) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_SOURCE_NOT_FILE",
      "Local proof source must be a regular MP4 file.",
    );
  }
  const maxBytes = parseInteger(
    rawValue(env, "SHORTSENGINE_LOCAL_PROOF_MAX_SOURCE_BYTES"),
    options.defaultMaxBytes || DEFAULT_SOURCE_MAX_BYTES,
    1024,
    2 * 1024 * 1024 * 1024,
    "LOCAL_VIDEO_PROOF_SOURCE_TOO_LARGE",
  );
  if (stats.size <= 0 || stats.size > maxBytes) {
    throw new LocalVideoProofError(
      stats.size <= 0 ? "LOCAL_VIDEO_PROOF_SOURCE_SIGNATURE_INVALID" : "LOCAL_VIDEO_PROOF_SOURCE_TOO_LARGE",
      "Local proof source size is invalid.",
      { sizeBytes: stats.size },
    );
  }
  const header = readMp4Header(resolvedFile);
  if (header.length < 12 || header.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_SOURCE_SIGNATURE_INVALID",
      "Local proof source is not a valid MP4 container.",
    );
  }
  const label = safeString(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SOURCE_LABEL") || "rights-cleared-local-mp4", 80);
  return {
    skipped: false,
    source: {
      resolvedFile,
      fileName,
      label,
      extension: ".mp4",
      sizeBytes: stats.size,
      sha256Prefix: fileSha256Prefix(resolvedFile),
    },
    expectedCountedGoals,
    scoreboardOcrEnabled: boolFromEnv(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR")),
    scoreboardOcrQaEnabled: boolFromEnv(rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR_QA")),
  };
}

function sourcePublicSummary(source) {
  if (!source) return null;
  return {
    sourceType: "local_mp4",
    fileName: source.fileName,
    label: source.label || null,
    extension: ".mp4",
    sizeBytes: source.sizeBytes,
    sha256Prefix: source.sha256Prefix,
  };
}

function createMultipartBody(parts) {
  const boundary = `----shortsengine-local-proof-${randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    const headers = [`--${boundary}`];
    if (part.fileName) {
      headers.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"`,
        `Content-Type: ${part.mimeType || "application/octet-stream"}`,
      );
    } else {
      headers.push(`Content-Disposition: form-data; name="${part.name}"`);
    }
    chunks.push(Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value || ""), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function endpointUrl(baseUrl, apiEndpoint) {
  const parsed = new URL(baseUrl);
  const mount = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${mount}${apiEndpoint}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function readBoundedResponseBuffer(response, maxBytes, code) {
  const declaredLength = response.headers && typeof response.headers.get === "function"
    ? Number(response.headers.get("content-length"))
    : null;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new LocalVideoProofError(code, "Local video proof response is too large.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new LocalVideoProofError(code, "Local video proof response is too large.");
  }
  return buffer;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const buffer = await readBoundedResponseBuffer(
    response,
    options.maxBytes || 256 * 1024,
    "LOCAL_VIDEO_PROOF_JSON_RESPONSE_TOO_LARGE",
  );
  let payload = null;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_JSON_INVALID", "Local video proof response is not valid JSON.");
  }
  if (findSensitiveLeak(payload)) {
    throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_RESPONSE_LEAK", "Local video proof API response contains sensitive output.");
  }
  return {
    ok: response.ok && payload && payload.ok === true,
    status: response.status,
    requestId: response.headers?.get?.("x-request-id") || payload?.data?.requestId || null,
    payload,
  };
}

async function fetchDownload(fetchImpl, url, maxBytes) {
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "video/mp4" } });
  const buffer = await readBoundedResponseBuffer(
    response,
    maxBytes || DEFAULT_DOWNLOAD_MAX_BYTES,
    "LOCAL_VIDEO_PROOF_DOWNLOAD_TOO_LARGE",
  );
  return {
    ok: response.ok,
    status: response.status,
    requestId: response.headers?.get?.("x-request-id") || null,
    contentType: response.headers?.get?.("content-type") || "",
    buffer,
  };
}

function assertApiOk(response, code, message) {
  if (response && response.ok === true && response.payload && response.payload.ok === true && response.payload.data) {
    return response.payload.data;
  }
  const apiCode = response?.payload?.error?.code;
  const nextAction = response?.payload?.error?.nextAction;
  throw new LocalVideoProofError(apiCode || code, message, {
    httpStatus: response?.status || null,
    nextAction,
  });
}

function assertId(value, prefix, code) {
  const text = String(value || "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(text)) {
    throw new LocalVideoProofError(code, "Local video proof response contains an invalid resource id.");
  }
  return text;
}

function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new LocalVideoProofError("LOCAL_VIDEO_PROOF_TIMEOUT", "Local video proof timed out."));
  }, timeoutMs);
  if (typeof timeoutId.unref === "function") timeoutId.unref();
  return { controller, timeoutId };
}

function delay(ms, signal = null) {
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  return new Promise((resolveDelay, rejectDelay) => {
    const timeoutId = setTimeout(resolveDelay, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      rejectDelay(new LocalVideoProofError("LOCAL_VIDEO_PROOF_TIMEOUT", "Local video proof timed out."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function localProofServerEnvironment({ port, dataDir, env = {}, config = {} } = {}) {
  return {
    ...process.env,
    ...env,
    ...(config.scoreboardOcrEnabled
      ? {
          SHORTSENGINE_SCOREBOARD_OCR_ENABLED: "1",
          SHORTSENGINE_SCOREBOARD_OCR_PROVIDER: String(rawValue(env, "SHORTSENGINE_SCOREBOARD_OCR_PROVIDER") || "local"),
        }
      : {}),
    ...(config.scoreboardOcrQaEnabled ? { SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS: "1" } : {}),
    MATCHCUTS_DATA_DIR: dataDir,
    PORT: String(port),
    MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
  };
}

function sanitizeServerEvent(parsed, stream) {
  const event = {
    stream,
    level: parsed.level || (stream === "stderr" ? "error" : "info"),
    event: parsed.event || null,
    code: parsed.code || null,
    service: parsed.service || null,
  };
  if (parsed.event === "video_output_qa_failed") {
    event.videoOutputQA = {
      status: safeString(parsed.status, 40),
      expectedGoalCount: safeNumber(parsed.expectedGoalCount),
      actualConfirmedGoalSegmentCount: safeNumber(parsed.actualConfirmedGoalSegmentCount),
      coveredGoalCount: safeNumber(parsed.coveredGoalCount),
      missingGoalNumbers: Array.isArray(parsed.missingGoalNumbers)
        ? parsed.missingGoalNumbers.map(Number).filter(Number.isFinite).slice(0, 12)
        : [],
      failedReasonCount: safeNumber(parsed.failedReasonCount),
    };
  }
  if (parsed.event === "valid_goal_selection_empty") {
    event.goalDiscovery = {
      scoreboardOcrAttempted: Boolean(parsed.scoreboardOcrAttempted),
      scoreboardOcrEnabled: Boolean(parsed.scoreboardOcrEnabled),
      scoreboardObservationCount: safeNumber(parsed.scoreboardObservationCount),
      scoreChangeCount: safeNumber(parsed.scoreChangeCount),
      stableScoreChangeCount: safeNumber(parsed.stableScoreChangeCount),
      countedGoalEventCount: safeNumber(parsed.countedGoalEventCount),
      selectedValidGoalCount: safeNumber(parsed.selectedValidGoalCount),
      missingEvidenceByCandidate: Array.isArray(parsed.missingEvidenceByCandidate)
        ? parsed.missingEvidenceByCandidate.slice(0, 12).map((item, index) => ({
            index: safeNumber(item && item.index) || index + 1,
            id: safeString(item && item.id, 80) || null,
            missingEvidence: safeList(item && item.missingEvidence, 8, 80),
            rejectionReason: item && item.rejectionReason ? safeString(item.rejectionReason, 80) : null,
          }))
        : [],
      nextAction: parsed.nextAction ? safeString(parsed.nextAction, 160) : null,
    };
  }
  if (parsed.event === "scoreboard_ocr_completed") {
    event.scoreboardOcr = {
      providerMode: safeString(parsed.providerMode, 80),
      fallbackUsed: typeof parsed.fallbackUsed === "boolean" ? parsed.fallbackUsed : null,
      sampledFrameCount: safeNumber(parsed.sampledFrameCount),
      evidenceCount: safeNumber(parsed.evidenceCount),
      scoreChangeCount: safeNumber(parsed.scoreChangeCount),
      scoreRevertedCount: safeNumber(parsed.scoreRevertedCount),
      ambiguousCount: safeNumber(parsed.ambiguousCount),
      unreadableCount: safeNumber(parsed.unreadableCount),
      qaReport: parsed.qaReport && typeof parsed.qaReport === "object"
        ? {
            enabled: Boolean(parsed.qaReport.enabled),
            status: safeString(parsed.qaReport.status, 40) || null,
            reportPath: parsed.qaReport.reportPath ? safeString(parsed.qaReport.reportPath, 180) : null,
            contactSheetPath: parsed.qaReport.contactSheetPath ? safeString(parsed.qaReport.contactSheetPath, 180) : null,
            cropCount: safeNumber(parsed.qaReport.cropCount),
          }
        : null,
    };
  }
  return event;
}

function startServer(port, env, config) {
  const tmpRoot = resolve(ROOT_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dataDir = mkdtempSync(resolve(tmpRoot, "shortsengine-local-proof-data-"));
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: localProofServerEnvironment({ port, dataDir, env, config }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  const collect = (chunk, stream) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      let event = { stream, level: stream === "stderr" ? "error" : "info", event: "server_output" };
      try {
        event = sanitizeServerEvent(JSON.parse(line), stream);
      } catch {
        // Raw process output stays out of persisted reports.
      }
      events.push(event);
      if (events.length > 50) events.shift();
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
      // Best-effort cleanup for isolated local proof storage.
    }
  }
}

async function waitForServerReady({ baseUrl, child = null, events = [], fetchImpl, timeoutMs = DEFAULT_SERVER_READY_TIMEOUT_MS }) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < timeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode)) {
      const failure = [...events].reverse().find((event) => event && event.code);
      throw new LocalVideoProofError(
        "LOCAL_VIDEO_PROOF_SERVER_BIND_FAILED",
        "Local proof server exited before readiness.",
        { causeCode: failure?.code || child.signalCode || `exit_${child.exitCode}` },
      );
    }
    attempts += 1;
    try {
      const response = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/health"), { method: "GET" });
      if (response.ok && response.payload?.data?.status === "ready") {
        return { attempts, waitedMs: Date.now() - started, status: response.status };
      }
    } catch {
      // Keep polling until bounded timeout.
    }
    await delay(250);
  }
  throw new LocalVideoProofError(
    "LOCAL_VIDEO_PROOF_SERVER_READY_TIMEOUT",
    "Local proof server did not become ready in time.",
    { attempts, waitedMs: Date.now() - started, timeoutMs },
  );
}

async function uploadLocalMp4({ baseUrl, config, fetchImpl, signal = null }) {
  const multipart = createMultipartBody([
    { name: "title", value: config.source.label || "ShortsEngine Local MP4 Proof" },
    { name: "source", value: LOCAL_PROOF_SOURCE_MARKER },
    {
      name: "video",
      fileName: config.source.fileName,
      mimeType: "video/mp4",
      value: readFileSync(config.source.resolvedFile),
    },
  ]);
  const response = await fetchJson(fetchImpl, endpointUrl(baseUrl, "/api/uploads"), {
    method: "POST",
    signal,
    headers: {
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.length),
    },
    body: multipart.body,
    maxBytes: 512 * 1024,
  });
  const data = assertApiOk(response, "LOCAL_VIDEO_PROOF_UPLOAD_FAILED", "Local video proof upload failed.");
  return {
    projectId: assertId(data.project?.id, "prj", "LOCAL_VIDEO_PROOF_UPLOAD_RESPONSE_INVALID"),
    uploadId: assertId(data.upload?.id, "upl", "LOCAL_VIDEO_PROOF_UPLOAD_RESPONSE_INVALID"),
    requestIdPresent: Boolean(response.requestId),
  };
}

async function startGenerate({ baseUrl, projectId, config, fetchImpl, signal = null }) {
  const response = await fetchJson(fetchImpl, endpointUrl(baseUrl, `/api/projects/${projectId}/generate`), {
    method: "POST",
    signal,
    body: JSON.stringify({
      title: config.source.label || "ShortsEngine Local MP4 Proof",
      preset: "hype",
      language: "English",
      rightsConfirmed: true,
      idempotencyKey: `local_video_proof_${Date.now()}_${randomUUID()}`,
    }),
  });
  const data = assertApiOk(response, "LOCAL_VIDEO_PROOF_GENERATE_FAILED", "Local video proof generate request failed.");
  return {
    jobId: assertId(data.job?.id, "job", "LOCAL_VIDEO_PROOF_JOB_RESPONSE_INVALID"),
    requestIdPresent: Boolean(response.requestId),
  };
}

function safeVideoOutputQA(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    status: safeString(value.status, 40) || null,
    passed: typeof value.passed === "boolean" ? value.passed : null,
    goalSelectionMode: safeString(value.goalSelectionMode, 60) || null,
    expectedGoalCount: safeNumber(value.expectedGoalCount),
    actualConfirmedGoalSegmentCount: safeNumber(value.actualConfirmedGoalSegmentCount),
    coveredGoalCount: safeNumber(value.coveredGoalCount),
    missingGoalNumbers: Array.isArray(value.missingGoalNumbers)
      ? value.missingGoalNumbers.map(Number).filter(Number.isFinite).slice(0, 12)
      : [],
    failedReasons: safeList(value.failedReasons, 12, 80),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function safeSegment(segment = {}, index = 0) {
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" ? segment.phaseCoverage : {};
  return {
    index: index + 1,
    id: safeString(segment.id || `segment_${index + 1}`, 80),
    sourceStart: safeNumber(segment.sourceStart),
    shotStart: safeNumber(segment.shotStart),
    finishTime: safeNumber(segment.finishTime),
    confirmationTime: safeNumber(segment.confirmationTime),
    sourceEnd: safeNumber(segment.sourceEnd),
    goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Number(segment.goalNumber) : null,
    replayOnly: Boolean(segment.replayOnly || phase.replayOnly),
    replayUsed: typeof segment.replayUsed === "boolean" ? segment.replayUsed : null,
    phaseCoverage: {
      hasBuildup: Boolean(phase.hasBuildup),
      hasShot: Boolean(phase.hasShot),
      hasFinish: Boolean(phase.hasFinish),
      hasConfirmation: Boolean(phase.hasConfirmation),
    },
    reasonCodes: safeList(segment.reasonCodes, 8, 80),
  };
}

function safeRenderPlan(job) {
  const plan = job?.editPlan && typeof job.editPlan === "object" ? job.editPlan : null;
  if (!plan) return null;
  const segments = Array.isArray(plan.segments) ? plan.segments.map(safeSegment).slice(0, 12) : [];
  return {
    mode: safeString(plan.mode || "", 60) || null,
    goalSelectionMode: safeString(plan.goalSelectionMode || "", 60) || null,
    totalDuration: safeNumber(plan.totalDuration || Number(plan.sourceEnd) - Number(plan.sourceStart)),
    segmentCount: segments.length,
    segments,
    videoOutputQA: safeVideoOutputQA(job.videoOutputQA || plan.videoOutputQA),
  };
}

async function pollJob({ baseUrl, fetchImpl, jobId, jobTimeoutMs, pollIntervalMs, signal = null }) {
  const started = Date.now();
  const lifecycle = [];
  let current = null;
  while (Date.now() - started < jobTimeoutMs) {
    if (signal?.aborted) throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_TIMEOUT", "Local video proof timed out.");
    const response = await fetchJson(fetchImpl, endpointUrl(baseUrl, `/api/jobs/${jobId}`), { method: "GET", signal });
    current = response.payload?.data?.job || null;
    if (current) {
      lifecycle.push({
        id: current.id || null,
        projectId: current.projectId || null,
        uploadId: current.uploadId || null,
        status: current.status || null,
        progress: safeNumber(current.progress) || 0,
        step: current.step || null,
        exportId: current.exportId || null,
        error: safeReportError(current.error),
        videoOutputQA: safeVideoOutputQA(current.videoOutputQA || current.editPlan?.videoOutputQA),
      });
    }
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
      return { job: current, lifecycle, timeout: false };
    }
    await delay(pollIntervalMs, signal);
  }
  return { job: current, lifecycle, timeout: true };
}

function assertCompletedJob(job) {
  if (!job || job.status !== "completed") {
    const videoOutputQA = safeVideoOutputQA(job?.videoOutputQA || job?.editPlan?.videoOutputQA);
    throw new LocalVideoProofError(job?.error?.code || "LOCAL_VIDEO_PROOF_JOB_FAILED", "Local video proof render job did not complete.", {
      videoOutputQA,
      countedGoalEventCount: videoOutputQA ? videoOutputQA.expectedGoalCount : null,
      actualConfirmedGoalSegmentCount: videoOutputQA ? videoOutputQA.actualConfirmedGoalSegmentCount : null,
      coveredGoalCount: videoOutputQA ? videoOutputQA.coveredGoalCount : null,
      missingGoalNumbers: videoOutputQA ? videoOutputQA.missingGoalNumbers : [],
      failedReasons: videoOutputQA ? videoOutputQA.failedReasons : [],
    });
  }
  return { exportId: assertId(job.exportId, "exp", "LOCAL_VIDEO_PROOF_EXPORT_MISSING") };
}

function assertOutputGate(job, expectedCountedGoals) {
  const qa = safeVideoOutputQA(job.videoOutputQA || job.editPlan?.videoOutputQA);
  const renderPlan = safeRenderPlan(job);
  const actual = Number(qa?.actualConfirmedGoalSegmentCount);
  const covered = Number(qa?.coveredGoalCount);
  const expectedFromQa = Number(qa?.expectedGoalCount);
  const passed = Boolean(
    qa &&
      qa.passed === true &&
      qa.goalSelectionMode === "valid_goals_only" &&
      expectedFromQa === expectedCountedGoals &&
      actual === expectedCountedGoals &&
      covered === expectedCountedGoals &&
      renderPlan?.segments?.length === expectedCountedGoals &&
      renderPlan.segments.every((segment) => (
        segment.replayOnly === false &&
        segment.phaseCoverage.hasBuildup &&
        segment.phaseCoverage.hasShot &&
        segment.phaseCoverage.hasFinish &&
        segment.phaseCoverage.hasConfirmation
      )),
  );
  if (!passed) {
    throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_OUTPUT_QA_FAILED", "Local video proof output QA did not prove every counted goal.", {
      videoOutputQA: qa,
      countedGoalEventCount: qa ? qa.expectedGoalCount : null,
      actualConfirmedGoalSegmentCount: qa ? qa.actualConfirmedGoalSegmentCount : null,
      coveredGoalCount: qa ? qa.coveredGoalCount : null,
      missingGoalNumbers: qa ? qa.missingGoalNumbers : [],
      failedReasons: qa ? qa.failedReasons : ["local_proof_expected_count_not_verified"],
      expectedCountedGoals,
      renderPlan,
    });
  }
  return { videoOutputQA: qa, renderPlan };
}

function validateMp4Download(download) {
  if (!download.ok || !String(download.contentType || "").includes("video/mp4")) {
    throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_DOWNLOAD_NOT_MP4", "Local video proof download did not return an MP4.");
  }
  if (!Buffer.isBuffer(download.buffer) || download.buffer.length < 12 || download.buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_MP4_SIGNATURE_INVALID", "Local video proof download has an invalid MP4 signature.");
  }
  return {
    status: download.status,
    contentType: download.contentType,
    sizeBytes: download.buffer.length,
    sha256Prefix: createHash("sha256").update(download.buffer).digest("hex").slice(0, 16),
  };
}

function safeTimestamp(value) {
  return String(value || nowIso()).replace(/[:.]/g, "-").replace(/[^A-Za-z0-9TZ_-]/g, "-");
}

function safeDownloadArtifactRef(candidate) {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    !text.startsWith(`${MANUAL_DOWNLOADS_DIR}/`) ||
    extname(text).toLowerCase() !== ".mp4"
  ) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_OUTPUT_REF_UNSAFE",
      "Local video proof output reference must stay under manual-downloads.",
    );
  }
  const resolvedFile = resolve(ROOT_DIR, text);
  const rel = relative(ROOT_DIR, resolvedFile).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..") {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_OUTPUT_REF_UNSAFE",
      "Local video proof output reference must stay inside the workspace.",
    );
  }
  return { relativePath: text, resolvedFile };
}

function defaultDownloadArtifactRef(config, timestamp) {
  const label = String(config.source.label || "local")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32) || "local";
  return `${MANUAL_DOWNLOADS_DIR}/shortsengine-local-proof-${label}-${safeTimestamp(timestamp)}.mp4`;
}

function isManagedLocalProofMp4(fileName) {
  return /^shortsengine-local-proof-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T[A-Za-z0-9_-]+\.mp4$/.test(String(fileName || ""));
}

function cleanupGeneratedProofArtifacts(options = {}) {
  const manualDir = resolve(ROOT_DIR, options.manualDir || MANUAL_DOWNLOADS_DIR);
  const relDir = relative(ROOT_DIR, manualDir).replace(/\\/g, "/");
  if (relDir !== MANUAL_DOWNLOADS_DIR) {
    throw new LocalVideoProofError(
      "LOCAL_VIDEO_PROOF_CLEANUP_DIR_UNSAFE",
      "Local proof cleanup directory is unsafe.",
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
  for (const entry of readdirSafe(manualDir)) {
    const file = resolve(manualDir, entry);
    let stats = null;
    try {
      stats = statSync(file);
    } catch {
      summary.skippedCount += 1;
      continue;
    }
    if (!stats.isFile() || !isManagedLocalProofMp4(entry)) {
      summary.skippedCount += 1;
      continue;
    }
    try {
      rmSync(file, { force: true });
      summary.deletedCount += 1;
      summary.deleted.push(`${MANUAL_DOWNLOADS_DIR}/${entry}`);
    } catch {
      summary.errors.push({ relativePath: `${MANUAL_DOWNLOADS_DIR}/${entry}`, code: "DELETE_FAILED" });
    }
  }
  return summary;
}

function readdirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function writeOutputArtifact({ buffer, downloadSummary, config, env, timestamp }) {
  const requested = rawValue(env || {}, "SHORTSENGINE_LOCAL_PROOF_OUTPUT_ARTIFACT");
  const target = safeDownloadArtifactRef(requested || defaultDownloadArtifactRef(config, timestamp));
  mkdirSync(dirname(target.resolvedFile), { recursive: true });
  writeFileSync(target.resolvedFile, buffer);
  return {
    type: "rendered_video",
    status: "available",
    relativePath: target.relativePath,
    sourceType: "local_mp4",
    sizeBytes: downloadSummary.sizeBytes,
    contentType: downloadSummary.contentType,
    sha256Prefix: downloadSummary.sha256Prefix,
    downloadVerified: true,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function probeGeneratedMp4(artifact) {
  if (!artifact || typeof artifact !== "object" || !artifact.relativePath) {
    return {
      checked: false,
      status: "skipped",
      code: "OUTPUT_MP4_NOT_CREATED",
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
    durationSeconds: safeNumber(probed.durationSeconds),
    width: safeNumber(probed.width),
    height: safeNumber(probed.height),
    videoCodec: probed.videoCodec || null,
    audioPresent: typeof probed.audioPresent === "boolean" ? probed.audioPresent : null,
  };
}

function outputProofFromSuccess({ config, artifact, ffprobe, renderPlan, videoOutputQA }) {
  return {
    schemaVersion: LOCAL_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    source: sourcePublicSummary(config.source),
    expectedCountedGoals: config.expectedCountedGoals,
    countedGoalEventCount: videoOutputQA.expectedGoalCount,
    selectedValidGoalCount: videoOutputQA.actualConfirmedGoalSegmentCount,
    actualConfirmedGoalSegmentCount: videoOutputQA.actualConfirmedGoalSegmentCount,
    coveredGoalCount: videoOutputQA.coveredGoalCount,
    missingGoalNumbers: videoOutputQA.missingGoalNumbers,
    failedReasons: videoOutputQA.failedReasons,
    scoreboardOcrAttempted: config.scoreboardOcrEnabled,
    scoreboardOcrEnabled: config.scoreboardOcrEnabled,
    scoreboardObservationCount: null,
    scoreChangeCount: null,
    stableScoreChangeCount: null,
    missingEvidenceByCandidate: [],
    outputMp4: artifact
      ? {
          relativePath: artifact.relativePath,
          sizeBytes: artifact.sizeBytes,
          contentType: artifact.contentType,
          sha256Prefix: artifact.sha256Prefix,
          downloadVerified: Boolean(artifact.downloadVerified),
        }
      : null,
    ffprobe,
    renderPlan,
    videoOutputQA,
    verdict: videoOutputQA.passed === true && ffprobe?.status === "passed" ? "passed" : "failed",
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function latestServerEvent(events = [], key) {
  return [...(Array.isArray(events) ? events : [])].reverse().find((event) => event && event[key]);
}

function outputProofFromFailure({ config = null, error = null, job = null, serverEvents = [] }) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const videoOutputQA = details.videoOutputQA || safeVideoOutputQA(job?.videoOutputQA || job?.editPlan?.videoOutputQA);
  const ocrEvent = latestServerEvent(serverEvents, "scoreboardOcr")?.scoreboardOcr || null;
  const goalDiscovery = latestServerEvent(serverEvents, "goalDiscovery")?.goalDiscovery || null;
  return {
    schemaVersion: LOCAL_PROOF_SCHEMA_VERSION,
    generatedAt: nowIso(),
    phase: details.phase || phaseForCode(error?.code),
    code: error?.code || "LOCAL_VIDEO_PROOF_FAILED",
    source: config ? sourcePublicSummary(config.source) : null,
    expectedCountedGoals: config?.expectedCountedGoals || null,
    countedGoalEventCount: safeNumber(details.countedGoalEventCount) ?? safeNumber(videoOutputQA?.expectedGoalCount) ?? 0,
    selectedValidGoalCount: safeNumber(goalDiscovery?.selectedValidGoalCount) ?? 0,
    actualConfirmedGoalSegmentCount: safeNumber(details.actualConfirmedGoalSegmentCount) ??
      safeNumber(videoOutputQA?.actualConfirmedGoalSegmentCount) ??
      0,
    coveredGoalCount: safeNumber(details.coveredGoalCount) ?? safeNumber(videoOutputQA?.coveredGoalCount) ?? 0,
    missingGoalNumbers: Array.isArray(details.missingGoalNumbers)
      ? details.missingGoalNumbers.map(Number).filter(Number.isFinite).slice(0, 12)
      : (videoOutputQA?.missingGoalNumbers || []),
    failedReasons: details.failedReasons ? safeList(details.failedReasons, 12, 80) : (videoOutputQA?.failedReasons || []),
    scoreboardOcrAttempted: Boolean(goalDiscovery?.scoreboardOcrAttempted || ocrEvent),
    scoreboardOcrEnabled: Boolean(config?.scoreboardOcrEnabled || goalDiscovery?.scoreboardOcrEnabled),
    scoreboardObservationCount: safeNumber(goalDiscovery?.scoreboardObservationCount) ?? safeNumber(ocrEvent?.evidenceCount) ?? 0,
    scoreChangeCount: safeNumber(goalDiscovery?.scoreChangeCount) ?? safeNumber(ocrEvent?.scoreChangeCount) ?? 0,
    stableScoreChangeCount: safeNumber(goalDiscovery?.stableScoreChangeCount) ?? 0,
    missingEvidenceByCandidate: Array.isArray(goalDiscovery?.missingEvidenceByCandidate)
      ? goalDiscovery.missingEvidenceByCandidate
      : [],
    outputMp4: null,
    ffprobe: {
      checked: false,
      status: "skipped",
      code: "OUTPUT_MP4_NOT_CREATED",
    },
    renderPlan: details.renderPlan || safeRenderPlan(job),
    videoOutputQA,
    nextAction: details.nextAction || nextActionForCode(error?.code),
    verdict: "failed",
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function safeFailure(error) {
  const base = safeReportError(error) || { code: "LOCAL_VIDEO_PROOF_FAILED", message: "Local video proof failed." };
  const code = error && error.code ? error.code : base.code;
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    code,
    message: base.message,
    phase: details.phase || phaseForCode(code),
    nextAction: details.nextAction || nextActionForCode(code),
    httpStatus: Number.isFinite(Number(details.httpStatus)) ? Number(details.httpStatus) : null,
    countedGoalEventCount: safeNumber(details.countedGoalEventCount),
    actualConfirmedGoalSegmentCount: safeNumber(details.actualConfirmedGoalSegmentCount),
    coveredGoalCount: safeNumber(details.coveredGoalCount),
    missingGoalNumbers: Array.isArray(details.missingGoalNumbers)
      ? details.missingGoalNumbers.map(Number).filter(Number.isFinite).slice(0, 12)
      : [],
    failedReasons: safeList(details.failedReasons, 12, 80),
  };
}

function reportNextAction({ checks, failedCases, status }) {
  const failure = failedCases[0] || null;
  if (failure?.nextAction) return failure.nextAction;
  if (status === "skipped") return checks.find((check) => check.nextAction)?.nextAction || null;
  return null;
}

function safeReport(report) {
  const leak = findSensitiveLeak(report);
  if (!leak) return report;
  return {
    schemaVersion: LOCAL_PROOF_SCHEMA_VERSION,
    timestamp: report.timestamp || nowIso(),
    generatedAt: nowIso(),
    command: report.command || DEFAULT_COMMAND_NAME,
    status: "failed",
    passed: false,
    skipped: false,
    mode: "local-video-proof",
    phase: PHASES.REPORT,
    nextAction: nextActionForCode("LOCAL_VIDEO_PROOF_REPORT_LEAK"),
    checks: [{
      name: "local_video_proof_report_no_sensitive_leaks",
      passed: false,
      code: "LOCAL_VIDEO_PROOF_REPORT_LEAK",
      leakCode: leak.code,
      leakPath: leak.path,
    }],
    steps: [],
    source: report.source || null,
    outputProof: null,
    failedCases: [{
      name: "local_video_proof_report_no_sensitive_leaks",
      code: "LOCAL_VIDEO_PROOF_REPORT_LEAK",
      phase: PHASES.REPORT,
      nextAction: nextActionForCode("LOCAL_VIDEO_PROOF_REPORT_LEAK"),
      leakCode: leak.code,
      leakPath: leak.path,
    }],
  };
}

function buildReport({
  checks,
  commandName,
  config,
  durationMs,
  failedCases,
  ids,
  outputProof,
  serverEvents,
  source,
  staleArtifactCleanup,
  status,
  steps,
}) {
  const phase = failedCases[0]?.phase || (status === "skipped" ? PHASES.SKIPPED : status === "passed" ? PHASES.COMPLETED : null);
  return safeReport({
    schemaVersion: LOCAL_PROOF_SCHEMA_VERSION,
    timestamp: nowIso(),
    generatedAt: nowIso(),
    command: commandName || DEFAULT_COMMAND_NAME,
    status,
    passed: status === "passed",
    skipped: status === "skipped",
    mode: "local-video-proof",
    phase,
    nextAction: reportNextAction({ checks, failedCases, status }),
    durationMs,
    source: sourcePublicSummary(source),
    expectedCountedGoals: config?.expectedCountedGoals || null,
    checks,
    steps,
    ids,
    outputProof,
    staleArtifactCleanup: staleArtifactCleanup || null,
    serverEvents: (Array.isArray(serverEvents) ? serverEvents : []).slice(-50),
    failedCases,
    logsDownloaded: false,
    artifactsDownloaded: false,
  });
}

async function runLocalVideoProof(options = {}) {
  const started = Date.now();
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const commandName = options.commandName || DEFAULT_COMMAND_NAME;
  const checks = [];
  const steps = [];
  const failedCases = [];
  const ids = {};
  const serverEvents = [];
  let config = null;
  let server = null;
  let outputProof = null;
  let staleArtifactCleanup = null;
  let finalJob = null;

  const deps = {
    cleanupGeneratedArtifacts: options.cleanupGeneratedArtifacts || cleanupGeneratedProofArtifacts,
    getFreePort: options.getFreePort || getFreePort,
    startServer: options.startServer || startServer,
    stopServer: options.stopServer || stopServer,
    waitForServerReady: options.waitForServerReady || waitForServerReady,
    uploadLocalMp4: options.uploadLocalMp4 || uploadLocalMp4,
    startGenerate: options.startGenerate || startGenerate,
    pollJob: options.pollJob || pollJob,
    fetchDownload: options.fetchDownload || fetchDownload,
    writeOutputArtifact: options.writeOutputArtifact || writeOutputArtifact,
    probeGeneratedMp4: options.probeGeneratedMp4 || probeGeneratedMp4,
  };

  try {
    config = validateLocalProofConfig(env, options);
    if (config.skipped) {
      addCheck(checks, "local_video_proof_explicit_source", true, {
        code: "LOCAL_VIDEO_PROOF_SKIPPED",
        nextAction: nextActionForCode("LOCAL_VIDEO_PROOF_SKIPPED"),
      });
      return buildReport({
        checks,
        commandName,
        config,
        durationMs: Date.now() - started,
        failedCases,
        ids,
        outputProof,
        serverEvents,
        source: null,
        status: "skipped",
        steps,
      });
    }

    addCheck(checks, "local_video_proof_rights_confirmed", true);
    addCheck(checks, "local_video_proof_source_validated_before_server", true, {
      fileName: config.source.fileName,
      sizeBytes: config.source.sizeBytes,
      expectedCountedGoals: config.expectedCountedGoals,
    });
    staleArtifactCleanup = deps.cleanupGeneratedArtifacts({ env, config });
    addStep(steps, "fresh-output-cleanup", "passed", {
      attempted: Boolean(staleArtifactCleanup?.attempted),
      deletedCount: safeNumber(staleArtifactCleanup?.deletedCount),
    });

    const configuredPort = options.port || rawValue(env, "SHORTSENGINE_LOCAL_PROOF_PORT");
    const port = configuredPort
      ? parseInteger(configuredPort, null, 1, 65535, "LOCAL_VIDEO_PROOF_PORT_INVALID")
      : await deps.getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = deps.startServer(port, env, config);
    addStep(steps, "server", "started", { target: "local" });
    const ready = await deps.waitForServerReady({
      baseUrl,
      child: server.child,
      events: server.events,
      fetchImpl,
      timeoutMs: parseInteger(
        rawValue(env, "SHORTSENGINE_LOCAL_PROOF_SERVER_READY_TIMEOUT_MS"),
        DEFAULT_SERVER_READY_TIMEOUT_MS,
        1000,
        120_000,
        "LOCAL_VIDEO_PROOF_SERVER_READY_TIMEOUT",
      ),
    });
    addStep(steps, "server-ready", "passed", {
      attempts: ready.attempts,
      waitedMs: ready.waitedMs,
      httpStatus: ready.status,
    });

    const upload = await deps.uploadLocalMp4({ baseUrl, config, fetchImpl, signal: options.signal });
    ids.projectId = upload.projectId;
    ids.uploadId = upload.uploadId;
    addStep(steps, "upload", "passed", {
      projectId: ids.projectId,
      uploadId: ids.uploadId,
      requestIdPresent: Boolean(upload.requestIdPresent),
      sourceMarker: LOCAL_PROOF_SOURCE_MARKER,
    });

    const generate = await deps.startGenerate({ baseUrl, projectId: ids.projectId, config, fetchImpl, signal: options.signal });
    ids.jobId = generate.jobId;
    addStep(steps, "generate", "passed", {
      jobId: ids.jobId,
      requestIdPresent: Boolean(generate.requestIdPresent),
    });

    const polled = await deps.pollJob({
      baseUrl,
      fetchImpl,
      jobId: ids.jobId,
      signal: options.signal,
      jobTimeoutMs: parseInteger(
        rawValue(env, "SHORTSENGINE_LOCAL_PROOF_JOB_TIMEOUT_MS"),
        DEFAULT_JOB_TIMEOUT_MS,
        1000,
        20 * 60 * 1000,
        "LOCAL_VIDEO_PROOF_JOB_TIMEOUT_INVALID",
      ),
      pollIntervalMs: parseInteger(
        rawValue(env, "SHORTSENGINE_LOCAL_PROOF_POLL_INTERVAL_MS"),
        DEFAULT_POLL_INTERVAL_MS,
        100,
        10_000,
        "LOCAL_VIDEO_PROOF_POLL_INTERVAL_INVALID",
      ),
    });
    if (polled.timeout) {
      throw new LocalVideoProofError("LOCAL_VIDEO_PROOF_JOB_TIMEOUT", "Local video proof render job timed out.");
    }
    finalJob = polled.job;
    const completed = assertCompletedJob(finalJob);
    ids.exportId = completed.exportId;
    const { videoOutputQA, renderPlan } = assertOutputGate(finalJob, config.expectedCountedGoals);
    addStep(steps, "video-output-qa", "passed", {
      expectedGoalCount: videoOutputQA.expectedGoalCount,
      actualConfirmedGoalSegmentCount: videoOutputQA.actualConfirmedGoalSegmentCount,
      coveredGoalCount: videoOutputQA.coveredGoalCount,
    });

    const downloadMaxBytes = parseInteger(
      rawValue(env, "SHORTSENGINE_LOCAL_PROOF_DOWNLOAD_MAX_BYTES"),
      DEFAULT_DOWNLOAD_MAX_BYTES,
      1024,
      1024 * 1024 * 1024,
      "LOCAL_VIDEO_PROOF_DOWNLOAD_LIMIT_INVALID",
    );
    const download = await deps.fetchDownload(fetchImpl, endpointUrl(baseUrl, `/api/exports/${ids.exportId}/download`), downloadMaxBytes);
    const downloadSummary = validateMp4Download(download);
    const artifact = deps.writeOutputArtifact({
      buffer: download.buffer,
      downloadSummary,
      config,
      env,
      timestamp: nowIso(),
    });
    const ffprobe = deps.probeGeneratedMp4(artifact);
    if (ffprobe.status !== "passed") {
      throw new LocalVideoProofError(
        "LOCAL_VIDEO_PROOF_MP4_SIGNATURE_INVALID",
        "Local video proof generated MP4 did not pass ffprobe.",
        { phase: PHASES.DOWNLOAD },
      );
    }
    outputProof = outputProofFromSuccess({ config, artifact, ffprobe, renderPlan, videoOutputQA });
    addStep(steps, "download", "passed", {
      exportId: ids.exportId,
      relativePath: artifact.relativePath,
      sizeBytes: artifact.sizeBytes,
    });

    for (const [name, passed] of [
      ["local_video_proof_upload_created_project", Boolean(ids.projectId)],
      ["local_video_proof_upload_created_upload", Boolean(ids.uploadId)],
      ["local_video_proof_render_created_export", Boolean(ids.exportId)],
      ["local_video_proof_video_output_qa_passed", videoOutputQA.passed === true],
      ["local_video_proof_output_written_after_gate", Boolean(outputProof.outputMp4?.relativePath)],
      ["local_video_proof_ffprobe_passed", outputProof.ffprobe?.status === "passed"],
    ]) {
      addCheck(checks, name, passed);
    }
  } catch (error) {
    const failure = safeFailure(error);
    failedCases.push({ name: "local_video_proof", ...failure });
    addStep(steps, "failure", "failed", {
      code: failure.code,
      phase: failure.phase,
      nextAction: failure.nextAction,
    });
    outputProof = outputProofFromFailure({ config, error, job: finalJob, serverEvents });
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
    config,
    durationMs: Date.now() - started,
    failedCases,
    ids,
    outputProof,
    serverEvents,
    source: config?.source || null,
    staleArtifactCleanup,
    status: failedCases.length ? "failed" : "passed",
    steps,
  });
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

function writeLocalVideoProofReport(report, outputDir = RESULTS_DIR) {
  const safe = safeReport(report);
  mkdirSync(outputDir, { recursive: true });
  const stamp = safe.timestamp.replace(/[:.]/g, "-");
  const reportFile = resolve(outputDir, `local-video-proof-${stamp}.json`);
  const latestFile = resolve(outputDir, "local-video-proof-latest.json");
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
      process.env.SHORTSENGINE_LOCAL_PROOF_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      20 * 60 * 1000,
      "LOCAL_VIDEO_PROOF_TIMEOUT_INVALID",
    );
  } catch (error) {
    const failure = safeFailure(error);
    const report = buildReport({
      checks: [{ name: "local_video_proof_timeout_config_valid", passed: false, code: failure.code }],
      commandName: DEFAULT_COMMAND_NAME,
      config: null,
      durationMs: 0,
      failedCases: [{ name: "local_video_proof_timeout_config_valid", ...failure }],
      ids: {},
      outputProof: outputProofFromFailure({ error }),
      serverEvents: [],
      source: null,
      status: "failed",
      steps: [{ step: "config", status: "failed", code: failure.code, nextAction: failure.nextAction }],
    });
    const written = writeLocalVideoProofReport(report);
    console.log(JSON.stringify({ status: report.status, failedCases: report.failedCases, ...written }, null, 2));
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    const { controller, timeoutId } = createTimeoutController(timeout);
    const report = await runLocalVideoProof({ signal: controller.signal }).catch((error) => {
      const failure = safeFailure(error);
      return buildReport({
        checks: [{ name: "local_video_proof_unexpected_failure", passed: false, code: failure.code }],
        commandName: DEFAULT_COMMAND_NAME,
        config: null,
        durationMs: timeout,
        failedCases: [{ name: "local_video_proof_unexpected_failure", ...failure }],
        ids: {},
        outputProof: outputProofFromFailure({ error }),
        serverEvents: [],
        source: null,
        status: "failed",
        steps: [{ step: "failure", status: "failed", code: failure.code, nextAction: failure.nextAction }],
      });
    });
    clearTimeout(timeoutId);
    const written = writeLocalVideoProofReport(report);
    console.log(JSON.stringify({
      status: report.status,
      phase: report.phase,
      passed: report.passed,
      skipped: report.skipped,
      nextAction: report.nextAction,
      outputMp4: report.outputProof?.outputMp4 || null,
      failedCases: report.failedCases,
      ...written,
    }, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  LOCAL_PROOF_SOURCE_MARKER,
  LocalVideoProofError,
  cleanupGeneratedProofArtifacts,
  outputProofFromFailure,
  outputProofFromSuccess,
  runLocalVideoProof,
  safeDownloadArtifactRef,
  validateLocalProofConfig,
  writeLocalVideoProofReport,
};
