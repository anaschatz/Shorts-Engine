# Long Source Goal Coverage + Temporal Sampling

Date: 2026-06-18

Decision:
- Long football sources must sample candidate windows across the full source timeline instead of taking the first FFmpeg scene/audio candidates.
- Multi-moment compilation must include every detected ball-in-net/goal coverage candidate before adding filler phases, bounded by max segment/duration caps.
- Tiny edge overlaps between adjacent selected segments are tolerated so rounded windows do not drop a valid nearby phase.
- Goal coverage moments must stay prioritized when building candidate edit plans, even if generic signal moments have higher scores.
- Multi-moment segments should include bounded pre/post handles so the viewer sees build-up and payoff instead of abrupt isolated cuts.
- Multi-segment rendering applies short bounded video fades to extracted segments before concat to reduce hard visual cuts without requiring fragile crossfade graphs.

Validation:
- `tests/analysis.test.cjs` covers late media candidates, late visual candidates, and three confirmed goals included before filler.
- `tests/frame-extraction.test.cjs` covers frame sampling across long candidate timelines.
- `tests/render.test.cjs` covers per-segment video fades in multi-segment rendering.
- Live YouTube proof produced a new 5-segment, 77.5s compilation with longer phase windows and timestamps spread across the source.

Limitation:
- In local fallback mode, vision/transcription may still label real goals as `unknown_action` because no real provider has explicit ball-in-net evidence. The coverage layer can preserve detected goals, but it cannot safely invent goal labels without explicit evidence.
