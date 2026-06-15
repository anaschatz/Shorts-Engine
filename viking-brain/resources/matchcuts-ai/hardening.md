# Hardening L2 Details

Source files:

- `hardening.js`
- `server/app.cjs`
- `server/jobs.cjs`
- `server/job-worker.cjs`
- `server/render-job.cjs`
- `server/adapters/`
- `PRODUCTION_HARDENING.md`
- `tests/validation.test.js`
- `tests/backend.test.cjs`
- `tests/render-job.test.cjs`
- `tests/adapter-contracts.test.cjs`
- `tests/static-lint.mjs`
- `tests/build-smoke.mjs`

Key contracts:

- API response shape: `{ ok, data, error }`.
- Upload checks: filename, extension, MIME, signature, size, duration.
- Job statuses: queued, processing, failed, completed, cancelled.
- Generate/export actions use idempotency keys.
- Client validation is a guardrail only; backend must enforce the same rules.
- Routes must stay thin: HTTP validation/delegation in `server/app.cjs`, job orchestration in `server/render-job.cjs`.
- Render orchestration validates upload metadata, transcript shape, highlight moments, edit plans, output existence, and export creation order.
- Durable jobs live under `data/jobs`; startup recovery rebuilds idempotency, skips corrupt records, requeues stale processing jobs within max attempts, and keeps terminal jobs terminal.
- Terminal jobs must be immutable except for idempotent same-status checks; progress, output and error mutations after completion/failure/cancel are rejected.
- `/health` may expose safe aggregate queue readiness counts, but never job storage paths, output paths, secrets, or raw provider errors.
- Orchestration failure handling must tolerate missing project/upload context and fail the job safely without creating exports.
- Persistence boundaries must go through repositories for projects/uploads/exports and artifact adapters for filesystem/object-storage resolution.
- `server/adapters/` defines fail-closed persistence and artifact adapter contracts before any real DB/S3 migration.
- Local adapters must expose capability metadata in health without storage keys, local paths or provider details.
- Upload artifacts start as `staging`; export records are created only after a render artifact exists.
- Public API/health payloads must not expose `storageKey`, `outputPath`, local paths, or repository internals.
- Artifact id/size/buffer inputs and artifact path/key consistency are validation boundaries, not caller assumptions.
- Static serving uses frontend asset allowlists; multipart upload parsing bounds files/fields and rejects unexpected file fields.
- HTTP responses should include safe default headers: no-store, no-referrer, nosniff, and DENY framing.
- Upload multipart parsing must bound request overhead, boundary length, part header length and text field size before media validation.
- Generate JSON requests must have an explicit small body limit and reject oversized declared content before job creation.
- Startup project-state restore should only read valid `prj_*.json` / `prj_*.render.json` records under a size cap; unrelated or corrupt metadata is ignored before JSON parsing.
