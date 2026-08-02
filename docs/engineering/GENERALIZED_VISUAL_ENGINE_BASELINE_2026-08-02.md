# Generalized Visual Engine baseline — 2026-08-02

## Executive verdict

The repository contains a real narrated-video production foundation, but it does not yet contain one visual engine that consistently converts arbitrary verified stories into clear, high-quality animation.

- The real engine is the contract-bound path from narration alignment through StoryIR/semantic planning, validated AnimationIR, local HyperFrames rendering, FFmpeg composition, captions, QA, and evidence packaging.
- `mechanism-explainer-v1` is the strongest reusable visual boundary demonstrated by rendered evidence. It renders two data-only stories through one compiler, owns all geometry, and rejects executable or story-owned layout input. Its domain is deliberately narrow.
- The semantic-v3 and educational-explainer stacks are broader generalized production contracts. They are architecturally stronger than the hand-authored demos, but the inspected evidence does not establish comparable human comprehension or visual polish across ten unrelated stories.
- Wow Signal human-v4 is the strongest inspected visual result. It is also the clearest example of story-specific debt: one 1,317-line renderer, inherited story asset kits, exact story/frame choreography, and a dedicated render tool.
- GPS human-v1 and Baychimo human-v1 are useful design studies, not reusable engine modules. Each new story requires new JavaScript and new coordinates.
- The next step must generalize the *boundary demonstrated by mechanism-explainer-v1* into a bounded recipe DSL connected to the existing StoryIR/AnimationIR production path. Extending the Wow/GPS/Baychimo hand-authored renderer family would deepen the wrong abstraction.

No renderer, test, media file, fixture, `.gitignore`, cache, or product behavior was changed by this audit.

## 1. Git and validation baseline

### Repository state captured before documentation changes

| Field | Value |
| --- | --- |
| Branch | `codex/production-beta-vertical-slice` |
| Local HEAD | `de9008e2e9cde05ff03d05e762bc225a3ddc8f97` |
| Upstream HEAD | `de9008e2e9cde05ff03d05e762bc225a3ddc8f97` |
| Existing tracked modifications | 3 files |
| Existing untracked files after validation | 3,430 files |

Existing tracked changes, treated as user-owned and left untouched:

- `package.json`
- `server/pipelines/narrated-short/captions/ass-generator.cjs`
- `tests/narrated-captions-audio.test.cjs`

The full suite regenerated the tracked timestamp in `viking-brain/agent/matchcuts-ai/memories/sessions/test-openviking-lite.md`. That test side effect was reverted to its pre-test value; it is not part of this task.

### Secret scan

A filename-aware and content-pattern scan covered 4,217 tracked/untracked files before tests, excluding binary media and bulk cache payloads. The apparent matches were existing placeholders, redaction-test fixtures, test-only token signatures, environment-variable lookups, and deliberately invalid credential-bearing URLs. No plausible live value was found and no raw candidate value was printed. The final pre-commit scan must still be repeated because the working tree is dirty.

### Validation results

| Gate | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run build` | pass |
| Focused narrated visual tests | 99 total; 97 pass; 0 fail; 2 skip |
| `npm test` | 1,732 total; 1,723 pass; 0 fail; 9 skip |

The two focused skips were browser-frame checks: Playwright Chromium was unavailable or blocked by the workspace sandbox. The full-suite skips are environment-gated checks, not hidden regressions. The existing MP4s were separately probed and all five inspected outputs were H.264/AAC, 1080×1920, and 30 fps.

These results prove contract validation, deterministic compilation, media shape, hash bindings, and selected motion invariants. They do **not** prove that a viewer understands an animation, that visuals match narration semantically, that a result is entertaining, or that it is publishable.

## 2. Artifact inventory

### Untracked inventory snapshot

| Category | Files | Size | Disposition |
| --- | ---: | ---: | --- |
| Temporary cache | 2,782 | 2,704.52 MiB | Keep local; reproducible; cleanup candidate |
| Deliverables | 129 | 110.35 MiB | Keep local; manual review before deletion |
| Human-review evidence | 424 | 45.91 MiB | Track only selected bounded reports/goldens |
| Generated MP4/VTT/ASS | 16 | 15.91 MiB | Keep local by default |
| Generated contact sheets | 8 | 2.40 MiB | May track only as approved visual evidence |
| Story-specific renderers | 5 | 0.20 MiB | Archive as reference; do not extend |
| Tests | 11 | 0.17 MiB | Candidate source, but outside this audit commit |
| Tooling/compilers | 9 | 0.29 MiB | Separate reusable orchestration from story scripts |
| Golden evaluation artifacts | 3 | 0.06 MiB | Candidate tracked test inputs after review |
| Story-owned assets | 39 | 0.04 MiB | Archive with provenance; not general vocabulary |
| Reusable renderer/compiler | 1 | 0.03 MiB | Generalize in Step 2 |
| Calibration fixtures | 2 | 0.01 MiB | Candidate tracked benchmark inputs |
| Documentation prompt | 1 | 0.01 MiB | Documentation only |

The counts are file-level. Git's short status collapses untracked directories, so its entry count is much smaller than the actual file count.

### Significant source inventory

| File | LOC | Bytes | Direct callers/importers observed | Coupling and classification | Recommended future action |
| --- | ---: | ---: | --- | --- | --- |
| `renderer/hyperframes/wow-signal-human-v2.mjs` | 948 | 40,814 | Four render tools and three tests | Story-specific; about 130 coordinate literals and 75 frame literals; reads Wow-only asset manifests | Archive as visual-reference source; extract patterns, not renderer |
| `renderer/hyperframes/wow-signal-human-v3.mjs` | 719 | 29,616 | Two render tools and one test | Story-specific delta over v2; about 139 coordinate and 90 frame literals; six v3 assets plus v2 parent | Archive after primitive extraction |
| `renderer/hyperframes/wow-signal-human-v4.mjs` | 1,317 | 60,412 | One render tool and one test | Story-specific full-story choreography; imports v3/v2 assets and binds exact Wow narrative/frame events | Stop extending; visual benchmark only |
| `renderer/hyperframes/gps-rollover-human-v1.mjs` | 951 | 39,785 | Batch tool, one test, evidence manifest | One GPS fixture; about 77 coordinate and 15 frame literals | Archive as finite-counter design study |
| `renderer/hyperframes/baychimo-human-v1.mjs` | 847 | 36,701 | Batch tool, one test, evidence manifest | One Baychimo fixture; about 54 coordinate and 22 frame literals | Archive as route/absence design study |
| `renderer/hyperframes/mechanism-explainer-v1.mjs` | 1,081 | 34,531 | Calibration tool, two tests, two manifests | Reusable narrow compiler; no story IDs/frame literals; fixed engine-owned geometry; data-only input | Canonical visual boundary for Step 2 |
| `renderer/hyperframes/generic-semantic-animation.mjs` | 410 | 24,263 | AnimationIR adapter and semantic-shape tests | Generalized renderer for validated AnimationIR; broad but visually abstract | Preserve as production compatibility layer |
| `renderer/hyperframes/educational-explainer-animation.mjs` | 227 | 16,780 | AnimationIR adapter and educational tests | Generalized recipe renderer; production-connected, but no inspected five-story visual proof | Preserve; converge with new bounded recipe boundary |
| `tools/render-dark-curiosity-human-quality-batch.mjs` | 1,129 | 37,053 | Package script and one test | Duplicated orchestration selecting two separate story compilers | Retire after equivalent generalized benchmark runner exists |
| `tools/render-mechanism-explainer-calibration.mjs` | 1,672 | 55,077 | Package script and calibration tests | Reusable calibration orchestration for two data-only stories; direct Playwright/FFmpeg filesystem effects | Split generic runner/evidence responsibilities later |

Across the six emphasized experimental renderers and their major tools, the audit found more than 13,000 lines of mostly uncommitted implementation. That volume is not evidence of generalization; much of it encodes a single story or its proof harness.

### Source versus reproducible output

- Source candidates: contracts, planners, generic/educational renderers, mechanism compiler, validated fixtures, allowlisted primitive implementations, small deterministic tests.
- Reproducible outputs: MP4, VTT/ASS, contact sheets, sampled PNG frames, render reports, frame hashes, temporary HTML, PCM/WAV intermediates, and most `showcase/evidence` payloads.
- Story-owned material: Wow v2/v3 SVG kits and their manifests. They have first-party provenance, but their semantic roles and geometry belong to the Wow production, not a generalized asset vocabulary.
- Manual-review material: `deliverables/` contains source/output media, thumbnails, publishing scripts/receipts, and other operator artifacts. It is outside the engine boundary and must not be batch-deleted or committed without a separate review.

## 3. Actual architecture flow

```text
verified fixture / draft bundle / claim ledger
  -> narration script and audio
  -> exact word alignment and timing context
  -> StoryIR + visual intent / semantic event graph
  -> production plan + validated AnimationIR
  -> profile dispatch in animation-ir-adapter
  -> deterministic HTML/SVG/CSS
  -> local HyperFrames/Chromium frame render
  -> FFmpeg visual master + narration + captions
  -> technical/perceptual QA + evidence package
  -> non-publishable MP4 pending human review
```

| Stage | Canonical modules/contracts | Inputs → outputs | Side effects/dependencies | Main risk |
| --- | --- | --- | --- | --- |
| Verified story | `contracts.cjs`, fixture `brief`, `claimLedger`, storyboard validators | Validated brief/claims → draft bundle | Reads fixture JSON | Three real fixtures are not a broad corpus |
| Narration and word timing | `narration/alignment.cjs`, `timing-context-builder.cjs`, `timing-resolver.cjs` | Exact script/provider words → frame-bound alignment/timing context | TTS/alignment providers may spawn Python/FFmpeg and use local models | Environment-dependent live alignment; exact bindings are reusable |
| Semantic understanding | `story-ir.cjs`, `generalized-visual-intent-planner.cjs`, semantic event/state graph modules | Draft + alignment → hash-bound semantic propositions and continuity | Predominantly pure/deterministic | Planner correctness does not imply visual clarity |
| Production planning | `production-plan-compiler.cjs`, semantic/educational profile contracts | Trusted semantic context → production plan/AnimationIR | No required media side effect | Multiple overlapping profile versions increase coupling |
| Renderer dispatch | `renderer/hyperframes/animation-ir-adapter.mjs` | Validated AnimationIR → selected compiler | Imports generic, semantic-sentence, and educational renderers | Human demo renderers bypass this canonical dispatch |
| HTML/SVG | `generic-semantic-animation.mjs`, `semantic-sentence-animation.mjs`, `educational-explainer-animation.mjs`; experimental human renderers | Engine-owned structured plan → self-contained markup | Local font/asset reads | Arbitrary hand-coded SVG/coordinates exist in demo family |
| Frame rendering | `renderer/hyperframes/render-worker.mjs`, HyperFrames producer; calibration tools use Playwright directly | Markup + exact frame clock → PNG/frame stream | Chromium, local filesystem, subprocess/runtime installation | Sandbox/runtime availability; two orchestration paths |
| Composition | `video-compositor.cjs`, shared render/media helpers | Visual master + audio + ASS → H.264/AAC MP4 | Temp files, FFmpeg/ffprobe subprocesses | Some experimental tools duplicate this orchestration and contain Homebrew-specific fallbacks |
| Captions/audio | `captions/contract.cjs`, `captions/ass-generator.cjs`, narration/TTS and audio-normalization modules | Word alignment/audio → caption manifest, ASS, normalized audio | Local files, FFmpeg, optional TTS runtime | Current tracked caption edits are outside this audit |
| QA/evidence | `qa/qa-orchestrator.cjs`, `evidence/package-orchestrator.cjs`, contact-sheet generator, perceptual/motion QA | Artifacts + bindings → reports/contact sheets/gates | Reads media; writes evidence; ffprobe/frame sampling | Automated gates remain proxies for human comprehension |

## 4. Renderer comparison and generalization matrix

Strict definition used here:

> A generalized renderer can produce a new story only from validated structured input and allowlisted assets, without changes to JavaScript, SVG templates, or engine-owned coordinates.

| Pipeline / renderer | Stories demonstrated | New JS per story? | Story coordinates accepted? | Arbitrary executable markup accepted? | Engine-owned anchors | Persistent primary | Reusable recipes | Narration-derived timing | New story without production-code change? | Verdict |
| --- | ---: | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| Generic semantic-v3 production stack | 3 unrelated checked fixtures plus non-registry tests | No | No at validated boundary | No | Yes | Supported by state/continuity contracts | 9 grammar families | Yes | Yes, within allowlisted capabilities | Generalized, broad, visually under-proven |
| Educational explainer | Contract/tests cover the semantic families; no five-output visual baseline here | No | No | No | Yes | Supported by director plan | 10 recipes, 5 layouts, 5 transitions | Yes | Yes, within allowlist | Generalized contract and renderer; quality not established |
| Wow human v2/v3/v4 | 1 story | Yes | Encoded in JS/assets | Renderer itself contains arbitrary SVG/CSS | No generalized layout | Wow printout/signal lineage only | Story scenes, not recipes | Exact story words/frames | No | Story-specific demo |
| GPS human-v1 | 1 story | Yes | Encoded in JS | Renderer contains story SVG/CSS | GPS-specific | GPS counter | Story scenes | Exact story words/frames | No | Story-specific demo |
| Baychimo human-v1 | 1 story | Yes | Encoded in JS | Renderer contains story SVG/CSS | Baychimo-specific | Ship | Story scenes | Exact story words/frames | No | Story-specific demo |
| Mechanism-explainer-v1 | 2 data-only stories | No | Explicitly rejected | Explicitly rejected | Yes, fixed geometry/transforms | Fixed counter device | 5 helper recipes; 6 motion actions | Phrase/token triggers | Yes, for finite counters | Truly generalized inside a narrow domain |

Architectural ranking:

1. Best demonstrated boundary: `mechanism-explainer-v1`.
2. Broadest production foundation: semantic-v3 StoryIR/visual-intent/AnimationIR stack.
3. Best visual result: Wow Signal human-v4.
4. Most reusable rendered output: mechanism-explainer GPS/odometer pair.
5. Most story-specific: Wow v2/v3/v4, followed by GPS human-v1 and Baychimo human-v1.

## 5. Visual quality baseline

Scale: 1 is poor and 5 is strong. For `repetition`, 5 means little unjustified repetition and 1 means severe repetition. Scores are based on visual inspection of existing contact sheets plus bounded evidence/ffprobe reports; they are not a substitute for timed viewer studies.

### Score matrix

| Metric | Wow human-v4 | GPS human-v1 | Baychimo human-v1 | Mechanism GPS | Mechanism odometer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narration–visual alignment | 4 | 4 | 4 | 5 | 5 |
| Causal clarity | 4 | 4 | 4 | 5 | 5 |
| Focal-point clarity | 4 | 4 | 4 | 5 | 5 |
| Centering | 4 | 3 | 4 | 5 | 5 |
| Element scale | 3 | 3 | 4 | 4 | 4 |
| Composition variety | 4 | 4 | 4 | 2 | 2 |
| Continuity | 5 | 3 | 4 | 5 | 5 |
| Comprehension time | 3 | 4 | 4 | 5 | 5 |
| Caption separation | 4 | 4 | 4 | 5 | 5 |
| Visual sophistication | 5 | 3 | 3 | 3 | 3 |
| Repetition | 2 | 4 | 4 | 2 | 2 |
| Generalizability | 1 | 1 | 1 | 4 | 4 |

### Evidence for every score

| Output | Evidence-based reasons |
| --- | --- |
| Wow human-v4 | **Alignment 4:** discovery, handwriting, 72-second measurement, beam crossing, failed repeat, and unresolved conclusion appear in narration order. **Causality 4:** the signal remains one visual lineage, though later inference is represented by abstract cards. **Focus 4 / centering 4:** each frame normally has one dominant object in the lower visual band, but thin charts and small evidence cards dilute focus. **Scale 3:** labels, apparatus, and signal details are small on a phone-sized contact view. **Variety 4:** character, paper, chart, telescope, folders, and verdict scenes vary. **Continuity 5:** the printout/signal morph persists across transitions. **Comprehension 3:** many micro-states and quick chart changes require more viewing time than the stills provide. **Caption separation 4:** a dedicated lower caption band is maintained, but the repeated header and captions compete with sparse scenes. **Sophistication 5:** strongest line-art choreography and morphing of the inspected set. **Repetition 2:** the same curve/card returns many times. **Generalizability 1:** exact Wow words, frames, assets, and dependencies are encoded in a 1,317-line renderer. |
| GPS human-v1 | **Alignment 4:** counter, repeated value, twenty-year cycle, patch, and continuing time all correspond to the narration. **Causality 4:** the sequence exposes counter → interpretation bug → correction. **Focus 4:** most frames have one obvious subject. **Centering 3 / scale 3:** device, stick figure, timeline, clock, and cards move among different anchors and some explanatory details are small. **Variety 4:** counter, timeline, people, comparison, and clock avoid one template. **Continuity 3:** the visual subject changes rather than preserving one stable device. **Comprehension 4:** each still states a single idea, although layout jumps add reorientation cost. **Caption separation 4:** bottom text is consistently separate. **Sophistication 3:** clean diagrammatic language, limited object animation. **Repetition 4:** repeated counter motifs are causally justified and not dominant. **Generalizability 1:** GPS ID, coordinates, frames, and scene grammar are embedded in JavaScript. |
| Baychimo human-v1 | **Alignment 4 / causality 4:** icebound ship, absence, sightings, visitors, archival span, evidence versus ghost story, and unknown fate track the story clearly. **Focus 4 / centering 4 / scale 4:** the ship or archive is large and visually isolated. **Variety 4:** absence, route, sighting, archive, evidence, and final uncertainty are distinct. **Continuity 4:** the ship persists semantically even when hidden; position changes are readable. **Comprehension 4:** one causal statement per frame with clear color coding. **Caption separation 4:** the lower lane is free of stage elements. **Sophistication 3:** effective but simple stick/line illustration. **Repetition 4:** ship reuse maintains identity without dominating every frame. **Generalizability 1:** a dedicated 847-line compiler and hardcoded Baychimo geometry are required. |
| Mechanism GPS | **Alignment 5 / causality 5:** the same receiver visibly advances from 838 to 1023, rolls to 0000, shows the wrong date, then applies a cycle correction. **Focus 5 / centering 5:** one fixed large device owns a stable central anchor. **Scale 4:** primary digits are strong; helper-rail copy is smaller than ideal. **Variety 2:** almost every composition is the same device plus one helper card. **Continuity 5:** stable transforms eliminate reorientation. **Comprehension 5:** settled state changes and one helper make the mechanism easy to follow. **Caption separation 5:** captions occupy a dedicated untouched lane. **Sophistication 3:** polished system diagram, modest scene language. **Repetition 2:** deliberate stability becomes visual monotony. **Generalizability 4:** one data-only compiler handles another counter story, but only the finite-counter domain is proven. |
| Mechanism odometer | **Alignment 5 / causality 5:** six wheels, final value, carry, rollover, same car, and finite-counter conclusion are shown directly. **Focus 5 / centering 5:** the odometer never leaves its engine-owned anchor. **Scale 4:** digits are legible; helper text remains small. **Variety 2:** it reuses the exact GPS composition. **Continuity 5:** the persistent odometer makes identity obvious. **Comprehension 5:** each phrase produces one bounded state change with a settled hold. **Caption separation 5:** no helper enters the caption lane. **Sophistication 3:** clean but mechanically uniform. **Repetition 2:** the same card/device arrangement fills all frames. **Generalizability 4:** it proves reuse without renderer edits, while also exposing the current domain/layout limit. |

All five evidence reports remain `publishable: false` and `human_review_pending` (or equivalent). Technical gates passed for the GPS, Baychimo, and mechanism outputs; Wow v4 explicitly retains human-review blockers.

## 6. Reusable primitive candidates

Extract behavior and constraints, not story markup:

- Persistent-primary-object lifecycle: enter, update, transform/morph, settle, resolve, exit.
- Engine-owned focal anchors, safe zones, scale bounds, and caption lane.
- One-primary/one-helper focus budget from mechanism-explainer.
- Finite counter with carry/rollover and bounded numeric labels.
- Evidence card, comparison card, uncertainty boundary, and honest unresolved verdict.
- Timeline with accumulation and highlighted event.
- Map/route with approximate-route disclosure and disappearance/reappearance state.
- Evidence-lens/inspection gesture and callout pointer.
- Matched signal/curve morph with identity preserved across scenes.
- Negative-space absence and reappearance recipe.
- Narration-token trigger, transition, settle, and comprehension-hold timing.
- Bounded draw-reveal, match-morph, focus-lens, mask-wipe, and scale-focus transitions.
- Asset manifest with local-only provenance, hash, viewBox, role, and rights state.

These candidates already exist in partial form across `semantic-render-profile.cjs`, `educational-explainer-profile.cjs`, `primitives/`, and mechanism/human experiments. Step 2 should consolidate them behind one strict contract rather than copy implementations.

## 7. Story-specific debt that must not be generalized

- Wow handwriting frame intervals, the exact “Wow!” pen path, 72-second plot coordinates, telescope crossing frames, named evidence cards, and Wow-specific character poses.
- GPS 2019/2038 labels, stick-figure diagnosis, specific counter values, and scene-by-scene coordinates.
- Baychimo ship path, named years/sightings, ghost-story card, and story-authored route geometry.
- Story-specific titles, script substrings, hardcoded source hashes, absolute scene/frame boundaries, and output filenames.
- Arbitrary SVG/HTML/CSS/JavaScript from a planner or fixture.
- A universal fixed blue/purple template. Palette and background should be controlled by bounded style tokens, not copied story CSS.
- Human-renderer tests that lock one story's pixels as if that establishes generalized quality.

## 8. Dependency and coupling risks

1. Two production paths exist: canonical AnimationIR dispatch and direct story render tools. The latter duplicate Chromium, FFmpeg, caption, evidence, and output logic.
2. CommonJS server modules and ESM renderer/tools create adapter seams and make dependency ownership less obvious.
3. Experimental tools read/write fixed repository paths and contain local Homebrew FFmpeg fallbacks. These are calibration conveniences, not production interfaces.
4. Several tests bind untracked MP4/evidence files by hash. A clean clone cannot validate those experiments unless the source/evidence policy is resolved.
5. The Wow v3/v4 chain imports parent story assets and historical outputs, so each visual revision increases transitive story coupling.
6. HyperFrames/Chromium and local fonts are runtime dependencies; browser proof was skipped in the current sandbox even though the installed runtime is detected elsewhere.
7. Automated perceptual/motion gates evaluate measurable proxies. No current artifact records independent viewer comprehension scores for the five inspected outputs.
8. Existing generalized modules overlap in vocabulary: semantic-v3 grammars, educational recipes/layouts, scene archetypes, capabilities, and mechanism recipes. Adding another parallel vocabulary would increase drift.

## 9. Canonical foundation for Step 2

Use this boundary:

```text
validated StoryIR + exact narration timing
  -> VisualProgram (data only; semantic recipe IDs and asset references)
  -> strict validator (no coordinates, markup, code, URLs, or unbounded text)
  -> engine-owned recipe compiler (layout, geometry, motion, focus, holds)
  -> existing validated AnimationIR
  -> existing HyperFrames worker / FFmpeg / captions / QA / evidence path
```

The VisualProgram should combine:

- the security/generalization discipline of mechanism-explainer-v1;
- the broad semantic families and source bindings of semantic-v3;
- the recipe/layout/transition vocabulary of educational-explainer;
- selected human-renderer patterns as bounded primitives;
- existing AnimationIR and production render infrastructure, not a new media stack.

Step 2 should implement only the contract, registry, validation, and compiler boundary for a minimal vertical slice. It should not add a new end-to-end render tool or another story renderer.

## 10. What was not verified

- No new MP4 was rendered.
- Full-motion visual inspection and audio-visual timing were not replayed end to end; the audit inspected contact sheets, evidence reports, tests, and ffprobe metadata.
- The skipped browser random-access tests were not forced around the sandbox restriction.
- No clean-clone test was run because the relevant experimental source and evidence are untracked by instruction.
- No independent viewer panel or comprehension study exists.
- No production publishability approval exists for any inspected output.
- No seven additional sourced stories exist yet for the proposed ten-story benchmark.
- No claim is made that the current generalized renderers achieve the visual quality of Wow v4.
- No deletion safety was proved for `deliverables/`; it remains manual-review-only.

## 11. Forbidden conclusions from current tests

Do not infer any of the following from green tests:

- “The animation is easy to understand.”
- “Narration and visuals are semantically coherent for arbitrary stories.”
- “Passing frame hashes means good animation.”
- “The renderer is generalized because it accepts an object.”
- “Two counter examples prove ten-family generalization.”
- “A technical QA pass means publishable.”
- “The engine can create a new high-quality animation without human code.”
- “Existing generated media is safe to commit or delete.”

## Final classification

| Question | Strict answer |
| --- | --- |
| What is real engine? | Alignment/timing contracts, StoryIR/semantic planning, validated AnimationIR, canonical HyperFrames worker, FFmpeg composition, caption/audio contracts, QA/evidence boundaries, and the data-only mechanism compiler pattern. |
| What is a story-specific demo? | Wow human v2/v3/v4, GPS human-v1, Baychimo human-v1, their dedicated render tools, story assets, and generated evidence/media. |
| What should be kept? | Canonical contracts/infrastructure, semantic planners, educational recipe vocabulary, mechanism boundary, reusable primitives, verified fixtures/goldens, and selected bounded evidence. |
| What should stop expanding? | One-JavaScript-file-per-story renderers and story-specific coordinate/frame choreography. |
| Exact next boundary | Validated, non-executable VisualProgram → engine-owned recipe compiler → existing AnimationIR. |
