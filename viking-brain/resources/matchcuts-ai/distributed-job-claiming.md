# Distributed Job Claiming + Worker Lease Safety

Production milestone: distributed-safe job claiming foundation for ShortsEngine.

Source files:

- `server/jobs.cjs`: lease-aware `JobStore` with `claimJob`, `claimNextJob`, `heartbeatWithLease`, `updateWithLease`, `completeWithLease` and `failWithLease`.
- `server/job-worker.cjs`: worker now claims a job before processing and passes a lease-bound `jobs` facade into render orchestration.
- `server/adapters/persistence-adapter.cjs`: persistence contract includes `claimPersistedJob` and `persistClaimedJob`.
- `server/adapters/sqlite-persistence-adapter.cjs`: SQLite claims jobs inside guarded transactions and rejects stale worker writes.
- `server/adapters/local-persistence-adapter.cjs`: local adapter implements the same contract for deterministic tests and future adapter swaps.
- `tests/job-persistence.test.cjs`: local and SQLite lease regressions for claim, re-claim, heartbeat, cancellation, stale writers and terminal protection.

Contracts:

- Workers get a `workerId`; each claim creates a `leaseId`, `claimedAt`, `leaseExpiresAt`, `lastHeartbeatAt` and increments `attempts`.
- Queued jobs can be claimed once.
- Processing jobs with an active lease cannot be claimed by another worker.
- Expired leases can be reclaimed and increment attempts.
- Terminal jobs cannot be claimed and remain terminal.
- Heartbeat, completion and failure through the worker path require matching `jobId`, `workerId` and `leaseId`.
- Cancellation clears the active lease, so stale worker completion/failure is rejected.
- Public job responses hide lease internals; health exposes aggregate queue/lease readiness only.

SQLite behavior:

- `claimPersistedJob` uses adapter transactions to guard claims against concurrent workers.
- `persistClaimedJob` checks the persisted active lease before allowing worker writes.
- Local JSON remains the default mode; SQLite claiming is opt-in with `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`.

Limitations:

- SQLite is still process-local and synchronous.
- This milestone does not add Postgres row locking, advisory locks, SKIP LOCKED semantics or multi-node deployment configuration.
- Long-running renders still need a future heartbeat scheduler during FFmpeg/provider calls.
