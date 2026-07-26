const { createHash } = require("node:crypto");

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function analysisCacheKey(input = {}) {
  const sourceChecksum = String(input.sourceChecksum || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceChecksum)) throw new Error("Analysis cache source checksum is invalid.");
  const pipelineVersion = String(input.pipelineVersion || "");
  const evidenceContractVersion = String(input.evidenceContractVersion || "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(pipelineVersion) || !/^[A-Za-z0-9._-]{1,80}$/.test(evidenceContractVersion)) {
    throw new Error("Analysis cache version is invalid.");
  }
  const configurationHash = digest(stableStringify(input.configuration || {}));
  return {
    key: digest(`${sourceChecksum}:${pipelineVersion}:${evidenceContractVersion}:${configurationHash}`),
    sourceChecksum,
    pipelineVersion,
    evidenceContractVersion,
    configurationHash,
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createAnalysisCache(options = {}) {
  const records = options.records || new Map();
  const ttlMs = Math.max(1000, Math.min(Number(options.ttlMs || 24 * 60 * 60 * 1000), 30 * 24 * 60 * 60 * 1000));
  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries || 500), 10_000));
  const metrics = options.metrics || null;

  function prune(nowMs = Date.now()) {
    for (const [key, record] of records) {
      if (!record || record.expiresAtMs <= nowMs) records.delete(key);
    }
    while (records.size > maxEntries) records.delete(records.keys().next().value);
    return records.size;
  }

  function get(descriptor, nowMs = Date.now()) {
    const identity = analysisCacheKey(descriptor);
    prune(nowMs);
    const record = records.get(identity.key);
    if (metrics) metrics.increment("analysis_cache_requests_total", { pipeline: "clip", outcome: record ? "hit" : "miss", stage: "cache" });
    if (!record) return null;
    if (metrics) metrics.increment("analysis_cache_hits_total", { pipeline: "clip", outcome: "hit", stage: "cache" });
    return clone(record.value);
  }

  function put(descriptor, value, nowMs = Date.now()) {
    const identity = analysisCacheKey(descriptor);
    records.set(identity.key, {
      ...identity,
      value: clone(value),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    });
    prune(nowMs);
    return identity.key;
  }

  return {
    get,
    put,
    prune,
    invalidate(descriptor) {
      return records.delete(analysisCacheKey(descriptor).key);
    },
    health() {
      prune();
      return {
        ready: true,
        bounded: true,
        entries: records.size,
        maxEntries,
        ttlMs,
      };
    },
  };
}

module.exports = {
  analysisCacheKey,
  createAnalysisCache,
};
