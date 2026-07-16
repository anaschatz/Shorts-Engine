const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");

const SEMANTIC_PROFILE_ID = "wow_signal_case_v1";
const MINIMUM_OPERATION_FRAMES = Object.freeze({
  "draw_path:observation_record": 30,
  "highlight:wow_annotation": 24,
  "create:frequency_scale": 30,
  "pulse:duration_timer": 24,
  "draw_path:beam_graph": 30,
  "morph_path:evidence_trace": 26,
  "trace_signal:evidence_trace": 26,
  "highlight:interference_label": 24,
  "stagger:search_timeline": 30,
  "highlight:no_repeat_label": 24,
  "fade:transmission_label": 24,
  "transition_match:evidence_node": 24,
  "fade:reasoning_bridge": 24,
  "fade:payoff_label": 24,
  "highlight:final_evidence_label": 27,
});
const MINIMUM_SCENE_HOLD_FRAMES = 12;
const MINIMUM_FINAL_HOLD_FRAMES = 24;

function fail(field, details = {}) {
  throw new AppError("ANIMATION_PACING_INVALID", SAFE_MESSAGES.ANIMATION_PACING_INVALID, 409, { field, ...details });
}

function operationKey(operation) {
  return `${operation.op}:${operation.targetId}`;
}

function resolvedDuration(operation) {
  return operation.to.resolvedFrame - operation.from.resolvedFrame;
}

function validateAnimationComprehensionPacing(ir) {
  if (ir?.content?.semantic?.profileId !== SEMANTIC_PROFILE_ID) return Object.freeze({ valid: true, applicable: false });

  const operations = new Map(ir.scenes.flatMap((scene) => scene.operations).map((operation) => [operationKey(operation), operation]));
  for (const [key, minimumFrames] of Object.entries(MINIMUM_OPERATION_FRAMES)) {
    const operation = operations.get(key);
    if (!operation) fail(`operations.${key}.missing`);
    const actualFrames = resolvedDuration(operation);
    if (actualFrames < minimumFrames) fail(`operations.${key}.duration`, { minimumFrames, actualFrames });
  }

  for (const scene of ir.scenes) {
    if (scene.readabilityHolds.length !== 1) fail(`scenes.${scene.id}.readabilityHolds.count`);
    let previousEnd = scene.startFrame;
    for (const [index, hold] of scene.readabilityHolds.entries()) {
      if (hold.startFrame < previousEnd) fail(`scenes.${scene.id}.readabilityHolds.${index}.order`);
      const overlap = scene.operations.find((operation) => operation.from.resolvedFrame < hold.endFrame && operation.to.resolvedFrame >= hold.startFrame);
      if (overlap) fail(`scenes.${scene.id}.readabilityHolds.${index}.overlap`, { operation: operationKey(overlap) });
      if (hold.endFrame !== scene.endFrame) fail(`scenes.${scene.id}.readabilityHolds.${index}.boundary`);
      const minimumFrames = scene === ir.scenes.at(-1) ? MINIMUM_FINAL_HOLD_FRAMES : MINIMUM_SCENE_HOLD_FRAMES;
      const actualFrames = hold.endFrame - hold.startFrame;
      if (actualFrames < minimumFrames) fail(`scenes.${scene.id}.readabilityHolds.${index}.duration`, { minimumFrames, actualFrames });
      previousEnd = hold.endFrame;
    }
  }

  const finalScene = ir.scenes.at(-1);
  const finalHold = finalScene?.readabilityHolds?.at(-1);
  if (!finalHold || finalHold.endFrame !== ir.durationFrames) fail("scenes.final.readabilityHold.missing");
  const finalHoldFrames = finalHold.endFrame - finalHold.startFrame;
  if (finalHoldFrames < MINIMUM_FINAL_HOLD_FRAMES) fail("scenes.final.readabilityHold.duration", { minimumFrames: MINIMUM_FINAL_HOLD_FRAMES, actualFrames: finalHoldFrames });

  return Object.freeze({
    valid: true,
    applicable: true,
    minimumOperationFrames: MINIMUM_OPERATION_FRAMES,
    finalHoldFrames,
  });
}

module.exports = {
  MINIMUM_FINAL_HOLD_FRAMES,
  MINIMUM_OPERATION_FRAMES,
  MINIMUM_SCENE_HOLD_FRAMES,
  validateAnimationComprehensionPacing,
};
