const { createHash } = require("node:crypto");
const { AppError } = require("../../../errors.cjs");
const { MINIMUM_SETTLE_FRAMES, validateFocusDirector } = require("./focus-director.cjs");

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const VISUAL_STATE_ORDER = Object.freeze(["observation_record", "frequency_context", "beam_response", "failed_repeat_search", "bounded_candidate"]);
const GEOMETRY_TOKENS = Object.freeze(["observation_spike_v1", "frequency_cursor_v1", "beam_response_v1", "timeline_spike_v1", "candidate_boundary_v1"]);
const GRAPH_ID = "wow_signal_visual_state_v1";
const PERSISTENT_ENTITY_ID = "signal_evidence";
const POINT_COUNT = 128;

function fail(field, details = {}) {
  throw new AppError("ANIMATION_VISUAL_STATE_INVALID", "Animation visual state graph is invalid.", 409, { field, ...details });
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) if (!supported.has(key)) fail(`${field}.${key}`);
}

function text(value, field, maximum = 180) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(field);
  return value;
}

function id(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(field);
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH_RE.test(value)) fail(field);
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function graphContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function timingExpected(anchor, timingBinding, durationFrames, field) {
  exactKeys(anchor, ["anchor", "frame", "beatId", "wordIndex", "offsetFrames", "resolvedFrame"], field);
  const type = text(anchor.anchor, `${field}.anchor`, 20);
  if (!["absolute", "beat_start", "beat_end", "word_start", "word_end"].includes(type)) fail(`${field}.anchor`);
  const offset = anchor.offsetFrames === undefined ? 0 : anchor.offsetFrames;
  if (!Number.isInteger(offset) || offset < -90 || offset > 90) fail(`${field}.offsetFrames`);
  let expected;
  if (type === "absolute") {
    if (!Number.isInteger(anchor.frame) || anchor.frame < 0 || anchor.frame >= durationFrames || anchor.beatId !== undefined || anchor.wordIndex !== undefined) fail(field);
    expected = anchor.frame + offset;
  } else if (type.startsWith("beat_")) {
    id(anchor.beatId, `${field}.beatId`);
    if (anchor.frame !== undefined || anchor.wordIndex !== undefined) fail(field);
    const beat = timingBinding.beats.find((candidate) => candidate.beatId === anchor.beatId);
    if (!beat) fail(`${field}.beatId`);
    expected = (type === "beat_start" ? beat.startFrame : beat.endFrame - 1) + offset;
  } else {
    if (!Number.isInteger(anchor.wordIndex) || anchor.wordIndex < 0 || anchor.wordIndex >= timingBinding.words.length || anchor.frame !== undefined || anchor.beatId !== undefined) fail(field);
    const word = timingBinding.words[anchor.wordIndex];
    expected = (type === "word_start" ? word.startFrame : word.endFrame - 1) + offset;
  }
  if (!Number.isInteger(anchor.resolvedFrame) || anchor.resolvedFrame !== expected || expected < 0 || expected >= durationFrames) fail(`${field}.resolvedFrame`);
  return expected;
}

function ids(value, field, { minimum = 0, maximum = 12 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(field);
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = id(entry, `${field}[${index}]`);
    if (seen.has(normalized)) fail(field);
    seen.add(normalized);
    return normalized;
  });
}

function validateFocusPolicy(value, field) {
  exactKeys(value, ["mode", "supportingOpacity", "dimmedOpacity", "preserveContext", "captionPolicy"], field);
  if (value.mode !== "single_primary" || value.preserveContext !== true || value.captionPolicy !== "avoid") fail(field);
  if (!Number.isFinite(value.supportingOpacity) || value.supportingOpacity < 0.35 || value.supportingOpacity > 0.75) fail(`${field}.supportingOpacity`);
  if (!Number.isFinite(value.dimmedOpacity) || value.dimmedOpacity < 0.05 || value.dimmedOpacity > 0.3 || value.dimmedOpacity >= value.supportingOpacity) fail(`${field}.dimmedOpacity`);
}

function validateVisualStateGraph(input, context = {}) {
  const graph = structuredClone(input);
  exactKeys(graph, ["schemaVersion", "graphId", "bindings", "entryStateId", "terminalStateId", "states", "persistentEntities", "stateTransitions", "continuityBindings", "focusIntervals", "semanticMotionConcurrency", "contentHash"], "visualStateGraph");
  if (graph.schemaVersion !== 1 || graph.graphId !== GRAPH_ID || graph.entryStateId !== VISUAL_STATE_ORDER[0] || graph.terminalStateId !== VISUAL_STATE_ORDER.at(-1)) fail("visualStateGraph.profile");
  exactKeys(graph.bindings, ["draftHash", "alignmentHash", "timingContextHash"], "visualStateGraph.bindings");
  hash(graph.bindings.draftHash, "visualStateGraph.bindings.draftHash");
  hash(graph.bindings.alignmentHash, "visualStateGraph.bindings.alignmentHash");
  hash(graph.bindings.timingContextHash, "visualStateGraph.bindings.timingContextHash");
  if (graph.bindings.draftHash !== context.draftHash || graph.bindings.alignmentHash !== context.alignmentHash || graph.bindings.timingContextHash !== context.timingBinding?.timingContextHash) fail("visualStateGraph.bindings");
  const entityIds = new Set(context.entityIds || []);
  const sceneByBeat = new Map((context.scenes || []).map((scene) => [scene.semantic?.beatId, scene]));

  if (!Array.isArray(graph.states) || graph.states.length !== VISUAL_STATE_ORDER.length) fail("visualStateGraph.states");
  const stateIds = new Set();
  const states = graph.states.map((state, index) => {
    const field = `visualStateGraph.states[${index}]`;
    exactKeys(state, ["id", "beatId", "claimIds", "primaryEntityId", "supportingEntityIds", "enterAnchor", "settleAnchor", "exitAnchor", "carriedEntityIds", "focusPolicy", "semanticStatement"], field);
    if (state.id !== VISUAL_STATE_ORDER[index] || stateIds.has(state.id)) fail(`${field}.id`);
    stateIds.add(state.id);
    id(state.beatId, `${field}.beatId`);
    const scene = sceneByBeat.get(state.beatId);
    if (!scene || scene.semantic?.role !== ["hook", "context", "evidence", "turn", "payoff"][index]) fail(`${field}.beatId`);
    const claimIds = ids(state.claimIds, `${field}.claimIds`, { minimum: 1, maximum: 8 });
    if (JSON.stringify(claimIds) !== JSON.stringify(scene.semantic.claimIds)) fail(`${field}.claimIds`);
    if (state.primaryEntityId !== PERSISTENT_ENTITY_ID || !entityIds.has(state.primaryEntityId)) fail(`${field}.primaryEntityId`);
    const supportingEntityIds = ids(state.supportingEntityIds, `${field}.supportingEntityIds`, { minimum: 1, maximum: 8 });
    if (supportingEntityIds.some((entityId) => !entityIds.has(entityId) || entityId === state.primaryEntityId)) fail(`${field}.supportingEntityIds`);
    const carried = ids(state.carriedEntityIds, `${field}.carriedEntityIds`, { minimum: 1, maximum: 2 });
    if (carried.length !== 1 || carried[0] !== PERSISTENT_ENTITY_ID) fail(`${field}.carriedEntityIds`);
    validateFocusPolicy(state.focusPolicy, `${field}.focusPolicy`);
    text(state.semanticStatement, `${field}.semanticStatement`);
    const enterFrame = timingExpected(state.enterAnchor, context.timingBinding, context.durationFrames, `${field}.enterAnchor`);
    const settleFrame = timingExpected(state.settleAnchor, context.timingBinding, context.durationFrames, `${field}.settleAnchor`);
    const exitFrame = timingExpected(state.exitAnchor, context.timingBinding, context.durationFrames, `${field}.exitAnchor`);
    if (enterFrame !== scene.startFrame || exitFrame !== scene.endFrame - 1 || settleFrame <= enterFrame || settleFrame > exitFrame || exitFrame - settleFrame + 1 < MINIMUM_SETTLE_FRAMES) fail(`${field}.anchors`);
    return state;
  });

  if (!Array.isArray(graph.persistentEntities) || graph.persistentEntities.length !== 1) fail("visualStateGraph.persistentEntities");
  const persistent = graph.persistentEntities[0];
  exactKeys(persistent, ["id", "kind", "browserEntityId", "representations"], "visualStateGraph.persistentEntities[0]");
  if (persistent.id !== PERSISTENT_ENTITY_ID || persistent.browserEntityId !== PERSISTENT_ENTITY_ID || persistent.kind !== "matched_path" || !entityIds.has(PERSISTENT_ENTITY_ID)) fail("visualStateGraph.persistentEntities[0]");
  if (!Array.isArray(persistent.representations) || persistent.representations.length !== VISUAL_STATE_ORDER.length) fail("visualStateGraph.persistentEntities[0].representations");
  const representationIds = new Set();
  persistent.representations.forEach((representation, index) => {
    const field = `visualStateGraph.persistentEntities[0].representations[${index}]`;
    exactKeys(representation, ["id", "stateId", "geometryToken", "styleToken", "pointCount"], field);
    id(representation.id, `${field}.id`);
    if (representationIds.has(representation.id) || representation.stateId !== VISUAL_STATE_ORDER[index] || representation.geometryToken !== GEOMETRY_TOKENS[index] || representation.styleToken !== "signal_cyan" || representation.pointCount !== POINT_COUNT) fail(field);
    representationIds.add(representation.id);
  });

  if (!Array.isArray(graph.stateTransitions) || graph.stateTransitions.length !== VISUAL_STATE_ORDER.length - 1) fail("visualStateGraph.stateTransitions");
  const transitionIds = new Set();
  graph.stateTransitions.forEach((transition, index) => {
    const field = `visualStateGraph.stateTransitions[${index}]`;
    exactKeys(transition, ["id", "fromStateId", "toStateId", "continuityBindingId", "fromAnchor", "toAnchor", "easing"], field);
    id(transition.id, `${field}.id`);
    if (transitionIds.has(transition.id) || transition.fromStateId !== VISUAL_STATE_ORDER[index] || transition.toStateId !== VISUAL_STATE_ORDER[index + 1] || transition.easing !== "ease_in_out_cubic") fail(field);
    transitionIds.add(transition.id);
    id(transition.continuityBindingId, `${field}.continuityBindingId`);
    const fromFrame = timingExpected(transition.fromAnchor, context.timingBinding, context.durationFrames, `${field}.fromAnchor`);
    const toFrame = timingExpected(transition.toAnchor, context.timingBinding, context.durationFrames, `${field}.toAnchor`);
    if (fromFrame !== states[index + 1].enterAnchor.resolvedFrame || toFrame !== states[index + 1].settleAnchor.resolvedFrame || toFrame - fromFrame < MINIMUM_SETTLE_FRAMES) fail(`${field}.anchors`);
  });

  if (!Array.isArray(graph.continuityBindings) || graph.continuityBindings.length !== graph.stateTransitions.length) fail("visualStateGraph.continuityBindings");
  const continuityIds = new Set();
  graph.continuityBindings.forEach((binding, index) => {
    const field = `visualStateGraph.continuityBindings[${index}]`;
    exactKeys(binding, ["id", "persistentEntityId", "fromRepresentationId", "toRepresentationId", "interpolation", "preserveIdentity"], field);
    id(binding.id, `${field}.id`);
    if (continuityIds.has(binding.id) || binding.id !== graph.stateTransitions[index].continuityBindingId || binding.persistentEntityId !== PERSISTENT_ENTITY_ID || binding.interpolation !== "matched_control_points" || binding.preserveIdentity !== true) fail(field);
    continuityIds.add(binding.id);
    const fromRepresentation = persistent.representations[index];
    const toRepresentation = persistent.representations[index + 1];
    if (binding.fromRepresentationId !== fromRepresentation.id || binding.toRepresentationId !== toRepresentation.id || fromRepresentation.pointCount !== toRepresentation.pointCount) fail(field);
  });

  const focus = validateFocusDirector(graph, { durationFrames: context.durationFrames, entityIds, states, scenes: context.scenes });
  graph.focusIntervals = focus.intervals;
  const expectedHash = graphContentHash(graph);
  if (graph.contentHash !== undefined && graph.contentHash !== expectedHash) fail("visualStateGraph.contentHash");
  graph.contentHash = expectedHash;
  return Object.freeze(graph);
}

module.exports = {
  GEOMETRY_TOKENS,
  GRAPH_ID,
  PERSISTENT_ENTITY_ID,
  POINT_COUNT,
  VISUAL_STATE_ORDER,
  graphContentHash,
  validateVisualStateGraph,
};
