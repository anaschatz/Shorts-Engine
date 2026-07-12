import { createHash } from "node:crypto";
import { createOperationSchedule } from "./operation-scheduler.mjs";
import { createPathMorph, pointsToPath } from "./primitives/path-morph.mjs";

const BASE_WIDTH = 720;
const BASE_HEIGHT = 1280;

function seededPoints(seed, count) {
  let state = seed >>> 0;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = 30 + (state / 0xffffffff) * 660;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const y = 40 + (state / 0xffffffff) * 820;
    points.push({ x: x.toFixed(2), y: y.toFixed(2), r: (0.5 + (index % 4) * 0.35).toFixed(2), phase: index % 29 });
  }
  return points;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function compileAnimationIRToHtml(ir) {
  const stars = seededPoints(ir.seed, 54).map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${point.r}" data-phase="${point.phase}"/>`).join("");
  const schedule = createOperationSchedule(ir);
  const morph = createPathMorph();
  const path = pointsToPath(morph.source);
  const runtimeData = safeJson({ fps: ir.fps, durationFrames: ir.durationFrames, seed: ir.seed, contentHash: ir.contentHash, schedule, morph: { pointCount: morph.pointCount, source: morph.source, target: morph.target } });
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'">
<meta data-composition-id="wow-signal-benchmark" data-width="${ir.width}" data-height="${ir.height}">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#030712}*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#030712}.composition svg{display:block;width:100%;height:100%;font-family:Arial,Helvetica,sans-serif}.stars{fill:#a5f3fc}.grid{stroke:#164e63;stroke-width:1}.micro{font-size:12px;letter-spacing:4px;font-weight:700}.label{font-size:18px;letter-spacing:2px;font-weight:700}.title{font-size:38px;font-weight:800}.mono{font-family:Menlo,Consolas,monospace}
</style></head><body>
<main id="wow-root" class="composition" data-composition-id="wow-signal-benchmark" data-start="0" data-duration="10" data-width="${ir.width}" data-height="${ir.height}">
<svg viewBox="0 0 ${BASE_WIDTH} ${BASE_HEIGHT}" role="img" aria-label="Animated explanatory visualization of the Wow signal">
<defs>
 <radialGradient id="bg" cx="50%" cy="32%" r="80%"><stop offset="0" stop-color="#10213a"/><stop offset="0.55" stop-color="#07111f"/><stop offset="1" stop-color="#02040b"/></radialGradient>
 <linearGradient id="signal" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="0.55" stop-color="#a5f3fc"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>
 <radialGradient id="payoff" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#fbbf24" stop-opacity=".22"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/></radialGradient>
 <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <pattern id="grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" class="grid" opacity=".46"/></pattern>
</defs>
<rect width="720" height="1280" fill="url(#bg)"/>
<g id="ambient-stars" class="stars" opacity=".22">${stars}</g>
<g id="camera-stage">
 <rect id="grid" x="42" y="190" width="636" height="650" rx="22" fill="url(#grid-pattern)" opacity=".78"/>
 <line x1="70" y1="515" x2="650" y2="515" stroke="#155e75" stroke-width="2" opacity=".72"/>
 <line x1="360" y1="235" x2="360" y2="795" stroke="#155e75" stroke-width="2" opacity=".5"/>
 <g id="header"><text x="54" y="78" fill="#67e8f9" class="micro">SIGNAL LAB / 1977</text><text x="54" y="126" fill="#e2e8f0" class="title" textLength="612" lengthAdjust="spacingAndGlyphs">THE SIGNAL THAT APPEARED ONCE</text><text x="55" y="158" fill="#64748b" class="label mono">1420 MHz · 72 SEC · SINGLE OBSERVATION</text></g>
 <path id="beam-a" d="M76 720 C220 330 500 330 646 720" fill="none" stroke="#8b5cf6" stroke-width="8" opacity="0" filter="url(#glow)"/>
 <path id="beam-b" d="M76 330 C225 720 500 720 646 330" fill="none" stroke="#f59e0b" stroke-width="8" opacity="0" filter="url(#glow)"/>
 <circle id="pulse-halo" cx="360" cy="515" r="34" fill="none" stroke="#67e8f9" stroke-width="6" opacity="0"/>
 <circle id="pulse-core" cx="360" cy="515" r="10" fill="#ecfeff" opacity="0" filter="url(#glow)"/>
 <path id="wave-glow" d="${path}" fill="none" stroke="#22d3ee" stroke-width="14" opacity=".18" filter="url(#glow)"/>
 <path id="wave" d="${path}" pathLength="1000" fill="none" stroke="url(#signal)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1000" stroke-dashoffset="1000"/>
 <g id="evidence-node" opacity="0"><circle cx="360" cy="515" r="80" fill="#0c4a6e" opacity=".82"/><circle cx="360" cy="515" r="57" fill="none" stroke="#bae6fd" stroke-width="2" stroke-dasharray="8 12"/><text x="360" y="508" text-anchor="middle" fill="#ecfeff" font-size="14" font-weight="800" letter-spacing="3">EVIDENCE</text><text x="360" y="536" text-anchor="middle" fill="#67e8f9" font-size="19" font-weight="800">6EQUJ5</text></g>
 <g id="payoff-panel" opacity="0"><circle id="payoff-field" cx="360" cy="515" r="210" fill="url(#payoff)"/><text x="360" y="682" text-anchor="middle" fill="#fde68a" font-size="39" font-weight="800">UNEXPLAINED</text><text x="360" y="724" text-anchor="middle" fill="#94a3b8" font-size="22" font-weight="700" letter-spacing="3">IS NOT PROOF</text><line x1="230" y1="752" x2="490" y2="752" stroke="#fbbf24" stroke-width="3"/></g>
 <g id="status"><circle cx="60" cy="890" r="5" fill="#22d3ee"/><text x="76" y="896" fill="#94a3b8" class="label">continuous observation trace</text><text id="frame-readout" x="660" y="896" text-anchor="end" fill="#475569" class="label mono">F000</text></g>
</g>
<rect x="0" y="947" width="720" height="333" fill="#030712" opacity=".78" data-caption-safe-zone="true"/>
<line x1="54" y1="947" x2="666" y2="947" stroke="#0f253b" stroke-width="1"/>
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
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
 const ambient=frame/DATA.durationFrames;
 byId("ambient-stars").setAttribute("transform","translate("+(Math.sin(ambient*6.283)*3).toFixed(3)+" "+(Math.cos(ambient*6.283)*2).toFixed(3)+")");
 byId("ambient-stars").setAttribute("opacity",(.18+.055*Math.sin(ambient*12.566)).toFixed(4));
 const transition=progress(frame,"transition_match:evidence_node");
 const gridCreate=progress(frame,"create:signal_grid");byId("grid").setAttribute("opacity",((.66+.09*Math.sin(ambient*6.283))*gridCreate*(1-.72*transition)).toFixed(4));
 const draw=progress(frame,"draw_path:signal_wave"); byId("wave").style.strokeDashoffset=String(1000*(1-draw));
 const pulse=pulseEnvelope(frame,"pulse:signal_pulse");
 byId("pulse-core").setAttribute("opacity",pulse.toFixed(4)); byId("pulse-core").setAttribute("r",String(8+10*pulse));
 const haloScale=1+(DATA.schedule["pulse:signal_pulse"].params.scale-1)*pulse; byId("pulse-halo").setAttribute("opacity",(pulse*DATA.schedule["pulse:signal_pulse"].params.opacity).toFixed(4)); byId("pulse-halo").setAttribute("transform","translate("+(360*(1-haloScale))+" "+(515*(1-haloScale))+") scale("+haloScale+")");
 const beamA=progress(frame,"draw_path:beam_alpha"),beamB=progress(frame,"draw_path:beam_beta"),beamVisibility=1-transition; byId("beam-a").setAttribute("opacity",(.62*beamA*beamVisibility).toFixed(4)); byId("beam-b").setAttribute("opacity",(.54*beamB*beamVisibility).toFixed(4));
 byId("beam-a").style.strokeDasharray="900";byId("beam-b").style.strokeDasharray="900";byId("beam-a").style.strokeDashoffset=String(900*(1-beamA));byId("beam-b").style.strokeDashoffset=String(900*(1-beamB));
 const push=progress(frame,"camera_push:camera_stage"),zoom=1+(DATA.schedule["camera_push:camera_stage"].params.scale-1)*push; byId("camera-stage").setAttribute("transform","translate("+(360*(1-zoom)).toFixed(3)+" "+(515*(1-zoom)).toFixed(3)+") scale("+zoom.toFixed(5)+")");
 const morph=progress(frame,"morph_path:signal_wave"),morphed=morphPath(morph);byId("wave").setAttribute("d",morphed);byId("wave-glow").setAttribute("d",morphed);byId("wave-glow").setAttribute("opacity",(.18-.1*morph).toFixed(4));
 const evidenceScale=progress(frame,"scale:evidence_node"),nodeScale=1+(DATA.schedule["scale:evidence_node"].params.to-1)*evidenceScale;byId("evidence-node").setAttribute("opacity",(morph*(1-.18*transition)).toFixed(4));byId("evidence-node").setAttribute("transform","translate("+(360*(1-nodeScale))+" "+(515*(1-nodeScale))+") scale("+nodeScale+")");
 const payoff=progress(frame,"fade:payoff_label"),fieldPulse=pulseEnvelope(frame,"pulse:deep_background"); byId("payoff-panel").setAttribute("opacity",payoff.toFixed(4)); byId("payoff-field").setAttribute("r",String(90+175*Math.max(transition,fieldPulse)));
 byId("header").setAttribute("opacity",(1-.82*transition).toFixed(4));byId("status").setAttribute("opacity",(1-.72*transition).toFixed(4));
 byId("frame-readout").textContent="F"+String(frame).padStart(3,"0");
 document.documentElement.dataset.renderedFrame=String(frame);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]}};
window.__timelines=window.__timelines||{};window.__timelines["wow-signal-benchmark"]=timeline;renderFrame(0);
</script></body></html>`;
  return Object.freeze({ html, compositionHash: createHash("sha256").update(html).digest("hex") });
}
