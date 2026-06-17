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
- Register the same completed generated render from the operator UI or `POST /api/review/register` only after export success and rights confirmation.
- Convert failed or borderline review metrics into safe operator fix suggestions without automatic regeneration.
- Convert review fix suggestions into manual-only regeneration drafts; never treat a draft as render approval.
- Evaluate regeneration approvals as a separate gate: draft creation is not render approval, and approved render jobs must use the validated draft plan.
- Real generated short review with `npm run review:compare`.
- Aggregate real-video review reports with `npm run review:summary`.
- Run authorized live proof visual review with `npm run demo:human-review` after `npm run youtube:proof:operator`.
- Use the Human review UI or `POST /api/review/human` to apply explicit 0-5 operator scores; product readiness must stay false without valid human review.
- Treat `textBlocksAction`, `missingPayoff` and `reactionOnly` as critical flags that block product readiness alongside false goal, wrong moment, bad crop and caption mismatch.

Review generated shorts against:

- moment type and no-false-goal safety.
- caption/action alignment and caption specificity.
- ball/player framing, aspect ratio and pacing.
- reference-style animation cue coverage.
- action sequence, shot/contact, payoff timing, reaction-as-support and text obstruction in the human visual checklist.
- optional human review notes without mutating fixtures or training data.
