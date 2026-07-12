const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { resolveTimingAnchor } = require("../server/pipelines/narrated-short/animation/timing-resolver.cjs");
const { compileTimingBoundAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");

const FIXTURE_DIR = join(__dirname, "../eval/narrated/dark-curiosity/animation");
function json(name) { return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")); }
function context() { return normalizeAnimationTimingContext(json("002_wow_signal_timing_context.json")); }
function plan() { return json("002_wow_signal_semantic_plan.json"); }

test("timing context is strict, hash-bound and reuses narration word rules", () => {
  const value = context();
  assert.equal(value.contentHash, "888847e723a033c2d3a6c5e376739e8c7de46463143328d5f90f0e2c19cce01b");
  const unknown = json("002_wow_signal_timing_context.json"); unknown.extra = true;
  assert.throws(() => normalizeAnimationTimingContext(unknown), { code: "ANIMATION_TIMING_INVALID" });
  const overlap = json("002_wow_signal_timing_context.json"); delete overlap.contentHash; overlap.words[1].startFrame = 5;
  assert.throws(() => normalizeAnimationTimingContext(overlap));
  const duplicate = json("002_wow_signal_timing_context.json"); delete duplicate.contentHash; duplicate.beats[1].beatId = duplicate.beats[0].beatId;
  assert.throws(() => normalizeAnimationTimingContext(duplicate), { code: "ANIMATION_TIMING_INVALID" });
});

test("semantic resolver uses exclusive end-frame semantics and bounded offsets", () => {
  const value = context();
  const scene = { startFrame: 0, endFrame: 230 };
  assert.equal(resolveTimingAnchor({ anchor: "beat_start", beatId: "beat_signal" }, value, scene), 88);
  assert.equal(resolveTimingAnchor({ anchor: "beat_end", beatId: "beat_signal" }, value, scene), 175);
  assert.equal(resolveTimingAnchor({ anchor: "word_start", wordIndex: 2, offsetFrames: -2 }, value, scene), 26);
  assert.equal(resolveTimingAnchor({ anchor: "word_end", wordIndex: 8 }, value, scene), 124);
  assert.throws(() => resolveTimingAnchor({ anchor: "beat_start", beatId: "beat_missing" }, value, scene), { code: "ANIMATION_TIMING_INVALID" });
  assert.throws(() => resolveTimingAnchor({ anchor: "word_start", wordIndex: 2, offsetFrames: -90 }, value, scene), { code: "ANIMATION_TIMING_INVALID" });
});

test("semantic compilation is deterministic and embeds self-verifiable resolved frames", () => {
  const first = compileTimingBoundAnimationIR(plan(), context());
  const second = compileTimingBoundAnimationIR(plan(), context());
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.timingBinding.timingContextHash, context().contentHash);
  const morph = first.scenes.flatMap((scene) => scene.operations).find((operation) => operation.op === "morph_path");
  assert.deepEqual([morph.from.resolvedFrame, morph.to.resolvedFrame], [190, 229]);
  const payoff = first.scenes.flatMap((scene) => scene.operations).find((operation) => operation.targetId === "payoff_label");
  assert.deepEqual([payoff.from.resolvedFrame, payoff.to.resolvedFrame], [241, 299]);
});

test("alignment changes alter the IR hash and only dependent checkpoints", () => {
  const original = context();
  const changedInput = json("002_wow_signal_timing_context.json"); delete changedInput.contentHash;
  changedInput.words[2].startFrame += 2;
  changedInput.beats[0].startFrame = changedInput.words[0].startFrame;
  changedInput.beats[0].endFrame = changedInput.words[5].endFrame;
  const changed = normalizeAnimationTimingContext(changedInput);
  const before = compileTimingBoundAnimationIR(plan(), original);
  const after = compileTimingBoundAnimationIR(plan(), changed);
  assert.notEqual(before.contentHash, after.contentHash);
  const beforeOps = before.scenes.flatMap((scene) => scene.operations);
  const afterOps = after.scenes.flatMap((scene) => scene.operations);
  assert.equal(beforeOps[2].from.resolvedFrame + 2, afterOps[2].from.resolvedFrame);
  assert.equal(beforeOps[7].from.resolvedFrame, afterOps[7].from.resolvedFrame);
});

test("timing compilation rejects binding mismatches, tampering and semantic concurrency overflow", () => {
  const mismatch = plan(); mismatch.alignmentHash = "e".repeat(64);
  assert.throws(() => compileTimingBoundAnimationIR(mismatch, context()), { code: "ANIMATION_TIMING_BINDING_MISMATCH" });
  const badWord = plan(); badWord.scenes[0].operations[2].from.wordIndex = 999;
  assert.throws(() => compileTimingBoundAnimationIR(badWord, context()), { code: "ANIMATION_TIMING_INVALID" });
  const concurrent = plan(); concurrent.motionBudget.maxConcurrentOperations = 1;
  assert.throws(() => compileTimingBoundAnimationIR(concurrent, context()), { code: "ANIMATION_MOTION_BUDGET_EXCEEDED" });
  const compiled = structuredClone(compileTimingBoundAnimationIR(plan(), context()));
  compiled.scenes[0].operations[0].to.resolvedFrame -= 1;
  const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
  assert.throws(() => validateAnimationIR(compiled), { code: "ANIMATION_IR_INVALID" });
});
