const { AppError } = require("../../../errors.cjs");

const PROVIDER_METHODS = Object.freeze(["doctor", "validate", "estimate", "render", "verify"]);

function assertAnimationProvider(provider) {
  if (!provider || typeof provider !== "object" || !/^[a-z][a-z0-9_-]{2,79}$/.test(provider.id || "")) throw new AppError("ANIMATION_PROVIDER_INVALID", "Animation renderer provider is invalid.", 500);
  for (const method of PROVIDER_METHODS) if (typeof provider[method] !== "function") throw new AppError("ANIMATION_PROVIDER_INVALID", "Animation renderer provider is invalid.", 500, { method });
  return provider;
}

module.exports = { PROVIDER_METHODS, assertAnimationProvider };
