import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { checkEnvironment } from "./check-environment.mjs";
import { StagingReadinessError, validateStagingConfig } from "./check-staging-readiness.mjs";

const RENDER_RUNTIME_CONTRACT = Object.freeze({
  provider: "render",
  serviceType: "web-service",
  runtime: "node",
  buildCommand: "npm ci",
  startCommand: "npm start",
  healthCheckPath: "/health",
  requiredTools: ["ffmpeg", "ffprobe"],
  expectedPortSource: "Render PORT environment variable",
});

class RenderStagingCheckError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RenderStagingCheckError";
    this.code = code;
    this.details = details;
  }
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new RenderStagingCheckError("RENDER_STAGING_SUMMARY_LEAK", "Render staging summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function validateRenderPublicUrl(config) {
  if (config.provider !== "render") return;
  if (!config.url.configured) {
    throw new RenderStagingCheckError("RENDER_STAGING_URL_REQUIRED", "Render staging requires a configured public URL.");
  }
  if (config.url.hostType !== "remote") {
    throw new RenderStagingCheckError("RENDER_STAGING_URL_PUBLIC_REQUIRED", "Render staging URL must be a public remote URL.");
  }
}

function renderModeFor(config) {
  return config.provider === "none" ? "readiness-only" : "render-staging";
}

function checkRenderStaging(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const environment = checkEnvironment({
    env,
    rootDir: options.rootDir,
    nowMs,
    docsText: options.environmentDocsText,
    exampleText: options.environmentExampleText,
  });
  const config = validateStagingConfig(env);
  validateRenderPublicUrl(config);

  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    contractVersion: 1,
    mode: renderModeFor(config),
    provider: config.provider,
    deployTarget: config.target,
    readinessOnly: config.provider === "none",
    networkCalls: false,
    render: {
      supported: config.provider === "render",
      serviceIdConfigured: config.deployServiceIdConfigured,
      deployTokenConfigured: config.deployCredentialConfigured,
      stagingUrlConfigured: config.url.configured,
      stagingUrlHostType: config.url.configured ? config.url.hostType : "not-configured",
      buildCommand: RENDER_RUNTIME_CONTRACT.buildCommand,
      startCommand: RENDER_RUNTIME_CONTRACT.startCommand,
      healthCheckPath: RENDER_RUNTIME_CONTRACT.healthCheckPath,
      requiredTools: RENDER_RUNTIME_CONTRACT.requiredTools,
      portSource: RENDER_RUNTIME_CONTRACT.expectedPortSource,
    },
    runtime: {
      node: true,
      ffmpegRequired: true,
      ffprobeRequired: true,
      healthPath: RENDER_RUNTIME_CONTRACT.healthCheckPath,
    },
    safeDefaults: {
      transcriptionProvider: environment.transcription.activeProvider,
      mockTranscriptionDefault: environment.transcription.defaultProviderIsMock,
      storageAdapter: environment.storage.adapter,
      persistenceAdapter: environment.persistence.adapter,
      realCloudIntegrationDefault: environment.cloudIntegration.defaultOptIn === false,
    },
    limitations: [
      "Render local filesystem storage is ephemeral unless a Render disk or object storage is configured.",
      "Deployed staging smoke is health-only and does not upload or render videos.",
      "This readiness check does not call Render APIs.",
    ],
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  const code = error && error.code ? error.code : error instanceof StagingReadinessError ? error.code : "RENDER_STAGING_CHECK_FAILED";
  return {
    ok: false,
    code: code || "RENDER_STAGING_CHECK_FAILED",
    message: error && error.message ? error.message : "Render staging check failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(checkRenderStaging(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  RENDER_RUNTIME_CONTRACT,
  RenderStagingCheckError,
  checkRenderStaging,
  safeError,
};
