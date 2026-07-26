const { AppError } = require("../../../errors.cjs");
const { assertAnimationProvider } = require("./provider-contract.cjs");

function createAnimationProviderRegistry(providers = []) {
  const entries = new Map();
  for (const candidate of providers) {
    const provider = assertAnimationProvider(candidate);
    if (entries.has(provider.id)) throw new AppError("ANIMATION_PROVIDER_DUPLICATE", "Animation renderer provider is already registered.", 500);
    entries.set(provider.id, provider);
  }
  return Object.freeze({
    get(id) {
      const provider = entries.get(String(id || ""));
      if (!provider) throw new AppError("ANIMATION_PROVIDER_UNAVAILABLE", "Animation renderer provider is unavailable.", 409);
      return provider;
    },
    list() { return [...entries.keys()].sort(); },
  });
}

module.exports = { createAnimationProviderRegistry };
