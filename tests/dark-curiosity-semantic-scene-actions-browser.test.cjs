"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  buildSemanticAnimationSceneDsl,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl.cjs");
const {
  buildSemanticAnimationSceneDslPlanFromScenes,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl-plan.cjs");
const {
  browserQaExpectations,
  safeSeekSequence,
} = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const RUN_BROWSER_PROOF =
  process.env.RUN_SEMANTIC_SCENE_ACTION_BROWSER_TEST === "1";

function fixtureDraft(fixtureId = "001_wow_signal_mystery") {
  return normalizeDraftBundle(JSON.parse(readFileSync(resolve(
    __dirname,
    "..",
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${fixtureId}.json`,
  ), "utf8")));
}

function fixtureTiming(fixtureId) {
  return normalizeAnimationTimingContext(JSON.parse(readFileSync(resolve(
    __dirname,
    "..",
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    "timing",
    `${fixtureId}.timing.json`,
  ), "utf8")));
}

function timingFor(draft) {
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
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`scene-action-browser:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function alternatePlan(compiled) {
  const content = compiled.animationIR.content;
  const defaultPlan = content.semanticAnimationSceneDslPlan;
  const sentencePlan = content.semanticVisualSentencePlan;
  const sentenceIndex = sentencePlan.sentences.findIndex(
    (sentence) => sentence.primitiveParameters.geometry.route === null,
  );
  const sentence = sentencePlan.sentences[sentenceIndex];
  const replacement = buildSemanticAnimationSceneDsl({
    semanticEventGraphHash: content.semanticEventGraph.contentHash,
    semanticVisualSentencePlanHash: sentencePlan.contentHash,
    propositionId: sentence.propositionId,
    primitiveParameters: sentence.primitiveParameters,
    sceneComposition: sentence.sceneComposition,
    proposal: {
      schemaVersion: 1,
      actions: [
        {
          op: "highlight",
          target: "module_primary",
          phase: "develop",
          preset: "pulse_once",
        },
        {
          op: "camera",
          target: "scene",
          phase: "resolve",
          preset: "pull_overview",
        },
      ],
    },
  });
  return {
    sentenceIndex,
    plan: buildSemanticAnimationSceneDslPlanFromScenes({
      bindings: defaultPlan.bindings,
      planner: defaultPlan.planner,
      scenes: defaultPlan.scenes.map((scene, index) => ({
        propositionId: scene.propositionId,
        provenance: scene.provenance,
        sceneDsl: index === sentenceIndex ? replacement : scene.sceneDsl,
      })),
    }),
  };
}

function hashAt(result, frame) {
  return result.captures.find((capture) => capture.frame === frame)?.sha256;
}

test("real browser pixels suppress extra Scene DSL motion deterministically", {
  skip: !RUN_BROWSER_PROOF,
}, async () => {
  const [
    { compileAnimationIRToHtml },
    {
      semanticSentenceRenderIntervals,
      semanticSimpleExplainerVisualGroups,
    },
    {
      compileSemanticSimpleExplainerGroupActionSchedule,
      semanticSceneActionQaPlan,
    },
    { runBrowserSeekProof },
    { hyperframesDoctor },
  ] = await Promise.all([
    import("../renderer/hyperframes/animation-ir-adapter.mjs"),
    import("../renderer/hyperframes/semantic-sentence-animation.mjs"),
    import("../renderer/hyperframes/semantic-scene-action-schedule.mjs"),
    import("../renderer/hyperframes/browser-seek-harness.mjs"),
    import("../renderer/hyperframes/doctor.mjs"),
  ]);
  const draft = fixtureDraft();
  const timingContext = timingFor(draft);
  const input = {
    animationProfile: "semantic-v3",
    projectId: "prj_scene_action_browser",
    projectRevision: 1,
    renderProfile: "preview",
    draft,
    timingContext,
  };
  const baseline = compileProductionAnimation(input);
  const alternate = alternatePlan(baseline);
  const changed = compileProductionAnimation({
    ...input,
    semanticAnimationSceneDslPlan: alternate.plan,
  });
  const options = { semanticSourceContext: { draft, timingContext } };
  const baselineComposition = compileAnimationIRToHtml(
    baseline.animationIR,
    options,
  );
  const changedComposition = compileAnimationIRToHtml(
    changed.animationIR,
    options,
  );
  const sentences =
    changed.animationIR.content.semanticVisualSentencePlan.sentences;
  const intervals = semanticSentenceRenderIntervals(
    sentences,
    changed.animationIR.durationFrames,
  );
  const visualGroups = semanticSimpleExplainerVisualGroups(
    sentences,
    intervals,
    changed.animationIR.durationFrames,
  );
  const schedule = compileSemanticSimpleExplainerGroupActionSchedule({
    sceneDslPlan: alternate.plan,
    sentences,
    visualGroups,
    fps: changed.animationIR.fps,
    durationFrames: changed.animationIR.durationFrames,
  });
  const changedGroupIndex = visualGroups.findIndex(
    (group) => group.anchorSentenceIndex === alternate.sentenceIndex,
  );
  assert.ok(changedGroupIndex >= 0);
  const changedGroup = visualGroups[changedGroupIndex];
  const changedScene = schedule.scenes[changedGroupIndex];
  const entryFrame = changedScene.phaseWindows.entry.startFrame;
  const entryMidFrame = Math.floor(
    (
      changedScene.phaseWindows.entry.startFrame
      + changedScene.phaseWindows.entry.endFrame
    ) / 2,
  );
  const entryEndFrame = changedScene.phaseWindows.entry.endFrame;
  const developFrame = Math.floor(
    (
      changedScene.phaseWindows.develop.startFrame
      + changedScene.phaseWindows.develop.endFrame
    ) / 2,
  );
  const resolveFrame = Math.floor(
    (
      changedScene.phaseWindows.resolve.startFrame
      + changedScene.phaseWindows.resolve.endFrame
    ) / 2,
  );
  const boundedStartFrame = changedGroup.startFrame;
  const boundedMidFrame = Math.floor(
    (
      changedGroup.startFrame
      + changedGroup.semanticEndFrame - 1
    ) / 2,
  );
  const boundedEndFrame = changedGroup.semanticEndFrame - 1;
  const seekSequence = [
    ...new Set([
      ...visualGroups.map((group) => Math.floor(
        (group.startFrame + group.semanticEndFrame - 1) / 2,
      )),
      ...semanticSceneActionQaPlan(schedule).phaseFrames,
      entryFrame,
      entryMidFrame,
      entryEndFrame,
      developFrame,
      resolveFrame,
      boundedStartFrame,
      boundedMidFrame,
      boundedEndFrame,
    ]),
  ].sort((left, right) => left - right);
  seekSequence.push(developFrame);
  seekSequence.push(boundedMidFrame);
  const doctor = await hyperframesDoctor();
  assert.equal(doctor.ready, true);
  const request = (html) => ({
    html,
    width: changed.animationIR.width,
    height: changed.animationIR.height,
    fps: changed.animationIR.fps,
    durationFrames: changed.animationIR.durationFrames,
    chromePath: doctor.chromePath,
    seekSequence,
    cacheWarmupFrames: [developFrame],
    expectedBoundedGeometrySentenceIndices: [],
    legibilityProfile: "mobile_720_v1",
  });
  const baselineProof = await runBrowserSeekProof(
    request(baselineComposition.html),
  );
  const changedProof = await runBrowserSeekProof(
    request(changedComposition.html),
  );
  assert.equal(
    baselineProof.passed,
    true,
    JSON.stringify(baselineProof.geometryAudit),
  );
  assert.equal(
    changedProof.passed,
    true,
    JSON.stringify(changedProof.geometryAudit),
  );
  assert.ok(baselineProof.repeatedFrames.every((entry) => entry.equal));
  assert.ok(changedProof.repeatedFrames.every((entry) => entry.equal));
  assert.equal(changedProof.geometryAudit.boundedGeometryObservationCount, 0);
  assert.ok(changedProof.geometryAudit.checkpoints.every(
    (checkpoint) => checkpoint.boundedGeometry.every(
      (geometry) => !geometry.visible,
    ),
  ));
  assert.deepEqual(
    changedProof.geometryAudit.boundedGeometryClippingViolations,
    [],
  );
  assert.deepEqual(
    changedProof.geometryAudit.boundedGeometryCaptionSafeZoneViolations,
    [],
  );
  assert.notEqual(
    hashAt(changedProof, entryFrame),
    hashAt(changedProof, entryMidFrame),
  );
  assert.notEqual(
    hashAt(changedProof, entryMidFrame),
    hashAt(changedProof, entryEndFrame),
  );
  assert.equal(
    hashAt(baselineProof, developFrame),
    hashAt(changedProof, developFrame),
  );
  assert.equal(
    hashAt(baselineProof, resolveFrame),
    hashAt(changedProof, resolveFrame),
  );
  assert.ok(changedProof.geometryAudit.observedActionSignatures.includes(
    "create:module_primary:entry:reveal",
  ));
  assert.equal(changedProof.geometryAudit.observedActionSignatures.includes(
    "highlight:module_primary:develop:pulse_once",
  ), false);
  assert.equal(changedProof.geometryAudit.observedActionSignatures.includes(
    "camera:scene:resolve:pull_overview",
  ), false);
  assert.ok(schedule.scenes.every(
    (scene) => scene.actions.length === 1,
  ));
});

test("real browser keeps an ungrounded route illustration static after reveal", {
  skip: !RUN_BROWSER_PROOF,
}, async () => {
  const [
    { compileAnimationIRToHtml },
    {
      semanticSentenceRenderIntervals,
      semanticSimpleExplainerVisualGroups,
    },
    {
      compileSemanticSimpleExplainerGroupActionSchedule,
      semanticSceneActionQaPlan,
    },
    { runBrowserSeekProof },
    { hyperframesDoctor },
  ] = await Promise.all([
    import("../renderer/hyperframes/animation-ir-adapter.mjs"),
    import("../renderer/hyperframes/semantic-sentence-animation.mjs"),
    import("../renderer/hyperframes/semantic-scene-action-schedule.mjs"),
    import("../renderer/hyperframes/browser-seek-harness.mjs"),
    import("../renderer/hyperframes/doctor.mjs"),
  ]);
  const draft = fixtureDraft("003_baychimo_icebound_drift");
  const timingContext = fixtureTiming("003_baychimo_icebound_drift");
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_scene_action_route_browser",
    projectRevision: 1,
    renderProfile: "preview",
    draft,
    timingContext,
  });
  const sentences =
    compiled.animationIR.content.semanticVisualSentencePlan.sentences;
  const intervals = semanticSentenceRenderIntervals(
    sentences,
    compiled.animationIR.durationFrames,
  );
  const visualGroups = semanticSimpleExplainerVisualGroups(
    sentences,
    intervals,
    compiled.animationIR.durationFrames,
  );
  const schedule = compileSemanticSimpleExplainerGroupActionSchedule({
    sceneDslPlan:
      compiled.animationIR.content.semanticAnimationSceneDslPlan,
    sentences,
    visualGroups,
    fps: compiled.animationIR.fps,
    durationFrames: compiled.animationIR.durationFrames,
  });
  const routeIndex = visualGroups.findIndex(
    (group) => group.visualKind === "route",
  );
  assert.ok(routeIndex >= 0);
  const routeScene = schedule.scenes[routeIndex];
  assert.equal(routeScene.actions.length, 1);
  assert.equal(routeScene.actions[0].op, "create");
  assert.ok(schedule.scenes.every((scene, index) => (
    visualGroups[index].visualKind === "route"
    || scene.actions.every((action) => action.op !== "move")
  )));
  const routeSpan = routeScene.semanticEndFrame - routeScene.startFrame;
  const routeVisibleStart = Math.min(
    routeScene.semanticEndFrame - 2,
    Math.max(
      routeScene.presentationTiming.revealSettleFrame + 1,
      routeScene.startFrame + Math.max(3, Math.floor(routeSpan * 0.2)),
    ),
  );
  const routeMid = Math.floor(
    (routeScene.startFrame + routeScene.semanticEndFrame - 1) / 2,
  );
  const routeEnd = routeScene.semanticEndFrame - 1;
  const seekSequence = [
    ...new Set([
      ...visualGroups.map((group) => Math.floor(
        (group.startFrame + group.semanticEndFrame - 1) / 2,
      )),
      ...semanticSceneActionQaPlan(schedule).phaseFrames,
      routeVisibleStart,
      routeMid,
      routeEnd,
    ]),
  ].sort((left, right) => left - right);
  seekSequence.push(routeMid);
  const composition = compileAnimationIRToHtml(compiled.animationIR, {
    semanticSourceContext: { draft, timingContext },
  });
  const doctor = await hyperframesDoctor();
  assert.equal(doctor.ready, true);
  const proof = await runBrowserSeekProof({
    html: composition.html,
    width: compiled.animationIR.width,
    height: compiled.animationIR.height,
    fps: compiled.animationIR.fps,
    durationFrames: compiled.animationIR.durationFrames,
    chromePath: doctor.chromePath,
    seekSequence,
    cacheWarmupFrames: [routeMid],
    expectedBoundedGeometrySentenceIndices: [],
    legibilityProfile: "mobile_720_v1",
  });
  assert.equal(proof.passed, true, JSON.stringify(proof.geometryAudit));
  assert.ok(proof.repeatedFrames.every((entry) => entry.equal));
  assert.ok(proof.geometryAudit.semanticRouteObservationCount > 0);
  assert.deepEqual(proof.geometryAudit.semanticRouteViolations, []);
  assert.deepEqual(proof.geometryAudit.boundedGeometryClippingViolations, []);
  assert.deepEqual(
    proof.geometryAudit.boundedGeometryCaptionSafeZoneViolations,
    [],
  );
  assert.equal(
    hashAt(proof, routeVisibleStart),
    hashAt(proof, routeMid),
  );
  assert.equal(hashAt(proof, routeMid), hashAt(proof, routeEnd));
  const checkpointAt = (frame) => proof.geometryAudit.checkpoints.find(
    (checkpoint) => checkpoint.frame === frame,
  );
  const routeAt = (frame) => checkpointAt(frame).semanticRoutes[0];
  assert.deepEqual(
    {
      x: routeAt(routeVisibleStart).x,
      y: routeAt(routeVisibleStart).y,
    },
    {
      x: routeAt(routeMid).x,
      y: routeAt(routeMid).y,
    },
  );
  assert.deepEqual(
    {
      x: routeAt(routeMid).x,
      y: routeAt(routeMid).y,
    },
    {
      x: routeAt(routeEnd).x,
      y: routeAt(routeEnd).y,
    },
  );
  assert.ok(checkpointAt(routeVisibleStart).semanticRoutes[0].distance <= 0.75);
  assert.ok(checkpointAt(routeMid).semanticRoutes[0].distance <= 0.75);
  assert.ok(checkpointAt(routeEnd).semanticRoutes[0].distance <= 0.75);
});

test("real browser keeps GPS simple foregrounds valid while provenance topology stays hidden", {
  skip: !RUN_BROWSER_PROOF,
}, async () => {
  const [
    { compileAnimationIRToHtml },
    { semanticSentenceRenderIntervals },
    { runBrowserSeekProof },
    { hyperframesDoctor },
  ] = await Promise.all([
    import("../renderer/hyperframes/animation-ir-adapter.mjs"),
    import("../renderer/hyperframes/semantic-sentence-animation.mjs"),
    import("../renderer/hyperframes/browser-seek-harness.mjs"),
    import("../renderer/hyperframes/doctor.mjs"),
  ]);
  const draft = fixtureDraft("002_gps_week_rollover");
  const timingContext = fixtureTiming("002_gps_week_rollover");
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_scene_action_gps_browser",
    projectRevision: 1,
    renderProfile: "final",
    draft,
    timingContext,
  });
  const sentences =
    compiled.animationIR.content.semanticVisualSentencePlan.sentences;
  const intervals = semanticSentenceRenderIntervals(
    sentences,
    compiled.animationIR.durationFrames,
  );
  const sentenceMidpoints = intervals.map((interval) => Math.floor(
    (interval.startFrame + interval.semanticEndFrame - 1) / 2,
  ));
  const composition = compileAnimationIRToHtml(compiled.animationIR, {
    semanticSourceContext: { draft, timingContext },
  });
  const seekSequence = [
    ...safeSeekSequence(compiled.animationIR, composition.actionQa),
    sentenceMidpoints[0],
  ];
  const productionExpectations = browserQaExpectations(
    compiled.animationIR,
    seekSequence,
    composition.actionQa,
    composition.qaPolicy,
  );
  assert.deepEqual(
    productionExpectations.boundedGeometrySentenceIndices,
    [],
  );
  const doctor = await hyperframesDoctor();
  assert.equal(doctor.ready, true);
  const proof = await runBrowserSeekProof({
    html: composition.html,
    width: compiled.animationIR.width,
    height: compiled.animationIR.height,
    fps: compiled.animationIR.fps,
    durationFrames: compiled.animationIR.durationFrames,
    chromePath: doctor.chromePath,
    seekSequence,
    cacheWarmupFrames: productionExpectations.cacheWarmupFrames,
    expectedBoundedGeometrySentenceIndices:
      productionExpectations.boundedGeometrySentenceIndices,
    legibilityProfile: "mobile_720_v1",
  });
  assert.equal(proof.passed, true, JSON.stringify(proof.geometryAudit));
  assert.ok(proof.repeatedFrames.length >= 1);
  assert.ok(proof.repeatedFrames.every((entry) => entry.equal));
  assert.equal(proof.geometryAudit.boundedGeometryObservationCount, 0);
  for (const checkpoint of proof.geometryAudit.checkpoints) {
    const visibleModuleIds = checkpoint.sceneActionModules.map(
      (module) => module.moduleId,
    );
    assert.ok(
      visibleModuleIds.length === 0
        || (
          visibleModuleIds.length === 1
          && visibleModuleIds[0] === "module_primary"
        ),
      `frame ${checkpoint.frame}: only the focal module may be visible`,
    );
    assert.ok(
      checkpoint.boundedGeometry.every((geometry) => !geometry.visible),
      `frame ${checkpoint.frame}: provenance topology must stay hidden`,
    );
  }
  assert.ok(proof.geometryAudit.checkpoints.some(
    (checkpoint) => checkpoint.sceneActionModules.some(
      (module) => module.moduleId === "module_primary",
    ),
  ));
  assert.ok(proof.geometryAudit.markedLabelIds.every(
    (labelId) => !labelId.startsWith("semantic-support-")
      && !labelId.includes("-copy-"),
  ));
  assert.deepEqual(proof.geometryAudit.boundedGeometryClippingViolations, []);
  assert.deepEqual(
    proof.geometryAudit.boundedGeometryCaptionSafeZoneViolations,
    [],
  );
});
