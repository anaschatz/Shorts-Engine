# Real Video Review Loop

## Purpose

ShortsEngine now has a local, deterministic review layer for real generated shorts. It bridges synthetic eval fixtures, reference-style rubric scoring, and operator feedback by comparing one generated short against source media plus an optional reference short/style target.

## Commands

```bash
npm run review:compare
npm run review:summary
```

`review:compare` reads `eval/review-fixtures/demo-reference-style-review.json` by default and writes safe JSON to `eval/review-results/`.

Custom fixtures can be passed with:

```bash
npm run review:compare -- --input=eval/review-fixtures/my-review.json
```

`review:summary` aggregates review comparison reports in `eval/review-results/`.

## Input Contract

Review fixtures include:

- `media.generated`
- `media.source`
- optional `media.reference`
- `expected.styleTarget`
- `expected.momentType`
- `expected.aspectRatio`
- `expected.durationRange`
- `expected.captionMustMentionAny`
- `expected.requiredAnimationCues`
- `expected.safety.noFalseGoalClaim`
- `generatedMetadata.selectedMoment`
- `generatedMetadata.editPlan`
- `consent.rightsConfirmed`
- optional `humanReview`

All media refs must be workspace-relative. Raw external URLs, absolute local paths, storage keys, provider output, logs, secrets and raw artifacts are rejected from reports.

## Metrics

The runner reports:

- `momentTypeMatch`
- `noFalseGoalClaim`
- `captionActionAlignment`
- `captionSpecificity`
- `framingSafety`
- `aspectRatioCorrectness`
- `pacingScore`
- `animationCueCoverage`
- `referenceStyleSimilarity`
- `reviewerReadinessScore`
- `overallScore`

No reference video is required for the default fixture. If `media.reference` is `null`, the report uses `reference_style_rubric` mode and keeps the comparison deterministic.

## Human Review Bridge

Optional `humanReview` captures operator checks:

- selected moment correct
- caption matches action
- ball/player visible
- text obstructs action
- animation feels reference-like from 1 to 5
- false claim
- notes

Human review changes the report only. It does not mutate fixtures, provider behavior, model prompts or training data.

## Safety Decisions

- No API keys or network are required.
- Reports are ignored by git under `eval/review-results/*.json`.
- Missing media, path traversal, unsupported extensions, missing rights confirmation and false goal claims fail closed.
- Reports include relative media refs only and set `logsDownloaded: false`, `artifactsDownloaded: false`, `rawProviderOutputIncluded: false`, and `trainingDataMutation: false`.

## Next Use

Use this loop after generating a real ShortsEngine output from YouTube/link ingest. Add a local review fixture that points to safe workspace-relative operator media, score it, then use failed criteria to prioritize the next AI/product milestone.
