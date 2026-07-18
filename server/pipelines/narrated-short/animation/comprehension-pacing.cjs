const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { MINIMUM_SETTLE_FRAMES, focusMotionBinding } = require("./focus-director.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
} = require("./semantic-render-profile.cjs");
const { GENERIC_SEMANTIC_PROFILE_ID } = require("./semantic-visual-planner.cjs");

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
const MINIMUM_SEMANTIC_SENTENCE_MOTION_FRAMES = 12;

function fail(field, details = {}) {
  throw new AppError("ANIMATION_PACING_INVALID", SAFE_MESSAGES.ANIMATION_PACING_INVALID, 409, { field, ...details });
}

function operationKey(operation) {
  return `${operation.op}:${operation.targetId}`;
}

function resolvedDuration(operation) {
  return operation.to.resolvedFrame - operation.from.resolvedFrame;
}

function validateSemanticSentenceComprehensionPacing(ir) {
  const sentences = ir.content.semanticVisualSentencePlan.sentences;
  const operationByTargetId = new Map(
    ir.scenes.flatMap((scene) => scene.operations)
      .map((operation) => [operation.targetId, operation]),
  );
  let minimumVisibleFrames = Number.POSITIVE_INFINITY;
  let minimumSettledFrames = Number.POSITIVE_INFINITY;

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const operation = operationByTargetId.get(sentence.id);
    if (!operation) fail(`sentences.${sentence.id}.operation.missing`);
    const actualFrames = resolvedDuration(operation);
    if (actualFrames < MINIMUM_SEMANTIC_SENTENCE_MOTION_FRAMES) {
      fail(`sentences.${sentence.id}.operation.duration`, {
        minimumFrames: MINIMUM_SEMANTIC_SENTENCE_MOTION_FRAMES,
        actualFrames,
      });
    }
    const nextStartFrame = index + 1 < sentences.length
      ? sentences[index + 1].wordSpan.startFrame
      : ir.durationFrames;
    const visibleFrames = nextStartFrame - sentence.wordSpan.startFrame;
    const settledFrames = nextStartFrame - sentence.wordSpan.endFrame;
    if (visibleFrames <= 0 || settledFrames < 0) {
      fail(`sentences.${sentence.id}.visibleInterval`, {
        visibleFrames,
        settledFrames,
      });
    }
    minimumVisibleFrames = Math.min(minimumVisibleFrames, visibleFrames);
    minimumSettledFrames = Math.min(minimumSettledFrames, settledFrames);
  }

  for (const scene of ir.scenes) {
    if (scene.readabilityHolds.length !== 1) {
      fail(`scenes.${scene.id}.readabilityHolds.count`);
    }
    const hold = scene.readabilityHolds[0];
    const overlap = scene.operations.find(
      (operation) => operation.from.resolvedFrame < hold.endFrame
        && operation.to.resolvedFrame >= hold.startFrame,
    );
    if (overlap) {
      fail(`scenes.${scene.id}.readabilityHolds.overlap`, {
        operation: operationKey(overlap),
      });
    }
    if (hold.endFrame !== scene.endFrame) {
      fail(`scenes.${scene.id}.readabilityHolds.boundary`);
    }
    const minimumFrames = scene === ir.scenes.at(-1)
      ? MINIMUM_FINAL_HOLD_FRAMES
      : MINIMUM_SCENE_HOLD_FRAMES;
    const actualFrames = hold.endFrame - hold.startFrame;
    if (actualFrames < minimumFrames) {
      fail(`scenes.${scene.id}.readabilityHolds.duration`, {
        minimumFrames,
        actualFrames,
      });
    }
  }

  return Object.freeze({
    valid: true,
    applicable: true,
    profileId: SEMANTIC_SENTENCE_PROFILE_ID,
    minimumOperationFrames: MINIMUM_SEMANTIC_SENTENCE_MOTION_FRAMES,
    minimumVisibleFrames,
    minimumSettledFrames,
    finalHoldFrames: ir.durationFrames
      - ir.scenes.at(-1).readabilityHolds[0].startFrame,
  });
}

function validateGenericComprehensionPacing(ir) {
  for (const scene of ir.scenes) {
    for (const operation of scene.operations) {
      const minimumFrames = operation.op === "create" ? 18 : 24;
      const actualFrames = resolvedDuration(operation);
      if (actualFrames < minimumFrames) fail(`scenes.${scene.id}.operations.${operationKey(operation)}.duration`, { minimumFrames, actualFrames });
    }
    if (scene.readabilityHolds.length !== 1) fail(`scenes.${scene.id}.readabilityHolds.count`);
    const hold = scene.readabilityHolds[0];
    const overlap = scene.operations.find((operation) => operation.from.resolvedFrame < hold.endFrame && operation.to.resolvedFrame >= hold.startFrame);
    if (overlap) fail(`scenes.${scene.id}.readabilityHolds.overlap`, { operation: operationKey(overlap) });
    if (hold.endFrame !== scene.endFrame) fail(`scenes.${scene.id}.readabilityHolds.boundary`);
    const minimumFrames = scene === ir.scenes.at(-1) ? MINIMUM_FINAL_HOLD_FRAMES : MINIMUM_SCENE_HOLD_FRAMES;
    const actualFrames = hold.endFrame - hold.startFrame;
    if (actualFrames < minimumFrames) fail(`scenes.${scene.id}.readabilityHolds.duration`, { minimumFrames, actualFrames });
  }
  const finalHold = ir.scenes.at(-1).readabilityHolds[0];
  return Object.freeze({
    valid: true,
    applicable: true,
    profileId: GENERIC_SEMANTIC_PROFILE_ID,
    minimumOperationFrames: 24,
    finalHoldFrames: finalHold.endFrame - finalHold.startFrame,
  });
}

function validateAnimationComprehensionPacing(ir) {
  const profileId = ir?.content?.semantic?.profileId;
  if (profileId === SEMANTIC_SENTENCE_PROFILE_ID) {
    return validateSemanticSentenceComprehensionPacing(ir);
  }
  if (profileId === GENERIC_SEMANTIC_PROFILE_ID) return validateGenericComprehensionPacing(ir);
  if (profileId !== SEMANTIC_PROFILE_ID) return Object.freeze({ valid: true, applicable: false });

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

  if (ir.renderer?.styleVersion === "1.9.0") {
    if (!ir.visualStateGraph) fail("visualStateGraph.missing");
    for (const [index, transition] of ir.visualStateGraph.stateTransitions.entries()) {
      const actualFrames = transition.toAnchor.resolvedFrame - transition.fromAnchor.resolvedFrame;
      if (actualFrames < MINIMUM_SETTLE_FRAMES) fail(`visualStateGraph.stateTransitions.${index}.duration`, { minimumFrames: MINIMUM_SETTLE_FRAMES, actualFrames });
    }
    for (const [index, interval] of ir.visualStateGraph.focusIntervals.entries()) {
      const actualFrames = interval.endFrame - interval.settleFrame;
      if (actualFrames < MINIMUM_SETTLE_FRAMES) fail(`visualStateGraph.focusIntervals.${index}.settle`, { minimumFrames: MINIMUM_SETTLE_FRAMES, actualFrames });
      const motion = focusMotionBinding(interval, {
        scenes: ir.scenes,
        stateTransitions: ir.visualStateGraph.stateTransitions,
        ambientEntityIds: ir.visualStateGraph.semanticMotionConcurrency?.ambientEntityIds,
      });
      if (motion.actualMotionEnd === null) fail(`visualStateGraph.focusIntervals.${index}.motionBinding`, { reason: "motion_missing" });
      if (interval.settleFrame !== motion.actualMotionEnd) fail(`visualStateGraph.focusIntervals.${index}.settle`, {
        reason: "motion_end_mismatch",
        expectedMotionEnd: motion.actualMotionEnd,
        actualSettleFrame: interval.settleFrame,
        operationKeys: motion.operationKeys,
        transitionIds: motion.transitionIds,
      });
    }
  }

  return Object.freeze({
    valid: true,
    applicable: true,
    minimumOperationFrames: MINIMUM_OPERATION_FRAMES,
    minimumSemanticSettleFrames: MINIMUM_SETTLE_FRAMES,
    finalHoldFrames,
  });
}

module.exports = {
  MINIMUM_FINAL_HOLD_FRAMES,
  MINIMUM_OPERATION_FRAMES,
  MINIMUM_SCENE_HOLD_FRAMES,
  MINIMUM_SEMANTIC_SENTENCE_MOTION_FRAMES,
  validateAnimationComprehensionPacing,
  validateSemanticSentenceComprehensionPacing,
};
