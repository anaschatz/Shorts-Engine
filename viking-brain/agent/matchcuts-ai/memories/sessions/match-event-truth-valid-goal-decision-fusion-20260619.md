# Session: Match Event Truth Layer + Valid Goal Decision Fusion

## Decisions

- Added a dedicated match-event truth layer before highlight ranking and render planning.
- Fused goal evidence, visual signals, media spikes, transcript cues and OCR QA support into validated event truth.
- Kept OCR, scoreboard, crowd and replay evidence support-only so they cannot create false confirmed goals.
- Preserved disallowed/offside ball-in-net events as important goal-phase moments while keeping the outcome explicit and safe.
- Required confirmed-goal candidates to include action/payoff evidence so replay-only or scoreboard-only moments do not become goal clips.
- Filtered public reason codes separately from internal evidence to keep reports useful without leaking noisy provider/OCR details.

## Focused Checks Passed

- `node -c server/match-event-truth.cjs`
- `node --test --test-concurrency=1 tests/match-event-truth.test.cjs`
- `node --test --test-concurrency=1 tests/render-job.test.cjs`
- `node --test --test-concurrency=1 tests/analysis.test.cjs`
- `node --test --test-concurrency=1 tests/eval.test.cjs`
- `node --test --test-concurrency=1 tests/static-lint.mjs`

## Limitations

- The truth layer is deterministic by default; a provider-backed event truth adapter can be added later behind the same validation boundary.
- Human review remains useful for ambiguous broadcast decisions, unclear referee signals or missing camera context.
