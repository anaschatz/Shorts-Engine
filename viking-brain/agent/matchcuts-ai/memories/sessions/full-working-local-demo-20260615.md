# Session: Full Working Local Demo

Date: 2026-06-15

## Decisions

- Added a deterministic FFmpeg-generated MP4 fixture instead of committing a large binary.
- Added a local API smoke runner that starts the server, validates health, rejects invalid uploads, uploads the fixture, starts a generate/render job, polls terminal lifecycle state, and downloads the completed export.
- Reports are written to `demo/results/latest.json` and timestamped JSON files with leak guards.
- User-facing product naming moved to ShortsEngine while internal `MatchCutsCore` and OpenViking matchcuts URIs remain stable for now.

## Checks To Run

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run brain:health`
- `npm run demo:smoke`

## Limitation

Browser E2E remains a smoke-level verification around visible states. The API harness is now the primary repeatable full local demo check.
