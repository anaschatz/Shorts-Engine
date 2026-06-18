# Session Memory: Real Goal Evidence Layer

Date: 2026-06-18

## Decisions

- Added a dedicated deterministic goal-evidence provider boundary instead of letting routes or render orchestration infer goals directly.
- Kept paid/external providers opt-in only. Tests, eval, and local demo require no API keys.
- Merged only validated supplemental decision windows into visual signals.
- Added `goalEvidence` health/readiness and eval/report metrics.

## Safety

- No valid goal claim is allowed without explicit ball-in-net plus decision evidence.
- Offside/no-goal evidence excludes valid-goal selection.
- Crowd/commentary/celebration-only evidence stays supportive or non-goal.
- Public reports contain bounded counts and safe reason codes only.

## Tests Added Or Updated

- `tests/goal-evidence-provider.test.cjs`
- `tests/render-job.test.cjs`
- `tests/youtube-runtime.test.mjs`
- `tests/static-lint.mjs`
- `tests/eval.test.cjs` coverage via eval metric shape

## Limitation

The layer improves contracts and deterministic proof quality, but live YouTube goal detection still depends on explicit evidence being available from sampled visual/transcript signals. Provider-backed frame understanding remains the next product milestone for difficult live clips.
