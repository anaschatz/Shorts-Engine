const { mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { AppError } = require("../../../errors.cjs");
const { contentHash } = require("../contracts.cjs");
const { buildProductionTimingContext } = require("./timing-context-builder.cjs");
const { GENERIC_SEMANTIC_PROFILE_ID } = require("./semantic-visual-planner.cjs");
const {
  compileProductionAnimation,
  PRODUCTION_PROVIDER_ID,
  PRODUCTION_RUNTIME_VERSION,
} = require("./production-plan-compiler.cjs");
const { createAnimationProviderRegistry } = require("./provider-registry.cjs");
const { createHyperframesProvider } = require("./providers/hyperframes.cjs");
const { runBenchmarkQa } = require("./benchmark-qa.cjs");

function fail(code = "ANIMATION_RENDER_FAILED") {
  throw new AppError(code, "Production animation rendering failed safely.", code === "ANIMATION_READINESS_FAILED" ? 503 : 409);
}

function safeSeekSequence(ir) {
  const maxUniqueFrames = 36;
  const selected = new Set();
  const validFrame = (frame) => Number.isInteger(frame) && frame >= 0 && frame < ir.durationFrames;
  const add = (frame) => {
    if (selected.size >= maxUniqueFrames || !validFrame(frame)) return;
    selected.add(frame);
  };
  const visualStateGraph = ir.visualStateGraph;
  if (visualStateGraph) {
    const mandatory = new Set();
    const requireFrame = (frame) => { if (validFrame(frame)) mandatory.add(frame); };
    [0, 1, Math.min(6, ir.durationFrames - 1), ir.durationFrames - 1].forEach(requireFrame);
    for (const state of visualStateGraph.states || []) requireFrame(state.settleAnchor?.resolvedFrame);
    for (const transition of visualStateGraph.stateTransitions || []) {
      const startFrame = transition.fromAnchor?.resolvedFrame;
      const endFrame = transition.toAnchor?.resolvedFrame;
      requireFrame(startFrame);
      if (Number.isInteger(startFrame) && Number.isInteger(endFrame)) requireFrame(Math.floor((startFrame + endFrame) / 2));
      requireFrame(endFrame);
    }
    for (const interval of visualStateGraph.focusIntervals || []) requireFrame(Math.floor((interval.startFrame + interval.endFrame - 1) / 2));
    for (const scene of ir.scenes) requireFrame(Math.floor((scene.startFrame + scene.endFrame - 1) / 2));
    if (mandatory.size > maxUniqueFrames) throw new AppError("ANIMATION_BROWSER_SEEK_BUDGET_EXCEEDED", "Animation browser proof exceeds its safe seek budget.", 409);
    mandatory.forEach((frame) => selected.add(frame));
  } else {
    [0, 1, Math.min(6, ir.durationFrames - 1), ir.durationFrames - 1].forEach(add);
    for (const scene of ir.scenes) add(Math.floor((scene.startFrame + scene.endFrame - 1) / 2));
  }

  const semantic = ir.profileVersion === "1.1.0" && ir.content?.semantic?.profileId === "wow_signal_case_v1";
  if (semantic) {
    const trace = ir.scenes.flatMap((scene) => scene.operations).find((operation) => operation.op === "trace_signal" && operation.targetId === "evidence_trace");
    if (trace) {
      const span = trace.to.resolvedFrame - trace.from.resolvedFrame;
      add(Math.floor(trace.from.resolvedFrame + span * 0.25));
      add(Math.floor(trace.from.resolvedFrame + span * 0.75));
    }
    for (const scene of ir.scenes) for (const operation of scene.operations) add(Math.floor((operation.from.resolvedFrame + operation.to.resolvedFrame) / 2));
  }
  for (const scene of ir.scenes) {
    add(scene.startFrame);
    add(Math.max(scene.startFrame, scene.endFrame - 1));
  }

  const maxOperationCount = Math.max(0, ...ir.scenes.map((scene) => scene.operations.length));
  for (let operationIndex = 0; operationIndex < maxOperationCount && selected.size < maxUniqueFrames; operationIndex += 1) {
    for (const scene of ir.scenes) {
      const operation = scene.operations[operationIndex];
      if (operation) add(Math.floor((operation.from.resolvedFrame + operation.to.resolvedFrame) / 2));
    }
  }

  for (const scene of ir.scenes) for (const operation of scene.operations) {
    add(operation.from.resolvedFrame);
    add(operation.to.resolvedFrame);
  }
  const ordered = [...selected].sort((a, b) => a - b);
  const repeated = ordered[Math.floor(ordered.length / 2)] || 0;
  return [...ordered, repeated, 0, repeated];
}

function readabilityHolds(ir) {
  return ir.scenes.flatMap((scene) => scene.readabilityHolds.map((hold, index) => ({ id: `${scene.id}_hold_${index}`, startFrame: hold.startFrame, endFrame: hold.endFrame })));
}

function motionSegments(ir) {
  return ir.scenes.map((scene) => ({ id: scene.id, startFrame: scene.startFrame, endFrame: scene.endFrame }));
}

function browserQaExpectations(ir, seekSequence) {
  const repeatedFrames = seekSequence.filter((frame, index) => seekSequence.indexOf(frame) !== index);
  if (ir.visualStateGraph) {
    const graph = ir.visualStateGraph;
    return Object.freeze({
      cacheWarmupFrames: [...new Set([
        ...graph.focusIntervals.map((interval) => Math.floor((interval.startFrame + interval.endFrame - 1) / 2)),
        ...repeatedFrames,
      ])],
      pathFollowerIds: ["beam-profile-dot", "signal-evidence-marker"],
      persistentEntityIds: graph.persistentEntities.map((entity) => entity.browserEntityId),
      visualStateIds: graph.states.map((state) => state.id),
      focusIntervalIds: graph.focusIntervals.map((interval) => interval.id),
      transitionIds: graph.stateTransitions.map((transition) => transition.id),
    });
  }
  if (ir.content?.semantic?.profileId === GENERIC_SEMANTIC_PROFILE_ID) {
    return Object.freeze({
      cacheWarmupFrames: [...new Set([
        ...ir.scenes.map((scene) => Math.floor((scene.startFrame + scene.endFrame - 1) / 2)),
        ...repeatedFrames,
      ])],
      pathFollowerIds: ["story-evidence-marker"],
      persistentEntityIds: ["story_evidence"],
      visualStateIds: ir.content.visualPlan.scenes.map((scene) => scene.id),
      focusIntervalIds: [],
      transitionIds: [],
    });
  }
  fail("ANIMATION_QA_POLICY_MISSING");
}

function motionQaGeometryRequirements(ir) {
  if (ir.visualStateGraph) {
    return Object.freeze({
      persistentContinuity: true,
      transitionContinuity: true,
      focusExclusivity: true,
      primaryRoi: true,
      mobileLegibility: true,
    });
  }
  if (ir.content?.semantic?.profileId === GENERIC_SEMANTIC_PROFILE_ID) {
    return Object.freeze({
      persistentContinuity: true,
      transitionContinuity: false,
      focusExclusivity: false,
      primaryRoi: true,
      mobileLegibility: true,
    });
  }
  fail("ANIMATION_QA_POLICY_MISSING");
}

function sameValues(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function browserResultMeetsPolicy(value, expected) {
  const geometry = value?.geometryAudit;
  if (!value || value.passed !== true || value.loadedOnce !== true || value.pageLoadCount !== 1 || value.stateIsolation?.valid !== true) return false;
  if (value.externalRequestCount !== 0 || value.blockedExternalRequestCount !== 0) return false;
  if (JSON.stringify(value.seekSequence) !== JSON.stringify(expected.seekSequence) || JSON.stringify(value.cacheWarmupFrames) !== JSON.stringify(expected.cacheWarmupFrames)) return false;
  if (!Array.isArray(value.captures) || value.captures.length !== expected.seekSequence.length || !Array.isArray(value.repeatedFrames) || !value.repeatedFrames.length || value.repeatedFrames.some((entry) => entry.equal !== true)) return false;
  if (!geometry || geometry.passed !== true || geometry.checkpointCount !== expected.seekSequence.length) return false;
  if (geometry.persistentObservationCount <= 0 || geometry.pathFollowerObservationCount <= 0 || geometry.labelObservationCount <= 0) return false;
  if (!sameValues(geometry.observedPathFollowerIds, expected.pathFollowerIds) || geometry.unobservedPathFollowerIds?.length !== 0) return false;
  if (!sameValues(geometry.observedTransitionIds, expected.transitionIds) || !sameValues(geometry.observedFocusIntervalIds, expected.focusIntervalIds) || geometry.unobservedFocusIntervalIds?.length !== 0) return false;
  if (!Array.isArray(geometry.markedLabelIds) || !geometry.markedLabelIds.length || !sameValues(geometry.markedLabelIds, geometry.observedLabelIds) || geometry.unobservedLabelIds?.length !== 0) return false;
  for (const entityId of expected.persistentEntityIds) if (!sameValues(geometry.persistentStateCoverage?.[entityId], expected.visualStateIds)) return false;
  for (const field of ["clippedEntities", "captionSafeZoneViolations", "pathFollowerViolations", "persistentContinuityViolations", "focusViolations", "primaryRoiViolations", "legibilityViolations", "contrastViolations"]) if (!Array.isArray(geometry[field]) || geometry[field].length !== 0) return false;
  return true;
}

function publicBrowserProof(value) {
  return {
    seekSequence: value.seekSequence,
    cacheWarmupFrames: value.cacheWarmupFrames,
    captures: value.captures,
    repeatedFrames: value.repeatedFrames,
    loadedOnce: value.loadedOnce,
    pageLoadCount: value.pageLoadCount,
    stateIsolation: value.stateIsolation,
    externalRequestCount: value.externalRequestCount,
    blockedExternalRequestCount: value.blockedExternalRequestCount,
    resourceClasses: value.resourceClasses,
    geometryAudit: {
      passed: value.geometryAudit.passed,
      semanticRoi: value.geometryAudit.semanticRoi,
      captionSafeZone: value.geometryAudit.captionSafeZone,
      checkpointCount: value.geometryAudit.checkpointCount,
      entityObservationCount: value.geometryAudit.entityObservationCount,
      pathFollowerObservationCount: value.geometryAudit.pathFollowerObservationCount || 0,
      persistentObservationCount: value.geometryAudit.persistentObservationCount || 0,
      labelObservationCount: value.geometryAudit.labelObservationCount || 0,
      markedLabelIds: value.geometryAudit.markedLabelIds || [],
      observedLabelIds: value.geometryAudit.observedLabelIds || [],
      unobservedLabelCount: value.geometryAudit.unobservedLabelIds?.length || 0,
      observedPathFollowerIds: value.geometryAudit.observedPathFollowerIds || [],
      unobservedPathFollowerCount: value.geometryAudit.unobservedPathFollowerIds?.length || 0,
      persistentStateCoverage: value.geometryAudit.persistentStateCoverage || {},
      observedTransitionIds: value.geometryAudit.observedTransitionIds || [],
      observedFocusIntervalIds: value.geometryAudit.observedFocusIntervalIds || [],
      unobservedFocusIntervalCount: value.geometryAudit.unobservedFocusIntervalIds?.length || 0,
      clippedEntityCount: value.geometryAudit.clippedEntities.length,
      captionSafeZoneViolationCount: value.geometryAudit.captionSafeZoneViolations.length,
      pathFollowerViolationCount: value.geometryAudit.pathFollowerViolations?.length || 0,
      persistentContinuityViolationCount: value.geometryAudit.persistentContinuityViolations?.length || 0,
      focusViolationCount: value.geometryAudit.focusViolations?.length || 0,
      primaryRoiViolationCount: value.geometryAudit.primaryRoiViolations?.length || 0,
      legibilityViolationCount: value.geometryAudit.legibilityViolations?.length || 0,
      contrastViolationCount: value.geometryAudit.contrastViolations?.length || 0,
    },
    passed: value.passed,
  };
}

function publicMotionQa(value) {
  const { sampleHashes: _sampleHashes, ...motion } = value.motion;
  return {
    passed: value.passed,
    checks: value.checks,
    technical: value.technical,
    motion,
    clippedEntities: value.clippedEntities,
    captionSafeZoneViolations: value.captionSafeZoneViolations,
  };
}

async function runProductionAnimationRender(input = {}, dependencies = {}) {
  const contentArtifacts = input.contentArtifactRepository || dependencies.contentArtifactRepository;
  if (!contentArtifacts || !input.projectId || !input.jobId || !input.draftArtifactId || !input.draftHash || !input.alignmentHash || !input.stagingDir) fail();
  const timingContext = buildProductionTimingContext(input);
  const compiled = compileProductionAnimation({ ...input, timingContext });
  const stagingDir = resolve(input.stagingDir, "animation");
  mkdirSync(stagingDir, { recursive: true });
  const provider = (dependencies.providerRegistry || createAnimationProviderRegistry([
    createHyperframesProvider({ providerId: PRODUCTION_PROVIDER_ID }),
  ])).get(PRODUCTION_PROVIDER_ID);
  const persist = (type, body, dependencyHashes) => contentArtifacts.createJson({ type, projectId: input.projectId, jobId: input.jobId, revision: input.projectRevision, dependencyHashes, body });
  const timingArtifact = persist("animation_timing_context", timingContext, [input.draftHash, input.alignmentHash]);
  const planArtifact = persist("animation_plan", compiled.plan, [timingArtifact.envelope.contentHash, input.draftHash, input.alignmentHash]);
  const irArtifact = persist("animation_ir", compiled.animationIR, [timingArtifact.envelope.contentHash, planArtifact.envelope.contentHash]);
  let completed = false;
  try {
    const doctor = await provider.doctor();
    if (!doctor.ready || doctor.runtimeVersion !== PRODUCTION_RUNTIME_VERSION) fail("ANIMATION_READINESS_FAILED");
    const validated = provider.validate(compiled.animationIR);
    const estimate = provider.estimate(validated);
    const renderTimeoutMs = input.timeoutMs || (input.renderProfile === "final" ? 1800000 : 1200000);
    const rendered = await provider.render({ validated, stagingDir, outputName: "visual-master.mp4", quality: input.renderProfile === "final" ? "high" : "standard", timeoutMs: renderTimeoutMs }, input.signal, input.onProgress);
    const verified = provider.verify(rendered);
    if (rendered.animationIRHash !== compiled.animationIR.contentHash || verified.animationIRHash !== compiled.animationIR.contentHash) fail("ANIMATION_OUTPUT_TAMPERED");
    const { compileAnimationIRToHtml } = await import("../../../../renderer/hyperframes/animation-ir-adapter.mjs");
    const composition = compileAnimationIRToHtml(compiled.animationIR);
    if (rendered.compositionHash !== composition.compositionHash) fail("ANIMATION_OUTPUT_TAMPERED");
    const browserRunner = dependencies.runBrowserSeekProof || (await import("../../../../renderer/hyperframes/browser-seek-harness.mjs")).runBrowserSeekProof;
    const runtimeDoctor = dependencies.chromePath ? null : await (await import("../../../../renderer/hyperframes/doctor.mjs")).hyperframesDoctor();
    const seekSequence = safeSeekSequence(compiled.animationIR);
    const expectations = browserQaExpectations(compiled.animationIR, seekSequence);
    const browser = await browserRunner({
      html: composition.html,
      width: compiled.animationIR.width,
      height: compiled.animationIR.height,
      fps: compiled.animationIR.fps,
      durationFrames: compiled.animationIR.durationFrames,
      chromePath: dependencies.chromePath || runtimeDoctor.chromePath,
      seekSequence,
      cacheWarmupFrames: expectations.cacheWarmupFrames,
      expectedPathFollowerIds: expectations.pathFollowerIds,
      expectedPersistentEntityIds: expectations.persistentEntityIds,
      expectedVisualStateIds: expectations.visualStateIds,
      expectedFocusIntervalIds: expectations.focusIntervalIds,
      expectedTransitionIds: expectations.transitionIds,
      legibilityProfile: "mobile_720_v1",
    });
    if (!browserResultMeetsPolicy(browser, {
      seekSequence,
      cacheWarmupFrames: expectations.cacheWarmupFrames,
      pathFollowerIds: expectations.pathFollowerIds,
      persistentEntityIds: expectations.persistentEntityIds,
      visualStateIds: expectations.visualStateIds,
      focusIntervalIds: expectations.focusIntervalIds,
      transitionIds: expectations.transitionIds,
    })) fail("ANIMATION_QA_BLOCKED");
    const browserProof = publicBrowserProof(browser);
    const motionQa = publicMotionQa((dependencies.runBenchmarkQa || runBenchmarkQa)({
      outputPath: rendered.outputPath,
      width: compiled.animationIR.width,
      height: compiled.animationIR.height,
      expectedFrameCount: compiled.animationIR.durationFrames,
      expectedFps: compiled.animationIR.fps,
      geometryAudit: browser.geometryAudit,
      readabilityHolds: readabilityHolds(compiled.animationIR),
      segments: motionSegments(compiled.animationIR),
      semanticContinuityRequired: true,
      semanticGeometryRequirements: motionQaGeometryRequirements(compiled.animationIR),
    }));
    if (!browserProof.passed || !motionQa.passed || browserProof.externalRequestCount !== 0 || browserProof.blockedExternalRequestCount !== 0) fail("ANIMATION_QA_BLOCKED");
    const browserProofHash = contentHash(browserProof);
    const motionProofHash = contentHash(motionQa);
    const qaBody = {
      schemaVersion: 1,
      status: "passed",
      timingContextHash: timingArtifact.envelope.contentHash,
      animationPlanHash: planArtifact.envelope.contentHash,
      animationIRHash: irArtifact.envelope.contentHash,
      provider: provider.id,
      runtimeVersion: doctor.runtimeVersion,
      styleVersion: compiled.animationIR.renderer.styleVersion,
      compositionHash: composition.compositionHash,
      visualMasterSha256: verified.outputSha256,
      browserProofHash,
      motionProofHash,
      browser: browserProof,
      motion: motionQa,
    };
    const qaArtifact = persist("animation_qa_report", qaBody, [timingArtifact.envelope.contentHash, planArtifact.envelope.contentHash, irArtifact.envelope.contentHash, verified.outputSha256, browserProofHash, motionProofHash]);
    const manifestBody = {
      schemaVersion: 1,
      timingContextArtifactId: timingArtifact.artifact.id,
      timingContextHash: timingArtifact.envelope.contentHash,
      animationPlanArtifactId: planArtifact.artifact.id,
      animationPlanHash: planArtifact.envelope.contentHash,
      animationIRArtifactId: irArtifact.artifact.id,
      animationIRHash: irArtifact.envelope.contentHash,
      provider: provider.id,
      runtimeVersion: doctor.runtimeVersion,
      styleVersion: compiled.animationIR.renderer.styleVersion,
      compositionHash: composition.compositionHash,
      visualMasterSha256: verified.outputSha256,
      browserProofHash,
      motionProofHash,
      animationQaArtifactId: qaArtifact.artifact.id,
      animationQaHash: qaArtifact.envelope.contentHash,
      estimate,
    };
    const renderManifestArtifact = persist("animation_render_manifest", manifestBody, [timingArtifact.envelope.contentHash, planArtifact.envelope.contentHash, irArtifact.envelope.contentHash, qaArtifact.envelope.contentHash, verified.outputSha256]);
    completed = true;
    return Object.freeze({
      visualMasterPath: rendered.outputPath,
      visualMasterSha256: verified.outputSha256,
      timingContext,
      animationPlan: compiled.plan,
      animationIR: compiled.animationIR,
      timingArtifact,
      planArtifact,
      irArtifact,
      qaArtifact,
      qa: qaBody,
      renderManifestArtifact,
      manifest: manifestBody,
    });
  } finally {
    if (!completed) rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = {
  browserQaExpectations,
  browserResultMeetsPolicy,
  motionQaGeometryRequirements,
  runProductionAnimationRender,
  safeSeekSequence,
  publicBrowserProof,
  publicMotionQa,
};
