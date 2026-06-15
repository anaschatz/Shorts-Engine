# ShortsEngine Provider-Specific Staging Deploy

Milestone: Provider-Specific Staging Deploy Step.

Decision:

- Keep `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none` as the default readiness-only path.
- Support Render as the first real staging deploy provider.
- Trigger Render deploys only when GitHub Environment `staging` provides:
  - `SHORTSENGINE_DEPLOY_TARGET=staging`
  - `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=render`
  - `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`
  - `SHORTSENGINE_STAGING_URL=https://...`
  - secret `SHORTSENGINE_STAGING_DEPLOY_TOKEN`
- Keep deploy logic in `tools/release/staging-deploy.mjs` so the workflow stays readable and provider behavior is testable.
- Validate Render staging configuration with `tools/release/check-render-staging.mjs` before triggering deploy.
- Run `npm run staging:smoke` only after deploy config exists and a staging URL is configured.

Safety contract:

- Unsupported providers fail closed.
- Missing service id, URL or deploy token fails closed.
- Render deploy output is sanitized: no token, raw provider error, local path, storage key or absolute path.
- Readiness checks inspect contracts without calling Render.
- `npm run render:check` must stay no-network and public-URL-only.
- Staging workflow does not upload artifacts or run real cloud integration by default.

Validation:

- `npm run staging:check` validates the contract shape.
- `npm run render:check` validates live Render setup readiness without network.
- `npm run staging:deploy` is a no-op summary for provider `none`.
- Tests mock Render deploy requests and assert no sensitive leakage.
