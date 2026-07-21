"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");

const {
  contentHash,
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  normalizeAlignment,
} = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const {
  buildProductionTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  MOTION_ANALYSIS_PROFILE_ID,
  READABILITY_HOLD_POLICY_ID,
  SEGMENT_POLICY_ID,
  motionAnalysisConfigurationHash,
  motionAnalysisDimensions,
  motionAnalysisRangeHash,
} = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");
const {
  browserQaExpectations,
  motionSegments,
  runProductionAnimationRender,
  safeSeekSequence,
} = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const {
  MOTION_TEMPORAL_METRIC_PROFILE_ID,
} = require("../server/pipelines/narrated-short/animation/motion-integrity-qa.cjs");
const {
  ContentArtifactRepository,
} = require("../server/repositories/content-artifact-repository.cjs");
const {
  InMemoryArtifactRepository,
} = require("../server/repositories/artifact-repository.cjs");
const {
  MOTION_CALIBRATION_CORPUS_PROFILE_ID,
  MOTION_CALIBRATION_THRESHOLD_MODE,
  MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
  MOTION_CALIBRATION_REVIEW_PROFILE_ID,
  MOTION_CALIBRATION_BLOCKERS,
  motionCalibrationCaseFromArtifacts,
  buildMotionCalibrationCorpusReport,
  validateMotionCalibrationCorpusReport,
} = require("../server/pipelines/narrated-short/animation/motion-calibration-corpus.cjs");

const FIXTURE = resolve(
  __dirname,
  "..",
  "eval",
  "narrated",
  "dark-curiosity",
  "fixtures",
  "001_wow_signal_mystery.json",
);
const ROUTE_FIXTURE = resolve(
  __dirname,
  "..",
  "eval",
  "narrated",
  "dark-curiosity",
  "fixtures",
  "003_baychimo_icebound_drift.json",
);

const FIXED_TIME = "2026-07-21T12:00:00.000Z";

function sha(value) {
  return contentHash({ value });
}

function canonicalArtifactId(value) {
  return `art_${sha(value).slice(0, 40)}`;
}

function resourceId(prefix, index) {
  return `${prefix}_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function churnId(value, index) {
  const separator = value.indexOf("_");
  const prefix = value.slice(0, separator);
  const suffix = value.slice(separator + 1).replace(/[^A-Za-z0-9-]/g, "-");
  return `${prefix}_${suffix}-variant-${index}`;
}

function rewriteSemanticWords(value, index, seed) {
  let markerIndex = 0;
  return value.split(/\s+/).map((word, wordIndex) => {
    if (wordIndex % 3 !== 1) return word;
    const marker = `case${index}token${seed}${markerIndex}`;
    markerIndex += 1;
    return marker;
  }).join(" ");
}

class MemoryArtifactStore {
  constructor() {
    this.buffers = new Map();
  }

  writeBuffer(input) {
    const buffer = Buffer.from(input.buffer);
    this.buffers.set(input.id, buffer);
    return {
      id: input.id,
      type: input.type,
      ownerProjectId: input.ownerProjectId,
      ownerJobId: input.ownerJobId || null,
      storageKey: input.storageKey,
      size: buffer.byteLength,
      contentType: input.contentType,
      checksumSha256: input.checksumSha256,
      source: null,
      status: "available",
      storageAdapterMode: "local",
      path: null,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
  }

  readArtifact(record, options = {}) {
    const value = this.buffers.get(record.id);
    if (!value) throw new Error("missing");
    if (value.byteLength > Number(options.maxBytes || Number.MAX_SAFE_INTEGER)) {
      throw new Error("too_large");
    }
    return Buffer.from(value);
  }
}

function repository() {
  const store = new MemoryArtifactStore();
  const artifacts = new InMemoryArtifactRepository({ persist: false });
  const content = new ContentArtifactRepository({
    artifactStore: store,
    artifactRepository: artifacts,
    clock: () => FIXED_TIME,
  });
  return { content, store, artifacts };
}

function persist(content, type, body, dependencyHashes, projectId, jobId) {
  return content.createJson({
    type,
    body,
    dependencyHashes,
    projectId,
    jobId,
    revision: 1,
  });
}

function draftFor(index, options = {}) {
  const raw = JSON.parse(readFileSync(options.fixture || FIXTURE, "utf8"));
  raw.brief.topic = `${raw.brief.topic} metadata revision ${index}`;
  raw.brief.thesis = `${raw.brief.thesis} Metadata revision ${index}.`;
  raw.script.title = `${raw.script.title} revision ${index}`;
  if (options.identityChurn === true) {
    const sourceIds = new Map(raw.claimLedger.sources.map((source) => {
      const changed = churnId(source.id, index);
      source.snapshotHash = sha(`declared-source-variant-${index}-${source.id}`);
      const original = source.id;
      source.id = changed;
      return [original, changed];
    }));
    raw.brief.sourceRefs = raw.brief.sourceRefs.map((sourceId) => sourceIds.get(sourceId));
    for (const claim of raw.claimLedger.claims) {
      for (const link of claim.sourceLinks) link.sourceId = sourceIds.get(link.sourceId);
    }
    const claimIds = new Map(raw.claimLedger.claims.map((claim) => {
      const changed = churnId(claim.id, index);
      const original = claim.id;
      claim.id = changed;
      return [original, changed];
    }));
    const beatIds = new Map(raw.script.beats.map((beat) => {
      beat.claimIds = beat.claimIds.map((claimId) => claimIds.get(claimId));
      const changed = churnId(beat.id, index);
      const original = beat.id;
      beat.id = changed;
      return [original, changed];
    }));
    for (const scene of raw.storyboard.scenes) {
      scene.id = churnId(scene.id, index);
      scene.beatIds = scene.beatIds.map((beatId) => beatIds.get(beatId));
      for (const operation of scene.operations) {
        if (operation.claimId) operation.claimId = claimIds.get(operation.claimId);
        if (operation.sourceId) operation.sourceId = sourceIds.get(operation.sourceId);
      }
      const textOperation = scene.operations.find((operation) => (
        Object.prototype.hasOwnProperty.call(operation, "text")
      ));
      if (textOperation) textOperation.text = `Visual-only revision ${index}`;
    }
  } else if (options.nearDuplicate === true) {
    for (const source of raw.claimLedger.sources) {
      source.snapshotHash = sha(`near-duplicate-source-${index}-${source.id}`);
      source.url = `https://near-duplicate-${index}.example/${source.id}`;
      source.publisher = `Near duplicate archive ${index} ${source.id}`;
      source.independenceGroup = `near_duplicate_${index}_${source.id}`;
    }
    raw.claimLedger.claims[0].text = `${raw.claimLedger.claims[0].text} Revision ${index}.`;
    raw.script.beats[0].spokenText = `${raw.script.beats[0].spokenText} Revision ${index}.`;
  } else if (options.metadataOnly !== true) {
    for (const source of raw.claimLedger.sources) {
      source.snapshotHash = sha(`source-snapshot-${index}-${source.id}`);
      source.url = `https://evidence-${index}.example/${source.id}`;
      source.publisher = `Independent archive ${index} ${source.id}`;
      source.independenceGroup = `archive_${index}_${source.id}`;
    }
    raw.claimLedger.claims.forEach((claim, claimIndex) => {
      claim.text = rewriteSemanticWords(claim.text, index, `claim${claimIndex}`);
    });
    raw.script.beats.forEach((beat, beatIndex) => {
      beat.spokenText = rewriteSemanticWords(beat.spokenText, index, `beat${beatIndex}`);
    });
    raw.script.beats[0].onScreenText = `Independent record ${index}`;
    raw.storyboard.scenes[0].operations[0].text = `Independent record ${index}`;
  }
  return normalizeDraftBundle(raw);
}

function alignmentFor(draft, draftArtifactId, projectId, index) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const text of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text,
        startFrame: frame,
        endFrame: frame + 6,
        confidence: 0.99,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  const durationFrames = frame + 30;
  return normalizeAlignment({
    schemaVersion: 1,
    status: "aligned",
    projectId,
    projectRevision: 1,
    verticalId: "dark_curiosity",
    draftArtifactId,
    draftHash: draft.contentHash,
    scriptHash: draft.script.contentHash,
    narrationManifestArtifactId: canonicalArtifactId(`narration-manifest-${index}`),
    narrationManifestHash: sha(`narration-manifest-${index}`),
    audioArtifactId: canonicalArtifactId(`narration-audio-${index}`),
    audioHash: sha(`narration-audio-${index}`),
    language: "en",
    fps: 30,
    durationFrames,
    words,
    beats,
    coverage: {
      expectedWords: words.length,
      alignedWords: words.length,
      exactSequenceMatch: true,
      coverageRatio: 1,
    },
    provider: {
      mode: "local_faster_whisper",
      model: "small.en",
      device: "cpu",
      computeType: "int8",
      promptVersion: "narration_alignment_v1",
    },
  });
}

async function browserProof(ir, index, semanticSourceContext) {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const composition = compileAnimationIRToHtml(ir, { semanticSourceContext });
  const actionQa = composition.actionQa || null;
  const seekSequence = safeSeekSequence(ir, actionQa);
  const expectations = browserQaExpectations(
    ir,
    seekSequence,
    actionQa,
    composition.qaPolicy,
  );
  const frameHashes = new Map(
    [...new Set(seekSequence)].map((frame) => [
      frame,
      sha(`browser-frame-${index}-${frame}`),
    ]),
  );
  const repeatedFrames = [...frameHashes.keys()]
    .filter((frame) => seekSequence.filter((value) => value === frame).length > 1)
    .sort((left, right) => left - right)
    .map((frame) => ({
      frame,
      occurrences: seekSequence.filter((value) => value === frame).length,
      sha256: frameHashes.get(frame),
      equal: true,
    }));
  const expectedPathFollowerIds = [...expectations.pathFollowerIds].sort();
  const expectedPersistentEntityIds = [...expectations.persistentEntityIds].sort();
  const expectedVisualStateIds = [...expectations.visualStateIds].sort();
  const expectedBoundedGeometrySentenceIndices = [
    ...(expectations.boundedGeometrySentenceIndices || []),
  ].sort((left, right) => left - right);
  const browser = {
    seekSequence,
    cacheWarmupFrames: expectations.cacheWarmupFrames,
    captures: seekSequence.map((frame, sequenceIndex) => ({
      sequenceIndex,
      frame,
      sha256: frameHashes.get(frame),
    })),
    repeatedFrames,
    loadedOnce: true,
    pageLoadCount: 1,
    stateIsolation: {
      valid: true,
      wallClockIndependent: true,
      seededRandomOnly: true,
      autoplayFree: true,
      frameAccumulationFree: true,
    },
    externalRequestCount: 0,
    blockedExternalRequestCount: 0,
    resourceClasses: [],
    geometryAudit: {
      passed: true,
      semanticRoi: expectations.semanticRoi,
      captionSafeZone: expectations.captionSafeZone,
      checkpointCount: seekSequence.length,
      entityObservationCount: 20,
      pathFollowerObservationCount: expectedPathFollowerIds.length,
      semanticRouteObservationCount: expectations.semanticRouteIds.length,
      observedSemanticRouteIds: expectations.semanticRouteIds,
      unobservedSemanticRouteCount: 0,
      semanticRouteViolationCount: 0,
      boundedGeometryObservationCount: expectedBoundedGeometrySentenceIndices.length,
      observedBoundedGeometrySentenceIndices:
        expectedBoundedGeometrySentenceIndices,
      unobservedBoundedGeometrySentenceCount: 0,
      boundedGeometryClippingViolationCount: 0,
      boundedGeometryCaptionSafeZoneViolationCount: 0,
      persistentObservationCount: expectedPersistentEntityIds.length,
      labelObservationCount: expectations.labelIds.length,
      markedLabelIds: expectations.labelIds,
      observedLabelIds: expectations.labelIds,
      unobservedLabelCount: 0,
      observedPathFollowerIds: expectedPathFollowerIds,
      unobservedPathFollowerCount: 0,
      persistentStateCoverage: Object.fromEntries(
        expectedPersistentEntityIds.map((entityId) => [
          entityId,
          expectedVisualStateIds,
        ]),
      ),
      observedTransitionIds: [...expectations.transitionIds].sort(),
      observedFocusIntervalIds: [...expectations.focusIntervalIds].sort(),
      unobservedFocusIntervalCount: 0,
      observedActionSignatures: [...(expectations.actionSignatures || [])].sort(),
      unobservedActionSignatureCount: 0,
      actionCoverageViolationCount: 0,
      clippedEntityCount: 0,
      captionSafeZoneViolationCount: 0,
      pathFollowerViolationCount: 0,
      persistentContinuityViolationCount: 0,
      focusViolationCount: 0,
      primaryRoiViolationCount: 0,
      legibilityViolationCount: 0,
      contrastViolationCount: 0,
    },
    passed: true,
  };
  return { browser, compositionHash: composition.compositionHash };
}

function rangeCounts(frameCount, ranges, firstFrame) {
  let held = 0;
  for (let frame = firstFrame; frame < frameCount; frame += 1) {
    if (ranges.some((range) => frame >= range.startFrame && frame < range.endFrame)) held += 1;
  }
  return frameCount - firstFrame - held;
}

function motionProof(ir, browser, index, options = {}) {
  const localIndex = index % 10;
  const failing = options.failing ?? (index % 10 < 2);
  const defaultJerkP99 = failing
    ? 0.22 + localIndex * 0.001
    : 0.02 + localIndex * 0.001;
  const jerkEnergyP99 = options.jerkEnergyP99 ?? defaultJerkP99;
  const peakJerkEnergy = options.peakJerkEnergy
    ?? Math.max(
      jerkEnergyP99,
      failing
        ? 0.34 + localIndex * 0.001
        : 0.05 + localIndex * 0.002,
    );
  const boundaryJump = options.boundaryJump
    ?? (failing ? 18 + localIndex : 1.4 + localIndex * 0.1);
  const segments = motionSegments(ir);
  const holds = ir.scenes.flatMap((scene) => scene.readabilityHolds.map((hold, holdIndex) => ({
    id: `${scene.id}_hold_${holdIndex}`,
    startFrame: hold.startFrame,
    endFrame: hold.endFrame,
  })));
  const analysis = motionAnalysisDimensions(browser.geometryAudit.semanticRoi, {
    width: ir.width,
    height: ir.height,
  });
  const readabilityHoldRangesHash = motionAnalysisRangeHash(READABILITY_HOLD_POLICY_ID, holds);
  const segmentRangesHash = motionAnalysisRangeHash(SEGMENT_POLICY_ID, segments);
  const motionThreshold = 0.0002;
  const motionConfigurationHash = motionAnalysisConfigurationHash({
    motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
    readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
    segmentPolicyId: SEGMENT_POLICY_ID,
    analysisWidth: analysis.width,
    analysisHeight: analysis.height,
    motionThreshold,
    readabilityHoldRangesHash,
    segmentRangesHash,
  });
  const segmentMetrics = segments.map((segment) => ({
    id: segment.id,
    startFrame: segment.startFrame,
    endFrame: segment.endFrame,
    transitionCount: Math.max(0, segment.endFrame - segment.startFrame - 1),
    totalMotionEnergy: 0.2,
    meanMotionEnergy: 0.01,
    stasisRatio: 0.05,
    meanAccelerationEnergy: 0.01,
    accelerationEnergyP99: 0.04,
    meanJerkEnergy: 0.01,
    jerkEnergyP99: Math.min(jerkEnergyP99, 0.03),
    peakJerkEnergy: Math.max(Math.min(peakJerkEnergy, 0.08), Math.min(jerkEnergyP99, 0.03)),
  }));
  const boundaryMetrics = segments.slice(1).map((segment, boundaryIndex) => {
    const jumpRatio = boundaryIndex === 0 ? boundaryJump : Math.min(boundaryJump, 1 + boundaryIndex * 0.1);
    const localBaseline = 0.001;
    return {
      frame: segment.startFrame,
      motionEnergy: jumpRatio * Math.max(motionThreshold, localBaseline),
      accelerationEnergy: 0.01,
      jerkEnergy: 0.01,
      localBaseline,
      jumpRatio,
    };
  });
  const frameCount = ir.durationFrames;
  const excludedReadabilityHoldTransitions = frameCount - 1 - rangeCounts(frameCount, holds, 1);
  const rawMotion = {
    temporalMetricProfileId: MOTION_TEMPORAL_METRIC_PROFILE_ID,
    temporalThresholdStatus: "provisional",
    motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
    readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
    segmentPolicyId: SEGMENT_POLICY_ID,
    analysisWidth: analysis.width,
    analysisHeight: analysis.height,
    readabilityHoldRangesHash,
    segmentRangesHash,
    motionConfigurationHash,
    decodedFrameSequenceHash: sha(`decoded-frames-${index}`),
    frameCount,
    transitionCount: frameCount - 1,
    analyzedTransitionCount: frameCount - 1 - excludedReadabilityHoldTransitions,
    excludedReadabilityHoldTransitions,
    semanticPixelCount: analysis.width * analysis.height,
    motionThreshold,
    firstMeaningfulMotionFrame: 1,
    consecutiveStasisRatio: 0.05,
    maxContiguousStasisFrames: 4,
    meanMotionEnergy: 0.01,
    motionEnergyP50: 0.008,
    motionEnergyP90: 0.015,
    motionEnergyP99: 0.02,
    peakMotionEnergy: 0.04,
    peakMotionFrame: 10,
    meanAccelerationEnergy: 0.01,
    analyzedAccelerationTransitionCount: rangeCounts(frameCount, holds, 2),
    accelerationEnergyP90: 0.02,
    accelerationEnergyP99: 0.04,
    peakAccelerationEnergy: 0.08,
    peakAccelerationFrame: 11,
    meanJerkEnergy: 0.01,
    analyzedJerkTransitionCount: rangeCounts(frameCount, holds, 3),
    jerkEnergyP90: Math.min(0.015, jerkEnergyP99),
    jerkEnergyP99,
    peakJerkEnergy,
    peakJerkFrame: 12,
    boundaryMetrics,
    maximumBoundaryJumpRatio: Math.max(...boundaryMetrics.map((entry) => entry.jumpRatio)),
    segmentMetrics,
    rollingWindowFrames: 51,
    windowEnergyTransform: "sqrt",
    maxWindowMotionShare: 0.2,
    maxWindowStartFrame: 1,
    maxWindowEndFrame: 51,
    rawMaxWindowMotionShare: 0.25,
    rawMaxWindowStartFrame: 1,
    rawMaxWindowEndFrame: 51,
    uniqueFrameRatio: 0.9,
    changedTransitionRatio: 0.8,
    meanLuma: 42,
    sampleCount: frameCount,
    stasisRatio: 0.05,
    motionEnergy: 0.01,
  };
  return {
    passed: true,
    checks: Object.fromEntries([
      "balancedMotion",
      "captionSafeZone",
      "clipping",
      "consecutiveStasis",
      "contiguousStasis",
      "dimensions",
      "duration",
      "exactFrames",
      "focusExclusivity",
      "frameRate",
      "geometryAudit",
      "h264Yuv420p",
      "immediateHook",
      "mobileLegibility",
      "persistentContinuity",
      "primaryRoi",
      "readableNonBlack",
      "semanticMotion",
    ].map((name) => [name, true])),
    technical: {
      codec: "h264",
      pixelFormat: "yuv420p",
      width: ir.width,
      height: ir.height,
      fps: ir.fps,
      frameCount,
      durationSeconds: frameCount / ir.fps,
    },
    motion: rawMotion,
    clippedEntities: 0,
    captionSafeZoneViolations: 0,
  };
}

async function buildArtifactBundle(index, options = {}) {
  const { content, store, artifacts } = repository();
  const draft = draftFor(index, options);
  const projectId = resourceId("prj", index + 1);
  const jobId = resourceId("job", index + 1);
  const draftArtifact = persist(content, "approval_bundle", draft, [
    draft.brief.contentHash,
    draft.claimLedger.contentHash,
    draft.script.contentHash,
    draft.storyboard.contentHash,
  ], projectId, jobId);
  const alignment = alignmentFor(draft, draftArtifact.artifact.id, projectId, index);
  const alignmentArtifact = persist(content, "narration_alignment", alignment, [
    draft.contentHash,
    draft.script.contentHash,
    alignment.narrationManifestHash,
    alignment.audioHash,
  ], projectId, jobId);
  const timing = buildProductionTimingContext({
    draft,
    alignment,
    projectId,
    projectRevision: 1,
    draftArtifactId: draftArtifact.artifact.id,
    draftHash: draft.contentHash,
    alignmentHash: alignment.contentHash,
  });
  const renderProfile = options.renderProfile || "preview";
  const renderQuality = renderProfile === "final" ? "high" : "standard";
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId,
    projectRevision: 1,
    renderProfile,
    draft,
    timingContext: timing,
  });
  const timingArtifact = persist(content, "animation_timing_context", timing, [
    draft.contentHash,
    alignment.contentHash,
  ], projectId, jobId);
  const planArtifact = persist(content, "animation_plan", compiled.plan, [
    draft.contentHash,
    alignment.contentHash,
    timingArtifact.envelope.contentHash,
  ], projectId, jobId);
  const irArtifact = persist(content, "animation_ir", compiled.animationIR, [
    timingArtifact.envelope.contentHash,
    planArtifact.envelope.contentHash,
  ], projectId, jobId);
  const { browser, compositionHash } = await browserProof(
    compiled.animationIR,
    index,
    { draft, timingContext: timing },
  );
  const motion = motionProof(compiled.animationIR, browser, index, options);
  const visualMasterSha256 = sha(`visual-master-${index}`);
  const browserProofHash = contentHash(browser);
  const motionProofHash = contentHash(motion);
  const qaBody = {
    schemaVersion: 1,
    status: "passed",
    draftArtifactId: draftArtifact.artifact.id,
    draftHash: draft.contentHash,
    alignmentArtifactId: alignmentArtifact.artifact.id,
    alignmentHash: alignment.contentHash,
    timingContextArtifactId: timingArtifact.artifact.id,
    timingContextHash: timingArtifact.envelope.contentHash,
    animationPlanArtifactId: planArtifact.artifact.id,
    animationPlanHash: planArtifact.envelope.contentHash,
    animationIRArtifactId: irArtifact.artifact.id,
    animationIRHash: irArtifact.envelope.contentHash,
    semanticProfileId: compiled.animationIR.content.semantic.profileId,
    provider: "hyperframes_local",
    runtimeVersion: "0.7.55",
    styleVersion: compiled.animationIR.renderer.styleVersion,
    renderProfile,
    renderQuality,
    compositionHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
    browser,
    motion,
  };
  const qaArtifact = persist(content, "animation_qa_report", qaBody, [
    draft.contentHash,
    alignment.contentHash,
    timingArtifact.envelope.contentHash,
    planArtifact.envelope.contentHash,
    irArtifact.envelope.contentHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
  ], projectId, jobId);
  const estimate = {
    frames: compiled.animationIR.durationFrames,
    durationSeconds: compiled.animationIR.durationFrames / compiled.animationIR.fps,
    complexityCost: 42,
    estimatedMemoryMb: 300,
    expectedDurationSeconds: 20,
  };
  const manifestBody = {
    schemaVersion: 1,
    draftArtifactId: draftArtifact.artifact.id,
    draftHash: draft.contentHash,
    alignmentArtifactId: alignmentArtifact.artifact.id,
    alignmentHash: alignment.contentHash,
    timingContextArtifactId: timingArtifact.artifact.id,
    timingContextHash: timingArtifact.envelope.contentHash,
    animationPlanArtifactId: planArtifact.artifact.id,
    animationPlanHash: planArtifact.envelope.contentHash,
    animationIRArtifactId: irArtifact.artifact.id,
    animationIRHash: irArtifact.envelope.contentHash,
    semanticProfileId: compiled.animationIR.content.semantic.profileId,
    provider: "hyperframes_local",
    runtimeVersion: "0.7.55",
    styleVersion: compiled.animationIR.renderer.styleVersion,
    renderProfile,
    renderQuality,
    compositionHash: qaBody.compositionHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
    animationQaArtifactId: qaArtifact.artifact.id,
    animationQaHash: qaArtifact.envelope.contentHash,
    estimate,
  };
  const renderManifestArtifact = persist(content, "animation_render_manifest", manifestBody, [
    draft.contentHash,
    alignment.contentHash,
    timingArtifact.envelope.contentHash,
    planArtifact.envelope.contentHash,
    irArtifact.envelope.contentHash,
    qaArtifact.envelope.contentHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
  ], projectId, jobId);
  const input = {
    contentArtifactRepository: content,
    draftArtifactId: draftArtifact.artifact.id,
    alignmentArtifactId: alignmentArtifact.artifact.id,
    timingArtifactId: timingArtifact.artifact.id,
    scenePlanArtifactId: null,
    planArtifactId: planArtifact.artifact.id,
    irArtifactId: irArtifact.artifact.id,
    qaArtifactId: qaArtifact.artifact.id,
    renderManifestArtifactId: renderManifestArtifact.artifact.id,
    reviewArtifactId: null,
  };
  const unreviewed = await motionCalibrationCaseFromArtifacts(input);
  if (options.reviewed !== false) {
    const failing = options.failing ?? (index % 10 < 2);
    const reviewBody = {
      schemaVersion: 1,
      profileId: MOTION_CALIBRATION_REVIEW_PROFILE_ID,
      draftHash: draft.contentHash,
      storyIdentityHash: unreviewed.storyIdentityHash,
      sourceFingerprintHash: unreviewed.sourceFingerprintHash,
      animationQaArtifactId: qaArtifact.artifact.id,
      animationQaHash: qaArtifact.envelope.contentHash,
      renderManifestArtifactId: renderManifestArtifact.artifact.id,
      renderManifestHash: renderManifestArtifact.envelope.contentHash,
      visualMasterSha256,
      reviewerIdHash: sha(`reviewer-${index}`),
      jerkVerdict: failing ? "fail" : "pass",
      boundaryVerdict: failing ? "fail" : "pass",
      reasonCodes: failing
        ? ["boundary_discontinuity", "jerk_discomfort"]
        : [],
    };
    const reviewArtifact = persist(content, "animation_motion_review", reviewBody, [
      draft.contentHash,
      unreviewed.storyIdentityHash,
      unreviewed.sourceFingerprintHash,
      qaArtifact.envelope.contentHash,
      renderManifestArtifact.envelope.contentHash,
      visualMasterSha256,
    ], projectId, jobId);
    input.reviewArtifactId = reviewArtifact.artifact.id;
  }
  return {
    input,
    content,
    store,
    artifacts,
    projectId,
    jobId,
    draft,
    draftArtifact,
    alignmentArtifact,
    timingArtifact,
    planArtifact,
    irArtifact,
    qaArtifact,
    renderManifestArtifact,
  };
}

async function verifiedCase(index, options = {}) {
  const bundle = await buildArtifactBundle(index, options);
  return motionCalibrationCaseFromArtifacts(bundle.input);
}

function replaceQaArtifact(bundle, mutate) {
  const current = bundle.content.readJson(bundle.input.qaArtifactId);
  const body = structuredClone(current.body);
  const previousBrowserProofHash = body.browserProofHash;
  const previousMotionProofHash = body.motionProofHash;
  mutate(body);
  body.browserProofHash = contentHash(body.browser);
  body.motionProofHash = contentHash(body.motion);
  const dependencyHashes = current.dependencyHashes.filter((value) => (
    value !== previousBrowserProofHash && value !== previousMotionProofHash
  ));
  dependencyHashes.push(body.browserProofHash, body.motionProofHash);
  const replacement = persist(
    bundle.content,
    "animation_qa_report",
    body,
    dependencyHashes,
    bundle.projectId,
    bundle.jobId,
  );
  return {
    ...bundle.input,
    qaArtifactId: replacement.artifact.id,
    reviewArtifactId: null,
  };
}

function assertInvalid(action) {
  assert.throws(action, { code: "ANIMATION_MOTION_CALIBRATION_INVALID" });
}

async function assertInvalidAsync(action, field = null) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, "ANIMATION_MOTION_CALIBRATION_INVALID");
    if (field !== null) assert.equal(error?.details?.field, field);
    return true;
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("repository resolver derives evidence from stored checksummed artifacts", async () => {
  const value = await verifiedCase(0);
  assert.match(value.caseId, /^repo_[a-f0-9]{24}$/);
  assert.match(value.sourceFixtureId, /^story_[a-f0-9]{24}$/);
  assert.equal(value.storyIdentityHash.length, 64);
  assert.equal(value.sourceFingerprintHash.length, 64);
  assert.equal(value.stratum.temporalMetricProfileId, MOTION_TEMPORAL_METRIC_PROFILE_ID);
  assert.equal(value.stratum.analysisWidth, 180);
  assert.equal(value.stratum.analysisHeight, 208);
  assert.equal(value.stratum.motionThreshold, 0.0002);
  assert.equal(value.stratum.renderProfile, "preview");
  assert.equal(value.metrics.jerkEnergyP99, 0.22);
  assert.equal(value.review.jerkVerdict, "fail");
  assertDeepFrozen(value);
  assert.doesNotMatch(
    JSON.stringify(value),
    /(?:sampleHashes|rawFrames|outputPath|storageKey|apiKey|authorization)/,
  );
});

test("production render artifacts are accepted by the repository-bound calibration resolver", async () => {
  const index = 310;
  const { content } = repository();
  const draft = draftFor(index);
  const projectId = resourceId("prj", index + 1);
  const jobId = resourceId("job", index + 1);
  const draftArtifact = persist(content, "approval_bundle", draft, [
    draft.brief.contentHash,
    draft.claimLedger.contentHash,
    draft.script.contentHash,
    draft.storyboard.contentHash,
  ], projectId, jobId);
  const alignment = alignmentFor(draft, draftArtifact.artifact.id, projectId, index);
  const alignmentArtifact = persist(content, "narration_alignment", alignment, [
    draft.contentHash,
    draft.script.contentHash,
    alignment.narrationManifestHash,
    alignment.audioHash,
  ], projectId, jobId);
  const stagingDir = mkdtempSync(resolve(tmpdir(), "motion-calibration-production-"));
  let renderedIr;
  let semanticSourceContext;
  let browserResult;
  const provider = {
    id: "hyperframes_local",
    doctor: async () => ({ ready: true, runtimeVersion: "0.7.55" }),
    validate(animationIR, options) {
      renderedIr = animationIR;
      semanticSourceContext = options.semanticSourceContext;
      return { animationIR, budget: { computedCost: 42 } };
    },
    estimate({ animationIR }) {
      return {
        frames: animationIR.durationFrames,
        durationSeconds: animationIR.durationFrames / animationIR.fps,
        complexityCost: 42,
        estimatedMemoryMb: 300,
        expectedDurationSeconds: 20,
      };
    },
    async render({ validated, stagingDir: rendererDir }) {
      const outputPath = resolve(rendererDir, "visual-master.mp4");
      const bytes = Buffer.from("repository-bound-production-render");
      writeFileSync(outputPath, bytes);
      const { compileAnimationIRToHtml } = await import(
        "../renderer/hyperframes/animation-ir-adapter.mjs"
      );
      return {
        outputPath,
        outputSha256: createHash("sha256").update(bytes).digest("hex"),
        animationIRHash: validated.animationIR.contentHash,
        compositionHash: compileAnimationIRToHtml(validated.animationIR, {
          semanticSourceContext,
        }).compositionHash,
      };
    },
    verify(manifest) {
      return {
        valid: true,
        outputSha256: manifest.outputSha256,
        animationIRHash: manifest.animationIRHash,
      };
    },
  };

  try {
    const result = await runProductionAnimationRender({
      animationProfile: "semantic-v3",
      draft,
      alignment,
      projectId,
      projectRevision: 1,
      jobId,
      draftArtifactId: draftArtifact.artifact.id,
      draftHash: draft.contentHash,
      alignmentArtifactId: alignmentArtifact.artifact.id,
      alignmentHash: alignment.contentHash,
      renderProfile: "preview",
      stagingDir,
      contentArtifactRepository: content,
    }, {
      providerRegistry: { get: () => provider },
      chromePath: "/mock/chrome",
      runBrowserSeekProof: async (request) => {
        const frameHashes = new Map(
          [...new Set(request.seekSequence)].map((frame) => [
            frame,
            sha(`production-browser-frame-${frame}`),
          ]),
        );
        const repeatedFrames = [...frameHashes.keys()]
          .filter((frame) => request.seekSequence.filter((value) => value === frame).length > 1)
          .sort((left, right) => left - right)
          .map((frame) => ({
            frame,
            occurrences: request.seekSequence.filter((value) => value === frame).length,
            sha256: frameHashes.get(frame),
            equal: true,
          }));
        browserResult = {
          seekSequence: request.seekSequence,
          cacheWarmupFrames: request.cacheWarmupFrames,
          captures: request.seekSequence.map((frame, sequenceIndex) => ({
            sequenceIndex,
            frame,
            sha256: frameHashes.get(frame),
          })),
          repeatedFrames,
          loadedOnce: true,
          pageLoadCount: 1,
          stateIsolation: {
            valid: true,
            wallClockIndependent: true,
            seededRandomOnly: true,
            autoplayFree: true,
            frameAccumulationFree: true,
          },
          externalRequestCount: 0,
          blockedExternalRequestCount: 0,
          resourceClasses: [],
          geometryAudit: {
            passed: true,
            semanticRoi: request.expectedSemanticRoi,
            captionSafeZone: request.expectedCaptionSafeZone,
            checkpointCount: request.seekSequence.length,
            entityObservationCount: request.seekSequence.length,
            pathFollowerObservationCount: request.expectedPathFollowerIds.length,
            semanticRouteObservationCount: request.expectedSemanticRouteIds.length,
            observedSemanticRouteIds: request.expectedSemanticRouteIds,
            unobservedSemanticRouteIds: [],
            boundedGeometryObservationCount:
              request.expectedBoundedGeometrySentenceIndices.length,
            persistentObservationCount: request.expectedPersistentEntityIds.length,
            labelObservationCount: request.expectedLabelIds.length,
            markedLabelIds: request.expectedLabelIds,
            observedLabelIds: request.expectedLabelIds,
            unobservedLabelIds: [],
            observedPathFollowerIds: request.expectedPathFollowerIds,
            unobservedPathFollowerIds: [],
            observedBoundedGeometrySentenceIndices:
              request.expectedBoundedGeometrySentenceIndices,
            unobservedBoundedGeometrySentenceIndices: [],
            persistentStateCoverage: Object.fromEntries(
              request.expectedPersistentEntityIds.map((entityId) => [
                entityId,
                request.expectedVisualStateIds,
              ]),
            ),
            observedTransitionIds: request.expectedTransitionIds,
            observedFocusIntervalIds: request.expectedFocusIntervalIds,
            unobservedFocusIntervalIds: [],
            observedActionSignatures: request.expectedActionSignatures,
            unobservedActionSignatures: [],
            actionCoverageViolations: [],
            semanticRouteViolations: [],
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
        return browserResult;
      },
      runBenchmarkQa() {
        return motionProof(renderedIr, browserResult, index, { failing: false });
      },
    });

    const value = await motionCalibrationCaseFromArtifacts({
      contentArtifactRepository: content,
      draftArtifactId: draftArtifact.artifact.id,
      alignmentArtifactId: alignmentArtifact.artifact.id,
      timingArtifactId: result.timingArtifact.artifact.id,
      scenePlanArtifactId: null,
      planArtifactId: result.planArtifact.artifact.id,
      irArtifactId: result.irArtifact.artifact.id,
      qaArtifactId: result.qaArtifact.artifact.id,
      renderManifestArtifactId: result.renderManifestArtifact.artifact.id,
      reviewArtifactId: null,
    });
    assert.equal(value.draftArtifactId, draftArtifact.artifact.id);
    assert.equal(value.alignmentArtifactId, alignmentArtifact.artifact.id);
    assert.equal(value.qaArtifactId, result.qaArtifact.artifact.id);
    assert.equal(value.renderManifestArtifactId, result.renderManifestArtifact.artifact.id);
    assert.equal(value.animationIRArtifactHash, result.animationIR.contentHash);
    assert.equal(
      value.stratum.semanticProfileId,
      result.animationIR.content.semantic.profileId,
    );
    assert.equal(value.stratum.analysisWidth, 180);
    assert.equal(value.stratum.analysisHeight, 208);
    assert.equal(value.review, null);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("repository resolver rejects a schema-valid browser proof that omits the trusted seek policy", async () => {
  const bundle = await buildArtifactBundle(320, { reviewed: false });
  const input = replaceQaArtifact(bundle, (body) => {
    const middle = Math.floor(body.motion.technical.frameCount / 2);
    const seekSequence = [0, middle, 0];
    const frameHashes = new Map([
      [0, sha("forged-browser-frame-0")],
      [middle, sha("forged-browser-frame-middle")],
    ]);
    body.browser.seekSequence = seekSequence;
    body.browser.cacheWarmupFrames = [0];
    body.browser.captures = seekSequence.map((frame, sequenceIndex) => ({
      sequenceIndex,
      frame,
      sha256: frameHashes.get(frame),
    }));
    body.browser.repeatedFrames = [{
      frame: 0,
      occurrences: 2,
      sha256: frameHashes.get(0),
      equal: true,
    }];
    body.browser.geometryAudit.checkpointCount = seekSequence.length;
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(input),
    "motionCalibration.qa.browser.seekSequence",
  );
});

test("repository resolver binds ROI, labels, and route coverage to the trusted composition", async () => {
  const wrongRoiBundle = await buildArtifactBundle(323, { reviewed: false });
  const wrongRoiInput = replaceQaArtifact(wrongRoiBundle, (body) => {
    body.browser.geometryAudit.semanticRoi.x += 1;
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(wrongRoiInput),
    "motionCalibration.qa.browser.geometryAudit",
  );

  const wrongLabelsBundle = await buildArtifactBundle(324, { reviewed: false });
  const wrongLabelsInput = replaceQaArtifact(wrongLabelsBundle, (body) => {
    body.browser.geometryAudit.markedLabelIds = ["forged_label"];
    body.browser.geometryAudit.observedLabelIds = ["forged_label"];
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(wrongLabelsInput),
    "motionCalibration.qa.browser.geometryAudit.markedLabelIds",
  );

  const missingRouteBundle = await buildArtifactBundle(325, {
    fixture: ROUTE_FIXTURE,
    metadataOnly: true,
    reviewed: false,
  });
  const storedQa = missingRouteBundle.content.readJson(
    missingRouteBundle.input.qaArtifactId,
  );
  assert.ok(storedQa.body.browser.geometryAudit.observedSemanticRouteIds.length > 0);
  const missingRouteInput = replaceQaArtifact(missingRouteBundle, (body) => {
    body.browser.geometryAudit.semanticRouteObservationCount = 0;
    body.browser.geometryAudit.observedSemanticRouteIds = [];
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(missingRouteInput),
    "motionCalibration.qa.browser.geometryAudit.observedSemanticRouteIds",
  );
});

test("repository resolver recomputes structural Motion QA flags", async () => {
  const bundle = await buildArtifactBundle(321, { reviewed: false });
  const input = replaceQaArtifact(bundle, (body) => {
    body.motion.motion.firstMeaningfulMotionFrame = 30;
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(input),
    "motionCalibration.qa.motion.checks.immediateHook",
  );
});

test("repository resolver recomputes every boundary jump ratio", async () => {
  const bundle = await buildArtifactBundle(322, { reviewed: false });
  const input = replaceQaArtifact(bundle, (body) => {
    const boundary = body.motion.motion.boundaryMetrics[0];
    boundary.jumpRatio += 0.5;
    body.motion.motion.maximumBoundaryJumpRatio = Math.max(
      ...body.motion.motion.boundaryMetrics.map((entry) => entry.jumpRatio),
    );
  });
  await assertInvalidAsync(
    () => motionCalibrationCaseFromArtifacts(input),
    "motionCalibration.qa.motion.motion.boundaryMetrics[0].jumpRatio",
  );
});

test("ten source- and story-distinct reviewed cases produce deterministic shadow candidates", async () => {
  const cases = await Promise.all(
    Array.from({ length: 10 }, (_, index) => verifiedCase(index)),
  );
  const report = buildMotionCalibrationCorpusReport({ cases });
  assert.equal(report.profileId, MOTION_CALIBRATION_CORPUS_PROFILE_ID);
  assert.equal(report.thresholdMode, MOTION_CALIBRATION_THRESHOLD_MODE);
  assert.equal(
    report.evidenceTrustLevel,
    MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
  );
  assert.equal(report.calibrationStatus, "candidate_ready");
  assert.equal(report.productionThresholdsApproved, false);
  assert.equal(report.distinctStoryCount, 10);
  assert.equal(report.reviewedCaseCount, 10);
  assert.deepEqual(report.blockers, [MOTION_CALIBRATION_BLOCKERS.SHADOW_THRESHOLDS]);
  assert.equal(report.thresholdCandidates.length, 3);
  assert.ok(report.thresholdCandidates.every((entry) => entry.separable));
  assert.ok(report.thresholdCandidates.every((entry) => entry.withinSafetyCeiling));
  assert.ok(report.thresholdCandidates.every((entry) => entry.outlierStable));
  assert.match(report.contentHash, /^[a-f0-9]{64}$/);
  assert.match(report.cases[0].browserProofHash, /^[a-f0-9]{64}$/);
  assert.match(report.cases[0].motionProofHash, /^[a-f0-9]{64}$/);
  assert.match(report.cases[0].compositionHash, /^[a-f0-9]{64}$/);
  assertDeepFrozen(report);

  const reversed = buildMotionCalibrationCorpusReport({ cases: [...cases].reverse() });
  assert.deepEqual(reversed, report);
  assert.deepEqual(
    validateMotionCalibrationCorpusReport(structuredClone(report), { cases }),
    report,
  );
});

test("metadata, identifier, visual, and near-duplicate rewrites cannot inflate story counts", async () => {
  const first = await verifiedCase(100, { metadataOnly: true, reviewed: false });
  const second = await verifiedCase(101, { metadataOnly: true, reviewed: false });
  const identifierChurn = await verifiedCase(102, {
    identityChurn: true,
    reviewed: false,
  });
  assert.notEqual(first.draftHash, second.draftHash);
  assert.equal(first.storyIdentityHash, second.storyIdentityHash);
  assert.equal(first.sourceFingerprintHash, second.sourceFingerprintHash);
  assert.notEqual(first.draftHash, identifierChurn.draftHash);
  assert.equal(first.storyIdentityHash, identifierChurn.storyIdentityHash);
  assert.equal(first.sourceFingerprintHash, identifierChurn.sourceFingerprintHash);
  assertInvalid(() => buildMotionCalibrationCorpusReport({ cases: [first, second] }));
  assertInvalid(() => buildMotionCalibrationCorpusReport({
    cases: [first, identifierChurn],
  }));

  const nearDuplicates = await Promise.all([
    verifiedCase(103, { nearDuplicate: true, reviewed: false }),
    verifiedCase(104, { nearDuplicate: true, reviewed: false }),
  ]);
  assert.notEqual(
    nearDuplicates[0].storyIdentityHash,
    nearDuplicates[1].storyIdentityHash,
  );
  assert.notEqual(
    nearDuplicates[0].sourceFingerprintHash,
    nearDuplicates[1].sourceFingerprintHash,
  );
  assertInvalid(() => buildMotionCalibrationCorpusReport({
    cases: nearDuplicates,
  }));
});

test("small, unreviewed, mixed-stratum, outlier, and unsafe corpora remain blocked", async () => {
  const small = await Promise.all(Array.from(
    { length: 3 },
    (_, index) => verifiedCase(index + 120, { reviewed: false }),
  ));
  const smallReport = buildMotionCalibrationCorpusReport({ cases: small });
  assert.equal(smallReport.calibrationStatus, "blocked");
  assert.deepEqual(smallReport.thresholdCandidates, []);
  assert.deepEqual(smallReport.blockers, [
    MOTION_CALIBRATION_BLOCKERS.INSUFFICIENT_STORIES,
    MOTION_CALIBRATION_BLOCKERS.INCOMPLETE_REVIEW,
    MOTION_CALIBRATION_BLOCKERS.LABEL_SUPPORT,
    MOTION_CALIBRATION_BLOCKERS.SHADOW_THRESHOLDS,
  ]);

  const mixedCases = await Promise.all([
    verifiedCase(130),
    verifiedCase(131, { renderProfile: "final" }),
  ]);
  assertInvalid(() => buildMotionCalibrationCorpusReport({ cases: mixedCases }));

  const outlierCases = await Promise.all(Array.from(
    { length: 10 },
    (_, index) => verifiedCase(
      index + 140,
      index === 9
        ? { failing: false, jerkEnergyP99: 0.17, peakJerkEnergy: 0.2 }
        : {},
    ),
  ));
  const outlierReport = buildMotionCalibrationCorpusReport({ cases: outlierCases });
  assert.equal(outlierReport.calibrationStatus, "blocked");
  assert.ok(outlierReport.blockers.includes(MOTION_CALIBRATION_BLOCKERS.PASS_OUTLIERS));

  const unsafeCases = await Promise.all(Array.from(
    { length: 10 },
    (_, index) => verifiedCase(
      index + 160,
      index < 2
        ? { failing: true, jerkEnergyP99: 0.4, peakJerkEnergy: 0.5 }
        : { failing: false, jerkEnergyP99: 0.2 + index * 0.001, peakJerkEnergy: 0.3 + index * 0.001 },
    ),
  ));
  const unsafeReport = buildMotionCalibrationCorpusReport({ cases: unsafeCases });
  assert.equal(unsafeReport.calibrationStatus, "blocked");
  assert.ok(unsafeReport.blockers.includes(MOTION_CALIBRATION_BLOCKERS.SAFETY_CEILING));
});

test("repository resolver rejects detached IDs, corrupt stored bytes, and stale bindings", async () => {
  const detached = await buildArtifactBundle(200);
  detached.input.qaArtifactId = detached.input.renderManifestArtifactId;
  await assertInvalidAsync(() => motionCalibrationCaseFromArtifacts(detached.input));

  const corrupt = await buildArtifactBundle(201);
  corrupt.store.buffers.set(corrupt.input.qaArtifactId, Buffer.from("{}"));
  await assertInvalidAsync(() => motionCalibrationCaseFromArtifacts(corrupt.input));

  const stale = await buildArtifactBundle(202, { reviewed: false });
  const body = structuredClone(stale.content.readJson(stale.input.qaArtifactId).body);
  body.draftHash = "0".repeat(64);
  const replacement = persist(stale.content, "animation_qa_report", body, [
    ...stale.content.readJson(stale.input.qaArtifactId).dependencyHashes,
  ], resourceId("prj", 203), resourceId("job", 203));
  stale.input.qaArtifactId = replacement.artifact.id;
  await assertInvalidAsync(() => motionCalibrationCaseFromArtifacts(stale.input));
});

test("resolver and report validator reject accessors, symbols, sparse arrays, cycles, and private fields without invoking getters", async () => {
  const base = (await buildArtifactBundle(220, { reviewed: false })).input;
  let invoked = false;
  Object.defineProperty(base, "qaArtifactId", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter must not execute");
    },
  });
  await assertInvalidAsync(() => motionCalibrationCaseFromArtifacts(base));
  assert.equal(invoked, false);

  const cases = await Promise.all(
    Array.from({ length: 10 }, (_, index) => verifiedCase(index + 230)),
  );
  const report = structuredClone(buildMotionCalibrationCorpusReport({ cases }));
  const topLevelAccessor = structuredClone(report);
  let topLevelGetterInvoked = false;
  Object.defineProperty(topLevelAccessor, "productionThresholdsApproved", {
    enumerable: true,
    get() {
      topLevelGetterInvoked = true;
      throw new Error("top-level getter must not execute");
    },
  });
  assertInvalid(() => validateMotionCalibrationCorpusReport(topLevelAccessor, { cases }));
  assert.equal(topLevelGetterInvoked, false);

  let reportGetterInvoked = false;
  Object.defineProperty(report.thresholdCandidates[0], "limit", {
    enumerable: true,
    get() {
      reportGetterInvoked = true;
      throw new Error("getter must not execute");
    },
  });
  assertInvalid(() => validateMotionCalibrationCorpusReport(report, { cases }));
  assert.equal(reportGetterInvoked, false);

  const cyclic = structuredClone(buildMotionCalibrationCorpusReport({ cases }));
  cyclic.thresholdCandidates[0].cycle = cyclic;
  assertInvalid(() => validateMotionCalibrationCorpusReport(cyclic, { cases }));

  const sparse = structuredClone(buildMotionCalibrationCorpusReport({ cases }));
  sparse.blockers = new Array(2);
  assertInvalid(() => validateMotionCalibrationCorpusReport(sparse, { cases }));

  const symbol = structuredClone(buildMotionCalibrationCorpusReport({ cases }));
  symbol.cases[0][Symbol("secret")] = true;
  assertInvalid(() => validateMotionCalibrationCorpusReport(symbol, { cases }));

  const privateField = structuredClone(buildMotionCalibrationCorpusReport({ cases }));
  privateField.cases[0].outputPath = "/private/render.mp4";
  assertInvalid(() => validateMotionCalibrationCorpusReport(privateField, { cases }));
});

test("serialized reports cannot self-attest provenance or promote shadow thresholds", async () => {
  const cases = await Promise.all(
    Array.from({ length: 10 }, (_, index) => verifiedCase(index + 260)),
  );
  const report = buildMotionCalibrationCorpusReport({ cases });
  assertInvalid(() => validateMotionCalibrationCorpusReport(structuredClone(report)));

  const promoted = structuredClone(report);
  promoted.productionThresholdsApproved = true;
  assertInvalid(() => validateMotionCalibrationCorpusReport(promoted, { cases }));

  const wrongHash = structuredClone(report);
  wrongHash.contentHash = "0".repeat(64);
  assertInvalid(() => validateMotionCalibrationCorpusReport(wrongHash, { cases }));

  const wrongCount = structuredClone(report);
  wrongCount.distinctStoryCount = 100;
  assertInvalid(() => validateMotionCalibrationCorpusReport(wrongCount, { cases }));

  const inconsistent = structuredClone(report);
  inconsistent.cases[0].metrics.jerkEnergyP99 = 0.9;
  inconsistent.cases[0].metrics.peakJerkEnergy = 0.1;
  assertInvalid(() => validateMotionCalibrationCorpusReport(inconsistent, { cases }));
});
