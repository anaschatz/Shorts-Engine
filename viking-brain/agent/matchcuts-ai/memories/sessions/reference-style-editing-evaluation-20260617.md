# Session Memory: Reference-Style Editing Evaluation

Date: 2026-06-17

Decisions:
- Added a deterministic reference-style review layer separate from the main eval runner.
- Kept scoring based on analysis/edit-plan metadata instead of reading final MP4s.
- Added 8 synthetic reference fixtures covering football chance, crowd reaction, save, hard foul, counter attack, replay-heavy detail, scoreboard-only no-goal context and high-noise commentary.
- Added review metadata to candidate edit plans for render style, caption roles, animation cues, target aspect ratio, highlight type, forbidden claim checks, framing and evidence summaries.

Metrics:
- `npm run eval:reference` reports aggregate reference quality, pass rate, failed/borderline counts and key rubric metrics.
- False goal claims are a hard penalty in no-goal fixtures.
- Captions and animations are scored for relevance, not only schema validity.

Validation notes:
- Targeted reference review tests passed after tightening hook strength to require an `opening_hook` caption role.
- Full validation should include `npm run lint`, `npm run build`, `npm test`, `npm run eval`, `npm run eval:reference`, `npm run brain:health`, `npm run ci:reports` and `npm run release:check`.
