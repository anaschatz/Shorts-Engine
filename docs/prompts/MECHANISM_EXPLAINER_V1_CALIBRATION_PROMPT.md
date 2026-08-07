# ShortsEngine implementation prompt — mechanism-explainer-v1 calibration

You are working on the ShortsEngine repository. Replace the failed
story-specific GPS quality experiment with a bounded, reusable
`mechanism-explainer-v1` calibration slice.

The current GPS sample is not an acceptable baseline. Its narration introduces
too many abstractions, its dominant object moves between unrelated coordinates,
and its scene-specific geometry makes the visual sequence feel random. Do not
polish that renderer. Build a simpler reusable grammar.

## Objective

Create one deterministic HyperFrames profile that can render two finite-counter
mechanism stories without story-specific renderer code or story-owned
coordinates:

1. A rewritten, easier-to-understand GPS week-counter explanation based only on
   the already verified GPS/CISA claims in the repository.
2. A clearly labelled non-publishable odometer rollover calibration story used
   only to prove renderer reuse.

The second story is a development calibration input, not production evidence.
Do not claim that it is approved or publishable.

## Required visual grammar

- 1080×1920 at 30 fps.
- One persistent device is the primary object for the complete video.
- The device, counter, annotation, helper rail, title, and caption lane use
  engine-owned fixed anchors. Story data cannot provide `x`, `y`, transforms,
  SVG, CSS, HTML, or executable code.
- The primary device must never jump or travel between scenes.
- A frame may show at most one primary object and one helper explanation.
- A helper may use only an allowlisted recipe:
  `range`, `interpretation`, `carry`, `patch`, or `time_continues`.
- Motion vocabulary is limited to:
  `enter`, `hold`, `update`, `rollover`, `resolve`, and `exit`.
- No camera moves, progress bar, decorative particles, random positioning,
  simultaneous scene stacks, or remote assets.
- State changes crossfade in the same anchor and retain a comprehension hold
  before the next change.
- Semantic motion must start from narration-owned phrase boundaries.
- Full subtitles remain available through the existing
  `human_readable_purple_v1` ASS profile and a VTT sidecar.

## GPS calibration script

Use short semantic phrases and preserve this causal order:

1. GPS sends a week number rather than a complete calendar date.
2. The older field has ten bits.
3. Ten bits provide 1,024 values: zero through 1,023.
4. After 1,023, the next week repeats zero.
5. Some old receivers interpreted the repeated value as an earlier cycle.
6. Their displayed date moved backward while real time continued.
7. A software update selects the correct cycle.
8. The number repeated; time did not.

Do not introduce the separate 2038 comparison in this calibration version.

## Reuse proof

Render an odometer story with the exact same compiler and fixed anchor map:

1. A six-digit odometer has six number wheels.
2. Each wheel carries into the next after nine.
3. At 999,999 every wheel is at its limit.
4. One more unit carries through every wheel.
5. The display returns to zero.
6. The machine did not become new; the counter ran out of digits.

Only content data, digit count, labels, values, semantic states, and phrase
timing may differ between the two stories.

## Audio and timing

- Use the installed local Kokoro runtime for calibration narration.
- Synthesize semantic phrases as bounded segments so segment boundaries are
  exact and deterministic.
- Do not assert commercial-use attestation or production approval.
- Derive the common frame clock from exact synthesized audio length and include
  a readable final hold.
- Bind each visual state to its corresponding audio segment.
- Derive word/caption timings inside those exact segment bounds
  deterministically.

## Contracts and tests

Implement a strict story-spec validator and reject:

- story-provided geometry or executable content;
- unknown helpers or motion recipes;
- gaps, overlaps, out-of-order states, or states outside the frame clock;
- more than one helper;
- unsupported digit counts or unsafe text;
- a changing primary anchor;
- remote asset references;
- nondeterministic output.

Tests must prove:

- both stories compile through the same profile and compiler;
- their HTML uses the same fixed geometry and motion vocabulary;
- no source-level story-id branch selects SVG/layout code;
- the primary device transform is constant across all sampled frames;
- at most one helper is visible;
- transitions are bounded and comprehension holds exist;
- compilation and sampled browser frames are deterministic;
- captions cover the complete narration without overlap;
- outputs have exact frame count, dimensions, codecs, audio sample rate, and no
  remote requests.

## Deliverables

- The reusable renderer/profile and validator.
- Two data-only calibration story specs.
- One write-gated batch render command.
- Two MP4s, VTT files, contact sheets, manifests, sampled-frame hashes, QA
  reports, and human-review checklists.
- A concise comparison explaining whether reuse improved clarity.

Keep the profile feature-gated and non-publishable until human review. Preserve
all existing API payloads and previous artifacts.
