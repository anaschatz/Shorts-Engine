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

test("real browser pixels execute distinct Scene DSL actions deterministically", {
  skip: !RUN_BROWSER_PROOF,
}, async () => {
  const [
    { compileAnimationIRToHtml },
    { semanticSentenceRenderIntervals },
    { compileSemanticSceneActionSchedule },
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
  const schedule = compileSemanticSceneActionSchedule({
    sceneDslPlan: alternate.plan,
    sentences,
    intervals,
    fps: changed.animationIR.fps,
    durationFrames: changed.animationIR.durationFrames,
  });
  const changedScene = schedule.scenes[alternate.sentenceIndex];
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
  const boundedInterval = intervals[alternate.sentenceIndex];
  const boundedStartFrame = boundedInterval.startFrame;
  const boundedMidFrame = Math.floor(
    (
      boundedInterval.startFrame
      + boundedInterval.semanticEndFrame - 1
    ) / 2,
  );
  const boundedEndFrame = boundedInterval.semanticEndFrame - 1;
  const seekSequence = [
    ...new Set([
      ...intervals.map((interval) => Math.floor(
        (interval.startFrame + interval.semanticEndFrame - 1) / 2,
      )),
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
    expectedBoundedGeometrySentenceIndices: sentences.map(
      (_sentence, index) => index,
    ),
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
  assert.ok(changedProof.geometryAudit.boundedGeometryObservationCount > 0);
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
  assert.notEqual(
    hashAt(baselineProof, developFrame),
    hashAt(changedProof, developFrame),
  );
  assert.notEqual(
    hashAt(baselineProof, resolveFrame),
    hashAt(changedProof, resolveFrame),
  );
  const boundedAt = (checkpoint) => checkpoint.boundedGeometry.find(
    (geometry) => geometry.sentenceIndex === alternate.sentenceIndex,
  );
  const checkpointsAt = (frame) => changedProof.geometryAudit.checkpoints
    .filter((checkpoint) => checkpoint.frame === frame);
  const startGeometry = boundedAt(checkpointsAt(boundedStartFrame)[0]);
  const midGeometries = checkpointsAt(boundedMidFrame).map(boundedAt);
  const endGeometry = boundedAt(checkpointsAt(boundedEndFrame)[0]);
  assert.ok(startGeometry);
  assert.ok(midGeometries.length >= 2);
  assert.ok(endGeometry);
  assert.ok(startGeometry.nodes.every(
    (node) => node.opacity === 0 && node.translateY === 10,
  ));
  assert.ok(startGeometry.edges.every(
    (edge) => edge.opacity === 0 && edge.dashOffset === 1000,
  ));
  assert.ok(midGeometries[0].nodes[0].opacity > 0);
  assert.ok(midGeometries[0].nodes[0].translateY < 10);
  assert.ok(midGeometries[0].edges[0].opacity > 0);
  assert.ok(
    midGeometries[0].edges[0].dashOffset > 0
      && midGeometries[0].edges[0].dashOffset < 1000,
  );
  assert.ok(endGeometry.nodes.every(
    (node) => node.opacity > 0.99 && node.translateY < 0.01,
  ));
  assert.ok(endGeometry.edges.every(
    (edge) => edge.opacity > 0.99 && edge.dashOffset < 50,
  ));
  assert.deepEqual(midGeometries.at(-1), midGeometries[0]);
});

test("real browser pixels follow the approved route without seek drift", {
  skip: !RUN_BROWSER_PROOF,
}, async () => {
  const [
    { compileAnimationIRToHtml },
    { semanticSentenceRenderIntervals },
    {
      compileSemanticSceneActionSchedule,
      semanticSceneActionStateAtFrame,
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
  const timingContext = timingFor(draft);
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
  const schedule = compileSemanticSceneActionSchedule({
    sceneDslPlan:
      compiled.animationIR.content.semanticAnimationSceneDslPlan,
    sentences,
    intervals,
    fps: compiled.animationIR.fps,
    durationFrames: compiled.animationIR.durationFrames,
  });
  const routeIndex = schedule.scenes.findIndex((scene, index) => (
    sentences[index].capability.grammarId === "map_motion"
    && scene.actions.some((action) => action.op === "move")
  ));
  assert.ok(routeIndex >= 0);
  const routeScene = schedule.scenes[routeIndex];
  const move = routeScene.actions.find((action) => action.op === "move");
  const moveMid = Math.floor((move.startFrame + move.endFrame) / 2);
  const nonMapRouteIndex = schedule.scenes.findIndex((scene, index) => (
    sentences[index].capability.grammarId !== "map_motion"
    && scene.actions.some((action) => action.op === "move")
  ));
  assert.ok(nonMapRouteIndex >= 0);
  const nonMapRouteScene = schedule.scenes[nonMapRouteIndex];
  const nonMapMove = nonMapRouteScene.actions.find(
    (action) => action.op === "move",
  );
  const nonMapMoveMid = Math.floor(
    (nonMapMove.startFrame + nonMapMove.endFrame) / 2,
  );
  const baseRouteIndex = schedule.scenes.findIndex((scene, index) => (
    sentences[index].capability.grammarId === "map_motion"
    && !scene.actions.some((action) => action.op === "move")
  ));
  assert.ok(baseRouteIndex >= 0);
  const baseRouteScene = schedule.scenes[baseRouteIndex];
  const baseRouteVisibleStart = baseRouteScene.phaseWindows.entry.endFrame;
  const baseRouteMid = Math.floor(
    (baseRouteScene.startFrame + baseRouteScene.semanticEndFrame - 1) / 2,
  );
  const baseRouteEnd = baseRouteScene.semanticEndFrame - 1;
  const seekSequence = [
    ...new Set([
      ...intervals.map((interval) => Math.floor(
        (interval.startFrame + interval.semanticEndFrame - 1) / 2,
      )),
      move.startFrame,
      moveMid,
      move.endFrame,
      nonMapMove.startFrame,
      nonMapMoveMid,
      nonMapMove.endFrame,
      baseRouteVisibleStart,
      baseRouteMid,
      baseRouteEnd,
    ]),
  ].sort((left, right) => left - right);
  seekSequence.push(moveMid);
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
    cacheWarmupFrames: [moveMid],
    expectedBoundedGeometrySentenceIndices: sentences.map(
      (_sentence, index) => index,
    ),
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
  assert.notEqual(hashAt(proof, move.startFrame), hashAt(proof, moveMid));
  assert.notEqual(hashAt(proof, moveMid), hashAt(proof, move.endFrame));
  const checkpointAt = (frame) => proof.geometryAudit.checkpoints.find(
    (checkpoint) => checkpoint.frame === frame,
  );
  const baseRouteAt = (frame) => checkpointAt(frame).semanticRoutes[0];
  assert.notDeepEqual(
    {
      x: baseRouteAt(baseRouteVisibleStart).x,
      y: baseRouteAt(baseRouteVisibleStart).y,
    },
    {
      x: baseRouteAt(baseRouteMid).x,
      y: baseRouteAt(baseRouteMid).y,
    },
  );
  assert.notDeepEqual(
    {
      x: baseRouteAt(baseRouteMid).x,
      y: baseRouteAt(baseRouteMid).y,
    },
    {
      x: baseRouteAt(baseRouteEnd).x,
      y: baseRouteAt(baseRouteEnd).y,
    },
  );
  const primaryAt = (frame) => checkpointAt(frame).sceneActionModules.find(
    (module) => module.moduleId === "module_primary",
  );
  const expectedMid = semanticSceneActionStateAtFrame(
    nonMapRouteScene,
    nonMapMoveMid,
  ).routeDisplacement;
  const expectedEnd = semanticSceneActionStateAtFrame(
    nonMapRouteScene,
    nonMapMove.endFrame,
  ).routeDisplacement;
  assert.deepEqual(
    {
      x: primaryAt(nonMapMoveMid).translateX,
      y: primaryAt(nonMapMoveMid).translateY,
    },
    {
      x: Number(expectedMid.x.toFixed(4)),
      y: Number(expectedMid.y.toFixed(4)),
    },
  );
  assert.deepEqual(
    {
      x: primaryAt(nonMapMove.endFrame).translateX,
      y: primaryAt(nonMapMove.endFrame).translateY,
    },
    {
      x: Number(expectedEnd.x.toFixed(4)),
      y: Number(expectedEnd.y.toFixed(4)),
    },
  );
});

test("real browser keeps every GPS sentence geometry inside the safe visual area", {
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
  const timingContext = timingFor(draft);
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_scene_action_gps_browser",
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
  const sentenceMidpoints = intervals.map((interval) => Math.floor(
    (interval.startFrame + interval.semanticEndFrame - 1) / 2,
  ));
  const seekSequence = [...sentenceMidpoints, sentenceMidpoints[0]];
  const productionExpectations = browserQaExpectations(
    compiled.animationIR,
    seekSequence,
  );
  assert.deepEqual(
    productionExpectations.boundedGeometrySentenceIndices,
    sentences.map((_sentence, index) => index),
  );
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
    cacheWarmupFrames: [sentenceMidpoints[0]],
    expectedBoundedGeometrySentenceIndices: sentences.map(
      (_sentence, index) => index,
    ),
    legibilityProfile: "mobile_720_v1",
  });
  assert.equal(proof.passed, true, JSON.stringify(proof.geometryAudit));
  assert.equal(proof.repeatedFrames.length, 1);
  assert.equal(proof.repeatedFrames[0].equal, true);
  assert.ok(
    proof.geometryAudit.boundedGeometryObservationCount >= sentences.length,
  );
  assert.deepEqual(proof.geometryAudit.boundedGeometryClippingViolations, []);
  assert.deepEqual(
    proof.geometryAudit.boundedGeometryCaptionSafeZoneViolations,
    [],
  );
});
