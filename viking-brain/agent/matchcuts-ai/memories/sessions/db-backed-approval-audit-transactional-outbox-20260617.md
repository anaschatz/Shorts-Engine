# Session: DB-backed Approval Audit Tables + Transactional Outbox

Date: 2026-06-17

## Decisions

- Added `ApprovalOutboxRepository` for safe approval lifecycle events.
- Extended persistence adapter contract with repository getters for regeneration drafts, approvals and approval outbox.
- Kept local JSON as the default implementation and added SQLite migration v3 for durable audit/outbox tables.
- Approval queueing writes creation/queued events through the persistence boundary; render orchestration writes processing/completed/failed/cancelled events.
- Startup recovery reconciles non-terminal approval audits with recovered job state and writes safe outbox events.

## Safety Notes

- Audit/outbox rows store safe identifiers, statuses, timestamps, counters and error codes only.
- No raw edit plans, captions, provider output, stdout/stderr, local paths, storage keys, signed tokens or secrets belong in audit/outbox rows or health output.
- `approval_created` outbox events omit render job/export ids to keep idempotent retries deterministic.

## Validation

Focused tests passed:

- `node --test --test-concurrency=1 tests/regeneration-audit-repository.test.cjs tests/sqlite-persistence-adapter.test.cjs tests/regeneration-approval.test.cjs tests/render-job.test.cjs tests/approval-audit-recovery.test.cjs tests/adapter-contracts.test.cjs`

Full validation still needs to run before commit/push:

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run feedback:summary`
- `npm run brain:health`
- demo/browser/report/release checks
