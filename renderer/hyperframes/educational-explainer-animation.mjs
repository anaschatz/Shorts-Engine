import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");

function escapeXml(value) {
  return String(value)
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

function bounded(value, maximum = 72) {
  const normalized = String(value || "").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trim()}…`;
}

function visualMarkup(cue, index) {
  const accent = cue.accentTone === "signal" ? "#ef4444" : "#a78bfa";
  const offset = index % 3;
  const common = `fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
  const white = 'fill="none" stroke="#f8fafc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';
  switch (cue.recipe) {
    case "line_chart":
      return `<g ${white}><path d="M155 660V355M155 660H575"/><path class="draw-path" pathLength="100" d="M175 625C240 592 264 610 314 530S410 505 458 430 525 400 555 365" ${common}/>${[["205","585"],["314","530"],["458","430"],["555","365"]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${accent}" stroke="none"/>`).join("")}</g>`;
    case "branching_tree":
      return `<g ${white}><circle cx="360" cy="390" r="46"/><path class="draw-path" pathLength="100" d="M360 436V500M360 500L210 585M360 500L360 610M360 500L510 585" ${common}/><circle cx="210" cy="585" r="35"/><circle cx="360" cy="610" r="35"/><circle cx="510" cy="585" r="35"/></g>`;
    case "process_flow":
      return `<g ${white}><rect x="115" y="450" width="135" height="90" rx="24"/><rect x="292" y="450" width="135" height="90" rx="24"/><rect x="469" y="450" width="135" height="90" rx="24"/><path class="draw-path" pathLength="100" d="M250 495H292M427 495H469M278 480L292 495 278 510M455 480L469 495 455 510" ${common}/></g>`;
    case "evidence_lens":
      return `<g ${white}><rect x="135" y="360" width="330" height="270" rx="28"/><path d="M175 420H390M175 470H425M175 520H350" opacity=".55"/><circle cx="430" cy="540" r="104" stroke="${accent}" stroke-width="7"/><path class="draw-path" pathLength="100" d="M503 613L580 690" ${common}/><circle cx="${315 + offset * 38}" cy="${455 + offset * 30}" r="16" fill="${accent}" stroke="none"/></g>`;
    case "timeline":
      return `<g ${white}><path class="draw-path" pathLength="100" d="M115 515H605" ${common}/>${[150, 270, 390, 510, 585].map((x, point) => `<circle cx="${x}" cy="515" r="${point === offset + 1 ? 17 : 10}" fill="${point === offset + 1 ? accent : "#030303"}"/><path d="M${x} 490V540"/>`).join("")}</g>`;
    case "comparison":
      return `<g ${white}><rect x="105" y="350" width="230" height="330" rx="32"/><rect x="385" y="350" width="230" height="330" rx="32"/><path d="M220 410V610M185 575L220 610 255 575M500 610V410M465 445L500 410 535 445" stroke="${accent}" stroke-width="6"/><text x="360" y="535" fill="${accent}" stroke="none" font-size="44" text-anchor="middle">≠</text></g>`;
    case "map_route":
      return `<g ${white}><path d="M120 390C210 330 250 410 330 365S480 335 590 400V650C470 600 415 675 330 625S210 650 120 600Z"/><path class="draw-path" pathLength="100" d="M175 550C235 450 330 570 390 460S500 430 555 500" ${common} stroke-dasharray="12 14"/><circle cx="175" cy="550" r="13" fill="#f8fafc"/><circle cx="555" cy="500" r="16" fill="${accent}" stroke="none"/></g>`;
    case "counter":
      return `<g ${white}><circle cx="360" cy="505" r="165"/><path class="draw-path" pathLength="100" d="M360 340A165 165 0 1 1 216 585" ${common}/><text x="360" y="540" fill="#f8fafc" stroke="none" font-size="102" text-anchor="middle">${index + 1}</text></g>`;
    case "formula":
      return `<g ${white}><rect x="95" y="390" width="530" height="235" rx="34"/><text x="360" y="520" fill="#f8fafc" stroke="none" font-size="54" text-anchor="middle">signal + context</text><path class="draw-path" pathLength="100" d="M205 565H515" ${common}/><text x="360" y="605" fill="${accent}" stroke="none" font-size="28" text-anchor="middle">meaning</text></g>`;
    default:
      return `<g ${white}><circle cx="360" cy="390" r="62"/><path d="M360 452V590M360 495L265 555M360 495L455 555M360 590L295 690M360 590L425 690"/><path class="draw-path" pathLength="100" d="M170 405C220 350 270 350 315 390M405 390C450 350 500 350 550 405" ${common}/></g>`;
  }
}

export function compileEducationalExplainerAnimationIRToHtml(ir) {
  const educational = ir.content?.educationalExplainer;
  if (!educational) throw new TypeError("Educational explainer artifacts are required.");
  const { referenceStyleSpec: style, narrativeBeatGraph: graph, directorPlan } = educational;
  const cueByMicrobeat = new Map(
    directorPlan.microbeats.map((cue) => [cue.microbeatId, cue]),
  );
  const cues = graph.microbeats.map((microbeat) => ({
    ...cueByMicrobeat.get(microbeat.id),
    startFrame: microbeat.startFrame,
    endFrame: microbeat.endFrame,
    sectionId: microbeat.sectionId,
  }));
  if (cues.some((cue) => !cue.id)) throw new TypeError("DirectorPlan microbeat coverage is incomplete.");
  const cueMarkup = cues.map((cue, index) => `
<g id="visual_${cue.id}" class="visual-state" data-visual-state-id="${cue.id}" data-recipe="${cue.recipe}" data-transition="${cue.transition}" opacity="0">
  <g class="recipe-stage">${visualMarkup(cue, index)}</g>
  <text id="${cue.id}_label" x="360" y="744" class="object-label" text-anchor="middle" data-legibility-role="object_label">${escapeXml(bounded(cue.typography.label.toUpperCase(), 34))}</text>
  <text id="${cue.id}_phrase" x="360" y="855" class="semantic-phrase" text-anchor="middle" data-legibility-role="semantic_phrase">${escapeXml(bounded(cue.typography.semanticPhrase, 76))}</text>
</g>`).join("");
  const overview = directorPlan.sections.map((section, index) => {
    const x = 94 + (index % 3) * 220;
    const y = 385 + Math.floor(index / 3) * 165;
    return `<g class="overview-node" style="--overview-index:${index}" transform="translate(${x} ${y})"><circle r="28"/><text y="62" text-anchor="middle">${escapeXml(section.sectionId.replace("section_", "").toUpperCase())}</text></g>`;
  }).join("");
  const sectionTitles = Object.fromEntries(
    directorPlan.sections.map((section) => {
      const firstCue = cues.find((cue) => cue.sectionId === section.sectionId);
      return [section.sectionId, firstCue?.typography.sectionTitle || directorPlan.promise.title];
    }),
  );
  const runtimeData = safeJson({
    fps: ir.fps,
    durationFrames: ir.durationFrames,
    overviewFrames: Math.min(ir.durationFrames, Math.round(style.pacing.overviewCompleteBySeconds * ir.fps)),
    cues: cues.map((cue) => ({
      id: cue.id,
      startFrame: cue.startFrame,
      endFrame: cue.endFrame,
      sectionId: cue.sectionId,
      transition: cue.transition,
    })),
    visualEvents: directorPlan.visualEvents,
    sectionTitles,
  });
  const palette = style.palette;
  const title = bounded(directorPlan.promise.title, 82);
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'">
<meta data-composition-id="${escapeXml(ir.content.compositionId)}" data-width="${ir.width}" data-height="${ir.height}" data-font-sha256="${FONT_SHA256}" data-reference-style-spec-hash="${style.contentHash}" data-director-plan-hash="${directorPlan.contentHash}">
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${palette.background}}*{box-sizing:border-box}
.composition{width:100vw;height:100vh;background:${palette.background};overflow:hidden}.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}
.promise{font-size:42px;font-weight:600;fill:${palette.primary}}.section-title{font-size:24px;letter-spacing:3px;fill:${palette.accent}}
.semantic-phrase{font-size:27px;fill:${palette.primary}}.object-label{font-size:15px;letter-spacing:3px;fill:${palette.muted}}
.visual-state{transform-origin:360px 520px}.draw-path{stroke-dasharray:100;stroke-dashoffset:100}
.overview-node circle{fill:${palette.background};stroke:${palette.accent};stroke-width:4}.overview-node text{fill:${palette.primary};font-size:15px;letter-spacing:2px}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${escapeXml(ir.content.compositionId)}" data-start="0" data-duration="${ir.durationFrames / ir.fps}" data-width="${ir.width}" data-height="${ir.height}">
<svg viewBox="0 0 720 1280" role="img" aria-label="${escapeXml(title)}">
<defs>
 <filter id="focus-blur"><feGaussianBlur stdDeviation="5"/></filter>
 <filter id="soft-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <linearGradient id="bottom-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.background}" stop-opacity="0"/><stop offset="1" stop-color="${palette.background}" stop-opacity=".92"/></linearGradient>
</defs>
<rect width="720" height="1280" fill="${palette.background}"/>
<circle id="ambient-orbit" cx="360" cy="560" r="310" fill="none" stroke="${palette.accent}" stroke-width="1" opacity=".09"/>
<rect x="36" y="180" width="648" height="720" fill="none" data-semantic-roi="true" pointer-events="none"/>
<g id="promise_header" data-entity-id="promise_header" data-persistent-entity="true" data-caption-policy="avoid">
 <text id="promise_title" x="360" y="105" class="promise" text-anchor="middle" data-legibility-role="promise_title">${escapeXml(title)}</text>
 <line x1="255" y1="142" x2="465" y2="142" stroke="${palette.accent}" stroke-width="4"/>
</g>
<g id="story_thread" data-entity-id="story_thread" data-persistent-entity="true" opacity=".65">
 <line x1="90" y1="950" x2="630" y2="950" stroke="${palette.muted}" stroke-width="2"/>
 <line id="thread_progress" x1="90" y1="950" x2="90" y2="950" stroke="${palette.accent}" stroke-width="5"/>
 <circle id="thread_cursor" cx="90" cy="950" r="9" fill="${palette.primary}"/>
</g>
<text id="section_title" x="360" y="205" text-anchor="middle" class="section-title" data-legibility-role="section_title">OVERVIEW</text>
<g id="overview" opacity="1"><path d="M120 515H600" stroke="${palette.muted}" stroke-width="2" opacity=".35"/>${overview}</g>
<g id="microbeat_stage">${cueMarkup}</g>
<g id="cta_scene" opacity="0" data-entity-id="cta_network">
 <circle cx="360" cy="485" r="74" fill="none" stroke="${palette.accent}" stroke-width="5"/>
 ${[0, 1, 2, 3, 4, 5].map((entry) => {
    const angle = (Math.PI * 2 * entry) / 6;
    const x = 360 + Math.cos(angle) * 190;
    const y = 485 + Math.sin(angle) * 190;
    return `<line x1="360" y1="485" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${palette.accent}" stroke-width="3"/><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="28" fill="${palette.background}" stroke="${palette.primary}" stroke-width="3"/>`;
  }).join("")}
 <text x="360" y="805" text-anchor="middle" class="semantic-phrase">FOLLOW THE THREAD</text>
</g>
<rect x="0" y="972" width="720" height="308" fill="url(#bottom-fade)" data-caption-safe-zone="true" pointer-events="none"/>
</svg></main>
<script>
"use strict";
const DATA=${runtimeData};
const byId=(id)=>document.getElementById(id);
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=(v)=>{const x=clamp(v);return x*x*(3-2*x)};
const activeCue=(frame)=>DATA.cues.find((cue)=>frame>=cue.startFrame&&frame<cue.endFrame)||DATA.cues.at(-1);
const activeVisualEvent=(frame)=>{let active=DATA.visualEvents[0];for(const event of DATA.visualEvents)if(frame>=event.frame)active=event;return active};
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7))),overviewProgress=clamp(frame/Math.max(1,DATA.overviewFrames)),cue=activeCue(frame),visualEvent=activeVisualEvent(frame),cueProgress=ease((frame-cue.startFrame)/Math.max(1,Math.min(18,cue.endFrame-cue.startFrame))),focusShift=visualEvent.type==="focus_shift"?1:0;
 byId("overview").setAttribute("opacity",String(1-overviewProgress));
 byId("overview").setAttribute("transform","translate(0 "+(-24*overviewProgress).toFixed(3)+") scale("+(1-.04*overviewProgress).toFixed(4)+")");
 document.querySelectorAll(".visual-state").forEach((node)=>{const active=node.id==="visual_"+cue.id;node.setAttribute("opacity",active?cueProgress.toFixed(4):"0");node.setAttribute("filter",active&&cueProgress<.65?"url(#focus-blur)":"none");node.setAttribute("transform",active?"translate("+(focusShift*8).toFixed(3)+" "+(22*(1-cueProgress)-focusShift*6).toFixed(3)+") scale("+(0.94+.06*cueProgress+.025*focusShift).toFixed(4)+")":"scale(.94)");node.querySelectorAll(".draw-path").forEach((path)=>{path.style.strokeDashoffset=active?String(100*(1-cueProgress)):"100"})});
 byId("section_title").textContent=DATA.sectionTitles[cue.sectionId]||"EXPLAINER";
 const storyProgress=clamp(frame/Math.max(1,DATA.durationFrames-1)),x=90+540*storyProgress;byId("thread_progress").setAttribute("x2",x.toFixed(3));byId("thread_cursor").setAttribute("cx",x.toFixed(3));
 byId("ambient-orbit").setAttribute("transform","rotate("+((frame*.06)%360).toFixed(3)+" 360 560)");
 const cta=cue===DATA.cues.at(-1)?clamp((frame-cue.startFrame)/24):0;byId("cta_scene").setAttribute("opacity",cta.toFixed(4));byId("microbeat_stage").setAttribute("opacity",String(1-.82*cta));
 document.documentElement.dataset.renderedFrame=String(frame);document.documentElement.dataset.activeVisualStateId=cue.id;document.documentElement.dataset.activeVisualEventId=visualEvent.id;document.documentElement.dataset.activeSectionId=cue.sectionId;document.documentElement.dataset.activeTransitionId=cue.transition;document.documentElement.dataset.promiseVisible="true";
}
let currentTime=0,rate=1;const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]}};
window.__timelines=window.__timelines||{};window.__timelines[${safeJson(ir.content.compositionId)}]=timeline;renderFrame(0);
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
