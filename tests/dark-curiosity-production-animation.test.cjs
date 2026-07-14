const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { buildProductionTimingContext } = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const { buildProductionAnimationPlan, compileProductionAnimation } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { runProductionAnimationRender } = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const { safeSeekSequence } = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const { validateSemanticNarrative } = require("../server/pipelines/narrated-short/animation/semantic-narrative.cjs");
const { contentHash } = require("../server/pipelines/narrated-short/contracts.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const art = (letter) => `art_${letter.repeat(40)}`;
const hash = (letter) => letter.repeat(64);

function productionFixture() {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const projectId = `prj_${randomUUID()}`;
  const expected = scriptWords(draft.script);
  const durationSeconds = 34.3467;
  const words = expected.map((word, index) => {
    const start = 0.08 + index * 0.415;
    return { word: word.text, start, end: Math.min(durationSeconds, start + 0.31), probability: 0.99 };
  });
  const narration = { media: { durationSeconds }, language: "en", voiceProfileId: "voice", rights: { commercialUseAllowed: true, consentReference: "consent" }, draftArtifactId: art("a"), draftHash: draft.contentHash, scriptHash: draft.script.contentHash, audioArtifactId: art("d"), audioHash: hash("d") };
  const summary = { manifestArtifactId: art("c"), manifestHash: hash("c") };
  const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: summary, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
  const timingContext = buildProductionTimingContext({ draft, alignment, projectId, projectRevision: 1, draftArtifactId: art("a"), draftHash: draft.contentHash, alignmentHash: alignment.contentHash });
  return { draft, projectId, alignment, timingContext };
}

test("production timing context is derived from exact approved alignment", () => {
  const value = productionFixture();
  assert.equal(value.timingContext.words.length, 81);
  assert.equal(value.timingContext.durationFrames, Math.ceil(34.3467 * 30));
  assert.deepEqual(value.timingContext.beats.map((beat) => beat.beatId), value.draft.script.beats.map((beat) => beat.id));
  assert.equal(buildProductionTimingContext({ draft: value.draft, alignment: value.alignment, draftArtifactId: art("a"), draftHash: value.draft.contentHash, alignmentHash: value.alignment.contentHash }).contentHash, value.timingContext.contentHash);
  assert.throws(() => buildProductionTimingContext({ draft: value.draft, alignment: value.alignment, draftArtifactId: art("a"), draftHash: hash("f"), alignmentHash: value.alignment.contentHash }), { code: "ANIMATION_TIMING_BINDING_MISMATCH" });
});

test("production plan and AnimationIR are deterministic and data-bound", () => {
  const value = productionFixture();
  const input = { draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" };
  const first = compileProductionAnimation(input);
  const second = compileProductionAnimation(input);
  const independent = productionFixture();
  const independentPlan = compileProductionAnimation({ draft: independent.draft, timingContext: independent.timingContext, projectId: independent.projectId, projectRevision: 1, renderProfile: "preview" });
  assert.equal(first.animationIR.contentHash, second.animationIR.contentHash);
  assert.notEqual(value.projectId, independent.projectId);
  assert.notEqual(value.alignment.contentHash, independent.alignment.contentHash);
  assert.equal(first.animationIR.seed, independentPlan.animationIR.seed);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.id), ["scene_hook", "scene_context", "scene_evidence", "scene_turn", "scene_payoff"]);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.template), ["wow_observation_v1", "frequency_duration_v1", "telescope_beam_v1", "repeat_search_v1", "evidence_payoff_v1"]);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.semantic.role), ["hook", "context", "evidence", "turn", "payoff"]);
  const operations = new Map(first.animationIR.scenes.flatMap((scene) => scene.operations).map((operation) => [`${operation.op}:${operation.targetId}`, operation]));
  assert.deepEqual([operations.get("highlight:wow_annotation").from.wordIndex, operations.get("highlight:wow_annotation").to.wordIndex], [11, 14]);
  assert.deepEqual([operations.get("pulse:duration_timer").from.wordIndex, operations.get("pulse:duration_timer").to.wordIndex], [27, 29]);
  assert.deepEqual([operations.get("trace_signal:evidence_trace").from.wordIndex, operations.get("trace_signal:evidence_trace").to.wordIndex], [31, 41]);
  assert.deepEqual([operations.get("highlight:no_repeat_label").from.wordIndex, operations.get("highlight:no_repeat_label").to.wordIndex], [51, 56]);
  assert.deepEqual([operations.get("highlight:final_evidence_label").from.wordIndex, operations.get("highlight:final_evidence_label").to.wordIndex], [78, 80]);
  assert.deepEqual(validateSemanticNarrative(first.animationIR), { valid: true, mode: "semantic", beatCount: 5, cueCount: 17 });
  const seekSequence = safeSeekSequence(first.animationIR);
  for (const scene of first.animationIR.scenes) assert.ok(seekSequence.includes(Math.floor((scene.startFrame + scene.endFrame - 1) / 2)));
  assert.ok(seekSequence.length <= 40);
  assert.equal(first.animationIR.timingBinding.timingContextHash, value.timingContext.contentHash);
  assert.equal(first.animationIR.durationFrames, value.alignment.durationFrames);
  assert.equal(first.animationIR.renderer.provider, "hyperframes_local");
  assert.equal(first.animationIR.content.semantic.profileId, "wow_signal_case_v1");
  assert.equal(first.animationIR.content.semantic.eventYearLabel, "1977");
  assert.equal(first.animationIR.content.semantic.sourceLabel, "PROMISING COMMUNICATION BAND");
  assert.equal(first.animationIR.content.metricValue, "72");
  assert.deepEqual(first.animationIR.content.payoffLines, ["UNEXPLAINED IS NOT PROOF"]);
});

test("semantic production profile fails closed on missing narration cues and metadata", () => {
  const value = productionFixture();
  const missingCue = structuredClone(value.timingContext);
  delete missingCue.contentHash;
  missingCue.words[14].text = "Different";
  assert.throws(() => buildProductionAnimationPlan({ draft: value.draft, timingContext: missingCue, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }), { code: "ANIMATION_TEMPLATE_INVALID" });
  const compiled = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  delete compiled.scenes[2].operations[0].visualStatement;
  assert.throws(() => validateSemanticNarrative(compiled), { code: "ANIMATION_SEMANTIC_INVALID" });

  const uncoveredClaim = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  uncoveredClaim.scenes[2].semantic.claimIds.push("claim_uncovered");
  assert.throws(() => validateSemanticNarrative(uncoveredClaim), { code: "ANIMATION_SEMANTIC_INVALID" });

  const futureCarry = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  futureCarry.scenes[2].operations.find((operation) => operation.targetId === "evidence_trace").carryPolicy = "clear_at_scene_end";
  futureCarry.scenes[3].operations.find((operation) => operation.targetId === "evidence_trace").carryPolicy = "carry_to_next";
  assert.throws(() => validateSemanticNarrative(futureCarry), { code: "ANIMATION_SEMANTIC_INVALID" });

  const legacyWithSemanticVersion = structuredClone(compiled);
  legacyWithSemanticVersion.scenes.forEach((scene) => { scene.template = "signal_lab_v1"; });
  delete legacyWithSemanticVersion.content.semantic;
  assert.throws(() => validateSemanticNarrative(legacyWithSemanticVersion), { code: "ANIMATION_SEMANTIC_INVALID" });
});

test("semantic renderer exposes five story stages, genuine carry morphing, and no editorial pipeline labels", async () => {
  const value = productionFixture();
  const ir = compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR;
  const { compileAnimationIRToHtml, semanticEvidenceMorphPath } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const html = compileAnimationIRToHtml(ir).html;
  for (const id of ["stage-hook", "stage-context", "stage-evidence", "stage-turn", "stage-payoff"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const cue of ["wow_annotation", "duration_72_seconds", "beam_signal_trace", "no_verified_repeat", "no_repeatable_proof"]) assert.match(html, new RegExp(`data-semantic-cue-id="${cue}"`));
  assert.match(html, /id="evidence-carry-morph"/);
  const source = semanticEvidenceMorphPath(0);
  const midpoint = semanticEvidenceMorphPath(0.5);
  const target = semanticEvidenceMorphPath(1);
  assert.notEqual(midpoint, source);
  assert.notEqual(midpoint, target);
  assert.equal(midpoint, semanticEvidenceMorphPath(0.5));
  assert.match(html, new RegExp(`id="signal-strength-curve" d="${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`id="single-signal-spike" d="${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const changedYear = structuredClone(ir);
  changedYear.content.semantic.eventYearLabel = "1984";
  assert.match(compileAnimationIRToHtml(changedYear).html, /class="small-label">1984<\/text>/);
  assert.doesNotMatch(html, />\s*(?:HOOK|CONTEXT|EVIDENCE|TURN|PAYOFF)\s*</);
});

test("browser seek sampling is hard-capped while retaining every scene midpoint", () => {
  const durationFrames = 1200;
  const scenes = Array.from({ length: 12 }, (_, sceneIndex) => {
    const startFrame = sceneIndex * 100;
    return {
      startFrame,
      endFrame: startFrame + 100,
      operations: Array.from({ length: 40 }, (_, operationIndex) => ({
        from: { resolvedFrame: startFrame + operationIndex },
        to: { resolvedFrame: startFrame + operationIndex + 2 },
      })),
    };
  });
  const sequence = safeSeekSequence({ durationFrames, profileVersion: "1.0.0", content: {}, scenes });
  assert.ok(sequence.length <= 39);
  for (const scene of scenes) assert.ok(sequence.includes(Math.floor((scene.startFrame + scene.endFrame - 1) / 2)));
});

test("production plan rejects unsupported formats and changes with content", () => {
  const value = productionFixture();
  const changed = structuredClone(value.draft);
  delete changed.contentHash;
  changed.script.title = "A different documented mystery";
  delete changed.script.contentHash;
  assert.throws(() => buildProductionAnimationPlan({ draft: { ...value.draft, brief: { ...value.draft.brief, formatId: "deepest_iceberg_layer_v1", contentHash: undefined }, contentHash: undefined }, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1 }), { code: "ANIMATION_TEMPLATE_INVALID" });
  assert.notEqual(normalizeDraftBundle(changed).contentHash, value.draft.contentHash);
});

test("production render service persists hash-bound artifacts and blocks no QA gate", async () => {
  const value = productionFixture();
  const stagingDir = mkdtempSync(resolve(tmpdir(), "production-animation-"));
  const created = [];
  const contentArtifactRepository = { createJson(input) { const bodyHash = contentHash(input.body); const result = { artifact: { id: `art_${bodyHash.slice(0, 40)}` }, envelope: { contentHash: bodyHash } }; created.push({ ...input, ...result }); return result; } };
  const provider = {
    id: "hyperframes_local",
    doctor: async () => ({ ready: true, runtimeVersion: "0.7.55" }),
    validate: (animationIR) => ({ animationIR, budget: { computedCost: 42 } }),
    estimate: ({ animationIR }) => ({ frames: animationIR.durationFrames, durationSeconds: animationIR.durationFrames / 30, complexityCost: 42, estimatedMemoryMb: 300, expectedDurationSeconds: 20 }),
    render: async ({ validated, stagingDir: rendererDir }) => {
      const outputPath = resolve(rendererDir, "visual-master.mp4");
      writeFileSync(outputPath, "continuous-video");
      const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
      return { outputPath, outputSha256: require("node:crypto").createHash("sha256").update("continuous-video").digest("hex"), animationIRHash: validated.animationIR.contentHash, compositionHash: compileAnimationIRToHtml(validated.animationIR).compositionHash };
    },
    verify: (manifest) => ({ valid: true, outputSha256: manifest.outputSha256, animationIRHash: manifest.animationIRHash }),
  };
  try {
    const result = await runProductionAnimationRender({ draft: value.draft, alignment: value.alignment, projectId: value.projectId, projectRevision: 1, jobId: `job_${randomUUID()}`, draftArtifactId: art("a"), draftHash: value.draft.contentHash, alignmentHash: value.alignment.contentHash, renderProfile: "preview", stagingDir, contentArtifactRepository }, {
      providerRegistry: { get: () => provider },
      chromePath: "/mock/chrome",
      runBrowserSeekProof: async (request) => ({ seekSequence: request.seekSequence, captures: request.seekSequence.map((frame, sequenceIndex) => ({ sequenceIndex, frame, sha256: hash("b") })), repeatedFrames: [{ frame: 0, occurrences: 2, sha256: hash("b"), equal: true }], loadedOnce: true, pageLoadCount: 1, stateIsolation: { valid: true }, externalRequestCount: 0, blockedExternalRequestCount: 0, resourceClasses: [], geometryAudit: { passed: true, semanticRoi: { x: 0, y: 0, width: 720, height: 900 }, captionSafeZone: { x: 0, y: 947, width: 720, height: 333 }, checkpointCount: request.seekSequence.length, entityObservationCount: 10, clippedEntities: [], captionSafeZoneViolations: [] }, passed: true }),
      runBenchmarkQa: () => ({ passed: true, checks: { immediateHook: true, consecutiveStasis: true, contiguousStasis: true, balancedMotion: true }, technical: { codec: "h264", pixelFormat: "yuv420p", width: 720, height: 1280, fps: 30, frameCount: 1031, durationSeconds: 1031 / 30 }, motion: { firstMeaningfulMotionFrame: 1, consecutiveStasisRatio: 0.1, maxContiguousStasisFrames: 10, maxWindowMotionShare: 0.3, rawMaxWindowMotionShare: 0.35, sampleHashes: [hash("c")] }, clippedEntities: 0, captionSafeZoneViolations: 0 }),
    });
    assert.deepEqual(created.map((entry) => entry.type), ["animation_timing_context", "animation_plan", "animation_ir", "animation_qa_report", "animation_render_manifest"]);
    assert.equal(result.manifest.provider, "hyperframes_local");
    assert.equal(result.manifest.animationIRHash, result.irArtifact.envelope.contentHash);
    assert.equal(result.manifest.visualMasterSha256, result.visualMasterSha256);
    assert.equal(result.manifest.animationQaHash, result.qaArtifact.envelope.contentHash);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});
