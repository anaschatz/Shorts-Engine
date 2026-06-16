# YouTube Link-To-Shorts UX Flow

## Contract

The UI may expose a YouTube source flow, but real ingest remains opt-in and health-gated. Default local and CI paths must not execute a downloader or perform real YouTube ingest.

## Flow

1. User selects `YouTube URL`.
2. User enters a safe YouTube watch, Shorts or youtu.be URL.
3. User confirms YouTube-specific rights.
4. `Validate source` becomes available only when URL and rights are present.
5. Validation calls `/api/youtube/validate`.
6. Preview shows safe source metadata such as video id/kind, not raw canonical URL.
7. `Ingest video` becomes available only when validation passed and `/health.youtubeIngest` is ready.
8. Ingest calls `/api/youtube/ingest` and creates project/upload state.
9. `Generate shorts` becomes available only after successful ingest.
10. Export/download remain disabled until render completion.

## Safety Rules

- No downloader commands or storage internals in frontend code.
- No raw paths, storage keys, stdout, stderr, cookies or secrets in UI errors.
- Playlist, live, embed, channel, search and credentialed URLs are rejected server-side and client-side where possible.
- Health readiness drives affordances; validation alone is not enough to enable real ingest.
- Keep local upload flow available when YouTube ingest is unavailable.

## Proof

- `Core.deriveYouTubeUiState` is the shared gating helper.
- `Core.createYouTubePreviewSummary` keeps preview metadata safe.
- Browser static checks assert gating and no frontend downloader logic.
- Validation tests cover disabled, ready, ingested, generated and busy YouTube states.
