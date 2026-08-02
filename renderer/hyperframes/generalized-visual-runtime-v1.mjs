import { createHash } from "node:crypto";

const SUPPORTED_OPERATIONS = Object.freeze([
  "create",
  "fade",
  "move",
  "scale",
  "draw_path",
  "morph_path",
  "highlight",
  "pulse",
  "transition_match",
]);
const SUPPORTED_OPERATION_SET = new Set(SUPPORTED_OPERATIONS);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function phaseProgress(phase, frame) {
  return clamp((frame - phase.startFrame) / Math.max(1, phase.endFrame - phase.startFrame));
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function frameStateHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function operationWindow(operation) {
  if (!SUPPORTED_OPERATION_SET.has(operation.op)) {
    throw new TypeError("Generalized visual operation is unsupported.");
  }
  return {
    op: operation.op,
    targetId: operation.targetId,
    startFrame: operation.from.resolvedFrame,
    endFrame: operation.to.resolvedFrame,
    easing: operation.easing,
  };
}

export function createGeneralizedVisualRuntimeData(adapter) {
  const plan = adapter.visualRecipePlan;
  if (!plan || !Array.isArray(plan.scenes) || !Array.isArray(adapter.animationIR?.scenes)) {
    throw new TypeError("Validated generalized visual adapter is required.");
  }
  if (plan.scenes.length !== adapter.animationIR.scenes.length) {
    throw new TypeError("Generalized visual scene bindings are inconsistent.");
  }
  return Object.freeze({
    fps: plan.duration.fps,
    durationFrames: plan.duration.totalFrames,
    compositionId: adapter.animationIR.content.compositionId,
    scenes: Object.freeze(plan.scenes.map((scene, index) => Object.freeze({
      id: scene.id,
      recipeId: scene.recipeId,
      phases: scene.phases,
      startFrame: scene.phases[0].startFrame,
      endFrame: scene.phases.at(-1).endFrame,
      operations: Object.freeze(adapter.animationIR.scenes[index].operations.map(operationWindow)),
    }))),
  });
}

export function resolveGeneralizedVisualFrameState(runtimeData, rawFrame) {
  if (!Number.isFinite(rawFrame)) throw new TypeError("Render frame is invalid.");
  const frame = Math.max(0, Math.min(runtimeData.durationFrames - 1, Math.floor(rawFrame + 1e-7)));
  const sceneIndex = runtimeData.scenes.findIndex((scene) => frame >= scene.startFrame && frame < scene.endFrame);
  const scene = runtimeData.scenes[Math.max(0, sceneIndex)];
  const phase = scene.phases.find((candidate) => frame >= candidate.startFrame && frame < candidate.endFrame)
    || scene.phases.at(-1);
  const index = scene.phases.indexOf(phase);
  const local = phaseProgress(phase, frame);
  const pathProgress = index < 1 ? 0 : index === 1 ? local : 1;
  const revealProgress = index < 2 ? 0 : index === 2 ? local : 1;
  const resolveProgress = index < 3 ? 0 : index === 3 ? local : 1;
  const opacity = index === 0 ? local : 1;
  const activeOperations = phase.id === "hold"
    ? []
    : scene.operations.filter((operation) => frame >= operation.startFrame && frame < operation.endFrame);
  if (activeOperations.length > 2) throw new TypeError("Generalized visual motion budget was exceeded.");
  const state = {
    frame,
    sceneId: scene.id,
    sceneIndex: Math.max(0, sceneIndex),
    recipeId: scene.recipeId,
    phaseId: phase.id,
    phaseProgress: Number(local.toFixed(6)),
    opacity: Number(opacity.toFixed(6)),
    pathProgress: Number(pathProgress.toFixed(6)),
    revealProgress: Number(revealProgress.toFixed(6)),
    resolveProgress: Number(resolveProgress.toFixed(6)),
    activeMotionCount: activeOperations.length,
    activeOperations: activeOperations.map((operation) => `${operation.op}:${operation.targetId}`).sort(),
  };
  return Object.freeze({ ...state, stateHash: frameStateHash(state) });
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function generalizedVisualRuntimeScript(runtimeData) {
  return `"use strict";
const DATA=${safeJson(runtimeData)};
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const progress=(phase,frame)=>clamp((frame-phase.startFrame)/Math.max(1,phase.endFrame-phase.startFrame));
const stateAt=(rawFrame)=>{
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor((Number(rawFrame)||0)+1e-7)));
 const sceneIndex=Math.max(0,DATA.scenes.findIndex((scene)=>frame>=scene.startFrame&&frame<scene.endFrame));
 const scene=DATA.scenes[sceneIndex];
 const phase=scene.phases.find((candidate)=>frame>=candidate.startFrame&&frame<candidate.endFrame)||scene.phases[scene.phases.length-1];
 const index=scene.phases.indexOf(phase),local=progress(phase,frame);
 const activeOperations=phase.id==="hold"?[]:scene.operations.filter((operation)=>frame>=operation.startFrame&&frame<operation.endFrame);
 if(activeOperations.length>2)throw new Error("motion_budget_exceeded");
 return {frame,scene,sceneIndex,phase,local,opacity:index===0?local:1,pathProgress:index<1?0:index===1?local:1,revealProgress:index<2?0:index===2?local:1,resolveProgress:index<3?0:index===3?local:1,activeOperations};
};
function renderFrame(rawFrame){
 const state=stateAt(rawFrame);
 document.querySelectorAll("[data-visual-scene]").forEach((node,index)=>{
  const active=index===state.sceneIndex;
  node.setAttribute("opacity",active?"1":"0");
  node.style.pointerEvents=active?"auto":"none";
  if(!active)return;
  const stage=node.querySelector("[data-motion-stage]");
  const lift=state.phase.id==="enter"?24*(1-state.opacity):0;
  stage.setAttribute("opacity",state.opacity.toFixed(4));
  stage.setAttribute("transform","translate(0 "+lift.toFixed(3)+")");
  node.querySelectorAll("[data-draw-path]").forEach((path)=>{path.style.strokeDasharray="100";path.style.strokeDashoffset=String(100*(1-state.pathProgress))});
  node.querySelectorAll('[data-reveal="reveal"]').forEach((element)=>element.setAttribute("opacity",state.revealProgress.toFixed(4)));
  node.querySelectorAll('[data-reveal="resolve"]').forEach((element)=>element.setAttribute("opacity",state.resolveProgress.toFixed(4)));
  node.dataset.activePhase=state.phase.id;
  node.dataset.phaseProgress=state.local.toFixed(6);
 });
 document.documentElement.dataset.renderedFrame=String(state.frame);
 document.documentElement.dataset.activeVisualSceneId=state.scene.id;
 document.documentElement.dataset.activeRecipeId=state.scene.recipeId;
 document.documentElement.dataset.activePhaseId=state.phase.id;
 document.documentElement.dataset.activeMotionCount=String(state.activeOperations.length);
 document.documentElement.dataset.holdMotionFree=String(state.phase.id!=="hold"||state.activeOperations.length===0);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]},renderFrame};
window.__timelines=window.__timelines||{};window.__timelines[DATA.compositionId]=timeline;window.__renderFrame=renderFrame;renderFrame(0);`;
}

export function listSupportedGeneralizedVisualOperations() {
  return SUPPORTED_OPERATIONS;
}
