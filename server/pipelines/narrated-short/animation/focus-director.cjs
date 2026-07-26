const { AppError } = require("../../../errors.cjs");

const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const FOCUS_PROFILE = "single_primary_v1";
const MINIMUM_SETTLE_FRAMES = 18;
const AMBIENT_ENTITY_IDS = Object.freeze(["deep_background"]);

function fail(field, details = {}) {
  throw new AppError("ANIMATION_FOCUS_INVALID", "Animation focus plan is invalid.", 409, { field, ...details });
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) if (!supported.has(key)) fail(`${field}.${key}`);
}

function id(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(field);
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(field);
  return value;
}

function opacity(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(field);
  return value;
}

function validateSemanticMotionConcurrency(value, entityIds) {
  exactKeys(value, ["profile", "maxPrimaryActions", "maxSupportingActions", "minimumSettleFrames", "ambientEntityIds"], "visualStateGraph.semanticMotionConcurrency");
  if (value.profile !== FOCUS_PROFILE || value.maxPrimaryActions !== 1) fail("visualStateGraph.semanticMotionConcurrency.profile");
  integer(value.maxSupportingActions, "visualStateGraph.semanticMotionConcurrency.maxSupportingActions", 0, 6);
  if (value.minimumSettleFrames !== MINIMUM_SETTLE_FRAMES) fail("visualStateGraph.semanticMotionConcurrency.minimumSettleFrames");
  if (!Array.isArray(value.ambientEntityIds) || value.ambientEntityIds.length > 4) fail("visualStateGraph.semanticMotionConcurrency.ambientEntityIds");
  const seen = new Set();
  for (const [index, entityId] of value.ambientEntityIds.entries()) {
    id(entityId, `visualStateGraph.semanticMotionConcurrency.ambientEntityIds[${index}]`);
    if (!entityIds.has(entityId) || seen.has(entityId)) fail("visualStateGraph.semanticMotionConcurrency.ambientEntityIds");
    seen.add(entityId);
  }
  if (JSON.stringify(value.ambientEntityIds) !== JSON.stringify(AMBIENT_ENTITY_IDS)) fail("visualStateGraph.semanticMotionConcurrency.ambientEntityIds");
  return value;
}

function focusMotionBinding(interval, context = {}) {
  const ambientEntityIds = new Set(context.ambientEntityIds || []);
  const operations = (context.scenes || [])
    .flatMap((scene) => scene.operations || [])
    .filter((operation) => !ambientEntityIds.has(operation.targetId)
      && Number.isInteger(operation.from?.resolvedFrame)
      && Number.isInteger(operation.to?.resolvedFrame)
      && operation.from.resolvedFrame >= interval.startFrame
      && operation.from.resolvedFrame < interval.endFrame);
  const transitions = (context.stateTransitions || [])
    .filter((transition) => Number.isInteger(transition.fromAnchor?.resolvedFrame)
      && Number.isInteger(transition.toAnchor?.resolvedFrame)
      && transition.fromAnchor.resolvedFrame >= interval.startFrame
      && transition.fromAnchor.resolvedFrame < interval.endFrame);
  const motionEnds = [
    ...operations.map((operation) => operation.to.resolvedFrame),
    ...transitions.map((transition) => transition.toAnchor.resolvedFrame),
  ];
  return Object.freeze({
    actualMotionEnd: motionEnds.length ? Math.max(...motionEnds) : null,
    operationKeys: Object.freeze(operations.map((operation) => `${operation.op}:${operation.targetId}`)),
    transitionIds: Object.freeze(transitions.map((transition) => transition.id)),
  });
}

function validateFocusDirector(graph, context = {}) {
  const durationFrames = Number(context.durationFrames);
  const entityIds = new Set(context.entityIds || []);
  const states = new Map((graph.states || []).map((state) => [state.id, state]));
  const concurrency = validateSemanticMotionConcurrency(graph.semanticMotionConcurrency, entityIds);
  if (!Array.isArray(graph.focusIntervals) || !graph.focusIntervals.length || graph.focusIntervals.length > 24) fail("visualStateGraph.focusIntervals");

  const intervalIds = new Set();
  let cursor = 0;
  const normalized = graph.focusIntervals.map((interval, index) => {
    const field = `visualStateGraph.focusIntervals[${index}]`;
    exactKeys(interval, ["id", "stateId", "claimId", "primaryEntityId", "supportingEntityIds", "startFrame", "settleFrame", "endFrame", "supportingOpacity", "dimmedOpacity"], field);
    const intervalId = id(interval.id, `${field}.id`);
    if (intervalIds.has(intervalId)) fail(`${field}.id`);
    intervalIds.add(intervalId);
    const stateId = id(interval.stateId, `${field}.stateId`);
    const state = states.get(stateId);
    if (!state) fail(`${field}.stateId`);
    const claimId = id(interval.claimId, `${field}.claimId`);
    if (!state.claimIds.includes(claimId)) fail(`${field}.claimId`);
    const primaryEntityId = id(interval.primaryEntityId, `${field}.primaryEntityId`);
    const allowedStateEntities = new Set([state.primaryEntityId, ...state.supportingEntityIds]);
    if (!entityIds.has(primaryEntityId) || !allowedStateEntities.has(primaryEntityId)) fail(`${field}.primaryEntityId`);
    if (!Array.isArray(interval.supportingEntityIds) || interval.supportingEntityIds.length > concurrency.maxSupportingActions) fail(`${field}.supportingEntityIds`);
    const supporting = new Set();
    for (const [supportIndex, supportingId] of interval.supportingEntityIds.entries()) {
      id(supportingId, `${field}.supportingEntityIds[${supportIndex}]`);
      if (supportingId === primaryEntityId || supporting.has(supportingId) || !entityIds.has(supportingId) || !allowedStateEntities.has(supportingId)) fail(`${field}.supportingEntityIds`);
      supporting.add(supportingId);
    }
    const startFrame = integer(interval.startFrame, `${field}.startFrame`, 0, durationFrames - 1);
    const endFrame = integer(interval.endFrame, `${field}.endFrame`, startFrame + 1, durationFrames);
    const settleFrame = integer(interval.settleFrame, `${field}.settleFrame`, startFrame, endFrame - MINIMUM_SETTLE_FRAMES);
    if (startFrame < state.enterAnchor.resolvedFrame || endFrame > state.exitAnchor.resolvedFrame + 1) fail(`${field}.stateFrames`);
    if (startFrame !== cursor || endFrame - settleFrame < concurrency.minimumSettleFrames) fail(`${field}.frames`, { minimumSettleFrames: concurrency.minimumSettleFrames });
    const motion = focusMotionBinding({ startFrame, endFrame }, {
      scenes: context.scenes,
      stateTransitions: graph.stateTransitions,
      ambientEntityIds: concurrency.ambientEntityIds,
    });
    if (motion.actualMotionEnd === null) fail(`${field}.motionBinding`, { reason: "motion_missing" });
    if (settleFrame !== motion.actualMotionEnd) fail(`${field}.settleFrame`, {
      reason: "motion_end_mismatch",
      expectedMotionEnd: motion.actualMotionEnd,
      actualSettleFrame: settleFrame,
      operationKeys: motion.operationKeys,
      transitionIds: motion.transitionIds,
    });
    cursor = endFrame;
    const supportingOpacity = opacity(interval.supportingOpacity, `${field}.supportingOpacity`, 0.35, 0.75);
    const dimmedOpacity = opacity(interval.dimmedOpacity, `${field}.dimmedOpacity`, 0.05, 0.3);
    if (dimmedOpacity >= supportingOpacity) fail(`${field}.dimmedOpacity`);
    return Object.freeze({ ...interval, supportingEntityIds: Object.freeze([...interval.supportingEntityIds]), startFrame, settleFrame, endFrame, supportingOpacity, dimmedOpacity });
  });
  if (cursor !== durationFrames) fail("visualStateGraph.focusIntervals.coverage");

  const stateCoverage = new Set(normalized.map((interval) => interval.stateId));
  for (const stateId of states.keys()) if (!stateCoverage.has(stateId)) fail(`visualStateGraph.focusIntervals.stateCoverage.${stateId}`);
  return Object.freeze({ valid: true, profile: FOCUS_PROFILE, maxPrimaryActions: 1, intervalCount: normalized.length, intervals: Object.freeze(normalized) });
}

module.exports = { AMBIENT_ENTITY_IDS, FOCUS_PROFILE, MINIMUM_SETTLE_FRAMES, focusMotionBinding, validateFocusDirector };
