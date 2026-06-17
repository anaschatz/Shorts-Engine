# Human Approval + Render-from-Draft Gate

## Purpose

ShortsEngine can now turn a validated regeneration draft into a render job only after explicit human approval. Draft creation remains a planning step; it does not render, export or unlock downloads.

## Approval Contract

- `POST /api/review/regeneration-approval` requires completed review records, rights confirmation and `approve: true`.
- The route delegates to `server/regeneration-approval.cjs`.
- The approval layer rebuilds the regeneration draft server-side and verifies the selected `draftHash`.
- Drafts with blocking reasons, invalid edit plans or failed safety checks are rejected.
- Approval creates a `regeneration_render` job with deterministic idempotency.

## Render Contract

- Approved render jobs carry `approvedEditPlan` and `regenerationApproval` metadata in their payload.
- `server/render-job.cjs` validates the approved plan and uses it directly.
- Approved regeneration renders skip fresh transcription, vision, highlight detection and candidate-plan generation.
- Exports/downloads remain gated on the normal successful render completion path.

## Public Safety

- Public job payloads expose only approved-plan summaries, not the full edit plan.
- API responses and logs must not include absolute paths, storage keys, provider raw output, stdout/stderr, tokens, secrets or stack traces.
- Failed approval or render states return structured safe errors.

## UI Contract

- The Review panel shows `Approve render` only for valid drafted regeneration plans.
- The button is disabled unless the operator has a registered review, a draft with applied suggestions and no blocking reasons.
- Approval states are visible: required, approving, queued/rendering, completed and failed.
- Normal download/export controls remain locked until a render job completes successfully.

## Validation

- `tests/regeneration-approval.test.cjs`
- `tests/render-job.test.cjs`
- `tests/backend.test.cjs`
- `tests/browser-demo.test.mjs`
- Demo browser smoke checks include approval button and status container contracts.
