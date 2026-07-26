const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const LOGIN_COOKIE = "__Host-shortsen_login";
const SESSION_COOKIE = "__Host-shortsen_session";
const CSRF_COOKIE = "__Host-shortsen_csrf";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_COOKIE_BYTES = 4096;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function authFailure(code = "OIDC_AUTH_FAILED", status = 401) {
  return new AppError(code, SAFE_MESSAGES[code], status);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function deriveEncryptionKey(secret) {
  return createHash("sha256")
    .update("shortsengine:oidc-login-cookie:v1\0", "utf8")
    .update(String(secret || ""), "utf8")
    .digest();
}

function sealLoginTransaction(value, secret, random = randomBytes) {
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", deriveEncryptionKey(secret), iv);
  cipher.setAAD(Buffer.from("shortsengine:oidc-login:v1", "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64url(iv)}.${base64url(ciphertext)}.${base64url(tag)}`;
}

function openLoginTransaction(value, secret) {
  try {
    const raw = String(value || "");
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_COOKIE_BYTES) throw new Error("invalid");
    const parts = raw.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("invalid");
    const iv = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(secret), iv);
    decipher.setAAD(Buffer.from("shortsengine:oidc-login:v1", "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw authFailure();
  }
}

function cookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    "Path=/",
    "Secure",
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (Number.isInteger(options.maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, options.maxAgeSeconds)}`);
  }
  return parts.join("; ");
}

function expireCookie(name) {
  return cookie(name, "", { maxAgeSeconds: 0 });
}

function readCookie(cookieHeader, name) {
  const raw = String(cookieHeader || "");
  if (!raw || Buffer.byteLength(raw, "utf8") > 16 * 1024) return "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function safeReturnTo(value) {
  const candidate = String(value || "/").trim();
  if (
    !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return "/";
  }
  return candidate.slice(0, 1024);
}

function principal(userId) {
  return Object.freeze({
    id: String(userId),
    role: "user",
    authMode: "oidc",
    permissions: Object.freeze(["user"]),
    canAccessUnowned: false,
  });
}

function persistenceMethod(persistence, method) {
  if (persistence && typeof persistence[method] === "function") {
    return persistence[method].bind(persistence);
  }
  if (persistence && typeof persistence.call === "function") {
    return (...args) => persistence.call(method, ...args);
  }
  throw new AppError(
    "ADAPTER_CONTRACT_INVALID",
    SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
    500,
  );
}

class OidcAuthAdapter {
  constructor(options = {}) {
    this.config = options.config && options.config.oidc
      ? options.config.oidc
      : options.config;
    this.persistence = options.persistence;
    this.clock = options.clock || { now: () => Date.now() };
    this.randomBytes = options.randomBytes || randomBytes;
    this.oidc = options.oidc || require("openid-client");
    this.client = options.client || null;
    this.initialized = Boolean(this.client);
    this.allowedOrigin = new URL(this.config.publicBaseUrl).origin;
  }

  async initialize() {
    if (this.initialized) return false;
    try {
      const issuer = await this.oidc.Issuer.discover(this.config.issuerUrl);
      this.client = new issuer.Client({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
      this.initialized = true;
      return true;
    } catch {
      throw new AppError("AUTH_CONFIG_INVALID", SAFE_MESSAGES.AUTH_CONFIG_INVALID, 503);
    }
  }

  assertInitialized() {
    if (!this.initialized || !this.client) {
      throw new AppError("AUTH_CONFIG_INVALID", SAFE_MESSAGES.AUTH_CONFIG_INVALID, 503);
    }
  }

  async beginLogin(options = {}) {
    this.assertInitialized();
    const now = this.clock.now();
    const state = base64url(this.randomBytes(32));
    const nonce = base64url(this.randomBytes(32));
    const verifier = base64url(this.randomBytes(64));
    const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
    const transaction = {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(options.returnTo),
      expiresAt: now + LOGIN_TTL_MS,
    };
    const transactionCookie = sealLoginTransaction(
      transaction,
      this.config.sessionSecret,
      this.randomBytes,
    );
    const authorizationUrl = this.client.authorizationUrl({
      scope: "openid",
      response_type: "code",
      redirect_uri: this.config.redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return {
      authorizationUrl,
      setCookie: cookie(LOGIN_COOKIE, transactionCookie, {
        maxAgeSeconds: LOGIN_TTL_MS / 1000,
      }),
    };
  }

  async completeLogin({ params = {}, transactionCookie = "" } = {}) {
    this.assertInitialized();
    const transaction = openLoginTransaction(transactionCookie, this.config.sessionSecret);
    if (
      !Number.isFinite(transaction.expiresAt)
      || transaction.expiresAt <= this.clock.now()
      || !equalText(params.state, transaction.state)
    ) {
      throw authFailure();
    }
    let tokenSet;
    try {
      tokenSet = await this.client.callback(
        this.config.redirectUri,
        params,
        {
          code_verifier: transaction.verifier,
          state: transaction.state,
          nonce: transaction.nonce,
          response_type: "code",
        },
      );
    } catch {
      throw authFailure();
    }
    let claims;
    try {
      claims = tokenSet.claims();
    } catch {
      throw authFailure();
    }
    const subject = String(claims && claims.sub || "").trim();
    const issuer = String(claims && claims.iss || this.config.issuerUrl).trim();
    if (!subject || !issuer || issuer !== this.config.issuerUrl) throw authFailure();

    const user = await persistenceMethod(
      this.persistence,
      "createUserFromIdentity",
    )({ issuer, subject });
    const sessionToken = base64url(this.randomBytes(32));
    const csrfToken = base64url(this.randomBytes(32));
    const now = this.clock.now();
    await persistenceMethod(this.persistence, "createSession")({
      id: `ses_${base64url(this.randomBytes(18))}`,
      userId: user.id,
      tokenHash: digest(sessionToken),
      csrfTokenHash: digest(csrfToken),
      expiresAt: new Date(now + this.config.sessionAbsoluteTtlMs).toISOString(),
      idleExpiresAt: new Date(
        Math.min(
          now + this.config.sessionAbsoluteTtlMs,
          now + this.config.sessionIdleTtlMs,
        ),
      ).toISOString(),
    });
    return {
      principal: principal(user.id),
      csrfToken,
      returnTo: safeReturnTo(transaction.returnTo),
      setCookies: [
        cookie(SESSION_COOKIE, sessionToken, {
          maxAgeSeconds: Math.floor(this.config.sessionAbsoluteTtlMs / 1000),
        }),
        cookie(CSRF_COOKIE, csrfToken, {
          httpOnly: false,
          maxAgeSeconds: Math.floor(this.config.sessionAbsoluteTtlMs / 1000),
        }),
        expireCookie(LOGIN_COOKIE),
      ],
    };
  }

  async resolveSession({ sessionToken = "" } = {}) {
    if (!sessionToken) return null;
    const session = await persistenceMethod(this.persistence, "resolveSession")({
      tokenHash: digest(sessionToken),
      idleTtlMs: this.config.sessionIdleTtlMs,
    });
    if (!session) return null;
    return {
      ...session,
      principal: principal(session.userId),
    };
  }

  assertCsrf({ method, origin, csrfToken, session }) {
    if (SAFE_METHODS.has(String(method || "GET").toUpperCase())) return true;
    if (
      !session
      || !origin
      || origin !== this.allowedOrigin
      || !csrfToken
      || !equalText(digest(csrfToken), session.csrfTokenHash)
    ) {
      throw authFailure("CSRF_INVALID", 403);
    }
    return true;
  }

  async logout({ sessionToken = "", userId = null } = {}) {
    if (sessionToken) {
      await persistenceMethod(this.persistence, "revokeSession")({
        tokenHash: digest(sessionToken),
        userId,
      });
    }
    const setCookies = [
      expireCookie(SESSION_COOKIE),
      expireCookie(CSRF_COOKIE, { httpOnly: false }),
    ];
    return {
      setCookie: setCookies[0],
      setCookies,
    };
  }

  sessionTokenFromCookie(cookieHeader) {
    return readCookie(cookieHeader, SESSION_COOKIE);
  }

  loginTransactionFromCookie(cookieHeader) {
    return readCookie(cookieHeader, LOGIN_COOKIE);
  }

  csrfTokenFromCookie(cookieHeader) {
    return readCookie(cookieHeader, CSRF_COOKIE);
  }

  async health() {
    return {
      ready: this.initialized,
      mode: "oidc",
      providerConfigured: Boolean(
        this.config.issuerUrl
        && this.config.clientId
        && this.config.redirectUri
      ),
    };
  }
}

async function createOidcAuthAdapter(options = {}) {
  const adapter = new OidcAuthAdapter(options);
  if (options.initialize !== false) await adapter.initialize();
  return adapter;
}

module.exports = {
  CSRF_COOKIE,
  LOGIN_COOKIE,
  LOGIN_TTL_MS,
  OidcAuthAdapter,
  SESSION_COOKIE,
  createOidcAuthAdapter,
  digest,
  expireCookie,
  openLoginTransaction,
  readCookie,
  sealLoginTransaction,
};
