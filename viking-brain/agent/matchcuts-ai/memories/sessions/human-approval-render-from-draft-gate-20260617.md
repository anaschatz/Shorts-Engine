# Session Memory: Human Approval + Render-from-Draft Gate

Date: 2026-06-17

## Decisions

- Regeneration drafts still do not render automatically.
- Explicit `approve: true` plus rights confirmation is required before creating a render-from-draft job.
- Approval rebuilds and validates the draft server-side, then checks `draftHash` to prevent stale or tampered approvals.
- Approved regeneration jobs are idempotent and carry bounded approval metadata.
- Approved render jobs use the validated edit plan directly instead of rerunning AI analysis.

## Safety Rules

- Reject drafts with blocking reasons, invalid edit plans or failed safety checks.
- Do not create exports/downloads until the approved render completes successfully.
- Public payloads expose only approved edit-plan summaries.
- Keep logs and reports free of absolute paths, storage keys, raw provider output, stdout/stderr, tokens and secrets.

## Tests

- Added `tests/regeneration-approval.test.cjs`.
- Added render orchestration coverage for approved draft jobs in `tests/render-job.test.cjs`.
- Added API coverage for approval rejection, approval success and idempotency in `tests/backend.test.cjs`.
- Added browser/static contract coverage for the approval button and approval status container.

## Limitations

- Approval records are carried in job payload metadata; a durable approval audit repository is still a future milestone.
- The approved render job still depends on the existing render/export path for final artifact creation.
