# Release Readiness Health Contract

ShortsEngine now exposes a local static release-readiness contract for health and release evidence.

## Module

- `server/release-readiness.cjs`
- `tools/release/check-release-readiness.mjs`
- `npm run release:readiness`

## Contract

The release-readiness summary verifies:

- Required release scripts exist with expected commands.
- The CI workflow contains required release markers.
- Failure artifacts remain failure-only.
- GitHub proof commands are documented without invoking GitHub.

The summary is safe for `/health` and release evidence:

- `networkCalls: false`
- `authStarted: false`
- `remoteMutation: false`
- `tokensRequested: false`
- `logsDownloaded: false`
- `artifactsDownloaded: false`

## Safety Rules

- Do not call `gh` from health or release-readiness static checks.
- Do not start `gh auth login` automatically.
- Do not include local paths, storage keys, tokens, raw stderr or raw provider output.
- Keep remote CI proof post-push and explicit through `npm run remote:ci` / `npm run remote:ci:proof`.

## Evidence

`/health` includes `releaseReadiness`.

`release:evidence` includes the same safe release-readiness summary so release reports prove the static CI/GitHub-proof contract without requiring network access.
