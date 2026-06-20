# Valid Goal Evidence Recovery

## Purpose

Recover counted goals in long football highlights when OCR is unavailable or unusable, while preserving the no-false-goal guard.

## Decisions

- A ball-in-net sequence can become a counted goal only when live shot/finish evidence is paired with explicit confirmation support.
- Crowd reaction is context/ranking support only. It must not be enough to create `combined_goal_confirmation`.
- Accepted combined confirmation support includes restart/kickoff, replay confirmation, explicit commentary confirmation, scoreboard/referee confirmation, or trusted score-change evidence.
- Offside/no-goal disqualifiers override combined confirmation.
- Long YouTube sources may use bounded source-wide candidate cluster recovery only in `valid_goals_only` mode, only when normal confirmed-goal evidence is empty, and only with action-plus-support signals.
- Candidate cluster recovery is marked as review-worthy production fallback evidence; it must not be treated as a replacement for real OCR/vision provider confirmation.
- Diagnostics should expose safe candidate summaries for empty valid-goal selection without paths, secrets, raw provider output, or raw logs.

## Validation

- Added an eval fixture for 3 counted goals recovered without OCR.
- Added regressions for crowd-only ball-in-net sequences staying unconfirmed.
- Added regressions for bounded YouTube cluster recovery and for non-YouTube/crowd-only recovery staying closed.
- Added a goal-outcome timing guard so payoff evidence slightly beyond a candidate window cannot create invalid decision windows.
