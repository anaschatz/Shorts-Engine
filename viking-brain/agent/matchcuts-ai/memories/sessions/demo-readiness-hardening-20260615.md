# Session: Demo Readiness Hardening

Date: 2026-06-15

Milestone:

- Added frontend/core validation for completed job export payloads.
- Updated `app.js` so download/export controls are enabled only after `validateCompletedJobForExport` accepts the completed job.
- Added regression coverage in `tests/validation.test.js` and `tests/static-lint.mjs`.

Decision:

- A `completed` job status alone is not sufficient for demo export readiness.
- The UI requires safe `exportId`, valid edit-plan timing and at least one valid caption before exposing download controls.
- Invalid completed payloads fail closed with `EXPORT_PAYLOAD_INVALID`/`EXPORT_NOT_READY` safe messages.

Focused checks:

- `node --check hardening.js`
- `node --check app.js`
- `node --test tests/validation.test.js`
- `npm run lint`

Limitation:

- Browser E2E upload -> generate -> render -> download still belongs to the next demo milestone.
