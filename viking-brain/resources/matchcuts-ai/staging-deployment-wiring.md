# ShortsEngine Staging Deployment Wiring

Milestone: Staging Deployment Wiring + Protected Environment Gate.

Decisions:

- Keep default staging mode provider-neutral and readiness-only.
- Add `npm run staging:check` as the deterministic local proof for staging deployment contracts.
- Add `npm run staging:smoke` as a health-only deployed smoke check that requires `SHORTSENGINE_STAGING_URL`.
- Use GitHub Environment `staging` in `.github/workflows/staging.yml`.
- Trigger staging workflow manually or after `ShortsEngine CI` succeeds.
- Do not claim a fake deploy when no provider is configured.
- Fail closed when a real provider is configured before provider-specific deploy steps exist.
- Do not run real cloud integration or upload artifacts in the staging workflow by default.

Safety contract:

- Validate staging URLs as `http`/`https` only.
- Reject URLs with embedded credentials.
- Reject localhost URLs unless `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1`.
- Keep deployed smoke read-only: `GET /health` only, no uploads, no render jobs.
- Keep reports free of secrets, absolute local paths and storage keys.

Commands:

- `npm run env:check`
- `npm run staging:check`
- `SHORTSENGINE_STAGING_URL=https://... npm run staging:smoke`
- `npm run release:check`
- `npm run release:evidence`
