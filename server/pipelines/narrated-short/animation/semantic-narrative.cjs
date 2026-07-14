const { AppError } = require("../../../errors.cjs");

const SEMANTIC_TEMPLATES = Object.freeze([
  "wow_observation_v1",
  "frequency_duration_v1",
  "telescope_beam_v1",
  "repeat_search_v1",
  "evidence_payoff_v1",
]);
const SEMANTIC_ROLES = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);
const SEMANTIC_PROFILE_ID = "wow_signal_case_v1";
const EDITORIAL_LABELS = new Set(["HOOK", "CONTEXT", "EVIDENCE", "TURN", "PAYOFF"]);

function fail(field) {
  throw new AppError("ANIMATION_SEMANTIC_INVALID", "Animation does not preserve the approved narrative meaning.", 409, { field });
}

function validateSemanticNarrative(ir) {
  const semanticScenes = ir.scenes.filter((scene) => SEMANTIC_TEMPLATES.includes(scene.template));
  if (!semanticScenes.length) {
    if (ir.profileVersion === "1.1.0" || ir.content.semantic) fail("profile");
    return Object.freeze({ valid: true, mode: "legacy", beatCount: 0, cueCount: 0 });
  }
  if (ir.profileVersion !== "1.1.0" || semanticScenes.length !== SEMANTIC_TEMPLATES.length || ir.scenes.length !== SEMANTIC_TEMPLATES.length || ir.content.semantic?.profileId !== SEMANTIC_PROFILE_ID || !ir.timingBinding) fail("profile");
  if (ir.content.timelineLabels.some((label) => EDITORIAL_LABELS.has(String(label).toUpperCase()))) fail("content.timelineLabels");

  const timingBeats = ir.timingBinding.beats;
  if (timingBeats.length !== semanticScenes.length) fail("timingBinding.beats");
  let cueCount = 0;
  for (let index = 0; index < semanticScenes.length; index += 1) {
    const scene = semanticScenes[index];
    const beat = timingBeats[index];
    if (scene.template !== SEMANTIC_TEMPLATES[index] || scene.semantic?.role !== SEMANTIC_ROLES[index] || scene.semantic?.beatId !== beat.beatId) fail(`scenes[${index}].semantic`);
    const expectedStart = index === 0 ? 0 : beat.startFrame;
    const expectedEnd = index === semanticScenes.length - 1 ? ir.durationFrames : timingBeats[index + 1].startFrame;
    if (scene.startFrame !== expectedStart || scene.endFrame !== expectedEnd || beat.startFrame < scene.startFrame || beat.endFrame > scene.endFrame) fail(`scenes[${index}].frames`);
    const claims = new Set(scene.semantic.claimIds);
    const coveredClaims = new Set();
    if (!scene.operations.length) fail(`scenes[${index}].operations`);
    for (let operationIndex = 0; operationIndex < scene.operations.length; operationIndex += 1) {
      const operation = scene.operations[operationIndex];
      if (!claims.has(operation.semanticClaimId) || !operation.visualStatement || !operation.carryPolicy) fail(`scenes[${index}].operations[${operationIndex}].semantic`);
      if (operation.from.resolvedFrame < beat.startFrame || operation.to.resolvedFrame >= beat.endFrame) fail(`scenes[${index}].operations[${operationIndex}].timing`);
      coveredClaims.add(operation.semanticClaimId);
      cueCount += 1;
    }
    for (const claimId of claims) if (!coveredClaims.has(claimId)) fail(`scenes[${index}].semantic.claimIds.${claimId}`);
  }

  for (let index = 0; index < semanticScenes.length - 1; index += 1) {
    const scene = semanticScenes[index];
    const next = semanticScenes[index + 1];
    const carried = scene.entityIds.filter((id) => next.entityIds.includes(id));
    for (const entityId of carried) {
      const currentPolicies = scene.operations.filter((operation) => operation.targetId === entityId).map((operation) => operation.carryPolicy);
      const persistedEarlier = semanticScenes.slice(0, index).flatMap((candidate) => candidate.operations).some((operation) => operation.targetId === entityId && operation.carryPolicy === "persistent");
      if (!persistedEarlier && !currentPolicies.includes("carry_to_next") && !currentPolicies.includes("persistent")) fail(`scenes[${index}].entityIds.${entityId}`);
    }
    for (const operation of scene.operations) {
      if (operation.carryPolicy === "carry_to_next" && !next.entityIds.includes(operation.targetId)) fail(`scenes[${index}].operations.${operation.targetId}.carryPolicy`);
      if (operation.carryPolicy === "persistent" && semanticScenes.slice(index + 1).some((candidate) => !candidate.entityIds.includes(operation.targetId))) fail(`scenes[${index}].operations.${operation.targetId}.carryPolicy`);
    }
  }
  return Object.freeze({ valid: true, mode: "semantic", beatCount: semanticScenes.length, cueCount });
}

module.exports = { EDITORIAL_LABELS, SEMANTIC_PROFILE_ID, SEMANTIC_ROLES, SEMANTIC_TEMPLATES, validateSemanticNarrative };
