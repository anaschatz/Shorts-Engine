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
  const words = text.split(/\s+/);
  const target = Math.max(8, Math.ceil((text.length + maximumLines - 1) / maximumLines));
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1) || "";
    const remainingSlots = maximumLines - lines.length;
    if (!current || (lines.length < maximumLines && `${current} ${word}`.length > target && remainingSlots > 0)) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  const longest = Math.max(...lines.map((line) => line.length));
  const effectiveSize = Math.max(18, Math.min(size, maximumWidth / Math.max(1, longest * .56)));
  const limit = Math.max(8, Math.floor(maximumWidth / (effectiveSize * .56)));
  return { lines, limit, effectiveSize };
}

function label(value, x, y, size, cssClass = "grounded-copy", anchor = "middle", maximumWidth = 720, maximumLines = 2) {
  const text = String(value || "").trim();
  if (!text || text.length > 160) throw new TypeError("Grounded label is invalid.");
  const { lines, limit, effectiveSize } = fittedLines(text, size, maximumWidth, maximumLines);
  const startY = y - ((lines.length - 1) * effectiveSize * 0.58);
  return `<text x="${n(x)}" y="${n(startY)}" font-size="${n(effectiveSize)}" text-anchor="${anchor}" class="${cssClass}" data-text-fit="${lines.length}" data-requested-font-size="${n(size)}">${lines.map((line, index) => `<tspan x="${n(x)}" dy="${index ? n(effectiveSize * 1.16) : 0}"${line.length > limit ? ` textLength="${n(maximumWidth)}" lengthAdjust="spacingAndGlyphs"` : ""}>${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function panel(scene, role = "primary_panel") {
  const bounds = scene.layout.primary.bounds;
  return `<rect ${attrs("panel_frame", role, bounds)} x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="42" class="surface panel-frame"/>`;
}

function groundedLabels(scene) {
  const bounds = scene.layout.primary.bounds;
  const center = bounds.x + bounds.width / 2;
  const headingY = bounds.y + 62;
  const primary = scene.grounded.primaryLabel !== scene.grounded.heading
    ? label(scene.grounded.primaryLabel, center, bounds.y + bounds.height - 118, 34, "grounded-copy", "middle", bounds.width - 96, 2)
    : "";
  const secondary = scene.grounded.secondaryLabel && scene.grounded.secondaryLabel !== scene.grounded.heading && scene.grounded.secondaryLabel !== scene.grounded.primaryLabel
    ? label(scene.grounded.secondaryLabel, center, bounds.y + bounds.height - 58, 28, "secondary-copy", "middle", bounds.width - 96, 2)
    : "";
  return `<g ${attrs("grounded_label", "grounded_story_copy", bounds)} data-legibility-role="key">
    ${label(scene.grounded.heading, bounds.x + 38, headingY, 36, "heading-copy", "start", bounds.width - 286, 2)}
    ${primary}
    ${secondary}
  </g>`;
}

export function renderGeneralizedVisualHelper(scene) {
  if (!scene.layout.helper) return "";
  const b = scene.layout.helper.bounds;
  return `<g data-helper="true" data-reveal="reveal">
    <rect ${attrs("panel_frame", "single_helper", b)} x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="28" class="helper-surface"/>
    <g ${attrs("grounded_label", "helper_grounded_copy", b)} data-legibility-role="secondary">
      ${label(scene.grounded.onScreenText, b.x + b.width / 2, b.y + b.height / 2 + 10, 30, "helper-copy", "middle", b.width - 64, 2)}
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
    return `<g data-cycle-cell="${index}"${index ? ' data-reveal="reveal"' : ""}><rect x="${n(x)}" y="${n(y)}" width="${cellWidth}" height="168" rx="28" class="counter-cell"/><circle cx="${n(x + cellWidth / 2)}" cy="${n(y + 58)}" r="18" class="counter-dot"/><path d="M${n(x + 34)} ${n(y + 116)}H${n(x + 98)}" class="accent-stroke"/></g>`;
  }).join("");
  const bounds = { x: startX, y, width: total, height: 168 };
  return `${panel(scene)}<g ${attrs("counter_cells", "persistent_cycle_counter", bounds)}>${cells}<path data-draw-path="true" pathLength="100" d="M${n(b.x + 170)} ${n(y + 226)}C${n(b.x + 260)} ${n(y + 300)} ${n(b.x + b.width - 260)} ${n(y + 300)} ${n(b.x + b.width - 170)} ${n(y + 226)}" class="line-art cycle-arrow"/><path d="M${n(b.x + b.width - 202)} ${n(y + 210)}L${n(b.x + b.width - 170)} ${n(y + 226)} ${n(b.x + b.width - 196)} ${n(y + 250)}" class="line-art"/><g data-reveal="reveal">${label("ROLLOVER", b.x + b.width / 2, y + 270, 18, "semantic-copy")}</g></g>`;
}

function causeEffect(scene) {
  const b = scene.layout.primary.bounds;
  const [left, right] = scene.layout.geometry.points;
  const nodeBounds = { x: left.x - 92, y: left.y - 92, width: right.x - left.x + 184, height: 184 };
  const dash = scene.grounded.certainty === "verified" ? "" : ' stroke-dasharray="14 12"';
  return `${panel(scene)}<g ${attrs("directional_connector", "qualified_direction", nodeBounds)}>
    <circle cx="${left.x}" cy="${left.y}" r="78" class="node-surface"/>
    ${label("INPUT", left.x, left.y + 7, 18, "semantic-copy")}
    <g data-reveal="reveal"><circle cx="${right.x}" cy="${right.y}" r="78" class="node-surface reveal-node"/>${label("RESULT", right.x, right.y + 7, 18, "semantic-copy")}</g>
    <path data-draw-path="true" pathLength="100" d="M${left.x + 82} ${left.y}H${right.x - 94}" class="accent-stroke"${dash}/>
    <path d="M${right.x - 120} ${right.y - 24}L${right.x - 88} ${right.y} ${right.x - 120} ${right.y + 24}" class="accent-stroke"${dash}/>
  </g>`;
}

function comparison(scene) {
  const b = scene.layout.primary.bounds;
  const gap = 76;
  const cardWidth = Math.floor((b.width - 120 - gap) / 2);
  const cardHeight = 250;
  const y = b.y + 166;
  const left = { x: b.x + 60, y, width: cardWidth, height: cardHeight };
  const right = { x: left.x + cardWidth + gap, y, width: cardWidth, height: cardHeight };
  const centerY = y + cardHeight / 2;
  return `${panel(scene)}<g ${attrs("comparison_baseline", "paired_state_comparison", { x: left.x, y, width: right.x + right.width - left.x, height: cardHeight })}>
    <g ${attrs("bounded_marker", "reference_state", left)}>
      <rect x="${left.x}" y="${left.y}" width="${left.width}" height="${left.height}" rx="32" class="counter-cell"/>
      ${label("BEFORE", left.x + left.width / 2, left.y + 55, 20, "semantic-copy")}
      <rect x="${left.x + 62}" y="${left.y + 112}" width="${left.width - 124}" height="62" rx="31" class="observed-region"/>
      <circle cx="${left.x + 92}" cy="${left.y + 143}" r="19" class="route-dot"/>
    </g>
    <path data-draw-path="true" pathLength="100" d="M${left.x + left.width + 14} ${centerY}H${right.x - 22}" class="accent-stroke"/>
    <path d="M${right.x - 48} ${centerY - 22}L${right.x - 18} ${centerY} ${right.x - 48} ${centerY + 22}" class="accent-stroke"/>
    <g ${attrs("bounded_marker", "result_state", right, 'data-reveal="reveal"')}>
      <rect x="${right.x}" y="${right.y}" width="${right.width}" height="${right.height}" rx="32" class="node-surface"/>
      ${label("AFTER", right.x + right.width / 2, right.y + 55, 20, "semantic-copy")}
      <rect x="${right.x + 62}" y="${right.y + 94}" width="${right.width - 124}" height="98" rx="49" class="observed-region"/>
      <circle cx="${right.x + right.width - 92}" cy="${right.y + 143}" r="25" class="marker-fill"/>
    </g>
    ${label("STATE CHANGE", b.x + b.width / 2, y + cardHeight + 48, 20, "semantic-copy")}
  </g>`;
}

function evidenceInspection(scene) {
  const b = scene.layout.primary.bounds;
  const doc = { x: b.x + 94, y: b.y + 86, width: b.width - 248, height: b.height - 250 };
  const lens = { x: doc.x + doc.width - 112, y: doc.y + doc.height - 118, width: 210, height: 210 };
  return `${panel(scene)}<g ${attrs("document", "evidence_document", doc)}><rect x="${doc.x}" y="${doc.y}" width="${doc.width}" height="${doc.height}" rx="24" class="paper-surface"/>${label("EVIDENCE", doc.x + doc.width / 2, doc.y + 52, 18, "paper-semantic-copy")}<path d="M${doc.x + 48} ${doc.y + 92}H${doc.x + doc.width - 48}M${doc.x + 48} ${doc.y + 150}H${doc.x + doc.width - 94}M${doc.x + 48} ${doc.y + 208}H${doc.x + doc.width - 62}" class="document-lines"/></g><g ${attrs("inspection_lens", "inspection_focus", lens, 'data-reveal="reveal"')}><circle cx="${lens.x + 84}" cy="${lens.y + 84}" r="74" class="lens-ring"/><line x1="${lens.x + 138}" y1="${lens.y + 138}" x2="${lens.x + 198}" y2="${lens.y + 198}" class="accent-stroke"/></g>`;
}

function boundedUncertainty(scene) {
  const b = scene.layout.primary.bounds;
  const points = scene.layout.geometry.points;
  const regionWidth = Math.floor((b.width - 128) / 3);
  return `${panel(scene)}<g data-uncertainty-regions="true">${points.map((point, index) => {
    const region = { x: b.x + 40 + index * (regionWidth + 24), y: b.y + 138, width: regionWidth, height: 248 };
    const classes = ["observed-region", "inferred-region", "unknown-region"];
    return `<g ${attrs("uncertainty_region", `certainty_region_${index + 1}`, region, index ? 'data-reveal="reveal"' : "")}><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" rx="32" class="${classes[index]}"/><circle cx="${region.x + region.width / 2}" cy="${region.y + 82}" r="28" class="region-symbol"/>${label(["OBSERVED", "INFERRED", "UNKNOWN"][index], region.x + region.width / 2, region.y + 158, 18, "semantic-copy", "middle", region.width - 28, 1)}<path d="M${region.x + 44} ${region.y + 190}H${region.x + region.width - 44}" class="line-art"/></g>`;
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
  return `${panel(scene)}<g ${attrs("expected_object_outline", "expected_presence_context", b)}><path d="${outline}" class="expected-outline"/>${label("EXPECTED", b.x + b.width / 2, b.y + 150, 18, "semantic-copy")}<circle cx="${b.x + b.width / 2}" cy="${b.y + b.height / 2}" r="142" class="search-field"/><path data-draw-path="true" pathLength="100" d="M${b.x + 94} ${b.y + 118}L${b.x + b.width - 94} ${b.y + b.height - 118}M${b.x + b.width - 94} ${b.y + 118}L${b.x + 94} ${b.y + b.height - 118}" class="search-rays"/><g data-reveal="reveal"><circle cx="${b.x + b.width / 2}" cy="${b.y + b.height / 2}" r="46" class="absence-center"/>${label("ABSENT", b.x + b.width / 2, b.y + b.height / 2 + 7, 18, "semantic-copy")}</g></g>`;
}

function chronology(scene) {
  const b = scene.layout.primary.bounds;
  const axisY = b.y + 326;
  const xs = [b.x + 120, b.x + b.width / 2, b.x + b.width - 120];
  const cardWidth = 190;
  const cardHeight = 112;
  const labels = ["START", "TURN", "NOW"];
  const axis = { x: xs[0], y: b.y + 138, width: xs[2] - xs[0], height: 258 };
  return `${panel(scene)}<g ${attrs("chronology_axis", "ordered_chronology", axis)}>
    <path data-draw-path="true" pathLength="100" d="M${xs[0] - 38} ${axisY}H${xs[2] + 46}" class="accent-stroke"/>
    <path d="M${xs[2] + 18} ${axisY - 20}L${xs[2] + 48} ${axisY} ${xs[2] + 18} ${axisY + 20}" class="accent-stroke"/>
    ${xs.map((x, index) => {
      const card = { x: x - cardWidth / 2, y: b.y + 140, width: cardWidth, height: cardHeight };
      return `<g ${attrs("chronology_event_marker", `chronology_event_${index + 1}`, card, index ? 'data-reveal="reveal"' : "")} data-chronology-index="${index}">
        <rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="26" class="${index === 2 ? "node-surface active-chronology" : "counter-cell"}"/>
        ${label(labels[index], x, card.y + 66, index === 2 ? 24 : 20, index === 2 ? "heading-copy" : "semantic-copy")}
        <line x1="${x}" y1="${card.y + card.height}" x2="${x}" y2="${axisY - 22}" class="line-art"/>
        <circle cx="${x}" cy="${axisY}" r="${index === 2 ? 24 : 17}" class="${index === 2 ? "marker-fill active-chronology" : "route-dot"}"/>
      </g>`;
    }).join("")}
    ${label("EARLIER", xs[0], axisY + 64, 18, "semantic-copy")}
    ${label("LATER", xs[2], axisY + 64, 18, "semantic-copy")}
  </g>`;
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
