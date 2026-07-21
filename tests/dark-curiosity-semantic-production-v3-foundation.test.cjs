"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  contentHash,
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  listSemanticEventProfiles,
  resolveSemanticEventProfile,
} = require("../server/pipelines/narrated-short/animation/semantic-event-profile-registry.cjs");
const {
  SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES,
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
  SEMANTIC_SENTENCE_PROFILE_VERSION,
  SEMANTIC_SENTENCE_STYLE_VERSION,
  SEMANTIC_SENTENCE_TEMPLATE_ID,
} = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");
const {
  buildSemanticSentenceProductionAnimationPlan,
} = require("../server/pipelines/narrated-short/animation/semantic-sentence-production-plan-compiler.cjs");
const {
  compileTimingBoundAnimationIR,
} = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const {
  validateAnimationIR,
} = require("../server/pipelines/narrated-short/animation/contract.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  browserQaExpectations,
  browserResultMeetsPolicy,
  motionQaGeometryRequirements,
  safeSeekSequence,
} = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const {
  semanticVisualSentencePlanContentHash,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
const {
  bindAnimationTiming,
} = require("../server/pipelines/narrated-short/animation/timing-compiler.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");

const ROOT = resolve(__dirname, "..");
const CASES = Object.freeze([
  "002_gps_week_rollover",
  "003_baychimo_icebound_drift",
]);
const DEFAULT_V2_HASHES = Object.freeze({
  "002_gps_week_rollover": Object.freeze({
    plan: "16ebf4d3969ab37bead82c154381f18080a7a9cfaa4dcf5b720fa9bbc5bf914a",
    ir: "25bf6e3fe5378285fa8480084ffd4058ceeb4f88c704de5f88ebbc47320b1236",
    composition: "c7e1d2aa779fe8fdb52dd66d9e2f9bf796851ca6bc1ffcfba20a532a63d7ca36",
  }),
  "003_baychimo_icebound_drift": Object.freeze({
    plan: "71992f5a56cb1dd17c9d24042d0871110afddab4f338a7c4321c68dd7a83ed69",
    ir: "d77c2b179da6a05cc8d8d77a23b5bcdfd00395016b881daf801467d99314364d",
    composition: "dabe2d6df7da73596bc3d82f9041b76e1b7e045f1dc94a4ca4ab3b0289253fbc",
  }),
});
const SEMANTIC_V3_HASHES = Object.freeze({
  "002_gps_week_rollover": Object.freeze({
    graph: "e2405560134386bb7d70745a1c89ef059ebaec15495b96d4129eee56d3c7be08",
    sentences: "75548c57aa2ce8f101deb35e098f725c6d3faa18dfd2cf8b60b62f948f544341",
    plan: "361ef45cb3178a41804e1a9c75600e57982548d4a1048f64bf3d905251389759",
    ir: "9613fe7c2b09c6707eab4b060393d7da9519a1849a454a241c94f48523848ea4",
    composition: "47302757ce17a264a7720d51fec6dfb5031ddc09c68e8c58aa574df01b3d76a5",
  }),
  "003_baychimo_icebound_drift": Object.freeze({
    graph: "54383a235b65264c4c8e269d9fd49901de439c8c92e256963179393b87832ab4",
    sentences: "24192acffd6dbe70b6cd59f2bdb92ad5b61b5de5c19546b1a6c94edbc58fac28",
    plan: "72c75276f42ce8f374b79dc5d2a12828f050ad0c021ea40360a93847e8a64ea0",
    ir: "5e620f50f3c90c50263a58c91a4a7226b262646161826f5ba486ffa46c447f23",
    composition: "3d8abb0fe9e83a6206dfb60f7ec98b049eb9ed22977234b4081129a6bc5a8696",
  }),
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixture(id) {
  const manifest = readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    `${id}.json`,
  ));
  return {
    draft: normalizeDraftBundle(readJson(resolve(ROOT, manifest.sourceBindings.fixturePath))),
    timingContext: normalizeAnimationTimingContext(readJson(resolve(
      ROOT,
      "eval",
      "narrated",
      "dark-curiosity",
      "semantic-events",
      "timing",
      `${id}.timing.json`,
    ))),
  };
}

function build(id) {
  const value = fixture(id);
  return {
    ...value,
    plan: buildSemanticSentenceProductionAnimationPlan({
      ...value,
      semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
      projectId: `prj_${id}`,
      projectRevision: 1,
      renderProfile: "preview",
    }),
  };
}

test("semantic v3 profile registry is a fixed exact tuple allowlist", () => {
  assert.equal(SEMANTIC_SENTENCE_PROFILE_TOKEN, "semantic-v3");
  assert.equal(SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES, 20);
  assert.equal(SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT, 8);
  assert.equal(SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT, 8);
  const profiles = listSemanticEventProfiles();
  assert.equal(profiles.length, 2);
  assert.equal(Object.isFrozen(profiles), true);
  for (const profile of profiles) {
    const resolved = resolveSemanticEventProfile(profile);
    assert.equal(resolved.profileId, SEMANTIC_SENTENCE_PROFILE_ID);
    assert.equal(resolved.draftHash, profile.draftHash);
    assert.equal(resolved.alignmentHash, profile.alignmentHash);
    assert.equal(Object.isFrozen(resolved.manifest), true);
    assert.equal(Object.isFrozen(resolved.timingContext.words), true);
  }
  assert.throws(
    () => resolveSemanticEventProfile({
      profileId: SEMANTIC_SENTENCE_PROFILE_ID,
      draftHash: "0".repeat(64),
      alignmentHash: profiles[0].alignmentHash,
    }),
    { code: "ANIMATION_SEMANTIC_PROFILE_UNSUPPORTED" },
  );
  assert.throws(
    () => resolveSemanticEventProfile({
      ...profiles[0],
      profileId: "dark_curiosity_semantic_sentences_v4",
    }),
    { code: "ANIMATION_SEMANTIC_PROFILE_UNSUPPORTED" },
  );
});

test("both checked profiles compile deterministically into five exact-cue beat scenes", () => {
  for (const id of CASES) {
    const first = build(id);
    const second = build(id);
    assert.deepEqual(second.plan, first.plan, id);
    assert.equal(first.plan.schemaVersion, 3, id);
    assert.equal(first.plan.profileVersion, SEMANTIC_SENTENCE_PROFILE_VERSION, id);
    assert.equal(first.plan.renderer.styleVersion, SEMANTIC_SENTENCE_STYLE_VERSION, id);
    assert.equal(first.plan.scenes.length, 5, id);
    assert.ok(first.plan.scenes.every(
      (scene) => scene.template === SEMANTIC_SENTENCE_TEMPLATE_ID,
    ));
    assert.equal(
      first.plan.content.semantic.semanticEventGraphHash,
      first.plan.content.semanticEventGraph.contentHash,
      id,
    );
    assert.equal(
      first.plan.content.semantic.semanticVisualSentencePlanHash,
      first.plan.content.semanticVisualSentencePlan.contentHash,
      id,
    );

    const sentences = first.plan.content.semanticVisualSentencePlan.sentences;
    const operations = first.plan.scenes.flatMap((scene) => scene.operations);
    assert.equal(first.plan.sharedEntities.length, sentences.length, id);
    assert.equal(operations.length, sentences.length, id);
    assert.deepEqual(
      first.plan.sharedEntities.map((entity) => entity.id),
      sentences.map((sentence) => sentence.id),
      id,
    );
    assert.deepEqual(
      operations.map((operation) => operation.targetId),
      sentences.map((sentence) => sentence.id),
      id,
    );

    const bound = bindAnimationTiming(first.plan, first.timingContext);
    let previousEnd = 0;
    for (const [sceneIndex, scene] of bound.scenes.entries()) {
      assert.equal(scene.startFrame, previousEnd, `${id}.scene.${sceneIndex}`);
      previousEnd = scene.endFrame;
      assert.ok(scene.operations.length <= 8, `${id}.scene.${sceneIndex}`);
      assert.ok(scene.semantic.claimIds.length <= 8, `${id}.scene.${sceneIndex}`);
      const beatSentences = sentences.filter(
        (sentence) => sentence.beatId === scene.semantic.beatId,
      );
      for (const [operationIndex, operation] of scene.operations.entries()) {
        const sentence = beatSentences[operationIndex];
        assert.equal(operation.targetId, sentence.id);
        assert.equal(operation.from.resolvedFrame, sentence.wordSpan.startFrame);
        assert.equal(operation.to.resolvedFrame, sentence.wordSpan.endFrame - 1);
        assert.equal(operation.visualStatement, sentence.wordSpan.text);
      }
      assert.deepEqual(scene.readabilityHolds, [{
        startFrame: beatSentences.at(-1).wordSpan.endFrame,
        endFrame: scene.endFrame,
      }]);
    }
    assert.equal(previousEnd, first.plan.durationFrames, id);
    assert.ok(operations.length <= 20, id);

    const compiled = compileProductionAnimation({
      draft: first.draft,
      timingContext: first.timingContext,
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      projectId: `prj_${id}`,
      projectRevision: 1,
      renderProfile: "preview",
    });
    assert.deepEqual(compiled.plan, first.plan, id);
    assert.equal(compiled.animationIR.schemaVersion, 3, id);
    assert.equal(
      compiled.animationIR.content.semanticVisualSentencePlan.contentHash,
      first.plan.content.semanticVisualSentencePlan.contentHash,
      id,
    );
    assert.match(compiled.animationIR.contentHash, /^[a-f0-9]{64}$/, id);
  }
});

test("checked semantic-v3 registry outputs remain byte-exact and omit generalized parameters and compositions", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  for (const id of CASES) {
    const value = fixture(id);
    const compiled = compileProductionAnimation({
      ...value,
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      projectId: `prj_${id}`,
      projectRevision: 1,
      renderProfile: "preview",
    });
    const expected = SEMANTIC_V3_HASHES[id];
    assert.equal(
      compiled.animationIR.content.semanticEventGraph.contentHash,
      expected.graph,
      id,
    );
    assert.equal(
      compiled.animationIR.content.semanticVisualSentencePlan.contentHash,
      expected.sentences,
      id,
    );
    assert.equal(contentHash(compiled.plan), expected.plan, id);
    assert.equal(compiled.animationIR.contentHash, expected.ir, id);
    const composition = compileAnimationIRToHtml(compiled.animationIR);
    assert.equal(composition.compositionHash, expected.composition, id);
    assert.doesNotMatch(composition.html, /data-bounded-geometry-/, id);
    assert.equal(
      compiled.animationIR.content.semanticVisualSentencePlan
        .sceneCompositionProfileId,
      undefined,
      id,
    );
    assert.equal(
      compiled.animationIR.content.semanticAnimationSceneDslPlan,
      undefined,
      id,
    );
    assert.equal(
      compiled.animationIR.content.semantic
        .semanticAnimationSceneDslPlanHash,
      undefined,
      id,
    );
    assert.ok(
      compiled.animationIR.content.semanticVisualSentencePlan.sentences.every(
        (sentence) => (
          sentence.primitiveParameters === undefined
          && sentence.sceneComposition === undefined
        ),
      ),
      id,
    );
  }
});

test("semantic v3 compilation is explicit and rejects non-registry timing", () => {
  const value = fixture(CASES[0]);
  const input = {
    ...value,
    projectId: "prj_semantic_v3",
    projectRevision: 1,
    renderProfile: "preview",
  };
  assert.throws(
    () => buildSemanticSentenceProductionAnimationPlan(input),
    { code: "ANIMATION_SEMANTIC_PRODUCTION_INVALID" },
  );
  const changed = structuredClone(value.timingContext);
  delete changed.contentHash;
  changed.words[0].endFrame += 1;
  changed.words[1].startFrame += 1;
  assert.throws(
    () => buildSemanticSentenceProductionAnimationPlan({
      ...input,
      semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
      timingContext: changed,
    }),
    { code: "ANIMATION_SEMANTIC_PRODUCTION_INVALID" },
  );
});

test("omitting semantic-v3 preserves the existing v2 plan, IR, and composition byte-for-byte", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  for (const id of CASES) {
    const value = fixture(id);
    const compiled = compileProductionAnimation({
      ...value,
      projectId: "prj_semantic_audit",
      projectRevision: 1,
      renderProfile: "preview",
    });
    assert.equal(compiled.animationIR.schemaVersion, 2, id);
    assert.equal(
      compiled.animationIR.content.semantic.profileId,
      "documented_mystery_semantic_v2",
      id,
    );
    assert.equal(contentHash(compiled.plan), DEFAULT_V2_HASHES[id].plan, id);
    assert.equal(compiled.animationIR.contentHash, DEFAULT_V2_HASHES[id].ir, id);
    assert.equal(
      compileAnimationIRToHtml(compiled.animationIR).compositionHash,
      DEFAULT_V2_HASHES[id].composition,
      id,
    );
  }
});

test("semantic-v3 validators reject contradictory operation metadata and extra entities", () => {
  const value = build(CASES[0]);
  const contradictory = structuredClone(value.plan);
  contradictory.scenes[0].operations[0].easing = "smoothstep";
  contradictory.scenes[0].operations[0].params = { opacity: 0 };
  assert.throws(
    () => compileTimingBoundAnimationIR(contradictory, value.timingContext),
    { code: "ANIMATION_SEMANTIC_INVALID" },
  );

  const extraEntity = structuredClone(value.plan);
  extraEntity.sharedEntities.push({
    id: "unused_semantic_visual",
    type: "semantic_visual",
    role: "mapping",
    layer: 2,
    styleToken: "cause_effect_chain",
    text: "Unused",
  });
  assert.throws(
    () => compileTimingBoundAnimationIR(extraEntity, value.timingContext),
    { code: "ANIMATION_SEMANTIC_INVALID" },
  );
});

test("semantic-v3 contract validates sentence content against the embedded graph, not hashes alone", () => {
  const value = build(CASES[0]);
  const compiled = compileProductionAnimation({
    draft: value.draft,
    timingContext: value.timingContext,
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    projectId: `prj_${CASES[0]}`,
    projectRevision: 1,
    renderProfile: "preview",
  });
  const rebound = structuredClone(compiled.animationIR);
  const plan = rebound.content.semanticVisualSentencePlan;
  plan.sentences[0].claimIds = [
    ...plan.sentences.find(
      (sentence) => sentence.beatId !== plan.sentences[0].beatId,
    ).claimIds,
  ];
  delete plan.contentHash;
  plan.contentHash = semanticVisualSentencePlanContentHash(plan);
  rebound.content.semantic.semanticVisualSentencePlanHash = plan.contentHash;
  delete rebound.contentHash;
  assert.throws(
    () => validateAnimationIR(rebound),
    { code: "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID" },
  );
});

test("fixed semantic-v3 graphs reject freshly rehashed sentence-plan tampering", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const value = build(CASES[0]);
  const compiled = compileProductionAnimation({
    draft: value.draft,
    timingContext: value.timingContext,
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    projectId: `prj_${CASES[0]}`,
    projectRevision: 1,
    renderProfile: "preview",
  });
  const rebound = structuredClone(compiled.animationIR);
  const plan = rebound.content.semanticVisualSentencePlan;
  plan.sentences[0].capability.score += 1;
  delete plan.contentHash;
  plan.contentHash = semanticVisualSentencePlanContentHash(plan);
  rebound.content.semantic.semanticVisualSentencePlanHash = plan.contentHash;
  delete rebound.contentHash;
  assert.throws(
    () => validateAnimationIR(rebound),
    { code: "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID" },
  );
  assert.throws(
    () => compileAnimationIRToHtml(rebound),
    /Unparameterized semantic sentence plan is not an approved checked profile/,
  );
});

test("semantic-v3 QA samples every sentence and does not invent continuity geometry", () => {
  for (const id of CASES) {
    const value = fixture(id);
    const { animationIR } = compileProductionAnimation({
      ...value,
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      projectId: `prj_${id}`,
      projectRevision: 1,
      renderProfile: "preview",
    });
    const sentences = animationIR.content.semanticVisualSentencePlan.sentences;
    const seekSequence = safeSeekSequence(animationIR);
    const expectations = browserQaExpectations(animationIR, seekSequence);
    for (const sentence of sentences) {
      assert.ok(seekSequence.includes(Math.floor(
        (sentence.wordSpan.startFrame + sentence.wordSpan.endFrame - 1) / 2,
      )), `${id}.${sentence.id}`);
    }
    assert.ok(seekSequence.length <= 40, id);
    assert.ok(expectations.cacheWarmupFrames.length <= 20, id);
    assert.deepEqual(expectations.pathFollowerIds, [], id);
    assert.deepEqual(expectations.persistentEntityIds, [], id);
    assert.deepEqual(
      expectations.visualStateIds,
      sentences.map((sentence) => sentence.id),
      id,
    );
    assert.deepEqual(motionQaGeometryRequirements(animationIR), {
      persistentContinuity: false,
      transitionContinuity: false,
      focusExclusivity: false,
      primaryRoi: true,
      mobileLegibility: true,
    }, id);

    const policy = {
      seekSequence,
      cacheWarmupFrames: expectations.cacheWarmupFrames,
      pathFollowerIds: expectations.pathFollowerIds,
      persistentEntityIds: expectations.persistentEntityIds,
      visualStateIds: expectations.visualStateIds,
      focusIntervalIds: expectations.focusIntervalIds,
      transitionIds: expectations.transitionIds,
    };
    assert.equal(browserResultMeetsPolicy({
      seekSequence,
      cacheWarmupFrames: expectations.cacheWarmupFrames,
      captures: seekSequence.map((frame) => ({ frame })),
      repeatedFrames: [{ frame: 0, equal: true }],
      loadedOnce: true,
      pageLoadCount: 1,
      stateIsolation: { valid: true },
      externalRequestCount: 0,
      blockedExternalRequestCount: 0,
      geometryAudit: {
        passed: true,
        checkpointCount: seekSequence.length,
        persistentObservationCount: 0,
        pathFollowerObservationCount: 0,
        labelObservationCount: 1,
        markedLabelIds: ["semantic_sentence_label"],
        observedLabelIds: ["semantic_sentence_label"],
        unobservedLabelIds: [],
        observedPathFollowerIds: [],
        unobservedPathFollowerIds: [],
        persistentStateCoverage: {},
        observedTransitionIds: [],
        observedFocusIntervalIds: [],
        unobservedFocusIntervalIds: [],
        clippedEntities: [],
        captionSafeZoneViolations: [],
        pathFollowerViolations: [],
        persistentContinuityViolations: [],
        focusViolations: [],
        primaryRoiViolations: [],
        legibilityViolations: [],
        contrastViolations: [],
      },
      passed: true,
    }, policy), true, id);
  }
});
