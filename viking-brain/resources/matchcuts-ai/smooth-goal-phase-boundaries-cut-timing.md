# Smooth Goal Phase Boundaries + Cut Timing Fix

## Decision

Confirmed-goal compilation segments must include bounded action lead-in and confirmation tail before they are rendered or scored as reference-style shorts.

## Contract

- Counted goals remain selected from match-event truth only.
- Goal segments must stay chronological and non-overlapping.
- Replay-only, celebration-only, offside and no-goal segments remain excluded.
- Segment starts should target 6s before `shotStart`, with a 2s minimum.
- Segment ends should target 2.4s after `confirmationTime`, with a 1.2s minimum.
- Reference QA must expose `boundarySmoothingAppliedCount`, average pre/post padding and `cutSmoothnessScore`.

## Safety Notes

- Boundary smoothing is bounded by source duration and total compilation duration.
- The smoother does not promote weak candidates or infer goals.
- If padding cannot be safely added, QA reports the insufficient boundary instead of hiding it.
