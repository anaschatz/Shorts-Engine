# ShortsEngine Manual Demo Testing

Use this checklist when you want to test ShortsEngine like a real user in a browser.

## Prerequisites

- Node.js 18 or newer.
- FFmpeg and FFprobe available on this machine.
- Playwright Chromium installed for automated browser E2E. Run `npm install` and, if needed, `npm run demo:browser:install`.
- No API key is required. The demo uses mock transcription unless you explicitly configure another provider.

## Commands

Generate or refresh the demo video fixture:

```bash
npm run demo:fixture
```

Run the API-level acceptance smoke:

```bash
npm run demo:smoke
```

Run the browser contract smoke report:

```bash
npm run demo:browser
```

Run the real Playwright browser E2E smoke:

```bash
npm run demo:browser:e2e
```

Check YouTube ingest runtime readiness without downloading anything:

```bash
npm run youtube:doctor
```

Run the opt-in authorized YouTube ingest smoke only when a downloader is installed and the URL is safe to process:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE=1 \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1 \
SHORTSENGINE_YOUTUBE_SMOKE_URL="https://www.youtube.com/watch?v=<video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL="http://127.0.0.1:4175" \
npm run youtube:smoke
```

For the full rights, downloader, doctor, smoke, report-reading and cleanup checklist, use `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`.

Install the Playwright Chromium runtime:

```bash
npm run demo:browser:install
```

Print this checklist:

```bash
npm run demo:manual
```

Start the local app for manual testing:

```bash
npm run dev
```

Open `http://127.0.0.1:4175` unless you set a different `PORT`.

## Manual Browser Steps

1. Confirm the page title/header says `ShortsEngine`.
2. Confirm the initial state is safe:
   - Export is disabled.
   - Download is hidden.
   - No horizontal overflow on desktop.
3. Switch to `YouTube URL`.
4. Enter a valid YouTube/Shorts URL and click `Validate source` without rights consent.
5. Confirm the UI shows a safe `YOUTUBE_RIGHTS_REQUIRED` error.
6. Enable the YouTube rights checkbox, validate again, and confirm a validated preview appears.
7. Confirm the preview shows safe video id/kind metadata, not a raw canonical URL.
8. In default mode, confirm `Ingest video`, `Generate shorts`, Export, and Download remain disabled because real ingest is not enabled.
9. If you intentionally started the server with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1` and doctor reports ready, click `Ingest video`.
10. Confirm successful ingest creates upload/project state and `Generate shorts` becomes enabled.
11. Click `Generate shorts`, confirm progress/loading state appears, and confirm `Cancel` appears while the job is active.
12. Wait for completion, then confirm Export/Download are enabled only after render completion.
13. Switch back to `Local upload`.
14. Click `Generate shorts` without uploading a file.
15. Confirm the UI shows a safe `UPLOAD_EMPTY` error and does not show download/export.
16. Click the upload control and choose `demo/fixtures/shortsengine-demo-source.mp4`.
17. Confirm the UI shows the uploaded file state and video preview.
18. Enable the rights checkbox.
19. Click `Generate shorts`.
20. Confirm progress/loading state appears.
21. Confirm `Cancel` appears while the job is active.
22. Wait for the job to complete.
23. Confirm Export/Download are enabled only after completion.
24. Confirm the download link points to `/api/exports/<export id>/download`.
25. Download the MP4 and confirm the file opens.
26. Repeat a quick mobile viewport check and confirm there is no horizontal overflow.

## Expected UI States

- Missing upload: safe `UPLOAD_EMPTY` message.
- YouTube source: safe URL validation is available by default; `YOUTUBE_RIGHTS_REQUIRED`, playlist/live/unsafe URL errors are user-facing; render/export stay disabled until a successful authorized ingest creates a local MP4 artifact.
- Active job: progress visible, generate disabled, cancel visible.
- Completed job: project status rendered/ready, download visible, export enabled.
- Failed job: retry visible, download hidden, safe error shown.

## Troubleshooting

- FFmpeg missing: install/configure FFmpeg and rerun `npm run demo:fixture`.
- Playwright missing: run `npm install`, then `npm run demo:browser:install`.
- Browser runtime unavailable in constrained CI: use `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1 npm run demo:browser:e2e` only when the skip is intentional and visible in the report.
- Upload rejected: regenerate the fixture with `npm run demo:fixture` and confirm it is an MP4.
- Render failed: run `npm run demo:smoke` and inspect `demo/results/latest.json`.
- YouTube ingest disabled: run `npm run youtube:doctor`; default skipped output is expected until `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`.
- YouTube downloader missing: install/configure the downloader and rerun doctor; `YOUTUBE_DOWNLOADER_MISSING` is a safe fail-closed runtime state.
- YouTube download timed out: keep the test video short and raise `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS` only for intentional manual proof.
- YouTube smoke URL rejected: playlists, live, embeds, channels, search pages, credentialed URLs and non-YouTube hosts are blocked before network/downloader work.
- Browser E2E failed: inspect `demo/results/playwright-latest.json`; reports include safe check names and failure codes only.
- Failure screenshots: only failed browser E2E runs write screenshots under `demo/results/playwright-artifacts/`.
- Trace/video: enable only for debugging with `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1`.
- Port already used: start with a different port, e.g. `PORT=4182 npm run dev`.
- No API key: expected for local demo; mock transcription is the safe default.
- Real YouTube ingest is opt-in and manual. It requires `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`, downloader readiness, explicit rights confirmation and a smoke allowlist or `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1`.
- Manual YouTube smoke details: see `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`.

## Known Limitations

- `npm run demo:browser` remains dependency-light and does not drive a real browser by itself.
- `npm run demo:browser:e2e` drives Chromium through Playwright and is the automated proof for the full browser upload/generate/render/download path.
- Real YouTube ingest is implemented behind the explicit local downloader adapter and remains disabled by default. Keep it manual until staging policy, downloader operations and authorized-source review are complete.
- CI setup, skip semantics and retention policy live in `demo/CI.md`.
- Internal `MatchCutsCore` identifiers remain until a dedicated internal rename milestone.
