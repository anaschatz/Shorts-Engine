# Scoreboard Change Live Phase Binding Proof

## Decision

ShortsEngine should anchor valid-goals-only YouTube proof to observed stable scoreboard transitions, not generic high-energy moments. A confirmed score transition is valid only when exactly one score side increments by one and the new score remains stable. Home and away goals are both valid; the engine must not hardcode a source-specific progression.

## Implementation Notes

- `server/render-job.cjs` now carries `changedSide` on chunked scorebug progression evidence and diagnostics.
- Score-change candidate windows now include a deeper `scorebug_first_live_phase_backtrack` probe 24 seconds before each stable score change, so frame analysis searches the live phase before the scoreboard update.
- `server/scoreboard-ocr.cjs` public OCR diagnostics expose safe `changedSide` metadata for operator review without raw OCR/log/path leakage.

## Proof

Live rights-confirmed proof for `WuuGus5Obkg` passed after increasing the operator download cap:

- Expected confirmed goals: 5
- Counted goals found: 5
- Counted goals included: 5
- Covered goals: 5
- Missing goals: []
- Output MP4: `manual-downloads/shortsengine-youtube-WuuGus5Obkg-2026-07-07T23-05-58-740Z.mp4`
- ffprobe: 120.75s, 1080x1920, h264 video, aac audio

The proof report preserved the observed score path as evidence: `0-0 -> 1-0 -> 1-1 -> 2-1 -> 2-2 -> 3-2`.

## Validation

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run youtube:doctor`
- `npm run ocr:smoke`
- `npm run ocr:qa:review`
- `npm run ci:reports`
- `npm run release:check`
- `npm run brain:health`
- Live YouTube proof with explicit rights flags
