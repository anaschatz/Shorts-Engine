# HookGate V3: metrics, failure cases, trade-offs

Versions:

- gate: `hook-gate-v3.0.0`
- selection policy: `bf_feed_stop_v1`
- optional experiment: `bf_short_brand_tail_v1`

## Decision boundary

HookGate V3 is opt-in. It does not replace or silently fall back to HookGate
V2. Its frozen control format is `bf_feed_stop_format_v2`, which binds the
selection policy to the existing `bf_editorial_inset_v2` renderer and adds the
fail-closed SpokenClarity gate. Supplying the historical
`bf_feed_stop_v1` selection policy during generation still resolves to this
V2 control format.

New whole-proposition selection and dynamic-music previews use the separate
`bf_feed_stop_format_v3` contract documented in
`docs/hook-gate-v4-dynamic-music.md`. V2 remains immutable for replay and
controlled comparisons; it is not silently mutated into V4 behavior.

`bf_feed_stop_format_v1` is retained only for exact verification, rejection,
and replay of historical artifacts. Active generation and `approve-candidate`
reject V1; there is no production-approval bypass flag.

HookGate itself reads only the existing source-contiguous word timestamps and
candidate semantic evidence. It makes no transcription, video-decoding, audio
enhancement, or Real-ESRGAN call. The separate V2 SpokenClarity gate locally
transcribes only the opening window for confidence and token-alignment
evidence. Rendering fields remain excluded from the semantic score.

## Measurements

All timestamps except `firstWordLatencyMs` are relative to the first authentic
spoken word:

- `firstWordLatencyMs`: first word start minus rendered start.
- `firstClauseEndSeconds`: measured punctuation boundary; when ASR punctuation
  is absent, the eighth word end is reported as a measurement proxy and is
  never used as permission to cut speech.
- `firstConcreteClaimSeconds`: first concrete object, action, or consequence.
- `firstTensionSignalSeconds`: first contradiction, rule, conflict,
  consequence, charged term, or specific visual object.
- `firstActionableRuleSeconds`: first source action/rule token.
- `firstConsequenceSeconds`: first source consequence token.
- `firstPayoffSeconds`: first mechanism, reversal, action, consequence, or
  exactly aligned payoff phrase.
- `openingWordCountAtTwoSeconds`: source words beginning within the first two
  seconds.
- `openingSemanticDensity`: share of the first-two-second words carrying an
  action, tension, consequence, concrete-object, or contrast signal.
- `openingContextDependence`: evidence that the opening requires an antecedent,
  earlier dialogue, host setup, or contextual framing.
- `openingAbstractionScore`: definition/general-concept evidence reduced by
  concrete action, object, consequence, and contrast evidence.
- `openingSpecificityScore`: content-word density plus concrete action, object,
  consequence, and contrast evidence.
- `hookCompressionScore`: weighted combination of tension latency, two-second
  word count, and semantic density.

These are lexical-semantic heuristics, not claims that a token alone fully
understands a sentence. Hard evidence from candidate fields remains
fail-closed, and the regression set protects the intended comparative ranking.

## Score

`bf_feed_stop_v1` uses the declared weighted score:

| Component | Weight |
| --- | ---: |
| Immediate tension or rule | 25% |
| Opening specificity | 15% |
| Context independence | 15% |
| Payoff latency | 15% |
| Semantic compression | 10% |
| Complete ending | 10% |
| Interpersonal relevance | 5% |
| Quotability | 5% |

Penalties are recorded as individual `{reason, points}` objects. Abstract
opening and unclear-reference penalties can each reach 20 points; late payoff
and repeated setup can each reach 15 points. Attribution/host setup and an
incomplete ending are hard rejections.

A normal pass requires:

- score at least 80;
- context dependence at most 15;
- abstraction at most 35;
- tension no later than 2.0s;
- payoff no later than 6.0s for speech shorter than 18s;
- complete ending and a single idea;
- first spoken word no later than 100ms.

An explicit review reason does not silently turn a threshold failure into an
eligible pass. It produces a review decision.

## Duration and ending

The preferred speech duration is 12–17s. A complete payoff may use 17–21s.
Speech from 21–24s requires review; more than 24s is rejected. Speech duration
is measured separately from the authentic source tail, post-source fade, and
black brand tail.

The existing `bf_natural_tail_v6` closure remains authoritative:

- captions stop at measured speech end;
- 0.35–0.55s of moving source is retained when the source gap allows it;
- the safety boundary is the next word start minus 40ms;
- the fade begins after source footage;
- absent source time is never replaced with a held frame.

## Expected failure cases

- ASR without word timings: fail closed; no timing is inferred from segment
  text.
- Incorrect punctuation: clause-end measurement may use the eight-word proxy,
  but source speech is not cut at that proxy.
- Metaphors outside the maintained concrete vocabulary: conservative
  under-scoring is possible. Add a regression fixture before expanding the
  vocabulary.
- Sarcasm or tension expressed only through prosody: the lexical gate can miss
  it. Such a candidate needs explicit human review, not invented text.
- An opening with a pronoun whose referent is genuinely obvious on screen may
  still be penalized because selection intentionally does not decode frames.
- A short excellent statement under 12s can pass but carries a duration review
  note; it is not padded or rejected merely for being short.

## Trade-offs and implementation decisions

- Determinism over unrestricted semantic inference: reproducible scores and
  cacheability are gained at the cost of occasional lexical false negatives.
- Fail-closed timing over guessed alignment: fewer candidates survive when ASR
  evidence is incomplete, but no hook is manufactured.
- One authoritative V3 score over blending legacy ranking fields: render
  settings and older LLM scores cannot change the semantic order.
- Hook-family diversity is preferred in the first selection pass. A second pass
  may reuse a family when otherwise fewer strong, distinct ideas would be
  returned.
- Recent-topic suppression requires either a new topic or an explicit
  `materially_stronger_than_recent=true` declaration.

## Performance and cache

Measurements are a linear scan of the candidate's existing timed words. The
cache key includes transcript timing hash, `bf_feed_stop_v1`, gate version,
candidate interval, and semantic evidence. Warm decisions require no semantic
rescan. The selection module has no imports or call paths to transcription,
OpenCV, FFmpeg, audio analysis, or Real-ESRGAN.

Normalized timings are cached once per transcript. A local synthetic stress
check with 36,000 timed words and 12 candidates measured approximately 32ms
cold and 0.12ms warm; the model/discovery and existing ranking work remains the
dominant selection cost. Production telemetry should still compare the
selection-stage p50/p95 before rollout; a greater than 10% increase is a
rollout blocker.

## Brand-tail experiment

`bf_short_brand_tail_v1` is opt-in and leaves the default at 0.85s. It renders:

- control: 0.85s black `BF.` tail;
- variant: 0.40s black `BF.` tail.

Both arms come from one sealed candidate. The manifest declares only
`changedAxes=["brandTailDuration"]`. Source interval, speech, captions, layout,
Real-ESRGAN requirement, music, natural moving tail, and fade are frozen. The
result is invalid unless decoded frames before the common brand-tail boundary
are byte-identical.

Real-ESRGAN is fail-closed: when enhancement is requested and its actual runtime
or model files are unavailable, rendering raises an error instead of silently
using ordinary interpolation.
