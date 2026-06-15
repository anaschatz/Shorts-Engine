const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const STAGING_FULL_SMOKE_SOURCE = "staging-full-smoke";
const STAGING_FULL_SMOKE_IDEMPOTENCY_PREFIX = "staging_full_";

function normalizeSmokeSource(value) {
  if (value === null || value === undefined || value === "") return null;
  const source = String(value).trim().toLowerCase();
  if (source !== STAGING_FULL_SMOKE_SOURCE) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return source;
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
  STAGING_FULL_SMOKE_IDEMPOTENCY_PREFIX,
  STAGING_FULL_SMOKE_SOURCE,
  isStagingFullSmokeIdempotencyKey,
  isStagingFullSmokeJob,
  isStagingFullSmokeSource,
  normalizeSmokeSource,
};
