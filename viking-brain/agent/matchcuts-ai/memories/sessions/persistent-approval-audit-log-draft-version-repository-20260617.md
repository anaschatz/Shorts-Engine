# Persistent Approval Audit Log + Draft Version Repository - 2026-06-17

## Decisions

- Added dedicated regeneration draft and approval audit repositories instead of storing approval state directly in routes or render jobs.
- Persisted draft audit records store only safe summaries: ids, hash, version, validation status, counts/labels and suggestion/safety ids.
- Persisted approval audit records store only ids, idempotency key, lifecycle status, render job/export ids and safe error codes.
- Approval requests now create/reuse audit records idempotently before queueing approved regeneration render jobs.
- Approved render jobs update approval audit state best-effort during processing, completion, failure and cancellation.
- The review UI shows compact audit id/version/status metadata without exposing raw edit plans, captions or paths.

## Validation Added

- Repository contract tests for draft/approval create/get/update/restore, corrupt metadata ignore, idempotency conflict and leak guards.
- Approval domain test now exercises real in-memory draft/approval repositories.
- Render orchestration tests now verify approved render completion/failure audit updates.
- Backend API test now verifies draftRecord public summary, approval audit public summary and health readiness entries.

## Limitations

- Audit repositories are still local filesystem/in-memory implementations, not a production database table.
- Approval audit updates are best-effort during render execution; a future DB transaction/outbox milestone should make lifecycle writes atomic with job/export persistence.
- Existing internal `matchcuts-ai` OpenViking paths remain until a dedicated naming migration.
