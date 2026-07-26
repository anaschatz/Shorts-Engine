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
      started = true;
      return true;
    },
    async readiness() {
      const [persistence, jobQueue, authentication] = await Promise.all([
        asyncPersistence.readiness(),
        asyncQueue.readiness(),
        auth.health(),
      ]);
      const telemetry = await observability.health();
      return {
        ready: Boolean(
          persistence.ready
          && jobQueue.ready
          && authentication.ready
          && telemetry.ready
        ),
        role: config.role,
        adapters: {
          persistence,
          queue: jobQueue,
          auth: authentication,
          observability: telemetry,
        },
      };
    },
    async close() {
      if (closed) return false;
      closed = true;
      await Promise.allSettled([
        asyncQueue.close(),
        asyncPersistence.close(),
        observability.shutdown(),
      ]);
      return true;
    },
  });
}

module.exports = {
  createRuntime,
};
