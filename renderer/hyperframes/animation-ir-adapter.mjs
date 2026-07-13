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

export function compileAnimationIRToHtml(ir) {
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
 const ambientX=2.8*Math.sin(frame*.037),ambientY=2.1*Math.cos(frame*.029),ambientOpacity=.88+.09*Math.sin(frame*.051);byId("ambient-grid-layer").setAttribute("transform","translate("+ambientX.toFixed(3)+" "+ambientY.toFixed(3)+")");byId("ambient-grid-layer").setAttribute("opacity",ambientOpacity.toFixed(4));byId("ambient-stars").setAttribute("transform","translate("+(1.8*Math.sin(frame*.023)).toFixed(3)+" "+(1.4*Math.cos(frame*.031)).toFixed(3)+")");byId("ambient-stars").setAttribute("opacity",(.16+.055*(1+Math.sin(frame*.043))).toFixed(4));
 const gridCreate=progress(frame,"create:signal_grid"),transition=progress(frame,"transition_match:evidence_node");
 byId("grid-group").setAttribute("opacity",((.20+.80*gridCreate)*(1-.72*transition)).toFixed(4));
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
