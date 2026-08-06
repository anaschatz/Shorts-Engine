# Budget Friendly Autoresearch V2

Version: `bf-autoresearch-v2.0.0`

## First implementation slice

Autoresearch V2 evaluates one selection hypothesis at a time against the real
Budget Friendly replay set. It does not generate candidates, call an LLM,
download media, render, enhance, upload, schedule, or mutate a production
profile.

The first slice deliberately optimizes semantic closure and closure-aware
top-3 selection. Hook prompt evidence remains `not_evaluable` for legacy
artifacts and is not synthesized.

## Experiment lifecycle

1. A versioned immutable contract declares metrics, thresholds, editable files,
   protected evaluator files, and test lanes.
2. A baseline stores per-file fingerprints rather than relying on a potentially
   dirty Git worktree.
3. One hypothesis changes one or more files inside the declared editable scope.
4. Fast selection tests and a cached offline replay run first.
5. A trial that gains no additional known human-approved clip is discarded
   without running the full suite.
6. A trial with an integer-count improvement must pass the full repository
   suite before it can be marked `keep`.
7. Any protected evaluator/fixture mutation crashes comparison.
8. A kept offline result is still not authority to change production defaults
   or publish a Short.

Source isolation content-hashes the Python inventory under `shorts_generator/`
and `research/`, every declared fast test, and each replay artifact. This stays
bounded (the wider test tree, media, outputs, caches, and arbitrary JSON are
never recursively scanned), remains portable across fresh checkouts, and still
exposes an undeclared engine edit as an out-of-scope change.

## Decision metrics

Keep/discard uses integer evidence rather than a blended score. The historical
reference contains 18 approved clips: 11 pass semantic closure and 7 reach the
9 filled top-3 slots. A trial must preserve every baseline floor and add at
least one real approved clip to closure passes or top-3 hits.

Non-positive historical candidates are unlabeled, not human-rejected. The
metric `knownPositiveHitRateAmongSelected` is therefore a coverage diagnostic,
not precision or specificity.

## Guardrails

- at least 5 sources, 30 candidates, and 12 human positives;
- at least 90% positive-label interval match coverage;
- known-positive hit rate among selected slots may not fall below 60%;
- no previously closure-passing approved candidate may regress;
- zero selected incomplete endings;
- zero selected context-dependent openings;
- zero selected promotional/outro candidates;
- replay must report zero LLM calls and zero renders;
- every changed experiment source must be inside the editable scope;
- evaluator, metric contract, replay manifest, and replay implementation hashes
  must match the baseline;
- fast tests must pass for every trial;
- the complete offline engine suite must pass for an offline winner; a manual
  publishing test that requires gitignored, rights-approved FIFA media is
  explicitly excluded by the versioned contract and remains part of its own
  authorized integration workflow.

The replay evaluation itself denies DNS/socket access, subprocesses, and both
high- and low-level filesystem mutations. Test lanes run with credentials
cleared, known write/cache paths redirected to an ephemeral directory, and an
outbound-network boundary. Local codec integration tests may run in the full
lane; they are validation work, not replay generation or a live API call.

Positive-label interval match coverage is a data-integrity gate, never an
optimization term. Hook quality is excluded until sealed HookGate evidence
exists for the corpus.

## Current readiness

The surviving historical report is sealed and internally consistent: 6
sources, 95 candidates, 18 known approved clips, 11 closure passes, 7 approved
top-3 hits, and 9 filled top-3 slots. It is not a runnable corpus because the
raw candidate dictionaries and exact timed transcripts are absent. The 18
manifest references resolve to 10 unique missing files, so V2 correctly stops
before testing or evaluation until those files are restored or replaced by a
new sealed replay pack.

## Durable approval capture

New local rankings embed one sealed
`BudgetFriendlyReplayTranscriptManifestV2`. This replay-only artifact is
deliberately distinct from the production control-plane `TranscriptManifest`,
whose cross-runtime schema is different. It keeps the complete strict-JSON
transcript, unknown metadata, and unrounded word timings, and binds them to the
source bytes. Because the ranking itself is sealed,
`CandidateDecision.rankingManifestHash` now transitively binds the human
approval to the exact transcript and complete ordered candidate universe.

`approve-candidate` automatically writes two append-only, content-addressed
objects under `LOCAL_AUTORESEARCH_EVIDENCE_DIR`:

- `datasets/<rankingManifestHash>.json` contains the complete sealed
  `RankingManifest`, exact transcript, and all candidates in original order;
- `labels/<rankingManifestHash>/<candidateDecisionHash>.json` contains the
  exact sealed human approval and its approved rank.

The default evidence root is durable OS app data, never `output/` and never a
cache. An identical retry is idempotent. A filename collision with different
content, stale source/ranking/candidate binding, missing word timing, NaN,
reversed/non-monotonic timing, or a label without a matching candidate fails
closed before the operator command reports success. A dataset may safely exist
without a label after an interrupted write; such a dataset is not promotable
and cannot become a positive.

Engine choices are stored with semantics `unknown_not_human_label`. Only an
explicit sealed `CandidateDecision` produces the label semantics
`explicit_human_approval`; every other candidate remains unknown rather than
being inferred rejected.

The inbox never mutates the active research corpus. Promotion is an explicit
offline step that verifies every nested seal and exact hash join, skips and
reports interrupted datasets that have no approval, collapses multiple
approval events for the same candidate into one positive, and embeds the
sealed capture labels and canonical `CandidateDecision` events in the frozen
pack. Only hash-volatile top-level cache/output fields are removed from the
portable candidate projection; a hidden nested or absolute path fails closed
instead of silently changing candidate identity. Semantic prompt evidence and
unrounded transcript metadata remain unchanged:

```bash
python3 research/fixture_pack_v2.py \
  --capture-dir \
  --output-dir research/fixtures/bf-autoresearch-v2-pack-YYYYMMDD
```

Only after review should `replayManifest` point at that frozen pack. Trials
never read the mutable inbox directly.

Every frozen V2 pack declares one label-binding mode. Migrated historical
packs use `legacy_interval_v1`; new approval captures use
`candidate_hash_exact_v1`. Exact packs recompute source, transcript and
candidate identities, require at least one explicit human positive per source,
reject reused approval events or duplicate source hashes, and verify the
manifest, corpus index, label index, datasets and labels before any metric is
calculated. Missing files report `replay_artifacts_missing`; present but
invalid evidence reports `replay_integrity_invalid`.

## Status meanings

- `baseline`: sealed comparison point;
- `discard`: valid experiment that did not improve enough;
- `keep`: offline improvement with all fast/full guards passing;
- `crash`: invalid evidence, protected mutation, out-of-scope change, failed
  tests, or failed quality/data guardrail.

## Later slices

Editing, semantic-focus motion, Real-ESRGAN quality, runtime, and YouTube
equal-age outcomes will be separate loops. Their metrics must not be merged
into this selection score because that would make causal attribution
impossible.
