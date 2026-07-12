# Narrated Visual Shorts Engine

Status: proposed architecture and implementation plan
Initial vertical: original football tactical and story explainers
Primary business model: first-party YouTube channel revenue
Last updated: 2026-07-11

## 1. Executive decision

ShortsEngine should not be rewritten into another footage clipper. The profitable hypothesis worth testing is a compiler for original narrated visual Shorts:

```text
verified idea + claims
        -> approved script
        -> narration
        -> football storyboard
        -> deterministic timeline
        -> animated 9:16 video
        -> quality and rights gates
```

The first format is football explainers made from original narration, animated pitch diagrams, stat cards, kinetic text, and other first-party visual primitives. Broadcast footage is not required.

This is a pivot of the content pipeline, not a rewrite of the infrastructure. The existing queue, durable jobs, storage, export, FFmpeg, safety, and evaluation foundations remain useful. Football broadcast analysis, OCR, tracking, and YouTube ingest become a legacy pipeline that is kept isolated and frozen while the new format is validated.

The first usable release must optimize for learning, not completeness:

- one channel and one operator;
- one language at a time;
- one narration voice;
- three repeatable football formats;
- five visual scene types;
- manual, verified research input;
- script approval before voice or render costs are incurred;
- no automatic publishing;
- no stock footage, broadcast clips, scraped clips, or unknown music.

## 2. Why this architecture fits the current repository

The repository already contains valuable production primitives:

- durable jobs, idempotency, leases, recovery, and cancellation in `server/jobs.cjs`, `server/queue/`, `server/job-worker.cjs`, and `server/worker-supervisor.cjs`;
- local and cloud-shaped artifact storage in `server/storage.cjs`, `server/storage/`, and `server/adapters/`;
- safe API errors, auth boundaries, rate limiting, exports, and persistence;
- FFmpeg execution, captions, audio extraction, probing, and MP4 validation in `server/render.cjs` and `server/media.cjs`;
- human-review, regeneration, evaluation, and fail-closed patterns;
- local Faster-Whisper support with word timestamps.

The current content path is not reusable as the new orchestrator without separation:

- `server/render-job.cjs` is approximately 5,800 lines and assumes a source upload plus football-event analysis;
- `server/analysis.cjs` is approximately 5,800 lines and is designed around finding moments inside existing footage;
- `server/edit-plan.cjs`, `server/render.cjs`, and job payload normalization contain football-highlight enums and assumptions;
- `server/job-worker.cjs` currently requires both a project and an upload before any job can run;
- `server/repositories/project-repository.cjs` requires `uploadId` for every project;
- OCR, scorebug, goal evidence, visual tracking, and source acquisition are irrelevant to generated explainers.

Therefore the new pipeline must run beside the existing clip pipeline and share only infrastructure-level components.

The nested `AI-Youtube-Shorts-Generator/` prototype remains source-footage-centric and introduces a second Python orchestration stack. Useful ranking and semantic-boundary ideas may be ported deliberately, but that repository should not become the runtime foundation of the narrated engine.

## 3. Product boundary

### 3.1 The engine is

- a structured content compiler;
- a revisioned workflow with human approval points;
- a small football visual language;
- a deterministic renderer of validated scene data;
- a producer of MP4, captions, metadata drafts, and provenance reports;
- an experiment system that can connect video performance to format and template versions later.

### 3.2 The engine is not

- a general-purpose video editor;
- a web scraper or autonomous news publisher;
- a match-footage downloader;
- a replacement for editorial judgment;
- an unrestricted prompt-to-video generator;
- an auto-publisher;
- a multi-tenant SaaS in the MVP;
- a system that invents tactical facts, statistics, quotes, or match events.

## 4. Target architecture

```text
                         +-----------------------+
                         | CLI / Narrated Studio |
                         +-----------+-----------+
                                     |
                                     v
                         +-----------------------+
                         | Narrated Project API  |
                         +-----------+-----------+
                                     |
                    +----------------+----------------+
                    |                                 |
                    v                                 v
          +--------------------+           +--------------------+
          | Draft pipeline job |           | Render pipeline job|
          +---------+----------+           +---------+----------+
                    |                                ^
                    v                                |
      brief -> claims -> script -> storyboard -> approval
                    |                                |
                    +--------------------------------+
                                                     |
                                                     v
         narration -> word timing -> Timeline IR -> renderer
                                                     |
                                                     v
                               visual QA -> audio QA -> export

 Shared infrastructure:
 JobStore | Queue | Worker leases | ArtifactStore | Persistence | Export
```

The system remains a modular monolith. There is no microservice split before a real workload requires it.

## 5. Core architectural rules

1. The model may propose structured content, but only validated contracts reach the renderer.
2. No network request is allowed during the deterministic render stage.
3. Every important stage writes an immutable, versioned artifact.
4. Jobs carry artifact IDs and revision hashes, not entire scripts or storyboards.
5. Script approval is a hard boundary. A changed script invalidates narration and all downstream artifacts.
6. All timeline timing is stored as integer frames, not floating-point seconds.
7. Every factual sentence is linked to a verified claim or marked clearly as opinion/analysis.
8. Every external asset has origin and rights metadata. Unverified remote assets block export.
9. Existing clip jobs continue to work during the pivot.
10. New narrated logic does not enter `render-job.cjs` or `analysis.cjs`.

## 6. Proposed repository structure

```text
server/
  rendering/
    ffmpeg-runner.cjs
    audio-finalizer.cjs
    ass-caption-renderer.cjs
    output-probe.cjs
  pipelines/
    pipeline-registry.cjs
    clip-pipeline-handler.cjs
    narrated-short/
      contracts.cjs
      artifact-types.cjs
      invalidation.cjs
      draft-job.cjs
      render-job.cjs
      brief-validator.cjs
      claim-ledger.cjs
      script-planner.cjs
      script-validator.cjs
      storyboard-planner.cjs
      storyboard-validator.cjs
      timeline-compiler.cjs
      export-metadata.cjs
      qa/
        content-qa.cjs
        timeline-qa.cjs
        rendered-video-qa.cjs
        rights-qa.cjs
      football/
        pitch-model.cjs
        football-dsl.cjs
        football-dsl-validator.cjs
        scene-templates.cjs
        storyboard-rules.cjs
  adapters/
    script-provider-adapter.cjs
    narration-provider-adapter.cjs
    narrated-renderer-adapter.cjs
  repositories/
    content-artifact-repository.cjs
    content-approval-repository.cjs

renderer/
  narrated/
    scene.html
    scene-runtime.js
    scene-styles.css
    scene-registry.mjs
    scenes/
      hook-scene.mjs
      pitch-scene.mjs
      formation-compare-scene.mjs
      stat-card-scene.mjs
      payoff-scene.mjs
    render-keyframes.mjs

tools/
  narrated-short.mjs

eval/
  narrated/
    fixtures/
    reference-renders/
    run-eval.mjs

data/                         # ignored runtime data
  content-artifacts/
  content-approvals/
  narration/
  renders/
```

The renderer is isolated because scene generation is a different execution concern from the API and job system. For MVP, a pinned headless Chromium executable renders deterministic HTML/SVG keyframes and FFmpeg turns those keyframes into timed scenes. The core invokes it only through `narrated-renderer-adapter.cjs`, with explicit subprocess timeouts and an optional `NARRATED_CHROME_BIN`. This avoids coupling production rendering to the repository's Playwright test runtime, which can block during module initialization on some local installations. If a frame renderer such as Remotion is justified later, the contracts and pipeline do not change.

Only generic, already-proven pieces should be extracted from `server/render.cjs`: the cancellable FFmpeg runner, ASS caption construction, audio finalization, and output probing. The old clip renderer and the new narrated renderer then call those small utilities. Football labels, source windows, crop logic, and goal badges stay in the legacy renderer.

## 7. Project and job model changes

### 7.1 Backward-compatible Project v2

The current project model always requires an upload. Replace that assumption with a discriminated input type:

```json
{
  "schemaVersion": 2,
  "id": "prj_...",
  "projectType": "narrated_short",
  "title": "Why the overload creates the free runner",
  "language": "en",
  "input": {
    "type": "content_brief",
    "briefArtifactId": "art_...",
    "revision": 3
  },
  "status": "draft",
  "ownerId": "local",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Legacy records are normalized as:

```json
{
  "projectType": "clip",
  "input": {
    "type": "upload",
    "uploadId": "upl_..."
  }
}
```

Do not create fake uploads for narrated projects.

### 7.2 Job v2

Add a pipeline discriminator and versioned input reference:

```json
{
  "action": "render_narrated_short",
  "pipelineType": "narrated_short",
  "payload": {
    "schemaVersion": 1,
    "projectRevision": 3,
    "approvedDraftArtifactId": "art_...",
    "approvedDraftHash": "sha256:...",
    "renderProfile": "preview"
  }
}
```

The existing worker must dispatch through a registry:

```text
clip               -> existing runRenderJob
narrated_short     -> runNarratedDraftJob or runNarratedRenderJob
unknown            -> fail closed with PIPELINE_TYPE_UNSUPPORTED
```

The upload lookup becomes conditional on pipeline type.

Payload normalization must also dispatch by pipeline type. The current fixed whitelist in `server/jobs.cjs` would silently discard narrated fields during persistence and recovery. Project documents remain in the artifact repository; the job payload stores only bounded IDs, revisions, hashes, and render settings.

### 7.3 Content artifact types

Extend the artifact registry with explicit allowlisted types:

```text
content_brief       claim_ledger       narrative_script
storyboard          approval_bundle    narration_audio
narration_manifest timeline_ir         scene_keyframe
render_manifest     qa_report           contact_sheet
export_metadata     provenance_report
```

Each artifact record includes schema version, project ID, revision, SHA-256, creator stage, dependency hashes, and creation time. Binary artifacts also include byte size and media type.

## 8. Versioned content contracts

All contracts include `schemaVersion`, stable IDs, and a content hash. The examples below show the required shape, not every validation rule.

### 8.1 ContentBrief

```json
{
  "schemaVersion": 1,
  "formatId": "tactical_cause_effect_v1",
  "language": "en",
  "audience": "casual football fans",
  "topic": "How an overload frees the weak-side runner",
  "thesis": "The decisive movement happens away from the ball.",
  "targetSeconds": 35,
  "tone": "clear_direct",
  "sourceRefs": ["src_01"],
  "operatorNotes": "Use a generic 4-3-3 example; do not name a real match."
}
```

MVP limits:

- duration: 20-45 seconds;
- one thesis;
- one language;
- maximum six claims;
- maximum eight script beats;
- allowlisted `formatId` values only.

### 8.2 Source and ClaimLedger

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "id": "src_01",
      "title": "Operator-verified coaching source",
      "url": "https://example.invalid/source",
      "verifiedBy": "operator",
      "verifiedAt": "...",
      "snapshotHash": "sha256:..."
    }
  ],
  "claims": [
    {
      "id": "claim_01",
      "text": "The wide player pins the full-back while the midfielder attacks the half-space.",
      "kind": "supported_fact",
      "sourceIds": ["src_01"],
      "operatorApproved": true
    },
    {
      "id": "claim_02",
      "text": "This is the movement casual viewers usually miss.",
      "kind": "analysis",
      "sourceIds": [],
      "operatorApproved": true
    }
  ]
}
```

Allowed claim kinds are `supported_fact`, `analysis`, and `opinion`. A factual claim without a verified source blocks draft approval. Automated web research is deliberately excluded from MVP.

### 8.3 NarrativeScript

```json
{
  "schemaVersion": 1,
  "title": "Watch the runner nobody tracks",
  "estimatedSeconds": 34,
  "beats": [
    {
      "id": "beat_01",
      "role": "hook",
      "spokenText": "The player who creates this chance never touches the ball.",
      "onScreenText": "HE NEVER TOUCHES IT",
      "claimIds": ["claim_02"]
    },
    {
      "id": "beat_02",
      "role": "mechanism",
      "spokenText": "The winger pins the full-back and the midfielder attacks the half-space.",
      "onScreenText": "PIN + THIRD-MAN RUN",
      "claimIds": ["claim_01"]
    }
  ],
  "provider": {
    "mode": "operator_or_structured_model",
    "model": null,
    "promptVersion": "script_v1"
  }
}
```

Allowed beat roles for MVP:

```text
hook -> setup -> mechanism -> consequence -> payoff
```

The validator enforces a hook within the first two seconds, claim coverage, length, language, reading speed, no duplicated beat, and a concrete payoff.

### 8.4 Football storyboard and DSL

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "id": "scene_01",
      "beatIds": ["beat_01"],
      "template": "hook_text",
      "durationFrames": 54,
      "operations": []
    },
    {
      "id": "scene_02",
      "beatIds": ["beat_02"],
      "template": "pitch_tactical_sequence",
      "reconstructionMode": "illustrative",
      "durationFrames": 210,
      "operations": [
        { "op": "place_player", "id": "A7", "team": "attack", "x": 0.16, "y": 0.22 },
        { "op": "place_player", "id": "D2", "team": "defend", "x": 0.26, "y": 0.22 },
        { "op": "draw_run", "id": "A8", "from": [0.43, 0.50], "to": [0.70, 0.30], "startFrame": 42, "endFrame": 110 },
        { "op": "highlight_zone", "shape": "half_space", "side": "left", "startFrame": 60, "endFrame": 170 }
      ]
    }
  ]
}
```

MVP football operations:

```text
place_player  move_player  hide_player
place_ball    pass         carry
draw_run      draw_press   highlight_zone
label         freeze       zoom
```

Pitch coordinates are normalized from `0.0` to `1.0`. The validator rejects duplicate IDs, out-of-bounds positions, invalid frame ranges, impossible references, unreadable labels, and operations unsupported by the selected scene template.

When exact tracking data does not exist, `reconstructionMode` must be `illustrative` and the script/metadata must not present player positions as an exact reconstruction of a real event.

### 8.5 NarrationManifest

```json
{
  "schemaVersion": 1,
  "providerMode": "tts",
  "voiceProfileId": "voice_en_01",
  "audioArtifactId": "art_...",
  "audioHash": "sha256:...",
  "sampleRate": 48000,
  "durationFrames": 1014,
  "words": [
    { "text": "The", "startFrame": 0, "endFrame": 5 },
    { "text": "player", "startFrame": 5, "endFrame": 15 }
  ],
  "rights": {
    "commercialUseAllowed": true,
    "consentReference": "voice_profile_terms_v1"
  }
}
```

The narration adapter supports two modes behind the same contract:

- uploaded first-party narration;
- one configured TTS provider with commercial-use metadata.

If the provider does not return word timing, the saved audio is aligned through the existing local Faster-Whisper adapter. Names and football terms use a pronunciation dictionary.

### 8.6 TimelineIR

`TimelineIR` is the renderer boundary. It contains no prompt text and no provider-specific output.

```json
{
  "schemaVersion": 1,
  "fps": 30,
  "width": 1080,
  "height": 1920,
  "totalFrames": 1014,
  "tracks": [
    { "type": "background", "zIndex": 0, "clips": [] },
    { "type": "football_visual", "zIndex": 10, "clips": [] },
    { "type": "caption", "zIndex": 30, "clips": [] },
    { "type": "brand", "zIndex": 40, "clips": [] },
    { "type": "narration", "zIndex": 50, "clips": [] }
  ],
  "assetManifestHash": "sha256:...",
  "templateVersions": {
    "pitch_tactical_sequence": "1.0.0",
    "kinetic_caption": "1.0.0"
  },
  "seed": 721144
}
```

The same approved artifacts and pinned template versions must produce the same frame plan.

### 8.7 AssetManifest

Every non-generated asset must be registered:

```json
{
  "id": "asset_font_01",
  "type": "font",
  "origin": "licensed_local",
  "fileHash": "sha256:...",
  "licenseId": "license_...",
  "commercialUseAllowed": true,
  "allowedUsage": ["youtube_video"]
}
```

Allowed origins:

```text
first_party  generated_by_engine  public_domain_verified  licensed_local
```

`remote_unverified`, missing hashes, unknown music, and scraped images are blockers.

## 9. Two-job workflow and approvals

A job must not pause while waiting for a human. Use two terminal jobs separated by an approval record.

### 9.1 Draft job

```text
validate_brief              5%
validate_claim_ledger      15%
generate_script            35%
validate_script            50%
generate_storyboard        70%
validate_storyboard        85%
write_draft_artifacts      95%
draft_ready_for_approval  100%
```

Output: a draft bundle containing the brief, claim ledger, script, storyboard, hashes, and validation report.

The job itself finishes with the existing terminal status `completed`. The project workflow moves to `awaiting_approval`; a worker lease is never held while a human reviews the draft.

### 9.2 Approval

The operator reviews and edits the script and storyboard. Approval stores:

- project ID and revision;
- exact draft artifact hash;
- approval timestamp;
- optional operator note;
- voice profile and render profile;
- approval record hash.

Any change produces a new revision and invalidates the prior approval.

### 9.3 Render job

```text
verify_approval             5%
generate_narration         18%
align_words                28%
compile_timeline           40%
validate_timeline          48%
render_preview             65%
run_preview_qa             74%
render_final               88%
run_final_qa               96%
commit_export             100%
```

If final QA fails, the job fails with a safe code and preserves the preview and QA artifacts for review.

## 10. Renderer decision

### 10.1 Recommended MVP split

- HTML/SVG scene templates describe pitch diagrams, stat cards, and visual states.
- Headless Chromium renders two or three exact keyframes per scene at the requested resolution.
- FFmpeg animates those frames with short crossfades, push-ins, pulses, and timeline transitions; it also adds word-level ASS captions, normalizes audio, validates encoding, and extracts QA frames.
- The main server talks to the renderer through a small process adapter and a versioned `TimelineIR` file.

This avoids encoding tactical layout logic inside the already large `server/render.cjs` filter graph while keeping the first renderer small. Full per-frame animation and Remotion are post-validation options, not MVP requirements.

### 10.2 Determinism requirements

- pin Node, Chromium, FFmpeg, and font versions;
- bundle fonts locally;
- disable network inside render;
- use integer frames for every animation;
- store a seed for any controlled visual variation;
- cache narration and assets by content hash;
- store renderer and template versions in the render manifest;
- never regenerate TTS during a render retry;
- record the exact `TimelineIR` and asset manifest used for the MP4.

### 10.3 Initial scene library

Only these scenes are required for the first release:

1. `hook_text`: bold claim plus minimal motion;
2. `pitch_tactical_sequence`: player/ball movement, arrows, zones;
3. `formation_compare`: before/after or left/right tactical shape;
4. `stat_card`: one comparison, maximum three values;
5. `payoff`: summarize the mechanism and return to the hook.

No generative images are required for MVP. Tactical diagrams are SVG primitives and brand elements are local, licensed assets.

## 11. Script and model-provider boundary

The MVP can operate with a manually supplied script. A structured model provider is optional, not mandatory.

Provider rules:

- input is the validated brief and claim ledger only;
- output must match `NarrativeScript` JSON exactly;
- the provider cannot add claims or sources;
- one schema-repair attempt is allowed;
- a second invalid response becomes `needs_review` or a failed draft;
- raw provider output is never sent to the renderer;
- model, prompt version, temperature, and request hash are recorded;
- the engine must remain usable with a deterministic fixture provider in tests.

This keeps the creative generation replaceable and prevents provider behavior from becoming architecture.

## 12. QA and export gates

### 12.1 Content QA

Block approval or export when:

- a supported fact has no verified source;
- a script beat references a missing claim;
- the hook promises a payoff the script does not deliver;
- the script is substantially similar to a recent published script;
- the reading rate or duration is outside the configured range;
- unsupported names, quotes, or statistics appear;
- there is no operator approval for the exact revision.

### 12.2 Visual and timeline QA

Block export when:

- player or ball coordinates leave pitch bounds;
- an operation references an unknown entity;
- captions exceed two lines or leave safe zones;
- text is too small or overlaps critical visuals;
- a scene has no meaningful visual change for too long;
- the first meaningful visual begins too late;
- timeline clips overlap illegally or exceed `totalFrames`;
- fonts or assets are missing;
- the renderer used an unregistered template version.

### 12.3 Audio QA

Block export when:

- narration is missing or word alignment is incomplete;
- audio clips;
- loudness or true peak is outside the configured safe profile;
- the audio duration disagrees with the timeline;
- a music asset has no commercial-use record.

Initial target profile:

```text
1080 x 1920
30 fps
H.264 + AAC
20-45 seconds
approximately -14 LUFS integrated
true peak no higher than -1 dBTP
```

### 12.4 Rendered-video QA

- `ffprobe` confirms dimensions, codecs, duration, and audio stream;
- sampled frames detect black/frozen output and missing overlays;
- a contact sheet is produced for human review;
- the export includes a provenance/rights report;
- no final MP4 is exposed if a blocker remains.

## 13. API and CLI surface

The first operator interface should be a CLI plus JSON artifacts. A full UI redesign would delay format validation.

### 13.1 CLI

```bash
npm run narrated:draft -- --brief fixtures/overload-brief.json
npm run narrated:approve -- --project prj_... --draft art_...
npm run narrated:render -- --project prj_... --profile preview
npm run narrated:render -- --project prj_... --profile final
```

### 13.2 API

```text
POST   /api/narrated-projects
GET    /api/narrated-projects/:projectId
PUT    /api/narrated-projects/:projectId/brief
POST   /api/narrated-projects/:projectId/draft
POST   /api/narrated-projects/:projectId/approve
POST   /api/narrated-projects/:projectId/render
GET    /api/jobs/:jobId
GET    /api/exports/:exportId/download
```

The existing job polling and export endpoints remain shared. API request bodies contain bounded user input; large content documents are persisted as artifacts.

### 13.3 UI after proof

After the renderer proves useful, add a separate Narrated Studio screen with:

- brief and claim editor;
- script and storyboard review;
- approval action;
- low-resolution preview;
- QA blockers and regeneration controls;
- final export.

Do not add all of this to the existing 2,000+ line `app.js`. Use separate modules or a separate page and share only the API client and safe-error utilities.

## 14. Artifact graph and invalidation

```text
ContentBrief
   + ClaimLedger
          |
          v
    NarrativeScript
          |
          v
      Storyboard
          |
       approval
          |
          +-------------> NarrationManifest
          |                       |
          +-----------------------+
                      |
                      v
                 TimelineIR
                      |
                      v
                 RenderManifest
                      |
                      v
                  QAReport
                      |
                      v
                    Export
```

Invalidation rules:

| Changed artifact | Invalidate |
|---|---|
| brief or claims | script and everything downstream |
| script spoken text | approval, narration, storyboard timing, timeline, render, QA |
| storyboard visuals only | approval, timeline, render, visual QA |
| pronunciation dictionary | narration, alignment, timeline, render, audio QA |
| caption style | timeline, render, visual QA |
| renderer/template version | render and rendered-video QA |
| export metadata only | metadata artifact only |

Artifacts are content-addressed by SHA-256 where practical. A job retry reuses all valid upstream artifacts.

## 15. Evaluation strategy

### 15.1 Contract and unit tests

- one valid and several invalid fixtures for every contract;
- property-style bounds tests for pitch coordinates and frame ranges;
- job dispatch and legacy compatibility tests;
- approval hash and invalidation tests;
- provider contract tests with deterministic adapters;
- timeline determinism tests;
- asset-rights enforcement tests.

### 15.2 Golden timeline tests

Given a fixed brief, claims, script, narration timing, and storyboard, the compiler must produce the same normalized `TimelineIR` and hash.

### 15.3 Renderer tests

- one short render per scene type at proof resolution;
- deterministic frame screenshots at selected frame numbers;
- visual regression thresholds for pitch, captions, and safe zones;
- FFmpeg decode and output-profile tests;
- audio loudness and clipping tests.

### 15.4 Editorial evaluation set

Start with 12 fixtures:

- four tactical cause/effect stories;
- three formation comparisons;
- three stat-led stories;
- two deliberately invalid or weak scripts.

Human review scores:

```text
hook clarity
claim credibility
visual comprehension
narration/caption sync
payoff completeness
template fatigue
overall publish decision
```

The primary offline metric is human publish acceptance, not a synthetic virality score.

## 16. Implementation phases

### Phase 0 - Freeze and baseline

Goal: protect the working clip pipeline while creating a pivot boundary.

- record the existing test and release baseline;
- mark broadcast/OCR features as maintenance-only;
- create and publish three representative Shorts manually before automating them;
- verify that one manual Short can be made in at most three hours and that at least ten credible follow-up topics exist;
- convert those three examples into approved scripts and visual references;
- define the initial channel language and visual identity;
- do not delete old modules.

Exit criteria:

- legacy tests still pass;
- at least one manually produced format is good enough to publish repeatedly;
- the three target content formats are written as concrete examples;
- MVP scope and non-goals are accepted.

### Phase 1 - Pipeline foundation

Goal: allow a narrated project to exist and run without an upload.

- add Project v2 normalization with legacy migration;
- add versioned job payloads and `pipelineType`;
- add pipeline handler registry;
- make upload lookup conditional;
- add content artifact and approval repositories;
- add CLI skeleton and deterministic fixtures.

Exit criteria:

- a narrated draft job survives persistence/restart;
- a clip job follows the unchanged legacy handler;
- no fake upload is required;
- idempotency and lease tests cover both job types.

### Phase 2 - Content compiler

Goal: convert a verified brief into an approvable deterministic draft.

- implement brief, source, claim, script, and storyboard contracts;
- implement manual-script provider first;
- add optional structured script provider;
- implement football DSL and validators;
- implement the five storyboard scene types;
- implement approval hashes and invalidation.

Exit criteria:

- all 12 fixtures compile or fail for the expected reason;
- no unsupported claim reaches approval;
- identical inputs generate the same draft hash;
- an operator can edit and approve a draft.

### Phase 3 - Narration and renderer

Goal: produce a technically valid first-party MP4.

- implement one narration provider plus uploaded narration mode;
- add pronunciation dictionary and word alignment;
- implement `TimelineIR` compiler;
- implement the headless-Chromium/SVG renderer adapter and the five keyframe-based scenes;
- treat Chromium as a pinned renderer runtime rather than test-only tooling;
- reuse FFmpeg for final audio normalization/muxing;
- produce preview and final profiles.

Exit criteria:

- all scene templates render at 1080x1920/30fps;
- captions follow actual narration timing;
- a rerender with cached inputs does not call TTS;
- the same timeline produces stable reference frames.

### Phase 4 - QA and operator loop

Goal: make publishing decisions fast and safe.

- implement content, rights, timeline, audio, and rendered-video QA;
- add contact sheet and safe QA summary;
- add partial regeneration from changed script or storyboard;
- add export metadata draft and provenance report;
- add a minimal preview/review UI only if the CLI loop is too slow.

Exit criteria:

- blockers prevent export;
- one weak/invalid fixture fails at each intended gate;
- one approved project can be revised without rerunning unaffected stages;
- operator time after research is under 15 minutes per Short.

### Phase 5 - Channel validation

Goal: determine whether the format, not merely the renderer, deserves more investment.

- publish 30 Shorts across three predeclared formats;
- publish consistently enough that format comparisons are meaningful;
- record `formatId`, hook type, duration, template mix, language, and publish date;
- import only aggregate YouTube analytics after the experiment;
- do not change several variables at once based on one result.

Continue only if there is evidence of a repeatable winner: multiple videos from the same format outperform the channel baseline, retention and returning viewers improve across later batches, and production time/cost remains sustainable. A single viral outlier is not proof.

Stop or freeze the project if, after the planned sample, no format shows repeatable improvement, the process still needs heavy manual rescue, or the total production cost cannot plausibly be recovered by the channel.

### 16.1 Provisional go/revise/kill bands

These are internal experiment thresholds, not claims about the YouTube algorithm. Count only Shorts that received enough feed distribution to make the percentages meaningful, and compare cohort medians rather than a viral outlier.

Go after roughly 18-24 adequately distributed Shorts when:

- median `chose to view` is at least 65%;
- median average percentage viewed is at least 85% for a 25-35 second format;
- at least two of the latest ten Shorts reach at least three times the cohort median;
- subscriber conversion is at least one subscriber per 1,000 engaged views;
- first-pass render success is at least 90%;
- total human production time is at most 60 minutes per Short, and at most 15 minutes after an approved script/narration pack exists.

Revise the format, without adding engine features, when `chose to view` is 55-65% or average percentage viewed is 70-85%. Test one hook, pacing, or duration change at a time.

Kill or freeze the format when, after about 24 adequately distributed Shorts, median `chose to view` remains below 55%, average percentage viewed remains below 70%, no cohort improves, or the only successful videos depend on copyrighted footage.

If there is still no upward trend after approximately 50 Shorts or 90 days, stop engineering work and reassess the channel premise. The current full Shorts ad-revenue YPP path requires 1,000 subscribers and 10 million valid public Shorts views in 90 days, so an efficient renderer without a credible path to audience scale is not a profitable asset. See [YouTube Partner Program eligibility](https://support.google.com/youtube/answer/72851?hl=en).

The only revenue calculation used after monetization should be based on the channel's actual Studio data:

```text
profit =
  (eligible engaged views / 1000 * actual Shorts RPM)
  - model/TTS/asset costs
  - valued operator time
```

Do not make investment decisions using an internet-average Shorts RPM.

## 17. Suggested implementation slices

Each slice should be independently testable and should not mix infrastructure refactoring with creative changes.

1. Contracts and fixtures only.
2. Project v2 plus legacy normalization.
3. Pipeline registry and narrated job dispatch.
4. Content artifact/approval persistence and hashing.
5. Brief/claim/script validation and manual provider.
6. Football DSL and pitch-coordinate validation.
7. Storyboard planner and five scene contracts.
8. Narration adapter and alignment manifest.
9. Timeline compiler and golden tests.
10. Renderer adapter plus one hook scene.
11. Pitch scene, formation scene, stat scene, payoff scene.
12. FFmpeg audio/finalization and output QA.
13. CLI end-to-end demo and contact sheet.
14. Optional structured script provider.
15. Minimal review UI only after the CLI pipeline is proven.

### 17.1 Implemented foundation (2026-07-11)

The repository now contains the first executable vertical slice:

- Project v2 and SQLite schema v6 keep the clip pipeline backward compatible while allowing narrated projects without uploads;
- versioned `draft_narrated_short` and `render_narrated_short` jobs dispatch through the pipeline registry;
- ContentBrief, ClaimLedger, NarrativeScript, Storyboard, narration timing, and TimelineIR contracts fail closed and use deterministic hashes;
- immutable content artifacts and exact-revision approvals survive local persistence;
- `POST /api/narrated-projects`, `POST /api/narrated-projects/:id/draft`, `POST /api/narrated-projects/:id/approve`, and `POST /api/narrated-projects/:id/render` implement the manual operator flow;
- original SVG football scenes render through an isolated headless-Chromium adapter with bounded subprocess lifecycles;
- FFmpeg creates a verified 720x1280 H.264 silent preview and the engine persists its export, TimelineIR, and render manifest.

The deliberate remaining boundary is audio and final QA: the current `/render` route produces a silent timing preview. It must not be treated as a publish-ready Short. Uploaded/generated narration, word-synchronized captions in the raster output, audio normalization, contact sheet, provenance, and final gates remain Phase 3/4 work.

## 18. Explicit scope cuts

Do not build these before the 30-video validation batch:

- autonomous topic discovery;
- autonomous web research;
- scraped images or clips;
- live football data feeds;
- team/player likeness generation;
- multi-language batch generation;
- many voice providers;
- automatic thumbnail generation;
- automatic YouTube publishing;
- analytics-driven prompt mutation;
- distributed render workers;
- multi-user permissions or billing;
- a generic drag-and-drop editor;
- more than five scene templates;
- migrations of the old football detector into the new pipeline.

## 19. Main risks and controls

| Risk | Control |
|---|---|
| The result looks like repetitive AI template content | Unique thesis, manual approval, script-similarity gate, limited publishing cadence, multiple scene mixes |
| Tactical claims are invented | Operator-verified claim ledger; no automated research in MVP |
| The architecture becomes another monolith | Pipeline registry, small stage modules, immutable contracts, isolated renderer |
| Old tests and features break | Parallel pipeline, backward-compatible Project v2, legacy handler left intact |
| Render iteration becomes slow | Preview profile, content-addressed cache, partial invalidation |
| TTS mispronounces names | Pronunciation dictionary and segment-level narration regeneration |
| Assets create copyright risk | Rights manifest and allowlisted local assets only |
| High engineering effort precedes channel proof | CLI-first delivery, five scene cap, explicit Phase 5 stop gate |
| Views are mistaken for a repeatable business | Compare format cohorts and returning viewers; ignore a single outlier |

## 20. Definition of MVP done

The narrated engine MVP is done only when all of the following are true:

- it accepts a verified ContentBrief and ClaimLedger without a video upload;
- it produces an editable, source-linked script and football storyboard;
- an operator approves an exact draft revision;
- it generates or accepts narration with word timing;
- it compiles a deterministic frame-based timeline;
- it renders all five required scene types into a 1080x1920 MP4;
- it produces readable synchronized captions;
- factual, rights, visual, audio, and output gates pass;
- it writes a contact sheet and provenance report;
- it can rerender a style change without regenerating narration;
- the old clip pipeline and its tests remain functional;
- one complete Short can be produced in under 15 minutes of operator time after the research/claim pack is ready.

## 21. First build milestone

The first milestone should not attempt a polished final video. It should prove the architecture with one deterministic fixture:

```text
brief.json
  -> manually approved script.json
  -> storyboard with hook_text + pitch_tactical_sequence + payoff
  -> fixed narration WAV and word timings
  -> TimelineIR
  -> 720x1280 preview MP4
  -> contact sheet + QA JSON
```

If this slice cannot be implemented cleanly without modifying the legacy football detector, the boundary is wrong and must be corrected before adding providers, templates, or UI.
