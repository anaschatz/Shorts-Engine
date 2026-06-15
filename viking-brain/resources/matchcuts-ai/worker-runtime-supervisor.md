# Worker Runtime Supervisor

ShortsEngine now routes local job execution through a worker supervisor instead of calling the worker directly from API routes or startup recovery.

Runtime responsibilities:

- Manage supervisor states: `stopped`, `starting`, `running`, `draining`, `stopping`.
- Start queued jobs on boot through the same supervised path used by generate requests.
- Keep drain mode from accepting new jobs while active jobs continue with worker heartbeat protection.
- Stop cleanly by clearing poll/retry timers, waiting for active jobs, and aborting active jobs after a bounded shutdown timeout.
- Schedule bounded retries only for explicit retryable failure codes.
- Keep `JobStore` as the source of truth for status, attempts, leases and retry metadata.

Retry/backoff contract:

- Retryable by default: `TRANSCRIPTION_FAILED`, `TRANSCRIPTION_TIMEOUT`, `CLOUD_STORAGE_FAILED`, `DB_TRANSACTION_FAILED`.
- Non-retryable failures stay terminal, including invalid AI output, invalid edit plans, unsafe paths, missing project/upload, and validation failures.
- Retry metadata is persisted on the job record as `nextRetryAt`, `backoffMs`, and `lastRetryCode`.
- Local and SQLite job claiming must skip queued jobs whose `nextRetryAt` is still in the future.
- Completed, cancelled and failed terminal jobs are never retried.

Observability:

- `/health` includes safe aggregate supervisor metrics: state, drain mode, active jobs, queued/processing/failed counts, retry scheduled count, active/expired leases and worker heartbeat readiness.
- Logs include supervisor lifecycle events, retry scheduled/skipped events, drain/stop events and shutdown timeout events.
- Health/log payloads must not expose local paths, storage keys, database paths, provider raw errors or secrets.

Tests:

- Supervisor lifecycle start/stop.
- Drain mode blocks new jobs while active jobs continue.
- Shutdown timeout aborts active jobs safely.
- Retryable failures schedule bounded backoff and retry only when due.
- Non-retryable and exhausted failures do not retry.
- Local and SQLite job claims respect future retry schedules.

