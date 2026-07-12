const { createHash } = require("node:crypto");
const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./contract.cjs");

const MORPH_POINT_COUNT = 128;

function operation(ir, op, targetId) {
  const matches = ir.scenes.flatMap((scene) => scene.operations.map((candidate) => ({ ...candidate, sceneId: scene.id }))).filter((candidate) => candidate.op === op && candidate.targetId === targetId);
  if (matches.length !== 1) throw new AppError("ANIMATION_TIMING_PROOF_INVALID", "Animation timing proof is incomplete.", 500);
  return matches[0];
}

function timingCheckpoints(ir) {
  const wave = operation(ir, "draw_path", "signal_wave");
  const pulse = operation(ir, "pulse", "signal_pulse");
  const beam = operation(ir, "draw_path", "beam_alpha");
  const morph = operation(ir, "morph_path", "signal_wave");
  const payoff = operation(ir, "fade", "payoff_label");
  const payoffScene = ir.scenes.find((scene) => scene.template === "mystery_payoff_v1");
  const hold = payoffScene?.readabilityHolds?.[0];
  if (!hold) throw new AppError("ANIMATION_TIMING_PROOF_INVALID", "Animation readability hold is missing.", 500);
  const midpoint = (item) => Math.floor((item.from.resolvedFrame + item.to.resolvedFrame) / 2);
  return Object.freeze([
    { id: "before_waveform", frame: Math.max(0, wave.from.resolvedFrame - 1) },
    { id: "waveform_midpoint", frame: midpoint(wave) },
    { id: "signal_pulse", frame: midpoint(pulse) },
    { id: "beam_crossing", frame: midpoint(beam) },
    { id: "morph_midpoint", frame: midpoint(morph) },
    { id: "payoff_start", frame: payoff.from.resolvedFrame },
    { id: "readability_hold", frame: Math.floor((hold.startFrame + hold.endFrame - 1) / 2) },
  ]);
}

function buildTimingTrace(ir) {
  if (!ir.timingBinding) throw new AppError("ANIMATION_TIMING_PROOF_INVALID", "Animation timing binding is missing.", 500);
  const operations = ir.scenes.flatMap((scene) => scene.operations.map((item) => ({ sceneId: scene.id, op: item.op, targetId: item.targetId, fromAnchor: item.from.anchor, toAnchor: item.to.anchor, startFrame: item.from.resolvedFrame, endFrame: item.to.resolvedFrame })));
  const wordIndices = [...new Set(ir.scenes.flatMap((scene) => scene.operations.flatMap((item) => [item.from.wordIndex, item.to.wordIndex].filter(Number.isInteger))))].sort((a, b) => a - b);
  const trace = {
    schemaVersion: 1, alignmentHash: ir.alignmentHash, timingContextHash: ir.timingBinding.timingContextHash,
    resolvedOperationCount: operations.length, operations,
    beatFrameRanges: ir.timingBinding.beats.map(({ beatId, startFrame, endFrame }) => ({ beatId, startFrame, endFrame })),
    usedWordIndices: wordIndices, morphPointCount: MORPH_POINT_COUNT,
    templateVersions: Object.fromEntries(ir.scenes.map((scene) => [scene.template, scene.templateVersion])),
    checkpoints: timingCheckpoints(ir),
  };
  return Object.freeze({ ...trace, contentHash: createHash("sha256").update(stableStringify(trace)).digest("hex") });
}

function validateTimingTrace(input, ir) {
  const expected = buildTimingTrace(ir);
  if (!input || stableStringify(input) !== stableStringify(expected)) throw new AppError("ANIMATION_TIMING_PROOF_INVALID", "Animation timing trace does not match its IR.", 409);
  if (input.operations.some((item) => !Number.isInteger(item.startFrame) || !Number.isInteger(item.endFrame) || item.endFrame <= item.startFrame)) throw new AppError("ANIMATION_TIMING_PROOF_INVALID", "Animation timing trace contains unresolved operations.", 409);
  return expected;
}

module.exports = { MORPH_POINT_COUNT, buildTimingTrace, timingCheckpoints, validateTimingTrace };
