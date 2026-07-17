const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { validateVisualStateGraph } = require("./visual-state-graph.cjs");

const ANIMATION_IR_SCHEMA_VERSION = 1;
const ANIMATION_PROFILE = "dark_curiosity_continuous";
const ALLOWED_OPERATIONS = Object.freeze([
  "create", "fade", "move", "scale", "transform", "draw_path", "trace_signal",
  "morph_path", "pulse", "stagger", "highlight", "camera_push", "transition_match",
]);
const ALLOWED_EASINGS = Object.freeze(["linear", "ease_in_out_cubic", "ease_out_cubic", "ease_in_cubic", "smoothstep"]);
const ALLOWED_ANCHORS = Object.freeze(["absolute", "beat_start", "beat_end", "word_start", "word_end"]);
const ENTITY_TYPES = Object.freeze([
  "background", "grid", "waveform", "signal_pulse", "beam", "evidence_node", "label", "camera_group",
  "observation_record", "annotation", "frequency_scale", "duration_timer", "beam_graph", "search_timeline", "proof_bridge",
  "persistent_signal",
]);
const TEMPLATE_FAMILIES = Object.freeze([
  "signal_lab_v1", "mystery_payoff_v1",
  "wow_observation_v1", "frequency_duration_v1", "telescope_beam_v1", "repeat_search_v1", "evidence_payoff_v1",
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(field, message = SAFE_MESSAGES.VALIDATION_ERROR, details = {}) {
  throw new AppError("ANIMATION_IR_INVALID", message, 400, { field, ...details });
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, `${field} must be an object.`);
  return value;
}

function exactKeys(value, allowed, field) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail(`${field}.${key}`, `${field} contains an unsupported field.`);
}

function text(value, field, { max = 120, pattern = null } = {}) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value) || (pattern && !pattern.test(value))) fail(field, `${field} is invalid.`);
  return value;
}

function number(value, field, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(field, `${field} is out of range.`);
  return value;
}

function token(value, field, allowed) {
  const normalized = text(value, field, { max: 80 });
  if (!allowed.includes(normalized)) fail(field, `${field} is unsupported.`);
  return normalized;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function animationContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function rejectExecutableOrRemote(value, field = "animationIR") {
  if (typeof value === "string") {
    if (/https?:\/\/|data:|javascript:|<\/?(?:script|style|svg|html)|\b(?:function|eval|require|import)\s*\(/i.test(value)) fail(field, `${field} contains executable or remote content.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => rejectExecutableOrRemote(entry, `${field}[${index}]`));
  if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => rejectExecutableOrRemote(entry, `${field}.${key}`));
}

function validateAnchor(anchor, field, context) {
  object(anchor, field);
  exactKeys(anchor, ["anchor", "frame", "beatId", "wordIndex", "offsetFrames", "resolvedFrame"], field);
  const type = token(anchor.anchor, `${field}.anchor`, ALLOWED_ANCHORS);
  const offset = anchor.offsetFrames === undefined ? 0 : number(anchor.offsetFrames, `${field}.offsetFrames`, -90, 90, true);
  const resolvedFrame = number(anchor.resolvedFrame, `${field}.resolvedFrame`, context.sceneStart, context.sceneEnd - 1, true);
  let expected;
  if (type === "absolute") {
    if (anchor.beatId !== undefined || anchor.wordIndex !== undefined) fail(field, "Absolute timing cannot include beat or word bindings.");
    expected = number(anchor.frame, `${field}.frame`, context.sceneStart, context.sceneEnd - 1, true) + offset;
  } else {
    if (anchor.frame !== undefined) fail(field, "Semantic timing cannot include an absolute frame.");
    if (!context.timingBinding) fail(field, "Semantic timing requires a timing binding.");
    if (type.startsWith("beat_")) {
      text(anchor.beatId, `${field}.beatId`, { pattern: ID_RE });
      const beat = context.timingBinding.beats.find((candidate) => candidate.beatId === anchor.beatId);
      if (!beat) fail(`${field}.beatId`, "Semantic timing references an unknown beat.");
      expected = (type === "beat_start" ? beat.startFrame : beat.endFrame - 1) + offset;
    } else {
      number(anchor.wordIndex, `${field}.wordIndex`, 0, 10000, true);
      const word = context.timingBinding.words.find((candidate) => candidate.index === anchor.wordIndex);
      if (!word) fail(`${field}.wordIndex`, "Semantic timing references an unknown word.");
      expected = (type === "word_start" ? word.startFrame : word.endFrame - 1) + offset;
    }
  }
  if (expected !== resolvedFrame) fail(`${field}.resolvedFrame`, "Resolved timing does not match its anchor.");
  return resolvedFrame;
}

function validateTimingBinding(binding, durationFrames) {
  if (binding === null) return null;
  object(binding, "timingBinding");
  exactKeys(binding, ["schemaVersion", "timingContextHash", "words", "beats"], "timingBinding");
  if (binding.schemaVersion !== 1) fail("timingBinding.schemaVersion");
  text(binding.timingContextHash, "timingBinding.timingContextHash", { max: 64, pattern: HASH_RE });
  if (!Array.isArray(binding.words) || !binding.words.length || binding.words.length > 400) fail("timingBinding.words");
  let previousEnd = 0;
  const words = binding.words.map((word, index) => {
    object(word, `timingBinding.words[${index}]`);
    exactKeys(word, ["index", "startFrame", "endFrame"], `timingBinding.words[${index}]`);
    if (word.index !== index) fail(`timingBinding.words[${index}].index`);
    const startFrame = number(word.startFrame, `timingBinding.words[${index}].startFrame`, 0, durationFrames - 1, true);
    const endFrame = number(word.endFrame, `timingBinding.words[${index}].endFrame`, startFrame + 1, durationFrames, true);
    if (startFrame < previousEnd) fail(`timingBinding.words[${index}].startFrame`);
    previousEnd = endFrame;
    return { index, startFrame, endFrame };
  });
  if (!Array.isArray(binding.beats) || !binding.beats.length || binding.beats.length > 40) fail("timingBinding.beats");
  let coveredWords = 0;
  const ids = new Set();
  const beats = binding.beats.map((beat, index) => {
    object(beat, `timingBinding.beats[${index}]`);
    exactKeys(beat, ["beatId", "wordStartIndex", "wordEndIndex", "startFrame", "endFrame"], `timingBinding.beats[${index}]`);
    const beatId = text(beat.beatId, `timingBinding.beats[${index}].beatId`, { pattern: ID_RE });
    if (ids.has(beatId) || beat.wordStartIndex !== coveredWords) fail(`timingBinding.beats[${index}]`);
    const wordEndIndex = number(beat.wordEndIndex, `timingBinding.beats[${index}].wordEndIndex`, coveredWords + 1, words.length, true);
    if (beat.startFrame !== words[coveredWords].startFrame || beat.endFrame !== words[wordEndIndex - 1].endFrame) fail(`timingBinding.beats[${index}]`);
    ids.add(beatId);
    const normalized = { beatId, wordStartIndex: coveredWords, wordEndIndex, startFrame: beat.startFrame, endFrame: beat.endFrame };
    coveredWords = wordEndIndex;
    return normalized;
  });
  if (coveredWords !== words.length) fail("timingBinding.beats");
  return { schemaVersion: 1, timingContextHash: binding.timingContextHash, words, beats };
}

const PARAM_KEYS = Object.freeze({
  create: ["opacity"], fade: ["from", "to"], move: ["x", "y"], scale: ["from", "to"],
  transform: ["x", "y", "scale", "rotation"], draw_path: ["direction"], trace_signal: ["amplitude", "frequency", "decay"],
  morph_path: ["toShape"], pulse: ["scale", "opacity"], stagger: ["delayFrames"], highlight: ["strength"],
  camera_push: ["scale", "x", "y"], transition_match: ["toEntityId"],
});

function validateParams(op, params, field) {
  object(params, field);
  exactKeys(params, PARAM_KEYS[op], field);
  for (const [key, value] of Object.entries(params)) {
    if (key === "direction") token(value, `${field}.${key}`, ["left_to_right", "right_to_left"]);
    else if (key === "toShape") token(value, `${field}.${key}`, ["circle", "node", "diamond"]);
    else if (key === "toEntityId") text(value, `${field}.${key}`, { pattern: ID_RE });
    else if (key === "delayFrames") number(value, `${field}.${key}`, 0, 30, true);
    else if (["x", "y"].includes(key)) number(value, `${field}.${key}`, -2160, 2160);
    else if (key === "rotation") number(value, `${field}.${key}`, -45, 45);
    else if (key === "frequency") number(value, `${field}.${key}`, 0.1, 12);
    else number(value, `${field}.${key}`, 0, key === "amplitude" ? 400 : 4);
  }
}

function validateEntity(entity, index) {
  const field = `sharedEntities[${index}]`;
  object(entity, field);
  exactKeys(entity, ["id", "type", "role", "layer", "styleToken", "text"], field);
  const normalized = {
    id: text(entity.id, `${field}.id`, { pattern: ID_RE }),
    type: token(entity.type, `${field}.type`, ENTITY_TYPES),
    role: text(entity.role, `${field}.role`, { max: 80, pattern: ID_RE }),
    layer: number(entity.layer, `${field}.layer`, 0, 20, true),
    styleToken: text(entity.styleToken, `${field}.styleToken`, { max: 80, pattern: ID_RE }),
  };
  if (entity.text !== undefined) normalized.text = text(entity.text, `${field}.text`, { max: 120 });
  return normalized;
}

function validateContent(content) {
  object(content, "content");
  exactKeys(content, ["compositionId", "kicker", "titleLines", "metricValue", "metricLabel", "evidenceCode", "evidenceLabel", "reasoningLeft", "reasoningRight", "payoffLines", "timelineLabels", "semantic"], "content");
  const lines = (value, field, min, max, length) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(field);
    return value.map((entry, index) => text(entry, `${field}[${index}]`, { max: length }));
  };
  const normalized = {
    compositionId: text(content.compositionId, "content.compositionId", { max: 80, pattern: ID_RE }),
    kicker: text(content.kicker, "content.kicker", { max: 60 }),
    titleLines: lines(content.titleLines, "content.titleLines", 1, 3, 50),
    metricValue: text(content.metricValue, "content.metricValue", { max: 32 }),
    metricLabel: text(content.metricLabel, "content.metricLabel", { max: 72 }),
    evidenceCode: text(content.evidenceCode, "content.evidenceCode", { max: 32 }),
    evidenceLabel: text(content.evidenceLabel, "content.evidenceLabel", { max: 72 }),
    reasoningLeft: text(content.reasoningLeft, "content.reasoningLeft", { max: 50 }),
    reasoningRight: text(content.reasoningRight, "content.reasoningRight", { max: 50 }),
    payoffLines: lines(content.payoffLines, "content.payoffLines", 1, 3, 50),
    timelineLabels: lines(content.timelineLabels, "content.timelineLabels", 3, 6, 24),
  };
  if (content.semantic !== undefined) {
    object(content.semantic, "content.semantic");
    const keys = ["profileId", "eventYearLabel", "eraLabel", "recordLabel", "annotationLabel", "frequencyLabel", "durationValue", "durationUnit", "sourceLabel", "beamTitle", "beamXAxis", "beamYAxis", "interferenceLabel", "disclosureLabel", "repeatRangeLabel", "noRepeatLabel", "transmissionLabel", "observationLabel", "proofLabel", "speculationLabel", "conclusionLabel", "candidateLeadLabel", "candidateNounLabel", "uncertaintyLabel", "finalEvidenceLabel"];
    exactKeys(content.semantic, keys, "content.semantic");
    normalized.semantic = Object.fromEntries(keys.map((key) => [key, text(content.semantic[key], `content.semantic.${key}`, { max: 80 })]));
  }
  return normalized;
}

function validateSceneSemantic(value, field) {
  object(value, field);
  exactKeys(value, ["beatId", "role", "claimIds", "visualStatement"], field);
  text(value.beatId, `${field}.beatId`, { pattern: ID_RE });
  token(value.role, `${field}.role`, ["hook", "context", "evidence", "turn", "payoff"]);
  if (!Array.isArray(value.claimIds) || !value.claimIds.length || value.claimIds.length > 8) fail(`${field}.claimIds`);
  const ids = new Set();
  value.claimIds.forEach((claimId, index) => {
    text(claimId, `${field}.claimIds[${index}]`, { pattern: ID_RE });
    if (ids.has(claimId)) fail(`${field}.claimIds`);
    ids.add(claimId);
  });
  text(value.visualStatement, `${field}.visualStatement`, { max: 160 });
}

function validateMotionBudget(budget) {
  object(budget, "motionBudget");
  exactKeys(budget, ["profile", "maxCost", "maxConcurrentOperations", "maxCameraScale", "maxTravelPxPerFrame", "captionSafeZone"], "motionBudget");
  object(budget.captionSafeZone, "motionBudget.captionSafeZone");
  exactKeys(budget.captionSafeZone, ["topRatio", "bottomRatio"], "motionBudget.captionSafeZone");
  return {
    profile: token(budget.profile, "motionBudget.profile", ["calm_explainer", "dark_curiosity", "high_intensity_mystery"]),
    maxCost: number(budget.maxCost, "motionBudget.maxCost", 1, 500, true),
    maxConcurrentOperations: number(budget.maxConcurrentOperations, "motionBudget.maxConcurrentOperations", 1, 8, true),
    maxCameraScale: number(budget.maxCameraScale, "motionBudget.maxCameraScale", 1, 1.3),
    maxTravelPxPerFrame: number(budget.maxTravelPxPerFrame, "motionBudget.maxTravelPxPerFrame", 0.1, 30),
    captionSafeZone: {
      topRatio: number(budget.captionSafeZone.topRatio, "motionBudget.captionSafeZone.topRatio", 0.5, 0.9),
      bottomRatio: number(budget.captionSafeZone.bottomRatio, "motionBudget.captionSafeZone.bottomRatio", 0.75, 1),
    },
  };
}

function validateAnimationIR(input, options = {}) {
  const ir = structuredClone(object(input, "animationIR"));
  rejectExecutableOrRemote(ir);
  exactKeys(ir, ["schemaVersion", "profile", "profileVersion", "projectId", "projectRevision", "verticalId", "width", "height", "fps", "durationFrames", "draftHash", "alignmentHash", "assetManifestHash", "renderer", "seed", "content", "timingBinding", "sharedEntities", "scenes", "transitions", "motionBudget", "visualStateGraph", "contentHash"], "animationIR");
  if (ir.schemaVersion !== ANIMATION_IR_SCHEMA_VERSION) fail("schemaVersion", "AnimationIR schema version is unsupported.");
  token(ir.profile, "profile", [ANIMATION_PROFILE]);
  text(ir.profileVersion, "profileVersion", { pattern: VERSION_RE });
  text(ir.projectId, "projectId", { pattern: ID_RE });
  number(ir.projectRevision, "projectRevision", 1, 1000000, true);
  token(ir.verticalId, "verticalId", ["dark_curiosity"]);
  number(ir.width, "width", 360, 2160, true);
  number(ir.height, "height", 640, 3840, true);
  if (ir.height * 9 !== ir.width * 16) fail("dimensions", "AnimationIR must use a 9:16 canvas.");
  number(ir.fps, "fps", 24, 60, true);
  number(ir.durationFrames, "durationFrames", 30, 3600, true);
  ["draftHash", "alignmentHash", "assetManifestHash"].forEach((key) => text(ir[key], key, { max: 64, pattern: HASH_RE }));
  object(ir.renderer, "renderer");
  exactKeys(ir.renderer, ["provider", "runtimeVersion", "styleVersion"], "renderer");
  text(ir.renderer.provider, "renderer.provider", { pattern: ID_RE });
  text(ir.renderer.runtimeVersion, "renderer.runtimeVersion", { pattern: VERSION_RE });
  text(ir.renderer.styleVersion, "renderer.styleVersion", { pattern: VERSION_RE });
  number(ir.seed, "seed", 0, 0xffffffff, true);
  ir.content = validateContent(ir.content);
  ir.timingBinding = validateTimingBinding(ir.timingBinding === undefined ? null : ir.timingBinding, ir.durationFrames);
  if (!Array.isArray(ir.sharedEntities) || !ir.sharedEntities.length || ir.sharedEntities.length > 64) fail("sharedEntities");
  ir.sharedEntities = ir.sharedEntities.map(validateEntity);
  const entityIds = new Set();
  for (const entity of ir.sharedEntities) {
    if (entityIds.has(entity.id)) fail("sharedEntities", "AnimationIR contains duplicate entity IDs.", { id: entity.id });
    entityIds.add(entity.id);
  }
  if (!Array.isArray(ir.scenes) || !ir.scenes.length || ir.scenes.length > 12) fail("scenes");
  let lastEnd = 0;
  ir.scenes.forEach((scene, sceneIndex) => {
    const field = `scenes[${sceneIndex}]`;
    object(scene, field);
    exactKeys(scene, ["id", "startFrame", "endFrame", "template", "templateVersion", "entityIds", "operations", "readabilityHolds", "complexityCost", "semantic"], field);
    text(scene.id, `${field}.id`, { pattern: ID_RE });
    number(scene.startFrame, `${field}.startFrame`, 0, ir.durationFrames - 1, true);
    number(scene.endFrame, `${field}.endFrame`, scene.startFrame + 1, ir.durationFrames, true);
    if (scene.startFrame !== lastEnd) fail(`${field}.startFrame`, "Animation scenes must be contiguous and non-overlapping.");
    lastEnd = scene.endFrame;
    token(scene.template, `${field}.template`, TEMPLATE_FAMILIES);
    if (scene.semantic !== undefined) validateSceneSemantic(scene.semantic, `${field}.semantic`);
    text(scene.templateVersion, `${field}.templateVersion`, { pattern: VERSION_RE });
    if (!Array.isArray(scene.entityIds) || !scene.entityIds.length) fail(`${field}.entityIds`);
    scene.entityIds.forEach((id, index) => { text(id, `${field}.entityIds[${index}]`, { pattern: ID_RE }); if (!entityIds.has(id)) fail(`${field}.entityIds[${index}]`, "Scene references an unknown entity."); });
    if (!Array.isArray(scene.operations) || !scene.operations.length || scene.operations.length > 40) fail(`${field}.operations`);
    scene.operations.forEach((operation, operationIndex) => {
      const opField = `${field}.operations[${operationIndex}]`;
      object(operation, opField);
      exactKeys(operation, ["op", "targetId", "from", "to", "easing", "params", "semanticClaimId", "visualStatement", "carryPolicy"], opField);
      const op = token(operation.op, `${opField}.op`, ALLOWED_OPERATIONS);
      text(operation.targetId, `${opField}.targetId`, { pattern: ID_RE });
      if (!entityIds.has(operation.targetId) || !scene.entityIds.includes(operation.targetId)) fail(`${opField}.targetId`, "Operation references an unavailable entity.");
      token(operation.easing, `${opField}.easing`, ALLOWED_EASINGS);
      const context = { sceneStart: scene.startFrame, sceneEnd: scene.endFrame, timingBinding: ir.timingBinding };
      const fromFrame = validateAnchor(operation.from, `${opField}.from`, context);
      const toFrame = validateAnchor(operation.to, `${opField}.to`, context);
      if (toFrame <= fromFrame) fail(`${opField}.to`, "Operation timing must have positive duration.");
      validateParams(op, operation.params, `${opField}.params`);
      if (operation.semanticClaimId !== undefined) text(operation.semanticClaimId, `${opField}.semanticClaimId`, { pattern: ID_RE });
      if (operation.visualStatement !== undefined) text(operation.visualStatement, `${opField}.visualStatement`, { max: 160 });
      if (operation.carryPolicy !== undefined) token(operation.carryPolicy, `${opField}.carryPolicy`, ["clear_at_scene_end", "carry_to_next", "persistent"]);
      if (op === "transition_match" && !entityIds.has(operation.params.toEntityId)) fail(`${opField}.params.toEntityId`, "Transition references an unknown entity.");
    });
    if (!Array.isArray(scene.readabilityHolds) || scene.readabilityHolds.length > 6) fail(`${field}.readabilityHolds`);
    scene.readabilityHolds.forEach((hold, index) => {
      object(hold, `${field}.readabilityHolds[${index}]`);
      exactKeys(hold, ["startFrame", "endFrame"], `${field}.readabilityHolds[${index}]`);
      number(hold.startFrame, `${field}.readabilityHolds[${index}].startFrame`, scene.startFrame, scene.endFrame - 1, true);
      number(hold.endFrame, `${field}.readabilityHolds[${index}].endFrame`, hold.startFrame + 1, scene.endFrame, true);
    });
    number(scene.complexityCost, `${field}.complexityCost`, 1, 200, true);
  });
  if (lastEnd !== ir.durationFrames) fail("scenes", "Animation scenes must cover the full duration.");
  if (!Array.isArray(ir.transitions) || ir.transitions.length > 11) fail("transitions");
  ir.transitions.forEach((transition, index) => {
    const field = `transitions[${index}]`;
    object(transition, field);
    exactKeys(transition, ["fromSceneId", "toSceneId", "sharedEntityId", "startFrame", "endFrame"], field);
    ["fromSceneId", "toSceneId", "sharedEntityId"].forEach((key) => text(transition[key], `${field}.${key}`, { pattern: ID_RE }));
    if (!ir.scenes.some((scene) => scene.id === transition.fromSceneId) || !ir.scenes.some((scene) => scene.id === transition.toSceneId) || !entityIds.has(transition.sharedEntityId)) fail(field, "Transition contains an unknown reference.");
    number(transition.startFrame, `${field}.startFrame`, 0, ir.durationFrames - 1, true);
    number(transition.endFrame, `${field}.endFrame`, transition.startFrame + 1, ir.durationFrames, true);
  });
  ir.motionBudget = validateMotionBudget(ir.motionBudget);
  const requiresVisualStateGraph = ir.renderer.styleVersion === "1.9.0" && ir.content.semantic?.profileId === "wow_signal_case_v1";
  if (requiresVisualStateGraph && ir.visualStateGraph === undefined) fail("visualStateGraph", "Production semantic animation requires a visual state graph.");
  if (ir.visualStateGraph !== undefined) {
    ir.visualStateGraph = validateVisualStateGraph(ir.visualStateGraph, {
      draftHash: ir.draftHash,
      alignmentHash: ir.alignmentHash,
      timingBinding: ir.timingBinding,
      entityIds,
      scenes: ir.scenes,
      durationFrames: ir.durationFrames,
    });
  }
  const expectedHash = animationContentHash(ir);
  if (ir.contentHash !== undefined && (!HASH_RE.test(ir.contentHash) || ir.contentHash !== expectedHash)) fail("contentHash", "AnimationIR content hash does not match.");
  ir.contentHash = expectedHash;
  return Object.freeze(ir);
}

module.exports = { ALLOWED_ANCHORS, ALLOWED_EASINGS, ALLOWED_OPERATIONS, ANIMATION_IR_SCHEMA_VERSION, ANIMATION_PROFILE, animationContentHash, stableStringify, validateAnimationIR };
