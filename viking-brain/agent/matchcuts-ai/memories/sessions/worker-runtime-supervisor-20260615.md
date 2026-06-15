# Session Memory: Worker Runtime Supervisor

Date: 2026-06-15

Decision:

- Added `server/worker-supervisor.cjs` to own worker start/stop, drain mode, queue draining, retry scheduling, shutdown timeout handling and safe health output.
- `server/app.cjs` now delegates startup recovery and generate job enqueueing to the supervisor.
- `JobStore` now persists retry metadata: `nextRetryAt`, `backoffMs`, `lastRetryCode`.
- Local and SQLite claim paths now skip queued jobs whose retry time is still in the future.
- Retry is explicit and bounded. Default retryable codes are provider/cloud/database transient codes; validation/AI/edit-plan/path failures do not retry.

Tests added:

- Supervisor start/stop lifecycle.
- Drain mode blocks new jobs while active work continues.
- Shutdown timeout aborts active jobs safely.
- Retryable failure schedules bounded backoff and retries only when due.
- Non-retryable and exhausted failures become terminal failed jobs.
- Supervisor health exposes safe aggregate metrics.
- Local and SQLite claims respect future retry schedules.

Checks:

- `npm test` passed with 148 tests.

Remaining limitation:

- This is still a local in-process supervisor. A future milestone should add multi-process worker deployment controls, external queue adapter boundaries, and production metrics export.

