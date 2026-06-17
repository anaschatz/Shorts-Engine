# Reference-Style Football Edit Planner

## Goal

ShortsEngine now has a dedicated football story planning layer for creator-style sports shorts.
The first implementation is intentionally conservative: it improves hook/caption/format/cue planning without claiming real ball or player tracking.

## Boundary

The planner lives in `server/football-story-planner.cjs`.
It accepts title/context, transcript language, selected highlight moments, media metadata, visual evidence summary, style target and edit intensity.

It returns:

- `storyType`
- `primarySubject`
- `hook`
- `contextLine`
- `selectedMoment`
- `supportingMoments`
- `captionBeats`
- `framingIntent`
- `animationIntent`
- `animationCues`
- `aspectRatio`
- `export`
- `confidence`
- `safetyNotes`

## Product Behavior

The planner replaces generic crowd captions with moment-specific captions.
Examples:

- chance: `Almost punished them`
- save: `Huge save`
- foul: `That was heavy`
- counter: `The break is on`
- crowd reaction: `The crowd felt that`
- replay: `Look at the timing`

Greek captions are supported when the language signal is Greek.

## Format Targets

Supported style targets:

- `vertical_9_16`
- `square_1_1`
- `auto`

`vertical_9_16` renders 1080x1920.
`square_1_1` renders 1080x1080.
`auto` currently falls back to safe vertical output until a stronger format selector exists.

## Safety Rules

- Never claim `goal` without explicit goal evidence.
- Titles containing goal language, such as "without goal claim", must not leak into no-goal captions.
- Visual evidence can rank chance/save/foul/counter/replay/crowd moments, but does not permit goal claims by itself.
- Default framing remains wide-safe to avoid losing ball/player context.
- Animation cues are bounded and unsupported cue types are ignored with metadata instead of crashing render.

## Render Contract

`server/render.cjs` now reads the export dimensions from the validated edit plan.
The ASS subtitle canvas supports 9:16 and 1:1.
The end beat comes from the story plan instead of a hardcoded `RUN IT BACK`.

## Eval

The eval runner now accepts fixture-specific expected aspect ratios.
`eval/fixtures/010_finish_phrase_no_goal_reference_style.json` covers a no-goal reference-style square target.

## Known Limits

- The planner is still deterministic and template-backed.
- It does not yet perform true ball/player tracking.
- Animation cues are structured and validated, but only basic caption motion/subtitle rendering is visible in this milestone.
- `auto` format selection is conservative.
