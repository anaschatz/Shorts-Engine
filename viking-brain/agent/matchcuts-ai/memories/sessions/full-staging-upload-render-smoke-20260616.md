# Full Staging Upload/Render Smoke - 2026-06-16

Added an opt-in full staging smoke proof for ShortsEngine.

Decisions:

- `staging:smoke` remains health-only.
- `staging:smoke:full` requires `SHORTSENGINE_STAGING_FULL_SMOKE=1`.
- The script validates fixture location/size, staging URL safety, health readiness, upload response, job completion and rendered MP4 download.
- Full smoke reports safe capability metadata only and distinguishes `ephemeral-staging` from `durable-capable`.
- Default CI and release gates do not run full smoke.

Validation focus:

- Disabled-by-default behavior.
- Unsafe URL and fixture rejection.
- Job failure, cancellation, timeout and missing export fail closed.
- Download content type/signature validation.
- No signed token, storage key, local path or raw response leakage.
