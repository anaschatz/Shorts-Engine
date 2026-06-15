import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { boolFromEnv, checkEnvironment, validateExampleSecrets } from "./check-environment.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGING_DOC_RELATIVE_PATH = "docs/STAGING_DEPLOYMENT.md";
const STAGING_WORKFLOW_RELATIVE_PATH = ".github/workflows/staging.yml";

const DEPLOY_TARGETS = Object.freeze(["local", "staging"]);
const DEPLOY_PROVIDERS = Object.freeze(["none", "render", "fly", "railway", "vercel", "cloud-run", "custom"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const STAGING_ENV_CONTRACT = Object.freeze([
  { name: "SHORTSENGINE_DEPLOY_TARGET", defaultValue: "local", type: "enum", allowedValues: DEPLOY_TARGETS },
  { name: "SHORTSENGINE_STAGING_DEPLOY_PROVIDER", defaultValue: "none", type: "enum", allowedValues: DEPLOY_PROVIDERS },
  { name: "SHORTSENGINE_STAGING_URL", defaultValue: "", type: "url" },
  { name: "SHORTSENGINE_STAGING_ALLOW_LOCAL_URL", defaultValue: "false", type: "boolean" },
  { name: "SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS", defaultValue: "30000", type: "integer", min: 1000, max: 120000 },
  { name: "SHORTSENGINE_STAGING_SMOKE_RETRIES", defaultValue: "2", type: "integer", min: 0, max: 5 },
  { name: "SHORTSENGINE_STAGING_DEPLOY_TOKEN", defaultValue: "", type: "secret" },
]);

class StagingReadinessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StagingReadinessError";
    this.code = code;
    this.details = details;
  }
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function valueOrDefault(env, spec) {
  const value = rawValue(env, spec.name);
  return value === undefined || value === null || value === "" ? spec.defaultValue : String(value);
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new StagingReadinessError("STAGING_PATH_INVALID", "Staging contract path is outside the project root.");
  }
  return fromRoot;
}

function readText(rootDir, relativePath, fallback, label) {
  if (typeof fallback === "string") return fallback;
  const safePath = safeRelativeFromRoot(rootDir, relativePath);
  const filePath = resolve(rootDir, safePath);
  if (!existsSync(filePath)) {
    throw new StagingReadinessError("STAGING_FILE_MISSING", `${label} is missing.`, { file: safePath });
  }
  return readFileSync(filePath, "utf8");
}

function parseInteger(value, spec) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max) {
    throw new StagingReadinessError("STAGING_NUMERIC_INVALID", "Staging numeric environment value is out of bounds.");
  }
  return parsed;
}

function normalizeEnum(value, spec) {
  const normalized = String(value || spec.defaultValue || "").trim().toLowerCase();
  if (!spec.allowedValues.includes(normalized)) {
    throw new StagingReadinessError("STAGING_ENUM_INVALID", "Staging environment value is not supported.");
  }
  return normalized;
}

function validateSecretValue(value) {
  if (!value) return false;
  const text = String(value);
  if (text.length < 8 || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new StagingReadinessError("STAGING_CREDENTIAL_INVALID", "Staging credential value is invalid.");
  }
  return true;
}

function hostIsLocal(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return LOCAL_HOSTNAMES.has(value);
}

function validateStagingUrl(value, options = {}) {
  const raw = String(value || "").trim();
  const required = options.required === true;
  const allowLocal = options.allowLocal === true;
  if (!raw) {
    if (required) {
      throw new StagingReadinessError("STAGING_URL_REQUIRED", "Staging URL is required for this check.");
    }
    return { configured: false };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StagingReadinessError("STAGING_URL_INVALID", "Staging URL is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new StagingReadinessError("STAGING_URL_INVALID", "Staging URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new StagingReadinessError("STAGING_URL_CREDENTIALS_UNSAFE", "Staging URL must not embed credentials.");
  }
  if (hostIsLocal(parsed.hostname) && !allowLocal) {
    throw new StagingReadinessError("STAGING_URL_LOCAL_UNSAFE", "Local staging URLs require explicit local mode.");
  }
  return {
    configured: true,
    protocol: parsed.protocol.replace(":", ""),
    hostType: hostIsLocal(parsed.hostname) ? "local" : "remote",
    healthPath: parsed.pathname.replace(/\/+$/, "").endsWith("/health")
      ? parsed.pathname.replace(/\/+$/, "")
      : `${parsed.pathname.replace(/\/+$/, "") || ""}/health`,
  };
}

function validateStagingConfig(env) {
  const values = {};
  for (const spec of STAGING_ENV_CONTRACT) {
    const value = valueOrDefault(env, spec);
    if (spec.type === "enum") values[spec.name] = normalizeEnum(value, spec);
    if (spec.type === "integer") values[spec.name] = parseInteger(value, spec);
    if (spec.type === "boolean") values[spec.name] = boolFromEnv(value);
    if (spec.type === "secret") values[spec.name] = validateSecretValue(value);
    if (spec.type === "url") values[spec.name] = String(value || "").trim();
  }
  const target = values.SHORTSENGINE_DEPLOY_TARGET;
  const provider = values.SHORTSENGINE_STAGING_DEPLOY_PROVIDER;
  const deployCredentialConfigured = values.SHORTSENGINE_STAGING_DEPLOY_TOKEN;
  const url = validateStagingUrl(values.SHORTSENGINE_STAGING_URL, {
    required: target === "staging",
    allowLocal: values.SHORTSENGINE_STAGING_ALLOW_LOCAL_URL,
  });

  if (target === "staging" && provider === "none") {
    throw new StagingReadinessError("STAGING_PROVIDER_REQUIRED", "Staging deploy target requires a configured deploy provider.");
  }
  if (target !== "staging" && provider !== "none") {
    throw new StagingReadinessError("STAGING_TARGET_REQUIRED", "Deploy provider requires SHORTSENGINE_DEPLOY_TARGET=staging.");
  }
  if (target === "staging" && provider !== "none" && !deployCredentialConfigured) {
    throw new StagingReadinessError("STAGING_CREDENTIAL_MISSING", "Staging deploy provider requires a protected deploy credential.");
  }

  return {
    target,
    provider,
    url,
    allowLocalUrl: values.SHORTSENGINE_STAGING_ALLOW_LOCAL_URL,
    smokeTimeoutMs: values.SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS,
    smokeRetries: values.SHORTSENGINE_STAGING_SMOKE_RETRIES,
    deployCredentialConfigured,
  };
}

function assertDocsMentionStagingVars(text) {
  const missing = STAGING_ENV_CONTRACT.filter((spec) => !text.includes(spec.name)).map((spec) => spec.name);
  if (missing.length > 0) {
    throw new StagingReadinessError("STAGING_DOC_INCOMPLETE", "Staging documentation is missing environment variables.", {
      missingCount: missing.length,
    });
  }
}

function assert(condition, code, message, details = {}) {
  if (!condition) throw new StagingReadinessError(code, message, details);
}

function verifyStagingWorkflowContract(workflowText) {
  assert(/workflow_dispatch:/.test(workflowText), "STAGING_WORKFLOW_TRIGGER_MISSING", "Staging workflow must support manual dispatch.");
  assert(/workflow_run:[\s\S]*workflows:[\s\S]*ShortsEngine CI[\s\S]*types:[\s\S]*completed/.test(workflowText), "STAGING_WORKFLOW_TRIGGER_MISSING", "Staging workflow must be gated by completed CI.");
  assert(/environment:[\s\S]*name:\s*staging/.test(workflowText), "STAGING_WORKFLOW_ENVIRONMENT_MISSING", "Staging workflow must use the staging GitHub Environment.");
  assert(/npm ci/.test(workflowText), "STAGING_WORKFLOW_INSTALL_INVALID", "Staging workflow must install dependencies deterministically when lockfile exists.");
  assert(/npm install/.test(workflowText), "STAGING_WORKFLOW_INSTALL_INVALID", "Staging workflow must retain npm install fallback.");
  assert(/npm run env:check/.test(workflowText), "STAGING_WORKFLOW_ENV_CHECK_MISSING", "Staging workflow must run env:check.");
  assert(/npm run staging:check/.test(workflowText), "STAGING_WORKFLOW_CHECK_MISSING", "Staging workflow must run staging:check.");
  assert(/npm run staging:smoke/.test(workflowText), "STAGING_WORKFLOW_SMOKE_MISSING", "Staging workflow must include deployed staging smoke.");
  assert(/SHORTSENGINE_STAGING_DEPLOY_PROVIDER/.test(workflowText), "STAGING_WORKFLOW_PROVIDER_GUARD_MISSING", "Staging workflow must guard deploy provider configuration.");
  assert(/Provider deploy step is not implemented/.test(workflowText), "STAGING_WORKFLOW_FAIL_CLOSED_MISSING", "Staging workflow must fail closed for configured providers without a deploy step.");
  assert(!/SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/.test(workflowText), "STAGING_WORKFLOW_BROWSER_SKIP_UNSAFE", "Staging workflow must not allow browser runtime skips.");
  assert(!/integration:cloud|MATCHCUTS_RUN_REAL_CLOUD_TESTS/.test(workflowText), "STAGING_WORKFLOW_CLOUD_UNSAFE", "Staging workflow must not run real cloud integration by default.");
  assert(!/uses:\s*actions\/upload-artifact@v4/.test(workflowText), "STAGING_WORKFLOW_ARTIFACT_UPLOAD_UNSAFE", "Staging workflow must not upload artifacts by default.");
  assert(!/(AKIA[A-Z0-9]{12,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})/.test(workflowText), "STAGING_WORKFLOW_SECRET_LEAK", "Staging workflow appears to contain a hardcoded secret.");
  return {
    workflow: STAGING_WORKFLOW_RELATIVE_PATH,
    environment: "staging",
    triggers: ["workflow_dispatch", "workflow_run:ShortsEngine CI"],
    artifactUploadDefault: false,
    realCloudIntegrationDefault: false,
    browserRuntimeSkipAllowed: false,
  };
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new StagingReadinessError("STAGING_SUMMARY_LEAK", "Staging readiness summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function checkStagingReadiness(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const docsText = readText(rootDir, STAGING_DOC_RELATIVE_PATH, options.docsText, "Staging deployment docs");
  const workflowText = readText(rootDir, STAGING_WORKFLOW_RELATIVE_PATH, options.workflowText, "Staging workflow");
  validateExampleSecrets(docsText);
  assertDocsMentionStagingVars(docsText);
  const environment = checkEnvironment({
    env,
    rootDir,
    nowMs,
    docsText: options.environmentDocsText,
    exampleText: options.environmentExampleText,
  });
  const config = validateStagingConfig(env);
  const workflow = verifyStagingWorkflowContract(workflowText);
  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    contractVersion: 1,
    deployment: {
      target: config.target,
      provider: config.provider,
      providerConfigured: config.provider !== "none",
      mode: config.provider === "none" ? "readiness-only" : "provider-deploy-required",
      stagingUrlConfigured: config.url.configured,
      stagingUrlHostType: config.url.configured ? config.url.hostType : "not-configured",
      localUrlAllowed: config.allowLocalUrl,
      deployCredentialConfigured: config.deployCredentialConfigured,
    },
    githubEnvironment: {
      name: "staging",
      workflow: STAGING_WORKFLOW_RELATIVE_PATH,
      protectedVariables: [
        "SHORTSENGINE_DEPLOY_TARGET",
        "SHORTSENGINE_STAGING_DEPLOY_PROVIDER",
        "SHORTSENGINE_STAGING_URL",
      ],
      credentialRefs: config.provider === "none" ? [] : ["SHORTSENGINE_STAGING_DEPLOY_TOKEN"],
    },
    smoke: {
      command: "npm run staging:smoke",
      healthOnly: true,
      uploadsVideo: false,
      expensiveRender: false,
      urlRequiredForRemoteSmoke: true,
      timeoutMs: config.smokeTimeoutMs,
      retries: config.smokeRetries,
      acceptedStatuses: ["ready", "degraded"],
    },
    environmentReadiness: {
      ok: environment.ok,
      storage: environment.storage,
      persistence: environment.persistence,
      transcription: environment.transcription,
      cloudIntegration: environment.cloudIntegration,
      ci: environment.ci,
      safeDefaults: environment.safeDefaults,
    },
    workflow,
    docs: {
      stagingDeployment: STAGING_DOC_RELATIVE_PATH,
      environment: "docs/ENVIRONMENT.md",
      complete: true,
    },
    limitations: [
      "No provider-specific deploy step is enabled by default.",
      "GitHub Environment protection and protected credentials must be configured in GitHub.",
      "Deployed smoke checks are health-only until an explicit staging URL exists.",
    ],
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "STAGING_READINESS_FAILED",
    message: error && error.message ? error.message : "Staging readiness check failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(checkStagingReadiness(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  DEPLOY_PROVIDERS,
  DEPLOY_TARGETS,
  ROOT_DIR,
  STAGING_DOC_RELATIVE_PATH,
  STAGING_ENV_CONTRACT,
  STAGING_WORKFLOW_RELATIVE_PATH,
  StagingReadinessError,
  checkStagingReadiness,
  safeError,
  validateStagingConfig,
  validateStagingUrl,
  verifyStagingWorkflowContract,
};
