import { createRequire } from "node:module";
import {
  semanticBoundedGeometryMarkup,
} from "./semantic-bounded-geometry.mjs";

const require = createRequire(import.meta.url);
const sceneCompositionContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-scene-composition.cjs",
);
const primitiveParameterContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-primitive-parameters.cjs",
);
const simpleExplainerContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs",
);

export const SEMANTIC_SCENE_COMPOSITION_PROFILE_ID =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_PROFILE_ID;
export const SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION;
export const SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS =
  sceneCompositionContract.SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS;
export const SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID =
  simpleExplainerContract.SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID;
export const SEMANTIC_SIMPLE_EXPLAINER_VISUAL_KINDS =
  simpleExplainerContract.SEMANTIC_SIMPLE_EXPLAINER_VISUAL_KINDS;

const SIMPLE_PRIMARY_TRANSFORM = "translate(14 54) scale(.96)";

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
  "WRONG",
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

function supportMaximumCharacters(box, fontSize) {
  return Math.max(
    6,
    Math.floor((box.width - 28) / (fontSize * 0.52)),
  );
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

function exactWrappedLines(value, maximumCharacters, maximumLines) {
  let remaining = value.trim();
  const lines = [];
  while (remaining && lines.length < maximumLines) {
    if (Array.from(remaining).length <= maximumCharacters) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    const characters = Array.from(remaining);
    const candidate = characters.slice(0, maximumCharacters + 1).join("");
    const whitespaceIndex = candidate.lastIndexOf(" ");
    const splitIndex = whitespaceIndex > 0
      ? whitespaceIndex
      : maximumCharacters;
    lines.push(characters.slice(0, splitIndex).join("").trimEnd());
    remaining = characters.slice(splitIndex).join("").trimStart();
  }
  if (
    remaining
    || lines.join("").replace(/\s/g, "")
      !== value.trim().replace(/\s/g, "")
  ) {
    throw new TypeError("Semantic support text cannot fit without truncation.");
  }
  return Object.freeze(lines);
}

function supportTextMarkup(
  lines,
  box,
  className = "semantic-support-value",
  baseFontSize = 26,
  sentenceIndex = 0,
  moduleId = "module_support_a",
  contrastBackground = "#071827",
) {
  const lineSpacing = Math.max(27, baseFontSize + 1);
  const startY = lines.length === 1
    ? box.height * .7
    : box.height - 14 - (lines.length - 1) * lineSpacing;
  return lines.map((line, index) => {
    return `<text id="semantic-support-${sentenceIndex}-${escapeXml(moduleId)}-${index}"
 x="${box.width / 2}" y="${(startY + index * lineSpacing).toFixed(1)}"
 text-anchor="middle" class="${className}"
 data-legibility-role="secondary"
 data-effective-font-floor="24"
 data-contrast-background="${contrastBackground}">${escapeXml(line)}</text>`;
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

function detailCardMarkup(module, box, parameters, sentenceIndex) {
  const baseFontSize = 26;
  const lines = excerptLines(
    parameters.detail.value,
    supportMaximumCharacters(box, baseFontSize),
  );
  const content = `<text x="16" y="27" class="semantic-support-label">CONTEXT</text>
  ${supportTextMarkup(
    lines,
    box,
    "semantic-support-value",
    baseFontSize,
    sentenceIndex,
    module.id,
  )}`;
  return supportSurface(module, box, content);
}

function quantityBadgeMarkup(module, box, parameters, sentenceIndex) {
  const quantity = exactQuantity(parameters);
  if (!quantity || quantity.length > 32) {
    throw new TypeError("Semantic quantity support is not grounded.");
  }
  const baseFontSize = 26;
  const lines = exactWrappedLines(
    quantity,
    Math.max(
      6,
      Math.floor((box.width - 28) / (baseFontSize * 0.49)),
    ),
    3,
  );
  const content = `<text x="16" y="27" class="semantic-support-label">MEASURE</text>
  ${supportTextMarkup(
    lines,
    box,
    "semantic-support-quantity",
    baseFontSize,
    sentenceIndex,
    module.id,
    "#211706",
  )}`;
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

function stateBadgeMarkup(module, box, parameters, sentenceIndex) {
  const state = parameters.stateToken;
  const tone = NEGATIVE_STATE_TOKENS.has(state) ? "reject" : "cool";
  const baseFontSize = 26;
  const lines = excerptLines(
    state,
    supportMaximumCharacters(box, baseFontSize),
  );
  const content = `<text x="16" y="27" class="semantic-support-label">STATE</text>
  ${supportTextMarkup(
    lines,
    box,
    "semantic-support-state",
    baseFontSize,
    sentenceIndex,
    module.id,
    tone === "reject" ? "#2b101b" : "#071827",
  )}`;
  return supportSurface(module, box, content, tone);
}

function contextSupportMarkup(module, box, parameters, sentenceIndex) {
  if (module.kind === "route_trace") {
    return routeTraceMarkup(module, box, parameters);
  }
  if (module.kind === "quantity_badge") {
    return quantityBadgeMarkup(module, box, parameters, sentenceIndex);
  }
  if (module.kind === "detail_card") {
    return detailCardMarkup(module, box, parameters, sentenceIndex);
  }
  throw new TypeError("Semantic context support kind is unsupported.");
}

function nonVisualModuleStub(module) {
  return `<g class="semantic-support-module semantic-support-stub" opacity="0"
 data-scene-module-id="${escapeXml(module.id)}"
 data-scene-module-kind="${escapeXml(module.kind)}"
 data-scene-module-source="${escapeXml(module.source)}"
 data-reveal-order="${module.revealOrder}"/>`;
}

export function semanticSceneCompositionMarkup(
  sentence,
  primaryMarkup,
  sentenceIndex = 0,
  options = {},
) {
  if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
    throw new TypeError("Semantic scene composition sentence is invalid.");
  }
  if (typeof primaryMarkup !== "string" || !primaryMarkup) {
    throw new TypeError("Semantic scene primary markup is invalid.");
  }
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0 || sentenceIndex > 95) {
    throw new TypeError("Semantic scene composition sentence index is invalid.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Semantic scene composition options are invalid.");
  }
  const presentationProfileId = options.presentationProfileId ?? null;
  if (
    presentationProfileId !== null
    && presentationProfileId !== SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID
  ) {
    throw new TypeError("Semantic scene presentation profile is invalid.");
  }
  const usesSimplePresentation =
    presentationProfileId === SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID;
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
  const propositionId = sentence.propositionId;
  const boundedGeometryMarkup = semanticBoundedGeometryMarkup({
    propositionId,
    primitiveParameters: parameters,
    sceneComposition: composition,
  });
  return `<g class="semantic-scene-composition"
 data-scene-composition-profile-id="${escapeXml(composition.profileId)}"
${usesSimplePresentation
    ? ` data-semantic-presentation-profile-id="${SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID}"`
    : ""}
 data-scene-composition-id="${escapeXml(composition.id)}"
 data-scene-composition-layout-id="${escapeXml(composition.layoutId)}"
 data-scene-composition-variant-seed="${composition.variantSeed}"
 data-visible-module-count="1">
 <g class="semantic-primary-slot" transform="${SIMPLE_PRIMARY_TRANSFORM}"
  data-composition-slot="${escapeXml(primary.slot)}">
  <g class="semantic-primary-module"
   data-scene-module-id="${escapeXml(primary.id)}"
   data-scene-module-kind="${escapeXml(primary.kind)}"
   data-reveal-order="${primary.revealOrder}">
   ${usesSimplePresentation
    ? `<g class="semantic-primary-layout-frame"
     data-semantic-auto-layout="focus">${primaryMarkup}</g>`
    : primaryMarkup}
   ${usesSimplePresentation ? "" : boundedGeometryMarkup}</g>
 </g>
 <g class="semantic-nonvisual-topology" opacity="0" aria-hidden="true"
  pointer-events="none" data-visual-role="nonvisual_scene_topology">
  ${usesSimplePresentation ? boundedGeometryMarkup : ""}
  <g class="semantic-composition-links">
  <path d="${layout.contextLink}" pathLength="1" opacity="0"
   class="semantic-composition-link semantic-composition-link-context semantic-draw"
   data-from-module-id="${escapeXml(composition.links[0].fromModuleId)}"
   data-to-module-id="${escapeXml(composition.links[0].toModuleId)}"/>
  <path d="${layout.stateLink}" pathLength="1" opacity="0"
   class="semantic-composition-link semantic-composition-link-state semantic-draw"
   data-from-module-id="${escapeXml(composition.links[1].fromModuleId)}"
   data-to-module-id="${escapeXml(composition.links[1].toModuleId)}"/>
  </g>
  ${nonVisualModuleStub(supportA)}
  ${nonVisualModuleStub(supportB)}
 </g>
</g>`;
}
