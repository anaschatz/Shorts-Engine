export const GENERALIZED_VISUAL_RENDERER_PROFILE_ID = "generalized_visual_recipe_renderer_v1";
export const GENERALIZED_VISUAL_RENDERER_VERSION = "1.0.0";

const STYLE_BY_COMPOSITION = Object.freeze({
  mechanism_focus: Object.freeze({
    styleId: "ember_mechanism",
    background: "#120b12",
    surface: "#251521",
    line: "#f97316",
    accent: "#fbbf24",
    secondary: "#fb7185",
  }),
  directional_causal_flow: Object.freeze({
    styleId: "violet_causality",
    background: "#0e0a18",
    surface: "#201735",
    line: "#a78bfa",
    accent: "#c4b5fd",
    secondary: "#f472b6",
  }),
  common_baseline_comparison: Object.freeze({
    styleId: "teal_comparison",
    background: "#071313",
    surface: "#102a2a",
    line: "#2dd4bf",
    accent: "#99f6e4",
    secondary: "#fbbf24",
  }),
  evidence_desk: Object.freeze({
    styleId: "paper_amber",
    background: "#151109",
    surface: "#292113",
    line: "#d6a85f",
    accent: "#fde68a",
    secondary: "#fb7185",
  }),
  uncertainty_band: Object.freeze({
    styleId: "plum_uncertainty",
    background: "#140d16",
    surface: "#2a1930",
    line: "#d8b4fe",
    accent: "#f0abfc",
    secondary: "#94a3b8",
  }),
  route_field: Object.freeze({
    styleId: "arctic_route",
    background: "#07151a",
    surface: "#0f2a32",
    line: "#67e8f9",
    accent: "#fcd34d",
    secondary: "#a7f3d0",
  }),
  expected_presence_field: Object.freeze({
    styleId: "graphite_absence",
    background: "#111113",
    surface: "#242429",
    line: "#d4d4d8",
    accent: "#fb7185",
    secondary: "#a1a1aa",
  }),
  chronology_track: Object.freeze({
    styleId: "forest_chronology",
    background: "#08130d",
    surface: "#12281b",
    line: "#4ade80",
    accent: "#bbf7d0",
    secondary: "#fbbf24",
  }),
});

export function styleForComposition(compositionFamily) {
  const style = STYLE_BY_COMPOSITION[compositionFamily];
  if (!style) throw new TypeError("Generalized visual composition style is unsupported.");
  return style;
}

export function listGeneralizedVisualStyles() {
  return Object.freeze(Object.values(STYLE_BY_COMPOSITION));
}
