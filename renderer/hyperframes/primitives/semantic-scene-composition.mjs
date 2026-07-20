import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sceneCompositionContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-scene-composition.cjs",
);
const primitiveParameterContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-primitive-parameters.cjs",
);

export const SEMANTIC_SCENE_COMPOSITION_PROFILE_ID =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_PROFILE_ID;
export const SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION;
export const SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS;

const LAYOUTS = Object.freeze({
  header_strip: Object.freeze({
    primaryTransform: "translate(80 132) scale(.78)",
    supportA: Object.freeze({ x: 54, y: 276, width: 272, height: 104 }),
    supportB: Object.freeze({ x: 394, y: 276, width: 272, height: 104 }),
    contextLink: "M190 380 C190 402 250 410 300 430",
    stateLink: "M530 380 C530 402 470 410 420 430",
  }),
  satellites_left: Object.freeze({
    primaryTransform: "translate(146 24) scale(.76)",
    supportA: Object.freeze({ x: 36, y: 366, width: 170, height: 116 }),
    supportB: Object.freeze({ x: 36, y: 526, width: 170, height: 116 }),
    contextLink: "M206 424 C232 424 238 440 258 454",
    stateLink: "M206 584 C240 584 250 558 274 544",
  }),
  satellites_right: Object.freeze({
    primaryTransform: "translate(-4 24) scale(.76)",
    supportA: Object.freeze({ x: 514, y: 366, width: 170, height: 116 }),
    supportB: Object.freeze({ x: 514, y: 526, width: 170, height: 116 }),
    contextLink: "M514 424 C488 424 482 440 462 454",
    stateLink: "M514 584 C480 584 470 558 446 544",
  }),
});

const NEGATIVE_STATE_TOKENS = new Set([
  "ABSENT",
  "REJECTED",
  "UNRESOLVED",
]);

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePrimitiveParameters(input) {
  try {
    return primitiveParameterContract.normalizeSemanticPrimitiveParameters(input);
  } catch {
    throw new TypeError("Semantic scene composition parameters are invalid.");
  }
}

export function normalizeSemanticSceneComposition(input) {
  try {
    return sceneCompositionContract.normalizeSemanticSceneComposition(input);
  } catch {
    throw new TypeError("Semantic scene composition is invalid.");
  }
}

function exactQuantity(parameters) {
  if (!parameters.quantity) return "";
  return [parameters.quantity.value, parameters.quantity.unit]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function excerptLines(value, maximumCharacters, maximumLines = 2) {
  const words = value.trim().split(/\s+/);
  const lines = [];
  let truncated = false;
  for (const word of words) {
    const current = lines.at(-1);
    if (!current) {
      lines.push(word);
      continue;
    }
    if (`${current} ${word}`.length <= maximumCharacters) {
      lines[lines.length - 1] = `${current} ${word}`;
      continue;
    }
    if (lines.length >= maximumLines) {
      truncated = true;
      break;
    }
    lines.push(word);
  }
  if (lines.some((line) => line.length > maximumCharacters)) {
    return Object.freeze([
      `${Array.from(value.trim()).slice(0, maximumCharacters - 1).join("")}…`,
    ]);
  }
  if (truncated) {
    const last = lines.length - 1;
    const available = Math.max(1, maximumCharacters - 1);
    lines[last] = `${Array.from(lines[last]).slice(0, available).join("")}…`;
  }
  return Object.freeze(lines.slice(0, maximumLines));
}

function supportTextMarkup(
  lines,
  box,
  className = "semantic-support-value",
  baseFontSize = 15,
) {
  const startY = lines.length === 1 ? box.height * .67 : box.height * .57;
  return lines.map((line, index) => {
    const availableWidth = box.width - 28;
    const needsFitting = Array.from(line).length * baseFontSize * .58
      > availableWidth;
    const fit = needsFitting
      ? ` textLength="${availableWidth}" lengthAdjust="spacingAndGlyphs"`
      : "";
    return `<text x="${box.width / 2}" y="${(startY + index * 22).toFixed(1)}"
 text-anchor="middle" class="${className}"${fit}>${escapeXml(line)}</text>`;
  }).join("");
}

function supportSurface(module, box, contentMarkup, tone = "cool") {
  return `<g class="semantic-support-slot"
 transform="translate(${box.x} ${box.y})" data-composition-slot="${escapeXml(module.slot)}">
 <g class="semantic-support-module semantic-support-${tone}" opacity="0"
  data-scene-module-id="${escapeXml(module.id)}"
  data-scene-module-kind="${escapeXml(module.kind)}"
  data-scene-module-source="${escapeXml(module.source)}"
  data-reveal-order="${module.revealOrder}">
  <rect width="${box.width}" height="${box.height}" rx="18" class="semantic-support-surface"/>
  ${contentMarkup}
 </g>
</g>`;
}

function detailCardMarkup(module, box, parameters) {
  const lines = excerptLines(
    parameters.detail.value,
    box.width < 200 ? 17 : 30,
  );
  const content = `<text x="16" y="27" class="semantic-support-label">CONTEXT</text>
  ${supportTextMarkup(lines, box)}`;
  return supportSurface(module, box, content);
}

function quantityBadgeMarkup(module, box, parameters) {
  const quantity = exactQuantity(parameters);
  if (!quantity || quantity.length > 32) {
    throw new TypeError("Semantic quantity support is not grounded.");
  }
  const content = `<text x="16" y="27" class="semantic-support-label">MEASURE</text>
  ${supportTextMarkup([quantity], box, "semantic-support-quantity", 23)}`;
  return supportSurface(module, box, content, "warm");
}

function routeTraceMarkup(module, box, parameters) {
  const route = parameters.geometry.route;
  if (!route) throw new TypeError("Semantic route support is not grounded.");
  const insetX = 18;
  const top = 39;
  const routeWidth = box.width - insetX * 2;
  const routeHeight = box.height - top - 16;
  const points = route.points.map(([x, y]) => [
    insetX + x * routeWidth,
    top + y * routeHeight,
  ]);
  const path = points.map(([x, y], index) => (
    `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`
  )).join(" ");
  const [startX, startY] = points[0];
  const [endX, endY] = points.at(-1);
  const content = `<text x="16" y="27" class="semantic-support-label">ROUTE</text>
  <path d="${path}" pathLength="1" class="semantic-support-route semantic-draw"/>
  <circle cx="${startX.toFixed(2)}" cy="${startY.toFixed(2)}" r="4" class="semantic-support-route-start"/>
  <circle cx="${endX.toFixed(2)}" cy="${endY.toFixed(2)}" r="5" class="semantic-support-route-end"/>`;
  return supportSurface(module, box, content);
}

function stateBadgeMarkup(module, box, parameters) {
  const state = parameters.stateToken;
  const tone = NEGATIVE_STATE_TOKENS.has(state) ? "reject" : "cool";
  const content = `<text x="16" y="27" class="semantic-support-label">STATE</text>
  ${supportTextMarkup([state], box, "semantic-support-state", 18)}`;
  return supportSurface(module, box, content, tone);
}

function contextSupportMarkup(module, box, parameters) {
  if (module.kind === "route_trace") {
    return routeTraceMarkup(module, box, parameters);
  }
  if (module.kind === "quantity_badge") {
    return quantityBadgeMarkup(module, box, parameters);
  }
  if (module.kind === "detail_card") {
    return detailCardMarkup(module, box, parameters);
  }
  throw new TypeError("Semantic context support kind is unsupported.");
}

export function semanticSceneCompositionMarkup(sentence, primaryMarkup) {
  if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
    throw new TypeError("Semantic scene composition sentence is invalid.");
  }
  if (typeof primaryMarkup !== "string" || !primaryMarkup) {
    throw new TypeError("Semantic scene primary markup is invalid.");
  }
  const parameters = normalizePrimitiveParameters(sentence.primitiveParameters);
  const composition = normalizeSemanticSceneComposition(sentence.sceneComposition);
  if (
    parameters.assetId !== sentence.capability?.assetId
    || parameters.grammarId !== sentence.capability?.grammarId
  ) {
    throw new TypeError("Semantic scene composition capability is invalid.");
  }
  if (composition.id !== `composition_${sentence.propositionId}`) {
    throw new TypeError("Semantic scene composition proposition binding is invalid.");
  }
  const layout = LAYOUTS[composition.layoutId];
  if (!layout) throw new TypeError("Semantic scene composition layout is invalid.");
  const [primary, supportA, supportB] = composition.modules;
  return `<g class="semantic-scene-composition"
 data-scene-composition-profile-id="${escapeXml(composition.profileId)}"
 data-scene-composition-id="${escapeXml(composition.id)}"
 data-scene-composition-layout-id="${escapeXml(composition.layoutId)}"
 data-scene-composition-variant-seed="${composition.variantSeed}">
 <g class="semantic-composition-links" aria-hidden="true">
  <path d="${layout.contextLink}" pathLength="1" opacity="0"
   class="semantic-composition-link semantic-composition-link-context semantic-draw"
   data-from-module-id="${escapeXml(composition.links[0].fromModuleId)}"
   data-to-module-id="${escapeXml(composition.links[0].toModuleId)}"/>
  <path d="${layout.stateLink}" pathLength="1" opacity="0"
   class="semantic-composition-link semantic-composition-link-state semantic-draw"
   data-from-module-id="${escapeXml(composition.links[1].fromModuleId)}"
   data-to-module-id="${escapeXml(composition.links[1].toModuleId)}"/>
 </g>
 <g class="semantic-primary-slot" transform="${layout.primaryTransform}"
  data-composition-slot="${escapeXml(primary.slot)}">
  <g class="semantic-primary-module"
   data-scene-module-id="${escapeXml(primary.id)}"
   data-scene-module-kind="${escapeXml(primary.kind)}"
   data-reveal-order="${primary.revealOrder}">${primaryMarkup}</g>
 </g>
 ${contextSupportMarkup(supportA, layout.supportA, parameters)}
 ${stateBadgeMarkup(supportB, layout.supportB, parameters)}
</g>`;
}
