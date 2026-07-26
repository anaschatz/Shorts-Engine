import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const geometryContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-geometry-blueprint.cjs",
);

export const SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID =
  geometryContract.SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID;
export const SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION =
  geometryContract.SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION;
export const SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID =
  geometryContract.SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID;
export const SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION =
  geometryContract.SEMANTIC_GEOMETRY_PROGRAM_SCHEMA_VERSION;

const EDGE_CLASS_BY_TONE = Object.freeze({
  cool: "connector-line",
  muted: "muted-line",
  reject: "error-cross",
  warm: "warm-line",
});
const HALO_CLASS_BY_TONE = Object.freeze({
  cool: "cool-halo",
  muted: "cool-halo",
  reject: "reject-halo",
  warm: "warm-halo",
});
const FILL_BY_TONE = Object.freeze({
  cool: "#22d3ee",
  muted: "#64748b",
  reject: "#fb7185",
  warm: "#f59e0b",
});

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function normalizeSemanticGeometryBlueprint(input) {
  try {
    return geometryContract.normalizeSemanticGeometryBlueprint(input);
  } catch {
    throw new TypeError("Semantic geometry blueprint is invalid.");
  }
}

export function compileSemanticGeometryProgram(input) {
  try {
    return geometryContract.compileSemanticGeometryProgram(input);
  } catch {
    throw new TypeError("Semantic geometry blueprint is not bound to the scene.");
  }
}

function projectedPoint(node) {
  return Object.freeze({
    x: 96 + node.x * 0.528,
    y: 310 + node.y * 0.34,
  });
}

function radius(node) {
  return 4.5 + node.size * 0.16;
}

function nodeShapeMarkup(node, point) {
  const nodeRadius = radius(node);
  const fill = FILL_BY_TONE[node.tone];
  if (node.shape === "circle") {
    return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}"
 r="${nodeRadius.toFixed(2)}" fill="${fill}"/>`;
  }
  const side = nodeRadius * 1.62;
  const x = point.x - side / 2;
  const y = point.y - side / 2;
  const transform = node.shape === "diamond"
    ? ` transform="rotate(45 ${point.x.toFixed(2)} ${point.y.toFixed(2)})"`
    : "";
  return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}"
 width="${side.toFixed(2)}" height="${side.toFixed(2)}" rx="2.5"
 fill="${fill}"${transform}/>`;
}

function nodeMarkup(node, index) {
  const point = projectedPoint(node);
  const nodeRadius = radius(node);
  return `<g class="semantic-bounded-node" opacity="0"
 data-blueprint-node-index="${index}"
 data-blueprint-node-id="${escapeXml(node.id)}"
 data-blueprint-node-role="${escapeXml(node.role)}"
 data-blueprint-node-shape="${escapeXml(node.shape)}"
 data-blueprint-node-tone="${escapeXml(node.tone)}"
 data-blueprint-reveal-order="${node.revealOrder}">
 <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}"
  r="${(nodeRadius * 1.85).toFixed(2)}"
  class="${HALO_CLASS_BY_TONE[node.tone]}" opacity=".58"/>
 ${nodeShapeMarkup(node, point)}
</g>`;
}

function edgeMarkup(edge, index, nodeById) {
  const from = projectedPoint(nodeById.get(edge.fromNodeId));
  const to = projectedPoint(nodeById.get(edge.toNodeId));
  const className = EDGE_CLASS_BY_TONE[edge.tone];
  const common = `pathLength="1000" opacity="0"
 class="semantic-draw semantic-bounded-edge ${className}"
 data-blueprint-edge-index="${index}"
 data-blueprint-edge-id="${escapeXml(edge.id)}"
 data-blueprint-edge-kind="${escapeXml(edge.kind)}"
 data-blueprint-edge-tone="${escapeXml(edge.tone)}"
 data-blueprint-reveal-order="${edge.revealOrder}"`;
  if (edge.kind === "dwell") {
    return `<circle cx="${from.x.toFixed(2)}" cy="${from.y.toFixed(2)}" r="10.00"
 fill="none" ${common}/>`;
  }
  if (edge.kind === "line") {
    return `<line x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}"
 x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" ${common}/>`;
  }
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const length = Math.hypot(deltaX, deltaY);
  const normalX = -deltaY / length;
  const normalY = deltaX / length;
  const bend = edge.bend * 0.28;
  const controlX = (from.x + to.x) / 2 + normalX * bend;
  const controlY = (from.y + to.y) / 2 + normalY * bend;
  return `<path d="M${from.x.toFixed(2)} ${from.y.toFixed(2)}
 Q${controlX.toFixed(2)} ${controlY.toFixed(2)} ${to.x.toFixed(2)} ${to.y.toFixed(2)}"
 ${common}/>`;
}

export function semanticBoundedGeometryMarkup(sentence) {
  if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
    throw new TypeError("Semantic bounded geometry sentence is invalid.");
  }
  const blueprint = normalizeSemanticGeometryBlueprint(
    sentence.sceneComposition?.geometryBlueprint,
  );
  const program = compileSemanticGeometryProgram({
    geometryBlueprint: blueprint,
    primitiveParameters: sentence.primitiveParameters,
    propositionId: sentence.propositionId,
  });
  const nodeById = new Map(program.nodes.map((node) => [node.id, node]));
  const edges = program.edges.map((edge, index) => edgeMarkup(
    edge,
    index,
    nodeById,
  )).join("\n ");
  const nodes = program.nodes.map(nodeMarkup).join("\n ");
  return `<g class="semantic-bounded-geometry" aria-hidden="true" pointer-events="none"
 data-bounded-geometry-profile-id="${escapeXml(blueprint.profileId)}"
 data-bounded-geometry-recipe-id="${escapeXml(blueprint.recipeId)}"
 data-bounded-geometry-blueprint-hash="${blueprint.contentHash}"
 data-bounded-geometry-program-hash="${program.contentHash}"
 data-bounded-geometry-provenance="${escapeXml(program.provenance)}"
 data-bounded-geometry-node-count="${program.nodes.length}"
 data-bounded-geometry-edge-count="${program.edges.length}">
 <g class="semantic-bounded-edges">${edges}</g>
 <g class="semantic-bounded-nodes">${nodes}</g>
</g>`;
}
