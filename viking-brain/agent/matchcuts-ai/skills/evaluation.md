# Skill: Evaluation

Use promptfoo-style evaluation thinking for captions, hooks, and generated edit plans.

Evaluate:

- Hook clarity in first 2 seconds.
- Caption accuracy and language fit.
- Copyright/safety warnings.
- No fabricated sports events.
- Stable output format.
- Regression cases for failed upload, missing captions, and failed render.
- Real generated short review with `npm run review:compare`.
- Aggregate real-video review reports with `npm run review:summary`.

Review generated shorts against:

- moment type and no-false-goal safety.
- caption/action alignment and caption specificity.
- ball/player framing, aspect ratio and pacing.
- reference-style animation cue coverage.
- optional human review notes without mutating fixtures or training data.
