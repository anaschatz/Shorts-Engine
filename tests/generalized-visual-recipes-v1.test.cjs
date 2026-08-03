"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const {
  normalizeVisualRecipePlanV1,
  visualRecipePlanContentHash,
} = require("../server/pipelines/narrated-short/animation/visual-recipe-plan-contract.cjs");
const { listVisualRecipes } = require("../server/pipelines/narrated-short/animation/visual-recipe-registry.cjs");
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");

function expectPlanFailure(action) {
  assert.throws(action, (error) => error?.code === "GENERALIZED_VISUAL_RECIPE_PLAN_INVALID" && error?.status === 400);
}

test("all eight registered recipes compile into engine-owned recipe plans", () => {
  const results = CASES.map(compileCase);
  const scenes = results.flatMap(({ compiled }) => compiled.visualRecipePlan.scenes);
  assert.deepEqual(
    [...new Set(scenes.map((scene) => scene.recipeId))].sort(),
    listVisualRecipes().map((recipe) => recipe.recipeId).sort(),
  );
  for (const scene of scenes) {
    assert.equal(scene.layout.primary.entityRole, "dominant_primary");
    assert.ok(scene.layout.geometry.points.length >= 2);
    assert.ok(scene.layout.geometry.semantics.stages.length >= 3);
    assert.ok(scene.phases.every((phase, index) => index === 0 || phase.startFrame === scene.phases[index - 1].endFrame));
    assert.equal(scene.phases.at(-1).id, "hold");
    assert.equal(scene.phases.at(-1).moving, false);
  }
});

test("three stories produce distinct compositions, geometry, and entity state graphs", () => {
  const plans = CASES.map((definition) => compileCase(definition).compiled.visualRecipePlan);
  assert.equal(new Set(plans.map((plan) => plan.contentHash)).size, 3);
  assert.equal(new Set(plans.map((plan) => plan.scenes.map((scene) => scene.layout.compositionFamily).join("|"))).size, 3);
  assert.equal(new Set(plans.map((plan) => plan.scenes.map((scene) => scene.layout.geometry.kind).join("|"))).size, 3);
  assert.equal(new Set(plans.map((plan) => plan.scenes.map((scene) => `${scene.stateGraph.stateProfile}:${scene.stateGraph.fromState}>${scene.stateGraph.toState}`).join("|"))).size, 3);
});

test("display content is copied only from trusted StoryIR fields and certainty is not promoted", () => {
  for (const definition of CASES) {
    const { context, compiled } = compileCase(definition);
    const beatById = new Map(context.storyIR.beats.map((beat) => [beat.beatId, beat]));
    for (const scene of compiled.visualRecipePlan.scenes) {
      const beats = scene.narrationBeatIds.map((id) => beatById.get(id));
      const source = beats[0].source;
      assert.equal(scene.grounded.heading, source.heading);
      assert.equal(scene.grounded.primaryLabel, source.primaryLabel);
      assert.equal(scene.grounded.secondaryLabel, source.secondaryLabel);
      assert.equal(scene.grounded.onScreenText, source.onScreenText);
      assert.ok(beats.map((beat) => beat.certainty).includes(scene.grounded.certainty));
      assert.notEqual(scene.grounded.primaryLabel, scene.purpose);
    }
  }
});

test("recipe operations replace placeholder-only compilation and obey settled holds", () => {
  const allowed = new Set(["create", "fade", "move", "scale", "draw_path", "morph_path", "highlight", "pulse", "transition_match"]);
  for (const definition of CASES) {
    const { compiled } = compileCase(definition);
    for (const [index, scene] of compiled.animationIR.scenes.entries()) {
      const planScene = compiled.visualRecipePlan.scenes[index];
      assert.ok(scene.operations.some((operation) => operation.op !== "create"));
      for (const operation of scene.operations) {
        assert.ok(allowed.has(operation.op));
        assert.ok(operation.to.resolvedFrame <= planScene.phases.at(-1).startFrame);
      }
    }
    assert.equal(compiled.animationIR.motionBudget.maxConcurrentOperations, 2);
  }
});

test("freshly rehashed layout and grounding tampering are rejected", () => {
  const { context, compiled } = compileCase(CASES[2]);
  const layoutTamper = structuredClone(compiled.visualRecipePlan);
  layoutTamper.scenes[0].layout.primary.bounds.x += 2;
  layoutTamper.contentHash = visualRecipePlanContentHash(layoutTamper);
  expectPlanFailure(() => normalizeVisualRecipePlanV1(layoutTamper, {
    visualProgram: compiled.visualProgram,
    ...context,
  }));

  const groundingTamper = structuredClone(compiled.visualRecipePlan);
  groundingTamper.scenes[0].grounded.primaryLabel = "Invented display claim";
  groundingTamper.contentHash = visualRecipePlanContentHash(groundingTamper);
  expectPlanFailure(() => normalizeVisualRecipePlanV1(groundingTamper, {
    visualProgram: compiled.visualProgram,
    ...context,
  }));

  const mutations = [
    (plan) => { plan.scenes[0].recipeId = "unknown_recipe"; },
    (plan) => { plan.scenes[0].layout.primary.bounds.x = Number.NaN; },
    (plan) => { plan.scenes[0].layout.primary.bounds.x = -1; },
    (plan) => { plan.scenes[1].layout.helper.bounds = { ...plan.scenes[1].layout.primary.bounds }; },
    (plan) => { plan.scenes[1].layout.helpers = [plan.scenes[1].layout.helper, plan.scenes[1].layout.helper]; },
    (plan) => { delete plan.scenes[0].layout.primary; },
    (plan) => { plan.scenes[1].stateGraph.identityId = plan.scenes[0].stateGraph.identityId; },
    (plan) => { plan.scenes[0].phases.at(-1).moving = true; },
    (plan) => { plan.scenes[0].layout.geometry.disclosure = "https://remote.invalid/layout"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(compiled.visualRecipePlan);
    mutate(candidate);
    candidate.contentHash = visualRecipePlanContentHash(candidate);
    expectPlanFailure(() => normalizeVisualRecipePlanV1(candidate, {
      visualProgram: compiled.visualProgram,
      ...context,
    }));
  }
});

test("recipe plan boundary rejects hostile graphs without invoking accessors", () => {
  const { context, compiled } = compileCase(CASES[0]);
  const trusted = { visualProgram: compiled.visualProgram, ...context };
  let calls = 0;
  const getter = {};
  Object.defineProperty(getter, "schemaVersion", { enumerable: true, get() { calls += 1; return 1; } });
  expectPlanFailure(() => normalizeVisualRecipePlanV1(getter, trusted));
  assert.equal(calls, 0);
  const cyclic = {}; cyclic.self = cyclic;
  expectPlanFailure(() => normalizeVisualRecipePlanV1(cyclic, trusted));
  const sparse = []; sparse.length = 2;
  expectPlanFailure(() => normalizeVisualRecipePlanV1(sparse, trusted));
  const withSymbol = structuredClone(compiled.visualRecipePlan);
  withSymbol[Symbol("hidden")] = true;
  expectPlanFailure(() => normalizeVisualRecipePlanV1(withSymbol, trusted));
});

test("production modules contain no tracked-story branches or side effects", () => {
  const root = resolve(__dirname, "../server/pipelines/narrated-short/animation");
  for (const file of ["visual-layout-engine.cjs", "visual-recipe-plan-contract.cjs", "visual-recipe-plan-compiler.cjs"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /(?:001_wow|002_gps|003_baychimo|wow|gps|baychimo)/i);
    assert.doesNotMatch(source, /node:(?:fs|child_process)|https?:\/\//i);
  }
});
