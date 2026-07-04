# Session Memory: Fresh Rendered Football Proof + Visual Frame QA

Date: 2026-07-04

Milestone:

- Added a fresh-MP4 visual QA layer for ShortsEngine proof reports.

Implementation decisions:

- Created `demo/rendered-visual-frame-qa.mjs` as the shared visual-frame QA boundary.
- Local proof now requires visual-frame QA after ffprobe and rendered social-polish QA.
- YouTube live proof reports include visual-frame QA and action-framing verdict summaries for operator comparison.
- Frame sampling is bounded and decode-only; no raw frames or raw FFmpeg output are persisted.
- Failed visual-frame QA discards the generated proof MP4 and returns `LOCAL_VIDEO_PROOF_VISUAL_QA_FAILED`.

Safety:

- Reports use safe relative refs under `manual-downloads/`.
- No secrets, absolute paths, raw logs, storage keys, or provider output are included.
- `latest`, `cached`, or unsafe MP4 refs fail closed.

Focused tests:

- `tests/rendered-visual-frame-qa.test.mjs`
- `tests/local-video-proof.test.mjs`
- `tests/rendered-social-proof.test.cjs`
- `tests/youtube-runtime.test.mjs`
