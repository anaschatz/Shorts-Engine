import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { redactForLogs } = require("../server/errors.cjs");

const SIGNED_DOWNLOAD_TOKEN_RE = /adt_[A-Fa-f0-9-]{36}_[A-Fa-f0-9]{32}/;
const URL_WITH_QUERY_RE = /(?:https?:\/\/|\/)[^\s"']*\?[^\s"']*/gi;
const SECRET_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "auth_token",
  "client_secret",
  "id_token",
  "oauth_token",
  "refresh_token",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-security-token",
  "x-goog-signature",
]);
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  { code: "LOCAL_PATH", pattern: /(?:^|[\s"'=])\/(?:Users|private|var\/folders|tmp)\/[^\s"']*/i },
  { code: "FILE_URL", pattern: /file:\/\/[^\s"']+/i },
  { code: "WINDOWS_PATH", pattern: /\b[A-Za-z]:\\[^\s"']+/ },
  { code: "OPENAI_API_KEY", pattern: /OPENAI_API_KEY\s*=?\s*[^\s"']*/i },
  { code: "MATCHCUTS_SECRET", pattern: /MATCHCUTS_[A-Z0-9_]*(?:SECRET|TOKEN|ACCESS_KEY)[A-Z0-9_]*\s*=?\s*[^\s"']*/i },
  { code: "SHORTSENGINE_SECRET", pattern: /SHORTSENGINE_[A-Z0-9_]*(?:SECRET|TOKEN|ACCESS_KEY|SERVICE_ID)[A-Z0-9_]*\s*=\s*[^\s"']+/i },
  { code: "APP_SECRET_VALUE", pattern: /\b(?:MATCHCUTS|SHORTSENGINE|YOUTUBE|YT_DLP|GOOGLE)[A-Z0-9_]*(?:SECRET|TOKEN|ACCESS_KEY|API_KEY|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|SERVICE_ID)[A-Z0-9_]*(?:\s*[:=]\s*|\s+)[^\s"']+/i },
  { code: "AWS_ACCESS_KEY", pattern: /(?:AKIA|ASIA)[A-Z0-9]{12,}/ },
  { code: "GITHUB_TOKEN", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { code: "GITLAB_TOKEN", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { code: "SLACK_TOKEN", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i },
  { code: "PRIVATE_KEY_BLOCK", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "YOUTUBE_COOKIE_VALUE", pattern: /\b(?:VISITOR_INFO1_LIVE|LOGIN_INFO|SAPISID|HSID|SSID|APISID|SID)=[^\s"']+/i },
  { code: "BEARER_TOKEN", pattern: /Bearer\s+[A-Za-z0-9._-]+/i },
  { code: "MODEL_API_KEY", pattern: /sk-[A-Za-z0-9_-]{10,}/ },
  { code: "RENDER_SERVICE_ID", pattern: /\bsrv-[A-Za-z0-9_-]{6,80}\b/ },
  { code: "S3_SIGNATURE", pattern: /X-Amz-(?:Signature|Credential)=[^&\s"']+/i },
]);

const UNSAFE_KEYS = new Set([
  "absolutepath",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "accesstoken",
  "apikey",
  "deploytoken",
  "filepath",
  "fullpath",
  "localpath",
  "outputpath",
  "path",
  "privatekey",
  "rawerror",
  "rawlogs",
  "secret",
  "secretaccesskey",
  "sessiontoken",
  "serviceid",
  "stack",
  "stderr",
  "storagekey",
  "stdout",
  "token",
]);

const SAFE_PATH_KEYS = new Set(["latestpath", "relativepath", "reportpath"]);
const SAFE_SENSITIVE_STATUS_KEYS = new Set([
  "activesignedtokens",
  "artifactsdownloaded",
  "authstarted",
  "branchprotectionmutation",
  "credentialconfigured",
  "credentialsconfigured",
  "credentialsetconfigured",
  "deploycredentialconfigured",
  "deploytokenconfigured",
  "credentialrefs",
  "githubenvironmentsecrets",
  "logsdownloaded",
  "networkcalls",
  "operatortokenconfigured",
  "providercredentialconfigured",
  "rawartifactsrequired",
  "rawlogsrequired",
  "remotemutation",
  "repositorymutation",
  "rulesetmutation",
  "secretsincluded",
  "serviceidconfigured",
  "sessioncredentialconfigured",
  "defaultmoderequirestoken",
  "tokensrequested",
]);
const UNSAFE_KEY_FAMILY_RE =
  /(?:authorization|bearer|clientsecret|cookie|credential|privatekey|refresh|sessiontoken|signature|storagekey|accesstoken|accesstokenid|accesskey|apikey|deploytoken|secret|token|rawlogs|rawerror|stderr|stdout|stack|outputpath|filepath|localpath|fullpath|absolutepath|password)/i;
const INTERNAL_ARTIFACT_DOWNLOAD_PATH = "/api/artifacts/download";

function keyPath(parent, key) {
  return parent ? `${parent}.${key}` : String(key);
}

function isUnsafeKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SAFE_PATH_KEYS.has(normalized)) return false;
  if (SAFE_SENSITIVE_STATUS_KEYS.has(normalized)) return false;
  return UNSAFE_KEYS.has(normalized) || UNSAFE_KEY_FAMILY_RE.test(normalized);
}

function valueLeak(value, options = {}) {
  const text = String(value || "");
  if (!options.allowSignedDownloadToken && SIGNED_DOWNLOAD_TOKEN_RE.test(text)) {
    return { code: "SIGNED_DOWNLOAD_TOKEN" };
  }
  const queryLeak = urlQuerySecretLeak(text);
  if (queryLeak) return queryLeak;
  for (const entry of SENSITIVE_VALUE_PATTERNS) {
    if (entry.pattern.test(text)) return { code: entry.code };
  }
  return null;
}

function urlQuerySecretLeak(text) {
  const candidates = String(text || "").match(URL_WITH_QUERY_RE) || [];
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate, "http://shortsengine.local");
    } catch {
      continue;
    }
    const isInternalArtifactDownload =
      parsed.origin === "http://shortsengine.local" &&
      parsed.pathname === INTERNAL_ARTIFACT_DOWNLOAD_PATH;
    for (const key of parsed.searchParams.keys()) {
      const normalizedKey = String(key || "").toLowerCase();
      if (isInternalArtifactDownload && normalizedKey === "token") continue;
      if (SECRET_QUERY_KEYS.has(normalizedKey)) return { code: "URL_SECRET_QUERY" };
    }
  }
  return null;
}

function findSensitiveLeak(value, options = {}, state = {}) {
  const path = state.path || "$";
  const depth = state.depth || 0;
  const seen = state.seen || new WeakSet();
  if (value === null || value === undefined) return null;
  if (depth > 12) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const leak = typeof value === "string" ? valueLeak(value, options) : null;
    return leak ? { ...leak, path } : null;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findSensitiveLeak(value[index], options, { path: `${path}[${index}]`, depth: depth + 1, seen });
      if (leak) return leak;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = keyPath(path, key);
    if (isUnsafeKey(key)) {
      return { code: "UNSAFE_KEY", path: itemPath };
    }
    const leak = findSensitiveLeak(item, options, { path: itemPath, depth: depth + 1, seen });
    if (leak) return leak;
  }
  return null;
}

function hasSensitiveLeak(value, options = {}) {
  return Boolean(findSensitiveLeak(value, options));
}

function safeError(error) {
  if (!error) return null;
  const redacted = redactForLogs(error);
  const code = String(redacted.code || redacted.error?.code || "UNEXPECTED").slice(0, 80);
  const rawMessage = String(redacted.message || redacted.error?.message || "Unexpected demo smoke failure.").slice(0, 240);
  const message = hasSensitiveLeak(rawMessage) ? "Unexpected demo smoke failure." : rawMessage;
  return { code, message };
}

export {
  findSensitiveLeak,
  hasSensitiveLeak,
  safeError,
};
