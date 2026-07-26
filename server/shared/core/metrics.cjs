const METRIC_NAMES = Object.freeze(new Set([
  "queue_latency_ms",
  "analysis_duration_ms",
  "render_duration_ms",
  "job_failures_total",
  "job_retries_total",
  "analysis_cache_requests_total",
  "analysis_cache_hits_total",
  "estimated_cost_usd",
]));
const LABEL_VALUES = Object.freeze({
  pipeline: new Set(["clip", "narrated_short", "motivational_source_short", "unknown"]),
  outcome: new Set(["success", "failure", "cancelled", "hit", "miss", "unknown"]),
  stage: new Set(["queue", "analysis", "render", "cache", "unknown"]),
});

function boundedLabels(labels = {}) {
  const safe = {};
  for (const [key, allowed] of Object.entries(LABEL_VALUES)) {
    const value = String(labels[key] || "unknown");
    safe[key] = allowed.has(value) ? value : "unknown";
  }
  return safe;
}

function createMetricsCollector() {
  const values = new Map();

  function record(name, value, labels = {}) {
    if (!METRIC_NAMES.has(name)) throw new Error("Metric name is not allowlisted.");
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error("Metric value is invalid.");
    const safeLabels = boundedLabels(labels);
    const key = `${name}|${safeLabels.pipeline}|${safeLabels.outcome}|${safeLabels.stage}`;
    const current = values.get(key) || { name, labels: safeLabels, count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += number;
    current.max = Math.max(current.max, number);
    values.set(key, current);
    return current;
  }

  return {
    increment(name, labels) {
      return record(name, 1, labels);
    },
    observe(name, value, labels) {
      return record(name, value, labels);
    },
    snapshot() {
      return [...values.values()].map((entry) => ({
        name: entry.name,
        labels: entry.labels,
        count: entry.count,
        sum: Number(entry.sum.toFixed(6)),
        max: Number(entry.max.toFixed(6)),
      }));
    },
    health() {
      return {
        ready: true,
        boundedLabels: true,
        series: values.size,
        allowlistedMetricCount: METRIC_NAMES.size,
      };
    },
  };
}

module.exports = {
  METRIC_NAMES,
  boundedLabels,
  createMetricsCollector,
};
