# Generalized Visual Engine — Step 8 live-planner proof

Date: 2026-08-08
Status: calibration proof complete; human review pending; non-publishable

## Outcome

The feature-gated Visual Program v2 path rendered three complete vertical
videos through the same local-LLM planner boundary, deterministic compiler,
locked art direction, primitive registry, HyperFrames runtime, audio/caption
compositor, and QA pipeline.

All three final programs were selected by the installed local model
`qwen3:4b-instruct` through the loopback OpenAI-compatible Ollama endpoint. Each
selection succeeded on its first attempt with `fallbackUsed: false` and
`failure: null`. No raw prompt or raw model response is retained in public
evidence.

This proves bounded story-specific composition and renderer reuse. It does not
prove reference-level creative quality or production readiness.

## Bounded planner architecture

The provider receives a data-only indexed semantic projection plus at most
eight deterministic complete-partition candidates. It returns only:

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "rangeCandidateIndex": 12,
      "layoutIntent": "layered_stack"
    }
  ]
}
```

The strict response schema binds the exact candidate sequence for each
catalogued complete path. Server validation then materializes proposition
ranges, grounded entities, focus, IDs, text, geometry, frames, assets, motion,
style, and hashes. The model cannot provide visible copy, coordinates, paths,
frames, assets, CSS, SVG, HTML, JavaScript, URLs, colors, or executable code.

Planner identity shared by all three runs:

- provider: `local_openai_compatible`
- model: `qwen3:4b-instruct`
- prompt profile: `generalized_visual_program_v2_local_composer_prompt_v1`
- configuration hash:
  `14b0f364949f8140c2f0e21403a910f5db088620616469fea6b421ee46fbebff`
- compiler trust: `calibration_trusted` /
  `local_llm_generated_nonproduction`

## Live render results

| Story | Scenes | Frames / duration | Program hash | Composition hash | MP4 SHA-256 |
| --- | ---: | ---: | --- | --- | --- |
| GPS rollover | 3 | 899 / 29.9667 s | `3c4b49cf…7ac48` | `14f54437…889d3` | `28134474…beb7b` |
| Odometer rollover | 3 | 537 / 17.9 s | `383ef772…500f` | `dc17afcd…e7eb` | `c27a2f0f…bf90` |
| Baychimo | 4 | 1068 / 35.6 s | `8ed9a0e3…83347` | `2b2a253a…2272` | `ddd899c7…4582` |

Every output is 1080×1920 at 30 fps, H.264/yuv420p with AAC 48 kHz mono.

Per-run bounded planner provenance:

| Story | Provider selection | Normalized choice | Prompt projection | Attempts / fallback |
| --- | --- | --- | --- | --- |
| GPS | `b241e1c1…0df2` | `a7aa19fc…dbdf` | `eea4676c…8800` | 1 / false |
| Odometer | `e7ae257d…77f` | `b217eb24…daae` | `14995c45…3957` | 1 / false |
| Baychimo | `43d65726…8090` | `f574be3d…ec1c` | `c0f8ca82…f4aa` | 1 / false |

The full 64-character hashes remain in each story's `report.json`.
The exact normalized, data-only selections are persisted as
`planner-choice.json` alongside each story report; each artifact's
`contentHash` equals the corresponding `choiceHash` above and supports
deterministic replay without retaining raw provider output.

## Semantic and visual evidence

The locked style hash is identical across all three outputs:
`fc86508b2b89e8a974caad385684ddb214c52710beaad99ff283f23f7c956601`.
Program and composition hashes are all distinct.

The arbitrary-N corpus comparison evaluated all three story pairs. It found:

- 3 accepted programs and 10 scenes;
- 3 pairwise comparisons;
- 0 exact or near cross-story scene-fingerprint overlaps;
- 0 repetition violations and 0 warnings;
- a passing semantic-trace report for every story.

The Baychimo proof uses the checked 89-word, 1068-frame exact-sequence ASR word
alignment, hash-bound to the approved draft and local source audio. This is not
a new phoneme-level forced-alignment run. Its source audio is internally
rights-confirmed but still requires publish approval. The GPS and odometer
calibration narration is not commercially attested.

Agent visual inspection of the rendered frames found the intended grounded
sequences:

- GPS: satellite signal value → bounded week counter → receiver → wrong cycle
  date → corrected mapping;
- odometer: one connected six-wheel bank → carry propagation →
  `999999`→`000000` → the same car continues;
- Baychimo: ship/crew/blizzard → last-seen absence → hunter sighting replacing
  the sinking assumption → crewless drift with pack ice → archive record →
  rejected ghost hypothesis → unresolved final fate.

This inspection is engineering evidence only, not independent human evidence.

## Automated gates

All three story reports record:

- technical: passed;
- deterministic plan: passed;
- no remote assets: passed;
- persistent title OCR: passed;
- semantic composition: passed;
- human perceptual: pending.

The comparison report is:
`showcase/evidence/generalized-visual-v2-comparison.json`.
Per-story evidence, sampled-frame hashes, title OCR, semantic traces, contact
frames, source bindings, and media metadata are under
`showcase/evidence/generalized-visual-v2-*-proof/`.

## Blinded human-review gate

A three-video blinded review pack was created as
`review_bcb0d20c29470034b8bf38b7` with five distinct complete and confirmed
reviewer sessions required, operationally performed by independent people.
The public assignment uses randomized anonymous items and same-origin hashed
MP4s. It omits internal story IDs, implementation IDs, source filenames,
program/composition/style/report hashes, planner/provider metadata, and expected
answers. The subject matter remains visible through burned-in titles and the
comprehension questions; the public contract also retains the assignment and
media-integrity hashes.

A direct browser spot check, separate from the persisted pack report, verified:

- the public page exposed no implementation, planner, or provider identity;
- video playback was 1× with native controls disabled;
- in the unmodified UI, questions remained hidden until the video `ended`
  event after normal-speed playback;
- the questions and bounded quality checks appeared after the video ended;
- the 390×844 viewport had no horizontal overflow;
- no browser warnings or errors were recorded.

This is a procedural UI check, not tamper-proof server attestation of elapsed
watch time. The persisted pack report correctly retains
`browserAutomationStatus: not_run`.

The separate hash-bound spot-check record is
`showcase/evidence/generalized-visual-v2-human-review-browser-spot-check.json`.

No responses were fabricated or submitted, and the review was not finalized.
The pack is an ephemeral local artifact under the system temporary directory.

## Release status and next gate

- `humanReviewStatus: pending`
- `humanApproved: false`
- `productionReady: false`
- `publishable: false`

These explicit release fields and their bindings to the comparison, three
story reports, and pending review result are persisted in
`showcase/evidence/generalized-visual-v2-release-status.json`.

The next legitimate gate is five complete blinded reviews across all three
videos, followed by thresholded aggregation and targeted iteration on any
failed story. Visual Program v2 must remain feature-gated and disconnected from
the production publish path until that evidence exists.
