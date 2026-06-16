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
  JOB_CANCELLED: "The job was cancelled.",
  JOB_LEASE_INVALID: "The job lease is not active for this worker.",
  JOB_NOT_FOUND: "The requested job was not found.",
  JOB_RETRY_SCHEDULED: "The job was recovered and queued for retry.",
  JOB_STATE_INVALID: "The job moved through an invalid state transition.",
  JOB_STALE: "The job did not finish before the worker stopped.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  MISSING_UPLOAD: "No video file was uploaded.",
  PROJECT_NOT_FOUND: "The requested project was not found.",
  RATE_LIMITED: "Too many requests. Please wait and retry.",
  RESOURCE_ID_INVALID: "The requested resource id is invalid.",
  RENDER_FAILED: "The video render failed.",
  ROUTE_NOT_FOUND: "Route not found.",
  STORAGE_PATH_UNSAFE: "The requested file path is outside the configured storage area.",
  TRANSCRIPTION_FAILED: "The transcription provider failed.",
  TRANSCRIPTION_TIMEOUT: "The transcription provider timed out.",
  UPLOAD_FIELD_INVALID: "The upload form contains an unsupported field.",
  UPLOAD_NOT_FOUND: "The requested upload was not found.",
  VIDEO_DURATION_INVALID: "Could not read a reliable video duration.",
  VIDEO_TOO_LONG: "The video is longer than the 30 minute limit.",
  VIDEO_TOO_SHORT: "The video is too short to process.",
  VALIDATION_ERROR: "The request did not pass validation.",
  YOUTUBE_DURATION_TOO_LONG: "The YouTube video is longer than the configured duration limit.",
  YOUTUBE_DOWNLOAD_FAILED: "The YouTube ingest download failed safely.",
  YOUTUBE_DOWNLOAD_TIMEOUT: "The YouTube ingest download timed out.",
  YOUTUBE_DOWNLOADER_MISSING: "The YouTube downloader is not available.",
  YOUTUBE_INGEST_NOT_ENABLED: "YouTube ingest is not enabled for rendering yet.",
  YOUTUBE_LIVE_UNSUPPORTED: "YouTube live streams are not supported.",
  YOUTUBE_PLAYLIST_UNSUPPORTED: "YouTube playlists are not supported.",
  YOUTUBE_RIGHTS_REQUIRED: "Confirm that you have rights to use this YouTube video.",
  YOUTUBE_URL_INVALID: "Enter a supported YouTube video or Shorts URL.",
  UNEXPECTED: "Something went wrong. Please retry.",
});

const SAFE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

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

function fail(code, message) {
  const safeCode = code || "UNEXPECTED";
  return {
    ok: false,
    data: null,
    error: {
      code: safeCode,
      message: message || SAFE_MESSAGES[safeCode] || SAFE_MESSAGES.UNEXPECTED,
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
          if (/token|secret|accessKey|apiKey|serviceId|credential|authorization|signature|storageKey|outputPath|filePath|path$/i.test(key)) {
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
  sendJson(res, appError.status || 500, fail(appError.code, appError.userMessage));
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
  toAppError,
  redactForLogs,
  requestId,
  sendJson,
  sendOk,
  sendError,
  readRequestBody,
  readJsonBody,
};
