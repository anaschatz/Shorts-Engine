# Session Memory: Hook-First Dynamic Captions + Rights-Safe Styling

Date: 2026-07-04

Decisions:

- Added hook-first, dynamic word-caption and rights-safe styling as enforceable contracts instead of prompt-only guidance.
- Kept copyright safety strict: no mirroring/copyright bypass/watermark hiding/scorebug hiding as a production feature.
- Renderer now writes dynamic ASS dialogue events from `activeWordTiming`, including Greek word highlighting without word-boundary regex failures.
- Final video output QA now reports hook, captions, animations, audio policy and creative style summaries.
- Eval/reference metrics now include first-two-second hook, dynamic caption coverage, short-form caption readability, rights-safe audio and no copyright-evasion behavior.

Validation run during implementation:

- `node --test tests/eval.test.cjs tests/analysis.test.cjs tests/video-output-gate.test.cjs tests/render.test.cjs`
- `npm run eval`
- `npm run eval:reference`
- `node --test tests/reference-review.test.cjs`

Limitations:

- Platform-native music remains manual/operator-side; ShortsEngine does not bundle trending or copyrighted audio by default.
