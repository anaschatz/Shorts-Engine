const { AppError } = require("../../../errors.cjs");
const { normalizeAnimationTimingContext, timingBindingFromContext } = require("./timing-contract.cjs");
const { resolveTimingAnchor } = require("./timing-resolver.cjs");

function bindAnimationTiming(input, timingInput = null) {
  const plan = structuredClone(input);
  const timing = timingInput ? normalizeAnimationTimingContext(timingInput) : null;
  if (timing) {
    if (plan.fps !== timing.fps || plan.durationFrames !== timing.durationFrames || plan.alignmentHash !== timing.alignmentHash || plan.draftHash !== timing.draftHash) throw new AppError("ANIMATION_TIMING_BINDING_MISMATCH", "Animation timing does not match the approved plan.", 409);
    plan.timingBinding = timingBindingFromContext(timing);
  } else if (plan.timingBinding === undefined) plan.timingBinding = null;
  for (const scene of plan.scenes || []) {
    for (const operation of scene.operations || []) {
      for (const key of ["from", "to"]) {
        const anchor = operation[key];
        const binding = timing || (plan.timingBinding ? { durationFrames: plan.durationFrames, ...plan.timingBinding } : { durationFrames: plan.durationFrames, words: [], beats: [] });
        const resolvedFrame = resolveTimingAnchor(anchor, binding, scene, `scenes.${scene.id}.${operation.op}.${key}`);
        operation[key] = { ...anchor, resolvedFrame };
      }
      if (operation.to.resolvedFrame <= operation.from.resolvedFrame) throw new AppError("ANIMATION_TIMING_INVALID", "Animation operation timing must have positive duration.", 400, { sceneId: scene.id, op: operation.op });
    }
  }
  return plan;
}

module.exports = { bindAnimationTiming };
