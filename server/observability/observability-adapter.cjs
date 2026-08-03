const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const OBSERVABILITY_METHODS = Object.freeze([
  "startSpan",
  "increment",
  "observe",
  "recordUsage",
  "jobCost",
  "health",
  "shutdown",
]);

function validateObservabilityAdapter(adapter) {
  for (const method of OBSERVABILITY_METHODS) {
    if (!adapter || typeof adapter[method] !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
  }
  return adapter;
}

module.exports = {
  OBSERVABILITY_METHODS,
  validateObservabilityAdapter,
};
