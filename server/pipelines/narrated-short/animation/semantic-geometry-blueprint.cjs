"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  normalizeSemanticPrimitiveParameters,
} = require("./semantic-primitive-parameters.cjs");

const SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION = 1;
const SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID =
  "dark_curiosity_bounded_geometry_blueprint_v1";
const SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION = 1;
const SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID =
  "dark_curiosity_bounded_geometry_program_v1";
const SEMANTIC_GEOMETRY_COORDINATE_SPACE = "normalized_1000";
const MAX_GEOMETRY_NODES = 12;
const MAX_GEOMETRY_EDGES = 16;
const MAX_GEOMETRY_COST = 28;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,119}$/;

const SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR = Object.freeze({
  before_after: "paired_frames_v1",
  bounded_uncertainty: "bounded_orbit_v1",
  cause_effect_chain: "causal_flow_v1",
  chronology_accumulation: "temporal_track_v1",
  evidence_inspection: "evidence_cluster_v1",
  finite_cycle: "finite_ring_v1",
  map_motion: "route_field_v1",
  negative_space_absence: "void_field_v1",
  side_by_side_comparison: "comparison_balance_v1",
});
const SEMANTIC_GEOMETRY_RECIPE_IDS = Object.freeze([
  ...new Set(Object.values(SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR)),
]);
const SEMANTIC_GEOMETRY_NODE_RANGE_BY_RECIPE = Object.freeze({
  paired_frames_v1: Object.freeze([4, 6]),
  bounded_orbit_v1: Object.freeze([5, 8]),
  causal_flow_v1: Object.freeze([3, 5]),
  temporal_track_v1: Object.freeze([4, 7]),
  evidence_cluster_v1: Object.freeze([5, 8]),
  finite_ring_v1: Object.freeze([5, 8]),
  route_field_v1: Object.freeze([4, 6]),
  void_field_v1: Object.freeze([5, 8]),
  comparison_balance_v1: Object.freeze([4, 6]),
});
const GEOMETRY_ORIENTATIONS = Object.freeze([
  "forward",
  "radial",
  "reverse",
]);
const GEOMETRY_DENSITIES = Object.freeze([
  "balanced",
  "dense",
  "sparse",
]);
const GEOMETRY_PROVENANCE = Object.freeze([
  "approved_storyboard_layout",
  "deterministic_illustrative",
]);
const GEOMETRY_NODE_SHAPES = Object.freeze([
  "circle",
  "diamond",
  "square",
]);
const GEOMETRY_NODE_ROLES = Object.freeze([
  "anchor",
  "context",
  "evidence",
  "outcome",
  "unknown",
]);
const GEOMETRY_TONES = Object.freeze([
  "cool",
  "muted",
  "reject",
  "warm",
]);
const GEOMETRY_EDGE_KINDS = Object.freeze(["curve", "dwell", "line"]);

const RADIAL_POINTS = Object.freeze([
  Object.freeze([500, 90]),
  Object.freeze([704, 145]),
  Object.freeze([855, 296]),
  Object.freeze([910, 500]),
  Object.freeze([855, 704]),
  Object.freeze([704, 855]),
  Object.freeze([500, 910]),
  Object.freeze([296, 855]),
  Object.freeze([145, 704]),
  Object.freeze([90, 500]),
  Object.freeze([145, 296]),
  Object.freeze([296, 145]),
]);

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "Semantic geometry is invalid or is not bound to its trusted scene context.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(value, required, field, optional = []) {
  if (!isPlainObject(value)) fail(field, "plain_object_required");
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    fail(`${field}.*`, "unsupported_field");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.${key}`, "plain_data_field_required");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "field_required");
  }
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function denseDataArray(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(field, "array_size_invalid");
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(`${field}.*`, "unsupported_array_field");
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}[${index}]`, "dense_data_array_required");
    entries.push(descriptor.value);
  }
  return entries;
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > (options.maximum || 120)
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function hash(value, field) {
  return text(value, field, { maximum: 64, pattern: HASH_PATTERN });
}

function integer(value, field, minimum, maximum) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) fail(field, "integer_out_of_range");
  return value;
}

function token(value, field, allowed) {
  const normalized = text(value, field, { maximum: 80, pattern: ID_PATTERN });
  if (!allowed.includes(normalized)) fail(field, "unsupported_value");
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function primitiveParametersHash(value) {
  return canonicalHash(normalizeSemanticPrimitiveParameters(value));
}

function normalizeBindings(input, field) {
  exactDataKeys(input, [
    "semanticEventGraphHash",
    "propositionId",
    "primitiveParametersHash",
  ], field);
  return {
    semanticEventGraphHash: hash(
      input.semanticEventGraphHash,
      `${field}.semanticEventGraphHash`,
    ),
    propositionId: text(input.propositionId, `${field}.propositionId`, {
      maximum: 120,
      pattern: ID_PATTERN,
    }),
    primitiveParametersHash: hash(
      input.primitiveParametersHash,
      `${field}.primitiveParametersHash`,
    ),
  };
}

function normalizeControls(input, field) {
  exactDataKeys(input, [
    "nodeCount",
    "emphasisIndex",
    "orientation",
    "density",
    "provenance",
  ], field);
  const nodeCount = integer(
    input.nodeCount,
    `${field}.nodeCount`,
    2,
    MAX_GEOMETRY_NODES,
  );
  return {
    nodeCount,
    emphasisIndex: integer(
      input.emphasisIndex,
      `${field}.emphasisIndex`,
      0,
      nodeCount - 1,
    ),
    orientation: token(
      input.orientation,
      `${field}.orientation`,
      GEOMETRY_ORIENTATIONS,
    ),
    density: token(input.density, `${field}.density`, GEOMETRY_DENSITIES),
    provenance: token(
      input.provenance,
      `${field}.provenance`,
      GEOMETRY_PROVENANCE,
    ),
  };
}

function semanticGeometryBlueprintContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return canonicalHash(copy);
}

function normalizeSemanticGeometryBlueprint(input) {
  exactDataKeys(input, [
    "schemaVersion",
    "profileId",
    "recipeId",
    "bindings",
    "controls",
    "complexityCost",
  ], "geometryBlueprint", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION) {
    fail("geometryBlueprint.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID) {
    fail("geometryBlueprint.profileId", "unsupported_profile");
  }
  const normalized = {
    schemaVersion: SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION,
    profileId: SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID,
    recipeId: token(
      input.recipeId,
      "geometryBlueprint.recipeId",
      SEMANTIC_GEOMETRY_RECIPE_IDS,
    ),
    bindings: normalizeBindings(input.bindings, "geometryBlueprint.bindings"),
    controls: normalizeControls(input.controls, "geometryBlueprint.controls"),
    complexityCost: integer(
      input.complexityCost,
      "geometryBlueprint.complexityCost",
      3,
      MAX_GEOMETRY_COST,
    ),
  };
  const contentHash = semanticGeometryBlueprintContentHash(normalized);
  const suppliedContentHash = ownDataValue(input, "contentHash");
  if (suppliedContentHash !== undefined) {
    hash(suppliedContentHash, "geometryBlueprint.contentHash");
    if (suppliedContentHash !== contentHash) {
      fail("geometryBlueprint.contentHash", "content_hash_mismatch");
    }
  }
  return deepFreeze({ ...normalized, contentHash });
}

function normalizedRoutePoints(parameters) {
  const route = parameters.geometry.route;
  if (!route) return null;
  const points = route.points.map(([x, y]) => [
    Math.round(x * 1000),
    Math.round(y * 1000),
  ]);
  if (new Set(points.map(([x, y]) => `${x}:${y}`)).size < 2) {
    fail("primitiveParameters.geometry.route.points", "geometry_degenerate");
  }
  return points;
}

function recipeForParameters(parameters) {
  return parameters.geometry.route
    ? "route_field_v1"
    : SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR[parameters.grammarId];
}

function expectedEdgeCount(recipeId, nodeCount) {
  if (["bounded_orbit_v1", "finite_ring_v1"].includes(recipeId)) {
    return nodeCount;
  }
  if (recipeId === "evidence_cluster_v1") return nodeCount - 1;
  if (recipeId === "comparison_balance_v1") return nodeCount;
  return nodeCount - 1;
}

function buildSemanticGeometryBlueprint(input = {}) {
  exactDataKeys(input, [
    "semanticEventGraphHash",
    "propositionId",
    "primitiveParameters",
  ], "geometryContext");
  const semanticEventGraphHash = hash(
    input.semanticEventGraphHash,
    "geometryContext.semanticEventGraphHash",
  );
  const propositionId = text(
    input.propositionId,
    "geometryContext.propositionId",
    { maximum: 120, pattern: ID_PATTERN },
  );
  const parameters = normalizeSemanticPrimitiveParameters(
    input.primitiveParameters,
  );
  const parameterHash = primitiveParametersHash(parameters);
  const routePoints = normalizedRoutePoints(parameters);
  const recipeId = recipeForParameters(parameters);
  if (!recipeId) fail("primitiveParameters.grammarId", "recipe_unavailable");
  const seed = createHash("sha256").update(stableStringify({
    semanticEventGraphHash,
    propositionId,
    primitiveParametersHash: parameterHash,
    recipeId,
  })).digest();
  const [minimumNodes, maximumNodes] =
    SEMANTIC_GEOMETRY_NODE_RANGE_BY_RECIPE[recipeId];
  const density = routePoints
    ? routePoints.length <= 4
      ? "sparse"
      : routePoints.length >= 8 ? "dense" : "balanced"
    : GEOMETRY_DENSITIES[seed[1] % GEOMETRY_DENSITIES.length];
  const nodeCount = routePoints
    ? routePoints.length
    : density === "sparse"
      ? minimumNodes
      : density === "dense"
        ? maximumNodes
        : Math.round((minimumNodes + maximumNodes) / 2);
  const edgeCount = expectedEdgeCount(recipeId, nodeCount);
  const complexityCost = nodeCount + edgeCount;
  if (complexityCost > MAX_GEOMETRY_COST) {
    fail("geometryBlueprint.complexityCost", "complexity_budget_exceeded");
  }
  const orientation = [
    "bounded_orbit_v1",
    "finite_ring_v1",
    "void_field_v1",
  ].includes(recipeId)
    ? "radial"
    : parameters.geometry.direction;
  return normalizeSemanticGeometryBlueprint({
    schemaVersion: SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION,
    profileId: SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID,
    recipeId,
    bindings: {
      semanticEventGraphHash,
      propositionId,
      primitiveParametersHash: parameterHash,
    },
    controls: {
      nodeCount,
      emphasisIndex: orientation === "reverse" ? 0 : nodeCount - 1,
      orientation,
      density,
      provenance: routePoints
        ? "approved_storyboard_layout"
        : "deterministic_illustrative",
    },
    complexityCost,
  });
}

function same(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function validateSemanticGeometryBlueprintAgainstContext(input, context = {}) {
  const blueprint = normalizeSemanticGeometryBlueprint(input);
  const expected = buildSemanticGeometryBlueprint(context);
  if (!same(blueprint, expected)) {
    fail("geometryBlueprint.bindings", "scene_context_binding_mismatch");
  }
  return blueprint;
}

function seededBytes(blueprint) {
  return Buffer.from(blueprint.contentHash, "hex");
}

function byteAt(bytes, index) {
  return bytes[index % bytes.length];
}

function clamp(value, minimum = 0, maximum = 1000) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function shapeAt(bytes, index) {
  return GEOMETRY_NODE_SHAPES[
    byteAt(bytes, 7 + index * 3) % GEOMETRY_NODE_SHAPES.length
  ];
}

function sizeAt(bytes, index, emphasized) {
  return (emphasized ? 34 : 20) + byteAt(bytes, 11 + index * 5) % 13;
}

function outcomeTone(parameters) {
  if (["ABSENT", "REJECTED", "UNRESOLVED"].includes(parameters.stateToken)) {
    return "reject";
  }
  return "warm";
}

function makeNode(index, point, blueprint, parameters, bytes, role = "context") {
  const emphasized = index === blueprint.controls.emphasisIndex;
  return {
    id: `node_${index}`,
    shape: shapeAt(bytes, index),
    role: emphasized ? "outcome" : role,
    tone: emphasized ? outcomeTone(parameters) : index === 0 ? "cool" : "muted",
    x: clamp(point[0]),
    y: clamp(point[1]),
    size: sizeAt(bytes, index, emphasized),
    revealOrder: index,
  };
}

function makeEdge(
  index,
  fromIndex,
  toIndex,
  bytes,
  tone = "cool",
  fixedKind = null,
) {
  const curved = fixedKind === null
    && byteAt(bytes, 17 + index * 7) % 2 === 1;
  const magnitude = 36 + byteAt(bytes, 19 + index * 7) % 85;
  const sign = byteAt(bytes, 23 + index * 7) % 2 ? 1 : -1;
  return {
    id: `edge_${index}`,
    fromNodeId: `node_${fromIndex}`,
    toNodeId: `node_${toIndex}`,
    kind: fixedKind || (curved ? "curve" : "line"),
    tone,
    bend: fixedKind === null && curved ? magnitude * sign : 0,
    revealOrder: index,
  };
}

function trackPoints(count, bytes, options = {}) {
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0 : index / (count - 1);
    const baseX = 110 + progress * 780;
    const wave = (index % 2 ? 1 : -1) * (70 + byteAt(bytes, 3 + index) % 80);
    const jitter = byteAt(bytes, 13 + index * 2) % 61 - 30;
    return [
      options.reverse ? 1000 - baseX : baseX,
      500 + wave + jitter,
    ];
  });
}

function radialPoints(count, bytes, options = {}) {
  const start = byteAt(bytes, 4) % RADIAL_POINTS.length;
  const step = Math.max(1, Math.floor(RADIAL_POINTS.length / count));
  const indexes = [];
  for (let index = 0; index < count; index += 1) {
    indexes.push((start + index * step) % RADIAL_POINTS.length);
  }
  if (options.gap) indexes.splice(byteAt(bytes, 9) % indexes.length, 1);
  while (indexes.length < count) {
    let candidate = (indexes.at(-1) + 1) % RADIAL_POINTS.length;
    while (indexes.includes(candidate)) {
      candidate = (candidate + 1) % RADIAL_POINTS.length;
    }
    indexes.push(candidate);
  }
  return indexes.map((index, pointIndex) => {
    const [x, y] = RADIAL_POINTS[index];
    const jitterX = byteAt(bytes, 12 + pointIndex * 2) % 41 - 20;
    const jitterY = byteAt(bytes, 13 + pointIndex * 2) % 41 - 20;
    return [x + jitterX, y + jitterY];
  });
}

function pairedPoints(count, bytes) {
  const points = [
    [180, 420],
    [820, 420],
    [420, 570],
    [580, 570],
  ];
  while (points.length < count) {
    const index = points.length;
    const left = index % 2 === 0;
    points.push([
      left ? 170 + byteAt(bytes, index) % 100 : 730 + byteAt(bytes, index) % 100,
      690 + byteAt(bytes, index + 8) % 90,
    ]);
  }
  return points;
}

function focusPoints(count, bytes) {
  return [
    [500, 500],
    ...radialPoints(count - 1, bytes).map(([x, y]) => [
      500 + (x - 500) * 0.78,
      500 + (y - 500) * 0.78,
    ]),
  ];
}

function programTopology(blueprint, parameters) {
  const bytes = seededBytes(blueprint);
  const count = blueprint.controls.nodeCount;
  const routePoints = normalizedRoutePoints(parameters);
  let points;
  switch (blueprint.recipeId) {
    case "paired_frames_v1":
    case "comparison_balance_v1":
      points = pairedPoints(count, bytes);
      break;
    case "bounded_orbit_v1":
    case "finite_ring_v1":
      points = radialPoints(count, bytes);
      break;
    case "void_field_v1":
      points = radialPoints(count, bytes, { gap: true });
      break;
    case "evidence_cluster_v1":
      points = focusPoints(count, bytes);
      break;
    case "route_field_v1":
      points = routePoints || trackPoints(count, bytes, {
        reverse: blueprint.controls.orientation === "reverse",
      });
      break;
    default:
      points = trackPoints(count, bytes, {
        reverse: blueprint.controls.orientation === "reverse",
      });
      break;
  }
  const nodes = points.map((point, index) => makeNode(
    index,
    point,
    blueprint,
    parameters,
    bytes,
    blueprint.recipeId === "evidence_cluster_v1" && index > 0
      ? "evidence"
      : index === 0 ? "anchor" : "context",
  ));
  const edges = [];
  if (blueprint.recipeId === "evidence_cluster_v1") {
    for (let index = 1; index < nodes.length; index += 1) {
      edges.push(makeEdge(edges.length, 0, index, bytes, "cool"));
    }
  } else {
    for (let index = 1; index < nodes.length; index += 1) {
      const repeatedRoutePoint = Boolean(routePoints)
        && nodes[index - 1].x === nodes[index].x
        && nodes[index - 1].y === nodes[index].y;
      edges.push(makeEdge(
        edges.length,
        index - 1,
        index,
        bytes,
        index === nodes.length - 1 ? outcomeTone(parameters) : "cool",
        routePoints ? (repeatedRoutePoint ? "dwell" : "line") : null,
      ));
    }
    if ([
      "bounded_orbit_v1",
      "finite_ring_v1",
      "comparison_balance_v1",
    ].includes(blueprint.recipeId)) {
      edges.push(makeEdge(
        edges.length,
        nodes.length - 1,
        0,
        bytes,
        "muted",
      ));
    }
  }
  return { nodes, edges };
}

function normalizeNode(input, index) {
  const field = `geometryProgram.nodes[${index}]`;
  exactDataKeys(input, [
    "id",
    "shape",
    "role",
    "tone",
    "x",
    "y",
    "size",
    "revealOrder",
  ], field);
  const normalized = {
    id: text(input.id, `${field}.id`, { maximum: 40, pattern: ID_PATTERN }),
    shape: token(input.shape, `${field}.shape`, GEOMETRY_NODE_SHAPES),
    role: token(input.role, `${field}.role`, GEOMETRY_NODE_ROLES),
    tone: token(input.tone, `${field}.tone`, GEOMETRY_TONES),
    x: integer(input.x, `${field}.x`, 0, 1000),
    y: integer(input.y, `${field}.y`, 0, 1000),
    size: integer(input.size, `${field}.size`, 12, 72),
    revealOrder: integer(
      input.revealOrder,
      `${field}.revealOrder`,
      0,
      MAX_GEOMETRY_NODES - 1,
    ),
  };
  if (normalized.id !== `node_${index}` || normalized.revealOrder !== index) {
    fail(field, "node_order_invalid");
  }
  return normalized;
}

function normalizeEdge(input, index, nodeById) {
  const field = `geometryProgram.edges[${index}]`;
  exactDataKeys(input, [
    "id",
    "fromNodeId",
    "toNodeId",
    "kind",
    "tone",
    "bend",
    "revealOrder",
  ], field);
  const normalized = {
    id: text(input.id, `${field}.id`, { maximum: 40, pattern: ID_PATTERN }),
    fromNodeId: text(input.fromNodeId, `${field}.fromNodeId`, {
      maximum: 40,
      pattern: ID_PATTERN,
    }),
    toNodeId: text(input.toNodeId, `${field}.toNodeId`, {
      maximum: 40,
      pattern: ID_PATTERN,
    }),
    kind: token(input.kind, `${field}.kind`, GEOMETRY_EDGE_KINDS),
    tone: token(input.tone, `${field}.tone`, GEOMETRY_TONES),
    bend: integer(input.bend, `${field}.bend`, -240, 240),
    revealOrder: integer(
      input.revealOrder,
      `${field}.revealOrder`,
      0,
      MAX_GEOMETRY_EDGES - 1,
    ),
  };
  if (normalized.id !== `edge_${index}` || normalized.revealOrder !== index) {
    fail(field, "edge_order_invalid");
  }
  if (
    !nodeById.has(normalized.fromNodeId)
    || !nodeById.has(normalized.toNodeId)
  ) fail(field, "dangling_edge");
  if (normalized.fromNodeId === normalized.toNodeId) fail(field, "self_edge");
  if (
    (["line", "dwell"].includes(normalized.kind) && normalized.bend !== 0)
    || (normalized.kind === "curve" && normalized.bend === 0)
  ) fail(field, "edge_kind_bend_mismatch");
  const fromNode = nodeById.get(normalized.fromNodeId);
  const toNode = nodeById.get(normalized.toNodeId);
  const zeroLength = fromNode.x === toNode.x && fromNode.y === toNode.y;
  if (
    (zeroLength && normalized.kind !== "dwell")
    || (!zeroLength && normalized.kind === "dwell")
  ) fail(field, "edge_geometry_kind_mismatch");
  return normalized;
}

function semanticGeometryProgramContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return canonicalHash(copy);
}

function normalizeSemanticGeometryProgram(input) {
  exactDataKeys(input, [
    "schemaVersion",
    "profileId",
    "blueprintHash",
    "coordinateSpace",
    "provenance",
    "nodes",
    "edges",
    "complexityCost",
  ], "geometryProgram", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION) {
    fail("geometryProgram.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID) {
    fail("geometryProgram.profileId", "unsupported_profile");
  }
  if (input.coordinateSpace !== SEMANTIC_GEOMETRY_COORDINATE_SPACE) {
    fail("geometryProgram.coordinateSpace", "unsupported_value");
  }
  const provenance = token(
    input.provenance,
    "geometryProgram.provenance",
    GEOMETRY_PROVENANCE,
  );
  const nodeInputs = denseDataArray(
    input.nodes,
    "geometryProgram.nodes",
    2,
    MAX_GEOMETRY_NODES,
  );
  const nodes = nodeInputs.map(normalizeNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const pointSignatures = nodes.map((node) => `${node.x}:${node.y}`);
  if (
    provenance !== "approved_storyboard_layout"
    && new Set(pointSignatures).size !== pointSignatures.length
  ) {
    fail("geometryProgram.nodes", "duplicate_points");
  }
  const edgeInputs = denseDataArray(
    input.edges,
    "geometryProgram.edges",
    1,
    MAX_GEOMETRY_EDGES,
  );
  const edges = edgeInputs.map((edge, index) => normalizeEdge(
    edge,
    index,
    nodeById,
  ));
  const edgeSignatures = edges.map((edge) => [
    edge.fromNodeId,
    edge.toNodeId,
  ].sort().join(":"));
  if (new Set(edgeSignatures).size !== edgeSignatures.length) {
    fail("geometryProgram.edges", "duplicate_edges");
  }
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    adjacency.get(edge.fromNodeId).add(edge.toNodeId);
    adjacency.get(edge.toNodeId).add(edge.fromNodeId);
  }
  const reached = new Set([nodes[0].id]);
  const queue = [nodes[0].id];
  while (queue.length) {
    const current = queue.shift();
    for (const candidate of adjacency.get(current)) {
      if (reached.has(candidate)) continue;
      reached.add(candidate);
      queue.push(candidate);
    }
  }
  if (reached.size !== nodes.length) {
    fail("geometryProgram.edges", "disconnected_geometry");
  }
  const complexityCost = nodes.length + edges.length;
  if (
    integer(
      input.complexityCost,
      "geometryProgram.complexityCost",
      3,
      MAX_GEOMETRY_COST,
    ) !== complexityCost
  ) fail("geometryProgram.complexityCost", "complexity_cost_mismatch");
  const normalized = {
    schemaVersion: SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION,
    profileId: SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID,
    blueprintHash: hash(input.blueprintHash, "geometryProgram.blueprintHash"),
    coordinateSpace: SEMANTIC_GEOMETRY_COORDINATE_SPACE,
    provenance,
    nodes,
    edges,
    complexityCost,
  };
  const contentHash = semanticGeometryProgramContentHash(normalized);
  const suppliedContentHash = ownDataValue(input, "contentHash");
  if (suppliedContentHash !== undefined) {
    hash(suppliedContentHash, "geometryProgram.contentHash");
    if (suppliedContentHash !== contentHash) {
      fail("geometryProgram.contentHash", "content_hash_mismatch");
    }
  }
  return deepFreeze({ ...normalized, contentHash });
}

function compileSemanticGeometryProgram(input = {}) {
  exactDataKeys(input, [
    "geometryBlueprint",
    "primitiveParameters",
  ], "geometryCompileContext", [
    "propositionId",
    "semanticEventGraphHash",
  ]);
  const parameters = normalizeSemanticPrimitiveParameters(
    input.primitiveParameters,
  );
  const normalizedBlueprint = normalizeSemanticGeometryBlueprint(
    input.geometryBlueprint,
  );
  const propositionId = ownDataValue(input, "propositionId");
  const semanticEventGraphHash = ownDataValue(
    input,
    "semanticEventGraphHash",
  );
  if (
    (
      propositionId !== undefined
      && normalizedBlueprint.bindings.propositionId !== propositionId
    )
    || (
      semanticEventGraphHash !== undefined
      && normalizedBlueprint.bindings.semanticEventGraphHash
        !== semanticEventGraphHash
    )
  ) fail("geometryBlueprint.bindings", "compile_context_binding_mismatch");
  let blueprint;
  try {
    blueprint = validateSemanticGeometryBlueprintAgainstContext(
      normalizedBlueprint,
      {
        semanticEventGraphHash: semanticEventGraphHash
          || normalizedBlueprint.bindings.semanticEventGraphHash,
        propositionId: propositionId
          || normalizedBlueprint.bindings.propositionId,
        primitiveParameters: parameters,
      },
    );
  } catch (cause) {
    if (cause?.code !== "ANIMATION_SEMANTIC_GEOMETRY_INVALID") throw cause;
    fail("geometryBlueprint.bindings", "compile_context_binding_mismatch");
  }
  const topology = programTopology(blueprint, parameters);
  if (
    topology.nodes.length !== blueprint.controls.nodeCount
    || topology.nodes.length + topology.edges.length
      !== blueprint.complexityCost
  ) fail("geometryBlueprint.controls", "compiled_complexity_mismatch");
  return normalizeSemanticGeometryProgram({
    schemaVersion: SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION,
    profileId: SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID,
    blueprintHash: blueprint.contentHash,
    coordinateSpace: SEMANTIC_GEOMETRY_COORDINATE_SPACE,
    provenance: blueprint.controls.provenance,
    nodes: topology.nodes,
    edges: topology.edges,
    complexityCost: topology.nodes.length + topology.edges.length,
  });
}

module.exports = {
  GEOMETRY_DENSITIES,
  GEOMETRY_EDGE_KINDS,
  GEOMETRY_NODE_ROLES,
  GEOMETRY_NODE_SHAPES,
  GEOMETRY_PROVENANCE,
  GEOMETRY_TONES,
  MAX_GEOMETRY_COST,
  MAX_GEOMETRY_EDGES,
  MAX_GEOMETRY_NODES,
  SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID,
  SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION,
  SEMANTIC_GEOMETRY_COORDINATE_SPACE,
  SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID,
  SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION,
  SEMANTIC_GEOMETRY_NODE_RANGE_BY_RECIPE,
  SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR,
  SEMANTIC_GEOMETRY_RECIPE_IDS,
  buildSemanticGeometryBlueprint,
  compileSemanticGeometryProgram,
  normalizeSemanticGeometryBlueprint,
  normalizeSemanticGeometryProgram,
  primitiveParametersHash,
  semanticGeometryBlueprintContentHash,
  semanticGeometryProgramContentHash,
  validateSemanticGeometryBlueprintAgainstContext,
};
