# Session: Multi-Moment Football Short Builder

## Decisions

- Added a multi-moment compilation path instead of replacing the single-moment path.
- Kept single-moment rendering as fallback for short/sparse sources.
- Extended edit-plan validation with a segment contract, overlap checks, total-duration bounds and opening-context rejection for non-action segments.
- Render strategy cuts bounded temp segment MP4s, concatenates them, then runs the existing caption/effects renderer over the joined timeline.
- Evaluation/report logic now treats `totalDuration` and `segments` as first-class fields.

## Safety

- No false-goal language is generated for compilation captions.
- Compilation defaults to wide-safe vertical framing.
- Opening filler is filtered before segment selection.
- Reaction-only moments can be selected only as support with lead-in windows and safety flags.

## Tests Added

- Analysis test for chronological multi-moment compilation without intro filler.
- Render test for segment cutting, concat and final caption pass with mocked FFmpeg.

## Limitations

- Segment ranking still depends on deterministic media/vision/caption signals; stronger provider-backed understanding can improve moment quality later.
- UI segment timeline display is not changed in this milestone.
