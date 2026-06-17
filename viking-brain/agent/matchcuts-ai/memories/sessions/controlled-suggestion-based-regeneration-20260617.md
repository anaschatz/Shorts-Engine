# Session Memory: Controlled Suggestion-Based Regeneration

Date: 2026-06-17

## Decisions

- Review suggestions can create a draft edit plan, but never a render job.
- The regeneration builder lives behind `server/regeneration-plan.cjs`.
- The API route remains thin and delegates to the builder.
- `canRender` is always false and `requiresHumanApproval` is always true.
- Moment reselection and reviewer readiness remain manual-only blocking reasons.

## Safety Rules

- No automatic render or export creation from suggestions.
- No unsupported goal wording may survive the proposed edit plan.
- Wide-safe framing is preferred for framing suggestions.
- Draft responses/logs must not expose local paths, storage keys, raw logs, provider output or secrets.

## Tests

- Added focused builder coverage in `tests/regeneration-plan.test.cjs`.
- Added API coverage for draft-only regeneration in `tests/backend.test.cjs`.
- Added browser/static contract coverage for the draft action and details container.

## Limitations

- Drafts are returned through the API and UI only; there is not yet an approved render-from-draft flow.
- Human approval is represented in the contract, but no persistent approval workflow exists yet.
