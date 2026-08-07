import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  escapeGeneralizedVisualXmlV2,
  listGeneralizedVisualEntityPrimitivesV2,
  listGeneralizedVisualRelationPrimitivesV2,
  renderGeneralizedVisualEntityV2,
  renderGeneralizedVisualRelationV2,
} from "./generalized-visual-primitives-v2.mjs";
import {
  GENERALIZED_VISUAL_STYLE_V2,
  validateGeneralizedVisualStyleBindingV2,
} from "./generalized-visual-style-v2.mjs";
import {
  createGeneralizedVisualRuntimeDataV2,
  generalizedVisualRuntimeScriptV2,
} from "./generalized-visual-runtime-v2.mjs";

const require = createRequire(import.meta.url);
const { normalizeVisualProgramV2 } = require(
  "../../server/pipelines/narrated-short/animation/visual-program-v2-contract.cjs",
);

export const GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_PROFILE_ID =
  "generalized_visual_composition_renderer_v2";
export const GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_VERSION = "2.0.0";

const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");

function sameBox(actual, expected) {
  return actual
    && ["x", "y", "width", "height"].every((key) => actual[key] === expected[key]);
}

function relationPresentation(relation) {
  const predicate = relation.predicate.toLowerCase();
  if (relation.polarity === "negated" || relation.certainty === "disputed") {
    return { primitiveId: "dashed_signal", tone: "signal" };
  }
  if (/(?:transmit|send|signal|broadcast|receive|communicat|emit)/.test(predicate)) {
    return { primitiveId: "dashed_signal", tone: "signal" };
  }
  if (/(?:compare|contrast|versus)/.test(predicate)) {
    return { primitiveId: "bracket", tone: "accent" };
  }
  if (/(?:preced|follow|continu|timeline|progress|before|after)/.test(predicate)) {
    return { primitiveId: "timeline", tone: "support" };
  }
  return { primitiveId: "arrow", tone: relation.certainty === "qualified" ? "support" : "accent" };
}

function entityTone(entity, scene) {
  if (entity.id === scene.focusEntityId) return "accent";
  if (/(?:signal|unknown|rejected)/.test(`${entity.kind} ${entity.visualSubjectKind}`)) return "signal";
  if (entity.persistent) return "support";
  return "primary";
}

function semanticSceneHeading(scene, fallback) {
  const predicate = scene.events.at(-1)?.predicate;
  if (typeof predicate !== "string" || !/^[a-z][a-z0-9_]{1,79}$/.test(predicate)) return fallback;
  return predicate.replaceAll("_", " ").toUpperCase();
}

function composedScene(scene, index) {
  const layout = scene.layout;
  if (
    layout.canvas.width !== GENERALIZED_VISUAL_STYLE_V2.canvas.width
    || layout.canvas.height !== GENERALIZED_VISUAL_STYLE_V2.canvas.height
    || !sameBox(layout.regions.visualRoi, { x: 72, y: 276, width: 936, height: 1068 })
    || !sameBox(layout.regions.captionLane, { x: 0, y: 1416, width: 1080, height: 504 })
  ) throw new TypeError(`scene.${scene.id} layout is incompatible with the locked style.`);
  const nodeByEntityId = new Map(layout.nodes.map((node) => [node.entityId, node]));
  const edgeByRelationId = new Map(layout.edges.map((edge) => [edge.relationId, edge]));
  if (nodeByEntityId.size !== scene.entities.length || edgeByRelationId.size !== scene.relations.length) {
    throw new TypeError(`scene.${scene.id} layout bindings are incomplete.`);
  }
  const entities = scene.entities.map((entity) => {
    const node = nodeByEntityId.get(entity.id);
    if (!node) throw new TypeError(`scene.${scene.id} is missing an entity node.`);
    return {
      ...entity,
      role: node.role,
      bounds: node.bounds,
      tone: entityTone(entity, scene),
      displayText: entity.label,
    };
  });
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const relations = scene.relations.map((relation) => {
    const edge = edgeByRelationId.get(relation.id);
    if (!edge || edge.fromEntityId !== relation.fromEntityId || edge.toEntityId !== relation.toEntityId) {
      throw new TypeError(`scene.${scene.id} has an invalid relation edge.`);
    }
    return {
      ...relation,
      ...relationPresentation(relation),
      pathKind: edge.kind,
      points: edge.points,
    };
  });
  const focusLabel = entitiesById.get(scene.focusEntityId)?.label || entities[0].label;
  const sceneHeading = semanticSceneHeading(scene, focusLabel);
  return `<g id="gv2_scene_${index}" data-visual-scene="${escapeGeneralizedVisualXmlV2(scene.id)}" data-layout-intent="${scene.layoutIntent}" data-composition-fingerprint="${scene.compositionFingerprint}" opacity="0">
    <text x="72" y="246" class="section-copy" data-grounded-copy="true">${escapeGeneralizedVisualXmlV2(sceneHeading)}</text>
    <g data-motion-stage="true">
      ${relations.map((relation) => renderGeneralizedVisualRelationV2(relation, entitiesById)).join("\n")}
      ${entities.map(renderGeneralizedVisualEntityV2).join("\n")}
    </g>
  </g>`;
}

export function compileGeneralizedVisualCompositionPlanV2ToHtml(rawPlan) {
  const plan = normalizeVisualProgramV2(rawPlan);
  const style = validateGeneralizedVisualStyleBindingV2(plan.style);
  const runtimeData = createGeneralizedVisualRuntimeDataV2(plan);
  const title = plan.presentation.title;
  const scenes = plan.scenes.map(composedScene).join("\n");
  const html = `<!doctype html>
<html lang="en" data-renderer-profile="${GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_PROFILE_ID}" data-renderer-version="${GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_VERSION}"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta data-composition-id="${runtimeData.compositionId}" data-program-hash="${plan.contentHash}" data-style-hash="${style.contentHash}" data-width="1080" data-height="1920" data-font-sha256="${FONT_SHA256}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${style.palette.background}}*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}.background{fill:${style.palette.background}}[data-motion-target]{transform-box:fill-box;transform-origin:center;will-change:transform,opacity}.promise-copy{fill:${style.palette.primary};font-size:48px;font-weight:600;letter-spacing:-.5px}.section-copy{fill:${style.palette.muted};font-size:28px;font-weight:600;letter-spacing:1px}.entity{--tone:${style.palette.primary}}.relation{--tone:${style.palette.accent}}.tone-primary{--tone:${style.palette.primary}}.tone-muted{--tone:${style.palette.muted}}.tone-accent{--tone:${style.palette.accent}}.tone-signal{--tone:${style.palette.signal}}.tone-support{--tone:${style.palette.support}}.line-art,.accent-stroke,.support-stroke,.muted-stroke,.relation-stroke{fill:none;stroke:var(--tone);stroke-linecap:round;stroke-linejoin:round}.line-art{stroke-width:5}.accent-stroke,.support-stroke{stroke-width:6}.muted-stroke{stroke:${style.palette.muted};stroke-width:3}.entity-surface,.inner-surface,.token-surface{fill:${style.palette.background};stroke:var(--tone);stroke-width:4}.inner-surface{stroke-width:2}.wheel{fill:${style.palette.background};stroke:var(--tone);stroke-width:5}.accent-fill,.relation-token{fill:var(--tone)}.accent-ring,.focus-ring{fill:none;stroke:var(--tone);stroke-width:4}.focus-ring{stroke-width:6;filter:url(#gv2_glow)}.entity-label,.display-copy,.relation-label{fill:${style.palette.primary};font-weight:600}.entity-label{font-size:23px}.display-copy{font-size:34px}.relation-label{fill:${style.palette.muted}}.relation-stroke{stroke:var(--tone);stroke-width:6}.relation-dashed,.semantic-dashed{stroke-dasharray:12 14}.relation-token{filter:url(#gv2_glow)}.semantic-rejection{fill:none;stroke:${style.palette.signal};stroke-width:7;stroke-linecap:round}.semantic-mark{fill:none;stroke:${style.palette.support};stroke-width:5;stroke-linecap:round;stroke-linejoin:round;filter:url(#gv2_glow)}.semantic-uncertainty{fill:none;stroke:${style.palette.signal};stroke-width:5;stroke-dasharray:12 14}.semantic-empty{fill:${style.palette.background};stroke:${style.palette.signal};stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
</style></head><body><main id="animation-root" class="composition" data-composition-id="${runtimeData.compositionId}" data-duration="${plan.duration.totalFrames / plan.duration.fps}" data-width="1080" data-height="1920"><svg viewBox="0 0 1080 1920" role="img" aria-label="${escapeGeneralizedVisualXmlV2(title)}"><defs><marker id="gv2-arrowhead" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M0 0L10 4L0 8Z" fill="context-stroke"/></marker><filter id="gv2_glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="1080" height="1920" class="background"/><text x="72" y="132" class="promise-copy" data-grounded-copy="true">${escapeGeneralizedVisualXmlV2(title)}</text><g id="gv2_scene_stack">${scenes}</g><rect x="0" y="1416" width="1080" height="504" fill="none" data-caption-safe-zone="true" pointer-events="none"/><rect x="72" y="276" width="936" height="1068" fill="none" data-semantic-roi="true" pointer-events="none"/></svg></main><script>${generalizedVisualRuntimeScriptV2(runtimeData)}</script></body></html>`;
  return Object.freeze({
    html,
    compositionHash: createHash("sha256").update(html).digest("hex"),
    compositionId: runtimeData.compositionId,
    renderer: Object.freeze({
      profile: GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_PROFILE_ID,
      version: GENERALIZED_VISUAL_COMPOSITION_RENDERER_V2_VERSION,
    }),
    style,
    font: Object.freeze({ family: FONT_FAMILY, sha256: FONT_SHA256, license: FONT_LICENSE, sourcePackage: "@fontsource/outfit" }),
    qaPolicy: Object.freeze({
      semanticRoi: Object.freeze({ x: 72, y: 276, width: 936, height: 1068 }),
      captionSafeZone: Object.freeze({ x: 0, y: 1416, width: 1080, height: 504 }),
      entityPrimitiveIds: listGeneralizedVisualEntityPrimitivesV2(),
      relationPrimitiveIds: listGeneralizedVisualRelationPrimitivesV2(),
      compositionFingerprints: Object.freeze(plan.scenes.map((scene) => scene.compositionFingerprint)),
      maximumSimultaneousMotion: style.motion.maximumSimultaneousOperations,
    }),
  });
}
