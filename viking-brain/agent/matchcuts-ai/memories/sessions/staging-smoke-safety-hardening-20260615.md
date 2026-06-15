# Session Memory: Staging Smoke Safety Hardening

Created: 2026-06-15

## Summary

ShortsEngine tightened the staging smoke boundary. The deployed smoke URL validator now rejects private and link-local network targets unless local mode is explicitly enabled, and the health response parser rejects oversized or invalid JSON bodies with safe structured errors.

## Decisions

- `SHORTSENGINE_STAGING_URL` is treated as untrusted input.
- Remote staging smoke should target public staging hosts, not internal metadata/private network addresses.
- `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1` remains available for explicit developer local smoke only.
- `/health` smoke responses are bounded to 64 KiB before JSON parsing.

## Validation

- Added regression tests for private/link-local URLs.
- Added regression tests for oversized and invalid JSON health responses.
- Existing staging/release/no-leak gates continue to pass.

## Limitation

This does not resolve DNS to detect private IPs behind public hostnames. That belongs in a future network-aware smoke hardening milestone if the staging runner allows DNS inspection safely.
