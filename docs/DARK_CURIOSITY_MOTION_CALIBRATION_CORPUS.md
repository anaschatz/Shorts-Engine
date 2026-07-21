# Dark Curiosity Repository-Bound Motion Calibration

Status: Slice E2A implemented in shadow mode; no production threshold is
approved

Date: 2026-07-21

## Purpose

Slice E1 proves that consecutive-frame luma motion can be measured. Its unit
fixtures are engineering controls, however, and must not be presented as a
real calibration corpus. Slice E2A adds a stricter path whose observations are
resolved from the managed artifact repository:

```text
approved draft + declared source snapshot hashes
  -> exact narration alignment
  -> rebuilt timing context
  -> recompiled semantic plan + AnimationIR
  -> decoded MP4 Motion QA + browser geometry proof
  -> render manifest
  -> optional human motion review
  -> shadow corpus report
```

The older E1 engineering report remains useful for contract regression. It
cannot promote production limits.

## Repository evidence contract

`motionCalibrationCaseFromArtifacts()` receives one
`ContentArtifactRepository` plus seven required artifact IDs:

- `approval_bundle`;
- `narration_alignment`;
- `animation_timing_context`;
- `animation_plan`;
- `animation_ir`;
- `animation_qa_report`;
- `animation_render_manifest`.

It also accepts a nullable `animation_scene_dsl_plan` ID and a nullable
`animation_motion_review` ID. Raw envelopes are not accepted from the caller.
Every ID is resolved through `publicRecord()` and `readJson()`, so the artifact
must be present, available, JSON, within the size bound, and checksum-valid.

The resolver then recomputes and verifies:

- the canonical envelope body hash and content-addressed artifact ID;
- the exact project, revision, owner, type, and dependency set;
- the approved draft and narration-alignment contracts;
- the timing context rebuilt from the draft and alignment;
- the semantic plan and AnimationIR recompiled from those trusted inputs;
- every direct QA/manifest binding and their browser/motion proof hashes;
- the declared visual-master digest and decoded-frame-sequence digest across
  the chain, plus independently rebuilt metric configuration, segment ranges,
  readability-hold ranges, and observed geometry coverage.

The browser proof must show one isolated load, deterministic repeated seeks,
no external requests, the exact compiler-owned semantic ROI and caption zone,
the exact marked-label and semantic-route identities, all required
observations, and zero clipping, caption, route, focus, persistence,
legibility, or contrast violations. The Motion QA
must include the complete production check set, exact technical metadata,
sufficient active transitions, canonical temporal summaries, and the real
downscaled analysis dimensions. The semantic-v3 648×746 ROI is analyzed at
180×208; the legacy 648×740 ROI is analyzed at 180×206, not falsely reported
at the source ROI size.

## Story and source distinction

The draft hash identifies a revision; it is not by itself a distinct story.
The resolver derives two separate identities:

- `storyIdentityHash` from normalized substantive claims, source
  relationships, narration beats, on-screen text, language, and format, while
  excluding claim/beat/scene IDs and visual-only storyboard metadata;
- `sourceFingerprintHash` from canonical source URLs, publisher, source class,
  independence group, vertical, and format. Snapshot digests remain bound by
  the approved draft but cannot manufacture a new source set by themselves.

Both must be unique in a corpus. A pairwise hashed-token similarity gate also
rejects near-duplicate claim/narration variants. Changing only titles, topics,
thesis wording, identifiers, snapshot declarations, visual operations, or
operator metadata therefore cannot inflate the story count. Re-rendering the
same story is also rejected through duplicate draft, QA, manifest, browser
proof, motion proof, composition, MP4-digest, and decoded-frame-sequence
evidence.

## Homogeneous calibration stratum

All accepted observations must share one exact stratum:

- temporal metric, motion-analysis, semantic, hold, and segment policy IDs;
- motion threshold;
- provider, runtime, style, render profile, and render quality;
- output dimensions, fps, codec, and pixel format;
- analyzed dimensions and the complete normalized semantic ROI.

Mixing preview and final renders, runtime versions, thresholds, crop geometry,
or analysis policies is a hard validation error rather than a silent merge.

## Reviews and shadow candidates

`animation_motion_review` binds separate human `pass`/`fail` verdicts for jerk
and boundary continuity to the exact story identity, source fingerprint, QA,
render manifest, and MP4. Reviewer identity is stored only as a SHA-256
reference, and reason codes must agree with the verdicts.

The current local repository provides integrity and provenance within this
engine; it does not cryptographically authenticate the human reviewer. The
review artifact is pseudonymous, not a digital signature or third-party
attestation. Likewise, E2A binds the visual-master digest recorded by the
production render service but does not reopen retained MP4 bytes during report
compilation. Repository write access is therefore not an independent
attestation that a render or review occurred. These are additional reasons the
result remains advisory.

The same limitation applies to source snapshots in this slice: their canonical
URLs and declared digests are bound through the approved draft, but the corpus
compiler does not resolve and checksum the snapshot bytes itself. E2A is
therefore repository-integrity-only shadow evidence, not independently
authenticated decoded-render or source evidence.

For each metric, the candidate is a deterministic nearest-rank P95 of the
human-pass observations. Candidate generation requires:

- at least ten story- and source-distinct repository observations;
- review coverage for every case;
- at least two pass and two fail labels for jerk;
- at least two pass and two fail labels for boundary continuity;
- separable labels, no pass-distribution outliers, and compliance with the
  hard safety ceilings.

The report also calculates false accepts and false rejects. A P95 candidate may
carry at most the mathematically implied 5% false-reject rate among human-pass
observations and no false accepts. Even a fully separable corpus reaches only
`candidate_ready`, with `evidenceTrustLevel` fixed to
`repository_integrity_only`.
`productionThresholdsApproved` is fixed to `false`; a separate operator-owned
promotion mechanism is intentionally not implemented.

Serialized reports cannot self-attest. Validation requires the corresponding
already-resolved, repository-branded cases and rebuilds the canonical report.
Accessors, symbols, cycles, sparse arrays, unknown/private fields, paths,
credentials, raw frames, HTML, transcripts, and non-finite values fail closed.

## CLI

The offline doctor needs no network, API key, or billing account:

```bash
npm run dark-curiosity:motion:corpus -- doctor
```

Compile uses an artifact-ID manifest, schema version 2. The IDs must already
exist in the engine's local managed artifact repository:

```json
{
  "schemaVersion": 2,
  "cases": [
    {
      "draftArtifactId": "art_...",
      "alignmentArtifactId": "art_...",
      "timingArtifactId": "art_...",
      "scenePlanArtifactId": null,
      "planArtifactId": "art_...",
      "irArtifactId": "art_...",
      "qaArtifactId": "art_...",
      "renderManifestArtifactId": "art_...",
      "reviewArtifactId": null
    }
  ]
}
```

```bash
npm run dark-curiosity:motion:corpus -- \
  compile --input data/motion-corpus/artifact-id-manifest.json \
  --output data/motion-corpus/calibration-report.json
```

Case resolution uses a fixed pool of at most four concurrent repository
resolvers, preserves manifest order, and stops assigning new work after the
first failure. A valid manifest with hundreds of cases therefore cannot start
hundreds of full artifact chains at once.

The emitted report contains only bounded artifact IDs, hashes, profile
metadata, allowlisted metrics, and review verdicts. It contains no filesystem
paths, raw frames, frame-hash arrays, HTML, narration text, provider output,
environment values, API keys, or credentials.

## Honest current inventory

There are three source-story engineering fixtures but currently zero eligible
full production calibration chains:

- GPS rollover and Baychimo have local source snapshots and draft-bound timing
  fixtures, but no complete repository-bound production render/review chain;
- Wow Signal has no local source snapshot, and its committed 300-frame timing
  fixture is only a short benchmark subset;
- the existing decoded Wow MP4 is a legacy ten-second, two-scene benchmark,
  not a full semantic-v3 story render;
- orphan MP4 files without draft, alignment, IR, QA, manifest, and checksum
  bindings are ineligible.

E2A therefore reports a blocked corpus today. The next operational step is to
produce complete chains for the current three stories, then add seven new
source-backed stories with exact local narration alignments and human reviews.
Only then should the shadow candidates be evaluated. Direction-aware optical
flow, OCR readability, continuous geometry sampling, and true cross-sentence
object identity remain later slices.
