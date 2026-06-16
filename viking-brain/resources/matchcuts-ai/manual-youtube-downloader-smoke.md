# Manual YouTube Downloader Smoke

## Contract

Real YouTube ingest proof is a manual operator action. Default CI and local validation must remain no-network and no-downloader.

## Operator Flow

1. Confirm rights for the exact source video.
2. Install and verify the downloader outside ShortsEngine.
3. Start the app with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`.
4. Run `npm run youtube:doctor` with optional `SHORTSENGINE_YOUTUBE_DOCTOR_URL`.
5. Run `npm run youtube:smoke` only with `SHORTSENGINE_YOUTUBE_SMOKE=1`, a reviewed URL and either allowlisted video ids or the explicit unlisted gate.
6. Read `demo/results/youtube-smoke-latest.json`.

## Safety Rules

- Do not auto-install downloader binaries.
- Do not run real downloader/network checks in default CI.
- Reject unsafe URL forms before fetch/downloader work.
- Keep reports bounded and leak-guarded.
- Store only request-id presence, not raw request ids.
- Do not include raw URLs, local paths, storage keys, stdout, stderr, cookies, tokens or provider errors in reports.
- Cleanup only current-run temp/staging files after the process exits; never delete uploads/renders/exports without a dedicated lifecycle policy.

## Key Files

- `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`
- `tools/release/check-youtube-ingest.mjs`
- `demo/run-youtube-smoke.mjs`
- `tests/youtube-runtime.test.mjs`
- `tests/static-lint.mjs`
