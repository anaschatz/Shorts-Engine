# ShortsEngine Autoresearch

This is the local autonomous research loop for improving ShortsEngine quality while preserving football truth and safety gates.

## Objective

Improve the composite research score:

```text
0.55 * eval:reference aggregateScore
+ 0.35 * eval aggregateScore
+ 0.10 * focused domain test score
```

The score is only eligible to advance when all hard gates pass and safety guardrails do not regress.

## Setup

1. Start from a clean understanding of the current code and metrics.
2. Read this file, `README.md`, `eval/README.md`, and the relevant domain files before editing.
3. Establish a baseline:

```bash
npm run research:short:baseline
```

4. Make one small hypothesis-driven code change.
5. Run the research gate:

```bash
npm run research:short -- --description="short explanation of the experiment"
```

Generated research artifacts are intentionally ignored by git:

- `shortresearch/baseline.json`
- `shortresearch/latest.json`
- `shortresearch/results.tsv`
- `shortresearch/runs/`

## Editable Scope

Prefer small changes in these files:

- `server/analysis.cjs`
- `server/caption-generation.cjs`
- `server/football-story-planner.cjs`
- `server/edit-plan.cjs`
- `server/visual-tracking.cjs`
- `server/scorebug-calibration.cjs`
- focused tests that lock in a real behavior improvement

## Do Not Edit

Do not tune the measuring stick during an experiment:

- `eval/fixtures/`
- `eval/reference-fixtures/`
- `eval/scoring.cjs`
- `eval/reference-rubric.cjs`
- generated reports

Changing the rubric or fixtures is a separate evaluation-design task, not an autoresearch experiment.

## Hard Guardrails

Discard the experiment if any of these regress:

- `noFalseGoalClaim`
- `captionActionAlignment`
- `framingSafety`
- `cropSafetyScore`
- `noFalseGoalFromOcrOnly`

Discard the experiment if any of these increase:

- `falseGoalRate`
- `falseVisualGoalRate`
- `falseGoalCaptionRate`
- `matchEventTruthFalseGoalRate`
- `textObstructionRisk`

Also discard if lint, build, eval, reference review, or focused tests fail.

## Experiment Loop

For each experiment:

1. Inspect the current metrics and weak spots.
2. Make one scoped change.
3. Run `npm run research:short -- --description="..."`.
4. Keep the change only when the runner returns `status: "keep"`.
5. If the runner returns `discard`, revert only the experiment change you just made.
6. Record what was learned in the next experiment description.

The goal is steady evidence-backed improvement, not broad rewrites.
