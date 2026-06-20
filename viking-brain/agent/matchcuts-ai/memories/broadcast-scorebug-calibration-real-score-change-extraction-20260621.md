# Broadcast Scorebug Calibration Session

Date: 2026-06-21

## Decisions

- Added scorebug layout profiles and score-only crop extraction before local OCR/digit parsing.
- Added score-only OCR parsing for compact score strings while rejecting clocks, team text and noisy extra digits.
- Carried `layoutId` and safe `scoreOnlyCropRef` through scoreboard evidence, timeline metadata, goal evidence and QA reports.
- Kept OCR as support-only evidence so it cannot produce false goal confirmation by itself.

## Verification

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed.
- `npm run eval` passed with aggregate score 99 and `scoreboardScoreChangeRecall: 1`.
- `npm run eval:reference` passed with aggregate score 98.
- `npm run feedback:summary`, `npm run brain:health`, `npm run demo:fixture`, `npm run ocr:smoke`, `npm run ocr:qa:review`, `npm run youtube:doctor`, `npm run demo:smoke`, `npm run demo:browser`, `npm run demo:browser:ci`, `npm run ci:reports` and `npm run release:check` passed.

## Live Proof Limitation

- Live YouTube proof for `gxiRyFZXJV8` failed safely with `NO_VALID_GOALS_FOUND`.
- Latest QA showed 37 score-only crop attempts, 1 readable score-only crop and 0 stable score-change events.
- No MP4 was produced because valid counted-goal selection still had no reliable real score-change timeline.

## Next Step

- Use the saved score-only QA crop refs to build real broadcast digit calibration or a provider-backed digit adapter.
- Do not spend more milestones on generic goal-selection heuristics until the live score-change extraction is reliable.
