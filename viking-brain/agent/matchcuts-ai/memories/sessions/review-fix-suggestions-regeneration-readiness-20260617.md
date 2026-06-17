# Session Memory: Review Fix Suggestions + Regeneration Readiness

Date: 2026-06-17

## Decision

Added a deterministic review-fix suggestion layer that turns failed review metrics into operator-readable next actions while keeping regeneration disabled.

## Implementation

- Added `eval/review-fix-suggestions.cjs`.
- Extended review registration comparison previews with `suggestions`, `suggestionSummary`, `regenerationAvailable: false` and `regenerationPlan: null`.
- Extended `/api/review/register` to return safe suggestions and log only counts/types.
- Extended the Review panel UI with a compact Fix suggestions section and disabled regeneration control.
- Extended demo/browser smoke contracts for suggestion summary and regeneration-disabled behavior.
- Added focused tests in `tests/review-fix-suggestions.test.cjs` and expanded backend/registration/browser tests.

## Safety

- Passing reviews return no suggestions.
- Every suggestion is schema-validated with allowlisted type, severity and target values.
- `canAutoApply` stays false by default.
- No raw logs, provider output, storage keys, tokens, secrets or absolute paths are allowed in public suggestion output.
- API logs do not include raw suggestion messages.

## Limitations

- Suggestions are deterministic and metric-driven; they do not yet rewrite captions or edit plans.
- Regeneration is intentionally unavailable until a dedicated apply/regenerate milestone exists.

## Validation

- Focused syntax and route/browser/review tests passed during implementation.
- Full validation remains required before commit and push.
