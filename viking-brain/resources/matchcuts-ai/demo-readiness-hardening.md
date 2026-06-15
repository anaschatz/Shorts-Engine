# Demo Readiness Hardening

ShortsEngine is close to a full local demo, so frontend export state must fail closed just like backend export routes.

Decision:

- A completed job is not enough to enable download/export in the UI.
- The client must validate that the completed job includes:
  - `status: completed`
  - safe `exportId`
  - valid `editPlan.sourceStart/sourceEnd`
  - at least one valid caption inside the source window
- Invalid completed payloads are shown as safe errors and keep download/export controls disabled.

Why:

- Demo testing should not expose stale download links or broken UI if a job record is partially corrupted, stale, or unexpectedly shaped.
- Backend still remains the authority for actual download authorization, but the frontend should avoid presenting impossible actions.

Tests:

- `tests/validation.test.js` covers `validateCompletedJobForExport`.
- `tests/static-lint.mjs` checks that `app.js` keeps the completed-job export guard.

Known limitation:

- This is a local demo readiness safeguard, not a full browser E2E flow. The next milestone should exercise upload -> generate -> progress -> render -> download in a browser smoke.
