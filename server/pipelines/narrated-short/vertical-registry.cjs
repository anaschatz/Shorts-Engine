const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { sanitizeText } = require("../../repositories/ids.cjs");

const VERTICAL_IDS = Object.freeze(["football_explainer", "dark_curiosity"]);

const VERTICALS = Object.freeze({
  football_explainer: Object.freeze({
    schemaVersion: 1,
    verticalId: "football_explainer",
    formatIds: Object.freeze(["tactical_cause_effect_v1", "formation_compare_v1", "stat_story_v1"]),
    beatRoles: Object.freeze(["hook", "setup", "mechanism", "consequence", "payoff"]),
    sceneTemplates: Object.freeze(["hook_text", "pitch_tactical_sequence", "formation_compare", "stat_card", "payoff"]),
    timelineTrackType: "football_visual",
    renderCapability: "available",
  }),
  dark_curiosity: Object.freeze({
    schemaVersion: 2,
    verticalId: "dark_curiosity",
    formatIds: Object.freeze(["documented_mystery_v1", "deepest_iceberg_layer_v1", "speculative_what_if_v1"]),
    beatRoles: Object.freeze(["hook", "context", "evidence", "turn", "payoff"]),
    sceneTemplates: Object.freeze(["hook_scene", "evidence_scene", "map_timeline_scene", "system_scale_scene", "payoff_scene"]),
    timelineTrackType: "visual_scene",
    renderCapability: "preview_available",
  }),
});

const FORMAT_TO_VERTICAL = new Map(
  Object.values(VERTICALS).flatMap((descriptor) => descriptor.formatIds.map((formatId) => [formatId, descriptor.verticalId])),
);

function fail(field, details = {}) {
  throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field, ...details });
}

function inferVerticalId(formatId) {
  const safeFormatId = sanitizeText(formatId || "", 80).toLowerCase();
  return FORMAT_TO_VERTICAL.get(safeFormatId) || null;
}

function normalizeVerticalId(value, formatId = null) {
  const explicit = sanitizeText(value || "", 60).toLowerCase();
  const verticalId = explicit || inferVerticalId(formatId) || "football_explainer";
  if (!VERTICAL_IDS.includes(verticalId)) fail("verticalId", { value: verticalId });
  return verticalId;
}

function verticalDescriptor(value, formatId = null) {
  return VERTICALS[normalizeVerticalId(value, formatId)];
}

function assertVerticalFormat(verticalId, formatId) {
  const descriptor = verticalDescriptor(verticalId, formatId);
  const safeFormatId = sanitizeText(formatId || "", 80).toLowerCase();
  if (!descriptor.formatIds.includes(safeFormatId)) {
    fail("formatId", { value: safeFormatId, verticalId: descriptor.verticalId });
  }
  return safeFormatId;
}

function createVerticalRegistry(overrides = {}) {
  const descriptors = new Map(Object.values(VERTICALS).map((descriptor) => [descriptor.verticalId, descriptor]));
  for (const [verticalId, descriptor] of Object.entries(overrides)) {
    if (!VERTICAL_IDS.includes(verticalId) || !descriptor || typeof descriptor !== "object") fail("verticalRegistry");
    descriptors.set(verticalId, Object.freeze({ ...VERTICALS[verticalId], ...descriptor, verticalId }));
  }
  return Object.freeze({
    get(verticalId, formatId = null) {
      const safeId = normalizeVerticalId(verticalId, formatId);
      return descriptors.get(safeId);
    },
    resolve(input = {}) {
      const descriptor = this.get(input.verticalId, input.formatId);
      assertVerticalFormat(descriptor.verticalId, input.formatId);
      return descriptor;
    },
    list() {
      return [...descriptors.values()];
    },
  });
}

module.exports = {
  DARK_CURIOSITY_FORMAT_IDS: VERTICALS.dark_curiosity.formatIds,
  FOOTBALL_FORMAT_IDS: VERTICALS.football_explainer.formatIds,
  VERTICALS,
  VERTICAL_IDS,
  assertVerticalFormat,
  createVerticalRegistry,
  inferVerticalId,
  normalizeVerticalId,
  verticalDescriptor,
};
