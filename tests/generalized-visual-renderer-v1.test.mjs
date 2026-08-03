import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileAnimationIRToHtml,
  compileGeneralizedVisualProgramAdapterToHtml,
} from "../renderer/hyperframes/animation-ir-adapter.mjs";
import {
  createGeneralizedVisualRuntimeData,
  listSupportedGeneralizedVisualOperations,
  resolveGeneralizedVisualFrameState,
} from "../renderer/hyperframes/generalized-visual-runtime-v1.mjs";
import { listGeneralizedVisualPrimitives } from "../renderer/hyperframes/generalized-visual-primitives-v1.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");

test("all eight generalized recipes render as distinct primitive trees", () => {
  const outputs = CASES.map((definition) => {
    const entry = compileCase(definition);
    return compileGeneralizedVisualProgramAdapterToHtml(entry.compiled, entry.context);
  });
  assert.equal(new Set(outputs.map((entry) => entry.compositionHash)).size, 3);
  const recipeMarkup = new Map();
  for (const output of outputs) {
    assert.match(output.html, /Content-Security-Policy/);
    assert.match(output.html, /font-src data:/);
    assert.doesNotMatch(output.html, /https?:\/\//);
    assert.equal(output.qaPolicy.maximumSimultaneousMotion, 2);
    for (const recipeId of output.qaPolicy.recipeIds) {
      assert.match(output.html, new RegExp(`data-recipe-tree="${recipeId}"`));
      const match = output.html.match(new RegExp(`<g data-recipe-tree="${recipeId}">([\\s\\S]*?)<\\/g><g data-primitive="grounded_label"`));
      assert.ok(match, `missing recipe tree for ${recipeId}`);
      recipeMarkup.set(recipeId, match[1]);
    }
  }
  assert.equal(recipeMarkup.size, 8);
  assert.equal(new Set([...recipeMarkup.values()]).size, 8);
});

test("the renderer exposes the complete bounded primitive and operation allowlists", () => {
  assert.deepEqual(listGeneralizedVisualPrimitives(), [
    "panel_frame", "document", "inspection_lens", "counter_cells",
    "directional_connector", "comparison_baseline", "bounded_marker",
    "uncertainty_region", "route_path", "route_marker",
    "expected_object_outline", "chronology_axis", "chronology_event_marker",
    "grounded_label", "certainty_badge", "focus_ring",
  ]);
  assert.deepEqual(listSupportedGeneralizedVisualOperations(), [
    "create", "fade", "move", "scale", "draw_path", "morph_path",
    "highlight", "pulse", "transition_match",
  ]);
});

test("random frame resolution is deterministic, bounded, and settles every hold", () => {
  const { compiled } = compileCase(CASES[1]);
  const runtime = createGeneralizedVisualRuntimeData(compiled);
  for (const scene of runtime.scenes) {
    const first = scene.phases[1].startFrame;
    const middle = scene.phases[2].startFrame;
    assert.deepEqual(
      resolveGeneralizedVisualFrameState(runtime, first),
      resolveGeneralizedVisualFrameState(runtime, first),
    );
    assert.notEqual(
      resolveGeneralizedVisualFrameState(runtime, first).stateHash,
      resolveGeneralizedVisualFrameState(runtime, middle).stateHash,
    );
    const hold = resolveGeneralizedVisualFrameState(runtime, scene.phases.at(-1).startFrame);
    assert.equal(hold.phaseId, "hold");
    assert.equal(hold.activeMotionCount, 0);
  }
  assert.equal(resolveGeneralizedVisualFrameState(runtime, -999).frame, 0);
  assert.equal(resolveGeneralizedVisualFrameState(runtime, 999999).frame, runtime.durationFrames - 1);
});

test("unsupported operations and invalid generalized tuples fail closed", () => {
  const { context, compiled } = compileCase(CASES[0]);
  const invalidTuple = structuredClone(compiled);
  invalidTuple.visualRecipePlan.profileVersion = "2.0.0";
  assert.throws(
    () => compileGeneralizedVisualProgramAdapterToHtml(invalidTuple, context),
    /tuple is invalid/,
  );
  const invalidOperation = structuredClone(compiled);
  invalidOperation.animationIR.scenes[0].operations[0].op = "execute_remote_script";
  assert.throws(
    () => createGeneralizedVisualRuntimeData(invalidOperation),
    /operation is unsupported/,
  );
});

test("story text is escaped and fitted without becoming renderer-authored copy", () => {
  const { context, compiled } = compileCase(CASES[2]);
  const output = compileGeneralizedVisualProgramAdapterToHtml(compiled, context);
  assert.match(output.html, /data-text-fit="[123]"/);
  assert.doesNotMatch(output.html, /001_wow|002_gps|003_baychimo/i);
  assert.doesNotMatch(output.html, /Date\.now|Math\.random|setTimeout|setInterval/);
});

test("the explicit generalized dispatch does not replace the existing production dispatch", () => {
  const source = readFileSync(resolve("renderer/hyperframes/animation-ir-adapter.mjs"), "utf8");
  const existingDispatch = source.slice(source.indexOf("export function compileAnimationIRToHtml"), source.indexOf("export function compileGeneralizedVisualProgramAdapterToHtml"));
  assert.doesNotMatch(existingDispatch, /generalized_visual_recipe_renderer_v1/);
  assert.equal(typeof compileAnimationIRToHtml, "function");
});
