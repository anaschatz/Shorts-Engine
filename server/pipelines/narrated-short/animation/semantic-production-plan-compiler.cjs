const { AppError } = require("../../../errors.cjs");
const { contentHash, normalizeDraftBundle } = require("../contracts.cjs");
const { OPERATION_COST } = require("./complexity-budget.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const {
  GENERIC_SEMANTIC_PROFILE_ID,
  buildSemanticVisualPlan,
  validateSemanticVisualPlanAgainstDraft,
} = require("./semantic-visual-planner.cjs");

const GENERIC_PROFILE_VERSION = "1.2.0";
const GENERIC_STYLE_VERSION = "2.0.0";
const TEMPLATE_VERSION = "2.0.0";
const D3_SHAPE_VERSION = "3.2.0";
const ROLES = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);

function fail(field) {
  throw new AppError(
    "ANIMATION_VISUAL_PLAN_INVALID",
    "The approved storyboard cannot be compiled into a grounded semantic visual plan.",
    409,
    { field },
  );
}

function wrapText(value, maxCharacters = 22, maxLines = 2) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || (current.length + word.length + 1 > maxCharacters && lines.length < maxLines)) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return (lines.length ? lines : ["UNTITLED"]).slice(0, maxLines).map((line) => line.slice(0, 50));
}

function safeLabel(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function anchor(frame) {
  return { anchor: "absolute", frame };
}

function operation({
  op,
  targetId,
  fromFrame,
  toFrame,
  params,
  claimId,
  visualStatement,
  carryPolicy = "clear_at_scene_end",
}) {
  return {
    op,
    targetId,
    from: anchor(fromFrame),
    to: anchor(toFrame),
    easing: op === "create" ? "linear" : "ease_in_out_cubic",
    params,
    semanticClaimId: claimId,
    visualStatement,
    carryPolicy,
  };
}

function allocateSceneTiming(beat, sceneEnd, field) {
  const span = beat.endFrame - beat.startFrame;
  if (span < 72 || sceneEnd - beat.startFrame < 84) fail(`${field}.duration`);
  const start = beat.startFrame;
  const latestMotionEnd = Math.min(beat.endFrame - 1, sceneEnd - 25);
  const morphEnd = Math.min(latestMotionEnd - 42, start + Math.max(26, Math.round(span * 0.28)));
  const primaryStart = Math.min(morphEnd, start + Math.max(4, Math.round(span * 0.08)));
  const primaryEnd = Math.min(latestMotionEnd - 24, Math.max(primaryStart + 24, start + Math.round(span * 0.55)));
  const labelStart = Math.min(latestMotionEnd - 24, Math.max(primaryEnd + 6, start + Math.round(span * 0.62)));
  const labelEnd = Math.min(latestMotionEnd, Math.max(labelStart + 24, start + Math.round(span * 0.82)));
  if (morphEnd - start < 24 || primaryEnd - primaryStart < 24 || labelEnd - labelStart < 24) fail(`${field}.timing`);
  return Object.freeze({ start, morphEnd, primaryStart, primaryEnd, labelStart, labelEnd });
}

function roleSceneEntities(role) {
  return [`${role}_visual`, `${role}_label`];
}

function genericSemanticScene(scenePlan) {
  return {
    beatId: scenePlan.beatId,
    role: scenePlan.role,
    claimIds: [...scenePlan.claimIds],
    visualStatement: safeLabel(scenePlan.heading, scenePlan.primaryLabel).slice(0, 160),
  };
}

function buildGenericProductionAnimationPlan(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timing = normalizeAnimationTimingContext(input.timingContext);
  if (draft.verticalId !== "dark_curiosity" || draft.brief.formatId !== "documented_mystery_v1") fail("formatId");
  if (draft.contentHash !== timing.draftHash) fail("draftHash");

  const visualPlan = buildSemanticVisualPlan({ draft, timingContext: timing });
  validateSemanticVisualPlanAgainstDraft(visualPlan, draft);
  const planByRole = Object.fromEntries(visualPlan.scenes.map((scene) => [scene.role, scene]));
  const scripted = Object.fromEntries(draft.script.beats.map((beat) => [beat.role, beat]));
  const beatById = new Map(timing.beats.map((beat) => [beat.beatId, beat]));
  for (const role of ROLES) {
    if (!planByRole[role] || !scripted[role] || !beatById.has(planByRole[role].beatId)) fail(`scenes.${role}`);
    if (!planByRole[role].claimIds.length || planByRole[role].claimIds.length > 3) fail(`scenes.${role}.claimIds`);
  }

  const dimensions = input.renderProfile === "final"
    ? { width: 1080, height: 1920 }
    : { width: 720, height: 1280 };
  const sceneStart = Object.fromEntries(ROLES.map((role, index) => [
    role,
    index === 0 ? 0 : beatById.get(planByRole[role].beatId).startFrame,
  ]));
  const sceneEnd = Object.fromEntries(ROLES.map((role, index) => [
    role,
    index === ROLES.length - 1 ? timing.durationFrames : sceneStart[ROLES[index + 1]],
  ]));

  const scenes = ROLES.map((role, roleIndex) => {
    const scenePlan = planByRole[role];
    const beat = beatById.get(scenePlan.beatId);
    const allocation = allocateSceneTiming(beat, sceneEnd[role], `scenes.${role}`);
    const claims = scenePlan.claimIds;
    const claimFor = (index) => claims[index % claims.length];
    const [visualId, labelId] = roleSceneEntities(role);
    const operations = [];
    if (role === "hook") {
      operations.push(operation({
        op: "create",
        targetId: "deep_background",
        fromFrame: allocation.start,
        toFrame: Math.min(allocation.morphEnd, allocation.start + 24),
        params: { opacity: 1 },
        claimId: claimFor(0),
        visualStatement: "Establish one continuous evidence field for the approved documented mystery.",
        carryPolicy: "persistent",
      }));
    }
    operations.push(
      operation({
        op: "morph_path",
        targetId: "story_evidence",
        fromFrame: allocation.start,
        toFrame: allocation.morphEnd,
        params: { toShape: ["circle", "node", "diamond", "node", "circle"][roleIndex] },
        claimId: claimFor(role === "hook" ? 1 : 0),
        visualStatement: `Carry the same grounded case evidence into ${scenePlan.archetypeId}.`,
        carryPolicy: "persistent",
      }),
      operation({
        op: "draw_path",
        targetId: visualId,
        fromFrame: allocation.primaryStart,
        toFrame: allocation.primaryEnd,
        params: { direction: "left_to_right" },
        claimId: claimFor(role === "hook" ? 2 : 1),
        visualStatement: `Render ${scenePlan.archetypeId} from storyboard scene ${scenePlan.sourceSceneId}.`,
      }),
      operation({
        op: "highlight",
        targetId: labelId,
        fromFrame: allocation.labelStart,
        toFrame: allocation.labelEnd,
        params: { strength: 1 },
        claimId: claimFor(role === "hook" ? 3 : 2),
        visualStatement: "Reveal only audience text grounded in the approved storyboard.",
      }),
    );
    return {
      id: `scene_${role}`,
      startFrame: sceneStart[role],
      endFrame: sceneEnd[role],
      template: scenePlan.archetypeId,
      templateVersion: TEMPLATE_VERSION,
      semantic: genericSemanticScene(scenePlan),
      entityIds: ["deep_background", "story_evidence", visualId, labelId],
      operations,
      readabilityHolds: [{ startFrame: allocation.labelEnd + 1, endFrame: sceneEnd[role] }],
      complexityCost: operations.reduce((total, item) => total + OPERATION_COST[item.op], 0),
    };
  });

  const contextPlan = planByRole.context;
  const evidencePlan = planByRole.evidence;
  const payoffPlan = planByRole.payoff;
  const contextLabel = safeLabel(contextPlan.primaryLabel, contextPlan.heading);
  const evidenceLabel = safeLabel(evidencePlan.primaryLabel, evidencePlan.heading);
  const payoffLabel = safeLabel(payoffPlan.primaryLabel, payoffPlan.heading);
  const uncertaintyLabel = safeLabel(payoffPlan.secondaryLabel, payoffPlan.disclosure, payoffLabel);
  if (![contextLabel, evidenceLabel, payoffLabel, uncertaintyLabel].every(Boolean)) fail("content.labels");

  const content = {
    compositionId: `dcv2_${draft.contentHash.slice(0, 22)}`,
    kicker: draft.brief.formatId.replace(/_v\d+$/, "").replace(/_/g, " ").toUpperCase(),
    titleLines: wrapText(draft.script.title.toUpperCase(), 20, 2),
    metricValue: (contextLabel.match(/\b\d[\d.,:/-]*\b/) || [contextPlan.entityKind])[0].toUpperCase().slice(0, 32),
    metricLabel: contextLabel.toUpperCase().slice(0, 72),
    evidenceCode: evidencePlan.entityKind.replace(/_/g, " ").toUpperCase().slice(0, 32),
    evidenceLabel: evidenceLabel.toUpperCase().slice(0, 72),
    reasoningLeft: safeLabel(payoffPlan.heading, payoffLabel).toUpperCase().slice(0, 50),
    reasoningRight: uncertaintyLabel.toUpperCase().slice(0, 50),
    payoffLines: wrapText(payoffLabel.toUpperCase(), 24, 2),
    timelineLabels: ROLES.map((role) => safeLabel(planByRole[role].primaryLabel, planByRole[role].heading).toUpperCase().slice(0, 24)),
    semantic: {
      profileId: GENERIC_SEMANTIC_PROFILE_ID,
      storyVocabulary: visualPlan.storyVocabulary,
      subjectLabel: draft.script.title.toUpperCase().slice(0, 80),
      uncertaintyLabel: uncertaintyLabel.toUpperCase().slice(0, 80),
      finalEvidenceLabel: payoffLabel.toUpperCase().slice(0, 80),
    },
    visualPlan,
  };

  const sharedEntities = [
    { id: "deep_background", type: "background", role: "ambient_field", layer: 0, styleToken: "navy_depth" },
    { id: "story_evidence", type: "case_evidence", role: "persistent_story_evidence", layer: 7, styleToken: "evidence_cyan" },
    ...ROLES.flatMap((role, index) => {
      const plan = planByRole[role];
      const [visualId, labelId] = roleSceneEntities(role);
      return [
        { id: visualId, type: "semantic_visual", role: plan.entityKind, layer: 2 + index, styleToken: plan.archetypeId },
        { id: labelId, type: "semantic_label", role: `${role}_audience_label`, layer: 8, styleToken: "audience_copy", text: safeLabel(plan.primaryLabel, plan.heading).slice(0, 120) },
      ];
    }),
  ];

  const seed = Number.parseInt(contentHash({
    draftHash: draft.contentHash,
    timingContextHash: timing.contentHash,
    visualPlan,
  }).slice(0, 8), 16) >>> 0;
  const assetManifestHash = contentHash({
    grammar: GENERIC_SEMANTIC_PROFILE_ID,
    sourceStoryboardHash: visualPlan.sourceStoryboardHash,
    d3ShapeVersion: D3_SHAPE_VERSION,
  });

  return {
    schemaVersion: 2,
    profile: "dark_curiosity_continuous",
    profileVersion: GENERIC_PROFILE_VERSION,
    projectId: String(input.projectId),
    projectRevision: Number(input.projectRevision),
    verticalId: "dark_curiosity",
    ...dimensions,
    fps: timing.fps,
    durationFrames: timing.durationFrames,
    draftHash: draft.contentHash,
    alignmentHash: timing.alignmentHash,
    assetManifestHash,
    renderer: {
      provider: "hyperframes_local",
      runtimeVersion: "0.7.55",
      styleVersion: GENERIC_STYLE_VERSION,
    },
    seed,
    content,
    sharedEntities,
    scenes,
    transitions: ROLES.slice(1).map((role, index) => {
      const previous = ROLES[index];
      const boundary = sceneStart[role];
      return {
        fromSceneId: `scene_${previous}`,
        toSceneId: `scene_${role}`,
        sharedEntityId: "story_evidence",
        startFrame: boundary,
        endFrame: Math.min(sceneEnd[role], boundary + 30),
      };
    }),
    motionBudget: {
      profile: "dark_curiosity",
      maxCost: 80,
      maxConcurrentOperations: 8,
      maxCameraScale: 1.15,
      maxTravelPxPerFrame: 12,
      captionSafeZone: { topRatio: 0.74, bottomRatio: 1 },
    },
  };
}

module.exports = {
  D3_SHAPE_VERSION,
  GENERIC_PROFILE_VERSION,
  GENERIC_STYLE_VERSION,
  buildGenericProductionAnimationPlan,
};
