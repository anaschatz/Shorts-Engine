const { createDefaultAdapters } = require("../adapters/local-persistence-adapter.cjs");
const { JobStore } = require("../jobs.cjs");
const { createLocalJobQueue } = require("../queue/local-job-queue.cjs");
const { createMemoryObservabilityAdapter } = require("../observability/memory-observability-adapter.cjs");
const { createAsyncJobQueue, createAsyncPersistenceAdapter } = require("./async-adapters.cjs");
const { loadRuntimeConfig, publicRuntimeConfig } = require("./runtime-config.cjs");

async function createRuntime(options = {}) {
  const config = options.config || loadRuntimeConfig(options.env || process.env);
  const logger = Object.prototype.hasOwnProperty.call(options, "logger") ? options.logger : console;
  const clock = options.clock || { now: () => Date.now() };
  const random = typeof options.random === "function" ? options.random : Math.random;
  const factories = options.factories || {};

  let artifactAdapter;
  let persistenceAdapter;
  if (config.persistenceMode === "postgres") {
    if (typeof factories.createPostgresPersistenceAdapter !== "function") {
      const { createPostgresPersistenceAdapter } = require("../adapters/postgres-persistence-adapter.cjs");
      persistenceAdapter = await createPostgresPersistenceAdapter({ config, logger, clock });
    } else {
      persistenceAdapter = await factories.createPostgresPersistenceAdapter({ config, logger, clock });
    }
    artifactAdapter = options.artifactAdapter || null;
  } else {
    const adapters = createDefaultAdapters({
      ...options,
      persistenceAdapterMode: config.persistenceMode,
    });
    artifactAdapter = adapters.artifactAdapter;
    persistenceAdapter = adapters.persistenceAdapter;
  }

  const asyncPersistence = createAsyncPersistenceAdapter(persistenceAdapter);
  if (config.storageMode === "r2") {
    if (typeof factories.createR2ArtifactStore === "function") {
      artifactAdapter = await factories.createR2ArtifactStore({
        config,
        logger,
        clock,
      });
    } else {
      const { createR2ArtifactStore } = require("../storage/r2-artifact-store.cjs");
      artifactAdapter = createR2ArtifactStore({ config, logger, clock });
    }
  }
  let auth;
  if (config.authMode === "oidc") {
    if (typeof factories.createOidcAuthAdapter === "function") {
      auth = await factories.createOidcAuthAdapter({
        config,
        persistence: asyncPersistence,
        logger,
        clock,
        initialize: false,
      });
    } else {
      const { createOidcAuthAdapter } = require("../auth/oidc-auth-adapter.cjs");
      auth = await createOidcAuthAdapter({
        config,
        persistence: asyncPersistence,
        logger,
        clock,
        initialize: false,
      });
    }
  } else {
    auth = options.authAdapter || {
      async health() {
        return { ready: true, mode: config.authMode };
      },
    };
  }
  let queue;
  if (config.queueMode === "postgres") {
    if (typeof factories.createPostgresJobQueue !== "function") {
      const { createPostgresJobQueue } = require("../queue/postgres-job-queue.cjs");
      queue = await createPostgresJobQueue({
        persistenceAdapter,
        config,
        logger,
        clock,
        random,
      });
    } else {
      queue = await factories.createPostgresJobQueue({
        persistenceAdapter,
        config,
        logger,
        clock,
        random,
      });
    }
  } else {
    const jobs = options.jobs || new JobStore({
      persist: config.persistenceMode !== "local",
      logger,
      persistenceAdapter: config.persistenceMode === "sqlite" ? persistenceAdapter : null,
    });
    queue = createLocalJobQueue({ jobs, logger });
  }

  const asyncQueue = createAsyncJobQueue(queue);
  const observability = options.observability || createMemoryObservabilityAdapter();
  let worker = null;
  if (config.role === "worker") {
    const { DistributedWorkerRunner } = require("../worker/distributed-worker-runner.cjs");
    const handlers = typeof factories.createWorkerHandlers === "function"
      ? await factories.createWorkerHandlers({
        artifactAdapter,
        config,
        logger,
        observability,
        persistence: asyncPersistence,
        queue,
      })
      : options.workerHandlers || {};
    worker = new DistributedWorkerRunner({
      queue,
      handlers,
      workerId: options.workerId || queue.workerId,
      heartbeatMs: config.worker.heartbeatMs,
      leaseMs: config.worker.leaseMs,
      pollMs: config.worker.pollMs,
    });
  }
  let started = false;
  let closed = false;

  return Object.freeze({
    config,
    publicConfig: publicRuntimeConfig(config),
    role: config.role,
    artifactAdapter,
    persistence: asyncPersistence,
    queue: asyncQueue,
    auth,
    observability,
    worker,
    clock,
    random,
    async start() {
      if (closed) throw new Error("Runtime is closed.");
      if (started) return false;
      if (config.role === "migrate") {
        await asyncPersistence.call("migrate");
      }
      if (
        config.role === "web"
        && config.authMode === "oidc"
        && typeof auth.initialize === "function"
      ) {
        await auth.initialize();
      }
      if (worker) await worker.start();
      started = true;
      return true;
    },
    async readiness() {
      const storageHealth = artifactAdapter && typeof artifactAdapter.readiness === "function"
        ? artifactAdapter.readiness()
        : artifactAdapter && typeof artifactAdapter.health === "function"
          ? artifactAdapter.health()
          : { ready: false, mode: "unconfigured" };
      const [persistence, jobQueue, authentication, storage] = await Promise.all([
        asyncPersistence.readiness(),
        asyncQueue.readiness(),
        auth.health(),
        storageHealth,
      ]);
      const telemetry = await observability.health();
      const workerHealth = worker
        ? worker.health()
        : { ready: true, configured: false };
      return {
        ready: Boolean(
          persistence.ready
          && jobQueue.ready
          && authentication.ready
          && storage.ready
          && telemetry.ready
          && workerHealth.ready
        ),
        role: config.role,
        adapters: {
          persistence,
          queue: jobQueue,
          auth: authentication,
          storage,
          observability: telemetry,
          worker: workerHealth,
        },
      };
    },
    async close() {
      if (closed) return false;
      closed = true;
      if (worker) await worker.stop();
      await Promise.allSettled([
        asyncQueue.close(),
        asyncPersistence.close(),
        artifactAdapter && typeof artifactAdapter.close === "function"
          ? artifactAdapter.close()
          : Promise.resolve(false),
        observability.shutdown(),
      ]);
      return true;
    },
  });
}

module.exports = {
  createRuntime,
};
