const { AppError } = require("../../../errors.cjs");
const { GENERIC_SEMANTIC_PROFILE_ID } = require("./semantic-visual-planner.cjs");

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
  wow_observation_v1: Object.freeze([
    ["create", "deep_background"], ["draw_path", "observation_record"], ["highlight", "wow_annotation"],
  ]),
  frequency_duration_v1: Object.freeze([
    ["create", "frequency_scale"], ["pulse", "duration_timer"],
  ]),
  telescope_beam_v1: Object.freeze([
    ["draw_path", "beam_graph"], ["trace_signal", "evidence_trace"], ["highlight", "interference_label"],
  ]),
  repeat_search_v1: Object.freeze([
    ["morph_path", "evidence_trace"], ["stagger", "search_timeline"], ["highlight", "no_repeat_label"], ["fade", "transmission_label"],
  ]),
  evidence_payoff_v1: Object.freeze([
    ["transition_match", "evidence_node"], ["fade", "reasoning_bridge"],
    ["fade", "payoff_label"], ["highlight", "final_evidence_label"], ["pulse", "deep_background"],
  ]),
});

const GENERIC_TEMPLATES = new Set([
  "document_record_v2",
  "evidence_card_v2",
  "relationship_graph_v2",
  "map_route_v2",
  "timeline_compare_v2",
  "scale_compare_v2",
  "bounded_verdict_v2",
]);

function validateTemplateOperations(ir) {
  for (const scene of ir.scenes) {
    const generic = ir.content?.semantic?.profileId === GENERIC_SEMANTIC_PROFILE_ID;
    const role = scene.semantic?.role;
    const required = generic && GENERIC_TEMPLATES.has(scene.template) && role
      ? [
        ...(role === "hook" ? [["create", "deep_background"]] : []),
        ["morph_path", "story_evidence"],
        ["draw_path", `${role}_visual`],
        ["highlight", `${role}_label`],
      ]
      : REQUIREMENTS[scene.template];
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

module.exports = { GENERIC_TEMPLATES, REQUIREMENTS, validateTemplateOperations };
