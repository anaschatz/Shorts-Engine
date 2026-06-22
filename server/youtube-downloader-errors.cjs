const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const YOUTUBE_FAILURES = Object.freeze({
  YOUTUBE_AUTH_REQUIRED: Object.freeze({
    code: "YOUTUBE_AUTH_REQUIRED",
    status: 403,
    reason: "auth_required",
    metadataStatus: "auth-required",
    ingestRisk: "authorized-import-required",
    nextAction: "try-public-video-or-use-authorized-import",
    retryable: false,
    authorizedImportRequired: true,
  }),
  YOUTUBE_BOT_CHECK_REQUIRED: Object.freeze({
    code: "YOUTUBE_BOT_CHECK_REQUIRED",
    status: 403,
    reason: "bot_check_required",
    metadataStatus: "bot-check-required",
    ingestRisk: "authorized-import-required",
    nextAction: "try-public-video-or-use-authorized-import",
    retryable: false,
    authorizedImportRequired: true,
  }),
  YOUTUBE_COOKIES_REQUIRED: Object.freeze({
    code: "YOUTUBE_COOKIES_REQUIRED",
    status: 403,
    reason: "cookies_required",
    metadataStatus: "cookies-required",
    ingestRisk: "authorized-import-required",
    nextAction: "use-authorized-import-or-upload-mp4",
    retryable: false,
    authorizedImportRequired: true,
  }),
  YOUTUBE_VIDEO_PRIVATE: Object.freeze({
    code: "YOUTUBE_VIDEO_PRIVATE",
    status: 403,
    reason: "video_private",
    metadataStatus: "private",
    ingestRisk: "source-unavailable",
    nextAction: "use-public-video-or-upload-mp4",
    retryable: false,
    authorizedImportRequired: false,
  }),
  YOUTUBE_VIDEO_UNAVAILABLE: Object.freeze({
    code: "YOUTUBE_VIDEO_UNAVAILABLE",
    status: 404,
    reason: "video_unavailable",
    metadataStatus: "unavailable",
    ingestRisk: "source-unavailable",
    nextAction: "check-link-or-use-another-video",
    retryable: false,
    authorizedImportRequired: false,
  }),
  YOUTUBE_GEO_RESTRICTED: Object.freeze({
    code: "YOUTUBE_GEO_RESTRICTED",
    status: 403,
    reason: "geo_restricted",
    metadataStatus: "geo-restricted",
    ingestRisk: "source-unavailable",
    nextAction: "use-accessible-video-or-upload-mp4",
    retryable: false,
    authorizedImportRequired: false,
  }),
  YOUTUBE_AGE_RESTRICTED: Object.freeze({
    code: "YOUTUBE_AGE_RESTRICTED",
    status: 403,
    reason: "age_restricted",
    metadataStatus: "age-restricted",
    ingestRisk: "authorized-import-required",
    nextAction: "use-authorized-import-or-upload-mp4",
    retryable: false,
    authorizedImportRequired: true,
  }),
  YOUTUBE_RATE_LIMITED: Object.freeze({
    code: "YOUTUBE_RATE_LIMITED",
    status: 429,
    reason: "rate_limited",
    metadataStatus: "rate-limited",
    ingestRisk: "retry-later",
    nextAction: "wait-and-retry-or-upload-mp4",
    retryable: true,
    authorizedImportRequired: false,
  }),
  YOUTUBE_DOWNLOAD_TIMEOUT: Object.freeze({
    code: "YOUTUBE_DOWNLOAD_TIMEOUT",
    status: 504,
    reason: "timeout",
    metadataStatus: "timeout",
    ingestRisk: "retry-later",
    nextAction: "retry-ingest-or-upload-mp4",
    retryable: true,
    authorizedImportRequired: false,
  }),
  YOUTUBE_DOWNLOAD_FAILED: Object.freeze({
    code: "YOUTUBE_DOWNLOAD_FAILED",
    status: 502,
    reason: "download_failed",
    metadataStatus: "local-unavailable",
    ingestRisk: "download-failed",
    nextAction: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
    retryable: true,
    authorizedImportRequired: false,
  }),
});

function downloaderOutputText(error) {
  if (!error) return "";
  return [
    error.message,
    error.stderr,
    error.stdout,
    error.output,
  ]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join("\n")
    .slice(0, 12000);
}

function safeFailure(details) {
  return {
    ...details,
    userMessage: SAFE_MESSAGES[details.code] || SAFE_MESSAGES.YOUTUBE_DOWNLOAD_FAILED,
  };
}

function classifyYouTubeDownloaderFailure(error) {
  if (error && (error.code === "ENOENT" || error.code === "EACCES")) {
    return safeFailure({
      code: "YOUTUBE_DOWNLOADER_MISSING",
      status: 503,
      reason: "downloader_unavailable",
      metadataStatus: "downloader-unavailable",
      ingestRisk: "downloader-unavailable",
      nextAction: "install-or-configure-youtube-downloader",
      retryable: false,
      authorizedImportRequired: false,
    });
  }
  if (error && (error.killed || error.signal || error.code === "ETIMEDOUT")) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_DOWNLOAD_TIMEOUT);
  }

  const text = downloaderOutputText(error).toLowerCase();
  const match = (pattern) => pattern.test(text);

  if (match(/\b(private video|this video is private|video private)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_VIDEO_PRIVATE);
  }
  if (match(/\b(geo|country|region).{0,80}\b(restricted|blocked|available)\b/) || match(/\bnot available in your country\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_GEO_RESTRICTED);
  }
  if (match(/\b(age[- ]?restricted|confirm your age|age verification)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_AGE_RESTRICTED);
  }
  if (match(/\b(too many requests|rate limit|rate-limited|http error 429|429)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_RATE_LIMITED);
  }
  if (match(/\b(not a bot|bot check|unusual traffic|automated queries|captcha)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_BOT_CHECK_REQUIRED);
  }
  if (match(/\b(cookies-from-browser|cookies? required|use --cookies|export cookies)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_COOKIES_REQUIRED);
  }
  if (match(/\b(sign in|login required|log in|authentication required|please login)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_AUTH_REQUIRED);
  }
  if (match(/\b(video unavailable|unavailable|removed|does not exist|has been deleted|not found)\b/)) {
    return safeFailure(YOUTUBE_FAILURES.YOUTUBE_VIDEO_UNAVAILABLE);
  }

  return safeFailure(YOUTUBE_FAILURES.YOUTUBE_DOWNLOAD_FAILED);
}

function toSafeYouTubeDownloaderError(error) {
  const failure = classifyYouTubeDownloaderFailure(error);
  return new AppError(failure.code, failure.userMessage, failure.status, {
    reason: failure.reason,
    nextAction: failure.nextAction,
    retryable: failure.retryable,
    authorizedImportRequired: failure.authorizedImportRequired,
    metadataStatus: failure.metadataStatus,
    ingestRisk: failure.ingestRisk,
  });
}

function metadataWarningFromFailure(error) {
  const failure = classifyYouTubeDownloaderFailure(error);
  if (failure.code === "YOUTUBE_DOWNLOAD_FAILED") return null;
  return {
    title: null,
    durationSeconds: null,
    metadataStatus: failure.metadataStatus,
    ingestAvailable: true,
    warningCode: failure.code,
    nextAction: failure.nextAction,
    retryable: failure.retryable,
    authorizedImportRequired: failure.authorizedImportRequired,
    ingestRisk: failure.ingestRisk,
  };
}

module.exports = {
  YOUTUBE_FAILURES,
  classifyYouTubeDownloaderFailure,
  metadataWarningFromFailure,
  toSafeYouTubeDownloaderError,
};
