# Dark Curiosity Semantic Timing Proof

Status: validated benchmark; not a production-renderer migration

Date: 2026-07-13

## Scope

Slice C1 binds animation operations to exact narration alignment and demonstrates a real topology-compatible SVG path morph. It does not change the production narrated-short renderer, publishing boundary, rights workflow, or pilot defaults.

The proof uses the allowlisted Wow Signal fixture and a strict `TimingContext` containing only bounded word/beat timing records, immutable bindings, and hashes. The semantic plan may express `absolute`, `beat_start`, `beat_end`, `word_start`, and `word_end` anchors plus bounded frame offsets. The compiler resolves every anchor to a concrete frame before HyperFrames sees the composition.

End semantics are explicit: narration and beat ranges use an exclusive end frame, while a rendered operation ends on the last renderable frame (`exclusiveEnd - 1`). All resolved ranges must remain inside their scene and the 300-frame composition.

## Ownership boundary

The timing IR owns:

- operation identity, target identity, semantic anchor type, easing, and resolved frame range;
- immutable draft, alignment, timing-context, renderer-profile, and template-version bindings;
- deterministic hashes and the alignment-sensitive compilation result.

The templates own:

- SVG geometry, layout, typography, colors, glows, camera transforms, and ambient styling;
- the waveform and evidence-node shapes used by `signal_lab_v1` and `mystery_payoff_v1`;
- bounded interpolation formulas for the allowlisted operations.

No story artifact contains renderer code. HyperFrames receives the compiled schedule and engine-owned SVG composition, not narration text or arbitrary JavaScript.

## Real morph

The waveform and target node are converted to compatible 128-point polylines through deterministic arc-length resampling. Every render frame interpolates all corresponding points and rewrites the SVG path `d` value. This is geometric morphing, not a cross-fade or opacity swap.

The engine-owned seek proof evaluates frame N, then a later frame M, then N again. The two N states have the same SHA-256 (`5420e604a2be22e100db7904a071470d3869e953d08937f948d56f31a068a8f1`), while M differs. This proves the pure morph state is addressable and free of accumulated frame history. A future slice should also repeat this assertion through the browser capture layer.

## Commands

The CLI is dry-run by default and accepts only the allowlisted fixture:

```bash
npm run dark-curiosity:animation:timing:doctor
npm run dark-curiosity:animation:timing:proof
npm run dark-curiosity:animation:timing:proof -- --render --yes
```

Generated proofs remain under the ignored benchmark output directory. No secret, API key, external asset, or production artifact is required.

## Verified 720p result

| Property | Result |
| --- | ---: |
| Resolution | 720×1280 |
| Codec / pixel format | H.264 / yuv420p |
| Frames / frame rate | 300 / 30 fps |
| Duration | 10.000 s |
| Render duration | 14.701 s |
| Peak renderer memory | 160 MiB |
| Resolved operations | 12 |
| Morph topology | 128 points |
| Changed-transition ratio | 1.000 |
| Sampled stasis | 13.79% |
| Active morph energy | 0.006095 |
| Readability-hold energy | 0.000231 |

All declared technical, non-black, sampled-diversity, stasis, motion-energy, caption-safe-zone, clipping, semantic-timing, checkpoint-diversity, morph-change, readability-hold, backward-seek, and alignment-sensitivity checks passed.

The proof hashes are:

- Timing Context: `888847e723a033c2d3a6c5e376739e8c7de46463143328d5f90f0e2c19cce01b`;
- AnimationIR: `53f5cd4ee107a0f1d4592502fcd27ed386fc86446fbdd3a7338b30118e273480`;
- timing trace: `3c4f1524bf5ed54acf1c156fdf668cec6dc0186bdea566619242b7a0612ba613`;
- rendered MP4: `72b8bdef4c6f686c7242b154c3e237eb78ffc2d6debeec273ae152dece10f322`.

The seven visual checkpoints are frames 27, 76, 131, 203, 209, 241, and 291. They cover the pre-wave state, waveform midpoint, signal pulse, beam crossing, morph midpoint, payoff start, and readability hold. Visual inspection confirmed that the waveform is absent before its semantic anchor and that the payoff hold retains only restrained ambient motion.

## Alignment sensitivity

Moving aligned word index 2 two frames later shifts its dependent waveform start from frame 28 to frame 30 and changes the AnimationIR hash to `83d9da730a7ec4f25129b31efaa9333e4750beffd3c7372063bce3463c89964c`. The independent morph start remains unchanged. This demonstrates semantic dependency rather than a global hardcoded timeline.

## Strict limitations

- This is one 10-second fixture, not evidence that 30–40 second stories are consistently well paced.
- Sampled stasis is 13.79%, below the current 15% limit but close enough that the threshold is not yet trustworthy.
- The backward-seek proof exercises the engine-owned morph primitive; browser-level reverse seeking still needs an integration test.
- Motion energy is a coarse pixel metric. Jerk, OCR readability, object persistence, and continuity need stronger gates.
- Human preference, retention, and channel profitability are completely unproven.
- HyperFrames remains a benchmark provider. Production migration is not approved.
