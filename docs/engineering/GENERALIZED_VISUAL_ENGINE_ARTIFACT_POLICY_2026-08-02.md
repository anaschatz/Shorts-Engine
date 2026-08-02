# Generalized Visual Engine artifact policy — 2026-08-02

## Purpose

This policy separates source-of-truth inputs from reproducible render products. It is a proposal only: no cleanup or `.gitignore` change was performed in the baseline task.

## Policy classes

| Class | Meaning |
| --- | --- |
| Must be tracked | Required to build, validate, or reproduce behavior in a clean clone. |
| May be tracked with justification | Small, stable evidence whose review value exceeds repository cost. |
| Must remain local | User/operator media, credentials, licensed inputs, large generated outputs, or private delivery material. |
| Must be reproducible | Generated from tracked inputs and a documented deterministic command. |
| Manual review before deletion | May contain unique source, approval evidence, publishing state, or non-reproducible work. |

## Path and artifact policy

| Artifact | Tracking policy | Reproducibility/retention | Deletion rule |
| --- | --- | --- | --- |
| Engine source, contracts, allowlisted recipes/primitives | Must be tracked | Deterministic tests required | Delete only through normal source review |
| Validated story/benchmark fixtures | Must be tracked when claims, provenance, and rights fields are complete | Stable schema and content hashes | Replace through immutable fixture revision |
| Small golden JSON contracts | Must be tracked | Must regenerate deterministically or document why immutable | Delete only with test migration |
| Story-specific experimental renderers | May be tracked only in an explicit archive/reference area | Not production dependencies | Manual architecture review before deletion |
| Story-owned first-party SVG assets | May be tracked with provenance and rights justification | Manifest must bind hash, role, and viewBox | Manual visual/provenance review |
| General asset vocabulary | Must be tracked if used by production | Allowlisted, local-only, hash/provenance-bound | Normal source review |
| `.local-cache/` hash caches | Must remain local; must be reproducible | LRU/TTL cleanup; never a source of truth | Safe to delete after confirming no cache path is the only copy |
| Temporary Chromium frames and HTML | Must remain local; must be reproducible | Per-job temp root; delete on completion/failure | Automatic cleanup after terminal job |
| Temporary PCM/WAV and FFmpeg intermediates | Must remain local; must be reproducible unless user-supplied source | Per-job retention only | Delete after artifact checksum/commit |
| Final MP4 exports | Must remain local/object storage by default | Regenerable from exact inputs; delivery lifecycle applies | Manual review if published or uniquely approved |
| Preview/calibration MP4 | Must remain local | Short TTL; always non-publishable without review | Automatic cleanup after review window |
| VTT/ASS generated captions | Must remain local by default; small golden samples may be tracked | Regenerate from caption manifest | Delete with corresponding render unless golden |
| Contact sheets | May be tracked with justification | Only representative approved benchmark sheets | Delete generated copies after report extraction |
| Sampled PNG frames | Must remain local; bounded hashes/metrics may be tracked | Reproducible from exact render | Delete after evidence report is committed/retained |
| Human-review evidence | May be tracked only as bounded sanitized score/report | Never include user paths, tokens, private URLs, raw media, or unbounded notes | Manual review; preserve signed approval decisions |
| Benchmark reports | Must be tracked when schema-stable, sanitized, and bound to commit/config/input hashes | Regenerate in CI/staging where possible | Keep historical release-gate reports |
| Render reports/manifests | May be tracked as selected goldens; otherwise artifact storage | Must bind source, plan, renderer, and output hashes | Retention follows owning render |
| `deliverables/` | Must remain local | Treat as operator-owned and potentially non-reproducible | Always manual review before deletion |
| Publishing receipts/schedules | Must remain local or protected operational storage | Preserve audit state without credentials | Never bulk-delete; retention policy required |
| Credentials, OAuth files, `.env` values | Never tracked | Re-created through secret manager/operator auth | Revoke before secure deletion if exposed |

## Current storage baseline

File-level snapshot after validation:

- `.local-cache/`: 2,773,948 KiB on disk (about 2.65 GiB), dominated by `realesrgan-v2` and `lossless-cuts-v1` hash caches.
- `deliverables/`: 116,044 KiB (about 113.3 MiB on disk).
- `showcase/evidence/`: 61,028 KiB (about 59.6 MiB on disk).
- `showcase/assets/`: 26,572 KiB (about 26.0 MiB on disk).
- Dark Curiosity eval data: 228 KiB.
- Wow story-owned SVG assets: 168 KiB.

### Safe cleanup estimate

The two clearly named, hash-partitioned caches are:

- `.local-cache/realesrgan-v2`: 1,481,160 KiB.
- `.local-cache/lossless-cuts-v1`: 1,172,640 KiB.

Combined conservative cleanup candidate: **2,653,800 KiB, approximately 2.53 GiB**.

This estimate excludes `.local-cache/work` (about 122 MiB), transcripts, visual-analysis data, all showcase media/evidence, and all deliverables because their exclusive-source status was not proved. A future cleanup task may increase the safe total only after verifying that every retained artifact is reproducible or backed up.

## Required generated-artifact contract

Every generated artifact retained outside an ephemeral job directory should record:

```text
schemaVersion
artifactType
contentHash
source/input hashes
plan/compiler/style versions
creation command or job type
technical media metadata when relevant
publishable=false by default
humanReview status
retention class and expiry
```

Reports committed to Git must be bounded and sanitized. They must not contain local absolute paths, usernames, filenames derived from private uploads, object-storage keys, delivery URLs, tokens, raw provider output, or user identifiers.

## Proposed cleanup workflow for a later task

1. Snapshot branch, HEAD, dirty paths, and sizes.
2. Run a value-redacting secret scan.
3. Generate a deletion manifest containing path category, byte count, reproducibility proof, and owner.
4. Require explicit confirmation for `deliverables/`, published outputs, unique source media, and human approval records.
5. Delete caches/intermediates only; never source or user deliverables in the same operation.
6. Run lint, build, focused render tests, and full tests.
7. Report bytes actually reclaimed and any files retained due to uncertainty.

## `.gitignore` decision

No `.gitignore` change is justified in this baseline commit. The desired policy is clear, but some current directories mix evidence, source-like manifests, and generated files. Step 2 or a dedicated artifact-normalization task should first move source-of-truth fixtures/goldens into explicit tracked roots and make generated roots unambiguously reproducible.
