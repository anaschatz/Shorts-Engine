# Real-Source Counted Goal Discovery + Live Proof Render

Date: 2026-06-20

## Purpose

Connect the counted-goals-only truth gate to real-source discovery so long YouTube/source videos do not lose late official goals before rendering.

## Decisions

- Goal evidence and OCR evidence caps use temporal coverage instead of earliest-only truncation.
- Goal-decision evidence is retained before support/filler events, preserving valid, disallowed and unknown goal candidates across the source.
- Match event truth accepts a larger bounded event set so source-wide evidence is not dropped before valid-goals-only selection.
- YouTube smoke reports include a safe counted-goal proof summary with selected valid goals, excluded disallowed/no-goal events, excluded unknowns and final segment windows.

## Safety

- Scoreboard/OCR remains support-only and requires usable calibration plus action evidence.
- Valid-goals-only output still excludes offside, no-goal, unknown, celebration-only, anthem and generic highlight filler.
- Proof reports include no raw logs, artifacts, local paths, storage keys, provider raw output, tokens or secrets.

## Evaluation

- Added a real-source style fixture with three counted goals, two disallowed/offside finishes and a late goal near the end of the source.
- Eval requires valid-goal recall, late-goal recall, offside/no-goal exclusion, exact segment count, chronological ordering and zero filler.
