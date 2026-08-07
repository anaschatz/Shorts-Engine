# Generalized Visual Engine — Step 7 report — 2026-08-07

## Outcome

Step 7 replaces the experimental "choose one complete scene recipe" boundary
with a feature-gated semantic composition v2 proof. The art direction remains
engine-owned and identical across stories, while the selected grounded
entities, relations, topology, focus path, state changes, and target-specific
motion tracks can differ by story.

The production dispatch is unchanged. Every generated artifact is stamped
`publishable: false` and `humanReviewStatus: pending`.

The implementation prompt is
[`REFERENCE_LOCKED_SEMANTIC_COMPOSITION_V2_PROMPT.md`](../prompts/REFERENCE_LOCKED_SEMANTIC_COMPOSITION_V2_PROMPT.md).

## Implemented architecture

- A strict, data-only `generalized_visual_program_proposal_v2` contract. It can
  select trusted entity and proposition IDs, topology, and focus, but cannot
  author visible copy, geometry, timing, style, paths, assets, URLs, or code.
- A deterministic compiler that resolves those selections against a trusted
  semantic graph and timing context, then owns layout, edges, phases, and
  animation tracks.
- One hash-bound reference art direction:
  `educational_line_art_reference_v1@1.0.0`, using the same black, white,
  purple, red, blue, Outfit, stroke, spacing, and safe-region rules for every
  story.
- Low-level reusable entity and connector primitives instead of complete
  story-scene renderers.
- Target-specific `reveal`, `draw`, `focus`, and `state_change` tracks, plus an
  eight-frame deterministic replacement crossfade.
- A semantic trace gate that rejects text-only explanations, invalid relation
  endpoints or certainty, mistimed cues, and missing settled holds.
- A repetition gate that compares semantic-graph, motion, and quantized 6x8
  occupancy descriptors within and across stories. Persistent identity alone
  does not count as novelty.
- A local, no-network proof runner with deterministic frame capture, burned
  captions, sidecar VTT, audio muxing, persistent-title OCR, technical media
  checks, contact sheets, hashes, and non-production disclosures.

The v1 contracts and default renderer dispatch were not changed.

## Two-story rendered proof

The proof command was:

```sh
node tools/render-generalized-visual-v2-video-proof.mjs --story all --confirm-write
```

Both stories use the same compiler, generic renderer, primitive registry, and
style hash:

`fc86508b2b89e8a974caad385684ddb214c52710beaad99ff283f23f7c956601`

They produce different programs and compositions:

| Story | Frames | Program hash | Composition hash | MP4 SHA-256 |
| --- | ---: | --- | --- | --- |
| GPS rollover | 899 | `b978a33f99991311112e751481d367322def58e2f25706b4c26568de1fdd678e` | `05edcfc3b4e93c8cd50346ec7fcac999a8706d2ff83ebba5df2ac43b434448b2` | `baf993f88f39b476682daa775fcb9ddfd48863988457f13a26d11fee0d813899` |
| Odometer rollover | 537 | `b378e581f1d7407152c6b0bad784250012f151a0de498b8f4f7a0d7433ec63a9` | `4def463cf0f2aec9c55c0550378ab56a4adcaf757c9e3c9190ffd6528aa8a8da` | `03969700be66f4333c34c52baab47f6d1d864a7bf2d66305a2038f8584182a6a` |

The GPS composition shows a satellite-to-week-value-to-receiver path, finite
counter rollover, wrong displayed date versus continuing real time, and a
software correction path. The odometer composition shows one vehicle above
six digit wheels, carry propagation through the ordered wheels, full rollover,
and the unchanged vehicle continuing after the display returns to zero.

Cross-story evidence reports ten scenes, zero repetition violations, zero
warnings, zero matched scene fingerprints, and different program hashes. See
[`generalized-visual-v2-comparison.json`](../../showcase/evidence/generalized-visual-v2-comparison.json).

Rendered artifacts:

- [`generalized-visual-v2-gps-proof.mp4`](../../showcase/assets/generalized-visual-v2-gps-proof.mp4)
- [`generalized-visual-v2-odometer-proof.mp4`](../../showcase/assets/generalized-visual-v2-odometer-proof.mp4)
- [`GPS evidence report`](../../showcase/evidence/generalized-visual-v2-gps-proof/report.json)
- [`Odometer evidence report`](../../showcase/evidence/generalized-visual-v2-odometer-proof/report.json)

## Automated validation

- 17/17 focused v2 contract, compiler, semantic gate, repetition gate,
  renderer, runtime, CLI, and cross-story proof tests passed.
- Static lint passed.
- Build smoke checks passed.
- Both MP4s are 1080x1920, 30 fps, H.264/yuv420p with 48 kHz mono AAC.
- No remote browser requests were observed.
- Persistent title OCR passed on 21 GPS samples and 15 odometer samples taken
  from the encoded MP4s.
- The same style hash and different program/composition fingerprints are
  recorded in the evidence artifacts.

## Honest status and remaining work

This run proves that the engine can keep one directed visual identity without
forcing two mechanisms through the same complete animation template. It does
not establish reference-Reel creative parity or production readiness.

Important limits:

- The two bounded composition proposals are operator-authored proof fixtures.
  The future local LLM planner is not connected yet, although the exact schema
  it must produce is now implemented and fail-closed.
- The proof reuses calibration narration and phrase timing. Audio duration is
  frame-exact, but the older character-weighted word estimates are not a new
  forced-alignment result.
- Calibration-source audio rights are not commercially attested, so the output
  must not be published.
- No real person has completed a side-by-side comprehension, pacing, polish,
  and originality review. `humanPerceptual` therefore remains `pending`.
- The primitive kit is deliberately small. More grounded depictions can be
  added behind the same low-level registry without adding story-specific
  renderer branches.

The next implementation slice should connect a loopback-only bounded LLM
composition planner to the v2 proposal contract, compile a new third story with
verified word alignment, and run blinded human comparison before any
production routing is considered.
