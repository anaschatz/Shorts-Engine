import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createPathMorph, interpolatePoints, pointsToPath } from "../renderer/hyperframes/primitives/path-morph.mjs";
import { createOperationSchedule, easedProgress } from "../renderer/hyperframes/operation-scheduler.mjs";
import { compileAnimationIRToHtml } from "../renderer/hyperframes/animation-ir-adapter.mjs";

const require = createRequire(import.meta.url);
const { compileTimingBoundAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const fixtureDir = join(import.meta.dirname, "../eval/narrated/dark-curiosity/animation");
const json = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const compile = () => compileTimingBoundAnimationIR(json("002_wow_signal_semantic_plan.json"), normalizeAnimationTimingContext(json("002_wow_signal_timing_context.json")));

test("path morph has exact endpoints and genuine intermediate geometry", () => {
  const morph = createPathMorph(128);
  assert.equal(morph.pathAt(0), pointsToPath(morph.source));
  assert.equal(morph.pathAt(1), pointsToPath(morph.target));
  assert.notEqual(morph.pathAt(0.5), morph.pathAt(0));
  assert.notEqual(morph.pathAt(0.5), morph.pathAt(1));
  assert.equal(morph.source.length, 128);
  assert.equal(morph.target.length, 128);
});

test("path morph is deterministic under backward seeking", () => {
  const morph = createPathMorph();
  const first = morph.pathAt(0.273);
  morph.pathAt(0.91);
  const repeated = morph.pathAt(0.273);
  assert.equal(first, repeated);
});

test("path morph rejects mismatches and non-finite values", () => {
  assert.throws(() => interpolatePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }], 0.5), TypeError);
  assert.throws(() => interpolatePoints([{ x: 0, y: 0 }, { x: NaN, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.5), TypeError);
  assert.throws(() => interpolatePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }], Infinity), TypeError);
});

test("operation schedule consumes resolved IR timing and easing", () => {
  const ir = compile();
  const schedule = createOperationSchedule(ir);
  assert.deepEqual([schedule["morph_path:signal_wave"].startFrame, schedule["morph_path:signal_wave"].endFrame], [190, 229]);
  assert.equal(easedProgress(190, schedule["morph_path:signal_wave"]), 0);
  assert.equal(easedProgress(229, schedule["morph_path:signal_wave"]), 1);
  assert.ok(easedProgress(210, schedule["morph_path:signal_wave"]) > 0 && easedProgress(210, schedule["morph_path:signal_wave"]) < 1);
});

test("engine HTML embeds the IR schedule and no hardcoded frame choreography", () => {
  const result = compileAnimationIRToHtml(compile());
  assert.match(result.html, /"startFrame":190,"endFrame":229/);
  assert.match(result.html, /DATA\.schedule/);
  assert.doesNotMatch(result.html, /between\(frame|frame,184|frame,228|frame,112/);
});

test("template validation fails closed on missing and duplicate required operations", () => {
  const missing = json("002_wow_signal_semantic_plan.json");
  missing.scenes[0].operations = missing.scenes[0].operations.filter((operation) => !(operation.op === "morph_path" && operation.targetId === "signal_wave"));
  missing.scenes[0].complexityCost -= 8;
  assert.throws(() => compileTimingBoundAnimationIR(missing, normalizeAnimationTimingContext(json("002_wow_signal_timing_context.json"))), { code: "ANIMATION_TEMPLATE_OPERATION_INVALID" });
  const duplicate = json("002_wow_signal_semantic_plan.json");
  duplicate.scenes[0].operations.push(structuredClone(duplicate.scenes[0].operations[7]));
  duplicate.scenes[0].complexityCost += 8;
  assert.throws(() => compileTimingBoundAnimationIR(duplicate, normalizeAnimationTimingContext(json("002_wow_signal_timing_context.json"))));
});
