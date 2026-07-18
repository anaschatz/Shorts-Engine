const REMOTE_URL = /\bhttps?:\/\//i;

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

function textBlock(lines, sentenceIndex) {
  const startY = 778 - Math.max(0, lines.length - 2) * 18;
  return lines.map((line, index) => (
    `<text id="semantic-sentence-${sentenceIndex}-copy-${index}"
 x="360" y="${startY + index * 38}" text-anchor="middle" class="sentence-copy"
 data-legibility-role="${index === 0 ? "key" : "secondary"}"
 data-contrast-background="#07111f">${escapeSemanticSentenceXml(line)}</text>`
  )).join("");
}

function beforeAfterMarkup() {
  const calendarCells = Array.from({ length: 12 }, (_, index) => {
    const x = 126 + (index % 4) * 52;
    const y = 408 + Math.floor(index / 4) * 46;
    return `<rect x="${x}" y="${y}" width="34" height="26" rx="5" class="calendar-cell"/>`;
  }).join("");
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

function finiteCounterMarkup() {
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

function causeEffectMarkup(sentence) {
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

function negativeSpaceVesselMarkup() {
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

function chronologyMarkup() {
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

function evidenceInspectionMarkup() {
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

function boundedUncertaintyMarkup() {
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

function primitiveMarkup(sentence) {
  switch (sentence.capability.grammarId) {
    case "before_after":
      return beforeAfterMarkup();
    case "finite_cycle":
      return finiteCounterMarkup();
    case "cause_effect_chain":
      return causeEffectMarkup(sentence);
    case "side_by_side_comparison":
      return comparisonMarkup(sentence);
    case "negative_space_absence":
      return negativeSpaceVesselMarkup();
    case "map_motion":
      return mapMotionMarkup(sentence);
    case "chronology_accumulation":
      return chronologyMarkup();
    case "evidence_inspection":
      return evidenceInspectionMarkup();
    case "bounded_uncertainty":
      return boundedUncertaintyMarkup();
    default:
      throw new TypeError("Semantic sentence grammar is unsupported.");
  }
}

export function semanticSentenceGeometryKind(sentence) {
  const match = primitiveMarkup(sentence).match(/data-geometry-kind="([^"]+)"/);
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
  const lines = semanticSentenceTextLines(sentence.wordSpan?.text);
  if (lines.length > 6) throw new TypeError("Semantic sentence copy exceeds the visual reading budget.");
  const capabilityToken = [
    sentence.visualIntent.predicate,
    sentence.visualIntent.subjectKind,
    sentence.visualIntent.stateTransition,
  ].join(":");
  const geometry = primitiveMarkup(sentence);
  return `<g id="semantic-sentence-${index}" class="semantic-sentence-stage" opacity="0"
 data-sentence-index="${index}"
 data-sentence-id="${escapeSemanticSentenceXml(sentence.id)}"
 data-proposition-id="${escapeSemanticSentenceXml(sentence.propositionId)}"
 data-source-beat-id="${escapeSemanticSentenceXml(sentence.beatId)}"
 data-asset-id="${escapeSemanticSentenceXml(sentence.capability.assetId)}"
 data-grammar-id="${escapeSemanticSentenceXml(sentence.capability.grammarId)}"
 data-capability="${escapeSemanticSentenceXml(capabilityToken)}"
 data-capability-predicate="${escapeSemanticSentenceXml(sentence.visualIntent.predicate)}"
 data-capability-subject-kind="${escapeSemanticSentenceXml(sentence.visualIntent.subjectKind)}"
 data-capability-state-transition="${escapeSemanticSentenceXml(sentence.visualIntent.stateTransition)}"
 data-claim-ids="${escapeSemanticSentenceXml(sentence.claimIds.join(","))}"
 data-focus-entity-id="${escapeSemanticSentenceXml(sentence.focusEntity.id)}"
 data-entity-id="${escapeSemanticSentenceXml(sentence.focusEntity.id)}"
 data-focus-target="${escapeSemanticSentenceXml(sentence.focusEntity.id)}"
 data-caption-policy="avoid">
 <text x="54" y="218" class="sentence-capability-label">
  ${escapeSemanticSentenceXml(sentence.visualIntent.predicate.replaceAll("_", " ").toUpperCase())}
  · ${escapeSemanticSentenceXml(sentence.visualIntent.subjectKind.replaceAll("_", " ").toUpperCase())}
 </text>
 ${geometry}
 <g class="semantic-sentence-copy">${textBlock(lines, index)}</g>
</g>`;
}
