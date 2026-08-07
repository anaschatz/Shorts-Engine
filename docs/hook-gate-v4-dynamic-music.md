# HookGate V4 and dynamic music

Versions:

- selection: `bf_feed_stop_v2`
- HookGate: `hook-gate-v4.0.0`
- format: `bf_feed_stop_format_v3`
- renderer: `bf_editorial_inset_v3`
- delivery evidence: `bf-delivery-quality-v1.0.0`
- music plan: `bf_dynamic_music_v1.0.0`

## What changed

V4 stops treating an isolated word in the opening as semantic proof. It first
aligns the complete opening proposition, then asks whether a new viewer knows
what the clip is about, and finally checks whether the complete selected point
and exact ending resolve that proposition. The first-word check remains only a
latency and boundary guard.

The decision requires exact source-contiguous quotes for the opening unit,
topic-comprehension unit, and payoff. Python aligns all three to word timings
and applies the thresholds; the semantic provider cannot rewrite speech or
select a phrase that does not exist in the source.

## Semantic measurements

The versioned report records:

- opening sentence clarity;
- topic explicitness;
- standalone comprehension;
- tension or relevance;
- opening-to-point coherence;
- payoff resolution;
- single-idea focus;
- lexical decisiveness;
- semantic evidence confidence;
- time to the end of the complete opening proposition;
- time until the topic is understandable;
- exact payoff start and end.

External context, unresolved references, host setup, topic-only introductions,
an incomplete claim, a topic-changing payoff, or unaligned quotes fail closed.
A normal pass requires an overall score of at least 78 plus every independent
semantic floor. A strong average cannot hide one unclear critical dimension.

## Observable delivery quality

`DeliveryQualityReport` is separate from semantic meaning. It verifies the
exact source, transcript timing hash, and half-open speech interval, and then
measures only observable evidence:

- opening ASR agreement and word confidence from SpokenClarity;
- adjacent duplicates, phrase restarts, and searching pauses;
- speaking rate and internal-pause ratio;
- active source-audio ratio and audibility;
- RMS variation as supporting evidence.

The engine does not infer emotion, personality, or whether a face “looks
confident.” Calm authoritative delivery is allowed: low RMS variation alone
cannot cause review or rejection. Very weak delivery requires corroboration
from at least two independent signal categories. Missing or uncertain provider
evidence becomes review and is ineligible, never an implicit pass.

## Dynamic music treatment

The V3 renderer keeps the existing layout, captions, grade, source cuts,
Real-ESRGAN policy, and natural ending. It changes only the licensed music-bed
envelope. Exact transcript anchors create a continuous sequence:

1. restrained entry;
2. stable hook bed;
3. gradual semantic build;
4. a short clarity pocket around the payoff onset;
5. stable payoff emphasis;
6. controlled release through the final phrase and natural reaction.

Every transition is linear and at least 120 ms. Gain remains within the
declared restrained range, speech side-chain ducking stays enabled, and the
planner cannot add sound effects, random hits, artificial cuts, zooms, shakes,
or visual events. Missing semantic anchors, a disabled music layer, or an
unresolved licensed track fail before encoding; V3 never silently substitutes
source-only audio or the legacy step envelope. The successful three-input
speech/music filter execution is recorded in the sealed render evidence and
required again by editorial QA.

## Failure cases and trade-offs

- Semantic scores still depend on a bounded model judgment. Exact quote
  alignment and deterministic floors limit fabrication, but a novel metaphor
  may still need human review.
- Word timing errors can make a genuine proposition appear unaligned. The gate
  fails closed instead of guessing or changing source speech.
- Source audio dynamics vary by microphone and mastering. RMS evidence is
  therefore corroborative, not an affect detector or sole rejection signal.
- A more expressive bed can mask speech if overdriven. The gain ceiling,
  clarity pocket, existing low-bed loudness normalization, side-chain ducking,
  limiter, and encoded-audio QA remain mandatory.

## Evaluation and rollout

Hook selection and music treatment are separate causal axes even though the V3
format can exercise both in an offline preview. Graduation requires two
experiments:

- HookGate lane: same renderer/music; compare V3 versus V4 selection using
  explicit human hook/point labels. No labeled `unclear_hook`, `unclear_point`,
  `unintelligible_speech`, or `hesitant_or_stuttered_delivery` candidate may be
  eligible.
- Music lane: the same approved candidate and visual render; change only
  `musicTreatment`. Compare equal-age Stayed to Watch and completion while
  preserving speech intelligibility and zero hard audio-QA failures.

Neither result is auto-promoted. Historical V1/V2 profiles remain immutable for
verification and replay.

New selection/render runs opt into this contract with
`--format-profile bf_feed_stop_format_v3`; V2 remains the frozen control.
