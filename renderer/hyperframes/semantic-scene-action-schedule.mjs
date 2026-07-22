import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  semanticSimpleExplainerPresentationTiming,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs",
);

export const SEMANTIC_SCENE_ACTION_SCHEDULE_PROFILE_ID =
  "dark_curiosity_semantic_scene_action_schedule_v1";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,179}$/;
const MODULE_TARGETS = Object.freeze([
  "module_primary",
  "module_support_a",
  "module_support_b",
]);
const ACTION_RULES = Object.freeze({
  create: Object.freeze({
    targets: MODULE_TARGETS,
    phases: Object.freeze(["entry"]),
    presets: Object.freeze(["reveal"]),
  }),
  move: Object.freeze({
    targets: Object.freeze(["module_primary"]),
    phases: Object.freeze(["develop"]),
    presets: Object.freeze(["follow_grounded_route"]),
  }),
  transform: Object.freeze({
    targets: Object.freeze(["module_primary"]),
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["semantic_transition"]),
  }),
  highlight: Object.freeze({
    targets: MODULE_TARGETS,
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["pulse_once"]),
  }),
  camera: Object.freeze({
    targets: Object.freeze(["scene"]),
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["push_primary", "pull_overview"]),
  }),
});
const PHASES = Object.freeze(["entry", "develop", "resolve"]);
const PHASE_WEIGHTS = Object.freeze([3, 4, 3]);
const CREATE_STAGGER = Object.freeze({
  module_primary: 0,
  module_support_a: 0.18,
  module_support_b: 0.36,
});

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function safeId(value, label) {
  if (
    typeof value !== "string"
    || !SAFE_ID.test(value)
    || value !== value.trim()
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is out of range.`);
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function normalizedAction(action, sceneIndex, actionIndex) {
  plainObject(action, `Scene ${sceneIndex} action ${actionIndex}`);
  const op = safeId(action.op, `Scene ${sceneIndex} action ${actionIndex} op`);
  const target = safeId(
    action.target,
    `Scene ${sceneIndex} action ${actionIndex} target`,
  );
  const phase = safeId(
    action.phase,
    `Scene ${sceneIndex} action ${actionIndex} phase`,
  );
  const preset = safeId(
    action.preset,
    `Scene ${sceneIndex} action ${actionIndex} preset`,
  );
  const rule = ACTION_RULES[op];
  if (
    !rule
    || !rule.targets.includes(target)
    || !rule.phases.includes(phase)
    || !rule.presets.includes(preset)
  ) {
    fail(`Scene ${sceneIndex} action ${actionIndex} is unsupported.`);
  }
  return { op, target, phase, preset };
}

function allocatePhaseLengths(frameCount, minimumPhaseFrames) {
  if (frameCount < PHASES.length) {
    return null;
  }
  const minimum = Math.max(
    1,
    Math.min(minimumPhaseFrames, Math.floor(frameCount / PHASES.length)),
  );
  const weightTotal = PHASE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const targets = PHASE_WEIGHTS.map(
    (weight) => frameCount * weight / weightTotal,
  );
  const lengths = targets.map(
    (target) => Math.max(minimum, Math.floor(target)),
  );
  while (lengths.reduce((sum, length) => sum + length, 0) < frameCount) {
    const candidate = lengths
      .map((length, index) => ({
        index,
        deficit: targets[index] - length,
      }))
      .sort((left, right) => (
        right.deficit - left.deficit
        || left.index - right.index
      ))[0];
    lengths[candidate.index] += 1;
  }
  while (lengths.reduce((sum, length) => sum + length, 0) > frameCount) {
    const candidate = lengths
      .map((length, index) => ({
        index,
        removable: length > minimum,
        excess: length - targets[index],
      }))
      .filter((entry) => entry.removable)
      .sort((left, right) => (
        right.excess - left.excess
        || right.index - left.index
      ))[0];
    if (!candidate) fail("Scene action phases cannot satisfy their bounds.");
    lengths[candidate.index] -= 1;
  }
  return lengths;
}

function degradedPhaseWindows(startFrame, frameCount) {
  const frames = Array.from(
    { length: frameCount },
    (_, index) => startFrame + index,
  );
  const phaseFrames = frameCount === 1
    ? [frames[0], frames[0], frames[0]]
    : [frames[0], frames[0], frames[1]];
  const windows = Object.fromEntries(PHASES.map((phase, index) => {
    const frame = phaseFrames[index];
    return [phase, { startFrame: frame, endFrame: frame }];
  }));
  return {
    windows,
    motionEndFrame: frames.at(-1),
    holdStartFrame: frames.at(-1) + 1,
  };
}

function phaseWindows(interval, fps) {
  const minimumPhaseFrames = Math.ceil(fps * 0.12);
  const minimumHoldFrames = Math.ceil(fps * 0.2);
  const postRollCap = Math.ceil(fps * 0.35);
  const gapFrames = interval.endFrame - interval.semanticEndFrame;
  const postRollFrames = Math.min(
    Math.max(0, gapFrames - minimumHoldFrames),
    postRollCap,
  );
  const motionEndExclusive = interval.semanticEndFrame + postRollFrames;
  const motionFrameCount = motionEndExclusive - interval.startFrame;
  if (motionFrameCount < PHASES.length) {
    return degradedPhaseWindows(interval.startFrame, motionFrameCount);
  }
  const lengths = allocatePhaseLengths(
    motionFrameCount,
    minimumPhaseFrames,
  );
  let cursor = interval.startFrame;
  const windows = {};
  PHASES.forEach((phase, index) => {
    const startFrame = cursor;
    const endFrame = startFrame + lengths[index] - 1;
    windows[phase] = { startFrame, endFrame };
    cursor = endFrame + 1;
  });
  return {
    windows,
    motionEndFrame: cursor - 1,
    holdStartFrame: cursor,
  };
}

function actionWindow(action, phases) {
  const phase = phases.windows[action.phase];
  if (!phase) fail("Scene action phase window is unsupported.");
  if (action.op !== "create") return { ...phase };
  const phaseLength = phase.endFrame - phase.startFrame + 1;
  const stagger = CREATE_STAGGER[action.target];
  if (stagger === undefined) fail("Scene create target is unsupported.");
  return {
    startFrame: Math.min(
      phase.endFrame,
      phase.startFrame + Math.floor((phaseLength - 1) * stagger),
    ),
    endFrame: phase.endFrame,
  };
}

function routePointsForSentence(sentence, actions, sceneIndex) {
  if (!actions.some((action) => action.op === "move")) return null;
  const route = sentence.primitiveParameters?.geometry?.route;
  if (
    !route
    || !Array.isArray(route.points)
    || route.points.length < 2
    || route.points.length > 12
  ) {
    fail(`Scene ${sceneIndex} move action requires an approved route.`);
  }
  const points = route.points.map((point, pointIndex) => {
    if (
      !Array.isArray(point)
      || point.length !== 2
      || point.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      fail(`Scene ${sceneIndex} route point ${pointIndex} is invalid.`);
    }
    return [
      Number((62 + point[0] * 596).toFixed(5)),
      Number((278 + point[1] * 380).toFixed(5)),
    ];
  });
  return sentence.primitiveParameters.geometry.direction === "reverse"
    ? points.reverse()
    : points;
}

export function compileSemanticSceneActionSchedule({
  sceneDslPlan,
  sentences,
  intervals,
  fps,
  durationFrames,
} = {}) {
  plainObject(sceneDslPlan, "Scene DSL plan");
  const normalizedFps = integer(fps, "Scene action schedule fps", 1, 120);
  const normalizedDurationFrames = integer(
    durationFrames,
    "Scene action schedule duration",
    2,
    21600,
  );
  if (
    !Array.isArray(sceneDslPlan.scenes)
    || !sceneDslPlan.scenes.length
    || sceneDslPlan.scenes.length > 20
    || !Array.isArray(sentences)
    || !Array.isArray(intervals)
    || sentences.length !== sceneDslPlan.scenes.length
    || intervals.length !== sceneDslPlan.scenes.length
  ) {
    fail("Scene action schedule requires aligned bounded scenes.");
  }
  const sceneDslPlanHash = hash(
    sceneDslPlan.contentHash,
    "Scene DSL plan content hash",
  );
  const semanticVisualSentencePlanHash = hash(
    sceneDslPlan.bindings?.semanticVisualSentencePlanHash,
    "Scene DSL sentence plan hash",
  );
  const timingContextHash = hash(
    sceneDslPlan.bindings?.timingContextHash,
    "Scene DSL timing context hash",
  );
  const scenes = sceneDslPlan.scenes.map((scene, sceneIndex) => {
    plainObject(scene, `Scene ${sceneIndex}`);
    plainObject(scene.sceneDsl, `Scene ${sceneIndex} DSL`);
    const sentence = plainObject(sentences[sceneIndex], `Sentence ${sceneIndex}`);
    const intervalInput = plainObject(
      intervals[sceneIndex],
      `Sentence ${sceneIndex} interval`,
    );
    const propositionId = safeId(
      sentence.propositionId,
      `Sentence ${sceneIndex} proposition`,
    );
    if (
      scene.propositionId !== propositionId
      || scene.sceneDsl.bindings?.propositionId !== propositionId
    ) {
      fail(`Scene ${sceneIndex} is bound to another proposition.`);
    }
    const startFrame = integer(
      intervalInput.startFrame,
      `Sentence ${sceneIndex} start frame`,
      0,
      normalizedDurationFrames - 1,
    );
    const semanticEndFrame = integer(
      intervalInput.semanticEndFrame,
      `Sentence ${sceneIndex} semantic end frame`,
      startFrame + 1,
      normalizedDurationFrames,
    );
    const endFrame = integer(
      intervalInput.endFrame,
      `Sentence ${sceneIndex} end frame`,
      semanticEndFrame,
      normalizedDurationFrames,
    );
    const interval = { startFrame, semanticEndFrame, endFrame };
    if (
      !Array.isArray(scene.sceneDsl.actions)
      || scene.sceneDsl.actions.length < 4
      || scene.sceneDsl.actions.length > 7
    ) {
      fail(`Scene ${sceneIndex} requires bounded actions.`);
    }
    const normalizedActions = scene.sceneDsl.actions.map(
      (action, actionIndex) => (
        normalizedAction(action, sceneIndex, actionIndex)
      ),
    );
    const phases = phaseWindows(interval, normalizedFps);
    const actions = normalizedActions.map((normalized, actionIndex) => {
      const window = actionWindow(normalized, phases);
      return {
        id: `scene_action_${sceneIndex}_${actionIndex}`,
        signature: [
          normalized.op,
          normalized.target,
          normalized.phase,
          normalized.preset,
        ].join(":"),
        ...normalized,
        ...window,
      };
    });
    const routePoints = routePointsForSentence(
      sentence,
      normalizedActions,
      sceneIndex,
    );
    return {
      sentenceIndex: sceneIndex,
      sentenceId: safeId(sentence.id, `Sentence ${sceneIndex} id`),
      propositionId,
      sceneDslId: safeId(scene.sceneDsl.id, `Scene ${sceneIndex} DSL id`),
      startFrame,
      semanticEndFrame,
      endFrame,
      motionEndFrame: phases.motionEndFrame,
      holdStartFrame: phases.holdStartFrame,
      phaseWindows: phases.windows,
      ...(routePoints ? { routePoints } : {}),
      actions,
    };
  });
  const normalized = {
    profileId: SEMANTIC_SCENE_ACTION_SCHEDULE_PROFILE_ID,
    bindings: {
      sceneDslPlanHash,
      semanticVisualSentencePlanHash,
      timingContextHash,
    },
    fps: normalizedFps,
    durationFrames: normalizedDurationFrames,
    scenes,
  };
  return deepFreeze({
    ...normalized,
    contentHash: contentHash(normalized),
  });
}

function simpleExplainerReadabilityHolds(
  group,
  action,
  presentationTiming,
) {
  const domainStartFrame = group.startFrame + 1;
  const domainEndFrame = group.endFrame;
  const actionMotionStartFrame = action.endFrame === action.startFrame
    ? action.startFrame
    : action.startFrame + 1;
  const motionRanges = [
    {
      startFrame: group.startFrame + 1,
      endFrame: presentationTiming.revealSettleFrame + 1,
    },
    ...(action.op === "create"
      ? []
      : [{
        startFrame: actionMotionStartFrame,
        endFrame: action.endFrame + 1,
      }]),
    ...(presentationTiming.secondaryRevealStartFrame === null
      ? []
      : [{
        startFrame: presentationTiming.secondaryRevealStartFrame + 1,
        endFrame: presentationTiming.secondaryRevealSettleFrame + 1,
      }]),
  ].map((range) => ({
    startFrame: Math.max(domainStartFrame, range.startFrame),
    endFrame: Math.min(domainEndFrame, range.endFrame),
  })).filter((range) => range.startFrame < range.endFrame)
    .sort((left, right) => (
      left.startFrame - right.startFrame
      || left.endFrame - right.endFrame
    ));
  const mergedMotionRanges = [];
  for (const range of motionRanges) {
    const previous = mergedMotionRanges.at(-1);
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      mergedMotionRanges.push({ ...range });
    }
  }
  const holds = [];
  let cursor = domainStartFrame;
  for (const range of mergedMotionRanges) {
    if (cursor < range.startFrame) {
      holds.push({ startFrame: cursor, endFrame: range.startFrame });
    }
    cursor = Math.max(cursor, range.endFrame);
  }
  if (cursor < domainEndFrame) {
    holds.push({ startFrame: cursor, endFrame: domainEndFrame });
  }
  return holds.map((hold, index) => ({
    id: `${group.id}_static_complement_${index + 1}`,
    ...hold,
  }));
}

export function compileSemanticSimpleExplainerGroupActionSchedule({
  sceneDslPlan,
  sentences,
  visualGroups,
  fps,
  durationFrames,
} = {}) {
  plainObject(sceneDslPlan, "Simple-explainer Scene DSL plan");
  if (
    !Array.isArray(sentences)
    || !Array.isArray(visualGroups)
    || !visualGroups.length
    || visualGroups.length > 20
    || !Array.isArray(sceneDslPlan.scenes)
    || sceneDslPlan.scenes.length !== sentences.length
  ) {
    fail("Simple-explainer action schedule requires aligned visual groups.");
  }
  const selectedScenes = [];
  const selectedSentences = [];
  const groupIntervals = [];
  for (const [groupIndex, groupInput] of visualGroups.entries()) {
    const group = plainObject(
      groupInput,
      `Simple-explainer visual group ${groupIndex}`,
    );
    const anchorSentenceIndex = integer(
      group.anchorSentenceIndex,
      `Simple-explainer visual group ${groupIndex} anchor`,
      0,
      sentences.length - 1,
    );
    const sentence = sentences[anchorSentenceIndex];
    const scene = sceneDslPlan.scenes[anchorSentenceIndex];
    if (!sentence || !scene) {
      fail(`Simple-explainer visual group ${groupIndex} driver is unavailable.`);
    }
    selectedScenes.push(scene);
    selectedSentences.push(sentence);
    groupIntervals.push({
      sentenceId: sentence.id,
      startFrame: group.startFrame,
      semanticEndFrame: group.semanticEndFrame,
      endFrame: group.endFrame,
    });
  }
  const compiled = compileSemanticSceneActionSchedule({
    sceneDslPlan: {
      ...sceneDslPlan,
      scenes: selectedScenes,
    },
    sentences: selectedSentences,
    intervals: groupIntervals,
    fps,
    durationFrames,
  });
  const scenes = compiled.scenes.map((scene, groupIndex) => {
    const group = visualGroups[groupIndex];
    const { routePoints: compiledRoutePoints, ...sceneWithoutRoute } = scene;
    const primaryCreate = scene.actions.find((action) => (
      action.op === "create" && action.target === "module_primary"
    ));
    const groundedRouteMove = group.visualKind === "route"
      ? scene.actions.find((action) => (
        action.op === "move" && action.target === "module_primary"
      ))
      : null;
    const sourceAction = groundedRouteMove || primaryCreate;
    if (!sourceAction) {
      fail(`Simple-explainer visual group ${groupIndex} has no single motion channel.`);
    }
    const presentationTiming = semanticSimpleExplainerPresentationTiming({
      fps: compiled.fps,
      startFrame: group.startFrame,
      semanticEndFrame: group.semanticEndFrame,
      endFrame: group.endFrame,
      stepStartFrames: group.stepStartFrames,
    });
    const selectedAction = sourceAction.op === "move"
      ? {
        ...sourceAction,
        startFrame: Math.max(
          sourceAction.startFrame,
          presentationTiming.revealSettleFrame,
        ),
      }
      : sourceAction;
    if (selectedAction.startFrame > selectedAction.endFrame) {
      fail(`Simple-explainer visual group ${groupIndex} cannot serialize its motion.`);
    }
    const actions = [selectedAction];
    const hasMoveAction = selectedAction.op === "move";
    // Benchmark QA ranges are transition-target intervals. The complement
    // starts after each full-progress frame, so final reveal/action steps and
    // the scene-boundary transition remain analyzed.
    const readabilityHolds = simpleExplainerReadabilityHolds(
      group,
      selectedAction,
      presentationTiming,
    );
    return {
      ...sceneWithoutRoute,
      sentenceIndex: group.anchorSentenceIndex,
      visualSceneId: safeId(
        group.id,
        `Simple-explainer visual group ${groupIndex} id`,
      ),
      groupIndex,
      anchorSentenceIndex: group.anchorSentenceIndex,
      anchorSentenceId: safeId(
        group.anchorSentenceId,
        `Simple-explainer visual group ${groupIndex} anchor id`,
      ),
      sentenceIndices: group.sentenceIndices.map((sentenceIndex) => (
        integer(
          sentenceIndex,
          `Simple-explainer visual group ${groupIndex} sentence index`,
          0,
          sentences.length - 1,
        )
      )),
      presentationTiming,
      readabilityHolds,
      ...(hasMoveAction && compiledRoutePoints
        ? { routePoints: compiledRoutePoints }
        : {}),
      actions,
    };
  });
  const normalized = {
    profileId: compiled.profileId,
    bindings: compiled.bindings,
    fps: compiled.fps,
    durationFrames: compiled.durationFrames,
    scenes,
  };
  return deepFreeze({
    ...normalized,
    contentHash: contentHash(normalized),
  });
}

export function semanticSceneActionStateAtFrame(sceneSchedule, rawFrame) {
  if (
    !sceneSchedule
    || typeof sceneSchedule !== "object"
    || !Array.isArray(sceneSchedule.actions)
    || !Number.isFinite(rawFrame)
  ) {
    throw new TypeError("Semantic scene action frame input is invalid.");
  }
  const clamp = (value, minimum = 0, maximum = 1) => (
    Math.max(minimum, Math.min(maximum, value))
  );
  const ease = (value) => {
    const bounded = clamp(value);
    return bounded * bounded * (3 - 2 * bounded);
  };
  const progressAt = (action, frame) => {
    if (
      !Number.isInteger(action.startFrame)
      || !Number.isInteger(action.endFrame)
      || action.endFrame < action.startFrame
    ) {
      throw new TypeError("Semantic scene action window is invalid.");
    }
    if (frame < action.startFrame) return 0;
    if (action.endFrame === action.startFrame || frame >= action.endFrame) {
      return 1;
    }
    return ease(
      (frame - action.startFrame)
        / Math.max(1, action.endFrame - action.startFrame),
    );
  };
  const routePointAt = (points, progress) => {
    if (
      !Array.isArray(points)
      || points.length < 2
      || points.some((point) => (
        !Array.isArray(point)
        || point.length !== 2
        || point.some((value) => !Number.isFinite(value))
      ))
    ) {
      throw new TypeError("Semantic scene route points are invalid.");
    }
    const segments = [];
    let totalLength = 0;
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      segments.push({ from, to, length });
      totalLength += length;
    }
    if (totalLength <= 1e-9) {
      return { x: points[0][0], y: points[0][1] };
    }
    let remaining = clamp(progress) * totalLength;
    for (const segment of segments) {
      if (segment.length <= 1e-9) continue;
      if (remaining <= segment.length) {
        const local = remaining / segment.length;
        return {
          x: segment.from[0] + (segment.to[0] - segment.from[0]) * local,
          y: segment.from[1] + (segment.to[1] - segment.from[1]) * local,
        };
      }
      remaining -= segment.length;
    }
    return {
      x: points.at(-1)[0],
      y: points.at(-1)[1],
    };
  };
  const frame = Math.floor(rawFrame + 1e-7);
  const moduleIds = [
    "module_primary",
    "module_support_a",
    "module_support_b",
  ];
  const modules = Object.fromEntries(moduleIds.map((id) => [id, {
    id,
    opacity: 1,
    translateX: 0,
    translateY: 0,
    scale: 1,
    glow: 0,
  }]));
  let cameraScale = 1;
  let routeProgress = null;
  let semanticTransitionProgress = null;
  const activeActionIds = [];
  const activeActionSignatures = [];
  const actionStates = [];

  for (const action of sceneSchedule.actions) {
    if (!action || typeof action !== "object") {
      throw new TypeError("Semantic scene action is invalid.");
    }
    const progress = progressAt(action, frame);
    const active = frame >= action.startFrame && frame <= action.endFrame;
    if (active) {
      activeActionIds.push(action.id);
      activeActionSignatures.push(action.signature);
    }
    let pulse = 0;
    if (action.op === "create" && action.preset === "reveal") {
      const module = modules[action.target];
      if (!module) throw new TypeError("Semantic scene create target is invalid.");
      module.opacity *= progress;
      module.translateY += 22 * (1 - progress);
      module.scale *= 0.96 + 0.04 * progress;
    } else if (
      action.op === "highlight"
      && action.preset === "pulse_once"
    ) {
      const module = modules[action.target];
      if (!module) {
        throw new TypeError("Semantic scene highlight target is invalid.");
      }
      const windowFrames = action.endFrame - action.startFrame + 1;
      pulse = windowFrames <= 2
        ? (active && frame === action.startFrame ? 1 : 0)
        : (
          progress <= 0.42
            ? ease(progress / 0.42)
            : ease((1 - progress) / 0.58)
        );
      module.scale *= 1 + 0.07 * pulse;
      module.glow = Math.max(module.glow, pulse);
    } else if (
      action.op === "transform"
      && action.target === "module_primary"
      && action.preset === "semantic_transition"
    ) {
      semanticTransitionProgress = progress;
      modules.module_primary.scale *= 1 + 0.055 * progress;
      modules.module_primary.translateY -= 9 * progress;
      modules.module_primary.glow = Math.max(
        modules.module_primary.glow,
        0.45 * progress,
      );
    } else if (
      action.op === "move"
      && action.target === "module_primary"
      && action.preset === "follow_grounded_route"
    ) {
      routeProgress = progress;
    } else if (action.op === "camera" && action.target === "scene") {
      if (action.preset === "push_primary") {
        cameraScale *= 1 + 0.065 * progress;
      } else if (action.preset === "pull_overview") {
        cameraScale *= 1 - 0.055 * progress;
      } else {
        throw new TypeError("Semantic scene camera preset is invalid.");
      }
    } else {
      throw new TypeError("Semantic scene action is unsupported.");
    }
    actionStates.push({
      id: action.id,
      signature: action.signature,
      phase: action.phase,
      progress: Number(progress.toFixed(5)),
      pulse: Number(pulse.toFixed(5)),
      active,
    });
  }

  const routePoint = routeProgress === null
    ? null
    : routePointAt(sceneSchedule.routePoints, routeProgress);
  const routeDisplacement = routePoint === null
    ? null
    : {
      x: clamp(
        (routePoint.x - sceneSchedule.routePoints[0][0]) / 596 * 30,
        -30,
        30,
      ),
      y: clamp(
        (routePoint.y - sceneSchedule.routePoints[0][1]) / 380 * 30,
        -30,
        30,
      ),
    };
  return {
    cameraScale: Number(cameraScale.toFixed(5)),
    semanticTransitionProgress: semanticTransitionProgress === null
      ? null
      : Number(semanticTransitionProgress.toFixed(5)),
    routeProgress: routeProgress === null
      ? null
      : Number(routeProgress.toFixed(5)),
    routePoint: routePoint === null
      ? null
      : {
        x: Number(routePoint.x.toFixed(5)),
        y: Number(routePoint.y.toFixed(5)),
      },
    routeDisplacement: routeDisplacement === null
      ? null
      : {
        x: Number(routeDisplacement.x.toFixed(5)),
        y: Number(routeDisplacement.y.toFixed(5)),
      },
    modules: moduleIds.map((id) => {
      const module = modules[id];
      return {
        id,
        opacity: Number(clamp(module.opacity).toFixed(5)),
        translateX: Number(module.translateX.toFixed(5)),
        translateY: Number(module.translateY.toFixed(5)),
        scale: Number(module.scale.toFixed(5)),
        glow: Number(clamp(module.glow).toFixed(5)),
      };
    }),
    activeActionIds,
    activeActionSignatures,
    actionStates,
  };
}

export function semanticSceneActionQaPlan(schedule) {
  plainObject(schedule, "Scene action schedule QA input");
  if (
    schedule.profileId !== SEMANTIC_SCENE_ACTION_SCHEDULE_PROFILE_ID
    || !Array.isArray(schedule.scenes)
    || !schedule.scenes.length
    || schedule.scenes.length > 20
  ) fail("Scene action schedule QA input is invalid.");

  const signatureFrames = new Map();
  const settledHoldFrames = [];
  const readabilityHolds = [];
  const presentationFrames = [];
  for (const [sceneIndex, scene] of schedule.scenes.entries()) {
    plainObject(scene, `Scene action QA ${sceneIndex}`);
    if (!Array.isArray(scene.actions) || !scene.actions.length) {
      fail(`Scene action QA ${sceneIndex} requires actions.`);
    }
    for (const action of scene.actions) {
      if (!signatureFrames.has(action.signature)) {
        signatureFrames.set(
          action.signature,
          Math.floor((action.startFrame + action.endFrame) / 2),
        );
      }
    }
    const secondaryStart = scene.presentationTiming?.secondaryRevealStartFrame;
    const secondarySettle = scene.presentationTiming?.secondaryRevealSettleFrame;
    if (secondaryStart !== null && secondaryStart !== undefined) {
      if (
        !Number.isInteger(secondaryStart)
        || !Number.isInteger(secondarySettle)
        || secondaryStart < scene.startFrame
        || secondarySettle < secondaryStart
        || secondarySettle > scene.semanticEndFrame
      ) fail(`Scene action QA ${sceneIndex} secondary timing is invalid.`);
      presentationFrames.push(
        secondaryStart,
        Math.floor((secondaryStart + secondarySettle) / 2),
        secondarySettle,
      );
    }
    const holdFrame = Math.min(
      scene.endFrame - 1,
      Math.max(scene.startFrame, scene.holdStartFrame),
    );
    if (holdFrame >= scene.holdStartFrame && holdFrame < scene.endFrame) {
      settledHoldFrames.push(holdFrame);
    }
    if (scene.readabilityHolds !== undefined) {
      if (!Array.isArray(scene.readabilityHolds)) {
        fail(`Scene action QA ${sceneIndex} readability holds are invalid.`);
      }
      for (const [holdIndex, holdInput] of scene.readabilityHolds.entries()) {
        const hold = plainObject(
          holdInput,
          `Scene action QA ${sceneIndex} readability hold ${holdIndex}`,
        );
        const id = safeId(
          hold.id,
          `Scene action QA ${sceneIndex} readability hold ${holdIndex} id`,
        );
        const startFrame = integer(
          hold.startFrame,
          `Scene action QA ${sceneIndex} readability hold ${holdIndex} start`,
          scene.startFrame + 1,
          scene.endFrame - 1,
        );
        const endFrame = integer(
          hold.endFrame,
          `Scene action QA ${sceneIndex} readability hold ${holdIndex} end`,
          startFrame + 1,
          scene.endFrame,
        );
        readabilityHolds.push({ id, startFrame, endFrame });
      }
    }
  }
  if (
    new Set(readabilityHolds.map((hold) => hold.id)).size
      !== readabilityHolds.length
    || readabilityHolds.some((hold, index) => (
      index > 0 && hold.startFrame < readabilityHolds[index - 1].endFrame
    ))
  ) fail("Scene action QA readability holds are invalid.");

  const first = schedule.scenes[0];
  const entry = first.phaseWindows.entry;
  const develop = first.phaseWindows.develop;
  const resolve = first.phaseWindows.resolve;
  const phaseFrames = [
    entry.startFrame,
    Math.floor((entry.startFrame + entry.endFrame) / 2),
    entry.endFrame,
    Math.floor((develop.startFrame + develop.endFrame) / 2),
    Math.floor((resolve.startFrame + resolve.endFrame) / 2),
  ];
  const expectedActionSignatures = [...signatureFrames.keys()].sort();
  if (expectedActionSignatures.length > 20) {
    fail("Scene action QA signature budget exceeded.");
  }
  return deepFreeze({
    scheduleHash: hash(schedule.contentHash, "Scene action schedule QA hash"),
    expectedActionSignatures,
    signatureCheckpoints: expectedActionSignatures.map((signature) => ({
      signature,
      frame: signatureFrames.get(signature),
    })),
    phaseFrames: [...new Set([...phaseFrames, ...presentationFrames])],
    settledHoldFrames: [...new Set(settledHoldFrames)],
    readabilityHolds,
  });
}

export function semanticSceneActionRuntimeSource() {
  return `const semanticSceneActionStateAtFrame=${
    semanticSceneActionStateAtFrame.toString()
  };`;
}
