import {
  GENERALIZED_VISUAL_SEMANTIC_TONES_V2,
} from "./generalized-visual-style-v2.mjs";

const ENTITY_PRIMITIVE_IDS = Object.freeze([
  "human_observer",
  "device",
  "receiver",
  "satellite",
  "vehicle",
  "wheel_digit",
  "wheel_bank",
  "numeric_token",
  "calendar",
  "clock",
  "document",
  "signal_wave",
  "graph_axis",
  "steamship",
  "ice_field",
  "weather_front",
  "hypothesis",
  "unknown_outcome",
  "generic_object",
]);

const ENTITY_ALIASES = Object.freeze({
  human: "human_observer",
  person: "human_observer",
  person_outline: "human_observer",
  observer: "human_observer",
  human_actor: "human_observer",
  counter: "wheel_digit",
  counter_digit: "wheel_digit",
  finite_counter: "wheel_digit",
  digit: "wheel_digit",
  odometer: "wheel_bank",
  digit_bank: "wheel_bank",
  number_wheels: "wheel_bank",
  number: "numeric_token",
  numeric_value: "numeric_token",
  value: "numeric_token",
  date_value: "numeric_token",
  signal: "signal_wave",
  wave: "signal_wave",
  graph: "graph_axis",
  chart: "graph_axis",
  timeline: "graph_axis",
  route: "graph_axis",
  record: "document",
  evidence: "document",
  date: "calendar",
  time: "clock",
  car: "vehicle",
  vessel: "steamship",
  steamship: "steamship",
  ship: "steamship",
  ice_environment: "ice_field",
  moving_ice_environment: "ice_field",
  ice: "ice_field",
  weather_event: "weather_front",
  weather: "weather_front",
  blizzard: "weather_front",
  crew_group: "human_observer",
  observer_group: "human_observer",
  archival_record: "document",
  rejected_interpretation: "hypothesis",
  unknown_outcome: "unknown_outcome",
  calendar_year: "calendar",
  coastal_region: "graph_axis",
  object: "generic_object",
  mapping: "generic_object",
  hypothesis: "hypothesis",
  grounded_subject: "generic_object",
  environment: "ice_field",
  unknown_region: "unknown_outcome",
});

const RELATION_PRIMITIVE_IDS = Object.freeze([
  "arrow",
  "dashed_signal",
  "timeline",
  "bracket",
  "association",
]);

const RELATION_ALIASES = Object.freeze({
  causal: "arrow",
  cause: "arrow",
  direction: "arrow",
  directed: "arrow",
  directed_edge: "arrow",
  signal: "dashed_signal",
  transmits: "dashed_signal",
  qualified: "dashed_signal",
  temporal: "timeline",
  temporal_edge: "timeline",
  cyclic: "timeline",
  comparison: "bracket",
  compare: "bracket",
  comparative: "bracket",
  context: "association",
  contextual: "association",
  association_edge: "association",
  line: "association",
  curve: "association",
});

const ID_RE = /^[a-z][a-z0-9_-]{1,119}$/;

export function escapeGeneralizedVisualXmlV2(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function number(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} is invalid.`);
  return Number(value.toFixed(3));
}

function identifier(value, field) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function normalizedEntityPrimitive(value) {
  const primitiveId = ENTITY_ALIASES[value] || value;
  if (!ENTITY_PRIMITIVE_IDS.includes(primitiveId)) {
    return "generic_object";
  }
  return primitiveId;
}

function normalizedRelationPrimitive(value) {
  const primitiveId = RELATION_ALIASES[value] || value;
  if (!RELATION_PRIMITIVE_IDS.includes(primitiveId)) {
    return "association";
  }
  return primitiveId;
}

function bounds(value, field = "bounds") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  const result = {
    x: number(value.x, `${field}.x`),
    y: number(value.y, `${field}.y`),
    width: number(value.width, `${field}.width`),
    height: number(value.height, `${field}.height`),
  };
  if (
    result.width < 36
    || result.height < 36
    || result.x < 0
    || result.y < 0
    || result.x + result.width > 1080
    || result.y + result.height > 1460
  ) throw new TypeError(`${field} is outside the visual stage.`);
  return result;
}

function toneClass(value) {
  const tone = value || "primary";
  if (!GENERALIZED_VISUAL_SEMANTIC_TONES_V2.includes(tone)) {
    throw new TypeError("Generalized visual semantic tone is unsupported.");
  }
  return `tone-${tone}`;
}

function safeCopy(value, maximum = 96) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError("Generalized visual grounded copy is invalid.");
  }
  return text;
}

function compactDisplayCopy(value, maximum, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const source = safeCopy(value, 120);
  if (source.length <= maximum) return source;
  const quantity = source.match(/(?:\b\d[\d,.:-]*(?:-bit)?(?:\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))?\b)/i)?.[0];
  if (quantity && quantity.length <= maximum) return quantity;
  const words = source.split(/\s+/);
  let result = "";
  for (const word of words) {
    if ((result ? result.length + 1 : 0) + word.length > maximum) break;
    result = result ? `${result} ${word}` : word;
  }
  return result || source.slice(0, maximum);
}

function labelLines(value, maximumCharacters = 22, maximumLines = 2) {
  const words = safeCopy(value).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1) || "";
    if (!current) lines.push(word);
    else if (current.length + word.length + 1 <= maximumCharacters) {
      lines[lines.length - 1] = `${current} ${word}`;
    } else if (lines.length < maximumLines) lines.push(word);
    else {
      lines[lines.length - 1] = `${lines.at(-1).slice(0, Math.max(1, maximumCharacters - 1)).trim()}…`;
      break;
    }
  }
  return lines;
}

function textMarkup(value, x, y, width, options = {}) {
  const lines = labelLines(value, options.maximumCharacters || 22, options.maximumLines || 2);
  if (!lines.length) return "";
  const size = number(options.size || 24, "font size");
  const lineHeight = size * 1.12;
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  return `<text x="${number(x, "text.x")}" y="${number(startY, "text.y")}" text-anchor="middle" class="${options.className || "entity-label"}" font-size="${size}" data-grounded-copy="true" data-text-width="${number(width, "text.width")}">${lines.map((line, index) => `<tspan x="${number(x, "text.x")}" dy="${index ? number(lineHeight, "lineHeight") : 0}">${escapeGeneralizedVisualXmlV2(line)}</tspan>`).join("")}</text>`;
}

function primitiveAttrs(entity, primitiveId, b) {
  const id = identifier(entity.id, "entity.id");
  return `data-entity-id="${id}" data-motion-target="${id}" data-primitive="${primitiveId}" data-semantic-role="${escapeGeneralizedVisualXmlV2(entity.role || "supporting")}" data-bounds="${b.x},${b.y},${b.width},${b.height}" data-tone="${entity.tone || "primary"}"`;
}

function humanObserver(entity, b) {
  const cx = b.x + b.width / 2;
  const headY = b.y + b.height * 0.25;
  const r = Math.min(b.width, b.height) * 0.13;
  const shoulderY = b.y + b.height * 0.47;
  const hipY = b.y + b.height * 0.72;
  return `<circle cx="${number(cx, "human.cx")}" cy="${number(headY, "human.headY")}" r="${number(r, "human.r")}" class="entity-surface"/><path d="M${number(cx, "human.cx")} ${number(headY + r, "human.neck")}V${number(hipY, "human.hip")}M${number(cx, "human.cx")} ${number(shoulderY, "human.shoulder")}L${number(b.x + b.width * .2, "human.arm")} ${number(b.y + b.height * .62, "human.armY")}M${number(cx, "human.cx")} ${number(shoulderY, "human.shoulder")}L${number(b.x + b.width * .8, "human.arm")} ${number(b.y + b.height * .55, "human.armY")}M${number(cx, "human.cx")} ${number(hipY, "human.hip")}L${number(b.x + b.width * .31, "human.leg")} ${number(b.y + b.height * .92, "human.legY")}M${number(cx, "human.cx")} ${number(hipY, "human.hip")}L${number(b.x + b.width * .69, "human.leg")} ${number(b.y + b.height * .92, "human.legY")}" class="line-art"/>`;
}

function device(entity, b) {
  const inset = Math.min(b.width, b.height) * .1;
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${number(Math.min(34, b.width * .12), "device.rx")}" class="entity-surface"/><rect x="${number(b.x + inset, "device.screenX")}" y="${number(b.y + inset, "device.screenY")}" width="${number(b.width - inset * 2, "device.screenW")}" height="${number(b.height * .55, "device.screenH")}" rx="18" class="inner-surface"/><circle cx="${number(b.x + b.width / 2, "device.cx")}" cy="${number(b.y + b.height - inset * .72, "device.cy")}" r="9" class="accent-fill"/>`;
}

function receiver(entity, b) {
  const base = device(entity, b);
  const cx = b.x + b.width * .72;
  const top = b.y;
  return `${base}<path d="M${number(cx, "receiver.cx")} ${number(top, "receiver.top")}L${number(b.x + b.width * .9, "receiver.tipX")} ${number(b.y - Math.min(52, b.height * .22), "receiver.tipY")}" class="accent-stroke"/><path d="M${number(b.x + b.width * .82, "receiver.waveX")} ${number(b.y + b.height * .14, "receiver.waveY")}Q${number(b.x + b.width * .98, "receiver.waveCx")} ${number(b.y, "receiver.waveCy")} ${number(b.x + b.width, "receiver.waveEndX")} ${number(b.y + b.height * .22, "receiver.waveEndY")}" class="support-stroke"/>`;
}

function satellite(entity, b) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const bodyW = b.width * .28;
  const bodyH = b.height * .38;
  return `<rect x="${number(cx - bodyW / 2, "satellite.x")}" y="${number(cy - bodyH / 2, "satellite.y")}" width="${number(bodyW, "satellite.w")}" height="${number(bodyH, "satellite.h")}" rx="12" class="entity-surface"/><rect x="${number(b.x + b.width * .04, "satellite.panelX")}" y="${number(cy - bodyH * .42, "satellite.panelY")}" width="${number(b.width * .29, "satellite.panelW")}" height="${number(bodyH * .84, "satellite.panelH")}" class="inner-surface"/><rect x="${number(b.x + b.width * .67, "satellite.panelX")}" y="${number(cy - bodyH * .42, "satellite.panelY")}" width="${number(b.width * .29, "satellite.panelW")}" height="${number(bodyH * .84, "satellite.panelH")}" class="inner-surface"/><path d="M${number(cx, "satellite.cx")} ${number(cy + bodyH / 2, "satellite.bodyY")}V${number(b.y + b.height * .84, "satellite.stemY")}M${number(cx - b.width * .12, "satellite.dishX")} ${number(b.y + b.height * .84, "satellite.dishY")}Q${number(cx, "satellite.cx")} ${number(b.y + b.height * .98, "satellite.dishCY")} ${number(cx + b.width * .12, "satellite.dishX")} ${number(b.y + b.height * .84, "satellite.dishY")}" class="accent-stroke"/>`;
}

function vehicle(entity, b) {
  const y = b.y + b.height * .64;
  const wheelR = Math.min(b.width, b.height) * .105;
  return `<path d="M${number(b.x + b.width * .08, "vehicle.x")} ${number(y, "vehicle.y")}L${number(b.x + b.width * .2, "vehicle.x")} ${number(b.y + b.height * .38, "vehicle.roofY")}Q${number(b.x + b.width * .28, "vehicle.qx")} ${number(b.y + b.height * .26, "vehicle.qy")} ${number(b.x + b.width * .43, "vehicle.roofX")} ${number(b.y + b.height * .26, "vehicle.roofY")}H${number(b.x + b.width * .65, "vehicle.roofX")}L${number(b.x + b.width * .78, "vehicle.x")} ${number(b.y + b.height * .43, "vehicle.y")}L${number(b.x + b.width * .94, "vehicle.x")} ${number(b.y + b.height * .49, "vehicle.y")}V${number(y, "vehicle.y")}Z" class="entity-surface"/><circle cx="${number(b.x + b.width * .28, "vehicle.wheelX")}" cy="${number(y, "vehicle.wheelY")}" r="${number(wheelR, "vehicle.r")}" class="wheel"/><circle cx="${number(b.x + b.width * .74, "vehicle.wheelX")}" cy="${number(y, "vehicle.wheelY")}" r="${number(wheelR, "vehicle.r")}" class="wheel"/>`;
}

function wheelDigit(entity, b) {
  const copy = compactDisplayCopy(entity.displayText ?? entity.value ?? entity.state ?? entity.label, 16, "•");
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${number(Math.min(28, b.width * .18), "wheel.rx")}" class="entity-surface"/><path d="M${b.x} ${number(b.y + b.height * .2, "wheel.lineY")}H${number(b.x + b.width, "wheel.lineX")}M${b.x} ${number(b.y + b.height * .8, "wheel.lineY")}H${number(b.x + b.width, "wheel.lineX")}" class="muted-stroke"/>${textMarkup(copy, b.x + b.width / 2, b.y + b.height * .59, b.width * .8, { size: Math.min(64, b.height * .36), className: "display-copy", maximumCharacters: 8, maximumLines: 1 })}`;
}

function wheelBank(entity, b) {
  const gap = Math.max(3, Math.min(8, b.width * .018));
  const padding = Math.max(8, b.width * .045);
  const digitWidth = (b.width - padding * 2 - gap * 5) / 6;
  const digitHeight = Math.min(b.height * .74, digitWidth * 1.45);
  const y = b.y + (b.height - digitHeight) / 2;
  const digits = Array.from({ length: 6 }, (_, index) => {
    const x = b.x + padding + index * (digitWidth + gap);
    return `<g data-wheel-bank-digit="${index}" style="transform-box:fill-box;transform-origin:center"><rect x="${number(x, "wheelBank.x")}" y="${number(y, "wheelBank.y")}" width="${number(digitWidth, "wheelBank.width")}" height="${number(digitHeight, "wheelBank.height")}" rx="${number(Math.min(12, digitWidth * .18), "wheelBank.rx")}" class="inner-surface"/><text x="${number(x + digitWidth / 2, "wheelBank.textX")}" y="${number(y + digitHeight * .65, "wheelBank.textY")}" text-anchor="middle" class="display-copy" font-size="${number(Math.min(34, digitHeight * .44), "wheelBank.fontSize")}">9</text></g>`;
  }).join("");
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${number(Math.min(26, b.height * .18), "wheelBank.outerRx")}" class="entity-surface"/>${digits}`;
}

function numericToken(entity, b) {
  const copy = compactDisplayCopy(entity.displayText ?? entity.value ?? entity.state ?? entity.label, 24, "•");
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${number(b.height / 2, "token.rx")}" class="token-surface"/>${textMarkup(copy, b.x + b.width / 2, b.y + b.height * .6, b.width * .78, { size: Math.min(40, b.height * .42), className: "display-copy", maximumCharacters: 12, maximumLines: 1 })}`;
}

function calendar(entity, b) {
  const copy = compactDisplayCopy(entity.displayText ?? entity.state ?? entity.label, 32, "");
  return `<rect x="${b.x}" y="${number(b.y + b.height * .1, "calendar.y")}" width="${b.width}" height="${number(b.height * .88, "calendar.h")}" rx="20" class="entity-surface"/><path d="M${b.x} ${number(b.y + b.height * .32, "calendar.lineY")}H${number(b.x + b.width, "calendar.lineX")}M${number(b.x + b.width * .25, "calendar.bindX")} ${b.y}V${number(b.y + b.height * .22, "calendar.bindY")}M${number(b.x + b.width * .75, "calendar.bindX")} ${b.y}V${number(b.y + b.height * .22, "calendar.bindY")}" class="accent-stroke"/>${copy ? textMarkup(copy, b.x + b.width / 2, b.y + b.height * .67, b.width * .76, { size: Math.min(38, b.height * .24), className: "display-copy", maximumCharacters: 12, maximumLines: 1 }) : ""}`;
}

function clock(entity, b) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const r = Math.min(b.width, b.height) * .42;
  return `<circle cx="${number(cx, "clock.cx")}" cy="${number(cy, "clock.cy")}" r="${number(r, "clock.r")}" class="entity-surface"/><path d="M${number(cx, "clock.cx")} ${number(cy, "clock.cy")}V${number(cy - r * .58, "clock.handY")}M${number(cx, "clock.cx")} ${number(cy, "clock.cy")}L${number(cx + r * .48, "clock.handX")} ${number(cy + r * .22, "clock.handY")}" class="accent-stroke"/><circle cx="${number(cx, "clock.cx")}" cy="${number(cy, "clock.cy")}" r="8" class="accent-fill"/>`;
}

function document(entity, b) {
  return `<path d="M${b.x} ${b.y}H${number(b.x + b.width * .72, "document.foldX")}L${number(b.x + b.width, "document.foldX")} ${number(b.y + b.height * .2, "document.foldY")}V${number(b.y + b.height, "document.bottom")}H${b.x}Z" class="entity-surface"/><path d="M${number(b.x + b.width * .72, "document.foldX")} ${b.y}V${number(b.y + b.height * .2, "document.foldY")}H${number(b.x + b.width, "document.foldX")}M${number(b.x + b.width * .14, "document.lineX")} ${number(b.y + b.height * .38, "document.lineY")}H${number(b.x + b.width * .78, "document.lineX")}M${number(b.x + b.width * .14, "document.lineX")} ${number(b.y + b.height * .55, "document.lineY")}H${number(b.x + b.width * .68, "document.lineX")}M${number(b.x + b.width * .14, "document.lineX")} ${number(b.y + b.height * .72, "document.lineY")}H${number(b.x + b.width * .82, "document.lineX")}" class="muted-stroke"/>`;
}

function signalWave(entity, b) {
  const midY = b.y + b.height / 2;
  const segments = 4;
  const step = b.width / segments;
  const path = Array.from({ length: segments }, (_, index) => {
    const x0 = b.x + index * step;
    const x1 = x0 + step / 2;
    const x2 = x0 + step;
    const amplitude = b.height * (index % 2 ? .28 : .42);
    return `${index ? "" : `M${number(x0, "signal.x")} ${number(midY, "signal.y")}`}C${number(x0 + step * .2, "signal.cx")} ${number(midY - amplitude, "signal.cy")} ${number(x1 - step * .2, "signal.cx")} ${number(midY - amplitude, "signal.cy")} ${number(x1, "signal.x")} ${number(midY, "signal.y")}C${number(x1 + step * .2, "signal.cx")} ${number(midY + amplitude, "signal.cy")} ${number(x2 - step * .2, "signal.cx")} ${number(midY + amplitude, "signal.cy")} ${number(x2, "signal.x")} ${number(midY, "signal.y")}`;
  }).join("");
  return `<path data-draw-path="true" pathLength="100" d="${path}" class="accent-stroke"/>`;
}

function graphAxis(entity, b) {
  const points = Array.isArray(entity.points) && entity.points.length >= 2
    ? entity.points.map((point) => ({ x: number(point.x, "graph.x"), y: number(point.y, "graph.y") }))
    : [
      { x: b.x + b.width * .12, y: b.y + b.height * .78 },
      { x: b.x + b.width * .35, y: b.y + b.height * .6 },
      { x: b.x + b.width * .58, y: b.y + b.height * .68 },
      { x: b.x + b.width * .86, y: b.y + b.height * .28 },
    ];
  const path = points.map((point, index) => `${index ? "L" : "M"}${number(point.x, "graph.x")} ${number(point.y, "graph.y")}`).join(" ");
  return `<path d="M${number(b.x + b.width * .1, "graph.axisX")} ${number(b.y + b.height * .12, "graph.axisY")}V${number(b.y + b.height * .82, "graph.axisY")}H${number(b.x + b.width * .92, "graph.axisX")}" class="muted-stroke"/><path data-draw-path="true" pathLength="100" d="${path}" class="accent-stroke"/>${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="8" class="accent-fill"/>`).join("")}`;
}

function steamship(entity, b) {
  const waterY = b.y + b.height * .78;
  const hullTop = b.y + b.height * .55;
  const left = b.x + b.width * .08;
  const right = b.x + b.width * .92;
  return `<path d="M${number(left, "ship.left")} ${number(hullTop, "ship.hullTop")}H${number(right, "ship.right")}L${number(b.x + b.width * .78, "ship.stern")} ${number(waterY, "ship.waterY")}H${number(b.x + b.width * .24, "ship.bow")}Z" class="entity-surface"/><rect x="${number(b.x + b.width * .34, "ship.cabinX")}" y="${number(b.y + b.height * .3, "ship.cabinY")}" width="${number(b.width * .34, "ship.cabinW")}" height="${number(b.height * .25, "ship.cabinH")}" rx="8" class="inner-surface"/><path d="M${number(b.x + b.width * .42, "ship.stackX")} ${number(b.y + b.height * .3, "ship.stackTop")}V${number(b.y + b.height * .15, "ship.stackBottom")}H${number(b.x + b.width * .52, "ship.stackRight")}V${number(b.y + b.height * .3, "ship.stackBottom")}M${number(b.x + b.width * .18, "ship.mastX")} ${number(hullTop, "ship.mastBottom")}V${number(b.y + b.height * .16, "ship.mastTop")}M${number(b.x + b.width * .18, "ship.mastX")} ${number(b.y + b.height * .2, "ship.flagY")}L${number(b.x + b.width * .34, "ship.flagX")} ${number(b.y + b.height * .28, "ship.flagEndY")}" class="accent-stroke"/><path d="M${number(b.x + b.width * .04, "ship.waveX")} ${number(b.y + b.height * .88, "ship.waveY")}Q${number(b.x + b.width * .2, "ship.waveCX")} ${number(b.y + b.height * .8, "ship.waveCY")} ${number(b.x + b.width * .36, "ship.waveX")} ${number(b.y + b.height * .88, "ship.waveY")}T${number(b.x + b.width * .68, "ship.waveX")} ${number(b.y + b.height * .88, "ship.waveY")}T${number(b.x + b.width * .96, "ship.waveX")} ${number(b.y + b.height * .88, "ship.waveY")}" class="support-stroke"/>`;
}

function iceField(entity, b) {
  const y = b.y + b.height * .66;
  return `<path d="M${b.x} ${number(y, "ice.y")}L${number(b.x + b.width * .17, "ice.x")} ${number(b.y + b.height * .38, "ice.y")}L${number(b.x + b.width * .34, "ice.x")} ${number(b.y + b.height * .58, "ice.y")}L${number(b.x + b.width * .52, "ice.x")} ${number(b.y + b.height * .27, "ice.y")}L${number(b.x + b.width * .7, "ice.x")} ${number(b.y + b.height * .55, "ice.y")}L${number(b.x + b.width * .86, "ice.x")} ${number(b.y + b.height * .42, "ice.y")}L${number(b.x + b.width, "ice.x")} ${number(y, "ice.y")}L${number(b.x + b.width * .9, "ice.x")} ${number(b.y + b.height * .86, "ice.y")}H${number(b.x + b.width * .12, "ice.x")}Z" class="entity-surface"/><path d="M${number(b.x + b.width * .18, "ice.crackX")} ${number(y, "ice.crackY")}L${number(b.x + b.width * .3, "ice.crackX")} ${number(b.y + b.height * .78, "ice.crackY")}L${number(b.x + b.width * .43, "ice.crackX")} ${number(b.y + b.height * .66, "ice.crackY")}M${number(b.x + b.width * .61, "ice.crackX")} ${number(b.y + b.height * .56, "ice.crackY")}L${number(b.x + b.width * .72, "ice.crackX")} ${number(b.y + b.height * .78, "ice.crackY")}" class="support-stroke"/>`;
}

function weatherFront(entity, b) {
  const cy = b.y + b.height * .42;
  return `<path d="M${number(b.x + b.width * .14, "weather.x")} ${number(cy, "weather.y")}Q${number(b.x + b.width * .18, "weather.x")} ${number(b.y + b.height * .18, "weather.y")} ${number(b.x + b.width * .38, "weather.x")} ${number(b.y + b.height * .25, "weather.y")}Q${number(b.x + b.width * .52, "weather.x")} ${number(b.y + b.height * .05, "weather.y")} ${number(b.x + b.width * .68, "weather.x")} ${number(b.y + b.height * .26, "weather.y")}Q${number(b.x + b.width * .9, "weather.x")} ${number(b.y + b.height * .25, "weather.y")} ${number(b.x + b.width * .88, "weather.x")} ${number(cy, "weather.y")}Z" class="entity-surface"/><path d="M${number(b.x + b.width * .08, "weather.windX")} ${number(b.y + b.height * .58, "weather.windY")}H${number(b.x + b.width * .72, "weather.windX")}Q${number(b.x + b.width * .88, "weather.windX")} ${number(b.y + b.height * .58, "weather.windY")} ${number(b.x + b.width * .82, "weather.windX")} ${number(b.y + b.height * .7, "weather.windY")}M${number(b.x + b.width * .2, "weather.windX")} ${number(b.y + b.height * .78, "weather.windY")}H${number(b.x + b.width * .62, "weather.windX")}" class="accent-stroke"/><path d="M${number(b.x + b.width * .28, "weather.snowX")} ${number(b.y + b.height * .52, "weather.snowY")}V${number(b.y + b.height * .7, "weather.snowY")}M${number(b.x + b.width * .22, "weather.snowX")} ${number(b.y + b.height * .61, "weather.snowY")}H${number(b.x + b.width * .34, "weather.snowX")}M${number(b.x + b.width * .58, "weather.snowX")} ${number(b.y + b.height * .48, "weather.snowY")}V${number(b.y + b.height * .66, "weather.snowY")}M${number(b.x + b.width * .52, "weather.snowX")} ${number(b.y + b.height * .57, "weather.snowY")}H${number(b.x + b.width * .64, "weather.snowX")}" class="muted-stroke"/>`;
}

function hypothesis(entity, b) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height * .46;
  return `<path d="M${number(b.x + b.width * .08, "hypothesis.x")} ${number(b.y + b.height * .1, "hypothesis.y")}H${number(b.x + b.width * .92, "hypothesis.x")}Q${number(b.x + b.width, "hypothesis.x")} ${number(b.y + b.height * .1, "hypothesis.y")} ${number(b.x + b.width, "hypothesis.x")} ${number(b.y + b.height * .22, "hypothesis.y")}V${number(b.y + b.height * .65, "hypothesis.y")}Q${number(b.x + b.width, "hypothesis.x")} ${number(b.y + b.height * .77, "hypothesis.y")} ${number(b.x + b.width * .88, "hypothesis.x")} ${number(b.y + b.height * .77, "hypothesis.y")}H${number(b.x + b.width * .56, "hypothesis.x")}L${number(b.x + b.width * .43, "hypothesis.tailX")} ${number(b.y + b.height * .94, "hypothesis.tailY")}L${number(b.x + b.width * .39, "hypothesis.tailX")} ${number(b.y + b.height * .77, "hypothesis.tailY")}H${number(b.x + b.width * .08, "hypothesis.x")}Q${b.x} ${number(b.y + b.height * .77, "hypothesis.y")} ${b.x} ${number(b.y + b.height * .65, "hypothesis.y")}V${number(b.y + b.height * .22, "hypothesis.y")}Q${b.x} ${number(b.y + b.height * .1, "hypothesis.y")} ${number(b.x + b.width * .08, "hypothesis.x")} ${number(b.y + b.height * .1, "hypothesis.y")}Z" class="entity-surface"/>${textMarkup("?", cx, cy + b.height * .09, b.width * .5, { size: Math.min(70, b.height * .46), className: "display-copy", maximumCharacters: 1, maximumLines: 1 })}`;
}

function unknownOutcome(entity, b) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const r = Math.min(b.width, b.height) * .4;
  return `<circle cx="${number(cx, "unknown.cx")}" cy="${number(cy, "unknown.cy")}" r="${number(r, "unknown.r")}" class="entity-surface semantic-dashed"/>${textMarkup("?", cx, cy + r * .22, b.width * .5, { size: Math.min(72, r * .92), className: "display-copy", maximumCharacters: 1, maximumLines: 1 })}`;
}

function genericObject(entity, b) {
  return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${number(Math.min(34, b.width * .14), "object.rx")}" class="entity-surface"/><circle cx="${number(b.x + b.width / 2, "object.cx")}" cy="${number(b.y + b.height / 2, "object.cy")}" r="${number(Math.min(b.width, b.height) * .15, "object.r")}" class="accent-ring"/>`;
}

const ENTITY_RENDERERS = Object.freeze({
  human_observer: humanObserver,
  device,
  receiver,
  satellite,
  vehicle,
  wheel_digit: wheelDigit,
  wheel_bank: wheelBank,
  numeric_token: numericToken,
  calendar,
  clock,
  document,
  signal_wave: signalWave,
  graph_axis: graphAxis,
  steamship,
  ice_field: iceField,
  weather_front: weatherFront,
  hypothesis,
  unknown_outcome: unknownOutcome,
  generic_object: genericObject,
});

export function renderGeneralizedVisualEntityV2(rawEntity) {
  const primitiveId = normalizedEntityPrimitive(
    rawEntity.primitiveId
      ?? rawEntity.primitive
      ?? rawEntity.representation
      ?? rawEntity.kind
      ?? rawEntity.visualSubjectKind,
  );
  const b = bounds(rawEntity.bounds, `entity.${rawEntity.id || "unknown"}.bounds`);
  const tone = toneClass(rawEntity.tone);
  const label = safeCopy(rawEntity.label ?? rawEntity.displayLabel ?? "");
  const body = ENTITY_RENDERERS[primitiveId](rawEntity, b);
  const labelY = Math.min(1432, b.y + b.height + 35);
  const labelAlreadyRendered = ["numeric_token", "wheel_digit", "calendar"].includes(primitiveId);
  const labelMarkup = label && !labelAlreadyRendered
    ? `<g data-target-label="true">${textMarkup(label, b.x + b.width / 2, labelY, Math.max(80, b.width * 1.18), { size: 23, className: "entity-label", maximumCharacters: 22, maximumLines: 2 })}</g>`
    : "";
  const left = b.x - 8;
  const top = b.y - 8;
  const right = b.x + b.width + 8;
  const bottom = b.y + b.height + 8;
  return `<g id="gv2_entity_${escapeGeneralizedVisualXmlV2(rawEntity.id)}" ${primitiveAttrs(rawEntity, primitiveId, b)} class="entity ${tone}"><g data-target-body="true">${body}</g>${labelMarkup}<g data-focus-indicator="true" opacity="0"><rect x="${number(b.x - 12, "focus.x")}" y="${number(b.y - 12, "focus.y")}" width="${number(b.width + 24, "focus.w")}" height="${number(b.height + 24, "focus.h")}" rx="34" class="focus-ring"/></g><g data-semantic-rejection-indicator="true" opacity="0"><path d="M${number(left, "reject.left")} ${number(top, "reject.top")}L${number(right, "reject.right")} ${number(bottom, "reject.bottom")}M${number(right, "reject.right")} ${number(top, "reject.top")}L${number(left, "reject.left")} ${number(bottom, "reject.bottom")}" class="semantic-rejection"/></g><g data-semantic-mark-indicator="true" opacity="0"><circle cx="${number(b.x + b.width * .82, "mark.cx")}" cy="${number(b.y + b.height * .18, "mark.cy")}" r="18" class="semantic-mark"/><path d="M${number(b.x + b.width * .73, "mark.x")} ${number(b.y + b.height * .18, "mark.y")}L${number(b.x + b.width * .8, "mark.x")} ${number(b.y + b.height * .25, "mark.y")}L${number(b.x + b.width * .92, "mark.x")} ${number(b.y + b.height * .08, "mark.y")}" class="semantic-mark"/></g><g data-semantic-uncertainty-indicator="true" opacity="0"><rect x="${number(b.x - 10, "uncertainty.x")}" y="${number(b.y - 10, "uncertainty.y")}" width="${number(b.width + 20, "uncertainty.w")}" height="${number(b.height + 20, "uncertainty.h")}" rx="30" class="semantic-uncertainty"/></g><g data-semantic-empty-indicator="true" opacity="0"><circle cx="${number(b.x + b.width * .78, "empty.cx")}" cy="${number(b.y + b.height * .2, "empty.cy")}" r="11" class="semantic-empty"/><path d="M${number(b.x + b.width * .78, "empty.x")} ${number(b.y + b.height * .31, "empty.y")}V${number(b.y + b.height * .48, "empty.y")}M${number(b.x + b.width * .68, "empty.x")} ${number(b.y + b.height * .38, "empty.y")}H${number(b.x + b.width * .88, "empty.x")}M${number(b.x + b.width * .63, "empty.x")} ${number(b.y + b.height * .1, "empty.y")}L${number(b.x + b.width * .94, "empty.x")} ${number(b.y + b.height * .52, "empty.y")}" class="semantic-empty"/></g></g>`;
}

function point(value, field) {
  if (!value || typeof value !== "object") throw new TypeError(`${field} is invalid.`);
  const normalized = { x: number(value.x, `${field}.x`), y: number(value.y, `${field}.y`) };
  if (normalized.x < 0 || normalized.x > 1080 || normalized.y < 0 || normalized.y > 1460) {
    throw new TypeError(`${field} is outside the visual stage.`);
  }
  return normalized;
}

function center(entity) {
  const b = bounds(entity.bounds, `entity.${entity.id}.bounds`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function relationPath(relation, from, to) {
  const points = Array.isArray(relation.points) && relation.points.length >= 2
    ? relation.points.map((entry, index) => point(entry, `relation.points[${index}]`))
    : [from, to];
  if (points.length > 8) throw new TypeError("Generalized visual relation path is too complex.");
  if (relation.pathKind === "curve" && points.length === 3) {
    return `M${number(points[0].x, "relation.x")} ${number(points[0].y, "relation.y")}Q${number(points[1].x, "relation.x")} ${number(points[1].y, "relation.y")} ${number(points[2].x, "relation.x")} ${number(points[2].y, "relation.y")}`;
  }
  return points.map((entry, index) => `${index ? "L" : "M"}${number(entry.x, "relation.x")} ${number(entry.y, "relation.y")}`).join(" ");
}

export function renderGeneralizedVisualRelationV2(rawRelation, entitiesById) {
  const id = identifier(rawRelation.id, "relation.id");
  const fromId = identifier(rawRelation.fromEntityId ?? rawRelation.from, "relation.fromEntityId");
  const toId = identifier(rawRelation.toEntityId ?? rawRelation.to, "relation.toEntityId");
  const fromEntity = entitiesById.get(fromId);
  const toEntity = entitiesById.get(toId);
  if (!fromEntity || !toEntity || fromId === toId) throw new TypeError("Generalized visual relation endpoint is invalid.");
  const primitiveId = normalizedRelationPrimitive(rawRelation.primitiveId ?? rawRelation.connectorId ?? rawRelation.kind ?? "association");
  const tone = toneClass(rawRelation.tone || (primitiveId === "dashed_signal" ? "signal" : "accent"));
  const from = center(fromEntity);
  const to = center(toEntity);
  const path = relationPath(rawRelation, from, to);
  const dash = primitiveId === "dashed_signal" || rawRelation.certainty === "disputed" || rawRelation.certainty === "unknown";
  const arrow = primitiveId === "arrow" || primitiveId === "dashed_signal";
  const label = safeCopy(rawRelation.label ?? "", 64);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 22 };
  return `<g id="gv2_relation_${escapeGeneralizedVisualXmlV2(id)}" data-relation-id="${id}" data-motion-target="${id}" data-primitive="${primitiveId}" data-from-entity-id="${fromId}" data-to-entity-id="${toId}" data-semantic-predicate="${escapeGeneralizedVisualXmlV2(rawRelation.predicate || "associated_with")}" class="relation ${tone}"><path id="gv2_relation_path_${id}" data-draw-path="true" pathLength="100" d="${path}" class="relation-stroke${dash ? " relation-dashed" : ""}"${arrow ? ' marker-end="url(#gv2-arrowhead)"' : ""}/><circle data-relation-token="true" cx="${number(from.x, "relation.tokenX")}" cy="${number(from.y, "relation.tokenY")}" r="10" class="relation-token" opacity="0"/>${label ? textMarkup(label, mid.x, mid.y, Math.max(120, Math.abs(to.x - from.x) * .72), { size: 20, className: "relation-label", maximumCharacters: 22, maximumLines: 1 }) : ""}</g>`;
}

export function listGeneralizedVisualEntityPrimitivesV2() {
  return ENTITY_PRIMITIVE_IDS;
}

export function listGeneralizedVisualRelationPrimitivesV2() {
  return RELATION_PRIMITIVE_IDS;
}
