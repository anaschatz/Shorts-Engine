# Session: Distributed Worker Queue Adapter

Date: 2026-06-15

Milestone:

- Added `server/queue/queue-contracts.cjs`.
- Added `server/queue/local-job-queue.cjs`.
- Wired `server/app.cjs`, `server/job-worker.cjs` and `server/worker-supervisor.cjs` through the queue boundary.
- Added `tests/job-queue.test.cjs`.
- Updated health output with safe queue metrics.

Decisions:

- Keep local/SQLite `JobStore` as the implementation backend for now.
- Treat the queue adapter as the worker-facing contract for future multi-process and external queue work.
- Preserve existing render/job behavior while moving runtime calls behind enqueue, claim, heartbeat, complete, fail, retry, cancel and release-expired-lease methods.
- Keep no-leak health: aggregate capability/readiness metrics only.

Focused checks passed during implementation:

- `node --check server/queue/queue-contracts.cjs`
- `node --check server/queue/local-job-queue.cjs`
- `node --check server/job-worker.cjs`
- `node --check server/worker-supervisor.cjs`
- `node --check server/app.cjs`
- `node --test tests/job-queue.test.cjs`
- `node --test tests/worker-supervisor.test.cjs`
- `node --test tests/job-persistence.test.cjs`
- `node --test tests/backend.test.cjs`

Limitations:

- The queue adapter is still local/in-process and backed by `JobStore`.
- No Redis/BullMQ/SQS/Kafka adapter yet.
- No separate worker process launcher yet.
