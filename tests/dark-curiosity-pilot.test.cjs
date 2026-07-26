const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const { parsePilotArgs } = require("../server/pipelines/narrated-short/pilot/cli.cjs");
const { PILOT_PROFILE, PILOT_PROFILE_VERSION, PILOT_STAGES, PilotStateMachine, normalizePilotReport, pilotRunId } = require("../server/pipelines/narrated-short/pilot/contract.cjs");
const { animationProfileMatchesEvidence, normalizePilotAnimationProfile, pilotReleaseIdempotencyKey, renderPayload, verifiedAlignedNarrationReuse, verifySemanticAnimationArtifactChain } = require("../server/pipelines/narrated-short/pilot/local-runtime.cjs");
const { runPilotWorkflow } = require("../server/pipelines/narrated-short/pilot/orchestrator.cjs");
const { persistPilotReport, readLatestPilotReport } = require("../server/pipelines/narrated-short/pilot/report-store.cjs");
const { SEMANTIC_SENTENCE_PROFILE_ID, SEMANTIC_SENTENCE_PROFILE_TOKEN } = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");
const { compileProductionAnimation } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { buildSemanticAnimationSceneDslPlanFromScenes } = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl-plan.cjs");
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { contentHash, normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeAlignment } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { normalizeNarrationAsset } = require("../server/pipelines/narrated-short/narration/contract.cjs");
const { idempotencyKey } = require("../server/jobs.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const HASH = "a".repeat(64);
const artifact = (character) => ({ artifactId: `art_${character.repeat(40)}`, hash: character.repeat(64) });
const job = (character) => ({ jobId: `job_${character.repeat(40)}`, exportArtifactId: `art_${character.repeat(40)}`, outputHash: character.repeat(64), status: "completed" });
const READY = { status: "ready", environmentReady: true, ffmpeg: true, ffprobe: true, renderer: true, aligner: true, managedStorage: true, fixtureValid: true, narrationAvailable: true, rightsConfirmed: true, previewCapable: true, technicalFinalCapable: true, blockingReasons: [], nextActions: [] };

function report(overrides = {}) {
  return { schemaVersion: 1, profile: PILOT_PROFILE, profileVersion: PILOT_PROFILE_VERSION, runId: `pilot_${"1".repeat(40)}`, status: "complete", projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1, fixture: { fixtureId: "fixture.json", hash: HASH }, approvedDraft: artifact("2"), narrationManifest: artifact("3"), narrationAudio: artifact("4"), narrationAlignment: artifact("5"), preview: job("6"), final: job("7"), qa: { report: artifact("8"), blockingGateCount: 4, blockingPassedCount: 4, blockingFailedCount: 0, warningCount: 0 }, contactSheet: artifact("9"), rightsManifest: artifact("a"), provenanceReport: artifact("b"), exportMetadata: artifact("c"), completedStages: [...PILOT_STAGES], failure: null, readiness: READY, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000, ...overrides };
}

function alignedNarrationReuseFixture() {
  const projectId = "prj_11111111-1111-4111-8111-111111111111";
  const draftArtifactId = `art_${"4".repeat(40)}`;
  const manifestArtifactId = `art_${"5".repeat(40)}`;
  const audioArtifactId = `art_${"6".repeat(40)}`;
  const alignmentArtifactId = `art_${"7".repeat(40)}`;
  const draftHash = "d".repeat(64);
  const scriptHash = "e".repeat(64);
  const audioBuffer = Buffer.from("verified pilot narration audio");
  const audioHash = createHash("sha256").update(audioBuffer).digest("hex");
  const manifest = normalizeNarrationAsset({
    schemaVersion: 1,
    status: "uploaded_unaligned",
    projectId,
    projectRevision: 1,
    verticalId: "dark_curiosity",
    draftArtifactId,
    draftHash,
    scriptHash,
    audioArtifactId,
    audioHash,
    voiceProfileId: "operator_voice",
    language: "en",
    media: { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 2, bytes: 128 },
    rights: { commercialUseAllowed: true, ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent-v1", licenseReference: null },
  });
  const alignment = normalizeAlignment({
    schemaVersion: 1,
    status: "aligned",
    projectId,
    projectRevision: 1,
    verticalId: "dark_curiosity",
    draftArtifactId,
    draftHash,
    scriptHash,
    narrationManifestArtifactId: manifestArtifactId,
    narrationManifestHash: manifest.contentHash,
    audioArtifactId,
    audioHash,
    language: "en",
    fps: 30,
    durationFrames: 60,
    words: [{ index: 0, text: "Signal", startFrame: 0, endFrame: 30, confidence: 0.99 }],
    beats: [{ beatId: "beat_hook", wordStartIndex: 0, wordEndIndex: 1, startFrame: 0, endFrame: 30 }],
    coverage: { expectedWords: 1, alignedWords: 1, exactSequenceMatch: true, coverageRatio: 1 },
    provider: { mode: "local_faster_whisper", model: "fixture", device: "cpu", computeType: "int8", promptVersion: "narration_alignment_v1" },
  });
  const activeNarration = {
    status: "aligned",
    projectRevision: 1,
    manifestArtifactId,
    manifestHash: manifest.contentHash,
    audioArtifactId,
    audioHash,
    draftArtifactId,
    draftHash,
    scriptHash,
    voiceProfileId: "operator_voice",
    language: "en",
    media: manifest.media,
    rights: { commercialUseAllowed: true, ownershipBasis: "self_recorded", consentDeclared: true, licenseDeclared: false },
    alignmentArtifactId,
    alignmentHash: alignment.contentHash,
    aligned: true,
    timingReady: true,
    renderReady: false,
  };
  const project = { id: projectId, language: "en", input: { revision: 1, activeNarration } };
  const envelopes = new Map([
    [manifestArtifactId, { artifactType: "narration_manifest", projectId, revision: 1, contentHash: manifest.contentHash, body: manifest }],
    [alignmentArtifactId, { artifactType: "narration_alignment", projectId, revision: 1, contentHash: alignment.contentHash, body: alignment }],
  ]);
  const audio = { id: audioArtifactId, type: "narration_audio", ownerProjectId: projectId, checksumSha256: audioHash, status: "available" };
  const input = {
    project,
    projectRevision: 1,
    draftArtifactId,
    draftHash,
    scriptHash,
    audioHash,
    contentArtifactRepository: { readJson: (id) => {
      const value = envelopes.get(id);
      if (!value) throw new Error("missing");
      return structuredClone(value);
    } },
    artifactRepository: { get: (id) => id === audioArtifactId ? structuredClone(audio) : null },
    artifactStore: { readArtifact: () => Buffer.from(audioBuffer) },
  };
  return { input, envelopes, audio, audioBuffer, activeNarration, manifest, alignment };
}

function semanticCompletionChainFixture(generalized) {
  const rawDraft = JSON.parse(readFileSync(resolve(
    __dirname,
    "..",
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    "002_gps_week_rollover.json",
  ), "utf8"));
  if (generalized) rawDraft.script.title = `${rawDraft.script.title} Reframed`;
  const draft = normalizeDraftBundle(rawDraft);
  const rawTiming = JSON.parse(readFileSync(resolve(
    __dirname,
    "..",
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    "timing",
    "002_gps_week_rollover.timing.json",
  ), "utf8"));
  delete rawTiming.contentHash;
  rawTiming.draftHash = draft.contentHash;
  const timingContext = normalizeAnimationTimingContext(rawTiming);
  const compileInput = {
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    projectId: "prj_11111111-1111-4111-8111-111111111111",
    projectRevision: 1,
    renderProfile: "final",
    draft,
    timingContext,
  };
  let compiled = compileProductionAnimation(compileInput);
  if (generalized) {
    const deterministic =
      compiled.animationIR.content.semanticAnimationSceneDslPlan;
    const mockPlan = buildSemanticAnimationSceneDslPlanFromScenes({
      bindings: deterministic.bindings,
      planner: {
        plannerId: "pilot_mock_scene_planner",
        mode: "mock",
        promptProfileId: deterministic.planner.promptProfileId,
      },
      scenes: deterministic.scenes,
    });
    compiled = compileProductionAnimation({
      ...compileInput,
      semanticAnimationSceneDslPlan: mockPlan,
    });
  }

  const animationIr = compiled.animationIR;
  const graph = animationIr.content.semanticEventGraph;
  const sentencePlan = animationIr.content.semanticVisualSentencePlan;
  const scenePlan = animationIr.content.semanticAnimationSceneDslPlan || null;
  const plannerConfigurationHash = "f".repeat(64);
  const ids = {
    timing: "art_pilot-timing-context",
    plan: "art_pilot-animation-plan",
    ir: "art_pilot-animation-ir",
    animationQa: "art_pilot-animation-qa",
    manifest: "art_pilot-animation-manifest",
    scenePlan: "art_pilot-scene-plan",
    draft: "art_pilot-approved-draft",
    alignment: "art_pilot-alignment",
  };
  const hashes = {
    timing: graph.timingContextHash,
    plan: contentHash(compiled.plan),
    ir: animationIr.contentHash,
    animationQa: "a".repeat(64),
    visual: "b".repeat(64),
    composition: "c".repeat(64),
  };
  const manifest = {
    schemaVersion: 1,
    timingContextArtifactId: ids.timing,
    timingContextHash: hashes.timing,
    animationPlanArtifactId: ids.plan,
    animationPlanHash: hashes.plan,
    animationIRArtifactId: ids.ir,
    animationIRHash: hashes.ir,
    provider: "hyperframes_local",
    runtimeVersion: "0.7.55",
    styleVersion: animationIr.renderer.styleVersion,
    compositionHash: hashes.composition,
    visualMasterSha256: hashes.visual,
    browserProofHash: "d".repeat(64),
    motionProofHash: "e".repeat(64),
    animationQaArtifactId: ids.animationQa,
    animationQaHash: hashes.animationQa,
    ...(scenePlan ? {
      animationScenePlanArtifactId: ids.scenePlan,
      animationScenePlanHash: scenePlan.contentHash,
    } : {}),
    estimate: { frames: animationIr.durationFrames },
  };
  const manifestEnvelope = {
    artifactType: "animation_render_manifest",
    projectId: compileInput.projectId,
    revision: 1,
    contentHash: contentHash(manifest),
    dependencyHashes: [...new Set([
      hashes.timing,
      hashes.plan,
      hashes.ir,
      hashes.animationQa,
      hashes.visual,
    ])].sort(),
    body: manifest,
  };
  const bindings = {
    draftArtifactId: ids.draft,
    draftHash: animationIr.draftHash,
    alignmentArtifactId: ids.alignment,
    alignmentHash: animationIr.alignmentHash,
    animationTimingContextArtifactId: ids.timing,
    animationTimingContextHash: hashes.timing,
    animationPlanArtifactId: ids.plan,
    animationPlanHash: hashes.plan,
    animationIRArtifactId: ids.ir,
    animationIRHash: hashes.ir,
    animationRenderManifestArtifactId: ids.manifest,
    animationRenderManifestHash: manifestEnvelope.contentHash,
    animationQaArtifactId: ids.animationQa,
    animationQaHash: hashes.animationQa,
    visualMasterSha256: hashes.visual,
    animationCompositionHash: hashes.composition,
    animationProvider: manifest.provider,
    animationRuntimeVersion: manifest.runtimeVersion,
    animationStyleVersion: manifest.styleVersion,
  };
  const scenePlanEnvelope = scenePlan ? {
    artifactType: "animation_scene_dsl_plan",
    projectId: compileInput.projectId,
    revision: 1,
    contentHash: scenePlan.contentHash,
    dependencyHashes: [...new Set([
      animationIr.draftHash,
      animationIr.alignmentHash,
      graph.timingContextHash,
      graph.contentHash,
      sentencePlan.contentHash,
      plannerConfigurationHash,
    ])].sort(),
    body: scenePlan,
  } : null;
  const envelopes = new Map([[ids.manifest, manifestEnvelope]]);
  if (scenePlanEnvelope) envelopes.set(ids.scenePlan, scenePlanEnvelope);
  const project = {
    id: compileInput.projectId,
    input: {
      revision: 1,
      ...(scenePlan ? {
        activeAnimationScenePlan: {
          status: "ready",
          animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
          projectRevision: 1,
          planArtifactId: ids.scenePlan,
          planHash: scenePlan.contentHash,
          draftArtifactId: ids.draft,
          draftHash: animationIr.draftHash,
          alignmentArtifactId: ids.alignment,
          alignmentHash: animationIr.alignmentHash,
          timingContextHash: graph.timingContextHash,
          semanticEventGraphHash: graph.contentHash,
          semanticVisualSentencePlanHash: sentencePlan.contentHash,
          plannerMode: scenePlan.planner.mode,
          promptProfileId: scenePlan.planner.promptProfileId,
          plannerConfigurationHash,
          sceneCount: scenePlan.summary.sceneCount,
          fallbackSceneCount: scenePlan.summary.fallbackSceneCount,
        },
      } : {}),
    },
  };
  return {
    animationIrEnvelope: {
      artifactType: "animation_ir",
      projectId: compileInput.projectId,
      revision: 1,
      contentHash: hashes.ir,
      body: animationIr,
    },
    contentArtifactRepository: {
      readJson(artifactId) {
        const envelope = envelopes.get(artifactId);
        if (!envelope) throw new Error("missing test artifact");
        return envelope;
      },
    },
    envelopes,
    manifestEnvelope,
    project,
    qaEnvelope: { body: { bindings } },
    report: {
      approvedDraft: {
        artifactId: ids.draft,
        hash: animationIr.draftHash,
      },
      narrationAlignment: {
        artifactId: ids.alignment,
        hash: animationIr.alignmentHash,
      },
    },
  };
}

test("pilot state machine enforces exact ordering and terminal states", () => {
  const machine = new PilotStateMachine();
  assert.throws(() => machine.transition("project_created"), { code: "PILOT_STATE_INVALID" });
  for (const stage of PILOT_STAGES) machine.transition(stage);
  assert.deepEqual(machine.completed, PILOT_STAGES);
  assert.throws(() => machine.transition("pilot_complete"), { code: "PILOT_STATE_INVALID" });
  const failed = new PilotStateMachine(["fixture_validated"]); assert.equal(failed.fail(), "pilot_failed"); assert.throws(() => failed.transition("project_created"), { code: "PILOT_STATE_INVALID" });
});

test("pilot report is strict, deterministic across runtime timings, and always non-publishable", () => {
  const first = normalizePilotReport(report());
  const second = normalizePilotReport(report({ startedAt: "2026-02-01T00:00:00.000Z", completedAt: "2026-02-01T00:00:09.000Z", durationMs: 9000 }));
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.contentHash, "fabede24bc3f62a5bfe7552bba434c0a8e06b37965690920fd5f2d5e23e7ed62");
  assert.equal(Object.hasOwn(first, "animationProfile"), false);
  assert.equal(first.publishable, false);
  assert.equal(first.publishApprovalRequired, true);
  const semantic = normalizePilotReport(report({ animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN }));
  assert.equal(semantic.animationProfile, SEMANTIC_SENTENCE_PROFILE_TOKEN);
  assert.notEqual(semantic.contentHash, first.contentHash);
  assert.throws(() => normalizePilotReport(report({ animationProfile: "unknown" })), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport(report({ animationProfile: null })), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport({ ...first, readiness: { ...first.readiness, storageKey: "secret" } }), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport({ ...first, completedStages: [...first.completedStages, "pilot_complete"] }), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport({ ...first, final: { ...first.final, outputHash: "bad" } }), { code: "PILOT_REPORT_INVALID" });
  const exportBacked = normalizePilotReport(report({ preview: { ...job("6"), exportArtifactId: "exp_11111111-1111-4111-8111-111111111111" }, final: { ...job("7"), exportArtifactId: "exp_22222222-2222-4222-8222-222222222222" } }));
  assert.match(exportBacked.final.exportArtifactId, /^exp_/);
  assert.throws(() => normalizePilotReport(report({ final: { ...job("7"), exportArtifactId: "upload_unsafe" } })), { code: "PILOT_REPORT_INVALID" });
});

test("pilot report store atomically updates latest with a validated bounded report", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-report-"));
  try {
    const stored = persistPilotReport(report(), dir);
    assert.equal(readLatestPilotReport(dir).contentHash, stored.contentHash);
    assert.doesNotMatch(readFileSync(join(dir, "latest.json"), "utf8"), /storageKey|\/Users|\/private/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pilot CLI validates managed fixture, operator rights, profiles, and output roots", () => {
  const output = join(tmpdir(), "pilot-safe-output");
  const reportOnly = parsePilotArgs(["--fixture", FIXTURE, "--output-dir", output, "--report-only"]);
  assert.equal(reportOnly.reportOnly, true);
  assert.equal(reportOnly.animationProfile, null);
  const semantic = parsePilotArgs(["--fixture", FIXTURE, "--output-dir", output, "--report-only", "--animation-profile", "SEMANTIC-V3"]);
  assert.equal(semantic.animationProfile, SEMANTIC_SENTENCE_PROFILE_TOKEN);
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--unknown"]), { code: "VALIDATION_ERROR" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--report-only", "--animation-profile", "semantic-v4"]), { code: "VALIDATION_ERROR" });
  assert.throws(() => parsePilotArgs(["--fixture", "/tmp/fixture.json", "--report-only"]), { code: "PILOT_FIXTURE_UNSAFE" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE]), { code: "PILOT_READINESS_BLOCKED" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--report-only", "--render-profile", "preview"]), { code: "VALIDATION_ERROR" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--report-only", "--timeout-ms", "2"]), { code: "VALIDATION_ERROR" });
});

test("pilot run identity changes with audio/configuration and contains no operator path", () => {
  const first = pilotRunId({ fixtureHash: HASH, audioHash: "b".repeat(64), operatorId: "operator_1" });
  const second = pilotRunId({ fixtureHash: HASH, audioHash: "c".repeat(64), operatorId: "operator_1" });
  assert.notEqual(first, second); assert.match(first, /^pilot_[a-f0-9]{40}$/);
  assert.equal(pilotRunId({ fixtureHash: HASH, audioHash: "b".repeat(64), operatorId: "operator_1", animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN }), first);
});

test("pilot workflow rejects unknown animation profiles before any stage executes", async () => {
  let executed = false;
  await assert.rejects(
    runPilotWorkflow({
      fixturePath: FIXTURE,
      audioPath: null,
      rightsConfirmed: true,
      operatorId: "operator_1",
      outputDir: tmpdir(),
      renderProfile: "final",
      animationProfile: "semantic-v4",
      timeoutMs: 10000,
      reportOnly: false,
    }, {
      executeStage: async () => { executed = true; },
    }),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(executed, false);
});

test("pilot animation profile changes only render identity and matches exact QA evidence", () => {
  const project = {
    language: "en",
    input: {
      revision: 1,
      activeNarration: {
        manifestHash: "1".repeat(64),
        audioHash: "2".repeat(64),
        alignmentHash: "3".repeat(64),
      },
    },
  };
  const approval = { draftArtifactId: `art_${"4".repeat(40)}`, draftHash: "5".repeat(64) };
  const legacy = renderPayload(project, approval, "final");
  const sameLegacy = renderPayload(project, approval, "final", null, null);
  const semantic = renderPayload(project, approval, "final", null, SEMANTIC_SENTENCE_PROFILE_TOKEN);
  assert.deepEqual(sameLegacy, legacy);
  assert.equal(Object.hasOwn(legacy, "animationProfile"), false);
  assert.equal(semantic.animationProfile, SEMANTIC_SENTENCE_PROFILE_TOKEN);
  assert.notEqual(
    idempotencyKey("pilot_final", { runId: `pilot_${"6".repeat(40)}`, ...legacy }),
    idempotencyKey("pilot_final", { runId: `pilot_${"6".repeat(40)}`, ...semantic }),
  );
  assert.equal(normalizePilotAnimationProfile(undefined), null);
  assert.throws(() => normalizePilotAnimationProfile("semantic-v4"), { code: "VALIDATION_ERROR" });

  const semanticQa = { bindings: { animationStyleVersion: "3.0.0" } };
  const semanticIr = { content: { semantic: { profileId: SEMANTIC_SENTENCE_PROFILE_ID } } };
  const legacyQa = { bindings: { animationStyleVersion: "2.0.0" } };
  const legacyIr = { content: { semantic: { profileId: "documented_mystery_semantic_v2" } } };
  assert.equal(animationProfileMatchesEvidence(SEMANTIC_SENTENCE_PROFILE_TOKEN, semanticQa, semanticIr), true);
  assert.equal(animationProfileMatchesEvidence(null, semanticQa, semanticIr), false);
  assert.equal(animationProfileMatchesEvidence(null, legacyQa, legacyIr), true);
  assert.equal(animationProfileMatchesEvidence(SEMANTIC_SENTENCE_PROFILE_TOKEN, legacyQa, legacyIr), false);
  assert.equal(animationProfileMatchesEvidence(null, semanticQa, legacyIr), false);
});

test("pilot semantic completion binds QA, render manifest, active plan and exact scene artifact", () => {
  const verify = (value) => {
    try {
      return verifySemanticAnimationArtifactChain(value);
    } catch {
      return false;
    }
  };
  assert.equal(verify(semanticCompletionChainFixture(true)), true);

  const staleActive = semanticCompletionChainFixture(true);
  staleActive.project.input.activeAnimationScenePlan.planHash = "0".repeat(64);
  assert.equal(verify(staleActive), false);

  const staleConfiguration = semanticCompletionChainFixture(true);
  staleConfiguration.project.input.activeAnimationScenePlan.plannerConfigurationHash =
    "0".repeat(64);
  assert.equal(verify(staleConfiguration), false);

  const wrongManifestPlan = semanticCompletionChainFixture(true);
  wrongManifestPlan.manifestEnvelope.body.animationScenePlanHash = "0".repeat(64);
  assert.equal(verify(wrongManifestPlan), false);

  const wrongQaManifest = semanticCompletionChainFixture(true);
  wrongQaManifest.qaEnvelope.body.bindings.animationRenderManifestHash =
    "0".repeat(64);
  assert.equal(verify(wrongQaManifest), false);
});

test("pilot checked semantic completion forbids but does not require a scene-plan artifact", () => {
  const checked = semanticCompletionChainFixture(false);
  assert.equal(verifySemanticAnimationArtifactChain(checked), true);

  checked.manifestEnvelope.body.animationScenePlanArtifactId =
    "art_unexpected-scene-plan";
  checked.manifestEnvelope.body.animationScenePlanHash = "0".repeat(64);
  assert.equal(verifySemanticAnimationArtifactChain(checked), false);
});

test("pilot reuses only exact, fully verified aligned narration artifacts", () => {
  const fixture = alignedNarrationReuseFixture();
  const reused = verifiedAlignedNarrationReuse(fixture.input);
  assert.deepEqual(reused, {
    narrationManifest: { artifactId: fixture.activeNarration.manifestArtifactId, hash: fixture.activeNarration.manifestHash },
    narrationAudio: { artifactId: fixture.activeNarration.audioArtifactId, hash: fixture.activeNarration.audioHash },
    narrationAlignment: { artifactId: fixture.activeNarration.alignmentArtifactId, hash: fixture.activeNarration.alignmentHash },
  });
  assert.equal(Object.isFrozen(reused), true);
  assert.equal(Object.isFrozen(reused.narrationAlignment), true);

  for (const patch of [
    { projectRevision: 2 },
    { draftHash: "0".repeat(64) },
    { scriptHash: "0".repeat(64) },
    { audioHash: "0".repeat(64) },
  ]) {
    assert.equal(verifiedAlignedNarrationReuse({ ...fixture.input, ...patch }), null);
  }

  const unaligned = alignedNarrationReuseFixture();
  unaligned.input.project.input.activeNarration = { ...unaligned.activeNarration, status: "uploaded_unaligned", aligned: false, timingReady: false };
  assert.equal(verifiedAlignedNarrationReuse(unaligned.input), null);

  const staleManifest = alignedNarrationReuseFixture();
  staleManifest.envelopes.get(staleManifest.activeNarration.manifestArtifactId).contentHash = "0".repeat(64);
  assert.equal(verifiedAlignedNarrationReuse(staleManifest.input), null);

  const staleAlignment = alignedNarrationReuseFixture();
  staleAlignment.envelopes.get(staleAlignment.activeNarration.alignmentArtifactId).body = {
    ...staleAlignment.alignment,
    audioHash: "0".repeat(64),
  };
  assert.equal(verifiedAlignedNarrationReuse(staleAlignment.input), null);

  const staleAudio = alignedNarrationReuseFixture();
  staleAudio.input.artifactRepository = { get: () => ({ ...staleAudio.audio, checksumSha256: "0".repeat(64) }) };
  assert.equal(verifiedAlignedNarrationReuse(staleAudio.input), null);

  const staleAudioBytes = alignedNarrationReuseFixture();
  staleAudioBytes.input.artifactStore = { readArtifact: () => Buffer.from("tampered narration audio") };
  assert.equal(verifiedAlignedNarrationReuse(staleAudioBytes.input), null);
});

test("pilot release idempotency is bound to the exact profiled report", () => {
  const legacy = normalizePilotReport(report());
  const semantic = normalizePilotReport(report({ animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN }));
  const legacyKey = pilotReleaseIdempotencyKey(legacy);
  const semanticKey = pilotReleaseIdempotencyKey(semantic);
  assert.notEqual(legacyKey, semanticKey);
  assert.equal(legacyKey, `pilot-release-${legacy.runId}`);
  assert.match(semanticKey, /^pilot-release-pilot_[a-f0-9]{40}-[a-f0-9]{64}$/);
  assert.ok(semanticKey.length <= 160);
  assert.throws(() => pilotReleaseIdempotencyKey({ ...semantic, contentHash: "bad" }), { code: "PILOT_REPORT_INVALID" });
});

test("pilot orchestrator completes every stage, replays complete reports, and stops on failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pilot-orchestrator-"));
  const options = { fixturePath: FIXTURE, audioPath: null, rightsConfirmed: true, operatorId: "operator_1", outputDir: temp, renderProfile: "final", timeoutMs: 10000, reportOnly: false };
  const seen = [];
  const executeStage = async (stage) => {
    seen.push(stage);
    if (stage === "project_created") return { context: { projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1 } };
    if (stage === "draft_ready") return { evidence: { approvedDraft: artifact("2") } };
    if (stage === "narration_uploaded") return { evidence: { narrationManifest: artifact("3"), narrationAudio: artifact("4") } };
    if (stage === "narration_aligned") return { evidence: { narrationAlignment: artifact("5") } };
    if (stage === "preview_ready") return { evidence: { preview: job("6") } };
    if (stage === "technical_qa_passed") return { evidence: { qa: { report: artifact("8"), blockingGateCount: 1, blockingPassedCount: 1, blockingFailedCount: 0, warningCount: 0 } } };
    if (stage === "evidence_packaged") return { evidence: { contactSheet: artifact("9"), rightsManifest: artifact("a"), provenanceReport: artifact("b"), exportMetadata: artifact("c") } };
    if (stage === "technical_final_committed") return { evidence: { final: job("7") } };
    return {};
  };
  try {
    const progress = [];
    const deps = { pilotReadiness: () => READY, executeStage, persistPilotReport: (value) => value, readLatestPilotReport: () => null, onProgress: (event) => progress.push(event) };
    const result = await runPilotWorkflow(options, deps);
    assert.equal(result.report.status, "complete"); assert.deepEqual(seen, PILOT_STAGES.slice(1)); assert.equal(result.report.publishable, false);
    assert.equal(progress[0].event, "readiness_started");
    assert.deepEqual(progress.filter((event) => event.event === "stage_started").map((event) => event.stage), PILOT_STAGES.slice(1));
    assert.deepEqual(progress.filter((event) => event.event === "stage_completed").map((event) => event.stage), PILOT_STAGES.slice(1));
    const replay = await runPilotWorkflow(options, { ...deps, readLatestPilotReport: () => result.report, verifyCompletedReport: () => true, executeStage: async () => assert.fail("must not execute") });
    assert.equal(replay.replayed, true);
    seen.length = 0;
    const semanticOptions = { ...options, animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN };
    const semantic = await runPilotWorkflow(semanticOptions, { ...deps, readLatestPilotReport: () => result.report });
    assert.equal(semantic.replayed, false);
    assert.equal(semantic.report.runId, result.report.runId);
    assert.equal(semantic.report.projectId, result.report.projectId);
    assert.equal(semantic.report.animationProfile, SEMANTIC_SENTENCE_PROFILE_TOKEN);
    assert.deepEqual(seen, PILOT_STAGES.slice(1));
    const semanticReplay = await runPilotWorkflow(semanticOptions, { ...deps, readLatestPilotReport: () => semantic.report, verifyCompletedReport: () => true, executeStage: async () => assert.fail("must not execute") });
    assert.equal(semanticReplay.replayed, true);
    const failedSeen = [];
    const failed = await runPilotWorkflow(options, { ...deps, readLatestPilotReport: () => null, executeStage: async (stage) => { failedSeen.push(stage); if (stage === "narration_aligned") { const error = new Error("unsafe detail"); error.code = "NARRATION_ALIGNMENT_FAILED"; throw error; } return executeStage(stage); } });
    assert.equal(failed.report.status, "failed"); assert.equal(failed.report.failure.code, "NARRATION_ALIGNMENT_FAILED"); assert.equal(failedSeen.includes("preview_ready"), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("pilot CLI help is successful and unknown arguments fail with bounded output", () => {
  const cli = resolve(__dirname, "..", "demo", "run-dark-curiosity-pilot.mjs");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }); assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/);
  const invalid = spawnSync(process.execPath, [cli, "--bad"], { encoding: "utf8" }); assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /stack|\/Users|storageKey/i); assert.match(invalid.stderr, /VALIDATION_ERROR/);
});

test("pilot report-only CLI completes without loading the mutation runtime", () => {
  const cli = resolve(__dirname, "..", "demo", "run-dark-curiosity-pilot.mjs"); const output = join(tmpdir(), `pilot-report-only-${process.pid}`);
  try { const run = spawnSync(process.execPath, [cli, "--fixture", FIXTURE, "--output-dir", output, "--report-only"], { encoding: "utf8", timeout: 10000, env: { ...process.env, SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled" } }); assert.equal(run.status, 0); const body = JSON.parse(run.stdout); assert.equal(body.status, "report_only"); assert.equal(body.report.completedStages.at(-1), "fixture_validated"); assert.equal(body.report.projectId, null); assert.doesNotMatch(run.stdout, /storageKey|\/Users|\/private|releaseToken/i); }
  finally { rmSync(output, { recursive: true, force: true }); }
});

test("pilot report-only CLI records semantic-v3 selection without changing run identity", () => {
  const cli = resolve(__dirname, "..", "demo", "run-dark-curiosity-pilot.mjs");
  const legacyOutput = join(tmpdir(), `pilot-report-only-legacy-${process.pid}`);
  const semanticOutput = join(tmpdir(), `pilot-report-only-semantic-${process.pid}`);
  try {
    const legacy = spawnSync(process.execPath, [cli, "--fixture", FIXTURE, "--output-dir", legacyOutput, "--report-only"], { encoding: "utf8", timeout: 10000, env: { ...process.env, SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled" } });
    const semantic = spawnSync(process.execPath, [cli, "--fixture", FIXTURE, "--output-dir", semanticOutput, "--report-only", "--animation-profile", SEMANTIC_SENTENCE_PROFILE_TOKEN], { encoding: "utf8", timeout: 10000, env: { ...process.env, SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled" } });
    assert.equal(legacy.status, 0);
    assert.equal(semantic.status, 0);
    const legacyBody = JSON.parse(legacy.stdout);
    const semanticBody = JSON.parse(semantic.stdout);
    assert.equal(Object.hasOwn(legacyBody.report, "animationProfile"), false);
    assert.equal(semanticBody.report.animationProfile, SEMANTIC_SENTENCE_PROFILE_TOKEN);
    assert.equal(semanticBody.report.runId, legacyBody.report.runId);
  } finally {
    rmSync(legacyOutput, { recursive: true, force: true });
    rmSync(semanticOutput, { recursive: true, force: true });
  }
});
