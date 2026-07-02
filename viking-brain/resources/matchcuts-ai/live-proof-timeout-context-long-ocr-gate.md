# Live Proof Timeout Context + Long OCR Gate

## Decision

The live YouTube proof runner must not create a minimal timeout report outside the real proof flow. A timeout is part of the proof lifecycle, so it must preserve bounded context from the local server, the smoke runner, the active job snapshot, OCR chunk progress, and output gate state.

## Contract

- `demo/run-youtube-live-e2e.mjs` owns the live proof deadline internally.
- Timeout failures return `YOUTUBE_LIVE_E2E_TIMEOUT` with safe `phase`, `step`, `substep`, `elapsedMs`, and `timeoutMs`.
- The runner still executes cleanup in `finally`, collects server events, stops the local server, and writes a safe failed proof report.
- Reports include `currentJob` when available, or a synthetic processing snapshot derived from safe server progress metadata.
- Reports always declare `logsDownloaded: false` and `artifactsDownloaded: false`.
- No generated MP4 should be treated as success unless the final output proof and ffprobe/output gates pass.

## OCR Context

Long source scorebug OCR can be slow. Timeout and polling failures should preserve:

- `phase`
- `step`
- `substep`
- `chunkIndex`
- `chunkCount`
- `chunkStart`
- `chunkEnd`
- `scannedChunks`
- `discoveredScoreChanges`
- `totalBudgetMs`
- `chunkTimeoutMs`

When only server progress exists, the failed output proof derives an `ocrChunkSummary` so the operator can see where OCR was when the proof stopped.

## Safety

- No raw stdout/stderr is persisted.
- No downloaded GitHub logs or artifacts are referenced.
- No absolute paths, tokens, cookies, provider raw errors, or storage keys are exposed in reports.
- Polling failures keep the last known job snapshot instead of collapsing into generic fetch failure without context.

## Tests

The contract is covered by `tests/youtube-runtime.test.mjs`:

- smoke polling failure preserves last active chunk context
- live proof timeout preserves server progress context
- existing leak guards continue to run against produced reports
