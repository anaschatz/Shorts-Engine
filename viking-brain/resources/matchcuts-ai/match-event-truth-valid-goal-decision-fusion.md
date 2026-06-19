# Match Event Truth Layer + Valid Goal Decision Fusion

Date: 2026-06-19

## Purpose

ShortsEngine should decide football event truth before ranking highlights or writing captions. The truth layer fuses visual goal evidence, media signals, transcript cues, scoreboard/OCR QA support and outcome rules into safe event types so the editor can show valid goals, disallowed goals, big chances and reactions without claiming goals that are not proven.

## Runtime Boundaries

- `server/match-event-truth.cjs` owns the event taxonomy, strict validation, safe public projection and leak guards.
- `server/render-job.cjs` runs match-event truth after goal evidence/OCR QA and before highlight detection/edit-plan generation.
- `server/analysis.cjs` converts truth events into ranked moments while keeping confirmed/disallowed/possible outcomes separate from visual phase labels.
- `eval/scoring.cjs` gates valid-goal recall, late-goal recall, disallowed-goal classification and false-goal rate.

## Safety Contract

- OCR and scoreboard text are support-only; they cannot confirm a goal by themselves.
- Crowd reaction, commentator intensity, replay and celebration signals are support-only unless paired with action/payoff and decision evidence.
- Confirmed goals require explicit action/payoff evidence plus safe decision support.
- Disallowed/offside ball-in-net events can be shown as important goal-phase highlights, but captions and metadata must say `OFFSIDE - NO GOAL` or equivalent safe outcome language.
- Unknown or weak evidence must become `possible_goal_unconfirmed`, `big_chance`, `crowd_reaction`, `replay` or `neutral`, never `confirmed_goal`.
- Public reports/loggable output must not expose raw OCR, raw provider output, absolute paths, storage keys, tokens, stdout or stderr.

## Metrics

- `matchEventTruthValidGoalRecall`
- `matchEventTruthLateGoalRecall`
- `matchEventTruthDisallowedClassification`
- `matchEventTruthFalseGoalRate`

## Next Step

Provider-backed truth can plug into this boundary later, but the local/eval default remains deterministic and safe so tests, demos and CI do not require API keys.
