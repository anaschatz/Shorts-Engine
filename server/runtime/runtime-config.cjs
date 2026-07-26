const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const PROCESS_ROLES = Object.freeze(["web", "worker", "migrate"]);
const PERSISTENCE_MODES = Object.freeze(["local", "sqlite", "postgres"]);
const QUEUE_MODES = Object.freeze(["local-jobstore", "postgres"]);
const AUTH_MODES = Object.freeze(["local", "operator", "oidc"]);
const STORAGE_MODES = Object.freeze(["local", "mock-cloud", "s3", "r2"]);
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

  if (strict) {
    if (persistenceMode !== "postgres") invalidConfiguration("MATCHCUTS_PERSISTENCE_ADAPTER");
    if (queueMode !== "postgres") invalidConfiguration("MATCHCUTS_QUEUE_ADAPTER");
    if (authMode !== "oidc") invalidConfiguration("SHORTSENGINE_AUTH_MODE");
    if (!["s3", "r2"].includes(storageMode)) invalidConfiguration("MATCHCUTS_STORAGE_ADAPTER");
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

  return Object.freeze({
    environment,
    strict,
    role,
    persistenceMode,
    queueMode,
    authMode,
    storageMode,
    postgres,
    oidc,
    worker: Object.freeze({
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
    },
  };
}

module.exports = {
  AUTH_MODES,
  PERSISTENCE_MODES,
  PROCESS_ROLES,
  QUEUE_MODES,
  STORAGE_MODES,
  loadRuntimeConfig,
  publicRuntimeConfig,
};
