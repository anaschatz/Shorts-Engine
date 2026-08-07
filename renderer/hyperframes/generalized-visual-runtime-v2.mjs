import { createHash } from "node:crypto";

import {
  GENERALIZED_VISUAL_STYLE_V2,
} from "./generalized-visual-style-v2.mjs";

export const GENERALIZED_VISUAL_RUNTIME_V2_PROFILE_ID = "generalized_visual_target_runtime_v2";
export const GENERALIZED_VISUAL_RUNTIME_V2_VERSION = "2.0.0";
export const GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2 = 8;

const SUPPORTED_OPERATIONS = Object.freeze([
  "reveal",
  "draw",
  "focus",
  "state_change",
  "occlude_to_absent",
  "supersede_hypothesis",
  "co_move",
  "mark_last_known",
  "reject_hypothesis",
  "unresolved_boundary",
  "empty_occupancy",
  "propagate_carry",
]);
const SUPPORTED_OPERATION_SET = new Set(SUPPORTED_OPERATIONS);
const SUPPORTED_TARGET_KINDS = new Set(["entity", "relation"]);
const SUPPORTED_EASINGS = new Set(["ease_out_cubic"]);
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,119}$/;

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function integer(value, field, minimum = 0, maximum = 10_000_000) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function identifier(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeOutCubic(value) {
  const progress = clamp(value);
  return 1 - ((1 - progress) ** 3);
}

function smoothStep(value) {
  const progress = clamp(value);
  return progress * progress * (3 - (2 * progress));
}

function trackProgress(track, frame) {
  if (frame < track.startFrame) return 0;
  if (frame >= track.endFrame) return 1;
  return easeOutCubic(
    (frame - track.startFrame) / Math.max(1, track.endFrame - track.startFrame),
  );
}

function focusEnvelope(track, frame) {
  if (frame < track.startFrame || frame >= track.endFrame) return 0;
  const local = (frame - track.startFrame) / Math.max(1, track.endFrame - track.startFrame);
  if (local < 0.25) return easeOutCubic(local / 0.25);
  if (local > 0.75) return easeOutCubic((1 - local) / 0.25);
  return 1;
}

function stateChangePulse(track, frame) {
  if (frame < track.startFrame || frame >= track.endFrame) return 0;
  const progress = (frame - track.startFrame) / Math.max(1, track.endFrame - track.startFrame);
  return Math.sin(Math.PI * clamp(progress));
}

function normalizeTrack(rawTrack, scene, targetIds, index) {
  if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) {
    throw new TypeError(`scene.${scene.id}.tracks[${index}] is invalid.`);
  }
  const id = identifier(rawTrack.id, `scene.${scene.id}.tracks[${index}].id`);
  const targetKind = rawTrack.targetKind;
  const operation = rawTrack.operation ?? rawTrack.op;
  const targetId = identifier(rawTrack.targetId, `track.${id}.targetId`);
  const startFrame = integer(
    rawTrack.startFrame ?? rawTrack.from?.resolvedFrame,
    `track.${id}.startFrame`,
    scene.startFrame,
    scene.endFrame - 1,
  );
  const endFrame = integer(
    rawTrack.endFrame ?? rawTrack.to?.resolvedFrame,
    `track.${id}.endFrame`,
    startFrame + 1,
    scene.endFrame,
  );
  if (!SUPPORTED_TARGET_KINDS.has(targetKind)) {
    throw new TypeError(`track.${id}.targetKind is unsupported.`);
  }
  if (!SUPPORTED_OPERATION_SET.has(operation)) {
    throw new TypeError(`track.${id}.operation is unsupported.`);
  }
  if (!targetIds[targetKind].has(targetId)) {
    throw new TypeError(`track.${id}.targetId is not present in its scene.`);
  }
  const easing = rawTrack.easing ?? "ease_out_cubic";
  if (!SUPPORTED_EASINGS.has(easing)) {
    throw new TypeError(`track.${id}.easing is unsupported.`);
  }
  return {
    id,
    targetKind,
    targetId,
    operation,
    startFrame,
    endFrame,
    easing,
    order: integer(rawTrack.order ?? index, `track.${id}.order`, 0, 10_000),
  };
}

function assertMotionBudget(scene, maximum) {
  const boundaries = scene.tracks.flatMap((track) => [
    { frame: track.startFrame, delta: 1 },
    { frame: track.endFrame, delta: -1 },
  ]).sort((left, right) => (
    left.frame - right.frame || left.delta - right.delta
  ));
  let active = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    if (active > maximum) {
      throw new TypeError(`scene.${scene.id} exceeds the simultaneous-motion budget.`);
    }
  }
}

function normalizeScene(rawScene, index, totalFrames) {
  if (!rawScene || typeof rawScene !== "object" || Array.isArray(rawScene)) {
    throw new TypeError(`scenes[${index}] is invalid.`);
  }
  const id = identifier(rawScene.id, `scenes[${index}].id`);
  const startFrame = integer(rawScene.startFrame, `scene.${id}.startFrame`, 0, totalFrames - 1);
  const endFrame = integer(rawScene.endFrame, `scene.${id}.endFrame`, startFrame + 1, totalFrames);
  if (!Array.isArray(rawScene.entities) || !Array.isArray(rawScene.relations) || !Array.isArray(rawScene.tracks)) {
    throw new TypeError(`scene.${id} target collections are invalid.`);
  }
  const entityIds = rawScene.entities.map((entity, entityIndex) => (
    identifier(entity?.id, `scene.${id}.entities[${entityIndex}].id`)
  ));
  const relationIds = rawScene.relations.map((relation, relationIndex) => (
    identifier(relation?.id, `scene.${id}.relations[${relationIndex}].id`)
  ));
  if (new Set(entityIds).size !== entityIds.length || new Set(relationIds).size !== relationIds.length) {
    throw new TypeError(`scene.${id} contains duplicate target ids.`);
  }
  const targetIds = {
    entity: new Set(entityIds),
    relation: new Set(relationIds),
  };
  const scene = { id, startFrame, endFrame };
  const tracks = rawScene.tracks
    .map((track, trackIndex) => normalizeTrack(track, scene, targetIds, trackIndex))
    .sort((left, right) => (
      left.startFrame - right.startFrame
      || left.order - right.order
      || left.id.localeCompare(right.id)
    ));
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length) {
    throw new TypeError(`scene.${id} contains duplicate track ids.`);
  }
  for (const targetId of [...entityIds, ...relationIds]) {
    for (const operation of ["reveal", "draw"]) {
      if (tracks.filter((track) => track.targetId === targetId && track.operation === operation).length > 1) {
        throw new TypeError(`scene.${id} repeats a persistent ${operation} track for ${targetId}.`);
      }
    }
  }
  const maximumSimultaneousMotion = integer(
    rawScene.layout?.constraints?.maximumSimultaneousMotion
      ?? GENERALIZED_VISUAL_STYLE_V2.motion.maximumSimultaneousOperations,
    `scene.${id}.layout.constraints.maximumSimultaneousMotion`,
    1,
    GENERALIZED_VISUAL_STYLE_V2.motion.maximumSimultaneousOperations,
  );
  const minimumSettledHoldFrames = integer(
    rawScene.layout?.constraints?.minimumSettledHoldFrames
      ?? GENERALIZED_VISUAL_STYLE_V2.motion.minimumSettledHoldFrames,
    `scene.${id}.layout.constraints.minimumSettledHoldFrames`,
    0,
    endFrame - startFrame,
  );
  const latestMotionFrame = tracks.reduce((latest, track) => Math.max(latest, track.endFrame), startFrame);
  if (endFrame - latestMotionFrame < minimumSettledHoldFrames) {
    throw new TypeError(`scene.${id} does not preserve its required settled hold.`);
  }
  const normalized = {
    id,
    startFrame,
    endFrame,
    focusEntityId: rawScene.focusEntityId || null,
    entityIds,
    relationIds,
    targets: [
      ...entityIds.map((targetId) => ({ targetKind: "entity", targetId })),
      ...relationIds.map((targetId) => ({ targetKind: "relation", targetId })),
    ],
    tracks,
    maximumSimultaneousMotion,
    minimumSettledHoldFrames,
  };
  assertMotionBudget(normalized, maximumSimultaneousMotion);
  return normalized;
}

function compositionIdFor(plan) {
  const sourceHash = typeof plan.contentHash === "string" && /^[a-f0-9]{64}$/.test(plan.contentHash)
    ? plan.contentHash
    : createHash("sha256").update(canonical(plan)).digest("hex");
  return `gv2_${sourceHash.slice(0, 20)}`;
}

export function createGeneralizedVisualRuntimeDataV2(rawPlan) {
  if (
    !rawPlan
    || typeof rawPlan !== "object"
    || rawPlan.schemaVersion !== 2
    || rawPlan.profile !== "generalized_visual_program_v2"
  ) throw new TypeError("Compiled generalized visual program v2 is required.");
  const fps = integer(rawPlan.duration?.fps, "duration.fps", 1, 120);
  if (fps !== GENERALIZED_VISUAL_STYLE_V2.canvas.fps) {
    throw new TypeError("Generalized visual runtime frame rate is unsupported.");
  }
  const durationFrames = integer(rawPlan.duration?.totalFrames, "duration.totalFrames", 1, 10_000_000);
  if (!Array.isArray(rawPlan.scenes) || !rawPlan.scenes.length || rawPlan.scenes.length > 64) {
    throw new TypeError("Generalized visual scenes are invalid.");
  }
  const scenes = rawPlan.scenes.map((scene, index) => normalizeScene(scene, index, durationFrames));
  if (new Set(scenes.map((scene) => scene.id)).size !== scenes.length) {
    throw new TypeError("Generalized visual scene ids are not unique.");
  }
  scenes.forEach((scene, index) => {
    const expectedStart = index ? scenes[index - 1].endFrame : 0;
    if (scene.startFrame !== expectedStart) {
      throw new TypeError("Generalized visual scene clock is not continuous.");
    }
  });
  if (scenes.at(-1).endFrame !== durationFrames) {
    throw new TypeError("Generalized visual scene clock does not cover the composition.");
  }
  return deepFreeze({
    profile: GENERALIZED_VISUAL_RUNTIME_V2_PROFILE_ID,
    version: GENERALIZED_VISUAL_RUNTIME_V2_VERSION,
    fps,
    durationFrames,
    compositionId: compositionIdFor(rawPlan),
    programHash: rawPlan.contentHash || null,
    scenes,
  });
}

function stateForTarget(scene, target, frame) {
  const tracks = scene.tracks.filter((track) => track.targetId === target.targetId);
  const tracksFor = (operation) => tracks.filter((track) => track.operation === operation);
  const revealTracks = tracksFor("reveal");
  const drawTracks = tracksFor("draw");
  const focusTracks = tracksFor("focus");
  const changeTracks = tracksFor("state_change");
  const absenceTracks = tracksFor("occlude_to_absent");
  const supersedeTracks = tracksFor("supersede_hypothesis");
  const coMoveTracks = tracksFor("co_move");
  const markTracks = tracksFor("mark_last_known");
  const rejectTracks = tracksFor("reject_hypothesis");
  const unresolvedTracks = tracksFor("unresolved_boundary");
  const emptyTracks = tracksFor("empty_occupancy");
  const carryTracks = tracksFor("propagate_carry");
  const activeOperations = tracks
    .filter((track) => frame >= track.startFrame && frame < track.endFrame)
    .map((track) => track.operation)
    .sort();
  const revealProgress = revealTracks.length
    ? Math.max(...revealTracks.map((track) => trackProgress(track, frame)))
    : 1;
  const drawProgress = drawTracks.length
    ? Math.max(...drawTracks.map((track) => trackProgress(track, frame)))
    : 1;
  const focusIntensity = focusTracks.length
    ? Math.max(...focusTracks.map((track) => focusEnvelope(track, frame)))
    : 0;
  const stateChangeIntensity = changeTracks.length
    ? Math.max(...changeTracks.map((track) => stateChangePulse(track, frame)))
    : 0;
  return {
    targetKind: target.targetKind,
    targetId: target.targetId,
    opacity: Number(revealProgress.toFixed(6)),
    revealProgress: Number(revealProgress.toFixed(6)),
    drawProgress: Number(drawProgress.toFixed(6)),
    focusIntensity: Number(focusIntensity.toFixed(6)),
    stateChangeIntensity: Number(stateChangeIntensity.toFixed(6)),
    stateRevision: changeTracks.filter((track) => frame >= track.endFrame).length,
    absenceProgress: Number((absenceTracks.length ? Math.max(...absenceTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    supersedeProgress: Number((supersedeTracks.length ? Math.max(...supersedeTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    coMoveProgress: Number((coMoveTracks.length ? Math.max(...coMoveTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    markProgress: Number((markTracks.length ? Math.max(...markTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    rejectionProgress: Number((rejectTracks.length ? Math.max(...rejectTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    unresolvedProgress: Number((unresolvedTracks.length ? Math.max(...unresolvedTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    emptyProgress: Number((emptyTracks.length ? Math.max(...emptyTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    carryProgress: Number((carryTracks.length ? Math.max(...carryTracks.map((track) => trackProgress(track, frame))) : 0).toFixed(6)),
    activeOperations,
  };
}

export function resolveGeneralizedVisualFrameStateV2(runtimeData, rawFrame) {
  if (!Number.isFinite(rawFrame)) throw new TypeError("Render frame is invalid.");
  const frame = Math.max(0, Math.min(
    runtimeData.durationFrames - 1,
    Math.floor(rawFrame + 1e-7),
  ));
  const sceneIndex = runtimeData.scenes.findIndex((scene) => (
    frame >= scene.startFrame && frame < scene.endFrame
  ));
  if (sceneIndex < 0) throw new TypeError("Render frame is outside the scene clock.");
  const scene = runtimeData.scenes[sceneIndex];
  const activeTracks = scene.tracks.filter((track) => (
    frame >= track.startFrame && frame < track.endFrame
  ));
  if (activeTracks.length > scene.maximumSimultaneousMotion) {
    throw new TypeError("Generalized visual motion budget was exceeded.");
  }
  const targetStates = scene.targets.map((target) => stateForTarget(scene, target, frame));
  const maximumFocus = targetStates.reduce((maximum, target) => (
    Math.max(maximum, target.focusIntensity)
  ), 0);
  const focusedIds = new Set(targetStates
    .filter((target) => target.focusIntensity > 0)
    .map((target) => target.targetId));
  const boundaryOffset = frame - scene.startFrame;
  const transitionActive = sceneIndex > 0
    && boundaryOffset < GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2;
  const transitionProgress = transitionActive
    ? smoothStep(boundaryOffset / Math.max(1, GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2 - 1))
    : 1;
  const state = {
    frame,
    sceneId: scene.id,
    sceneIndex,
    sceneProgress: Number(((frame - scene.startFrame) / Math.max(1, scene.endFrame - scene.startFrame)).toFixed(6)),
    activeMotionCount: activeTracks.length,
    activeOperations: activeTracks
      .map((track) => `${track.operation}:${track.targetKind}:${track.targetId}`)
      .sort(),
    targetStates: targetStates.map((target) => ({
      ...target,
      dimFactor: Number((focusedIds.has(target.targetId) ? 1 : 1 - (0.48 * maximumFocus)).toFixed(6)),
    })),
    transition: transitionActive ? {
      active: true,
      durationFrames: GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2,
      outgoingSceneId: runtimeData.scenes[sceneIndex - 1].id,
      incomingSceneId: scene.id,
      progress: Number(transitionProgress.toFixed(6)),
      sceneOpacities: [
        { sceneId: runtimeData.scenes[sceneIndex - 1].id, opacity: Number((1 - transitionProgress).toFixed(6)) },
        { sceneId: scene.id, opacity: Number(transitionProgress.toFixed(6)) },
      ],
    } : {
      active: false,
      durationFrames: GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2,
      outgoingSceneId: null,
      incomingSceneId: scene.id,
      progress: 1,
      sceneOpacities: [{ sceneId: scene.id, opacity: 1 }],
    },
    settled: activeTracks.length === 0,
  };
  return deepFreeze({
    ...state,
    stateHash: createHash("sha256").update(canonical(state)).digest("hex"),
  });
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function generalizedVisualRuntimeScriptV2(runtimeData) {
  return `"use strict";
const DATA=${safeJson(runtimeData)};
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const easeOut=(value)=>1-Math.pow(1-clamp(value),3);
const smoothStep=(value)=>{const progress=clamp(value);return progress*progress*(3-2*progress)};
const CROSSFADE_FRAMES=${GENERALIZED_VISUAL_SCENE_CROSSFADE_FRAMES_V2};
const progress=(track,frame)=>frame<track.startFrame?0:frame>=track.endFrame?1:easeOut((frame-track.startFrame)/Math.max(1,track.endFrame-track.startFrame));
const focus=(track,frame)=>{if(frame<track.startFrame||frame>=track.endFrame)return 0;const local=(frame-track.startFrame)/Math.max(1,track.endFrame-track.startFrame);return local<.25?easeOut(local/.25):local>.75?easeOut((1-local)/.25):1};
const pulse=(track,frame)=>frame<track.startFrame||frame>=track.endFrame?0:Math.sin(Math.PI*clamp((frame-track.startFrame)/Math.max(1,track.endFrame-track.startFrame)));
function targetState(scene,target,frame){
 const tracks=scene.tracks.filter((track)=>track.targetId===target.targetId),by=(operation)=>tracks.filter((track)=>track.operation===operation);
 const reveal=by("reveal"),draw=by("draw"),focusTracks=by("focus"),changes=by("state_change"),absence=by("occlude_to_absent"),supersede=by("supersede_hypothesis"),coMove=by("co_move"),mark=by("mark_last_known"),reject=by("reject_hypothesis"),unresolved=by("unresolved_boundary"),empty=by("empty_occupancy"),carry=by("propagate_carry");
 const revealProgress=reveal.length?Math.max(...reveal.map((track)=>progress(track,frame))):1;
 const drawProgress=draw.length?Math.max(...draw.map((track)=>progress(track,frame))):1;
 const lasting=(items)=>items.length?Math.max(...items.map((track)=>progress(track,frame))):0;
 return {targetKind:target.targetKind,targetId:target.targetId,opacity:revealProgress,revealProgress,drawProgress,focusIntensity:focusTracks.length?Math.max(...focusTracks.map((track)=>focus(track,frame))):0,stateChangeIntensity:changes.length?Math.max(...changes.map((track)=>pulse(track,frame))):0,stateRevision:changes.filter((track)=>frame>=track.endFrame).length,absenceProgress:lasting(absence),supersedeProgress:lasting(supersede),coMoveProgress:lasting(coMove),markProgress:lasting(mark),rejectionProgress:lasting(reject),unresolvedProgress:lasting(unresolved),emptyProgress:lasting(empty),carryProgress:lasting(carry),activeOperations:tracks.filter((track)=>frame>=track.startFrame&&frame<track.endFrame).map((track)=>track.operation).sort()};
}
function stateAt(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor((Number(rawFrame)||0)+1e-7)));
 const sceneIndex=DATA.scenes.findIndex((scene)=>frame>=scene.startFrame&&frame<scene.endFrame);
 if(sceneIndex<0)throw new Error("frame_outside_scene_clock");
 const scene=DATA.scenes[sceneIndex],activeTracks=scene.tracks.filter((track)=>frame>=track.startFrame&&frame<track.endFrame);
 if(activeTracks.length>scene.maximumSimultaneousMotion)throw new Error("motion_budget_exceeded");
 const targets=scene.targets.map((target)=>targetState(scene,target,frame)),maximumFocus=targets.reduce((maximum,target)=>Math.max(maximum,target.focusIntensity),0),focused=new Set(targets.filter((target)=>target.focusIntensity>0).map((target)=>target.targetId));
 targets.forEach((target)=>{target.dimFactor=focused.has(target.targetId)?1:1-.48*maximumFocus});
 const offset=frame-scene.startFrame,transitionActive=sceneIndex>0&&offset<CROSSFADE_FRAMES,transitionProgress=transitionActive?smoothStep(offset/Math.max(1,CROSSFADE_FRAMES-1)):1;
 const visualScenes=[{scene,sceneIndex,opacity:transitionProgress,targets}];
 if(transitionActive){const outgoing=DATA.scenes[sceneIndex-1],outgoingFrame=outgoing.endFrame-1;visualScenes.unshift({scene:outgoing,sceneIndex:sceneIndex-1,opacity:1-transitionProgress,targets:outgoing.targets.map((target)=>({...targetState(outgoing,target,outgoingFrame),dimFactor:1}))})}
 return {frame,scene,sceneIndex,activeTracks,targets,visualScenes,transition:{active:transitionActive,progress:transitionProgress}};
}
function renderFrame(rawFrame){
 const state=stateAt(rawFrame);
 document.querySelectorAll("[data-visual-scene]").forEach((sceneNode,index)=>{
  const visual=state.visualScenes.find((entry)=>entry.sceneIndex===index),active=Boolean(visual);
  sceneNode.setAttribute("opacity",active?visual.opacity.toFixed(4):"0");sceneNode.style.pointerEvents=index===state.sceneIndex?"auto":"none";
  if(!active)return;
  const targetById=new Map(visual.targets.map((target)=>[target.targetId,target]));
  sceneNode.querySelectorAll("[data-motion-target]").forEach((node)=>{
   const target=targetById.get(node.dataset.motionTarget);if(!target)return;
   const lift=target.targetKind==="entity"?28*(1-target.revealProgress):0;
   const semanticX=target.targetKind==="entity"?92*target.coMoveProgress:0;
   const semanticY=target.targetKind==="entity"?-12*Math.sin(Math.PI*target.coMoveProgress):0;
   const scale=1+.075*target.stateChangeIntensity;
   node.style.opacity=(target.opacity*target.dimFactor).toFixed(4);
   node.style.transform="translate("+semanticX.toFixed(3)+"px,"+(lift+semanticY).toFixed(3)+"px) scale("+scale.toFixed(4)+")";
   node.dataset.activeOperations=target.activeOperations.join(",");
   node.dataset.stateRevision=String(target.stateRevision);
   node.dataset.semanticAbsence=target.absenceProgress.toFixed(4);
   node.dataset.semanticRejection=Math.max(target.supersedeProgress,target.rejectionProgress).toFixed(4);
   node.dataset.semanticUnresolved=target.unresolvedProgress.toFixed(4);
   const body=node.querySelector("[data-target-body]");if(body)body.style.opacity=clamp(1-.78*target.absenceProgress-.42*Math.max(target.supersedeProgress,target.rejectionProgress)).toFixed(4);
   const label=node.querySelector("[data-target-label]");if(label)label.style.opacity=clamp(1-.42*target.absenceProgress-.38*Math.max(target.supersedeProgress,target.rejectionProgress)).toFixed(4);
   const rejection=node.querySelector("[data-semantic-rejection-indicator]");if(rejection)rejection.setAttribute("opacity",Math.max(target.supersedeProgress,target.rejectionProgress).toFixed(4));
   const marker=node.querySelector("[data-semantic-mark-indicator]");if(marker)marker.setAttribute("opacity",target.markProgress.toFixed(4));
   const uncertainty=node.querySelector("[data-semantic-uncertainty-indicator]");if(uncertainty)uncertainty.setAttribute("opacity",Math.max(target.absenceProgress,target.unresolvedProgress).toFixed(4));
   const empty=node.querySelector("[data-semantic-empty-indicator]");if(empty)empty.setAttribute("opacity",target.emptyProgress.toFixed(4));
   node.querySelectorAll("[data-wheel-bank-digit]").forEach((digit,digitIndex)=>{const phase=clamp(target.carryProgress*1.55-(5-digitIndex)*.11);digit.style.transform="translateY("+(-10*Math.sin(Math.PI*phase)).toFixed(3)+"px) scale("+(1+.12*Math.sin(Math.PI*phase)).toFixed(4)+")";digit.style.opacity=(.42+.58*phase).toFixed(4)});
   node.querySelectorAll("[data-draw-path]").forEach((path)=>{path.style.strokeDasharray="100";path.style.strokeDashoffset=String(100*(1-target.drawProgress))});
   const indicator=node.querySelector("[data-focus-indicator]");if(indicator)indicator.setAttribute("opacity",target.focusIntensity.toFixed(4));
   const token=node.querySelector("[data-relation-token]"),path=node.querySelector("[data-draw-path]");
   if(token&&path){const moving=target.activeOperations.includes("draw")||target.activeOperations.includes("state_change");if(moving&&typeof path.getTotalLength==="function"){const length=path.getTotalLength(),point=path.getPointAtLength(length*clamp(target.drawProgress));token.setAttribute("cx",point.x.toFixed(3));token.setAttribute("cy",point.y.toFixed(3));token.setAttribute("opacity","1")}else token.setAttribute("opacity","0")}
  });
  sceneNode.dataset.activeMotionCount=String(index===state.sceneIndex?state.activeTracks.length:0);
 });
 document.documentElement.dataset.renderedFrame=String(state.frame);
 document.documentElement.dataset.activeVisualSceneId=state.scene.id;
 document.documentElement.dataset.activeMotionCount=String(state.activeTracks.length);
 document.documentElement.dataset.sceneTransitionActive=String(state.transition.active);
 document.documentElement.dataset.sceneTransitionProgress=state.transition.progress.toFixed(6);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]},renderFrame};
window.__timelines=window.__timelines||{};window.__timelines[DATA.compositionId]=timeline;window.__renderFrame=renderFrame;window.__getGeneralizedVisualFrameStateV2=stateAt;renderFrame(0);`;
}

export function listSupportedGeneralizedVisualOperationsV2() {
  return SUPPORTED_OPERATIONS;
}
