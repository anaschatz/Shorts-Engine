# Scorebug Evidence to Counted Goal Truth Integration

## Purpose

Connect decoded scorebug/OCR evidence to the match-event truth layer so stable score increases can become counted-goal truth events, while reverted or noisy score changes fail closed.

## Contract

- Score observations expose timestamp, score before/after, confidence, source, decoder status, segmentation status, stability, and safe reason codes.
- Score changes expose start score, end score, change time, team side, delta, confidence, persisted duration, revert status, and outcome.
- Stable score increases with live action become `counted_goal` candidates.
- Score increases that revert back become `disallowed_goal` candidates.
- Ambiguous/noisy OCR becomes `uncertain_review` and must not enter the final short as a counted goal.

## Safety Rules

- OCR alone does not create a confirmed goal.
- A confirmed scorebug goal requires live-action shot evidence and either strong OCR QA or decoder-backed/digit-reader scorebug evidence.
- Replay-only and celebration-only score changes are rejected as primary goal segments.
- Public reports include only safe counts and relative metadata, not crop paths, raw OCR text, provider output, or secrets.

## Validation

- Unit tests cover stable counted goals, reverted goals, noisy OCR, late goal coverage, and replay-only rejection.
- Eval fixture `035_scorebug_truth_integration_live_blocker.json` covers three counted goals, one reverted no-goal, decoder-backed scorebug evidence, and full-phase segment selection.
