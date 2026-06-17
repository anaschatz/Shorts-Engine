const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const OUTBOX_HANDLER_RESULTS = Object.freeze(["delivered", "retry", "dead_letter", "skipped"]);

function normalizeHandlerStatus(value) {
  const status = String(value || "delivered").trim().toLowerCase();
  if (!OUTBOX_HANDLER_RESULTS.includes(status)) {
    throw new AppError("OUTBOX_HANDLER_INVALID", SAFE_MESSAGES.OUTBOX_HANDLER_INVALID, 500);
  }
  return status;
}

function normalizeErrorCode(value, fallback = "OUTBOX_HANDLER_FAILED") {
  const code = String(value || fallback).trim().toUpperCase();
  if (!/^[A-Z0-9_:-]{2,80}$/.test(code)) return fallback;
  return code;
}

function normalizeOutboxHandlerResult(result = {}) {
  if (typeof result === "string") {
    return {
      status: normalizeHandlerStatus(result),
      errorCode: null,
    };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AppError("OUTBOX_HANDLER_INVALID", SAFE_MESSAGES.OUTBOX_HANDLER_INVALID, 500);
  }
  const status = normalizeHandlerStatus(result.status || result.result || "delivered");
  return {
    status,
    errorCode: status === "delivered" || status === "skipped" ? null : normalizeErrorCode(result.errorCode),
  };
}

function createNoopOutboxHandler() {
  return {
    name: "noop-audit",
    async handle() {
      return { status: "delivered" };
    },
  };
}

function validateOutboxHandler(handler) {
  if (!handler || typeof handler.handle !== "function") {
    throw new AppError("OUTBOX_HANDLER_INVALID", SAFE_MESSAGES.OUTBOX_HANDLER_INVALID, 500);
  }
  return handler;
}

module.exports = {
  OUTBOX_HANDLER_RESULTS,
  createNoopOutboxHandler,
  normalizeOutboxHandlerResult,
  validateOutboxHandler,
};
