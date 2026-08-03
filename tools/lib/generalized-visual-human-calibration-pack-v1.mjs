import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

import { compileGeneralizedVisualProgramAdapterToHtml } from "../../renderer/hyperframes/animation-ir-adapter.mjs";

const require = createRequire(import.meta.url);
const {
  aggregateHumanCalibration,
  createHumanCalibrationAssignment,
  publicBlindedAssignment,
} = require("../../server/pipelines/narrated-short/animation/generalized-visual-human-calibration-contract.cjs");

const PROFILE = "generalized_visual_human_calibration_pack_v1";
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_RE = /^[a-z0-9_.:-]{1,96}$/i;
const UNSAFE_REPORT_RE = /(?:https?:\/\/|file:|\/Users\/|authorization|bearer|token|storage[_-]?key|\.html|\.png|\\)/i;

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${field} has an unsupported field.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new TypeError(`${field} is missing a field.`);
}

function normalizeCoverage(input) {
  if (!Array.isArray(input) || input.length !== 8) throw new TypeError("pack coverage is invalid.");
  return input.map((entry) => {
    exact(entry, ["recipeId", "sceneCount", "helperSceneCount", "contactSheetHash"], "pack.coverage");
    if (!SAFE_RE.test(entry.recipeId) || !Number.isInteger(entry.sceneCount) || entry.sceneCount < 3 || entry.sceneCount > 12 || !Number.isInteger(entry.helperSceneCount) || entry.helperSceneCount < 0 || entry.helperSceneCount > entry.sceneCount || !HASH_RE.test(entry.contactSheetHash)) throw new TypeError("pack coverage entry is invalid.");
    return { ...entry };
  });
}

export function normalizeGeneralizedVisualCalibrationPackReport(input) {
  exact(input, [
    "schemaVersion", "profile", "commitSha", "corpusHash", "assignmentHash", "calibrationId",
    "renderer", "browser", "canvas", "caseCount", "sceneCount", "previewCount", "coverage",
    "automation", "humanReviewStatus", "calibrationStatus", "humanApproved", "productionReady", "contentHash",
  ], "pack");
  if (input.schemaVersion !== 1 || input.profile !== PROFILE || !COMMIT_RE.test(input.commitSha) || !HASH_RE.test(input.corpusHash) || !HASH_RE.test(input.assignmentHash) || !SAFE_RE.test(input.calibrationId)) throw new TypeError("pack identity is invalid.");
  exact(input.renderer, ["profile", "version", "runtimeVersion"], "pack.renderer");
  exact(input.browser, ["name", "version", "headless", "externalRequestCount"], "pack.browser");
  exact(input.canvas, ["desktopWidth", "desktopHeight", "mobileWidth", "mobileHeight"], "pack.canvas");
  exact(input.automation, ["desktopAnimated", "mobileAnimated", "keyboardReachable", "silentNarratedInteraction", "ariaPresent", "networkIsolated", "cspPresent"], "pack.automation");
  if (Object.values(input.automation).some((entry) => entry !== true)) throw new TypeError("pack automated browser gates failed.");
  if (input.browser.name !== "chromium" || input.browser.headless !== true || input.browser.externalRequestCount !== 0) throw new TypeError("pack browser identity is invalid.");
  if (input.canvas.desktopWidth !== 1080 || input.canvas.desktopHeight !== 1920 || input.canvas.mobileWidth !== 390 || input.canvas.mobileHeight !== 844) throw new TypeError("pack canvas bounds are invalid.");
  if (input.caseCount !== 12 || input.sceneCount !== 36 || input.previewCount !== 36) throw new TypeError("pack corpus bounds are invalid.");
  const coverage = normalizeCoverage(input.coverage);
  if (input.humanReviewStatus !== "pending" || input.calibrationStatus !== "insufficient_evidence" || input.humanApproved !== false || input.productionReady !== false) throw new TypeError("pack cannot self-approve human calibration.");
  const normalized = {
    schemaVersion: 1,
    profile: PROFILE,
    commitSha: input.commitSha,
    corpusHash: input.corpusHash,
    assignmentHash: input.assignmentHash,
    calibrationId: input.calibrationId,
    renderer: { ...input.renderer },
    browser: { ...input.browser },
    canvas: { ...input.canvas },
    caseCount: input.caseCount,
    sceneCount: input.sceneCount,
    previewCount: input.previewCount,
    coverage,
    automation: { ...input.automation },
    humanReviewStatus: "pending",
    calibrationStatus: "insufficient_evidence",
    humanApproved: false,
    productionReady: false,
  };
  if (UNSAFE_REPORT_RE.test(JSON.stringify(normalized))) throw new TypeError("pack report contains unsafe content.");
  const contentHash = sha(normalized);
  if (input.contentHash !== contentHash) throw new TypeError("pack contentHash is invalid.");
  return deepFreeze({ ...normalized, contentHash });
}

function captionFor(entry, sceneIndex) {
  const beatIndexes = sceneIndex === 0 ? [0, 1] : sceneIndex === 1 ? [2, 3] : [4];
  return beatIndexes.map((index) => entry.context.draft.script.beats[index].spokenText).join(" ");
}

function previewHtml(composition, scene, caption) {
  const startFrame = scene.phases[0].startFrame;
  const endFrame = scene.phases.at(-1).endFrame;
  const injected = `<style>
#calibration-caption{display:none;position:fixed;z-index:4;left:7%;right:7%;bottom:5.5%;padding:22px 28px;border-radius:18px;background:rgba(2,4,7,.9);color:#f8fafc;font-family:Outfit,sans-serif;font-size:30px;line-height:1.24;text-align:center;box-shadow:0 0 0 2px rgba(255,255,255,.12)}
html[data-calibration-mode="narrated"] #calibration-caption{display:block}
</style><div id="calibration-caption" role="note" aria-label="Narration context">${escapeHtml(caption)}</div><script>
(()=>{const q=new URLSearchParams(location.search),mode=q.get("mode")==="narrated"?"narrated":"silent";document.documentElement.dataset.calibrationMode=mode;const start=${startFrame},end=${endFrame};let epoch=null;window.__calibrationPaused=false;function loop(now){if(epoch===null)epoch=now;if(!window.__calibrationPaused){const frame=start+Math.floor(((now-epoch)/1000)*30)%Math.max(1,end-start);window.__renderFrame(frame)}requestAnimationFrame(loop)}window.__renderFrame(start);requestAnimationFrame(loop)})();
</script>`;
  return composition.html
    .replace(/ data-recipe-id="[^"]*"/g, "")
    .replace(/ data-composition-family="[^"]*"/g, "")
    .replace("</body>", `${injected}</body>`);
}

function optionLabels() {
  return {
    bounded_uncertainty: "Known evidence beside a bounded unknown",
    cause_effect: "A cause producing an effect",
    chronology: "Events ordered through time",
    comparison: "Two states or values being compared",
    evidence_inspection: "Evidence being closely examined",
    finite_cycle: "A bounded repeating cycle",
    map_route: "Movement along a route",
    negative_space_absence: "An expected thing shown as absent",
  };
}

function reviewUiHtml(publicAssignment) {
  const data = safeJson(publicAssignment);
  const labels = safeJson(optionLabels());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Blinded visual calibration</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#08090c;color:#f8fafc}*{box-sizing:border-box}body{margin:0}.app{max-width:1280px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center}.progress{color:#a7b0c0}.grid{display:grid;grid-template-columns:minmax(300px,430px) 1fr;gap:24px;margin-top:16px}.preview{aspect-ratio:9/16;max-height:74vh;margin:auto;border:2px solid #384152;border-radius:18px;overflow:hidden;background:#000}.preview iframe{border:0;width:100%;height:100%}.panel{background:#151821;border:1px solid #343a49;border-radius:18px;padding:20px}.mode{color:#fbbf24;text-transform:uppercase;letter-spacing:.12em}.options{display:grid;gap:10px}.option,.button{width:100%;border:2px solid #465064;border-radius:12px;padding:13px;background:#202533;color:#f8fafc;text-align:left;font:inherit}.option:hover,.option:focus-visible,.button:focus-visible,input:focus-visible,select:focus-visible{outline:4px solid #67e8f9;outline-offset:2px}.option[aria-pressed="true"]{border-color:#fbbf24;background:#3d3218}.rubric{display:grid;grid-template-columns:1fr auto;gap:9px 12px;margin-top:18px}.checks{display:grid;gap:8px;margin-top:16px}.actions{display:flex;gap:10px;margin-top:18px}.button{text-align:center;cursor:pointer}.button.primary{background:#0e7490}.button:disabled{opacity:.45}.status{min-height:1.5em;color:#a7f3d0}.hidden{display:none}@media(max-width:760px){.grid{grid-template-columns:1fr}.preview{width:min(100%,360px);max-height:none}.app{padding:10px}.top{align-items:flex-start;flex-direction:column}}
</style></head><body><main class="app"><div class="top"><div><h1>Blinded visual calibration</h1><div class="progress" id="progress" aria-live="polite"></div></div><button id="resume" class="button" type="button">Resume saved session</button></div><div class="grid"><section class="preview" aria-label="Animated visual preview"><iframe id="preview" title="Animated calibration preview"></iframe></section><section class="panel"><div class="mode" id="mode"></div><h2 id="question">Which semantic relationship does this animation communicate?</h2><div class="options" id="options" role="group" aria-labelledby="question"></div><p class="status" id="status" aria-live="polite"></p><div id="details" class="hidden"><h3>Bounded rubric: 1 weak, 5 clear</h3><div class="rubric" id="rubric"></div><div class="checks" id="checks"></div><label>Confused with <select id="confused"><option value="">None</option></select></label><fieldset><legend>Observed issues</legend><div class="checks" id="issues"></div></fieldset><label><input id="confirm" type="checkbox"> I personally reviewed both modes and confirm this bounded response.</label></div><div class="actions"><button class="button" id="back" type="button">Back</button><button class="button primary" id="next" type="button">Continue</button></div></section></div></main><script>
"use strict";const ASSIGNMENT=${data},LABELS=${labels};const RUBRIC=["narrationVisualCorrespondence","immediateComprehensibility","focalClarity","textLegibility","revealClarity","pacing","visualDistinctiveness"],BOOL=["understoodWithoutReplay","neededNarrationToUnderstand","primaryObjectIdentified","helperImprovedMeaning","textReadableOnMobile","wouldRequireManualEdit"],ISSUES=["CLUTTERED","FOCUS_UNCLEAR","HELPER_CONFUSING","HELPER_TOO_SMALL","MEANING_UNCLEAR","MOTION_TOO_FAST","MOTION_TOO_SLOW","OFF_CENTER","REPETITIVE","TEXT_TOO_SMALL","TIMING_UNCLEAR","WRONG_RELATION"];
const sessionKey="gvc:"+ASSIGNMENT.assignmentHash;let state=JSON.parse(localStorage.getItem(sessionKey)||"null")||{session:"reviewer_"+Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,"0")).join(""),index:0,stage:0,drafts:{}};const el=id=>document.getElementById(id),item=()=>ASSIGNMENT.items[state.index],draft=()=>state.drafts[item().itemId]||(state.drafts[item().itemId]={answers:{},rubric:Object.fromEntries(RUBRIC.map(k=>[k,3])),booleans:Object.fromEntries(BOOL.map(k=>[k,false])),confusedWith:null,issueCodes:[]});function save(){localStorage.setItem(sessionKey,JSON.stringify(state))}function renderOptions(){const d=draft(),mode=state.stage===0?"silent":"narrated";el("options").innerHTML="";for(const optionId of item().optionIds){const b=document.createElement("button");b.type="button";b.className="option";b.textContent=LABELS[optionId];b.setAttribute("aria-pressed",String(d.answers[mode]===optionId));b.onclick=()=>{d.answers[mode]=optionId;save();renderOptions()};el("options").append(b)}}function renderDetails(){const d=draft();el("details").classList.toggle("hidden",state.stage<2);if(state.stage<2)return;el("rubric").innerHTML=RUBRIC.map(k=>'<label for="r_'+k+'">'+k.replace(/[A-Z]/g,m=>" "+m.toLowerCase())+'</label><input id="r_'+k+'" type="range" min="1" max="5" value="'+d.rubric[k]+'" aria-label="'+k+' score">').join("");for(const k of RUBRIC)el("r_"+k).oninput=e=>{d.rubric[k]=Number(e.target.value);save()};el("checks").innerHTML=BOOL.map(k=>'<label><input data-bool="'+k+'" type="checkbox" '+(d.booleans[k]?"checked":"")+'> '+k.replace(/[A-Z]/g,m=>" "+m.toLowerCase())+'</label>').join("");document.querySelectorAll("[data-bool]").forEach(n=>n.onchange=e=>{d.booleans[e.target.dataset.bool]=e.target.checked;save()});el("confused").innerHTML='<option value="">None</option>'+item().optionIds.map(optionId=>'<option value="'+optionId+'" '+(d.confusedWith===optionId?"selected":"")+'>'+LABELS[optionId]+'</option>').join("");el("confused").onchange=e=>{d.confusedWith=e.target.value||null;save()};el("issues").innerHTML=ISSUES.map(code=>'<label><input data-issue="'+code+'" type="checkbox" '+(d.issueCodes.includes(code)?"checked":"")+'> '+code.toLowerCase().replaceAll("_"," ")+'</label>').join("");document.querySelectorAll("[data-issue]").forEach(n=>n.onchange=e=>{const code=e.target.dataset.issue;d.issueCodes=e.target.checked?[...new Set([...d.issueCodes,code])].sort():d.issueCodes.filter(x=>x!==code);save()});el("confirm").checked=false}
function render(){const it=item(),mode=state.stage===0?"silent":"narrated";el("progress").textContent="Item "+(state.index+1)+" of "+ASSIGNMENT.items.length+" · "+(state.stage===0?"silent pass":state.stage===1?"narrated pass":"rubric");el("mode").textContent=state.stage<2?mode:"Final bounded rating";if(state.stage<2)el("preview").src=it.previewRefs[mode]+"?mode="+mode;renderOptions();renderDetails();el("options").classList.toggle("hidden",state.stage===2);el("question").textContent=state.stage===2?"Rate only what you observed":"Which semantic relationship does this animation communicate?";el("back").disabled=state.index===0&&state.stage===0;el("next").textContent=state.stage===2?(state.index===ASSIGNMENT.items.length-1?"Save final response":"Save and continue"):"Continue";el("status").textContent="";save()}
async function advance(){const d=draft();if(state.stage<2){const mode=state.stage===0?"silent":"narrated";if(!d.answers[mode]){el("status").textContent="Choose one bounded answer before continuing.";return}state.stage+=1;render();return}if(!el("confirm").checked){el("status").textContent="Explicit reviewer confirmation is required.";return}const body={reviewerSessionId:state.session,itemId:item().itemId,source:"human",answers:d.answers,rubric:d.rubric,booleans:d.booleans,confusedWith:d.confusedWith,issueCodes:d.issueCodes,reviewerConfirmed:true};const response=await fetch("/api/responses",{method:"POST",headers:{"Content-Type":"application/json","X-Calibration-Assignment":ASSIGNMENT.assignmentHash},body:JSON.stringify(body)});if(!response.ok&&response.status!==409){el("status").textContent="Local save failed.";return}if(state.index<ASSIGNMENT.items.length-1){state.index+=1;state.stage=0;render()}else el("status").textContent="All responses are saved locally. Ask the operator to finalize the aggregate."}
function back(){if(state.stage>0)state.stage-=1;else if(state.index>0){state.index-=1;state.stage=2}render()}el("next").onclick=advance;el("back").onclick=back;el("resume").onclick=()=>render();addEventListener("keydown",e=>{if(e.key==="ArrowRight"&&e.altKey)advance();if(e.key==="ArrowLeft"&&e.altKey)back()});render();
</script></body></html>`;
}

async function contactSheet(browser, images, outputPath) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    const columns = images.length <= 4 ? 2 : 3;
    const rows = Math.ceil(images.length / columns);
    const cellWidth = 1080 / columns;
    const cellHeight = 1920 / rows;
    const markup = `<!doctype html><style>html,body{margin:0;width:1080px;height:1920px;background:#050608;overflow:hidden}.grid{display:grid;grid-template-columns:repeat(${columns},${cellWidth}px);grid-template-rows:repeat(${rows},${cellHeight}px)}img{display:block;width:${cellWidth}px;height:${cellHeight}px;object-fit:contain;background:#050608}</style><div class="grid">${images.map((buffer) => `<img alt="" src="data:image/png;base64,${buffer.toString("base64")}">`).join("")}</div>`;
    await page.setContent(markup, { waitUntil: "load" });
    const sheet = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    await writeFile(outputPath, sheet, { flag: "wx", mode: 0o600 });
    return sheet;
  } finally {
    await context.close();
  }
}

export async function writeGeneralizedVisualHumanCalibrationPack({ corpus, commitSha, chromePath, runtimeVersion, artifactDirectory, seed } = {}) {
  if (!corpus?.manifest || corpus.manifest.caseCount !== 12 || !COMMIT_RE.test(commitSha || "") || typeof chromePath !== "string" || typeof runtimeVersion !== "string" || typeof artifactDirectory !== "string") throw new TypeError("calibration pack input is invalid.");
  const assignment = createHumanCalibrationAssignment({ corpus, commitSha, seed });
  const blinded = publicBlindedAssignment(assignment);
  await mkdir(`${artifactDirectory}/previews`, { recursive: true, mode: 0o700 });
  await mkdir(`${artifactDirectory}/contact-sheets`, { recursive: true, mode: 0o700 });
  await mkdir(`${artifactDirectory}/responses`, { recursive: true, mode: 0o700 });
  const launchOptions = { headless: true, args: ["--disable-gpu", "--force-color-profile=srgb", "--font-render-hinting=none"] };
  let browser;
  try {
    browser = await chromium.launch({ ...launchOptions, executablePath: chromePath });
  } catch {
    browser = await chromium.launch(launchOptions);
  }
  let externalRequestCount = 0;
  try {
    const screenshotsByRecipe = new Map();
    let visiblePreviewCount = 0;
    for (const item of assignment.items) {
      const entry = corpus.cases[item.caseIndex];
      const scene = entry.compiled.visualRecipePlan.scenes[item.sceneIndex];
      const composition = compileGeneralizedVisualProgramAdapterToHtml(entry.compiled, entry.context);
      const html = previewHtml(composition, scene, captionFor(entry, item.sceneIndex));
      const relative = item.previewRefs.silent;
      await writeFile(`${artifactDirectory}/${relative}`, html, { flag: "wx", mode: 0o600 });
      const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, colorScheme: "dark" });
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === "about:blank" || url.startsWith("data:")) await route.continue();
        else { externalRequestCount += 1; await route.abort(); }
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const hold = scene.phases.find((phase) => phase.id === "hold") || scene.phases.at(-1);
      await page.evaluate((frame) => { window.__calibrationPaused = true; window.__renderFrame(frame); }, hold.startFrame + Math.floor((hold.endFrame - hold.startFrame) / 2));
      const previewVisible = await page.evaluate((sceneId) => {
        const active = document.querySelector(`[data-visual-scene="${sceneId}"]`);
        const primary = active?.querySelector("[data-dominant-primary]");
        const activeOpacity = Number(active?.getAttribute("opacity") || 0);
        const stageOpacity = Number(active?.querySelector("[data-motion-stage]")?.getAttribute("opacity") || 0);
        const bounds = primary?.getBoundingClientRect();
        return Boolean(activeOpacity > .9 && stageOpacity > .9 && bounds && bounds.width * bounds.height > 250000);
      }, scene.id);
      if (!previewVisible) throw new Error("calibration_preview_not_visible");
      visiblePreviewCount += 1;
      const image = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
      if (!screenshotsByRecipe.has(item.recipeId)) screenshotsByRecipe.set(item.recipeId, []);
      screenshotsByRecipe.get(item.recipeId).push(image);
      await context.close();
    }
    const coverage = [];
    for (const recipeId of [...screenshotsByRecipe.keys()].sort()) {
      const images = screenshotsByRecipe.get(recipeId);
      const sheet = await contactSheet(browser, images, `${artifactDirectory}/contact-sheets/${recipeId}.png`);
      const recipeItems = assignment.items.filter((entry) => entry.recipeId === recipeId);
      coverage.push({ recipeId, sceneCount: recipeItems.length, helperSceneCount: recipeItems.filter((entry) => entry.helperPresent).length, contactSheetHash: sha(sheet) });
    }
    const browserVersion = browser.version().replace(/^HeadlessChrome\//, "").replace(/^Chrome\//, "").slice(0, 48);
    const indexHtml = reviewUiHtml(blinded);
    const uiContext = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, colorScheme: "dark" });
    await uiContext.route("http://calibration.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/index.html") await route.fulfill({ status: 200, contentType: "text/html", body: indexHtml });
      else await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Bounded preview fixture</title>" });
    });
    const uiPage = await uiContext.newPage();
    await uiPage.goto("http://calibration.test/index.html", { waitUntil: "domcontentloaded" });
    await uiPage.keyboard.press("Tab");
    const keyboardFocused = await uiPage.evaluate(() => document.activeElement instanceof HTMLButtonElement);
    await uiPage.locator(".option").first().click();
    await uiPage.locator("#next").click();
    const interaction = await uiPage.evaluate(() => ({
      mode: document.querySelector("#mode")?.textContent,
      preview: document.querySelector("#preview")?.getAttribute("src"),
      saved: [...Array(localStorage.length).keys()].some((index) => localStorage.key(index)?.startsWith("gvc:")),
    }));
    const desktopUi = await uiPage.evaluate(() => ({
      aria: Boolean(document.querySelector('[aria-live="polite"]') && document.querySelector('iframe[title]') && document.querySelector('[role="group"]')),
      csp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
    }));
    desktopUi.keyboard = keyboardFocused;
    desktopUi.silentNarratedInteraction = interaction.mode === "narrated" && interaction.preview?.endsWith("?mode=narrated") === true && interaction.saved;
    await uiContext.close();
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: "dark" });
    await mobileContext.route("http://calibration.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/index.html") await route.fulfill({ status: 200, contentType: "text/html", body: indexHtml });
      else await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Bounded preview fixture</title>" });
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto("http://calibration.test/index.html", { waitUntil: "domcontentloaded" });
    const mobileUiFits = await mobilePage.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector(".preview")?.getBoundingClientRect().width <= 390);
    await mobileContext.close();
    await writeFile(`${artifactDirectory}/index.html`, indexHtml, { flag: "wx", mode: 0o600 });
    await writeFile(`${artifactDirectory}/assignment.json`, `${JSON.stringify(assignment)}\n`, { flag: "wx", mode: 0o600 });
    const pendingResult = aggregateHumanCalibration({ assignment, responses: [] });
    await writeFile(`${artifactDirectory}/calibration-result.json`, `${JSON.stringify(pendingResult)}\n`, { flag: "wx", mode: 0o600 });
    const base = {
      schemaVersion: 1,
      profile: PROFILE,
      commitSha,
      corpusHash: corpus.manifest.contentHash,
      assignmentHash: assignment.contentHash,
      calibrationId: assignment.calibrationId,
      renderer: { profile: "generalized_visual_recipe_renderer_v1", version: "1.0.0", runtimeVersion },
      browser: { name: "chromium", version: browserVersion, headless: true, externalRequestCount },
      canvas: { desktopWidth: 1080, desktopHeight: 1920, mobileWidth: 390, mobileHeight: 844 },
      caseCount: corpus.manifest.caseCount,
      sceneCount: corpus.manifest.sceneCount,
      previewCount: assignment.items.length,
      coverage,
      automation: {
        desktopAnimated: visiblePreviewCount === assignment.items.length,
        mobileAnimated: mobileUiFits && visiblePreviewCount === assignment.items.length,
        keyboardReachable: desktopUi.keyboard,
        silentNarratedInteraction: desktopUi.silentNarratedInteraction,
        ariaPresent: desktopUi.aria,
        networkIsolated: externalRequestCount === 0,
        cspPresent: desktopUi.csp,
      },
      humanReviewStatus: "pending",
      calibrationStatus: "insufficient_evidence",
      humanApproved: false,
      productionReady: false,
    };
    const report = normalizeGeneralizedVisualCalibrationPackReport({ ...base, contentHash: sha(base) });
    await writeFile(`${artifactDirectory}/pack-report.json`, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ assignment, report, pendingResult, artifactCount: assignment.items.length + coverage.length + 5 });
  } finally {
    await browser.close();
  }
}
