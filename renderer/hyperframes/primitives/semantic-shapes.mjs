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

export function semanticTextLines(value, maximum = 24, maximumLines = 2) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text || !Number.isInteger(maximum) || maximum < 8 || !Number.isInteger(maximumLines) || maximumLines < 1 || maximumLines > 3) {
    throw new TypeError("Semantic text wrapping input is invalid.");
  }
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximum) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length <= maximumLines && lines.every((line) => line.length <= maximum)) return Object.freeze(lines);
  const visible = lines.slice(0, maximumLines);
  visible[maximumLines - 1] = displayText(lines.slice(maximumLines - 1).join(" "), maximum);
  return Object.freeze(visible);
}

function textBlock({ id, x, y, className, role, background, lines, lineHeight, anchor = null }) {
  const anchorAttribute = anchor ? ` text-anchor="${escapeSvg(anchor)}"` : "";
  const tspans = lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvg(line)}</tspan>`).join("");
  return `<text id="${escapeSvg(id)}" x="${x}" y="${y}" class="${escapeSvg(className)}"${anchorAttribute} data-legibility-role="${escapeSvg(role)}" data-contrast-background="${escapeSvg(background)}">${tspans}</text>`;
}

function normalizedKind(entityKind) {
  const value = String(entityKind || "evidence").trim().toLowerCase();
  const tokens = new Set(value.split(/[^a-z0-9]+/).filter(Boolean));
  if (["clock", "date", "time", "timestamp", "calendar", "temporal"].some((token) => tokens.has(token))) return "temporal";
  if (["arctic", "icebound", "packice"].some((token) => tokens.has(token))) return "arctic";
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
  arctic: Object.freeze({
    packEdge: pathData(LINE, [[84, 690], [146, 660], [208, 676], [270, 640], [342, 664], [414, 624], [486, 646], [562, 604], [632, 622]], "arctic pack edge"),
    drift: pathData(LINE, [[128, 652], [214, 618], [302, 574], [398, 548], [486, 496], [582, 458]], "arctic drift"),
    current: pathData(LINE, [[104, 724], [172, 708], [240, 724], [308, 708], [376, 724], [444, 708], [512, 724], [580, 708]], "arctic current"),
    smoke: pathData(LINE, [[384, 486], [370, 460], [390, 438], [378, 412]], "steamer smoke"),
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

function semanticRouteCoordinates(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 12) {
    throw new TypeError("Semantic route requires between two and twelve normalized points.");
  }
  return points.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
      throw new TypeError("Semantic route contains an invalid normalized point.");
    }
    return [
      Number((96 + point[0] * 528).toFixed(3)),
      Number((420 + point[1] * 300).toFixed(3)),
    ];
  });
}

export function semanticRoutePath(points) {
  return pathData(LINE, semanticRouteCoordinates(points), "storyboard route");
}

function semanticMotionOverlay(path, motionKey) {
  const key = escapeSvg(motionKey);
  return `<path d="${path}" class="semantic-flow-path" data-semantic-motion-path="${key}"/>
 <g class="semantic-motion-cursor" data-semantic-motion-cursor="${key}" opacity="0">
  <circle r="18" class="semantic-motion-halo"/>
  <circle r="9" class="bright-fill"/>
  <circle r="3" class="warm-fill"/>
 </g>`;
}

function temporalMotif({ includeMotionOverlay = true, motionKey = "clock-rollover" } = {}) {
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
  <line x1="0" y1="0" x2="0" y2="-48" class="clock-hand cool-stroke" data-semantic-clock-hand="rollover"/>
  <line x1="0" y1="0" x2="42" y2="18" class="clock-hand warm-stroke" data-semantic-clock-hand="reference"/>
  <circle r="8" class="bright-fill semantic-emphasis"/>
  ${includeMotionOverlay ? semanticMotionOverlay(CLOCK_RING, motionKey) : ""}
 </g>
</g>`;
}

function maritimeMotif({ includeMotionOverlay = true, motionKey = "maritime-route" } = {}) {
  const paths = PRIMITIVE_PATHS.maritime;
  return `<g class="semantic-motif maritime-motif" data-motif-kind="harbor_route">
 <path d="${paths.coast}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.route}" class="semantic-draw-path route-stroke"/>
 <path d="${paths.wave}" class="semantic-draw-path cool-stroke"/>
 ${includeMotionOverlay ? semanticMotionOverlay(paths.route, motionKey) : ""}
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

function arcticMotif({
  showDefaultRoute = true,
  sightingPoints = null,
  includeMotionOverlay = true,
  motionKey = "arctic-drift",
} = {}) {
  const paths = PRIMITIVE_PATHS.arctic;
  const markers = Array.isArray(sightingPoints) && sightingPoints.length
    ? sightingPoints
    : [[128, 652], [302, 574], [486, 496], [582, 458]];
  return `<g class="semantic-motif arctic-motif" data-motif-kind="arctic_drift">
 <path d="${paths.packEdge}" class="semantic-draw-path cool-stroke" data-arctic-feature="pack-ice-edge"/>
 ${showDefaultRoute ? `<path d="${paths.drift}" class="semantic-draw-path route-stroke" data-arctic-feature="drift-path"/>` : ""}
 <path d="${paths.current}" class="semantic-draw-path muted-stroke" data-arctic-feature="under-ice-current"/>
 ${includeMotionOverlay ? semanticMotionOverlay(paths.drift, motionKey) : ""}
 <g class="pack-ice" data-arctic-feature="pack-ice">
  <path d="M88 690 L144 664 L198 678 L168 724 L104 728 Z" class="cool-surface semantic-emphasis"/>
  <path d="M210 676 L272 642 L330 662 L312 718 L242 724 Z" class="secondary-surface semantic-emphasis"/>
  <path d="M424 626 L486 648 L544 616 L604 632 L584 704 L504 716 L446 688 Z" class="cool-surface semantic-emphasis"/>
 </g>
 <g transform="translate(392 548)" class="icebound-steamer semantic-emphasis" data-arctic-feature="steamer">
  <path d="M-94 14 H92 L62 54 H-66 Z" class="surface semantic-draw-path"/>
  <rect x="-44" y="-28" width="92" height="42" rx="6" class="secondary-surface"/>
  <rect x="-18" y="-58" width="28" height="30" rx="3" class="warm-surface"/>
  <line x1="-52" y1="-28" x2="-52" y2="-66" class="semantic-draw-path muted-stroke"/>
  <path d="M-52 -66 L-18 -52 L-52 -40 Z" class="accent-fill"/>
 </g>
 <path d="${paths.smoke}" class="semantic-draw-path muted-stroke" data-arctic-feature="smoke"/>
 <g class="sighting-markers" data-arctic-feature="sightings">${markers.map(([x, y], index) => (
    `<g class="sighting-marker semantic-emphasis" data-sighting-index="${index}" transform="translate(${x} ${y})"><circle r="12" class="warm-surface"/><circle r="4" class="warm-fill"/></g>`
  )).join("")}</g>
</g>`;
}

function radioMotif({ includeMotionOverlay = true, motionKey = "radio-signal" } = {}) {
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
 ${includeMotionOverlay ? semanticMotionOverlay(paths.wave, motionKey) : ""}
 <g transform="translate(360 420)"><path d="M-42 -34 Q8 -48 42 -10 Q28 34 -18 46 Q-34 10 -42 -34 Z" class="surface"/><line x1="-18" y1="45" x2="-42" y2="82" class="warm-stroke"/><line x1="-55" y1="82" x2="-29" y2="82" class="warm-stroke"/></g>
</g>`;
}

function evidenceMotif({ includeMotionOverlay = true, motionKey = "evidence-pulse" } = {}) {
  const paths = PRIMITIVE_PATHS.evidence;
  return `<g class="semantic-motif evidence-motif" data-motif-kind="evidence">
 <path d="${paths.link}" class="semantic-draw-path muted-stroke"/>
 <path d="${paths.pulse}" class="semantic-draw-path signal-stroke"/>
 ${includeMotionOverlay ? semanticMotionOverlay(paths.pulse, motionKey) : ""}
 <circle cx="168" cy="522" r="42" class="node cool-surface semantic-emphasis"/>
 <circle cx="552" cy="522" r="42" class="node warm-surface semantic-emphasis"/>
</g>`;
}

function motifFor(entityKind, options = {}) {
  const kind = normalizedKind(entityKind);
  if (kind === "temporal") return temporalMotif(options);
  if (kind === "arctic") return arcticMotif(options);
  if (kind === "maritime") return maritimeMotif(options);
  if (kind === "radio") return radioMotif(options);
  return evidenceMotif(options);
}

function headerLayout(scenePlan, role, { includePrimary = true } = {}) {
  const headingLines = semanticTextLines(scenePlan.heading, 24, 2);
  const duplicatePrimary = String(scenePlan.primaryLabel || "").trim().replace(/\s+/g, " ").toLowerCase()
    === String(scenePlan.heading || "").trim().replace(/\s+/g, " ").toLowerCase();
  const primaryLines = includePrimary && !duplicatePrimary
    ? semanticTextLines(scenePlan.primaryLabel, 24, 2)
    : [];
  const secondaryLines = scenePlan.secondaryLabel ? semanticTextLines(scenePlan.secondaryLabel, 32, 2) : [];
  const headingY = 294;
  const primaryY = headingY + headingLines.length * 38 + 10;
  const secondaryY = primaryLines.length
    ? primaryY + primaryLines.length * 36
    : headingY + headingLines.length * 38 + 10;
  const lineCount = headingLines.length + primaryLines.length + secondaryLines.length;
  const contentOffset = Math.max(0, lineCount - 3) * 40;
  const heading = textBlock({
    id: `scene-heading-${role}`,
    x: 72,
    y: headingY,
    className: "scene-heading",
    role: "key",
    background: "#07111f",
    lines: headingLines,
    lineHeight: 38,
  });
  const primary = primaryLines.length ? textBlock({
    id: `scene-primary-${role}`,
    x: 72,
    y: primaryY,
    className: "primary-label",
    role: "key",
    background: "#07111f",
    lines: primaryLines,
    lineHeight: 36,
  }) : "";
  const secondary = secondaryLines.length ? textBlock({
    id: `scene-secondary-${role}`,
    x: 72,
    y: secondaryY,
    className: "secondary-label",
    role: "secondary",
    background: "#07111f",
    lines: secondaryLines,
    lineHeight: 32,
  }) : "";
  return Object.freeze({
    contentOffset,
    markup: `<g class="scene-copy">
 <text x="72" y="246" class="role-label">${escapeSvg(role).toUpperCase()}</text>
 ${heading}
 ${primary}
 ${secondary}
</g>`,
  });
}

function documentMarkup(scenePlan, role) {
  const header = headerLayout(scenePlan, role);
  const motionKey = `${role}-${normalizedKind(scenePlan.entityKind)}-record`;
  return `${header.markup}
<g transform="translate(0 ${28 + header.contentOffset})">
 <rect x="92" y="386" width="536" height="396" rx="30" class="surface" stroke="currentColor"/>
 <path d="M548 386 H598 Q628 386 628 416 V466 Z" class="secondary-surface"/>
 <line x1="128" y1="430" x2="474" y2="430" class="semantic-draw-path muted-stroke"/>
 <line x1="128" y1="458" x2="408" y2="458" class="semantic-draw-path muted-stroke"/>
 ${motifFor(scenePlan.entityKind, { motionKey })}
</g>`;
}

function evidenceCardMarkup(scenePlan, role) {
  const header = headerLayout(scenePlan, role);
  const motionKey = `${role}-${normalizedKind(scenePlan.entityKind)}-evidence`;
  return `${header.markup}
<g transform="translate(0 ${26 + header.contentOffset})">
 <rect x="76" y="392" width="568" height="382" rx="34" class="surface" stroke="currentColor"/>
 <rect x="76" y="392" width="12" height="382" rx="6" class="accent-fill semantic-emphasis"/>
 <circle cx="592" cy="440" r="17" class="warm-fill semantic-emphasis"/>
 ${motifFor(scenePlan.entityKind, { motionKey })}
</g>`;
}

function relationshipMarkup(scenePlan, role) {
  const header = headerLayout(scenePlan, role);
  const motionKey = `${role}-${normalizedKind(scenePlan.entityKind)}-relationship`;
  return `${header.markup}
<g transform="translate(0 ${18 + header.contentOffset})">
 <rect x="72" y="394" width="576" height="390" rx="30" class="surface" stroke="currentColor"/>
 ${motifFor(scenePlan.entityKind, { motionKey })}
</g>`;
}

function mapRouteMarkup(scenePlan, role) {
  const paths = semanticPrimitivePaths(scenePlan.entityKind);
  const routePoints = scenePlan.geometry?.points?.length
    ? semanticRouteCoordinates(scenePlan.geometry.points)
    : null;
  const route = routePoints
    ? pathData(LINE, routePoints, "storyboard route")
    : paths.route || paths.drift || paths.wave || paths.pulse;
  const header = headerLayout(scenePlan, role);
  return `${header.markup}
<g transform="translate(0 ${18 + header.contentOffset})">
 <rect x="66" y="394" width="588" height="398" rx="30" class="surface" stroke="currentColor"/>
 <path d="M100 430 C192 394 240 458 320 424 C402 390 472 448 618 410" class="thin-line"/>
 <path d="M94 714 C206 650 294 750 404 696 C486 656 548 696 626 660" class="thin-line"/>
 <path d="${route}" class="semantic-draw-path route-stroke"/>
 ${semanticMotionOverlay(route, `${role}-${normalizedKind(scenePlan.entityKind)}-route`)}
 ${motifFor(scenePlan.entityKind, {
    showDefaultRoute: !routePoints,
    sightingPoints: routePoints,
    includeMotionOverlay: false,
    motionKey: `${role}-${normalizedKind(scenePlan.entityKind)}-route`,
  })}
</g>`;
}

function timelineMarkup(scenePlan, role) {
  const paths = semanticPrimitivePaths(scenePlan.entityKind);
  const connector = paths.link || paths.route || paths.pulse || paths.wave;
  const secondary = scenePlan.secondaryLabel
    ? `<text id="timeline-secondary-${escapeSvg(role)}" x="118" y="626" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.secondaryLabel, 36))}</text>`
    : "";
  const header = headerLayout(scenePlan, role, { includePrimary: false });
  return `${header.markup}
<g transform="translate(0 ${12 + header.contentOffset})">
 <rect x="72" y="408" width="576" height="364" rx="30" class="surface" stroke="currentColor"/>
 <line x1="118" y1="500" x2="602" y2="500" class="muted-stroke"/>
 <line x1="118" y1="654" x2="602" y2="654" class="muted-stroke"/>
 <path d="${connector}" class="semantic-draw-path route-stroke" opacity=".72"/>
 ${semanticMotionOverlay(STRAIGHT_LINE([[118, 500], [602, 500]]), `${role}-timeline-comparison`)}
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
  const header = headerLayout(scenePlan, role, { includePrimary: false });
  return `${header.markup}
<g transform="translate(0 ${10 + header.contentOffset})">
 <rect x="72" y="406" width="576" height="366" rx="30" class="surface" stroke="currentColor"/>
 <text id="scale-primary-${escapeSvg(role)}" x="112" y="472" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.primaryLabel, 36))}</text>
 <rect x="112" y="500" width="468" height="34" rx="17" class="secondary-surface"/>
 <rect x="112" y="500" width="${leftWidth}" height="34" rx="17" class="cool-fill semantic-emphasis"/>
 ${scenePlan.secondaryLabel ? `<text id="scale-secondary-${escapeSvg(role)}" x="112" y="602" class="micro-label" data-legibility-role="secondary" data-contrast-background="#0b1527">${escapeSvg(displayText(scenePlan.secondaryLabel, 36))}</text>` : ""}
 <rect x="112" y="630" width="468" height="34" rx="17" class="secondary-surface"/>
 <rect x="112" y="630" width="${rightWidth}" height="34" rx="17" class="warm-fill semantic-emphasis"/>
 <path d="${STRAIGHT_LINE([[112, 714], [580, 714]])}" class="semantic-draw-path muted-stroke"/>
 ${semanticMotionOverlay(STRAIGHT_LINE([[112, 714], [580, 714]]), `${role}-scale-comparison`)}
 <g class="scale-ticks">${[112, 190, 268, 346, 424, 502, 580].map((x) => `<line x1="${x}" y1="704" x2="${x}" y2="724" class="thin-line"/>`).join("")}</g>
</g>`;
}

function verdictMarkup(scenePlan, role) {
  const kind = normalizedKind(scenePlan.entityKind);
  const glyph = kind === "temporal" ? "?" : kind === "maritime" ? "≈" : kind === "radio" ? "≠" : "?";
  const header = headerLayout(scenePlan, role, { includePrimary: false });
  const primaryLines = semanticTextLines(scenePlan.primaryLabel, 24, 2);
  const primaryY = primaryLines.length === 1 ? 188 : 172;
  const secondaryLines = scenePlan.secondaryLabel ? semanticTextLines(scenePlan.secondaryLabel, 32, 2) : [];
  const secondaryY = primaryY + primaryLines.length * 36 + 2;
  const primary = textBlock({
    id: `verdict-primary-${role}`,
    x: 0,
    y: primaryY,
    className: "verdict-primary",
    role: "key",
    background: "#07111f",
    lines: primaryLines,
    lineHeight: 36,
    anchor: "middle",
  });
  const secondary = secondaryLines.length ? textBlock({
    id: `verdict-secondary-${role}`,
    x: 0,
    y: secondaryY,
    className: "verdict-secondary",
    role: "secondary",
    background: "#07111f",
    lines: secondaryLines,
    lineHeight: 30,
    anchor: "middle",
  }) : "";
  return `${header.markup}
<g transform="translate(360 ${575 + header.contentOffset})">
 <path d="${VERDICT_RING}" class="semantic-draw-path warm-stroke"/>
 ${semanticMotionOverlay(VERDICT_RING, `${role}-bounded-verdict`)}
 <circle r="92" class="surface semantic-emphasis"/>
 <text x="0" y="24" text-anchor="middle" class="verdict-glyph">${glyph}</text>
 <path d="M-176 142 H176" class="semantic-draw-path muted-stroke"/>
 ${primary}
 ${secondary}
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
