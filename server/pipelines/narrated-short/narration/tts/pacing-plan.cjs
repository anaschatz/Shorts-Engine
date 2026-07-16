const { createHash } = require("node:crypto");
const { AppError } = require("../../../../errors.cjs");
const { contentHash } = require("../../contracts.cjs");

const DARK_CURIOSITY_COMPREHENSION_PROFILE = "dark_curiosity_comprehension_v1";
const PACING_PLAN_SCHEMA_VERSION = 1;
const SUPPORTED_PACING_PROFILES = Object.freeze([DARK_CURIOSITY_COMPREHENSION_PROFILE]);

const PROFILE_SEGMENTS = Object.freeze([
  Object.freeze({ id: "hook_observation", role: "hook", text: "In 1977, one radio signal looked so unusual that an astronomer wrote one word: Wow.", speakingRate: 0.98, pauseAfterMs: 850 }),
  Object.freeze({ id: "context_frequency_duration", role: "context", text: "It arrived near a frequency researchers considered promising for interstellar communication and lasted seventy-two seconds.", speakingRate: 0.96, pauseAfterMs: 950 }),
  Object.freeze({ id: "evidence_strength_shape", role: "evidence", text: "Its strength rose and fell", speakingRate: 0.88, pauseAfterMs: 600 }),
  Object.freeze({ id: "evidence_beam_crossing", role: "evidence", text: "as the telescope beam crossed the source,", speakingRate: 0.9, pauseAfterMs: 650 }),
  Object.freeze({ id: "evidence_interference_inference", role: "evidence", text: "making ordinary local interference less convincing.", speakingRate: 0.94, pauseAfterMs: 700 }),
  Object.freeze({ id: "turn_search_setup", role: "turn", text: "But later searches", speakingRate: 0.9, pauseAfterMs: 350 }),
  Object.freeze({ id: "turn_no_repeat", role: "turn", text: "never verified the same signal again,", speakingRate: 0.9, pauseAfterMs: 650 }),
  Object.freeze({ id: "turn_no_transmission", role: "turn", text: "and no confirmed transmission has explained it.", speakingRate: 0.94, pauseAfterMs: 750 }),
  Object.freeze({ id: "payoff_not_aliens", role: "payoff", text: "The honest answer is not aliens.", speakingRate: 0.88, pauseAfterMs: 650 }),
  Object.freeze({ id: "payoff_candidate", role: "payoff", text: "It is one strong unexplained candidate", speakingRate: 0.92, pauseAfterMs: 500 }),
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
  if (!script || typeof script !== "object" || Array.isArray(script) || !Array.isArray(script.beats)) fail("script");
  const profile = String(options.profile || DARK_CURIOSITY_COMPREHENSION_PROFILE);
  if (!SUPPORTED_PACING_PROFILES.includes(profile)) fail("profile");
  const beatsByRole = new Map();
  for (const beat of script.beats) {
    const role = String(beat && beat.role || "");
    if (!role || beatsByRole.has(role)) fail("script.beats", { role });
    beatsByRole.set(role, beat);
  }
  const spokenScript = script.beats.map((beat) => cleanText(beat.spokenText, `script.beats.${beat.role}.spokenText`, 320)).join(" ");
  const globalWords = scriptWords(spokenScript);
  const roleOffsets = new Map();
  let globalOffset = 0;
  for (const beat of script.beats) {
    roleOffsets.set(beat.role, globalOffset);
    globalOffset += scriptWords(beat.spokenText).length;
  }
  const roleCursors = new Map();
  const segments = PROFILE_SEGMENTS.map((definition, index) => {
    const beat = beatsByRole.get(definition.role);
    if (!beat) fail(`segments[${index}].beatId`, { role: definition.role });
    const sourceWords = scriptWords(beat.spokenText);
    const expectedWords = scriptWords(definition.text);
    const localStart = roleCursors.get(definition.role) || 0;
    const localEnd = localStart + expectedWords.length;
    if (sourceWords.slice(localStart, localEnd).join(" ") !== definition.text) fail(`segments[${index}].text`, { segmentId: definition.id });
    roleCursors.set(definition.role, localEnd);
    const wordStartIndex = roleOffsets.get(definition.role) + localStart;
    const wordEndIndex = roleOffsets.get(definition.role) + localEnd;
    return {
      id: definition.id,
      beatId: String(beat.id),
      wordStartIndex,
      wordEndIndex,
      text: definition.text,
      speakingRate: definition.speakingRate,
      pauseAfterMs: definition.pauseAfterMs,
    };
  });
  for (const [role, beat] of beatsByRole) {
    if ((roleCursors.get(role) || 0) !== scriptWords(beat.spokenText).length) fail("segments", { role });
  }
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
  if (!Array.isArray(input.segments) || input.segments.length !== PROFILE_SEGMENTS.length) fail("pacingPlan.segments");
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
    if (!/^beat_[a-z0-9_-]{2,79}$/.test(beatId)) fail(`pacingPlan.segments[${index}].beatId`);
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
  PACING_PLAN_SCHEMA_VERSION,
  PROFILE_SEGMENTS,
  SUPPORTED_PACING_PROFILES,
  buildPacingPlan,
  normalizePacingPlan,
  pacingSummary,
  pacingSummaryMatchesPlan,
  semanticBoundaryWordIndices,
};
