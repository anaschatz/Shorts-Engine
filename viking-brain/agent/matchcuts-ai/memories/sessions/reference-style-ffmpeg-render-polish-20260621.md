# Reference-Style FFmpeg Render Polish - 2026-06-21

Milestone implemented:

- Added `reference_football_multi_goal_v1` as a validated render style preset.
- Routed valid-goals-only multi-goal compilations to the reference football style.
- Added render-polish QA metadata for transitions, caption motion, overlays, style preset, dimensions and warnings.
- Timed numbered confirmed-goal overlays near confirmation windows, not at segment start.
- Preserved safe render QA metadata through public job serialization.
- Updated YouTube live proof reports to expose render-polish metrics at top level.

Live proof:

- Source: `gxiRyFZXJV8`
- Output: `manual-downloads/shortsengine-youtube-gxiRyFZXJV8-2026-06-21T15-20-19-683Z.mp4`
- FFprobe: passed, 1080x1920, 88.5 seconds
- Counted goals found/included/expected: 3/3/3
- Replay-only segments: 0
- Render style preset: `reference_football_multi_goal_v1`
- Rendered transitions: 2
- Hard-cut fallbacks: 0
- Animated captions: 5
- Static caption fallbacks: 0
- Overlays rendered: 5
- Overlay fallbacks: 0

Validation:

- `npm run lint`: passed
- `npm run build`: passed
- `npm test`: passed, 681/681
- `npm run eval`: passed, aggregate score 98
- `npm run eval:reference`: passed, aggregate score 98
- `npm run feedback:summary`: passed
- `npm run demo:fixture`: passed
- `npm run ocr:smoke`: passed safely
- `npm run ocr:qa:review`: passed safely
- `npm run demo:smoke`: passed
- `npm run demo:browser`: passed
- `npm run demo:browser:ci`: passed
- `npm run ci:reports`: passed
- `npm run release:check`: passed
- `npm run youtube:doctor`: passed/skipped safely because YouTube ingest remains disabled by default
- Live `youtube:proof:operator`: passed

Limitations:

- Transitions are rendered with the existing safe segment fade + concat strategy, not true FFmpeg `xfade` graph composition.
- Visual/reference style score is still partly heuristic; this milestone proves visible render polish metadata and output wiring, not final creative parity with reference Shorts.
- YouTube ingest remains opt-in for live proof and disabled by default for normal local/release checks.
