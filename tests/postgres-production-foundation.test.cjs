const assert = require("node:assert/strict");
const test = require("node:test");

const { AppError } = require("../server/errors.cjs");
const {
  PostgresPersistenceAdapter,
  createPostgresPool,
} = require("../server/adapters/postgres-persistence-adapter.cjs");
const {
  discoverMigrations,
  runPostgresMigrations,
} = require("../server/migrations/postgres/runner.cjs");

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function createMigrationHarness(options = {}) {
  const calls = [];
  const applied = Array.isArray(options.applied) ? [...options.applied] : [];
  let released = false;
  const client = {
    async query(text, values = []) {
      const sql = String(text);
      calls.push({ sql, values });
      if (/SELECT version, name, checksum FROM schema_migrations/.test(sql)) {
        return result(applied);
      }
      if (/INSERT INTO schema_migrations/.test(sql)) {
        applied.push({
          version: values[0],
          name: values[1],
          checksum: values[2],
        });
        return result([], 1);
      }
      if (
        options.failSql
        && !["BEGIN", "ROLLBACK", "COMMIT"].includes(sql)
        && options.failSql(sql)
      ) {
        const error = new Error(options.failureMessage || "sensitive database failure");
        error.code = "INTERNAL_POSTGRES_ERROR";
        throw error;
      }
      return result();
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    applied,
    client,
    pool: {
      async connect() {
        return client;
      },
    },
    get released() {
      return released;
    },
  };
}

test("canonical PostgreSQL migration chain is contiguous and transaction-free", () => {
  const migrations = discoverMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(migrations.map((migration) => migration.checksum)).size, 7);
  for (const migration of migrations) {
    assert.match(migration.fileName, /^\d{4}_[a-z0-9_]+\.sql$/);
    assert.doesNotMatch(migration.sql, /\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i);
  }
});

test("migration runner applies each migration in its own transaction and reruns cleanly", async () => {
  const migrations = discoverMigrations();
  const first = createMigrationHarness();
  const summary = await runPostgresMigrations({
    pool: first.pool,
    logger: null,
    migrations,
  });
  assert.deepEqual(summary, {
    discovered: 7,
    applied: 7,
    currentVersion: 7,
  });
  assert.equal(first.calls.filter((call) => call.sql === "BEGIN").length, 7);
  assert.equal(first.calls.filter((call) => call.sql === "COMMIT").length, 7);
  assert.equal(first.calls.filter((call) => call.sql === "ROLLBACK").length, 0);
  assert.equal(first.released, true);

  const second = createMigrationHarness({ applied: first.applied });
  const rerun = await runPostgresMigrations({
    pool: second.pool,
    logger: null,
    migrations,
  });
  assert.deepEqual(rerun, {
    discovered: 7,
    applied: 0,
    currentVersion: 7,
  });
  assert.equal(second.calls.filter((call) => call.sql === "BEGIN").length, 0);
  assert.equal(second.released, true);
});

test("migration checksum mismatch fails closed without exposing database details", async () => {
  const migrations = discoverMigrations();
  const harness = createMigrationHarness({
    applied: [{
      version: 1,
      name: migrations[0].name,
      checksum: "0".repeat(64),
    }],
  });
  await assert.rejects(
    runPostgresMigrations({
      pool: harness.pool,
      logger: null,
      migrations,
    }),
    (error) => {
      assert.equal(error.code, "DB_MIGRATION_FAILED");
      assert.equal(error.status, 503);
      assert.deepEqual(error.details, { reason: "checksum_mismatch" });
      assert.doesNotMatch(error.message, /checksum|postgres|database_url/i);
      return true;
    },
  );
  assert.equal(
    harness.calls.some((call) => /pg_advisory_unlock/.test(call.sql)),
    true,
  );
  assert.equal(harness.released, true);
});

test("migration failure rolls back, unlocks and returns only a safe error", async () => {
  const migrations = discoverMigrations();
  const sensitive = "postgres://user:secret@example.invalid/private";
  const harness = createMigrationHarness({
    failureMessage: `${sensitive} SELECT private_column`,
    failSql: (sql) => sql === migrations[0].sql,
  });
  await assert.rejects(
    runPostgresMigrations({
      pool: harness.pool,
      logger: null,
      migrations,
    }),
    (error) => {
      assert.equal(error.code, "DB_MIGRATION_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /secret|private_column|example\.invalid/i);
      return true;
    },
  );
  assert.equal(harness.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(harness.calls.some((call) => /pg_advisory_unlock/.test(call.sql)), true);
  assert.equal(harness.released, true);
});

function createTransactionHarness({ failPoolQuery = true } = {}) {
  const calls = [];
  let released = false;
  let ended = false;
  const client = {
    async query(text, values = []) {
      calls.push({ sql: String(text), values });
      if (String(text) === "SELECT transaction_probe") {
        return result([{ ok: true }]);
      }
      return result();
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      if (failPoolQuery) throw new Error("pool.query must not be used in a transaction");
      return result();
    },
    async end() {
      ended = true;
    },
  };
  return {
    calls,
    client,
    pool,
    get released() {
      return released;
    },
    get ended() {
      return ended;
    },
  };
}

test("PostgreSQL transactions stay on one checked-out client", async () => {
  const harness = createTransactionHarness();
  const adapter = new PostgresPersistenceAdapter({
    config: { postgres: { transactionTimeoutMs: 60_000 } },
    logger: null,
    pool: harness.pool,
  });
  const value = await adapter.withTransaction(async (transaction) => {
    assert.equal(transaction.client, harness.client);
    const probe = await transaction.query("SELECT transaction_probe");
    return probe.rows[0].ok;
  });
  assert.equal(value, true);
  assert.deepEqual(
    harness.calls.map((call) => call.sql),
    [
      "BEGIN",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT transaction_probe",
      "COMMIT",
    ],
  );
  assert.equal(harness.released, true);
  assert.equal(await adapter.close(), false);
  assert.equal(harness.ended, false);
});

test("PostgreSQL transactions rollback raw failures but preserve safe AppErrors", async () => {
  const rawHarness = createTransactionHarness();
  const rawAdapter = new PostgresPersistenceAdapter({
    config: { postgres: {} },
    logger: null,
    pool: rawHarness.pool,
  });
  await assert.rejects(
    rawAdapter.withTransaction(async () => {
      throw new Error("postgres://user:secret@example.invalid/private");
    }),
    (error) => {
      assert.equal(error.code, "DB_TRANSACTION_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /secret|example\.invalid/i);
      return true;
    },
  );
  assert.equal(rawHarness.calls.at(-1).sql, "ROLLBACK");
  assert.equal(rawHarness.released, true);

  const appHarness = createTransactionHarness();
  const appAdapter = new PostgresPersistenceAdapter({
    config: { postgres: {} },
    logger: null,
    pool: appHarness.pool,
  });
  const conflict = new AppError("IDEMPOTENCY_CONFLICT", "safe conflict", 409);
  await assert.rejects(
    appAdapter.withTransaction(async () => {
      throw conflict;
    }),
    (error) => error === conflict,
  );
  assert.equal(appHarness.calls.at(-1).sql, "ROLLBACK");
});

test("owner-scoped project lookup never issues an unscoped resource query", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return result();
    },
  };
  const adapter = new PostgresPersistenceAdapter({
    config: { postgres: {} },
    logger: null,
    pool,
  });
  assert.equal(await adapter.getProject("prj_1", "usr_1"), null);
  assert.match(queries[0].sql, /id = \$1 AND owner_id = \$2/);
  assert.deepEqual(queries[0].values, ["prj_1", "usr_1"]);
});

test("PostgreSQL pool applies bounded production defaults without logging its DSN", () => {
  let poolOptions;
  class FakePool {
    constructor(options) {
      poolOptions = options;
    }

    on() {}
  }
  const dsn = "postgres://user:secret@example.invalid/private";
  createPostgresPool(
    {
      postgres: {
        url: dsn,
        sslMode: "require",
      },
    },
    {
      pg: { Pool: FakePool },
      logger: null,
    },
  );
  assert.deepEqual(
    {
      max: poolOptions.max,
      connectionTimeoutMillis: poolOptions.connectionTimeoutMillis,
      idleTimeoutMillis: poolOptions.idleTimeoutMillis,
      statementTimeout: poolOptions.statement_timeout,
      queryTimeout: poolOptions.query_timeout,
    },
    {
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statementTimeout: 30000,
      queryTimeout: 30000,
    },
  );
  assert.deepEqual(poolOptions.ssl, { rejectUnauthorized: true });
});
