const PRIMITIVE_IDS = Object.freeze([
  "panel_frame",
  "document",
  "inspection_lens",
  "counter_cells",
  "directional_connector",
  "comparison_baseline",
  "bounded_marker",
  "uncertainty_region",
  "route_path",
  "route_marker",
  "expected_object_outline",
  "chronology_axis",
  "chronology_event_marker",
  "grounded_label",
  "certainty_badge",
  "focus_ring",
]);

const PRIMITIVE_SET = new Set(PRIMITIVE_IDS);

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function n(value) {
  if (!Number.isFinite(value)) throw new TypeError("Primitive coordinate is invalid.");
  return Number(value.toFixed(3));
}

function attrs(primitiveId, role, bounds, extra = "") {
  if (!PRIMITIVE_SET.has(primitiveId)) throw new TypeError("Visual primitive is not allowlisted.");
  return `data-primitive="${primitiveId}" data-semantic-role="${escapeXml(role)}" data-bounds="${n(bounds.x)},${n(bounds.y)},${n(bounds.width)},${n(bounds.height)}" data-caption-policy="avoid" ${extra}`;
}

function pathFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 12) {
    throw new TypeError("Primitive points are invalid.");
  }
  return points.map((point, index) => `${index ? "L" : "M"}${n(point.x)} ${n(point.y)}`).join(" ");
}

function fittedLines(text, size, maximumWidth, maximumLines) {
  const limit = Math.max(8, Math.floor(maximumWidth / (size * 0.56)));
  const words = text.split(/\s+/);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1) || "";
    if (!current || `${current} ${word}`.length > limit) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (lines.length > maximumLines) {
    const remainder = lines.slice(maximumLines - 1).join(" ");
    lines.splice(maximumLines - 1, Infinity, remainder);
  }
  return { lines, limit };
}

function label(value, x, y, size, cssClass = "grounded-copy", anchor = "middle", maximumWidth = 720, maximumLines = 2) {
  const text = String(value || "").trim();
  if (!text || text.length > 160) throw new TypeError("Grounded label is invalid.");
  const { lines, limit } = fittedLines(text, size, maximumWidth, maximumLines);
  const startY = y - ((lines.length - 1) * size * 0.58);
  return `<text x="${n(x)}" y="${n(startY)}" font-size="${n(size)}" text-anchor="${anchor}" class="${cssClass}" data-text-fit="${lines.length}">${lines.map((line, index) => `<tspan x="${n(x)}" dy="${index ? n(size * 1.16) : 0}"${line.length > limit ? ` textLength="${n(maximumWidth)}" lengthAdjust="spacingAndGlyphs"` : ""}>${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function panel(scene, role = "primary_panel") {
  const bounds = scene.layout.primary.bounds;
  return `<rect ${attrs("panel_frame", role, bounds)} x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="42" class="surface panel-frame"/>`;
}

function groundedLabels(scene) {
  const bounds = scene.layout.primary.bounds;
  const center = bounds.x + bounds.width / 2;
  const headingY = bounds.y + 62;
  const secondary = scene.grounded.secondaryLabel
    ? label(scene.grounded.secondaryLabel, center, bounds.y + bounds.height - 58, 28, "secondary-copy", "middle", bounds.width - 96, 2)
    : "";
  return `<g ${attrs("grounded_label", "grounded_story_copy", bounds)} data-legibility-role="key">
    ${label(scene.grounded.heading, center, headingY, 38, "heading-copy", "middle", bounds.width - 240, 2)}
    ${label(scene.grounded.primaryLabel, center, bounds.y + bounds.height - 118, 34, "grounded-copy", "middle", bounds.width - 96, 2)}
    ${secondary}
  </g>`;
}

export function renderGeneralizedVisualHelper(scene) {
  if (!scene.layout.helper) return "";
  const b = scene.layout.helper.bounds;
  return `<g data-helper="true" data-reveal="reveal">
    <rect ${attrs("panel_frame", "single_helper", b)} x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="28" class="helper-surface"/>
    <g ${attrs("grounded_label", "helper_grounded_copy", b)} data-legibility-role="secondary">
      ${label(scene.grounded.onScreenText, b.x + b.width / 2, b.y + b.height / 2 + 10, 26, "helper-copy", "middle", b.width - 56, 3)}
    </g>
  </g>`;
}

function certainty(scene) {
  const bounds = scene.layout.primary.bounds;
  const width = 184;
  const badge = { x: bounds.x + bounds.width - width - 24, y: bounds.y + 24, width, height: 52 };
  return `<g ${attrs("certainty_badge", "story_certainty", badge)} data-certainty="${escapeXml(scene.grounded.certainty)}">
    <rect x="${badge.x}" y="${badge.y}" width="${badge.width}" height="${badge.height}" rx="26" class="badge-surface"/>
    ${label(scene.grounded.certainty.toUpperCase(), badge.x + badge.width / 2, badge.y + 35, 20, "badge-copy")}
  </g>`;
}

function focusRing(scene) {
  const bounds = scene.layout.primary.bounds;
  const ring = { x: bounds.x + 16, y: bounds.y + 16, width: bounds.width - 32, height: bounds.height - 32 };
  return `<rect ${attrs("focus_ring", "resolve_focus", ring, 'data-focus-ring="true" data-reveal="resolve"')} x="${ring.x}" y="${ring.y}" width="${ring.width}" height="${ring.height}" rx="34" class="focus-ring"/>`;
}

function finiteCycle(scene) {
  const b = scene.layout.primary.bounds;
  const cellWidth = 132;
  const gap = 24;
  const total = cellWidth * 4 + gap * 3;
  const startX = b.x + (b.width - total) / 2;
  const y = b.y + 188;
  const cells = Array.from({ length: 4 }, (_, index) => {
    const x = startX + index * (cellWidth + gap);
    return `<g data-cycle-cell="${index}"><rect x="${n(x)}" y="${n(y)}" width="${cellWidth}" height="168" rx="28" class="counter-cell"/><circle cx="${n(x + cellWidth / 2)}" cy="${n(y + 58)}" r="18" class="counter-dot"/><path d="M${n(x + 34)} ${n(y + 116)}H${n(x + 98)}" class="accent-stroke"/></g>`;
  }).join("");
  const bounds = { x: startX, y, width: total, height: 168 };
  return `${panel(scene)}<g ${attrs("counter_cells", "persistent_cycle_counter", bounds)}>${cells}<path data-draw-path="true" pathLength="100" d="M${n(b.x + 170)} ${n(y + 226)}C${n(b.x + 260)} ${n(y + 300)} ${n(b.x + b.width - 260)} ${n(y + 300)} ${n(b.x + b.width - 170)} ${n(y + 226)}" class="line-art cycle-arrow"/><path d="M${n(b.x + b.width - 202)} ${n(y + 210)}L${n(b.x + b.width - 170)} ${n(y + 226)} ${n(b.x + b.width - 196)} ${n(y + 250)}" class="line-art"/></g>`;
}

function causeEffect(scene) {
  const b = scene.layout.primary.bounds;
  const [left, right] = scene.layout.geometry.points;
  const nodeBounds = { x: left.x - 92, y: left.y - 92, width: right.x - left.x + 184, height: 184 };
  const dash = scene.grounded.certainty === "verified" ? "" : ' stroke-dasharray="14 12"';
  return `${panel(scene)}<g ${attrs("directional_connector", "qualified_direction", nodeBounds)}>
    <circle cx="${left.x}" cy="${left.y}" r="78" class="node-surface"/>
    <circle cx="${right.x}" cy="${right.y}" r="78" class="node-surface reveal-node" data-reveal="reveal"/>
    <path data-draw-path="true" pathLength="100" d="M${left.x + 82} ${left.y}H${right.x - 94}" class="accent-stroke"${dash}/>
    <path d="M${right.x - 120} ${right.y - 24}L${right.x - 88} ${right.y} ${right.x - 120} ${right.y + 24}" class="accent-stroke"${dash}/>
  </g>`;
}

function comparison(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const baselineY = Math.max(...points.map((point) => point.y));
  const bounds = { x: points[0].x - 30, y: Math.min(...points.map((point) => point.y)) - 42, width: points.at(-1).x - points[0].x + 60, height: baselineY - Math.min(...points.map((point) => point.y)) + 84 };
  return `${panel(scene)}<g ${attrs("comparison_baseline", "common_baseline", bounds)}>
    <path d="M${points[0].x} ${baselineY}H${points.at(-1).x}" class="line-art baseline"/>
    ${points.slice(1).map((point, index) => `<g ${attrs("bounded_marker", `comparison_marker_${index + 1}`, { x: point.x - 28, y: point.y - 28, width: 56, height: baselineY - point.y + 56 }, 'data-reveal="reveal"')}><line x1="${point.x}" y1="${baselineY}" x2="${point.x}" y2="${point.y}" class="accent-stroke"/><circle cx="${point.x}" cy="${point.y}" r="22" class="marker-fill"/></g>`).join("")}
  </g>`;
}

function evidenceInspection(scene) {
  const b = scene.layout.primary.bounds;
  const doc = { x: b.x + 94, y: b.y + 86, width: b.width - 248, height: b.height - 250 };
  const lens = { x: doc.x + doc.width - 112, y: doc.y + doc.height - 118, width: 210, height: 210 };
  return `${panel(scene)}<g ${attrs("document", "evidence_document", doc)}><rect x="${doc.x}" y="${doc.y}" width="${doc.width}" height="${doc.height}" rx="24" class="paper-surface"/><path d="M${doc.x + 48} ${doc.y + 74}H${doc.x + doc.width - 48}M${doc.x + 48} ${doc.y + 132}H${doc.x + doc.width - 94}M${doc.x + 48} ${doc.y + 190}H${doc.x + doc.width - 62}" class="document-lines"/></g><g ${attrs("inspection_lens", "inspection_focus", lens, 'data-reveal="reveal"')}><circle cx="${lens.x + 84}" cy="${lens.y + 84}" r="74" class="lens-ring"/><line x1="${lens.x + 138}" y1="${lens.y + 138}" x2="${lens.x + 198}" y2="${lens.y + 198}" class="accent-stroke"/></g>`;
}

function boundedUncertainty(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const regionWidth = Math.floor((b.width - 128) / 3);
  return `${panel(scene)}<g data-uncertainty-regions="true">${points.map((point, index) => {
    const region = { x: b.x + 40 + index * (regionWidth + 24), y: b.y + 138, width: regionWidth, height: 248 };
    const classes = ["observed-region", "inferred-region", "unknown-region"];
    return `<g ${attrs("uncertainty_region", `certainty_region_${index + 1}`, region, index ? 'data-reveal="reveal"' : "")}><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" rx="32" class="${classes[index]}"/><circle cx="${region.x + region.width / 2}" cy="${region.y + 92}" r="32" class="region-symbol"/><path d="M${region.x + 44} ${region.y + 174}H${region.x + region.width - 44}" class="line-art"/></g>`;
  }).join("")}</g>`;
}

function mapRoute(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const path = pathFromPoints(points);
  return `${panel(scene)}<g ${attrs("route_path", "illustrative_approximate_route", b)}><path d="M${b.x + 38} ${b.y + 94}C${b.x + 168} ${b.y + 26} ${b.x + 280} ${b.y + 148} ${b.x + 410} ${b.y + 80}S${b.x + 650} ${b.y + 42} ${b.x + b.width - 38} ${b.y + 124}V${b.y + b.height - 88}C${b.x + 650} ${b.y + b.height - 154} ${b.x + 510} ${b.y + b.height - 34} ${b.x + 340} ${b.y + b.height - 112}S${b.x + 120} ${b.y + b.height - 52} ${b.x + 38} ${b.y + b.height - 126}Z" class="map-field"/><path data-draw-path="true" pathLength="100" d="${path}" class="accent-stroke route-line"/>${points.map((point, index) => `<circle ${attrs("route_marker", `ordered_route_marker_${index + 1}`, { x: point.x - 16, y: point.y - 16, width: 32, height: 32 }, index ? 'data-reveal="reveal"' : "")} cx="${point.x}" cy="${point.y}" r="16" class="${index === points.length - 1 ? "marker-fill" : "route-dot"}"/>`).join("")}${label(scene.layout.geometry.disclosure.replaceAll("_", " ").toUpperCase(), b.x + b.width / 2, b.y + 118, 18, "disclosure-copy", "middle", b.width - 300, 1)}</g>`;
}

function negativeSpace(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const outline = pathFromPoints([...points, points[0]]);
  return `${panel(scene)}<g ${attrs("expected_object_outline", "expected_presence_context", b)}><path d="${outline}" class="expected-outline"/><circle cx="${b.x + b.width / 2}" cy="${b.y + b.height / 2}" r="142" class="search-field"/><path data-draw-path="true" pathLength="100" d="M${b.x + 94} ${b.y + 118}L${b.x + b.width - 94} ${b.y + b.height - 118}M${b.x + b.width - 94} ${b.y + 118}L${b.x + 94} ${b.y + b.height - 118}" class="search-rays"/><circle data-reveal="reveal" cx="${b.x + b.width / 2}" cy="${b.y + b.height / 2}" r="46" class="absence-center"/></g>`;
}

function chronology(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const axis = { x: points[0].x, y: points[0].y - 46, width: points.at(-1).x - points[0].x, height: 92 };
  return `${panel(scene)}<g ${attrs("chronology_axis", "ordered_chronology", axis)}><path data-draw-path="true" pathLength="100" d="M${points[0].x} ${points[0].y}H${points.at(-1).x}" class="accent-stroke"/>${points.map((point, index) => `<g ${attrs("chronology_event_marker", `chronology_event_${index + 1}`, { x: point.x - 24, y: point.y - 24, width: 48, height: 48 }, index ? 'data-reveal="reveal"' : "")} data-chronology-index="${index}"><circle cx="${point.x}" cy="${point.y}" r="${index === 2 ? 22 : 14}" class="${index === 2 ? "marker-fill active-chronology" : "route-dot"}"/><line x1="${point.x}" y1="${point.y - 42}" x2="${point.x}" y2="${point.y + 42}" class="line-art"/></g>`).join("")}</g>`;
}

const RECIPE_RENDERERS = Object.freeze({
  finite_cycle: finiteCycle,
  cause_effect: causeEffect,
  comparison,
  evidence_inspection: evidenceInspection,
  bounded_uncertainty: boundedUncertainty,
  map_route: mapRoute,
  negative_space_absence: negativeSpace,
  chronology,
});

export function renderGeneralizedVisualRecipe(scene) {
  const renderer = RECIPE_RENDERERS[scene.recipeId];
  if (!renderer) throw new TypeError("Generalized visual recipe is unsupported.");
  return `<g data-recipe-tree="${scene.recipeId}">${renderer(scene)}${groundedLabels(scene)}${certainty(scene)}${focusRing(scene)}</g>`;
}

export function listGeneralizedVisualPrimitives() {
  return PRIMITIVE_IDS;
}
