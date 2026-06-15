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
3. Click `Generate shorts` without uploading a file.
4. Confirm the UI shows a safe `UPLOAD_EMPTY` error and does not show download/export.
5. Click the upload control and choose `demo/fixtures/shortsengine-demo-source.mp4`.
6. Confirm the UI shows the uploaded file state and video preview.
7. Enable the rights checkbox.
8. Click `Generate shorts`.
9. Confirm progress/loading state appears.
10. Confirm `Cancel` appears while the job is active.
11. Wait for the job to complete.
12. Confirm Export/Download are enabled only after completion.
13. Confirm the download link points to `/api/exports/<export id>/download`.
14. Download the MP4 and confirm the file opens.
15. Repeat a quick mobile viewport check and confirm there is no horizontal overflow.

## Expected UI States

- Missing upload: safe `UPLOAD_EMPTY` message.
- Active job: progress visible, generate disabled, cancel visible.
- Completed job: project status rendered/ready, download visible, export enabled.
- Failed job: retry visible, download hidden, safe error shown.

## Troubleshooting

- FFmpeg missing: install/configure FFmpeg and rerun `npm run demo:fixture`.
- Playwright missing: run `npm install`, then `npm run demo:browser:install`.
- Browser runtime unavailable in constrained CI: use `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1 npm run demo:browser:e2e` only when the skip is intentional and visible in the report.
- Upload rejected: regenerate the fixture with `npm run demo:fixture` and confirm it is an MP4.
- Render failed: run `npm run demo:smoke` and inspect `demo/results/latest.json`.
- Browser E2E failed: inspect `demo/results/playwright-latest.json`; reports include safe check names and failure codes only.
- Failure screenshots: only failed browser E2E runs write screenshots under `demo/results/playwright-artifacts/`.
- Trace/video: enable only for debugging with `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1`.
- Port already used: start with a different port, e.g. `PORT=4182 npm run dev`.
- No API key: expected for local demo; mock transcription is the safe default.

## Known Limitations

- `npm run demo:browser` remains dependency-light and does not drive a real browser by itself.
- `npm run demo:browser:e2e` drives Chromium through Playwright and is the automated proof for the full browser upload/generate/render/download path.
- CI setup, skip semantics and retention policy live in `demo/CI.md`.
- Internal `MatchCutsCore` identifiers remain until a dedicated internal rename milestone.
