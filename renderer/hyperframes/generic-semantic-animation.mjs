import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  archetypeSceneMarkup,
  SUPPORTED_SEMANTIC_ARCHETYPES,
} from "./primitives/semantic-shapes.mjs";

const require = createRequire(import.meta.url);
const BASE_WIDTH = 720;
const BASE_HEIGHT = 1280;
const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"));
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");
const ROLE_ORDER = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);
const ROLE_SET = new Set(ROLE_ORDER);
const ARCHETYPE_SET = new Set(SUPPORTED_SEMANTIC_ARCHETYPES);
const REMOTE_URL = /\bhttps?:\/\//i;
const ENTITY_ID = /^[a-z][a-z0-9_-]{2,79}$/;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function geometryToken(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(stableValue(value));
  }
  return "centered_semantic_roi";
}

function normalizeGeometry(value, label) {
  assertPlainObject(value, label);
  const normalized = stableValue(value);
  if (Object.hasOwn(normalized, "points")) {
    if (!Array.isArray(normalized.points) || normalized.points.length < 2 || normalized.points.length > 12) {
      throw new TypeError(`${label} route points are invalid.`);
    }
    normalized.points = normalized.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
        throw new TypeError(`${label} route point is invalid.`);
      }
      return Object.freeze([...point]);
    });
  }
  return Object.freeze(normalized);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertSafeText(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (REMOTE_URL.test(value)) {
    throw new TypeError(`${label} cannot contain a remote URL.`);
  }
  return value.trim();
}

function resolvedOperation(operation, label) {
  assertPlainObject(operation, label);
  const startFrame = operation.from?.resolvedFrame;
  const endFrame = operation.to?.resolvedFrame;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new TypeError(`${label} must contain resolved operation frames.`);
  }
  return Object.freeze({
    startFrame,
    endFrame,
    easing: typeof operation.easing === "string" ? operation.easing : "smoothstep",
    op: typeof operation.op === "string" ? operation.op : "reveal",
    targetId: typeof operation.targetId === "string" ? operation.targetId : "",
  });
}

function normalizePlan(ir) {
  assertPlainObject(ir, "AnimationIR");
  if (!Number.isInteger(ir.width) || !Number.isInteger(ir.height) || ir.height * 9 !== ir.width * 16) {
    throw new TypeError("Generic semantic animation requires a 9:16 AnimationIR.");
  }
  if (!Number.isInteger(ir.fps) || ir.fps <= 0 || !Number.isInteger(ir.durationFrames) || ir.durationFrames <= 1) {
    throw new TypeError("AnimationIR timing is invalid.");
  }
  assertPlainObject(ir.content, "AnimationIR content");
  const compositionId = assertSafeText(ir.content.compositionId, "Composition id");
  assertPlainObject(ir.content.visualPlan, "Semantic visual plan");
  const plannedScenes = ir.content.visualPlan.scenes;
  if (!Array.isArray(plannedScenes) || plannedScenes.length !== ROLE_ORDER.length) {
    throw new TypeError("Semantic visual plan must contain exactly five scenes.");
  }
  if (!Array.isArray(ir.scenes) || ir.scenes.length === 0) {
    throw new TypeError("AnimationIR scenes are required.");
  }

  const sourceScenes = new Map();
  for (const sourceScene of ir.scenes) {
    assertPlainObject(sourceScene, "AnimationIR source scene");
    if (typeof sourceScene.id !== "string" || sourceScenes.has(sourceScene.id)) {
      throw new TypeError("AnimationIR source scene ids must be unique strings.");
    }
    if (!Number.isInteger(sourceScene.startFrame) || !Number.isInteger(sourceScene.endFrame)
      || sourceScene.startFrame < 0 || sourceScene.endFrame <= sourceScene.startFrame
      || sourceScene.endFrame > ir.durationFrames) {
      throw new TypeError(`AnimationIR source scene ${sourceScene.id} has invalid frame bounds.`);
    }
    if (!Array.isArray(sourceScene.operations)) {
      throw new TypeError(`AnimationIR source scene ${sourceScene.id} operations are required.`);
    }
    sourceScenes.set(sourceScene.id, sourceScene);
  }

  const plansByRole = new Map();
  for (const scenePlan of plannedScenes) {
    assertPlainObject(scenePlan, "Semantic visual scene");
    const role = assertSafeText(scenePlan.role, "Semantic scene role");
    if (!ROLE_SET.has(role) || plansByRole.has(role)) {
      throw new TypeError(`Semantic scene role is invalid or duplicated: ${role}.`);
    }
    if (!ARCHETYPE_SET.has(scenePlan.archetypeId)) {
      throw new TypeError(`Semantic scene archetype is unsupported: ${scenePlan.archetypeId || "missing"}.`);
    }
    const sourceSceneId = assertSafeText(scenePlan.sourceSceneId, `Semantic ${role} source scene id`);
    const sourceScene = sourceScenes.get(sourceSceneId);
    if (!sourceScene) {
      throw new TypeError(`Semantic ${role} source scene is unavailable.`);
    }
    if (!Array.isArray(scenePlan.sourceOperationIndexes)
      || scenePlan.sourceOperationIndexes.some((index) => !Number.isInteger(index) || index < 0 || index > 39)
      || new Set(scenePlan.sourceOperationIndexes).size !== scenePlan.sourceOperationIndexes.length) {
      throw new TypeError(`Semantic ${role} operation indexes are invalid.`);
    }
    if (!Array.isArray(scenePlan.claimIds) || scenePlan.claimIds.some((claimId) => typeof claimId !== "string" || !claimId.trim() || REMOTE_URL.test(claimId))) {
      throw new TypeError(`Semantic ${role} claim ids are invalid.`);
    }

    const selectedOperations = sourceScene.operations
      .map((operation, index) => resolvedOperation(operation, `Semantic ${role} operation ${index}`));
    const operations = selectedOperations.length ? selectedOperations : [Object.freeze({
      startFrame: sourceScene.startFrame,
      endFrame: sourceScene.endFrame,
      easing: "smoothstep",
      op: "scene_reveal",
      targetId: sourceScene.id,
    })];
    const fadeFrames = Math.max(3, Math.min(Math.round(ir.fps * 0.24), Math.floor((sourceScene.endFrame - sourceScene.startFrame) / 4)));
    const geometry = normalizeGeometry(scenePlan.geometry, `Semantic ${role} geometry`);
    const normalized = Object.freeze({
      id: assertSafeText(scenePlan.id, `Semantic ${role} visual state id`),
      role,
      archetypeId: scenePlan.archetypeId,
      heading: assertSafeText(scenePlan.heading, `Semantic ${role} heading`),
      primaryLabel: assertSafeText(scenePlan.primaryLabel, `Semantic ${role} primary label`),
      secondaryLabel: assertSafeText(scenePlan.secondaryLabel, `Semantic ${role} secondary label`, { optional: true }),
      entityKind: assertSafeText(scenePlan.entityKind, `Semantic ${role} entity kind`),
      geometry,
      geometryToken: geometryToken(geometry),
      sourceSceneId,
      sourceOperationIndexes: Object.freeze([...scenePlan.sourceOperationIndexes]),
      beatId: assertSafeText(scenePlan.beatId, `Semantic ${role} beat id`),
      claimIds: Object.freeze(scenePlan.claimIds.map((claimId) => claimId.trim())),
      startFrame: sourceScene.startFrame,
      endFrame: sourceScene.endFrame,
      fadeFrames,
      operations: Object.freeze(operations),
    });
    if (!ENTITY_ID.test(normalized.id)) {
      throw new TypeError(`Semantic ${role} visual state id is invalid.`);
    }
    plansByRole.set(role, normalized);
  }

  return Object.freeze({
    compositionId,
    width: ir.width,
    height: ir.height,
    fps: ir.fps,
    durationFrames: ir.durationFrames,
    kicker: assertSafeText(ir.content.kicker || ir.content.visualPlan.kicker || "DARK CURIOSITY", "Composition kicker"),
    titleLines: Object.freeze((Array.isArray(ir.content.titleLines) && ir.content.titleLines.length
      ? ir.content.titleLines
      : [plansByRole.get("hook").heading]).map((line, index) => assertSafeText(line, `Composition title line ${index}`))),
    stages: Object.freeze(ROLE_ORDER.map((role) => plansByRole.get(role))),
  });
}

function stageMarkup(stage, index) {
  return `<g id="stage-${escapeXml(stage.role)}" class="semantic-stage" opacity="0"
 data-stage-index="${index}"
 data-visual-state-id="${escapeXml(stage.id)}"
 data-role="${escapeXml(stage.role)}"
 data-entity-id="semantic_${escapeXml(stage.role)}"
 data-entity-kind="${escapeXml(stage.entityKind)}"
 data-archetype-id="${escapeXml(stage.archetypeId)}"
	 data-geometry-token="${escapeXml(stage.geometryToken)}"
 data-source-scene-id="${escapeXml(stage.sourceSceneId)}"
 data-source-operation-indexes="${escapeXml(stage.sourceOperationIndexes.join(","))}"
 data-source-beat-id="${escapeXml(stage.beatId)}"
 data-source-claim-ids="${escapeXml(stage.claimIds.join(","))}"
 data-caption-policy="avoid">
 <g class="stage-motion">${archetypeSceneMarkup(stage, stage.role)}</g>
</g>`;
}

export function compileGenericSemanticAnimationIRToHtml(ir) {
  const plan = normalizePlan(ir);
  const compositionIdAttribute = escapeXml(plan.compositionId);
  const titleMarkup = plan.titleLines.slice(0, 2).map((line, index) => (
    `<text x="54" y="${100 + index * 38}" class="composition-title">${escapeXml(line)}</text>`
  )).join("");
  const stagesMarkup = plan.stages.map(stageMarkup).join("\n");
  const runtimeData = safeJson({
    compositionId: plan.compositionId,
    fps: plan.fps,
    durationFrames: plan.durationFrames,
    stages: plan.stages.map((stage) => ({
      id: stage.id,
      role: stage.role,
      archetypeId: stage.archetypeId,
      startFrame: stage.startFrame,
      endFrame: stage.endFrame,
      fadeFrames: stage.fadeFrames,
      operations: stage.operations,
    })),
  });
  const durationSeconds = plan.durationFrames / plan.fps;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta data-composition-id="${compositionIdAttribute}" data-width="${plan.width}" data-height="${plan.height}" data-font-sha256="${FONT_SHA256}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#030712}
*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#030712}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}
.semantic-stage{color:#334155}.stage-motion{transform-box:view-box;transform-origin:360px 540px}
.surface{fill:#0b1527;stroke:#334155;stroke-width:2}.secondary-surface{fill:#13233a;stroke:#334155;stroke-width:1.5}.warm-surface{fill:#422006;stroke:#f59e0b;stroke-width:2}.cool-surface{fill:#083344;stroke:#22d3ee;stroke-width:2}
.thin-line{fill:none;stroke:#334155;stroke-width:2}.muted-stroke{fill:none;stroke:#475569;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.cool-stroke{fill:none;stroke:#22d3ee;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}.warm-stroke{fill:none;stroke:#f59e0b;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}.signal-stroke{fill:none;stroke:#67e8f9;stroke-width:7;stroke-linecap:round;stroke-linejoin:round}.route-stroke{fill:none;stroke:#fbbf24;stroke-width:6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:10 12}
.bright-fill{fill:#ecfeff}.cool-fill{fill:#22d3ee}.warm-fill{fill:#f59e0b}.muted-fill{fill:#64748b}.accent-fill{fill:#22d3ee}.beacon-fill{fill:#fbbf24;fill-opacity:.16;stroke:#fbbf24;stroke-width:2}
.node{stroke-width:2}.clock-hand{stroke-width:7;stroke-linecap:round}.semantic-emphasis{filter:url(#soft-glow)}
.composition-kicker{fill:#67e8f9;font-size:17px;letter-spacing:4px}.composition-title{fill:#e2e8f0;font-size:30px}.role-label{fill:#67e8f9;font-size:15px;letter-spacing:4px}.scene-heading{fill:#f8fafc;font-size:34px}.primary-label{fill:#fde68a;font-size:32px}.secondary-label{fill:#cbd5e1;font-size:24px}.micro-label{fill:#cbd5e1;font-size:24px;letter-spacing:.4px}.verdict-glyph{fill:#fde68a;font-size:68px}.verdict-primary{fill:#f8fafc;font-size:32px}.verdict-secondary{fill:#cbd5e1;font-size:24px}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${compositionIdAttribute}" data-start="0" data-duration="${durationSeconds}" data-width="${plan.width}" data-height="${plan.height}">
<svg viewBox="0 0 ${BASE_WIDTH} ${BASE_HEIGHT}" role="img" aria-label="${escapeXml(plan.titleLines.join(" "))}">
<defs>
 <radialGradient id="generic-bg" cx="50%" cy="30%" r="86%"><stop offset="0" stop-color="#13233a"/><stop offset=".56" stop-color="#07111f"/><stop offset="1" stop-color="#030712"/></radialGradient>
 <linearGradient id="caption-scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#030712" stop-opacity="0"/><stop offset=".34" stop-color="#030712" stop-opacity=".48"/><stop offset="1" stop-color="#030712" stop-opacity=".88"/></linearGradient>
 <filter id="soft-glow" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="3.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${BASE_WIDTH}" height="${BASE_HEIGHT}" fill="url(#generic-bg)"/>
<g id="ambient-grid" opacity=".22" data-qa-layer="ambient">
 ${Array.from({ length: 14 }, (_, index) => `<line x1="${52 + index * 48}" y1="180" x2="${52 + index * 48}" y2="900" class="thin-line"/>`).join("")}
 ${Array.from({ length: 16 }, (_, index) => `<line x1="48" y1="${184 + index * 46}" x2="672" y2="${184 + index * 46}" class="thin-line"/>`).join("")}
</g>
<rect x="48" y="180" width="624" height="720" fill="none" data-semantic-roi="true" data-geometry-audit="semantic-roi" pointer-events="none"/>
<g id="composition-header" data-entity-id="semantic_header" data-caption-policy="avoid">
 <text x="54" y="56" class="composition-kicker">${escapeXml(plan.kicker)}</text>${titleMarkup}
</g>
<g id="semantic-stage-stack">${stagesMarkup}</g>
<g id="story-evidence" data-entity-id="story_evidence" data-persistent-entity="true"
 data-visual-state-id="${escapeXml(plan.stages[0].id)}" data-representation-id="${escapeXml(plan.stages[0].archetypeId)}"
 data-active-transition-id="none" data-caption-policy="avoid">
 <path id="story-evidence-path" data-persistent-path="true" d="M120 856 L600 856" class="muted-stroke"/>
 <circle id="story-evidence-marker" data-follow-path-id="story-evidence-path" cx="120" cy="856" r="10" class="bright-fill semantic-emphasis"/>
</g>
<g id="semantic-progress" data-entity-id="semantic_progress" data-caption-policy="avoid">
 <line x1="84" y1="906" x2="636" y2="906" class="muted-stroke"/>
 <line id="semantic-progress-active" x1="84" y1="906" x2="84" y2="906" class="cool-stroke"/>
 <circle id="semantic-progress-cursor" cx="84" cy="906" r="9" class="bright-fill semantic-emphasis"/>
</g>
<rect x="0" y="948" width="720" height="332" fill="url(#caption-scrim)" data-caption-safe-zone="true" pointer-events="none"/>
</svg></main>
<script>
"use strict";
const DATA=${runtimeData};
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const ease=(value,name)=>{const x=clamp(value);if(name==="linear")return x;if(name==="ease_in_cubic")return x*x*x;if(name==="ease_out_cubic")return 1-Math.pow(1-x,3);if(name==="ease_in_out_cubic")return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;return x*x*(3-2*x)};
const operationProgress=(frame,operation)=>ease((frame-operation.startFrame)/Math.max(1,operation.endFrame-operation.startFrame),operation.easing);
const channelProgress=(frame,stage,op,fallback)=>{const operations=stage.operations.filter((operation)=>operation.op===op);return operations.length?Math.max(...operations.map((operation)=>operationProgress(frame,operation))):fallback};
const stageElements=DATA.stages.map((stage)=>document.getElementById("stage-"+stage.role));
const drawPaths=stageElements.map((element)=>Array.from(element.querySelectorAll(".semantic-draw-path")));
const highlightNodes=stageElements.map((element)=>Array.from(element.querySelectorAll(".semantic-emphasis,[data-legibility-role]")));
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(Number(rawFrame)||0)));
 const channelStates=DATA.stages.map((stage)=>{
  const sceneReveal=ease((frame-stage.startFrame)/stage.fadeFrames,"smoothstep");
  return {
   sceneReveal,
   morphPath:channelProgress(frame,stage,"morph_path",sceneReveal),
   drawPath:channelProgress(frame,stage,"draw_path",sceneReveal),
   highlight:channelProgress(frame,stage,"highlight",sceneReveal),
  };
 });
 DATA.stages.forEach((stage,index)=>{
  const channels=channelStates[index];
  const element=stageElements[index],enter=ease((frame-stage.startFrame)/stage.fadeFrames,"smoothstep");
  const exit=stage.endFrame>=DATA.durationFrames?1:1-ease((frame-(stage.endFrame-stage.fadeFrames))/stage.fadeFrames,"smoothstep");
  const sceneWindow=clamp(enter*exit),opacity=sceneWindow;
  element.setAttribute("opacity",opacity.toFixed(4));
  element.style.pointerEvents=opacity>.01?"auto":"none";
  element.dataset.sceneRevealProgress=channels.sceneReveal.toFixed(4);
  element.dataset.morphPathProgress=channels.morphPath.toFixed(4);
  element.dataset.drawPathProgress=channels.drawPath.toFixed(4);
  element.dataset.highlightProgress=channels.highlight.toFixed(4);
  const motion=element.querySelector(".stage-motion"),lift=18*(1-channels.sceneReveal),scale=.975+.025*channels.sceneReveal;
  motion.setAttribute("transform","translate(0 "+lift.toFixed(3)+") scale("+scale.toFixed(5)+")");
  drawPaths[index].forEach((path)=>{path.style.strokeDasharray="1000";path.style.strokeDashoffset=String(1000*(1-channels.drawPath));});
  highlightNodes[index].forEach((node)=>node.setAttribute("opacity",channels.highlight.toFixed(4)));
 });
 const containingStageIndex=DATA.stages.findIndex((stage)=>frame>=stage.startFrame&&frame<stage.endFrame);
 const activeIndex=containingStageIndex>=0?containingStageIndex:DATA.stages.reduce((selected,stage,index)=>frame>=stage.startFrame?index:selected,0);
 const activeStage=DATA.stages[activeIndex]||DATA.stages[0];
 const activeChannels=channelStates[activeIndex]||channelStates[0];
 const persistent=document.getElementById("story-evidence"),evidenceProgress=clamp((activeIndex+activeChannels.morphPath)/DATA.stages.length);
 persistent.dataset.visualStateId=activeStage.id;persistent.dataset.representationId=activeStage.archetypeId;persistent.dataset.activeTransitionId="none";
 persistent.dataset.morphPathProgress=activeChannels.morphPath.toFixed(4);
 document.getElementById("story-evidence-marker").setAttribute("cx",(120+480*evidenceProgress).toFixed(3));
 document.documentElement.dataset.activeVisualStateId=activeStage.id;
 document.documentElement.dataset.activeStateTransitionId="none";
 const totalProgress=clamp(frame/Math.max(1,DATA.durationFrames-1)),cursorX=84+552*totalProgress;
 document.getElementById("semantic-progress-active").setAttribute("x2",cursorX.toFixed(3));
 document.getElementById("semantic-progress-cursor").setAttribute("cx",cursorX.toFixed(3));
 document.documentElement.dataset.renderedFrame=String(frame);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]},renderFrame};
window.__timelines=window.__timelines||{};
window.__timelines[${safeJson(plan.compositionId)}]=timeline;
window.__renderFrame=renderFrame;
renderFrame(0);
</script></body></html>`;

  return Object.freeze({
    html,
    compositionHash: createHash("sha256").update(html).digest("hex"),
    font: Object.freeze({
      family: FONT_FAMILY,
      sha256: FONT_SHA256,
      license: FONT_LICENSE,
      sourcePackage: "@fontsource/outfit",
    }),
  });
}
