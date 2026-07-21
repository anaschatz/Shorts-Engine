import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_SEMANTIC_SENTENCE_ASSETS,
  SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS,
  semanticSentenceGeometryKind,
  semanticSentencePrimitiveMarkup,
} from "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs";
import {
  validateCompositionIsolation,
} from "../renderer/hyperframes/composition-isolation.mjs";
import {
  compileAnimationIRToHtml,
} from "../renderer/hyperframes/animation-ir-adapter.mjs";
import {
  SEMANTIC_SENTENCE_ANIMATION_PROFILE,
  SEMANTIC_SENTENCE_ANIMATION_PROFILE_VERSION,
  SEMANTIC_SENTENCE_ANIMATION_PROVIDER,
  SEMANTIC_SENTENCE_ANIMATION_RUNTIME_VERSION,
  SEMANTIC_SENTENCE_ANIMATION_SCHEMA_VERSION,
  SEMANTIC_SENTENCE_ANIMATION_STYLE_VERSION,
  SEMANTIC_SENTENCE_CONTENT_PROFILE_ID,
  activeSemanticSentenceIndexAtFrame,
  compileSemanticSentenceAnimationIRToHtml,
  semanticSentenceRenderIntervals,
} from "../renderer/hyperframes/semantic-sentence-animation.mjs";

const require = createRequire(import.meta.url);
const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  buildSemanticVisualSentencePlan,
} = require(
  "../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs"
);
const {
  buildSemanticSentenceProductionAnimationPlan,
} = require(
  "../server/pipelines/narrated-short/animation/semantic-sentence-production-plan-compiler.cjs"
);
const {
  compileTimingBoundAnimationIR,
} = require("../server/pipelines/narrated-short/animation/compiler.cjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function rehash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return {
    ...copy,
    contentHash: createHash("sha256").update(stableStringify(copy)).digest("hex"),
  };
}

function golden(fileName) {
  const manifest = readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    fileName,
  ));
  const draft = normalizeDraftBundle(readJson(resolve(ROOT, manifest.sourceBindings.fixturePath)));
  const timing = normalizeAnimationTimingContext(readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    "timing",
    fileName.replace(/\.json$/, ".timing.json"),
  )));
  const graph = buildSemanticEventGraph({ draft, timingContext: timing, manifest });
  const sentencePlan = buildSemanticVisualSentencePlan(graph);
  return { draft, timing, graph, sentencePlan };
}

function animationIR(fixture, compositionId) {
  return {
    schemaVersion: SEMANTIC_SENTENCE_ANIMATION_SCHEMA_VERSION,
    profile: SEMANTIC_SENTENCE_ANIMATION_PROFILE,
    profileVersion: SEMANTIC_SENTENCE_ANIMATION_PROFILE_VERSION,
    width: 720,
    height: 1280,
    fps: fixture.timing.fps,
    durationFrames: fixture.timing.durationFrames,
    draftHash: fixture.draft.contentHash,
    timingBinding: {
      timingContextHash: fixture.timing.contentHash,
    },
    renderer: {
      provider: SEMANTIC_SENTENCE_ANIMATION_PROVIDER,
      runtimeVersion: SEMANTIC_SENTENCE_ANIMATION_RUNTIME_VERSION,
      styleVersion: SEMANTIC_SENTENCE_ANIMATION_STYLE_VERSION,
    },
    content: {
      compositionId,
      kicker: "DARK CURIOSITY",
      titleLines: ["SEMANTIC SENTENCES", "VISUAL PROOF"],
      semantic: {
        profileId: SEMANTIC_SENTENCE_CONTENT_PROFILE_ID,
      },
      semanticVisualSentencePlan: fixture.sentencePlan,
    },
  };
}

function productionAnimationIR(fixture, projectId) {
  const plan = buildSemanticSentenceProductionAnimationPlan({
    draft: fixture.draft,
    timingContext: fixture.timing,
    semanticProfileId: SEMANTIC_SENTENCE_CONTENT_PROFILE_ID,
    projectId,
    projectRevision: 1,
    renderProfile: "preview",
  });
  return compileTimingBoundAnimationIR(plan, fixture.timing);
}

function attributeValues(html, attribute) {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))]
    .map((match) => match[1]);
}

test("GPS and Baychimo compile to deterministic, story-specific 9:16 compositions", () => {
  const gps = golden("002_gps_week_rollover.json");
  const baychimo = golden("003_baychimo_icebound_drift.json");
  const gpsFirst = compileSemanticSentenceAnimationIRToHtml(animationIR(gps, "semantic_gps"));
  const gpsSecond = compileSemanticSentenceAnimationIRToHtml(animationIR(gps, "semantic_gps"));
  const baychimoResult = compileSemanticSentenceAnimationIRToHtml(
    animationIR(baychimo, "semantic_baychimo"),
  );

  assert.deepEqual(gpsSecond, gpsFirst);
  assert.match(gpsFirst.compositionHash, HASH_PATTERN);
  assert.match(baychimoResult.compositionHash, HASH_PATTERN);
  assert.notEqual(gpsFirst.compositionHash, baychimoResult.compositionHash);
  assert.match(gpsFirst.html, /viewBox="0 0 720 1280"/);
  assert.match(gpsFirst.html, /data-caption-safe-zone="true"/);
  assert.match(gpsFirst.html, /data-semantic-roi="true"/);
  assert.match(gpsFirst.html, /data-geometry-kind="finite_counter_rollover"/);
  assert.match(gpsFirst.html, /data-geometry-kind="cause_effect_chain"/);
  assert.match(gpsFirst.html, /data-geometry-kind="side_by_side_comparison"/);
  assert.match(baychimoResult.html, /data-geometry-kind="negative_space_vessel"/);
  assert.match(baychimoResult.html, /data-geometry-kind="map_motion_route"/);
  assert.match(baychimoResult.html, /data-geometry-kind="chronology_records"/);
  assert.match(baychimoResult.html, /data-geometry-kind="evidence_inspection"/);
  assert.match(baychimoResult.html, /data-geometry-kind="bounded_uncertainty"/);
  assert.equal(validateCompositionIsolation(gpsFirst.html).valid, true);
  assert.equal(validateCompositionIsolation(baychimoResult.html).valid, true);
  assert.doesNotMatch(gpsFirst.html, /\bhttps?:\/\/|Math\.random|Date\.now|performance\.now/i);
  assert.doesNotMatch(baychimoResult.html, /\bhttps?:\/\/|Math\.random|Date\.now|performance\.now/i);
});

test("real v3 production AnimationIR dispatches to the sentence renderer without fallback", () => {
  const gps = golden("002_gps_week_rollover.json");
  const ir = productionAnimationIR(gps, "prj_semantic_renderer_gps");
  const direct = compileSemanticSentenceAnimationIRToHtml(ir);
  const dispatched = compileAnimationIRToHtml(ir);

  const { qaPolicy, ...dispatchedComposition } = dispatched;
  assert.deepEqual(dispatchedComposition, direct);
  assert.deepEqual(qaPolicy.semanticRoi, {
    x: 36,
    y: 180,
    width: 648,
    height: 746,
  });
  assert.deepEqual(qaPolicy.captionSafeZone, {
    x: 0,
    y: 948,
    width: 720,
    height: 332,
  });
  assert.ok(qaPolicy.labelIds.length > 0);
  assert.equal(direct.profile.schemaVersion, 3);
  assert.equal(direct.profile.profile, "dark_curiosity_continuous");
  assert.equal(direct.profile.profileVersion, "1.3.0");
  assert.equal(direct.profile.provider, "hyperframes_local");
  assert.equal(direct.profile.runtimeVersion, "0.7.55");
  assert.equal(direct.profile.styleVersion, "3.0.0");
  assert.equal(
    direct.profile.sentencePlanHash,
    ir.content.semanticVisualSentencePlan.contentHash,
  );
  assert.match(direct.html, /data-semantic-profile-id="dark_curiosity_semantic_sentences_v3"/);
  assert.doesNotMatch(direct.html, /data-archetype-id=/);
});

test("renderer capability boundary exactly covers the GPS and Baychimo selected vocabulary", () => {
  const gps = golden("002_gps_week_rollover.json");
  const baychimo = golden("003_baychimo_icebound_drift.json");
  const sentences = [...gps.sentencePlan.sentences, ...baychimo.sentencePlan.sentences];
  const selectedAssets = [...new Set(
    sentences.map((sentence) => sentence.capability.assetId),
  )].sort();
  const selectedGrammars = [...new Set(
    sentences.map((sentence) => sentence.capability.grammarId),
  )].sort();

  assert.deepEqual([...SUPPORTED_SEMANTIC_SENTENCE_ASSETS].sort(), selectedAssets);
  assert.deepEqual([...SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS].sort(), selectedGrammars);
  for (const [index, sentence] of sentences.entries()) {
    const first = semanticSentencePrimitiveMarkup(sentence, index);
    const second = semanticSentencePrimitiveMarkup(sentence, index);
    assert.equal(second, first);
    assert.match(first, new RegExp(`data-sentence-id="${sentence.id}"`));
    assert.match(first, new RegExp(`data-proposition-id="${sentence.propositionId}"`));
    assert.match(first, new RegExp(`data-asset-id="${sentence.capability.assetId}"`));
    assert.match(first, new RegExp(`data-grammar-id="${sentence.capability.grammarId}"`));
    assert.match(first, /data-capability-predicate="[a-z_]+"/);
    assert.match(first, /data-capability-subject-kind="[a-z_]+"/);
    assert.match(first, /data-capability-state-transition="[a-z_]+"/);
    assert.match(first, /data-claim-ids="claim_/);
    assert.equal(
      attributeValues(first, "data-geometry-kind")[0],
      semanticSentenceGeometryKind(sentence),
    );
  }
});

test("active sentence owns narration gaps and persists through its complete interval", () => {
  const gps = golden("002_gps_week_rollover.json");
  const sentences = gps.sentencePlan.sentences;
  const intervals = semanticSentenceRenderIntervals(
    sentences,
    gps.timing.durationFrames,
  );

  assert.deepEqual(intervals[0], {
    sentenceId: "vs_gps_hook_date",
    startFrame: 0,
    semanticEndFrame: 60,
    endFrame: 78,
  });
  assert.equal(activeSemanticSentenceIndexAtFrame(intervals, 0), 0);
  assert.equal(activeSemanticSentenceIndexAtFrame(intervals, 59), 0);
  assert.equal(activeSemanticSentenceIndexAtFrame(intervals, 60), 0);
  assert.equal(activeSemanticSentenceIndexAtFrame(intervals, 77), 0);
  assert.equal(activeSemanticSentenceIndexAtFrame(intervals, 78), 1);
  assert.equal(intervals.at(-1).endFrame, gps.timing.durationFrames);
  assert.equal(
    activeSemanticSentenceIndexAtFrame(
      intervals,
      gps.timing.durationFrames - 1,
    ),
    intervals.length - 1,
  );
});

test("compiled markup exposes deterministic sentence traceability without executing source copy", () => {
  const baychimo = golden("003_baychimo_icebound_drift.json");
  const ir = animationIR(baychimo, "semantic_escape_proof");
  ir.content.titleLines = ["<script>throw new Error('owned')</script>"];
  const result = compileSemanticSentenceAnimationIRToHtml(ir);

  assert.match(result.html, /&lt;script&gt;throw new Error\(&apos;owned&apos;\)&lt;\/script&gt;/);
  assert.doesNotMatch(result.html, /<script>throw new Error/);
  assert.match(result.html, /data-active-semantic-sentence-id|activeSemanticSentenceId/);
  assert.match(result.html, /activePropositionId/);
  assert.match(result.html, /activeAssetId/);
  assert.match(result.html, /activeGrammarId/);
  assert.match(result.html, /activeCapabilityPredicate/);
  assert.match(result.html, /activeClaimIds/);
  assert.match(result.html, /connect-src 'none'/);
  assert.match(result.html, /object-src 'none'/);
});

test("renderer rejects stale hashes, remote text, and future capability fallbacks", () => {
  const gps = golden("002_gps_week_rollover.json");

  const stale = animationIR(gps, "semantic_stale");
  stale.content.semanticVisualSentencePlan = structuredClone(gps.sentencePlan);
  stale.content.semanticVisualSentencePlan.sentences[0].wordSpan.text = "tampered";
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(stale),
    /hash does not match/,
  );

  const remote = animationIR(gps, "semantic_remote");
  remote.content.titleLines = ["https://remote.invalid/asset"];
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(remote),
    /bounded safe text/,
  );

  const unsupported = animationIR(gps, "semantic_unsupported");
  const futurePlan = structuredClone(gps.sentencePlan);
  futurePlan.sentences[0].capability.assetId = "future_magic_asset";
  unsupported.content.semanticVisualSentencePlan = rehash(futurePlan);
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(unsupported),
    /asset is unsupported/,
  );

  const wrongProfile = animationIR(gps, "semantic_wrong_profile");
  wrongProfile.profileVersion = "1.2.0";
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(wrongProfile),
    /tuple is invalid/,
  );

  const wrongRuntime = animationIR(gps, "semantic_wrong_runtime");
  wrongRuntime.renderer.runtimeVersion = "0.7.54";
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(wrongRuntime),
    /tuple is invalid/,
  );
});
