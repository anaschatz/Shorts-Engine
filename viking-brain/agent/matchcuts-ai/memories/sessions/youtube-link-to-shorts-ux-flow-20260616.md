# YouTube Link-To-Shorts UX Flow - 2026-06-16

## Decisions

- Use the existing YouTube source panel rather than adding a new page.
- Move YouTube UI gating into `Core.deriveYouTubeUiState` so tests can cover state transitions without a browser runtime.
- Keep validation available only after URL and YouTube-specific rights confirmation.
- Keep ingest available only after validation and `youtubeIngest` health readiness.
- Keep generate disabled until successful ingest creates project/upload state.
- Keep preview safe by showing video id/kind metadata instead of raw canonical URL.

## Proof

- `tests/validation.test.js` covers validate/ingest/generate/download/busy YouTube UI states.
- `demo/run-browser-smoke.mjs` and `tests/static-lint.mjs` assert frontend gating, safe preview summary and no downloader logic.
- Manual docs cover the local UI E2E demo path.

## Limitations

- Real downloader execution remains manual and opt-in.
- Browser/live health smoke depends on whether the local environment allows server binding.
