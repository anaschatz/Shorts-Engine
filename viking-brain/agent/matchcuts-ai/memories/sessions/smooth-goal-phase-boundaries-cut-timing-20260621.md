# Session Memory: Smooth Goal Phase Boundaries + Cut Timing Fix

## Context

The reference comparison loop showed valid goal recall at 3/3 and replay-only count at 0, but `cutSmoothnessScore` was low because live goal segments could start directly at `shotStart`.

## Decisions

- Add bounded pre-action and post-confirmation handles for confirmed goal candidates.
- Keep valid-goals-only selection strict; no offside/no-goal/replay-only promotion.
- Add boundary smoothing metadata to render plans, edit assembly, visual polish QA and reference comparison output.
- Keep reports safe with relative metadata only.

## Validation Targets

- `boundarySmoothingAppliedCount` should equal the counted goal segment count for clean reference cases.
- `abruptCutRiskCount` should remain 0 when each goal has minimum lead-in and confirmation tail.
- `cutSmoothnessScore` should be reported directly by visual polish QA and consumed by reference comparison.
