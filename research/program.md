# AI Shorts Autoresearch

This loop improves selection and rendering quality through small, measurable experiments.

## Budget Friendly Autoresearch V2

The current Budget Friendly lane is versioned separately from the legacy
blended-score loop below. Its first causal experiment surface is semantic
closure and closure-aware top-3 selection; HookGate, editing, Real-ESRGAN,
runtime, and live YouTube outcomes are intentionally separate lanes.

Inspect the historical evidence that survived deletion of the old outputs:

```bash
.venv/bin/python research/historical_replay_integrity_v2.py \
  --output research/autoresearch-v2/historical-integrity.json
```

Check whether the raw replay corpus is available:

```bash
.venv/bin/python research/fixture_pack_v2.py --preflight
```

Once every referenced candidate/transcript/positive artifact exists, seal a
self-contained corpus and point `replayManifest` in the V2 contract to its
generated `manifest.json`:

```bash
.venv/bin/python research/fixture_pack_v2.py
.venv/bin/python research/runner_v2.py --baseline
```

Run exactly one scoped hypothesis after a compatible baseline exists:

```bash
.venv/bin/python research/runner_v2.py \
  --hypothesis "one precise semantic-closure change"
```

The V2 runner fails closed when evidence is absent or changed. It content-hashes
the engine/research source inventory, declared fast tests, and sealed replay
inputs. It rejects protected/out-of-scope changes, runs the fast lane first,
evaluates the replay twice for determinism, and runs the full suite only for a
baseline or an integer-evidence winner. Test processes have empty credentials,
redirected output/cache/home paths, and an enforced outbound-network boundary.
The replay evaluator additionally forbids subprocesses and filesystem writes.
The versioned offline lane excludes only `test_youtube_publish`, whose fixtures
are intentionally gitignored rights-approved media; that manual publishing
integration remains outside Autoresearch.

Current data status (2026-08-06): the sealed historical report is valid, but
the six-source raw replay is not runnable because 18 manifest references map
to 10 missing unique files. The tool records this as
`crash/replay_artifacts_missing`; it never presents the frozen historical
report as evidence for a new engine change.

New reviewed approvals now create durable replay evidence automatically. The
default `LOCAL_AUTORESEARCH_EVIDENCE_DIR` lives in OS application data and is
separate from render output and caches. Inspect the inbox without mutating it:

```bash
.venv/bin/python research/fixture_pack_v2.py \
  --capture-dir \
  --preflight
```

Freeze a reviewed snapshot into a new directory (the command refuses to
overwrite an existing pack):

```bash
.venv/bin/python research/fixture_pack_v2.py \
  --capture-dir \
  --output-dir research/fixtures/bf-autoresearch-v2-pack-YYYYMMDD
```

Auto-selected candidates are preserved only as provenance. The fixture pack
creates positives solely from hash-bound explicit human approvals, and leaves
all unapproved candidates unknown. Each exact positive carries its sealed
capture-label and canonical `CandidateDecision` proof; replay recomputes its
source, transcript and candidate identities before counting it. Interrupted
unlabeled captures are reported and skipped, never promoted as evidence.

## Objective

Maximize:

```text
0.30 * top1_human_acceptance
+ 0.20 * pairwise_ranking_accuracy
+ 0.15 * recall_at_5
+ 0.15 * boundary_completeness
+ 0.10 * visual_subject_coverage
+ 0.10 * caption_readability
```

All component metrics use a 0-100 scale. Quality terms are additive. Only explicit penalties and hard guardrails are negative.

## Baseline

```bash
.venv/bin/python research/runner.py --baseline
```

## One Experiment

```bash
.venv/bin/python research/runner.py \
  --hypothesis "increase tutorial payoff weight without harming gaming"
```

Use `--live --model gemini-3.1-flash-lite` only after an offline improvement. Live runs pin one model and never silently fall back.

## Editable Scope

- `shorts_generator/highlights.py`
- `shorts_generator/local/llm.py` structured response schema
- `shorts_generator/ranker.py`
- selection thresholds and boundary alignment logic
- `shorts_generator/local/visual_features.py` weights
- focused tests for newly discovered behavior

## Immutable During Experiments

- `research/fixtures/`
- `research/eval.py`
- baseline reports
- metric definitions and acceptance thresholds

If fixture or metric fingerprints differ from the baseline, the runner crashes the experiment instead of comparing incompatible scores.

## Hard Guardrails

All must remain zero:

- `promotional_top1_rate`
- `outro_top1_rate`
- `mid_sentence_cut_rate`
- `duration_violation_rate`
- `render_decode_failure_rate`

All unit tests must pass, including facecam, motion tracking, captions, ranking, and output profile tests.

## Efficient Loop

1. Read baseline and weakest metrics.
2. Form one hypothesis.
3. Make one scoped edit.
4. Run unit tests and cached offline evaluation.
5. Keep only if score improves by at least 0.25 and guardrails pass.
6. Run live evaluation only for an offline winner.
7. Limit live repeats to three fixed seeds.
8. Render only the final live top candidate.
9. Record the result in `results.tsv` and `runs/`.

At least 90% of experiments should stay offline. Cache keys include transcript, prompt, schema, pinned model, and seed.

## Visual GTA Loop

The GTA visual loop uses immutable cached crops from all three ranked
`Vj88NUJeY9Q` shorts. It measures structural, edge, color, and flat-region
fidelity, detail retention, temporal stability, inference efficiency, frame
count, dimensions, and decode success.

```bash
venv/bin/python research/visual_quality.py --prepare
venv/bin/python research/visual_quality.py \
  --strategy half_x2_blend25 \
  --hypothesis "test one scoped enhancement change"
```

Experiments compare against the highest-scoring kept run. Real-ESRGAN model
outputs and source samples are cached; blending and metric experiments do not
repeat inference.

## Camera GTA Loop

Camera experiments replay immutable motion targets from the same three clips.
They balance action coverage and centering against acceleration, direction
reversals, and edge dwell.

```bash
venv/bin/python research/camera_quality.py \
  --controller smoother \
  --hypothesis "test one scoped controller change"
```

Only controllers that improve the best kept score while preserving coverage
and edge guardrails are eligible for production rendering.
