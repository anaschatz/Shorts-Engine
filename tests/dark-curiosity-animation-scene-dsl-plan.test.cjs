"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildGeneralizedSemanticArtifacts,
} = require("../server/pipelines/narrated-short/animation/generalized-semantic-event-planner.cjs");
const {
  normalizeSemanticEventGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-event-validator.cjs");
const {
  buildSemanticVisualSentencePlan,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
const {
  buildDeterministicSemanticAnimationSceneDslPlan,
  buildSemanticAnimationSceneDslPlanFromScenes,
  normalizeSemanticAnimationSceneDslPlan,
  semanticAnimationSceneDslPlanContentHash,
  validateSemanticAnimationSceneDslPlanAgainstContext,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl-plan.cjs");
const {
  planSemanticAnimationScenes,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-plan-service.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");

const ROOT = resolve(__dirname, "..");

function timingFor(draft) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text: wordText,
        startFrame: frame,
        endFrame: frame + 6,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`scene-dsl-plan:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function fixture(id = "001_wow_signal_mystery") {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${id}.json`,
  ), "utf8")));
  const timingContext = timingFor(draft);
  const semantic = buildGeneralizedSemanticArtifacts({
    draft,
    timingContext,
  });
  return {
    graph: semantic.semanticEventGraph,
    sentencePlan: buildSemanticVisualSentencePlan(
      semantic.semanticEventGraph,
    ),
  };
}

function context(value) {
  return {
    semanticEventGraph: value.graph,
    semanticVisualSentencePlan: value.sentencePlan,
  };
}

function assertDeepFrozen(value, field = "sceneDslPlan", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${field} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

function fakePlannerFrom(plan, options = {}) {
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  return {
    id: options.id || "test_scene_planner",
    mode: options.mode || "mock",
    calls,
    get maximumActive() {
      return maximumActive;
    },
    health() {
      return {
        promptProfileId:
          "dark_curiosity_local_scene_planner_prompt_v1",
      };
    },
    async planScene(input) {
      calls.push(input.propositionId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await Promise.resolve();
        options.onCall?.(input, calls.length);
        const source = plan.scenes.find(
          (scene) => scene.propositionId === input.propositionId,
        );
        return {
          providerId: options.providerId || "test_scene_provider",
          modelId: options.modelId || "test-scene-model-v1",
          promptProfileId:
            "dark_curiosity_local_scene_planner_prompt_v1",
          fallbackUsed: false,
          failure: null,
          sceneDsl: options.sceneDsl?.(source, calls.length)
            || source.sceneDsl,
          ignoredRawProviderField: "<not-persisted>",
        };
      } finally {
        active -= 1;
      }
    },
  };
}

test("deterministic aggregate is canonical, bound and deeply frozen", () => {
  const value = fixture();
  const first = buildDeterministicSemanticAnimationSceneDslPlan(
    context(value),
  );
  const second = buildDeterministicSemanticAnimationSceneDslPlan({
    semanticEventGraph: structuredClone(value.graph),
    semanticVisualSentencePlan:
      structuredClone(value.sentencePlan),
  });

  assert.deepEqual(first, second);
  assert.equal(
    first.contentHash,
    semanticAnimationSceneDslPlanContentHash(first),
  );
  assert.deepEqual(
    first.scenes.map((scene) => scene.propositionId),
    value.sentencePlan.sentences.map(
      (sentence) => sentence.propositionId,
    ),
  );
  assert.equal(first.summary.sceneCount, first.scenes.length);
  assert.equal(first.summary.fallbackSceneCount, 0);
  assert.equal(
    first.summary.totalComputedCost,
    first.scenes.reduce(
      (sum, scene) => sum + scene.sceneDsl.computedCost,
      0,
    ),
  );
  assert.deepEqual(
    validateSemanticAnimationSceneDslPlanAgainstContext(
      first,
      context(value),
    ),
    first,
  );
  assertDeepFrozen(first);
});

test("route choreography remains grounded through the aggregate", () => {
  const value = fixture("003_baychimo_icebound_drift");
  const plan = buildDeterministicSemanticAnimationSceneDslPlan(
    context(value),
  );

  assert.equal(
    plan.scenes.some((scene) => scene.sceneDsl.actions.some(
      (action) => action.op === "move",
    )),
    true,
  );
  assert.equal(plan.summary.maximumSceneCost, 12);
  assert.doesNotThrow(() => (
    validateSemanticAnimationSceneDslPlanAgainstContext(
      plan,
      context(value),
    )
  ));
});

test("strict schema binds provenance and rejects unknown or forged fields", () => {
  const value = fixture();
  const original = buildDeterministicSemanticAnimationSceneDslPlan(
    context(value),
  );
  const unknown = structuredClone(original);
  unknown.rawProviderOutput = "must never be persisted";
  assert.throws(
    () => normalizeSemanticAnimationSceneDslPlan(unknown),
    { code: "ANIMATION_SCENE_DSL_PLAN_INVALID" },
  );

  const provenance = structuredClone(original);
  provenance.scenes[0].provenance.modelId = "forged-model";
  assert.throws(
    () => normalizeSemanticAnimationSceneDslPlan(provenance),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "content_hash_mismatch"
    ),
  );

  const invalidPair = structuredClone(original);
  delete invalidPair.contentHash;
  invalidPair.scenes[0].provenance.fallbackUsed = true;
  assert.throws(
    () => normalizeSemanticAnimationSceneDslPlan(invalidPair),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "fallback_failure_pair_required"
    ),
  );
});

test("mixed provider and fallback provenance is canonical and hash-bound", () => {
  const value = fixture();
  const original = buildDeterministicSemanticAnimationSceneDslPlan(
    context(value),
  );
  const scenes = structuredClone(original.scenes);
  scenes[0].provenance = {
    providerId: "deterministic_fallback",
    modelId: "local-scene-model",
    promptProfileId: original.planner.promptProfileId,
    fallbackUsed: true,
    failure: {
      code: "ANIMATION_LOCAL_LLM_TIMEOUT",
      phase: "local_scene_planner",
      retryable: true,
    },
  };
  scenes[1].provenance = {
    providerId: "local_openai_compatible",
    modelId: "local-scene-model",
    promptProfileId: original.planner.promptProfileId,
    fallbackUsed: false,
    failure: null,
  };
  const mixed = buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: original.bindings,
    planner: {
      plannerId: "local_llm_scene_planner",
      mode: "openai_compatible",
      promptProfileId: original.planner.promptProfileId,
    },
    scenes,
  });

  assert.equal(mixed.summary.fallbackSceneCount, 1);
  assert.deepEqual(mixed.summary.providerIds, [
    "deterministic_fallback",
    "deterministic_scene_planner",
    "local_openai_compatible",
  ]);
  assert.equal(
    mixed.contentHash,
    semanticAnimationSceneDslPlanContentHash(mixed),
  );
  assert.doesNotThrow(() => (
    validateSemanticAnimationSceneDslPlanAgainstContext(
      mixed,
      context(value),
    )
  ));
});

test("context validation requires complete narration-order coverage", () => {
  const value = fixture();
  const original = buildDeterministicSemanticAnimationSceneDslPlan(
    context(value),
  );
  const missing = buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: original.bindings,
    planner: original.planner,
    scenes: original.scenes.slice(1),
  });
  assert.throws(
    () => validateSemanticAnimationSceneDslPlanAgainstContext(
      missing,
      context(value),
    ),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "narration_order_coverage_mismatch"
    ),
  );

  const reordered = buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: original.bindings,
    planner: original.planner,
    scenes: [...original.scenes].reverse(),
  });
  assert.throws(
    () => validateSemanticAnimationSceneDslPlanAgainstContext(
      reordered,
      context(value),
    ),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "narration_order_coverage_mismatch"
    ),
  );

  const other = fixture("002_gps_week_rollover");
  assert.throws(
    () => validateSemanticAnimationSceneDslPlanAgainstContext(
      original,
      context(other),
    ),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "semantic_context_binding_mismatch"
    ),
  );
});

test("scene DSL plans require generalized composed sentence inputs", () => {
  const value = fixture();
  const rawGraph = structuredClone(value.graph);
  delete rawGraph.contentHash;
  delete rawGraph.primitivePayloadProfileId;
  for (const proposition of rawGraph.propositions) {
    delete proposition.primitivePayload;
  }
  const graph = normalizeSemanticEventGraph(rawGraph);
  const sentencePlan = buildSemanticVisualSentencePlan(graph);

  assert.throws(
    () => buildDeterministicSemanticAnimationSceneDslPlan({
      semanticEventGraph: graph,
      semanticVisualSentencePlan: sentencePlan,
    }),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_PLAN_INVALID"
      && cause?.details?.reason === "composed_sentence_plan_required"
    ),
  );
});

test("async service calls one scene at a time in narration order", async () => {
  const value = fixture();
  const deterministic =
    buildDeterministicSemanticAnimationSceneDslPlan(context(value));
  const planner = fakePlannerFrom(deterministic);
  const result = await planSemanticAnimationScenes({
    ...context(value),
    planner,
  });

  assert.deepEqual(
    planner.calls,
    value.sentencePlan.sentences.map(
      (sentence) => sentence.propositionId,
    ),
  );
  assert.equal(planner.maximumActive, 1);
  assert.deepEqual(result.summary.providerIds, [
    "test_scene_provider",
  ]);
  assert.equal(
    Object.hasOwn(
      result.scenes[0].provenance,
      "ignoredRawProviderField",
    ),
    false,
  );
  assertDeepFrozen(result);
});

test("async service cancellation stops before another scene or artifact", async () => {
  const value = fixture();
  const deterministic =
    buildDeterministicSemanticAnimationSceneDslPlan(context(value));
  const controller = new AbortController();
  const planner = fakePlannerFrom(deterministic, {
    onCall(_input, callCount) {
      if (callCount === 1) controller.abort();
    },
  });

  await assert.rejects(
    () => planSemanticAnimationScenes({
      ...context(value),
      planner,
      signal: controller.signal,
    }),
    { code: "JOB_CANCELLED" },
  );
  assert.equal(planner.calls.length, 1);
});

test("async service fails closed on a context-mismatched provider scene", async () => {
  const value = fixture();
  const deterministic =
    buildDeterministicSemanticAnimationSceneDslPlan(context(value));
  const planner = fakePlannerFrom(deterministic, {
    sceneDsl(source, callCount) {
      if (callCount !== 1) return source.sceneDsl;
      const forged = structuredClone(source.sceneDsl);
      forged.bindings.primitiveParametersHash = "a".repeat(64);
      return forged;
    },
  });

  await assert.rejects(
    () => planSemanticAnimationScenes({
      ...context(value),
      planner,
    }),
    { code: "ANIMATION_SCENE_DSL_INVALID" },
  );
  assert.equal(planner.calls.length, 1);
});
