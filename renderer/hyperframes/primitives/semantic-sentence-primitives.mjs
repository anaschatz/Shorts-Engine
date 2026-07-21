import { createRequire } from "node:module";
import {
  normalizeSemanticSceneComposition,
  semanticSceneCompositionMarkup,
} from "./semantic-scene-composition.mjs";

const require = createRequire(import.meta.url);
const primitiveParameterContract = require(
  "../../../server/pipelines/narrated-short/animation/semantic-primitive-parameters.cjs",
);
const visualConceptRegistry = require(
  "../../../server/pipelines/narrated-short/animation/semantic-visual-concept-registry.cjs",
);
const REMOTE_URL = /\bhttps?:\/\//i;

export const SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID =
  primitiveParameterContract.SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID;
export const SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION =
  primitiveParameterContract.SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION;
export const SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR =
  primitiveParameterContract.SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR;
export const SEMANTIC_PRIMITIVE_STATE_TOKENS =
  primitiveParameterContract.SEMANTIC_PRIMITIVE_STATE_TOKENS;

export function normalizeSemanticPrimitiveParameters(input) {
  try {
    return primitiveParameterContract.normalizeSemanticPrimitiveParameters(input);
  } catch {
    throw new TypeError("Semantic primitive parameters are invalid.");
  }
}

export const SUPPORTED_SEMANTIC_SENTENCE_ASSETS = Object.freeze([
  "archive_record",
  "calendar_card",
  "finite_counter",
  "hypothesis_card",
  "mapping_table",
  "receiver_device",
  "timeline_axis",
  "uncertainty_boundary",
  "vessel",
  "witness_marker",
]);

export const SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS = Object.freeze([
  "before_after",
  "bounded_uncertainty",
  "cause_effect_chain",
  "chronology_accumulation",
  "evidence_inspection",
  "finite_cycle",
  "map_motion",
  "negative_space_absence",
  "side_by_side_comparison",
]);

export function escapeSemanticSentenceXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function semanticSentenceTextLines(value, maximumCharacters = 30) {
  if (
    typeof value !== "string"
    || !value.trim()
    || REMOTE_URL.test(value)
    || !Number.isInteger(maximumCharacters)
    || maximumCharacters < 12
    || maximumCharacters > 48
  ) {
    throw new TypeError("Semantic sentence text is invalid.");
  }
  const words = value.trim().split(/\s+/);
  const lines = [];
  for (const word of words) {
    const previous = lines.at(-1);
    if (!previous || previous.length + word.length + 1 > maximumCharacters) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${previous} ${word}`;
    }
  }
  return Object.freeze(lines);
}

function semanticLabelLines(value, maximumCharacters, maximumLines = 2) {
  const naturalLines = semanticSentenceTextLines(value, maximumCharacters);
  if (naturalLines.length > maximumLines) {
    const characters = Array.from(value.trim());
    if (characters.length > maximumCharacters * maximumLines) {
      throw new TypeError("Semantic parameter label exceeds its visual line budget.");
    }
    const partSize = Math.ceil(characters.length / maximumLines);
    return Object.freeze(Array.from({ length: maximumLines }, (_, index) => (
      characters.slice(index * partSize, (index + 1) * partSize)
        .join("")
        .trim()
    )).filter(Boolean));
  }
  const lines = [];
  for (const line of naturalLines) {
    const characters = Array.from(line);
    if (characters.length <= maximumCharacters) {
      lines.push(line);
      continue;
    }
    const partCount = Math.ceil(characters.length / maximumCharacters);
    const partSize = Math.ceil(characters.length / partCount);
    for (let offset = 0; offset < characters.length; offset += partSize) {
      lines.push(characters.slice(offset, offset + partSize).join(""));
    }
  }
  return Object.freeze(lines);
}

function textBlock(lines, sentenceIndex) {
  const startY = 778 - Math.max(0, lines.length - 2) * 18;
  return lines.map((line, index) => (
    `<text id="semantic-sentence-${sentenceIndex}-copy-${index}"
 x="360" y="${startY + index * 38}" text-anchor="middle" class="sentence-copy"
 data-legibility-role="${index === 0 ? "key" : "secondary"}"
 data-contrast-background="#07111f">${escapeSemanticSentenceXml(line)}</text>`
  )).join("");
}

const SEMANTIC_EXCERPT_WORDS = new Set([
  "absent",
  "never",
  "no",
  "not",
  "rejected",
  "unknown",
  "unresolved",
  "without",
]);

function displayText(value, maximum = 24) {
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  const words = normalized.split(" ");
  const cleanWord = (word) => word.toLowerCase().replace(/[^a-z]/g, "");
  const semanticIndex = words.findIndex(
    (word) => SEMANTIC_EXCERPT_WORDS.has(cleanWord(word)),
  );
  if (semanticIndex >= 0) {
    const prefix = semanticIndex > 0 ? "… " : "";
    const selected = [];
    for (let index = semanticIndex; index < words.length; index += 1) {
      const suffix = index < words.length - 1 ? " …" : "";
      const candidate = `${prefix}${[...selected, words[index]].join(" ")}${suffix}`;
      if (selected.length && candidate.length > maximum) break;
      selected.push(words[index]);
    }
    return `${prefix}${selected.join(" ")}${
      semanticIndex + selected.length < words.length ? " …" : ""
    }`;
  }

  const marker = " … ";
  const phraseCandidates = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 2; end <= words.length; end += 1) {
      const prefix = start > 0 ? "… " : "";
      const suffix = end < words.length ? " …" : "";
      const candidate = `${prefix}${words.slice(start, end).join(" ")}${suffix}`;
      if (candidate.length > maximum) continue;
      phraseCandidates.push({
        candidate,
        score: (
          (end === words.length ? 10_000 : 0)
          + (end - start) * 100
          + candidate.length
        ),
      });
    }
  }
  phraseCandidates.sort((left, right) => right.score - left.score);
  if (phraseCandidates.length) return phraseCandidates[0].candidate;

  let headEnd = 1;
  let tailStart = words.length - 1;
  let output = `${words[0]}${marker}${words.at(-1)}`;
  while (headEnd < tailStart) {
    const addHead = `${words.slice(0, headEnd + 1).join(" ")}${marker}${
      words.slice(tailStart).join(" ")
    }`;
    if (addHead.length <= maximum) {
      output = addHead;
      headEnd += 1;
    } else {
      const addTail = `${words.slice(0, headEnd).join(" ")}${marker}${
        words.slice(tailStart - 1).join(" ")
      }`;
      if (addTail.length > maximum) break;
      output = addTail;
      tailStart -= 1;
    }
  }
  if (output.length <= maximum) return output;
  const edgeWords = [words[0], words.at(-1)];
  const intact = edgeWords
    .filter((word) => word.length <= maximum)
    .sort((left, right) => right.length - left.length);
  if (intact.length) return intact[0];
  const shortest = [...edgeWords].sort(
    (left, right) => left.length - right.length,
  )[0];
  return `${shortest.slice(0, Math.max(3, maximum - 1))}…`;
}

function displayQuantity(parameters) {
  if (!parameters.quantity) return null;
  return [
    parameters.quantity.value,
    parameters.quantity.unit,
  ].filter(Boolean).join(" ").trim().toUpperCase().replace(/\s+/g, " ");
}

function groundedPrimaryValue(parameters, maximum = 20) {
  return displayQuantity(parameters)
    || displayText(parameters.detail.value, maximum);
}

function fitTextAttributes(value, maximumCharacters, width) {
  const length = displayText(value, maximumCharacters).length;
  return length * 10 > width
    ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"`
    : "";
}

function fitFontSizeAttributes(value, baseSize, minimumSize, width) {
  const length = String(value).trim().length;
  const fitted = Math.floor(width / Math.max(1, length * 0.58));
  const fontSize = Math.max(minimumSize, Math.min(baseSize, fitted));
  return fontSize < baseSize ? ` style="font-size:${fontSize}px"` : "";
}

function fitExactTextAttributes(
  value,
  baseSize,
  minimumSize,
  width,
  letterSpacing = 0,
) {
  const normalized = String(value).trim().replace(/\s+/g, " ");
  const spacingWidth = Math.max(0, normalized.length - 1) * letterSpacing;
  const fitted = Math.floor(
    Math.max(1, width - spacingWidth)
      / Math.max(1, normalized.length * 0.58),
  );
  const fontSize = Math.max(minimumSize, Math.min(baseSize, fitted));
  const attributes = [];
  if (fontSize < baseSize) attributes.push(`style="font-size:${fontSize}px"`);
  if (normalized.length * fontSize * 0.58 + spacingWidth > width) {
    attributes.push(`textLength="${width}"`, 'lengthAdjust="spacingAndGlyphs"');
  }
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

const SIMPLE_NUMBER_WORDS = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});

function parsedNumberPhrase(value) {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const tokens = value.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (token === "and") continue;
    if (token === "hundred") {
      current = Math.max(1, current) * 100;
      continue;
    }
    if (token === "thousand") {
      total += Math.max(1, current) * 1000;
      current = 0;
      continue;
    }
    const valuePart = SIMPLE_NUMBER_WORDS[token];
    if (valuePart === undefined) return null;
    current += valuePart;
  }
  return total + current;
}

function finiteCounterTickCount(parameters) {
  if (!["bit", "bits"].includes(parameters.quantity?.unit?.toLowerCase())) {
    return 12;
  }
  const numeric = parsedNumberPhrase(parameters.quantity.value);
  return Number.isInteger(numeric) && numeric >= 4 && numeric <= 24
    ? numeric
    : 12;
}

function groundedSemanticContext(parameters) {
  return `${parameters.subject.value} ${parameters.detail.value}`
    .toLocaleLowerCase("en-US");
}

function sameGroundedSource(left, right) {
  return left && right
    && left.sourceType === right.sourceType
    && left.sourceId === right.sourceId
    && left.operationIndex === right.operationIndex
    && left.field === right.field;
}

function groundedResetTarget(parameters) {
  if (!parameters.quantity) return "ORIGIN";
  const detailRef = parameters.detail.sourceRef;
  const valueRef = parameters.quantity.valueSourceRef;
  if (
    sameGroundedSource(detailRef, valueRef)
    && valueRef.startOffset >= detailRef.startOffset
    && valueRef.startOffset <= detailRef.endOffset
  ) {
    const localQuantityStart = valueRef.startOffset - detailRef.startOffset;
    const beforeQuantity = parameters.detail.value
      .slice(0, localQuantityStart)
      .toLocaleLowerCase("en-US");
    if (
      /\b(?:reset(?:s|ting)?|wrap(?:s|ped|ping)?|roll(?:ed|s)? over)\b[^,.;!?]{0,36}\b(?:back\s+)?to\s+(?:the\s+)?$/.test(
        beforeQuantity,
      )
    ) return displayQuantity(parameters);
  }
  return "ORIGIN";
}

function rendererVariant(sentence, parameters) {
  return visualConceptRegistry.semanticVisualConceptRendererVariant({
    visualConceptId: parameters.visualConceptId,
    grammarId: sentence.capability.grammarId,
    assetId: sentence.capability.assetId,
    stateTransition: sentence.visualIntent.stateTransition,
    stateToken: parameters.stateToken,
  });
}

function finiteCounterConcept(sentence, parameters) {
  const variant = rendererVariant(sentence, parameters);
  if (variant === "bounded_value_range") {
    return "bounded_range";
  }
  if (variant === "finite_counter_wrap") return "wrap";
  return "cycle";
}

function calendarMonthIndex(parameters) {
  const source = `${parameters.subject.value} ${parameters.detail.value}`
    .toLowerCase();
  return [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].findIndex((month) => new RegExp(`\\b${month}\\b`).test(source));
}

function seedPart(seed, shift) {
  return (seed >>> shift) & 0xff;
}

function parameterRoutePoints(parameters) {
  const supplied = parameters.geometry.route?.points;
  let points;
  if (supplied) {
    points = supplied.map(([x, y]) => ({
      x: 62 + x * 596,
      y: 278 + y * 380,
    }));
  } else {
    const seed = parameters.geometry.variantSeed;
    points = [
      { x: 118, y: 530 + seedPart(seed, 0) % 66 },
      { x: 238, y: 334 + seedPart(seed, 8) % 178 },
      { x: 438, y: 350 + seedPart(seed, 16) % 202 },
      { x: 602, y: 318 + seedPart(seed, 24) % 116 },
    ];
  }
  return parameters.geometry.direction === "reverse"
    ? [...points].reverse()
    : points;
}

function routePath(points, preserveWaypoints = false) {
  const formatted = points.map(({ x, y }) => (
    `${x.toFixed(3)} ${y.toFixed(3)}`
  ));
  if (!preserveWaypoints && formatted.length === 4) {
    return `M${formatted[0]} C${formatted[1]} ${formatted[2]} ${formatted[3]}`;
  }
  return formatted.map((point, index) => `${index ? "L" : "M"}${point}`).join(" ");
}

function beforeAfterMarkup(sentence) {
  const calendarCells = Array.from({ length: 12 }, (_, index) => {
    const x = 126 + (index % 4) * 52;
    const y = 408 + Math.floor(index / 4) * 46;
    return `<rect x="${x}" y="${y}" width="34" height="26" rx="5" class="calendar-cell"/>`;
  }).join("");
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const emphasis = calendarMonthIndex(parameters);
    const groundedCells = Array.from({ length: 12 }, (_, index) => {
      const x = 126 + (index % 4) * 52;
      const y = 408 + Math.floor(index / 4) * 46;
      return `<rect x="${x}" y="${y}" width="34" height="26" rx="5"
 class="calendar-cell" opacity="${index === emphasis ? "1" : ".62"}"/>`;
    }).join("");
    const subject = escapeSemanticSentenceXml(displayText(parameters.subject.value, 18));
    const detail = escapeSemanticSentenceXml(displayText(parameters.detail.value, 18));
    const state = escapeSemanticSentenceXml(displayText(parameters.stateToken, 18));
    const primaryValue = groundedPrimaryValue(parameters, 20);
    const value = escapeSemanticSentenceXml(primaryValue);
    const subjectFit = fitTextAttributes(parameters.subject.value, 18, 212);
    const detailFit = fitTextAttributes(parameters.detail.value, 18, 212);
    const stateFit = fitTextAttributes(parameters.stateToken, 18, 212);
    const valueFit = fitExactTextAttributes(
      primaryValue,
      48,
      18,
      196,
    );
    return `<g data-geometry-kind="before_after_calendar" data-primitive-parameterized="true"
 class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="84" y="292" width="252" height="328" rx="24" class="sentence-surface"/>
  <rect x="84" y="292" width="252" height="70" rx="24" class="cool-panel"/>
  <text x="210" y="338" text-anchor="middle" class="micro-copy"${subjectFit}>${subject}</text>
  ${groundedCells}
  <text x="210" y="598" text-anchor="middle" class="micro-copy"${detailFit}>${detail}</text>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="384" y="292" width="252" height="328" rx="24" class="sentence-surface"/>
  <rect x="384" y="292" width="252" height="70" rx="24" class="warm-panel"/>
  <text x="510" y="338" text-anchor="middle" class="micro-copy"${stateFit}>${state}</text>
  <text x="510" y="486" text-anchor="middle" class="large-value"${valueFit}>${value}</text>
  <path d="M422 576 H598" class="semantic-draw warm-line"/>
 </g>
 <path d="M338 456 H378 M364 442 L380 456 L364 470" class="semantic-draw connector-line"/>
</g>`;
  }
  return `<g data-geometry-kind="before_after_calendar" class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="84" y="292" width="252" height="328" rx="24" class="sentence-surface"/>
  <rect x="84" y="292" width="252" height="70" rx="24" class="cool-panel"/>
  <text x="210" y="338" text-anchor="middle" class="micro-copy">BEFORE</text>
  ${calendarCells}
  <path d="M122 576 H298" class="semantic-draw cool-line"/>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="384" y="292" width="252" height="328" rx="24" class="sentence-surface"/>
  <rect x="384" y="292" width="252" height="70" rx="24" class="warm-panel"/>
  <text x="510" y="338" text-anchor="middle" class="micro-copy">AFTER</text>
  <text x="510" y="486" text-anchor="middle" class="large-value">DATE</text>
  <path d="M422 576 H598" class="semantic-draw warm-line"/>
 </g>
 <path d="M338 456 H378 M364 442 L380 456 L364 470" class="semantic-draw connector-line"/>
</g>`;
}

function finiteCounterMarkup(sentence) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const concept = finiteCounterConcept(sentence, parameters);
    const subjectValue = displayText(parameters.subject.value, 22);
    const subject = escapeSemanticSentenceXml(subjectValue);
    const subjectFit = fitTextAttributes(parameters.subject.value, 22, 500);
    if (concept === "wrap") {
      const targetValue = groundedResetTarget(parameters);
      const target = escapeSemanticSentenceXml(targetValue);
      const targetFit = fitExactTextAttributes(targetValue, 42, 18, 208);
      return `<g data-geometry-kind="finite_counter_rollover"
 data-finite-counter-concept="wrap" data-primitive-parameterized="true"
 class="semantic-geometry">
 <rect x="70" y="292" width="580" height="340" rx="34" class="sentence-surface"/>
 <g class="semantic-counter-old semantic-rise">
  <rect x="104" y="374" width="200" height="142" rx="24" class="cool-panel"/>
  <text x="204" y="420" text-anchor="middle" class="micro-copy">LAST VALUE</text>
  <path d="M142 462 H266" class="semantic-draw cool-line"/>
  <circle cx="266" cy="462" r="11" class="cool-fill"/>
 </g>
 <path d="M310 446 H404 M384 426 L406 446 L384 466"
  class="semantic-draw connector-line"/>
 <g class="semantic-counter-new semantic-rise" opacity="0">
  <rect x="416" y="374" width="200" height="142" rx="24" class="warm-panel"/>
  <text x="516" y="420" text-anchor="middle" class="micro-copy">RESET TO</text>
  <text x="516" y="482" text-anchor="middle" class="large-value"${targetFit}>${target}</text>
 </g>
 <path d="M520 548 C520 598 204 598 204 538 M186 554 L204 536 L222 554"
  class="semantic-draw warm-line"/>
 <text x="360" y="690" text-anchor="middle"
  class="timeline-label"${subjectFit}>${subject}</text>
</g>`;
    }
    if (concept === "bounded_range") {
      const cells = Array.from({ length: 7 }, (_, index) => {
        const x = 104 + index * 74;
        const tone = index === 6 ? "warm-panel" : "cool-panel";
        return `<g class="semantic-rise" data-range-index="${index}">
 <rect x="${x}" y="402" width="54" height="74" rx="12" class="${tone}"/>
 <circle cx="${x + 27}" cy="439" r="${index === 6 ? 9 : 6}"
  class="${index === 6 ? "warm-fill" : "cool-fill"}"/>
</g>`;
      }).join("");
      return `<g data-geometry-kind="finite_counter_rollover"
 data-finite-counter-concept="bounded_range"
 data-primitive-parameterized="true" class="semantic-geometry">
 <rect x="70" y="302" width="580" height="326" rx="34" class="sentence-surface"/>
 <path d="M96 376 V500 M96 376 H116 M96 500 H116
  M624 376 V500 M604 376 H624 M604 500 H624"
  class="semantic-draw warm-line"/>
 ${cells}
 <text x="104" y="548" class="micro-copy">FIRST</text>
 <text x="616" y="548" text-anchor="end" class="micro-copy">LAST</text>
 <text x="360" y="592" text-anchor="middle" class="micro-copy warm-copy">FINITE VALUE SPACE</text>
 <text x="360" y="690" text-anchor="middle"
  class="timeline-label"${subjectFit}>${subject}</text>
</g>`;
    }
    const tickCount = finiteCounterTickCount(parameters);
    const ticks = Array.from({ length: tickCount }, (_, index) => {
      const angle = (index * (360 / tickCount) - 90) * Math.PI / 180;
      const x1 = 360 + Math.cos(angle) * 180;
      const y1 = 472 + Math.sin(angle) * 180;
      const x2 = 360 + Math.cos(angle) * 198;
      const y2 = 472 + Math.sin(angle) * 198;
      return `<line x1="${x1.toFixed(3)}" y1="${y1.toFixed(3)}"
 x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}" class="counter-tick"/>`;
    }).join("");
    const quantityValue = displayQuantity(parameters);
    const quantity = quantityValue
      ? escapeSemanticSentenceXml(quantityValue)
      : null;
    const stateValue = displayText(parameters.stateToken, 12);
    const state = escapeSemanticSentenceXml(stateValue);
    const cycleSubjectValue = displayText(parameters.subject.value, 20);
    const cycleSubject = escapeSemanticSentenceXml(cycleSubjectValue);
    const detailValue = displayText(parameters.detail.value, 24);
    const detailLines = semanticLabelLines(detailValue, 18);
    const symbolicCycle = stateValue === "LIMIT"
      ? {
        kind: "limit",
        markup: `<path d="M304 438 V506 M416 438 V506 M304 472 H416"
   class="semantic-draw cool-line"/>
  <circle cx="360" cy="472" r="12" class="cool-fill"/>`,
      }
      : stateValue === "REPEATS"
        ? {
          kind: "repeat",
          markup: `<path d="M304 470 A62 62 0 0 1 408 420
   M416 430 L408 420 L396 426 M416 474 A62 62 0 0 1 312 524
   M304 514 L312 524 L324 518" class="semantic-draw cool-line"/>
  <circle cx="360" cy="472" r="12" class="cool-fill"/>`,
        }
        : {
          kind: "change",
          markup: `<path d="M304 472 H416 M392 448 L416 472 L392 496"
   class="semantic-draw cool-line"/>`,
        };
    const quantityFit = quantityValue ? fitExactTextAttributes(
      quantityValue,
      76,
      24,
      300,
    ) : "";
    const stateFit = fitFontSizeAttributes(
      stateValue,
      quantityValue ? 20 : 38,
      quantityValue ? 15 : 24,
      300,
    );
    const cycleSubjectFit = fitTextAttributes(parameters.subject.value, 20, 500);
    return `<g data-geometry-kind="finite_counter_rollover"
 data-finite-counter-concept="cycle"
 data-primitive-parameterized="true"
 data-cycle-content="${quantityValue ? "quantity" : "symbolic"}"
 class="semantic-geometry">
 <circle cx="360" cy="472" r="205" class="sentence-surface"/>
 <circle cx="360" cy="472" r="184" pathLength="1"
  class="semantic-draw counter-cycle"/>
 ${quantityValue ? ticks : ""}
 ${quantityValue
    ? `<text x="360" y="478" text-anchor="middle"
  class="counter-value cycle-quantity"${quantityFit}>${quantity}</text>`
    : `<g class="semantic-cycle-symbol" data-cycle-symbol="${symbolicCycle.kind}">
  ${symbolicCycle.markup}
 </g>`}
 <g class="semantic-counter-old">
  ${detailLines.map((line, index) => (
    `<text x="360" y="${532 + index * 22 - (detailLines.length - 1) * 11}"
   text-anchor="middle" class="micro-copy"${fitExactTextAttributes(line, 20, 14, 330, 1.5)}>${escapeSemanticSentenceXml(line)}</text>`
  )).join("")}
 </g>
 <g class="semantic-counter-new" opacity="0">
  <text x="360" y="538" text-anchor="middle"
   class="${quantityValue ? "micro-copy" : "large-value"} warm-copy"${stateFit}>${state}</text>
 </g>
 <g class="semantic-cycle-pointer">
  <path d="M360 472 L360 312" class="warm-line pointer-line"/>
  <circle cx="360" cy="472" r="16" class="warm-fill"/>
 </g>
 <path d="M502 336 C565 390 575 495 528 565" class="semantic-draw connector-line"/>
 <path d="M512 548 L528 568 L548 551" class="semantic-draw connector-line"/>
 <text x="360" y="710" text-anchor="middle"
  class="timeline-label"${cycleSubjectFit}>${cycleSubject}</text>
</g>`;
  }
  const ticks = Array.from({ length: 12 }, (_, index) => {
    const angle = (index * 30 - 90) * Math.PI / 180;
    const x1 = 360 + Math.cos(angle) * 180;
    const y1 = 472 + Math.sin(angle) * 180;
    const x2 = 360 + Math.cos(angle) * 198;
    const y2 = 472 + Math.sin(angle) * 198;
    return `<line x1="${x1.toFixed(3)}" y1="${y1.toFixed(3)}"
 x2="${x2.toFixed(3)}" y2="${y2.toFixed(3)}" class="counter-tick"/>`;
  }).join("");
  return `<g data-geometry-kind="finite_counter_rollover" class="semantic-geometry">
 <circle cx="360" cy="472" r="205" class="sentence-surface"/>
 <circle cx="360" cy="472" r="184" pathLength="1"
  class="semantic-draw counter-cycle"/>
 ${ticks}
 <g class="semantic-counter-old">
  <text x="360" y="458" text-anchor="middle" class="counter-value">1023</text>
  <text x="360" y="505" text-anchor="middle" class="micro-copy">MAXIMUM</text>
 </g>
 <g class="semantic-counter-new" opacity="0">
  <text x="360" y="458" text-anchor="middle" class="counter-value warm-copy">0000</text>
  <text x="360" y="505" text-anchor="middle" class="micro-copy">ORIGIN</text>
 </g>
 <g class="semantic-cycle-pointer" transform-origin="360px 472px">
  <path d="M360 472 L360 312" class="warm-line pointer-line"/>
  <circle cx="360" cy="472" r="16" class="warm-fill"/>
 </g>
 <path d="M502 336 C565 390 575 495 528 565" class="semantic-draw connector-line"/>
 <path d="M512 548 L528 568 L548 551" class="semantic-draw connector-line"/>
</g>`;
}

function causeEffectConcept(sentence, parameters) {
  const variant = rendererVariant(sentence, parameters);
  if (!visualConceptRegistry.semanticVisualConceptGroundingMatches({
    visualConceptId: parameters.visualConceptId,
    subjectValue: parameters.subject.value,
    detailValue: parameters.detail.value,
    detailSourceRef: parameters.detail.sourceRef,
    quantity: parameters.quantity,
  })) return "generic";
  return ({
    counter_date_misinterpretation: "wrong_date",
    counter_mapping_mechanism: "counter_mapping_mechanism",
    encoded_bit_register: "bit_register",
    receiver_patch_required: "software_patch",
  })[variant] || "generic";
}

function bitRegisterCauseEffectMarkup(parameters) {
  const numericBitCount = parsedNumberPhrase(parameters.quantity?.value || "");
  const declaredBitCount = Number.isInteger(numericBitCount)
    && numericBitCount > 0
    ? numericBitCount
    : null;
  const exactBitGeometry = Number.isInteger(declaredBitCount)
    && declaredBitCount <= 64;
  const bitCount = exactBitGeometry ? declaredBitCount : 16;
  const columns = bitCount <= 8 ? bitCount : bitCount <= 32 ? 8 : 16;
  const rows = Math.ceil(bitCount / columns);
  const cellGap = columns <= 8 ? 7 : 4;
  const cellWidth = columns <= 8
    ? 28
    : Math.floor((300 - (columns - 1) * cellGap) / columns);
  const cellHeight = rows <= 2 ? 38 : rows === 3 ? 32 : 28;
  const rowGap = rows <= 2 ? 16 : rows === 3 ? 12 : 10;
  const registerHeight = rows * cellHeight + (rows - 1) * rowGap;
  const registerWidth = columns * cellWidth + (columns - 1) * cellGap;
  const registerCenterX = 422;
  const registerStartX = registerCenterX - registerWidth / 2;
  const registerStartY = 430 - registerHeight / 2;
  const cells = Array.from({ length: bitCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowColumns = row === rows - 1 && bitCount % columns
      ? bitCount % columns
      : columns;
    const rowWidth = rowColumns * cellWidth + (rowColumns - 1) * cellGap;
    const x = row === rows - 1
      ? registerCenterX - rowWidth / 2 + column * (cellWidth + cellGap)
      : registerStartX + column * (cellWidth + cellGap);
    const y = registerStartY + row * (cellHeight + rowGap);
    return `<g data-bit-index="${index}">
 <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellWidth}" height="${cellHeight}" rx="7"
  class="${index === bitCount - 1 ? "warm-panel" : "cool-panel"}"/>
</g>`;
  }).join("");
  const quantityValue = displayQuantity(parameters) || "BIT FIELD";
  const quantity = escapeSemanticSentenceXml(quantityValue);
  const detailValue = displayText(parameters.detail.value, 30);
  const detail = escapeSemanticSentenceXml(detailValue);
  const semanticContext = groundedSemanticContext(parameters);
  const inputLabel = /\bgps\b/.test(semanticContext)
    ? "GPS SIGNAL"
    : /\bsignal\b/.test(semanticContext)
      ? "SIGNAL"
      : "ENCODED INPUT";
  return `<g data-geometry-kind="cause_effect_chain"
 data-cause-concept="bit_register" data-cause-asset="mapping_table"
 data-bit-render-mode="${exactBitGeometry ? "exact" : "symbolic_summary"}"
 data-declared-bit-count="${declaredBitCount === null ? "unspecified" : declaredBitCount}"
 data-primitive-parameterized="true" class="semantic-geometry">
 <rect x="64" y="292" width="592" height="350" rx="32" class="sentence-surface"/>
 <g class="semantic-rise">
  <path d="M76 438 C98 402 120 474 142 438 C164 402 186 474 208 438"
   class="semantic-draw cool-line"/>
  <text x="142" y="504" text-anchor="middle" class="micro-copy">${inputLabel}</text>
 </g>
 <path d="M210 438 H250 M232 424 L252 438 L232 452"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise">
  <rect x="252" y="330" width="340" height="238" rx="22" class="cool-panel"/>
  ${cells}
  ${exactBitGeometry ? "" : `<text x="422" y="514" text-anchor="middle"
   class="micro-copy">SYMBOLIC SAMPLE</text>`}
  <text x="422" y="548" text-anchor="middle" class="micro-copy warm-copy"
   ${fitExactTextAttributes(quantityValue, 20, 14, 290).trim()}>${quantity}</text>
 </g>
 <path d="M594 438 H618 M602 424 L622 438 L602 452"
  class="semantic-draw connector-line"/>
 <path d="M628 380 V498 M628 380 H648 M628 498 H648"
  class="semantic-draw warm-line"/>
 <text x="360" y="610" text-anchor="middle" class="timeline-label"
  ${fitExactTextAttributes(detailValue, 19, 13, 520).trim()}>${detail}</text>
</g>`;
}

function wrongDateCauseEffectMarkup(sentence, parameters) {
  const context = groundedSemanticContext(parameters);
  const temporalErrorKind = visualConceptRegistry.semanticTemporalErrorKind(
    parameters.detail.value,
  );
  const outputLabel = temporalErrorKind === "date_error"
    ? "WRONG DATE"
    : temporalErrorKind === "clock_anomaly"
      ? "CLOCK ANOMALY"
      : temporalErrorKind === "time_error"
        ? "TIME ERROR"
        : null;
  if (!outputLabel) {
    throw new TypeError("Temporal error geometry requires grounded output.");
  }
  const isCalendar = sentence.capability.assetId === "calendar_card";
  const inputLabel = /\bweek\b/.test(context)
    ? "WEEK VALUE"
    : /\bgps\b/.test(context)
      ? "GPS VALUE"
    : /\b(?:clock|time)\b/.test(context)
      ? "TIME VALUE"
      : "INPUT VALUE";
  return `<g data-geometry-kind="cause_effect_chain"
 data-cause-concept="wrong_date" data-cause-asset="${sentence.capability.assetId}"
 data-primitive-parameterized="true" class="semantic-geometry">
 <g class="semantic-rise cause-node">
  <rect x="64" y="372" width="166" height="168" rx="24" class="cool-panel"/>
  <path d="M94 430 H200 M94 458 H176 M94 486 H188"
   class="semantic-draw cool-line"/>
  <text x="147" y="518" text-anchor="middle" class="micro-copy">${inputLabel}</text>
 </g>
 <path d="M230 456 H274 M258 442 L276 456 L258 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="276" y="330" width="168" height="252" rx="24" class="sentence-surface"/>
  ${isCalendar
    ? `<rect x="316" y="380" width="88" height="104" rx="12" class="cool-panel"/>
  <path d="M316 410 H404 M338 380 V398 M382 380 V398
   M332 432 H350 M366 432 H384 M332 456 H350 M366 456 H384"
   class="semantic-draw cool-line"/>`
    : `<rect x="326" y="392" width="68" height="82" rx="14" class="cool-panel"/>
  <circle cx="360" cy="434" r="10" class="cool-fill"/>
  <path d="M342 382 Q360 362 378 382 M326 368 Q360 330 394 368"
   class="semantic-draw cool-line"/>`}
  <text x="360" y="542" text-anchor="middle" class="micro-copy">INTERPRET</text>
 </g>
 <path d="M444 456 H488 M472 442 L490 456 L472 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="488" y="372" width="168" height="168" rx="24" class="reject-panel"/>
  <path d="M522 408 H622 M522 436 H594" class="semantic-draw warm-line"/>
  <path d="M526 466 L616 520 M616 466 L526 520" class="semantic-draw error-cross"/>
  <text x="572" y="526" text-anchor="middle" class="micro-copy">${outputLabel}</text>
 </g>
</g>`;
}

function softwarePatchCauseEffectMarkup(parameters) {
  const context = parameters.detail.value.toLocaleLowerCase("en-US");
  const problemLabel = /\bambiguity\b/.test(context)
    ? "AMBIGUITY"
    : /\brollovers?\b/.test(context)
      ? "ROLLOVER"
      : /\bwrong\s+date\b/.test(context)
        ? "WRONG DATE"
        : /\bweek\s+number\b/.test(context)
          ? "WEEK NUMBER"
          : "UPDATE ISSUE";
  const patchLabel = /\bsoftware patches?\b/i.test(parameters.detail.value)
    ? "SOFTWARE PATCH"
    : "UPDATE";
  return `<g data-geometry-kind="cause_effect_chain"
 data-cause-concept="software_patch" data-cause-asset="receiver_device"
 data-primitive-parameterized="true" class="semantic-geometry">
 <g class="semantic-rise cause-node">
  <rect x="62" y="372" width="174" height="170" rx="24" class="reject-panel"/>
  <path d="M94 420 H204 M94 456 H184 M94 492 H198"
   class="semantic-draw error-cross"/>
  <text x="149" y="522" text-anchor="middle" class="micro-copy">${problemLabel}</text>
 </g>
 <path d="M236 456 H276 M260 442 L278 456 L260 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="276" y="326" width="168" height="260" rx="24" class="sentence-surface"/>
  <rect x="326" y="376" width="68" height="82" rx="14" class="cool-panel"/>
  <circle cx="360" cy="418" r="10" class="cool-fill"/>
  <circle cx="402" cy="368" r="28" class="warm-panel"/>
  <path d="M390 368 H414 M402 356 V380" class="semantic-draw warm-line"/>
  <text x="360" y="520" text-anchor="middle" class="micro-copy">${patchLabel}</text>
 </g>
 <path d="M444 456 H486 M470 442 L488 456 L470 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="486" y="372" width="174" height="170" rx="24" class="warm-panel"/>
  <path d="M522 450 L554 482 L624 408" class="semantic-draw warm-line"/>
  <text x="573" y="522" text-anchor="middle" class="micro-copy"
   ${fitExactTextAttributes("UPDATE REQUIRED", 20, 13, 142).trim()}>UPDATE REQUIRED</text>
 </g>
</g>`;
}

function counterMappingMechanismMarkup(parameters) {
  const groundedDetail = escapeSemanticSentenceXml(
    displayText(parameters.detail.value, 34),
  );
  return `<g data-geometry-kind="cause_effect_chain"
 data-cause-concept="counter_mapping_mechanism"
 data-cause-asset="mapping_table" data-primitive-parameterized="true"
 class="semantic-geometry">
 <g class="semantic-rise cause-node">
  <rect x="60" y="370" width="176" height="176" rx="24" class="cool-panel"/>
  <text x="148" y="414" text-anchor="middle" class="micro-copy">COUNTER</text>
  <text x="148" y="482" text-anchor="middle" class="large-value">VALUE</text>
  <path d="M94 510 H202" class="semantic-draw cool-line"/>
 </g>
 <path d="M236 456 H276 M260 442 L278 456 L260 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="276" y="326" width="168" height="264" rx="24" class="sentence-surface"/>
  <rect x="320" y="376" width="80" height="92" rx="14" class="cool-panel"/>
  <path d="M338 400 H382 M338 422 H368 M338 444 H390"
   class="semantic-draw cool-line"/>
  <text x="360" y="520" text-anchor="middle" class="micro-copy">MAPPING RULE</text>
 </g>
 <path d="M444 456 H484 M468 442 L486 456 L468 470"
  class="semantic-draw connector-line"/>
 <g class="semantic-rise cause-node">
  <rect x="484" y="370" width="176" height="176" rx="24" class="warm-panel"/>
  <path d="M520 414 H624 M520 444 H596 M520 474 H612"
   class="semantic-draw warm-line"/>
  <text x="572" y="522" text-anchor="middle" class="micro-copy">RESULT</text>
 </g>
 <text x="360" y="646" text-anchor="middle" class="timeline-label warm-copy"
  ${fitExactTextAttributes(groundedDetail, 19, 12, 560).trim()}>${groundedDetail}</text>
</g>`;
}

function causeEffectMarkup(sentence) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const concept = causeEffectConcept(sentence, parameters);
    if (concept === "bit_register") {
      return bitRegisterCauseEffectMarkup(parameters);
    }
    if (concept === "wrong_date") {
      return wrongDateCauseEffectMarkup(sentence, parameters);
    }
    if (concept === "software_patch") {
      return softwarePatchCauseEffectMarkup(parameters);
    }
    if (concept === "counter_mapping_mechanism") {
      return counterMappingMechanismMarkup(parameters);
    }
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 14),
    );
    const detail = displayText(parameters.detail.value, 22);
    const detailLines = semanticLabelLines(detail, 14);
    const state = escapeSemanticSentenceXml(
      displayText(parameters.stateToken, 14),
    );
    const offset = (parameters.geometry.variantSeed % 3 - 1) * 10;
    const rejected = parameters.stateToken === "REJECTED";
    const assetId = sentence.capability.assetId;
    const assetMotif = {
      calendar_card: `<g data-cause-asset-motif="calendar_card">
   <rect x="312" y="374" width="96" height="116" rx="12" class="cool-panel"/>
   <path d="M312 406 H408 M336 374 V394 M384 374 V394
    M328 426 H348 M362 426 H382 M328 450 H348 M362 450 H382"
    class="semantic-draw cool-line"/>
  </g>`,
      finite_counter: `<g data-cause-asset-motif="finite_counter">
   <circle cx="360" cy="430" r="62" class="cool-halo"/>
   <path d="M360 430 L360 384 M322 430 A38 38 0 1 1 386 458"
    class="semantic-draw cool-line"/>
   <circle cx="360" cy="430" r="8" class="cool-fill"/>
  </g>`,
      mapping_table: `<g class="mapping-grid" data-cause-asset-motif="mapping_table">
   <path d="M306 382 H414 M306 424 H414 M306 466 H414
    M342 358 V508 M378 358 V508" class="muted-line"/>
  </g>`,
      receiver_device: `<g data-cause-asset-motif="receiver_device">
   <rect x="326" y="404" width="68" height="82" rx="14" class="cool-panel"/>
   <circle cx="360" cy="446" r="10" class="cool-fill"/>
   <path d="M342 394 Q360 374 378 394 M326 380 Q360 342 394 380
    M360 486 V510" class="semantic-draw cool-line"/>
  </g>`,
    }[assetId];
    const subjectFit = fitTextAttributes(parameters.subject.value, 14, 132);
    const stateFit = fitTextAttributes(parameters.stateToken, 14, 132);
    return `<g data-geometry-kind="cause_effect_chain"
 data-primitive-parameterized="true" data-cause-asset="${assetId}"
 data-cause-result="${rejected ? "rejected" : "affirmed"}"
 class="semantic-geometry">
 <g class="semantic-rise cause-node">
  <g transform="translate(0 ${offset})">
   <rect x="64" y="376" width="168" height="160" rx="24" class="cool-panel"/>
   <circle cx="148" cy="416" r="18" class="cool-fill"/>
   <text x="148" y="480" text-anchor="middle" class="micro-copy"${subjectFit}>${subject}</text>
  </g>
 </g>
 <g class="semantic-rise cause-node">
  <rect x="276" y="324" width="168" height="264" rx="24" class="sentence-surface"/>
  ${assetMotif}
  ${detailLines.map((line, index) => (
    `<text x="360" y="${542 + index * 22 - (detailLines.length - 1) * 11}"
    text-anchor="middle" class="micro-copy" data-cause-detail-line="${index}"
    ${fitExactTextAttributes(line, 20, 12, 132, 1.5).trim()}>${escapeSemanticSentenceXml(line)}</text>`
  )).join("")}
 </g>
 <g class="semantic-rise cause-node">
  <g transform="translate(0 ${-offset})">
   <rect x="488" y="376" width="168" height="160" rx="24"
    class="${rejected ? "reject-panel" : "warm-panel"}"/>
   <path d="${rejected
    ? "M528 420 L616 492 M616 420 L528 492"
    : "M526 458 L558 490 L620 414"}"
    class="semantic-draw ${rejected ? "error-cross" : "warm-line"}"/>
   <text x="572" y="520" text-anchor="middle" class="micro-copy"${stateFit}>${state}</text>
  </g>
 </g>
 <path d="M232 456 H276 M260 442 L278 456 L260 470"
  class="semantic-draw connector-line"/>
 <path d="M444 456 H488 M472 442 L490 456 L472 470"
  class="semantic-draw connector-line"/>
</g>`;
  }
  const asset = sentence.capability.assetId;
  const middleLabel = asset === "receiver_device" ? "DEVICE" : "INTERPRET";
  return `<g data-geometry-kind="cause_effect_chain" class="semantic-geometry">
 <g class="semantic-rise cause-node">
  <rect x="64" y="376" width="168" height="160" rx="24" class="cool-panel"/>
  <circle cx="148" cy="416" r="18" class="cool-fill"/>
  <text x="148" y="480" text-anchor="middle" class="micro-copy">INPUT</text>
 </g>
 <g class="semantic-rise cause-node">
  <rect x="276" y="324" width="168" height="264" rx="24" class="sentence-surface"/>
  <g class="mapping-grid">
   <path d="M306 382 H414 M306 424 H414 M306 466 H414 M342 358 V508 M378 358 V508"
    class="muted-line"/>
  </g>
  <text x="360" y="552" text-anchor="middle" class="micro-copy">${middleLabel}</text>
 </g>
 <g class="semantic-rise cause-node">
  <rect x="488" y="376" width="168" height="160" rx="24" class="warm-panel"/>
  <path d="M528 420 L616 492 M616 420 L528 492" class="semantic-draw error-cross"/>
  <text x="572" y="520" text-anchor="middle" class="micro-copy">OUTPUT</text>
 </g>
 <path d="M232 456 H276 M260 442 L278 456 L260 470"
  class="semantic-draw connector-line"/>
 <path d="M444 456 H488 M472 442 L490 456 L472 470"
  class="semantic-draw connector-line"/>
</g>`;
}

function comparisonMarkup(sentence) {
  const rejected = sentence.visualIntent.stateTransition === "reject_hypothesis";
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const variant = rendererVariant(sentence, parameters);
    if (
      variant === "counter_capacity_comparison"
    ) {
      const legacyCells = Array.from({ length: 5 }, (_, index) => (
        `<rect x="${112 + index * 32}" y="430" width="24" height="40" rx="6"
 class="cool-panel" data-capacity-cell="legacy-${index}"/>`
      )).join("");
      const modernCells = Array.from({ length: 10 }, (_, index) => (
        `<rect x="${408 + (index % 5) * 38}" y="${404 + Math.floor(index / 5) * 58}"
 width="30" height="42" rx="6" class="${index > 4 ? "warm-panel" : "cool-panel"}"
 data-capacity-cell="modern-${index}"/>`
      )).join("");
      const detailValue = displayText(parameters.detail.value, 28);
      const detailContext = parameters.detail.value.toLocaleLowerCase("en-US");
      const leftTitle = /\blegacy\b/.test(detailContext)
        ? "LEGACY"
        : /\bweek\s+counter\b/.test(detailContext)
          ? "WEEK COUNTER"
          : "COUNTER";
      const rightTitle = /\bnewer\b/.test(detailContext)
        ? /\bnavigation\s+messages?\b/.test(detailContext)
          ? "NEWER MESSAGE"
          : "NEWER"
        : "MESSAGE";
      const comparativeLabel = (
        detailContext.match(
          /\b(?:greater|larger|more|wider)\s+(?:capacity|range|values?|bit\s+field|room)\b/,
        )?.[0] || "CAPACITY"
      ).toLocaleUpperCase("en-US");
      return `<g data-geometry-kind="side_by_side_comparison"
 data-comparison-concept="capacity" data-primitive-parameterized="true"
 class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="66" y="320" width="270" height="312" rx="28" class="sentence-surface"/>
  <text x="201" y="380" text-anchor="middle" class="micro-copy">${leftTitle}</text>
  ${legacyCells}
  <path d="M110 504 H280" class="semantic-draw cool-line"/>
  <path d="M280 486 V522" class="semantic-draw warm-line"/>
  <text x="201" y="574" text-anchor="middle" class="timeline-label">COUNTER</text>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="384" y="320" width="270" height="312" rx="28" class="warm-panel"/>
  <text x="519" y="380" text-anchor="middle" class="micro-copy">${rightTitle}</text>
  ${modernCells}
  <path d="M420 520 H618 M596 502 L620 520 L596 538"
   class="semantic-draw warm-line"/>
  <text x="519" y="574" text-anchor="middle" class="timeline-label">${comparativeLabel}</text>
 </g>
 <text x="360" y="688" text-anchor="middle" class="timeline-label"
  ${fitExactTextAttributes(detailValue, 19, 13, 560).trim()}>${escapeSemanticSentenceXml(detailValue)}</text>
</g>`;
    }
    if (
      variant === "counter_not_time"
    ) {
      return `<g data-geometry-kind="side_by_side_comparison"
 data-comparison-concept="counter_vs_time"
 data-primitive-parameterized="true" class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="62" y="318" width="274" height="322" rx="30" class="sentence-surface"/>
  <path d="M132 454 A70 70 0 1 1 244 500
   M250 476 L244 502 L218 496" class="semantic-draw cool-line"/>
  <circle cx="194" cy="454" r="12" class="cool-fill"/>
  <text x="199" y="574" text-anchor="middle" class="micro-copy">NUMBER RESETS</text>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="384" y="318" width="274" height="322" rx="30" class="warm-panel"/>
  <path d="M430 462 H610 M578 432 L612 462 L578 492"
   class="semantic-draw warm-line"/>
  <circle cx="466" cy="462" r="12" class="warm-fill"/>
  <text x="521" y="574" text-anchor="middle" class="micro-copy">TIME CONTINUES</text>
 </g>
 <circle cx="360" cy="478" r="38" class="reject-panel"/>
 <text x="360" y="490" text-anchor="middle" class="comparison-glyph">≠</text>
 <text x="360" y="690" text-anchor="middle" class="timeline-label warm-copy">NOT TIME ITSELF</text>
</g>`;
    }
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 16),
    );
    const detail = escapeSemanticSentenceXml(
      displayText(parameters.detail.value, 16),
    );
    const state = escapeSemanticSentenceXml(
      displayText(parameters.stateToken, 16),
    );
    const quantityValue = parameters.quantity
      ? displayQuantity(parameters)
      : null;
    const quantity = quantityValue
      ? escapeSemanticSentenceXml(quantityValue)
      : null;
    const radius = 52 + (parameters.geometry.variantSeed % 17);
    const subjectFit = fitTextAttributes(parameters.subject.value, 16, 218);
    const detailFit = fitTextAttributes(parameters.detail.value, 16, 218);
    const stateFit = fitTextAttributes(parameters.stateToken, 16, 218);
    const quantityFit = quantityValue
      ? fitExactTextAttributes(quantityValue, 19, 16, 300)
      : "";
    return `<g data-geometry-kind="side_by_side_comparison"
 data-primitive-parameterized="true" class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="66" y="310" width="258" height="310" rx="28" class="sentence-surface"/>
  <circle cx="195" cy="408" r="${radius}" class="cool-halo"/>
  <path d="M148 408 H242 M195 361 V455" class="semantic-draw cool-line"/>
  <text x="195" y="560" text-anchor="middle" class="micro-copy"${subjectFit}>${subject}</text>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="396" y="310" width="258" height="310" rx="28" class="${rejected ? "reject-panel" : "sentence-surface"}"/>
  <circle cx="525" cy="408" r="${radius}" class="${rejected ? "reject-halo" : "warm-halo"}"/>
  <path d="${rejected ? "M482 365 L568 451 M568 365 L482 451" : "M478 408 H572"}"
   class="semantic-draw ${rejected ? "error-cross" : "warm-line"}"/>
  <text x="525" y="548" text-anchor="middle" class="micro-copy"${detailFit}>${detail}</text>
  <text x="525" y="582" text-anchor="middle" class="micro-copy"${stateFit}>${state}</text>
 </g>
 <line x1="360" y1="340" x2="360" y2="590" class="semantic-divider"/>
 <text x="360" y="490" text-anchor="middle" class="comparison-glyph">${rejected ? "≠" : "VS"}</text>
 ${quantity ? `<text x="360" y="652" text-anchor="middle"
  class="timeline-label warm-copy"${quantityFit}>${quantity}</text>` : ""}
</g>`;
  }
  return `<g data-geometry-kind="side_by_side_comparison" class="semantic-geometry">
 <g class="semantic-compare-left semantic-rise">
  <rect x="66" y="310" width="258" height="310" rx="28" class="sentence-surface"/>
  <circle cx="195" cy="408" r="60" class="cool-halo"/>
  <path d="M148 408 H242 M195 361 V455" class="semantic-draw cool-line"/>
  <text x="195" y="560" text-anchor="middle" class="micro-copy">CLAIM</text>
 </g>
 <g class="semantic-compare-right semantic-rise">
  <rect x="396" y="310" width="258" height="310" rx="28" class="${rejected ? "reject-panel" : "sentence-surface"}"/>
  <circle cx="525" cy="408" r="60" class="${rejected ? "reject-halo" : "warm-halo"}"/>
  <path d="${rejected ? "M482 365 L568 451 M568 365 L482 451" : "M478 408 H572"}"
   class="semantic-draw ${rejected ? "error-cross" : "warm-line"}"/>
  <text x="525" y="560" text-anchor="middle" class="micro-copy">${rejected ? "REJECTED" : "CONTRAST"}</text>
 </g>
 <line x1="360" y1="340" x2="360" y2="590" class="semantic-divider"/>
 <text x="360" y="490" text-anchor="middle" class="comparison-glyph">${rejected ? "≠" : "VS"}</text>
</g>`;
}

function negativeSpaceVesselMarkup(sentence) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 22),
    );
    const state = escapeSemanticSentenceXml(
      displayText(parameters.stateToken, 18),
    );
    const drift = parameters.geometry.variantSeed % 25 - 12;
    const subjectFit = fitTextAttributes(parameters.subject.value, 22, 540);
    const stateFit = fitTextAttributes(parameters.stateToken, 18, 260);
    const groundedContext = `${parameters.subject.value} ${parameters.detail.value}`
      .toLocaleLowerCase("en-US");
    const hasIce = /\b(?:arctic|frozen|glacier|ice|icebound|icy)\b/.test(
      groundedContext,
    );
    const hasBlizzard = /\b(?:blizzard|snow|snowstorm|whiteout)\b/.test(
      groundedContext,
    );
    const environment = hasIce && hasBlizzard
      ? "ice_blizzard"
      : hasIce ? "ice" : hasBlizzard ? "blizzard" : "neutral";
    return `<g data-geometry-kind="negative_space_vessel"
 data-primitive-parameterized="true"
 data-absence-environment="${environment}" class="semantic-geometry">
 ${hasIce ? `<g class="ice-field" transform="translate(${drift} 0)">
  <path d="M54 606 L132 548 L204 592 L278 532 L350 590 L442 526 L518 584 L666 528"
   class="ice-line"/>
  <path d="M72 650 L168 618 L250 658 L342 612 L424 660 L526 614 L650 654"
   class="ice-line secondary-ice"/>
 </g>` : ""}
 ${!hasIce && !hasBlizzard ? `<g class="absence-neutral-field">
  <circle cx="360" cy="472" r="218" class="cool-halo"/>
  <path d="M104 632 H616 M360 278 V666" class="muted-line"/>
 </g>` : ""}
 <g class="semantic-vessel-solid">
  <path d="M180 445 H510 L568 512 Q542 570 468 582 H250 Q188 568 154 512 Z"
   class="vessel-hull"/>
  <path d="M278 445 V350 H444 V445 M316 350 V306 H410 V350"
   class="vessel-structure"/>
  <rect x="300" y="376" width="38" height="30" rx="4" class="vessel-window"/>
  <rect x="360" y="376" width="38" height="30" rx="4" class="vessel-window"/>
 </g>
 <g class="semantic-vessel-absence" opacity="0">
  <path d="M180 445 H510 L568 512 Q542 570 468 582 H250 Q188 568 154 512 Z"
   class="absence-outline"/>
  <path d="M278 445 V350 H444 V445 M316 350 V306 H410 V350"
   class="absence-outline"/>
  <text x="360" y="490" text-anchor="middle" class="absence-mark"${stateFit}>${state}</text>
 </g>
 <text x="360" y="640" text-anchor="middle" class="timeline-label"${subjectFit}>${subject}</text>
 ${hasBlizzard ? `<g class="semantic-blizzard">
  <path d="M82 334 L264 290 M442 312 L650 264 M64 406 L234 364 M472 398 L666 350"
   class="blizzard-line"/>
  <path d="M52 500 L214 462 M500 486 L682 436 M86 564 L206 536 M514 572 L654 538"
   class="blizzard-line"/>
 </g>` : ""}
</g>`;
  }
  return `<g data-geometry-kind="negative_space_vessel" class="semantic-geometry">
 <g class="ice-field">
  <path d="M54 606 L132 548 L204 592 L278 532 L350 590 L442 526 L518 584 L666 528"
   class="ice-line"/>
  <path d="M72 650 L168 618 L250 658 L342 612 L424 660 L526 614 L650 654"
   class="ice-line secondary-ice"/>
 </g>
 <g class="semantic-vessel-solid">
  <path d="M180 445 H510 L568 512 Q542 570 468 582 H250 Q188 568 154 512 Z"
   class="vessel-hull"/>
  <path d="M278 445 V350 H444 V445 M316 350 V306 H410 V350"
   class="vessel-structure"/>
  <rect x="300" y="376" width="38" height="30" rx="4" class="vessel-window"/>
  <rect x="360" y="376" width="38" height="30" rx="4" class="vessel-window"/>
 </g>
 <g class="semantic-vessel-absence" opacity="0">
  <path d="M180 445 H510 L568 512 Q542 570 468 582 H250 Q188 568 154 512 Z"
   class="absence-outline"/>
  <path d="M278 445 V350 H444 V445 M316 350 V306 H410 V350"
   class="absence-outline"/>
  <text x="360" y="490" text-anchor="middle" class="absence-mark">ABSENT</text>
 </g>
 <g class="semantic-blizzard">
  <path d="M82 334 L264 290 M442 312 L650 264 M64 406 L234 364 M472 398 L666 350"
   class="blizzard-line"/>
  <path d="M52 500 L214 462 M500 486 L682 436 M86 564 L206 536 M514 572 L654 538"
   class="blizzard-line"/>
 </g>
</g>`;
}

function mapMotionMarkup(sentence) {
  const observer = sentence.capability.assetId === "witness_marker";
  const marker = observer
    ? `<g class="semantic-route-marker"><circle cx="0" cy="0" r="24" class="cool-panel"/>
       <circle cx="0" cy="-6" r="7" class="bright-fill"/>
       <path d="M-11 12 Q0 1 11 12" class="bright-line"/></g>`
    : `<g class="semantic-route-marker"><path d="M-34 -5 H25 L38 8 Q27 24 2 26 H-23 Q-39 20 -45 8 Z"
       class="route-vessel"/><path d="M-12 -5 V-25 H13 V-5" class="route-vessel-detail"/></g>`;
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const points = parameterRoutePoints(parameters);
    const path = routePath(points, Boolean(parameters.geometry.route));
    const first = points[0];
    const last = points.at(-1);
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 24),
    );
    const detail = escapeSemanticSentenceXml(
      displayText(parameters.detail.value, 24),
    );
    const subjectFit = fitTextAttributes(parameters.subject.value, 24, 260);
    const detailFit = fitTextAttributes(parameters.detail.value, 24, 260);
    const provenance = parameters.geometry.route
      ? "approved_storyboard_layout"
      : "illustrative_seeded";
    return `<g data-geometry-kind="map_motion_route"
 data-geometry-provenance="${provenance}" data-primitive-parameterized="true"
 class="semantic-geometry">
 <rect x="62" y="278" width="596" height="380" rx="32" class="map-surface"/>
 <path d="M102 336 C166 286 232 328 270 386 C318 462 360 314 430 350 C494 382 520 470 620 430"
  class="coast-line"/>
 <path d="M112 574 C198 520 236 602 322 538 C396 482 464 586 610 514"
  class="coast-line secondary-coast"/>
 <g class="map-grid">
  <path d="M160 290 V646 M260 290 V646 M360 290 V646 M460 290 V646 M560 290 V646
   M74 360 H646 M74 450 H646 M74 540 H646" class="map-grid-line"/>
 </g>
 <path d="${path}" pathLength="1"
  class="semantic-route-guide semantic-draw"/>
 <path d="${path}" pathLength="1" class="semantic-route-path"/>
 ${marker}
 <circle cx="${first.x.toFixed(3)}" cy="${first.y.toFixed(3)}" r="10" class="cool-fill"/>
 <circle cx="${last.x.toFixed(3)}" cy="${last.y.toFixed(3)}" r="12" class="warm-fill"/>
 <text x="92" y="314" class="timeline-label"${subjectFit}>${subject}</text>
 <text x="628" y="628" text-anchor="end" class="timeline-label"${detailFit}>${detail}</text>
</g>`;
  }
  return `<g data-geometry-kind="map_motion_route" class="semantic-geometry">
 <rect x="62" y="278" width="596" height="380" rx="32" class="map-surface"/>
 <path d="M102 336 C166 286 232 328 270 386 C318 462 360 314 430 350 C494 382 520 470 620 430"
  class="coast-line"/>
 <path d="M112 574 C198 520 236 602 322 538 C396 482 464 586 610 514"
  class="coast-line secondary-coast"/>
 <g class="map-grid">
  <path d="M160 290 V646 M260 290 V646 M360 290 V646 M460 290 V646 M560 290 V646
   M74 360 H646 M74 450 H646 M74 540 H646" class="map-grid-line"/>
 </g>
 <path d="M118 566 C204 528 246 438 334 464 C418 490 458 390 602 344"
  pathLength="1" class="semantic-route-guide semantic-draw"/>
 <path d="M118 566 C204 528 246 438 334 464 C418 490 458 390 602 344"
  pathLength="1" class="semantic-route-path"/>
 ${marker}
 <circle cx="118" cy="566" r="10" class="cool-fill"/>
 <circle cx="602" cy="344" r="12" class="warm-fill"/>
</g>`;
}

function chronologyMarkup(sentence) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const quantity = parameters.quantity
      ? displayQuantity(parameters)
      : null;
    const labels = [
      displayText(parameters.subject.value, 22),
      displayText(parameters.detail.value, 22),
      quantity
        ? displayText(quantity, 14)
        : displayText(parameters.subject.value, 22),
      displayText(parameters.stateToken, 14),
    ];
    const positions = [126, 264, 402, 560];
    const emphasis = 3;
    return `<g data-geometry-kind="chronology_records"
 data-primitive-parameterized="true" class="semantic-geometry">
 <rect x="66" y="300" width="588" height="330" rx="30" class="sentence-surface"/>
 <path d="M112 486 H608" class="semantic-draw chronology-axis"/>
 ${labels.map((label, index) => {
    const x = positions[index];
    const lines = semanticLabelLines(label, 12);
    const centerY = index % 2 ? 570 : 416;
    return `<g class="semantic-chronology-dot" data-chronology-index="${index}">
      <line x1="${x}" y1="446" x2="${x}" y2="526" class="chronology-tick"/>
      <circle cx="${x}" cy="486" r="${index === emphasis ? 15 : 10}"
       class="${index === emphasis ? "warm-fill" : "cool-fill"}"/>
      ${lines.map((line, lineIndex) => (
    `<text x="${x}" y="${centerY + (lineIndex - (lines.length - 1) / 2) * 20}"
       text-anchor="middle" class="timeline-label"
       data-chronology-label-line="${lineIndex}"${fitExactTextAttributes(line, 18, 12, 112)}>${escapeSemanticSentenceXml(line)}</text>`
  )).join("")}
     </g>`;
  }).join("")}
 <g class="semantic-last-record semantic-rise">
  <rect x="420" y="332" width="188" height="74" rx="16" class="warm-panel"/>
  <text x="514" y="378" text-anchor="middle" class="micro-copy">${escapeSemanticSentenceXml(displayText(parameters.stateToken, 16))}</text>
 </g>
 ${quantity ? `<text x="360" y="612" text-anchor="middle"
  class="timeline-label warm-copy"${fitExactTextAttributes(quantity, 19, 16, 500)}>${escapeSemanticSentenceXml(quantity)}</text>` : ""}
</g>`;
  }
  const records = [
    ["START", 126],
    ["TRACE", 264],
    ["LATER", 402],
    ["LAST", 560],
  ];
  return `<g data-geometry-kind="chronology_records" class="semantic-geometry">
 <rect x="66" y="300" width="588" height="330" rx="30" class="sentence-surface"/>
 <path d="M112 486 H608" class="semantic-draw chronology-axis"/>
 ${records.map(([label, x], index) => (
    `<g class="semantic-chronology-dot" data-chronology-index="${index}">
      <line x1="${x}" y1="446" x2="${x}" y2="526" class="chronology-tick"/>
      <circle cx="${x}" cy="486" r="${index === records.length - 1 ? 15 : 10}"
       class="${index === records.length - 1 ? "warm-fill" : "cool-fill"}"/>
      <text x="${x}" y="${index % 2 ? 570 : 416}" text-anchor="middle" class="timeline-label">${label}</text>
     </g>`
  )).join("")}
 <g class="semantic-last-record semantic-rise">
  <rect x="420" y="332" width="188" height="74" rx="16" class="warm-panel"/>
  <text x="514" y="378" text-anchor="middle" class="micro-copy">LAST RECORD</text>
 </g>
</g>`;
}

function evidenceInspectionMarkup(sentence, sentenceIndex) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const seed = parameters.geometry.variantSeed;
    const highlightX = 326 + seedPart(seed, 0) % 71;
    const highlightY = 376 + seedPart(seed, 8) % 108;
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 18),
    );
    const detail = escapeSemanticSentenceXml(
      displayText(parameters.detail.value, 24),
    );
    const subjectFit = fitTextAttributes(parameters.subject.value, 18, 158);
    const detailFit = fitTextAttributes(parameters.detail.value, 30, 332);
    const requestedNeutralVariant = String(parameters.visualConceptId || "")
      .replace(/^cue_evidence_/, "");
    const neutralVariant = [
      "document",
      "bands",
      "field",
      "focus",
      "frame",
      "network",
      "quote",
      "ribbon",
      "spotlight",
    ].includes(requestedNeutralVariant)
      ? requestedNeutralVariant
      : "focus";
    if (neutralVariant === "focus") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="focus" data-primitive-parameterized="true"
 class="semantic-geometry">
 <circle cx="360" cy="444" r="196" class="sentence-surface"/>
 <circle cx="360" cy="444" r="138" class="cool-panel"/>
 <circle cx="360" cy="444" r="72" class="warm-halo"/>
 <path d="M360 276 V326 M360 562 V612 M192 444 H242 M478 444 H528"
  class="semantic-draw cool-line"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="420"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#0e7490">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="492"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "spotlight") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="spotlight" data-neutral-grounding="cue_text_only"
 data-primitive-parameterized="true" class="semantic-geometry">
 <path d="M236 276 H484 L592 620 H128 Z" class="cool-panel" opacity="0.52"/>
 <ellipse cx="360" cy="558" rx="218" ry="70" class="sentence-surface"/>
 <ellipse cx="360" cy="558" rx="142" ry="42" class="warm-halo"/>
 <circle cx="360" cy="356" r="62" class="warm-panel semantic-rise"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="368"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#071827">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="574"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "field") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="field" data-neutral-grounding="cue_text_only"
 data-primitive-parameterized="true" class="semantic-geometry">
 <circle cx="154" cy="342" r="18" class="cool-fill semantic-rise"/>
 <circle cx="566" cy="366" r="28" class="warm-fill semantic-rise"/>
 <circle cx="116" cy="528" r="12" class="warm-fill semantic-rise"/>
 <circle cx="602" cy="546" r="16" class="cool-fill semantic-rise"/>
 <circle cx="226" cy="620" r="22" class="cool-fill semantic-rise"/>
 <circle cx="506" cy="640" r="10" class="warm-fill semantic-rise"/>
 <rect x="176" y="318" width="368" height="284" rx="142" class="sentence-surface"/>
 <rect x="222" y="372" width="276" height="92" rx="42" class="cool-panel"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="428"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#0e7490">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="530"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "ribbon") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="ribbon" data-neutral-grounding="cue_text_only"
 data-primitive-parameterized="true" class="semantic-geometry">
 <path d="M82 356 C214 268 278 444 402 348 C500 272 564 306 638 376"
  class="semantic-draw cool-line"/>
 <path d="M70 542 C194 642 296 466 414 570 C510 654 578 608 650 526"
  class="semantic-draw warm-line"/>
 <rect x="138" y="344" width="444" height="246" rx="44" class="sentence-surface"/>
 <rect x="202" y="386" width="316" height="72" rx="28" class="warm-panel semantic-rise"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="432"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#071827">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="526"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "frame") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="frame" data-neutral-grounding="cue_text_only"
 data-primitive-parameterized="true" class="semantic-geometry">
 <rect x="104" y="286" width="512" height="354" rx="48" class="sentence-surface"/>
 <rect x="140" y="322" width="440" height="282" rx="34" class="cool-panel"/>
 <path d="M140 386 H194 V332 M526 332 V386 H580 M140 540 H194 V594 M526 594 V540 H580"
  class="semantic-draw warm-line"/>
 <rect x="206" y="382" width="308" height="78" rx="28" class="warm-panel semantic-rise"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="430"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#071827">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="526"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#0e7490">${detail}</text>
</g>`;
    }
    if (neutralVariant === "bands") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="bands" data-neutral-grounding="cue_text_only"
 data-primitive-parameterized="true" class="semantic-geometry">
 <path d="M92 350 C214 274 506 274 628 350" class="semantic-draw cool-line"/>
 <path d="M70 420 C210 332 510 332 650 420" class="semantic-draw warm-line"/>
 <path d="M70 554 C210 642 510 642 650 554" class="semantic-draw warm-line"/>
 <path d="M92 624 C214 700 506 700 628 624" class="semantic-draw cool-line"/>
 <rect x="154" y="370" width="412" height="236" rx="108" class="sentence-surface"/>
 <rect x="216" y="408" width="288" height="72" rx="34" class="cool-panel semantic-rise"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="454"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#0e7490">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="548"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "network") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="network" data-primitive-parameterized="true"
 class="semantic-geometry">
 <path d="M174 430 L360 330 L552 430 L360 566 Z M174 430 L552 430"
  class="semantic-draw connector-line"/>
 <circle cx="174" cy="430" r="44" class="cool-panel"/>
 <circle cx="360" cy="330" r="52" class="sentence-surface"/>
 <circle cx="552" cy="430" r="44" class="cool-panel"/>
 <circle cx="360" cy="566" r="58" class="warm-panel"/>
 <circle cx="360" cy="446" r="26" class="warm-fill"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="350"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#071827">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="682"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    if (neutralVariant === "quote") {
      return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="quote" data-primitive-parameterized="true"
 class="semantic-geometry">
 <rect x="82" y="298" width="556" height="338" rx="34" class="sentence-surface"/>
 <text x="122" y="418" class="counter-value warm-copy">“</text>
 <text x="598" y="584" text-anchor="end" class="counter-value warm-copy">”</text>
 <path d="M150 448 H570 M150 502 H526 M150 556 H548"
  class="semantic-draw cool-line"/>
 <text id="semantic-evidence-${sentenceIndex}-subject" x="360" y="364"
  text-anchor="middle" class="micro-copy"${subjectFit}
  data-legibility-role="key" data-contrast-background="#071827">${subject}</text>
 <text id="semantic-evidence-${sentenceIndex}-detail" x="360" y="688"
  text-anchor="middle" class="timeline-label"${detailFit}
  data-legibility-role="secondary" data-contrast-background="#071827">${detail}</text>
</g>`;
    }
    return `<g data-geometry-kind="evidence_inspection"
 data-evidence-variant="document" data-primitive-parameterized="true"
 class="semantic-geometry">
 <g class="semantic-evidence-record semantic-rise">
  <rect x="112" y="288" width="410" height="348" rx="24" class="paper-surface"/>
  <rect x="146" y="332" width="178" height="28" rx="7" class="paper-heading"/>
  <text id="semantic-evidence-${sentenceIndex}-subject" x="156" y="354" class="micro-copy"${subjectFit}
   fill="#f8fafc" data-legibility-role="key"
   data-contrast-background="#0e7490">${subject}</text>
  <path d="M146 398 H478 M146 444 H478 M146 490 H478 M146 536 H418 M146 582 H382"
   class="record-line"/>
  <rect x="${highlightX}" y="${highlightY}" width="126" height="124" rx="12"
   class="evidence-highlight"/>
  <text id="semantic-evidence-${sentenceIndex}-detail" x="156" y="612" class="timeline-label"${detailFit}
   fill="#0f172a" data-legibility-role="secondary"
   data-contrast-background="#dbeafe">${detail}</text>
 </g>
 <g class="semantic-magnifier">
  <circle cx="470" cy="492" r="92" class="magnifier-lens"/>
  <path d="M536 558 L618 640" class="magnifier-handle"/>
  <path d="M424 470 H516 M424 510 H492" class="semantic-draw cool-line"/>
 </g>
</g>`;
  }
  return `<g data-geometry-kind="evidence_inspection" class="semantic-geometry">
 <g class="semantic-evidence-record semantic-rise">
  <rect x="112" y="288" width="410" height="348" rx="24" class="paper-surface"/>
  <rect x="146" y="332" width="178" height="28" rx="7" class="paper-heading"/>
  <path d="M146 398 H478 M146 444 H478 M146 490 H478 M146 536 H418 M146 582 H382"
   class="record-line"/>
  <rect x="352" y="382" width="126" height="124" rx="12" class="evidence-highlight"/>
 </g>
 <g class="semantic-magnifier">
  <circle cx="470" cy="492" r="92" class="magnifier-lens"/>
  <path d="M536 558 L618 640" class="magnifier-handle"/>
  <path d="M424 470 H516 M424 510 H492" class="semantic-draw cool-line"/>
 </g>
</g>`;
}

function boundedUncertaintyMarkup(sentence) {
  const parameters = sentence.primitiveParameters;
  if (parameters) {
    const rotation = parameters.geometry.variantSeed % 25 - 12;
    const subject = escapeSemanticSentenceXml(
      displayText(parameters.subject.value, 24),
    );
    const state = escapeSemanticSentenceXml(
      displayText(parameters.stateToken, 18),
    );
    const subjectFit = fitTextAttributes(parameters.subject.value, 24, 540);
    const stateFit = fitTextAttributes(parameters.stateToken, 18, 190);
    return `<g data-geometry-kind="bounded_uncertainty"
 data-primitive-parameterized="true" class="semantic-geometry">
 <path d="M126 418 C150 318 264 270 356 314 C446 260 586 326 590 438
  C656 502 578 626 470 614 C396 680 268 648 232 592 C126 610 62 500 126 418 Z"
  pathLength="1" class="semantic-uncertainty-boundary semantic-draw"/>
 <g class="semantic-rise">
  <circle cx="360" cy="470" r="104" class="uncertainty-core"/>
  <text x="360" y="492" text-anchor="middle" class="uncertainty-glyph">?</text>
  <text x="360" y="548" text-anchor="middle" class="micro-copy"${stateFit}>${state}</text>
 </g>
 <text x="360" y="640" text-anchor="middle" class="timeline-label"${subjectFit}>${subject}</text>
 <g class="uncertainty-particles" transform="rotate(${rotation} 360 470)">
  <circle cx="168" cy="400" r="8"/><circle cx="548" cy="362" r="6"/>
  <circle cx="566" cy="544" r="9"/><circle cx="198" cy="584" r="6"/>
 </g>
</g>`;
  }
  return `<g data-geometry-kind="bounded_uncertainty" class="semantic-geometry">
 <path d="M126 418 C150 318 264 270 356 314 C446 260 586 326 590 438
  C656 502 578 626 470 614 C396 680 268 648 232 592 C126 610 62 500 126 418 Z"
  pathLength="1" class="semantic-uncertainty-boundary semantic-draw"/>
 <g class="semantic-rise">
  <circle cx="360" cy="470" r="104" class="uncertainty-core"/>
  <text x="360" y="510" text-anchor="middle" class="uncertainty-glyph">?</text>
 </g>
 <g class="uncertainty-particles">
  <circle cx="168" cy="400" r="8"/><circle cx="548" cy="362" r="6"/>
  <circle cx="566" cy="544" r="9"/><circle cx="198" cy="584" r="6"/>
 </g>
</g>`;
}

function primitiveMarkup(sentence, sentenceIndex = 0) {
  switch (sentence.capability.grammarId) {
    case "before_after":
      return beforeAfterMarkup(sentence);
    case "finite_cycle":
      return finiteCounterMarkup(sentence);
    case "cause_effect_chain":
      return causeEffectMarkup(sentence);
    case "side_by_side_comparison":
      return comparisonMarkup(sentence);
    case "negative_space_absence":
      return negativeSpaceVesselMarkup(sentence);
    case "map_motion":
      return mapMotionMarkup(sentence);
    case "chronology_accumulation":
      return chronologyMarkup(sentence);
    case "evidence_inspection":
      return evidenceInspectionMarkup(sentence, sentenceIndex);
    case "bounded_uncertainty":
      return boundedUncertaintyMarkup(sentence);
    default:
      throw new TypeError("Semantic sentence grammar is unsupported.");
  }
}

function sentenceWithNormalizedParameters(sentence) {
  const hasPrimitiveParameters = sentence.primitiveParameters !== undefined;
  const hasSceneComposition = sentence.sceneComposition !== undefined;
  if (hasPrimitiveParameters !== hasSceneComposition) {
    throw new TypeError(
      "Semantic primitive parameters and scene composition must be supplied together.",
    );
  }
  if (!hasPrimitiveParameters) return sentence;
  const primitiveParameters = normalizeSemanticPrimitiveParameters(
    sentence.primitiveParameters,
  );
  const sceneComposition = normalizeSemanticSceneComposition(
    sentence.sceneComposition,
  );
  if (
    primitiveParameters.grammarId !== sentence.capability?.grammarId
    || primitiveParameters.assetId !== sentence.capability?.assetId
  ) {
    throw new TypeError("Semantic primitive capability binding is invalid.");
  }
  if (sceneComposition.id !== `composition_${sentence.propositionId}`) {
    throw new TypeError("Semantic scene composition proposition binding is invalid.");
  }
  return { ...sentence, primitiveParameters, sceneComposition };
}

export function semanticSentenceGeometryKind(sentence) {
  const normalizedSentence = sentenceWithNormalizedParameters(sentence);
  const match = primitiveMarkup(normalizedSentence)
    .match(/data-geometry-kind="([^"]+)"/);
  if (!match) throw new TypeError("Semantic sentence geometry kind is unavailable.");
  return match[1];
}

export function semanticSentencePrimitiveMarkup(sentence, index) {
  if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
    throw new TypeError("Semantic sentence is invalid.");
  }
  if (!Number.isInteger(index) || index < 0 || index > 95) {
    throw new TypeError("Semantic sentence index is invalid.");
  }
  if (!SUPPORTED_SEMANTIC_SENTENCE_ASSETS.includes(sentence.capability?.assetId)) {
    throw new TypeError("Semantic sentence asset is unsupported.");
  }
  if (!SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS.includes(sentence.capability?.grammarId)) {
    throw new TypeError("Semantic sentence grammar is unsupported.");
  }
  const normalizedSentence = sentenceWithNormalizedParameters(sentence);
  const lines = semanticSentenceTextLines(normalizedSentence.wordSpan?.text);
  if (lines.length > 6) throw new TypeError("Semantic sentence copy exceeds the visual reading budget.");
  const capabilityToken = [
    normalizedSentence.visualIntent.predicate,
    normalizedSentence.visualIntent.subjectKind,
    normalizedSentence.visualIntent.stateTransition,
  ].join(":");
  const primaryGeometry = primitiveMarkup(normalizedSentence, index);
  const geometry = normalizedSentence.sceneComposition
    ? semanticSceneCompositionMarkup(
      normalizedSentence,
      primaryGeometry,
      index,
    )
    : primaryGeometry;
  const renderedGeometry = normalizedSentence.sceneComposition
    ? `<g class="semantic-scene-camera-channel">${geometry}</g>`
    : geometry;
  const capabilityLabelMarkup = normalizedSentence.primitiveParameters
    ? `\n  ${escapeSemanticSentenceXml(displayText(
      normalizedSentence.primitiveParameters.subject.value,
      32,
    ))}`
    : `\n  ${escapeSemanticSentenceXml(
      normalizedSentence.visualIntent.predicate.replaceAll("_", " ").toUpperCase(),
    )}
  · ${escapeSemanticSentenceXml(
      normalizedSentence.visualIntent.subjectKind.replaceAll("_", " ").toUpperCase(),
    )}`;
  const capabilityFit = normalizedSentence.primitiveParameters
    ? fitTextAttributes(
      normalizedSentence.primitiveParameters.subject.value,
      32,
      612,
    )
    : "";
  return `<g id="semantic-sentence-${index}" class="semantic-sentence-stage" opacity="0"
 data-sentence-index="${index}"
 data-sentence-id="${escapeSemanticSentenceXml(normalizedSentence.id)}"
 data-proposition-id="${escapeSemanticSentenceXml(normalizedSentence.propositionId)}"
 data-source-beat-id="${escapeSemanticSentenceXml(normalizedSentence.beatId)}"
 data-asset-id="${escapeSemanticSentenceXml(normalizedSentence.capability.assetId)}"
 data-grammar-id="${escapeSemanticSentenceXml(normalizedSentence.capability.grammarId)}"
 data-capability="${escapeSemanticSentenceXml(capabilityToken)}"
 data-capability-predicate="${escapeSemanticSentenceXml(normalizedSentence.visualIntent.predicate)}"
 data-capability-subject-kind="${escapeSemanticSentenceXml(normalizedSentence.visualIntent.subjectKind)}"
 data-capability-state-transition="${escapeSemanticSentenceXml(normalizedSentence.visualIntent.stateTransition)}"
 data-claim-ids="${escapeSemanticSentenceXml(normalizedSentence.claimIds.join(","))}"
 data-focus-entity-id="${escapeSemanticSentenceXml(normalizedSentence.focusEntity.id)}"
 data-entity-id="${escapeSemanticSentenceXml(normalizedSentence.focusEntity.id)}"
 data-focus-target="${escapeSemanticSentenceXml(normalizedSentence.focusEntity.id)}"
 data-caption-policy="avoid">
 <text x="54" y="218" class="sentence-capability-label"${capabilityFit}>${capabilityLabelMarkup}
 </text>
 ${renderedGeometry}
 <g class="semantic-sentence-copy">${textBlock(lines, index)}</g>
</g>`;
}
