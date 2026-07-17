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
  if (plan.visualStateGraph) {
    const binding = timing || (plan.timingBinding ? { durationFrames: plan.durationFrames, ...plan.timingBinding } : { durationFrames: plan.durationFrames, words: [], beats: [] });
    const composition = { id: "visual_state_graph", startFrame: 0, endFrame: plan.durationFrames };
    const bindAnchor = (anchor, field) => ({ ...anchor, resolvedFrame: resolveTimingAnchor(anchor, binding, composition, field) });
    for (const [index, state] of (plan.visualStateGraph.states || []).entries()) {
      state.enterAnchor = bindAnchor(state.enterAnchor, `visualStateGraph.states[${index}].enterAnchor`);
      state.settleAnchor = bindAnchor(state.settleAnchor, `visualStateGraph.states[${index}].settleAnchor`);
      state.exitAnchor = bindAnchor(state.exitAnchor, `visualStateGraph.states[${index}].exitAnchor`);
    }
    for (const [index, transition] of (plan.visualStateGraph.stateTransitions || []).entries()) {
      transition.fromAnchor = bindAnchor(transition.fromAnchor, `visualStateGraph.stateTransitions[${index}].fromAnchor`);
      transition.toAnchor = bindAnchor(transition.toAnchor, `visualStateGraph.stateTransitions[${index}].toAnchor`);
      if (transition.toAnchor.resolvedFrame <= transition.fromAnchor.resolvedFrame) throw new AppError("ANIMATION_TIMING_INVALID", "Animation state transition timing must have positive duration.", 400, { transitionId: transition.id });
    }
  }
  return plan;
}

function validateAnimationTimingBinding(animationIR, timingInput) {
  const timing = normalizeAnimationTimingContext(timingInput);
  if (!animationIR || animationIR.fps !== timing.fps || animationIR.durationFrames !== timing.durationFrames || animationIR.alignmentHash !== timing.alignmentHash || animationIR.draftHash !== timing.draftHash || animationIR.timingBinding?.timingContextHash !== timing.contentHash) {
    throw new AppError("ANIMATION_TIMING_BINDING_MISMATCH", "Animation timing does not match the approved plan.", 409);
  }
  return Object.freeze({ valid: true, timingContextHash: timing.contentHash });
}

module.exports = { bindAnimationTiming, validateAnimationTimingBinding };
