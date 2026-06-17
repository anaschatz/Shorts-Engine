import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDefaultAdapters } = require("../server/adapters/local-persistence-adapter.cjs");
const { createOutboxWorker } = require("../server/outbox-worker.cjs");

function optionValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length);
}

function safeFailure(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "OUTBOX_DRAIN_FAILED",
    message: "Outbox drain failed safely.",
  };
}

function closeAdapter(adapter) {
  if (adapter && typeof adapter.close === "function") adapter.close();
}

function restoreSummary(value) {
  if (value && typeof value === "object") {
    return {
      records: Number(value.records || 0),
      ignored: Number(value.ignored || 0),
    };
  }
  return {
    records: Number(value || 0),
    ignored: 0,
  };
}

function emptySummary() {
  return {
    runId: "outbox_drain_aggregate",
    startedAt: null,
    finishedAt: null,
    claimed: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    skipped: 0,
    failed: 0,
    staleRecovered: 0,
    cancelled: false,
    errors: 0,
    batches: 0,
  };
}

function addSummary(total, next) {
  total.startedAt = total.startedAt || next.startedAt || null;
  total.finishedAt = next.finishedAt || total.finishedAt;
  total.claimed += Number(next.claimed || 0);
  total.delivered += Number(next.delivered || 0);
  total.retried += Number(next.retried || 0);
  total.deadLettered += Number(next.deadLettered || 0);
  total.skipped += Number(next.skipped || 0);
  total.failed += Number(next.failed || 0);
  total.staleRecovered += Number(next.staleRecovered || 0);
  total.errors += Number(next.errors || 0);
  total.cancelled = total.cancelled || Boolean(next.cancelled);
  total.batches += 1;
  return total;
}

try {
  const { persistenceAdapter } = createDefaultAdapters();
  try {
    const restored = persistenceAdapter.restoreState();
    const repository = persistenceAdapter.getApprovalOutboxRepository();
    const limit = Number(optionValue("limit", 10));
    const maxBatches = Math.max(1, Math.min(Number(optionValue("max-batches", 20)), 100));
    const worker = createOutboxWorker({
      repository,
      logger: null,
      batchSize: limit,
    });
    const result = emptySummary();
    for (let index = 0; index < maxBatches; index += 1) {
      const batch = await worker.runOnce({ requestId: "outbox_cli_drain" });
      addSummary(result, batch);
      if (batch.claimed === 0 || batch.errors > 0 || batch.cancelled) break;
    }
    console.log(JSON.stringify({
      ok: result.errors === 0,
      restored: {
        approvalOutbox: restoreSummary(restored.approvalOutbox),
      },
      result,
      repository: repository.health(),
    }, null, 2));
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    closeAdapter(persistenceAdapter);
  }
} catch (error) {
  console.error(JSON.stringify(safeFailure(error), null, 2));
  process.exitCode = 1;
}
