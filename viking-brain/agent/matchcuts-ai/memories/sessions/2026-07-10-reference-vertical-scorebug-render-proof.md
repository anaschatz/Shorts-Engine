# Session Memory: Reference Vertical Scorebug Render Proof

Created: 2026-07-10

## Summary

Replaced the valid-goal proof letterbox layout with a full-height portrait crop plus a validated live scorebug overlay. Added strict edit-plan validation, renderer metadata, output-gate contracts, safe public report propagation, and tests that reject missing or spoofed scorebug layout evidence.

The live proof initially exposed two report mismatches: the public summary dropped `reference_fill`, and stale pre-render cut flags overrode 4/4 rendered fades. Both were fixed without relaxing goal visibility gates. A confirmation fallback is allowed only when pre-shot, finish, and payoff frames are clear and the validated scorebug was rendered.

Final rights-confirmed proof passed with five visible goals, full-screen `9:16` framing, score visible at the top, social polish score 100, and no missing goals.

## Validation

- lint, build, and 1019 tests passed
- eval: 98
- reference eval: 98
- live YouTube proof: passed
- CI reports: passed
- release check: passed
- brain health: passed

## Limitation

The research gate returned neutral `discard` because its fixtures do not score final render pixels; it reported no hard-gate or guardrail regression.
