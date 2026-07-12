const test = require("node:test");
const assert = require("node:assert/strict");
const { compileAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const { createAnimationProviderRegistry } = require("../server/pipelines/narrated-short/animation/provider-registry.cjs");

function fixture() {
  const hash = "a".repeat(64);
  return { schemaVersion: 1, profile: "dark_curiosity_continuous", profileVersion: "1.0.0", projectId: "project_wow", projectRevision: 1, verticalId: "dark_curiosity", width: 720, height: 1280, fps: 30, durationFrames: 300, draftHash: hash, alignmentHash: hash, assetManifestHash: hash, renderer: { provider: "hyperframes_benchmark", runtimeVersion: "0.7.55", styleVersion: "1.0.0" }, seed: 1977,
    sharedEntities: [{ id: "signal_wave", type: "waveform", role: "primary_signal", layer: 4, styleToken: "signal_cyan" }],
    scenes: [{ id: "scene_signal", startFrame: 0, endFrame: 300, template: "signal_lab_v1", templateVersion: "1.0.0", entityIds: ["signal_wave"], operations: [{ op: "draw_path", targetId: "signal_wave", from: { anchor: "absolute", frame: 0 }, to: { anchor: "absolute", frame: 299 }, easing: "ease_in_out_cubic", params: { direction: "left_to_right" } }], readabilityHolds: [], complexityCost: 4 }], transitions: [], motionBudget: { profile: "dark_curiosity", maxCost: 20, maxConcurrentOperations: 3, maxCameraScale: 1.2, maxTravelPxPerFrame: 12, captionSafeZone: { topRatio: 0.74, bottomRatio: 1 } } };
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
