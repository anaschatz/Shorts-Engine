import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  escapeXml,
  listGeneralizedVisualPrimitives,
  renderGeneralizedVisualHelper,
  renderGeneralizedVisualRecipe,
} from "./generalized-visual-primitives-v1.mjs";
import {
  GENERALIZED_VISUAL_RENDERER_PROFILE_ID,
  GENERALIZED_VISUAL_RENDERER_VERSION,
  styleForComposition,
} from "./generalized-visual-style-v1.mjs";
import {
  createGeneralizedVisualRuntimeData,
  generalizedVisualRuntimeScript,
} from "./generalized-visual-runtime-v1.mjs";

const require = createRequire(import.meta.url);
const {
  GENERALIZED_VISUAL_PROGRAM_ADAPTER_PROFILE_ID,
  validateGeneralizedVisualProgramAnimationAdapterV1,
} = require("../../server/pipelines/narrated-short/animation/visual-program-compiler.cjs");

const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");
const EXPECTED_PLAN_PROFILE = "generalized_visual_recipe_plan_v1";
const EXPECTED_LAYOUT_PROFILE = "engine_owned_vertical_layout_v1";

function sceneMarkup(scene, index) {
  const style = styleForComposition(scene.layout.compositionFamily);
  const canvas = scene.layout.canvas;
  const primary = scene.layout.primary.bounds;
  const helper = scene.layout.helper?.bounds || null;
  return `<g id="visual_scene_${index}" data-visual-scene="${escapeXml(scene.id)}" data-recipe-id="${escapeXml(scene.recipeId)}" data-composition-family="${escapeXml(scene.layout.compositionFamily)}" data-style-id="${style.styleId}" opacity="0" style="--scene-bg:${style.background};--scene-surface:${style.surface};--scene-line:${style.line};--scene-accent:${style.accent};--scene-secondary:${style.secondary}">
    <rect width="${canvas.width}" height="${canvas.height}" fill="${style.background}"/>
    <circle cx="${canvas.width / 2}" cy="610" r="520" fill="${style.accent}" opacity=".035"/>
    <g data-motion-stage="true">
      <g data-dominant-primary="true" data-bounds="${primary.x},${primary.y},${primary.width},${primary.height}">${renderGeneralizedVisualRecipe(scene)}</g>
      ${helper ? `<g data-single-helper="true" data-bounds="${helper.x},${helper.y},${helper.width},${helper.height}">${renderGeneralizedVisualHelper(scene)}</g>` : ""}
    </g>
  </g>`;
}

function strictTuple(adapter) {
  if (
    adapter.schemaVersion !== 1
    || adapter.profile !== GENERALIZED_VISUAL_PROGRAM_ADAPTER_PROFILE_ID
    || adapter.visualRecipePlan?.profile !== EXPECTED_PLAN_PROFILE
    || adapter.visualRecipePlan?.profileVersion !== "1.0.0"
    || adapter.visualRecipePlan?.layoutProfile?.id !== EXPECTED_LAYOUT_PROFILE
    || adapter.visualRecipePlan?.layoutProfile?.version !== "1.0.0"
    || adapter.animationIR?.renderer?.provider !== "hyperframes_local"
    || adapter.animationIR?.renderer?.runtimeVersion !== "0.7.55"
  ) throw new TypeError("Generalized visual renderer tuple is invalid.");
}

export function compileGeneralizedVisualRecipeAdapterToHtml(rawAdapter, trustedContext = {}) {
  strictTuple(rawAdapter || {});
  const adapter = validateGeneralizedVisualProgramAnimationAdapterV1(
    rawAdapter,
    trustedContext,
  );
  const plan = adapter.visualRecipePlan;
  if (plan.duration.fps !== 30 || plan.duration.totalFrames !== adapter.animationIR.durationFrames) {
    throw new TypeError("Generalized visual renderer timing is invalid.");
  }
  const runtimeData = createGeneralizedVisualRuntimeData(adapter);
  const runtimeScript = generalizedVisualRuntimeScript(runtimeData);
  const sceneMarkupValue = plan.scenes.map(sceneMarkup).join("\n");
  const firstLayout = plan.scenes[0].layout;
  const compositionId = adapter.animationIR.content.compositionId;
  const html = `<!doctype html>
<html lang="en" data-renderer-profile="${GENERALIZED_VISUAL_RENDERER_PROFILE_ID}" data-renderer-version="${GENERALIZED_VISUAL_RENDERER_VERSION}"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta data-composition-id="${escapeXml(compositionId)}" data-width="1080" data-height="1920" data-font-sha256="${FONT_SHA256}" data-visual-program-hash="${adapter.visualProgram.contentHash}" data-recipe-plan-hash="${plan.contentHash}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#08090c}*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#08090c}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}
[data-visual-scene]{--scene-bg:#08090c;--scene-surface:#171922;--scene-line:#cbd5e1;--scene-accent:#fbbf24;--scene-secondary:#fb7185}.surface{fill:var(--scene-surface);stroke:var(--scene-line);stroke-width:3}.panel-frame{fill-opacity:.88}.helper-surface{fill:var(--scene-surface);fill-opacity:.95;stroke:var(--scene-line);stroke-width:2}.line-art{fill:none;stroke:var(--scene-line);stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.accent-stroke{fill:none;stroke:var(--scene-accent);stroke-width:7;stroke-linecap:round;stroke-linejoin:round}.grounded-copy{fill:#f8fafc}.heading-copy{fill:var(--scene-accent);letter-spacing:.4px}.secondary-copy,.helper-copy{fill:#cbd5e1}.semantic-copy{fill:var(--scene-line);letter-spacing:1.4px}.paper-semantic-copy{fill:#6b5a42;letter-spacing:1.4px}.badge-surface{fill:var(--scene-surface);stroke:var(--scene-accent);stroke-width:2}.badge-copy{fill:var(--scene-accent);letter-spacing:2px}.focus-ring{fill:none;stroke:var(--scene-accent);stroke-width:4;filter:url(#soft-glow)}
.counter-cell{fill:var(--scene-bg);stroke:var(--scene-line);stroke-width:4}.counter-dot,.marker-fill{fill:var(--scene-accent)}.cycle-arrow{stroke-dasharray:12 14}.node-surface{fill:var(--scene-surface);stroke:var(--scene-line);stroke-width:5}.baseline{stroke-width:5}.paper-surface{fill:#f1e8d1;stroke:var(--scene-line);stroke-width:4}.document-lines{fill:none;stroke:#6b5a42;stroke-width:5;stroke-linecap:round}.lens-ring{fill:var(--scene-surface);fill-opacity:.28;stroke:var(--scene-accent);stroke-width:8}.observed-region{fill:var(--scene-accent);fill-opacity:.2;stroke:var(--scene-accent);stroke-width:3}.inferred-region{fill:var(--scene-secondary);fill-opacity:.14;stroke:var(--scene-secondary);stroke-width:3;stroke-dasharray:12 10}.unknown-region{fill:var(--scene-surface);stroke:var(--scene-line);stroke-width:3;stroke-dasharray:5 12}.region-symbol{fill:var(--scene-bg);stroke:var(--scene-line);stroke-width:4}.map-field{fill:var(--scene-surface);stroke:var(--scene-line);stroke-width:3}.route-line{stroke-dasharray:14 14}.route-dot{fill:var(--scene-bg);stroke:var(--scene-line);stroke-width:4}.disclosure-copy{fill:var(--scene-line);letter-spacing:1.8px}.expected-outline{fill:var(--scene-surface);fill-opacity:.22;stroke:var(--scene-line);stroke-width:6;stroke-dasharray:18 14}.search-field{fill:none;stroke:var(--scene-secondary);stroke-width:3;stroke-dasharray:8 12}.search-rays{fill:none;stroke:var(--scene-accent);stroke-width:5}.absence-center{fill:var(--scene-bg);stroke:var(--scene-accent);stroke-width:6}.active-chronology{filter:url(#soft-glow)}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${escapeXml(compositionId)}" data-start="0" data-duration="${plan.duration.totalFrames / plan.duration.fps}" data-width="1080" data-height="1920">
<svg viewBox="0 0 1080 1920" role="img" aria-label="${escapeXml(plan.scenes[0].grounded.heading)}">
<defs><filter id="soft-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect x="${firstLayout.regions.visualRoi.x}" y="${firstLayout.regions.visualRoi.y}" width="${firstLayout.regions.visualRoi.width}" height="${firstLayout.regions.visualRoi.height}" fill="none" data-semantic-roi="true" pointer-events="none"/>
<g id="generalized-scene-stack">${sceneMarkupValue}</g>
<rect x="${firstLayout.regions.captionLane.x}" y="${firstLayout.regions.captionLane.y}" width="${firstLayout.regions.captionLane.width}" height="${firstLayout.regions.captionLane.height}" fill="#020407" fill-opacity=".86" data-caption-safe-zone="true" pointer-events="none"/>
</svg></main><script>${runtimeScript}</script></body></html>`;
  const compositionHash = createHash("sha256").update(html).digest("hex");
  const primitiveIds = listGeneralizedVisualPrimitives();
  return Object.freeze({
    html,
    compositionHash,
    renderer: Object.freeze({
      profile: GENERALIZED_VISUAL_RENDERER_PROFILE_ID,
      version: GENERALIZED_VISUAL_RENDERER_VERSION,
    }),
    font: Object.freeze({
      family: FONT_FAMILY,
      sha256: FONT_SHA256,
      license: FONT_LICENSE,
      sourcePackage: "@fontsource/outfit",
    }),
    qaPolicy: Object.freeze({
      semanticRoi: firstLayout.regions.visualRoi,
      captionSafeZone: firstLayout.regions.captionLane,
      primitiveIds,
      recipeIds: Object.freeze(plan.scenes.map((scene) => scene.recipeId)),
      maximumSimultaneousMotion: 2,
    }),
  });
}
