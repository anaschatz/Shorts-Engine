# Session Memory: Generated Output Review Registration

Date: 2026-06-17

## Decision

Added a local registration layer that turns completed generated ShortsEngine renders into review drafts for the existing real-video comparison loop. The layer stays under `eval/` so review draft creation does not become hidden work inside the render pipeline.

## Implementation

- Added `eval/review-registration.cjs`.
- Added `eval/run-review-registration.mjs`.
- Added `npm run review:register`.
- Added ignored local draft output under `eval/review-drafts/`.
- Added focused tests in `tests/review-registration.test.cjs`.
- Updated the evaluation skill and OpenViking resource docs.

## Safety

- Requires completed job status, matching export record and explicit rights confirmation.
- Resolves generated/source media to workspace-relative refs only.
- Rejects traversal, missing media, unsafe absolute refs and incomplete jobs.
- Does not include storage keys, raw local paths, raw logs, raw provider errors, tokens or artifacts in drafts.
- Generated drafts are local/ignored by default.

## OpenViking Cleanup

The old dirty OpenViking files were inspected before cleanup. Truncated decision/skill content and timestamp-only churn were restored to committed state, while unrelated `manual-downloads/` remains untracked and untouched.

## Validation

- Targeted registration tests passed during implementation.
- Full validation remains required before commit/push.
