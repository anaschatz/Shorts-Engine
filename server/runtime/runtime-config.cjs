const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const PROCESS_ROLES = Object.freeze(["web", "worker", "migrate"]);
const PERSISTENCE_MODES = Object.freeze(["local", "sqlite", "postgres"]);
const QUEUE_MODES = Object.freeze(["local-jobstore", "postgres"]);
const AUTH_MODES = Object.freeze(["local", "operator", "oidc"]);
const STORAGE_MODES = Object.freeze(["local", "mock-cloud", "s3", "r2"]);
const TELEMETRY_MODES = Object.freeze(["memory", "postgres"]);
const STRICT_ENVIRONMENTS = Object.freeze(["staging", "production"]);

function invalidConfiguration(field) {
  throw new AppError(
    "CONFIGURATION_INVALID",
    SAFE_MESSAGES.CONFIGURATION_INVALID || "The server configuration is invalid.",
    500,
    { field },
  );
}

function enumValue(value, allowed, fallback, field) {
  const normalized = String(value === undefined || value === null || value === "" ? fallback : value)
    .trim()
    .toLowerCase();
  if (!allowed.includes(normalized)) invalidConfiguration(field);
  return normalized;
}

function boundedInteger(value, fallback, { min, max, field }) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) invalidConfiguration(field);
  return number;
}

function boundedNumber(value, fallback, { min, max, field }) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    invalidConfiguration(field);
  }
  return number;
}

function optionalHttpsUrl(value, field) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    invalidConfiguration(field);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    invalidConfiguration(field);
  }
  return parsed.toString();
}

function postgresUrl(value, required) {
  const raw = String(value || "").trim();
  if (!raw && !required) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    invalidConfiguration("DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname) {
    invalidConfiguration("DATABASE_URL");
  }
  return raw;
}

function requiredSecret(value, field, minimumLength = 16) {
  const raw = String(value || "");
  if (
    raw.length < minimumLength
    || raw.length > 4096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)
  ) {
    invalidConfiguration(field);
  }
  return raw;
}

function storageBucket(value, required) {
  const raw = String(value || "").trim();
  if (!raw && !required) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(raw)) {
    invalidConfiguration("MATCHCUTS_STORAGE_BUCKET");
  }
  return raw;
}

function loadRuntimeConfig(env = process.env) {
  const environment = enumValue(
    env.SHORTSENGINE_ENVIRONMENT || env.NODE_ENV,
    ["development", "test", ...STRICT_ENVIRONMENTS],
    "development",
    "SHORTSENGINE_ENVIRONMENT",
  );
  const strict = STRICT_ENVIRONMENTS.includes(environment);
  const role = enumValue(
    env.SHORTSENGINE_PROCESS_ROLE,
    PROCESS_ROLES,
    "web",
    "SHORTSENGINE_PROCESS_ROLE",
  );
  const persistenceMode = enumValue(
    env.MATCHCUTS_PERSISTENCE_ADAPTER,
    PERSISTENCE_MODES,
    "local",
    "MATCHCUTS_PERSISTENCE_ADAPTER",
  );
  const queueMode = enumValue(
    env.MATCHCUTS_QUEUE_ADAPTER,
    QUEUE_MODES,
    persistenceMode === "postgres" ? "postgres" : "local-jobstore",
    "MATCHCUTS_QUEUE_ADAPTER",
  );
  const authMode = enumValue(
    env.SHORTSENGINE_AUTH_MODE,
    AUTH_MODES,
    "operator",
    "SHORTSENGINE_AUTH_MODE",
  );
  const storageMode = enumValue(
    env.MATCHCUTS_STORAGE_ADAPTER,
    STORAGE_MODES,
    "local",
    "MATCHCUTS_STORAGE_ADAPTER",
  );
  const telemetryMode = enumValue(
    env.SHORTSENGINE_TELEMETRY_ADAPTER,
    TELEMETRY_MODES,
    strict ? "postgres" : "memory",
    "SHORTSENGINE_TELEMETRY_ADAPTER",
  );

  if (strict) {
    if (persistenceMode !== "postgres") invalidConfiguration("MATCHCUTS_PERSISTENCE_ADAPTER");
    if (queueMode !== "postgres") invalidConfiguration("MATCHCUTS_QUEUE_ADAPTER");
    if (authMode !== "oidc") invalidConfiguration("SHORTSENGINE_AUTH_MODE");
    if (storageMode !== "r2") invalidConfiguration("MATCHCUTS_STORAGE_ADAPTER");
    if (telemetryMode !== "postgres") {
      invalidConfiguration("SHORTSENGINE_TELEMETRY_ADAPTER");
    }
  }
  if (persistenceMode === "postgres" && queueMode !== "postgres") {
    invalidConfiguration("MATCHCUTS_QUEUE_ADAPTER");
  }

  const databaseUrl = postgresUrl(env.DATABASE_URL, persistenceMode === "postgres");
  const postgres = Object.freeze({
    url: databaseUrl,
    poolMax: boundedInteger(env.MATCHCUTS_POSTGRES_POOL_MAX, 5, {
      min: 1,
      max: 50,
      field: "MATCHCUTS_POSTGRES_POOL_MAX",
    }),
    connectionTimeoutMs: boundedInteger(env.MATCHCUTS_POSTGRES_CONNECTION_TIMEOUT_MS, 5000, {
      min: 250,
      max: 60000,
      field: "MATCHCUTS_POSTGRES_CONNECTION_TIMEOUT_MS",
    }),
    idleTimeoutMs: boundedInteger(env.MATCHCUTS_POSTGRES_IDLE_TIMEOUT_MS, 30000, {
      min: 1000,
      max: 600000,
      field: "MATCHCUTS_POSTGRES_IDLE_TIMEOUT_MS",
    }),
    statementTimeoutMs: boundedInteger(env.MATCHCUTS_POSTGRES_STATEMENT_TIMEOUT_MS, 30000, {
      min: 1000,
      max: 600000,
      field: "MATCHCUTS_POSTGRES_STATEMENT_TIMEOUT_MS",
    }),
    transactionTimeoutMs: boundedInteger(env.MATCHCUTS_POSTGRES_TRANSACTION_TIMEOUT_MS, 60000, {
      min: 1000,
      max: 900000,
      field: "MATCHCUTS_POSTGRES_TRANSACTION_TIMEOUT_MS",
    }),
    sslMode: enumValue(
      env.MATCHCUTS_POSTGRES_SSL_MODE,
      ["disable", "require"],
      strict ? "require" : "disable",
      "MATCHCUTS_POSTGRES_SSL_MODE",
    ),
  });

  const oidcRequired = authMode === "oidc";
  const oidcIssuerUrl = optionalHttpsUrl(env.SHORTSENGINE_OIDC_ISSUER_URL, "SHORTSENGINE_OIDC_ISSUER_URL");
  const oidcRedirectUri = optionalHttpsUrl(env.SHORTSENGINE_OIDC_REDIRECT_URI, "SHORTSENGINE_OIDC_REDIRECT_URI");
  const publicBaseUrl = optionalHttpsUrl(env.SHORTSENGINE_PUBLIC_BASE_URL, "SHORTSENGINE_PUBLIC_BASE_URL");
  const oidcClientId = String(env.SHORTSENGINE_OIDC_CLIENT_ID || "").trim();
  if (oidcRequired && (!oidcIssuerUrl || !oidcRedirectUri || !publicBaseUrl || !oidcClientId)) {
    invalidConfiguration("SHORTSENGINE_OIDC");
  }
  const oidc = Object.freeze({
    issuerUrl: oidcIssuerUrl,
    clientId: oidcClientId,
    clientSecret: oidcRequired
      ? requiredSecret(env.SHORTSENGINE_OIDC_CLIENT_SECRET, "SHORTSENGINE_OIDC_CLIENT_SECRET")
      : "",
    redirectUri: oidcRedirectUri,
    publicBaseUrl,
    sessionSecret: oidcRequired
      ? requiredSecret(env.SHORTSENGINE_SESSION_SECRET, "SHORTSENGINE_SESSION_SECRET", 32)
      : "",
    sessionAbsoluteTtlMs: boundedInteger(env.SHORTSENGINE_SESSION_ABSOLUTE_TTL_MS, 8 * 60 * 60 * 1000, {
      min: 5 * 60 * 1000,
      max: 7 * 24 * 60 * 60 * 1000,
      field: "SHORTSENGINE_SESSION_ABSOLUTE_TTL_MS",
    }),
    sessionIdleTtlMs: boundedInteger(env.SHORTSENGINE_SESSION_IDLE_TTL_MS, 30 * 60 * 1000, {
      min: 60 * 1000,
      max: 24 * 60 * 60 * 1000,
      field: "SHORTSENGINE_SESSION_IDLE_TTL_MS",
    }),
  });

  const cloudStorageRequired = ["s3", "r2"].includes(storageMode);
  const storageEndpoint = String(env.MATCHCUTS_STORAGE_ENDPOINT || "").trim();
  let endpoint = "";
  if (storageEndpoint) {
    let parsed;
    try {
      parsed = new URL(storageEndpoint);
    } catch {
      invalidConfiguration("MATCHCUTS_STORAGE_ENDPOINT");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.hash
      || (strict && parsed.protocol !== "https:")
    ) {
      invalidConfiguration("MATCHCUTS_STORAGE_ENDPOINT");
    }
    endpoint = parsed.toString().replace(/\/$/, "");
  }
  if (storageMode === "r2" && !endpoint) invalidConfiguration("MATCHCUTS_STORAGE_ENDPOINT");
  const storage = Object.freeze({
    bucket: storageBucket(env.MATCHCUTS_STORAGE_BUCKET, cloudStorageRequired),
    region: String(env.MATCHCUTS_STORAGE_REGION || (storageMode === "r2" ? "auto" : "")).trim(),
    endpoint,
    accessKeyId: cloudStorageRequired
      ? requiredSecret(env.MATCHCUTS_STORAGE_ACCESS_KEY_ID, "MATCHCUTS_STORAGE_ACCESS_KEY_ID", 3)
      : "",
    secretAccessKey: cloudStorageRequired
      ? requiredSecret(env.MATCHCUTS_STORAGE_SECRET_ACCESS_KEY, "MATCHCUTS_STORAGE_SECRET_ACCESS_KEY", 8)
      : "",
    sessionToken: String(env.MATCHCUTS_STORAGE_SESSION_TOKEN || ""),
    partSizeBytes: boundedInteger(env.MATCHCUTS_MULTIPART_PART_SIZE_BYTES, 16 * 1024 * 1024, {
      min: 5 * 1024 * 1024,
      max: 512 * 1024 * 1024,
      field: "MATCHCUTS_MULTIPART_PART_SIZE_BYTES",
    }),
    presignTtlSeconds: boundedInteger(env.MATCHCUTS_UPLOAD_PART_URL_TTL_SECONDS, 600, {
      min: 60,
      max: 900,
      field: "MATCHCUTS_UPLOAD_PART_URL_TTL_SECONDS",
    }),
    stagingRetentionHours: boundedInteger(env.MATCHCUTS_STAGING_RETENTION_HOURS, 24, {
      min: 1,
      max: 168,
      field: "MATCHCUTS_STAGING_RETENTION_HOURS",
    }),
    previewRetentionHours: boundedInteger(env.MATCHCUTS_PREVIEW_RETENTION_HOURS, 24, {
      min: 1,
      max: 168,
      field: "MATCHCUTS_PREVIEW_RETENTION_HOURS",
    }),
    exportRetentionDays: boundedInteger(env.MATCHCUTS_EXPORT_RETENTION_DAYS, 30, {
      min: 1,
      max: 365,
      field: "MATCHCUTS_EXPORT_RETENTION_DAYS",
    }),
  });
  if (cloudStorageRequired && storageMode === "s3" && !storage.region) {
    invalidConfiguration("MATCHCUTS_STORAGE_REGION");
  }

  const worker = Object.freeze({
    leaseMs: boundedInteger(env.MATCHCUTS_WORKER_LEASE_MS, 60000, {
      min: 10000,
      max: 15 * 60 * 1000,
      field: "MATCHCUTS_WORKER_LEASE_MS",
    }),
    heartbeatMs: boundedInteger(env.MATCHCUTS_WORKER_HEARTBEAT_MS, 20000, {
      min: 1000,
      max: 5 * 60 * 1000,
      field: "MATCHCUTS_WORKER_HEARTBEAT_MS",
    }),
    pollMs: boundedInteger(env.MATCHCUTS_WORKER_POLL_INTERVAL_MS, 1000, {
      min: 100,
      max: 60000,
      field: "MATCHCUTS_WORKER_POLL_INTERVAL_MS",
    }),
    maxAttempts: boundedInteger(env.MATCHCUTS_JOB_MAX_ATTEMPTS, 4, {
      min: 1,
      max: 10,
      field: "MATCHCUTS_JOB_MAX_ATTEMPTS",
    }),
    retryBaseMs: boundedInteger(env.MATCHCUTS_RETRY_BASE_MS, 1000, {
      min: 100,
      max: 60000,
      field: "MATCHCUTS_RETRY_BASE_MS",
    }),
  });
  if (worker.heartbeatMs * 2 >= worker.leaseMs) {
    invalidConfiguration("MATCHCUTS_WORKER_HEARTBEAT_MS");
  }

  return Object.freeze({
    environment,
    strict,
    role,
    persistenceMode,
    queueMode,
    authMode,
    storageMode,
    telemetryMode,
    postgres,
    oidc,
    storage,
    worker,
    quotas: Object.freeze({
      maxUploadBytes: boundedInteger(env.SHORTSENGINE_MAX_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024, {
        min: 1024 * 1024,
        max: 20 * 1024 * 1024 * 1024,
        field: "SHORTSENGINE_MAX_UPLOAD_BYTES",
      }),
      maxVideoDurationSeconds: boundedInteger(
        env.SHORTSENGINE_MAX_VIDEO_DURATION_SECONDS,
        4 * 60 * 60,
        {
          min: 30,
          max: 24 * 60 * 60,
          field: "SHORTSENGINE_MAX_VIDEO_DURATION_SECONDS",
        },
      ),
      dailyRenderLimit: boundedInteger(env.SHORTSENGINE_DAILY_RENDER_LIMIT, 20, {
        min: 1,
        max: 10000,
        field: "SHORTSENGINE_DAILY_RENDER_LIMIT",
      }),
      monthlyRenderLimit: boundedInteger(env.SHORTSENGINE_MONTHLY_RENDER_LIMIT, 400, {
        min: 1,
        max: 100000,
        field: "SHORTSENGINE_MONTHLY_RENDER_LIMIT",
      }),
      perUserConcurrency: boundedInteger(env.SHORTSENGINE_USER_CONCURRENCY_LIMIT, 2, {
        min: 1,
        max: 32,
        field: "SHORTSENGINE_USER_CONCURRENCY_LIMIT",
      }),
      globalConcurrency: boundedInteger(env.SHORTSENGINE_GLOBAL_CONCURRENCY_LIMIT, 8, {
        min: 1,
        max: 256,
        field: "SHORTSENGINE_GLOBAL_CONCURRENCY_LIMIT",
      }),
      providerBudgetUsd: boundedNumber(env.SHORTSENGINE_PROVIDER_MONTHLY_BUDGET_USD, 100, {
        min: 0,
        max: 1_000_000,
        field: "SHORTSENGINE_PROVIDER_MONTHLY_BUDGET_USD",
      }),
    }),
    rendering: Object.freeze({
      analysisTimeoutMs: boundedInteger(env.SHORTSENGINE_ANALYSIS_TIMEOUT_MS, 15 * 60 * 1000, {
        min: 30 * 1000,
        max: 2 * 60 * 60 * 1000,
        field: "SHORTSENGINE_ANALYSIS_TIMEOUT_MS",
      }),
      renderTimeoutMs: boundedInteger(env.SHORTSENGINE_RENDER_TIMEOUT_MS, 30 * 60 * 1000, {
        min: 60 * 1000,
        max: 4 * 60 * 60 * 1000,
        field: "SHORTSENGINE_RENDER_TIMEOUT_MS",
      }),
    }),
    telemetry: Object.freeze({
      mode: telemetryMode,
      metricRetentionDays: boundedInteger(env.SHORTSENGINE_METRIC_RETENTION_DAYS, 30, {
        min: 1,
        max: 365,
        field: "SHORTSENGINE_METRIC_RETENTION_DAYS",
      }),
    }),
  });
}

function publicRuntimeConfig(config) {
  return {
    environment: config.environment,
    role: config.role,
    strict: config.strict,
    adapters: {
      persistence: config.persistenceMode,
      queue: config.queueMode,
      auth: config.authMode,
      storage: config.storageMode,
      telemetry: config.telemetryMode,
    },
    configured: {
      database: Boolean(config.postgres && config.postgres.url),
      oidc: Boolean(
        config.oidc
        && config.oidc.issuerUrl
        && config.oidc.clientId
        && config.oidc.redirectUri
        && config.oidc.sessionSecret
      ),
      storage: Boolean(
        config.storage
        && config.storage.bucket
        && config.storage.accessKeyId
        && config.storage.secretAccessKey
      ),
    },
  };
}

module.exports = {
  AUTH_MODES,
  PERSISTENCE_MODES,
  PROCESS_ROLES,
  QUEUE_MODES,
  STORAGE_MODES,
  TELEMETRY_MODES,
  loadRuntimeConfig,
  publicRuntimeConfig,
};
