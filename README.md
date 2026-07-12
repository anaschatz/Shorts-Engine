# ShortsEngine

ShortsEngine is a hardened local prototype for turning football match footage into short-form video. It focuses on safe media ingest, football-aware analysis, edit-plan generation, FFmpeg rendering, evaluation loops and release gates.

The project is intentionally conservative: if a goal, artifact, provider output or final MP4 cannot be verified, it should fail closed instead of producing a misleading "success" result.

## What It Does

- Accepts local video uploads and authorized YouTube URLs.
- Validates media before it enters the pipeline.
- Uses deterministic/mock providers by default so local tests do not require API keys.
- Detects football moments with evidence gates for counted goals, offside/no-goal cases, replay-only clips and celebration-only clips.
- Generates edit plans for short-form football content.
- Renders MP4 outputs through FFmpeg.
- Produces evaluation, demo, browser, OCR, YouTube proof and release reports.
- Keeps API routes, orchestration, repositories, artifact storage, providers and render logic behind separate boundaries.

## Current Status

ShortsEngine is a local production-hardening prototype, not a finished production SaaS.

The current live YouTube proof path is opt-in and rights-gated. For the latest live YouTube test case, the system failed safely instead of producing a misleading MP4 because scoreboard/OCR evidence did not prove the expected counted goals. The next product milestone is better live scorebug ROI calibration and visible counted-goal proof.

## Safety Defaults

- YouTube ingest is disabled unless explicitly enabled by operator flags.
- YouTube processing requires rights confirmation.
- No cookies, tokens or secrets are stored for YouTube ingest.
- Mock/fallback providers are the default.
- Real cloud storage, real transcription providers and live external integrations are opt-in.
- Reports must not include secrets, raw provider output, local absolute paths, storage keys, raw logs or downloaded artifacts.
- Final video proof should fail if the rendered MP4 cannot prove the expected counted-goal coverage.

## Requirements

- Node.js 18 or newer.
- npm.
- FFmpeg and FFprobe available on the system path.
- Playwright Chromium for browser proof checks.
- Optional: `yt-dlp` for authorized YouTube ingest.
- Optional: local OCR runtime such as Tesseract for opt-in OCR experiments.

## Quick Start

Install dependencies:

```bash
npm install
```

Create deterministic demo fixtures:

```bash
npm run demo:fixture
```

Run the local app:

```bash
npm run dev
```

Open:

```text
http://localhost:4175
```

The default port is `4175`. You can override it with `PORT`.

## Optional Real-ESRGAN Enhancement

Video enhancement is automatic when the official `realesrgan-ncnn-vulkan` portable runtime and its models are installed. It never changes the source used for OCR, tracking or goal verification. With the binary on `PATH` and its `models` directory beside it, the normal command is enough:

```bash
npm run dev
```

The renderer automatically enhances a caption-free `540x960` visual layer to `1080x1920`, then composes the original scorebug, captions, effects and audio. When the runtime is unavailable it uses the normal FFmpeg path. Absolute binary/model paths and mandatory mode remain available through the variables in `docs/ENVIRONMENT.md`.

## Automatic Local Transcription

Faster-Whisper is auto-detected through `python3`. When the Python package and the configured model are already available locally, the engine uses it automatically and preserves word timestamps for kinetic captions. It never downloads a model during a render. If the runtime or cached model is unavailable, automatic mode keeps the existing safe transcription fallback and the job continues normally. Configuration and mandatory mode are documented in `docs/ENVIRONMENT.md`.

Reliable FFmpeg scene cuts are also fed into the dynamic crop planner automatically. Ball and player tracking resets at a real cut instead of carrying camera motion from the previous shot; estimated scene boundaries are ignored.

## Core Validation

Run the main local checks:

```bash
npm run lint
npm run build
npm test
npm run eval
npm run eval:reference
npm run brain:health
```

Run demo and browser proof checks:

```bash
npm run demo:fixture
npm run demo:smoke
npm run demo:browser
npm run demo:browser:ci
```

Run release/report gates:

```bash
npm run ci:reports
npm run release:check
```

Run the local autoresearch quality loop:

```bash
npm run research:short:baseline
npm run research:short -- --description="one scoped experiment"
```

The loop is documented in `shortresearch/program.md`. It compares the current tree against a saved local baseline using eval, reference review and focused domain tests, then records whether the experiment should be kept or discarded.

## YouTube Link Proof

YouTube ingest is deliberately locked by default. Only run live YouTube proof for videos you have the right to process.

Check readiness:

```bash
npm run youtube:doctor
```

Run an operator-approved proof:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=VIDEO_ID" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="VIDEO_ID" \
npm run youtube:proof:operator
```

For counted-goal proof runs, add the expected goal count:

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS=5
```

The proof writes safe JSON reports under `demo/results/`. It should only produce an MP4 when the final output gate passes. If evidence is missing, the report should explain the failed phase, failure code, missing goal numbers or windows, and next action.

If the downloader cannot complete a long authorized source inside the bounded timeout, use the operator-approved source cache: place a rights-cleared `<VIDEO_ID>.mp4` under `data/source-cache`, enable `SHORTSENGINE_SOURCE_CACHE_ENABLED=1`, and rerun the same proof. See [docs/YOUTUBE_INGEST_MANUAL_SMOKE.md](docs/YOUTUBE_INGEST_MANUAL_SMOKE.md) for the full cache contract and checksum option.

## OCR And Goal Evidence

Scoreboard/OCR evidence is support-only. It can help identify counted goals, disallowed goals and score changes, but it must not confirm a goal without matching football action evidence.

Useful OCR commands:

```bash
npm run ocr:doctor
npm run ocr:smoke
npm run ocr:qa:review
```

Local OCR is opt-in. Missing OCR runtime should not break default tests.

## Project Structure

```text
server/        API, orchestration, media, rendering, providers, storage and domain logic
tests/         Node test suite and static contract tests
eval/          Deterministic evaluation fixtures, scoring and reference rubrics
demo/          Local proof runners, browser smoke, YouTube proof and report tooling
docs/          Operator docs, environment contract, release and staging notes
tools/         Release, environment, GitHub, YouTube and validation utilities
viking-brain/  OpenViking project memory, resources and skills
data/          Local runtime storage, ignored/generated by normal development
```

## Important Scripts

```text
npm run dev                 Start the local server
npm run lint                Static lint and safety checks
npm run build               Build smoke check
npm test                    Full test suite
npm run eval                Deterministic quality evaluation
npm run eval:beta           20-50 match production-beta benchmark
npm run eval:reference      Reference-style football quality evaluation
npm run youtube:doctor      YouTube ingest readiness check
npm run youtube:proof       Local YouTube proof alias
npm run youtube:proof:operator
npm run demo:browser:ci     Browser release proof
npm run ci:reports          Validate generated report safety
npm run research:short      Run the local autoresearch quality gate
npm run research:short:baseline
npm run release:check       Local release gate
```

## GitHub And CI

The repository CI is expected to run lint, build, tests, eval, reference eval, brain health, demo smoke, browser smoke and release gates. Failure artifacts should be uploaded only when a CI run fails, and reports must stay sanitized.

Remote CI proof uses GitHub CLI in read-only mode:

```bash
npm run github:setup
gh auth status
npm run github:doctor
npm run remote:ci
npm run remote:ci:proof
```

The proof must verify the exact pushed commit. It must not download raw logs or artifacts.

## Environment

Copy or inspect `.env.example` if present, then use documented environment variables only. See:

- `docs/ENVIRONMENT.md`
- `demo/CI.md`
- `docs/RELEASE.md`
- `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`

Do not commit secrets, cookies, API keys, local storage, rendered MP4s, downloads, reports with raw logs, or generated runtime artifacts.

## Known Limitations

- Live YouTube proof still depends on reliable scorebug/OCR framing and can fail if the scoreboard ROI is not readable.
- The system should prefer safe failure over a misleading proof video.
- Real provider-backed transcription, OCR and cloud storage are opt-in and not required for the default local test suite.
- Generated football shorts are still being tuned against reference examples for full phase coverage, pacing, captions and visible goal reconstruction.

## Roadmap

- Real scorebug ROI calibration from live YouTube QA artifacts.
- Stronger counted-goal verification against rendered MP4 segments.
- Better multi-goal pacing and smoother transitions.
- More reliable full goal phase reconstruction.
- Provider-backed vision/tracking with deterministic fallback.
- Human review loop for ambiguous football moments.
- Production deployment with database and object-storage adapters.
