# Report And Log Key Family Hardening

## Context

ShortsEngine already redacts many secret-shaped values and unsafe exact keys in public
reports, CI proof files and structured logs. The remaining risk is provider output or
future adapters using modern object keys such as `clientSecret`, `refreshToken`,
`privateKey`, `accessKeyId` or `sessionToken` where the key itself communicates that
the value must never be persisted or exposed.

## Decision

- Treat credential-shaped object keys as unsafe in `demo/report-safety.mjs`.
- Align `server/errors.cjs` log redaction with the same key families.
- Keep safe readiness booleans explicit so health/proof reports can still say whether
  credentials or tokens are configured/requested without exposing values.
- Cover both report leak guards and structured log redaction with regression tests.

## Safe Status Keys

Allowed readiness/status keys include:

- `credentialsConfigured`
- `deployTokenConfigured`
- `serviceIdConfigured`
- `tokensRequested`
- `secretsIncluded`
- `logsDownloaded`
- `artifactsDownloaded`

These keys are safe only as status metadata. Secret values, raw logs, provider errors
and local paths remain forbidden.
