const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const DATA_DIR = mkdtempSync(join(tmpdir(), "narration-alignment-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;
const { ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { InMemoryExportRepository } = require("../server/repositories/export-repository.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { AppError } = require("../server/errors.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { ingestUploadedNarration } = require("../server/pipelines/narrated-short/narration/upload.cjs");
const { createAlignment, normalizeAlignment, normalizeSpeechToken, scriptWords, alignmentToNarrationManifest } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { runNarrationAlignmentJob } = require("../server/pipelines/narrated-short/narration/align-job.cjs");
const { fasterWhisperVersion, transcribeWithFasterWhisper } = require("../server/adapters/faster-whisper-adapter.cjs");
const { compileTimeline } = require("../server/pipelines/narrated-short/timeline-compiler.cjs");
const { runNarratedRenderJob } = require("../server/pipelines/narrated-short/render-job.cjs");
const { contentHash } = require("../server/pipelines/narrated-short/contracts.cjs");
const { buildProductionAnimationPayloadBindings } = require("../server/pipelines/narrated-short/animation/payload-bindings.cjs");
const { buildProductionTimingContext } = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const { compileProductionAnimation, PRODUCTION_PROVIDER_ID, PRODUCTION_RUNTIME_VERSION } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { SEMANTIC_SENTENCE_PROFILE_TOKEN } = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function wav(seed = 0) { const b = Buffer.alloc(128, seed); b.write("RIFF"); b.writeUInt32LE(120, 4); b.write("WAVE", 8); return { fieldName: "narration", fileName: "voice.wav", buffer: b }; }
function providerFor(draft, mutate = (words) => words) {
  const semanticPausesBefore = new Map([[15, 0.45], [30, 0.45], [48, 0.45], [57, 0.45], [64, 0.45]]);
  let cursor = 0.2;
  const words = scriptWords(draft.script).map((word, index) => {
    cursor += semanticPausesBefore.get(index) || 0;
    const value = { word: word.text, start: cursor, end: cursor + 0.25, probability: 0.98 };
    cursor += 0.32;
    return value;
  });
  return { language: "en", segments: [{ start: 0, end: 31, text: "bounded", words: mutate(words) }] };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function setup(renderProfile = "preview") {
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const projectId = `prj_${randomUUID()}`;
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const bundle = contentArtifactRepository.createJson({ type: "approval_bundle", projectId, revision: 1, body: draft });
  const project = projectRepository.create({ id: projectId, projectType: "narrated_short", title: draft.script.title, language: "en", status: "awaiting_approval", input: { type: "content_brief", briefArtifactId: bundle.artifact.id, claimLedgerArtifactId: bundle.artifact.id, scriptArtifactId: bundle.artifact.id, storyboardArtifactId: bundle.artifact.id, revision: 1 } });
  contentApprovalRepository.approve({ projectId, projectRevision: 1, draftArtifactId: bundle.artifact.id, draftHash: bundle.envelope.contentHash, renderProfile });
  const uploaded = await ingestUploadedNarration({ project, file: wav(), fields: { draftArtifactId: bundle.artifact.id, draftHash: bundle.envelope.contentHash, projectRevision: "1", voiceProfileId: "operator_voice", language: "en", commercialUseAllowed: "true", ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent_v1" } }, { artifactStore, artifactRepository, contentArtifactRepository, contentApprovalRepository, projectRepository, ffprobeJson: async () => ({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 1 }], format: { format_name: "wav", duration: "32" } }) });
  return { artifactStore, artifactRepository, contentArtifactRepository, contentApprovalRepository, projectRepository, draft, bundle, project: uploaded.project, uploaded };
}

function productionBindings(ctx, project, renderProfile) {
  return buildProductionAnimationPayloadBindings({
    project,
    approval: ctx.contentApprovalRepository.findApproved(project.id, project.input.revision),
    renderProfile,
    contentArtifacts: ctx.contentArtifactRepository,
  });
}

function productionAnimationStub() {
  return async (input) => {
    const timingContext = buildProductionTimingContext({
      draft: input.draft,
      alignment: input.alignment,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      draftArtifactId: input.draftArtifactId,
      draftHash: input.draftHash,
      alignmentHash: input.alignmentHash,
    });
    const compiled = compileProductionAnimation({
      draft: input.draft,
      timingContext,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      renderProfile: input.renderProfile,
    });
    const create = (type, body, dependencyHashes = []) => input.contentArtifactRepository.createJson({
      type,
      projectId: input.projectId,
      jobId: input.jobId,
      revision: input.projectRevision,
      dependencyHashes,
      body,
    });
    const timingArtifact = create("animation_timing_context", timingContext, [input.draftHash, input.alignmentHash]);
    const planArtifact = create("animation_plan", compiled.plan, [timingArtifact.envelope.contentHash]);
    const irArtifact = create("animation_ir", compiled.animationIR, [planArtifact.envelope.contentHash]);
    const visualMasterPath = join(input.stagingDir, "animation-visual-master.mp4");
    writeFileSync(visualMasterPath, Buffer.from("continuous-animation"));
    const visualMasterSha256 = require("node:crypto").createHash("sha256").update("continuous-animation").digest("hex");
    const qa = {
      status: "passed",
      motion: { passed: true },
      browser: {
        externalRequestCount: 0,
        blockedExternalRequestCount: 0,
        geometryAudit: { passed: true, clippedEntityCount: 0, captionSafeZoneViolationCount: 0 },
      },
    };
    const qaArtifact = create("animation_qa_report", qa, [irArtifact.envelope.contentHash, visualMasterSha256]);
    const manifest = {
      timingContextHash: timingArtifact.envelope.contentHash,
      animationPlanHash: planArtifact.envelope.contentHash,
      animationIRHash: irArtifact.envelope.contentHash,
      animationQaHash: qaArtifact.envelope.contentHash,
      visualMasterSha256,
      compositionHash: contentHash({ animationIRHash: compiled.animationIR.contentHash }),
      provider: PRODUCTION_PROVIDER_ID,
      runtimeVersion: PRODUCTION_RUNTIME_VERSION,
      styleVersion: compiled.animationIR.renderer.styleVersion,
    };
    const renderManifestArtifact = create("animation_render_manifest", manifest, [qaArtifact.envelope.contentHash]);
    return { timingContext, animationIR: compiled.animationIR, qa, manifest, timingArtifact, planArtifact, irArtifact, qaArtifact, renderManifestArtifact, visualMasterPath, visualMasterSha256 };
  };
}

function continuousCompositorStub(writeValue) {
  return async (input) => {
    writeFileSync(input.outputPath, Buffer.from(writeValue));
    return {
      schemaVersion: 1,
      outputPath: input.outputPath,
      width: input.timeline.width,
      height: input.timeline.height,
      fps: 30,
      totalFrames: input.timeline.totalFrames,
      durationSeconds: input.timeline.totalFrames / 30,
      audioIncluded: true,
      captionsIncluded: true,
      captionsBurned: true,
      audioNormalized: true,
      audioCodec: "aac",
      audioSampleRate: 48000,
      loudness: { input: { integratedLoudness: -22.1, truePeak: -4.2, loudnessRange: 3.1, threshold: -32.2 }, output: { integratedLoudness: -16.02, truePeak: -1.6, loudnessRange: 3 } },
      renderProfile: input.renderProfile,
      timelineHash: input.timeline.contentHash,
      visualMasterSha256: require("node:crypto").createHash("sha256").update("continuous-animation").digest("hex"),
    };
  };
}

test("speech token normalization is deterministic for punctuation, apostrophes, hyphens, and simple number words", () => {
  assert.equal(normalizeSpeechToken("  WOW—Signal! "), "wowsignal");
  assert.equal(normalizeSpeechToken("DON’T"), "dont");
  assert.equal(normalizeSpeechToken("ten"), "10");
  assert.equal(normalizeSpeechToken("10"), "10");
  assert.equal(normalizeSpeechToken("nineteen,"), "19");
  assert.equal(normalizeSpeechToken("20"), normalizeSpeechToken("twenty"));
  assert.equal(normalizeSpeechToken("seventy-two"), "72");
  assert.equal(normalizeSpeechToken("72"), "72");
});

test("alignment requires exact script sequence and rejects missing, extra, reordered and changed words", async () => {
  const ctx = await setup();
  const narration = ctx.uploaded.manifest;
  const base = { project: ctx.project, draft: ctx.draft, narration, narrationSummary: ctx.project.input.activeNarration, provider: { model: "fixture", device: "cpu", computeType: "int8" } };
  const aligned = createAlignment({ ...base, providerResult: providerFor(ctx.draft) });
  assert.equal(aligned.coverage.coverageRatio, 1);
  assert.equal(normalizeAlignment(aligned).contentHash, aligned.contentHash);
  for (const mutate of [
    (w) => w.slice(1),
    (w) => [...w, { ...w[0], start: 31, end: 31.2 }],
    (w) => { const x = [...w]; [x[0], x[1]] = [x[1], x[0]]; return x; },
    (w) => [{ ...w[0], word: "changed" }, ...w.slice(1)],
  ]) assert.throws(() => createAlignment({ ...base, providerResult: providerFor(ctx.draft, mutate) }), (error) => {
    const details = error.details || {};
    return error.code === "NARRATION_SCRIPT_MISMATCH"
      && Number.isInteger(details.firstMismatchIndex)
      && !Object.hasOwn(details, "expectedWord")
      && !Object.hasOwn(details, "actualWord");
  });
});

test("alignment artifact rejects unknown nested fields", async () => {
  const ctx = await setup();
  const base = { project: ctx.project, draft: ctx.draft, narration: ctx.uploaded.manifest, narrationSummary: ctx.project.input.activeNarration, provider: { model: "fixture", device: "cpu", computeType: "int8" } };
  const aligned = createAlignment({ ...base, providerResult: providerFor(ctx.draft) });
  assert.throws(() => normalizeAlignment({ ...aligned, coverage: { ...aligned.coverage, rawTranscript: "must not persist" } }), (error) => error.code === "NARRATION_ALIGNMENT_FAILED");
  assert.throws(() => normalizeAlignment({ ...aligned, words: [{ ...aligned.words[0], providerPayload: true }, ...aligned.words.slice(1)] }), (error) => error.code === "NARRATION_ALIGNMENT_FAILED");
});

test("alignment rejects invalid, overlapping and out-of-duration timestamps", async () => {
  const ctx = await setup();
  const base = { project: ctx.project, draft: ctx.draft, narration: ctx.uploaded.manifest, narrationSummary: ctx.project.input.activeNarration, provider: { model: "fixture", device: "cpu", computeType: "int8" } };
  for (const mutate of [
    (w) => [{ ...w[0], start: -1 }, ...w.slice(1)],
    (w) => [{ ...w[0], end: Number.NaN }, ...w.slice(1)],
    (w) => { const x = [...w]; x[1] = { ...x[1], start: x[0].end - 0.1 }; return x; },
    (w) => { const x = [...w]; x[x.length - 1] = { ...x[x.length - 1], end: 33 }; return x; },
  ]) assert.throws(() => createAlignment({ ...base, providerResult: providerFor(ctx.draft, mutate) }), (error) => error.code === "NARRATION_TIMING_INVALID");
});

test("local aligner maps subprocess timeout and explicit cancellation without provider leakage", async () => {
  const timeoutChild = fakeChild();
  await assert.rejects(
    () => transcribeWithFasterWhisper({ audioPath: "/managed/input.wav", spawnImpl: () => timeoutChild, setTimeoutImpl: (callback) => { queueMicrotask(callback); return 1; }, clearTimeoutImpl: () => {} }),
    (error) => error.code === "TRANSCRIPTION_TIMEOUT" && !JSON.stringify(error).includes("/managed/input.wav"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => transcribeWithFasterWhisper({ audioPath: "/managed/input.wav", signal: controller.signal, spawnImpl: () => fakeChild() }),
    (error) => error.code === "JOB_CANCELLED" && !JSON.stringify(error).includes("/managed/input.wav"),
  );
});

test("alignment job stages managed audio, persists immutable alignment, and drives TimelineIR", async () => {
  const ctx = await setup();
  const jobs = new JobStore({ persist: false, logger: null });
  const active = ctx.project.input.activeNarration;
  const alignerEnv = { SHORTSENGINE_LOCAL_WHISPER_MODEL: "fixture" };
  const payload = { projectRevision: 1, language: "en", approvedDraftArtifactId: active.draftArtifactId, approvedDraftHash: active.draftHash, narrationManifestArtifactId: active.manifestArtifactId, narrationManifestHash: active.manifestHash, audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, scriptHash: active.scriptHash, alignerVersion: fasterWhisperVersion(alignerEnv) };
  const job = jobs.create({ projectId: ctx.project.id, action: "align_narration", pipelineType: "narrated_short", idempotencyKey: "align_fixture_001", payload });
  jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });
  const result = await runNarrationAlignmentJob({ jobs, job, project: ctx.project, payload: job.payload, dependencies: { ...ctx, alignNarration: async () => providerFor(ctx.draft), alignerEnv } });
  assert.equal(job.status, "completed");
  assert.equal(job.narrationAlignment.exactSequenceMatch, true);
  assert.equal(result.project.input.activeNarration.status, "aligned");
  assert.equal(result.project.input.activeNarration.timingReady, true);
  const narration = alignmentToNarrationManifest(result.alignment, ctx.uploaded.manifest);
  const timeline = compileTimeline({ draftBundle: ctx.draft, narrationManifest: narration, timingMode: "uploaded_aligned", alignmentArtifactId: result.artifact.artifact.id, alignmentHash: result.artifact.envelope.contentHash, width: 720, height: 1280 });
  assert.equal(timeline.totalFrames, 960);
  assert.equal(timeline.timingMode, "uploaded_aligned");
  assert.equal(timeline.alignmentHash, result.artifact.envelope.contentHash);
  assert.equal(timeline.beatTimings[0].startFrame, result.alignment.beats[0].startFrame);
  assert.equal(ctx.contentArtifactRepository.readJson(result.artifact.artifact.id).artifactType, "narration_alignment");

  const renderJob = jobs.create({ projectId: ctx.project.id, action: "render_narrated_short", pipelineType: "narrated_short", payload: { projectRevision: 1, language: "en", approvedDraftArtifactId: active.draftArtifactId, approvedDraftHash: active.draftHash, renderProfile: "preview", narrationManifestHash: result.project.input.activeNarration.manifestHash, audioHash: result.project.input.activeNarration.audioHash, alignmentHash: result.project.input.activeNarration.alignmentHash, ...productionBindings(ctx, result.project, "preview") } });
  jobs.claimJob(renderJob.id, { workerId: `wrk_${randomUUID()}` });
  const exportRepository = new InMemoryExportRepository({ artifactStore: ctx.artifactStore });
  let renderedTimeline = null;
  await runNarratedRenderJob({
    jobs, job: renderJob, project: result.project, payload: renderJob.payload, exportRepository,
    dependencies: {
      ...ctx,
      runProductionAnimationRender: productionAnimationStub(),
      renderNarratedKeyframes: async ({ timelinePath, outputDir }) => {
        renderedTimeline = JSON.parse(readFileSync(timelinePath, "utf8"));
        return { timelineHash: renderedTimeline.contentHash, frames: [{ globalFrame: 0, fileName: "frame.png", outputPath: join(outputDir, "frame.png") }] };
      },
      composeNarratedVisualMaster: async (input) => {
        renderedTimeline = input.timeline;
        assert.equal(typeof input.audioPath, "string");
        assert.equal(typeof input.assPath, "string");
        writeFileSync(input.outputPath, Buffer.from("silent-aligned-preview"));
        return { schemaVersion: 1, outputPath: input.outputPath, width: input.timeline.width, height: input.timeline.height, fps: 30, totalFrames: input.timeline.totalFrames, durationSeconds: input.timeline.totalFrames / 30, audioIncluded: true, captionsIncluded: true, captionsBurned: true, audioNormalized: true, audioCodec: "aac", audioSampleRate: 48000, loudness: { input: { integratedLoudness: -22.1, truePeak: -4.2, loudnessRange: 3.1, threshold: -32.2 }, output: { integratedLoudness: -16.02, truePeak: -1.6, loudnessRange: 3 } }, renderProfile: "preview", timelineHash: input.timeline.contentHash, visualMasterSha256: require("node:crypto").createHash("sha256").update("continuous-animation").digest("hex") };
      },
      analyzeRenderedVideo: async () => ({ size: 2048, durationSeconds: 32, videoCount: 1, audioCount: 1, width: 720, height: 1280, fps: 30, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", audioSampleRate: 48000, detector: { black: { ratio: 0, longestSeconds: 0 }, freeze: { ratio: 0.1, longestSeconds: 3 }, silence: { ratio: 0, longestSeconds: 0 } } }),
    },
  });
  assert.equal(renderJob.narratedRender.timingMode, "uploaded_aligned");
  assert.equal(renderJob.narratedRender.narrationTimingUsed, true);
  assert.equal(renderJob.narratedRender.narrationUsed, true);
  assert.equal(renderJob.narratedRender.audioIncluded, true);
  assert.equal(renderJob.narratedRender.captionsBurned, true);
  assert.equal(renderJob.narratedRender.audioNormalized, true);
  assert.match(renderJob.narratedRender.captionManifestArtifactId, /^art_/);
  assert.match(renderJob.narratedRender.captionAssArtifactId, /^art_/);
  assert.match(renderJob.narratedRender.audioNormalizationReportArtifactId, /^art_/);
  assert.equal(ctx.contentArtifactRepository.readJson(renderJob.narratedRender.captionManifestArtifactId).artifactType, "caption_manifest");
  assert.equal(ctx.contentArtifactRepository.readJson(renderJob.narratedRender.audioNormalizationReportArtifactId).artifactType, "audio_normalization_report");
  assert.equal(renderJob.narratedRender.previewOnly, true);
  assert.equal(renderJob.narratedRender.publishable, false);
  assert.equal(renderedTimeline.totalFrames, 960);
  assert.equal(renderedTimeline.alignmentHash, result.artifact.envelope.contentHash);
  const sameJob = jobs.create({ projectId: ctx.project.id, action: "align_narration", pipelineType: "narrated_short", idempotencyKey: "align_fixture_001", payload });
  assert.equal(sameJob.id, job.id);

  const replaced = await ingestUploadedNarration({ project: ctx.projectRepository.get(ctx.project.id), file: wav(7), fields: { draftArtifactId: ctx.bundle.artifact.id, draftHash: ctx.bundle.envelope.contentHash, projectRevision: "1", voiceProfileId: "operator_voice", language: "en", commercialUseAllowed: "true", ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent_v1" } }, { ...ctx, ffprobeJson: async () => ({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 1 }], format: { format_name: "wav", duration: "32" } }) });
  assert.equal(replaced.project.input.activeNarration.status, "uploaded_unaligned");
  assert.equal(replaced.project.input.activeNarration.alignmentArtifactId, null);
  assert.notEqual(replaced.project.input.activeNarration.audioHash, result.project.input.activeNarration.audioHash);
  assert.equal(ctx.contentArtifactRepository.readJson(result.artifact.artifact.id).contentHash, result.artifact.envelope.contentHash);
});

test("alignment job fails closed for stale bindings and unavailable local model", async () => {
  const ctx = await setup();
  const active = ctx.project.input.activeNarration;
  const env = { SHORTSENGINE_LOCAL_WHISPER_MODEL: "missing-local-model" };
  const basePayload = { projectRevision: 1, language: "en", approvedDraftArtifactId: active.draftArtifactId, approvedDraftHash: active.draftHash, narrationManifestArtifactId: active.manifestArtifactId, narrationManifestHash: active.manifestHash, audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, scriptHash: active.scriptHash, alignerVersion: fasterWhisperVersion(env) };
  for (const [field, value] of [["narrationManifestHash", "e".repeat(64)], ["audioHash", "f".repeat(64)], ["projectRevision", 2]]) {
    const jobs = new JobStore({ persist: false, logger: null });
    const payload = { ...basePayload, [field]: value };
    const job = jobs.create({ projectId: ctx.project.id, action: "align_narration", pipelineType: "narrated_short", payload });
    jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });
    await assert.rejects(() => runNarrationAlignmentJob({ jobs, job, project: ctx.project, payload: job.payload, dependencies: { ...ctx, alignerEnv: env, probeAlignerRuntime: () => ({ available: true }) } }), (error) => error.code === "NARRATION_ALIGNMENT_STALE" && !JSON.stringify(error).includes("voice.wav"));
  }
  const jobs = new JobStore({ persist: false, logger: null });
  const job = jobs.create({ projectId: ctx.project.id, action: "align_narration", pipelineType: "narrated_short", payload: basePayload });
  jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });
  await assert.rejects(() => runNarrationAlignmentJob({ jobs, job, project: ctx.project, payload: job.payload, dependencies: { ...ctx, alignerEnv: env, probeAlignerRuntime: () => ({ available: false, reason: "model_unavailable" }) } }), (error) => error.code === "NARRATION_ALIGNER_UNAVAILABLE" && !Object.hasOwn(error.details || {}, "reason"));
});

async function semanticProfileRenderContext() {
  const ctx = await setup();
  const jobs = new JobStore({ persist: false, logger: null });
  const active = ctx.project.input.activeNarration;
  const alignerEnv = { SHORTSENGINE_LOCAL_WHISPER_MODEL: "fixture" };
  const alignPayload = {
    projectRevision: 1,
    language: "en",
    approvedDraftArtifactId: active.draftArtifactId,
    approvedDraftHash: active.draftHash,
    narrationManifestArtifactId: active.manifestArtifactId,
    narrationManifestHash: active.manifestHash,
    audioArtifactId: active.audioArtifactId,
    audioHash: active.audioHash,
    scriptHash: active.scriptHash,
    alignerVersion: fasterWhisperVersion(alignerEnv),
  };
  const alignJob = jobs.create({
    projectId: ctx.project.id,
    action: "align_narration",
    pipelineType: "narrated_short",
    payload: alignPayload,
  });
  jobs.claimJob(alignJob.id, { workerId: `wrk_${randomUUID()}` });
  const aligned = await runNarrationAlignmentJob({
    jobs,
    job: alignJob,
    project: ctx.project,
    payload: alignJob.payload,
    dependencies: { ...ctx, alignNarration: async () => providerFor(ctx.draft), alignerEnv },
  });
  const current = aligned.project.input.activeNarration;
  const expectedTiming = buildProductionTimingContext({
    draft: ctx.draft,
    alignment: aligned.alignment,
    projectId: aligned.project.id,
    projectRevision: aligned.project.input.revision,
    draftArtifactId: active.draftArtifactId,
    draftHash: active.draftHash,
    alignmentHash: current.alignmentHash,
  });
  const expectedAnimation = {
    plan: { schemaVersion: 3, profile: "semantic-v3-job-test" },
    animationIR: {
      contentHash: "9".repeat(64),
      renderer: { styleVersion: "3.0.0" },
    },
  };
  const renderJob = jobs.create({
    projectId: aligned.project.id,
    action: "render_narrated_short",
    pipelineType: "narrated_short",
    payload: {
      projectRevision: 1,
      language: "en",
      approvedDraftArtifactId: active.draftArtifactId,
      approvedDraftHash: active.draftHash,
      renderProfile: "preview",
      narrationManifestHash: current.manifestHash,
      audioHash: current.audioHash,
      alignmentHash: current.alignmentHash,
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      timingContextHash: expectedTiming.contentHash,
      animationPlanHash: contentHash(expectedAnimation.plan),
      animationIRHash: expectedAnimation.animationIR.contentHash,
      animationProvider: PRODUCTION_PROVIDER_ID,
      animationRuntimeVersion: PRODUCTION_RUNTIME_VERSION,
      animationStyleVersion: "3.0.0",
    },
  });
  jobs.claimJob(renderJob.id, { workerId: `wrk_${randomUUID()}` });
  return {
    aligned,
    ctx,
    expectedAnimation,
    jobs,
    renderJob,
    exportRepository: new InMemoryExportRepository({ artifactStore: ctx.artifactStore }),
  };
}

test("semantic-v3 render jobs propagate the profile through stale compilation and rendering", async () => {
  const value = await semanticProfileRenderContext();
  let compileInput = null;
  let renderInput = null;
  await assert.rejects(
    () => runNarratedRenderJob({
      jobs: value.jobs,
      job: value.renderJob,
      project: value.aligned.project,
      payload: value.renderJob.payload,
      exportRepository: value.exportRepository,
      dependencies: {
        ...value.ctx,
        compileProductionAnimation(input) {
          compileInput = input;
          return value.expectedAnimation;
        },
        async runProductionAnimationRender(input) {
          renderInput = input;
          throw new Error("stop-after-profile-propagation");
        },
      },
    }),
    (error) => error?.message === "stop-after-profile-propagation",
  );
  assert.equal(compileInput.animationProfile, "semantic-v3");
  assert.equal(renderInput.animationProfile, "semantic-v3");
});

test("semantic-v3 stale bindings are recomputed with semantic-v3 before rendering", async () => {
  const value = await semanticProfileRenderContext();
  let compileInput = null;
  let renderInvoked = false;
  await assert.rejects(
    () => runNarratedRenderJob({
      jobs: value.jobs,
      job: value.renderJob,
      project: value.aligned.project,
      payload: { ...value.renderJob.payload, animationPlanHash: "8".repeat(64) },
      exportRepository: value.exportRepository,
      dependencies: {
        ...value.ctx,
        compileProductionAnimation(input) {
          compileInput = input;
          return value.expectedAnimation;
        },
        async runProductionAnimationRender() {
          renderInvoked = true;
          throw new Error("renderer-must-not-run");
        },
      },
    }),
    (error) => error?.code === "ANIMATION_BINDING_STALE",
  );
  assert.equal(compileInput.animationProfile, "semantic-v3");
  assert.equal(renderInvoked, false);
});

test("final export commits only after passing QA and evidence package; either failure leaves no export", async () => {
  for (const mode of ["pass", "qa_fail", "package_fail"]) {
    const ctx = await setup("final");
    const jobs = new JobStore({ persist: false, logger: null });
    const active = ctx.project.input.activeNarration;
    const alignerEnv = { SHORTSENGINE_LOCAL_WHISPER_MODEL: "fixture" };
    const alignPayload = { projectRevision: 1, language: "en", approvedDraftArtifactId: active.draftArtifactId, approvedDraftHash: active.draftHash, narrationManifestArtifactId: active.manifestArtifactId, narrationManifestHash: active.manifestHash, audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, scriptHash: active.scriptHash, alignerVersion: fasterWhisperVersion(alignerEnv) };
    const alignJob = jobs.create({ projectId: ctx.project.id, action: "align_narration", pipelineType: "narrated_short", payload: alignPayload });
    jobs.claimJob(alignJob.id, { workerId: `wrk_${randomUUID()}` });
    const aligned = await runNarrationAlignmentJob({ jobs, job: alignJob, project: ctx.project, payload: alignJob.payload, dependencies: { ...ctx, alignNarration: async () => providerFor(ctx.draft), alignerEnv } });
    const current = aligned.project.input.activeNarration;
    const renderJob = jobs.create({ projectId: ctx.project.id, action: "render_narrated_short", pipelineType: "narrated_short", payload: { projectRevision: 1, language: "en", approvedDraftArtifactId: active.draftArtifactId, approvedDraftHash: active.draftHash, renderProfile: "final", narrationManifestHash: current.manifestHash, audioHash: current.audioHash, alignmentHash: current.alignmentHash, ...productionBindings(ctx, aligned.project, "final") } });
    jobs.claimJob(renderJob.id, { workerId: `wrk_${randomUUID()}` });
    const exportRepository = new InMemoryExportRepository({ artifactStore: ctx.artifactStore });
    const dependencies = {
      ...ctx,
      runProductionAnimationRender: productionAnimationStub(),
      renderNarratedKeyframes: async ({ timelinePath, outputDir }) => { const timeline = JSON.parse(readFileSync(timelinePath, "utf8")); return { timelineHash: timeline.contentHash, frames: [{ globalFrame: 0, fileName: "frame.png", outputPath: join(outputDir, "frame.png") }] }; },
      composeNarratedPreview: async (input) => { writeFileSync(input.outputPath, Buffer.from("technical-final-candidate")); return { schemaVersion: 1, outputPath: input.outputPath, width: 1080, height: 1920, fps: 30, totalFrames: input.timeline.totalFrames, durationSeconds: 32, audioIncluded: true, captionsIncluded: true, captionsBurned: true, audioNormalized: true, audioCodec: "aac", audioSampleRate: 48000, loudness: { input: { integratedLoudness: -22.1, truePeak: -4.2, loudnessRange: 3.1, threshold: -32.2 }, output: { integratedLoudness: -16.02, truePeak: -1.6, loudnessRange: 3 } }, renderProfile: "final", timelineHash: input.timeline.contentHash, keyframeCount: 1 }; },
      composeNarratedVisualMaster: continuousCompositorStub("technical-final-candidate"),
      analyzeRenderedVideo: async () => ({ size: 4096, durationSeconds: 32, videoCount: 1, audioCount: 1, width: 1080, height: 1920, fps: 30, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", audioSampleRate: 48000, detector: { black: mode === "qa_fail" ? { ratio: 1, longestSeconds: 32 } : { ratio: 0, longestSeconds: 0 }, freeze: { ratio: 0.1, longestSeconds: 3 }, silence: { ratio: 0, longestSeconds: 0 } } }),
      generateEvidencePackage: async ({ outputHash }) => {
        if (mode === "package_fail") throw new AppError("EVIDENCE_PACKAGE_HASH_MISMATCH", "The technical evidence package hashes do not match.", 409, { failedArtifactCode: "contact_sheet" });
        return { summary: { packageStatus: "complete", contactSheetArtifactId: "art_contactsheet12345678", contactSheetHash: "1".repeat(64), rightsManifestArtifactId: "art_rightsmanifest12345678", rightsManifestHash: "2".repeat(64), provenanceReportArtifactId: "art_provenance12345678", provenanceReportHash: "3".repeat(64), exportMetadataArtifactId: "art_exportmetadata12345678", exportMetadataHash: "4".repeat(64), outputHash, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true, failedArtifactCode: null } };
      },
    };
    if (mode === "pass") {
      await runNarratedRenderJob({ jobs, job: renderJob, project: aligned.project, payload: renderJob.payload, exportRepository, dependencies });
      assert.equal(exportRepository.all().length, 1);
      assert.equal(renderJob.technicalQa.qaPassed, true);
      assert.equal(renderJob.narratedRender.technicalFinal, true);
      assert.equal(renderJob.narratedRender.publishable, false);
    } else if (mode === "qa_fail") {
      await assert.rejects(() => runNarratedRenderJob({ jobs, job: renderJob, project: aligned.project, payload: renderJob.payload, exportRepository, dependencies }), (error) => error.code === "QA_BLOCKED" && !JSON.stringify(error).includes("technical-final-candidate"));
      assert.equal(exportRepository.all().length, 0);
      assert.equal(renderJob.technicalQa.qaPassed, false);
      assert.ok(renderJob.technicalQa.failedGateCodes.includes("VIDEO_BLACK_OUTPUT_ABSENT"));
    } else {
      await assert.rejects(() => runNarratedRenderJob({ jobs, job: renderJob, project: aligned.project, payload: renderJob.payload, exportRepository, dependencies }), (error) => error.code === "EVIDENCE_PACKAGE_HASH_MISMATCH" && !JSON.stringify(error).includes("technical-final-candidate"));
      assert.equal(exportRepository.all().length, 0);
      assert.equal(renderJob.evidencePackage.packageStatus, "failed");
      assert.equal(renderJob.evidencePackage.failedArtifactCode, "contact_sheet");
    }
  }
});
