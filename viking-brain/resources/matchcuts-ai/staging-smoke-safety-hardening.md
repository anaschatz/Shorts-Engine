# ShortsEngine Staging Smoke Safety Hardening

Milestone: Production risk-reduction hardening for staging smoke and deployment readiness.

Decisions:

- Treat `SHORTSENGINE_STAGING_URL` as an external input with SSRF-style risk.
- Accept only `http` and `https` URLs without embedded credentials.
- Reject localhost, private IPv4, carrier-grade NAT, link-local, multicast/reserved and private IPv6 targets unless `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1` is explicitly set.
- Keep local-mode staging smoke available for developer validation only.
- Bound deployed `/health` response bodies to 64 KiB before parsing JSON.
- Convert oversized, invalid JSON, timeout and fetch failures into safe structured errors.
- Keep staging smoke read-only: no uploads, render jobs, cleanup operations or real cloud integration.

Regression coverage:

- Private/link-local URL rejection.
- Explicit local/private override behavior.
- Oversized health body rejection.
- Invalid JSON health body rejection.
- Existing no path/secret/storage-key leakage checks.
