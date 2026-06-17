# Reference-Style Football Edit Planner - 2026-06-17

## Decisions

- Added `server/football-story-planner.cjs` as a dedicated product/AI planning boundary.
- Kept goal claims evidence-gated; visual-only or title-only goal language is downgraded to no-goal chance/reaction language.
- Added `styleTarget` support for `vertical_9_16`, `square_1_1` and `auto`.
- Added `editIntensity` support for `clean`, `balanced` and `punchy`.
- Updated render validation and FFmpeg rendering to support 1080x1920 and 1080x1080 MP4 exports.
- Replaced hardcoded end caption copy with story-plan closing copy.
- Added UI controls for ratio target and creator pacing intensity.

## Tests Added / Updated

- `tests/football-story-planner.test.cjs`
- `tests/analysis.test.cjs`
- `tests/backend.test.cjs`
- `tests/render-job.test.cjs`
- `tests/validation.test.js`
- `tests/eval.test.cjs` via scoring changes and fixture contract

## Guardrails

- No false goal captioning from title text like `goal area` or `without goal claim`.
- Unsupported animation cues are recorded as unsupported and do not fail the render pipeline.
- Square output is validated with matching export dimensions.
- Frontend completed-job validation now accepts relative caption timings.

## Limitations

- No real ball/player tracking yet.
- Advanced visual effects such as true beat-synced zoom/freeze-frame are metadata-first in this milestone.
- `auto` format selection still resolves conservatively until more style evidence is available.
