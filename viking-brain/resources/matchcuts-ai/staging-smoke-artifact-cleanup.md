# ShortsEngine Staging Smoke Artifact Cleanup

Milestone: Staging Smoke Artifact Cleanup + Evidence Lifecycle.

Decisions:

- Mark full staging smoke resources with `source: staging-full-smoke`.
- Keep the idempotency key prefix `staging_full_` as a secondary cleanup signal.
- Keep `npm run staging:smoke:cleanup` manual and dry-run by default.
- Require `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1` before deleting smoke artifacts or records.
- Clean only validated smoke ownership chains: project -> upload -> job -> export/artifacts.
- Protect active queued/processing jobs and all non-smoke artifacts.

Safety contract:

- Cleanup summaries must be count-only and sanitized.
- Do not expose storage keys, signed tokens, local paths, provider raw errors or record ids.
- Do not run cleanup in default CI or release gates.
