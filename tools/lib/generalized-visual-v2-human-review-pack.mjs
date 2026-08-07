import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BOOLEAN_KEYS,
  ISSUE_CODES,
  REQUIRED_REVIEWER_COUNT,
  RUBRIC_KEYS,
  aggregateHumanReview,
  createHumanReviewAssignment,
  publicBlindedAssignment,
  shaHumanReviewValue,
} = require("../../server/pipelines/narrated-short/animation/generalized-visual-v2-human-review-contract.cjs");

export const HUMAN_REVIEW_ROOT = join(tmpdir(), "shortsengine-generalized-visual-v2-human-review");
export const HUMAN_REVIEW_INPUT_PROFILE = "generalized_visual_v2_human_review_input_v1";
export const HUMAN_REVIEW_PACK_PROFILE = "generalized_visual_v2_human_review_pack_v1";

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${field} has an unsupported field.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${field} is missing a field.`);
  }
}

function safePath(value, field) {
  if (typeof value !== "string" || !value || value.includes("\0") || /https?:\/\//iu.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function normalizeQuestionInput(input, index, field) {
  exact(input, ["questionId", "kind", "prompt", "options", "expectedOptionId"], field);
  if (!SAFE_ID_RE.test(input.questionId || "")) throw new TypeError(`${field}.questionId is invalid.`);
  const expectedKind = index < 3 ? "factual" : "uncertainty";
  if (input.kind !== expectedKind) throw new TypeError(`${field}.kind is invalid.`);
  if (typeof input.prompt !== "string" || input.prompt.length < 8 || input.prompt.length > 220) {
    throw new TypeError(`${field}.prompt is invalid.`);
  }
  if (!Array.isArray(input.options) || input.options.length < 3 || input.options.length > 4) {
    throw new TypeError(`${field}.options is invalid.`);
  }
  const options = input.options.map((option, optionIndex) => {
    exact(option, ["optionId", "label"], `${field}.options.${optionIndex}`);
    if (!SAFE_ID_RE.test(option.optionId || "") || typeof option.label !== "string" || !option.label || option.label.length > 160) {
      throw new TypeError(`${field}.options.${optionIndex} is invalid.`);
    }
    return { optionId: option.optionId, label: option.label };
  });
  if (new Set(options.map((entry) => entry.optionId)).size !== options.length) {
    throw new TypeError(`${field}.options must be unique.`);
  }
  if (!options.some((entry) => entry.optionId === input.expectedOptionId)) {
    throw new TypeError(`${field}.expectedOptionId is invalid.`);
  }
  return {
    questionId: input.questionId,
    kind: input.kind,
    prompt: input.prompt,
    options,
    expectedOptionId: input.expectedOptionId,
  };
}

export function normalizeGeneralizedVisualV2HumanReviewInput(input, { baseDirectory = process.cwd() } = {}) {
  exact(input, ["schemaVersion", "profile", "comparisonPath", "stories"], "input");
  if (input.schemaVersion !== 1 || input.profile !== HUMAN_REVIEW_INPUT_PROFILE) {
    throw new TypeError("human review input identity is invalid.");
  }
  safePath(input.comparisonPath, "input.comparisonPath");
  if (!Array.isArray(input.stories) || input.stories.length !== 3) {
    throw new TypeError("human review input must contain exactly three stories.");
  }
  const stories = input.stories.map((story, storyIndex) => {
    const field = `input.stories.${storyIndex}`;
    exact(story, ["storyId", "mediaPath", "reportPath", "questions"], field);
    if (!SAFE_ID_RE.test(story.storyId || "")) throw new TypeError(`${field}.storyId is invalid.`);
    safePath(story.mediaPath, `${field}.mediaPath`);
    safePath(story.reportPath, `${field}.reportPath`);
    if (!Array.isArray(story.questions) || story.questions.length !== 4) {
      throw new TypeError(`${field}.questions is invalid.`);
    }
    return {
      storyId: story.storyId,
      mediaPath: isAbsolute(story.mediaPath) ? story.mediaPath : resolve(baseDirectory, story.mediaPath),
      reportPath: isAbsolute(story.reportPath) ? story.reportPath : resolve(baseDirectory, story.reportPath),
      questions: story.questions.map((question, questionIndex) => (
        normalizeQuestionInput(question, questionIndex, `${field}.questions.${questionIndex}`)
      )),
    };
  });
  if (new Set(stories.map((entry) => entry.storyId)).size !== 3) {
    throw new TypeError("human review story IDs must be unique.");
  }
  return deepFreeze({
    schemaVersion: 1,
    profile: HUMAN_REVIEW_INPUT_PROFILE,
    comparisonPath: isAbsolute(input.comparisonPath)
      ? input.comparisonPath
      : resolve(baseDirectory, input.comparisonPath),
    stories,
  });
}

function validateProofReport(report, story, mediaHash, mediaBytes) {
  if (
    !report
    || report.proofProfile !== "generalized_visual_composition_v2_video_proof"
    || report.storyId !== story.storyId
    || report.publishable !== false
    || report.humanReviewStatus !== "pending"
    || report.gates?.technical !== "passed"
    || report.gates?.deterministicPlan !== "passed"
    || report.gates?.noRemoteAssets !== "passed"
    || report.gates?.persistentTitleOcr !== "passed"
    || report.gates?.semanticComposition !== "passed"
    || report.gates?.humanPerceptual !== "pending"
    || report.media?.sha256 !== mediaHash
    || report.media?.bytes !== mediaBytes
    || !HASH_RE.test(report.style?.contentHash || "")
    || !HASH_RE.test(report.fingerprints?.program || "")
    || !HASH_RE.test(report.fingerprints?.composition || "")
  ) throw new TypeError(`${story.storyId} proof report is not eligible for human review.`);
}

function validateComparison(comparison, storyIds) {
  const stories = Array.isArray(comparison?.stories) ? comparison.stories : [];
  if (
    comparison?.proofProfile !== "generalized_visual_composition_v2_cross_story_comparison"
    || comparison.publishable !== false
    || comparison.humanReviewStatus !== "pending"
    || comparison.sameStyleHash !== true
    || comparison.distinctProgramHashes !== true
    || comparison.repetitionReport?.passed !== true
    || comparison.passed !== true
    || stories.length !== 3
    || new Set(stories).size !== 3
    || [...stories].sort().join("|") !== [...storyIds].sort().join("|")
  ) throw new TypeError("three-story comparison evidence is not eligible for human review.");
}

async function sourceItems(input) {
  const comparisonBytes = await readFile(input.comparisonPath);
  const comparison = JSON.parse(comparisonBytes.toString("utf8"));
  validateComparison(comparison, input.stories.map((entry) => entry.storyId));
  const items = [];
  for (const story of input.stories) {
    const [mediaBytesValue, reportBytes, mediaStats] = await Promise.all([
      readFile(story.mediaPath),
      readFile(story.reportPath),
      stat(story.mediaPath),
    ]);
    if (!mediaStats.isFile() || mediaBytesValue.byteLength < 16) {
      throw new TypeError(`${story.storyId} review media is invalid.`);
    }
    const mediaHash = sha(mediaBytesValue);
    const report = JSON.parse(reportBytes.toString("utf8"));
    validateProofReport(report, story, mediaHash, mediaBytesValue.byteLength);
    items.push({
      storyId: story.storyId,
      mediaPath: story.mediaPath,
      mediaHash,
      mediaBytes: mediaBytesValue.byteLength,
      reportHash: sha(reportBytes),
      programHash: report.fingerprints.program,
      compositionHash: report.fingerprints.composition,
      styleHash: report.style.contentHash,
      questions: story.questions,
    });
  }
  return { comparisonHash: sha(comparisonBytes), items };
}

function escapeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function reviewHtml(publicAssignment) {
  const assignmentJson = escapeJson(publicAssignment);
  const rubricJson = escapeJson(RUBRIC_KEYS);
  const booleansJson = escapeJson(BOOLEAN_KEYS);
  const issuesJson = escapeJson(ISSUE_CODES);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Blinded full-video review</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#08090c;color:#f8fafc}*{box-sizing:border-box}body{margin:0}.app{max-width:1120px;margin:auto;padding:16px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}.progress{color:#a7b0c0}.grid{display:grid;grid-template-columns:minmax(300px,430px) 1fr;gap:24px}.video-shell{position:relative;aspect-ratio:9/16;background:#000;border:2px solid #384152;border-radius:16px;overflow:hidden}video{width:100%;height:100%;display:block}.start{position:absolute;inset:42% 12%;height:64px;border:2px solid #67e8f9;border-radius:14px;background:#0e7490;color:#fff;font:inherit;font-weight:700}.panel{padding:18px;border:1px solid #343a49;border-radius:16px;background:#151821}.question{padding:12px 0;border-bottom:1px solid #343a49}.options{display:grid;gap:8px}.rubric{display:grid;grid-template-columns:1fr auto;gap:9px 12px}.checks{display:grid;gap:8px}.button{width:100%;padding:14px;border:2px solid #67e8f9;border-radius:12px;background:#0e7490;color:#fff;font:inherit}.button:disabled{opacity:.4}.hidden{display:none}.status{min-height:1.5em;color:#a7f3d0}button:focus-visible,input:focus-visible{outline:4px solid #fbbf24;outline-offset:2px}@media(max-width:760px){.grid{grid-template-columns:1fr}.video-shell{width:min(100%,390px);margin:auto}.app{padding:10px}}
</style></head><body><main class="app"><div class="top"><h1>Blinded video review</h1><div id="progress" class="progress" aria-live="polite"></div></div><p>Watch once at normal speed. The questions appear only after playback completes.</p><div class="grid"><section class="video-shell" aria-label="Review video"><video id="video" playsinline preload="metadata" disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback"></video><button id="start" class="start" type="button">Play once</button></section><section id="panel" class="panel hidden"><form id="form"><div id="questions"></div><h2>Quality ratings</h2><p>1 = weak, 5 = clear.</p><div id="rubric" class="rubric"></div><h2>Bounded checks</h2><div id="booleans" class="checks"></div><fieldset><legend>Observed issues</legend><div id="issues" class="checks"></div></fieldset><label><input id="confirm" type="checkbox"> I personally watched this video once at normal speed and confirm this response.</label><button id="submit" class="button" type="submit">Save and continue</button><p id="status" class="status" aria-live="polite"></p></form></section></div></main><script>
"use strict";const ASSIGNMENT=${assignmentJson},RUBRIC=${rubricJson},BOOL=${booleansJson},ISSUES=${issuesJson};const key="gv2hr:"+ASSIGNMENT.assignmentHash;let state=JSON.parse(localStorage.getItem(key)||"null")||{session:"reviewer_"+Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,"0")).join(""),index:0,played:{},submitted:{}};const el=id=>document.getElementById(id),item=()=>ASSIGNMENT.items[state.index],save=()=>localStorage.setItem(key,JSON.stringify(state));function words(v){return v.replace(/[A-Z]/g,m=>" "+m.toLowerCase()).replaceAll("_"," ")}function build(){const it=item();el("progress").textContent="Video "+(state.index+1)+" of "+ASSIGNMENT.items.length;el("video").src=it.mediaRef;el("video").playbackRate=1;el("video").controls=false;el("start").classList.toggle("hidden",Boolean(state.played[it.itemId]));el("panel").classList.toggle("hidden",!state.played[it.itemId]);el("questions").innerHTML=it.questions.map((q,i)=>'<fieldset class="question"><legend>'+(i+1)+'. '+q.prompt+'</legend><div class="options">'+q.options.map(o=>'<label><input required type="radio" name="q_'+q.questionId+'" value="'+o.optionId+'"> '+o.label+'</label>').join("")+'</div></fieldset>').join("");el("rubric").innerHTML=RUBRIC.map(k=>'<label for="r_'+k+'">'+words(k)+'</label><input id="r_'+k+'" name="r_'+k+'" type="range" min="1" max="5" value="3" aria-label="'+words(k)+' rating">').join("");el("booleans").innerHTML=BOOL.map(k=>'<label><input name="b_'+k+'" type="checkbox"> '+words(k)+'</label>').join("");el("issues").innerHTML=ISSUES.map(k=>'<label><input name="i_'+k+'" type="checkbox"> '+words(k)+'</label>').join("");el("confirm").checked=false;el("status").textContent="";save()}el("video").addEventListener("ratechange",()=>{if(el("video").playbackRate!==1)el("video").playbackRate=1});el("video").addEventListener("contextmenu",e=>e.preventDefault());el("video").addEventListener("ended",()=>{state.played[item().itemId]=true;el("video").removeAttribute("src");el("video").load();build()});el("start").onclick=async()=>{el("start").disabled=true;el("video").playbackRate=1;try{await el("video").play()}catch{el("start").disabled=false}};el("form").onsubmit=async e=>{e.preventDefault();if(!el("confirm").checked){el("status").textContent="Explicit confirmation is required.";return}const it=item(),data=new FormData(e.currentTarget),answers=Object.fromEntries(it.questions.map(q=>[q.questionId,data.get("q_"+q.questionId)]));if(Object.values(answers).some(v=>!v)){el("status").textContent="Answer every bounded question.";return}const rubric=Object.fromEntries(RUBRIC.map(k=>[k,Number(data.get("r_"+k))]));const booleans=Object.fromEntries(BOOL.map(k=>[k,data.get("b_"+k)==="on"]));const issueCodes=ISSUES.filter(k=>data.get("i_"+k)==="on").sort();const body={reviewerSessionId:state.session,itemId:it.itemId,source:"human",playback:{completed:true,normalSpeed:true,replayCount:0},answers,rubric,booleans,issueCodes,reviewerConfirmed:true};const response=await fetch("/api/responses",{method:"POST",headers:{"Content-Type":"application/json","X-Human-Review-Assignment":ASSIGNMENT.assignmentHash},body:JSON.stringify(body)});if(!response.ok&&response.status!==409){el("status").textContent="Local save failed.";return}state.submitted[it.itemId]=true;if(state.index<ASSIGNMENT.items.length-1){state.index+=1;build()}else{save();el("panel").innerHTML="<h2>Review saved</h2><p>All three bounded responses were stored locally. A fifth independent reviewer is still required before the aggregate can complete.</p>"}};build();
</script></body></html>`;
}

export function normalizeGeneralizedVisualV2HumanReviewPackReport(input) {
  exact(input, [
    "schemaVersion",
    "profile",
    "commitSha",
    "comparisonHash",
    "assignmentHash",
    "reviewId",
    "itemCount",
    "requiredReviewerCount",
    "styleHash",
    "media",
    "security",
    "browserAutomationStatus",
    "humanReviewStatus",
    "humanApproved",
    "publishable",
    "productionReady",
    "contentHash",
  ], "packReport");
  if (
    input.schemaVersion !== 1
    || input.profile !== HUMAN_REVIEW_PACK_PROFILE
    || !COMMIT_RE.test(input.commitSha || "")
    || !HASH_RE.test(input.comparisonHash || "")
    || !HASH_RE.test(input.assignmentHash || "")
    || !SAFE_ID_RE.test(input.reviewId || "")
    || input.itemCount !== 3
    || input.requiredReviewerCount !== REQUIRED_REVIEWER_COUNT
    || !HASH_RE.test(input.styleHash || "")
  ) throw new TypeError("human review pack identity is invalid.");
  if (!Array.isArray(input.media) || input.media.length !== 3) throw new TypeError("pack media is invalid.");
  const media = input.media.map((entry, index) => {
    exact(entry, ["ordinal", "mediaHash", "reportHash", "bytes"], `packReport.media.${index}`);
    if (entry.ordinal !== index || !HASH_RE.test(entry.mediaHash || "") || !HASH_RE.test(entry.reportHash || "") || !Number.isInteger(entry.bytes) || entry.bytes < 16) {
      throw new TypeError("pack media entry is invalid.");
    }
    return { ...entry };
  });
  exact(input.security, ["loopbackOnly", "sameOriginMedia", "strictCsp", "createOnlyResponses", "assignmentNotPublic"], "packReport.security");
  if (Object.values(input.security).some((entry) => entry !== true)) throw new TypeError("pack security gates failed.");
  if (
    input.browserAutomationStatus !== "not_run"
    || input.humanReviewStatus !== "pending"
    || input.humanApproved !== false
    || input.publishable !== false
    || input.productionReady !== false
  ) throw new TypeError("pack cannot self-approve human review.");
  const base = {
    schemaVersion: 1,
    profile: HUMAN_REVIEW_PACK_PROFILE,
    commitSha: input.commitSha,
    comparisonHash: input.comparisonHash,
    assignmentHash: input.assignmentHash,
    reviewId: input.reviewId,
    itemCount: 3,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    styleHash: input.styleHash,
    media,
    security: { ...input.security },
    browserAutomationStatus: "not_run",
    humanReviewStatus: "pending",
    humanApproved: false,
    publishable: false,
    productionReady: false,
  };
  const contentHash = shaHumanReviewValue(base);
  if (input.contentHash !== contentHash) throw new TypeError("pack report contentHash is invalid.");
  const serialized = JSON.stringify(base);
  if (/\/Users\/|https?:\/\/|reviewerSessionId|expectedOptionId|storyId/iu.test(serialized)) {
    throw new TypeError("pack report contains unsafe content.");
  }
  return deepFreeze({ ...base, contentHash });
}

export async function prepareGeneralizedVisualV2HumanReviewPack({ input, commitSha, seed } = {}) {
  const normalizedInput = normalizeGeneralizedVisualV2HumanReviewInput(input, { baseDirectory: process.cwd() });
  if (!COMMIT_RE.test(commitSha || "")) throw new TypeError("human review commitSha is invalid.");
  const sources = await sourceItems(normalizedInput);
  const assignment = createHumanReviewAssignment({
    items: sources.items.map(({ mediaPath: ignored, ...entry }) => entry),
    commitSha,
    comparisonHash: sources.comparisonHash,
    seed,
  });
  const pendingResult = aggregateHumanReview({ assignment, responses: [] });
  const reportBase = {
    schemaVersion: 1,
    profile: HUMAN_REVIEW_PACK_PROFILE,
    commitSha,
    comparisonHash: sources.comparisonHash,
    assignmentHash: assignment.contentHash,
    reviewId: assignment.reviewId,
    itemCount: 3,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    styleHash: assignment.items[0].styleHash,
    media: assignment.items.map((item) => ({
      ordinal: item.ordinal,
      mediaHash: item.mediaHash,
      reportHash: item.reportHash,
      bytes: item.mediaBytes,
    })),
    security: {
      loopbackOnly: true,
      sameOriginMedia: true,
      strictCsp: true,
      createOnlyResponses: true,
      assignmentNotPublic: true,
    },
    browserAutomationStatus: "not_run",
    humanReviewStatus: "pending",
    humanApproved: false,
    publishable: false,
    productionReady: false,
  };
  const report = normalizeGeneralizedVisualV2HumanReviewPackReport({
    ...reportBase,
    contentHash: shaHumanReviewValue(reportBase),
  });
  return deepFreeze({ assignment, pendingResult, report, sources });
}

async function exclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}

export async function writeGeneralizedVisualV2HumanReviewPack({
  input,
  commitSha,
  artifactDirectory,
  seed,
  prepared: preparedInput,
} = {}) {
  if (typeof artifactDirectory !== "string" || !artifactDirectory) {
    throw new TypeError("human review artifactDirectory is invalid.");
  }
  const prepared = preparedInput || await prepareGeneralizedVisualV2HumanReviewPack({ input, commitSha, seed });
  if (
    prepared.assignment?.commitSha !== commitSha
    || prepared.assignment?.items?.length !== 3
    || prepared.report?.assignmentHash !== prepared.assignment.contentHash
    || prepared.pendingResult?.assignmentHash !== prepared.assignment.contentHash
    || !Array.isArray(prepared.sources?.items)
    || prepared.sources.items.length !== 3
  ) throw new TypeError("prepared human review pack is invalid.");
  await mkdir(join(artifactDirectory, "media"), { recursive: true, mode: 0o700 });
  await mkdir(join(artifactDirectory, "responses"), { recursive: true, mode: 0o700 });
  const sourceByStory = new Map(prepared.sources.items.map((entry) => [entry.storyId, entry]));
  for (const item of prepared.assignment.items) {
    const source = sourceByStory.get(item.storyId);
    if (!source || source.mediaHash !== item.mediaHash) {
      throw new TypeError("prepared human review source binding is invalid.");
    }
    const destination = join(artifactDirectory, item.mediaRef);
    await copyFile(source.mediaPath, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    const copied = await readFile(destination);
    if (copied.byteLength !== item.mediaBytes || sha(copied) !== item.mediaHash) {
      throw new Error("human_review_media_copy_mismatch");
    }
  }
  await exclusiveJson(join(artifactDirectory, "assignment.json"), prepared.assignment);
  await exclusiveJson(join(artifactDirectory, "review-result.json"), prepared.pendingResult);
  await exclusiveJson(join(artifactDirectory, "pack-report.json"), prepared.report);
  await writeFile(
    join(artifactDirectory, "index.html"),
    reviewHtml(publicBlindedAssignment(prepared.assignment)),
    { flag: "wx", mode: 0o600 },
  );
  return deepFreeze({
    assignment: prepared.assignment,
    pendingResult: prepared.pendingResult,
    report: prepared.report,
    artifactCount: 7,
  });
}

export function resolveHumanReviewInputPaths(input, manifestPath) {
  return normalizeGeneralizedVisualV2HumanReviewInput(input, { baseDirectory: dirname(resolve(manifestPath)) });
}
