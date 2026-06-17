import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDefaultAdapters } = require("../server/adapters/local-persistence-adapter.cjs");
const { createOutboxWorker } = require("../server/outbox-worker.cjs");

function safeFailure(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "OUTBOX_HEALTH_FAILED",
    message: "Outbox health check failed safely.",
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

try {
  const { persistenceAdapter } = createDefaultAdapters();
  try {
    const restored = persistenceAdapter.restoreState();
    const repository = persistenceAdapter.getApprovalOutboxRepository();
    const worker = createOutboxWorker({ repository, logger: null });
    const health = worker.health();
    console.log(JSON.stringify({
      ok: health.ready,
      restored: {
        approvalOutbox: restoreSummary(restored.approvalOutbox),
      },
      repository: repository.health(),
      worker: health,
    }, null, 2));
    if (!health.ready) process.exitCode = 1;
  } finally {
    closeAdapter(persistenceAdapter);
  }
} catch (error) {
  console.error(JSON.stringify(safeFailure(error), null, 2));
  process.exitCode = 1;
}
