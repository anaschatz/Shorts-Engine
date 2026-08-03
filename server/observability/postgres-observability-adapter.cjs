const { randomUUID } = require("node:crypto");
const {
  validateObservabilityAdapter,
} = require("./observability-adapter.cjs");

const METRIC_NAMES = new Set([
  "render_success_total",
  "render_failure_total",
  "queue_depth",
  "queue_wait_ms",
  "processing_time_ms",
  "retry_total",
  "dead_letter_total",
  "cache_hit_total",
  "cache_miss_total",
  "completed_video_cost_usd",
  "failed_video_cost_usd",
  "pipeline_failure_total",
  "quota_rejection_total",
]);
const LABEL_KEYS = new Set([
  "pipeline",
  "outcome",
  "stage",
  "provider",
  "operation",
  "category",
]);
const LABEL_VALUE = /^[a-z][a-z0-9_-]{0,39}$/;

function boundedLabels(labels = {}) {
  const output = {};
  for (const [key, value] of Object.entries(labels || {})) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const normalizedValue = String(value || "").trim().toLowerCase();
    if (!LABEL_KEYS.has(normalizedKey) || !LABEL_VALUE.test(normalizedValue)) continue;
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

class PostgresObservabilityAdapter {
  constructor(options = {}) {
    this.persistence = options.persistence;
    this.clock = options.clock || { now: () => Date.now() };
    this.pending = new Set();
    this.closed = false;
    validateObservabilityAdapter(this);
  }

  persist(promise) {
    const pending = Promise.resolve(promise).catch(() => false);
    this.pending.add(pending);
    pending.finally(() => this.pending.delete(pending));
    return pending;
  }

  startSpan(name, attributes = {}) {
    const startedAt = this.clock.now();
    const traceId = randomUUID().replaceAll("-", "");
    let ended = false;
    return {
      traceId,
      spanId: traceId.slice(0, 16),
      name: String(name || "operation").slice(0, 120),
      attributes: boundedLabels(attributes),
      end: (outcome = "success") => {
        if (ended) return false;
        ended = true;
        this.observe("processing_time_ms", Math.max(0, this.clock.now() - startedAt), {
          ...attributes,
          outcome,
        });
        return true;
      },
    };
  }

  recordMetric(name, kind, value, labels) {
    const metricName = String(name || "");
    const number = Number(value);
    if (
      this.closed
      || !METRIC_NAMES.has(metricName)
      || !Number.isFinite(number)
      || number < 0
    ) return false;
    this.persist(this.persistence.recordMetric({
      metricName,
      kind,
      value: number,
      labels: boundedLabels(labels),
    }));
    return true;
  }

  increment(name, labels = {}, value = 1) {
    return this.recordMetric(name, "counter", value, labels);
  }

  observe(name, value, labels = {}) {
    return this.recordMetric(name, "histogram", value, labels);
  }

  recordUsage(event = {}) {
    if (this.closed) return null;
    const record = {
      ownerId: event.ownerId || null,
      jobId: event.jobId || null,
      provider: String(event.provider || "unknown").slice(0, 40).toLowerCase(),
      operation: String(event.operation || "unknown").slice(0, 60).toLowerCase(),
      unitType: String(event.unit || event.unitType || "request").slice(0, 40),
      unitCount: Number(event.count || event.unitCount || 0),
      byteCount: Number.isFinite(Number(event.byteCount)) ? Number(event.byteCount) : null,
      durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
      retryCount: Math.max(0, Number(event.retryCount || 0)),
      priceBookVersion: event.priceBookVersion || null,
      providerCostUsd: Number.isFinite(Number(event.costUsd ?? event.providerCostUsd))
        ? Number(event.costUsd ?? event.providerCostUsd)
        : null,
      computeCostUsd: Number.isFinite(Number(event.computeCostUsd))
        ? Number(event.computeCostUsd)
        : null,
      estimated: event.estimated !== false,
      traceId: event.traceId || null,
    };
    if (!Number.isFinite(record.unitCount) || record.unitCount < 0) return null;
    this.persist(this.persistence.recordUsage(record));
    return record;
  }

  async jobCost(filter = {}) {
    if (!filter.jobId) {
      return { totalUsd: null, pricedEvents: 0, totalEvents: 0, coverage: 0 };
    }
    return await this.persistence.getJobCost(String(filter.jobId));
  }

  async health() {
    if (this.closed) {
      return { ready: false, adapter: "postgres-observability", durable: true };
    }
    try {
      const check = typeof this.persistence.readiness === "function"
        ? this.persistence.readiness.bind(this.persistence)
        : this.persistence.health.bind(this.persistence);
      const health = await check();
      return {
        ready: health && health.ready === true,
        adapter: "postgres-observability",
        durable: true,
        pendingWrites: this.pending.size,
      };
    } catch {
      return { ready: false, adapter: "postgres-observability", durable: true };
    }
  }

  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    return true;
  }
}

function createPostgresObservabilityAdapter(options = {}) {
  return validateObservabilityAdapter(new PostgresObservabilityAdapter(options));
}

module.exports = {
  METRIC_NAMES,
  PostgresObservabilityAdapter,
  boundedLabels,
  createPostgresObservabilityAdapter,
};
