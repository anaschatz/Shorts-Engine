# Session Memory: Football-Aware Highlight Style v1

Date: 2026-06-17

## Decisions

- Replaced broad `goal_like_phrase` style detection with canonical `goal` evidence and football-aware highlight types.
- Added context-aware goal language guard so no-goal phases do not get goal hooks/captions.
- Default candidate plans now use `social_sports_v1`, caption emphasis, animation cues, and `wide_safe` framing metadata.
- Render path uses wide-safe blurred-fill composition for landscape sources so the full action remains visible instead of aggressive center crop.
- UI shows safe highlight type and style chips instead of hardcoded goal language.

## Evaluation

- Expanded fixtures from 6 to 9.
- Added no-goal fixtures for hard foul, audio spike without semantic certainty, and generic pressure.
- Added metrics for false-goal caption rate, highlight type accuracy, caption safety, framing safety, and animation cue validity.
- Dry-run aggregate score was 100 with `falseGoalCaptionRate: 0` before full validation.

## Tests

- Focused suite passed locally: 87/87 across analysis, backend, render job, eval, cloud staging, S3 adapter, and validation tests.

## Limitations

- No real ball/player tracking yet.
- `social_sports_v1` is deterministic template editing, not creative multimodal editing.
- Next milestone should add a real visual/action analysis adapter and compare it against the deterministic baseline.
