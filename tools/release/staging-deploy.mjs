import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { StagingReadinessError, validateStagingConfig } from "./check-staging-readiness.mjs";

const RENDER_DEPLOY_API_BASE = "https://api.render.com/v1";
const SUPPORTED_DEPLOY_PROVIDERS = Object.freeze(["none", "render"]);

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
  const status = responsePayload && typeof responsePayload.status === "string" ? responsePayload.status : "triggered";
  return {
    providerRequestAccepted: true,
    deployIdPresent: deployId.length > 0,
    status,
  };
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

  let payload = {};
  if (typeof response.json === "function") {
    payload = await response.json().catch(() => ({}));
  }
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
  SUPPORTED_DEPLOY_PROVIDERS,
  StagingDeployError,
  runStagingDeploy,
  safeError,
  triggerRenderDeploy,
  validateRenderServiceId,
};
