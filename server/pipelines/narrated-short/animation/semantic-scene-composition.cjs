"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  normalizeSemanticPrimitiveParameters,
} = require("./semantic-primitive-parameters.cjs");

const SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION = 1;
const SEMANTIC_SCENE_COMPOSITION_PROFILE_ID =
  "dark_curiosity_scene_composition_v1";
const SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS = Object.freeze([
  "header_strip",
  "satellites_left",
  "satellites_right",
]);
const SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS = Object.freeze([
  "detail_card",
  "primary_geometry",
  "quantity_badge",
  "route_trace",
  "state_badge",
]);
const MODULE_SOURCE_BY_KIND = Object.freeze({
  detail_card: "cue_detail",
  primary_geometry: "primary_geometry",
  quantity_badge: "display_quantity",
  route_trace: "approved_route",
  state_badge: "semantic_state",
});
const SUPPORT_CONTEXT_KINDS = Object.freeze([
  "detail_card",
  "quantity_badge",
  "route_trace",
]);
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,119}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "Semantic scene composition is invalid or is not grounded in its primitive parameters.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const expected = [...required].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(field, "unsupported_or_missing_field");
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > (options.maximum || 120)
    || /[\u0000-\u001f\u007f]/.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function normalizeModule(input, index) {
  const field = `sceneComposition.modules[${index}]`;
  exactKeys(input, [
    "id",
    "role",
    "kind",
    "source",
    "slot",
    "revealOrder",
  ], field);
  const normalized = {
    id: text(input.id, `${field}.id`, { pattern: ID_PATTERN }),
    role: text(input.role, `${field}.role`, { maximum: 16 }),
    kind: text(input.kind, `${field}.kind`, { pattern: ID_PATTERN }),
    source: text(input.source, `${field}.source`, { pattern: ID_PATTERN }),
    slot: text(input.slot, `${field}.slot`, { pattern: ID_PATTERN }),
    revealOrder: integer(input.revealOrder, `${field}.revealOrder`, 0, 2),
  };
  if (!SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS.includes(normalized.kind)) {
    fail(`${field}.kind`, "unsupported_value");
  }
  if (normalized.source !== MODULE_SOURCE_BY_KIND[normalized.kind]) {
    fail(`${field}.source`, "kind_source_mismatch");
  }
  const expected = index === 0
    ? {
      id: "module_primary",
      role: "primary",
      kind: "primary_geometry",
      source: "primary_geometry",
      slot: "primary",
      revealOrder: 0,
    }
    : index === 1
      ? {
        id: "module_support_a",
        role: "supporting",
        slot: "support_a",
        revealOrder: 1,
      }
      : {
        id: "module_support_b",
        role: "supporting",
        kind: "state_badge",
        source: "semantic_state",
        slot: "support_b",
        revealOrder: 2,
      };
  for (const [key, value] of Object.entries(expected)) {
    if (normalized[key] !== value) fail(`${field}.${key}`, "module_topology_mismatch");
  }
  if (index === 1 && !SUPPORT_CONTEXT_KINDS.includes(normalized.kind)) {
    fail(`${field}.kind`, "context_support_required");
  }
  return normalized;
}

function normalizeLink(input, index) {
  const field = `sceneComposition.links[${index}]`;
  exactKeys(input, ["fromModuleId", "toModuleId", "relation"], field);
  const normalized = {
    fromModuleId: text(input.fromModuleId, `${field}.fromModuleId`, {
      pattern: ID_PATTERN,
    }),
    toModuleId: text(input.toModuleId, `${field}.toModuleId`, {
      pattern: ID_PATTERN,
    }),
    relation: text(input.relation, `${field}.relation`, { pattern: ID_PATTERN }),
  };
  const expected = index === 0
    ? {
      fromModuleId: "module_primary",
      toModuleId: "module_support_a",
      relation: "context",
    }
    : {
      fromModuleId: "module_primary",
      toModuleId: "module_support_b",
      relation: "state",
    };
  if (stableStringify(normalized) !== stableStringify(expected)) {
    fail(field, "link_topology_mismatch");
  }
  return normalized;
}

function normalizeSemanticSceneComposition(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "id",
    "layoutId",
    "variantSeed",
    "modules",
    "links",
  ], "sceneComposition");
  if (input.schemaVersion !== SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION) {
    fail("sceneComposition.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_SCENE_COMPOSITION_PROFILE_ID) {
    fail("sceneComposition.profileId", "unsupported_profile");
  }
  const layoutId = text(input.layoutId, "sceneComposition.layoutId", {
    pattern: ID_PATTERN,
  });
  if (!SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS.includes(layoutId)) {
    fail("sceneComposition.layoutId", "unsupported_value");
  }
  if (!Array.isArray(input.modules) || input.modules.length !== 3) {
    fail("sceneComposition.modules", "exactly_three_modules_required");
  }
  if (!Array.isArray(input.links) || input.links.length !== 2) {
    fail("sceneComposition.links", "exactly_two_links_required");
  }
  return deepFreeze({
    schemaVersion: SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
    profileId: SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
    id: text(input.id, "sceneComposition.id", { pattern: ID_PATTERN }),
    layoutId,
    variantSeed: integer(
      input.variantSeed,
      "sceneComposition.variantSeed",
      0,
      0xffffffff,
    ),
    modules: input.modules.map(normalizeModule),
    links: input.links.map(normalizeLink),
  });
}

function normalizeRecentLayoutIds(value) {
  if (!Array.isArray(value) || value.length > 4) {
    fail("recentLayoutIds", "bounded_array_required");
  }
  return value.map((layoutId, index) => {
    const normalized = text(layoutId, `recentLayoutIds[${index}]`, {
      pattern: ID_PATTERN,
    });
    if (!SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS.includes(normalized)) {
      fail(`recentLayoutIds[${index}]`, "unsupported_value");
    }
    return normalized;
  });
}

function displayQuantity(parameters) {
  if (!parameters.quantity) return null;
  return [parameters.quantity.value, parameters.quantity.unit]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function contextSupportKind(parameters) {
  if (parameters.geometry.route) return "route_trace";
  const quantity = displayQuantity(parameters);
  if (quantity && quantity.length <= 32) return "quantity_badge";
  return "detail_card";
}

function buildSemanticSceneComposition(input = {}) {
  const graphHash = text(input.graphHash, "graphHash", {
    maximum: 64,
    pattern: HASH_PATTERN,
  });
  const propositionId = text(input.propositionId, "propositionId", {
    pattern: ID_PATTERN,
  });
  const primitiveParameters = normalizeSemanticPrimitiveParameters(
    input.primitiveParameters,
  );
  const capability = input.capability;
  if (
    !isPlainObject(capability)
    || capability.assetId !== primitiveParameters.assetId
    || capability.grammarId !== primitiveParameters.grammarId
  ) fail("capability", "primitive_capability_mismatch");
  const recentLayoutIds = normalizeRecentLayoutIds(
    input.recentLayoutIds || [],
  );
  const supportKind = contextSupportKind(primitiveParameters);
  const digest = createHash("sha256").update(stableStringify({
    graphHash,
    propositionId,
    primitiveParameters,
    supportKind,
    recentLayoutIds,
  })).digest();
  const variantSeed = digest.readUInt32BE(0);
  const previousLayoutId = recentLayoutIds.at(-1) || null;
  const candidates = SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS.filter(
    (layoutId) => layoutId !== previousLayoutId,
  );
  const layoutId = candidates[variantSeed % candidates.length];
  return normalizeSemanticSceneComposition({
    schemaVersion: SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
    profileId: SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
    id: `composition_${propositionId}`,
    layoutId,
    variantSeed,
    modules: [
      {
        id: "module_primary",
        role: "primary",
        kind: "primary_geometry",
        source: "primary_geometry",
        slot: "primary",
        revealOrder: 0,
      },
      {
        id: "module_support_a",
        role: "supporting",
        kind: supportKind,
        source: MODULE_SOURCE_BY_KIND[supportKind],
        slot: "support_a",
        revealOrder: 1,
      },
      {
        id: "module_support_b",
        role: "supporting",
        kind: "state_badge",
        source: "semantic_state",
        slot: "support_b",
        revealOrder: 2,
      },
    ],
    links: [
      {
        fromModuleId: "module_primary",
        toModuleId: "module_support_a",
        relation: "context",
      },
      {
        fromModuleId: "module_primary",
        toModuleId: "module_support_b",
        relation: "state",
      },
    ],
  });
}

module.exports = {
  SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS,
  SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS,
  SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
  SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
  buildSemanticSceneComposition,
  normalizeSemanticSceneComposition,
};
