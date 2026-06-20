# Real-Source Counted Goal Discovery Session

Date: 2026-06-20

## Decisions

- Replaced earliest-only OCR evidence truncation with temporal coverage to avoid losing late score changes.
- Added source-wide goal evidence selection so critical goal decisions are prioritized over support/filler events.
- Added safe counted-goal proof details to YouTube smoke output for operator comparison.
- Added tests for late source-wide counted goal retention, live proof report shape and a three-counted-goal eval fixture.

## Validation Intent

- Focused tests cover goal evidence provider, eval scoring and YouTube proof report shape.
- Full release validation must still run lint, build, tests, eval/reference, feedback, brain health, demo/browser gates, CI reports and release check before commit/push.
