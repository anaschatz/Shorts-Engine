const LEGACY_REQUIRED_KEYS = Object.freeze([
  "create:deep_background", "create:signal_grid", "draw_path:signal_wave", "pulse:signal_pulse",
  "draw_path:beam_alpha", "draw_path:beam_beta", "camera_push:camera_stage", "morph_path:signal_wave",
  "transition_match:evidence_node", "scale:evidence_node", "fade:payoff_label", "pulse:deep_background",
]);
const SEMANTIC_REQUIRED_KEYS = Object.freeze([
  "create:deep_background", "draw_path:observation_record", "highlight:wow_annotation",
  "create:frequency_scale", "pulse:duration_timer", "draw_path:beam_graph", "trace_signal:evidence_trace", "highlight:interference_label",
  "morph_path:evidence_trace", "stagger:search_timeline", "highlight:no_repeat_label", "fade:transmission_label",
  "transition_match:evidence_node", "fade:reasoning_bridge", "fade:payoff_label", "highlight:final_evidence_label", "pulse:deep_background",
]);

export function operationKey(operation) { return `${operation.op}:${operation.targetId}`; }

export function createOperationSchedule(ir) {
  const schedule = {};
  for (const scene of ir.scenes || []) for (const operation of scene.operations || []) {
    const key = operationKey(operation);
    if (schedule[key]) throw new TypeError("Animation schedule contains a duplicate operation.");
    if (!Number.isInteger(operation.from?.resolvedFrame) || !Number.isInteger(operation.to?.resolvedFrame) || operation.to.resolvedFrame <= operation.from.resolvedFrame) throw new TypeError("Animation schedule contains unresolved timing.");
    schedule[key] = { startFrame: operation.from.resolvedFrame, endFrame: operation.to.resolvedFrame, easing: operation.easing, params: operation.params, fromAnchor: operation.from.anchor, toAnchor: operation.to.anchor };
  }
  const required = ir.profileVersion === "1.1.0" && ir.content?.semantic?.profileId === "wow_signal_case_v1" ? SEMANTIC_REQUIRED_KEYS : LEGACY_REQUIRED_KEYS;
  for (const key of required) if (!schedule[key]) throw new TypeError("Animation schedule is missing a required operation.");
  return Object.freeze(schedule);
}

export function easedProgress(frame, operation) {
  if (!operation || !Number.isFinite(frame)) throw new TypeError("Animation schedule progress is invalid.");
  const raw = Math.max(0, Math.min(1, (frame - operation.startFrame) / Math.max(1, operation.endFrame - operation.startFrame)));
  if (operation.easing === "linear") return raw;
  if (operation.easing === "smoothstep") return raw * raw * (3 - 2 * raw);
  if (operation.easing === "ease_in_cubic") return raw ** 3;
  if (operation.easing === "ease_out_cubic") return 1 - (1 - raw) ** 3;
  if (operation.easing === "ease_in_out_cubic") return raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
  throw new TypeError("Animation schedule easing is unsupported.");
}

export function pulseProgress(frame, operation) {
  const progress = easedProgress(frame, operation);
  return progress <= 0.38 ? progress / 0.38 : Math.max(0, 1 - (progress - 0.38) / 0.62);
}

export { LEGACY_REQUIRED_KEYS, SEMANTIC_REQUIRED_KEYS };
