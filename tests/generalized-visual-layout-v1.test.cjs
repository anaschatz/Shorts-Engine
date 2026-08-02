"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CAPTION_LANE,
  VISUAL_ROI,
  compileEngineOwnedLayout,
} = require("../server/pipelines/narrated-short/animation/visual-layout-engine.cjs");
const { resolveVisualRecipeSceneState } = require("../server/pipelines/narrated-short/animation/visual-recipe-plan-compiler.cjs");
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");

function overlaps(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

test("every layout has one dominant centered primary and at most one non-overlapping helper", () => {
  const recipeIds = [...new Set(CASES.flatMap((definition) => definition.sequence.map(([id]) => id)))];
  for (const recipeId of recipeIds) {
    for (const hasHelper of [false, true]) {
      const layout = compileEngineOwnedLayout(recipeId, { hasHelper });
      const primary = layout.primary.bounds;
      assert.ok(primary.x >= VISUAL_ROI.x && primary.y >= VISUAL_ROI.y);
      assert.ok(primary.x + primary.width <= VISUAL_ROI.x + VISUAL_ROI.width);
      assert.ok(primary.y + primary.height <= VISUAL_ROI.y + VISUAL_ROI.height);
      assert.ok(Math.abs(primary.x + primary.width / 2 - 540) <= layout.constraints.centerTolerancePx);
      assert.equal(overlaps(primary, CAPTION_LANE), false);
      if (hasHelper) {
        assert.equal(overlaps(primary, layout.helper.bounds), false);
        assert.equal(overlaps(layout.helper.bounds, CAPTION_LANE), false);
        assert.ok(primary.width * primary.height > layout.helper.bounds.width * layout.helper.bounds.height);
      } else assert.equal(layout.helper, null);
    }
  }
});

test("route geometry is engine-owned, ordered, bounded, and explicitly approximate", () => {
  const layout = compileEngineOwnedLayout("map_route", { hasHelper: true });
  assert.equal(layout.geometry.disclosure, "illustrative_approximate_route");
  assert.deepEqual(layout.geometry.points.map((point) => point.order), [0, 1, 2, 3, 4]);
  for (const point of layout.geometry.points) {
    assert.ok(point.x >= layout.primary.bounds.x && point.x <= layout.primary.bounds.x + layout.primary.bounds.width);
    assert.ok(point.y >= layout.primary.bounds.y && point.y <= layout.primary.bounds.y + layout.primary.bounds.height);
  }
});

test("random seek state resolution is deterministic and holds are motion-free", () => {
  const plan = compileCase(CASES[1]).compiled.visualRecipePlan;
  for (const scene of plan.scenes) {
    const frames = [scene.phases[1].startFrame, scene.phases[2].startFrame, scene.phases[1].startFrame];
    const states = frames.map((frame) => resolveVisualRecipeSceneState(plan, scene.id, frame));
    assert.deepEqual(states[0], states[2]);
    const holdFrame = scene.phases.at(-1).startFrame;
    assert.equal(resolveVisualRecipeSceneState(plan, scene.id, holdFrame).moving, false);
  }
});

test("narration timing changes recipe-plan and adapter hashes without changing engine geometry", () => {
  const normal = compileCase(CASES[0], 1).compiled;
  const slower = compileCase(CASES[0], 1.2).compiled;
  assert.notEqual(normal.visualRecipePlan.contentHash, slower.visualRecipePlan.contentHash);
  assert.notEqual(normal.contentHash, slower.contentHash);
  assert.deepEqual(
    normal.visualRecipePlan.scenes.map((scene) => scene.layout),
    slower.visualRecipePlan.scenes.map((scene) => scene.layout),
  );
  assert.notDeepEqual(
    normal.visualRecipePlan.scenes.map((scene) => scene.phases),
    slower.visualRecipePlan.scenes.map((scene) => scene.phases),
  );
});
