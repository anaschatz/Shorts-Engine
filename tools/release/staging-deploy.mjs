import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { StagingReadinessError, validateStagingConfig } from "./check-staging-readiness.mjs";

const RENDER_DEPLOY_API_BASE = "https://api.render.com/v1";
const SUPPORTED_DEPLOY_PROVIDERS = Object.freeze(["none", "render"]);
const MAX_RENDER_DEPLOY_RESPONSE_BYTES = 32 * 1024;

class StagingDeployError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StagingDeployError";
    this.code = code;
    this.details = details;
  }
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function validateRenderServiceId(value) {
  const serviceId = String(value || "").trim();
  if (!/^srv-[A-Za-z0-9_-]{6,80}$/.test(serviceId)) {
    throw new StagingDeployError("STAGING_RENDER_SERVICE_ID_INVALID", "Render staging deploy requires a valid service id.");
  }
  return serviceId;
}

function validateDeployToken(value) {
  const token = String(value || "").trim();
  if (token.length < 8 || token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new StagingDeployError("STAGING_DEPLOY_TOKEN_INVALID", "Staging deploy credential is invalid.");
  }
  return token;
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new StagingDeployError("STAGING_DEPLOY_SUMMARY_LEAK", "Staging deploy summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function safeProviderSummary(config, options = {}) {
  return {
    provider: config.provider,
    mode: config.provider === "none" ? "readiness-only" : "provider-deploy",
    deployTriggered: options.deployTriggered === true,
    smokeRequired: config.url.configured,
    stagingUrlConfigured: config.url.configured,
    stagingUrlHostType: config.url.configured ? config.url.hostType : "not-configured",
  };
}

function safeRenderDeploySummary(responsePayload) {
  const deployId = responsePayload && typeof responsePayload.id === "string" ? responsePayload.id : "";
  const status = safeDeployStatus(responsePayload && responsePayload.status);
  return {
    providerRequestAccepted: true,
    deployIdPresent: deployId.length > 0,
    status,
  };
}

function safeDeployStatus(value) {
  const status = String(value || "triggered").trim().slice(0, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(status)) return "unknown";
  if (findSensitiveLeak(status)) return "unknown";
  return status;
}

async function readBoundedResponseText(response, maxBytes = MAX_RENDER_DEPLOY_RESPONSE_BYTES) {
  const declaredLength = response.headers && typeof response.headers.get === "function"
    ? Number(response.headers.get("content-length"))
    : null;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_RESPONSE_TOO_LARGE", "Render deploy response is too large.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new StagingDeployError("STAGING_RENDER_DEPLOY_RESPONSE_TOO_LARGE", "Render deploy response is too large.");
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
      throw new StagingDeployError("STAGING_RENDER_DEPLOY_RESPONSE_TOO_LARGE", "Render deploy response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readRenderDeployPayload(response) {
  const text = await readBoundedResponseText(response);
  if (!text.trim()) return {};
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_JSON_INVALID", "Render deploy response is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_RESPONSE_INVALID", "Render deploy returned an invalid response.");
  }
  return payload;
}

async function triggerRenderDeploy({ env, fetchImpl }) {
  const serviceId = validateRenderServiceId(rawValue(env, "SHORTSENGINE_STAGING_SERVICE_ID"));
  const deployToken = validateDeployToken(rawValue(env, "SHORTSENGINE_STAGING_DEPLOY_TOKEN"));
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new StagingDeployError("STAGING_DEPLOY_FETCH_UNAVAILABLE", "Fetch is not available for staging deploy.");
  }

  const url = `${RENDER_DEPLOY_API_BASE}/services/${encodeURIComponent(serviceId)}/deploys`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deployToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ clearCache: "do_not_clear" }),
  }).catch(() => {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_REQUEST_FAILED", "Render deploy request failed.");
  });

  if (!response || typeof response.status !== "number") {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_RESPONSE_INVALID", "Render deploy returned an invalid response.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new StagingDeployError("STAGING_RENDER_DEPLOY_HTTP_FAILED", "Render deploy request was rejected.");
  }

  const payload = await readRenderDeployPayload(response);
  return safeRenderDeploySummary(payload);
}

async function runStagingDeploy(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const config = validateStagingConfig(env);

  if (!SUPPORTED_DEPLOY_PROVIDERS.includes(config.provider)) {
    throw new StagingDeployError("STAGING_DEPLOY_PROVIDER_UNSUPPORTED", "Staging deploy provider is not supported by this workflow.");
  }

  if (config.provider === "none") {
    const summary = {
      ok: true,
      checkedAt: new Date(nowMs).toISOString(),
      ...safeProviderSummary(config),
      dryRun: false,
      providerResult: null,
    };
    assertNoSensitiveSummary(summary);
    return summary;
  }

  const providerResult = await triggerRenderDeploy({ env, fetchImpl: options.fetchImpl });

  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    ...safeProviderSummary(config, { deployTriggered: true }),
    dryRun: false,
    providerResult,
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  const code = error && error.code ? error.code : error instanceof StagingReadinessError ? error.code : "STAGING_DEPLOY_FAILED";
  return {
    ok: false,
    code: code || "STAGING_DEPLOY_FAILED",
    message: error && error.message ? error.message : "Staging deploy failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = await runStagingDeploy();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  RENDER_DEPLOY_API_BASE,
  MAX_RENDER_DEPLOY_RESPONSE_BYTES,
  SUPPORTED_DEPLOY_PROVIDERS,
  StagingDeployError,
  readBoundedResponseText,
  readRenderDeployPayload,
  runStagingDeploy,
  safeError,
  safeDeployStatus,
  safeRenderDeploySummary,
  triggerRenderDeploy,
  validateRenderServiceId,
};
