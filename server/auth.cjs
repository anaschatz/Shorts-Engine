const { createHash, timingSafeEqual } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const AUTH_MODES = Object.freeze(["operator", "local"]);
const DEPLOYMENT_ENVIRONMENTS = Object.freeze(["development", "test", "local", "staging", "production"]);
const TOKEN_MIN_BYTES = 24;

function sanitizeText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeOwnerId(value, fallback = "operator") {
  const raw = sanitizeText(value || fallback, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(raw)) {
    throw new AppError("AUTH_CONFIG_INVALID", SAFE_MESSAGES.AUTH_CONFIG_INVALID, 500);
  }
  return raw;
}

function deploymentEnvironment(input) {
  const value = String(input || process.env.NODE_ENV || "development").trim().toLowerCase();
  return DEPLOYMENT_ENVIRONMENTS.includes(value) ? value : "development";
}

function tokenLooksWeak(token) {
  const value = String(token || "");
  return (
    value.length < TOKEN_MIN_BYTES ||
    /[\u0000-\u001f\u007f\s]/.test(value) ||
    /^(changeme|password|secret|token|dev|local|operator|shortsengine)$/i.test(value)
  );
}

function validateAuthConfig(input = {}) {
  const mode = String(input.mode || "operator").trim().toLowerCase();
  if (!AUTH_MODES.includes(mode)) {
    throw new Error("Invalid SHORTSENGINE_AUTH_MODE value.");
  }
  const environment = deploymentEnvironment(input.environment);
  const operatorToken = String(input.operatorToken || "").trim();
  const operatorId = normalizeOwnerId(input.operatorId || "operator", "operator");
  if (mode === "local" && ["staging", "production"].includes(environment)) {
    throw new Error("Local anonymous auth mode is not allowed in staging/production.");
  }
  if (operatorToken && tokenLooksWeak(operatorToken)) {
    throw new Error("Invalid ShortsEngine operator auth token configuration.");
  }
  if (mode === "operator" && ["staging", "production"].includes(environment) && !operatorToken) {
    throw new Error("ShortsEngine operator auth token is required in staging/production.");
  }
  return {
    mode,
    environment,
    operatorId,
    operatorTokenConfigured: Boolean(operatorToken),
    operatorTokenDigest: operatorToken ? digestToken(operatorToken) : "",
    localAnonymous: mode === "local",
  };
}

function digestToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest();
}

function safeTimingEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBearerToken(req) {
  const authorization = req && req.headers ? req.headers.authorization : "";
  if (authorization) {
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{8,512})$/i.exec(String(authorization).trim());
    if (!match) {
      throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
    }
    return match[1];
  }
  const headerToken = req && req.headers ? req.headers["x-shortsengine-auth"] || req.headers["x-shortsengine-token"] : "";
  if (!headerToken) return "";
  const token = String(headerToken).trim();
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(token)) {
    throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
  }
  return token;
}

function localPrincipal(config = {}) {
  return {
    id: normalizeOwnerId(config.operatorId || "local_operator", "local_operator"),
    role: "operator",
    authMode: "local",
    permissions: ["operator"],
    canAccessUnowned: true,
  };
}

function operatorPrincipal(config = {}) {
  return {
    id: normalizeOwnerId(config.operatorId || "operator", "operator"),
    role: "operator",
    authMode: "operator",
    permissions: ["operator"],
    canAccessUnowned: false,
  };
}

function authenticateRequest(req, config = {}) {
  if (config.mode === "local") return localPrincipal(config);
  if (!config.operatorTokenConfigured || !config.operatorTokenDigest) {
    throw new AppError("AUTH_CONFIG_MISSING", SAFE_MESSAGES.AUTH_CONFIG_MISSING, 503, {
      authMode: "operator",
      nextAction: "configure-shortsengine-operator-auth-token",
    });
  }
  const token = readBearerToken(req);
  if (!token) {
    throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
  }
  if (!safeTimingEqual(digestToken(token), config.operatorTokenDigest)) {
    throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
  }
  return operatorPrincipal(config);
}

function safePrincipal(principal) {
  if (!principal) return null;
  return {
    id: normalizeOwnerId(principal.id || "operator", "operator"),
    role: sanitizeText(principal.role || "operator", 40),
    authMode: sanitizeText(principal.authMode || "operator", 40),
  };
}

function publicAuthHealth(config = {}) {
  return {
    mode: sanitizeText(config.mode || "operator", 40),
    environment: sanitizeText(config.environment || "development", 40),
    operatorTokenConfigured: config.operatorTokenConfigured === true,
    localAnonymous: config.localAnonymous === true,
    ready: config.mode === "local" || config.operatorTokenConfigured === true,
  };
}

function assertPrincipalCanAccessOwner(principal, ownerId, options = {}) {
  if (!principal) {
    throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
  }
  const safeOwnerId = ownerId ? normalizeOwnerId(ownerId, "operator") : "";
  if (!safeOwnerId) {
    if (principal.canAccessUnowned === true) return true;
    throw new AppError("FORBIDDEN", SAFE_MESSAGES.FORBIDDEN, 403, {
      resource: sanitizeText(options.resource || "resource", 60),
      reason: "missing_owner",
    });
  }
  if (safeOwnerId !== principal.id) {
    throw new AppError("FORBIDDEN", SAFE_MESSAGES.FORBIDDEN, 403, {
      resource: sanitizeText(options.resource || "resource", 60),
      reason: "owner_mismatch",
    });
  }
  return true;
}

module.exports = {
  AUTH_MODES,
  assertPrincipalCanAccessOwner,
  authenticateRequest,
  normalizeOwnerId,
  publicAuthHealth,
  safePrincipal,
  validateAuthConfig,
};
