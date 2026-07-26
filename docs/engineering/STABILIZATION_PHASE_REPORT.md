# ShortsEngine stabilization phase report

Date: 2026-07-26
Branch: `codex/production-beta-vertical-slice`

## Scope and cancelled work

This phase intentionally stops before production infrastructure. Seven earlier
commits that introduced or wired PostgreSQL identity, OIDC, R2 lifecycle,
distributed workers, football previews, approved renders, and a production web
flow were cancelled through two traceable revert commits:

- `0e0aad8` removes the production integrations;
- `92b88b8` removes the async production runtime foundation.

The older, dormant adapter prototypes already present in the pre-production
snapshot remain in the repository, but this phase does not wire or extend them.
The final application entrypoint remains `server/app.cjs`. No OIDC,
PostgreSQL, R2, object-storage, or distributed-worker runtime was started.

## 1. Baseline and final verification

| Gate | Baseline | Final |
| --- | --- | --- |
| Node lint | Pass | Pass |
| Node build smoke | Pass | Pass |
| Node tests | 1,564 total: 1,553 pass, 6 skip, 5 cancelled by per-file timeout | 1,585 total: 1,580 pass, 5 skip, 0 fail/cancel |
| Python tests | 238 discovered, 35 import/fixture errors on unprepared Python 3.14 | 496/496 pass in clean CPython 3.13 environment |
| Python modules in fresh interpreters | 25/48 pass | 50/50 pass |
| Node/Python contract tests | Not present | 3/3 pass |
| HookGate deterministic offline evaluation | Pass, 7 fixtures | Pass, same metrics and fingerprints |

The old Node command applied a 120-second timeout to every file while forcing
all files through one serial queue. A test file could therefore time out while
waiting, even though its tests had not started. The replacement runner retains
deterministic serial execution and enforces one bounded suite timeout.

## 2. Architecture before and after

### Before

```text
Node API / local queue / human review / render orchestration
                      |
        legacy, unversioned JSON + absolute paths
                      |
vendored Python worker and separate root Python implementation
```

Runtime ownership was broadly correct, but the Node/Python protocol exposed
filesystem layout and internal artifact shapes. Offline Python imports could
load live evaluation, dotenv, OpenCV, and NumPy transitively. Report assembly
and media probing were hidden inside large production modules.

### After

```text
Node: API, projects, orchestration, quotas, persistence interfaces
                      |
     versioned v1 schemas + validation + opaque IDs/hashes
                      |
Python: analysis, ranking, HookGate, rendering and media QA
```

This remains one application plus a worker-process boundary; no microservice
was added. The legacy bridge remains operational until its current job envelope
can supply complete candidate timing and HookGate evidence. It is not
misrepresented as migrated.

## 3. Versioned contracts

Protocol v1 is defined in:

- `contracts/node-python/v1/protocol.schema.json`;
- `server/python-worker-contracts.cjs`;
- `shorts_generator/worker_contracts.py`.

It validates analysis request/result, render request/result, candidate,
HookGate decision, artifact manifest, and structured error response. Both
runtimes validate the same fixture. Contracts reject absolute paths, unknown
top-level fields, invalid hashes, unsupported versions, broken artifact links,
and unbounded/free-form error codes. Compatible additions use `extensions`;
breaking changes require a new major contract version.

The migration and ownership decision is recorded in
`docs/architecture/adr-node-python-worker-boundary-v1.md`.

## 4. Modules split

| Original module | Before | After | Extracted module | Responsibility |
| --- | ---: | ---: | --- | --- |
| `shorts_generator/hook_gate_v3.py` | 1,146 | 1,037 | `hook_gate_report.py` (142) | deterministic decision-report assembly |
| `shorts_generator/production_workflow.py` | 1,051 | 991 | `media_probe.py` (82) | FFprobe/OpenCV media metadata probing |

Public imports and patch points remain compatible. The split was deliberately
small: no wholesale rewrite and no generic framework was introduced.

## 5. Largest source files after stabilization

| Lines | File |
| ---: | --- |
| 7,658 | `shorts_generator/local/clipper.py` |
| 5,927 | `server/render-job.cjs` |
| 5,848 | `server/analysis.cjs` |
| 2,905 | `server/app.cjs` |
| 2,834 | `shorts_generator/highlights.py` |
| 2,594 | `server/scoreboard-ocr.cjs` |
| 2,581 | `server/pipelines/narrated-short/animation/motion-calibration-corpus.cjs` |
| 2,550 | `server/match-event-truth.cjs` |
| 2,094 | `server/jobs.cjs` |
| 1,849 | `server/adapters/sqlite-persistence-adapter.cjs` |
| 1,836 | `server/edit-plan.cjs` |
| 1,732 | `server/rendered-goal-proof.cjs` |
| 1,674 | `server/render.cjs` |
| 1,414 | `shorts_generator/ranker.py` |
| 1,397 | `shorts_generator/pipeline.py` |

The two safely characterized Python modules were reduced. The remaining large
files need responsibility-by-responsibility extraction in later stabilization
slices; changing all of them in one phase would increase video regression risk.

## 6. HookGate V2/V3 benchmark

The deterministic V3 reference remains:

| Metric | V3 |
| --- | ---: |
| Top-1 human acceptance | 100.0 |
| Pairwise ranking accuracy | 100.0 |
| Recall@5 | 100.0 |
| Boundary completeness | 100.0 |
| Caption readability | 92.7143 |
| Visual subject coverage | 70.2663 |
| Overall weighted quality | 96.2981 |

These figures cover seven curated fixtures. They are a regression-quality
benchmark, not virality evidence. Visual subject coverage is the weakest axis;
the tutorial fixture scores 23.864.

There is no honest 30-real-project V2/V3 result yet. The existing V2 shadow
artifact contains one source, fourteen candidates, and zero completed human
reviews, and explicitly recommends against production approval.

To prevent an invalid future claim, `research/hookgate_benchmark.py` now:

- rejects fewer than 30 projects;
- requires consecutive, non-selected-only, real-project collection metadata;
- requires all three product categories and explicit train/evaluation splits;
- requires hashed project/reviewer identities;
- computes V2/V3 acceptance, pairwise accuracy, recall@5, boundaries, captions,
  visual coverage, attribution failures, mean/p95 latency, cost, and cost
  coverage from the evaluation split only.

Its committed data is synthetic contract-test data created in memory and is
never reported as benchmark evidence. A real anonymized dataset must still be
collected.

## 7. Regressions found and fixed

- Offline imports failed when `python-dotenv` was absent.
- `research.runner` eagerly loaded live rendering/provider dependencies.
- String-based patches depended on package import order.
- YouTube publishing tests depended on deleted generated MP4 files.
- Node’s per-file timeout caused false cancellations in a serial suite.
- The Node/Python bridge had no shared path-free, versioned validation target.
- Future HookGate comparisons had no fail-closed dataset governance.

## 8. Remaining limitations and debt

- The 30-project real, consecutive, anonymized V2/V3 dataset does not exist.
- The legacy vendored Python bridge still uses its older path-bearing
  envelope; migration is blocked on complete upstream timing/HookGate data.
- `clipper.py`, `highlights.py`, `ranker.py`, `pipeline.py`, and several large
  Node modules still need incremental characterization and extraction.
- HookGate V3 still owns process-local caches; configuration still includes
  module-level environment-derived values.
- Dormant PostgreSQL/OIDC/R2 adapters from the earlier repository snapshot are
  technical debt. They are not production entrypoints and were not extended.

## 9. Video-output safety

No clip-selection rules, timeline values, caption layout, filters, pixels,
audio processing, encoding settings, review gates, or publishing behavior were
intentionally changed. The media-probe and HookGate-report extractions preserve
their public behavior, and the existing render/timeline/HookGate
characterization tests pass. Therefore this phase introduces no known video
output delta. This is regression evidence, not a claim that every possible
source video is pixel-identical.
