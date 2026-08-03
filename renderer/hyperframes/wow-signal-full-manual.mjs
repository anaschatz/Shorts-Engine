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

export function validateWowSignalFullManualFixture(input) {
  const value = structuredClone(input);
  if (
    value?.schemaVersion !== 1
    || value?.profile !== "educational_explainer_full_manual_v1"
    || value?.fps !== 30
    || value?.width !== 1080
    || value?.height !== 1920
    || value?.durationFrames !== 1031
  ) {
    throw new TypeError("The full manual Wow signal fixture is invalid.");
  }
  if (
    value.audio?.speed !== 1
    || value.audio?.transformation !== "complete_source_loudness_normalization_only"
    || !/^[a-f0-9]{64}$/.test(value.audio.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(value.alignment?.contentHash)
  ) {
    throw new TypeError("The full narration binding must preserve the complete natural-speed source.");
  }
  if (
    value.anchors.wowWriteLandFrame < value.anchors.wowWordStartFrame
    || value.anchors.wowWriteLandFrame > value.anchors.wowWordEndFrame
    || Math.abs(
      value.anchors.seventyTwoRevealFrame
        - value.anchors.seventyTwoWordStartFrame,
    ) > 2
    || value.anchors.speechEndFrame >= value.durationFrames
  ) {
    throw new TypeError("The full manual narration anchors are invalid.");
  }
  if (
    !Array.isArray(value.storyboard)
    || value.storyboard.length !== 10
    || value.storyboard[0].startFrame !== 0
    || value.storyboard.at(-1).endFrame !== value.durationFrames
    || value.storyboard.some((scene, index) => (
      scene.endFrame <= scene.startFrame
      || (index > 0 && scene.startFrame !== value.storyboard[index - 1].endFrame)
    ))
  ) {
    throw new TypeError("The full manual storyboard must cover the exact frame clock.");
  }
  const gaps = value.meaningfulChanges.slice(1).map(
    (event, index) => event.frame - value.meaningfulChanges[index].frame,
  );
  if (
    value.meaningfulChanges[0].frame !== 0
    || Math.max(...gaps) > value.fps * 3
    || value.meaningfulChanges.some((event, index) => (
      index > 0 && event.frame <= value.meaningfulChanges[index - 1].frame
    ))
  ) {
    throw new TypeError("Meaningful changes must be semantic and at most three seconds apart.");
  }
  const approvedText = new Set([
    "The signal that appeared once",
    "signal strength",
    "Wow!",
    "frequency",
    "72 seconds",
    "not proof",
    "unexplained",
    "no verified repeat",
  ]);
  if (
    value.visibleTextAllowlist.length !== approvedText.size
    || value.visibleTextAllowlist.some((entry) => !approvedText.has(entry))
  ) {
    throw new TypeError("The full manual visible-text allowlist is invalid.");
  }
  return Object.freeze(value);
}

export function compileWowSignalFullManualHtml(input) {
  const fixture = validateWowSignalFullManualFixture(input);
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
<meta data-full-manual-profile="${escapeXml(fixture.profile)}" data-font-sha256="${FONT_SHA256}">
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
.key-text{fill:#f8fafc;font-size:66px}
.draw{stroke-dasharray:100;stroke-dashoffset:100}
</style>
</head>
<body>
<div id="promiseTitleOverlay" class="promise-overlay" data-visible-text="The signal that appeared once">The signal that appeared once</div>
<svg viewBox="0 0 1080 1920" role="img" aria-label="The signal that appeared once">
  <defs>
    <radialGradient id="peakGlow"><stop offset="0" stop-color="#a78bfa" stop-opacity=".48"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient>
    <linearGradient id="paperFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#111827"/><stop offset="1" stop-color="#05070b"/></linearGradient>
    <linearGradient id="frequencyBand" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a78bfa" stop-opacity="0"/><stop offset=".5" stop-color="#a78bfa" stop-opacity=".38"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="#030303"/>

  <g id="overviewStage">
    <g id="sky">
      <circle cx="804" cy="354" r="8" fill="#f8fafc"/>
      <circle cx="860" cy="286" r="4" fill="#94a3b8"/>
      <circle cx="726" cy="270" r="3" fill="#94a3b8"/>
      <circle cx="925" cy="410" r="3" fill="#94a3b8"/>
      <path id="signalWaveA" d="M790 366q14 18 0 36t0 36" class="purple draw" pathLength="100"/>
      <path id="signalWaveB" d="M812 354q30 30 0 60t0 60" class="purple draw" pathLength="100" opacity=".65"/>
    </g>
    <g id="overviewTelescope">
      <path id="dish" d="M176 860C220 1030 392 1094 520 956C395 1000 276 960 176 860Z" class="white draw" pathLength="100"/>
      <path id="dishArm" d="M348 982L421 863M405 888L457 832" class="white draw" pathLength="100"/>
      <circle cx="465" cy="823" r="18" fill="#a78bfa"/>
      <path id="mount" d="M346 1020V1285M258 1320H434M290 1285L246 1320M402 1285L446 1320" class="white draw" pathLength="100"/>
      <path id="arrivalPath" d="M794 376C700 510 602 648 465 823" class="purple draw" pathLength="100"/>
    </g>
    <g id="overviewTrace">
      <path d="M596 1095V858M596 1095H922" class="muted"/>
      <path id="overviewSignal" d="M610 1070C650 1062 684 1048 716 1012C756 968 777 882 808 840C840 886 862 970 900 1068" class="purple draw" pathLength="100"/>
      <path id="overviewConnector" d="M520 956C570 976 586 996 610 1030" class="muted draw" pathLength="100"/>
      <path id="overviewWowConnector" d="M808 840C858 796 892 770 934 748" class="muted draw" pathLength="100"/>
      <g id="overviewWow" transform="translate(908 682) scale(.42)" opacity="0">
        <path d="M0 0L28 90L58 22L86 90L116 0M132 57C132 27 180 27 180 57S132 87 132 57M196 28L218 88L242 38L266 88L290 28M315 18V68M315 91v3" class="red"/>
      </g>
    </g>
  </g>

  <g id="printoutStage" opacity="0">
    <rect x="116" y="400" width="848" height="880" rx="42" fill="url(#paperFade)" stroke="#334155" stroke-width="4"/>
    <g id="printoutGrid">
      <path d="M190 520H900M190 640H900M190 760H900M190 880H900M190 1000H900M190 1120H900" class="muted" opacity=".28"/>
      <path d="M260 475V1170M380 475V1170M500 475V1170M620 475V1170M740 475V1170M860 475V1170" class="muted" opacity=".22"/>
    </g>
    <text id="signalLabel" x="190" y="1220" class="label" data-visible-text="signal strength">signal strength</text>
    <circle id="printoutGlow" cx="540" cy="560" r="190" fill="url(#peakGlow)"/>
    <path id="printoutCircle" d="M444 474C526 410 644 443 674 554C702 658 614 738 506 716C398 694 362 548 444 474Z" class="red draw" pathLength="100"/>
  </g>

  <path id="persistentTrace" d="M170 1040L280 1020L370 940L460 760L540 560L620 760L720 940L900 1040" class="purple" pathLength="100" opacity="0"/>

  <g id="handwrittenWow" transform="translate(650 1050)" opacity="0" data-visible-text="Wow!">
    <path id="wowPath" d="M0 0L28 90L58 22L86 90L116 0M132 57C132 27 180 27 180 57S132 87 132 57M196 28L218 88L242 38L266 88L290 28M315 18V68M315 91v3" class="red draw" pathLength="100"/>
  </g>

  <g id="frequencyStage" opacity="0">
    <path d="M150 940H930" class="white"/>
    <path d="M180 900V980M300 915V965M420 900V980M540 915V965M660 900V980M780 915V965M900 900V980" class="muted"/>
    <rect id="narrowBand" x="588" y="490" width="144" height="450" fill="url(#frequencyBand)" opacity="0"/>
    <path id="frequencyNeedle" d="M660 500V940" class="purple draw" pathLength="100"/>
    <circle cx="660" cy="940" r="14" fill="#a78bfa"/>
    <text id="frequencyLabel" x="540" y="1040" text-anchor="middle" class="label" data-visible-text="frequency">frequency</text>
    <g id="frequencyTelescope" transform="translate(60 760) scale(.42)">
      <path d="M176 0C220 170 392 234 520 96C395 140 276 100 176 0Z" class="white"/>
      <path d="M346 160V380M258 415H434" class="white"/>
    </g>
    <path id="frequencyLink" d="M300 910C390 760 500 660 660 590" class="muted draw" pathLength="100"/>
  </g>

  <g id="durationStage" opacity="0">
    <path id="durationAxis" d="M170 1120H910" class="white draw" pathLength="100"/>
    <path d="M170 1084V1156M910 1084V1156" class="white"/>
    <circle id="durationCursor" cx="170" cy="1120" r="13" fill="#a78bfa"/>
    <text id="durationText" x="540" y="1265" class="key-text" text-anchor="middle" opacity="0" data-visible-text="72 seconds">72 seconds</text>
  </g>

  <g id="beamStage" opacity="0">
    <circle id="fixedSourceGlow" cx="540" cy="520" r="92" fill="url(#peakGlow)"/>
    <circle id="fixedSource" cx="540" cy="520" r="18" fill="#f8fafc"/>
    <g id="beamCone">
      <path d="M430 1030L495 600L585 600L650 1030Z" fill="#a78bfa" opacity=".12" stroke="#a78bfa" stroke-width="4"/>
      <path d="M540 1030V600" class="purple" opacity=".65"/>
    </g>
    <g transform="translate(372 1030) scale(.36)">
      <path d="M176 0C220 170 392 234 520 96C395 140 276 100 176 0Z" class="white"/>
      <path d="M346 160V390M260 420H430" class="white"/>
    </g>
    <path d="M170 1500V1210M170 1500H910" class="muted"/>
  </g>

  <g id="interferenceStage" opacity="0">
    <rect id="interferenceBand" x="120" y="1030" width="840" height="280" rx="70" fill="#ef4444" opacity="0"/>
    <path id="localInterference" d="M170 1230L260 1120L340 1280L430 1060L520 1240L610 1110L700 1260L800 1080L900 1220" class="red draw" pathLength="100" opacity=".72"/>
    <circle id="interferenceFadeMask" cx="540" cy="1160" r="280" fill="#030303" opacity="0"/>
  </g>

  <g id="searchStage" opacity="0">
    <path d="M170 530L245 516L310 472L380 380L430 300L480 380L550 472L635 516" class="purple" opacity=".32"/>
    <path d="M170 680H910M170 860H910M170 1040H910" class="muted"/>
    <path id="scanOne" d="M170 680H910" class="purple draw" pathLength="100"/>
    <path id="scanTwo" d="M170 860H910" class="purple draw" pathLength="100"/>
    <path id="scanThree" d="M170 1040H910" class="purple draw" pathLength="100"/>
    <rect id="scanBeamOne" x="110" y="625" width="150" height="110" rx="28" fill="#a78bfa" opacity=".16"/>
    <rect id="scanBeamTwo" x="110" y="805" width="150" height="110" rx="28" fill="#a78bfa" opacity=".16"/>
    <rect id="scanBeamThree" x="110" y="985" width="150" height="110" rx="28" fill="#a78bfa" opacity=".16"/>
    <circle id="scanCursorOne" cx="170" cy="680" r="11" fill="#a78bfa"/>
    <circle id="scanCursorTwo" cx="170" cy="860" r="11" fill="#a78bfa"/>
    <circle id="scanCursorThree" cx="170" cy="1040" r="11" fill="#a78bfa"/>
  </g>

  <g id="matchStage" opacity="0">
    <path id="matchOne" d="M430 510C520 590 590 630 720 680" class="muted draw" pathLength="100"/>
    <path id="matchTwo" d="M430 510C520 680 590 760 720 860" class="muted draw" pathLength="100"/>
    <path id="matchThree" d="M430 510C520 760 590 900 720 1040" class="muted draw" pathLength="100"/>
    <circle id="emptyMatchOne" cx="750" cy="680" r="22" class="muted"/>
    <circle id="emptyMatchTwo" cx="750" cy="860" r="22" class="muted"/>
    <circle id="emptyMatchThree" cx="750" cy="1040" r="22" class="muted"/>
    <rect id="matchScanner" x="650" y="620" width="210" height="100" rx="32" fill="#a78bfa" opacity=".12"/>
  </g>

  <g id="honestStage" opacity="0">
    <rect x="170" y="390" width="740" height="700" rx="40" fill="url(#paperFade)" stroke="#334155" stroke-width="4"/>
    <path id="branchOne" d="M540 690C390 610 320 510 250 430" class="muted draw" pathLength="100"/>
    <path id="branchTwo" d="M540 690C650 560 730 490 830 430" class="muted draw" pathLength="100"/>
    <path id="branchThree" d="M540 690C650 790 760 870 850 980" class="muted draw" pathLength="100"/>
    <circle cx="540" cy="690" r="118" class="red"/>
    <text id="notProofText" x="540" y="1280" class="key-text" text-anchor="middle" opacity="0" data-visible-text="not proof">not proof</text>
  </g>

  <g id="finalStage" opacity="0">
    <circle id="finalCircle" cx="540" cy="505" r="130" class="red draw" pathLength="100"/>
    <path id="finalRepeatOne" d="M190 1120H890" class="muted draw" pathLength="100"/>
    <path id="finalRepeatTwo" d="M190 1240H890" class="muted draw" pathLength="100"/>
    <path id="finalRepeatThree" d="M190 1360H890" class="muted draw" pathLength="100"/>
    <circle id="finalCursorOne" cx="190" cy="1120" r="10" fill="#64748b"/>
    <circle id="finalCursorTwo" cx="190" cy="1240" r="10" fill="#64748b"/>
    <circle id="finalCursorThree" cx="190" cy="1360" r="10" fill="#64748b"/>
    <text id="unexplainedText" x="540" y="940" class="key-text" text-anchor="middle" opacity="0" data-visible-text="unexplained">unexplained</text>
    <text id="noRepeatText" x="540" y="1500" class="label" text-anchor="middle" opacity="0" data-visible-text="no verified repeat">no verified repeat</text>
  </g>
</svg>
<script>
"use strict";
const DATA=${runtime};
const byId=(id)=>document.getElementById(id);
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const ease=(value)=>{const x=clamp(value);return x*x*(3-2*x)};
const progress=(frame,start,end)=>ease((frame-start)/Math.max(1,end-start));
const windowOpacity=(frame,start,end,fade=18)=>progress(frame,start,start+fade)*(1-progress(frame,end-fade,end));
const setDraw=(id,value)=>byId(id).style.strokeDashoffset=String(100*(1-clamp(value)));
const signalPoints=[[170,1040],[280,1020],[370,940],[460,760],[540,560],[620,760],[720,940],[900,1040]];
const flatPoints=[[170,1040],[275,1040],[380,1040],[485,1040],[590,1040],[695,1040],[800,1040],[900,1040]];
const mix=(a,b,t)=>a+(b-a)*t;
function tracePath(t){
 const points=signalPoints.map((point,index)=>[
   mix(point[0],flatPoints[index][0],t),
   mix(point[1],flatPoints[index][1],t),
 ]);
 return "M"+points.map((point)=>point.map((value)=>value.toFixed(2)).join(" ")).join("L");
}
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
 byId("promiseTitleOverlay").style.opacity=frame%2===0?"1":".9999";

 byId("overviewStage").setAttribute("opacity",String(windowOpacity(frame,0,114,8)));
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

 const printoutOpacity=windowOpacity(frame,96,216,18);
 byId("printoutStage").setAttribute("opacity",String(printoutOpacity));
 byId("persistentTrace").setAttribute("opacity",String(progress(frame,96,112)));
 byId("persistentTrace").style.strokeDasharray="100";
 byId("persistentTrace").style.strokeDashoffset=String(100*(1-progress(frame,96,145)));
 setDraw("printoutCircle",progress(frame,139,174));
 byId("printoutGlow").setAttribute("opacity",String(progress(frame,112,140)));
 byId("handwrittenWow").setAttribute("opacity",String(progress(frame,145,154)));
 setDraw("wowPath",progress(frame,145,DATA.anchors.wowWriteLandFrame));

 const frequencyOpacity=windowOpacity(frame,198,363,18);
 byId("frequencyStage").setAttribute("opacity",String(frequencyOpacity));
 byId("narrowBand").setAttribute("opacity",String(progress(frame,238,270)));
 setDraw("frequencyNeedle",progress(frame,238,270));
 setDraw("frequencyLink",progress(frame,270,326));

 const durationOpacity=windowOpacity(frame,345,444,18);
 byId("durationStage").setAttribute("opacity",String(durationOpacity));
 setDraw("durationAxis",progress(frame,345,392));
 const durationTravel=progress(frame,345,409);
 byId("durationCursor").setAttribute("cx",String(170+740*durationTravel));
 byId("durationText").setAttribute("opacity",String(progress(frame,DATA.anchors.seventyTwoRevealFrame,DATA.anchors.seventyTwoRevealFrame+2)));

 const flatten=frame<345?0:frame<426?progress(frame,345,392):1-progress(frame,426,468);
 byId("persistentTrace").setAttribute("d",tracePath(flatten));
 let traceTransform="translate(0 0) scale(1)";
 if(frame>=198&&frame<345)traceTransform="translate(105 -170) scale(.72)";
 else if(frame>=345&&frame<426)traceTransform="translate(0 60) scale(1)";
 else if(frame>=426&&frame<649)traceTransform="translate(150 650) scale(.72)";
 else if(frame>=649&&frame<825)traceTransform="translate(100 120) scale(.55)";
 else if(frame>=825&&frame<886)traceTransform="translate(55 80) scale(.82)";
 else if(frame>=886)traceTransform="translate(108 20) scale(.8)";
 byId("persistentTrace").setAttribute("transform",traceTransform);

 let wowTransform="translate(650 1050) scale(1)";
 let wowOpacity=frame>=145?1:0;
 if(frame>=198&&frame<345)wowTransform="translate(800 490) scale(.52)";
 else if(frame>=345&&frame<426)wowTransform="translate(710 1325) scale(.72)";
 else if(frame>=426&&frame<649){wowTransform="translate(780 320) scale(.42)";wowOpacity=.35}
 else if(frame>=649&&frame<825)wowTransform="translate(690 360) scale(.5)";
 else if(frame>=825&&frame<886)wowTransform="translate(650 900) scale(.72)";
 else if(frame>=886)wowTransform="translate(690 730) scale(.78)";
 byId("handwrittenWow").setAttribute("transform",wowTransform);
 byId("handwrittenWow").setAttribute("opacity",String(wowOpacity));

 const beamOpacity=windowOpacity(frame,426,565,18);
 byId("beamStage").setAttribute("opacity",String(beamOpacity));
 const sweep=progress(frame,468,532);
 byId("beamCone").setAttribute("transform","translate("+(-300+600*sweep).toFixed(2)+" 0)");
 const peakDistance=Math.abs(sweep-.5)*2;
 byId("fixedSourceGlow").setAttribute("opacity",String(.25+.75*(1-peakDistance)));

 const interferenceOpacity=windowOpacity(frame,547,667,18);
 byId("interferenceStage").setAttribute("opacity",String(interferenceOpacity));
 setDraw("localInterference",progress(frame,547,603));
 byId("interferenceBand").setAttribute("opacity",String(.14*progress(frame,547,584)*(1-progress(frame,603,649))));
 byId("localInterference").setAttribute("opacity",String(.72*(1-progress(frame,603,649))));
 byId("interferenceFadeMask").setAttribute("opacity",String(.86*progress(frame,603,649)));

 const searchOpacity=windowOpacity(frame,649,772,18);
 byId("searchStage").setAttribute("opacity",String(searchOpacity));
 const scan1=progress(frame,649,690),scan2=progress(frame,677,718),scan3=progress(frame,704,738);
 setDraw("scanOne",scan1);setDraw("scanTwo",scan2);setDraw("scanThree",scan3);
 byId("scanCursorOne").setAttribute("cx",String(170+740*scan1));
 byId("scanCursorTwo").setAttribute("cx",String(170+740*scan2));
 byId("scanCursorThree").setAttribute("cx",String(170+740*scan3));
 byId("scanBeamOne").setAttribute("transform","translate("+(650*scan1).toFixed(2)+" 0)");
 byId("scanBeamTwo").setAttribute("transform","translate("+(650*scan2).toFixed(2)+" 0)");
 byId("scanBeamThree").setAttribute("transform","translate("+(650*scan3).toFixed(2)+" 0)");
 byId("scanBeamOne").setAttribute("opacity",String(.16*(1-progress(frame,684,696))));
 byId("scanBeamTwo").setAttribute("opacity",String(.16*(1-progress(frame,712,724))));
 byId("scanBeamThree").setAttribute("opacity",String(.16*(1-progress(frame,732,744))));

 const matchOpacity=windowOpacity(frame,754,843,16);
 byId("matchStage").setAttribute("opacity",String(matchOpacity));
 setDraw("matchOne",progress(frame,754,786));
 setDraw("matchTwo",progress(frame,770,802));
 setDraw("matchThree",progress(frame,786,818));
 byId("matchScanner").setAttribute("transform","translate(0 "+(360*progress(frame,754,818)).toFixed(2)+")");
 byId("matchScanner").setAttribute("opacity",String(.12*(1-progress(frame,812,825))));

 const honestOpacity=windowOpacity(frame,825,904,16);
 byId("honestStage").setAttribute("opacity",String(honestOpacity));
 const branchWithdraw=1-progress(frame,825,863);
 setDraw("branchOne",branchWithdraw);setDraw("branchTwo",branchWithdraw);setDraw("branchThree",branchWithdraw);
 byId("notProofText").setAttribute("opacity",String(progress(frame,DATA.anchors.notAliensFrame,874)));

 const finalOpacity=progress(frame,886,904);
 byId("finalStage").setAttribute("opacity",String(finalOpacity));
 const finalCircleProgress=progress(frame,886,924);
 setDraw("finalCircle",finalCircleProgress);
 const repeatOne=progress(frame,924,968),repeatTwo=progress(frame,950,988),repeatThree=progress(frame,968,1016);
 setDraw("finalRepeatOne",repeatOne);setDraw("finalRepeatTwo",repeatTwo);setDraw("finalRepeatThree",repeatThree);
 byId("finalCursorOne").setAttribute("cx",String(190+700*repeatOne));
 byId("finalCursorTwo").setAttribute("cx",String(190+700*repeatTwo));
 byId("finalCursorThree").setAttribute("cx",String(190+700*repeatThree));
 byId("unexplainedText").setAttribute("opacity",String(progress(frame,DATA.anchors.unexplainedFrame,950)));
 byId("noRepeatText").setAttribute("opacity",String(progress(frame,DATA.anchors.noRepeatFrame,1018)));

 document.documentElement.dataset.renderedFrame=String(frame);
 document.documentElement.dataset.overviewComplete=String(frame>=DATA.anchors.overviewCompleteFrame);
 document.documentElement.dataset.wowLanded=String(frame>=DATA.anchors.wowWriteLandFrame);
 document.documentElement.dataset.durationVisible=String(frame>=DATA.anchors.seventyTwoRevealFrame);
 document.documentElement.dataset.fullNarrationComplete=String(frame>=DATA.anchors.speechEndFrame);
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
window.__timelines={wow_signal_full_manual_v1:timeline};
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
