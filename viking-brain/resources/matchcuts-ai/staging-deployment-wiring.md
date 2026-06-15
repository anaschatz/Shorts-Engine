# ShortsEngine Staging Deployment Wiring

Milestone: Staging Deployment Wiring + Protected Environment Gate.

Decisions:

- Keep default staging mode provider-neutral and readiness-only.
- Add `npm run staging:check` as the deterministic local proof for staging deployment contracts.
- Add `npm run staging:smoke` as a health-only deployed smoke check that requires `SHORTSENGINE_STAGING_URL`.
- Use GitHub Environment `staging` in `.github/workflows/staging.yml`.
- Trigger staging workflow manually or after `ShortsEngine CI` succeeds.
- Do not claim a fake deploy when no provider is configured.
- Support Render as the first provider-specific deploy path through `tools/release/staging-deploy.mjs`.
- Validate live Render configuration with `tools/release/check-render-staging.mjs` before deploy.
- Fail closed when an unsupported provider is configured.
- Do not run real cloud integration or upload artifacts in the staging workflow by default.

Safety contract:

- Validate staging URLs as `http`/`https` only.
- Reject URLs with embedded credentials.
- Reject localhost URLs unless `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1`.
- Keep deployed smoke read-only: `GET /health` only, no uploads, no render jobs.
- Keep reports free of secrets, absolute local paths and storage keys.
- Require Render staging deploys to provide target `staging`, provider `render`, a `srv-...` service id, a protected deploy token and a safe staging URL.

Commands:

- `npm run env:check`
- `npm run staging:check`
- `npm run render:check`
- `npm run staging:deploy`
- `SHORTSENGINE_STAGING_URL=https://... npm run staging:smoke`
- `npm run release:check`
- `npm run release:evidence`
