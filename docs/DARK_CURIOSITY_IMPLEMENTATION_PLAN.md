# Dark Curiosity Engine — Implementation and Validation Plan

Status: core pilot implemented; continuous-animation Slice A validated separately
Owner model: one operator, one YouTube channel, YouTube-only revenue
Last updated: 2026-07-13

## 1. Decision

Build one source-backed narrated content engine for a single **Dark Curiosity** channel. Reuse the existing `narrated_short` pipeline and add a new content vertical; do not create another footage clipper and do not launch three channels.

The channel will test three original formats:

1. `documented_mystery_v1` — evidence chain ending in the strongest defensible explanation or unresolved question;
2. `deepest_iceberg_layer_v1` — one obscure layer of a known mystery, historical anomaly, or technology story and why it matters;
3. `speculative_what_if_v1` — clearly labelled science-fiction or constrained thought experiment.

Every Short must be built from an approved claim pack, an original script, licensed narration, and original or explicitly licensed visual assets. Reddit readings, copied podcasts, ripped long-form videos, borrowed gameplay, current-crime accusations, and automatic publishing are outside the MVP.

## 2. Success condition

The engineering milestone is not “the renderer works.” It is:

> One operator can turn a verified research pack into a publishable 1080x1920 Short, with narration, synchronized captions, provenance, and passing QA, in at most 60 minutes of human work after research is ready.

The business milestone is:

> A 30-video controlled test produces at least one repeatable format whose cohort metrics and production economics justify further investment.

The engine is frozen if the content experiment fails. More templates, providers, automation, or channels are not a substitute for audience evidence.

## 3. Scope lock

### Included in MVP

- one channel;
- one language for the entire 30-video test;
- three formats;
- one voice profile;
- five reusable visual scene families;
- manual source selection and verification;
- optional structured script assistance behind strict JSON contracts;
- uploaded narration plus one commercially licensed TTS adapter;
- word-level captions;
- preview and final render profiles;
- content, rights, audio, timeline, and output QA;
- manual upload to YouTube;
- manual analytics import after publishing.

### Explicitly excluded

- Reddit or website scraping;
- ingesting other creators' podcasts, audiobooks, or mystery videos;
- GTA or third-party gameplay;
- automatic topic discovery;
- automatic fact approval;
- photorealistic AI reconstructions of real events;
- background music in the first ten videos;
- automatic publishing;
- three simultaneous channels;
- a general-purpose editor;
- multi-user SaaS features;
- analytics-driven prompt mutation.

## 4. What already exists

The existing implementation already provides the infrastructure foundation:

- Project v2 supports `narrated_short` without fake uploads;
- durable versioned jobs dispatch through `pipeline-registry.cjs`;
- immutable content artifacts and exact-revision approvals exist;
- ContentBrief, ClaimLedger, NarrativeScript, Storyboard, NarrationManifest, and TimelineIR have deterministic hashes;
- SVG scenes render through isolated headless Chromium;
- FFmpeg produces a verified 720x1280 H.264 silent preview;
- the old clip pipeline remains isolated and backward compatible;
- the complete repository test suite is green.

The current narrated contracts and SVG renderer are football-specific, and the render job uses estimated silent timing. These are the primary product gaps—not queues, persistence, upload infrastructure, or another orchestration framework.

Continuous-animation Slice A now adds a separate, non-production benchmark path:

- strict provider-neutral `AnimationIR v1` and motion budget;
- isolated `hyperframes_benchmark` provider using `@hyperframes/producer` 0.7.55;
- engine-owned SVG/custom interpolation with no generated renderer code, GSAP, CDN, or remote assets;
- 300-frame 720×1280 and 1080×1920 Wow Signal proofs with manifests and motion QA;
- unchanged production pilot and unchanged default SVG keyframe renderer.

This does not raise the product-readiness estimate by itself. It proves renderer feasibility, not content-market fit, 30–40 second pacing, aligned narration choreography, or repeatable human preference.

Strict readiness estimate:

- shared infrastructure: roughly 60–70% reusable;
- publishable Dark Curiosity product: roughly 25–35% complete.

The missing 65–75% contains the high-risk work: source integrity, content compilation, narration, generic visuals, synchronized captions, rights evidence, and release-blocking QA.

## 5. Target workflow

```text
manual topic selection
        |
        v
SourcePack -> ClaimLedger -> ContentBrief
        |           |             |
        +-----------+-------------+
                    v
             original script
                    v
              storyboard
                    v
          exact content approval
                    v
        narration + word alignment
                    v
                TimelineIR
                    v
       SVG/Chromium + ASS + FFmpeg
                    v
       content/rights/audio/video QA
                    v
       contact sheet + provenance pack
                    v
             final MP4 export
                    v
          manual YouTube publishing
```

There are two human gates:

1. **Content approval:** exact brief, claims, script, and storyboard revision.
2. **Publish approval:** exact final render and QA/provenance hashes.

A content change invalidates narration, timeline, render, and QA. A style-only change invalidates timeline/render/visual QA but must reuse narration.

## 6. Contract changes

Do not replace the narrated pipeline with `dark_curiosity_pipeline`. Add a vertical registry to the existing pipeline:

```json
{
  "schemaVersion": 2,
  "verticalId": "dark_curiosity",
  "formatId": "documented_mystery_v1",
  "language": "en",
  "topic": "...",
  "thesis": "...",
  "targetSeconds": 32,
  "sourceRefs": ["src_..."],
  "riskClass": "ordinary"
}
```

### 6.1 Backward compatibility

- keep schema v1 football fixtures valid;
- normalize missing `verticalId` to `football_explainer` for existing artifacts;
- introduce schema v2 only for new vertical-aware artifacts;
- register format and storyboard validators by `verticalId`;
- never add dark-curiosity branches inside the football SVG renderer.

### 6.2 SourcePack

Each source record stores only bounded evidence and provenance metadata:

- canonical URL;
- source title and publisher;
- publication and operator-verification timestamps;
- source class: `primary`, `institutional`, `reputable_secondary`, or `other`;
- snapshot/file hash;
- a short operator-written evidence note;
- rights class for any visual/audio asset;
- retrieval mode and operator identity.

Do not copy entire articles into artifacts. The snapshot hash proves which material was checked; the claim ledger stores the operator's bounded factual summary.

### 6.3 Claim rules

- every factual statement needs two independent credible sources or one definitive primary record;
- extraordinary, disputed, medical, scientific, or accusatory claims require two independent credible sources and manual review;
- speculation uses `speculation` and must be spoken as speculation;
- unresolved questions use `uncertain`, never a fabricated conclusion;
- quotes require an exact source and bounded excerpt;
- claims about identifiable private people, active criminal cases, or recent sensitive events block the MVP;
- the script provider cannot introduce a proper noun, number, quote, or factual claim absent from the ledger.

### 6.4 Script roles

Use a vertical-neutral sequence:

```text
hook -> context -> evidence -> turn -> payoff
```

Format-specific validators may rename the middle semantics, but the first beat must open a curiosity gap and the final beat must resolve exactly what the hook promised. Target 25–40 seconds and validate actual reading rate after narration.

### 6.5 Dark Curiosity visual DSL

Add a separate allowlisted DSL:

- `set_heading`
- `show_evidence`
- `show_source_badge`
- `place_marker`
- `connect_nodes`
- `draw_route`
- `advance_timeline`
- `reveal_layer`
- `compare_scale`
- `highlight_region`
- `show_uncertainty`
- `camera_push`
- `fade_or_blackout`

No arbitrary HTML, CSS, remote URLs, JavaScript, or filesystem paths are accepted in storyboard data.

### 6.6 RightsAssetRecord

Every asset that appears or is heard in the rendered bill of materials needs an immutable rights record:

```json
{
  "assetId": "asset_...",
  "artifactId": "art_...",
  "role": "visual|narration|font|sfx|music|quote",
  "origin": "first_party|commissioned|licensed|public_domain|generated",
  "rightsholder": "...",
  "commercialUseAllowed": true,
  "derivativesAllowed": true,
  "youtubeAllowed": true,
  "attributionRequired": false,
  "termsSnapshotArtifactId": "art_...",
  "termsSnapshotHash": "...",
  "expiresAt": null,
  "status": "cleared"
}
```

`pending`, `unknown`, expired, missing terms evidence, or undeclared remote assets block final export. “Credit given,” “fair use,” or “I do not own this” are not automatic rights clearance. Fonts and voices are assets too.

## 7. Five-scene MVP library

1. **Hook scene** — high-contrast question or counterintuitive claim with one original symbol/shape transition.
2. **Evidence scene** — claim cards connected into an evidence chain; optional source-class badge, not a fake screenshot.
3. **Map/timeline scene** — markers, paths, dates, and progressive descent through an “iceberg” or sequence.
4. **System/scale scene** — node diagram, cause/effect flow, or scale comparison for history, technology, and sci-fi.
5. **Payoff scene** — conclusion, uncertainty label, or explicit speculative outcome.

All scenes use bundled fonts, original vector primitives, deterministic motion, safe zones, and a visible illustration/reconstruction disclosure where needed. Remote assets are disabled during render.

## 8. Implementation phases

Effort ranges assume one focused developer and the current repository state. They are planning ranges, not delivery promises.

| Phase | Output | Effort | Exit criterion |
|---|---|---:|---|
| 0 | Scope and baseline lock | 1 day | Legacy and narrated baseline recorded; no unrelated refactor |
| 1 | Vertical-aware contracts | 3–5 days | 12 fixtures validate/fail deterministically; football v1 still passes |
| 1B | Manual/structured content compiler | 3–5 days | Claim-bound script/storyboard generated without new facts |
| 2 | Dark Curiosity scene renderer | 5–8 days | All five scenes produce stable reference frames at both profiles |
| 3 | Narration and captions | 4–7 days | Real audio, exact word alignment, readable burned captions |
| 4 | QA, rights, provenance | 4–6 days | Any blocker prevents final export; contact sheet/report generated |
| 5 | Operator workflow | 3–5 days | One fixture runs research pack → final export without code edits |
| 6 | Pilot hardening | 10 manual pilots | ≥90% first-pass technical success; ≤60 min operator time |
| 7 | Channel validation | 30 published videos | Predeclared go/revise/freeze decision |

### Phase 0 — Freeze the boundary

Tasks:

- record current full-suite result and one reference silent render;
- preserve `clip` and football narrated fixtures as compatibility tests;
- add a feature flag/vertical registry entry for `dark_curiosity`;
- declare one experiment language and voice profile;
- set a hard engineering budget before publication begins.

Do not extract generic renderer utilities until a new implementation actually needs them.

### Phase 1 — Contracts and fixtures

Tasks:

- split shared contract primitives from football-specific storyboard validation;
- add `vertical-registry.cjs`;
- replace the core `football_visual` TimelineIR assumption with registered `visual_scene` tracks while preserving football normalization;
- add v2 ContentBrief/ClaimLedger fields and migration normalization;
- implement the three format validators;
- implement dark-curiosity storyboard/DSL validation;
- create four fixtures per format: valid, unsupported claim, unsafe source/risk, invalid payoff/visual;
- add content similarity checks against approved/published script hashes;
- add artifact invalidation tests.

### Phase 1B — Content compiler

The current create endpoint accepts an already completed bundle; that is not a usable production workflow. Add compilation in two controlled steps:

1. deterministic/manual planners that turn a verified SourcePack and ClaimLedger into editable script/storyboard artifacts;
2. an optional structured model adapter that receives claim IDs and bounded evidence only.

Provider rules:

- strict JSON schema output;
- no direct renderer access;
- no new URLs, names, dates, numbers, quotes, or claims;
- one bounded schema-repair attempt;
- invalid second response becomes `needs_review`;
- model, prompt version, parameters, request hash, and raw response artifact are recorded;
- topic research and factual approval remain human-controlled in the MVP.

Acceptance:

- changing providers cannot change contract semantics;
- an injected unsupported fact blocks the draft;
- the manual provider remains sufficient for fixtures and fallback;
- no provider network call occurs during render.

Acceptance:

- model/provider output cannot bypass claim or storyboard validation;
- identical inputs produce identical hashes;
- every script sentence maps to approved claims or explicitly labelled speculation;
- existing football and clip tests remain green.

### Phase 2 — Original visual renderer

Tasks:

- add a scene registry keyed by vertical and template version;
- implement the five SVG scene families;
- add deterministic transitions: reveal, push, line draw, pulse, and fade;
- bundle and hash fonts;
- enforce text measurement, maximum lines, and safe zones;
- generate golden PNGs at 720x1280 and 1080x1920;
- add perceptual/reference-frame regression checks with bounded tolerance;
- store renderer, Chromium, font, and template versions in the render manifest.

Acceptance:

- no network access during rendering;
- no external copyrighted visual is needed for a complete Short;
- the first meaningful visual appears in the opening second;
- no scene remains visually unchanged beyond the configured stasis limit;
- the same TimelineIR produces stable reference frames.

### Phase 3 — Narration, alignment, and captions

Implement in this order:

1. uploaded WAV narration with declared commercial-use rights;
2. local alignment through existing word-timestamp tooling;
3. ASS word-level captions and safe-zone tests;
4. one licensed TTS provider behind `narration-provider-adapter.cjs`;
5. content-hash narration cache and pronunciation dictionary.

Render requirements:

- final profile: 1080x1920, 30 fps, H.264/yuv420p, AAC 48 kHz;
- preview profile: 720x1280;
- narration duration drives TimelineIR; estimated silent timing cannot create a final export;
- FFmpeg loudness normalization uses a documented internal profile and records measured results;
- no background music until narration-only videos pass the first ten-video pilot.

Acceptance:

- narration covers the approved script exactly;
- no unaligned or extra words;
- captions are derived from actual audio timing;
- changing only style never regenerates narration;
- missing consent/rights metadata blocks final rendering.

### Phase 4 — QA and provenance gates

Create a single `QaReport` with blocking failures and non-blocking warnings.

Blocking gates:

- unsupported or unapproved factual claim;
- missing source snapshot/hash;
- high-risk topic outside MVP scope;
- missing asset or narration commercial-use rights;
- script/draft/approval hash mismatch;
- incomplete audio alignment;
- captions outside safe zones or unreadable;
- timeline overlap/out-of-bounds duration;
- missing font/template/version;
- black, corrupt, frozen, silent, wrong-dimension, or wrong-codec final output;
- missing provenance report.

Advertiser/platform safety is evaluated separately across narration, captions, visuals, title, thumbnail, description, and tags. A safe script does not excuse a graphic thumbnail. Realistic synthetic depictions of real people, places, or events set `aiDisclosureRequired`; a missing required disclosure blocks release. Potential limited-ads content requires an explicit operator acknowledgement and remains visible as commercial risk.

Warnings:

- hook/payoff semantic mismatch;
- high similarity to recent scripts;
- reading rate near bounds;
- excessive visual stasis;
- too many words on screen;
- source diversity below the preferred level.

Artifacts:

- `qa_report.json`;
- `provenance_report.json`;
- `rights_manifest.json`;
- `contact_sheet.png`;
- `export_metadata.json`;
- exact final MP4 checksum.

Final exports remain unavailable while any blocking gate is open.

### PublishGuard

The release boundary produces a short-lived immutable decision:

```json
{
  "decision": "publishable",
  "approvedRevision": 4,
  "outputHash": "...",
  "qaReportHash": "...",
  "provenanceHash": "...",
  "releaseToken": "...",
  "expiresAt": "..."
}
```

Any future uploader must accept only `releaseToken + outputHash`, never a filesystem path or export ID alone. Warnings may be explicitly acknowledged and audited. Missing rights, unsupported claims, probable platform violations, or output-hash mismatches cannot be overridden.

### Phase 5 — Operator workflow

Extend the existing API rather than building a full editor:

```text
POST /api/narrated-projects
POST /api/narrated-projects/:id/draft
POST /api/narrated-projects/:id/approve
POST /api/narrated-projects/:id/narration
POST /api/narrated-projects/:id/narration/generate
POST /api/narrated-projects/:id/render
GET  /api/narrated-projects/:id/qa
POST /api/narrated-projects/:id/publish-approve
POST /api/narrated-projects/:id/revise
```

Add a CLI wrapper for fixture and operator use. A minimal review UI is authorized only if ten manual pilots show that JSON/CLI review, rather than content quality, is the production bottleneck.

Acceptance:

- no source code edits are required to make a new video;
- every mutation is revisioned and idempotent;
- job restart does not repeat completed provider work;
- public responses expose safe summaries, not local paths or raw provider output;
- final download requires a passing QA hash and publish approval.

## 9. Concrete repository backlog

### Modify

- `server/pipelines/narrated-short/contracts.cjs` — extract shared v2 primitives and keep v1 normalizer;
- `server/pipelines/narrated-short/timeline-compiler.cjs` — compile generic registered scenes and actual narration;
- `server/pipelines/narrated-short/render-job.cjs` — remove silent timing from final profile, add QA gates;
- `server/pipelines/narrated-short/video-compositor.cjs` — audio mux, ASS captions, transitions, final profile;
- `server/pipelines/pipeline-registry.cjs` — validate new narration/QA payload stages;
- `server/app.cjs` — narration, QA, and publish-approval endpoints;
- `server/storage/artifact-store.cjs` — add any missing rights/source snapshot artifact types;
- `server/repositories/content-artifact-repository.cjs` — validate new immutable JSON artifact types.
- `server/repositories/content-approval-repository.cjs` — enforce one active approval per revision and deterministic revocation/invalidation.

### Add

```text
server/pipelines/narrated-short/
  vertical-registry.cjs
  shared-contracts.cjs
  invalidation.cjs
  export-metadata.cjs
  dark-curiosity/
    formats.cjs
    contracts.cjs
    storyboard-validator.cjs
    visual-dsl.cjs
    scene-svg.cjs
  qa/
    content-qa.cjs
    rights-qa.cjs
    audio-qa.cjs
    timeline-qa.cjs
    rendered-video-qa.cjs
    qa-orchestrator.cjs
  narration/
    upload.cjs
    align.cjs
    pronunciation-dictionary.cjs

server/adapters/
  narration-provider-adapter.cjs

renderer/narrated/
  vertical-registry.mjs
  dark-curiosity/
    hook-scene.mjs
    evidence-scene.mjs
    map-timeline-scene.mjs
    system-scale-scene.mjs
    payoff-scene.mjs

eval/narrated/dark-curiosity/
  fixtures/
  reference-renders/
  run-eval.mjs
```

Tests are added one slice at a time; no phase proceeds with broken legacy tests.

## 10. First publishable vertical slice

Use one `documented_mystery_v1` fixture with no external image and no music:

```text
2 verified sources
-> 3–4 approved claims
-> 30-second original script
-> hook + evidence + map/timeline + payoff storyboard
-> uploaded/licensed narration
-> actual word alignment
-> 720x1280 preview
-> exact content approval
-> 1080x1920 final
-> content/rights/audio/video QA
-> contact sheet + provenance
-> manual publish approval
```

This milestone must pass before adding TTS, the other two formats, more templates, or a UI.

## 11. Ten-video technical pilot

The first ten outputs are unlisted or internal review assets until they pass technical and editorial review.

Track per video:

- research minutes;
- script/revision minutes;
- render/retry minutes;
- provider and asset cost;
- first-pass QA result;
- failed gate codes;
- manual corrections;
- visual-template reuse;
- script-similarity score.

Pilot exit criteria:

- at least 9/10 pass the technical pipeline without code changes;
- no rights or unsupported-claim blocker is waived;
- no final file uses silent estimated narration;
- median post-research operator time is at most 60 minutes;
- at least three reviewers can understand the hook and payoff without additional context;
- no two outputs look like only a text swap of the same template.

If these fail, fix the dominant blocker only. Do not add features in response to general dissatisfaction.

## 12. Thirty-video channel experiment

### Design

- one channel;
- one language;
- 30 public Shorts;
- ten videos per format;
- all 30 topics selected before publishing begins to prevent cherry-picking;
- five uploads per week for six weeks, or a slower fixed cadence if quality cannot be maintained;
- rotate formats across the schedule instead of publishing one format in a single block;
- fixed duration band, voice, visual quality floor, and publishing window;
- no paid promotion;
- no deletion of weak results during the measurement window;
- record snapshots at 24 hours, 72 hours, seven days, and 28 days; compare formats primarily on equal-age seven-day data.

Do not launch a second channel during the experiment.

### Primary measurements

- chose-to-view rate;
- average percentage viewed;
- average view duration;
- engaged views;
- subscribers per 1,000 engaged views;
- rewatches where visible in Studio;
- median views per format cohort;
- first-pass render success;
- operator time and cash cost per Short.

Compare cohort medians, not the best-performing upload.

### Winner rule

A format is a winner only if all of these are true:

- its median seven-day engaged views is at least 25% above the second format;
- its median chose-to-view and average percentage viewed are at least the channel median;
- its subscribers per 1,000 engaged views are positive and at least the channel median;
- at least four of its ten videos beat the overall channel median engaged views;
- its best video contributes less than half of the format's engaged views.

This prevents one viral outlier from being mistaken for a repeatable format.

### Internal decision bands

These are experiment thresholds, not claims about the YouTube algorithm.

**Go:** after roughly 18–24 adequately distributed Shorts:

- median chose-to-view at least 65%;
- median average percentage viewed at least 85% for the 25–40 second band;
- at least two of the latest ten reach three times the cohort median;
- at least one subscriber per 1,000 engaged views;
- first-pass render success at least 90%;
- post-research operator time at most 60 minutes per Short.

**Revise content, not the engine:** chose-to-view 55–65% or average percentage viewed 70–85%. Change one variable—hook, pacing, or duration—at a time.

**Freeze:** after about 24 adequately distributed Shorts, chose-to-view remains below 55%, average percentage viewed below 70%, no format cohort improves, or successful videos depend on assets that cannot be licensed reliably.

If distribution is too low to evaluate 24 videos, the conclusion is “channel hypothesis unproven,” not permission for unlimited engineering.

## 13. Economics gate

Before YPP, Shorts advertising revenue is zero. Do not describe views as revenue.

After monetization, use only actual YouTube Studio RPM:

```text
cash_cost_per_short = narration + model + licensed_assets + compute
full_cost_per_short = cash_cost_per_short + operator_hours * chosen_hourly_value
break_even_engaged_views = full_cost_per_short / actual_shorts_rpm * 1000
```

Record both cash cost and full economic cost. The engine continues only if a winning format has a plausible break-even path based on the channel's own data.

No automatic publishing, analytics API, extra TTS provider, new channel, or generic editor is built before the 30-video decision.

## 14. Implementation order — next 15 tickets

1. Add vertical registry with football v1 compatibility.
2. Add v2 `verticalId`, `riskClass`, source class, and uncertainty contracts.
3. Add `documented_mystery_v1` valid and invalid fixtures.
4. Implement dark-curiosity storyboard DSL validator.
5. Implement hook SVG scene and golden render.
6. Implement evidence scene and source-class badge.
7. Implement map/timeline scene.
8. Implement system/scale scene.
9. Implement payoff/uncertainty scene.
10. Add uploaded WAV artifact and rights contract.
11. Align actual narration and compile caption timings.
12. Burn ASS captions and mux normalized audio.
13. Implement QA orchestrator and blocking export gate.
14. Generate contact sheet, provenance, rights, and metadata artifacts.
15. Add deterministic revise/invalidation and active-approval tests.
16. Run the first publishable fixture and begin the ten-video pilot.

Tickets 1–4 are the next coding slice. TTS is intentionally ticket 17 or later: first prove a rights-safe, actual-audio final render without coupling the MVP to a provider.

## 15. Final stop rules

Stop engineering and reassess if any of the following is true:

- the format needs copied footage to retain attention;
- facts cannot be checked in a sustainable amount of time;
- the operator repeatedly overrides rights or claim blockers;
- videos remain visually interchangeable after the five-scene system is complete;
- ten pilots cannot reach 90% first-pass technical success;
- 30 public videos show no repeatable format improvement;
- production cost cannot plausibly be recovered from actual channel data.

The engine is an amplifier. It cannot rescue an undifferentiated content thesis, unclear rights, or a channel that viewers consistently choose not to watch.

## 16. Implementation log

### 2026-07-11 — Slice 1 complete

Implemented tickets 1–4:

- vertical registry with inferred football v1 and Dark Curiosity v2 formats;
- schema v2 fields for vertical, source class, independence group, evidence notes, claim type/verdict/source links, and topic risk;
- strict unknown-field rejection for Dark Curiosity inputs;
- `documented_mystery_v1` Wow-signal fixture plus adversarial mutations;
- allowlisted Dark Curiosity visual DSL with claim/source reference checks, normalized coordinates, template semantics, and reconstruction disclosure;
- end-to-end API proof for create → draft → exact approval;
- explicit `contracts_only` render capability so Dark Curiosity render jobs fail closed until Slice 2 implements the renderer.

Next slice: implement the five original SVG scene families and switch the Dark Curiosity TimelineIR to `visual_scene` before enabling preview rendering.

### 2026-07-11 — Slice 2 complete

Implemented tickets 5–9 as a preview-only rendering slice:

- generic TimelineIR visual-track selection through the vertical registry, preserving football's `football_visual` track and selecting `visual_scene` for Dark Curiosity;
- versioned scene-renderer registry keyed by vertical, template, and exact template version, with explicit mismatch and unsupported-version failures;
- five deterministic original SVG families: hook, evidence/source badge, map/timeline, system/scale, and payoff/uncertainty;
- frame-based execution of the allowlisted Dark Curiosity DSL, including interpolation, XML escaping, camera motion, fades, and reconstruction disclosure;
- generalized headless-Chromium keyframe renderer with vertical, format, renderer-version, and template-version provenance in its manifest;
- Dark Curiosity `preview_available` capability limited to silent 720x1280 output marked `previewOnly: true` and `publishable: false`;
- fail-closed rejection of Dark Curiosity `final` render requests before Chromium or FFmpeg is invoked;
- deterministic renderer, registry, TimelineIR, job-boundary, compatibility, and opt-in Chromium → PNG → FFmpeg → ffprobe integration coverage.

Slice 2 deliberately does not add TTS, narration audio, captions, final export, QA orchestration, publishing, analytics, or additional formats. The next slice remains ticket 10: uploaded WAV plus its rights contract.

### 2026-07-11 — Slice 3A complete

Implemented ticket 10 as a rights-bound upload slice:

- strict, versioned, deterministic narration asset contract bound to the exact project revision, approved draft artifact/hash, and script hash;
- mandatory commercial-use declaration, ownership basis, rightsholder, and consent reference, with a mandatory license reference for licensed recordings;
- bounded multipart `POST /api/narrated-projects/:id/narration` ingestion that accepts uploaded bytes only—never local paths, remote URLs, or base64 JSON audio;
- RIFF/WAVE signature validation followed by real `ffprobe` inspection before commit;
- allowlisted uncompressed PCM, 48 kHz mono/stereo, finite duration greater than one second and at most 120 seconds, and a 32 MiB upload ceiling;
- immutable managed WAV and JSON manifest artifacts with SHA-256 checksums and dependency hashes;
- explicit active-narration pointer per project revision while preserving superseded narration artifacts;
- safe project, API, and render-job summaries with no storage key, filesystem path, or raw probe output;
- cleanup of uncommitted staging audio on validation/probe failure;
- real FFmpeg-generated PCM WAV → ingestion → ffprobe integration coverage plus adversarial rights, signature, codec, duration, revision, approval, ownership, replacement, and leakage tests.

Uploaded narration remains `uploaded_unaligned`, `aligned: false`, and `renderReady: false`. Preview rendering continues to use silent estimated timing, reports `narrationUsed: false`, and remains `previewOnly: true` / `publishable: false`. Dark Curiosity final rendering remains blocked. The next slice is ticket 11: actual local word alignment and narration-driven TimelineIR timing.

### 2026-07-11 — Slice 3B complete

Implemented ticket 11 as a local exact-alignment slice:

- asynchronous `POST /api/narrated-projects/:id/narration/align` dispatch through the existing `narrated_short` worker pipeline, with immutable project, approval, narration-manifest, WAV, script, and aligner-version references;
- reuse of the bounded Faster-Whisper subprocess adapter with explicit language, word timestamps, cancellation, timeout, model/device/compute-type identity, and `local_files_only=True` model loading;
- fail-closed `NARRATION_ALIGNER_UNAVAILABLE` behavior when either the local runtime or configured local model is absent, with no remote provider or estimated-alignment fallback;
- one shared deterministic speech-token normalization path using Unicode normalization, lowercase, whitespace tokenization, punctuation removal, and explicit apostrophe/hyphen handling;
- exact normalized word-sequence enforcement across all approved `spokenText` beats: missing, extra, reordered, changed-number, changed-name, paraphrased, or hallucinated words fail with bounded mismatch metadata and no transcript excerpts;
- strict versioned `narration_alignment` artifacts with deterministic hashes, 30 fps word timings, complete contiguous beat coverage, exact project/revision/hash binding, dependency hashes, and recorded provider configuration;
- frame conversion from the uploaded WAV's real duration, rejecting negative, non-finite, overlapping, zero-duration, and out-of-duration timestamps;
- active narration transition to `aligned: true` and `timingReady: true` while remaining `renderReady: false`; replacement WAV uploads reset the active pointer to `uploaded_unaligned` and preserve old immutable artifacts;
- TimelineIR compilation from real aligned duration and beat boundaries, with `timingMode: uploaded_aligned` plus exact alignment/audio references; unaligned previews remain explicitly `estimated_silent`;
- aligned previews use narration timing only and remain `narrationUsed: false`, `audioIncluded: false`, `previewOnly: true`, and `publishable: false`;
- regression coverage for exact matching, contract strictness, timestamps, stale bindings, runtime failure, timeout/cancellation, staging, idempotency, replacement invalidation, TimelineIR determinism, silent rendering, final blocking, and legacy pipeline compatibility.

Slice 3B deliberately adds no captions, audio muxing, normalization, TTS, final export, QA orchestration, publishing, or analytics. Dark Curiosity final rendering remains blocked before Chromium/FFmpeg. The next slice is ticket 12: ASS word-level captions plus narration audio muxing and normalization.

### 2026-07-11 — Slice 4 complete

Implemented ticket 12 as an audible review-preview slice:

- strict, versioned `caption_manifest` artifacts bound to the exact approved draft, narration manifest, WAV, and active alignment hashes;
- deterministic `dark_curiosity_word_v1` grouping that preserves every aligned word exactly once, stays within its source beat, uses no more than six words per cue and two lines of at most 28 characters, and rejects missing, duplicated, reordered, orphaned, overlapping, or out-of-duration caption data;
- deterministic `ass_caption_v1` generation at 720x1280 with bounded safe-zone placement, ASS override escaping, Unicode-safe text, and word-level `\kf` highlighting derived only from actual alignment frames—not storyboard `onScreenText`;
- immutable managed `caption_ass` artifacts with deterministic UTF-8 bytes, checksum, renderer-version identity, and caption/alignment dependencies;
- narration-only `dark_curiosity_speech_v1` loudness normalization using a real two-pass FFmpeg `loudnorm` flow targeting -16 LUFS, -1.5 dBTP, and 11 LU;
- strict immutable `audio_normalization_report` artifacts containing bounded measured input/predicted normalized-output values without raw FFmpeg output, commands, or filesystem paths;
- extension of the existing narrated compositor—without a second FFmpeg pipeline—to burn ASS captions, mux normalized AAC 48 kHz narration, and verify H.264/yuv420p, 720x1280, 30 fps, audio stream, sample rate, and duration through `ffprobe`;
- aligned preview summaries now report `narrationUsed`, `audioIncluded`, `captionsIncluded`, `captionsBurned`, and `audioNormalized` as true and expose only immutable artifact IDs/hashes;
- unaligned previews remain explicitly `estimated_silent`, while aligned audio never falls back to estimates;
- render idempotency now includes narration/alignment hashes plus caption, normalization, and compositor versions;
- deterministic contract, escaping, stale-binding, failure-safety, compositor, API, legacy compatibility, and real managed PCM WAV → ASS burn → loudnorm → AAC MP4 integration coverage.

No background music, TTS, QA orchestration, provenance generation, publishing, or analytics was added. Audible previews remain `previewOnly: true` and `publishable: false`; active narration remains `renderReady: false`. Dark Curiosity final rendering remains blocked before Chromium/FFmpeg. The next slice is ticket 13: the QA orchestrator and blocking export gate.

### 2026-07-12 — Slice 5 complete

Implemented ticket 13 as a deterministic technical-QA and export-gating slice:

- strict versioned `dark_curiosity_technical_v1` QA reports with canonical gate ordering, required-category coverage, exact immutable bindings, deterministic hashes, and bounded public summaries;
- modular blocking checks for approved content integrity, narration/visual rights, exact alignment and audio normalization, caption coverage/safe zones/ASS binding, TimelineIR duration/tracks/boundaries, and rendered MP4 integrity;
- real bounded `ffprobe` verification of H.264/yuv420p, AAC 48 kHz, dimensions, frame rate, stream counts, file size, and TimelineIR-compatible duration;
- real bounded FFmpeg `blackdetect`, `freezedetect`, and `silencedetect` analysis with the versioned thresholds: black ratio at most 0.35 and longest black interval at most 2 seconds; frozen ratio at most 0.60 and longest frozen interval at most 6 seconds; silent ratio at most 0.20 and longest silence at most 2 seconds;
- intentional short fades remain below the black-output blocker while full-black, excessive-freeze, and silent candidates fail closed;
- final candidates remain in managed uncommitted staging until the QA report passes; failed QA persists its immutable report, removes the candidate, creates no export record, and exposes no download boundary;
- passing 1080x1920 technical final candidates may be committed only after QA and are marked `technicalFinal: true`, `qaPassed: true`, and `publishable: false`;
- audible 720x1280 previews also receive technical QA and remain review-only/non-publishable; unaligned silent estimated previews remain outside the audible QA/final path;
- safe `GET /api/narrated-projects/:id/qa` retrieval returns only the latest exact active-revision report summary and ignores stale draft/audio/alignment bindings;
- render idempotency now includes the QA profile version, while job persistence/public polling retain only report IDs/hashes, counts, and bounded failed gate codes;
- real integration coverage proves managed aligned narration → burned captions/normalized MP4 → detector analysis → immutable passing QA report, plus real black/silent adversarial blocking.

No provenance/contact sheet, packaged rights manifest, export metadata package, release token, publish approval, publishing, TTS, music, or analytics was added. Technical finals remain non-publishable. The next slice is ticket 14: contact sheet, provenance, rights, and export metadata artifacts.

### 2026-07-12 — Slice 6 complete

Implemented ticket 14 as a pre-commit technical-evidence packaging slice:

- strict versioned contracts for `rights_manifest`, `provenance_report`, `export_metadata`, and the contact-sheet descriptor, with nested unknown-field rejection, canonical ordering, duplicate/missing dependency rejection, exact immutable bindings, and deterministic content hashes;
- a real bounded FFmpeg contact-sheet path that selects six deterministic non-terminal frames from the exact staged final candidate, creates a fixed 3x2 1080x1280 PNG, verifies its signature, size, dimensions, and checksum, and persists it as an immutable managed artifact;
- a rights manifest that packages narration ownership/license/consent evidence, source snapshot hashes and classes, original engine-generated visual template provenance, managed font/version identity, and reconstruction disclosure requirements without inventing or overriding missing rights;
- a provenance dependency graph covering the exact approved draft and its four source artifacts, narration/audio/alignment, caption manifest/ASS, normalization, TimelineIR, QA, rights manifest, contact sheet, renderer/compositor/template versions, and final MP4 checksum;
- technical export metadata bound to real probed duration, dimensions, frame rate, codecs, pixel format, sample rate, QA profile/hash, evidence artifact hashes, and disclosure flags while remaining `technicalFinal: true`, `qaPassed: true`, `publishable: false`, and `publishApprovalRequired: true`;
- one package orchestrator that validates common project/revision/active-approval/output/QA bindings and every cross-artifact checksum before the existing `commitOutputStage` and export-record boundary;
- package failure now removes the uncommitted MP4 candidate, creates zero exports, returns bounded artifact/error codes, and retains only safe immutable evidence or diagnostic artifacts already produced;
- render idempotency includes the evidence profile version, while durable job polling exposes only bounded package status plus artifact IDs/hashes—never paths, storage keys, commands, or raw FFmpeg/ffprobe output;
- deterministic contract/adversarial coverage, package-failure/no-export proof, durable summary recovery, real FFmpeg PNG generation, and legacy clip/football/object-storage regression coverage.

No publish approval endpoint, PublishGuard, release token, uploader, YouTube metadata generation, thumbnail generation, TTS, music, analytics, revise/invalidation workflow, new UI, or new format was added. Technical finals remain non-publishable. The next slice is ticket 15: deterministic revise/invalidation and active-approval tests.

### 2026-07-12 — Slice 7 complete

Implemented ticket 15 as a deterministic revision and invalidation slice:

- authenticated, ownership-checked `POST /api/narrated-projects/:id/revise` with a bounded strict request, exact expected-revision check, normalized Dark Curiosity bundle, deterministic request identity, optional hashed idempotency key, no-op rejection, and exactly one revision increment;
- one central invalidation matrix: explicit `content` changes always clear `activeNarration`, while `style_only` is accepted only when brief, claim ledger, and script hashes are identical and the validated storyboard hash changes;
- every successful revision creates new immutable `content_brief`, `claim_ledger`, `narrative_script`, `storyboard`, `approval_bundle`, and strict versioned `invalidation_report` artifacts, but never auto-approves the new draft;
- style-only narration reuse preserves the exact managed audio artifact and checksum without copying bytes or invoking an aligner, transcription model, FFmpeg, or external provider; it creates new revision-bound narration JSON and, when previously aligned, new revision-bound alignment JSON that depends on the historical alignment and retains identical word/beat timings;
- content changes never infer narration reuse, even when spoken text happens to remain unchanged; narration, alignment, captions, normalization, TimelineIR, render, QA, and evidence must be recreated;
- historical immutable artifacts and technical exports are retained, but exact revision/draft checks prevent them from becoming current or producing a new render/export; queued stale render jobs fail at the existing pre-render revision boundary;
- projects expose only a bounded last-invalidation summary, and local plus SQLite recovery preserve its exact revision state without paths, storage keys, artifact bodies, provider output, or secrets;
- content approval storage now enforces at most one active approval per project revision, distinguishes exact replay from configuration conflict, deterministically revokes a replaced draft approval, fails closed on duplicate-active lookup, and deterministically reconciles adversarial persisted duplicates during recovery.

The invalidation matrix is therefore:

| Change | Narration audio | Narration/alignment JSON | Downstream render artifacts | New approval |
| --- | --- | --- | --- | --- |
| `content` | historical only; not current | invalidated; `activeNarration` cleared | stale and must be regenerated | required |
| `style_only` | exact artifact/hash reused | rebound to the new revision/draft; timings preserved when aligned | stale and must be regenerated | required |

Technical finals remain `publishable: false` and `publishApprovalRequired: true`. No publish approval, PublishGuard, release token, uploader, YouTube integration, TTS, music, analytics, thumbnails, metadata automation, UI, new format, or historical-artifact deletion was added. The next slice is ticket 16: the first full fixture/operator run and pilot-workflow preparation.

### 2026-07-12 — Slice 8 complete

Implemented ticket 16 as a bounded operator-pilot workflow:

- a reusable `dark-curiosity:pilot` CLI with allowlisted fixture resolution, local authorized-WAV input, explicit rights confirmation, bounded timeout, managed report output, report-only mode, strict unknown-argument rejection, and safe non-zero blocking failures;
- an explicit 12-stage state machine from fixture validation through committed technical final, rejecting skipped, duplicated, out-of-order, post-failure, and post-terminal transitions;
- strict `dark_curiosity_pilot_report_v1` reports with canonical technical hashes independent of runtime timestamps, nested unknown-field rejection, ordered/duplicate-free stage history, exact artifact/job bindings, atomic timestamped and `latest.json` persistence, and no paths, storage keys, raw content, provider output, or secrets;
- deterministic run identity over normalized fixture hash, narration audio hash, operator/configuration, final render profile, and pilot profile version; verified complete runs replay without duplicating approval, narration audio, or export, while failed/corrupt same-run checkpoints fail closed;
- one local runtime that reuses the existing content repositories plus draft, rights-bound narration ingestion, exact local alignment, narrated render, technical QA, and evidence-package services—there is no second renderer, compositor, QA path, or export gate;
- final approval may authorize a lower-risk review preview for the exact same revision/draft while the final remains bound to that active approval; a preview approval still cannot authorize a final;
- pre-execution readiness reporting for FFmpeg, FFprobe, renderer, local aligner/model, managed storage, fixture validity, authorized narration, rights confirmation, preview capability, technical-final capability, bounded blockers, and safe next actions;
- stale/replay verification of current project revision, component hashes, artifact ownership/status, approved draft, narration/audio/alignment, QA, contact sheet, evidence metadata, and final checksum before accepting an existing complete pilot;
- operator documentation for exact-script recording, WAV constraints, rights confirmation, report-only inspection, full execution, stage semantics, idempotency, and non-publishable output interpretation.

The real local report-only run executed `fixture_validated` for `001_wow_signal_mystery.json`. FFmpeg, FFprobe, the narrated renderer, managed storage, and strict fixture validation passed. Full mutation was correctly blocked because the local Faster-Whisper model was unavailable, no authorized operator WAV was supplied, and narration rights were not confirmed. No preview or final MP4 was created and no provider fallback was used.

Available deterministic and real FFmpeg/FFprobe narrated regressions passed, together with the complete repository suite. Technical finals remain `publishable: false` and `publishApprovalRequired: true`. No publish approval, PublishGuard, release token, automatic publishing, YouTube API, TTS, music, analytics, thumbnail/metadata automation, UI, new format, scheduler, or multi-channel orchestration was added.

### 2026-07-12 — Slice 9 complete

Implemented ticket 17 as a manual guarded-release boundary:

- authenticated `publish-approve`, `release-verify`, and `final-download-url` endpoints scoped to owned narrated projects, with strict bounded JSON, safe errors/logging, and no path, storage-key, artifact-body, token-hash, or provider-output exposure;
- one central PublishGuard that reloads and verifies the current project revision, active content approval, aligned narration manifest/audio/alignment, final render manifest, committed output checksum, passed final QA, contact sheet, rights manifest, provenance graph, and export metadata before any approval/token mutation;
- non-overridable blockers for stale revisions/approvals, unaligned or estimated narration, rights/disclosure failures, failed QA, preview/non-final output, missing captions/normalization, evidence/hash mismatch, and unavailable output;
- canonical acknowledgement of allowlisted warnings only when the same warning exists in the current QA/evidence graph; unknown, duplicate, absent, or blocking-code acknowledgements fail closed;
- strict immutable `dark_curiosity_publish_approval_v1` artifacts binding the exact content approval, draft, narration, audio, alignment, render manifest, final output, QA, contact sheet, rights, provenance, metadata, operator identity hash, request identity, issue/expiry time, and release-token hash;
- cryptographically random 256-bit opaque release tokens with a 15-minute default TTL bounded to 5–30 minutes, constant-time SHA-256 verification, plaintext disclosure only on initial creation, no TTL extension during verification, and persisted `active`, `expired`, `revoked`, or `superseded` state without raw tokens;
- deterministic idempotent replay that returns the existing approval without revealing the token again, idempotency-key conflict rejection, one active approval per project revision, deterministic recovery of duplicate-active state, and safe renewal after expiry;
- content and style-only revisions revoke prior release eligibility; revocation failure rolls the project revision mutation and persisted project state back, while historical immutable publish-approval artifacts remain available;
- Dark Curiosity technical finals are blocked from the generic export download boundary and require a current release token plus exact output hash; guarded download descriptors use the existing artifact adapter and cannot outlive the release token, while previews and legacy clip downloads remain unchanged.

The deterministic fixture-based proof exercised a complete normalized aligned-narration, final-QA, rights, provenance, contact-sheet, export-metadata, render-manifest, and output-checksum graph, then proved token creation, hashed-only persistence, verification, mismatch blocking, expiration, revocation, recovery, replay, and revision invalidation. The real report-only pilot still confirms FFmpeg, FFprobe, renderer, storage, and fixture readiness, but no real release-approved final was created because the local aligner model and authorized operator WAV/rights confirmation remain unavailable.

There is still no uploader, YouTube OAuth/API call, automatic publishing, scheduler, TTS, music, analytics import, thumbnail generation, metadata automation, UI, new format, or bypass for blocking gates. A release token establishes temporary eligibility for one exact output; it does not mutate the technical final's `publishable: false` state.

### 2026-07-12 — Slice 10 tooling complete; real pilot blocked

Implemented ticket 18 as an operator-proof and environment-hardening slice:

- bounded aligner doctor covering Python/helper/package/model/cache/device/compute/disk/runtime readiness without paths, tracebacks, subprocess output, environment dumps, or secrets;
- dry-run-by-default project-local bootstrap with explicit, separate package-install and allowlisted-model acquisition authorization, pinned CPU dependencies, bounded subprocesses, incomplete-venv cleanup, and no `sudo` or global mutation;
- deterministic non-publishable narration preparation package containing the exact approved 81-word spoken sequence, beat order, WAV constraints, and rights/consent checklist;
- read-only WAV preflight using the ingestion validators plus bounded signal, clipping, duration, format, channel, sample-rate, and reading-rate checks;
- read-only local exact-script rehearsal returning only word counts and bounded mismatch metadata, never a transcript or provider output;
- a pre-mutation pilot gate that requires doctor, preflight, exact rehearsal, and stable fixture bindings before constructing the project/artifact/export runtime;
- optional explicit `--publish-approve` release proof using the existing PublishGuard, immutable approval, in-memory raw token, release verification, and guarded download descriptor; failure revokes the active proof approval;
- strict `dark_curiosity_operator_proof_v1` persistence with nested unknown-field rejection, canonical technical hash, duplicate rejection, bounded blockers/durations, complete artifact/evidence references, and no raw token/token hash/path/storage/provider leakage.

Tooling and automated tests are complete. The real environment is not ready: local Python 3.14.5 is outside the supported 3.9–3.12 aligner range, the pinned local package/model are unavailable, and no authorized operator WAV/rights declaration was supplied. Consequently only `fixture_validated` ran in the real report-only proof. No project, preview, final MP4, publish approval, release token, or guarded descriptor was created. No install, model download, remote transcription, uploader, or network operation was performed.

### 2026-07-12 — Slice 11 environment ready; real pilot blocked on narration

Authorized local provisioning found an already-installed Python 3.10.20, created the ignored project-local `.venv-dark-curiosity`, installed and verified the complete pinned runtime (`faster-whisper==1.2.0`, `ctranslate2==4.6.0`, `requests==2.32.5`), and acquired the allowlisted `base` CPU/int8 model into managed storage. No system Python, global package, `sudo`, remote transcription service, or unapproved model was used.

The provisioning audit exposed and fixed two real readiness defects: Faster-Whisper 1.2.0 needs an explicit `requests` pin with current dependency resolution, and the helper previously inspected the external default model cache instead of the bootstrap-managed cache. Doctor, model probe, rehearsal, and transcription now share one managed cache and fail closed when it is missing. The final doctor reports Python/package/model/helper/cache `ready`, and the bootstrap dry-run is idempotently `ready` with zero actions.

Additional deterministic coverage now proves compatible-Python discovery, incompatible-Python pre-mutation blocking, exact package/import verification, ready rerun idempotency, complete operator-proof token filtering, failed-release revocation, four interruption boundaries, and CLI no-project behavior when an operator gate fails.

Narration readiness, real pilot completion, and release proof remain blocked because no authorized operator WAV or rights confirmation was supplied. The real report-only execution therefore completed only `fixture_validated`; it created no project, narration artifact, preview, final MP4, publish approval, release token, or guarded descriptor. This is environment readiness, not a synthetic or real media proof.

### 2026-07-12 — Slice 12 readiness verified; authorized narration still required

The scoped attachment contained only the execution prompt and no WAV or rights declaration, so the real run stopped before narration preflight, rehearsal, or mutation. Doctor and bootstrap remained idempotently `ready`; the exact 81-word preparation package was regenerated; report-only completed only `fixture_validated` with no project or media artifacts.

The readiness execution exposed two defects and added narrowly scoped regressions. `--probe-model` previously loaded the complete CTranslate2 model during every doctor call; it now performs a bounded read-only integrity check of the allowlisted managed snapshot, while rehearsal/transcription still perform the real model load. The pilot CLI also stopped importing the mutation-capable runtime during report-only execution and now loads it only after full-pilot gates pass. This preserves the no-mutation boundary and keeps readiness independent of heavy render/runtime imports.

Environment readiness is complete. Narration readiness, real preview/final creation, QA/evidence proof, publish approval, token verification, and guarded download remain deliberately blocked until the operator supplies an authorized WAV and explicit rights confirmation.

### 2026-07-12 — Slice 13 provenance-bound AI narration complete

The narration boundary now supports an optional provider-neutral TTS path while preserving authorized human WAV ingestion. A real OpenAI `/v1/audio/speech` adapter and a deterministic test-only mock sit behind the same contract. Production synthesis requires `OPENAI_API_KEY`, an approved fixture script, a built-in non-cloned voice, and explicit operator commercial-use attestation; missing credentials never fall back to mock.

Every provider response is normalized with FFmpeg to validated mono 48 kHz `pcm_s16le` WAV and bound to a strict `dark_curiosity_tts_provenance_v1` manifest containing script approval/hash, provider/model/voice, request reference, terms attestation, audio metadata/hash, and deterministic blocker codes. Atomic writes, partial-output cleanup, exact-configuration reuse, explicit regeneration, bounded timeouts, and inspect/verify CLI commands protect the artifact lifecycle.

Narration preflight verifies a colocated TTS sidecar before mutation. Pilot upload embeds the verified provenance and uses `ai_generated_licensed` rights metadata. The existing PublishGuard independently blocks missing or mismatched provenance, mock output, absent commercial attestation, cloned/impersonated voices, and tampered script/audio while leaving the human-recorded path unchanged. The deterministic mock proof creates and verifies a technical WAV but remains permanently non-publishable; no real paid provider call was made during implementation or tests.

### 2026-07-12 — Slice 14 free local Kokoro narration complete

The default production narration provider is now `kokoro_local`. A dedicated `.venv-kokoro` contains pinned `kokoro-onnx==0.5.0` and `soundfile==0.13.1`; the full Kokoro v1.0 ONNX model and bundled voices live in ignored managed storage. Separate authorization-gated package/model bootstrap commands and a bounded doctor verify Python, packages, helper, model byte sizes, SHA-256 hashes, voice data, model identity, and Apache-2.0 license reference. Normal synthesis is fully offline and performs no download or API request.

The provider allows only bundled non-cloned voice IDs and English in this first production profile, invokes a bounded stdin-only Python helper, emits no raw script or runtime error details, cleans partial WAVs, and returns audio through the existing normalization/provenance service. `kokoro_local` is publishable only with the existing exact approved-script binding, verified audio/provenance, and explicit operator commercial-use attestation. OpenAI remains an explicit optional provider and mock remains permanently non-publishable.

The real `001_wow_signal_mystery` proof produced 34.3467 seconds of audible Kokoro narration, normalized it to mono 48 kHz `pcm_s16le`, recorded zero provenance blockers, passed WAV preflight at 141.5 WPM, and passed exact Faster-Whisper rehearsal with all 81 approved words. A conservative alignment canonicalization treats a hyphenated English number such as `seventy-two` and an ASR digit token such as `72` as the same spoken word while preserving word count and every other exact-token gate. No paid provider or API key was used.
