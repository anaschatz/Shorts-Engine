const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText } = require("../media.cjs");
const {
  generateEvidenceAwareCaptions,
  validateCaptionGenerationResult,
} = require("../caption-generation.cjs");

function createDeterministicCaptionProvider() {
  return {
    providerMode: "deterministic",
    networkCalls: false,
    requiresApiKey: false,
    generateCaptions(input = {}) {
      return generateEvidenceAwareCaptions({ ...input, providerMode: "deterministic" });
    },
  };
}

function createDisabledCaptionProvider({ code = "CAPTION_PROVIDER_DISABLED" } = {}) {
  return {
    providerMode: "disabled",
    networkCalls: false,
    requiresApiKey: false,
    generateCaptions() {
      throw new AppError(code, SAFE_MESSAGES.AI_OUTPUT_INVALID, 503);
    },
  };
}

function safeProviderFailure(error) {
  const code = sanitizeText(error && error.code, 60) || "CAPTION_PROVIDER_FAILED";
  return {
    code,
    phase: "caption_provider",
    retryable: false,
  };
}

function validateProviderResult(result, input, providerMode) {
  return validateCaptionGenerationResult(result, input, { providerMode });
}

function generateCaptionsWithProvider(input = {}, options = {}) {
  const fallbackProvider = options.fallbackProvider || createDeterministicCaptionProvider();
  const provider = options.provider || fallbackProvider;
  const providerMode = sanitizeText(provider.providerMode || "custom", 40) || "custom";
  try {
    if (!provider || typeof provider.generateCaptions !== "function") {
      throw new AppError("CAPTION_PROVIDER_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 503);
    }
    const result = provider.generateCaptions(input);
    return validateProviderResult(result, input, providerMode);
  } catch (error) {
    const failure = safeProviderFailure(error);
    const fallbackResult = fallbackProvider.generateCaptions(input);
    const validatedFallback = validateProviderResult(fallbackResult, input, fallbackProvider.providerMode || "deterministic");
    return {
      ...validatedFallback,
      fallbackUsed: true,
      warnings: [...new Set([`provider_fallback:${failure.code}`, ...validatedFallback.warnings])].slice(0, 6),
    };
  }
}

module.exports = {
  createDeterministicCaptionProvider,
  createDisabledCaptionProvider,
  generateCaptionsWithProvider,
  safeProviderFailure,
};
