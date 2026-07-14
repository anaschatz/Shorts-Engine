const { mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { AppError } = require("../../../errors.cjs");
const { contentHash } = require("../contracts.cjs");
const { buildProductionTimingContext } = require("./timing-context-builder.cjs");
const {
  compileProductionAnimation,
  PRODUCTION_PROVIDER_ID,
  PRODUCTION_RUNTIME_VERSION,
  PRODUCTION_STYLE_VERSION,
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
  const add = (frame) => {
    if (selected.size >= maxUniqueFrames || !Number.isInteger(frame) || frame < 0 || frame >= ir.durationFrames) return;
    selected.add(frame);
  };
  [0, 1, Math.min(6, ir.durationFrames - 1), ir.durationFrames - 1].forEach(add);
  for (const scene of ir.scenes) add(Math.floor((scene.startFrame + scene.endFrame - 1) / 2));

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

function publicBrowserProof(value) {
  return {
    seekSequence: value.seekSequence,
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
      observedPathFollowerIds: value.geometryAudit.observedPathFollowerIds || [],
      unobservedPathFollowerCount: value.geometryAudit.unobservedPathFollowerIds?.length || 0,
      clippedEntityCount: value.geometryAudit.clippedEntities.length,
      captionSafeZoneViolationCount: value.geometryAudit.captionSafeZoneViolations.length,
      pathFollowerViolationCount: value.geometryAudit.pathFollowerViolations?.length || 0,
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
    const rendered = await provider.render({ validated, stagingDir, outputName: "visual-master.mp4", quality: input.renderProfile === "final" ? "high" : "standard", timeoutMs: input.timeoutMs || 600000 }, input.signal, input.onProgress);
    const verified = provider.verify(rendered);
    if (rendered.animationIRHash !== compiled.animationIR.contentHash || verified.animationIRHash !== compiled.animationIR.contentHash) fail("ANIMATION_OUTPUT_TAMPERED");
    const { compileAnimationIRToHtml } = await import("../../../../renderer/hyperframes/animation-ir-adapter.mjs");
    const composition = compileAnimationIRToHtml(compiled.animationIR);
    if (rendered.compositionHash !== composition.compositionHash) fail("ANIMATION_OUTPUT_TAMPERED");
    const browserRunner = dependencies.runBrowserSeekProof || (await import("../../../../renderer/hyperframes/browser-seek-harness.mjs")).runBrowserSeekProof;
    const runtimeDoctor = dependencies.chromePath ? null : await (await import("../../../../renderer/hyperframes/doctor.mjs")).hyperframesDoctor();
    const browser = await browserRunner({ html: composition.html, width: compiled.animationIR.width, height: compiled.animationIR.height, fps: compiled.animationIR.fps, durationFrames: compiled.animationIR.durationFrames, chromePath: dependencies.chromePath || runtimeDoctor.chromePath, seekSequence: safeSeekSequence(compiled.animationIR), expectedPathFollowerIds: ["beam-profile-dot", "signal-response-dot", "signal-trace-dot"] });
    const browserProof = publicBrowserProof(browser);
    const motionQa = publicMotionQa((dependencies.runBenchmarkQa || runBenchmarkQa)({ outputPath: rendered.outputPath, width: compiled.animationIR.width, height: compiled.animationIR.height, expectedFrameCount: compiled.animationIR.durationFrames, expectedFps: compiled.animationIR.fps, geometryAudit: browser.geometryAudit, readabilityHolds: readabilityHolds(compiled.animationIR), segments: motionSegments(compiled.animationIR) }));
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
      styleVersion: PRODUCTION_STYLE_VERSION,
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
      styleVersion: PRODUCTION_STYLE_VERSION,
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

module.exports = { runProductionAnimationRender, safeSeekSequence, publicBrowserProof, publicMotionQa };
