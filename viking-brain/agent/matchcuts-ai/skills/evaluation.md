# Skill: Evaluation

Use promptfoo-style evaluation thinking for captions, hooks, and generated edit plans.

Evaluate:

- Hook clarity in first 2 seconds.
- Caption accuracy and language fit.
- Copyright/safety warnings.
- No fabricated sports events.
- Stable output format.
- Regression cases for failed upload, missing captions, and failed render.
- Register a completed generated render as a local review draft with `npm run review:register -- --project=<project-id> --job=<job-id> --rights-confirmed=1`.
- Real generated short review with `npm run review:compare`.
- Aggregate real-video review reports with `npm run review:summary`.

Review generated shorts against:

- moment type and no-false-goal safety.
- caption/action alignment and caption specificity.
- ball/player framing, aspect ratio and pacing.
- reference-style animation cue coverage.
- optional human review notes without mutating fixtures or training data.
