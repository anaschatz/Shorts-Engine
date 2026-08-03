const { createHash, randomUUID } = require("node:crypto");
const { validateObservabilityAdapter } = require("./observability-adapter.cjs");

const LABEL_VALUE = /^[a-z][a-z0-9_-]{0,39}$/;

function boundedLabels(labels = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(labels || {})) {
    const safeKey = String(key || "").trim().toLowerCase();
    const safeValue = String(value || "").trim().toLowerCase();
    if (!LABEL_VALUE.test(safeKey) || !LABEL_VALUE.test(safeValue)) continue;
    normalized[safeKey] = safeValue;
  }
  return Object.freeze(normalized);
}

function metricKey(name, labels) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return `${name}:${entries.map(([key, value]) => `${key}=${value}`).join(",")}`;
}

class MemoryObservabilityAdapter {
  constructor(options = {}) {
    this.maxSeries = Math.max(10, Math.min(5000, Number(options.maxSeries || 500)));
    this.maxUsageEvents = Math.max(10, Math.min(10000, Number(options.maxUsageEvents || 1000)));
    this.counters = new Map();
    this.histograms = new Map();
    this.usageEvents = [];
    this.activeSpans = new Map();
    this.closed = false;
    validateObservabilityAdapter(this);
  }

  startSpan(name, attributes = {}) {
    const spanId = randomUUID().replaceAll("-", "").slice(0, 16);
    const traceId = createHash("sha256")
      .update(`${spanId}:${String(name || "operation")}`)
      .digest("hex")
      .slice(0, 32);
    const span = {
      traceId,
      spanId,
      name: String(name || "operation").slice(0, 120),
      attributes: boundedLabels(attributes),
      startedAt: Date.now(),
      ended: false,
      end: (outcome = "success") => {
        if (span.ended) return false;
        span.ended = true;
        span.outcome = LABEL_VALUE.test(String(outcome)) ? String(outcome) : "unknown";
        span.durationMs = Math.max(0, Date.now() - span.startedAt);
        this.activeSpans.delete(spanId);
        return true;
      },
    };
    this.activeSpans.set(spanId, span);
    return span;
  }

  increment(name, labels = {}, value = 1) {
    const normalized = boundedLabels(labels);
    const key = metricKey(String(name || "counter").slice(0, 100), normalized);
    if (!this.counters.has(key) && this.counters.size >= this.maxSeries) return false;
    this.counters.set(key, Number(this.counters.get(key) || 0) + Math.max(0, Number(value || 0)));
    return true;
  }

  observe(name, value, labels = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    const normalized = boundedLabels(labels);
    const key = metricKey(String(name || "histogram").slice(0, 100), normalized);
    if (!this.histograms.has(key) && this.histograms.size >= this.maxSeries) return false;
    const bucket = this.histograms.get(key) || { count: 0, sum: 0, min: number, max: number };
    bucket.count += 1;
    bucket.sum += number;
    bucket.min = Math.min(bucket.min, number);
    bucket.max = Math.max(bucket.max, number);
    this.histograms.set(key, bucket);
    return true;
  }

  recordUsage(event = {}) {
    const count = Number(event.count);
    if (!Number.isFinite(count) || count < 0) return null;
    const record = Object.freeze({
      provider: String(event.provider || "unknown").slice(0, 40).toLowerCase(),
      operation: String(event.operation || "unknown").slice(0, 60).toLowerCase(),
      unit: String(event.unit || "request").slice(0, 40).toLowerCase(),
      count,
      costUsd: Number.isFinite(Number(event.costUsd)) ? Number(event.costUsd) : null,
      estimated: event.estimated !== false,
      recordedAt: new Date().toISOString(),
    });
    this.usageEvents.push(record);
    if (this.usageEvents.length > this.maxUsageEvents) this.usageEvents.shift();
    return record;
  }

  jobCost(filter = {}) {
    const provider = filter.provider ? String(filter.provider).toLowerCase() : null;
    const events = provider
      ? this.usageEvents.filter((event) => event.provider === provider)
      : this.usageEvents;
    const priced = events.filter((event) => Number.isFinite(event.costUsd));
    return {
      totalUsd: priced.length === events.length
        ? priced.reduce((sum, event) => sum + event.costUsd, 0)
        : null,
      pricedEvents: priced.length,
      totalEvents: events.length,
      coverage: events.length ? priced.length / events.length : 1,
    };
  }

  health() {
    return {
      ready: !this.closed,
      adapter: "memory-observability",
      network: false,
      series: this.counters.size + this.histograms.size,
      usageEvents: this.usageEvents.length,
      activeSpans: this.activeSpans.size,
    };
  }

  async shutdown() {
    this.closed = true;
    this.activeSpans.clear();
    return true;
  }
}

function createMemoryObservabilityAdapter(options = {}) {
  return validateObservabilityAdapter(new MemoryObservabilityAdapter(options));
}

module.exports = {
  MemoryObservabilityAdapter,
  boundedLabels,
  createMemoryObservabilityAdapter,
};
