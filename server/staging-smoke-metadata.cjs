const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const LOCAL_VIDEO_PROOF_SOURCE = "local-video-proof";
const STAGING_FULL_SMOKE_SOURCE = "staging-full-smoke";
const STAGING_FULL_SMOKE_IDEMPOTENCY_PREFIX = "staging_full_";

function normalizeSmokeSource(value) {
  if (value === null || value === undefined || value === "") return null;
  const source = String(value).trim().toLowerCase();
  if (![STAGING_FULL_SMOKE_SOURCE, LOCAL_VIDEO_PROOF_SOURCE].includes(source)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return source;
}

function isLocalVideoProofSource(value) {
  return String(value || "").trim().toLowerCase() === LOCAL_VIDEO_PROOF_SOURCE;
}

function isStagingFullSmokeSource(value) {
  return String(value || "").trim().toLowerCase() === STAGING_FULL_SMOKE_SOURCE;
}

function isStagingFullSmokeIdempotencyKey(value) {
  return String(value || "").startsWith(STAGING_FULL_SMOKE_IDEMPOTENCY_PREFIX);
}

function isStagingFullSmokeJob(job) {
  return Boolean(
    job &&
      isStagingFullSmokeIdempotencyKey(job.idempotencyKey) &&
      (isStagingFullSmokeSource(job.source) || isStagingFullSmokeSource(job.payload && job.payload.source)),
  );
}

module.exports = {
  LOCAL_VIDEO_PROOF_SOURCE,
  STAGING_FULL_SMOKE_IDEMPOTENCY_PREFIX,
  STAGING_FULL_SMOKE_SOURCE,
  isLocalVideoProofSource,
  isStagingFullSmokeIdempotencyKey,
  isStagingFullSmokeJob,
  isStagingFullSmokeSource,
  normalizeSmokeSource,
};
