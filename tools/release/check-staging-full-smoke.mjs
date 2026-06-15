import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMultipartBody } from "../../demo/run-smoke.mjs";
import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import {
  DEFAULT_FIXTURE_PATH,
  ROOT_DIR,
} from "../../demo/create-fixture.mjs";
import {
  hostNetworkType,
  validateStagingUrl,
} from "./check-staging-readiness.mjs";
import {
  healthUrlFor,
  validateHealthPayload,
} from "./check-staging-smoke.mjs";

const FULL_SMOKE_FLAG = "SHORTSENGINE_STAGING_FULL_SMOKE";
const DEFAULT_FULL_TIMEOUT_MS = 120_000;
const DEFAULT_JOB_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_JSON_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 80 * 1024 * 1024;
const DEFAULT_FIXTURE_MAX_BYTES = 32 * 1024 * 1024;
const ALLOWED_FIXTURE_EXTENSIONS = Object.freeze([".mp4", ".mov", ".webm"]);

class StagingFullSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StagingFullSmokeError";
    this.code = code;
    this.details = details;
  }
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
    throw new StagingFullSmokeError(code, "Full staging smoke numeric configuration is out of bounds.");
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isInside(parent, child) {
  const fromParent = relative(parent, child);
  return Boolean(fromParent) && !fromParent.startsWith("..") && !isAbsolute(fromParent) && !fromParent.includes("\\");
}

function relativeFromRootDir(rootDir, filePath) {
  const fromRoot = relative(rootDir, filePath).replace(/\\/g, "/");
  if (!fromRoot || fromRoot.startsWith("..") || fromRoot.includes("\u0000")) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_UNSAFE", "Full staging smoke fixture must stay inside the project root.");
  }
  return fromRoot;
}

function validateFixturePath(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const fixtureDir = resolve(rootDir, "demo", "fixtures");
  const configured = options.fixturePath || rawValue(options.env || {}, "SHORTSENGINE_STAGING_FULL_SMOKE_FIXTURE") || DEFAULT_FIXTURE_PATH;
  const raw = String(configured || "").trim();
  if (!raw || raw.includes("\u0000")) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_INVALID", "Full staging smoke fixture is invalid.");
  }
  const fixtureFile = resolve(isAbsolute(raw) ? raw : resolve(rootDir, raw));
  if (!isInside(fixtureDir, fixtureFile) && fixtureFile !== resolve(DEFAULT_FIXTURE_PATH)) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_UNSAFE", "Full staging smoke fixture must stay inside demo fixtures.");
  }
  const extension = extname(fixtureFile).toLowerCase();
  if (!ALLOWED_FIXTURE_EXTENSIONS.includes(extension)) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_EXTENSION_UNSUPPORTED", "Full staging smoke fixture extension is unsupported.");
  }
  if (!existsSync(fixtureFile)) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_MISSING", "Full staging smoke fixture is missing.");
  }
  const stats = statSync(fixtureFile);
  if (!stats.isFile() || stats.size <= 0) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_INVALID", "Full staging smoke fixture is invalid.");
  }
  const maxBytes = parseInteger(
    rawValue(options.env || {}, "SHORTSENGINE_STAGING_FULL_SMOKE_FIXTURE_MAX_BYTES"),
    DEFAULT_FIXTURE_MAX_BYTES,
    1024,
    250 * 1024 * 1024,
    "STAGING_FULL_FIXTURE_LIMIT_INVALID",
  );
  if (stats.size > maxBytes) {
    throw new StagingFullSmokeError("STAGING_FULL_FIXTURE_TOO_LARGE", "Full staging smoke fixture is too large.");
  }
  return {
    absoluteFile: fixtureFile,
    public: {
      exists: true,
      fileName: fixtureFile.split(/[\\/]/).pop(),
      relativePath: relativeFromRootDir(rootDir, fixtureFile),
      sizeBytes: stats.size,
      extension: extension.slice(1),
    },
    maxBytes,
  };
}

function safeTargetSummary(baseUrl) {
  const parsed = new URL(baseUrl);
  const normalizedBasePath = parsed.pathname.replace(/\/+$/, "");
  return {
    configured: true,
    protocol: parsed.protocol.replace(":", ""),
    hostType: hostNetworkType(parsed.hostname),
    healthPath: normalizedBasePath.endsWith("/health") ? normalizedBasePath : `${normalizedBasePath || ""}/health`,
  };
}

async function readBoundedResponseBuffer(response, maxBytes, code) {
  const declaredLength = response.headers && typeof response.headers.get === "function"
    ? Number(response.headers.get("content-length"))
    : null;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new StagingFullSmokeError(code, "Full staging smoke response is too large.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new StagingFullSmokeError(code, "Full staging smoke response is too large.");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new StagingFullSmokeError(code, "Full staging smoke response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  }).catch(() => {
    throw new StagingFullSmokeError("STAGING_FULL_FETCH_FAILED", "Full staging smoke request failed.");
  });
  if (!response || typeof response.status !== "number") {
    throw new StagingFullSmokeError("STAGING_FULL_FETCH_INVALID", "Full staging smoke request returned an invalid response.");
  }
  const maxBytes = options.maxBytes || DEFAULT_JSON_RESPONSE_BYTES;
  const body = await readBoundedResponseBuffer(response, maxBytes, "STAGING_FULL_RESPONSE_TOO_LARGE");
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new StagingFullSmokeError("STAGING_FULL_JSON_INVALID", "Full staging smoke response is not valid JSON.");
  }
  if (findSensitiveLeak(payload)) {
    throw new StagingFullSmokeError("STAGING_FULL_RESPONSE_LEAK", "Full staging smoke response contains sensitive data.");
  }
  return { ok: response.ok && payload && payload.ok === true, status: response.status, payload };
}

function assertApiOk(response, code, message) {
  if (!response || response.ok !== true || !response.payload || response.payload.ok !== true || !response.payload.data) {
    throw new StagingFullSmokeError(code, message);
  }
  return response.payload.data;
}

function assertId(value, prefix, code) {
  const text = String(value || "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(text)) {
    throw new StagingFullSmokeError(code, "Full staging smoke API response is invalid.");
  }
  return text;
}

function validateHealthForFullSmoke(payload, env = {}) {
  const health = validateHealthPayload(payload);
  const data = payload.data || {};
  const ffmpegReady = Boolean(data.ffmpeg && data.ffmpeg.ffmpeg && data.ffmpeg.ffprobe);
  const allowDegraded = boolFromEnv(rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_ALLOW_DEGRADED"));
  if (health.status !== "ready" && !(allowDegraded && ffmpegReady)) {
    throw new StagingFullSmokeError("STAGING_FULL_HEALTH_NOT_READY", "Full staging smoke requires ready health.");
  }
  if (!ffmpegReady) {
    throw new StagingFullSmokeError("STAGING_FULL_FFMPEG_UNAVAILABLE", "Full staging smoke requires FFmpeg and FFprobe.");
  }
  const artifactHealth = data.adapters?.artifacts || data.artifacts || {};
  const persistenceHealth = data.adapters?.persistence || {};
  const objectStorage = Boolean(artifactHealth.objectStorage);
  const database = Boolean(persistenceHealth.database);
  return {
    status: health.status,
    requestIdPresent: health.requestIdPresent,
    ffmpeg: true,
    ffprobe: true,
    storageMode: artifactHealth.mode || data.artifacts?.mode || "unknown",
    persistenceMode: persistenceHealth.mode || "unknown",
    objectStorage,
    database,
    durabilityMode: objectStorage && database ? "durable-capable" : "ephemeral-staging",
  };
}

async function uploadFixture({ baseUrl, fetchImpl, fixture }) {
  const multipart = createMultipartBody([
    { name: "title", value: "ShortsEngine Staging Full Smoke" },
    {
      name: "video",
      fileName: fixture.public.fileName,
      mimeType: fixture.public.extension === "webm" ? "video/webm" : "video/mp4",
      value: readFileSync(fixture.absoluteFile),
    },
  ]);
  if (multipart.body.length > fixture.maxBytes + 64 * 1024) {
    throw new StagingFullSmokeError("STAGING_FULL_UPLOAD_BODY_TOO_LARGE", "Full staging smoke upload body is too large.");
  }
  const response = await fetchJson(fetchImpl, `${baseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.length),
    },
    body: multipart.body,
  });
  const data = assertApiOk(response, "STAGING_FULL_UPLOAD_FAILED", "Full staging smoke upload failed.");
  return {
    projectId: assertId(data.project && data.project.id, "prj", "STAGING_FULL_UPLOAD_RESPONSE_INVALID"),
    uploadId: assertId(data.upload && data.upload.id, "upl", "STAGING_FULL_UPLOAD_RESPONSE_INVALID"),
  };
}

async function startGenerate({ baseUrl, fetchImpl, projectId, nowMs }) {
  const response = await fetchJson(fetchImpl, `${baseUrl}/api/projects/${projectId}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "ShortsEngine Staging Full Smoke",
      preset: "hype",
      language: "English",
      rightsConfirmed: true,
      idempotencyKey: `staging_full_${nowMs}`,
    }),
  });
  const data = assertApiOk(response, "STAGING_FULL_GENERATE_FAILED", "Full staging smoke generate request failed.");
  return assertId(data.job && data.job.id, "job", "STAGING_FULL_GENERATE_RESPONSE_INVALID");
}

async function pollJob({ baseUrl, fetchImpl, jobId, timeoutMs, intervalMs }) {
  const started = Date.now();
  let pollCount = 0;
  let lastStatus = "unknown";
  while (Date.now() - started <= timeoutMs) {
    pollCount += 1;
    const response = await fetchJson(fetchImpl, `${baseUrl}/api/jobs/${jobId}`, { method: "GET" });
    const data = assertApiOk(response, "STAGING_FULL_JOB_FETCH_FAILED", "Full staging smoke job fetch failed.");
    const job = data.job || {};
    lastStatus = String(job.status || "unknown");
    if (["completed", "failed", "cancelled"].includes(lastStatus)) {
      if (lastStatus !== "completed") {
        throw new StagingFullSmokeError("STAGING_FULL_JOB_TERMINAL_FAILURE", "Full staging smoke job did not complete.");
      }
      const exportId = assertId(job.exportId, "exp", "STAGING_FULL_EXPORT_MISSING");
      return { exportId, pollCount, durationMs: Date.now() - started };
    }
    await delay(intervalMs);
  }
  throw new StagingFullSmokeError("STAGING_FULL_JOB_TIMEOUT", "Full staging smoke job polling timed out.", {
    pollCount,
    lastStatus,
  });
}

function validateMp4(buffer) {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp";
}

async function downloadExport({ baseUrl, fetchImpl, exportId, maxBytes }) {
  const response = await fetchImpl(`${baseUrl}/api/exports/${exportId}/download`, {
    method: "GET",
    headers: { accept: "video/mp4" },
  }).catch(() => {
    throw new StagingFullSmokeError("STAGING_FULL_DOWNLOAD_FAILED", "Full staging smoke export download failed.");
  });
  if (!response || typeof response.status !== "number") {
    throw new StagingFullSmokeError("STAGING_FULL_DOWNLOAD_RESPONSE_INVALID", "Full staging smoke export download response is invalid.");
  }
  if (!response.ok) {
    throw new StagingFullSmokeError("STAGING_FULL_DOWNLOAD_HTTP_FAILED", "Full staging smoke export download failed.");
  }
  const contentType = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") || "" : "";
  if (!contentType.toLowerCase().includes("video/mp4")) {
    throw new StagingFullSmokeError("STAGING_FULL_DOWNLOAD_CONTENT_TYPE_INVALID", "Full staging smoke export content type is invalid.");
  }
  const buffer = await readBoundedResponseBuffer(response, maxBytes, "STAGING_FULL_DOWNLOAD_TOO_LARGE");
  if (!validateMp4(buffer)) {
    throw new StagingFullSmokeError("STAGING_FULL_DOWNLOAD_SIGNATURE_INVALID", "Full staging smoke export signature is invalid.");
  }
  return {
    contentType: "video/mp4",
    sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new StagingFullSmokeError("STAGING_FULL_SUMMARY_LEAK", "Full staging smoke summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

async function runStagingFullSmoke(options = {}) {
  const env = options.env || process.env;
  if (!boolFromEnv(rawValue(env, FULL_SMOKE_FLAG))) {
    throw new StagingFullSmokeError("STAGING_FULL_SMOKE_DISABLED", "Full staging smoke requires SHORTSENGINE_STAGING_FULL_SMOKE=1.");
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new StagingFullSmokeError("STAGING_FULL_FETCH_UNAVAILABLE", "Fetch is not available for full staging smoke.");
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const started = Date.now();
  const baseUrl = String(rawValue(env, "SHORTSENGINE_STAGING_URL") || "").trim().replace(/\/+$/, "");
  const allowLocal = boolFromEnv(rawValue(env, "SHORTSENGINE_STAGING_ALLOW_LOCAL_URL"));
  validateStagingUrl(baseUrl, { required: true, allowLocal });
  const timeoutMs = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_TIMEOUT_MS"), DEFAULT_FULL_TIMEOUT_MS, 5_000, 10 * 60 * 1000, "STAGING_FULL_TIMEOUT_INVALID");
  const jobTimeoutMs = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_JOB_TIMEOUT_MS"), DEFAULT_JOB_TIMEOUT_MS, 1_000, timeoutMs, "STAGING_FULL_JOB_TIMEOUT_INVALID");
  const pollIntervalMs = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_POLL_INTERVAL_MS"), DEFAULT_POLL_INTERVAL_MS, 100, 10_000, "STAGING_FULL_POLL_INTERVAL_INVALID");
  const downloadMaxBytes = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_DOWNLOAD_MAX_BYTES"), DEFAULT_DOWNLOAD_MAX_BYTES, 1024, 512 * 1024 * 1024, "STAGING_FULL_DOWNLOAD_LIMIT_INVALID");
  const fixture = validateFixturePath({ env, rootDir: options.rootDir, fixturePath: options.fixturePath });

  const healthResponse = await fetchJson(fetchImpl, healthUrlFor(baseUrl), { method: "GET", maxBytes: 64 * 1024 });
  const health = validateHealthForFullSmoke(healthResponse.payload, env);
  const upload = await uploadFixture({ baseUrl, fetchImpl, fixture });
  const jobId = await startGenerate({ baseUrl, fetchImpl, projectId: upload.projectId, nowMs });
  const job = await pollJob({ baseUrl, fetchImpl, jobId, timeoutMs: jobTimeoutMs, intervalMs: pollIntervalMs });
  const download = await downloadExport({ baseUrl, fetchImpl, exportId: job.exportId, maxBytes: downloadMaxBytes });

  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    mode: "full-staging-smoke",
    target: safeTargetSummary(baseUrl),
    gated: {
      explicitFlag: true,
      healthOnly: false,
      uploadsVideo: true,
      expensiveRender: true,
    },
    fixture: fixture.public,
    health,
    flow: {
      uploadAccepted: true,
      generateAccepted: true,
      jobCompleted: true,
      exportDownloadable: true,
      pollCount: job.pollCount,
      jobDurationMs: job.durationMs,
      totalDurationMs: Date.now() - started,
    },
    export: {
      contentType: download.contentType,
      sizeBytes: download.sizeBytes,
      sha256: download.sha256,
    },
    bounds: {
      timeoutMs,
      jobTimeoutMs,
      pollIntervalMs,
      downloadMaxBytes,
      fixtureMaxBytes: fixture.maxBytes,
      jsonResponseMaxBytes: DEFAULT_JSON_RESPONSE_BYTES,
    },
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "STAGING_FULL_SMOKE_FAILED",
    message: error && error.message ? error.message : "Full staging smoke failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runStagingFullSmoke(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  ALLOWED_FIXTURE_EXTENSIONS,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_FIXTURE_MAX_BYTES,
  DEFAULT_FULL_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  FULL_SMOKE_FLAG,
  StagingFullSmokeError,
  downloadExport,
  runStagingFullSmoke,
  safeError,
  validateFixturePath,
  validateHealthForFullSmoke,
  validateMp4,
};
