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
  assert.equal(first.animationIR.contentHash, second.animationIR.contentHash);
  assert.equal(first.animationIR.timingBinding.timingContextHash, value.timingContext.contentHash);
  assert.equal(first.animationIR.durationFrames, value.alignment.durationFrames);
  assert.equal(first.animationIR.renderer.provider, "hyperframes_local");
  assert.equal(first.animationIR.content.metricValue, "72");
  assert.deepEqual(first.animationIR.content.payoffLines, ["UNEXPLAINED IS NOT PROOF"]);
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
