import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createOperationSchedule } from "./operation-scheduler.mjs";
import { createPathMorph, pointsToPath } from "./primitives/path-morph.mjs";

const require = createRequire(import.meta.url);
const BASE_WIDTH = 720;
const BASE_HEIGHT = 1280;
const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"));
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");

function seededPoints(seed, count) {
  let state = seed >>> 0;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = 30 + (state / 0xffffffff) * 660;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const y = 40 + (state / 0xffffffff) * 880;
    points.push({ x: x.toFixed(2), y: y.toFixed(2), r: (0.5 + (index % 4) * 0.35).toFixed(2) });
  }
  return points;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const SEMANTIC_EVIDENCE_MORPH_SOURCE = Object.freeze([120, 690, 220, 690, 238, 350, 365, 350, 492, 350, 510, 690, 610, 690]);
export const SEMANTIC_EVIDENCE_MORPH_TARGET = Object.freeze([110, 545, 122, 545, 132, 385, 140, 385, 148, 385, 155, 545, 174, 545]);

export function semanticEvidenceMorphPath(progress) {
  if (!Number.isFinite(progress)) throw new TypeError("Semantic evidence morph progress is invalid.");
  const t = Math.max(0, Math.min(1, progress));
  const values = SEMANTIC_EVIDENCE_MORPH_SOURCE.map((value, index) => value + (SEMANTIC_EVIDENCE_MORPH_TARGET[index] - value) * t).map((value) => Number(value.toFixed(3)));
  return `M${values[0]} ${values[1]} C${values[2]} ${values[3]} ${values[4]} ${values[5]} ${values[6]} ${values[7]} C${values[8]} ${values[9]} ${values[10]} ${values[11]} ${values[12]} ${values[13]}`;
}

function compileLegacyAnimationIRToHtml(ir) {
  const content = ir.content;
  const compositionId = escapeXml(content.compositionId);
  const titleLines = content.titleLines.map((line, index) => `<text x="54" y="${121 + index * 47}" fill="#f1f5f9" class="title">${escapeXml(line)}</text>`).join("");
  const payoffStartY = content.payoffLines.length === 1 ? 714 : 690;
  const payoffLines = content.payoffLines.map((line, index) => `<text x="360" y="${payoffStartY + index * 48}" text-anchor="middle" fill="${index === 0 ? "#fde68a" : "#cbd5e1"}" font-size="${index === 0 ? 42 : 26}" letter-spacing="${index === 0 ? 0 : 3}">${escapeXml(line)}</text>`).join("");
  const timelineLabels = content.timelineLabels.map((line, index, values) => {
    const x = values.length === 1 ? 360 : 84 + index * (552 / (values.length - 1));
    const anchor = index === 0 ? "start" : index === values.length - 1 ? "end" : "middle";
    return `<text x="${x.toFixed(2)}" y="912" text-anchor="${anchor}">${escapeXml(line)}</text>`;
  }).join("");
  const stars = seededPoints(ir.seed, 54).map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${point.r}"/>`).join("");
  const schedule = createOperationSchedule(ir);
  const morph = createPathMorph();
  const path = pointsToPath(morph.source);
  const finalHold = ir.scenes.at(-1)?.readabilityHolds?.at(-1);
  const timelineEndFrame = finalHold?.endFrame === ir.durationFrames ? finalHold.startFrame : ir.durationFrames - 1;
  const runtimeData = safeJson({ fps: ir.fps, durationFrames: ir.durationFrames, timelineEndFrame, seed: ir.seed, contentHash: ir.contentHash, schedule, morph: { pointCount: morph.pointCount, source: morph.source, target: morph.target } });
  const durationSeconds = ir.durationFrames / ir.fps;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'">
<meta data-composition-id="${compositionId}" data-width="${ir.width}" data-height="${ir.height}" data-font-sha256="${FONT_SHA256}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#02040b}*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#02040b}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}.stars{fill:#a5f3fc}.grid-line{stroke:#164e63;stroke-width:1}.kicker{font-size:18px;letter-spacing:4px;font-weight:600}.label{font-size:20px;letter-spacing:2px;font-weight:600}.title{font-size:44px;font-weight:600}.axis{font-size:14px;letter-spacing:2px;font-weight:600}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${compositionId}" data-start="0" data-duration="${durationSeconds}" data-width="${ir.width}" data-height="${ir.height}">
<svg viewBox="0 0 ${BASE_WIDTH} ${BASE_HEIGHT}" role="img" aria-label="${escapeXml(content.titleLines.join(" "))}">
<defs>
 <radialGradient id="bg" cx="50%" cy="31%" r="82%"><stop offset="0" stop-color="#10243d"/><stop offset="0.54" stop-color="#07121f"/><stop offset="1" stop-color="#02040b"/></radialGradient>
 <linearGradient id="signal" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="0.55" stop-color="#ecfeff"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>
 <linearGradient id="caption-scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#02040b" stop-opacity="0"/><stop offset="0.48" stop-color="#02040b" stop-opacity=".34"/><stop offset="1" stop-color="#02040b" stop-opacity=".68"/></linearGradient>
 <radialGradient id="payoff" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#fbbf24" stop-opacity=".20"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/></radialGradient>
 <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <pattern id="grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" class="grid-line" opacity=".48"/></pattern>
</defs>
<rect width="720" height="1280" fill="url(#bg)"/>
<rect id="ambient-wash" width="720" height="1280" fill="#0e7490" opacity=".025"/>
<g id="ambient-stars" class="stars" opacity=".18" data-qa-layer="ambient">${stars}</g>
<rect x="36" y="180" width="648" height="740" fill="none" data-semantic-roi="true" pointer-events="none"/>
<g id="header" data-entity-id="explanation_header" data-caption-policy="avoid"><text x="54" y="70" fill="#67e8f9" class="kicker">${escapeXml(content.kicker)}</text>${titleLines}</g>
<g id="camera-stage">
 <g id="grid-group" data-entity-id="signal_grid" data-caption-policy="avoid">
  <rect id="grid" x="42" y="210" width="636" height="610" rx="28" fill="#071827" stroke="#164e63" stroke-width="2"/>
  <rect id="ambient-grid-layer" x="42" y="210" width="636" height="610" rx="28" fill="url(#grid-pattern)"/>
  <line x1="70" y1="515" x2="650" y2="515" stroke="#155e75" stroke-width="2" opacity=".78"/>
  <line x1="360" y1="238" x2="360" y2="792" stroke="#155e75" stroke-width="2" opacity=".58"/>
  <text x="72" y="246" fill="#64748b" class="axis">${escapeXml(content.timelineLabels[0])}</text>
  <text x="648" y="795" text-anchor="end" fill="#64748b" class="axis">${escapeXml(content.timelineLabels.at(-1))}</text>
 </g>
 <g id="scan-sweep" data-entity-id="frequency_sweep" data-caption-policy="avoid"><line id="sweep-line" x1="74" y1="236" x2="74" y2="790" stroke="#67e8f9" stroke-width="4" filter="url(#glow)"/><circle id="sweep-dot" cx="74" cy="515" r="10" fill="#ecfeff" filter="url(#glow)"/></g>
 <g id="frequency-label" opacity="0" data-entity-id="primary_metric" data-caption-policy="avoid"><rect x="238" y="250" width="244" height="52" rx="26" fill="#083344" stroke="#22d3ee" stroke-width="2"/><text x="360" y="284" text-anchor="middle" fill="#cffafe" class="label">${escapeXml(content.metricValue)}</text></g>
 <path id="beam-a" data-entity-id="beam_alpha" data-caption-policy="avoid" d="M78 732 C220 338 500 338 642 732" fill="none" stroke="#8b5cf6" stroke-width="8" opacity="0" filter="url(#glow)"/>
 <path id="beam-b" data-entity-id="beam_beta" data-caption-policy="avoid" d="M78 338 C220 732 500 732 642 338" fill="none" stroke="#f59e0b" stroke-width="8" opacity="0" filter="url(#glow)"/>
 <g id="duration-bracket" opacity="0" data-entity-id="metric_context" data-caption-policy="avoid"><line id="duration-line" x1="174" y1="748" x2="546" y2="748" stroke="#67e8f9" stroke-width="4" stroke-dasharray="372" stroke-dashoffset="372"/><line x1="174" y1="733" x2="174" y2="763" stroke="#67e8f9" stroke-width="4"/><line x1="546" y1="733" x2="546" y2="763" stroke="#67e8f9" stroke-width="4"/><circle id="duration-cursor" cx="174" cy="748" r="12" fill="#ecfeff" filter="url(#glow)"/><text x="360" y="790" text-anchor="middle" fill="#cffafe" font-size="16">${escapeXml(content.metricLabel)}</text></g>
 <circle id="pulse-halo" data-entity-id="signal_pulse" data-caption-policy="avoid" cx="360" cy="515" r="34" fill="none" stroke="#67e8f9" stroke-width="6" opacity="0"/>
 <circle id="pulse-core" cx="360" cy="515" r="10" fill="#ecfeff" opacity="0" filter="url(#glow)"/>
 <path id="wave-glow" d="${path}" fill="none" stroke="#22d3ee" stroke-width="14" opacity="0" filter="url(#glow)"/>
 <path id="wave" data-entity-id="signal_wave" data-caption-policy="avoid" d="${path}" pathLength="1000" fill="none" stroke="url(#signal)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1000" stroke-dashoffset="1000"/>
 <g id="evidence-label" opacity="0" data-entity-id="evidence_node" data-caption-policy="avoid"><text x="360" y="506" text-anchor="middle" fill="#ecfeff" font-size="16" letter-spacing="2">${escapeXml(content.evidenceLabel)}</text><text x="360" y="542" text-anchor="middle" fill="#67e8f9" font-size="24">${escapeXml(content.evidenceCode)}</text></g>
 <g id="reasoning-bridge" opacity="0" data-entity-id="reasoning_bridge" data-caption-policy="avoid"><line id="reason-left" x1="360" y1="610" x2="360" y2="610" stroke="#67e8f9" stroke-width="4"/><line id="reason-right" x1="360" y1="610" x2="360" y2="610" stroke="#fbbf24" stroke-width="4"/><circle id="reason-left-dot" cx="360" cy="610" r="8" fill="#67e8f9"/><circle id="reason-right-dot" cx="360" cy="610" r="8" fill="#fbbf24"/><text x="150" y="658" text-anchor="middle" fill="#cffafe" font-size="16" letter-spacing="1">${escapeXml(content.reasoningLeft)}</text><text id="reason-not-equal" x="360" y="660" text-anchor="middle" fill="#fde68a" font-size="34">≠</text><text x="570" y="658" text-anchor="middle" fill="#fde68a" font-size="18" letter-spacing="2">${escapeXml(content.reasoningRight)}</text></g>
 <g id="payoff-panel" opacity="0" data-entity-id="payoff_label" data-caption-policy="avoid"><circle id="payoff-field" cx="360" cy="515" r="110" fill="url(#payoff)"/>${payoffLines}<line id="payoff-line" x1="222" y1="790" x2="498" y2="790" stroke="#fbbf24" stroke-width="3" stroke-dasharray="276" stroke-dashoffset="276"/></g>
</g>
<g id="narrative-timeline" data-entity-id="narrative_timeline" data-caption-policy="avoid">
 <line x1="84" y1="870" x2="636" y2="870" stroke="#164e63" stroke-width="4"/>
 <line id="timeline-active" x1="84" y1="870" x2="84" y2="870" stroke="#22d3ee" stroke-width="4"/>
 <g fill="#64748b" font-size="13" letter-spacing="1">${timelineLabels}</g>
 <g id="timeline-cursor"><rect x="-62" y="838" width="124" height="64" rx="22" fill="#22d3ee" fill-opacity=".16" stroke="#67e8f9" stroke-opacity=".58" stroke-width="2"/><line x1="0" y1="838" x2="0" y2="902" stroke="#67e8f9" stroke-width="6" filter="url(#glow)"/><circle cx="0" cy="870" r="11" fill="#ecfeff" filter="url(#glow)"/></g>
</g>
<rect x="0" y="947" width="720" height="333" fill="url(#caption-scrim)" data-caption-safe-zone="true" pointer-events="none"/>
</svg></main>
<script>
"use strict";
const DATA=${runtimeData};
const byId=(id)=>document.getElementById(id);
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=(value,name)=>{const x=clamp(value);if(name==="linear")return x;if(name==="smoothstep")return x*x*(3-2*x);if(name==="ease_in_cubic")return x*x*x;if(name==="ease_out_cubic")return 1-Math.pow(1-x,3);if(name==="ease_in_out_cubic")return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;throw new Error("unsupported_easing")};
const progress=(frame,key)=>{const op=DATA.schedule[key];if(!op)throw new Error("missing_operation");return ease((frame-op.startFrame)/Math.max(1,op.endFrame-op.startFrame),op.easing)};
const pulseEnvelope=(frame,key)=>{const p=progress(frame,key);return p<=.38?p/.38:Math.max(0,1-(p-.38)/.62)};
const morphPath=(value)=>DATA.morph.source.map((point,index)=>{const target=DATA.morph.target[index];const x=point.x+(target.x-point.x)*value,y=point.y+(target.y-point.y)*value;return(index?"L":"M")+x.toFixed(3)+" "+y.toFixed(3)}).join(" ");
const scaleAround=(scale)=>"translate("+(360*(1-scale)).toFixed(3)+" "+(515*(1-scale)).toFixed(3)+") scale("+scale.toFixed(5)+")";
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
 byId("ambient-wash").setAttribute("opacity",(.015+.035*(1+Math.sin(frame*.11))).toFixed(4));byId("ambient-stars").setAttribute("transform","translate("+(1.8*Math.sin(frame*.023)).toFixed(3)+" "+(1.4*Math.cos(frame*.031)).toFixed(3)+")");byId("ambient-stars").setAttribute("opacity",(.16+.055*(1+Math.sin(frame*.043))).toFixed(4));
 const gridCreate=progress(frame,"create:signal_grid"),transition=progress(frame,"transition_match:evidence_node");
 const sweepX=74+572*gridCreate;byId("scan-sweep").setAttribute("opacity",((1-gridCreate)*(1-.8*transition)).toFixed(4));byId("sweep-line").setAttribute("x1",sweepX.toFixed(3));byId("sweep-line").setAttribute("x2",sweepX.toFixed(3));byId("sweep-dot").setAttribute("cx",sweepX.toFixed(3));
 const draw=progress(frame,"draw_path:signal_wave");byId("wave").style.strokeDashoffset=String(1000*(1-draw));byId("wave-glow").setAttribute("opacity",(.16*draw*(1-.55*transition)).toFixed(4));
 const measure=progress(frame,"pulse:signal_pulse"),pulse=pulseEnvelope(frame,"pulse:signal_pulse");byId("frequency-label").setAttribute("opacity",measure.toFixed(4));byId("duration-bracket").setAttribute("opacity",measure.toFixed(4));byId("duration-line").style.strokeDashoffset=String(372*(1-measure));byId("duration-cursor").setAttribute("cx",String(174+372*measure));
 byId("pulse-core").setAttribute("opacity",pulse.toFixed(4));byId("pulse-core").setAttribute("r",String(8+10*pulse));const haloScale=1+(DATA.schedule["pulse:signal_pulse"].params.scale-1)*pulse;byId("pulse-halo").setAttribute("opacity",(pulse*DATA.schedule["pulse:signal_pulse"].params.opacity).toFixed(4));byId("pulse-halo").setAttribute("transform",scaleAround(haloScale));
 const beamA=progress(frame,"draw_path:beam_alpha"),beamB=progress(frame,"draw_path:beam_beta"),beamVisibility=1-transition;byId("beam-a").setAttribute("opacity",(.58*beamA*beamVisibility).toFixed(4));byId("beam-b").setAttribute("opacity",(.52*beamB*beamVisibility).toFixed(4));byId("beam-a").style.strokeDasharray="900";byId("beam-b").style.strokeDasharray="900";byId("beam-a").style.strokeDashoffset=String(900*(1-beamA));byId("beam-b").style.strokeDashoffset=String(900*(1-beamB));
 const push=progress(frame,"camera_push:camera_stage"),zoom=1+(DATA.schedule["camera_push:camera_stage"].params.scale-1)*push;
 const morph=progress(frame,"morph_path:signal_wave"),morphed=morphPath(morph);byId("wave").setAttribute("d",morphed);byId("wave-glow").setAttribute("d",morphed);
 const evidenceReveal=clamp((frame-DATA.schedule["morph_path:signal_wave"].endFrame)/7),condensedOpacity=1-.85*morph+.85*evidenceReveal,condensedWidth=6-4.5*morph+4.5*evidenceReveal;byId("wave").setAttribute("opacity",condensedOpacity.toFixed(4));byId("wave").setAttribute("stroke-width",condensedWidth.toFixed(3));byId("wave-glow").setAttribute("opacity",(.08*draw*(1-.90*morph+.90*evidenceReveal)*(1-.55*transition)).toFixed(4));byId("evidence-label").setAttribute("opacity",(evidenceReveal*(1-.28*transition)).toFixed(4));
 const evidenceScale=progress(frame,"scale:evidence_node"),nodeScale=(1+(DATA.schedule["scale:evidence_node"].params.to-1)*evidenceScale)*zoom;const nodeTransform=scaleAround(nodeScale);byId("wave").setAttribute("transform",nodeTransform);byId("wave-glow").setAttribute("transform",nodeTransform);byId("evidence-label").setAttribute("transform",nodeTransform);
 const payoff=progress(frame,"fade:payoff_label"),fieldPulse=pulseEnvelope(frame,"pulse:deep_background"),payoffScale=.82+.18*payoff,payoffLift=28*(1-payoff);byId("payoff-panel").setAttribute("opacity",payoff.toFixed(4));byId("payoff-panel").setAttribute("transform","translate(0 "+payoffLift.toFixed(3)+") "+scaleAround(payoffScale));byId("payoff-field").setAttribute("r",String(110+135*fieldPulse));byId("payoff-line").style.strokeDashoffset=String(276*(1-payoff));byId("header").setAttribute("opacity",(1-.82*transition).toFixed(4));
 const reasoningVisibility=transition*(1-payoff),reasonLeft=360-210*transition,reasonRight=360+210*transition;byId("reasoning-bridge").setAttribute("opacity",reasoningVisibility.toFixed(4));byId("reason-left").setAttribute("x2",reasonLeft.toFixed(3));byId("reason-right").setAttribute("x2",reasonRight.toFixed(3));byId("reason-left-dot").setAttribute("cx",reasonLeft.toFixed(3));byId("reason-right-dot").setAttribute("cx",reasonRight.toFixed(3));byId("reason-not-equal").setAttribute("opacity",evidenceScale.toFixed(4));
 const narrativeProgress=clamp(frame/Math.max(1,DATA.timelineEndFrame)),cursorX=84+552*narrativeProgress;byId("timeline-active").setAttribute("x2",cursorX.toFixed(3));byId("timeline-cursor").setAttribute("transform","translate("+cursorX.toFixed(3)+" 0)");
 document.documentElement.dataset.renderedFrame=String(frame);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]}};
window.__timelines=window.__timelines||{};window.__timelines[${safeJson(content.compositionId)}]=timeline;renderFrame(0);
</script></body></html>`;
  return Object.freeze({ html, compositionHash: createHash("sha256").update(html).digest("hex"), font: Object.freeze({ family: FONT_FAMILY, sha256: FONT_SHA256, license: FONT_LICENSE, sourcePackage: "@fontsource/outfit" }) });
}

function compileSemanticAnimationIRToHtml(ir) {
  const content = ir.content;
  const semantic = content.semantic;
  const compositionId = escapeXml(content.compositionId);
  const titleLines = content.titleLines.map((line, index) => `<text x="54" y="${108 + index * 39}" fill="#e2e8f0" font-size="${index === 0 ? 34 : 31}" font-weight="600">${escapeXml(line)}</text>`).join("");
  const stars = seededPoints(ir.seed, 54).map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${point.r}"/>`).join("");
  const schedule = createOperationSchedule(ir);
  const stages = Object.fromEntries(ir.scenes.map((scene) => [scene.id.replace(/^scene_/, ""), { startFrame: scene.startFrame, endFrame: scene.endFrame, beatId: scene.semantic.beatId }]));
  const evidenceSourcePath = semanticEvidenceMorphPath(0);
  const evidenceTargetPath = semanticEvidenceMorphPath(1);
  const finalHold = ir.scenes.at(-1)?.readabilityHolds?.at(-1);
  const timelineEndFrame = finalHold?.endFrame === ir.durationFrames ? finalHold.startFrame : ir.durationFrames - 1;
  const runtimeData = safeJson({ fps: ir.fps, durationFrames: ir.durationFrames, timelineEndFrame, seed: ir.seed, contentHash: ir.contentHash, schedule, stages, transitions: ir.transitions, evidenceMorph: { source: SEMANTIC_EVIDENCE_MORPH_SOURCE, target: SEMANTIC_EVIDENCE_MORPH_TARGET } });
  const durationSeconds = ir.durationFrames / ir.fps;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'">
<meta data-composition-id="${compositionId}" data-width="${ir.width}" data-height="${ir.height}" data-font-sha256="${FONT_SHA256}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#02040b}*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#02040b}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}.stars{fill:#a5f3fc}.stage-title{font-size:25px;font-weight:600;letter-spacing:1px}.small-label{font-size:14px;font-weight:600;letter-spacing:2px}.semantic-copy{font-size:19px;font-weight:600;letter-spacing:1px}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${compositionId}" data-start="0" data-duration="${durationSeconds}" data-width="${ir.width}" data-height="${ir.height}">
<svg viewBox="0 0 ${BASE_WIDTH} ${BASE_HEIGHT}" role="img" aria-label="${escapeXml(content.titleLines.join(" "))}">
<defs>
 <radialGradient id="semantic-bg" cx="50%" cy="31%" r="82%"><stop offset="0" stop-color="#10243d"/><stop offset="0.54" stop-color="#07121f"/><stop offset="1" stop-color="#02040b"/></radialGradient>
 <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2e8f0"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient>
 <radialGradient id="verdict-gradient" cx="50%" cy="50%" r="65%"><stop offset="0" stop-color="#f59e0b" stop-opacity=".22"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient>
 <linearGradient id="caption-scrim-semantic" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#02040b" stop-opacity="0"/><stop offset=".48" stop-color="#02040b" stop-opacity=".34"/><stop offset="1" stop-color="#02040b" stop-opacity=".68"/></linearGradient>
 <clipPath id="record-clip"><rect id="record-clip-rect" x="80" y="220" width="0" height="600"/></clipPath>
</defs>
<rect width="720" height="1280" fill="url(#semantic-bg)"/>
<rect id="semantic-ambient-wash" width="720" height="1280" fill="#0e7490" opacity=".025"/>
<g id="semantic-ambient-stars" class="stars" opacity=".18" data-qa-layer="ambient">${stars}</g>
<rect x="36" y="180" width="648" height="740" fill="none" data-semantic-roi="true" pointer-events="none"/>
<g id="semantic-header" data-caption-policy="avoid"><text x="54" y="60" fill="#67e8f9" font-size="17" letter-spacing="4">${escapeXml(content.kicker)}</text>${titleLines}</g>

<g id="stage-hook" opacity="0" data-semantic-beat-id="${escapeXml(stages.hook.beatId)}">
 <g id="hook-record" clip-path="url(#record-clip)" data-entity-id="observation_record" data-caption-policy="avoid" data-semantic-cue-id="hook_record" data-semantic-beat-id="${escapeXml(stages.hook.beatId)}" data-semantic-kind="primary_visual">
  <rect x="80" y="220" width="560" height="600" rx="22" fill="url(#paper)"/>
  <text x="112" y="268" fill="#0f172a" class="small-label">${escapeXml(semantic.eraLabel)}</text>
  <text x="112" y="307" fill="#334155" font-size="18">${escapeXml(semantic.recordLabel)}</text>
  <g stroke="#94a3b8" stroke-width="2" opacity=".72"><line x1="112" y1="350" x2="608" y2="350"/><line x1="112" y1="405" x2="608" y2="405"/><line x1="112" y1="460" x2="608" y2="460"/><line x1="112" y1="515" x2="608" y2="515"/><line x1="112" y1="570" x2="608" y2="570"/><line x1="112" y1="625" x2="608" y2="625"/><line x1="112" y1="680" x2="608" y2="680"/><line x1="112" y1="735" x2="608" y2="735"/></g>
  <rect id="record-anomaly-column" x="332" y="326" width="56" height="438" rx="10" fill="#22d3ee" fill-opacity=".16" stroke="#0891b2" stroke-width="3"/>
  <path id="record-trace" d="M112 625 L168 608 L218 632 L272 601 L326 622 L360 360 L394 620 L448 599 L506 631 L560 606 L608 620" fill="none" stroke="#0e7490" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
  <line id="record-scan-line" x1="100" y1="360" x2="620" y2="360" stroke="#f59e0b" stroke-width="3" opacity=".62"/>
 </g>
 <g id="wow-mark" opacity="0" data-entity-id="wow_annotation" data-caption-policy="avoid" data-semantic-cue-id="wow_annotation" data-semantic-beat-id="${escapeXml(stages.hook.beatId)}" data-semantic-kind="audience_text">
  <text x="474" y="500" fill="#f59e0b" font-size="54" font-style="italic" text-anchor="middle" transform="rotate(-8 474 500)">${escapeXml(semantic.annotationLabel)}</text>
  <ellipse id="wow-ring" cx="474" cy="480" rx="105" ry="62" fill="none" stroke="#f59e0b" stroke-width="6" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-8 474 480)"/>
 </g>
</g>

<g id="stage-context" opacity="0" data-semantic-beat-id="${escapeXml(stages.context.beatId)}">
 <g id="frequency-panel" data-entity-id="frequency_scale" data-caption-policy="avoid" data-semantic-cue-id="frequency_context" data-semantic-beat-id="${escapeXml(stages.context.beatId)}" data-semantic-kind="primary_visual">
  <text x="360" y="225" text-anchor="middle" fill="#e2e8f0" class="stage-title">${escapeXml(semantic.frequencyLabel)}</text>
  <rect x="64" y="255" width="592" height="292" rx="24" fill="#071827" stroke="#155e75" stroke-width="2"/>
  <line x1="100" y1="455" x2="620" y2="455" stroke="#64748b" stroke-width="3"/>
  <g stroke="#475569" stroke-width="2"><line x1="100" y1="435" x2="100" y2="475"/><line x1="204" y1="441" x2="204" y2="469"/><line x1="308" y1="435" x2="308" y2="475"/><line x1="412" y1="435" x2="412" y2="475"/><line x1="516" y1="441" x2="516" y2="469"/><line x1="620" y1="435" x2="620" y2="475"/></g>
  <rect id="notable-band" x="334" y="292" width="52" height="182" rx="14" fill="#22d3ee" fill-opacity=".18" stroke="#67e8f9" stroke-width="3" opacity="0"/>
  <line id="frequency-cursor" x1="100" y1="285" x2="100" y2="490" stroke="#f59e0b" stroke-width="4"/>
  <text x="360" y="525" text-anchor="middle" fill="#94a3b8" class="small-label">${escapeXml(semantic.sourceLabel)}</text>
 </g>
 <g id="duration-display" opacity="0" data-entity-id="duration_timer" data-caption-policy="avoid" data-semantic-cue-id="duration_72_seconds" data-semantic-beat-id="${escapeXml(stages.context.beatId)}" data-semantic-kind="evidence_text">
  <circle cx="360" cy="700" r="112" fill="#082f49" fill-opacity=".36" stroke="#164e63" stroke-width="12"/>
  <circle id="duration-ring" cx="360" cy="700" r="112" fill="none" stroke="#22d3ee" stroke-width="12" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 360 700)"/>
  <text x="360" y="698" text-anchor="middle" fill="#ecfeff" font-size="82">${escapeXml(semantic.durationValue)}</text>
  <text x="360" y="744" text-anchor="middle" fill="#fbbf24" class="small-label">${escapeXml(semantic.durationUnit)}</text>
 </g>
</g>

<g id="stage-evidence" opacity="0" data-semantic-beat-id="${escapeXml(stages.evidence.beatId)}">
 <g id="beam-panel" data-entity-id="beam_graph" data-caption-policy="avoid" data-semantic-cue-id="beam_graph" data-semantic-beat-id="${escapeXml(stages.evidence.beatId)}" data-semantic-kind="primary_visual">
  <text x="360" y="225" text-anchor="middle" fill="#e2e8f0" class="stage-title">${escapeXml(semantic.beamTitle)}</text>
  <rect x="74" y="255" width="572" height="530" rx="24" fill="#071827" stroke="#155e75" stroke-width="2"/>
  <line x1="120" y1="700" x2="610" y2="700" stroke="#64748b" stroke-width="3"/><line x1="120" y1="330" x2="120" y2="700" stroke="#64748b" stroke-width="3"/>
  <text x="365" y="755" text-anchor="middle" fill="#94a3b8" class="small-label">${escapeXml(semantic.beamXAxis)}</text>
  <text x="96" y="520" text-anchor="middle" fill="#94a3b8" class="small-label" transform="rotate(-90 96 520)">${escapeXml(semantic.beamYAxis)}</text>
  <path id="beam-reference" d="${evidenceSourcePath}" fill="none" stroke="#8b5cf6" stroke-width="13" opacity=".34" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
 </g>
 <g id="evidence-signal" data-entity-id="evidence_trace" data-caption-policy="avoid" data-semantic-cue-id="beam_signal_trace" data-semantic-beat-id="${escapeXml(stages.evidence.beatId)}" data-semantic-kind="primary_visual">
  <path id="signal-strength-curve" d="${evidenceSourcePath}" fill="none" stroke="#22d3ee" stroke-width="7" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
  <line id="beam-guide" x1="120" y1="690" x2="120" y2="690" stroke="#67e8f9" stroke-width="3" stroke-dasharray="8 8"/>
  <circle id="beam-source-dot" cx="120" cy="690" r="11" fill="#ecfeff" stroke="#22d3ee" stroke-width="5"/>
  <text x="205" y="660" fill="#67e8f9" class="small-label">RISE</text><text x="530" y="660" fill="#fbbf24" class="small-label">FALL</text>
 </g>
 <g id="interference-note" opacity="0" data-entity-id="interference_label" data-caption-policy="avoid" data-semantic-cue-id="interference_inference" data-semantic-beat-id="${escapeXml(stages.evidence.beatId)}" data-semantic-kind="evidence_text">
  <rect x="128" y="803" width="464" height="54" rx="27" fill="#083344" stroke="#22d3ee" stroke-width="2"/>
  <text x="360" y="837" text-anchor="middle" fill="#cffafe" font-size="16" letter-spacing="1">${escapeXml(semantic.interferenceLabel)}</text>
 </g>
 <text x="360" y="778" text-anchor="middle" fill="#64748b" font-size="10" letter-spacing=".8">${escapeXml(semantic.disclosureLabel)}</text>
</g>

<g id="stage-turn" opacity="0" data-semantic-beat-id="${escapeXml(stages.turn.beatId)}">
 <g id="search-history" data-entity-id="search_timeline" data-caption-policy="avoid" data-semantic-cue-id="later_searches" data-semantic-beat-id="${escapeXml(stages.turn.beatId)}" data-semantic-kind="primary_visual">
  <text x="360" y="235" text-anchor="middle" fill="#e2e8f0" class="stage-title">${escapeXml(semantic.repeatRangeLabel)}</text>
  <rect x="70" y="280" width="580" height="430" rx="26" fill="#071827" stroke="#155e75" stroke-width="2"/>
  <line x1="104" y1="545" x2="616" y2="545" stroke="#475569" stroke-width="5"/>
  <line id="search-active-line" x1="104" y1="545" x2="104" y2="545" stroke="#22d3ee" stroke-width="5"/>
  <path id="single-signal-spike" d="${evidenceTargetPath}" fill="none" stroke="#67e8f9" stroke-width="8" stroke-linejoin="round"/>
  <text x="140" y="590" text-anchor="middle" fill="#67e8f9" class="small-label">${escapeXml(semantic.eventYearLabel)}</text>
  <g id="search-pass-1" opacity="0"><circle cx="280" cy="545" r="38" fill="none" stroke="#475569" stroke-width="3"/><path d="M250 545 H310" stroke="#94a3b8" stroke-width="5"/></g>
  <g id="search-pass-2" opacity="0"><circle cx="390" cy="545" r="38" fill="none" stroke="#475569" stroke-width="3"/><path d="M360 545 H420" stroke="#94a3b8" stroke-width="5"/></g>
  <g id="search-pass-3" opacity="0"><circle cx="500" cy="545" r="38" fill="none" stroke="#475569" stroke-width="3"/><path d="M470 545 H530" stroke="#94a3b8" stroke-width="5"/></g>
  <g id="search-pass-4" opacity="0"><circle cx="600" cy="545" r="30" fill="none" stroke="#475569" stroke-width="3"/><path d="M577 545 H623" stroke="#94a3b8" stroke-width="5"/></g>
  <text x="445" y="645" text-anchor="middle" fill="#94a3b8" class="small-label">LATER SEARCH PASSES: FLAT</text>
 </g>
 <g id="no-repeat-note" opacity="0" data-entity-id="no_repeat_label" data-caption-policy="avoid" data-semantic-cue-id="no_verified_repeat" data-semantic-beat-id="${escapeXml(stages.turn.beatId)}" data-semantic-kind="evidence_text"><text x="360" y="770" text-anchor="middle" fill="#fbbf24" font-size="34">${escapeXml(semantic.noRepeatLabel)}</text></g>
 <g id="transmission-note" opacity="0" data-entity-id="transmission_label" data-caption-policy="avoid" data-semantic-cue-id="no_confirmed_transmission" data-semantic-beat-id="${escapeXml(stages.turn.beatId)}" data-semantic-kind="evidence_text"><text x="360" y="825" text-anchor="middle" fill="#cbd5e1" font-size="19" letter-spacing="1">${escapeXml(semantic.transmissionLabel)}</text></g>
</g>

<path id="evidence-carry-morph" d="${evidenceSourcePath}" fill="none" stroke="#22d3ee" stroke-width="7" opacity="0" data-entity-id="evidence_trace" data-caption-policy="avoid" data-semantic-cue-id="evidence_to_search_morph" data-semantic-beat-id="${escapeXml(stages.turn.beatId)}" data-semantic-kind="primary_visual"/>

<g id="stage-payoff" opacity="0" data-semantic-beat-id="${escapeXml(stages.payoff.beatId)}">
 <circle id="verdict-field" cx="360" cy="570" r="110" fill="url(#verdict-gradient)"/>
 <g id="observation-chip" data-entity-id="evidence_node" data-caption-policy="avoid" data-semantic-cue-id="single_observation" data-semantic-beat-id="${escapeXml(stages.payoff.beatId)}" data-semantic-kind="primary_visual">
  <rect x="84" y="330" width="240" height="82" rx="24" fill="#083344" stroke="#22d3ee" stroke-width="3"/><circle cx="120" cy="371" r="11" fill="#67e8f9"/><text x="204" y="378" text-anchor="middle" fill="#cffafe" font-size="18">${escapeXml(semantic.observationLabel)}</text>
 </g>
 <g id="reasoning-verdict" opacity="0" data-entity-id="reasoning_bridge" data-caption-policy="avoid" data-semantic-cue-id="not_aliens" data-semantic-beat-id="${escapeXml(stages.payoff.beatId)}" data-semantic-kind="primary_visual">
  <rect x="430" y="330" width="206" height="82" rx="24" fill="#3f1d2e" stroke="#fb7185" stroke-width="3"/><text x="533" y="378" text-anchor="middle" fill="#fecdd3" font-size="22">${escapeXml(semantic.speculationLabel)}</text>
  <line id="aliens-strike-a" x1="452" y1="347" x2="614" y2="395" stroke="#fb7185" stroke-width="8" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/><line id="aliens-strike-b" x1="614" y1="347" x2="452" y2="395" stroke="#fb7185" stroke-width="8" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
  <text x="360" y="735" text-anchor="middle" fill="#cbd5e1" font-size="23">${escapeXml(semantic.observationLabel)} <tspan fill="#fbbf24" font-size="38">≠</tspan> ${escapeXml(semantic.proofLabel)}</text>
 </g>
 <g id="bounded-conclusion" opacity="0" data-entity-id="payoff_label" data-caption-policy="avoid" data-semantic-cue-id="unexplained_conclusion" data-semantic-beat-id="${escapeXml(stages.payoff.beatId)}" data-semantic-kind="audience_text">
  <circle cx="360" cy="570" r="112" fill="#082f49" stroke="#22d3ee" stroke-width="4"/><text x="360" y="555" text-anchor="middle" fill="#fde68a" font-size="30">${escapeXml(semantic.conclusionLabel)}</text><text x="360" y="600" text-anchor="middle" fill="#94a3b8" class="small-label">${escapeXml(semantic.uncertaintyLabel)}</text>
 </g>
 <g id="final-proof-note" opacity="0" data-entity-id="final_evidence_label" data-caption-policy="avoid" data-semantic-cue-id="no_repeatable_proof" data-semantic-beat-id="${escapeXml(stages.payoff.beatId)}" data-semantic-kind="evidence_text"><text x="360" y="795" text-anchor="middle" fill="#fbbf24" font-size="27" letter-spacing="1">${escapeXml(semantic.finalEvidenceLabel)}</text><line id="final-proof-line" x1="190" y1="818" x2="530" y2="818" stroke="#f59e0b" stroke-width="4" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></g>
</g>

<rect x="0" y="947" width="720" height="333" fill="url(#caption-scrim-semantic)" data-caption-safe-zone="true" pointer-events="none"/>
</svg></main>
<script>
"use strict";
const DATA=${runtimeData};
const byId=(id)=>document.getElementById(id);
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=(value,name)=>{const x=clamp(value);if(name==="linear")return x;if(name==="smoothstep")return x*x*(3-2*x);if(name==="ease_in_cubic")return x*x*x;if(name==="ease_out_cubic")return 1-Math.pow(1-x,3);if(name==="ease_in_out_cubic")return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;throw new Error("unsupported_easing")};
const progress=(frame,key)=>{const op=DATA.schedule[key];if(!op)throw new Error("missing_operation");return ease((frame-op.startFrame)/Math.max(1,op.endFrame-op.startFrame),op.easing)};
const cueReveal=(frame,key,preRoll=8,settleFrames=2)=>{const op=DATA.schedule[key];if(!op)throw new Error("missing_operation");return clamp((frame-(op.startFrame-preRoll))/Math.max(1,preRoll+settleFrames))};
const morphPath=(value)=>{const t=clamp(value),p=DATA.evidenceMorph.source.map((entry,index)=>entry+(DATA.evidenceMorph.target[index]-entry)*t);return "M"+p[0]+" "+p[1]+" C"+p[2]+" "+p[3]+" "+p[4]+" "+p[5]+" "+p[6]+" "+p[7]+" C"+p[8]+" "+p[9]+" "+p[10]+" "+p[11]+" "+p[12]+" "+p[13]};
const stageOpacity=(frame,key)=>{const stage=DATA.stages[key];if(!stage||frame<stage.startFrame||frame>=stage.endFrame)return 0;const enter=stage.startFrame===0?1:.35+.65*clamp((frame-stage.startFrame)/7),exit=stage.endFrame===DATA.durationFrames?1:clamp((stage.endFrame-frame)/7);return Math.min(enter,exit)};
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
 const stageKeys=["hook","context","evidence","turn","payoff"],stageValues=stageKeys.map((key)=>stageOpacity(frame,key));stageKeys.forEach((key,index)=>byId("stage-"+key).setAttribute("opacity",stageValues[index].toFixed(4)));
 byId("semantic-header").setAttribute("opacity",(.38+.62*stageValues[0]).toFixed(4));
 byId("semantic-ambient-wash").setAttribute("opacity",(.015+.035*(1+Math.sin(frame*.11))).toFixed(4));byId("semantic-ambient-stars").setAttribute("transform","translate("+(1.8*Math.sin(frame*.023)).toFixed(3)+" "+(1.4*Math.cos(frame*.031)).toFixed(3)+")");byId("semantic-ambient-stars").setAttribute("opacity",(.16+.055*(1+Math.sin(frame*.043))).toFixed(4));

 const record=progress(frame,"draw_path:observation_record"),wow=progress(frame,"highlight:wow_annotation");byId("record-clip-rect").setAttribute("width",String(560*record));byId("record-trace").style.strokeDashoffset=String(100*(1-record));byId("record-anomaly-column").setAttribute("opacity",(.22+.78*record).toFixed(4));const scanY=535+185*Math.sin(frame*.055);byId("record-scan-line").setAttribute("y1",scanY.toFixed(3));byId("record-scan-line").setAttribute("y2",scanY.toFixed(3));byId("wow-mark").setAttribute("opacity",wow.toFixed(4));byId("wow-ring").style.strokeDashoffset=String(100*(1-wow));

 const frequency=progress(frame,"create:frequency_scale"),timer=progress(frame,"pulse:duration_timer"),timerVisibility=Math.max(timer,cueReveal(frame,"pulse:duration_timer"));const cursorX=100+520*frequency;byId("frequency-cursor").setAttribute("x1",cursorX.toFixed(3));byId("frequency-cursor").setAttribute("x2",cursorX.toFixed(3));byId("notable-band").setAttribute("opacity",clamp((frequency-.42)/.22).toFixed(4));byId("duration-display").setAttribute("opacity",timerVisibility.toFixed(4));byId("duration-ring").style.strokeDashoffset=String(100*(1-timer));

 const beam=progress(frame,"draw_path:beam_graph"),trace=progress(frame,"trace_signal:evidence_trace"),interference=progress(frame,"highlight:interference_label");byId("beam-reference").style.strokeDashoffset=String(100*(1-beam));byId("signal-strength-curve").style.strokeDashoffset=String(100*(1-trace));const sourceX=120+490*trace,sourceY=690-340*Math.exp(-Math.pow((trace-.5)/.235,2));byId("beam-source-dot").setAttribute("cx",sourceX.toFixed(3));byId("beam-source-dot").setAttribute("cy",sourceY.toFixed(3));byId("beam-guide").setAttribute("x1",sourceX.toFixed(3));byId("beam-guide").setAttribute("x2",sourceX.toFixed(3));byId("beam-guide").setAttribute("y1",sourceY.toFixed(3));byId("beam-guide").setAttribute("y2","700");byId("interference-note").setAttribute("opacity",interference.toFixed(4));

 const morph=progress(frame,"morph_path:evidence_trace"),searches=progress(frame,"stagger:search_timeline"),noRepeat=progress(frame,"highlight:no_repeat_label"),transmission=progress(frame,"fade:transmission_label"),morphOp=DATA.schedule["morph_path:evidence_trace"],carryTransition=DATA.transitions.find((entry)=>entry.sharedEntityId==="evidence_trace"),morphSettle=clamp((frame-morphOp.endFrame)/5),carryVisible=carryTransition&&frame>=carryTransition.startFrame&&frame<=morphOp.endFrame+5?1-morphSettle:0;byId("evidence-carry-morph").setAttribute("d",morphPath(morph));byId("evidence-carry-morph").setAttribute("opacity",carryVisible.toFixed(4));byId("search-active-line").setAttribute("x2",String(104+512*searches));byId("single-signal-spike").setAttribute("opacity",morphSettle.toFixed(4));[1,2,3,4].forEach((index)=>byId("search-pass-"+index).setAttribute("opacity",clamp((searches-(index-1)*.19)/.22).toFixed(4)));byId("no-repeat-note").setAttribute("opacity",noRepeat.toFixed(4));byId("transmission-note").setAttribute("opacity",transmission.toFixed(4));

 const transition=progress(frame,"transition_match:evidence_node"),reasoning=progress(frame,"fade:reasoning_bridge"),payoff=progress(frame,"fade:payoff_label"),payoffVisibility=Math.max(payoff,cueReveal(frame,"fade:payoff_label")),finalProof=progress(frame,"highlight:final_evidence_label"),finalProofVisibility=Math.max(finalProof,cueReveal(frame,"highlight:final_evidence_label")),fieldPulse=progress(frame,"pulse:deep_background");byId("observation-chip").setAttribute("opacity",(.45+.55*transition).toFixed(4));byId("reasoning-verdict").setAttribute("opacity",reasoning.toFixed(4));byId("aliens-strike-a").style.strokeDashoffset=String(100*(1-reasoning));byId("aliens-strike-b").style.strokeDashoffset=String(100*(1-reasoning));byId("bounded-conclusion").setAttribute("opacity",payoffVisibility.toFixed(4));byId("final-proof-note").setAttribute("opacity",finalProofVisibility.toFixed(4));byId("final-proof-line").style.strokeDashoffset=String(100*(1-finalProof));byId("verdict-field").setAttribute("r",String(110+120*Math.sin(Math.PI*fieldPulse)));
 document.documentElement.dataset.renderedFrame=String(frame);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]}};
window.__timelines=window.__timelines||{};window.__timelines[${safeJson(content.compositionId)}]=timeline;renderFrame(0);
</script></body></html>`;
  return Object.freeze({ html, compositionHash: createHash("sha256").update(html).digest("hex"), font: Object.freeze({ family: FONT_FAMILY, sha256: FONT_SHA256, license: FONT_LICENSE, sourcePackage: "@fontsource/outfit" }) });
}

export function compileAnimationIRToHtml(ir) {
  return ir.profileVersion === "1.1.0" && ir.content?.semantic?.profileId === "wow_signal_case_v1" ? compileSemanticAnimationIRToHtml(ir) : compileLegacyAnimationIRToHtml(ir);
}
