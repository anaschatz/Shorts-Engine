import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FONT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function validateWowSignalGoldenFixture(input) {
  const value = structuredClone(input);
  if (
    value?.schemaVersion !== 1
    || value?.profile !== "educational_explainer_manual_golden_v1"
    || value?.fps !== 30
    || value?.width !== 1080
    || value?.height !== 1920
    || value?.durationFrames < 360
    || value?.durationFrames > 450
  ) {
    throw new TypeError("The manual Wow signal golden fixture is invalid.");
  }
  if (
    value.audio?.speed !== 1
    || !Array.isArray(value.audio.edits)
    || value.audio.edits.some((edit) => (
      edit.outputEndFrame <= edit.outputStartFrame
      || (edit.type === "source" && (
        edit.sourceEndFrame <= edit.sourceStartFrame
        || edit.sourceEndFrame - edit.sourceStartFrame
          !== edit.outputEndFrame - edit.outputStartFrame
      ))
    ))
  ) {
    throw new TypeError("The golden narration edit must preserve natural speed.");
  }
  const edits = [...value.audio.edits].sort(
    (left, right) => left.outputStartFrame - right.outputStartFrame,
  );
  if (
    edits[0].outputStartFrame !== 0
    || edits.at(-1).outputEndFrame !== value.durationFrames
    || edits.some((edit, index) => (
      index > 0 && edit.outputStartFrame !== edits[index - 1].outputEndFrame
    ))
  ) {
    throw new TypeError("The golden narration edits must cover the exact frame clock.");
  }
  if (
    value.anchors.wowWriteLandFrame < value.anchors.wowWordStartFrame
    || value.anchors.wowWriteLandFrame > value.anchors.wowWordEndFrame
    || value.anchors.seventyTwoRevealFrame
      !== value.anchors.seventyTwoWordStartFrame
  ) {
    throw new TypeError("The golden narration anchors are invalid.");
  }
  const allowed = new Set([
    "The signal that appeared once",
    "signal strength",
    "Wow!",
    "72 seconds",
  ]);
  if (
    value.visibleTextAllowlist.length !== allowed.size
    || value.visibleTextAllowlist.some((entry) => !allowed.has(entry))
  ) {
    throw new TypeError("The golden visible-text allowlist is invalid.");
  }
  return Object.freeze(value);
}

export function compileWowSignalGoldenHtml(input) {
  const fixture = validateWowSignalGoldenFixture(input);
  const runtime = safeJson({
    fps: fixture.fps,
    durationFrames: fixture.durationFrames,
    anchors: fixture.anchors,
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; img-src data:; media-src 'none'; object-src 'none'; frame-src 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta data-golden-profile="${escapeXml(fixture.profile)}" data-font-sha256="${FONT_SHA256}">
<style>
@font-face{font-family:Outfit;src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#030303}
body{position:relative;font-family:Outfit,sans-serif}
svg{display:block;position:relative;z-index:1;width:100%;height:100%;font-family:Outfit,sans-serif}
.promise-overlay{position:absolute;z-index:2;top:38px;left:0;width:100%;color:#f8fafc;font-size:29px;line-height:1.15;text-align:center;pointer-events:none}
.promise-overlay::after{content:"";display:block;width:122px;height:3px;margin:14px auto 0;border-radius:3px;background:#a78bfa}
.white{fill:none;stroke:#f8fafc;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.muted{fill:none;stroke:#64748b;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.purple{fill:none;stroke:#a78bfa;stroke-width:7;stroke-linecap:round;stroke-linejoin:round}
.red{fill:none;stroke:#ef4444;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}
.label{fill:#cbd5e1;font-size:30px;letter-spacing:5px}
.draw{stroke-dasharray:100;stroke-dashoffset:100}
</style>
</head>
<body>
<div id="promiseTitleOverlay" class="promise-overlay" data-visible-text="The signal that appeared once">The signal that appeared once</div>
<svg viewBox="0 0 1080 1920" role="img" aria-label="The signal that appeared once">
  <defs>
    <radialGradient id="peakGlow"><stop offset="0" stop-color="#a78bfa" stop-opacity=".48"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient>
    <linearGradient id="paperFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#111827"/><stop offset="1" stop-color="#05070b"/></linearGradient>
    <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="1080" height="1920" fill="#030303"/>

  <g id="sky">
    <circle cx="804" cy="354" r="8" fill="#f8fafc"/>
    <circle cx="860" cy="286" r="4" fill="#94a3b8"/>
    <circle cx="726" cy="270" r="3" fill="#94a3b8"/>
    <circle cx="925" cy="410" r="3" fill="#94a3b8"/>
    <path id="signalWaveA" d="M790 366q14 18 0 36t0 36" class="purple draw" pathLength="100"/>
    <path id="signalWaveB" d="M812 354q30 30 0 60t0 60" class="purple draw" pathLength="100" opacity=".65"/>
  </g>

  <g id="telescope" transform-origin="330px 1020px">
    <path id="dish" d="M176 860C220 1030 392 1094 520 956C395 1000 276 960 176 860Z" class="white draw" pathLength="100"/>
    <path id="dishArm" d="M348 982L421 863M405 888L457 832" class="white draw" pathLength="100"/>
    <circle cx="465" cy="823" r="18" fill="#a78bfa"/>
    <path id="mount" d="M346 1020V1285M258 1320H434M290 1285L246 1320M402 1285L446 1320" class="white draw" pathLength="100"/>
    <path id="arrivalPath" d="M794 376C700 510 602 648 465 823" class="purple draw" pathLength="100"/>
  </g>

  <g id="overviewTrace" transform-origin="738px 1000px">
    <path d="M596 1095V858M596 1095H922" class="muted"/>
    <path id="overviewSignal" d="M610 1070C650 1062 684 1048 716 1012C756 968 777 882 808 840C840 886 862 970 900 1068" class="purple draw" pathLength="100"/>
    <path id="overviewConnector" d="M520 956C570 976 586 996 610 1030" class="muted draw" pathLength="100"/>
    <path id="overviewWowConnector" d="M808 840C858 796 892 770 934 748" class="muted draw" pathLength="100"/>
    <g id="overviewWow" transform="translate(908 682) scale(.42)" opacity="0">
      <path d="M0 0L28 90L58 22L86 90L116 0M132 57C132 27 180 27 180 57S132 87 132 57M196 28L218 88L242 38L266 88L290 28M315 18V68M315 91v3" class="red"/>
    </g>
  </g>

  <g id="signalStage" transform-origin="540px 1000px">
    <rect id="printout" x="116" y="450" width="848" height="880" rx="42" fill="url(#paperFade)" stroke="#334155" stroke-width="4" opacity="0"/>
    <g id="grid" opacity="0">
      <path d="M190 570H900M190 690H900M190 810H900M190 930H900M190 1050H900M190 1170H900" class="muted" opacity=".28"/>
      <path d="M260 525V1220M380 525V1220M500 525V1220M620 525V1220M740 525V1220M860 525V1220" class="muted" opacity=".22"/>
    </g>
    <text id="signalLabel" x="190" y="1268" class="label" opacity="0" data-visible-text="signal strength">signal strength</text>
    <circle id="peakGlow" cx="620" cy="684" r="190" fill="url(#peakGlow)" opacity="0"/>
    <path id="persistentTrace" d="M190 1110C280 1102 350 1086 425 1036C500 986 560 812 620 672C680 812 740 986 890 1110" class="purple" pathLength="100"/>
    <circle id="peakDot" cx="620" cy="672" r="13" fill="#a78bfa" opacity="0"/>
    <path id="evidenceCircle" d="M524 586C606 522 724 555 754 666C782 770 694 850 586 828C478 806 442 660 524 586Z" class="red draw" pathLength="100"/>
  </g>

  <g id="handwrittenWow" transform="translate(676 1060)" opacity="0" data-visible-text="Wow!">
    <path id="wowPath" d="M0 0L28 90L58 22L86 90L116 0M132 57C132 27 180 27 180 57S132 87 132 57M196 28L218 88L242 38L266 88L290 28M315 18V68M315 91v3" class="red draw" pathLength="100"/>
  </g>

  <g id="durationStage" opacity="0">
    <path id="durationAxis" d="M190 1270H890" class="white draw" pathLength="100"/>
    <path d="M190 1238V1302M890 1238V1302" class="white"/>
    <circle id="durationCursor" cx="190" cy="1270" r="12" fill="#a78bfa"/>
    <text id="durationText" x="540" y="1400" fill="#f8fafc" font-size="76" text-anchor="middle" opacity="0" data-visible-text="72 seconds">72 seconds</text>
  </g>
</svg>
<script>
"use strict";
const DATA=${runtime};
const byId=(id)=>document.getElementById(id);
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const ease=(value)=>{const x=clamp(value);return x*x*(3-2*x)};
const progress=(frame,start,end)=>ease((frame-start)/Math.max(1,end-start));
const setDraw=(id,value)=>byId(id).style.strokeDashoffset=String(100*(1-clamp(value)));
const tracePoints=[[190,1110],[280,1102],[350,1086],[425,1036],[500,986],[560,812],[620,672],[680,812],[740,986],[890,1110]];
const timePoints=[[190,1110],[268,1096],[346,1082],[424,1042],[502,970],[580,846],[658,970],[736,1042],[814,1082],[890,1110]];
const mix=(a,b,t)=>a+(b-a)*t;
function tracePath(t){
 const p=tracePoints.map((point,index)=>[mix(point[0],timePoints[index][0],t),mix(point[1],timePoints[index][1],t)]);
 return "M"+p.map((point)=>point.map((value)=>value.toFixed(2)).join(" ")).join("L");
}
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
 byId("promiseTitleOverlay").style.opacity=frame%2===0?"1":".9999";
 const overview=progress(frame,0,78);
 setDraw("dish",progress(frame,0,34));
 setDraw("dishArm",progress(frame,8,38));
 setDraw("mount",progress(frame,18,52));
 setDraw("signalWaveA",progress(frame,18,48));
 setDraw("signalWaveB",progress(frame,28,60));
 setDraw("arrivalPath",progress(frame,42,78));
 setDraw("overviewSignal",progress(frame,54,78));
 setDraw("overviewConnector",progress(frame,48,72));
 setDraw("overviewWowConnector",progress(frame,58,78));
 byId("overviewWow").setAttribute("opacity",String(progress(frame,58,76)));

 const focus=progress(frame,78,96);
 byId("sky").setAttribute("opacity",String(1-focus));
 byId("telescope").setAttribute("transform","translate("+(-130*focus).toFixed(2)+" "+(80*focus).toFixed(2)+") scale("+(1-.34*focus).toFixed(4)+")");
 byId("telescope").setAttribute("opacity",String(1-focus));
 byId("overviewTrace").setAttribute("opacity",String(1-focus));
 byId("overviewTrace").setAttribute("transform","translate("+(-198*focus).toFixed(2)+" "+(-140*focus).toFixed(2)+") scale("+(1+1.44*focus).toFixed(4)+")");

 const traceDraw=progress(frame,84,126);
 byId("signalStage").setAttribute("opacity",String(focus));
 byId("persistentTrace").style.strokeDasharray="100";
 byId("persistentTrace").style.strokeDashoffset=String(100*(1-traceDraw));
 byId("signalLabel").setAttribute("opacity",String(progress(frame,96,112)));
 byId("peakGlow").setAttribute("opacity",String(.9*progress(frame,108,126)));
 byId("peakDot").setAttribute("opacity",String(progress(frame,112,124)));

 const paper=progress(frame,126,150);
 byId("printout").setAttribute("opacity",String(.96*paper));
 byId("grid").setAttribute("opacity",String(paper));
 setDraw("evidenceCircle",progress(frame,144,176));

 const wowStart=166,wowLand=DATA.anchors.wowWriteLandFrame;
 const wowProgress=progress(frame,wowStart,wowLand);
 byId("handwrittenWow").setAttribute("opacity",String(progress(frame,158,166)));
 setDraw("wowPath",wowProgress);
 const wowSettle=progress(frame,wowLand,252);
 byId("handwrittenWow").setAttribute("transform","translate("+(676+20*wowSettle).toFixed(2)+" "+(1060+460*wowSettle).toFixed(2)+") scale("+(1-.28*wowSettle).toFixed(4)+")");

 const morph=progress(frame,DATA.anchors.durationMorphStartFrame,252);
 byId("persistentTrace").setAttribute("d",tracePath(morph));
 byId("signalStage").setAttribute("transform","translate(0 "+(-160*morph).toFixed(2)+") scale("+(1-.08*morph).toFixed(4)+")");
 byId("printout").setAttribute("opacity",String(.96*(1-morph)));
 byId("grid").setAttribute("opacity",String(1-morph));
 byId("signalLabel").setAttribute("opacity",String(1-morph));
 byId("peakGlow").setAttribute("opacity",String(.9*(1-morph)));
 byId("peakDot").setAttribute("opacity",String(1-.4*morph));
 byId("evidenceCircle").setAttribute("opacity",String(1-.35*morph));
 byId("durationStage").setAttribute("opacity",String(progress(frame,220,238)));
 setDraw("durationAxis",progress(frame,220,252));
 const cursorProgress=progress(frame,220,274);
 byId("durationCursor").setAttribute("cx",String(190+700*cursorProgress));
 byId("durationText").setAttribute("opacity",String(progress(frame,DATA.anchors.seventyTwoRevealFrame,DATA.anchors.seventyTwoRevealFrame+2)));

 const finalSettle=progress(frame,252,274);
 byId("signalStage").setAttribute("transform","translate(0 "+(-160-80*finalSettle).toFixed(2)+") scale("+(0.92-.04*finalSettle).toFixed(4)+")");
 document.documentElement.dataset.renderedFrame=String(frame);
 document.documentElement.dataset.overviewComplete=String(frame>=78);
 document.documentElement.dataset.wowLanded=String(frame>=DATA.anchors.wowWriteLandFrame);
 document.documentElement.dataset.durationVisible=String(frame>=DATA.anchors.seventyTwoRevealFrame);
}
let currentTime=0;
const timeline={
 duration:()=>DATA.durationFrames/DATA.fps,
 time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},
 totalTime(value){return value===undefined?currentTime:this.time(value)},
 seek(value){return this.time(value)},
 pause(){return this},
 play(){return this}
};
window.__timelines={wow_signal_manual_golden_v1:timeline};
renderFrame(0);
</script>
</body>
</html>`;
  return Object.freeze({
    html,
    compositionHash: createHash("sha256").update(html).digest("hex"),
    fontSha256: FONT_SHA256,
    durationFrames: fixture.durationFrames,
    fps: fixture.fps,
  });
}
