import { createHash } from "node:crypto";

export const GENERALIZED_VISUAL_STYLE_V2_ID = "generalized_reference_line_art_v2";
export const GENERALIZED_VISUAL_STYLE_V2_VERSION = "2.0.0";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const BASE_SPEC = {
  id: GENERALIZED_VISUAL_STYLE_V2_ID,
  version: GENERALIZED_VISUAL_STYLE_V2_VERSION,
  benchmarkRef: "instagram_dzt2g_htwco",
  canvas: { width: 1080, height: 1920, fps: 30 },
  palette: {
    background: "#030303",
    primary: "#f8fafc",
    muted: "#94a3b8",
    accent: "#a78bfa",
    signal: "#ef4444",
    support: "#60a5fa",
  },
  regions: {
    header: { x: 72, y: 72, width: 936, height: 190 },
    stage: { x: 72, y: 300, width: 936, height: 1020 },
    semanticPhrase: { x: 86, y: 1328, width: 908, height: 112 },
    captionSafe: { x: 0, y: 1460, width: 1080, height: 460 },
  },
  typography: {
    family: "Outfit",
    promise: { weight: 600, size: 64, maximumLines: 2 },
    section: { weight: 600, size: 31, maximumLines: 1 },
    phrase: { weight: 600, size: 38, maximumLines: 2 },
    label: { weight: 600, size: 24, maximumLines: 2 },
  },
  lineArt: {
    primaryStroke: 5,
    supportingStroke: 3,
    connectorStroke: 6,
    cornerRadius: 28,
    lineCap: "round",
    lineJoin: "round",
  },
  motion: {
    easing: "ease_out_cubic",
    maximumSimultaneousOperations: 2,
    maximumScale: 1.12,
    maximumTravelPixels: 96,
    minimumSettledHoldFrames: 18,
  },
};

const STYLE_HASH = createHash("sha256").update(canonical(BASE_SPEC)).digest("hex");

export const GENERALIZED_VISUAL_STYLE_V2 = deepFreeze({
  ...BASE_SPEC,
  contentHash: STYLE_HASH,
});

const STYLE_ID_ALIASES = new Set([
  GENERALIZED_VISUAL_STYLE_V2_ID,
  "educational_line_art_reference_v1",
]);

export const GENERALIZED_VISUAL_SEMANTIC_TONES_V2 = Object.freeze([
  "primary",
  "muted",
  "accent",
  "signal",
  "support",
]);

export function validateGeneralizedVisualStyleBindingV2(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("Generalized visual style binding is invalid.");
  }
  const id = binding.id ?? binding.specId ?? binding.styleSpecId ?? binding.tokenId;
  if (!STYLE_ID_ALIASES.has(id)) {
    throw new TypeError("Generalized visual style binding is unsupported.");
  }
  const version = binding.version ?? binding.specVersion ?? binding.styleVersion;
  if (version !== undefined && ![GENERALIZED_VISUAL_STYLE_V2_VERSION, "1.0.0"].includes(version)) {
    throw new TypeError("Generalized visual style version is unsupported.");
  }
  if (binding.contentHash !== undefined && binding.contentHash !== STYLE_HASH) {
    throw new TypeError("Generalized visual style binding hash is invalid.");
  }
  return GENERALIZED_VISUAL_STYLE_V2;
}

export function colorForGeneralizedVisualToneV2(tone) {
  if (!GENERALIZED_VISUAL_SEMANTIC_TONES_V2.includes(tone)) {
    throw new TypeError("Generalized visual semantic tone is unsupported.");
  }
  return GENERALIZED_VISUAL_STYLE_V2.palette[tone];
}
