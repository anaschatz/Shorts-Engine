const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  ["BROWSER_TIME_SOURCE_FORBIDDEN", /\b(?:Date\.now|performance\.now)\s*\(/],
  ["BROWSER_RANDOM_SOURCE_FORBIDDEN", /\bMath\.random\s*\(/],
  ["BROWSER_FRAME_ACCUMULATION_FORBIDDEN", /\b(?:requestAnimationFrame|setInterval|setTimeout)\s*\(/],
  ["BROWSER_AUTOPLAY_FORBIDDEN", /<(?:audio|video)\b[^>]*\bautoplay\b/i],
  ["BROWSER_CSS_AUTOPLAY_FORBIDDEN", /(?:^|[;{])\s*(?:animation(?:-name)?|transition)\s*:/im],
]);

export class CompositionIsolationError extends Error {
  constructor(code) {
    super("Browser composition failed deterministic isolation validation.");
    this.name = "CompositionIsolationError";
    this.code = code;
  }
}
export function validateCompositionIsolation(html) {
  if (typeof html !== "string" || !html.length || html.length > 2_000_000) {
    throw new CompositionIsolationError("BROWSER_COMPOSITION_INVALID");
  }
  for (const [code, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(html)) throw new CompositionIsolationError(code);
  }
  if (!html.includes("window.__timelines") || !html.includes("data-composition-id=")) {
    throw new CompositionIsolationError("BROWSER_TIMELINE_MISSING");
  }
  return Object.freeze({
    valid: true,
    wallClockIndependent: true,
    seededRandomOnly: true,
    autoplayFree: true,
    frameAccumulationFree: true,
  });
}
