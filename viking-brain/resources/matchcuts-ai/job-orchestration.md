# Job Orchestration Architecture

Source files:

- `server/app.cjs`: HTTP route parsing, validation, rate limiting, idempotency, and delegation.
- `server/render-job.cjs`: render/generate orchestration, progress, cancellation, adapters, defensive validation, export persistence.
- `server/jobs.cjs`: state machine and idempotency.
- `tests/render-job.test.cjs`: mocked orchestration success/failure/cancel regressions.

Contracts:

- Routes must not own FFmpeg/transcription/analysis/edit-plan business logic.
- `enqueueRenderJob` starts only queued jobs and avoids restarting active idempotent jobs.
- `runRenderJob` accepts injected adapters for tests and defaults to real local modules in production.
- Exports are created only after render success and output verification.
- Project status becomes `ready` only after job completion; failures become `failed`; cancellations leave projects unexported.
- Logs include requestId/jobId/projectId/step/error code without absolute local paths or secrets.
