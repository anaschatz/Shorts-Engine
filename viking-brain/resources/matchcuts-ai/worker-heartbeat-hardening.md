# Worker Heartbeat Hardening

ShortsEngine workers now renew active job leases while render/provider work is running.

Runtime shape:

- `server/job-worker.cjs` starts a bounded heartbeat loop after project/upload context is validated and before render orchestration begins.
- The interval defaults to half of the configured lease duration, clamped to a safe range, and can be disabled or overridden in tests.
- Heartbeats use the active lease-bound `JobStore` proxy, so stale workers cannot renew, complete or fail jobs after losing a lease.
- On heartbeat failure, the worker aborts its local job signal and refuses stale terminal writes.
- The heartbeat timer is cleared in success, failure and lost-lease paths.
- `/health` exposes worker heartbeat readiness metadata without local paths, storage keys, secrets or provider internals.

Production risk reduced:

- Long-running FFmpeg/provider calls are less likely to exceed a valid worker lease.
- Stale workers fail closed when their lease has been lost.
- Duplicate or late completions remain blocked by lease-bound writes.
- Operators can see whether worker heartbeat is enabled and what lease interval is active.

Regression coverage:

- Worker heartbeat renews leases deterministically during processing.
- Heartbeat cleanup clears timers.
- Lost lease aborts stale processing and blocks stale completion.
- API health includes safe worker heartbeat metadata.

