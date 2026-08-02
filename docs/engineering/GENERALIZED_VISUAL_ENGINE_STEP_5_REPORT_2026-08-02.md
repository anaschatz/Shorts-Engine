# Generalized Visual Engine — Step 5 report — 2026-08-02

## Outcome

Step 5 adds a reusable perceptual-QA and temporary review-pack layer around the experimental generalized renderer. A real Chromium run now measures the actual 1080×1920 output rather than treating schema validity, SVG bounds, or deterministic screenshots as sufficient quality evidence.

The default production renderer remains unchanged and the generalized path remains opt-in. This work does not claim human approval or production readiness.

## What was implemented

- Static scene audit for beat/claim traceability, recipe semantics, helper grounding, certainty, visible state transition, settled dwell, hold motion, reveal timing, and structural continuity.
- Browser audit for primary/helper visual weight, focal placement, rendered font size and lines, `textLength` compression, computed contrast, edge/caption safety, visible complexity, map disclosure, and duplicate key labels.
- A bounded primary/helper/caption/focal overlay descriptor.
- A write-gated Chromium review tool that renders 45 phase screenshots, nine overlays, and three 5×3 contact sheets for the existing three-fixture corpus.
- A strict, sanitized, deeply frozen, exact-commit, content-hash-bound report with an explicit `agent_visual_review` rubric.
- Focused pure and real-browser regression tests without skips.

No story-owned asset, generated media, contact sheet, local report, cache, or existing user file is part of the implementation.

## Findings and generalized renderer changes

The initial numeric/browser pass found real failures rather than being tuned to pass:

- identical grounded labels were rendered twice in some scenes;
- naturally narrow multiline labels were incorrectly classified as compressed;
- some fitted text used unnecessarily aggressive stretching;
- finite-cycle states appeared together too early;
- cause/effect, uncertainty, absence, comparison, evidence, and chronology structures needed clearer relationship cues;
- the paper evidence label required contrast measurement against its actual light surface.

The generalized primitive/style layer was refined accordingly. Text fitting now balances lines and preserves an 18 px floor; duplicate heading/primary/secondary copy is suppressed; headings leave room for badges; reveals expose the cycle progressively; and bounded recipe-owned semantic labels identify rollover, input/result, baseline, evidence, certainty regions, expected/absent, and earlier/later states. Browser contrast logic now uses the actual paper surface.

There are no branches for the three fixture/story IDs, no hardcoded narration, no caller-authored SVG, and no additional recipe or schema.

## Validation result

The post-fix real-browser review covered:

- three tracked story fixtures;
- nine scenes and all eight recipe IDs;
- five phases per scene, or 45 rendered phase frames;
- nine annotated hold overlays;
- three 1080×1152 contact sheets assembled from real 1080×1920 frames;
- network-isolated headless Chromium with the embedded pinned font.

All automated gates passed after the renderer fixes. The contact sheets were then opened and inspected rather than accepted from metrics alone.

The bounded agent rubric is:

| Dimension | Score |
| --- | ---: |
| Narration alignment | 3/5 |
| Focal hierarchy | 4/5 |
| Legibility | 4/5 |
| Pacing | 4/5 |
| Diversity | 4/5 |

The remaining allowlisted finding is `VISUAL_NARRATION_LINK_WEAK`. The evidence, uncertainty, finite-cycle, cause/effect, route, and absence sequences are clearer after refinement. Comparison and chronology are still comparatively abstract: their direction is legible, but the visual may not explain the full narrated relationship without the grounded label and voiceover.

This is a provisional agent pass only. Every emitted report retains `humanApproved: false` and `productionReady: false`.

## What was actually proved

- Browser measurements can catch real typography, hierarchy, contrast, disclosure, duplicate-label, density, and safe-area failures.
- Static trusted bindings provide a bounded narration-to-visual audit without leaking narration into the report.
- Timing thresholds change deterministically with the timing context and affect the audit hash/result.
- Repeated structures fail unless persistent identity continuity justifies them.
- All eight recipes produce structurally different sequences across the bounded corpus.
- Temporary review media are generated with bounded dimensions and removed rather than committed.
- The report rejects shape, metric, issue-code, summary, unsafe-content, and hash tampering.

## What remains uncertain

- No human viewer has approved comprehension, pacing, accessibility, or aesthetics.
- Three fixtures are too small a corpus to prove generalization or prevent long-run visual fatigue.
- DOM geometry and deterministic thresholds are proxies for attention and comprehension.
- Structural signatures do not replace perceptual silhouette comparison or user studies.
- The review samples phases, not final audio, captions, cuts, encoded video, or distribution playback.
- Some helper copy is valid at the threshold but may still be too small on a physical phone.
- Comparison and chronology need human-guided semantic refinement.

## Release boundary

The write-gated report is regenerated after the feature commit so its `commitSha` binds the exact delivered revision. It is still not a release proof. Step 6 should use a larger, different corpus and real human calibration to refine the weakest recipes. The generalized renderer must remain disabled by default until that work produces explicit evidence.
