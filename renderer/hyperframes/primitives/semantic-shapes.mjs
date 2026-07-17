import {
  arc,
  curveCatmullRom,
  line,
  linkHorizontal,
  linkVertical,
} from "d3-shape";

export const SUPPORTED_SEMANTIC_ARCHETYPES = Object.freeze([
  "document_record_v2",
  "evidence_card_v2",
  "relationship_graph_v2",
  "map_route_v2",
  "timeline_compare_v2",
  "scale_compare_v2",
  "bounded_verdict_v2",
]);

const ARCHETYPE_SET = new Set(SUPPORTED_SEMANTIC_ARCHETYPES);
const LINE = line()
  .x((point) => point[0])
  .y((point) => point[1])
  .curve(curveCatmullRom.alpha(0.5))
  .digits(3);
const STRAIGHT_LINE = line()
  .x((point) => point[0])
  .y((point) => point[1])
  .digits(3);
const ARC = arc().digits(3);
const HORIZONTAL_LINK = linkHorizontal()
  .x((point) => point[0])
  .y((point) => point[1])
  .digits(3);
const VERTICAL_LINK = linkVertical()
  .x((point) => point[0])
  .y((point) => point[1])
  .digits(3);

function escapeSvg(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function displayText(value, maximum = 38) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function normalizedKind(entityKind) {
  const value = String(entityKind || "evidence").trim().toLowerCase();
  const tokens = new Set(value.split(/[^a-z0-9]+/).filter(Boolean));
  if (["clock", "date", "time", "timestamp", "calendar", "temporal"].some((token) => tokens.has(token))) return "temporal";
  if (["harbour", "harbor", "maritime", "route", "ship", "vessel", "lighthouse", "beacon", "coast"].some((token) => tokens.has(token))) return "maritime";
  if (["radio", "signal", "frequency", "relationship", "network", "transmission", "antenna"].some((token) => tokens.has(token))) return "radio";
  return "evidence";
}

function pathData(generator, input, label) {
  const result = generator(input);
  if (typeof result !== "string" || !result.startsWith("M")) {
    throw new TypeError(`Unable to compile deterministic ${label} path.`);
  }
  return result;
}

const CLOCK_RING = pathData(ARC, {
  innerRadius: 76,
  outerRadius: 83,
  startAngle: 0,
  endAngle: Math.PI * 2,
}, "clock ring");
const CLOCK_PROGRESS = pathData(ARC, {
  innerRadius: 88,
  outerRadius: 94,
  startAngle: -Math.PI / 2,
  endAngle: Math.PI * 0.63,
  cornerRadius: 3,
}, "clock progress");
const VERDICT_RING = pathData(ARC, {
  innerRadius: 106,
  outerRadius: 113,
  startAngle: -Math.PI * 0.84,
  endAngle: Math.PI * 0.84,
  cornerRadius: 3,
}, "verdict ring");

const PRIMITIVE_PATHS = Object.freeze({
  temporal: Object.freeze({
    clockRing: CLOCK_RING,
    clockProgress: CLOCK_PROGRESS,
    pulse: pathData(LINE, [[248, 520], [282, 520], [302, 484], [329, 556], [355, 500], [382, 520], [472, 520]], "temporal pulse"),
    route: pathData(LINE, [[126, 642], [208, 610], [286, 654], [366, 592], [458, 630], [582, 572]], "temporal route"),
    link: pathData(VERTICAL_LINK, { source: [360, 340], target: [360, 650] }, "temporal link"),
  }),
  maritime: Object.freeze({
    wave: pathData(LINE, [[102, 642], [162, 626], [222, 642], [282, 626], [342, 642], [402, 626], [462, 642], [522, 626], [582, 642]], "maritime wave"),
    route: pathData(LINE, [[120, 592], [198, 548], [278, 576], [356, 486], [454, 526], [584, 430]], "maritime route"),
    coast: pathData(LINE, [[84, 372], [142, 404], [186, 384], [250, 418], [318, 394], [378, 430]], "coast line"),
    link: pathData(HORIZONTAL_LINK, { source: [176, 518], target: [548, 438] }, "maritime link"),
  }),
  radio: Object.freeze({
    wave: pathData(LINE, [[112, 520], [168, 520], [202, 466], [246, 574], [294, 438], [346, 600], [402, 476], [452, 548], [500, 520], [596, 520]], "radio wave"),
    relationshipA: pathData(HORIZONTAL_LINK, { source: [154, 520], target: [360, 420] }, "radio relationship"),
    relationshipB: pathData(HORIZONTAL_LINK, { source: [360, 420], target: [566, 520] }, "radio relationship"),
    relationshipC: pathData(VERTICAL_LINK, { source: [360, 420], target: [360, 654] }, "radio relationship"),
  }),
  evidence: Object.freeze({
    pulse: pathData(LINE, [[120, 528], [196, 528], [238, 474], [282, 582], [334, 448], [388, 550], [438, 500], [492, 528], [596, 528]], "evidence pulse"),
    route: pathData(LINE, [[118, 610], [210, 574], [298, 602], [382, 520], [476, 548], [588, 458]], "evidence route"),
    link: pathData(HORIZONTAL_LINK, { source: [168, 522], target: [552, 522] }, "evidence link"),
  }),
});

export function semanticPrimitivePaths(entityKind) {
  return PRIMITIVE_PATHS[normalizedKind(entityKind)];
}

export function semanticRoutePath(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 12) {
    throw new TypeError("Semantic route requires between two and twelve normalized points.");
  }
  const scaled = points.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
      throw new TypeError("Semantic route contains an invalid normalized point.");
    }
    return [96 + point[0] * 528, 420 + point[1] * 300];
  });
  return pathData(LINE, scaled, "storyboard route");
}

function temporalMotif() {
  return `<g class="semantic-motif temporal-motif" data-motif-kind="clock_date" transform="translate(360 478)">
 <rect x="-154" y="-174" width="308" height="102" rx="18" class="surface secondary-surface"/>
 <line x1="-154" y1="-134" x2="154" y2="-134" class="thin-line"/>
 <circle cx="-112" cy="-154" r="5" class="accent-fill"/><circle cx="-88" cy="-154" r="5" class="accent-fill"/>
 <g class="calendar-grid">${[
    [-112, -111], [-72, -111], [-32, -111], [8, -111], [48, -111], [88, -111],
    [-112, -91], [-72, -91], [-32, -91], [8, -91], [48, -91], [88, -91],
  ].map(([x, y], index) => `<circle cx="${x}" cy="${y}" r="${index === 8 ? 7 : 3}" class="${index === 8 ? "warm-fill semantic-emphasis" : "muted-fill"}"/>`).join("")}</g>
 <g transform="translate(0 40)">
  <path d="${CLOCK_RING}" class="semantic-draw-path cool-stroke"/>
  <path d="${CLOCK_PROGRESS}" class="semantic-draw-path warm-stroke"/>
  <line x1="0" y1="0" x2="0" y2="-48" class="clock-hand cool-stroke"/><line x1="0" y1="0" x2="42" y2="18" class="clock-hand warm-stroke"/>
  <circle r="8" class="bright-fill semantic-emphasis"/>
 </g>
</g>`;
}

function maritimeMotif() {
  const paths = PRIMITIVE_PATHS.maritime;
  return `<g class="semantic-motif maritime-motif" data-motif-kind="harbor_route">
 <path d="${paths.coast}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.route}" class="semantic-draw-path route-stroke"/>
 <path d="${paths.wave}" class="semantic-draw-path cool-stroke"/>
 <g transform="translate(152 470)" class="lighthouse semantic-emphasis">
  <path d="M-28 124 L-17 6 H17 L28 124 Z" class="surface" stroke="currentColor"/>
  <rect x="-25" y="-24" width="50" height="34" rx="7" class="warm-surface"/>
  <path d="M-19 -24 L0 -48 L19 -24" class="warm-stroke"/>
  <path d="M24 -6 L172 -52 L172 32 Z" class="beacon-fill"/>
 </g>
 <g transform="translate(518 568)" class="vessel semantic-emphasis">
  <path d="M-58 12 H58 L38 42 H-38 Z" class="surface" stroke="currentColor"/>
  <rect x="-22" y="-12" width="48" height="24" rx="5" class="secondary-surface"/>
  <line x1="4" y1="-12" x2="4" y2="-48" class="thin-line"/><path d="M6 -45 L42 -28 L6 -18 Z" class="accent-fill"/>
 </g>
</g>`;
}

function radioMotif() {
  const paths = PRIMITIVE_PATHS.radio;
  return `<g class="semantic-motif radio-motif" data-motif-kind="radio_relationship">
 <path d="${paths.relationshipA}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.relationshipB}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.relationshipC}" class="semantic-draw-path muted-stroke"/>
 <circle cx="154" cy="520" r="34" class="node cool-surface semantic-emphasis"/>
 <circle cx="360" cy="420" r="42" class="node warm-surface semantic-emphasis"/>
 <circle cx="566" cy="520" r="34" class="node cool-surface semantic-emphasis"/>
 <circle cx="360" cy="654" r="29" class="node secondary-surface semantic-emphasis"/>
 <path d="${paths.wave}" class="semantic-draw-path signal-stroke"/>
 <g transform="translate(360 420)"><path d="M-42 -34 Q8 -48 42 -10 Q28 34 -18 46 Q-34 10 -42 -34 Z" class="surface"/><line x1="-18" y1="45" x2="-42" y2="82" class="warm-stroke"/><line x1="-55" y1="82" x2="-29" y2="82" class="warm-stroke"/></g>
</g>`;
}

function evidenceMotif() {
  const paths = PRIMITIVE_PATHS.evidence;
  return `<g class="semantic-motif evidence-motif" data-motif-kind="evidence">
 <path d="${paths.link}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.pulse}" class="semantic-draw-path signal-stroke"/>
 <circle cx="168" cy="522" r="42" class="node cool-surface semantic-emphasis"/>
 <circle cx="552" cy="522" r="42" class="node warm-surface semantic-emphasis"/>
</g>`;
}

function motifFor(entityKind) {
  const kind = normalizedKind(entityKind);
  if (kind === "temporal") return temporalMotif();
  if (kind === "maritime") return maritimeMotif();
  if (kind === "radio") return radioMotif();
  return evidenceMotif();
}

function headerMarkup(scenePlan, role) {
  const secondary = scenePlan.secondaryLabel
    ? `<text id="scene-secondary-${escapeSvg(role)}" x="72" y="378" class="secondary-label" data-legibility-role="secondary" data-contrast-background="#07111f">${escapeSvg(displayText(scenePlan.secondaryLabel, 44))}</text>`
    : "";
  return `<g class="scene-copy">
 <text x="72" y="246" class="role-label">${escapeSvg(role).toUpperCase()}</text>
 <text id="scene-heading-${escapeSvg(role)}" x="72" y="294" class="scene-heading" data-legibility-role="key" data-contrast-background="#07111f">${escapeSvg(displayText(scenePlan.heading, 34))}</text>
 <text id="scene-primary-${escapeSvg(role)}" x="72" y="342" class="primary-label" data-legibility-role="key" data-contrast-background="#07111f">${escapeSvg(displayText(scenePlan.primaryLabel, 38))}</text>
 ${secondary}
</g>`;
}

function documentMarkup(scenePlan, role) {
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 28)">
 <rect x="92" y="386" width="536" height="396" rx="30" class="surface" stroke="currentColor"/>
 <path d="M548 386 H598 Q628 386 628 416 V466 Z" class="secondary-surface"/>
 <line x1="128" y1="430" x2="474" y2="430" class="semantic-draw-path muted-stroke"/>
 <line x1="128" y1="458" x2="408" y2="458" class="semantic-draw-path muted-stroke"/>
 ${motifFor(scenePlan.entityKind)}
</g>`;
}

function evidenceCardMarkup(scenePlan, role) {
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 26)">
 <rect x="76" y="392" width="568" height="382" rx="34" class="surface" stroke="currentColor"/>
 <rect x="76" y="392" width="12" height="382" rx="6" class="accent-fill semantic-emphasis"/>
 <circle cx="592" cy="440" r="17" class="warm-fill semantic-emphasis"/>
 ${motifFor(scenePlan.entityKind)}
</g>`;
}

function relationshipMarkup(scenePlan, role) {
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 18)">
 <rect x="72" y="394" width="576" height="390" rx="30" class="surface" stroke="currentColor"/>
 ${motifFor(scenePlan.entityKind)}
</g>`;
}

function mapRouteMarkup(scenePlan, role) {
  const paths = semanticPrimitivePaths(scenePlan.entityKind);
  const route = scenePlan.geometry?.points?.length
    ? semanticRoutePath(scenePlan.geometry.points)
    : paths.route || paths.wave || paths.pulse;
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 18)">
 <rect x="66" y="394" width="588" height="398" rx="30" class="surface" stroke="currentColor"/>
 <path d="M100 430 C192 394 240 458 320 424 C402 390 472 448 618 410" class="thin-line"/>
 <path d="M94 714 C206 650 294 750 404 696 C486 656 548 696 626 660" class="thin-line"/>
 <path d="${route}" class="semantic-draw-path route-stroke"/>
 ${motifFor(scenePlan.entityKind)}
</g>`;
}

function timelineMarkup(scenePlan, role) {
  const paths = semanticPrimitivePaths(scenePlan.entityKind);
  const connector = paths.link || paths.route || paths.pulse || paths.wave;
  const secondary = scenePlan.secondaryLabel
    ? `<text id="timeline-secondary-${escapeSvg(role)}" x="118" y="626" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.secondaryLabel, 36))}</text>`
    : "";
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 12)">
 <rect x="72" y="408" width="576" height="364" rx="30" class="surface" stroke="currentColor"/>
 <line x1="118" y1="500" x2="602" y2="500" class="muted-stroke"/>
 <line x1="118" y1="654" x2="602" y2="654" class="muted-stroke"/>
 <path d="${connector}" class="semantic-draw-path route-stroke" opacity=".72"/>
 <circle cx="180" cy="500" r="13" class="cool-fill semantic-emphasis"/><circle cx="540" cy="500" r="13" class="warm-fill semantic-emphasis"/>
 <circle cx="220" cy="654" r="13" class="cool-fill semantic-emphasis"/><circle cx="500" cy="654" r="13" class="warm-fill semantic-emphasis"/>
 <text id="timeline-primary-${escapeSvg(role)}" x="118" y="472" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.primaryLabel, 36))}</text>
 ${secondary}
</g>`;
}

function scaleMarkup(scenePlan, role) {
  const kind = normalizedKind(scenePlan.entityKind);
  const leftWidth = kind === "temporal" ? 330 : kind === "maritime" ? 238 : 392;
  const rightWidth = kind === "radio" ? 420 : kind === "maritime" ? 356 : 268;
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(0 10)">
 <rect x="72" y="406" width="576" height="366" rx="30" class="surface" stroke="currentColor"/>
 <text id="scale-primary-${escapeSvg(role)}" x="112" y="472" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.primaryLabel, 36))}</text>
 <rect x="112" y="500" width="468" height="34" rx="17" class="secondary-surface"/>
 <rect x="112" y="500" width="${leftWidth}" height="34" rx="17" class="cool-fill semantic-emphasis"/>
 ${scenePlan.secondaryLabel ? `<text id="scale-secondary-${escapeSvg(role)}" x="112" y="602" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.secondaryLabel, 36))}</text>` : ""}
 <rect x="112" y="630" width="468" height="34" rx="17" class="secondary-surface"/>
 <rect x="112" y="630" width="${rightWidth}" height="34" rx="17" class="warm-fill semantic-emphasis"/>
 <path d="${STRAIGHT_LINE([[112, 714], [580, 714]])}" class="semantic-draw-path muted-stroke"/>
 <g class="scale-ticks">${[112, 190, 268, 346, 424, 502, 580].map((x) => `<line x1="${x}" y1="704" x2="${x}" y2="724" class="thin-line"/>`).join("")}</g>
</g>`;
}

function verdictMarkup(scenePlan, role) {
  const kind = normalizedKind(scenePlan.entityKind);
  const glyph = kind === "temporal" ? "?" : kind === "maritime" ? "≈" : kind === "radio" ? "≠" : "?";
  return `${headerMarkup(scenePlan, role)}
<g transform="translate(360 575)">
 <path d="${VERDICT_RING}" class="semantic-draw-path warm-stroke"/>
 <circle r="92" class="surface semantic-emphasis"/>
 <text x="0" y="24" text-anchor="middle" class="verdict-glyph">${glyph}</text>
 <path d="M-176 142 H176" class="semantic-draw-path muted-stroke"/>
 <text id="verdict-primary-${escapeSvg(role)}" x="0" y="188" text-anchor="middle" class="verdict-primary" data-legibility-role="key" data-contrast-background="#07111f">${escapeSvg(displayText(scenePlan.primaryLabel, 30))}</text>
 ${scenePlan.secondaryLabel ? `<text id="verdict-secondary-${escapeSvg(role)}" x="0" y="226" text-anchor="middle" class="verdict-secondary" data-legibility-role="secondary" data-contrast-background="#07111f">${escapeSvg(displayText(scenePlan.secondaryLabel, 38))}</text>` : ""}
</g>`;
}

const ARCHETYPE_RENDERERS = Object.freeze({
  document_record_v2: documentMarkup,
  evidence_card_v2: evidenceCardMarkup,
  relationship_graph_v2: relationshipMarkup,
  map_route_v2: mapRouteMarkup,
  timeline_compare_v2: timelineMarkup,
  scale_compare_v2: scaleMarkup,
  bounded_verdict_v2: verdictMarkup,
});

export function archetypeSceneMarkup(scenePlan, role) {
  if (!scenePlan || typeof scenePlan !== "object" || Array.isArray(scenePlan)) {
    throw new TypeError("Semantic scene plan must be an object.");
  }
  if (!ARCHETYPE_SET.has(scenePlan.archetypeId)) {
    throw new TypeError(`Unsupported semantic archetype: ${scenePlan.archetypeId || "missing"}.`);
  }
  if (typeof role !== "string" || role.length === 0) {
    throw new TypeError("Semantic scene role is required.");
  }
  const renderer = ARCHETYPE_RENDERERS[scenePlan.archetypeId];
  return `<g class="archetype-scene" data-archetype-id="${escapeSvg(scenePlan.archetypeId)}" data-entity-kind="${escapeSvg(normalizedKind(scenePlan.entityKind))}" data-role="${escapeSvg(role)}">
${renderer(scenePlan, role)}
</g>`;
}
