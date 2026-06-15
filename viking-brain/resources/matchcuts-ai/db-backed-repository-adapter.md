# DB-backed Repository Adapter

Production milestone: DB-backed Repository Adapter + Migrations + Transaction Boundaries.

Source files:

- `server/adapters/sqlite-persistence-adapter.cjs`: opt-in SQLite persistence adapter using `node:sqlite`.
- `server/adapters/persistence-adapter.cjs`: shared adapter contract, including transaction, project/upload atomic create, job and idempotency persistence helpers.
- `server/adapters/local-persistence-adapter.cjs`: default local adapter, kept compatible with the expanded contract.
- `server/config.cjs`: `MATCHCUTS_PERSISTENCE_ADAPTER=local|sqlite`, `MATCHCUTS_SQLITE_FILE`, safe DB directory and filename validation.
- `server/storage.cjs`: `db` storage root for safe SQLite file resolution.
- `server/render-job.cjs`: export creation and project-ready transition can run inside adapter transactions.
- `tests/sqlite-persistence-adapter.test.cjs`: migration, rollback, persistence, idempotency, path-safety and no-leak regression tests.

Contracts:

- Default persistence remains `local`.
- SQLite is opt-in through `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite` or `createDefaultAdapters({ persistenceAdapterMode: "sqlite" })`.
- SQLite DB files must live under `data/db` and use `.sqlite`, `.sqlite3` or `.db`.
- Migrations are idempotent and reported through adapter health without exposing local file paths.
- Project/upload creation can be atomic through `createProjectUpload`.
- Export creation plus project `ready` state can run inside `persistenceAdapter.transaction`.
- Job and idempotency tables are now used by `JobStore` when SQLite mode is active; local JSON remains the default for local mode.
- Public responses and health must not expose absolute paths, storage keys, DB file paths or secrets.

Limitations:

- No Postgres or cloud DB adapter yet.
- The SQLite adapter is process-local and synchronous.
- Distributed queue claiming and multi-process locking are still future milestones.
