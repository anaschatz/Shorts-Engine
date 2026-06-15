# Staging Smoke Artifact Cleanup - 2026-06-16

Added a safe cleanup lifecycle for ShortsEngine full staging smoke artifacts.

Decisions:

- Full smoke writes a safe `staging-full-smoke` source marker and `staging_full_` idempotency prefix.
- Cleanup runs with `npm run staging:smoke:cleanup`.
- Cleanup is dry-run by default.
- Real deletion requires `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1`.
- Cleanup skips non-smoke records, invalid ownership chains and active queued/processing jobs.

Validation focus:

- Dry-run by default.
- Explicit flag required for deletion.
- Smoke-marked artifacts only.
- Active job protection.
- No storage key, token, path or raw error leakage.
