# Session Memory: Staging Deployment Wiring

Created: 2026-06-15

## Summary

ShortsEngine added a provider-neutral staging deployment foundation. The system now has a local staging readiness gate, a deployed health-only smoke command, a GitHub Environment `staging` workflow, documentation and tests.

## Decisions

- Default staging provider remains `none` so local and CI checks do not require real deployment credentials.
- Real provider configuration fails closed until an explicit provider deploy step is implemented.
- Deployed smoke checks only `/health`; no uploads, renders, cloud integration or cleanup actions run by default.
- Release evidence includes staging readiness alongside environment readiness.

## Validation Targets

- `npm run staging:check`
- `npm run staging:smoke` with explicit `SHORTSENGINE_STAGING_URL`
- `npm run release:check`
- `npm run release:evidence`

## Limitations

- No actual hosting provider is wired yet.
- GitHub Environment variables, secrets and reviewers must be configured in GitHub by the repo owner.
