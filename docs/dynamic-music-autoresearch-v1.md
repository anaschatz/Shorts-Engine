# DynamicMusic Autoresearch V1

This is a separate, offline calibration lane for `bf_dynamic_music_v1.0.0`.
It does not share an objective with HookGate, call an LLM, decode media,
render, upload, predict retention, or modify a production profile.

## Causal contract

The experiment recipe declares exactly:

```json
{"changedAxes":["musicTreatment"]}
```

Source bytes, transcript timing, speech/render intervals, layout, captions,
grade, natural tail, Real-ESRGAN treatment, authentic source cuts, and the
licensed music asset are fixed. A candidate plan is eligible only after its
exact body and asset receipt are bound into sealed V3
`RenderManifestEvidence`. The receipt must match exactly one code-authorized
contract entry, and the runner re-hashes the referenced music file rather than
trusting the receipt. Offline plan metrics are structure and speech-safety
proxies, not viewer-outcome labels.

Today's published Short (`V3pd9Yrmi-c`) is recorded only as the observed
control identity. Publication is not treated as proof that the music caused
good performance. Its `performanceLabel` and `retentionClaim` are explicitly
null. Its video, source, transcript, selection, gate diagnostics, tail patch,
and upload receipt are cross-bound by byte length and SHA-256 before the
control is admitted.

## Deterministic guardrails

The evaluator first calls the production `validate_dynamic_music_plan`, then
checks:

- exact HookGate V4 opening and payoff anchors with no timing fallback;
- contiguous, one-way semantic phase order;
- no random effects, sound effects, or visual events;
- ramp rate no greater than `1.25 gain/s`;
- speech-weighted mean music gain no greater than `0.82`;
- restrained entry and natural-tail gains;
- bounded dynamic range;
- build lift, clarity-pocket depth, stable payoff lift, and controlled release;
- how much of the hook-to-payoff context contains the semantic build.

When render evidence is supplied, its seal, V3 profiles, applied mix, plan
version, exact plan hash/body, and non-empty licensed asset SHA-256 must all
match. Missing evidence fails closed.

## Baseline result — 2026-08-07

The immutable run is
`research/music-autoresearch-v1/baseline-2026-08-07.json` with content hash
`a13f1bee445d4a1c364d04ad52e7b1cd6109c8cd210577d92755bd67fe03dc0f`.

Inventory audit against the source worktree found:

- 3/3 licensed Mixkit music files, exact byte length and SHA-256 verified;
- 6/6 previously captured Instagram reference media files verified;
- today's published control video, source, transcript, selection, diagnostics,
  tail patch, and upload receipt cross-bindings verified;
- 0 sealed human reference-music labels;
- 0 real equal-age analytics snapshots in this experiment.

The production baseline held a flat hook bed until 1.38 seconds before the
payoff. Its semantic build covered only `0.219780` of the context between the
complete hook and the payoff pocket, so it failed this one structure proxy.
All speech-safety measurements still passed.

The bounded five-variant search selected `hook_plus_0.08s`: begin the gradual
semantic build 80 ms after the complete hook proposition lands. It changes no
gain target and preserves the same clarity pocket, payoff emphasis, release,
speech side-chain, source audio, tail, and visuals.

| Measurement | Baseline | Offline proposal |
| --- | ---: | ---: |
| Context-build coverage | 0.219780 | 0.985348 |
| Maximum ramp rate | 1.000000 | 1.000000 |
| Speech-weighted mean gain | 0.728993 | 0.748889 |
| Dynamic range | 0.460000 | 0.460000 |
| Clarity-pocket depth | 0.300000 | 0.300000 |
| Payoff-emphasis lift | 0.400000 | 0.400000 |

Proposal plan hash:
`2f1c387818e824fba79865e1faa66ba9ffa50e94424beeae435a1a8776ce3d30`.
This is a plan-safe candidate for a listening comparison, not a quality or
retention winner.

## Current disposition

`calibration_not_ready`

The lifecycle is blocked at `treatment_render_binding`. Blocking evidence:

1. no sealed reference-music labels;
2. no sealed V3 treatment render evidence;
3. no real 168-hour equal-age cohort with at least three videos per treatment;
4. no implemented verifier yet for fixed-axis equivalence between each
   control/treatment render pair.

The next valid action is a local music-only treatment render followed by a
human A/B listen for speech masking, hook support, payoff clarity, pumping, and
natural-tail release. A future live comparison admits only canonical sealed
observations that bind an analytics snapshot to the exact render evidence,
treatment-video bytes, public upload receipt, source/candidate identity, and
experiment assignment. Raw analytics snapshots are rejected. Until an
independent fixed-axis render-pair verifier is implemented,
`realOutcomeEvidenceReady` remains false even if cohort counts are sufficient.
This lane has no winner selection or auto-promotion.

The contract digest is code-owned, not merely self-sealed. Every run also
binds the exact contract, observed control, evaluator source, DynamicMusic
source, optional render evidence, and outcome-observation set hashes.

## Commands

Focused tests:

```bash
python3 -m unittest -q \
  tests.test_music_autoresearch_v1 \
  tests.test_dynamic_music \
  tests.test_pipeline_editorial_qa_contract \
  tests.test_editorial_qa
```

Run directly from the repository and atomically persist the baseline:

```bash
python3 research/music_autoresearch_v1.py \
  --root "/Users/anastaseschatzedakes/Desktop/short form /AI-Youtube-Shorts-Generator" \
  --output research/music-autoresearch-v1/baseline-2026-08-07.json \
  --compact
```

The runner writes the sealed report first, then exits with status `2` while
the staged lifecycle is blocked. That non-zero status is intentional and must
not be interpreted as a failed atomic write.

After producing the music-only V3 treatment, bind it without changing any
other axis:

```bash
python3 research/music_autoresearch_v1.py \
  --root "/Users/anastaseschatzedakes/Desktop/short form /AI-Youtube-Shorts-Generator" \
  --render-evidence /absolute/path/to/render-evidence.json \
  --output research/music-autoresearch-v1/treatment-bound.json
```

Canonical observations can be appended with repeated
`--outcome-observation` arguments. Raw snapshots, manual numbers, duplicate
video/content assignments, stale treatment bytes, or unbound uploads are
rejected as outcome evidence.
