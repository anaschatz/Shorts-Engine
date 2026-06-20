# Valid Goal Evidence Recovery - 2026-06-20

Implemented a safe combined evidence path for counted-goal recovery when OCR is unavailable.

Key outcomes:
- `combined_goal_confirmation` now requires live shot/finish evidence plus explicit confirmation support.
- Crowd reaction remains useful context but cannot confirm a counted goal by itself.
- Match-event truth exposes safe truth details for combined evidence.
- Valid-goals-only edit planning can use combined evidence to produce 3/3 counted-goal plans.
- YouTube `valid_goals_only` proof can recover bounded source-wide action clusters when OCR-backed valid goals are unavailable, while marking the path as production review-worthy fallback evidence.
- Eval fixture `032_combined_goal_evidence_recovery` covers 3 valid goals, one offside/no-goal, and a replay-only window.

Validation snapshot:
- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed with 630 tests.
- `npm run eval` passed with aggregate score 99 and passRate 1.
- `npm run eval:reference` passed with aggregate score 98 and passRate 1.
- `npm run feedback:summary`, `npm run brain:health`, `npm run youtube:doctor`, `npm run demo:fixture`, `npm run demo:smoke`, `npm run demo:browser`, `npm run demo:browser:ci`, `npm run ocr:smoke`, `npm run ocr:qa:review`, `npm run ci:reports`, and `npm run release:check` passed.
- Live YouTube proof for `gxiRyFZXJV8` passed and produced `manual-downloads/shortsengine-youtube-gxiRyFZXJV8-2026-06-20T13-37-07-578Z.mp4` with 3/3 counted goals included, 0 replay-only segments, 1080x1920 H.264 video, and audio present.

Limitations:
- The live proof still relies on deterministic fallback cluster recovery when OCR/provider evidence is unavailable; real provider-backed scoreboard/vision evidence remains the production next step.
