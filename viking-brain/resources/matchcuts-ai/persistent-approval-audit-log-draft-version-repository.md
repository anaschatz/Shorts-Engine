# Persistent Approval Audit Log + Draft Version Repository

## Purpose

ShortsEngine approval-to-render flows now persist review regeneration draft versions and approval audit records before and during approved render jobs. This makes human-approved regeneration traceable without exposing raw edit plans, captions, filesystem paths or storage keys.

## Boundaries

- `server/repositories/regeneration-draft-repository.cjs` owns draft-version audit records.
- `server/repositories/regeneration-approval-repository.cjs` owns approval audit lifecycle records.
- API routes stay thin: they validate route payloads, delegate plan/approval work, then return safe public summaries.
- Render orchestration updates approval audit state best-effort for `render_processing`, `render_completed`, `render_failed` and `cancelled`.

## Public Record Shape

Draft records contain only:

- ids and draft hash
- version, status and validation status
- safe edit-plan summary counts/labels
- applied/skipped/blocking suggestion ids
- safety check codes/statuses

Approval records contain only:

- approval id, regeneration plan id and draft hash
- source project/job/export ids
- idempotency key, approvedAt/approvedBy
- render job id, completed export id
- lifecycle status and safe error code

## Safety Rules

- Do not persist full proposed edit plans or raw captions in the audit repositories.
- Do not expose local paths, storage keys, stdout/stderr, provider errors, tokens or secrets in public responses.
- Idempotent approval requests must reuse the same approval record and render job.
- Failed renders must not create export records.
- Completed approval audit may reference an export only after the render output has been committed and the job completed.
- Corrupt persisted audit records are ignored during restore.

## Validation

- `tests/regeneration-audit-repository.test.cjs` covers repository create/get/update/restore, corrupt metadata handling, lifecycle statuses, idempotency conflict and leak guards.
- `tests/regeneration-approval.test.cjs` covers approval idempotency with real audit repositories.
- `tests/render-job.test.cjs` covers approved draft render audit updates for completion and failure.
- `tests/backend.test.cjs` covers public API/health contracts for draft and approval audit summaries.
