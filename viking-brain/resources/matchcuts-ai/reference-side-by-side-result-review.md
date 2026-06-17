# Reference Side-by-Side Result Review

## Purpose

ShortsEngine now has an opt-in local comparison runner for reviewing a generated short against a reference short without pretending that metadata proves creative quality.

## Command

```bash
npm run demo:compare
```

Default local inputs:

- Generated result: `manual-downloads/shortsengine-gxiRyFZXJV8-result.mp4`
- Reference short: `manual-downloads/shortsengine-youtube-short.mp4`

Custom inputs can be passed as safe workspace-relative `.mp4` references:

```bash
npm run demo:compare -- --generated=manual-downloads/result.mp4 --reference=manual-downloads/reference.mp4
```

Operator review input can be attached without adding binary artifacts to the repo:

```bash
npm run demo:compare -- --review=demo/reviews/example-side-by-side-review.json
```

## Output

The runner writes ignored local reports:

- `demo/results/side-by-side-latest.json`
- `demo/results/side-by-side-<timestamp>.json`
- optional contact sheets under `demo/results/side-by-side-artifacts/`

Reports include only safe relative references. They must not include absolute local paths, raw logs, provider output, storage keys, tokens or external artifacts.

## Metrics

The machine score covers structural checks only:

- generated/reference readability
- vertical short-form aspect ratio fit
- duration fit
- resolution fit
- contact sheet availability

The human review rubric scores creative/product quality from `0` to `5`:

- `moment_selection`
- `caption_action_alignment`
- `ball_player_framing`
- `reference_style_editing`
- `false_goal_guard`
- `hook_strength`
- `pacing_energy`
- `text_readability`
- `replay_or_context_use`
- `overall_short_quality`

Without a review JSON, reports keep `quality.qualityStatus` as `pending_human_review` and list every pending criterion. With a valid review JSON, reports include `humanScore`, `combinedScore`, per-criterion status, failed criteria, penalties and improvement hints.

## Product Readiness Rules

The combined score is not allowed to pass just because the video is structurally correct. Critical review flags reduce product readiness:

- `falseGoalClaim` heavily caps the combined score and fails `false_goal_guard`.
- `wrongMoment` fails product readiness and points to highlight ranking.
- `badCrop` fails product readiness and points to crop/framing strategy.
- `captionMismatch` fails caption quality and points to caption/action planning.
- `lowEnergy` and `missingTrendEditing` reduce score and point to pacing/style renderer work.

Reports continue to be safe JSON: no absolute paths, raw logs, provider output, storage keys, tokens or raw local artifacts.

## Decision

This is not a release gate because the reference videos live in `manual-downloads/` and are local operator assets. Keep it opt-in until stable fixture videos can be committed or generated deterministically.

The review loop is the bridge between product feedback and AI improvement. Use failed criteria and `improvementHints` to decide whether the next milestone should focus on highlight ranking, caption/action alignment, framing, or reference-style editing.
