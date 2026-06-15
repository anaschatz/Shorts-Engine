# Provider-Specific Staging Deploy - 2026-06-15

Implemented Render as the first real staging deploy provider.

Decisions:

- Keep provider `none` as readiness-only and no-network by default.
- Add `tools/release/staging-deploy.mjs` for testable provider deploy behavior.
- Require `SHORTSENGINE_DEPLOY_TARGET=staging`, `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=render`, `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`, `SHORTSENGINE_STAGING_URL` and secret `SHORTSENGINE_STAGING_DEPLOY_TOKEN` before real deploy.
- Reject unsupported providers and missing Render service id/token fail-closed.
- Keep staging workflow artifact-free and real-cloud-integration-free by default.

Validation focus:

- Mock Render deploy request in tests.
- Keep deploy summaries free of secrets, raw provider errors, storage keys and absolute local paths.
- Run deployed smoke only when a staging URL is configured.
