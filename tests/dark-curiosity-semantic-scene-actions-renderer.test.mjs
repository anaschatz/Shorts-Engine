import test from "node:test";
import assert from "node:assert/strict";

import {
  SEMANTIC_SCENE_ACTION_SCHEDULE_PROFILE_ID,
  compileSemanticSceneActionSchedule,
  compileSemanticSimpleExplainerGroupActionSchedule,
  semanticSceneActionQaPlan,
  semanticSceneActionRuntimeSource,
  semanticSceneActionStateAtFrame,
} from "../renderer/hyperframes/semantic-scene-action-schedule.mjs";
import simpleExplainerContract from "../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs";

const {
  SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS,
  SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS,
  semanticSimpleExplainerPresentationTiming,
} = simpleExplainerContract;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function createActions() {
  return [
    {
      op: "create",
      target: "module_primary",
      phase: "entry",
      preset: "reveal",
    },
    {
      op: "create",
      target: "module_support_a",
      phase: "entry",
      preset: "reveal",
    },
    {
      op: "create",
      target: "module_support_b",
      phase: "entry",
      preset: "reveal",
    },
  ];
}

function fixture() {
  const definitions = [
    {
      propositionId: "proposition_camera",
      actions: [
        ...createActions(),
        {
          op: "camera",
          target: "scene",
          phase: "develop",
          preset: "push_primary",
        },
        {
          op: "highlight",
          target: "module_support_a",
          phase: "resolve",
          preset: "pulse_once",
        },
      ],
      route: null,
    },
    {
      propositionId: "proposition_transform",
      actions: [
        ...createActions(),
        {
          op: "highlight",
          target: "module_primary",
          phase: "develop",
          preset: "pulse_once",
        },
        {
          op: "transform",
          target: "module_primary",
          phase: "resolve",
          preset: "semantic_transition",
        },
      ],
      route: null,
    },
    {
      propositionId: "proposition_route",
      actions: [
        ...createActions(),
        {
          op: "move",
          target: "module_primary",
          phase: "develop",
          preset: "follow_grounded_route",
        },
        {
          op: "camera",
          target: "scene",
          phase: "resolve",
          preset: "pull_overview",
        },
      ],
      route: {
        points: [
          [0.1, 0.8],
          [0.1, 0.8],
          [0.5, 0.4],
          [0.9, 0.2],
        ],
      },
    },
  ];
  const scenes = definitions.map((definition) => ({
    propositionId: definition.propositionId,
    sceneDsl: {
      id: `scene_dsl_${definition.propositionId}`,
      bindings: { propositionId: definition.propositionId },
      actions: definition.actions,
    },
  }));
  const sentences = definitions.map((definition, index) => ({
    id: `vs_${definition.propositionId}`,
    propositionId: definition.propositionId,
    primitiveParameters: {
      geometry: {
        direction: "forward",
        route: definition.route,
      },
    },
    sceneComposition: {
      modules: [
        { id: "module_primary", revealOrder: 0 },
        { id: "module_support_a", revealOrder: 1 },
        { id: "module_support_b", revealOrder: 2 },
      ],
    },
    wordSpan: {
      startFrame: [10, 42, 78][index],
      endFrame: [24, 60, 92][index],
    },
  }));
  const intervals = [
    { sentenceId: sentences[0].id, startFrame: 10, semanticEndFrame: 24, endFrame: 42 },
    { sentenceId: sentences[1].id, startFrame: 42, semanticEndFrame: 60, endFrame: 78 },
    { sentenceId: sentences[2].id, startFrame: 78, semanticEndFrame: 92, endFrame: 120 },
  ];
  return {
    sceneDslPlan: {
      contentHash: HASH_A,
      bindings: {
        semanticVisualSentencePlanHash: HASH_B,
        timingContextHash: HASH_C,
      },
      scenes,
    },
    sentences,
    intervals,
    fps: 30,
    durationFrames: 120,
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach((child) => assertDeepFrozen(child, seen));
}

test("scene action schedule is canonical, phase-separated and hash-bound", () => {
  const input = fixture();
  const first = compileSemanticSceneActionSchedule(input);
  const repeated = compileSemanticSceneActionSchedule(
    structuredClone(input),
  );
  assert.deepEqual(repeated, first);
  assertDeepFrozen(first);
  assert.equal(first.profileId, SEMANTIC_SCENE_ACTION_SCHEDULE_PROFILE_ID);
  assert.equal(first.bindings.sceneDslPlanHash, HASH_A);
  assert.equal(first.bindings.semanticVisualSentencePlanHash, HASH_B);
  assert.equal(first.bindings.timingContextHash, HASH_C);
  assert.equal(first.fps, 30);
  assert.equal(first.durationFrames, 120);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);

  for (const scene of first.scenes) {
    const { entry, develop, resolve } = scene.phaseWindows;
    assert.equal(entry.endFrame + 1, develop.startFrame);
    assert.equal(develop.endFrame + 1, resolve.startFrame);
    assert.equal(resolve.endFrame, scene.motionEndFrame);
    assert.equal(scene.holdStartFrame, scene.motionEndFrame + 1);
    assert.ok(scene.holdStartFrame <= scene.endFrame);
    for (const action of scene.actions) {
      const phase = scene.phaseWindows[action.phase];
      assert.ok(action.startFrame >= phase.startFrame);
      assert.ok(action.endFrame <= phase.endFrame);
      assert.ok(action.endFrame >= action.startFrame);
    }
    const creates = scene.actions.filter((action) => action.op === "create");
    assert.deepEqual(
      creates.map((action) => action.endFrame),
      creates.map(() => entry.endFrame),
    );
    assert.ok(creates[0].startFrame <= creates[1].startFrame);
    assert.ok(creates[1].startFrame <= creates[2].startFrame);
  }
});

test("all allowlisted actions produce visible bounded frame state and settle", () => {
  const schedule = compileSemanticSceneActionSchedule(fixture());
  const cameraScene = schedule.scenes[0];
  const entry = cameraScene.phaseWindows.entry;
  const develop = cameraScene.phaseWindows.develop;
  const resolve = cameraScene.phaseWindows.resolve;
  const entryStart = semanticSceneActionStateAtFrame(
    cameraScene,
    entry.startFrame,
  );
  assert.equal(entryStart.modules[0].opacity, 0);
  const entryEnd = semanticSceneActionStateAtFrame(
    cameraScene,
    entry.endFrame,
  );
  assert.ok(entryEnd.modules.every((module) => module.opacity === 1));
  const cameraMid = semanticSceneActionStateAtFrame(
    cameraScene,
    Math.floor((develop.startFrame + develop.endFrame) / 2),
  );
  assert.ok(cameraMid.cameraScale > 1);
  const highlightMid = semanticSceneActionStateAtFrame(
    cameraScene,
    Math.floor((resolve.startFrame + resolve.endFrame) / 2),
  );
  assert.ok(
    highlightMid.modules.find(
      (module) => module.id === "module_support_a",
    ).glow > 0,
  );
  const settled = semanticSceneActionStateAtFrame(
    cameraScene,
    cameraScene.endFrame - 1,
  );
  assert.equal(settled.cameraScale, 1.065);
  assert.equal(
    settled.modules.find(
      (module) => module.id === "module_support_a",
    ).glow,
    0,
  );

  const transformScene = schedule.scenes[1];
  const transformed = semanticSceneActionStateAtFrame(
    transformScene,
    transformScene.endFrame - 1,
  );
  const transformedPrimary = transformed.modules.find(
    (module) => module.id === "module_primary",
  );
  assert.equal(transformed.semanticTransitionProgress, 1);
  assert.equal(transformedPrimary.scale, 1.055);
  assert.equal(transformedPrimary.translateY, -9);
  assert.equal(transformedPrimary.glow, 0.45);
  assert.equal(cameraMid.semanticTransitionProgress, null);

  const transformAction = transformScene.actions.find(
    (action) => action.op === "transform",
  );
  assert.equal(
    semanticSceneActionStateAtFrame(
      transformScene,
      transformAction.startFrame - 1,
    ).semanticTransitionProgress,
    0,
  );
  assert.equal(
    semanticSceneActionStateAtFrame(
      transformScene,
      Math.floor(
        (transformAction.startFrame + transformAction.endFrame) / 2,
      ),
    ).semanticTransitionProgress,
    0.5,
  );
});

test("action QA covers every unique signature and every settled scene hold", () => {
  const schedule = compileSemanticSceneActionSchedule(fixture());
  const qa = semanticSceneActionQaPlan(schedule);
  const expectedSignatures = [...new Set(schedule.scenes.flatMap(
    (scene) => scene.actions.map((action) => action.signature),
  ))].sort();
  assert.deepEqual(qa.expectedActionSignatures, expectedSignatures);
  assert.equal(qa.signatureCheckpoints.length, expectedSignatures.length);
  for (const checkpoint of qa.signatureCheckpoints) {
    const scene = schedule.scenes.find((candidate) => (
      checkpoint.frame >= candidate.startFrame
      && checkpoint.frame < candidate.endFrame
      && candidate.actions.some(
        (action) => action.signature === checkpoint.signature,
      )
    ));
    assert.ok(scene, checkpoint.signature);
    assert.ok(
      semanticSceneActionStateAtFrame(scene, checkpoint.frame)
        .activeActionSignatures.includes(checkpoint.signature),
      checkpoint.signature,
    );
  }
  assert.equal(qa.settledHoldFrames.length, schedule.scenes.length);
  qa.settledHoldFrames.forEach((frame, index) => {
    assert.deepEqual(
      semanticSceneActionStateAtFrame(schedule.scenes[index], frame)
        .activeActionSignatures,
      [],
    );
  });
  assert.equal(Object.isFrozen(qa), true);
  assert.equal(qa.scheduleHash, schedule.contentHash);
});

test("simple presenter QA excludes only post-settle static transitions", () => {
  const input = fixture();
  const sentences = input.sentences.slice(0, 2);
  const visualGroup = {
    id: "simple_scene_test",
    visualKind: "state_change",
    anchorSentenceIndex: 0,
    anchorSentenceId: sentences[0].id,
    sentenceIndices: [0, 1],
    startFrame: 10,
    semanticEndFrame: 60,
    endFrame: 78,
    stepStartFrames: [10, 42],
  };
  const schedule = compileSemanticSimpleExplainerGroupActionSchedule({
    sceneDslPlan: {
      ...input.sceneDslPlan,
      scenes: input.sceneDslPlan.scenes.slice(0, 2),
    },
    sentences,
    visualGroups: [visualGroup],
    fps: input.fps,
    durationFrames: 78,
  });
  const scene = schedule.scenes[0];
  const timing = semanticSimpleExplainerPresentationTiming({
    fps: input.fps,
    startFrame: visualGroup.startFrame,
    semanticEndFrame: visualGroup.semanticEndFrame,
    endFrame: visualGroup.endFrame,
    stepStartFrames: visualGroup.stepStartFrames,
  });
  assert.equal(SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS, 0.65);
  assert.equal(SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS, 0.42);
  assert.deepEqual(scene.presentationTiming, timing);
  const initialFullProgressFrame = timing.revealSettleFrame;
  assert.deepEqual(semanticSceneActionQaPlan(schedule).readabilityHolds, [
    {
      id: "simple_scene_test_static_complement_1",
      startFrame: initialFullProgressFrame + 1,
      endFrame: timing.secondaryRevealStartFrame + 1,
    },
    {
      id: "simple_scene_test_static_complement_2",
      startFrame: timing.secondaryRevealSettleFrame + 1,
      endFrame: visualGroup.endFrame,
    },
  ]);
});

test("secondary reveal settles on a renderable frame before the next scene", () => {
  const timing = semanticSimpleExplainerPresentationTiming({
    fps: 30,
    startFrame: 0,
    semanticEndFrame: 33,
    endFrame: 33,
    stepStartFrames: [0, 20],
  });
  assert.equal(timing.secondaryRevealStartFrame, 20);
  assert.equal(timing.secondaryRevealDurationFrames, 12);
  assert.equal(timing.secondaryRevealSettleFrame, 32);
  assert.ok(timing.secondaryRevealSettleFrame < 33);
});

test("simple routes without a grounded move remain static after reveal", () => {
  const input = fixture();
  const sceneDslPlan = structuredClone(input.sceneDslPlan);
  sceneDslPlan.scenes[2].sceneDsl.actions = sceneDslPlan.scenes[2]
    .sceneDsl.actions.filter((action) => action.op !== "move");
  const schedule = compileSemanticSimpleExplainerGroupActionSchedule({
    sceneDslPlan,
    sentences: input.sentences,
    visualGroups: [{
      id: "simple_scene_route",
      visualKind: "route",
      anchorSentenceIndex: 2,
      anchorSentenceId: input.sentences[2].id,
      sentenceIndices: [2],
      startFrame: 78,
      semanticEndFrame: 92,
      endFrame: 120,
      stepStartFrames: [78],
    }],
    fps: input.fps,
    durationFrames: input.durationFrames,
  });
  assert.equal(schedule.scenes[0].actions.length, 1);
  assert.equal(schedule.scenes[0].actions[0].op, "create");
  assert.equal(schedule.scenes[0].routePoints, undefined);
});

test("grounded route motion uses deterministic piecewise geometry on random seeks", () => {
  const schedule = compileSemanticSceneActionSchedule(fixture());
  const routeScene = schedule.scenes[2];
  const move = routeScene.actions.find((action) => action.op === "move");
  const start = semanticSceneActionStateAtFrame(
    routeScene,
    move.startFrame,
  );
  const middleFrame = Math.floor((move.startFrame + move.endFrame) / 2);
  const middle = semanticSceneActionStateAtFrame(routeScene, middleFrame);
  const end = semanticSceneActionStateAtFrame(routeScene, move.endFrame);
  assert.deepEqual(start.routePoint, { x: 121.6, y: 582 });
  assert.deepEqual(end.routePoint, { x: 598.4, y: 354 });
  assert.ok(middle.routePoint.x > start.routePoint.x);
  assert.ok(middle.routePoint.y < start.routePoint.y);
  assert.ok(Number.isFinite(middle.routePoint.x));
  assert.ok(Number.isFinite(middle.routePoint.y));
  assert.ok(Math.abs(middle.routeDisplacement.x) > 0);
  assert.ok(Math.abs(middle.routeDisplacement.y) > 0);
  assert.deepEqual(end.routeDisplacement, { x: 24, y: -18 });
  const afterSeekingElsewhere = semanticSceneActionStateAtFrame(
    routeScene,
    routeScene.endFrame - 1,
  );
  assert.equal(afterSeekingElsewhere.cameraScale, 0.945);
  assert.deepEqual(
    semanticSceneActionStateAtFrame(routeScene, middleFrame),
    middle,
  );
});

test("executor fails closed for missing route, mismatched coverage and unsafe time", () => {
  const noRoute = fixture();
  noRoute.sentences[2].primitiveParameters.geometry.route = null;
  assert.throws(
    () => compileSemanticSceneActionSchedule(noRoute),
    /requires an approved route/,
  );
  const rebound = fixture();
  rebound.sceneDslPlan.scenes[0].propositionId = "proposition_other";
  assert.throws(
    () => compileSemanticSceneActionSchedule(rebound),
    /bound to another proposition/,
  );
  assert.throws(
    () => semanticSceneActionStateAtFrame(
      compileSemanticSceneActionSchedule(fixture()).scenes[0],
      Number.NaN,
    ),
    /frame input is invalid/,
  );
  const runtimeSource = semanticSceneActionRuntimeSource();
  assert.match(runtimeSource, /semanticSceneActionStateAtFrame/);
  assert.doesNotMatch(runtimeSource, /https?:|provider|model|prompt|failure/i);
});

test("phase allocation stays bounded across frame rates and short gaps", () => {
  for (const fps of [24, 30, 60]) {
    const input = fixture();
    input.fps = fps;
    const schedule = compileSemanticSceneActionSchedule(input);
    for (const scene of schedule.scenes) {
      assert.equal(
        scene.phaseWindows.entry.endFrame + 1,
        scene.phaseWindows.develop.startFrame,
      );
      assert.equal(
        scene.phaseWindows.develop.endFrame + 1,
        scene.phaseWindows.resolve.startFrame,
      );
      assert.ok(scene.motionEndFrame < scene.endFrame);
      assert.ok(scene.holdStartFrame >= scene.semanticEndFrame);
    }
  }
  const noGap = fixture();
  noGap.intervals[0].endFrame = noGap.intervals[0].semanticEndFrame;
  const schedule = compileSemanticSceneActionSchedule(noGap);
  assert.equal(
    schedule.scenes[0].holdStartFrame,
    schedule.scenes[0].endFrame,
  );
  const finalState = semanticSceneActionStateAtFrame(
    schedule.scenes[0],
    schedule.scenes[0].endFrame - 1,
  );
  assert.ok(finalState.modules.every((module) => module.opacity === 1));

  const exactRatio = fixture();
  exactRatio.intervals[0] = {
    startFrame: 0,
    semanticEndFrame: 30,
    endFrame: 36,
  };
  const exactScene = compileSemanticSceneActionSchedule(exactRatio).scenes[0];
  assert.deepEqual(
    Object.values(exactScene.phaseWindows).map(
      (window) => window.endFrame - window.startFrame + 1,
    ),
    [9, 12, 9],
  );
});

test("very short cues degrade deterministically and keep pulse visible", () => {
  for (const frameCount of [1, 2]) {
    const input = fixture();
    input.intervals[0] = {
      startFrame: 10,
      semanticEndFrame: 10 + frameCount,
      endFrame: 10 + frameCount,
    };
    const scene = compileSemanticSceneActionSchedule(input).scenes[0];
    const highlight = scene.actions.find((action) => (
      action.op === "highlight"
    ));
    const activeFrames = Array.from(
      { length: frameCount },
      (_, index) => 10 + index,
    );
    assert.ok(activeFrames.some((frame) => (
      semanticSceneActionStateAtFrame(scene, frame)
        .modules.find((module) => module.id === "module_support_a")
        .glow >= 0.99
    )));
    assert.equal(
      semanticSceneActionStateAtFrame(scene, scene.holdStartFrame)
        .modules.find((module) => module.id === "module_support_a")
        .glow,
      0,
    );
    assert.ok(highlight.endFrame < scene.holdStartFrame);
  }

  const sixFrames = fixture();
  sixFrames.intervals[0] = {
    startFrame: 0,
    semanticEndFrame: 6,
    endFrame: 8,
  };
  const scene = compileSemanticSceneActionSchedule(sixFrames).scenes[0];
  const glow = Array.from({ length: 8 }, (_, frame) => (
    semanticSceneActionStateAtFrame(scene, frame)
      .modules.find((module) => module.id === "module_support_a")
      .glow
  ));
  assert.deepEqual(glow, [0, 0, 0, 0, 1, 0, 0, 0]);
});
