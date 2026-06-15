# ShortsEngine Full Staging Upload/Render Smoke

Milestone: Full Staging Upload/Render Smoke + Durable Storage/Persistence Proof.

Decision:

- Keep `npm run staging:smoke` health-only.
- Add `npm run staging:smoke:full` for manual, opt-in upload/render/download proof.
- Require `SHORTSENGINE_STAGING_FULL_SMOKE=1` before the full smoke can run.
- Reuse staging URL safety rules: public remote URLs by default, local/private only with explicit local mode.
- Use `demo/fixtures/shortsengine-demo-source.mp4` as the default deterministic fixture.

Flow:

- `GET /health`
- `POST /api/uploads`
- `POST /api/projects/:projectId/generate`
- poll `GET /api/jobs/:jobId`
- download `GET /api/exports/:exportId/download`
- validate MP4 content type and signature

Safety contract:

- No full upload/render smoke in default CI or release gate.
- Bound fixture size, JSON response size, polling timeout and download size.
- Do not write raw response bodies, signed download tokens, storage keys, service ids or local paths into summaries.
- Label storage/persistence proof as `ephemeral-staging` unless object storage and database-backed persistence are both present.
- Mark resources with `source: staging-full-smoke` and the `staging_full_` idempotency prefix so manual cleanup can identify them safely.

Limitations:

- Full smoke creates a real staging job/export and cleanup remains a separate manual command.
- Render local filesystem proof is not production durability.
