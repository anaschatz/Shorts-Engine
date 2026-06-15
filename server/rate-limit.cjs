function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.floor(number));
}

function normalizeClientKey(value) {
  const key = String(value || "anonymous")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return key || "anonymous";
}

function createRateLimiter(options = {}) {
  const limit = normalizePositiveInteger(options.limit, 60);
  const windowMs = normalizePositiveInteger(options.windowMs, 60 * 1000);
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const buckets = new Map();

  function prune(nowMs) {
    for (const [key, bucket] of buckets.entries()) {
      if (!bucket || bucket.resetAtMs <= nowMs) buckets.delete(key);
    }
  }

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  function check(clientKey = "anonymous") {
    const currentTime = nowMs();
    const key = normalizeClientKey(clientKey);
    prune(currentTime);
    const current = buckets.get(key);
    if (!current || current.resetAtMs <= currentTime) {
      buckets.set(key, { count: 1, resetAtMs: currentTime + windowMs });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  function reset(clientKey) {
    if (clientKey === undefined) {
      buckets.clear();
      return;
    }
    buckets.delete(normalizeClientKey(clientKey));
  }

  function snapshot() {
    prune(nowMs());
    return {
      limit,
      windowMs,
      activeKeys: buckets.size,
    };
  }

  return { check, reset, snapshot };
}

module.exports = {
  createRateLimiter,
};
