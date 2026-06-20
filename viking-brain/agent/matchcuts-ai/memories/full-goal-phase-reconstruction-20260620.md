# Full Goal Phase Reconstruction Session

Date: 2026-06-20

## Decisions

- Reconstructed confirmed-goal windows around the live phase instead of the replay/payoff peak.
- Demoted replay-only and celebration-only candidates before valid-goals-only edit-plan generation.
- Preserved goal phase metadata through analysis and edit-plan normalization.
- Added eval metrics for full phase coverage and replay-only goal rate.
- Restored old OpenViking dirty files to their tracked content and kept this milestone in separate scoped brain files.

## Verification

- Focused analysis and eval tests passed.
- Full local validation passed: lint, build, tests, eval, reference eval, feedback summary, brain health, CI report validation and release check.
- YouTube doctor passed in safe skipped mode because ingest is disabled by default.

## Limitation

- Live YouTube proof for the test link was blocked before ingest/render by local server readiness timeout, so no new MP4 was produced in that run.
