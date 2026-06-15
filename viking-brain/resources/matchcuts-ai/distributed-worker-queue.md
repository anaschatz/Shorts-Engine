# Distributed Worker Queue Adapter

ShortsEngine now has a local job queue contract boundary in front of `JobStore`.

Purpose:

- Prepare worker execution for future separate processes/containers.
- Keep local/SQLite persistence as the current backend while hiding it behind queue methods.
- Make future Redis/BullMQ/SQS/Kafka adapters possible without rewriting routes or render orchestration.

Contract methods:

- `create`
- `enqueue`
- `get`
- `all`
- `claim`
- `claimNext`
- `heartbeat`
- `update`
- `complete`
- `fail`
- `retry`
- `cancel`
- `releaseExpiredLeases`
- `publicJob`
- `health`

Runtime guarantees:

- Claims are lease-based with `workerId`, `leaseId`, `leaseExpiresAt`, heartbeat renewal and attempt counts.
- Duplicate active claims are rejected.
- Expired leases can be reclaimed or failed through bounded max-attempt rules.
- Invalid leases cannot complete, fail, heartbeat or retry a job.
- Terminal jobs remain protected.
- Retry/backoff metadata is written through the queue adapter.
- Cancellation clears the active lease and blocks stale completion.

Observability:

- `/health` includes a safe `queue` object with backend, capabilities, active workers, active/expired leases, status counts and retry scheduled counts.
- Supervisor health includes safe queue aggregate metrics.
- Queue health must not expose local paths, storage keys, DB paths, provider errors or secrets.

Tests:

- `tests/job-queue.test.cjs` covers contract validation, enqueue/claim/complete/fail/retry/cancel, duplicate claim prevention, stale lease reclaim, invalid lease rejection, terminal state protection and safe health.
- Existing worker supervisor tests now run through `createLocalJobQueue`.
