# Full Working Local Demo

ShortsEngine now has a repeatable local demo acceptance harness.

## Demo Commands

- `npm run demo:fixture` generates a small deterministic MP4 fixture with FFmpeg.
- `npm run demo:smoke` starts a local server, uploads the fixture, triggers the generate/render job, polls lifecycle state, downloads the completed export, and writes `demo/results/latest.json`.
- `npm run demo:e2e` is an alias for the local acceptance harness.

## Safety Contract

- The demo uses mock transcription by default and does not require API keys.
- The generated report stores relative fixture metadata, bounded job lifecycle snapshots, safe error codes, and export size/hash.
- Reports must not include absolute local paths, storage keys, secrets, raw provider errors, or stack traces.
- Full render/download success requires FFmpeg/FFprobe. If tools are missing, the runner fails with a safe code instead of silently passing.

## Current Boundary

Internal OpenViking resources and some historic `matchcuts` identifiers remain unchanged until a dedicated rename milestone. User-facing product copy is now ShortsEngine.
