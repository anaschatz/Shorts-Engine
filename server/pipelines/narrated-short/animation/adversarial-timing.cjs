const { readdirSync } = require("node:fs");
const { compileTimingBoundAnimationIR } = require("./compiler.cjs");
const { validateAnimationIR } = require("./contract.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const { validateAnimationTimingBinding } = require("./timing-compiler.cjs");

const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{2,79}$/;

function withoutHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return copy;
}

function casesFor(planInput, contextInput) {
  const plan = () => withoutHash(planInput);
  const context = () => withoutHash(contextInput);
  return [
    { id: "unknown_beat", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[0].to.beatId = "beat_missing"; compileTimingBoundAnimationIR(value, context()); } },
    { id: "word_index_out_of_bounds", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[2].from.wordIndex = 999; compileTimingBoundAnimationIR(value, context()); } },
    { id: "negative_resolved_frame", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[0].from.offsetFrames = -1; compileTimingBoundAnimationIR(value, context()); } },
    { id: "end_before_start", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[2].to = structuredClone(value.scenes[0].operations[2].from); compileTimingBoundAnimationIR(value, context()); } },
    { id: "operation_outside_scene", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[0].to = { anchor: "absolute", frame: 240 }; compileTimingBoundAnimationIR(value, context()); } },
    { id: "anchor_outside_composition", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[1].operations[2].to = { anchor: "absolute", frame: 300 }; compileTimingBoundAnimationIR(value, context()); } },
    { id: "duplicate_operation_target", expectedCode: "ANIMATION_TEMPLATE_OPERATION_INVALID", run() { const value = plan(); value.scenes[0].operations.push(structuredClone(value.scenes[0].operations[0])); value.scenes[0].complexityCost += 1; value.motionBudget.maxCost += 1; compileTimingBoundAnimationIR(value, context()); } },
    { id: "alignment_hash_mismatch", expectedCode: "ANIMATION_TIMING_BINDING_MISMATCH", run() { const value = plan(); value.alignmentHash = "e".repeat(64); compileTimingBoundAnimationIR(value, context()); } },
    { id: "timing_context_hash_mismatch", expectedCode: "ANIMATION_TIMING_BINDING_MISMATCH", run() { const timing = normalizeAnimationTimingContext(context()); const compiled = structuredClone(compileTimingBoundAnimationIR(plan(), timing)); compiled.timingBinding.timingContextHash = "f".repeat(64); validateAnimationTimingBinding(compiled, timing); } },
    { id: "fps_mismatch", expectedCode: "ANIMATION_TIMING_BINDING_MISMATCH", run() { const value = plan(); value.fps = 31; compileTimingBoundAnimationIR(value, context()); } },
    { id: "duration_mismatch", expectedCode: "ANIMATION_TIMING_BINDING_MISMATCH", run() { const value = plan(); value.durationFrames = 301; compileTimingBoundAnimationIR(value, context()); } },
    { id: "offset_overflow", expectedCode: "ANIMATION_TIMING_INVALID", run() { const value = plan(); value.scenes[0].operations[2].from.offsetFrames = 91; compileTimingBoundAnimationIR(value, context()); } },
    { id: "resolved_frame_disagrees", expectedCode: "ANIMATION_IR_INVALID", run() { const compiled = structuredClone(compileTimingBoundAnimationIR(plan(), context())); delete compiled.contentHash; compiled.scenes[0].operations[2].from.resolvedFrame += 1; validateAnimationIR(compiled); } },
  ];
}

function mp4Count(directory) {
  if (!directory) return 0;
  try { return readdirSync(directory, { recursive: true }).filter((entry) => String(entry).toLowerCase().endsWith(".mp4")).length; } catch { return 0; }
}

function runAdversarialTimingValidation({ plan, timingContext, artifactDirectory = null }) {
  const before = mp4Count(artifactDirectory);
  const results = casesFor(plan, timingContext).map((testCase) => {
    let actualCode = "NO_ERROR";
    try { testCase.run(); } catch (error) { actualCode = SAFE_CODE_RE.test(error?.code || "") ? error.code : "UNSAFE_ERROR"; }
    return Object.freeze({ id: testCase.id, expectedCode: testCase.expectedCode, actualCode, passed: actualCode === testCase.expectedCode, renderAttempted: false });
  });
  const after = mp4Count(artifactDirectory);
  return Object.freeze({
    caseCount: results.length,
    passedCount: results.filter((result) => result.passed).length,
    cases: results,
    renderAttemptCount: 0,
    partialArtifactCount: Math.max(0, after - before),
    passed: results.every((result) => result.passed) && before === after,
  });
}

module.exports = { runAdversarialTimingValidation };
