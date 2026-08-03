import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { styleForComposition } from "./generalized-visual-style-v1.mjs";

const require = createRequire(import.meta.url);
const { validateGeneralizedVisualProgramAnimationAdapterV1 } = require(
  "../../server/pipelines/narrated-short/animation/visual-program-compiler.cjs",
);

export const GENERALIZED_VISUAL_PERCEPTUAL_PROFILE = "generalized_visual_perceptual_qa_v1";
export const GENERALIZED_VISUAL_PERCEPTUAL_VERSION = "1.0.0";

const COMPLEX_RECIPES = new Set([
  "finite_cycle",
  "bounded_uncertainty",
  "map_route",
  "negative_space_absence",
  "chronology",
  "cause_effect",
]);
const TEXT_HEAVY_RECIPES = new Set(["evidence_inspection"]);
const CERTAINTY_RANK = Object.freeze({ verified: 0, qualified: 1, disputed: 2, unknown: 3 });

export const PERCEPTUAL_ISSUE_CODES = Object.freeze([
  "TRACEABILITY_INCOMPLETE",
  "RECIPE_SEMANTIC_MISMATCH",
  "HELPER_UNGROUNDED",
  "CERTAINTY_PROMOTED",
  "STATE_CHANGE_UNBOUND",
  "SETTLED_DWELL_SHORT",
  "HOLD_SHORT",
  "HOLD_MOTION_PRESENT",
  "LATE_REVEAL",
  "UNJUSTIFIED_REPETITION",
  "PRIMARY_NOT_VISIBLE",
  "FOCAL_POINT_OUTSIDE_PRIMARY",
  "PRIMARY_HELPER_HIERARCHY_WEAK",
  "TYPOGRAPHY_TOO_SMALL",
  "TYPOGRAPHY_OVERFLOW",
  "TYPOGRAPHY_OVERCOMPRESSED",
  "TEXT_CONTRAST_LOW",
  "EDGE_MARGIN_LOW",
  "CAPTION_COLLISION",
  "VISUAL_DASHBOARD_DENSITY",
  "ACCENT_COMPETITION",
  "MAP_DISCLOSURE_MISSING",
  "DUPLICATE_RENDERED_LABEL",
  "NETWORK_REQUEST_OBSERVED",
]);
const ISSUE_SET = new Set(PERCEPTUAL_ISSUE_CODES);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function expectedCertainty(beats) {
  return beats.reduce((worst, beat) => (
    (CERTAINTY_RANK[beat.certainty] ?? 3) > (CERTAINTY_RANK[worst] ?? 3)
      ? beat.certainty
      : worst
  ), "verified");
}

function minimumSettledFrames(recipeId) {
  if (TEXT_HEAVY_RECIPES.has(recipeId)) return 30;
  if (COMPLEX_RECIPES.has(recipeId)) return 36;
  return 18;
}

export function evaluateGeneralizedVisualStructuralContinuity(current, previous = null) {
  for (const [name, descriptor] of [["current", current], ["previous", previous]]) {
    if (descriptor === null && name === "previous") continue;
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new TypeError(`${name} structural descriptor is invalid.`);
    if (!/^[a-f0-9]{64}$/.test(descriptor.structuralSignature || "") || typeof descriptor.identityId !== "string" || typeof descriptor.persistent !== "boolean") {
      throw new TypeError(`${name} structural descriptor is invalid.`);
    }
  }
  const repeatedPreviousStructure = Boolean(previous && previous.structuralSignature === current.structuralSignature);
  const repetitionJustified = Boolean(repeatedPreviousStructure
    && previous.identityId === current.identityId
    && previous.persistent
    && current.persistent);
  return deepFreeze({
    repeatedPreviousStructure,
    repetitionJustified,
    issueCodes: repeatedPreviousStructure && !repetitionJustified ? ["UNJUSTIFIED_REPETITION"] : [],
  });
}

function staticSceneAudit({ planScene, programScene, storyIR, previous }) {
  const beatById = new Map(storyIR.beats.map((beat) => [beat.beatId, beat]));
  const beats = planScene.narrationBeatIds.map((beatId) => beatById.get(beatId)).filter(Boolean);
  const claimIds = [...new Set(beats.flatMap((beat) => beat.claimIds))];
  const phases = Object.fromEntries(planScene.phases.map((phase) => [phase.id, phase]));
  const phaseFrames = Object.fromEntries(planScene.phases.map((phase) => [phase.id, phase.endFrame - phase.startFrame]));
  const settledReadabilityFrames = phaseFrames.resolve + phaseFrames.hold;
  const minimumSettledReadabilityFrames = minimumSettledFrames(planScene.recipeId);
  const revealLeadFrames = phases.hold.endFrame - phases.reveal.startFrame;
  const helperGrounded = !programScene.helper || (
    planScene.layout.helper
    && programScene.helper.dataRefs.every((id) => claimIds.includes(id))
  );
  const recipeSemanticMatch = planScene.recipeId === programScene.semanticFamily
    && planScene.recipeId === programScene.primary.recipeId;
  const certaintyPreserved = planScene.grounded.certainty === expectedCertainty(beats);
  const traceability = {
    beatCount: beats.length,
    claimCount: planScene.grounded.claimIds.length,
    beatBindingComplete: beats.length === planScene.narrationBeatIds.length,
    claimBindingComplete: planScene.grounded.claimIds.every((id) => claimIds.includes(id)),
    recipeSemanticMatch,
    helperGrounded: Boolean(helperGrounded),
    certaintyPreserved,
    stateChangeBound: Boolean(planScene.stateGraph.fromState && planScene.stateGraph.toState),
    revealBound: Boolean(phases.reveal && phases.resolve && phases.hold),
  };
  const styleId = styleForComposition(planScene.layout.compositionFamily).styleId;
  const structuralSignature = hash({
    recipeId: planScene.recipeId,
    compositionFamily: planScene.layout.compositionFamily,
    styleId,
    geometryKind: planScene.layout.geometry.kind,
    helper: Boolean(planScene.layout.helper),
    stateProfile: planScene.stateGraph.stateProfile,
  });
  const continuity = evaluateGeneralizedVisualStructuralContinuity({
    structuralSignature,
    identityId: planScene.stateGraph.identityId,
    persistent: planScene.stateGraph.persistent,
  }, previous ? {
    structuralSignature: previous.diversity.structuralSignature,
    identityId: previous.identityId,
    persistent: previous.persistent,
  } : null);
  const issueCodes = [];
  if (!Object.values(traceability).every((value) => typeof value === "number" || value === true)) issueCodes.push("TRACEABILITY_INCOMPLETE");
  if (!recipeSemanticMatch) issueCodes.push("RECIPE_SEMANTIC_MISMATCH");
  if (!helperGrounded) issueCodes.push("HELPER_UNGROUNDED");
  if (!certaintyPreserved) issueCodes.push("CERTAINTY_PROMOTED");
  if (!traceability.stateChangeBound) issueCodes.push("STATE_CHANGE_UNBOUND");
  if (settledReadabilityFrames < minimumSettledReadabilityFrames) issueCodes.push("SETTLED_DWELL_SHORT");
  if (phaseFrames.hold < 18) issueCodes.push("HOLD_SHORT");
  if (planScene.phases.at(-1).moving || planScene.motionBudget.movingOperationsEndFrame > phases.hold.startFrame) issueCodes.push("HOLD_MOTION_PRESENT");
  if (revealLeadFrames < minimumSettledReadabilityFrames) issueCodes.push("LATE_REVEAL");
  issueCodes.push(...continuity.issueCodes);
  return {
    recipeId: planScene.recipeId,
    compositionFamily: planScene.layout.compositionFamily,
    styleId,
    traceability,
    timing: {
      phaseFrames,
      settledReadabilityFrames,
      minimumSettledReadabilityFrames,
      revealLeadFrames,
      holdMotionFree: !issueCodes.includes("HOLD_MOTION_PRESENT"),
    },
    diversity: {
      structuralSignature,
      repeatedPreviousStructure: continuity.repeatedPreviousStructure,
      repetitionJustified: continuity.repetitionJustified,
    },
    identityId: planScene.stateGraph.identityId,
    persistent: planScene.stateGraph.persistent,
    issueCodes,
  };
}

export function compileGeneralizedVisualPerceptualAudit(rawAdapter, trustedContext = {}) {
  const adapter = validateGeneralizedVisualProgramAnimationAdapterV1(rawAdapter, trustedContext);
  let previous = null;
  const scenes = adapter.visualRecipePlan.scenes.map((planScene, sceneIndex) => {
    const result = staticSceneAudit({
      planScene,
      programScene: adapter.visualProgram.scenes[sceneIndex],
      storyIR: trustedContext.storyIR,
      previous,
    });
    previous = result;
    return {
      sceneIndex,
      recipeId: result.recipeId,
      compositionFamily: result.compositionFamily,
      styleId: result.styleId,
      traceability: result.traceability,
      timing: result.timing,
      diversity: result.diversity,
      issueCodes: result.issueCodes,
      passed: result.issueCodes.length === 0,
    };
  });
  const base = {
    schemaVersion: 1,
    profile: GENERALIZED_VISUAL_PERCEPTUAL_PROFILE,
    profileVersion: GENERALIZED_VISUAL_PERCEPTUAL_VERSION,
    bindings: {
      adapterHash: adapter.contentHash,
      planHash: adapter.visualRecipePlan.contentHash,
      storyIrHash: trustedContext.storyIR.contentHash,
      timingContextHash: trustedContext.timingContext.contentHash,
    },
    scenes,
    passed: scenes.every((scene) => scene.passed),
  };
  return deepFreeze({ ...base, contentHash: hash(base) });
}

export function evaluateGeneralizedVisualBrowserMetrics(metrics) {
  const issueCodes = [];
  if (!metrics.primaryVisible) issueCodes.push("PRIMARY_NOT_VISIBLE");
  if (!metrics.focalCenterInPrimary) issueCodes.push("FOCAL_POINT_OUTSIDE_PRIMARY");
  if (metrics.helperPresent && metrics.primaryHelperAreaRatio < 1.6) issueCodes.push("PRIMARY_HELPER_HIERARCHY_WEAK");
  if (metrics.minimumFontSize < 18) issueCodes.push("TYPOGRAPHY_TOO_SMALL");
  if (metrics.maximumTextLines > 3 || !metrics.typographyBounded) issueCodes.push("TYPOGRAPHY_OVERFLOW");
  if (metrics.minimumCompressionRatio < 0.72) issueCodes.push("TYPOGRAPHY_OVERCOMPRESSED");
  if (metrics.minimumContrastRatio < 4.5) issueCodes.push("TEXT_CONTRAST_LOW");
  if (metrics.minimumEdgeMargin < 36) issueCodes.push("EDGE_MARGIN_LOW");
  if (!metrics.captionSafe) issueCodes.push("CAPTION_COLLISION");
  if (metrics.visiblePrimitiveCount > 14) issueCodes.push("VISUAL_DASHBOARD_DENSITY");
  if (metrics.visibleAccentCount > 12) issueCodes.push("ACCENT_COMPETITION");
  if (!metrics.mapDisclosureVisible) issueCodes.push("MAP_DISCLOSURE_MISSING");
  if (metrics.duplicateKeyLabels) issueCodes.push("DUPLICATE_RENDERED_LABEL");
  return deepFreeze({ issueCodes, passed: issueCodes.length === 0 });
}

export function generalizedVisualPerceptualContentHash(value) {
  return hash(value);
}

export function assertPerceptualIssueCodes(values) {
  if (!Array.isArray(values) || values.some((value) => !ISSUE_SET.has(value))) {
    throw new TypeError("Perceptual issue code is unsupported.");
  }
  return values;
}
