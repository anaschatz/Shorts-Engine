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
