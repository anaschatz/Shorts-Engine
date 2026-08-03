"use strict";

const { createHash } = require("node:crypto");
const { stableStringify } = require("./canonical-json.cjs");

const VISUAL_RECIPE_REGISTRY_SCHEMA_VERSION = 1;
const VISUAL_RECIPE_REGISTRY_VERSION = "1.0.0";
const VISUAL_PROGRAM_COMPILER_VERSION = "1.0.0";
const VISUAL_STYLE_TOKEN_ID = "line_art_dark_v1";
const VISUAL_STYLE_TOKEN_VERSION = "1.0.0";

const VISUAL_ACTIONS = Object.freeze([
  "enter",
  "hold",
  "update",
  "reveal",
  "morph",
  "compare",
  "resolve",
  "exit",
]);

const VISUAL_TRANSITIONS = Object.freeze([
  "none",
  "match_morph",
  "focus_lens",
  "mask_wipe",
  "scale_focus",
]);

const VISUAL_ROLES = Object.freeze([
  "counter",
  "receiver",
  "document",
  "signal",
  "vessel",
  "map_marker",
  "timeline",
  "hypothesis",
  "uncertainty_boundary",
]);

const DEFINITIONS = [
  {
    recipeId: "finite_cycle",
    semanticFamilies: ["finite_cycle"],
    allowedPrimaryRoles: ["counter", "receiver", "signal"],
    allowedHelperRoles: ["counter", "timeline"],
    allowedActions: ["enter", "hold", "update", "reveal", "resolve"],
    allowedTransitions: ["none", "match_morph", "focus_lens"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: true,
    supportsUncertainty: false,
    animationTemplate: "relationship_graph_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 18,
  },
  {
    recipeId: "evidence_inspection",
    semanticFamilies: ["evidence_inspection"],
    allowedPrimaryRoles: ["document", "signal", "receiver"],
    allowedHelperRoles: ["document", "uncertainty_boundary"],
    allowedActions: ["enter", "hold", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "focus_lens", "mask_wipe"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: true,
    supportsUncertainty: true,
    animationTemplate: "evidence_card_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 16,
  },
  {
    recipeId: "bounded_uncertainty",
    semanticFamilies: ["bounded_uncertainty"],
    allowedPrimaryRoles: ["hypothesis", "uncertainty_boundary", "document"],
    allowedHelperRoles: ["uncertainty_boundary", "document"],
    allowedActions: ["enter", "hold", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "focus_lens", "scale_focus"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: false,
    supportsUncertainty: true,
    animationTemplate: "bounded_verdict_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 14,
  },
  {
    recipeId: "map_route",
    semanticFamilies: ["map_route"],
    allowedPrimaryRoles: ["vessel", "map_marker"],
    allowedHelperRoles: ["map_marker", "timeline"],
    allowedActions: ["enter", "hold", "update", "reveal", "morph", "resolve"],
    allowedTransitions: ["none", "match_morph", "mask_wipe"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: true,
    supportsUncertainty: true,
    animationTemplate: "map_route_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 20,
  },
  {
    recipeId: "negative_space_absence",
    semanticFamilies: ["negative_space_absence"],
    allowedPrimaryRoles: ["vessel", "map_marker", "signal"],
    allowedHelperRoles: ["uncertainty_boundary", "timeline"],
    allowedActions: ["enter", "hold", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "focus_lens", "mask_wipe"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: false,
    supportsUncertainty: true,
    animationTemplate: "map_route_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 16,
  },
  {
    recipeId: "chronology",
    semanticFamilies: ["chronology"],
    allowedPrimaryRoles: ["timeline", "counter", "document"],
    allowedHelperRoles: ["timeline", "document"],
    allowedActions: ["enter", "hold", "update", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "match_morph", "scale_focus"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: true,
    supportsUncertainty: true,
    animationTemplate: "timeline_compare_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 18,
  },
  {
    recipeId: "comparison",
    semanticFamilies: ["comparison"],
    allowedPrimaryRoles: ["counter", "signal", "timeline", "document"],
    allowedHelperRoles: ["counter", "document", "timeline"],
    allowedActions: ["enter", "hold", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "match_morph", "scale_focus"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: false,
    supportsUncertainty: true,
    animationTemplate: "scale_compare_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 18,
  },
  {
    recipeId: "cause_effect",
    semanticFamilies: ["cause_effect"],
    allowedPrimaryRoles: ["receiver", "signal", "hypothesis", "document"],
    allowedHelperRoles: ["document", "uncertainty_boundary"],
    allowedActions: ["enter", "hold", "update", "reveal", "compare", "resolve"],
    allowedTransitions: ["none", "match_morph", "focus_lens"],
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
    requiresPersistentIdentity: true,
    supportsUncertainty: true,
    animationTemplate: "relationship_graph_v2",
    animationEntityType: "semantic_visual",
    complexityCost: 20,
  },
];

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const VISUAL_RECIPE_REGISTRY = deepFreeze({
  schemaVersion: VISUAL_RECIPE_REGISTRY_SCHEMA_VERSION,
  version: VISUAL_RECIPE_REGISTRY_VERSION,
  recipes: DEFINITIONS,
});

const VISUAL_RECIPE_REGISTRY_HASH = createHash("sha256")
  .update(stableStringify(VISUAL_RECIPE_REGISTRY))
  .digest("hex");

const RECIPE_BY_ID = new Map(
  VISUAL_RECIPE_REGISTRY.recipes.map((recipe) => [recipe.recipeId, recipe]),
);

function findVisualRecipe(recipeId) {
  return RECIPE_BY_ID.get(recipeId) || null;
}

function listVisualRecipes() {
  return VISUAL_RECIPE_REGISTRY.recipes;
}

module.exports = {
  VISUAL_ACTIONS,
  VISUAL_RECIPE_REGISTRY,
  VISUAL_RECIPE_REGISTRY_HASH,
  VISUAL_RECIPE_REGISTRY_SCHEMA_VERSION,
  VISUAL_RECIPE_REGISTRY_VERSION,
  VISUAL_ROLES,
  VISUAL_STYLE_TOKEN_ID,
  VISUAL_STYLE_TOKEN_VERSION,
  VISUAL_TRANSITIONS,
  VISUAL_PROGRAM_COMPILER_VERSION,
  findVisualRecipe,
  listVisualRecipes,
};
