# DB-backed Approval Audit Tables + Transactional Outbox

## Purpose

ShortsEngine now treats regeneration draft audits, approval audits and approval lifecycle events as persistence-owned records. Local JSON remains the default, while SQLite can persist the same contracts for staging-like durability.

## Boundaries

- `server/repositories/regeneration-draft-repository.cjs` validates draft audit summaries and exports the shared normalizer.
- `server/repositories/regeneration-approval-repository.cjs` validates approval lifecycle rows and exports the shared normalizer.
- `server/repositories/approval-outbox-repository.cjs` owns approval lifecycle outbox events.
- `server/adapters/local-persistence-adapter.cjs` exposes draft, approval and outbox repositories for local defaults.
- `server/adapters/sqlite-persistence-adapter.cjs` migration v3 adds `regeneration_drafts`, `regeneration_approvals` and `approval_outbox` tables with source/status indexes.
- `server/approval-audit-recovery.cjs` reconciles non-terminal approval records with recovered job state on startup.

## Safety Contract

Audit and outbox records may store safe ids, lifecycle statuses, timestamps, counters and error codes only. They must not store raw edit plans, raw captions, provider output, stdout/stderr, local paths, storage keys, signed tokens or secrets.

`approval_created` outbox events intentionally omit render job/export ids so idempotent approval retries do not create duplicate creation events after the approval has moved to `render_queued`.

## Lifecycle Events

- `approval_created`
- `render_queued`
- `render_processing`
- `render_completed`
- `render_failed`
- `render_cancelled`

Approval route queueing writes `approval_created` and `render_queued` in the persistence transaction when supported. Render orchestration writes processing/completed/failed/cancelled events. Recovery writes terminal events when it reconciles persisted approval rows against recovered jobs.

## Health

`/health` includes aggregate readiness for:

- `repositories.regenerationDrafts`
- `repositories.regenerationApprovals`
- `repositories.approvalOutbox`
- `approvalRecovery`

Health output remains aggregate-only and must not include DB paths, storage keys or raw record payloads.

## Tests

Focused coverage:

- `tests/regeneration-audit-repository.test.cjs`
- `tests/sqlite-persistence-adapter.test.cjs`
- `tests/regeneration-approval.test.cjs`
- `tests/render-job.test.cjs`
- `tests/approval-audit-recovery.test.cjs`
- `tests/adapter-contracts.test.cjs`
