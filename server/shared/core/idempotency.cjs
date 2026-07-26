const { createHash } = require("node:crypto");

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function idempotencyKey(action, payload) {
  const hash = createHash("sha256").update(stableStringify(payload || {})).digest("hex").slice(0, 20);
  return `${String(action || "action")}-${hash}`;
}

module.exports = {
  idempotencyKey,
  stableStringify,
};
