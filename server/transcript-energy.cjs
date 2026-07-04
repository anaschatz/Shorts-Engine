const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const MAX_SEGMENTS = 96;
const MAX_KEYWORD_HITS = 12;

const EVENT_KEYWORDS = Object.freeze({
  goal: [
    "what a goal",
    "goal",
    "scores",
    "scored",
    "into the net",
    "back of the net",
    "finds the net",
    "γκολ",
    "σκοραρει",
    "σκοράρει",
  ],
  big_chance: [
    "chance",
    "big chance",
    "huge chance",
    "so close",
    "nearly",
    "almost",
    "off the post",
    "post",
    "ευκαιρια",
    "ευκαιρία",
    "δοκαρι",
    "δοκάρι",
  ],
  save: [
    "save",
    "what a save",
    "keeper",
    "goalkeeper",
    "stops it",
    "denied",
    "αποκρουση",
    "απόκρουση",
    "τερματοφυλακας",
    "τερματοφύλακας",
  ],
  foul: [
    "foul",
    "bad foul",
    "hard foul",
    "challenge",
    "tackle",
    "contact",
    "φαουλ",
    "φάουλ",
    "μαρκαρισμα",
    "μαρκάρισμα",
  ],
  card_moment: [
    "red card",
    "yellow card",
    "sent off",
    "booking",
    "card",
    "καρτα",
    "κάρτα",
    "αποβολη",
    "αποβολή",
  ],
  var_offside: [
    "offside",
    "flag is up",
    "flag goes up",
    "var",
    "review",
    "checking",
    "no goal",
    "disallowed",
    "ruled out",
    "οφσαιντ",
    "οφσάιντ",
    "var",
    "ακυρωνεται",
    "ακυρώνεται",
    "δεν μετρα",
    "δεν μετρά",
  ],
  counter_attack: [
    "counter",
    "counter attack",
    "break",
    "transition",
    "fast break",
    "αντεπιθεση",
    "αντεπίθεση",
  ],
  crowd_reaction: [
    "crowd",
    "fans",
    "roar",
    "listen to that",
    "stadium",
    "reaction",
    "stands",
    "κερκιδα",
    "κερκίδα",
    "κοσμος",
    "κόσμος",
    "αντιδραση",
    "αντίδραση",
  ],
  commentator_peak: [
    "unbelievable",
    "incredible",
    "sensational",
    "wow",
    "oh my",
    "what a moment",
    "huge moment",
    "απιστευτο",
    "απίστευτο",
    "τρομερο",
    "τρομερό",
  ],
});

const REASON_BY_EVENT_TYPE = Object.freeze({
  goal: "goal",
  big_chance: "big_chance",
  save: "save",
  foul: "foul",
  card_moment: "card_moment",
  var_offside: "replay_worthy_moment",
  counter_attack: "counter_attack",
  crowd_reaction: "crowd_reaction",
  commentator_peak: "commentator_peak",
});

const EVENT_PRIORITY = Object.freeze([
  "var_offside",
  "goal",
  "save",
  "card_moment",
  "foul",
  "counter_attack",
  "big_chance",
  "crowd_reaction",
  "commentator_peak",
]);

const NON_EVENT_GOAL_CONTEXT_RE = /\b(?:behind|towards?|near|around|beside|from behind|in front of)\s+(?:the\s+)?goals?\b|\bno\s+goals?\b/i;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeForSearch(value) {
  return sanitizeText(value, 500).toLowerCase();
}

function keywordRegex(term) {
  const safe = sanitizeText(term, 80).toLowerCase();
  if (!safe) return null;
  const escaped = safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (/^[a-z0-9\s-]+$/.test(safe)) return new RegExp(`\\b${escaped}\\b`, "i");
  return new RegExp(escaped, "i");
}

function keywordHitsForText(text) {
  const normalized = normalizeForSearch(text);
  const hits = [];
  for (const [category, terms] of Object.entries(EVENT_KEYWORDS)) {
    for (const term of terms) {
      const regex = keywordRegex(term);
      if (regex && regex.test(normalized)) {
        if (category === "goal" && NON_EVENT_GOAL_CONTEXT_RE.test(normalized)) continue;
        hits.push({
          category,
          keyword: sanitizeText(term, 40),
          reasonCode: REASON_BY_EVENT_TYPE[category] || "commentator_peak",
        });
      }
    }
  }
  return hits.slice(0, MAX_KEYWORD_HITS);
}

function exclamationDensity(text) {
  const safeText = sanitizeText(text, 500);
  const words = safeText.split(/\s+/).filter(Boolean);
  const exclamations = (safeText.match(/[!！]/g) || []).length;
  const uppercaseWords = words.filter((word) => (
    word.length >= 4 &&
    /[A-ZΑ-Ω]/.test(word) &&
    word === word.toUpperCase() &&
    /[A-ZΑ-Ω]/.test(word)
  )).length;
  return round(clamp((exclamations * 0.16) + (uppercaseWords / Math.max(1, words.length)) * 0.75, 0, 1), 3);
}

function eventTypeFromHits(hits) {
  const categories = new Set(hits.map((hit) => hit.category));
  for (const eventType of EVENT_PRIORITY) {
    if (categories.has(eventType)) return eventType;
  }
  return categories.size ? [...categories][0] : "neutral";
}

function goalClaimAllowedFor({ eventType, hits }) {
  if (eventType !== "goal") return false;
  const categories = new Set(hits.map((hit) => hit.category));
  return categories.has("goal") && !categories.has("var_offside");
}

function safeReasonsFor({ eventType, hits, density, intensity }) {
  const reasons = [];
  if (hits.length) reasons.push("transcript_keyword_match");
  if (density >= 0.2) reasons.push("transcript_exclamation_density");
  if (intensity >= 0.72) reasons.push("commentator_intensity_high");
  if (eventType === "goal" && !goalClaimAllowedFor({ eventType, hits })) reasons.push("goal_claim_blocked_by_decision_context");
  if (eventType === "crowd_reaction") reasons.push("crowd_reaction_support_only");
  return reasons.slice(0, 8);
}

function normalizeSegment(segment = {}, index = 0) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) return null;
  const start = Math.max(0, seconds(segment.start ?? segment.time, 0));
  const end = Math.max(start + 0.2, seconds(segment.end, start + 1.6));
  const text = sanitizeText(segment.text || segment.caption || "", 240);
  if (!text) return null;
  return {
    index,
    start: round(start, 2),
    end: round(end, 2),
    center: round((start + end) / 2, 2),
    text,
  };
}

function analyzeSegment(segment) {
  const hits = keywordHitsForText(segment.text);
  const density = exclamationDensity(segment.text);
  const eventType = eventTypeFromHits(hits);
  const keywordScore = clamp(hits.length * 0.14, 0, 0.56);
  const eventBoost = eventType === "neutral" ? 0 : eventType === "crowd_reaction" ? 0.08 : 0.16;
  const commentatorIntensityScore = round(clamp(0.18 + keywordScore + density * 0.58 + eventBoost, 0, 1), 2);
  const goalClaimAllowed = goalClaimAllowedFor({ eventType, hits });
  const reasonCodes = [...new Set([
    ...hits.map((hit) => hit.reasonCode).filter((reason) => reason !== "goal" || goalClaimAllowed),
    commentatorIntensityScore >= 0.66 ? "commentator_peak" : null,
  ].filter(Boolean))].slice(0, 8);
  return {
    start: segment.start,
    end: segment.end,
    center: segment.center,
    textPreview: sanitizeText(segment.text, 96),
    keywordHits: hits.map((hit) => ({
      category: hit.category,
      keyword: hit.keyword,
      reasonCode: hit.reasonCode,
    })),
    exclamationDensity: density,
    commentatorIntensityScore,
    possibleEventType: eventType,
    confidence: round(clamp(commentatorIntensityScore * 0.7 + (hits.length ? 0.2 : 0), 0, 0.96), 2),
    reasonCodes,
    safeReasons: safeReasonsFor({ eventType, hits, density, intensity: commentatorIntensityScore }),
    goalClaimAllowed,
  };
}

function validateTranscriptEnergyOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const serialized = JSON.stringify(output);
  if (/\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret/i.test(serialized)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    schemaVersion: 1,
    providerMode: sanitizeText(output.providerMode || "deterministic-transcript-energy", 80),
    fallbackUsed: Boolean(output.fallbackUsed),
    language: sanitizeText(output.language || "auto", 24),
    windows: (Array.isArray(output.windows) ? output.windows : []).map((window) => ({
      start: round(window.start, 2),
      end: round(Math.max(Number(window.end || 0), Number(window.start || 0) + 0.2), 2),
      center: round(window.center, 2),
      textPreview: sanitizeText(window.textPreview, 96),
      keywordHits: (Array.isArray(window.keywordHits) ? window.keywordHits : [])
        .map((hit) => ({
          category: sanitizeText(hit.category, 40),
          keyword: sanitizeText(hit.keyword, 40),
          reasonCode: sanitizeText(hit.reasonCode, 60),
        }))
        .filter((hit) => hit.category && hit.reasonCode)
        .slice(0, MAX_KEYWORD_HITS),
      exclamationDensity: round(clamp(window.exclamationDensity, 0, 1), 3),
      commentatorIntensityScore: round(clamp(window.commentatorIntensityScore, 0, 1), 2),
      possibleEventType: sanitizeText(window.possibleEventType || "neutral", 40),
      confidence: round(clamp(window.confidence, 0, 1), 2),
      reasonCodes: (Array.isArray(window.reasonCodes) ? window.reasonCodes : [])
        .map((reason) => sanitizeText(reason, 60))
        .filter(Boolean)
        .slice(0, 8),
      safeReasons: (Array.isArray(window.safeReasons) ? window.safeReasons : [])
        .map((reason) => sanitizeText(reason, 80))
        .filter(Boolean)
        .slice(0, 8),
      goalClaimAllowed: Boolean(window.goalClaimAllowed),
    })).slice(0, MAX_SEGMENTS),
    summary: output.summary && typeof output.summary === "object" && !Array.isArray(output.summary)
      ? {
          windowCount: Math.max(0, Math.round(Number(output.summary.windowCount || 0))),
          highEnergyWindowCount: Math.max(0, Math.round(Number(output.summary.highEnergyWindowCount || 0))),
          goalClaimAllowedCount: Math.max(0, Math.round(Number(output.summary.goalClaimAllowedCount || 0))),
          possibleEventTypes: (Array.isArray(output.summary.possibleEventTypes) ? output.summary.possibleEventTypes : [])
            .map((type) => sanitizeText(type, 40))
            .filter(Boolean)
            .slice(0, 12),
        }
      : {
          windowCount: 0,
          highEnergyWindowCount: 0,
          goalClaimAllowedCount: 0,
          possibleEventTypes: [],
        },
  };
}

function analyzeTranscriptEnergy({ transcriptSegments = [], language = "auto" } = {}) {
  const segments = (Array.isArray(transcriptSegments) ? transcriptSegments : [])
    .map(normalizeSegment)
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS);
  const windows = segments.map(analyzeSegment);
  const highEnergyWindowCount = windows.filter((window) => window.commentatorIntensityScore >= 0.66).length;
  const possibleEventTypes = [...new Set(windows.map((window) => window.possibleEventType).filter((type) => type && type !== "neutral"))];
  return validateTranscriptEnergyOutput({
    schemaVersion: 1,
    providerMode: "deterministic-transcript-energy",
    fallbackUsed: false,
    language,
    windows,
    summary: {
      windowCount: windows.length,
      highEnergyWindowCount,
      goalClaimAllowedCount: windows.filter((window) => window.goalClaimAllowed).length,
      possibleEventTypes,
    },
  });
}

function transcriptEnergyForWindow(output, { start = 0, end = 0, center = null } = {}) {
  const safe = validateTranscriptEnergyOutput(output || {});
  const windowCenter = center == null ? (seconds(start) + seconds(end)) / 2 : seconds(center);
  const overlapping = safe.windows
    .filter((window) => seconds(window.end) >= seconds(start) - 0.5 && seconds(window.start) <= seconds(end) + 0.5)
    .sort((a, b) => (
      Math.abs(seconds(a.center) - windowCenter) - Math.abs(seconds(b.center) - windowCenter) ||
      Number(b.commentatorIntensityScore || 0) - Number(a.commentatorIntensityScore || 0)
    ));
  return overlapping[0] || null;
}

function publicTranscriptEnergySummary(output) {
  const safe = validateTranscriptEnergyOutput(output || {});
  return {
    providerMode: safe.providerMode,
    fallbackUsed: safe.fallbackUsed,
    language: safe.language,
    summary: safe.summary,
    topWindows: [...safe.windows]
      .sort((a, b) => Number(b.commentatorIntensityScore || 0) - Number(a.commentatorIntensityScore || 0))
      .slice(0, 8)
      .map((window) => ({
        start: window.start,
        end: window.end,
        possibleEventType: window.possibleEventType,
        confidence: window.confidence,
        commentatorIntensityScore: window.commentatorIntensityScore,
        reasonCodes: window.reasonCodes,
        safeReasons: window.safeReasons,
        goalClaimAllowed: window.goalClaimAllowed,
      })),
  };
}

module.exports = {
  analyzeTranscriptEnergy,
  publicTranscriptEnergySummary,
  transcriptEnergyForWindow,
  validateTranscriptEnergyOutput,
};
