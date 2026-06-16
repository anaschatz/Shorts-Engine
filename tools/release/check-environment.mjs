import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_DOC_RELATIVE_PATH = "docs/ENVIRONMENT.md";
const ENV_EXAMPLE_RELATIVE_PATH = ".env.example";
const BYTE_1_MB = 1024 * 1024;

const STORAGE_ADAPTERS = Object.freeze(["local", "mock-cloud", "s3", "r2", "gcs"]);
const STAGING_READY_STORAGE_ADAPTERS = Object.freeze(["local", "mock-cloud", "s3", "r2"]);
const PERSISTENCE_ADAPTERS = Object.freeze(["local", "sqlite"]);
const TRANSCRIPTION_PROVIDERS = Object.freeze(["mock", "openai"]);

const ENV_CONTRACT = Object.freeze([
  { name: "PORT", category: "App/runtime", required: false, defaultValue: "4175", type: "integer", min: 1, max: 65535, secret: false },
  { name: "FFMPEG_BIN", category: "FFmpeg/render limits", required: false, defaultValue: "ffmpeg", type: "command", secret: false },
  { name: "FFPROBE_BIN", category: "FFmpeg/render limits", required: false, defaultValue: "ffprobe", type: "command", secret: false },
  { name: "MATCHCUTS_MAX_UPLOAD_BYTES", category: "Upload/media limits", required: false, defaultValue: String(250 * BYTE_1_MB), type: "integer", min: 1024, max: 20 * 1024 * BYTE_1_MB, secret: false },
  { name: "MATCHCUTS_MAX_DURATION_SECONDS", category: "Upload/media limits", required: false, defaultValue: String(30 * 60), type: "integer", min: 1, max: 24 * 60 * 60, secret: false },
  { name: "SHORTSENGINE_YOUTUBE_INGEST_ENABLED", category: "Remote URL ingest", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN", category: "Remote URL ingest", required: false, defaultValue: "yt-dlp", type: "command", secret: false },
  { name: "SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS", category: "Remote URL ingest", required: false, defaultValue: String(2 * 60 * 1000), type: "integer", min: 1000, max: 10 * 60 * 1000, secret: false },
  { name: "SHORTSENGINE_YOUTUBE_DOWNLOADER_OUTPUT_BYTES", category: "Remote URL ingest", required: false, defaultValue: String(64 * 1024), type: "integer", min: 1024, max: BYTE_1_MB, secret: false },
  { name: "MATCHCUTS_RENDER_TIMEOUT_MS", category: "FFmpeg/render limits", required: false, defaultValue: String(5 * 60 * 1000), type: "integer", min: 1000, max: 60 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_ANALYSIS_TIMEOUT_MS", category: "FFmpeg/render limits", required: false, defaultValue: String(45 * 1000), type: "integer", min: 1000, max: 10 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_TRANSCRIPTION_TIMEOUT_MS", category: "Transcription/AI provider", required: false, defaultValue: String(60 * 1000), type: "integer", min: 1000, max: 15 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_TRANSCRIPTION_RETRIES", category: "Transcription/AI provider", required: false, defaultValue: "1", type: "integer", min: 0, max: 5, secret: false },
  { name: "MATCHCUTS_TRANSCRIPTION_PROVIDER", category: "Transcription/AI provider", required: false, defaultValue: "mock", type: "enum", allowedValues: TRANSCRIPTION_PROVIDERS, secret: false },
  { name: "OPENAI_API_KEY", category: "Transcription/AI provider", required: false, defaultValue: "", type: "secret", secret: true },
  { name: "OPENAI_TRANSCRIPTION_MODEL", category: "Transcription/AI provider", required: false, defaultValue: "gpt-4o-mini-transcribe", type: "string", secret: false },
  { name: "MATCHCUTS_WORKER_POLL_INTERVAL_MS", category: "Worker/job settings", required: false, defaultValue: "0", type: "integer", min: 0, max: 60 * 1000, secret: false },
  { name: "MATCHCUTS_WORKER_SHUTDOWN_TIMEOUT_MS", category: "Worker/job settings", required: false, defaultValue: String(10 * 1000), type: "integer", min: 0, max: 10 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_WORKER_RETRY_INITIAL_DELAY_MS", category: "Worker/job settings", required: false, defaultValue: "1000", type: "integer", min: 0, max: 10 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_WORKER_RETRY_MAX_DELAY_MS", category: "Worker/job settings", required: false, defaultValue: String(30 * 1000), type: "integer", min: 0, max: 60 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_WORKER_RETRY_MAX_ATTEMPTS", category: "Worker/job settings", required: false, defaultValue: "2", type: "integer", min: 1, max: 10, secret: false },
  { name: "MATCHCUTS_STORAGE_ADAPTER", category: "Storage/artifact adapter", required: false, defaultValue: "local", type: "enum", allowedValues: STORAGE_ADAPTERS, secret: false },
  { name: "MATCHCUTS_STORAGE_BUCKET", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "string", secret: false },
  { name: "MATCHCUTS_STORAGE_REGION", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "string", secret: false },
  { name: "MATCHCUTS_STORAGE_ENDPOINT", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "url", secret: false },
  { name: "MATCHCUTS_STORAGE_ACCESS_KEY_ID", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "secret", secret: true },
  { name: "MATCHCUTS_STORAGE_SECRET_ACCESS_KEY", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "secret", secret: true },
  { name: "MATCHCUTS_STORAGE_SESSION_TOKEN", category: "Storage/artifact adapter", required: false, defaultValue: "", type: "secret", secret: true },
  { name: "MATCHCUTS_STORAGE_FORCE_PATH_STYLE", category: "Storage/artifact adapter", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "MATCHCUTS_STORAGE_SIGNED_URL_TTL_SECONDS", category: "Signed delivery", required: false, defaultValue: "300", type: "integer", min: 1, max: 15 * 60, secret: false },
  { name: "MATCHCUTS_MULTIPART_THRESHOLD_BYTES", category: "Storage/artifact adapter", required: false, defaultValue: String(64 * BYTE_1_MB), type: "integer", min: 5 * BYTE_1_MB, max: 5 * 1024 * BYTE_1_MB, secret: false },
  { name: "MATCHCUTS_MULTIPART_PART_SIZE_BYTES", category: "Storage/artifact adapter", required: false, defaultValue: String(16 * BYTE_1_MB), type: "integer", min: 5 * BYTE_1_MB, max: 512 * BYTE_1_MB, secret: false },
  { name: "MATCHCUTS_ARTIFACT_CLEANUP_MAX_AGE_SECONDS", category: "Storage/artifact adapter", required: false, defaultValue: String(24 * 60 * 60), type: "integer", min: 60, max: 365 * 24 * 60 * 60, secret: false },
  { name: "MATCHCUTS_ARTIFACT_CLEANUP_MAX_PER_RUN", category: "Storage/artifact adapter", required: false, defaultValue: "100", type: "integer", min: 1, max: 1000, secret: false },
  { name: "MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS", category: "Worker/job settings", required: false, defaultValue: "0", type: "integer", min: 0, max: 24 * 60 * 60 * 1000, secret: false },
  { name: "MATCHCUTS_PERSISTENCE_ADAPTER", category: "Persistence adapter", required: false, defaultValue: "local", type: "enum", allowedValues: PERSISTENCE_ADAPTERS, secret: false },
  { name: "MATCHCUTS_SQLITE_FILE", category: "Persistence adapter", required: false, defaultValue: "shortsengine.sqlite", type: "sqlite-file", secret: false },
  { name: "MATCHCUTS_RUN_REAL_CLOUD_TESTS", category: "Cloud integration", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "DEMO_SMOKE_PORT", category: "Browser/demo/CI flags", required: false, defaultValue: "", type: "integer", min: 1, max: 65535, secret: false },
  { name: "DEMO_SMOKE_TIMEOUT_MS", category: "Browser/demo/CI flags", required: false, defaultValue: "120000", type: "integer", min: 1000, max: 10 * 60 * 1000, secret: false },
  { name: "PLAYWRIGHT_SMOKE_PORT", category: "Browser/demo/CI flags", required: false, defaultValue: "", type: "integer", min: 1, max: 65535, secret: false },
  { name: "PLAYWRIGHT_SMOKE_JOB_TIMEOUT_MS", category: "Browser/demo/CI flags", required: false, defaultValue: "120000", type: "integer", min: 1000, max: 10 * 60 * 1000, secret: false },
  { name: "PLAYWRIGHT_SMOKE_TIMEOUT_MS", category: "Browser/demo/CI flags", required: false, defaultValue: "120000", type: "integer", min: 1000, max: 10 * 60 * 1000, secret: false },
  { name: "SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP", category: "Browser/demo/CI flags", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "SHORTSENGINE_BROWSER_E2E_RETENTION_MAX", category: "Browser/demo/CI flags", required: false, defaultValue: "20", type: "integer", min: 1, max: 200, secret: false },
  { name: "SHORTSENGINE_BROWSER_E2E_TRACE", category: "Browser/demo/CI flags", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "SHORTSENGINE_BROWSER_E2E_VIDEO", category: "Browser/demo/CI flags", required: false, defaultValue: "false", type: "boolean", secret: false },
  { name: "SHORTSENGINE_CI_REPORT_MAX_AGE_MS", category: "Browser/demo/CI flags", required: false, defaultValue: String(2 * 60 * 60 * 1000), type: "integer", min: 60 * 1000, max: 24 * 60 * 60 * 1000, secret: false },
]);

class EnvironmentCheckError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EnvironmentCheckError";
    this.code = code;
    this.details = details;
  }
}

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function safeRelativeFromRoot(rootDir, filePath) {
  const target = resolve(rootDir, filePath);
  const fromRoot = relative(rootDir, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new EnvironmentCheckError("ENV_PATH_INVALID", "Environment contract path is outside the project root.");
  }
  return fromRoot;
}

function readOptionalText(rootDir, relativePath, fallback) {
  if (typeof fallback === "string") return fallback;
  const safePath = safeRelativeFromRoot(rootDir, relativePath);
  const fullPath = resolve(rootDir, safePath);
  if (!existsSync(fullPath)) {
    throw new EnvironmentCheckError("ENV_CONTRACT_FILE_MISSING", "Environment contract file is missing.");
  }
  return readFileSync(fullPath, "utf8");
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function valueOrDefault(env, spec) {
  const raw = rawValue(env, spec.name);
  return raw === undefined || raw === null || raw === "" ? spec.defaultValue : String(raw);
}

function parseInteger(value, spec) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max) {
    throw new EnvironmentCheckError("ENV_NUMERIC_INVALID", "Numeric environment value is out of bounds.", {
      category: spec.category,
    });
  }
  return parsed;
}

function normalizeEnum(value, spec) {
  const normalized = String(value || spec.defaultValue || "").trim().toLowerCase();
  if (!spec.allowedValues.includes(normalized)) {
    throw new EnvironmentCheckError("ENV_ENUM_INVALID", "Environment value is not supported.", { category: spec.category });
  }
  return normalized;
}

function validateBooleanValue(value, spec) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["", "0", "1", "true", "false", "yes", "no", "on", "off"].includes(normalized)) {
    throw new EnvironmentCheckError("ENV_BOOLEAN_INVALID", "Boolean environment value is invalid.", { category: spec.category });
  }
  return boolFromEnv(value);
}

function validateCommandValue(value, spec) {
  const command = String(value || "").trim();
  if (
    !command ||
    command.length > 240 ||
    /[\u0000-\u001f\u007f\s`$;&|<>]/.test(command) ||
    command.includes("\\") ||
    command.includes("..")
  ) {
    throw new EnvironmentCheckError("ENV_COMMAND_INVALID", "Command environment value is invalid.", {
      category: spec.category,
    });
  }
  if (command.includes("/")) {
    if (!command.startsWith("/") || !/^\/[A-Za-z0-9._/@:+-]+$/.test(command)) {
      throw new EnvironmentCheckError("ENV_COMMAND_INVALID", "Command environment path is invalid.", {
        category: spec.category,
      });
    }
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(command)) {
    throw new EnvironmentCheckError("ENV_COMMAND_INVALID", "Command environment name is invalid.", {
      category: spec.category,
    });
  }
  return true;
}

function validateEndpoint(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported");
    return "configured";
  } catch {
    throw new EnvironmentCheckError("ENV_URL_INVALID", "Storage endpoint configuration is invalid.", {
      category: "Storage/artifact adapter",
    });
  }
}

function validateSqliteFileName(value) {
  const fileName = String(value || "shortsengine.sqlite").trim();
  if (
    !fileName ||
    fileName.includes("\u0000") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(sqlite|sqlite3|db)$/i.test(fileName)
  ) {
    throw new EnvironmentCheckError("ENV_SQLITE_FILE_INVALID", "SQLite filename is invalid.", {
      category: "Persistence adapter",
    });
  }
  return fileName;
}

function validateSecretValue(value, category) {
  if (!value) return false;
  const text = String(value);
  if (text.length < 8 || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new EnvironmentCheckError("ENV_SECRET_INVALID", "Credential environment value is invalid.", { category });
  }
  return true;
}

function validateExampleSecrets(text) {
  const realSecretPatterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /AKIA[A-Z0-9]{12,}/,
    /Bearer\s+[A-Za-z0-9._-]{10,}/i,
    /X-Amz-(?:Signature|Credential)=[^&\s"']+/i,
    /adt_[A-Fa-f0-9-]{36}_[A-Fa-f0-9]{32}/,
  ];
  for (const pattern of realSecretPatterns) {
    if (pattern.test(text)) {
      throw new EnvironmentCheckError("ENV_EXAMPLE_SECRET_LEAK", "Example environment file appears to contain a real secret.");
    }
  }
}

function assertDocsMentionKnownVars(text) {
  const missing = ENV_CONTRACT.filter((spec) => !text.includes(spec.name)).map((spec) => spec.name);
  if (missing.length > 0) {
    throw new EnvironmentCheckError("ENV_DOC_INCOMPLETE", "Environment documentation is missing known variables.", {
      missingCount: missing.length,
    });
  }
}

function validateContractValues(env) {
  const numeric = {};
  const booleans = {};
  for (const spec of ENV_CONTRACT) {
    const value = valueOrDefault(env, spec);
    if (spec.type === "integer") numeric[spec.name] = parseInteger(value, spec);
    if (spec.type === "enum") normalizeEnum(value, spec);
    if (spec.type === "boolean") booleans[spec.name] = validateBooleanValue(value, spec);
    if (spec.type === "command") validateCommandValue(value, spec);
    if (spec.type === "url") validateEndpoint(value);
    if (spec.type === "sqlite-file") validateSqliteFileName(value);
    if (spec.type === "secret") validateSecretValue(value, spec.category);
  }
  if (numeric.MATCHCUTS_WORKER_RETRY_INITIAL_DELAY_MS > numeric.MATCHCUTS_WORKER_RETRY_MAX_DELAY_MS) {
    throw new EnvironmentCheckError("ENV_WORKER_RETRY_INVALID", "Worker retry delay configuration is invalid.", {
      category: "Worker/job settings",
    });
  }
  if (numeric.MATCHCUTS_MULTIPART_PART_SIZE_BYTES > numeric.MATCHCUTS_MULTIPART_THRESHOLD_BYTES) {
    throw new EnvironmentCheckError("ENV_MULTIPART_INVALID", "Multipart storage configuration is invalid.", {
      category: "Storage/artifact adapter",
    });
  }
  return { numeric, booleans };
}

function validateStorageReadiness(env) {
  const adapter = normalizeEnum(valueOrDefault(env, ENV_CONTRACT.find((spec) => spec.name === "MATCHCUTS_STORAGE_ADAPTER")), {
    allowedValues: STORAGE_ADAPTERS,
    defaultValue: "local",
    category: "Storage/artifact adapter",
  });
  if (!STAGING_READY_STORAGE_ADAPTERS.includes(adapter)) {
    throw new EnvironmentCheckError("ENV_STORAGE_NOT_STAGING_READY", "Selected storage adapter is not staging-ready.", {
      category: "Storage/artifact adapter",
    });
  }
  const bucketConfigured = Boolean(String(rawValue(env, "MATCHCUTS_STORAGE_BUCKET") || "").trim());
  const regionConfigured = Boolean(String(rawValue(env, "MATCHCUTS_STORAGE_REGION") || "").trim());
  const endpointConfigured = Boolean(String(rawValue(env, "MATCHCUTS_STORAGE_ENDPOINT") || "").trim());
  const accessConfigured = validateSecretValue(rawValue(env, "MATCHCUTS_STORAGE_ACCESS_KEY_ID"), "Storage/artifact adapter");
  const secretConfigured = validateSecretValue(rawValue(env, "MATCHCUTS_STORAGE_SECRET_ACCESS_KEY"), "Storage/artifact adapter");
  const sessionConfigured = validateSecretValue(rawValue(env, "MATCHCUTS_STORAGE_SESSION_TOKEN"), "Storage/artifact adapter");
  if (["s3", "r2"].includes(adapter)) {
    if (!bucketConfigured || !accessConfigured || !secretConfigured) {
      throw new EnvironmentCheckError("ENV_CLOUD_STORAGE_INCOMPLETE", "Cloud storage adapter requires bucket and credentials.", {
        category: "Storage/artifact adapter",
      });
    }
    if (adapter === "s3" && !regionConfigured) {
      throw new EnvironmentCheckError("ENV_CLOUD_STORAGE_INCOMPLETE", "S3 storage adapter requires a region.", {
        category: "Storage/artifact adapter",
      });
    }
    if (adapter === "r2" && !endpointConfigured) {
      throw new EnvironmentCheckError("ENV_CLOUD_STORAGE_INCOMPLETE", "R2 storage adapter requires an endpoint.", {
        category: "Storage/artifact adapter",
      });
    }
  }
  return {
    adapter,
    objectStorage: ["s3", "r2"].includes(adapter),
    credentialSetConfigured: Boolean(accessConfigured && secretConfigured),
    sessionCredentialConfigured: sessionConfigured,
  };
}

function validateTranscriptionReadiness(env) {
  const requestedProvider = normalizeEnum(valueOrDefault(env, ENV_CONTRACT.find((spec) => spec.name === "MATCHCUTS_TRANSCRIPTION_PROVIDER")), {
    allowedValues: TRANSCRIPTION_PROVIDERS,
    defaultValue: "mock",
    category: "Transcription/AI provider",
  });
  const providerCredentialConfigured = validateSecretValue(rawValue(env, "OPENAI_API_KEY"), "Transcription/AI provider");
  if (requestedProvider === "openai" && !providerCredentialConfigured) {
    throw new EnvironmentCheckError("ENV_PROVIDER_CREDENTIAL_MISSING", "Real transcription provider requires a configured credential.", {
      category: "Transcription/AI provider",
    });
  }
  return {
    requestedProvider,
    activeProvider: requestedProvider === "openai" ? "openai" : "mock",
    providerCredentialConfigured,
    defaultProviderIsMock: valueOrDefault(env, ENV_CONTRACT.find((spec) => spec.name === "MATCHCUTS_TRANSCRIPTION_PROVIDER")) === "mock",
  };
}

function validateCloudReadiness(env, storage) {
  const enabledRaw = rawValue(env, "MATCHCUTS_RUN_REAL_CLOUD_TESTS");
  const enabled = boolFromEnv(enabledRaw);
  if (enabledRaw !== undefined && enabled && String(enabledRaw).trim() !== "1") {
    throw new EnvironmentCheckError("ENV_REAL_CLOUD_FLAG_INVALID", "Real cloud integration requires the explicit numeric enable flag.", {
      category: "Cloud integration",
    });
  }
  if (enabled && !storage.objectStorage) {
    throw new EnvironmentCheckError("ENV_REAL_CLOUD_INCOMPLETE", "Real cloud integration requires an object storage adapter.", {
      category: "Cloud integration",
    });
  }
  return { enabled, defaultOptIn: false };
}

function validateCiReadiness(env, numeric) {
  const browserSkip = boolFromEnv(rawValue(env, "SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP"));
  if (browserSkip) {
    throw new EnvironmentCheckError("ENV_BROWSER_SKIP_UNSAFE", "Browser runtime skip is not allowed in staging readiness checks.", {
      category: "Browser/demo/CI flags",
    });
  }
  return {
    browserRuntimeSkipAllowed: false,
    traceOnFailure: boolFromEnv(rawValue(env, "SHORTSENGINE_BROWSER_E2E_TRACE")),
    videoOnFailure: boolFromEnv(rawValue(env, "SHORTSENGINE_BROWSER_E2E_VIDEO")),
    retentionMax: numeric.SHORTSENGINE_BROWSER_E2E_RETENTION_MAX,
    reportMaxAgeMs: numeric.SHORTSENGINE_CI_REPORT_MAX_AGE_MS,
  };
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new EnvironmentCheckError("ENV_SUMMARY_LEAK", "Environment readiness summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function checkEnvironment(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const exampleText = readOptionalText(rootDir, ENV_EXAMPLE_RELATIVE_PATH, options.exampleText);
  const docsText = readOptionalText(rootDir, ENV_DOC_RELATIVE_PATH, options.docsText);
  validateExampleSecrets(exampleText);
  assertDocsMentionKnownVars(docsText);
  const { numeric } = validateContractValues(env);
  const storage = validateStorageReadiness(env);
  const transcription = validateTranscriptionReadiness(env);
  const cloudIntegration = validateCloudReadiness(env, storage);
  const ci = validateCiReadiness(env, numeric);
  const persistenceAdapter = normalizeEnum(valueOrDefault(env, ENV_CONTRACT.find((spec) => spec.name === "MATCHCUTS_PERSISTENCE_ADAPTER")), {
    allowedValues: PERSISTENCE_ADAPTERS,
    defaultValue: "local",
    category: "Persistence adapter",
  });
  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    contractVersion: 1,
    variablesChecked: ENV_CONTRACT.length,
    categories: [...new Set(ENV_CONTRACT.map((spec) => spec.category))],
    docs: {
      environmentDoc: ENV_DOC_RELATIVE_PATH,
      exampleFile: ENV_EXAMPLE_RELATIVE_PATH,
      complete: true,
    },
    runtime: {
      port: numeric.PORT,
      ffmpegCommandConfigured: Boolean(rawValue(env, "FFMPEG_BIN")),
      ffprobeCommandConfigured: Boolean(rawValue(env, "FFPROBE_BIN")),
    },
    limits: {
      maxUploadBytes: numeric.MATCHCUTS_MAX_UPLOAD_BYTES,
      maxDurationSeconds: numeric.MATCHCUTS_MAX_DURATION_SECONDS,
      renderTimeoutMs: numeric.MATCHCUTS_RENDER_TIMEOUT_MS,
      analysisTimeoutMs: numeric.MATCHCUTS_ANALYSIS_TIMEOUT_MS,
      transcriptionTimeoutMs: numeric.MATCHCUTS_TRANSCRIPTION_TIMEOUT_MS,
      transcriptionRetries: numeric.MATCHCUTS_TRANSCRIPTION_RETRIES,
    },
    youtubeIngest: {
      enabled: Boolean(boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED"))),
      downloaderConfigured: Boolean(valueOrDefault(env, ENV_CONTRACT.find((spec) => spec.name === "SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN"))),
      timeoutMs: numeric.SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS,
      outputBytes: numeric.SHORTSENGINE_YOUTUBE_DOWNLOADER_OUTPUT_BYTES,
      defaultDisabled: !boolFromEnv(rawValue(env, "SHORTSENGINE_YOUTUBE_INGEST_ENABLED")),
    },
    worker: {
      pollIntervalMs: numeric.MATCHCUTS_WORKER_POLL_INTERVAL_MS,
      shutdownTimeoutMs: numeric.MATCHCUTS_WORKER_SHUTDOWN_TIMEOUT_MS,
      retryInitialDelayMs: numeric.MATCHCUTS_WORKER_RETRY_INITIAL_DELAY_MS,
      retryMaxDelayMs: numeric.MATCHCUTS_WORKER_RETRY_MAX_DELAY_MS,
      retryMaxAttempts: numeric.MATCHCUTS_WORKER_RETRY_MAX_ATTEMPTS,
      cleanupIntervalMs: numeric.MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS,
    },
    storage: {
      adapter: storage.adapter,
      objectStorage: storage.objectStorage,
      credentialSetConfigured: storage.credentialSetConfigured,
      sessionCredentialConfigured: storage.sessionCredentialConfigured,
      signedUrlTtlSeconds: numeric.MATCHCUTS_STORAGE_SIGNED_URL_TTL_SECONDS,
      multipartThresholdBytes: numeric.MATCHCUTS_MULTIPART_THRESHOLD_BYTES,
      multipartPartSizeBytes: numeric.MATCHCUTS_MULTIPART_PART_SIZE_BYTES,
      cleanupMaxAgeSeconds: numeric.MATCHCUTS_ARTIFACT_CLEANUP_MAX_AGE_SECONDS,
      cleanupMaxPerRun: numeric.MATCHCUTS_ARTIFACT_CLEANUP_MAX_PER_RUN,
    },
    persistence: {
      adapter: persistenceAdapter,
      database: persistenceAdapter === "sqlite",
    },
    transcription,
    cloudIntegration,
    ci,
    safeDefaults: {
      mockTranscriptionDefault: true,
      localStorageDefault: true,
      localPersistenceDefault: true,
      youtubeIngestOptIn: true,
      realCloudOptIn: true,
    },
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "ENV_CHECK_FAILED",
    message: error && error.message ? error.message : "Environment readiness check failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(checkEnvironment(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  ENV_CONTRACT,
  ENV_DOC_RELATIVE_PATH,
  ENV_EXAMPLE_RELATIVE_PATH,
  EnvironmentCheckError,
  ROOT_DIR,
  boolFromEnv,
  checkEnvironment,
  safeError,
  validateExampleSecrets,
};
