# Generalized Visual Perceptual QA v1

## Scope

Perceptual QA v1 is an isolated validation layer for the experimental generalized renderer. It evaluates the canonical Step 3 adapter twice: first as trusted semantic/timing data and then as pixels and DOM geometry produced by a real Chromium browser.

```text
VisualProgramV1
  -> VisualRecipePlanV1
  -> AnimationIR
  -> generalized renderer
  -> browser-rendered phase frames
  -> static + browser perceptual findings
  -> strict sanitized review report
  -> temporary bounded review pack
```

It does not replace the default renderer, change the Step 2–4 schemas, or activate a production path. Passing this layer means that the bounded fixtures satisfy the encoded checks. It does not mean that a person understood or liked the result.

## Components

- `generalized-visual-perceptual-audit-v1.mjs` verifies narration-beat and claim binding, recipe semantics, helper grounding, certainty preservation, state/reveal binding, timing windows, and structural continuity.
- `generalized-visual-review-overlay-v1.mjs` produces an engine-owned descriptor for primary, optional helper, caption lane, and focal center. The browser creates the temporary overlay; no caller-authored SVG enters the renderer.
- `generalized-visual-review-pack-v1.mjs` renders real 1080×1920 frames in Chromium, measures the resulting DOM, creates three temporary contact sheets, and emits the strict report.
- `render-generalized-visual-review-pack.mjs` provides the explicit non-writing and writing boundaries.

## Narration–visual traceability

Each scene is revalidated against the trusted StoryIR and timing context before audit or rendering. The bounded report records counts and booleans rather than raw narration:

- every `narrationBeatId` resolves to a trusted beat;
- grounded claim IDs belong to those beats;
- the program semantic family, primary recipe, and planned recipe agree;
- an optional helper is backed by a claim from the same scene;
- the displayed certainty is not stronger than the worst bound beat certainty;
- the state graph has a source, destination, reveal, resolve, and hold.

Entity/source-scene integrity is enforced by the upstream canonical adapter validator. The perceptual layer does not duplicate or weaken that contract.

## Automated gates

### Focal hierarchy

The hold frame must expose a dominant primary with sufficient rendered area and a focal center inside its trusted bounds. An optional helper must be materially smaller. Visible primitive and accent counts are capped to discourage dashboard-like compositions.

### Browser legibility

Chromium supplies actual element rectangles, computed font sizes, line counts, text compression, color contrast, edge distance, and caption-lane clearance. The v1 defaults reject font sizes below 18 px, more than three lines, compression below 0.72, contrast below 4.5, edge margin below 36 px, and caption collisions.

These are proxies, not an OCR or comprehension model. In particular, a technically readable label can still be vague, and area alone does not fully describe visual weight.

### Temporal readability

Every scene has enter, develop, reveal, resolve, and hold samples. Static timing checks require at least 18 settled frames for simple scenes, 30 for text-heavy evidence, and 36 for complex mechanisms, routes, uncertainty, absence, and chronology. Holds require at least 18 frames and no motion. A reveal must leave at least the recipe-specific settled window before scene end.

The current check is scene-local. It does not yet measure a viewer's comprehension across audio, captions, cuts, or two adjacent scenes in a final encoded short.

### Diversity

A structural signature binds recipe, composition family, style/palette identity, geometry kind, helper presence, and state profile. Repeating that structure in consecutive scenes fails unless both state-graph nodes identify the same persistent entity. The review report also records consecutive-scene structural-similarity scores—including primary bounds and geometry-point count—and the actual recipe/composition sequences for three different stories.

This detects identical structural reuse, not complete perceptual similarity. Silhouette comparison and larger-corpus palette fatigue still need human calibration.

## Review pack and agent review

Dry-run performs no browser or file work:

```bash
node tools/render-generalized-visual-review-pack.mjs --dry-run
```

Real rendering requires both flags:

```bash
node tools/render-generalized-visual-review-pack.mjs --write --confirm-bounded-review
```

The write path renders five phase frames per scene, an annotated hold overlay, and one 5×3 contact sheet per case. All media and the transient JSON file live in a temporary directory and are deleted before the CLI exits. The report contains hashes, bounded measurements, IDs, booleans, and allowlisted issue codes only—never media, narration, markup, local paths, filenames, URLs, credentials, or environment values.

The CLI leaves `agent_visual_review` explicitly pending. A completed agent rubric can only be supplied by a trusted caller after the contact sheets have actually been opened and inspected. It scores narration alignment, focal hierarchy, legibility, pacing, and diversity from 1–5, with allowlisted issue codes and no free-form generated prose.

`agent_visual_review` is not `human_review`. It provides a reproducible second inspection channel, but it cannot establish audience comprehension, aesthetic preference, accessibility, or commercial performance. Consequently every v1 report hard-codes:

```text
humanApproved: false
productionReady: false
```

## Canonical and security properties

The report has an exact schema, canonical ordering assumptions for issue codes, deep freezing, SHA-256 content binding, and an exact Git commit SHA. Runtime, browser, adapter, plan, composition, audit, frame, and contact-sheet hashes are recorded. Unsafe fields and strings fail closed. Browser routing blocks and counts every non-data external request.

Screenshot hashes are evidence for the pinned local browser/font environment, not cross-platform pixel-equivalence guarantees.

## Renderer refinements driven by the review

The first browser/contact-sheet pass exposed duplicated story labels, over-compressed multiline text, weakly signposted mechanisms, and reveals whose meaning was not visually explicit. General renderer changes therefore:

- balance fitted lines and derive a bounded effective font size rather than stretching naturally fitting text;
- remove identical heading/primary/secondary repetitions;
- keep headings clear of certainty badges;
- progressively reveal cycle cells and label the rollover state;
- label input/result, common baseline, evidence, observed/inferred/unknown, expected/absent, and earlier/later relationships;
- use a dedicated high-contrast semantic label style, including the paper evidence surface.

These labels are engine-owned vocabulary selected by recipe. They do not branch on fixture/story IDs and contain no hardcoded narration.

## Known limits

The comparison and chronology recipes remain more abstract than the strongest evidence, cycle, and route scenes. Their semantic relationship is readable with the grounded title, but the visuals are not always self-sufficient without narration. Helper text is within the measured threshold yet may still feel small on some phones. Final audio/caption timing, complete video encoding, viewer comprehension, and style preference remain outside this proof.

The correct next step is human calibration against a larger and more varied story corpus, followed by recipe refinement. It is not default production activation.
