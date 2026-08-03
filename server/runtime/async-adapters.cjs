const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

function contractError() {
  return new AppError(
    "ADAPTER_CONTRACT_INVALID",
    SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
    500,
  );
}

function requireMethod(target, method) {
  if (!target || typeof target[method] !== "function") throw contractError();
  return target[method].bind(target);
}

function createAsyncPersistenceAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw contractError();
  return Object.freeze({
    mode: adapter.mode || (adapter.health && adapter.health().mode) || "unknown",
    raw: adapter,
    async call(method, ...args) {
      return await requireMethod(adapter, method)(...args);
    },
    async withTransaction(callback) {
      if (typeof callback !== "function") throw contractError();
      const transaction = typeof adapter.withTransaction === "function"
        ? adapter.withTransaction.bind(adapter)
        : requireMethod(adapter, "transaction");
      return await transaction(async (transactionAdapter = adapter) => {
        const scoped = transactionAdapter === adapter
          ? this
          : createAsyncPersistenceAdapter(transactionAdapter);
        return await callback(scoped);
      });
    },
    async readiness() {
      const health = typeof adapter.readiness === "function"
        ? await adapter.readiness()
        : await requireMethod(adapter, "health")();
      return health && typeof health === "object"
        ? health
        : { ready: false, mode: "unknown" };
    },
    async close() {
      if (typeof adapter.close !== "function") return false;
      await adapter.close();
      return true;
    },
  });
}

function createAsyncJobQueue(queue) {
  if (!queue || typeof queue !== "object") throw contractError();
  return Object.freeze({
    backend: queue.backend || "unknown",
    raw: queue,
    async call(method, ...args) {
      return await requireMethod(queue, method)(...args);
    },
    async enqueue(input, options) {
      if (input && typeof input === "object" && !input.id && typeof queue.create === "function") {
        const job = await queue.create(input);
        return {
          job: await queue.enqueue(job, options),
          replayed: false,
        };
      }
      const result = await requireMethod(queue, "enqueue")(input, options);
      if (
        result
        && typeof result === "object"
        && result.job
        && typeof result.replayed === "boolean"
      ) {
        return result;
      }
      return { job: result, replayed: false };
    },
    async get(jobId, ownerId) {
      return await requireMethod(queue, "get")(jobId, ownerId);
    },
    async cancel(jobOrId, options) {
      return await requireMethod(queue, "cancel")(jobOrId, options);
    },
    async readiness() {
      return await requireMethod(queue, "health")();
    },
    async close() {
      if (typeof queue.close !== "function") return false;
      await queue.close();
      return true;
    },
  });
}

module.exports = {
  createAsyncJobQueue,
  createAsyncPersistenceAdapter,
};
