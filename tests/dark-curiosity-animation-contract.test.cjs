const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { compileAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const { createAnimationProviderRegistry } = require("../server/pipelines/narrated-short/animation/provider-registry.cjs");

function fixture() {
  return JSON.parse(readFileSync(join(__dirname, "../eval/narrated/dark-curiosity/animation/001_wow_signal_benchmark.json"), "utf8"));
}

test("AnimationIR compilation is deterministic and hash-bound", () => {
  const first = compileAnimationIR(fixture());
  const second = compileAnimationIR(fixture());
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(validateAnimationIR(first).contentHash, first.contentHash);
});

test("AnimationIR rejects unknown fields, executable content and bad references", () => {
  const unknown = fixture(); unknown.shell = "no";
  assert.throws(() => compileAnimationIR(unknown), { code: "ANIMATION_IR_INVALID" });
  const executable = fixture(); executable.sharedEntities[0].text = "<script>alert(1)</script>";
  assert.throws(() => compileAnimationIR(executable), { code: "ANIMATION_IR_INVALID" });
  const missing = fixture(); missing.scenes[0].operations[0].targetId = "unknown_entity";
  assert.throws(() => compileAnimationIR(missing), { code: "ANIMATION_IR_INVALID" });
});

test("AnimationIR rejects invalid frames and excessive complexity", () => {
  const frame = fixture(); frame.scenes[0].operations[0].to.frame = 301;
  assert.throws(() => compileAnimationIR(frame), { code: "ANIMATION_TIMING_INVALID" });
  const cost = fixture(); cost.motionBudget.maxCost = 2;
  assert.throws(() => compileAnimationIR(cost), { code: "ANIMATION_MOTION_BUDGET_EXCEEDED" });
});

test("provider registry enforces its contract and resolves by id", () => {
  const provider = { id: "test_provider", doctor() {}, validate() {}, estimate() {}, render() {}, verify() {} };
  const registry = createAnimationProviderRegistry([provider]);
  assert.equal(registry.get("test_provider"), provider);
  assert.deepEqual(registry.list(), ["test_provider"]);
  assert.throws(() => registry.get("missing"), { code: "ANIMATION_PROVIDER_UNAVAILABLE" });
  assert.throws(() => createAnimationProviderRegistry([{ id: "bad" }]), { code: "ANIMATION_PROVIDER_INVALID" });
});
