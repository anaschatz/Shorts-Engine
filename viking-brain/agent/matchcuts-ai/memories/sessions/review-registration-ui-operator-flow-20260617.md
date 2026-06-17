# Session Memory: Review Registration UI Operator Flow

Date: 2026-06-17

## Decision

Added an operator-facing review registration flow in the local UI. Review draft registration remains outside the render pipeline, but operators can now trigger it safely after a completed render/export.

## Implementation

- Added `POST /api/review/register` in `server/app.cjs`.
- Added a review panel, Register/Registered state and safe metrics summary in `index.html`, `app.js` and `styles.css`.
- Extended demo smoke to register review after a successful export.
- Extended browser smoke contracts for review panel selectors and initial disabled state.
- Added backend route tests for registration success and fail-closed cases.
- Added this OpenViking resource: `viking-brain/resources/matchcuts-ai/review-registration-ui-operator-flow.md`.

## Safety

- Register stays disabled until there is a completed job, export id and rights confirmation.
- The backend validates project/job/export ids, bounded JSON, rights confirmation and artifact availability.
- Failed jobs, missing artifacts and unsafe references return structured safe errors.
- Public responses expose only bounded review metrics and workspace-relative draft refs.
- No absolute paths, storage keys, raw logs, raw provider output, tokens or secrets are returned.

## Validation

- Focused route/browser/review-registration tests passed during implementation.
- Full lint/build/test/eval/demo/release validation is still required before commit and push.
