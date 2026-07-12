const { AppError } = require("../../../errors.cjs");

const OPERATION_COST = Object.freeze({ create: 1, fade: 1, move: 3, scale: 2, transform: 4, draw_path: 4, trace_signal: 5, morph_path: 8, pulse: 2, stagger: 3, highlight: 2, camera_push: 6, transition_match: 7 });

function absoluteFrame(anchor) {
  if (anchor.anchor !== "absolute") return null;
  return anchor.frame + (anchor.offsetFrames || 0);
}

function validateComplexityBudget(ir) {
  const events = [];
  let computedCost = 0;
  let maxCameraScale = 1;
  for (const scene of ir.scenes) {
    let sceneCost = 0;
    for (const operation of scene.operations) {
      const cost = OPERATION_COST[operation.op];
      sceneCost += cost;
      computedCost += cost;
      const start = absoluteFrame(operation.from);
      const end = absoluteFrame(operation.to);
      if (start !== null && end !== null) events.push({ start, end });
      if (operation.op === "camera_push") maxCameraScale = Math.max(maxCameraScale, operation.params.scale || 1);
      if (operation.op === "move" && start !== null && end !== null) {
        const distance = Math.hypot(operation.params.x || 0, operation.params.y || 0);
        if (distance / Math.max(1, end - start) > ir.motionBudget.maxTravelPxPerFrame) throw new AppError("ANIMATION_MOTION_BUDGET_EXCEEDED", "Animation movement exceeds its motion budget.", 400);
      }
    }
    if (sceneCost !== scene.complexityCost) throw new AppError("ANIMATION_COMPLEXITY_MISMATCH", "Scene complexity cost does not match its operations.", 400, { sceneId: scene.id });
  }
  let maxConcurrentOperations = 0;
  for (let frame = 0; frame < ir.durationFrames; frame += 1) maxConcurrentOperations = Math.max(maxConcurrentOperations, events.filter((event) => frame >= event.start && frame < event.end).length);
  if (computedCost > ir.motionBudget.maxCost || maxConcurrentOperations > ir.motionBudget.maxConcurrentOperations || maxCameraScale > ir.motionBudget.maxCameraScale) throw new AppError("ANIMATION_MOTION_BUDGET_EXCEEDED", "Animation plan exceeds its declared motion budget.", 400);
  return Object.freeze({ computedCost, maxConcurrentOperations, maxCameraScale: Number(maxCameraScale.toFixed(4)), withinBudget: true });
}

module.exports = { OPERATION_COST, validateComplexityBudget };
