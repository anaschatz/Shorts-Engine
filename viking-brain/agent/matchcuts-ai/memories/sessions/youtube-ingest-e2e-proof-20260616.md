# YouTube Ingest E2E Proof - 2026-06-16

## Decisions

- Added `npm run youtube:doctor` as the default-safe runtime validator.
- Added `npm run youtube:smoke` as manual real-ingest proof only.
- Kept real YouTube download out of default CI and local default flows.
- Required explicit smoke flag, ingest flag, authorized URL and allowlist/manual URL gate.
- Validated unsafe URL forms before any network/fetch path.
- Reused shared report leak guards for doctor, smoke reports and public API responses.

## Tests Added

- Doctor disabled default returns a safe skipped summary and does not check the downloader.
- Doctor enabled with missing downloader fails closed with `YOUTUBE_DOWNLOADER_MISSING`.
- Smoke skips safely without `SHORTSENGINE_YOUTUBE_SMOKE=1`.
- Smoke rejects unsafe playlists before network.
- Smoke requires allowlist or explicit manual unlisted flag before network.
- Mocked smoke covers health, validate, ingest, generate, job polling and MP4 download.
- Smoke report writer creates safe `youtube-smoke-latest.json`.
- Public response leaks fail closed without persisting sensitive report content.

## Limitations

- Default tests mock network and downloader behavior.
- Manual real downloader validation still requires local/staging setup with a legally authorized URL and installed downloader.
- Local server smoke/browser checks may be unavailable in restricted sandboxes that block port binding.
