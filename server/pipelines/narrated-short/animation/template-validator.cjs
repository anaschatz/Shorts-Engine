const { AppError } = require("../../../errors.cjs");

const REQUIREMENTS = Object.freeze({
  signal_lab_v1: Object.freeze([
    ["create", "deep_background"], ["create", "signal_grid"], ["draw_path", "signal_wave"],
    ["pulse", "signal_pulse"], ["draw_path", "beam_alpha"], ["draw_path", "beam_beta"],
    ["camera_push", "camera_stage"], ["morph_path", "signal_wave"],
  ]),
  mystery_payoff_v1: Object.freeze([
    ["transition_match", "evidence_node"], ["scale", "evidence_node"],
    ["fade", "payoff_label"], ["pulse", "deep_background"],
  ]),
});

function validateTemplateOperations(ir) {
  for (const scene of ir.scenes) {
    const required = REQUIREMENTS[scene.template];
    if (!required) throw new AppError("ANIMATION_TEMPLATE_INVALID", "Animation template is unsupported.", 400);
    for (const [op, targetId] of required) {
      const matches = scene.operations.filter((operation) => operation.op === op && operation.targetId === targetId);
      if (matches.length !== 1) throw new AppError("ANIMATION_TEMPLATE_OPERATION_INVALID", "Animation template operations are incomplete or ambiguous.", 400, { template: scene.template, op, targetId });
    }
    const seen = new Set();
    for (const operation of scene.operations) {
      const key = `${operation.op}:${operation.targetId}`;
      if (seen.has(key)) throw new AppError("ANIMATION_TEMPLATE_OPERATION_INVALID", "Animation template contains duplicate operations.", 400, { template: scene.template, op: operation.op, targetId: operation.targetId });
      seen.add(key);
    }
  }
  return ir;
}

module.exports = { REQUIREMENTS, validateTemplateOperations };
