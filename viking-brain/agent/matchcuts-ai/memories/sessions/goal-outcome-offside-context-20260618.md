# Session: Goal Outcome + Offside Decision Context

## Decisions

- Added goal outcome modeling instead of weakening the no-false-goal guard.
- Ball-in-net moments now carry decision status: confirmed, disallowed offside, possible offside or unknown.
- Post-goal windows keep bounded decision context so flag/offside/VAR/no-goal evidence can be detected.
- Multi-moment segments preserve per-segment outcome metadata.
- ASS subtitles render small outcome badges and avoid confirmed-goal language for disallowed or unclear goals.

## Tests Added

- Offside goal remains included and gains post-context.
- Unknown ball-in-net stays neutral.
- Invalid offside/outcome combinations fail validation.
- Rendered ASS includes offside outcome badge and no confirmed-goal copy.

## Limitations

- Decision detection is deterministic and evidence-based; provider-backed referee/offside understanding can improve recall later.
- Human review is still useful for ambiguous broadcast decisions.
