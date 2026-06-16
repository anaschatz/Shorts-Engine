const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { createLocalYouTubeIngestAdapter } = require("./local-youtube-ingest-adapter.cjs");
const { createMockYouTubeIngestAdapter } = require("./mock-youtube-ingest-adapter.cjs");

function validateYouTubeIngestAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  if (typeof adapter.getMetadata !== "function" || typeof adapter.health !== "function") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  if (adapter.enabled && typeof adapter.ingest !== "function") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  return adapter;
}

function createYouTubeIngestAdapter(options = {}) {
  const config = options.config || CONFIG.youtubeIngest;
  const adapter = config.enabled
    ? createLocalYouTubeIngestAdapter({ ...options, config })
    : createMockYouTubeIngestAdapter(options.mock || {});
  return validateYouTubeIngestAdapter(adapter);
}

module.exports = {
  createYouTubeIngestAdapter,
  validateYouTubeIngestAdapter,
};
