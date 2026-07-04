# Session Memory: AI Curation + Action-Aware Auto-Framing Foundation

## Decisions

- Added deterministic transcript energy analysis as a domain boundary instead of scattering new keyword heuristics deeper in route or render code.
- Integrated transcript energy into `detectHighlights` ranking/evidence/explainability while preserving no-false-goal safeguards.
- Guarded non-event goal context such as "behind the goal" so replay/location wording cannot become goal evidence.
- Extended crop-plan metadata with action center, crop mode, tracking confidence, max pan speed and safe margins.
- Kept OpenCV/object tracking optional; tests/eval/demo do not require external dependencies.

## Validation Snapshot

- Targeted tests passed: `node --test tests/transcript-energy.test.cjs tests/analysis.test.cjs tests/visual-tracking.test.cjs`.
- Eval passed: `npm run eval`, aggregate score 98 across 38 fixtures.

## Limitations

- This milestone improves the deterministic foundation and reporting contract; it does not add a real OpenCV runtime dependency.
- Full release validation still depends on the existing demo smoke/release gate state for this workspace.
