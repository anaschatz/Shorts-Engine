# Durable Queue + Worker Persistence

Source files:

- `server/jobs.cjs`: durable job store, atomic JSON persistence, idempotency index recovery, stale processing recovery.
- `server/job-worker.cjs`: local worker abstraction for queued/recovered jobs.
- `server/app.cjs`: startup recovery, completed export restoration, API enqueue delegation.
- `server/config.cjs`: `data/jobs` storage configuration.
- `tests/job-persistence.test.cjs`: reload, stale, corrupt, unsafe, worker, cancellation and idempotency regressions.

Storage:

- Durable job files live under `data/jobs/`.
- Runtime-only `_controller` is never persisted.
- Public job responses omit `outputPath`; persisted records may keep storage-safe internal render paths for recovery.

Recovery policy:

- Completed, failed and cancelled jobs stay terminal.
- Queued jobs are picked up by the local worker.
- Processing jobs with stale/missing heartbeat are requeued while attempts are under the safe limit.
- Processing jobs at/over the attempt limit become failed with `JOB_STALE`.
- Corrupt or unsafe job records are skipped without crashing startup.

Worker contract:

- The local worker marks queued jobs processing, increments attempts through `JobStore`, calls `runRenderJob`, and respects cancellation.
- Missing project/upload during recovery fails closed with safe structured errors.
- No duplicate worker is scheduled for a job already running in-process.

Limitations:

- This is a local durable queue, not a distributed queue.
- Multi-process locking, database transactions, object storage and cross-machine workers remain future production milestones.
