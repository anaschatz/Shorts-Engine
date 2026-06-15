# Session Memory: Worker Heartbeat Hardening

Date: 2026-06-15

Decision:

- Added a bounded worker heartbeat loop to `server/job-worker.cjs` so long-running render/provider work renews the active lease while processing.
- Heartbeat writes go through the lease-bound `JobStore` proxy.
- Heartbeat failure aborts local stale processing and prevents stale completion/failure writes from overwriting the current job owner.
- `/health` now includes safe worker heartbeat metadata.

Tests added:

- Worker heartbeat renews the active lease during processing and clears its timer.
- Worker heartbeat aborts stale processing when the lease is lost.
- API health includes safe worker heartbeat metadata.

Checks:

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed: 140 tests.
- `npm run eval` passed with aggregate score 99 across 6 fixtures.

Remaining limitation:

- This is still an in-process worker model. The next production milestone should focus on distributed worker coordination and retry/backoff observability across multiple worker processes.

