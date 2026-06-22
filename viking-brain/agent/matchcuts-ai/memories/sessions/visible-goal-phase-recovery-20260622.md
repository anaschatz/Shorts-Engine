# Visible Goal Phase Recovery - 2026-06-22

## Decisions

- Added a bounded visible-goal phase recovery layer around score-change anchors.
- Kept scoreboard changes as timeline anchors only; visible finish proof now requires ball-in-net style payoff evidence.
- Demoted replay, celebration, and scoreboard-only windows so they cannot become primary counted-goal segments.
- Preserved safe public diagnostics for why a goal candidate was selected or rejected.

## Verification

- Added unit coverage for live-phase recovery, scoreboard-only rejection, replay-only rejection, shot-without-payoff rejection, and report leak safety.
- Updated match-event truth tests so high motion, crowd reaction, scoreboard context, and cluster recovery do not confirm goals without visible payoff.
- Added an eval fixture for visible goal phase recovery with three counted live-action goal phases.

## Limitation

- The deterministic fixture path is covered. The live YouTube proof for `gxiRyFZXJV8` still fails closed with `NO_VALID_GOALS_FOUND`, because current live evidence does not expose enough confirmed visible-goal candidates. The next milestone should focus on real OCR/vision/provider evidence extraction for that source rather than loosening goal truth rules blindly.
