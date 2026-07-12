const { randomUUID } = require("node:crypto");

const SAFE_MESSAGES = Object.freeze({
  AI_OUTPUT_INVALID: "The AI output did not pass validation.",
  ANALYSIS_FAILED: "The video analysis failed.",
  ADAPTER_CONTRACT_INVALID: "A storage or persistence adapter is not configured correctly.",
  ARTIFACT_DELETE_FORBIDDEN: "This artifact cannot be deleted by this operation.",
  ARTIFACT_KEY_INVALID: "The artifact storage key is invalid.",
  ARTIFACT_NOT_FOUND: "The requested artifact was not found.",
  ARTIFACT_PATH_MISMATCH: "The artifact path does not match its storage key.",
  ARTIFACT_TOKEN_INVALID: "The artifact download token is invalid or expired.",
  ARTIFACT_TYPE_INVALID: "The artifact type is not supported.",
  AUTH_CONFIG_INVALID: "The authentication configuration is invalid.",
  AUTH_CONFIG_MISSING: "Authentication is not configured for protected routes.",
  AUTH_REQUIRED: "Authentication is required for this operation.",
  BAD_JSON: "Invalid JSON request body.",
  CANCEL_NOT_SUPPORTED: "This job cannot be cancelled anymore.",
  CLOUD_STORAGE_FAILED: "The cloud storage operation failed.",
  DB_MIGRATION_FAILED: "The database schema is not ready.",
  DB_TRANSACTION_FAILED: "The database transaction failed.",
  EXPORT_NOT_FOUND: "The requested export was not found.",
  FFMPEG_MISSING: "FFmpeg is not available on this machine.",
  FFPROBE_MISSING: "FFprobe is not available on this machine.",
  FILE_NAME_UNSAFE: "The uploaded filename is not safe.",
  FILE_SIGNATURE_MISMATCH: "The uploaded file content does not match its declared type.",
  FILE_SIGNATURE_UNSUPPORTED: "The uploaded file is not a supported video container.",
  FILE_TOO_LARGE: "The uploaded file is too large.",
  FILE_TOO_SMALL: "The uploaded file is empty or unreadable.",
  FILE_TYPE_UNSUPPORTED: "Only MP4, MOV, and WEBM videos are supported.",
  FORBIDDEN: "You do not have access to this resource.",
  JOB_CANCELLED: "The job was cancelled.",
  JOB_LEASE_INVALID: "The job lease is not active for this worker.",
  JOB_NOT_FOUND: "The requested job was not found.",
  JOB_RETRY_SCHEDULED: "The job was recovered and queued for retry.",
  JOB_STATE_INVALID: "The job moved through an invalid state transition.",
  JOB_STALE: "The job did not finish before the worker stopped.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  MISSING_UPLOAD: "No video file was uploaded.",
  NARRATION_APPROVAL_MISMATCH: "Narration does not match the approved draft.",
  NARRATION_ALIGNMENT_FAILED: "Narration alignment failed validation.",
  NARRATION_ALIGNMENT_REQUIRED: "Upload narration before requesting alignment.",
  NARRATION_ALIGNMENT_STALE: "Narration alignment references are stale.",
  NARRATION_ALIGNER_UNAVAILABLE: "The local narration aligner is unavailable.",
  NARRATION_AUDIO_UNSUPPORTED: "Narration audio must be a supported 48 kHz PCM WAV.",
  NARRATION_DURATION_INVALID: "Narration duration must be greater than one second and no longer than 120 seconds.",
  NARRATION_REVISION_STALE: "The narrated project revision has changed.",
  NARRATION_RIGHTS_REQUIRED: "Commercial narration rights and consent must be declared.",
  NARRATION_SCRIPT_MISMATCH: "Narration does not exactly match the approved script.",
  NARRATION_TIMING_INVALID: "Narration word timings are invalid.",
  CAPTION_ALIGNMENT_REQUIRED: "Exact narration alignment is required for captions.",
  CAPTION_CONTRACT_INVALID: "Caption data failed validation.",
  CAPTION_SAFE_ZONE_INVALID: "Captions do not fit the approved safe zone.",
  CAPTION_FONT_UNAVAILABLE: "The approved local caption font is unavailable.",
  ASS_GENERATION_FAILED: "Caption rendering data could not be generated.",
  AUDIO_NORMALIZATION_FAILED: "Narration loudness normalization failed.",
  AUDIO_DURATION_MISMATCH: "Narration and timeline durations do not match.",
  NARRATION_AUDIO_STALE: "Narration audio references are stale.",
  NARRATED_COMPOSITION_FAILED: "Narrated preview composition failed.",
  QA_REQUIRED: "A passing technical QA report is required.",
  QA_EXECUTION_FAILED: "Technical QA could not be completed.",
  QA_REPORT_INVALID: "The technical QA report is invalid.",
  QA_BINDING_STALE: "Technical QA references are stale.",
  QA_BLOCKED: "Technical QA blocked this output.",
  CONTENT_QA_FAILED: "Content integrity QA failed.",
  RIGHTS_QA_FAILED: "Rights integrity QA failed.",
  AUDIO_QA_FAILED: "Narration audio QA failed.",
  CAPTION_QA_FAILED: "Caption QA failed.",
  TIMELINE_QA_FAILED: "Timeline QA failed.",
  RENDERED_VIDEO_QA_FAILED: "Rendered video QA failed.",
  FINAL_EXPORT_BLOCKED: "Final export is blocked by technical QA.",
  CONTACT_SHEET_GENERATION_FAILED: "The technical contact sheet could not be generated.",
  CONTACT_SHEET_INVALID: "The technical contact sheet is invalid.",
  RIGHTS_MANIFEST_INVALID: "The rights manifest is invalid.",
  PROVENANCE_REPORT_INVALID: "The provenance report is invalid.",
  EXPORT_METADATA_INVALID: "The export metadata is invalid.",
  EVIDENCE_PACKAGE_INCOMPLETE: "The technical evidence package is incomplete.",
  EVIDENCE_PACKAGE_BINDING_STALE: "The technical evidence package references are stale.",
  EVIDENCE_PACKAGE_HASH_MISMATCH: "The technical evidence package hashes do not match.",
  TECHNICAL_EXPORT_BLOCKED: "The technical export is blocked by its evidence package.",
  REVISION_EXPECTATION_STALE: "The expected project revision is stale.",
  REVISION_NO_CHANGES: "The revision does not contain any changes.",
  REVISION_CHANGE_TYPE_MISMATCH: "The requested revision change type does not match the content changes.",
  REVISION_REQUEST_CONFLICT: "The revision request conflicts with an earlier request.",
  INVALIDATION_REPORT_INVALID: "The revision invalidation report is invalid.",
  INVALIDATION_STATE_INVALID: "The project invalidation state is invalid.",
  NARRATION_REUSE_NOT_ALLOWED: "Narration cannot be reused for this revision.",
  NARRATION_REBIND_FAILED: "Narration could not be rebound to the new revision.",
  CONTENT_APPROVAL_CONFLICT: "The content approval conflicts with the active approval.",
  CONTENT_APPROVAL_STATE_INVALID: "The content approval state is invalid.",
  ACTIVE_APPROVAL_REQUIRED: "An active content approval is required.",
  PILOT_REPORT_INVALID: "The Dark Curiosity pilot report is invalid.",
  PILOT_STATE_INVALID: "The Dark Curiosity pilot state transition is invalid.",
  PILOT_READINESS_BLOCKED: "The Dark Curiosity pilot is blocked by environment readiness.",
  PILOT_FIXTURE_UNSAFE: "The pilot fixture path is not allowlisted.",
  PILOT_OUTPUT_UNSAFE: "The pilot report output path is not allowlisted.",
  PILOT_CHECKPOINT_INVALID: "The pilot checkpoint is invalid or stale.",
  PUBLISH_APPROVAL_REQUIRED: "A current publish approval is required.",
  PUBLISH_APPROVAL_INVALID: "The publish approval is invalid.",
  PUBLISH_APPROVAL_CONFLICT: "The publish approval conflicts with an earlier request.",
  PUBLISH_APPROVAL_STALE: "The publish approval is stale.",
  PUBLISH_GUARD_BLOCKED: "The technical final did not pass the publish guard.",
  PUBLISH_WARNING_INVALID: "A warning acknowledgement is invalid.",
  RELEASE_TOKEN_INVALID: "The release token is invalid.",
  RELEASE_TOKEN_EXPIRED: "The release token has expired.",
  RELEASE_TOKEN_REVOKED: "The release token was revoked.",
  RELEASE_TOKEN_OUTPUT_MISMATCH: "The release token does not match this output.",
  RELEASE_ELIGIBILITY_STALE: "The release eligibility is stale.",
  FINAL_DOWNLOAD_BLOCKED: "The final download is blocked.",
  NARRATION_WAV_INVALID: "The narration WAV file is invalid.",
  NO_VALID_GOALS_FOUND: "No valid goals were found with enough evidence for this render.",
  OUTBOX_EVENT_NOT_FOUND: "The approval outbox event was not found.",
  OUTBOX_HANDLER_INVALID: "The approval outbox handler returned an invalid result.",
  OUTBOX_STATE_INVALID: "The approval outbox event moved through an invalid state transition.",
  PROJECT_NOT_FOUND: "The requested project was not found.",
  RATE_LIMITED: "Too many requests. Please wait and retry.",
  RESOURCE_ID_INVALID: "The requested resource id is invalid.",
  RENDER_FAILED: "The video render failed.",
  ROUTE_NOT_FOUND: "Route not found.",
  STORAGE_PATH_UNSAFE: "The requested file path is outside the configured storage area.",
  SOURCE_CACHE_CHECKSUM_MISMATCH: "The approved source cache file checksum did not match.",
  SOURCE_CACHE_FILE_INVALID: "The approved source cache file did not pass validation.",
  SOURCE_CACHE_MISS: "No approved source cache file was found for this YouTube video.",
  TRANSCRIPTION_FAILED: "The transcription provider failed.",
  TRANSCRIPTION_TIMEOUT: "The transcription provider timed out.",
  UPLOAD_FIELD_INVALID: "The upload form contains an unsupported field.",
  UPLOAD_NOT_FOUND: "The requested upload was not found.",
  VIDEO_DURATION_INVALID: "Could not read a reliable video duration.",
  VIDEO_OUTPUT_QA_FAILED: "The generated video plan did not cover the required valid goals.",
  VIDEO_TOO_LONG: "The video is longer than the 30 minute limit.",
  VIDEO_TOO_SHORT: "The video is too short to process.",
  VALIDATION_ERROR: "The request did not pass validation.",
  YOUTUBE_DURATION_TOO_LONG: "The YouTube video is longer than the configured duration limit.",
  YOUTUBE_AGE_RESTRICTED: "This YouTube video needs age-gated or authorized access before ingest.",
  YOUTUBE_AUTH_REQUIRED: "This YouTube video requires authorized access before ingest.",
  YOUTUBE_BOT_CHECK_REQUIRED: "YouTube blocked this download with an anti-bot check.",
  YOUTUBE_COOKIES_REQUIRED: "This YouTube video requires an authorized browser/cookie import flow.",
  YOUTUBE_DOWNLOAD_FAILED: "The YouTube ingest download failed safely.",
  YOUTUBE_DOWNLOAD_INCOMPLETE: "The YouTube downloader produced partial progress but did not finish a valid MP4.",
  YOUTUBE_NO_PROGRESS_TIMEOUT: "The YouTube ingest download stopped making progress.",
  YOUTUBE_DOWNLOAD_TIMEOUT: "The YouTube ingest download timed out.",
  YOUTUBE_DOWNLOADER_MISSING: "The YouTube downloader is not available.",
  YOUTUBE_FORMAT_UNAVAILABLE: "The requested YouTube media format is not available.",
  YOUTUBE_GEO_RESTRICTED: "This YouTube video is not available from this environment.",
  YOUTUBE_INGEST_NOT_ENABLED: "YouTube ingest is not enabled for rendering yet.",
  YOUTUBE_LIVE_UNSUPPORTED: "YouTube live streams are not supported.",
  YOUTUBE_OUTPUT_INVALID: "The YouTube downloader did not produce a valid media output.",
  YOUTUBE_PLAYLIST_UNSUPPORTED: "YouTube playlists are not supported.",
  YOUTUBE_RATE_LIMITED: "YouTube rate-limited this ingest request. Retry later.",
  YOUTUBE_RIGHTS_REQUIRED: "Confirm that you have rights to use this YouTube video.",
  YOUTUBE_URL_INVALID: "Enter a supported YouTube video or Shorts URL.",
  YOUTUBE_VIDEO_PRIVATE: "This YouTube video is private.",
  YOUTUBE_VIDEO_UNAVAILABLE: "This YouTube video is unavailable.",
  UNEXPECTED: "Something went wrong. Please retry.",
});

const SAFE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
const URL_SECRET_QUERY_PARAM_RE =
  /([?&](?:access_token|api_key|auth_token|client_secret|id_token|oauth_token|refresh_token|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-credential|x-goog-security-token|x-goog-signature)=)[^&\s"']+/gi;
const SAFE_LOG_STATUS_KEYS = new Set([
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
  "providercredentialconfigured",
  "rawartifactsrequired",
  "rawlogsrequired",
  "remotemutation",
  "repositorymutation",
  "rulesetmutation",
  "secretsincluded",
  "serviceidconfigured",
  "sessioncredentialconfigured",
  "tokensrequested",
]);
const LOG_REDACT_KEY_RE =
  /(?:authorization|bearer|clientsecret|cookie|credential|privatekey|refresh|sessiontoken|signature|storagekey|accesstoken|accesskey|apikey|deploytoken|secret|token|rawlogs|rawerror|stderr|stdout|stack|outputpath|filepath|localpath|fullpath|absolutepath|password)/i;

class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.UNEXPECTED);
    this.name = "AppError";
    this.code = code || "UNEXPECTED";
    this.status = status;
    this.userMessage = message || SAFE_MESSAGES[this.code] || SAFE_MESSAGES.UNEXPECTED;
    this.details = details;
  }
}

function ok(data) {
  return { ok: true, data: data ?? null, error: null };
}

const PUBLIC_ERROR_DETAIL_KEYS = new Set([
  "authorizedImportRequired",
  "attempts",
  "attemptsConfigured",
  "cleanupSucceeded",
  "cacheChecked",
  "cacheFailureCode",
  "cacheHit",
  "cacheValidated",
  "checksumSha256",
  "bytesStillMovingAtTimeout",
  "continueAttempted",
  "continueEnabled",
  "downloaderConfigured",
  "downloaderFallbackUsed",
  "downloadedOutputReady",
  "elapsedMs",
  "fallbackFormatSelector",
  "fallbackUsed",
  "fileValidation",
  "failureReason",
  "formatSelector",
  "heartbeatIntervalMs",
  "ingestRisk",
  "lastProgressAgeMs",
  "metadataPreflightDurationSeconds",
  "metadataPreflightStatus",
  "metadataStatus",
  "noProgressTimeoutMs",
  "nextAction",
  "failedGateCodes",
  "blockingFailedCount",
  "failedArtifactCode",
  "expectedRevision",
  "currentRevision",
  "changeType",
  "failedDependencyClass",
  "blockerCodes",
  "warningCodes",
  "expiresAt",
  "partialCleanupRemovedCount",
  "partialCleanupSucceeded",
  "phase",
  "playerClient",
  "progressBytesObserved",
  "progressEventCount",
  "progressHeartbeatCount",
  "resumableStateEnabled",
  "resumeStateRetained",
  "retryable",
  "safeMessage",
  "sourceAcquisitionStatus",
  "sourceAcquisitionStrategy",
  "stallClassification",
  "step",
  "substep",
  "timeoutClassification",
  "timeoutMs",
]);
const PUBLIC_ERROR_NUMERIC_DETAIL_KEYS = new Set([
  "attempts",
  "attemptsConfigured",
  "elapsedMs",
  "heartbeatIntervalMs",
  "lastProgressAgeMs",
  "metadataPreflightDurationSeconds",
  "noProgressTimeoutMs",
  "partialCleanupRemovedCount",
  "progressBytesObserved",
  "progressEventCount",
  "progressHeartbeatCount",
  "timeoutMs",
]);
const PUBLIC_ERROR_FORMAT_DETAIL_KEYS = new Set([
  "fallbackFormatSelector",
  "formatSelector",
]);
const PUBLIC_ERROR_HASH_DETAIL_KEYS = new Set([
  "checksumSha256",
]);
const PUBLIC_ERROR_CODE_DETAIL_KEYS = new Set([
  "cacheFailureCode",
  "timeoutClassification",
]);
const PUBLIC_ERROR_TEXT_DETAIL_KEYS = new Set([
  "safeMessage",
]);
const PUBLIC_ERROR_CODE_LIST_DETAIL_KEYS = new Set(["blockerCodes", "warningCodes"]);
const PUBLIC_ERROR_ISO_DETAIL_KEYS = new Set(["expiresAt"]);

function publicErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const safeDetails = {};
  for (const key of PUBLIC_ERROR_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = details[key];
    if (PUBLIC_ERROR_NUMERIC_DETAIL_KEYS.has(key) && Number.isFinite(Number(value))) {
      safeDetails[key] = Number(value);
    } else if (
      PUBLIC_ERROR_FORMAT_DETAIL_KEYS.has(key) &&
      typeof value === "string" &&
      /^[A-Za-z0-9*+/\[\]=._:,-]{1,180}$/.test(value)
    ) {
      safeDetails[key] = value;
    } else if (
      PUBLIC_ERROR_HASH_DETAIL_KEYS.has(key) &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/.test(value)
    ) {
      safeDetails[key] = value;
    } else if (
      PUBLIC_ERROR_CODE_DETAIL_KEYS.has(key) &&
      typeof value === "string" &&
      /^[A-Z0-9_]{1,80}$/.test(value)
    ) {
      safeDetails[key] = value;
    } else if (
      PUBLIC_ERROR_TEXT_DETAIL_KEYS.has(key) &&
      typeof value === "string"
    ) {
      const safeText = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      safeDetails[key] = /\/Users\/|\/private\/|Bearer\s+|cookie|secret|stderr|stdout|token/i.test(safeText)
        ? SAFE_MESSAGES.UNEXPECTED
        : safeText;
    } else if (PUBLIC_ERROR_CODE_LIST_DETAIL_KEYS.has(key) && Array.isArray(value)) {
      const codes = value.slice(0, 12).filter((item) => typeof item === "string" && /^[A-Z0-9_]{1,80}$/.test(item));
      if (codes.length === value.length) safeDetails[key] = codes;
    } else if (PUBLIC_ERROR_ISO_DETAIL_KEYS.has(key) && typeof value === "string" && Number.isFinite(Date.parse(value))) {
      safeDetails[key] = value;
    } else if (typeof value === "boolean") {
      safeDetails[key] = value;
    } else if (typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value)) {
      safeDetails[key] = value;
    }
  }
  return Object.keys(safeDetails).length ? safeDetails : null;
}

function fail(code, message, details = null) {
  const safeCode = code || "UNEXPECTED";
  const safeDetails = publicErrorDetails(details);
  return {
    ok: false,
    data: null,
    error: {
      code: safeCode,
      message: message || SAFE_MESSAGES[safeCode] || SAFE_MESSAGES.UNEXPECTED,
      ...(safeDetails || {}),
    },
  };
}

function toAppError(error, fallbackCode = "UNEXPECTED", fallbackStatus = 500) {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, SAFE_MESSAGES[fallbackCode], fallbackStatus);
}

function redactForLogs(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
      .replace(/OPENAI_API_KEY=[^\s]+/g, "OPENAI_API_KEY=[redacted]")
      .replace(
        /\b((?:MATCHCUTS|SHORTSENGINE|YOUTUBE|YT_DLP|GOOGLE)[A-Z0-9_]*(?:SECRET|TOKEN|ACCESS_KEY|API_KEY|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|SERVICE_ID)[A-Z0-9_]*)(\s*[:=]\s*|\s+)[^\s"']+/gi,
        "$1$2[redacted]",
      )
      .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[redacted]")
      .replace(/(?:AKIA|ASIA)[A-Z0-9]{12,}/g, "[redacted-access-key]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted-github-token]")
      .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[redacted-gitlab-token]")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, "[redacted-slack-token]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
      .replace(/\b(VISITOR_INFO1_LIVE|LOGIN_INFO|SAPISID|HSID|SSID|APISID|SID)=[^\s"']+/gi, "$1=[redacted]")
      .replace(/\bsrv-[A-Za-z0-9_-]{6,80}\b/g, "srv-[redacted]")
      .replace(/X-Amz-Signature=[A-Fa-f0-9]+/g, "X-Amz-Signature=[redacted]")
      .replace(/X-Amz-Credential=[^&\s]+/g, "X-Amz-Credential=[redacted]")
      .replace(URL_SECRET_QUERY_PARAM_RE, "$1[redacted]")
      .replace(/adt_[A-Fa-f0-9-]{36}_[A-Fa-f0-9]{32}/g, "adt_[redacted]")
      .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
      .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
      .replace(/\/(?:tmp|var\/folders)\/[^\s"']+/g, "[redacted-path]")
      .slice(0, 1600);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(redactForLogs);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => {
          const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          if (!SAFE_LOG_STATUS_KEYS.has(normalizedKey) && LOG_REDACT_KEY_RE.test(normalizedKey)) {
            return [key, "[redacted]"];
          }
          return [key, redactForLogs(item)];
        }),
    );
  }
  return value;
}

function requestId() {
  return `req_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...SAFE_RESPONSE_HEADERS,
    ...headers,
  });
  res.end(body);
}

function sendOk(res, data, status = 200, headers = {}) {
  sendJson(res, status, ok(data), headers);
}

function sendError(res, error, context = {}) {
  const appError = toAppError(error);
  console.error(
    JSON.stringify({
      level: "error",
      requestId: context.requestId,
      jobId: context.jobId,
      code: appError.code,
      details: appError.details ? redactForLogs(appError.details) : undefined,
    }),
  );
  sendJson(res, appError.status || 500, fail(appError.code, appError.userMessage, appError.details));
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const body = await readRequestBody(req, maxBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError("BAD_JSON", SAFE_MESSAGES.BAD_JSON, 400);
  }
}

module.exports = {
  SAFE_MESSAGES,
  SAFE_RESPONSE_HEADERS,
  AppError,
  ok,
  fail,
  publicErrorDetails,
  toAppError,
  redactForLogs,
  requestId,
  sendJson,
  sendOk,
  sendError,
  readRequestBody,
  readJsonBody,
};
