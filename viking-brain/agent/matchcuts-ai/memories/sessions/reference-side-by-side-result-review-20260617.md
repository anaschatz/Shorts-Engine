# Session Memory: Reference Side-by-Side Result Review

Created: 2026-06-17T14:53:00.000Z

## Summary

- Added an opt-in `npm run demo:compare` runner for comparing a generated ShortsEngine output against a local reference short.
- The runner writes safe JSON reports under `demo/results/` and optional contact sheets under `demo/results/side-by-side-artifacts/`.
- Reports use workspace-relative references only and run through the shared report leak guard.
- Machine scoring covers structural metadata only: readability, aspect ratio, duration, resolution and contact sheet availability.
- Creative quality remains explicit human review: moment choice, caption/action alignment, ball/player framing, editing style and false-goal claim guard.

## Latest Local Result

- Generated result: `manual-downloads/shortsengine-gxiRyFZXJV8-result.mp4`
- Reference short: `manual-downloads/shortsengine-youtube-short.mp4`
- Report: `demo/results/side-by-side-latest.json`
- Machine score: 100
- Human review required: true

## Validation

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`
- `npm run ci:reports`
- `npm run release:check`

## Retrieval Hints

- reference-review
- side-by-side-comparison
- short-form-quality-loop
- football-editing
