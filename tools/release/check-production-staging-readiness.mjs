import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadRuntimeConfig, publicRuntimeConfig } = require("../../server/runtime/runtime-config.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_REPORT_PATH = "release/results/staging-credentials-readiness.json";
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;

const REQUIRED_CONFIGURATION = Object.freeze([
  "DATABASE_URL",
  "SHORTSENGINE_OIDC_ISSUER_URL",
  "SHORTSENGINE_OIDC_CLIENT_ID",
  "SHORTSENGINE_OIDC_CLIENT_SECRET",
  "SHORTSENGINE_OIDC_REDIRECT_URI",
  "SHORTSENGINE_PUBLIC_BASE_URL",
  "SHORTSENGINE_SESSION_SECRET",
  "MATCHCUTS_STORAGE_BUCKET",
  "MATCHCUTS_STORAGE_ENDPOINT",
  "MATCHCUTS_STORAGE_ACCESS_KEY_ID",
  "MATCHCUTS_STORAGE_SECRET_ACCESS_KEY",
  "SHORTSENGINE_STAGING_SERVICE_ID",
  "SHORTSENGINE_STAGING_URL",
  "SHORTSENGINE_STAGING_DEPLOY_TOKEN",
]);

const EXPECTED_MODES = Object.freeze({
  SHORTSENGINE_ENVIRONMENT: "staging",
  MATCHCUTS_PERSISTENCE_ADAPTER: "postgres",
  MATCHCUTS_QUEUE_ADAPTER: "postgres",
  MATCHCUTS_STORAGE_ADAPTER: "r2",
  SHORTSENGINE_AUTH_MODE: "oidc",
  SHORTSENGINE_TELEMETRY_ADAPTER: "postgres",
  SHORTSENGINE_DEPLOY_TARGET: "staging",
  SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
});

const ALLOWED_MISSING_NAMES = new Set(REQUIRED_CONFIGURATION);

class ProductionStagingReadinessError extends Error {
  constructor(code, message, report) {
    super(message);
    this.name = "ProductionStagingReadinessError";
    this.code = code;
    this.report = report;
  }
}

function configured(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function gitCommit(rootDir) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function assertCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new ProductionStagingReadinessError(
      "STAGING_COMMIT_INVALID",
      "The staging readiness commit must be an exact 40-character Git SHA.",
    );
  }
  return commit;
}

function validateBlueprint(text) {
  const requiredPatterns = [
    [/\bdatabases:\s*\n[\s\S]*name:\s*shortsengine-staging-postgres/, "RENDER_POSTGRES_MISSING"],
    [/type:\s*web[\s\S]*name:\s*shortsengine-staging-web/, "RENDER_WEB_MISSING"],
    [/name:\s*shortsengine-staging-worker-a[\s\S]*SHORTSENGINE_PROCESS_ROLE[\s\S]*value:\s*worker/, "RENDER_WORKER_A_MISSING"],
    [/name:\s*shortsengine-staging-worker-b[\s\S]*SHORTSENGINE_PROCESS_ROLE[\s\S]*value:\s*worker/, "RENDER_WORKER_B_MISSING"],
    [/preDeployCommand:\s*SHORTSENGINE_PROCESS_ROLE=migrate node server\/migrate-entry\.cjs/, "RENDER_MIGRATE_MISSING"],
    [/healthCheckPath:\s*\/health/, "RENDER_HEALTH_MISSING"],
    [/dockerfilePath:\s*\.\/Dockerfile\.production/g, "RENDER_DOCKERFILE_MISSING"],
    [/autoDeployTrigger:\s*checksPass/g, "RENDER_EXACT_SOURCE_GATE_MISSING"],
  ];
  const blockers = [];
  for (const [pattern, code] of requiredPatterns) {
    if (!pattern.test(text)) blockers.push(code);
  }
  for (const [name, value] of Object.entries(EXPECTED_MODES).slice(0, 6)) {
    const pattern = new RegExp(`key:\\s*${name}[\\s\\S]{0,80}value:\\s*${value}`, "g");
    const matches = text.match(pattern) || [];
    if (matches.length < 3) blockers.push(`RENDER_MODE_MISSING_${name}`);
  }
  if (/(?:value:\s*)(?:postgres(?:ql)?:\/\/|[A-Za-z0-9+/]{40,}={0,2}|(?:AKIA|ASIA)[A-Z0-9]{12,})/.test(text)) {
    blockers.push("RENDER_HARDCODED_SECRET");
  }
  return [...new Set(blockers)].sort();
}

function validateDockerfile(text) {
  const requiredPatterns = [
    [/^FROM node:22-/m, "PRODUCTION_IMAGE_NODE22_MISSING"],
    [/apt-get install[\s\S]*\bffmpeg\b/, "PRODUCTION_IMAGE_FFMPEG_MISSING"],
    [/npm ci --include=dev/, "PRODUCTION_IMAGE_LOCKED_INSTALL_MISSING"],
    [/playwright install --with-deps chromium/, "PRODUCTION_IMAGE_CHROMIUM_MISSING"],
    [/^USER node$/m, "PRODUCTION_IMAGE_ROOT_USER_UNSAFE"],
  ];
  return requiredPatterns
    .filter(([pattern]) => !pattern.test(text))
    .map(([, code]) => code);
}

function validateWorkflow(text) {
  const blockers = [];
  const required = [
    /environment:[\s\S]*name:\s*staging/,
    /npm run staging:production:check/,
    /npm run staging:deploy/,
    /npm run staging:smoke/,
    /actions\/checkout@v4[\s\S]*ref:\s*\$\{\{\s*(?:github\.event\.workflow_run\.head_sha\s*\|\|\s*github\.sha|github\.sha)\s*\}\}/,
  ];
  if (required.some((pattern) => !pattern.test(text))) {
    blockers.push("STAGING_WORKFLOW_CONTRACT_INVALID");
  }
  if (/\|\|\s*['"](?:sqlite|local|mock|none|operator|memory)['"]/.test(text)) {
    blockers.push("STAGING_WORKFLOW_FALLBACK_UNSAFE");
  }
  for (const [name, value] of Object.entries(EXPECTED_MODES)) {
    const pattern = new RegExp(`${name}:\\s*["']?${value}["']?`);
    if (!pattern.test(text)) blockers.push(`STAGING_WORKFLOW_MODE_MISSING_${name}`);
  }
  for (const name of REQUIRED_CONFIGURATION) {
    if (!text.includes(name)) blockers.push(`STAGING_WORKFLOW_REFERENCE_MISSING_${name}`);
  }
  return [...new Set(blockers)].sort();
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Readiness report must be an object.");
  }
  if (!/^[a-f0-9]{40}$/.test(report.exactCommitSha)) {
    throw new Error("Readiness report is not bound to an exact commit.");
  }
  if (!Array.isArray(report.missingConfiguration)
    || report.missingConfiguration.some((name) => !ALLOWED_MISSING_NAMES.has(name))) {
    throw new Error("Readiness report contains an unknown configuration name.");
  }
  const serialized = JSON.stringify(report);
  for (const name of REQUIRED_CONFIGURATION) {
    const valuePattern = new RegExp(`${name}\\s*[=:]\\s*[^",}\\s]+`);
    if (valuePattern.test(serialized)) {
      throw new Error("Readiness report contains a configuration value.");
    }
  }
  if (/(?:postgres(?:ql)?:\/\/|(?:AKIA|ASIA)[A-Z0-9]{12,}|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/.test(serialized)) {
    throw new Error("Readiness report contains sensitive material.");
  }
  return true;
}

function writeReadinessReport(report, options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const reportPath = resolve(rootDir, options.reportPath || DEFAULT_REPORT_PATH);
  mkdirSync(dirname(reportPath), { recursive: true });
  validateReport(report);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(reportPath, 0o600);
  return reportPath;
}

function checkProductionStagingReadiness(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const localCommit = assertCommit(options.commitSha || gitCommit(rootDir));
  const expectedCommit = env.SHORTSENGINE_PROOF_COMMIT_SHA
    ? assertCommit(env.SHORTSENGINE_PROOF_COMMIT_SHA)
    : localCommit;
  const missingConfiguration = REQUIRED_CONFIGURATION
    .filter((name) => !configured(env, name))
    .sort();
  const blockers = [];

  if (localCommit !== expectedCommit) blockers.push("STAGING_COMMIT_MISMATCH");
  for (const [name, expected] of Object.entries(EXPECTED_MODES)) {
    if (String(env[name] || "").trim().toLowerCase() !== expected) {
      blockers.push(`STAGING_MODE_INVALID_${name}`);
    }
  }

  const blueprintText = options.blueprintText
    ?? readFileSync(resolve(rootDir, "render.yaml"), "utf8");
  const dockerfileText = options.dockerfileText
    ?? readFileSync(resolve(rootDir, "Dockerfile.production"), "utf8");
  const workflowText = options.workflowText
    ?? readFileSync(resolve(rootDir, ".github/workflows/staging.yml"), "utf8");
  blockers.push(
    ...validateBlueprint(blueprintText),
    ...validateDockerfile(dockerfileText),
    ...validateWorkflow(workflowText),
  );

  let runtime = null;
  if (missingConfiguration.length === 0 && blockers.length === 0) {
    try {
      runtime = publicRuntimeConfig(loadRuntimeConfig({
        ...env,
        SHORTSENGINE_PROCESS_ROLE: "web",
      }));
    } catch {
      blockers.push("STAGING_RUNTIME_CONFIGURATION_INVALID");
    }
  }
  if (missingConfiguration.length > 0) blockers.push("STAGING_CREDENTIALS_REQUIRED");
  const fatalBlockers = [...new Set(blockers)].sort();
  const uniqueBlockers = [...new Set([
    ...fatalBlockers,
    "REAL_STAGING_NOT_PROVED",
    ...(!configured(env, "SHORTSENGINE_OTLP_ENDPOINT") ? ["OTLP_BACKEND_NOT_PROVED"] : []),
  ])].sort();
  const report = {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + REPORT_TTL_MS).toISOString(),
    exactCommitSha: localCommit,
    environment: "staging",
    adapters: runtime?.adapters || {
      persistence: "postgres",
      queue: "postgres",
      storage: "r2",
      auth: "oidc",
      telemetry: "postgres",
    },
    checks: {
      exactCommitMatched: localCommit === expectedCommit,
      blueprintValid: !uniqueBlockers.some((code) => code.startsWith("RENDER_")),
      protectedConfigurationComplete: missingConfiguration.length === 0,
      strictRuntimeConfigurationValid: Boolean(runtime),
      realStagingProved: false,
    },
    configuredCount: REQUIRED_CONFIGURATION.length - missingConfiguration.length,
    requiredCount: REQUIRED_CONFIGURATION.length,
    missingConfiguration,
    blockerCodes: uniqueBlockers,
    productionReady: false,
  };
  validateReport(report);

  if (options.writeReport !== false) {
    writeReadinessReport(report, {
      rootDir,
      reportPath: options.reportPath,
    });
  }
  if (fatalBlockers.length > 0) {
    const code = missingConfiguration.length > 0
      ? "STAGING_CREDENTIALS_REQUIRED"
      : fatalBlockers[0];
    throw new ProductionStagingReadinessError(
      code,
      "Production staging readiness is blocked.",
      report,
    );
  }
  return report;
}

function safeError(error) {
  return {
    ok: false,
    code: error?.code || "PRODUCTION_STAGING_READINESS_FAILED",
    message: "Production staging readiness is blocked.",
    reportWritten: Boolean(error?.report),
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(checkProductionStagingReadiness(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_REPORT_PATH,
  EXPECTED_MODES,
  ProductionStagingReadinessError,
  REQUIRED_CONFIGURATION,
  checkProductionStagingReadiness,
  safeError,
  validateBlueprint,
  validateDockerfile,
  validateReport,
  validateWorkflow,
  writeReadinessReport,
};
