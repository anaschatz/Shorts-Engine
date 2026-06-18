# Multi-Moment Football Short Builder

## Purpose

ShortsEngine should prefer a longer football short made from several strong match phases when the source contains enough usable moments. A single-moment short remains the fallback for short or sparse sources.

## Contracts

- `detectHighlights` may return up to 7 bounded moments.
- `createCandidateEditPlans` may put a `mode: "multi_moment_compilation"` plan first when it can safely select 3-7 chronological segments and 35-60 seconds total duration.
- Multi-moment plans include validated `segments` with source/timeline timing, highlight type, reason codes, confidence, why-selected text and safety flags.
- The renderer cuts each segment into temp clips, concatenates them, then applies the existing caption/effects pass over the combined timeline.

## Safety Rules

- Exclude opening ceremony, hymns and generic intro context unless explicit action evidence exists.
- Prefer action moments over crowd-only reactions.
- Treat reaction-only evidence as support; include it only with an action lead-in window.
- Do not use goal language unless explicit goal evidence exists.
- Use wide-safe vertical framing for compilation output to avoid cutting ball/player context across mixed phases.
- Keep temp render artifacts inside configured output staging and clean them after render.

## Evaluation Notes

Reports should expose `mode`, `selectedMomentCount`, `totalDuration` and safe segment timestamps. Caption timing must use `totalDuration` for multi-moment plans, not raw `sourceEnd - sourceStart`.
