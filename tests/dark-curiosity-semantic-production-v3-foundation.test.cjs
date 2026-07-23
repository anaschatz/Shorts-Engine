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
  buildSemanticSentencePlanningContext,
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
  motionSegments,
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
const {
  SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
  buildSemanticSimpleExplainerGroups,
} = require("../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs");

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
    graph: "46fcf46c25e80e6bc52f5832c2566c2b4b3d93859ccfe01768145859fd37643a",
    sentences: "093b212932a3d301c6679aece10e4d639e745d704a01f9b65e9b8ac514433136",
    plan: "e30ade205a247eb4bcf770b06a34f552c506ef76482ef20e94c39d071cf6f51d",
    ir: "cdcf53aae36b84b78c41b5c52cbce695114f3e1292b595f675ccc313e69c8418",
    composition: "b3c66e8044063c77a2be29fd322b0e9e5eb1c9a564a75a1a7ba085f593e11fc3",
  }),
  "003_baychimo_icebound_drift": Object.freeze({
    graph: "1ac7f3493a7deda0a906792d3355ba177448a846096a82d264b25348d7fb94c7",
    sentences: "5afa08b21434dea5ff2f1b677306a05c3c00733e0608d8375e729c3a5a5f99d1",
    plan: "8f84d391925fbc2d7e9e45c165f6dc2f0c0b7613fe54d8ba648f547b70966e0a",
    ir: "dd9fe91e68aa2f55f5103568b1df442cf7b2c9d432eb6fc15f1a2321e0fb30ac",
    composition: "cc2a0366ae378cb325e0352c1b9fbce4324375cbb4047d435c5319827ce10349",
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
    const checkedProfile = resolveSemanticEventProfile({
      profileId: SEMANTIC_SENTENCE_PROFILE_ID,
      draftHash: first.draft.contentHash,
      alignmentHash: first.timingContext.alignmentHash,
    });
    const planningContext = buildSemanticSentencePlanningContext({
      draft: first.draft,
      timingContext: first.timingContext,
      semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
    });
    assert.equal(planningContext.profile.id, "generalized_story_visual_intent_v1");
    assert.equal(planningContext.profile.sourceProfileId, checkedProfile.id);
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

test("checked semantic-v3 sources remain byte-exact on the generalized simple presenter", async () => {
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
    const composition = compileAnimationIRToHtml(compiled.animationIR, {
      semanticSourceContext: value,
    });
    assert.equal(composition.compositionHash, expected.composition, id);
    assert.equal(
      composition.profile.presentationProfileId,
      SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
      id,
    );
    assert.ok(composition.actionQa, id);
    const sentencePlan = compiled.animationIR.content.semanticVisualSentencePlan;
    const simpleGroups = buildSemanticSimpleExplainerGroups(
      sentencePlan.sentences,
      { fps: compiled.animationIR.fps },
    );
    assert.deepEqual(
      composition.qaPolicy.semanticRouteIds,
      simpleGroups
        .filter((group) => group.visualKind === "route")
        .map((group) => sentencePlan.sentences[group.anchorSentenceIndex].id)
        .sort(),
      `${id}: QA may require only visibly rendered route groups`,
    );
    assert.equal(
      compiled.animationIR.content.semanticVisualSentencePlan
        .sceneCompositionProfileId,
      "dark_curiosity_scene_composition_v2",
      id,
    );
    assert.ok(compiled.animationIR.content.semanticAnimationSceneDslPlan, id);
    assert.match(
      compiled.animationIR.content.semantic
        .semanticAnimationSceneDslPlanHash,
      /^[a-f0-9]{64}$/,
      id,
    );
    assert.ok(
      compiled.animationIR.content.semanticVisualSentencePlan.sentences.every(
        (sentence) => (
          sentence.primitiveParameters !== undefined
          && sentence.sceneComposition !== undefined
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
  const validationOptions = {
    semanticSourceContext: {
      draft: value.draft,
      timingContext: value.timingContext,
    },
  };
  const contradictory = structuredClone(value.plan);
  contradictory.scenes[0].operations[0].easing = "smoothstep";
  contradictory.scenes[0].operations[0].params = { opacity: 0 };
  assert.throws(
    () => compileTimingBoundAnimationIR(
      contradictory,
      value.timingContext,
      validationOptions,
    ),
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
    () => compileTimingBoundAnimationIR(
      extraEntity,
      value.timingContext,
      validationOptions,
    ),
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
    () => validateAnimationIR(rebound, {
      semanticSourceContext: {
        draft: value.draft,
        timingContext: value.timingContext,
      },
    }),
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
    () => validateAnimationIR(rebound, {
      semanticSourceContext: {
        draft: value.draft,
        timingContext: value.timingContext,
      },
    }),
    { code: "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID" },
  );
  assert.throws(
    () => compileAnimationIRToHtml(rebound, {
      semanticSourceContext: {
        draft: value.draft,
        timingContext: value.timingContext,
      },
    }),
    /Semantic primitive parameters are not bound to the embedded graph/,
  );
});

test("semantic-v3 QA samples every sentence and does not invent continuity geometry", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
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
    const groups = buildSemanticSimpleExplainerGroups(sentences, {
      fps: animationIR.fps,
    });
    assert.deepEqual(
      motionSegments(animationIR),
      groups.map((group, index) => ({
        id: group.id,
        startFrame: sentences[group.firstSentenceIndex].wordSpan.startFrame,
        endFrame: index + 1 < groups.length
          ? sentences[groups[index + 1].firstSentenceIndex]
            .wordSpan.startFrame
          : animationIR.durationFrames,
      })),
      id,
    );
    assert.ok(groups.length < sentences.length, id);
    const composition = compileAnimationIRToHtml(animationIR, {
      semanticSourceContext: {
        draft: value.draft,
        timingContext: value.timingContext,
      },
    });
    const seekSequence = safeSeekSequence(animationIR, composition.actionQa);
    const expectations = browserQaExpectations(
      animationIR,
      seekSequence,
      composition.actionQa,
      composition.qaPolicy,
    );
    for (const sentence of sentences) {
      assert.ok(seekSequence.some((frame) => (
        frame >= sentence.wordSpan.startFrame
        && frame < sentence.wordSpan.endFrame
      )), `${id}.${sentence.id}`);
    }
    assert.ok(seekSequence.length <= 55, id);
    assert.ok(expectations.cacheWarmupFrames.length <= 20, id);
    assert.deepEqual(expectations.pathFollowerIds, [], id);
    assert.deepEqual(expectations.persistentEntityIds, [], id);
    assert.deepEqual(
      expectations.visualStateIds,
      sentences.map((sentence) => sentence.id),
      id,
    );
    assert.deepEqual(
      expectations.boundedGeometrySentenceIndices,
      [],
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
      boundedGeometrySentenceIndices:
        expectations.boundedGeometrySentenceIndices,
    };
    const validBrowserResult = {
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
        boundedGeometryObservationCount:
          expectations.boundedGeometrySentenceIndices.length,
        labelObservationCount: 1,
        markedLabelIds: ["semantic_sentence_label"],
        observedLabelIds: ["semantic_sentence_label"],
        unobservedLabelIds: [],
        observedPathFollowerIds: [],
        unobservedPathFollowerIds: [],
        observedBoundedGeometrySentenceIndices:
          expectations.boundedGeometrySentenceIndices,
        unobservedBoundedGeometrySentenceIndices: [],
        persistentStateCoverage: {},
        observedTransitionIds: [],
        observedFocusIntervalIds: [],
        unobservedFocusIntervalIds: [],
        clippedEntities: [],
        captionSafeZoneViolations: [],
        pathFollowerViolations: [],
        semanticRouteViolations: [],
        boundedGeometryClippingViolations: [],
        boundedGeometryCaptionSafeZoneViolations: [],
        persistentContinuityViolations: [],
        focusViolations: [],
        primaryRoiViolations: [],
        legibilityViolations: [],
        contrastViolations: [],
      },
      passed: true,
    };
    assert.equal(
      browserResultMeetsPolicy(validBrowserResult, policy),
      true,
      id,
    );
  }
});
