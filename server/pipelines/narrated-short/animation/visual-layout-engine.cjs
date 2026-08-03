"use strict";

const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");

const VISUAL_LAYOUT_PROFILE_ID = "engine_owned_vertical_layout_v1";
const VISUAL_LAYOUT_PROFILE_VERSION = "1.0.0";
const CANVAS = Object.freeze({ x: 0, y: 0, width: 1080, height: 1920 });
const HEADER = Object.freeze({ x: 72, y: 72, width: 936, height: 156 });
const VISUAL_ROI = Object.freeze({ x: 72, y: 276, width: 936, height: 1068 });
const CAPTION_LANE = Object.freeze({ x: 0, y: 1416, width: 1080, height: 504 });
const CENTER_TOLERANCE_PX = 54;
const MAX_SIMULTANEOUS_MOTION = 2;
const MIN_SETTLED_HOLD_FRAMES = 8;

const RECIPES = Object.freeze({
  finite_cycle: Object.freeze({
    compositionFamily: "mechanism_focus",
    geometryKind: "cycle_counter",
    primary: { x: 150, y: 372, width: 780, height: 636 },
    helper: { x: 318, y: 1074, width: 444, height: 198 },
    points: [[0.13, 0.5], [0.37, 0.5], [0.63, 0.5], [0.87, 0.5]],
  }),
  cause_effect: Object.freeze({
    compositionFamily: "directional_causal_flow",
    geometryKind: "causal_nodes",
    primary: { x: 114, y: 402, width: 852, height: 570 },
    helper: { x: 330, y: 1050, width: 420, height: 216 },
    points: [[0.18, 0.5], [0.82, 0.5]],
  }),
  comparison: Object.freeze({
    compositionFamily: "common_baseline_comparison",
    geometryKind: "comparison_axis",
    primary: { x: 126, y: 390, width: 828, height: 618 },
    helper: { x: 630, y: 1068, width: 324, height: 198 },
    points: [[0.13, 0.72], [0.46, 0.42], [0.82, 0.24]],
  }),
  evidence_inspection: Object.freeze({
    compositionFamily: "evidence_desk",
    geometryKind: "document_lens",
    primary: { x: 162, y: 342, width: 756, height: 672 },
    helper: { x: 660, y: 1056, width: 294, height: 204 },
    points: [[0.22, 0.24], [0.52, 0.5], [0.78, 0.68]],
  }),
  bounded_uncertainty: Object.freeze({
    compositionFamily: "uncertainty_band",
    geometryKind: "certainty_regions",
    primary: { x: 138, y: 408, width: 804, height: 576 },
    helper: { x: 300, y: 1056, width: 480, height: 210 },
    points: [[0.16, 0.54], [0.5, 0.54], [0.84, 0.54]],
  }),
  map_route: Object.freeze({
    compositionFamily: "route_field",
    geometryKind: "approximate_route",
    primary: { x: 90, y: 318, width: 900, height: 738 },
    helper: { x: 654, y: 1092, width: 318, height: 180 },
    points: [[0.08, 0.75], [0.29, 0.57], [0.47, 0.67], [0.67, 0.35], [0.91, 0.2]],
  }),
  negative_space_absence: Object.freeze({
    compositionFamily: "expected_presence_field",
    geometryKind: "absence_outline",
    primary: { x: 174, y: 354, width: 732, height: 654 },
    helper: { x: 336, y: 1068, width: 408, height: 198 },
    points: [[0.17, 0.5], [0.5, 0.24], [0.83, 0.5], [0.5, 0.78]],
  }),
  chronology: Object.freeze({
    compositionFamily: "chronology_track",
    geometryKind: "ordered_timeline",
    primary: { x: 96, y: 420, width: 888, height: 570 },
    helper: { x: 654, y: 1056, width: 312, height: 210 },
    points: [[0.1, 0.58], [0.3, 0.58], [0.5, 0.58], [0.7, 0.58], [0.9, 0.58]],
  }),
});

const GEOMETRY_SEMANTICS = Object.freeze({
  finite_cycle: Object.freeze({ stages: ["before", "rollover", "resolved"], persistent: "counter_receiver" }),
  cause_effect: Object.freeze({ stages: ["source", "qualified_connection", "outcome"], direction: "left_to_right" }),
  comparison: Object.freeze({ stages: ["state_a", "common_baseline", "state_b"], boundedMarkers: true }),
  evidence_inspection: Object.freeze({ stages: ["evidence_document", "inspection_lens", "settled_detail"], readableAtHold: true }),
  bounded_uncertainty: Object.freeze({ stages: ["observed", "inferred", "unknown"], unresolvedRemainsOpen: true }),
  map_route: Object.freeze({ stages: ["semantic_origin", "ordered_waypoints", "semantic_destination"], approximate: true }),
  negative_space_absence: Object.freeze({ stages: ["expected_outline", "searched_context", "absence"], contextRequired: true }),
  chronology: Object.freeze({ stages: ["ordered_events", "active_point", "settled_sequence"], boundedMarkers: true }),
});

function fail(field, reason) {
  throw new AppError(
    "GENERALIZED_VISUAL_RECIPE_PLAN_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual recipe plan did not pass validation.",
    400,
    { field, reason },
  );
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function intersects(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function assertInside(inner, outer, field) {
  if (
    inner.x < outer.x
    || inner.y < outer.y
    || inner.x + inner.width > outer.x + outer.width
    || inner.y + inner.height > outer.y + outer.height
  ) fail(field, "outside_visual_roi");
}

function compileEngineOwnedLayout(recipeId, { hasHelper = false } = {}) {
  const definition = RECIPES[recipeId];
  if (!definition) fail("recipeId", "unsupported_recipe");
  const primary = {
    entityRole: "dominant_primary",
    bounds: { ...definition.primary },
    scale: 1,
    fontSize: 42,
    focusWeight: 100,
  };
  const helper = hasHelper ? {
    entityRole: "single_helper",
    bounds: { ...definition.helper },
    scale: 0.72,
    fontSize: 30,
    focusWeight: 35,
  } : null;
  assertInside(primary.bounds, VISUAL_ROI, "layout.primary.bounds");
  if (helper) {
    assertInside(helper.bounds, VISUAL_ROI, "layout.helper.bounds");
    if (intersects(primary.bounds, helper.bounds)) fail("layout", "primary_helper_overlap");
    if (primary.bounds.width * primary.bounds.height <= helper.bounds.width * helper.bounds.height) {
      fail("layout.primary", "primary_not_dominant");
    }
  }
  if (intersects(primary.bounds, CAPTION_LANE) || (helper && intersects(helper.bounds, CAPTION_LANE))) {
    fail("layout", "caption_collision");
  }
  const primaryCenter = primary.bounds.x + primary.bounds.width / 2;
  if (Math.abs(primaryCenter - CANVAS.width / 2) > CENTER_TOLERANCE_PX) {
    fail("layout.primary.bounds", "off_center");
  }
  const points = definition.points.map(([nx, ny], index) => ({
    id: `point_${String(index + 1).padStart(2, "0")}`,
    x: Math.round(primary.bounds.x + nx * primary.bounds.width),
    y: Math.round(primary.bounds.y + ny * primary.bounds.height),
    order: index,
  }));
  return freeze({
    profileId: VISUAL_LAYOUT_PROFILE_ID,
    profileVersion: VISUAL_LAYOUT_PROFILE_VERSION,
    canvas: { ...CANVAS },
    regions: {
      header: { ...HEADER },
      visualRoi: { ...VISUAL_ROI },
      captionLane: { ...CAPTION_LANE },
    },
    compositionFamily: definition.compositionFamily,
    geometry: {
      kind: definition.geometryKind,
      points,
      semantics: { ...GEOMETRY_SEMANTICS[recipeId], stages: [...GEOMETRY_SEMANTICS[recipeId].stages] },
      disclosure: recipeId === "map_route" ? "illustrative_approximate_route" : "engine_owned_geometry",
    },
    primary,
    helper,
    constraints: {
      centerTolerancePx: CENTER_TOLERANCE_PX,
      maximumSimultaneousMotion: MAX_SIMULTANEOUS_MOTION,
      minimumSettledHoldFrames: MIN_SETTLED_HOLD_FRAMES,
      transitionOverlapFrames: 0,
    },
  });
}

function deriveNarrationPhases(scene) {
  if (scene.readabilityHold.endFrame - scene.readabilityHold.startFrame < MIN_SETTLED_HOLD_FRAMES) {
    fail(`scenes.${scene.id}.readabilityHold`, "settled_hold_too_short");
  }
  const motionEnd = scene.readabilityHold.startFrame;
  const available = motionEnd - scene.startFrame;
  if (available < 8) fail(`scenes.${scene.id}`, "insufficient_motion_window");
  const weights = [0.2, 0.3, 0.3, 0.2];
  const names = ["enter", "develop", "reveal", "resolve"];
  const boundaries = [scene.startFrame];
  let remainingFrames = available;
  let remainingPhases = names.length;
  for (let index = 0; index < names.length - 1; index += 1) {
    const weighted = Math.round(available * weights[index]);
    const length = Math.max(2, Math.min(weighted, remainingFrames - (remainingPhases - 1) * 2));
    boundaries.push(boundaries.at(-1) + length);
    remainingFrames -= length;
    remainingPhases -= 1;
  }
  boundaries.push(motionEnd);
  const phases = names.map((id, index) => ({
    id,
    startFrame: boundaries[index],
    endFrame: boundaries[index + 1],
    moving: true,
  }));
  phases.push({
    id: "hold",
    startFrame: scene.readabilityHold.startFrame,
    endFrame: scene.readabilityHold.endFrame,
    moving: false,
  });
  return freeze(phases);
}

module.exports = {
  CAPTION_LANE,
  MAX_SIMULTANEOUS_MOTION,
  MIN_SETTLED_HOLD_FRAMES,
  VISUAL_LAYOUT_PROFILE_ID,
  VISUAL_LAYOUT_PROFILE_VERSION,
  VISUAL_ROI,
  compileEngineOwnedLayout,
  deriveNarrationPhases,
};
