"use strict";

const {
  SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
  normalizeSemanticAnimationSceneProposal,
} = require("./semantic-animation-scene-dsl.cjs");

const SEMANTIC_ANIMATION_SCENE_PLANNER_PROMPT_PROFILE_ID =
  "dark_curiosity_local_scene_planner_prompt_v1";

function deterministicSemanticAnimationSceneProposalForContext(context) {
  const grammarId = context.sentence.primitiveParameters.grammarId;
  const variationBucket =
    context.sentence.primitiveParameters.geometry.variantSeed % 16;
  const alternatingSupport = variationBucket % 2 === 0
    ? "module_support_a"
    : "module_support_b";
  let actions;
  if (context.hasApprovedRoute) {
    actions = [
      {
        op: "move",
        target: "module_primary",
        phase: "develop",
        preset: "follow_grounded_route",
      },
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 2 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if ([
    "evidence_inspection",
    "chronology_accumulation",
  ].includes(grammarId)) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 2 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: variationBucket % 3 === 0
          ? "module_primary"
          : alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if ([
    "bounded_uncertainty",
    "negative_space_absence",
  ].includes(grammarId)) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 3 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: variationBucket % 2 === 0
          ? "module_primary"
          : alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if (variationBucket % 3 === 2) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: "push_primary",
      },
      {
        op: "highlight",
        target: "module_primary",
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else {
    actions = [
      {
        op: "highlight",
        target: alternatingSupport,
        phase: "develop",
        preset: "pulse_once",
      },
      {
        op: "transform",
        target: "module_primary",
        phase: "resolve",
        preset: "semantic_transition",
      },
    ];
  }
  return normalizeSemanticAnimationSceneProposal({
    schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
    actions,
  }, {
    hasApprovedRoute: context.hasApprovedRoute,
  });
}

module.exports = {
  SEMANTIC_ANIMATION_SCENE_PLANNER_PROMPT_PROFILE_ID,
  deterministicSemanticAnimationSceneProposalForContext,
};
