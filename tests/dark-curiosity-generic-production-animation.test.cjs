"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");

const { contentHash, normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const {
  DEFAULT_MOTION_THRESHOLD,
  MOTION_ANALYSIS_PROFILE_ID,
  READABILITY_HOLD_POLICY_ID,
  SEGMENT_POLICY_ID,
  evaluateGeometryQuality,
  motionAnalysisConfigurationHash,
  motionAnalysisDimensions,
  motionAnalysisRangeHash,
} = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");
const { buildProductionTimingContext } = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const { compileProductionAnimation } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { buildProductionAnimationPayloadBindings } = require("../server/pipelines/narrated-short/animation/payload-bindings.cjs");
const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const { validateAnimationComprehensionPacing } = require("../server/pipelines/narrated-short/animation/comprehension-pacing.cjs");
const { browserQaExpectations, runProductionAnimationRender, safeSeekSequence } = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const { validateSemanticNarrative } = require("../server/pipelines/narrated-short/animation/semantic-narrative.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const art = (letter) => `art_${letter.repeat(40)}`;
const hash = (letter) => letter.repeat(64);

function mockMotionEvidence(request) {
  const dimensions = motionAnalysisDimensions(
    request.geometryAudit.semanticRoi,
    { width: request.width, height: request.height },
  );
  const readabilityHoldRangesHash = motionAnalysisRangeHash(
    READABILITY_HOLD_POLICY_ID,
    request.readabilityHolds,
  );
  const segmentRangesHash = motionAnalysisRangeHash(
    SEGMENT_POLICY_ID,
    request.segments,
  );
  return {
    motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
    readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
    segmentPolicyId: SEGMENT_POLICY_ID,
    analysisWidth: dimensions.width,
    analysisHeight: dimensions.height,
    motionThreshold: DEFAULT_MOTION_THRESHOLD,
    readabilityHoldRangesHash,
    segmentRangesHash,
    motionConfigurationHash: motionAnalysisConfigurationHash({
      motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
      readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
      segmentPolicyId: SEGMENT_POLICY_ID,
      analysisWidth: dimensions.width,
      analysisHeight: dimensions.height,
      motionThreshold: DEFAULT_MOTION_THRESHOLD,
      readabilityHoldRangesHash,
      segmentRangesHash,
    }),
  };
}

function rawStory(kind) {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (kind === "timestamp") {
    raw.brief.topic = "Why a receiver printed tomorrow's timestamp";
    raw.brief.thesis = "The date mismatch was recorded, but its cause was never verified.";
    raw.script.title = "Tomorrow's timestamp";
    raw.script.beats[0].spokenText = "In 1994, a desert receiver printed a message carrying tomorrow's date before midnight had passed.";
    raw.script.beats[0].onScreenText = "The message was dated tomorrow";
    raw.script.beats[1].spokenText = "The paper log showed today's receipt time beside a header dated exactly one day later.";
    raw.script.beats[1].onScreenText = "Receipt date versus header date";
    raw.script.beats[2].spokenText = "The station clock and the printed timestamp disagreed, while the original recorder showed no obvious interruption.";
    raw.script.beats[2].onScreenText = "Two dates, one recording";
    raw.script.beats[3].spokenText = "Later tests repeated the same window, but none produced another message from the following day.";
    raw.script.beats[3].onScreenText = "The mismatch never repeated";
    raw.script.beats[4].spokenText = "The timestamp remains unexplained, but one anomalous date is not evidence that information travelled backward.";
    raw.script.beats[4].onScreenText = "An anomaly is not proof";
    raw.storyboard.scenes[0].operations[0].text = "The message was dated tomorrow";
    raw.storyboard.scenes[1].operations[0].text = "RECEIVED MAY 12 • HEADER MAY 13";
    raw.storyboard.scenes[2].operations = [
      { op: "connect_nodes", fromId: "clock", toId: "timestamp", label: "recorded before its date", startFrame: 10, endFrame: 205 },
      { op: "show_evidence", claimId: "claim_beam-shape", text: "Clock and timestamp disagree", startFrame: 45, endFrame: 205 },
    ];
    raw.storyboard.scenes[3].operations = [
      { op: "advance_timeline", date: "MAY 12 → MAY 13", label: "DATE MISMATCH", startFrame: 0, endFrame: 175 },
      { op: "fade_or_blackout", mode: "blackout", startFrame: 135, endFrame: 175 },
    ];
    raw.storyboard.scenes[4].operations[0].text = "An anomaly is not proof";
    raw.storyboard.scenes[4].operations[1].text = "Clock source unresolved";
  } else if (kind === "harbor") {
    raw.brief.topic = "Why the silent harbor route remains unexplained";
    raw.brief.thesis = "The route was logged, but it did not identify a vessel.";
    raw.script.title = "The silent harbor route";
    raw.script.beats[0].spokenText = "In 2003, a dark lighthouse logged one moving return across a harbor that officials believed was empty.";
    raw.script.beats[0].onScreenText = "A return crossed the silent harbor";
    raw.script.beats[1].spokenText = "The receiver log placed it beyond the breakwater after the lighthouse beacon had already gone dark.";
    raw.script.beats[1].onScreenText = "A route beyond the breakwater";
    raw.script.beats[2].spokenText = "Three recorded points formed a smooth route from the lighthouse toward open water without a registered vessel.";
    raw.script.beats[2].onScreenText = "Lighthouse, route, open water";
    raw.script.beats[3].spokenText = "Search crews traced the same path the next morning and found no ship, debris, or repeated beacon.";
    raw.script.beats[3].onScreenText = "No vessel repeated the route";
    raw.script.beats[4].spokenText = "The harbor log preserves an unresolved route, not proof of a ghost ship or hidden craft.";
    raw.script.beats[4].onScreenText = "A route is not an identity";
    raw.storyboard.scenes[0].operations[0].text = "A return crossed the silent harbor";
    raw.storyboard.scenes[1].operations[0].text = "HARBOR RECEIVER LOG";
    raw.storyboard.scenes[2].operations = [
      { op: "connect_nodes", fromId: "lighthouse", toId: "vessel", label: "beacon to open water", startFrame: 10, endFrame: 205 },
      { op: "show_evidence", claimId: "claim_beam-shape", text: "No registered vessel", startFrame: 45, endFrame: 205 },
    ];
    raw.storyboard.scenes[3].operations = [
      { op: "draw_route", points: [[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]], label: "SILENT HARBOR ROUTE", startFrame: 0, endFrame: 175 },
      { op: "fade_or_blackout", mode: "blackout", startFrame: 135, endFrame: 175 },
    ];
    raw.storyboard.scenes[4].operations[0].text = "A route is not an identity";
    raw.storyboard.scenes[4].operations[1].text = "Vessel identity unresolved";
  } else if (kind === "wow_paraphrase") {
    raw.script.beats[0].spokenText = "In 1977, an astronomer noted one unusual signal and marked the paper record by hand.";
    raw.script.beats[0].onScreenText = "One unusual observation";
    raw.script.beats[1].spokenText = "It sat near a frequency linked to interstellar research and remained visible for about a minute.";
    raw.script.beats[1].onScreenText = "A narrow frequency window";
    raw.script.beats[2].spokenText = "As the telescope swept past, its strength climbed and faded in a narrow pattern.";
    raw.script.beats[2].onScreenText = "A beam-shaped rise and fall";
    raw.script.beats[3].spokenText = "Later searches found no second event with the same pattern or a confirmed source.";
    raw.script.beats[3].onScreenText = "The observation never repeated";
    raw.script.beats[4].spokenText = "The case remains unexplained, but one unrepeated event cannot establish an extraterrestrial origin.";
    raw.script.beats[4].onScreenText = "Unexplained is not confirmed";
  } else {
    throw new TypeError("Unsupported generic production fixture.");
  }
  return raw;
}

function productionFixture(kind, renderProfile = "preview", transformRaw = null) {
  const raw = rawStory(kind);
  if (transformRaw) transformRaw(raw);
  const draft = normalizeDraftBundle(raw);
  const projectId = `prj_${randomUUID()}`;
  let cursor = 0.08;
  const words = scriptWords(draft.script).map((word) => {
    const start = cursor;
    const end = start + 0.29;
    cursor += 0.39;
    return { word: word.text, start, end, probability: 0.99 };
  });
  const narration = {
    media: { durationSeconds: Number((cursor + 1.4).toFixed(3)) },
    language: "en",
    voiceProfileId: "voice",
    rights: { commercialUseAllowed: true, consentReference: "consent" },
    draftArtifactId: art("a"),
    draftHash: draft.contentHash,
    scriptHash: draft.script.contentHash,
    audioArtifactId: art("d"),
    audioHash: hash("d"),
  };
  const alignment = createAlignment({
    project: { id: projectId, input: { revision: 1 } },
    draft,
    narration,
    narrationSummary: { manifestArtifactId: art("c"), manifestHash: hash("c") },
    providerResult: { segments: [{ words }] },
    provider: { model: "fixture", device: "cpu", computeType: "int8" },
  });
  const timingContext = buildProductionTimingContext({
    draft,
    alignment,
    projectId,
    projectRevision: 1,
    draftArtifactId: art("a"),
    draftHash: draft.contentHash,
    alignmentHash: alignment.contentHash,
  });
  return {
    draft,
    projectId,
    alignment,
    compiled: compileProductionAnimation({
      draft,
      timingContext,
      projectId,
      projectRevision: 1,
      renderProfile,
    }),
  };
}

test("timestamp production path renders clock and date archetypes without telescope visuals", async () => {
  const { compiled } = productionFixture("timestamp");
  const ir = compiled.animationIR;
  assert.equal(ir.schemaVersion, 2);
  assert.equal(ir.profileVersion, "1.2.0");
  assert.equal(ir.content.semantic.profileId, "documented_mystery_semantic_v2");
  assert.equal(ir.content.visualPlan.storyVocabulary, "temporal_anomaly");
  assert.deepEqual(
    ir.scenes.map((scene) => scene.template),
    ["document_record_v2", "evidence_card_v2", "relationship_graph_v2", "timeline_compare_v2", "bounded_verdict_v2"],
  );
  assert.equal(validateSemanticNarrative(ir).mode, "semantic_v2");
  assert.equal(validateAnimationComprehensionPacing(ir).applicable, true);
  const seekSequence = safeSeekSequence(ir);
  const browserPolicy = browserQaExpectations(ir, seekSequence);
  assert.deepEqual(browserPolicy.pathFollowerIds, ["story-evidence-marker"]);
  assert.deepEqual(browserPolicy.persistentEntityIds, ["story_evidence"]);
  assert.deepEqual(browserPolicy.visualStateIds, ir.content.visualPlan.scenes.map((scene) => scene.id));
  assert.deepEqual(browserPolicy.focusIntervalIds, []);

  const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const first = compileAnimationIRToHtml(ir);
  const second = compileAnimationIRToHtml(ir);
  assert.equal(first.compositionHash, second.compositionHash);
  assert.match(first.html, /data-motif-kind="clock_date"/);
  assert.match(first.html, /data-entity-kind="clock"/);
  assert.match(first.html, /data-source-operation-indexes="0,1"/);
  assert.doesNotMatch(first.html, /telescope/i);
  assert.doesNotMatch(first.html, /https?:\/\//i);
});

test("harbor production path renders a lighthouse, vessel, and D3 route without telescope visuals", async () => {
  const { compiled } = productionFixture("harbor");
  const ir = compiled.animationIR;
  assert.equal(ir.content.visualPlan.storyVocabulary, "maritime_route");
  assert.ok(ir.scenes.some((scene) => scene.template === "map_route_v2"));
  const routePlan = ir.content.visualPlan.scenes.find((scene) => scene.archetypeId === "map_route_v2");
  assert.deepEqual(routePlan.geometry.points, [[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]]);

  const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const html = compileAnimationIRToHtml(ir).html;
  assert.match(html, /data-motif-kind="harbor_route"/);
  assert.match(html, /class="lighthouse/);
  assert.match(html, /class="vessel/);
  assert.match(html, /data-archetype-id="map_route_v2"/);
  assert.doesNotMatch(html, /telescope/i);
});

test("generic semantic renderer accepts the final 1080x1920 production profile", async () => {
  const { compiled } = productionFixture("harbor", "final");
  const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const html = compileAnimationIRToHtml(compiled.animationIR).html;
  assert.equal(compiled.animationIR.width, 1080);
  assert.equal(compiled.animationIR.height, 1920);
  assert.match(html, /data-width="1080" data-height="1920"/);
});

test("a non-Wow astronomy story falls back to the generic compiler instead of failing in the legacy grammar", () => {
  const { compiled } = productionFixture("timestamp", "preview", (raw) => {
    raw.script.beats[0].spokenText = "An astronomer recorded one signal beside a timestamp that appeared to be dated tomorrow.";
    raw.script.beats[1].spokenText = "An interstellar explanation was proposed, although the paper log only established a date mismatch.";
    raw.script.beats[2].spokenText = "The telescope record and timestamp disagreed, without the words required by the historic Wow case.";
    raw.storyboard.scenes[2].operations[0] = {
      op: "connect_nodes",
      fromId: "telescope",
      toId: "signal",
      label: "recorded before its date",
      startFrame: 10,
      endFrame: 205,
    };
  });
  assert.equal(compiled.animationIR.schemaVersion, 2);
  assert.equal(compiled.animationIR.content.semantic.profileId, "documented_mystery_semantic_v2");
  assert.equal(compiled.animationIR.content.visualPlan.storyVocabulary, "temporal_anomaly");
});

test("a paraphrased Wow Signal draft uses the generic compiler when the brittle legacy cue grammar does not fit", () => {
  const { compiled } = productionFixture("wow_paraphrase");
  assert.equal(compiled.animationIR.schemaVersion, 2);
  assert.equal(compiled.animationIR.renderer.styleVersion, "2.0.0");
  assert.equal(compiled.animationIR.content.semantic.profileId, "documented_mystery_semantic_v2");
  assert.equal(compiled.animationIR.content.visualPlan.storyVocabulary, "radio_signal");
});

test("generic job payload provenance carries the AnimationIR 2.0.0 style version", () => {
  const value = productionFixture("timestamp");
  const draftArtifactId = art("a");
  const alignmentArtifactId = "art_generic-alignment-binding";
  const bindings = buildProductionAnimationPayloadBindings({
    project: {
      id: value.projectId,
      input: {
        revision: 1,
        activeNarration: {
          alignmentArtifactId,
          alignmentHash: value.alignment.contentHash,
        },
      },
    },
    approval: {
      draftArtifactId,
      draftHash: value.draft.contentHash,
    },
    renderProfile: "preview",
    contentArtifacts: {
      readJson(artifactId) {
        if (artifactId === draftArtifactId) return { body: value.draft };
        if (artifactId === alignmentArtifactId) return { body: value.alignment };
        throw new TypeError("Unknown test artifact.");
      },
    },
  });
  assert.equal(bindings.animationStyleVersion, "2.0.0");
  assert.equal(bindings.animationIRHash, value.compiled.animationIR.contentHash);
});

test("AnimationIR v2 rejects a visual plan rebound to another draft, timing context, or vocabulary", () => {
  const { compiled } = productionFixture("timestamp");
  const expectBindingFailure = (mutate) => {
    const rebound = structuredClone(compiled.animationIR);
    mutate(rebound);
    delete rebound.contentHash;
    assert.throws(() => validateAnimationIR(rebound), { code: "ANIMATION_IR_INVALID" });
  };
  expectBindingFailure((ir) => { ir.content.visualPlan.draftHash = "f".repeat(64); });
  expectBindingFailure((ir) => { ir.content.visualPlan.timingContextHash = "e".repeat(64); });
  expectBindingFailure((ir) => { ir.content.semantic.storyVocabulary = "general_mystery"; });
});

test("generic production render accepts transitionless browser and motion proof while preserving semantic continuity", async () => {
  const value = productionFixture("harbor");
  const stagingDir = mkdtempSync(resolve(tmpdir(), "generic-production-animation-"));
  const contentArtifactRepository = {
    createJson(input) {
      const bodyHash = contentHash(input.body);
      return {
        artifact: { id: `art_${bodyHash.slice(0, 40)}` },
        envelope: { contentHash: bodyHash },
      };
    },
  };
  const provider = {
    id: "hyperframes_local",
    doctor: async () => ({ ready: true, runtimeVersion: "0.7.55" }),
    validate: (animationIR) => ({ animationIR, budget: { computedCost: 42 } }),
    estimate: ({ animationIR }) => ({
      frames: animationIR.durationFrames,
      durationSeconds: animationIR.durationFrames / animationIR.fps,
      complexityCost: 42,
      estimatedMemoryMb: 300,
      expectedDurationSeconds: 20,
    }),
    render: async ({ validated, stagingDir: rendererDir }) => {
      const outputPath = resolve(rendererDir, "visual-master.mp4");
      writeFileSync(outputPath, "generic-continuous-video");
      const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
      return {
        outputPath,
        outputSha256: contentHash("generic-continuous-video"),
        animationIRHash: validated.animationIR.contentHash,
        compositionHash: compileAnimationIRToHtml(validated.animationIR).compositionHash,
      };
    },
    verify: (manifest) => ({
      valid: true,
      outputSha256: manifest.outputSha256,
      animationIRHash: manifest.animationIRHash,
    }),
  };
  let benchmarkRequest;
  let browserRequest;
  const alignmentArtifactId = art("d");
  try {
    const result = await runProductionAnimationRender({
      draft: value.draft,
      alignment: value.alignment,
      projectId: value.projectId,
      projectRevision: 1,
      jobId: `job_${randomUUID()}`,
      draftArtifactId: art("a"),
      draftHash: value.draft.contentHash,
      alignmentArtifactId,
      alignmentHash: value.alignment.contentHash,
      renderProfile: "preview",
      stagingDir,
      contentArtifactRepository,
    }, {
      providerRegistry: { get: () => provider },
      chromePath: "/mock/chrome",
      runBrowserSeekProof: async (request) => {
        browserRequest = request;
        return {
          seekSequence: request.seekSequence,
          cacheWarmupFrames: request.cacheWarmupFrames,
          captures: request.seekSequence.map((frame, sequenceIndex) => ({ sequenceIndex, frame, sha256: hash("b") })),
          repeatedFrames: [{ frame: 0, occurrences: 2, sha256: hash("b"), equal: true }],
          loadedOnce: true,
          pageLoadCount: 1,
          stateIsolation: { valid: true },
          externalRequestCount: 0,
          blockedExternalRequestCount: 0,
          resourceClasses: [],
          geometryAudit: {
            passed: true,
            semanticRoi: request.expectedSemanticRoi,
            captionSafeZone: request.expectedCaptionSafeZone,
            checkpointCount: request.seekSequence.length,
            entityObservationCount: 20,
            pathFollowerObservationCount: 8,
            semanticRouteObservationCount: request.expectedSemanticRouteIds.length,
            observedSemanticRouteIds: request.expectedSemanticRouteIds,
            unobservedSemanticRouteIds: [],
            persistentObservationCount: 20,
            labelObservationCount: request.expectedLabelIds.length,
            markedLabelIds: request.expectedLabelIds,
            observedLabelIds: request.expectedLabelIds,
            unobservedLabelIds: [],
            observedPathFollowerIds: request.expectedPathFollowerIds,
            unobservedPathFollowerIds: [],
            persistentStateCoverage: Object.fromEntries(request.expectedPersistentEntityIds.map((id) => [id, request.expectedVisualStateIds])),
            observedTransitionIds: [],
            observedFocusIntervalIds: [],
            unobservedFocusIntervalIds: [],
            clippedEntities: [],
            captionSafeZoneViolations: [],
            pathFollowerViolations: [],
            semanticRouteViolations: [],
            boundedGeometryClippingViolations: [],
            boundedGeometryCaptionSafeZoneViolations: [],
            persistentContinuityViolations: [],
            focusViolations: [],
            primaryRoiViolations: [],
            legibilityViolations: [],
            contrastViolations: [],
          },
          passed: true,
        };
      },
      runBenchmarkQa: (request) => {
        benchmarkRequest = request;
        const geometryChecks = evaluateGeometryQuality(request.geometryAudit, request.semanticGeometryRequirements);
        return {
          passed: Object.values(geometryChecks).every(Boolean),
          checks: geometryChecks,
          technical: {
            codec: "h264",
            pixelFormat: "yuv420p",
            width: request.width,
            height: request.height,
            fps: request.expectedFps,
            frameCount: request.expectedFrameCount,
            durationSeconds: request.expectedFrameCount / request.expectedFps,
          },
          motion: {
            temporalMetricProfileId:
              "dark_curiosity_luma_temporal_motion_v1",
            temporalThresholdStatus: "provisional",
            ...mockMotionEvidence(request),
            decodedFrameSequenceHash: hash("e"),
            firstMeaningfulMotionFrame: 1,
            consecutiveStasisRatio: 0.1,
            maxContiguousStasisFrames: 10,
            maxWindowMotionShare: 0.3,
            rawMaxWindowMotionShare: 0.35,
            sampleHashes: [hash("c")],
          },
          clippedEntities: 0,
          captionSafeZoneViolations: 0,
        };
      },
    });

    assert.equal(result.qa.status, "passed");
    assert.equal(result.qa.alignmentArtifactId, alignmentArtifactId);
    assert.equal(result.qa.renderProfile, "preview");
    assert.equal(result.qa.renderQuality, "standard");
    assert.equal(result.qa.motion.motion.analysisWidth, 180);
    assert.equal(result.qa.motion.motion.analysisHeight, 208);
    assert.equal(result.manifest.alignmentArtifactId, alignmentArtifactId);
    assert.equal(result.manifest.renderProfile, "preview");
    assert.equal(result.manifest.renderQuality, "standard");
    assert.deepEqual(browserRequest.expectedTransitionIds, []);
    assert.deepEqual(browserRequest.expectedFocusIntervalIds, []);
    assert.deepEqual(benchmarkRequest.semanticGeometryRequirements, {
      persistentContinuity: true,
      transitionContinuity: false,
      focusExclusivity: false,
      primaryRoi: true,
      mobileLegibility: true,
    });
    assert.deepEqual(
      benchmarkRequest.segments,
      result.animationIR.scenes.map((scene) => ({
        id: scene.id,
        startFrame: scene.startFrame,
        endFrame: scene.endFrame,
      })),
    );
    assert.equal(result.qa.motion.checks.persistentContinuity, true);
    assert.equal(result.qa.motion.checks.focusExclusivity, true);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});
