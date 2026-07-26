const { createHash } = require("node:crypto");
const { readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("../../errors.cjs");

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const ADVISORY_LOCK_NAME = "shortsengine_postgres_migrations_v1";

function safeMigrationError(cause = null) {
  const error = new AppError(
    "DB_MIGRATION_FAILED",
    SAFE_MESSAGES.DB_MIGRATION_FAILED,
    503,
  );
  if (cause && cause.code === "MIGRATION_CHECKSUM_MISMATCH") {
    error.details = { reason: "checksum_mismatch" };
  }
  return error;
}

function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function discoverMigrations(directory = __dirname) {
  const root = resolve(directory);
  const migrations = readdirSync(root)
    .map((fileName) => {
      const match = MIGRATION_FILE.exec(fileName);
      if (!match) return null;
      const sql = readFileSync(join(root, fileName), "utf8").trim();
      if (!sql || /\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(sql)) {
        throw safeMigrationError();
      }
      return Object.freeze({
        version: Number(match[1]),
        name: match[2],
        fileName,
        sql,
        checksum: migrationChecksum(sql),
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.version - right.version);
  const versions = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw safeMigrationError();
    versions.add(migration.version);
  }
  return migrations;
}

async function bootstrapMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function runPostgresMigrations(options = {}) {
  const pool = options.pool;
  if (!pool || typeof pool.connect !== "function") throw safeMigrationError();
  const logger = Object.prototype.hasOwnProperty.call(options, "logger") ? options.logger : console;
  const migrations = options.migrations || discoverMigrations(options.directory || __dirname);
  const timeoutMs = Math.max(1000, Math.min(15 * 60 * 1000, Number(options.timeoutMs || 60000)));
  const client = await pool.connect().catch(() => {
    throw safeMigrationError();
  });
  let locked = false;
  const summary = {
    discovered: migrations.length,
    applied: 0,
    currentVersion: 0,
  };
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_NAME]);
    locked = true;
    await bootstrapMigrationTable(client);
    const existing = await client.query(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const applied = new Map(existing.rows.map((row) => [Number(row.version), row]));
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous) {
        if (
          previous.name !== migration.name
          || String(previous.checksum).trim() !== migration.checksum
        ) {
          const mismatch = new Error("migration checksum mismatch");
          mismatch.code = "MIGRATION_CHECKSUM_MISMATCH";
          throw mismatch;
        }
        summary.currentVersion = Math.max(summary.currentVersion, migration.version);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT set_config('statement_timeout', $1, true)",
          [`${timeoutMs}ms`],
        );
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations(version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        summary.applied += 1;
        summary.currentVersion = migration.version;
        if (logger && typeof logger.info === "function") {
          logger.info(JSON.stringify(redactForLogs({
            level: "info",
            event: "database_migration_applied",
            version: migration.version,
            name: migration.name,
          })));
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    return summary;
  } catch (error) {
    throw safeMigrationError(error);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_NAME])
        .catch(() => {});
    }
    client.release();
  }
}

module.exports = {
  ADVISORY_LOCK_NAME,
  discoverMigrations,
  migrationChecksum,
  runPostgresMigrations,
};
