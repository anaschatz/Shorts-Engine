# DB-backed JobStore + Worker Recovery

Production milestone: DB-backed JobStore + Worker Recovery Migration for ShortsEngine.

Source files:

- `server/jobs.cjs`: `JobStore` can persist through a persistence adapter when a database-backed adapter is active, while preserving local JSON as the default fallback.
- `server/adapters/sqlite-persistence-adapter.cjs`: SQLite job rows, idempotency rows and `listPersistedJobs()` support restart recovery.
- `server/adapters/local-persistence-adapter.cjs`: local adapter keeps the expanded contract for tests and future swaps.
- `server/app.cjs`: wires `JobStore` to the persistence adapter only when adapter health reports a real database backend.
- `tests/job-persistence.test.cjs`: DB-backed lifecycle, idempotency, recovery, cancellation, worker success/failure and no-leak regression coverage.
- `server/job-worker.cjs`: worker now claims a lease before processing and writes through a lease-bound job facade.

Contracts:

- Local JSON job files remain the safe default when persistence mode is local.
- SQLite-backed jobs are opt-in through `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`.
- Job creates persist before being exposed in memory.
- Idempotency lookups can hydrate persisted DB jobs after restart without needing JSON recovery.
- Recovery reads persisted DB job records, skips corrupt/unsafe records safely, requeues stale processing jobs within attempt limits, fails exhausted stale jobs, and keeps terminal jobs terminal.
- Worker completion/failure/cancellation updates are persisted through the DB-backed store.
- DB-backed workers must claim a lease before processing; stale workers cannot complete/fail after another worker reclaims the job.
- Persistence failures are surfaced as safe structured `DB_TRANSACTION_FAILED` errors unless the adapter already produced a safe `AppError`.
- Public job responses, health and logs must not leak absolute paths, storage keys, database paths, stack traces or secrets.

Limitations:

- SQLite is still process-local and synchronous.
- This adds a SQLite/local claiming foundation but not Postgres row locks or multi-node deployment config.
- Local JSON remains the default runtime mode until deployment explicitly enables the SQLite adapter.
