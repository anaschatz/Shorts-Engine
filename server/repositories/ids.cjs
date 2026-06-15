const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

function validateResourceId(value, prefix) {
  const safe = String(value || "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`).test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function sanitizeText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function jsonClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  jsonClone,
  nowIso,
  sanitizeText,
  validateResourceId,
};
