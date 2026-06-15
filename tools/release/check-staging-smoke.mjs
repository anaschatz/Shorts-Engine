import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import {
  StagingReadinessError,
  hostNetworkType,
  validateStagingUrl,
} from "./check-staging-readiness.mjs";

const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

class StagingSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StagingSmokeError";
    this.code = code;
    this.details = details;
  }
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new StagingSmokeError(code, "Staging smoke numeric configuration is out of bounds.");
  }
  return parsed;
}

function healthUrlFor(baseUrl) {
  const parsed = new URL(baseUrl);
  const normalizedBasePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalizedBasePath.endsWith("/health") ? normalizedBasePath : `${normalizedBasePath || ""}/health`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
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

function validateHealthPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new StagingSmokeError("STAGING_HEALTH_SHAPE_INVALID", "Staging health response shape is invalid.");
  }
  const status = payload.data.status;
  if (!["ready", "degraded"].includes(status)) {
    throw new StagingSmokeError("STAGING_HEALTH_STATUS_INVALID", "Staging health status is invalid.");
  }
  if (payload.data.service !== "shortsengine-mvp") {
    throw new StagingSmokeError("STAGING_HEALTH_SERVICE_INVALID", "Staging health service identity is invalid.");
  }
  for (const key of ["ffmpeg", "storage", "artifacts", "repositories", "adapters", "transcription", "analysis"]) {
    if (!payload.data[key] || typeof payload.data[key] !== "object") {
      throw new StagingSmokeError("STAGING_HEALTH_SECTION_MISSING", "Staging health response is missing required sections.");
    }
  }
  const leak = findSensitiveLeak(payload);
  if (leak) {
    throw new StagingSmokeError("STAGING_HEALTH_LEAK", "Staging health response contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
  return {
    service: payload.data.service,
    status,
    ready: status === "ready",
    degraded: status === "degraded",
    requestIdPresent: typeof payload.data.requestId === "string" && payload.data.requestId.length > 0,
    sectionsChecked: ["ffmpeg", "storage", "artifacts", "repositories", "adapters", "transcription", "analysis"],
  };
}

function isAbortError(error) {
  return error && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

async function readBoundedResponseText(response, maxBytes = MAX_HEALTH_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new StagingSmokeError("STAGING_HEALTH_RESPONSE_TOO_LARGE", "Staging health response is too large.");
    }
    return text;
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
      throw new StagingSmokeError("STAGING_HEALTH_RESPONSE_TOO_LARGE", "Staging health response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchHealthJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== "number") {
      throw new StagingSmokeError("STAGING_HEALTH_FETCH_INVALID", "Staging health fetch returned an invalid response.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new StagingSmokeError("STAGING_HEALTH_HTTP_FAILED", "Staging health endpoint returned a non-success status.");
    }
    const body = await readBoundedResponseText(response);
    try {
      return JSON.parse(body);
    } catch {
      throw new StagingSmokeError("STAGING_HEALTH_JSON_INVALID", "Staging health response is not valid JSON.");
    }
  } catch (error) {
    if (error instanceof StagingSmokeError) throw error;
    if (isAbortError(error)) {
      throw new StagingSmokeError("STAGING_HEALTH_TIMEOUT", "Staging health request timed out.");
    }
    throw new StagingSmokeError("STAGING_HEALTH_FETCH_FAILED", "Staging health request failed.");
  } finally {
    clearTimeout(timer);
  }
}

async function checkStagingSmoke(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const baseUrl = String(rawValue(env, "SHORTSENGINE_STAGING_URL") || "").trim();
  const allowLocal = ["1", "true", "yes", "on"].includes(String(rawValue(env, "SHORTSENGINE_STAGING_ALLOW_LOCAL_URL") || "").trim().toLowerCase());
  validateStagingUrl(baseUrl, { required: true, allowLocal });
  const timeoutMs = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS"), 30000, 1000, 120000, "STAGING_SMOKE_TIMEOUT_INVALID");
  const retries = parseInteger(rawValue(env, "SHORTSENGINE_STAGING_SMOKE_RETRIES"), 2, 0, 5, "STAGING_SMOKE_RETRIES_INVALID");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new StagingSmokeError("STAGING_FETCH_UNAVAILABLE", "Fetch is not available for staging smoke.");
  }

  const healthUrl = healthUrlFor(baseUrl);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const payload = await fetchHealthJson(fetchImpl, healthUrl, timeoutMs);
      const health = validateHealthPayload(payload);
      const summary = {
        ok: true,
        checkedAt: new Date(nowMs).toISOString(),
        target: safeTargetSummary(baseUrl),
        health,
        attempts: attempt + 1,
        timeoutMs,
        retries,
        maxResponseBytes: MAX_HEALTH_RESPONSE_BYTES,
        uploadsVideo: false,
        expensiveRender: false,
      };
      const leak = findSensitiveLeak(summary);
      if (leak) {
        throw new StagingSmokeError("STAGING_SMOKE_SUMMARY_LEAK", "Staging smoke summary contains sensitive data.", {
          leakCode: leak.code,
          leakPath: leak.path,
        });
      }
      return summary;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
    }
  }
  throw lastError instanceof StagingSmokeError
    ? lastError
    : new StagingSmokeError("STAGING_HEALTH_FAILED", "Staging health smoke failed.");
}

function safeError(error) {
  const code = error && error.code ? error.code : error instanceof StagingReadinessError ? error.code : "STAGING_SMOKE_FAILED";
  return {
    ok: false,
    code: code || "STAGING_SMOKE_FAILED",
    message: error && error.message ? error.message : "Staging smoke check failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = await checkStagingSmoke();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  StagingSmokeError,
  MAX_HEALTH_RESPONSE_BYTES,
  checkStagingSmoke,
  healthUrlFor,
  readBoundedResponseText,
  safeError,
  validateHealthPayload,
};
