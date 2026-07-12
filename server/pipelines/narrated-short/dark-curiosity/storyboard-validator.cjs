const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText } = require("../../../repositories/ids.cjs");
const { VERTICALS } = require("../vertical-registry.cjs");

const DARK_CURIOSITY_OPERATIONS = Object.freeze([
  "set_heading",
  "show_evidence",
  "show_source_badge",
  "place_marker",
  "connect_nodes",
  "draw_route",
  "advance_timeline",
  "reveal_layer",
  "compare_scale",
  "highlight_region",
  "show_uncertainty",
  "camera_push",
  "fade_or_blackout",
]);
const VISUAL_MODES = Object.freeze(["original_vector", "illustrative_reconstruction"]);
const COMMON_OPERATION_FIELDS = Object.freeze(["op", "startFrame", "endFrame"]);
const OPERATION_FIELDS = Object.freeze({
  set_heading: ["text"],
  show_evidence: ["claimId", "text"],
  show_source_badge: ["sourceId", "text"],
  place_marker: ["id", "x", "y", "label"],
  connect_nodes: ["fromId", "toId", "label"],
  draw_route: ["points", "label"],
  advance_timeline: ["date", "label"],
  reveal_layer: ["layer", "text"],
  compare_scale: ["leftLabel", "rightLabel", "leftValue", "rightValue"],
  highlight_region: ["x", "y", "width", "height", "label"],
  show_uncertainty: ["text"],
  camera_push: ["scale"],
  fade_or_blackout: ["mode"],
});
const REQUIRED_OPERATION_FIELDS = Object.freeze({
  set_heading: ["text"],
  show_evidence: ["claimId"],
  show_source_badge: ["sourceId"],
  place_marker: ["id", "x", "y"],
  connect_nodes: ["fromId", "toId"],
  draw_route: ["points"],
  advance_timeline: ["date", "label"],
  reveal_layer: ["layer", "text"],
  compare_scale: ["leftLabel", "rightLabel", "leftValue", "rightValue"],
  highlight_region: ["x", "y", "width", "height"],
  show_uncertainty: ["text"],
  camera_push: ["scale"],
  fade_or_blackout: ["mode"],
});

function fail(field, message = SAFE_MESSAGES.VALIDATION_ERROR, details = {}) {
  throw new AppError("VALIDATION_ERROR", message, 400, { field, ...details });
}

function assertAllowedKeys(value, allowed, field) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${field}.${key}`, "Dark Curiosity storyboard contains an unsupported field.");
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function text(value, field, max = 120, required = true) {
  const safe = sanitizeText(value || "", max);
  if (required && !safe) fail(field);
  return safe;
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(field);
  return number;
}

function number(value, field, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) fail(field);
  return Number(numeric.toFixed(4));
}

function token(value, field, allowed) {
  const safe = text(value, field, 80).toLowerCase();
  if (!allowed.includes(safe)) fail(field, SAFE_MESSAGES.VALIDATION_ERROR, { value: safe });
  return safe;
}

function id(value, field, prefix) {
  const safe = text(value, field, 80);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]{2,72}$`).test(safe)) fail(field);
  return safe;
}

function point(value, field) {
  if (!Array.isArray(value) || value.length !== 2) fail(field);
  return [number(value[0], `${field}[0]`, 0, 1), number(value[1], `${field}[1]`, 0, 1)];
}

function normalizeOperation(input, sceneIndex, operationIndex, durationFrames, context) {
  const field = `scenes[${sceneIndex}].operations[${operationIndex}]`;
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(field);
  const op = token(input.op, `${field}.op`, DARK_CURIOSITY_OPERATIONS);
  const allowedFields = new Set([...COMMON_OPERATION_FIELDS, ...OPERATION_FIELDS[op]]);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) fail(`${field}.${key}`, "Dark Curiosity operation contains an unsupported field.");
  }
  for (const key of REQUIRED_OPERATION_FIELDS[op]) {
    if (input[key] === undefined || input[key] === null || input[key] === "") fail(`${field}.${key}`);
  }
  const normalized = { op };
  if (input.startFrame !== undefined) normalized.startFrame = integer(input.startFrame, `${field}.startFrame`, 0, durationFrames - 1);
  if (input.endFrame !== undefined) normalized.endFrame = integer(input.endFrame, `${field}.endFrame`, 1, durationFrames);
  if (normalized.startFrame !== undefined && normalized.endFrame !== undefined && normalized.endFrame <= normalized.startFrame) fail(field);

  for (const key of ["text", "label", "leftLabel", "rightLabel"]) {
    if (input[key] !== undefined) normalized[key] = text(input[key], `${field}.${key}`, key === "text" ? 160 : 80);
  }
  for (const key of ["id", "fromId", "toId"]) {
    if (input[key] !== undefined) normalized[key] = text(input[key], `${field}.${key}`, 40);
  }
  if (input.claimId !== undefined) {
    normalized.claimId = id(input.claimId, `${field}.claimId`, "claim");
    if (!context.claimIds.has(normalized.claimId)) fail(`${field}.claimId`, "Visual operation references an unknown claim.");
  }
  if (input.sourceId !== undefined) {
    normalized.sourceId = id(input.sourceId, `${field}.sourceId`, "src");
    if (!context.sourceIds.has(normalized.sourceId)) fail(`${field}.sourceId`, "Visual operation references an unknown source.");
  }
  for (const key of ["x", "y", "width", "height"]) {
    if (input[key] !== undefined) normalized[key] = number(input[key], `${field}.${key}`, 0, 1);
  }
  if (normalized.width !== undefined && normalized.width <= 0) fail(`${field}.width`);
  if (normalized.height !== undefined && normalized.height <= 0) fail(`${field}.height`);
  if (normalized.x !== undefined && normalized.width !== undefined && normalized.x + normalized.width > 1) fail(field);
  if (normalized.y !== undefined && normalized.height !== undefined && normalized.y + normalized.height > 1) fail(field);
  for (const key of ["leftValue", "rightValue"]) {
    if (input[key] !== undefined) normalized[key] = number(input[key], `${field}.${key}`, -1_000_000_000, 1_000_000_000);
  }
  if (input.scale !== undefined) normalized.scale = number(input.scale, `${field}.scale`, 1, 2.5);
  if (input.layer !== undefined) normalized.layer = integer(input.layer, `${field}.layer`, 1, 12);
  if (input.date !== undefined) normalized.date = text(input.date, `${field}.date`, 40);
  if (input.mode !== undefined) normalized.mode = token(input.mode, `${field}.mode`, ["fade", "blackout"]);
  if (input.points !== undefined) {
    if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > 12) fail(`${field}.points`);
    normalized.points = input.points.map((value, index) => point(value, `${field}.points[${index}]`));
  }
  return normalized;
}

function assertTemplateSemantics(scene, field) {
  const operations = new Set(scene.operations.map((operation) => operation.op));
  const allowed = {
    hook_scene: ["set_heading"],
    evidence_scene: ["show_evidence"],
    map_timeline_scene: ["place_marker", "draw_route", "advance_timeline", "reveal_layer"],
    system_scale_scene: ["connect_nodes", "compare_scale", "highlight_region"],
    payoff_scene: ["set_heading", "show_uncertainty"],
  }[scene.template];
  if (!allowed.some((operation) => operations.has(operation))) {
    fail(`${field}.operations`, "Scene does not contain an operation appropriate for its template.");
  }
}

function normalizeDarkCuriosityStoryboard(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("storyboard");
  assertAllowedKeys(input, ["schemaVersion", "verticalId", "fps", "scenes", "contentHash"], "storyboard");
  const script = options.script;
  const claimLedger = options.claimLedger;
  if (!script || !claimLedger) fail("storyboard", "Dark Curiosity storyboard validation requires script and claims.");
  const beatIds = new Set(script.beats.map((beat) => beat.id));
  const claimIds = new Set(claimLedger.claims.map((claim) => claim.id));
  const sourceIds = new Set(claimLedger.sources.map((source) => source.id));
  if (!Array.isArray(input.scenes) || input.scenes.length < 3 || input.scenes.length > 10) fail("scenes");
  const seenSceneIds = new Set();
  const scenes = input.scenes.map((scene, sceneIndex) => {
    const field = `scenes[${sceneIndex}]`;
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) fail(field);
    assertAllowedKeys(scene, ["id", "beatIds", "template", "visualMode", "disclosure", "durationFrames", "operations"], field);
    const sceneId = id(scene.id, `${field}.id`, "scene");
    if (seenSceneIds.has(sceneId)) fail(`${field}.id`, "Storyboard contains a duplicate scene id.");
    seenSceneIds.add(sceneId);
    if (!Array.isArray(scene.beatIds) || scene.beatIds.length < 1 || scene.beatIds.length > 4) fail(`${field}.beatIds`);
    const normalizedBeatIds = [...new Set(scene.beatIds.map((beatId, index) => id(beatId, `${field}.beatIds[${index}]`, "beat")))];
    for (const beatId of normalizedBeatIds) if (!beatIds.has(beatId)) fail(`${field}.beatIds`, "Scene references an unknown beat.");
    const template = token(scene.template, `${field}.template`, VERTICALS.dark_curiosity.sceneTemplates);
    const visualMode = token(scene.visualMode || "original_vector", `${field}.visualMode`, VISUAL_MODES);
    const disclosure = text(scene.disclosure || "", `${field}.disclosure`, 120, false);
    if (visualMode === "illustrative_reconstruction" && !disclosure) fail(`${field}.disclosure`, "Illustrative reconstruction requires a disclosure.");
    const durationFrames = integer(scene.durationFrames, `${field}.durationFrames`, 15, 900);
    if (!Array.isArray(scene.operations) || scene.operations.length < 1 || scene.operations.length > 40) fail(`${field}.operations`);
    const operations = scene.operations.map((operation, operationIndex) => normalizeOperation(
      operation,
      sceneIndex,
      operationIndex,
      durationFrames,
      { claimIds, sourceIds },
    ));
    const normalized = { id: sceneId, beatIds: normalizedBeatIds, template, visualMode, disclosure: disclosure || null, durationFrames, operations };
    assertTemplateSemantics(normalized, field);
    return normalized;
  });
  const coveredBeatIds = new Set(scenes.flatMap((scene) => scene.beatIds));
  for (const beatId of beatIds) if (!coveredBeatIds.has(beatId)) fail("scenes", "Every script beat must be represented by a scene.", { beatId });
  if (scenes[0].template !== "hook_scene") fail("scenes[0].template", "The first Dark Curiosity scene must be the hook.");
  if (scenes[scenes.length - 1].template !== "payoff_scene") fail(`scenes[${scenes.length - 1}].template`, "The final Dark Curiosity scene must be the payoff.");
  const normalized = { schemaVersion: 2, verticalId: "dark_curiosity", fps: 30, scenes };
  return { ...normalized, contentHash: contentHash(normalized) };
}

module.exports = {
  DARK_CURIOSITY_OPERATIONS,
  VISUAL_MODES,
  normalizeDarkCuriosityStoryboard,
};
