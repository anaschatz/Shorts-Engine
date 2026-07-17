const { createHash } = require("node:crypto");
const { AppError } = require("../../../../errors.cjs");
const { contentHash } = require("../../contracts.cjs");

const DARK_CURIOSITY_COMPREHENSION_PROFILE = "dark_curiosity_comprehension_v1";
const PACING_PLAN_SCHEMA_VERSION = 1;
const SUPPORTED_PACING_PROFILES = Object.freeze([DARK_CURIOSITY_COMPREHENSION_PROFILE]);
const NARRATIVE_ROLES = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);
const MIN_PLAN_SEGMENTS = NARRATIVE_ROLES.length;
const MAX_PLAN_SEGMENTS = 16;
const MAX_SEGMENTS_PER_BEAT = 3;
const MIN_SEGMENT_WORDS = 3;
const TARGET_SEGMENT_WORDS = 12;
const MAX_SEGMENT_WORDS = 18;

const GENERIC_ROLE_PACING = Object.freeze({
  hook: Object.freeze({ speakingRate: 0.98, pauseAfterMs: 450 }),
  context: Object.freeze({ speakingRate: 0.96, pauseAfterMs: 350 }),
  evidence: Object.freeze({ speakingRate: 0.92, pauseAfterMs: 450 }),
  turn: Object.freeze({ speakingRate: 0.93, pauseAfterMs: 520 }),
  payoff: Object.freeze({ speakingRate: 0.9, pauseAfterMs: 900 }),
});

const PROFILE_SEGMENTS = Object.freeze([
  Object.freeze({ id: "hook_observation", role: "hook", text: "In 1977, one radio signal looked so unusual that an astronomer wrote one word: Wow.", speakingRate: 0.98, pauseAfterMs: 600 }),
  Object.freeze({ id: "context_frequency_duration", role: "context", text: "It arrived near a frequency researchers considered promising for interstellar communication and lasted seventy-two seconds.", speakingRate: 0.96, pauseAfterMs: 500 }),
  Object.freeze({ id: "evidence_strength_shape", role: "evidence", text: "Its strength rose and fell", speakingRate: 0.88, pauseAfterMs: 100 }),
  Object.freeze({ id: "evidence_beam_crossing", role: "evidence", text: "as the telescope beam crossed the source,", speakingRate: 0.9, pauseAfterMs: 180 }),
  Object.freeze({ id: "evidence_interference_inference", role: "evidence", text: "making ordinary local interference less convincing.", speakingRate: 0.94, pauseAfterMs: 600 }),
  Object.freeze({ id: "turn_search_setup", role: "turn", text: "But later searches", speakingRate: 0.9, pauseAfterMs: 80 }),
  Object.freeze({ id: "turn_no_repeat", role: "turn", text: "never verified the same signal again,", speakingRate: 0.9, pauseAfterMs: 200 }),
  Object.freeze({ id: "turn_no_transmission", role: "turn", text: "and no confirmed transmission has explained it.", speakingRate: 0.94, pauseAfterMs: 650 }),
  Object.freeze({ id: "payoff_not_aliens", role: "payoff", text: "The honest answer is not aliens.", speakingRate: 0.88, pauseAfterMs: 450 }),
  Object.freeze({ id: "payoff_candidate", role: "payoff", text: "It is one strong unexplained candidate", speakingRate: 0.92, pauseAfterMs: 120 }),
  Object.freeze({ id: "payoff_no_proof", role: "payoff", text: "that left no repeatable proof.", speakingRate: 0.9, pauseAfterMs: 1200 }),
]);

function fail(field, details = null) {
  throw new AppError("TTS_PACING_INVALID", "The narration pacing plan is invalid.", 400, { field, ...(details || {}) });
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`);
}

function cleanText(value, field, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value.trim().replace(/\s+/g, " ");
}

function scriptSha256(script) {
  return createHash("sha256").update(script).digest("hex");
}

function scriptWords(script) {
  return cleanText(script, "script").split(/\s+/);
}

function boundaryStrength(word) {
  const value = String(word || "");
  if (/[.!?]["')\]}]*$/.test(value)) return 3;
  if (/[;:]["')\]}]*$/.test(value)) return 2;
  if (/[,\u2013\u2014]["')\]}]*$/.test(value)) return 1;
  return 0;
}

function beginsNewClause(word) {
  return /^(?:and|although|as|because|but|however|if|since|so|then|though|unless|when|while|yet)\b/i.test(String(word || "").replace(/^["'([{]+/, ""));
}

function boundaryScore(words, start, boundary, limit) {
  const strength = boundaryStrength(words[boundary - 1]);
  if (!strength || boundary >= limit) return null;
  return {
    boundary,
    semantic: strength,
    distance: Math.abs((boundary - start) - TARGET_SEGMENT_WORDS),
  };
}

function preferredBoundary(words, start, limit, requireBoundary) {
  if (!requireBoundary) return null;
  const minimum = start + MIN_SEGMENT_WORDS;
  const maximum = Math.min(start + MAX_SEGMENT_WORDS, limit - MIN_SEGMENT_WORDS);
  if (maximum < minimum) return null;
  const candidates = [];
  for (let boundary = minimum; boundary <= maximum; boundary += 1) {
    const candidate = boundaryScore(words, start, boundary, limit);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.semantic - left.semantic || left.distance - right.distance || left.boundary - right.boundary);
  if (candidates.length) return candidates[0].boundary;
  const clauseBoundaries = [];
  for (let boundary = minimum; boundary <= maximum; boundary += 1) {
    if (beginsNewClause(words[boundary])) {
      clauseBoundaries.push({
        boundary,
        distance: Math.abs((boundary - start) - TARGET_SEGMENT_WORDS),
      });
    }
  }
  clauseBoundaries.sort((left, right) => left.distance - right.distance || left.boundary - right.boundary);
  if (clauseBoundaries.length) return clauseBoundaries[0].boundary;
  return Math.min(start + TARGET_SEGMENT_WORDS, maximum);
}

function mergeExcessRanges(words, ranges) {
  const merged = ranges.map((range) => ({ ...range }));
  while (merged.length > MAX_SEGMENTS_PER_BEAT) {
    const candidates = merged.slice(0, -1).map((range, index) => ({
      index,
      strength: boundaryStrength(words[range.end - 1]),
      combinedWords: merged[index + 1].end - range.start,
    }));
    candidates.sort((left, right) => left.strength - right.strength || left.combinedWords - right.combinedWords || left.index - right.index);
    const index = candidates[0].index;
    merged.splice(index, 2, { start: merged[index].start, end: merged[index + 1].end });
  }
  return merged;
}

function genericBeatRanges(words) {
  const ranges = [];
  let start = 0;
  while (start < words.length) {
    const remaining = words.length - start;
    const boundary = preferredBoundary(words, start, words.length, remaining > MAX_SEGMENT_WORDS);
    const end = boundary || words.length;
    ranges.push({ start, end });
    start = end;
  }
  return mergeExcessRanges(words, ranges);
}

function genericPauseAfter(role, words, end, isBeatEnd) {
  if (isBeatEnd) return GENERIC_ROLE_PACING[role].pauseAfterMs;
  const strength = boundaryStrength(words[end - 1]);
  if (strength >= 3) return 360;
  if (strength === 2) return 240;
  if (strength === 1) return 160;
  return 100;
}

function legacyRoleText(role) {
  return PROFILE_SEGMENTS.filter((segment) => segment.role === role).map((segment) => segment.text).join(" ");
}

function isLegacyWowScript(beats) {
  return beats.every((beat) => cleanText(beat.spokenText, `script.beats.${beat.role}.spokenText`, 320) === legacyRoleText(beat.role));
}

function validateFiveBeatScript(script) {
  if (!script || typeof script !== "object" || Array.isArray(script) || !Array.isArray(script.beats)) fail("script");
  if (script.beats.length !== NARRATIVE_ROLES.length) fail("script.beats", { expectedBeatCount: NARRATIVE_ROLES.length });
  return script.beats.map((beat, index) => {
    const role = String(beat && beat.role || "");
    if (role !== NARRATIVE_ROLES[index]) fail(`script.beats.${index}.role`, { role, expectedRole: NARRATIVE_ROLES[index] });
    const id = String(beat && beat.id || "");
    if (!/^beat_[A-Za-z0-9-]{2,72}$/.test(id)) fail(`script.beats.${index}.id`);
    return { ...beat, id, role, spokenText: cleanText(beat.spokenText, `script.beats.${role}.spokenText`, 320) };
  });
}

function buildLegacySegments(beats, roleOffsets) {
  const beatsByRole = new Map(beats.map((beat) => [beat.role, beat]));
  const roleCursors = new Map();
  return PROFILE_SEGMENTS.map((definition, index) => {
    const beat = beatsByRole.get(definition.role);
    const sourceWords = scriptWords(beat.spokenText);
    const expectedWords = scriptWords(definition.text);
    const localStart = roleCursors.get(definition.role) || 0;
    const localEnd = localStart + expectedWords.length;
    if (sourceWords.slice(localStart, localEnd).join(" ") !== definition.text) fail(`segments[${index}].text`, { segmentId: definition.id });
    roleCursors.set(definition.role, localEnd);
    return {
      id: definition.id,
      beatId: beat.id,
      wordStartIndex: roleOffsets.get(definition.role) + localStart,
      wordEndIndex: roleOffsets.get(definition.role) + localEnd,
      text: definition.text,
      speakingRate: definition.speakingRate,
      pauseAfterMs: definition.pauseAfterMs,
    };
  });
}

function buildGenericSegments(beats, roleOffsets) {
  return beats.flatMap((beat) => {
    const words = scriptWords(beat.spokenText);
    const ranges = genericBeatRanges(words);
    return ranges.map((range, index) => ({
      id: `${beat.role}_${String(index + 1).padStart(2, "0")}`,
      beatId: beat.id,
      wordStartIndex: roleOffsets.get(beat.role) + range.start,
      wordEndIndex: roleOffsets.get(beat.role) + range.end,
      text: words.slice(range.start, range.end).join(" "),
      speakingRate: GENERIC_ROLE_PACING[beat.role].speakingRate,
      pauseAfterMs: genericPauseAfter(beat.role, words, range.end, range.end === words.length),
    }));
  });
}

function freezePlan(body, hashValue) {
  const segments = Object.freeze(body.segments.map((segment) => Object.freeze({ ...segment })));
  return Object.freeze({ ...body, segments, contentHash: hashValue });
}

function semanticBoundaryWordIndices(plan) {
  if (!plan || !Array.isArray(plan.segments) || plan.segments.length < 1) fail("pacingPlan.segments");
  return Object.freeze(plan.segments.slice(0, -1).map((segment) => segment.wordEndIndex));
}

function pacingSummary(plan) {
  if (!plan) return null;
  return Object.freeze({
    profile: plan.profile,
    planHash: plan.contentHash,
    segmentCount: plan.segments.length,
    totalPauseMs: plan.totalPauseMs,
    semanticBoundaryWordIndices: semanticBoundaryWordIndices(plan),
  });
}

function pacingSummaryMatchesPlan(summary, plan, options = {}) {
  if (!summary || !plan) return summary === null && plan === null;
  if (summary.profile !== plan.profile || summary.planHash !== plan.contentHash || summary.segmentCount !== plan.segments.length || summary.totalPauseMs !== plan.totalPauseMs) return false;
  const expectedBoundaries = semanticBoundaryWordIndices(plan);
  if (!Array.isArray(summary.semanticBoundaryWordIndices)) return options.requireSemanticBoundaries !== true;
  return summary.semanticBoundaryWordIndices.length === expectedBoundaries.length
    && summary.semanticBoundaryWordIndices.every((value, index) => value === expectedBoundaries[index]);
}

function buildPacingPlan(script, options = {}) {
  const profile = String(options.profile || DARK_CURIOSITY_COMPREHENSION_PROFILE);
  if (!SUPPORTED_PACING_PROFILES.includes(profile)) fail("profile");
  const beats = validateFiveBeatScript(script);
  const spokenScript = beats.map((beat) => beat.spokenText).join(" ");
  const globalWords = scriptWords(spokenScript);
  const roleOffsets = new Map();
  let globalOffset = 0;
  for (const beat of beats) {
    roleOffsets.set(beat.role, globalOffset);
    globalOffset += scriptWords(beat.spokenText).length;
  }
  const segments = isLegacyWowScript(beats) ? buildLegacySegments(beats, roleOffsets) : buildGenericSegments(beats, roleOffsets);
  if (segments.length < MIN_PLAN_SEGMENTS || segments.length > MAX_PLAN_SEGMENTS) fail("segments", { segmentCount: segments.length });
  const body = {
    schemaVersion: PACING_PLAN_SCHEMA_VERSION,
    profile,
    scriptSha256: scriptSha256(spokenScript),
    totalPauseMs: segments.reduce((sum, segment) => sum + segment.pauseAfterMs, 0),
    segments,
  };
  if (segments.map((segment) => segment.text).join(" ") !== globalWords.join(" ")) fail("segments");
  return freezePlan(body, contentHash(body));
}

function normalizePacingPlan(input = {}, options = {}) {
  exact(input, ["schemaVersion", "profile", "scriptSha256", "totalPauseMs", "segments", "contentHash"], "pacingPlan");
  if (Number(input.schemaVersion) !== PACING_PLAN_SCHEMA_VERSION || !SUPPORTED_PACING_PROFILES.includes(input.profile)) fail("pacingPlan.profile");
  const expectedScript = cleanText(options.script, "script");
  const expectedWords = scriptWords(expectedScript);
  if (!/^[a-f0-9]{64}$/.test(String(input.scriptSha256 || "")) || input.scriptSha256 !== scriptSha256(expectedScript)) fail("pacingPlan.scriptSha256");
  if (!Array.isArray(input.segments) || input.segments.length < MIN_PLAN_SEGMENTS || input.segments.length > MAX_PLAN_SEGMENTS) fail("pacingPlan.segments");
  let nextWordIndex = 0;
  const ids = new Set();
  const segments = input.segments.map((segment, index) => {
    exact(segment, ["id", "beatId", "wordStartIndex", "wordEndIndex", "text", "speakingRate", "pauseAfterMs"], `pacingPlan.segments[${index}]`);
    const id = String(segment.id || "");
    const beatId = String(segment.beatId || "");
    const wordStartIndex = Number(segment.wordStartIndex);
    const wordEndIndex = Number(segment.wordEndIndex);
    const text = cleanText(segment.text, `pacingPlan.segments[${index}].text`, 500);
    const speakingRate = Number(segment.speakingRate);
    const pauseAfterMs = Number(segment.pauseAfterMs);
    if (!/^[a-z][a-z0-9_-]{2,79}$/.test(id) || ids.has(id)) fail(`pacingPlan.segments[${index}].id`);
    if (!/^beat_[A-Za-z0-9-]{2,72}$/.test(beatId)) fail(`pacingPlan.segments[${index}].beatId`);
    if (!Number.isInteger(wordStartIndex) || wordStartIndex !== nextWordIndex || !Number.isInteger(wordEndIndex) || wordEndIndex <= wordStartIndex || wordEndIndex > expectedWords.length) fail(`pacingPlan.segments[${index}].wordStartIndex`);
    if (expectedWords.slice(wordStartIndex, wordEndIndex).join(" ") !== text) fail(`pacingPlan.segments[${index}].text`);
    if (!Number.isFinite(speakingRate) || speakingRate < 0.5 || speakingRate > 2 || Number(speakingRate.toFixed(2)) !== speakingRate) fail(`pacingPlan.segments[${index}].speakingRate`);
    if (!Number.isInteger(pauseAfterMs) || pauseAfterMs < 0 || pauseAfterMs > 1500) fail(`pacingPlan.segments[${index}].pauseAfterMs`);
    ids.add(id);
    nextWordIndex = wordEndIndex;
    return { id, beatId, wordStartIndex, wordEndIndex, text, speakingRate, pauseAfterMs };
  });
  if (nextWordIndex !== expectedWords.length || segments.map((segment) => segment.text).join(" ") !== expectedScript) fail("pacingPlan.segments");
  const totalPauseMs = segments.reduce((sum, segment) => sum + segment.pauseAfterMs, 0);
  if (!Number.isInteger(input.totalPauseMs) || input.totalPauseMs !== totalPauseMs) fail("pacingPlan.totalPauseMs");
  const body = { schemaVersion: PACING_PLAN_SCHEMA_VERSION, profile: input.profile, scriptSha256: input.scriptSha256, totalPauseMs, segments };
  const calculated = contentHash(body);
  if (input.contentHash !== undefined && input.contentHash !== calculated) fail("pacingPlan.contentHash");
  return freezePlan(body, calculated);
}

module.exports = {
  DARK_CURIOSITY_COMPREHENSION_PROFILE,
  GENERIC_ROLE_PACING,
  MAX_PLAN_SEGMENTS,
  MIN_PLAN_SEGMENTS,
  NARRATIVE_ROLES,
  PACING_PLAN_SCHEMA_VERSION,
  PROFILE_SEGMENTS,
  SUPPORTED_PACING_PROFILES,
  buildPacingPlan,
  normalizePacingPlan,
  pacingSummary,
  pacingSummaryMatchesPlan,
  semanticBoundaryWordIndices,
};
