const { randomUUID } = require("node:crypto");
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { basename, isAbsolute, join, relative, resolve } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { CONFIG } = require("./config.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { normalizeOcrEvidence } = require("./goal-evidence-provider.cjs");
const { runFfmpeg } = require("./render.cjs");
const { assertStoragePath, safeResolve, storagePath } = require("./storage.cjs");
const {
  LocalOcrCommandAdapter,
  buildScoreboardTimelineFromObservations,
  parseScoreOnlyScore,
  parseClock,
  parseScoreboardScore,
  scoreAllowedForRegion,
} = require("./adapters/local-ocr-adapter.cjs");
const { readScoreboardCandidate } = require("./scoreboard-reader.cjs");
const {
  calibrationSummary,
  digitReaderSummary,
  readScorebugDigitsAsync,
  validateScorebugCalibration,
} = require("./scorebug-digit-reader.cjs");
const {
  buildScorebugAttemptDiagnostic,
  parseScorebugDigitGroups,
  safeScorebugAttemptDiagnostic,
} = require("./scorebug-calibration.cjs");
const { visualReasonCodesForWindow } = require("./vision.cjs");

const DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS = 15000;
const MAX_SCOREBOARD_OCR_FRAMES = 48;
const MAX_SCOREBOARD_REGIONS = 6;
const MAX_SCOREBOARD_OCR_CROPS = 144;
const DEFAULT_OCR_FRAME_MAX_DIMENSION = 1280;
const ROOT_DIR = resolve(__dirname, "..");
const SCOREBOARD_OCR_QA_RELATIVE_DIR = "demo/results/scoreboard-ocr-artifacts";
const SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH = "demo/results/ocr-scoreboard-qa-latest.json";
const MAX_SCOREBOARD_OCR_QA_ATTEMPTS = 72;
const MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SCOREBOARD_OCR_QA_RETENTION = 8;
const DIGIT_TEMPLATE_MIN_SIMILARITY = 0.88;
const DIGIT_TEMPLATE_MIN_MARGIN = 0.04;
const DIGIT_TEMPLATE_OVERRIDE_SIMILARITY = 0.92;
const MAX_DIGIT_TEMPLATES_PER_VALUE = 12;
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;
const OCR_PREPROCESS_VARIANTS = Object.freeze([
  {
    id: "color_whitelist",
    psm: "11",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*4:ih*4",
  },
  {
    id: "gray_line",
    psm: "7",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.35:brightness=0.03,unsharp=5:5:0.7",
  },
  {
    id: "contrast_block",
    psm: "6",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.65:brightness=0.05,unsharp=5:5:1.0",
  },
  {
    id: "sparse_text",
    psm: "11",
    whitelist: "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    filter: "scale=iw*2:ih*2,format=gray,eq=contrast=1.45:brightness=0.04,unsharp=5:5:0.8",
  },
]);
const SCOREBUG_FIRST_REGION_IDS = Object.freeze([
  "scorebug_broadcast_compact",
  "scorebug_left_compact",
  "scoreboard_top_left",
  "scoreboard_top_center",
  "scoreboard_top_right",
]);
const SCOREBUG_FIRST_FAST_REGION_IDS = Object.freeze([
  "scorebug_broadcast_compact",
  "scorebug_left_compact",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function validDigitSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const width = Math.round(Number(value.width || 0));
  const height = Math.round(Number(value.height || 0));
  const bits = String(value.bits || "");
  if (value.version !== 1 || width !== 10 || height !== 16 || bits.length !== width * height || /[^01]/.test(bits)) {
    return null;
  }
  return { version: 1, width, height, bits };
}

function digitSignatureSimilarity(left, right) {
  const a = validDigitSignature(left);
  const b = validDigitSignature(right);
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  let equal = 0;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < a.bits.length; index += 1) {
    const aOn = a.bits[index] === "1";
    const bOn = b.bits[index] === "1";
    if (aOn === bOn) equal += 1;
    if (aOn && bOn) intersection += 1;
    if (aOn || bOn) union += 1;
  }
  const hamming = equal / a.bits.length;
  const jaccard = union ? intersection / union : 0;
  return round(hamming * 0.35 + jaccard * 0.65, 4);
}

function templateEligibleObservation(observation = {}) {
  return Boolean(
    observation.score &&
    Number(observation.confidence || 0) >= 0.72 &&
    /profile_digit_ocr|digit_reader|digit_template_match/i.test(String(observation.source || ""))
  );
}

function digitTemplatesFromObservations(observations = []) {
  const templates = new Map();
  const add = (digit, role, signature) => {
    const parsedDigit = Number(digit);
    const safeSignature = validDigitSignature(signature);
    if (!Number.isInteger(parsedDigit) || parsedDigit < 0 || parsedDigit > 9 || !safeSignature) return;
    if (!templates.has(parsedDigit)) templates.set(parsedDigit, []);
    const values = templates.get(parsedDigit);
    if (values.length >= MAX_DIGIT_TEMPLATES_PER_VALUE) return;
    values.push({ role, signature: safeSignature });
  };
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!templateEligibleObservation(observation)) continue;
    const signatures = observation.digitSignatures || {};
    add(observation.score.home, "home", signatures.home);
    add(observation.score.away, "away", signatures.away);
  }
  for (const [digit, values] of [...templates.entries()]) {
    const conflictsWithRepeatedDigit = [...templates.entries()].some(([otherDigit, otherValues]) => (
      otherDigit !== digit &&
      otherValues.length >= Math.max(2, values.length + 1) &&
      values.some((value) => otherValues.some((other) => (
        Number(digitSignatureSimilarity(value.signature, other.signature) || 0) >= DIGIT_TEMPLATE_OVERRIDE_SIMILARITY
      )))
    ));
    if (conflictsWithRepeatedDigit) templates.delete(digit);
  }
  return templates;
}

function predictDigitFromTemplates(signature, role, templates) {
  const safeSignature = validDigitSignature(signature);
  if (!safeSignature || !(templates instanceof Map) || !templates.size) return null;
  const candidates = [];
  for (const [digit, values] of templates.entries()) {
    const scores = values
      .map((template) => {
        const similarity = digitSignatureSimilarity(safeSignature, template.signature);
        if (similarity == null) return null;
        return similarity + (template.role === role ? 0.005 : 0);
      })
      .filter((value) => value != null)
      .sort((a, b) => b - a);
    if (scores.length) candidates.push({ digit, similarity: Math.min(1, scores[0]) });
  }
  candidates.sort((a, b) => b.similarity - a.similarity || a.digit - b.digit);
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.similarity < DIGIT_TEMPLATE_MIN_SIMILARITY) return null;
  if (second && best.similarity - second.similarity < DIGIT_TEMPLATE_MIN_MARGIN) return null;
  return {
    digit: best.digit,
    similarity: round(best.similarity, 4),
    margin: second ? round(best.similarity - second.similarity, 4) : null,
  };
}

function recoverScoresFromDigitTemplates(observations = []) {
  const source = Array.isArray(observations) ? observations : [];
  const templates = digitTemplatesFromObservations(source);
  let recoveredObservationCount = 0;
  let correctedWeakObservationCount = 0;
  const recovered = source.map((observation) => {
    const signatures = observation && observation.digitSignatures || {};
    const home = predictDigitFromTemplates(signatures.home, "home", templates);
    const away = predictDigitFromTemplates(signatures.away, "away", templates);
    if (!home || !away) return observation;
    const candidate = { home: home.digit, away: away.digit, text: `${home.digit}-${away.digit}` };
    if (candidate.home + candidate.away > 12) return observation;
    const strongCurrent = templateEligibleObservation(observation);
    const currentText = observation.score && `${observation.score.home}-${observation.score.away}`;
    if (strongCurrent || currentText === candidate.text) return observation;
    const correctingWeakScore = Boolean(currentText);
    if (correctingWeakScore && Math.min(home.similarity, away.similarity) < DIGIT_TEMPLATE_OVERRIDE_SIMILARITY) {
      return observation;
    }
    recoveredObservationCount += 1;
    if (correctingWeakScore) correctedWeakObservationCount += 1;
    return {
      ...observation,
      text: candidate.text,
      score: candidate,
      rejected: false,
      confidence: round(Math.min(0.9, home.similarity, away.similarity), 4),
      source: "local_scorebug_digit_template_match",
      digitTemplateMatch: {
        homeSimilarity: home.similarity,
        awaySimilarity: away.similarity,
      },
    };
  });
  return {
    observations: recovered,
    summary: {
      templateDigitCount: templates.size,
      templateCount: [...templates.values()].reduce((sum, values) => sum + values.length, 0),
      recoveredObservationCount,
      correctedWeakObservationCount,
      applied: recoveredObservationCount > 0,
    },
  };
}

function internalDigitTemplateObservations(observations = []) {
  return (Array.isArray(observations) ? observations : [])
    .map((observation) => {
      const home = validDigitSignature(observation && observation.digitSignatures && observation.digitSignatures.home);
      const away = validDigitSignature(observation && observation.digitSignatures && observation.digitSignatures.away);
      if (!home || !away) return null;
      const score = observation && observation.score;
      return {
        id: sanitizeText(observation.id || "scorebug_digit_observation", 80),
        timestamp: round(observation.timestamp),
        start: round(observation.start ?? observation.timestamp),
        end: round(observation.end ?? observation.timestamp),
        regionId: sanitizeText(observation.regionId || "scorebug_region", 80),
        preprocessingVariant: sanitizeText(observation.preprocessingVariant || "default", 40),
        score: score && Number.isInteger(Number(score.home)) && Number.isInteger(Number(score.away))
          ? { home: Number(score.home), away: Number(score.away), text: `${Number(score.home)}-${Number(score.away)}` }
          : null,
        confidence: round(clamp(observation.confidence, 0, 1), 4),
        rejected: Boolean(observation.rejected),
        source: sanitizeText(observation.source || "local_scorebug_digit_observation", 80),
        digitSignatures: { home, away },
        layoutId: observation.layoutId ? sanitizeText(observation.layoutId, 80) : null,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
}

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 2));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function scaledOcrFrameDimensions(metadata = {}, maxDimension = DEFAULT_OCR_FRAME_MAX_DIMENSION) {
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: DEFAULT_OCR_FRAME_MAX_DIMENSION, height: even(DEFAULT_OCR_FRAME_MAX_DIMENSION * 9 / 16) };
  }
  const scale = Math.min(1, Math.max(320, Math.min(DEFAULT_OCR_FRAME_MAX_DIMENSION, Number(maxDimension) || DEFAULT_OCR_FRAME_MAX_DIMENSION)) / Math.max(sourceWidth, sourceHeight));
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}

function hasUnsafeValue(value) {
  const serialized = JSON.stringify(value || {});
  return SENSITIVE_RE.test(serialized);
}

function deterministicFallback(input = {}) {
  return validateScoreboardOcrOutput({
    ...deterministicScoreboardOcr(input),
    providerMode: "deterministic-scoreboard-ocr",
    fallbackUsed: true,
  }, input.metadata || {});
}

function mediaDimensions(metadata = {}, frame = {}) {
  return {
    width: Math.max(1, Math.round(Number(frame.width || metadata.width || 1920))),
    height: Math.max(1, Math.round(Number(frame.height || metadata.height || 1080))),
  };
}

function normalizeRegion(region = {}, metadata = {}, frame = {}) {
  if (!region || typeof region !== "object" || Array.isArray(region) || hasUnsafeValue(region)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const { width: frameWidth, height: frameHeight } = mediaDimensions(metadata, frame);
  const ratioLike = [region.x, region.y, region.width, region.height].every((value) => Number(value) >= 0 && Number(value) <= 1);
  const rawX = Number(region.x ?? region.left ?? 0);
  const rawY = Number(region.y ?? region.top ?? 0);
  const rawWidth = Number(region.width ?? 0);
  const rawHeight = Number(region.height ?? 0);
  if (!ratioLike && (
    rawX < 0 ||
    rawY < 0 ||
    rawWidth <= 0 ||
    rawHeight <= 0 ||
    rawX >= frameWidth ||
    rawY >= frameHeight ||
    rawX + rawWidth > frameWidth ||
    rawY + rawHeight > frameHeight
  )) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const x = ratioLike ? rawX * frameWidth : rawX;
  const y = ratioLike ? rawY * frameHeight : rawY;
  const width = ratioLike ? rawWidth * frameWidth : rawWidth;
  const height = ratioLike ? rawHeight * frameHeight : rawHeight;
  const safeX = clamp(x, 0, frameWidth - 1);
  const safeY = clamp(y, 0, frameHeight - 1);
  const safeWidth = clamp(width, 8, frameWidth - safeX);
  const safeHeight = clamp(height, 8, frameHeight - safeY);
  const maxRegionArea = frameWidth * frameHeight * 0.28;
  if (safeWidth * safeHeight > maxRegionArea) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    id: sanitizeText(region.id || region.name || "scoreboard_region", 64),
    x: Math.round(safeX),
    y: Math.round(safeY),
    width: Math.round(safeWidth),
    height: Math.round(safeHeight),
    anchor: sanitizeText(region.anchor || "top", 40),
  };
}

function defaultScoreboardRegions(metadata = {}, frame = {}) {
  const { width, height } = mediaDimensions(metadata, frame);
  return [
    { id: "scorebug_broadcast_compact", x: width * 0.035, y: height * 0.035, width: width * 0.40, height: height * 0.095, anchor: "scorebug_top_left" },
    { id: "scorebug_left_compact", x: width * 0.01, y: height * 0.01, width: width * 0.26, height: height * 0.11, anchor: "top_left" },
    { id: "scoreboard_top_left", x: width * 0.01, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_left" },
    { id: "scoreboard_top_center", x: width * 0.28, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_center" },
    { id: "scoreboard_top_right", x: width * 0.55, y: height * 0.01, width: width * 0.44, height: height * 0.16, anchor: "top_right" },
    { id: "broadcast_top_band", x: width * 0.01, y: height * 0.005, width: width * 0.98, height: height * 0.18, anchor: "top_band" },
  ].map((region) => normalizeRegion(region, metadata, frame));
}

const SCOREBUG_LAYOUT_PROFILES = Object.freeze([
  {
    layoutId: "broadcast-compact-score-only-v1",
    regionPattern: /^scorebug_broadcast_compact$/,
    fullScorebugRoi: { x: 0, y: 0, width: 1, height: 1 },
    scoreOnlyRoi: { x: 0.405, y: 0.08, width: 0.19, height: 0.82 },
    homeDigitRoi: { x: 0.03, y: 0.12, width: 0.28, height: 0.76 },
    awayDigitRoi: { x: 0.70, y: 0.12, width: 0.27, height: 0.76 },
    fullHomeDigitRoi: { x: 0.415, y: 0.18, width: 0.075, height: 0.62 },
    fullAwayDigitRoi: { x: 0.545, y: 0.18, width: 0.052, height: 0.62 },
    separatorRoi: { x: 0.49, y: 0.08, width: 0.055, height: 0.82 },
    clockRoi: { x: 0.02, y: 0.04, width: 0.26, height: 0.38 },
    teamLabelRejectRoi: { x: 0.27, y: 0.1, width: 0.13, height: 0.72 },
    minConfidence: 0.72,
    minTemporalStability: 2,
  },
  {
    layoutId: "left-compact-score-only-v1",
    regionPattern: /^scorebug_left_compact$/,
    fullScorebugRoi: { x: 0, y: 0, width: 1, height: 1 },
    scoreOnlyRoi: { x: 0.36, y: 0.08, width: 0.44, height: 0.82 },
    homeDigitRoi: { x: 0.06, y: 0.12, width: 0.34, height: 0.76 },
    awayDigitRoi: { x: 0.53, y: 0.12, width: 0.34, height: 0.76 },
    fullHomeDigitRoi: { x: 0.36, y: 0.16, width: 0.16, height: 0.68 },
    fullAwayDigitRoi: { x: 0.56, y: 0.16, width: 0.16, height: 0.68 },
    separatorRoi: { x: 0.48, y: 0.1, width: 0.08, height: 0.8 },
    clockRoi: { x: 0.02, y: 0.04, width: 0.30, height: 0.38 },
    minConfidence: 0.72,
    minTemporalStability: 2,
  },
  {
    layoutId: "default-scorebug-score-only-v1",
    regionPattern: /^scorebug_/,
    fullScorebugRoi: { x: 0, y: 0, width: 1, height: 1 },
    scoreOnlyRoi: { x: 0.35, y: 0.10, width: 0.42, height: 0.78 },
    homeDigitRoi: { x: 0.06, y: 0.12, width: 0.34, height: 0.76 },
    awayDigitRoi: { x: 0.54, y: 0.12, width: 0.34, height: 0.76 },
    fullHomeDigitRoi: { x: 0.36, y: 0.16, width: 0.16, height: 0.68 },
    fullAwayDigitRoi: { x: 0.56, y: 0.16, width: 0.16, height: 0.68 },
    separatorRoi: { x: 0.48, y: 0.1, width: 0.08, height: 0.8 },
    clockRoi: null,
    minConfidence: 0.74,
    minTemporalStability: 2,
  },
]);

function normalizeRatioRoi(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const x = clamp(value.x ?? value.left ?? 0, 0, 0.99);
  const y = clamp(value.y ?? value.top ?? 0, 0, 0.99);
  const width = clamp(value.width ?? 0.1, 0.02, 1 - x);
  const height = clamp(value.height ?? 0.1, 0.02, 1 - y);
  return {
    x: round(x, 4),
    y: round(y, 4),
    width: round(width, 4),
    height: round(height, 4),
  };
}

function safeScorebugLayoutProfile(profile = {}) {
  const scoreOnlyRoi = normalizeRatioRoi(profile.scoreOnlyRoi);
  const homeDigitRoi = normalizeRatioRoi(profile.homeDigitRoi);
  const awayDigitRoi = normalizeRatioRoi(profile.awayDigitRoi);
  if (!scoreOnlyRoi || !homeDigitRoi || !awayDigitRoi) return null;
  return {
    layoutId: sanitizeText(profile.layoutId || "default-scorebug-score-only-v1", 80),
    fullScorebugRoi: normalizeRatioRoi(profile.fullScorebugRoi),
    scoreOnlyRoi,
    homeDigitRoi,
    awayDigitRoi,
    fullHomeDigitRoi: normalizeRatioRoi(profile.fullHomeDigitRoi),
    fullAwayDigitRoi: normalizeRatioRoi(profile.fullAwayDigitRoi),
    separatorRoi: normalizeRatioRoi(profile.separatorRoi),
    clockRoi: normalizeRatioRoi(profile.clockRoi),
    teamLabelRejectRoi: normalizeRatioRoi(profile.teamLabelRejectRoi),
    minConfidence: round(clamp(profile.minConfidence ?? 0.74, 0.55, 0.98)),
    minTemporalStability: Math.max(1, Math.min(4, Math.round(Number(profile.minTemporalStability || 2)))),
  };
}

function selectScorebugLayoutProfile(region = {}) {
  const regionId = sanitizeText(region.id || "scoreboard_region", 80);
  const profile = SCOREBUG_LAYOUT_PROFILES.find((candidate) => candidate.regionPattern.test(regionId));
  return profile ? safeScorebugLayoutProfile(profile) : null;
}

function scorebugProfileDigitCalibration(profile = null, baseCalibration = {}) {
  const safeProfile = profile ? safeScorebugLayoutProfile(profile) : null;
  if (!safeProfile) return baseCalibration;
  return validateScorebugCalibration({
    ...baseCalibration,
    enabled: true,
    layoutId: safeProfile.layoutId,
    minConfidence: Math.min(Number(baseCalibration.minConfidence || 0.82), safeProfile.minConfidence),
    homeDigitRoi: safeProfile.homeDigitRoi,
    awayDigitRoi: safeProfile.awayDigitRoi,
    hasExplicitDigitRois: true,
    readings: Array.isArray(baseCalibration.readings) ? baseCalibration.readings : [],
  });
}

function scorebugProfileFullCropDigitCalibration(profile = null, baseCalibration = {}) {
  const safeProfile = profile ? safeScorebugLayoutProfile(profile) : null;
  if (!safeProfile || !safeProfile.fullHomeDigitRoi || !safeProfile.fullAwayDigitRoi) return baseCalibration;
  return validateScorebugCalibration({
    ...baseCalibration,
    enabled: true,
    layoutId: `${safeProfile.layoutId}-full-crop`,
    minConfidence: Math.min(Number(baseCalibration.minConfidence || 0.82), safeProfile.minConfidence),
    homeDigitRoi: safeProfile.fullHomeDigitRoi,
    awayDigitRoi: safeProfile.fullAwayDigitRoi,
    hasExplicitDigitRois: true,
    readings: Array.isArray(baseCalibration.readings) ? baseCalibration.readings : [],
  });
}

function regionHintsForFrame(frame = {}, metadata = {}) {
  const hints = Array.isArray(frame.scoreboardRegions) && frame.scoreboardRegions.length
    ? frame.scoreboardRegions
    : Array.isArray(frame.regions) && frame.regions.length
      ? frame.regions
      : [];
  if (!hints.length) return defaultScoreboardRegions(metadata, frame);
  return hints
    .map((region) => normalizeRegion(region, metadata, frame))
    .slice(0, MAX_SCOREBOARD_REGIONS);
}

function frameTimestamp(frame = {}) {
  return seconds(frame.timestamp ?? frame.center ?? frame.time, Number.NaN);
}

function visualWindowCenter(window = {}) {
  const start = seconds(window.start, 0);
  const end = seconds(window.end, start);
  return seconds(window.center ?? (start + end) / 2, start);
}

function normalizeOcrSamplingWindow(candidate = {}, metadata = {}) {
  const duration = seconds(metadata.durationSeconds, 0);
  const center = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
  if (!Number.isFinite(center)) return null;
  const boundedCenter = round(clamp(center, 0, duration || center));
  const start = round(clamp(candidate.start ?? boundedCenter - 1.2, 0, duration || boundedCenter + 1.2));
  const end = round(clamp(candidate.end ?? boundedCenter + 1.2, Math.min(duration || boundedCenter + 1.2, start + 0.4), duration || boundedCenter + 1.2));
  return {
    timestamp: boundedCenter,
    start,
    end,
    confidence: round(clamp(candidate.confidence ?? 0.55, 0.05, 0.98)),
    source: sanitizeText(candidate.source || "scoreboard_ocr_sample", 48),
    visualHints: Array.isArray(candidate.visualHints)
      ? candidate.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
      : [],
  };
}

function pushSamplingTime(windows, time, metadata = {}, input = {}) {
  const window = normalizeOcrSamplingWindow({
    timestamp: time,
    start: input.start,
    end: input.end,
    confidence: input.confidence,
    source: input.source,
    visualHints: input.visualHints,
  }, metadata);
  if (window) windows.push(window);
}

function mediaSignalTimes(mediaSignals = {}) {
  const times = [];
  for (const peak of Array.isArray(mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : []) {
    const time = seconds(peak.time ?? peak.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(peak.energyScore ?? peak.confidence ?? 0) >= 0.62) {
      times.push({ time, confidence: Number(peak.energyScore ?? peak.confidence), source: "audio_peak" });
    }
  }
  for (const change of Array.isArray(mediaSignals.sceneChanges) ? mediaSignals.sceneChanges : []) {
    const time = seconds(change.time ?? change.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(change.confidence ?? 0) >= 0.55) {
      times.push({ time, confidence: Number(change.confidence), source: "scene_change" });
    }
  }
  for (const motion of Array.isArray(mediaSignals.highMotionCandidates) ? mediaSignals.highMotionCandidates : []) {
    const time = seconds(motion.time ?? motion.center ?? motion.timestamp, Number.NaN);
    if (Number.isFinite(time) && Number(motion.confidence ?? motion.score ?? 0) >= 0.5) {
      times.push({ time, confidence: Number(motion.confidence ?? motion.score), source: "high_motion" });
    }
  }
  return times;
}

function explicitOcrSamplingWindows({ ocrSamplingWindows = [], metadata = {} } = {}) {
  const rawWindows = Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows : [];
  if (!rawWindows.length) return null;
  return rawWindows
    .map((window) => normalizeOcrSamplingWindow(window, metadata))
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
}

function selectOcrSamplingWindows({ frames = [], visualSignals = {}, candidateWindows = [], mediaSignals = {}, metadata = {}, ocrSamplingWindows = [] } = {}) {
  const explicitWindows = explicitOcrSamplingWindows({ ocrSamplingWindows, metadata });
  if (explicitWindows) return explicitWindows;

  const duration = seconds(metadata.durationSeconds, 0);
  const windows = [];
  if (duration > 0) {
    const periodicCount = duration >= 480
      ? 36
      : duration >= 120
        ? 28
        : Math.min(8, MAX_SCOREBOARD_OCR_FRAMES);
    for (let index = 0; index < periodicCount; index += 1) {
      const ratio = (index + 0.5) / periodicCount;
      pushSamplingTime(windows, duration * ratio, metadata, {
        confidence: 0.52,
        source: "full_source_periodic_scoreboard_sample",
      });
    }
    if (duration >= 180) {
      for (const ratio of [0.08, 0.16, 0.33, 0.5, 0.66, 0.82, 0.92, 0.98]) {
        pushSamplingTime(windows, duration * ratio, metadata, {
          confidence: 0.58,
          source: "full_source_anchor_scoreboard_sample",
        });
      }
    }
  }
  for (const frame of Array.isArray(frames) ? frames : []) {
    const timestamp = frameTimestamp(frame);
    if (!Number.isFinite(timestamp)) continue;
    pushSamplingTime(windows, timestamp, metadata, {
      start: frame.windowStart,
      end: frame.windowEnd,
      confidence: Number(frame.confidence || 0.58),
      source: "existing_frame_scoreboard_sample",
      visualHints: frame.visualHints,
    });
  }
  const visualWindows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  for (const window of visualWindows.filter(importantVisualWindow)) {
    const center = visualWindowCenter(window);
    for (const offset of [-8, -3, 0, 5, 12, 22]) {
      pushSamplingTime(windows, center + offset, metadata, {
        start: seconds(window.start, center) + offset,
        end: seconds(window.end, center) + offset,
        confidence: Number(window.confidence || 0.7),
        source: "visual_decision_scoreboard_sample",
        visualHints: visualReasonCodesForWindow(window).slice(0, 4),
      });
    }
  }
  for (const candidate of Array.isArray(candidateWindows) ? candidateWindows : []) {
    const time = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
    if (!Number.isFinite(time) || Number(candidate.confidence || 0) < 0.55) continue;
    for (const offset of [-6, 0, 8, 18]) {
      pushSamplingTime(windows, time + offset, metadata, {
        confidence: Number(candidate.confidence),
        source: "candidate_scoreboard_sample",
        visualHints: candidate.visualHints,
      });
    }
  }
  for (const signal of mediaSignalTimes(mediaSignals)) {
    for (const offset of [-10, 0, 8, 18]) {
      pushSamplingTime(windows, signal.time + offset, metadata, {
        confidence: signal.confidence,
        source: `${signal.source}_scoreboard_sample`,
      });
    }
  }

  const selected = [];
  const sorted = windows
    .filter((window) => Number.isFinite(window.timestamp))
    .sort((a, b) => b.confidence - a.confidence || a.timestamp - b.timestamp);
  const minGap = duration >= 120 ? Math.max(5, duration / MAX_SCOREBOARD_OCR_FRAMES * 0.45) : 2;
  const takeWindow = (window, gap) => {
    if (selected.length >= MAX_SCOREBOARD_OCR_FRAMES) return;
    if (selected.some((item) => Math.abs(item.timestamp - window.timestamp) < gap)) return;
    selected.push(window);
  };
  for (const window of windows.filter((item) => item.source === "full_source_periodic_scoreboard_sample")) {
    takeWindow(window, minGap);
  }
  for (const window of sorted) takeWindow(window, Math.min(3, minGap));
  return selected.sort((a, b) => a.timestamp - b.timestamp);
}

function importantVisualWindow(window = {}) {
  const reasons = new Set(visualReasonCodesForWindow(window));
  return [
    "visual_ball_in_net",
    "visual_scoreboard_context",
    "visual_scoreboard_goal_confirmed",
    "visual_scoreboard_goal_removed",
    "visual_no_goal_decision",
    "visual_referee_goal_signal",
    "visual_referee_no_goal_signal",
    "visual_offside_flag",
    "visual_var_check",
    "visual_var_decision",
    "visual_replay_indicator",
    "visual_replay_angle",
    "visual_shot_contact",
    "visual_ball_toward_goal",
  ].some((reason) => reasons.has(reason));
}

function selectOcrFrames({ frames = [], visualSignals = {}, candidateWindows = [], metadata = {} } = {}) {
  const safeFrames = (Array.isArray(frames) ? frames : [])
    .filter((frame) => Number.isFinite(frameTimestamp(frame)))
    .sort((a, b) => frameTimestamp(a) - frameTimestamp(b));
  if (!safeFrames.length) return [];
  const importantTimes = [];
  const visualWindows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  for (const window of visualWindows.filter(importantVisualWindow)) importantTimes.push(visualWindowCenter(window));
  for (const candidate of Array.isArray(candidateWindows) ? candidateWindows : []) {
    const time = seconds(candidate.timestamp ?? candidate.center ?? candidate.time, Number.NaN);
    if (Number.isFinite(time) && Number(candidate.confidence || 0) >= 0.72) importantTimes.push(time);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  if (duration > 0) {
    importantTimes.push(duration * 0.25, duration * 0.5, duration * 0.75);
  }
  const ranked = safeFrames
    .map((frame) => {
      const timestamp = frameTimestamp(frame);
      const distance = importantTimes.length
        ? Math.min(...importantTimes.map((time) => Math.abs(time - timestamp)))
        : 0;
      const hasHint = Array.isArray(frame.scoreboardOcr) || Array.isArray(frame.scoreboardEvidence) || frame.scoreboardHint;
      return {
        frame,
        score: (hasHint ? 2 : 0) + Math.max(0, 1 - distance / 18) + Number(frame.confidence || 0),
      };
    })
    .sort((a, b) => b.score - a.score || frameTimestamp(a.frame) - frameTimestamp(b.frame));
  const selected = [];
  for (const item of ranked) {
    if (selected.length >= MAX_SCOREBOARD_OCR_FRAMES) break;
    const timestamp = frameTimestamp(item.frame);
    if (selected.some((frame) => Math.abs(frameTimestamp(frame) - timestamp) < 1.25)) continue;
    selected.push(item.frame);
  }
  return selected.sort((a, b) => frameTimestamp(a) - frameTimestamp(b));
}

function evidenceHintsForFrame(frame = {}) {
  if (Array.isArray(frame.scoreboardOcr)) return frame.scoreboardOcr;
  if (Array.isArray(frame.scoreboardEvidence)) return frame.scoreboardEvidence;
  if (frame.scoreboardHint && typeof frame.scoreboardHint === "object") return [frame.scoreboardHint];
  return [];
}

function deterministicScoreboardOcr(input = {}) {
  const metadata = input.metadata || {};
  const frames = selectOcrFrames(input);
  const evidence = [];
  const explicitHints = Array.isArray(input.scoreboardOcr)
    ? input.scoreboardOcr
    : Array.isArray(input.ocrEvidence)
      ? input.ocrEvidence
      : Array.isArray(input.scoreboardEvidence)
        ? input.scoreboardEvidence
        : [];
  for (const [hintIndex, hint] of explicitHints.entries()) {
    if (hasUnsafeValue(hint)) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    evidence.push({
      ...hint,
      id: hint.id || `scoreboard_ocr_hint_${hintIndex + 1}`,
      source: "fixture_scoreboard_ocr_hint",
    });
  }
  for (const [index, frame] of frames.entries()) {
    const regions = regionHintsForFrame(frame, metadata);
    const hints = evidenceHintsForFrame(frame);
    for (const [hintIndex, hint] of hints.entries()) {
      if (hasUnsafeValue(hint)) {
        throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
      }
      evidence.push({
        ...hint,
        id: hint.id || `scoreboard_ocr_${index + 1}_${hintIndex + 1}`,
        timestamp: hint.timestamp ?? frameTimestamp(frame),
        start: hint.start ?? frame.windowStart ?? frameTimestamp(frame) - 0.8,
        end: hint.end ?? frame.windowEnd ?? frameTimestamp(frame) + 0.8,
        confidence: hint.confidence ?? frame.confidence ?? 0.72,
        source: "frame_scoreboard_hint",
        regionId: regions[0] && regions[0].id,
      });
    }
  }
  return validateScoreboardOcrOutput({
    providerMode: "deterministic-scoreboard-ocr",
    fallbackUsed: evidence.length === 0,
    evidence,
    sampledFrameCount: frames.length,
    regionCount: frames.reduce((sum, frame) => sum + regionHintsForFrame(frame, metadata).length, 0),
  }, metadata);
}

function normalizeQaReportSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  return {
    enabled: Boolean(value.enabled),
    runId: sanitizeText(value.runId || "", 120) || null,
    status: sanitizeText(value.status || "unknown", 40),
    reportPath: value.reportPath ? sanitizeText(value.reportPath, 180) : null,
    latestPath: value.latestPath ? sanitizeText(value.latestPath, 180) : null,
    contactSheetPath: value.contactSheetPath ? sanitizeText(value.contactSheetPath, 180) : null,
    reviewPath: value.reviewPath ? sanitizeText(value.reviewPath, 180) : null,
    cropCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_QA_ATTEMPTS, Math.round(Number(value.cropCount || 0)))),
    attemptCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_QA_ATTEMPTS, Math.round(Number(value.attemptCount || 0)))),
  };
}

function normalizeScoreboardOcrChunkSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const chunks = Array.isArray(value.chunks) ? value.chunks : [];
  const safeNumberList = (values = [], max = 16) => (Array.isArray(values) ? values : [])
    .map((item) => round(clamp(item, 0, 24 * 60 * 60)))
    .filter((item) => Number.isFinite(item))
    .slice(0, max);
  const safeTextList = (values = [], max = 12, length = 80) => (Array.isArray(values) ? values : [])
    .map((item) => sanitizeText(item, length))
    .filter(Boolean)
    .slice(0, max);
  const safeScoreCandidate = (candidate = {}) => ({
    chunkIndex: Math.max(0, Math.min(100, Math.round(Number(candidate.chunkIndex || 0)))),
    timestamp: candidate.timestamp == null ? null : round(clamp(candidate.timestamp, 0, 24 * 60 * 60)),
    chunkStart: candidate.chunkStart == null ? null : round(clamp(candidate.chunkStart, 0, 24 * 60 * 60)),
    chunkEnd: candidate.chunkEnd == null ? null : round(clamp(candidate.chunkEnd, 0, 24 * 60 * 60)),
    score: candidate.score ? sanitizeText(candidate.score, 16) : null,
    scoreBefore: candidate.scoreBefore ? sanitizeText(candidate.scoreBefore, 16) : null,
    scoreAfter: candidate.scoreAfter ? sanitizeText(candidate.scoreAfter, 16) : null,
    changedSide: candidate.changedSide ? sanitizeText(candidate.changedSide, 16) : null,
    currentScore: candidate.currentScore ? sanitizeText(candidate.currentScore, 16) : null,
    role: candidate.role ? sanitizeText(candidate.role, 60) : null,
    reason: candidate.reason ? sanitizeText(candidate.reason, 80) : null,
    reasonCodes: safeTextList(candidate.reasonCodes, 8, 80),
  });
  const safeScoreCandidateFirstSeen = (candidate = {}) => {
    const score = sanitizeText(candidate.score || "", 16);
    const timestamp = Number(candidate.timestamp);
    if (!/^\d{1,2}-\d{1,2}$/.test(score) || !Number.isFinite(timestamp)) return null;
    return {
      score,
      timestamp: round(clamp(timestamp, 0, 24 * 60 * 60)),
    };
  };
  const safeScoreCandidateDiagnostics = (diagnostics = null) => {
    if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics) || hasUnsafeValue(diagnostics)) return null;
    return {
      mode: sanitizeText(diagnostics.mode || "chunked_score_candidate_progression", 60),
      firstReadableChunk: diagnostics.firstReadableChunk == null
        ? null
        : Math.max(1, Math.min(100, Math.round(Number(diagnostics.firstReadableChunk || 1)))),
      acceptedCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(diagnostics.acceptedCount || 0)))),
      acceptedScoreChangeCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(diagnostics.acceptedScoreChangeCount || 0)))),
      rejectedCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(diagnostics.rejectedCount || 0)))),
      finalScore: diagnostics.finalScore ? sanitizeText(diagnostics.finalScore, 16) : null,
      acceptedCandidates: Array.isArray(diagnostics.acceptedCandidates)
        ? diagnostics.acceptedCandidates.map((candidate) => safeScoreCandidate(candidate)).slice(0, 16)
        : [],
      rejectedCandidates: Array.isArray(diagnostics.rejectedCandidates)
        ? diagnostics.rejectedCandidates.map((candidate) => safeScoreCandidate(candidate)).slice(0, 24)
        : [],
      reasonCodes: safeTextList(diagnostics.reasonCodes, 8, 80),
    };
  };
  const safeChunk = (chunk = {}, index = 0) => {
    const sampledFrameTimestamps = safeNumberList(chunk.sampledFrameTimestamps, MAX_SCOREBOARD_OCR_FRAMES);
    const plannedFrameCount = Math.max(0, Math.min(
      MAX_SCOREBOARD_OCR_FRAMES,
      Math.round(Number(chunk.plannedFrameCount ?? sampledFrameTimestamps.length)),
    ));
    return {
      index: Math.max(1, Math.min(100, Math.round(Number(chunk.index || index + 1)))),
      start: round(clamp(chunk.start, 0, 24 * 60 * 60)),
      end: round(clamp(chunk.end, 0, 24 * 60 * 60)),
      status: sanitizeText(chunk.status || "unknown", 40),
      plannedFrameCount,
      sampledFrameCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(chunk.sampledFrameCount || 0)))),
      sampledFrameTimestamps,
      roiCandidateIds: safeTextList(chunk.roiCandidateIds, MAX_SCOREBOARD_REGIONS, 80),
      attemptedRoiCount: Math.max(0, Math.min(MAX_SCOREBOARD_REGIONS * 4, Math.round(Number(chunk.attemptedRoiCount || 0)))),
      attemptedObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.attemptedObservationCount || 0)))),
      roiDetected: Boolean(chunk.roiDetected),
      selectedRoiId: chunk.selectedRoiId ? sanitizeText(chunk.selectedRoiId, 80) : null,
      ocrTextCandidateCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.ocrTextCandidateCount || 0)))),
      evidenceCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(chunk.evidenceCount || 0)))),
      scoreChangeCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(chunk.scoreChangeCount || 0)))),
      textPresentObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.textPresentObservationCount || 0)))),
      readableObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.readableObservationCount || 0)))),
      clockOnlyObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.clockOnlyObservationCount || 0)))),
      rejectedObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(chunk.rejectedObservationCount || 0)))),
      stableScoreDecision: sanitizeText(chunk.stableScoreDecision || "unknown", 80),
      normalizedScoreCandidates: safeTextList(chunk.normalizedScoreCandidates, 12, 16),
      scoreCandidateFirstSeenAt: Array.isArray(chunk.scoreCandidateFirstSeenAt)
        ? chunk.scoreCandidateFirstSeenAt.map(safeScoreCandidateFirstSeen).filter(Boolean).slice(0, 12)
        : [],
      rejectedScoreCandidateReasons: safeTextList(chunk.rejectedScoreCandidateReasons, 12, 80),
      skippedReason: chunk.skippedReason ? sanitizeText(chunk.skippedReason, 80) : null,
      nextAction: chunk.nextAction ? sanitizeText(chunk.nextAction, 180) : null,
      elapsedMs: Math.max(0, Math.min(60 * 60 * 1000, Math.round(Number(chunk.elapsedMs || 0)))),
      timeoutMs: chunk.timeoutMs == null
        ? null
        : Math.max(0, Math.min(60 * 60 * 1000, Math.round(Number(chunk.timeoutMs || 0)))),
    };
  };
  const safeChunks = chunks.map(safeChunk).slice(0, 40);
  return {
    mode: sanitizeText(value.mode || "chunked_scorebug_ocr", 60),
    chunkCount: Math.max(0, Math.min(100, Math.round(Number(value.chunkCount || chunks.length || 0)))),
    scannedChunks: Math.max(0, Math.min(100, Math.round(Number(value.scannedChunks || 0)))),
    skippedChunks: Math.max(0, Math.min(100, Math.round(Number(value.skippedChunks || 0)))),
    timedOutChunks: safeChunks.filter((chunk) => chunk.status === "timed_out").length,
    failedChunks: safeChunks.filter((chunk) => chunk.status === "failed").length,
    scannedDurationSeconds: round(clamp(value.scannedDurationSeconds, 0, 24 * 60 * 60)),
    discoveredScoreChanges: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(value.discoveredScoreChanges || 0)))),
    plannedFrameCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES * 100, Math.round(Number(value.plannedFrameCount || 0)))),
    attemptedRoiCount: Math.max(0, Math.min(MAX_SCOREBOARD_REGIONS * 4, Math.round(Number(value.attemptedRoiCount || 0)))),
    attemptedObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS * 100, Math.round(Number(value.attemptedObservationCount || 0)))),
    totalBudgetMs: Math.max(0, Math.min(60 * 60 * 1000, Math.round(Number(value.totalBudgetMs || 0)))),
    chunkTimeoutMs: Math.max(0, Math.min(60 * 60 * 1000, Math.round(Number(value.chunkTimeoutMs || 0)))),
    scoreCandidateDiagnostics: safeScoreCandidateDiagnostics(value.scoreCandidateDiagnostics),
    chunks: safeChunks,
  };
}

function summarizeDigitReaderRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const statuses = safeRows.reduce((acc, row) => {
    const status = sanitizeText(row.digitReaderStatus || "unreadable", 32);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const transitionDecisions = safeRows.reduce((acc, row) => {
    const decision = sanitizeText(row.transitionDecision || "unreadable", 60);
    acc[decision] = (acc[decision] || 0) + 1;
    return acc;
  }, {});
  return {
    readableCount: Number(statuses.readable || 0),
    ambiguousCount: Number(statuses.ambiguous || 0),
    unreadableCount: Number(statuses.unreadable || 0),
    digitBoxCount: safeRows.reduce((sum, row) => sum + Math.max(0, Number(row.digitBoxCount || 0)), 0),
    imageSegmentationReadableCount: safeRows.filter((row) => row.imageSegmentationStatus === "readable").length,
    imageSegmentationAttemptCount: safeRows.filter((row) => row.imageSegmentationStatus).length,
    imageDecoderDecodedCount: safeRows.filter((row) => row.imageDecoderStatus === "decoded").length,
    imageDecoderAttemptCount: safeRows.filter((row) => row.imageDecoderStatus).length,
    scoreOnlyCropCount: safeRows.filter((row) => row.scoreOnlyCropRef).length,
    scoreOnlyReadableCount: safeRows.filter((row) => row.scoreOnlyScore).length,
    profileDigitOcrReadableCount: safeRows.filter((row) => row.profileDigitOcrStatus === "readable").length,
    profileDigitCropCount: safeRows.filter((row) => row.homeDigitCropRef || row.awayDigitCropRef).length,
    transitionDecisions,
    layoutIds: [...new Set(safeRows.map((row) => sanitizeText(row.layoutId || "", 80)).filter(Boolean))].slice(0, 8),
    failClosedReasons: [...new Set(safeRows
      .flatMap((row) => [
        ...(Array.isArray(row.digitReaderReasons) ? row.digitReaderReasons : []),
        ...(Array.isArray(row.rejectedReasonCodes) ? row.rejectedReasonCodes : []),
      ])
      .map((reason) => sanitizeText(reason, 60))
      .filter(Boolean))]
      .slice(0, 12),
  };
}

function normalizeRoiCalibrationSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const safeCandidate = (candidate = {}) => ({
    regionId: sanitizeText(candidate.regionId || "scoreboard_region", 80),
    layoutId: candidate.layoutId ? sanitizeText(candidate.layoutId, 80) : null,
    selected: Boolean(candidate.selected),
    score: round(clamp(candidate.score, -100, 1000)),
    observationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.observationCount || 0)))),
    textPresentCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.textPresentCount || 0)))),
    readableCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.readableCount || 0)))),
    readableObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.readableObservationCount || 0)))),
    rejectedObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.rejectedObservationCount || 0)))),
    clockOnlyObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(candidate.clockOnlyObservationCount || 0)))),
    scoreChangeCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(candidate.scoreChangeCount || 0)))),
    revertedCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(candidate.revertedCount || 0)))),
    unchangedCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(candidate.unchangedCount || 0)))),
    ambiguousCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(candidate.ambiguousCount || 0)))),
    firstTimestamp: candidate.firstTimestamp == null ? null : round(candidate.firstTimestamp),
    lastTimestamp: candidate.lastTimestamp == null ? null : round(candidate.lastTimestamp),
    averageConfidence: round(clamp(candidate.averageConfidence, 0, 1)),
    diagnosis: candidate.diagnosis ? sanitizeText(candidate.diagnosis, 80) : null,
    reasonCodes: Array.isArray(candidate.reasonCodes)
      ? candidate.reasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
      : [],
    nextAction: candidate.nextAction ? sanitizeText(candidate.nextAction, 160) : null,
  });
  return {
    selectedRoi: value.selectedRoi ? safeCandidate({ ...value.selectedRoi, selected: true }) : null,
    candidateCount: Math.max(0, Math.min(MAX_SCOREBOARD_REGIONS * 4, Math.round(Number(value.candidateCount || 0)))),
    rejectedRois: Array.isArray(value.rejectedRois)
      ? value.rejectedRois.map((candidate) => safeCandidate(candidate)).slice(0, MAX_SCOREBOARD_REGIONS * 2)
      : [],
    globalFallback: Boolean(value.globalFallback),
    confidence: round(clamp(value.confidence, 0, 1)),
    reasonCodes: Array.isArray(value.reasonCodes)
      ? value.reasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
      : [],
  };
}

function normalizeScorebugDebugSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const safeCalibration = normalizeRoiCalibrationSummary({
    selectedRoi: value.selectedRoi,
    rejectedRois: value.rejectedRois,
    candidateCount: value.attemptedRoiCount,
    globalFallback: value.globalFallback,
    reasonCodes: value.reasonCodes,
  });
  return {
    attemptedRoiCount: Math.max(0, Math.min(MAX_SCOREBOARD_REGIONS * 4, Math.round(Number(value.attemptedRoiCount || 0)))),
    attemptedObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(value.attemptedObservationCount || 0)))),
    textPresentObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(value.textPresentObservationCount || 0)))),
    readableObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_CROPS, Math.round(Number(value.readableObservationCount || 0)))),
    selectedRoi: safeCalibration && safeCalibration.selectedRoi,
    rejectedRois: safeCalibration ? safeCalibration.rejectedRois : [],
    globalFallbackCandidate: value.globalFallbackCandidate
      ? normalizeRoiCalibrationSummary({ selectedRoi: value.globalFallbackCandidate })?.selectedRoi || null
      : null,
    state: sanitizeText(value.state || "unknown", 80),
    nextAction: sanitizeText(value.nextAction || "inspect-scorebug-debug-summary", 180),
    qaRecommended: Boolean(value.qaRecommended),
    digitTemplateRecovery: value.digitTemplateRecovery && typeof value.digitTemplateRecovery === "object"
      ? {
          templateDigitCount: Math.max(0, Math.min(10, Math.round(Number(value.digitTemplateRecovery.templateDigitCount || 0)))),
          templateCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES * 2, Math.round(Number(value.digitTemplateRecovery.templateCount || 0)))),
          recoveredObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(value.digitTemplateRecovery.recoveredObservationCount || 0)))),
          correctedWeakObservationCount: Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(value.digitTemplateRecovery.correctedWeakObservationCount || 0)))),
          applied: Boolean(value.digitTemplateRecovery.applied),
        }
      : null,
    reasonCodes: Array.isArray(value.reasonCodes)
      ? value.reasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 10)
      : [],
  };
}

function validateScoreboardOcrOutput(output = {}, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const evidence = normalizeOcrEvidence(output.evidence || output.scoreboardOcr || output.ocrEvidence, metadata);
  const sampledFrameCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES, Math.round(Number(output.sampledFrameCount || 0))));
  const regionCount = Math.max(0, Math.min(MAX_SCOREBOARD_OCR_FRAMES * MAX_SCOREBOARD_REGIONS, Math.round(Number(output.regionCount || 0))));
  const regionIdsUsed = Array.isArray(output.regionIdsUsed)
    ? output.regionIdsUsed.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, MAX_SCOREBOARD_REGIONS)
    : [];
  const scoreTimeline = evidence
    .filter((item) => item.scoreBefore || item.scoreAfter || item.status === "clock_only")
    .map((item) => ({
      timestamp: round(item.timestamp),
      status: sanitizeText(item.status || "unknown", 40),
      scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
      scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
      temporalConsistency: Boolean(item.temporalConsistency),
      imageSegmentationStatus: item.imageSegmentationStatus ? sanitizeText(item.imageSegmentationStatus, 40) : null,
      imageDecoderStatus: item.imageDecoderStatus ? sanitizeText(item.imageDecoderStatus, 40) : null,
      imageDecoderMode: item.imageDecoderMode ? sanitizeText(item.imageDecoderMode, 40) : null,
      layoutId: item.layoutId ? sanitizeText(item.layoutId, 80) : null,
      scoreOnlyCropRef: item.scoreOnlyCropRef ? sanitizeText(item.scoreOnlyCropRef, 180) : null,
      transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
      transitionReasonCodes: Array.isArray(item.transitionReasonCodes)
        ? item.transitionReasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
        : [],
    }))
    .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
  const qaReport = normalizeQaReportSummary(output.qaReport);
  const roiCalibration = normalizeRoiCalibrationSummary(output.roiCalibration || output.scorebugRoiCalibration);
  const scorebugDebug = normalizeScorebugDebugSummary(output.scorebugDebug || output.scorebugDebugSummary);
  const chunkSummary = normalizeScoreboardOcrChunkSummary(output.chunkSummary || output.scoreboardOcrChunkSummary);
  return {
    providerMode: sanitizeText(output.providerMode || "deterministic-scoreboard-ocr", 60),
    fallbackUsed: Boolean(output.fallbackUsed || evidence.length === 0),
    confidence: round(clamp(output.confidence ?? (evidence.length ? Math.max(...evidence.map((item) => item.confidence)) : 0), 0, 1)),
    evidence,
    qaReport,
    summary: {
      evidenceCount: evidence.length,
      scoreChangeCount: evidence.filter((item) => item.scoreChanged).length,
      scoreUnchangedCount: evidence.filter((item) => item.scoreUnchanged).length,
      scoreRevertedCount: evidence.filter((item) => item.scoreReverted).length,
      ambiguousCount: evidence.filter((item) => item.ambiguous).length,
      clockOnlyCount: evidence.filter((item) => item.status === "clock_only").length,
      unreadableCount: evidence.filter((item) => item.status === "unreadable").length,
      sampledFrameCount,
      regionCount,
      regionIdsUsed,
      preprocessingVariantCount: Math.max(0, Math.min(8, Math.round(Number(output.preprocessingVariantCount || 0)))),
      roiCalibration,
      scorebugDebug,
      scoreTimeline,
      qaReport,
      chunkSummary,
      fallbackUsed: Boolean(output.fallbackUsed || evidence.length === 0),
    },
    chunkSummary,
  };
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithTimeout(promise, { signal, timeoutMs = DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return Promise.reject(cancellationError());
  let timer = null;
  let abortListener = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => finish(reject, cancellationError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => {
      finish(reject, new AppError("SCOREBOARD_OCR_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, Math.max(250, Math.min(DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS)));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class DeterministicScoreboardOcrProvider {
  health() {
    return {
      ready: true,
      status: "degraded",
      providerMode: "deterministic-scoreboard-ocr",
      fallbackAvailable: true,
      realOcrEnabled: false,
      localOcrEnabled: false,
      runtimeAvailable: false,
      networkRequired: false,
      maxFrames: MAX_SCOREBOARD_OCR_FRAMES,
      maxRegions: MAX_SCOREBOARD_REGIONS,
      capabilities: [
        "scoreboard_region_sampling",
        "fixture_hint_ocr",
        "safe_empty_fallback",
      ],
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    return deterministicScoreboardOcr(input);
  }
}

class ExternalScoreboardOcrProviderAdapter extends DeterministicScoreboardOcrProvider {
  constructor({ client = null } = {}) {
    super();
    this.client = client;
  }

  health() {
    return {
      ...super.health(),
      status: this.client ? "ready" : "degraded",
      providerMode: this.client ? "external-scoreboard-ocr-adapter" : "external-scoreboard-ocr-disabled",
      realOcrEnabled: Boolean(this.client),
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    if (!this.client || typeof this.client.analyzeScoreboardOcr !== "function") {
      return deterministicFallback(input);
    }
    try {
      const output = await raceWithTimeout(this.client.analyzeScoreboardOcr(input), {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });
      return validateScoreboardOcrOutput({
        ...output,
        providerMode: "external-scoreboard-ocr-adapter",
        fallbackUsed: Boolean(output && output.fallbackUsed),
      }, input.metadata || {});
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      if (error && error.code === "AI_OUTPUT_INVALID") throw error;
      return deterministicFallback(input);
    }
  }
}

function safeFilePart(value, fallback = "item") {
  return sanitizeText(value || fallback, 80).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || fallback;
}

function boolFromInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function rootRelative(filePath) {
  const target = resolve(filePath);
  const fromRoot = relative(ROOT_DIR, target).replace(/\\/g, "/");
  if (!fromRoot || fromRoot.startsWith("../") || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return fromRoot;
}

function safeQaRunId(value = randomUUID()) {
  const raw = sanitizeText(value || randomUUID(), 96).replace(/[^A-Za-z0-9._-]/g, "_");
  const id = raw.startsWith("ocr-scoreboard-") ? raw : `ocr-scoreboard-${raw}`;
  if (!/^ocr-scoreboard-[A-Za-z0-9._-]{1,96}$/.test(id) || id.includes("..")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return id.slice(0, 112);
}

function safeResolveRootRelative(relativePath) {
  const safeRelative = String(relativePath || "").replace(/\\/g, "/");
  if (!safeRelative || safeRelative.includes("..") || safeRelative.startsWith("/") || safeRelative.includes("\u0000")) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const target = resolve(ROOT_DIR, safeRelative);
  if (rootRelative(target) !== safeRelative) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return target;
}

function qaRetentionMax(value = CONFIG.scoreboardOcr.qaArtifactRetention) {
  const parsed = Math.round(Number(value || DEFAULT_SCOREBOARD_OCR_QA_RETENTION));
  return Math.max(1, Math.min(50, Number.isFinite(parsed) ? parsed : DEFAULT_SCOREBOARD_OCR_QA_RETENTION));
}

function scoreboardOcrQaEnabled(input = {}) {
  return boolFromInput(input.qaArtifactsEnabled, CONFIG.scoreboardOcr.qaArtifactsEnabled);
}

function createScoreboardOcrQaContext(input = {}) {
  const enabled = scoreboardOcrQaEnabled(input);
  const runId = safeQaRunId(input.qaRunId || randomUUID());
  const directory = `${SCOREBOARD_OCR_QA_RELATIVE_DIR}/${runId}`;
  if (!enabled) {
    return {
      enabled: false,
      runId,
      directory,
      attempts: [],
      files: [],
      contactSheetRows: [],
    };
  }
  const runDir = safeResolveRootRelative(directory);
  mkdirSync(runDir, { recursive: true });
  return {
    enabled: true,
    runId,
    directory,
    runDir,
    attempts: [],
    files: [],
    contactSheetRows: [],
  };
}

function cleanupScoreboardOcrQaArtifacts({ currentRunId, retentionMax = DEFAULT_SCOREBOARD_OCR_QA_RETENTION } = {}) {
  const root = safeResolveRootRelative(SCOREBOARD_OCR_QA_RELATIVE_DIR);
  if (!existsSync(root)) return { retentionMax: qaRetentionMax(retentionMax), removedCount: 0, removed: [] };
  const keep = new Set(currentRunId ? [safeQaRunId(currentRunId)] : []);
  const managed = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^ocr-scoreboard-[A-Za-z0-9._-]+$/.test(entry.name) && !entry.name.includes(".."))
    .map((entry) => {
      const dir = resolve(root, entry.name);
      return { name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of managed) {
    if (keep.size >= qaRetentionMax(retentionMax)) break;
    keep.add(entry.name);
  }
  const removed = [];
  for (const entry of managed) {
    if (keep.has(entry.name)) continue;
    rmSync(entry.dir, { recursive: true, force: true });
    removed.push(`${SCOREBOARD_OCR_QA_RELATIVE_DIR}/${entry.name}`);
  }
  return {
    retentionMax: qaRetentionMax(retentionMax),
    removedCount: removed.length,
    removed,
  };
}

function safeOcrTextPreview(value) {
  return sanitizeText(value || "", 120);
}

function safeDigitOcrTextPreview(value) {
  const text = safeOcrTextPreview(value);
  return SENSITIVE_RE.test(text) ? "" : text;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function qaCropFileName({ attemptIndex, frameIndex, regionId, variantId }) {
  return `ocr-attempt-${String(attemptIndex + 1).padStart(2, "0")}-frame-${String(frameIndex + 1).padStart(2, "0")}-${safeFilePart(regionId, "region")}-${safeFilePart(variantId, "variant")}.png`;
}

function qaScoreOnlyCropFileName({ attemptIndex, frameIndex, regionId, variantId, layoutId }) {
  return `ocr-score-only-${String(attemptIndex + 1).padStart(2, "0")}-frame-${String(frameIndex + 1).padStart(2, "0")}-${safeFilePart(regionId, "region")}-${safeFilePart(variantId, "variant")}-${safeFilePart(layoutId, "layout")}.png`;
}

function qaProfileDigitCropFileName({ attemptIndex, frameIndex, regionId, variantId, layoutId, role }) {
  return `ocr-profile-digit-${safeFilePart(role, "digit")}-${String(attemptIndex + 1).padStart(2, "0")}-frame-${String(frameIndex + 1).padStart(2, "0")}-${safeFilePart(regionId, "region")}-${safeFilePart(variantId, "variant")}-${safeFilePart(layoutId, "layout")}.png`;
}

function safeProfileDigitOcrSummary(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    status: sanitizeText(value.status || "unreadable", 40),
    homeOcrText: safeDigitOcrTextPreview(value.homeOcrText || ""),
    awayOcrText: safeDigitOcrTextPreview(value.awayOcrText || ""),
    homeDigitConfidence: round(clamp(value.homeDigitConfidence, 0, 1)),
    awayDigitConfidence: round(clamp(value.awayDigitConfidence, 0, 1)),
    homeDigitCropPath: value.homeDigitCropPath ? assertStoragePath(value.homeDigitCropPath, "staging") : null,
    awayDigitCropPath: value.awayDigitCropPath ? assertStoragePath(value.awayDigitCropPath, "staging") : null,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
      : [],
  };
}

function copyQaProfileDigitCrop({ qa, sourcePath, attemptIndex, frameIndex, region, variant, layoutProfile, role }) {
  if (!qa || !qa.enabled || !sourcePath || !existsSync(sourcePath)) return null;
  const cropStat = statSync(sourcePath);
  if (!cropStat.isFile() || cropStat.size > MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES) return null;
  const layoutId = layoutProfile && layoutProfile.layoutId ? layoutProfile.layoutId : "profile-digit";
  const fileName = qaProfileDigitCropFileName({
    attemptIndex,
    frameIndex,
    regionId: region.id,
    variantId: variant.id,
    layoutId,
    role,
  });
  const targetPath = safeResolveRootRelative(`${qa.directory}/${fileName}`);
  copyFileSync(sourcePath, targetPath);
  const cropRef = rootRelative(targetPath);
  qa.files.push({
    id: `scoreboard_ocr_${safeFilePart(role, "digit")}_digit_crop_${attemptIndex + 1}`,
    artifactType: "profile_digit_crop",
    role: sanitizeText(role, 16),
    timestamp: round(region.timestamp),
    regionId: sanitizeText(region.id || "scoreboard_region", 80),
    preprocessingVariant: sanitizeText(variant.id || "default", 60),
    layoutId: sanitizeText(layoutId, 80),
    sizeBytes: statSync(targetPath).size,
    relativePath: cropRef,
  });
  return cropRef;
}

function recordScoreboardOcrQaAttempt({
  qa,
  cropPath,
  scoreOnlyCropPath = null,
  profileDigitOcr = null,
  frame = {},
  frameIndex = 0,
  region = {},
  variant = {},
  ocr = {},
  scoreOnlyOcr = null,
  scoreOnlyScore = null,
  layoutProfile = null,
  scoreSource = null,
  reader = {},
  digitReading = null,
  calibrationDiagnostic = null,
} = {}) {
  if (!qa || !qa.enabled) return null;
  if (qa.attempts.length >= MAX_SCOREBOARD_OCR_QA_ATTEMPTS) return null;
  const attemptIndex = qa.attempts.length;
  let cropRef = null;
  let sizeBytes = 0;
  if (cropPath && existsSync(cropPath)) {
    const cropStat = statSync(cropPath);
    if (cropStat.isFile() && cropStat.size <= MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES) {
      const fileName = qaCropFileName({
        attemptIndex,
        frameIndex,
        regionId: region.id,
        variantId: variant.id,
      });
      const targetPath = safeResolveRootRelative(`${qa.directory}/${fileName}`);
      copyFileSync(cropPath, targetPath);
      cropRef = rootRelative(targetPath);
      sizeBytes = statSync(targetPath).size;
      qa.files.push({
        id: `scoreboard_ocr_crop_${attemptIndex + 1}`,
        timestamp: round(frame.timestamp),
        regionId: sanitizeText(region.id || "scoreboard_region", 80),
        preprocessingVariant: sanitizeText(variant.id || "default", 60),
        width: Math.max(1, Math.round(Number(region.width || 0))),
        height: Math.max(1, Math.round(Number(region.height || 0))),
        sizeBytes,
        relativePath: cropRef,
      });
    }
  }
  let scoreOnlyCropRef = null;
  if (scoreOnlyCropPath && existsSync(scoreOnlyCropPath)) {
    const cropStat = statSync(scoreOnlyCropPath);
    if (cropStat.isFile() && cropStat.size <= MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES) {
      const layoutId = layoutProfile && layoutProfile.layoutId ? layoutProfile.layoutId : "score-only";
      const fileName = qaScoreOnlyCropFileName({
        attemptIndex,
        frameIndex,
        regionId: region.id,
        variantId: variant.id,
        layoutId,
      });
      const targetPath = safeResolveRootRelative(`${qa.directory}/${fileName}`);
      copyFileSync(scoreOnlyCropPath, targetPath);
      scoreOnlyCropRef = rootRelative(targetPath);
      qa.files.push({
        id: `scoreboard_ocr_score_only_crop_${attemptIndex + 1}`,
        artifactType: "score_only_crop",
        timestamp: round(frame.timestamp),
        regionId: sanitizeText(region.id || "scoreboard_region", 80),
        preprocessingVariant: sanitizeText(variant.id || "default", 60),
        layoutId: sanitizeText(layoutId, 80),
        sizeBytes: statSync(targetPath).size,
        relativePath: scoreOnlyCropRef,
      });
    }
  }
  const safeDiagnostic = calibrationDiagnostic ? safeScorebugAttemptDiagnostic(calibrationDiagnostic) : null;
  const digitOcr = safeProfileDigitOcrSummary(profileDigitOcr);
  const homeDigitCropRef = digitOcr && digitOcr.homeDigitCropPath
    ? copyQaProfileDigitCrop({ qa, sourcePath: digitOcr.homeDigitCropPath, attemptIndex, frameIndex, region: { ...region, timestamp: frame.timestamp }, variant, layoutProfile, role: "home" })
    : null;
  const awayDigitCropRef = digitOcr && digitOcr.awayDigitCropPath
    ? copyQaProfileDigitCrop({ qa, sourcePath: digitOcr.awayDigitCropPath, attemptIndex, frameIndex, region: { ...region, timestamp: frame.timestamp }, variant, layoutProfile, role: "away" })
    : null;
  const row = {
    index: attemptIndex + 1,
    timestamp: round(frame.timestamp),
    regionId: sanitizeText(region.id || "scoreboard_region", 80),
    preprocessingVariant: sanitizeText(variant.id || "default", 60),
    layoutId: layoutProfile && layoutProfile.layoutId ? sanitizeText(layoutProfile.layoutId, 80) : null,
    selectedProfile: safeDiagnostic && safeDiagnostic.selectedProfile,
    status: sanitizeText(reader.status || "unreadable", 40),
    score: reader.scoreText || null,
    clock: reader.clock || null,
    confidence: round(ocr.confidence || reader.confidence || 0),
    scoreSource: scoreSource ? sanitizeText(scoreSource, 80) : null,
    scoreOnlyScore: scoreOnlyScore && Number.isInteger(scoreOnlyScore.home) && Number.isInteger(scoreOnlyScore.away)
      ? `${scoreOnlyScore.home}-${scoreOnlyScore.away}`
      : null,
    scoreOnlyOcrText: scoreOnlyOcr ? safeOcrTextPreview(scoreOnlyOcr.text) : "",
    scoreOnlyCropRef,
    homeDigitCropRef,
    awayDigitCropRef,
    homeDigitOcrText: digitOcr ? digitOcr.homeOcrText : "",
    awayDigitOcrText: digitOcr ? digitOcr.awayOcrText : "",
    profileDigitOcrStatus: digitOcr ? digitOcr.status : null,
    profileDigitOcrReasons: digitOcr ? digitOcr.reasons : [],
    finalScoreCandidate: safeDiagnostic && safeDiagnostic.finalScoreCandidate,
    transitionDecision: safeDiagnostic ? safeDiagnostic.transitionDecision : null,
    calibrationConfidence: safeDiagnostic ? safeDiagnostic.confidence : 0,
    rejectedReasonCodes: safeDiagnostic ? safeDiagnostic.rejectedReasonCodes : [],
    calibrationReasonCodes: safeDiagnostic ? safeDiagnostic.reasonCodes : [],
    digitBoxesFound: safeDiagnostic ? safeDiagnostic.digitBoxesFound : 0,
    homeCandidateGroups: safeDiagnostic ? safeDiagnostic.homeCandidateGroups : 0,
    awayCandidateGroups: safeDiagnostic ? safeDiagnostic.awayCandidateGroups : 0,
    foregroundGroupCount: safeDiagnostic ? safeDiagnostic.foregroundGroupCount : 0,
    ...digitReaderSummary(digitReading || {}),
    ambiguityReasons: Array.isArray(reader.ambiguityReasons)
      ? reader.ambiguityReasons.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 6)
      : [],
    ocrText: safeOcrTextPreview(ocr.text),
    cropRef,
  };
  qa.attempts.push(row);
  qa.contactSheetRows.push(row);
  return row;
}

function safeScoreboardOcrQaReport(report = {}) {
  const serialized = JSON.stringify(report || {});
  if (/\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i.test(serialized)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return report;
}

function writeScoreboardOcrReviewHtml({ qa, reportRelativePath, contactSheetRelativePath, status = "completed" } = {}) {
  if (!qa || !qa.enabled) return null;
  const reviewRelativePath = `${qa.directory}/review.html`;
  const rows = qa.contactSheetRows.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS).map((row) => `
      <tr>
        <td>${escapeHtml(row.index)}</td>
        <td>${escapeHtml(row.timestamp)}</td>
        <td>${escapeHtml(row.regionId)}</td>
        <td>${escapeHtml(row.preprocessingVariant)}</td>
        <td>${escapeHtml(row.layoutId || "")}</td>
        <td>${escapeHtml(row.selectedProfile || "")}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.score || "")}</td>
        <td>${escapeHtml(row.scoreSource || "")}</td>
        <td>${escapeHtml(row.scoreOnlyScore || "")}</td>
        <td>${escapeHtml(row.finalScoreCandidate || "")}</td>
        <td>${escapeHtml(row.transitionDecision || "")}</td>
        <td>${escapeHtml(row.clock || "")}</td>
        <td>${escapeHtml(row.confidence)}</td>
        <td>${escapeHtml(row.digitReaderStatus || "")}</td>
        <td>${escapeHtml(row.digitBoxCount || 0)}</td>
        <td>${escapeHtml(row.homeCandidateGroups || 0)}</td>
        <td>${escapeHtml(row.awayCandidateGroups || 0)}</td>
        <td>${escapeHtml(row.scoreConfidence || 0)}</td>
        <td>${escapeHtml(row.imageDecoderStatus || "")}</td>
        <td>${escapeHtml(row.imageDecoderMode || "")}</td>
        <td>${escapeHtml(row.imageSegmentationStatus || "")}</td>
        <td>${escapeHtml(row.imageSegmentationGroups || 0)}</td>
        <td>${escapeHtml((row.imageSegmentationReasons || []).join(", "))}</td>
        <td>${escapeHtml((row.rejectedReasonCodes || []).join(", "))}</td>
        <td>${escapeHtml((row.calibrationReasonCodes || []).join(", "))}</td>
        <td>${escapeHtml((row.digitReaderReasons || []).join(", "))}</td>
        <td>${escapeHtml((row.ambiguityReasons || []).join(", "))}</td>
        <td>${escapeHtml(row.ocrText || "")}</td>
        <td>${escapeHtml(row.scoreOnlyOcrText || "")}</td>
        <td>${escapeHtml(row.profileDigitOcrStatus || "")}</td>
        <td>${escapeHtml(row.homeDigitOcrText || "")}</td>
        <td>${escapeHtml(row.awayDigitOcrText || "")}</td>
        <td>${escapeHtml((row.profileDigitOcrReasons || []).join(", "))}</td>
        <td>${row.cropRef ? `<img alt="crop ${escapeHtml(row.index)}" src="${escapeHtml(relative(qa.directory, row.cropRef).replace(/\\/g, "/"))}">` : ""}</td>
        <td>${row.scoreOnlyCropRef ? `<img alt="score-only ${escapeHtml(row.index)}" src="${escapeHtml(relative(qa.directory, row.scoreOnlyCropRef).replace(/\\/g, "/"))}">` : ""}</td>
        <td>${row.homeDigitCropRef ? `<img alt="home digit ${escapeHtml(row.index)}" src="${escapeHtml(relative(qa.directory, row.homeDigitCropRef).replace(/\\/g, "/"))}">` : ""}</td>
        <td>${row.awayDigitCropRef ? `<img alt="away digit ${escapeHtml(row.index)}" src="${escapeHtml(relative(qa.directory, row.awayDigitCropRef).replace(/\\/g, "/"))}">` : ""}</td>
      </tr>`).join("");
  const html = safeScoreboardOcrQaReport(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scoreboard OCR QA Review</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #151515; background: #f7f7f4; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #d8d8d2; padding: 6px; font-size: 12px; vertical-align: top; }
    th { background: #ecece4; text-align: left; position: sticky; top: 0; }
    img { max-width: 280px; max-height: 90px; object-fit: contain; display: block; }
    code { background: #ecece4; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Scoreboard OCR QA Review</h1>
  <p>Status: <code>${escapeHtml(status)}</code> | Run: <code>${escapeHtml(qa.runId)}</code></p>
  <p>JSON report: <code>${escapeHtml(reportRelativePath)}</code> | Contact sheet: <code>${escapeHtml(contactSheetRelativePath)}</code></p>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Time</th><th>Region</th><th>Variant</th><th>Layout</th><th>Profile</th><th>Status</th><th>Score</th><th>Score Source</th><th>Score-Only Score</th><th>Final Candidate</th><th>Transition Decision</th><th>Clock</th><th>Conf</th><th>Digit Status</th><th>Digit Boxes</th><th>Home Groups</th><th>Away Groups</th><th>Score Conf</th><th>Decoder</th><th>Mode</th><th>Image Seg</th><th>Groups</th><th>Image Reasons</th><th>Rejected</th><th>Calibration Reasons</th><th>Digit Reasons</th><th>Reasons</th><th>OCR Text</th><th>Score-Only OCR</th><th>Profile Digit OCR</th><th>Home OCR</th><th>Away OCR</th><th>Profile OCR Reasons</th><th>Crop</th><th>Score-Only Crop</th><th>Home Digit Crop</th><th>Away Digit Crop</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`);
  writeFileSync(safeResolveRootRelative(reviewRelativePath), html, "utf8");
  return reviewRelativePath;
}

function writeScoreboardOcrQaReport({ qa, scoreboardOcr, status = "completed" } = {}) {
  if (!qa || !qa.enabled) return null;
  const generatedAt = new Date().toISOString();
  const contactSheetRelativePath = `${qa.directory}/contact-sheet.json`;
  const reportRelativePath = `demo/results/ocr-scoreboard-qa-${generatedAt.replace(/[:.]/g, "-")}.json`;
  const latestRelativePath = SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH;
  const cleanup = cleanupScoreboardOcrQaArtifacts({
    currentRunId: qa.runId,
    retentionMax: qaRetentionMax(CONFIG.scoreboardOcr.qaArtifactRetention),
  });
  const digitReader = summarizeDigitReaderRows(qa.contactSheetRows);
  const layoutSummary = qa.contactSheetRows.reduce((acc, row) => {
    const layoutId = sanitizeText(row.layoutId || "none", 80);
    acc[layoutId] = (acc[layoutId] || 0) + 1;
    return acc;
  }, {});
  const contactSheet = safeScoreboardOcrQaReport({
    schemaVersion: 1,
    kind: "scoreboard-ocr-contact-sheet",
    generatedAt,
    runId: qa.runId,
    rowCount: qa.contactSheetRows.length,
    rows: qa.contactSheetRows.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    relativeRefsOnly: true,
  });
  writeFileSync(safeResolveRootRelative(contactSheetRelativePath), `${JSON.stringify(contactSheet, null, 2)}\n`, "utf8");
  const reviewRelativePath = writeScoreboardOcrReviewHtml({
    qa,
    reportRelativePath,
    contactSheetRelativePath,
    status,
  });
  const report = safeScoreboardOcrQaReport({
    schemaVersion: 1,
    kind: "scoreboard-ocr-qa-report",
    generatedAt,
    status: sanitizeText(status, 40),
    runId: qa.runId,
    directory: qa.directory,
    contactSheet: {
      relativePath: contactSheetRelativePath,
      rowCount: contactSheet.rowCount,
    },
    review: reviewRelativePath
      ? {
          relativePath: reviewRelativePath,
          rowCount: contactSheet.rowCount,
        }
      : null,
    cropArtifacts: {
      enabled: true,
      cropCount: qa.files.length,
      maxCropCount: MAX_SCOREBOARD_OCR_QA_ATTEMPTS,
      maxArtifactBytes: MAX_SCOREBOARD_OCR_QA_ARTIFACT_BYTES,
      files: qa.files.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    },
    ocrAttempts: qa.attempts.slice(0, MAX_SCOREBOARD_OCR_QA_ATTEMPTS),
    digitReader,
    layoutSummary,
    scoreOnlyExtraction: {
      cropCount: digitReader.scoreOnlyCropCount,
      readableCount: digitReader.scoreOnlyReadableCount,
      layoutIds: digitReader.layoutIds,
      transitionDecisions: digitReader.transitionDecisions,
    },
    calibrationUsed: qa.digitCalibrationSummary || null,
    evidenceSummary: scoreboardOcr && scoreboardOcr.summary
      ? {
          evidenceCount: Number(scoreboardOcr.summary.evidenceCount || 0),
          scoreChangeCount: Number(scoreboardOcr.summary.scoreChangeCount || 0),
          scoreChangeEvents: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.filter((item) => item.status === "score_changed").slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          roiCalibration: normalizeRoiCalibrationSummary(scoreboardOcr.summary.roiCalibration),
          scorebugDebug: normalizeScorebugDebugSummary(scoreboardOcr.summary.scorebugDebug),
          revertedScoreEvents: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.filter((item) => item.status === "goal_removed").slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          ambiguousCount: Number(scoreboardOcr.summary.ambiguousCount || 0),
          unreadableCount: Number(scoreboardOcr.summary.unreadableCount || 0),
          scoreTimeline: Array.isArray(scoreboardOcr.summary.scoreTimeline)
            ? scoreboardOcr.summary.scoreTimeline.slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
        }
      : null,
    cleanup,
    relativeRefsOnly: true,
    logsDownloaded: false,
    artifactsDownloaded: false,
  });
  const reportPath = safeResolveRootRelative(reportRelativePath);
  const latestPath = safeResolveRootRelative(latestRelativePath);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    enabled: true,
    runId: qa.runId,
    reportPath: reportRelativePath,
    latestPath: latestRelativePath,
    contactSheetPath: contactSheetRelativePath,
    reviewPath: reviewRelativePath,
    cropCount: qa.files.length,
    attemptCount: qa.attempts.length,
    status: report.status,
  };
}

function ocrCropOutputDir(input = {}) {
  if (input.ocrOutputDir) return assertStoragePath(input.ocrOutputDir, "staging");
  return storagePath("staging", join("scoreboard-ocr", `ocr_${randomUUID()}`));
}

function assertOcrFrame(frame = {}) {
  const timestamp = frameTimestamp(frame);
  if (!Number.isFinite(timestamp)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (!frame.localPath) return null;
  const localPath = assertStoragePath(frame.localPath, "staging");
  if (!existsSync(localPath)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return {
    ...frame,
    localPath,
    timestamp,
  };
}

function assertProcessingInputPath(inputPath) {
  try {
    return assertStoragePath(inputPath, "uploads");
  } catch {
    return assertStoragePath(inputPath, "staging");
  }
}

function ocrFramePath(outputDir, index) {
  return safeResolve(outputDir, `ocr_frame_${String(index + 1).padStart(2, "0")}.jpg`);
}

async function extractOcrFramesFromSource({
  inputPath,
  outputDir,
  metadata = {},
  frames = [],
  visualSignals = {},
  candidateWindows = [],
  mediaSignals = {},
  ocrSamplingWindows = [],
  ffmpegRunner = runFfmpeg,
  signal = null,
} = {}) {
  if (!inputPath || !existsSync(inputPath)) return [];
  if (ffmpegRunner === runFfmpeg && !commandAvailable(CONFIG.ffmpegBin)) return [];
  const safeInputPath = assertProcessingInputPath(inputPath);
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  const windows = selectOcrSamplingWindows({ frames, visualSignals, candidateWindows, mediaSignals, metadata, ocrSamplingWindows });
  if (!windows.length) return [];
  mkdirSync(safeOutputDir, { recursive: true });
  const dimensions = scaledOcrFrameDimensions(metadata);
  const extracted = [];
  for (const [index, window] of windows.entries()) {
    if (signal && signal.aborted) throw cancellationError();
    const localPath = ocrFramePath(safeOutputDir, index);
    await ffmpegRunner([
      "-y",
      "-ss",
      String(window.timestamp),
      "-i",
      safeInputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${dimensions.width}:${dimensions.height}`,
      "-q:v",
      "3",
      localPath,
    ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 30000) });
    if (!existsSync(localPath)) continue;
    extracted.push({
      id: `ocr_frame_${index + 1}`,
      timestamp: window.timestamp,
      windowStart: window.start,
      windowEnd: window.end,
      width: dimensions.width,
      height: dimensions.height,
      localPath,
      purpose: "scoreboard_ocr",
      source: window.source,
      visualHints: window.visualHints,
    });
  }
  return extracted.slice(0, MAX_SCOREBOARD_OCR_FRAMES);
}

function cropPathForRegion(outputDir, frameIndex, region) {
  const name = `crop_${String(frameIndex + 1).padStart(2, "0")}_${safeFilePart(region.id, "region")}.png`;
  return safeResolve(outputDir, name);
}

function scoreOnlyCropPathForRegion(outputDir, frameIndex, region, variant, layoutId) {
  const name = `score_only_${String(frameIndex + 1).padStart(2, "0")}_${safeFilePart(region.id, "region")}_${safeFilePart(variant && variant.id, "variant")}_${safeFilePart(layoutId, "layout")}.png`;
  return safeResolve(outputDir, name);
}

function profileDigitCropPathForRegion(outputDir, frameIndex, region, variant, layoutId, role) {
  const name = `profile_digit_${safeFilePart(role, "digit")}_${String(frameIndex + 1).padStart(2, "0")}_${safeFilePart(region.id, "region")}_${safeFilePart(variant && variant.id, "variant")}_${safeFilePart(layoutId, "layout")}.png`;
  return safeResolve(outputDir, name);
}

function cropFilterForRatioRoi(roi = {}) {
  const safe = normalizeRatioRoi(roi);
  if (!safe) return null;
  return `crop=iw*${safe.width}:ih*${safe.height}:iw*${safe.x}:ih*${safe.y}`;
}

function scoreboardOcrPreprocessVariants() {
  return OCR_PREPROCESS_VARIANTS.map((variant) => ({
    id: sanitizeText(variant.id, 48),
    psm: sanitizeText(variant.psm || "7", 4),
    whitelist: sanitizeText(variant.whitelist || "", 120),
    filter: sanitizeText(variant.filter, 180),
  }));
}

function scorebugFirstPreprocessVariants() {
  const preferred = new Set(["contrast_block"]);
  return scoreboardOcrPreprocessVariants().filter((variant) => preferred.has(variant.id));
}

function safeScorebugFirstRegionIds(regionIds = []) {
  const requested = Array.isArray(regionIds) ? regionIds : [];
  const safeIds = requested
    .map((id) => sanitizeText(id, 80))
    .filter((id) => SCOREBUG_FIRST_REGION_IDS.includes(id));
  return [...new Set(safeIds)].slice(0, MAX_SCOREBOARD_REGIONS);
}

function scorebugFirstRegions(regions = [], preferredRegionIds = []) {
  const byId = new Map((Array.isArray(regions) ? regions : []).map((region) => [region.id, region]));
  const ids = safeScorebugFirstRegionIds(preferredRegionIds);
  return (ids.length ? ids : SCOREBUG_FIRST_FAST_REGION_IDS)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, MAX_SCOREBOARD_REGIONS);
}

async function cropScoreboardRegion({
  frame,
  region,
  outputDir,
  frameIndex = 0,
  variant = null,
  ffmpegRunner = runFfmpeg,
  signal = null,
  timeoutMs = CONFIG.analysisTimeoutMs,
} = {}) {
  const safeFrame = assertOcrFrame(frame);
  if (!safeFrame || !safeFrame.localPath) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  mkdirSync(safeOutputDir, { recursive: true });
  const cropPath = cropPathForRegion(safeOutputDir, frameIndex, region);
  await ffmpegRunner([
    "-y",
    "-i",
    safeFrame.localPath,
    "-vf",
    [`crop=${region.width}:${region.height}:${region.x}:${region.y}`, variant && variant.filter].filter(Boolean).join(","),
    "-frames:v",
    "1",
    cropPath,
  ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 20000, Math.max(250, Number(timeoutMs) || CONFIG.analysisTimeoutMs)) });
  if (!existsSync(cropPath)) {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  return cropPath;
}

async function cropScoreOnlyRegion({
  cropPath,
  outputDir,
  frameIndex = 0,
  region = {},
  variant = null,
  profile = null,
  ffmpegRunner = runFfmpeg,
  signal = null,
  timeoutMs = CONFIG.analysisTimeoutMs,
} = {}) {
  const safeProfile = safeScorebugLayoutProfile(profile);
  if (!safeProfile || !cropPath) return null;
  const safeCropPath = assertStoragePath(cropPath, "staging");
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  mkdirSync(safeOutputDir, { recursive: true });
  const scoreOnlyPath = scoreOnlyCropPathForRegion(safeOutputDir, frameIndex, region, variant, safeProfile.layoutId);
  const cropFilter = cropFilterForRatioRoi(safeProfile.scoreOnlyRoi);
  if (!cropFilter) return null;
  await ffmpegRunner([
    "-y",
    "-i",
    safeCropPath,
    "-vf",
    `${cropFilter},scale=iw*3:ih*3`,
    "-frames:v",
    "1",
    scoreOnlyPath,
  ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 12000, Math.max(250, Number(timeoutMs) || CONFIG.analysisTimeoutMs)) });
  if (!existsSync(scoreOnlyPath)) return null;
  return {
    cropPath: assertStoragePath(scoreOnlyPath, "staging"),
    layoutId: safeProfile.layoutId,
    scoreOnlyRoi: safeProfile.scoreOnlyRoi,
    digitCalibration: scorebugProfileDigitCalibration(safeProfile),
  };
}

async function cropProfileDigitRegion({
  cropPath,
  outputDir,
  frameIndex = 0,
  region = {},
  variant = null,
  profile = null,
  role = "home",
  ffmpegRunner = runFfmpeg,
  signal = null,
  timeoutMs = CONFIG.analysisTimeoutMs,
} = {}) {
  const safeProfile = safeScorebugLayoutProfile(profile);
  const roi = role === "away" ? safeProfile && safeProfile.fullAwayDigitRoi : safeProfile && safeProfile.fullHomeDigitRoi;
  if (!safeProfile || !roi || !cropPath) return null;
  const safeCropPath = assertStoragePath(cropPath, "staging");
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  mkdirSync(safeOutputDir, { recursive: true });
  const outputPath = profileDigitCropPathForRegion(safeOutputDir, frameIndex, region, variant, safeProfile.layoutId, role);
  const cropFilter = cropFilterForRatioRoi(roi);
  if (!cropFilter) return null;
  await ffmpegRunner([
    "-y",
    "-i",
    safeCropPath,
    "-vf",
    `${cropFilter},scale=iw*4:ih*4`,
    "-frames:v",
    "1",
    outputPath,
  ], { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 12000, Math.max(250, Number(timeoutMs) || CONFIG.analysisTimeoutMs)) });
  return existsSync(outputPath)
    ? {
        cropPath: assertStoragePath(outputPath, "staging"),
        roi,
      }
    : null;
}

async function readProfileDigitOcr({
  cropPath,
  outputDir,
  frameIndex = 0,
  region = {},
  variant = null,
  profile = null,
  ocrAdapter,
  ffmpegRunner = runFfmpeg,
  timeoutMs = DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS,
  signal = null,
} = {}) {
  const safeProfile = safeScorebugLayoutProfile(profile);
  if (!safeProfile || !ocrAdapter || typeof ocrAdapter.readTextFromImage !== "function") return null;
  const emptyResult = (overrides = {}) => ({
    status: "unreadable",
    score: null,
    confidence: 0,
    reasons: ["profile_digit_ocr_unreadable"],
    homeDigitCropPath: null,
    awayDigitCropPath: null,
    homeOcrText: "",
    awayOcrText: "",
    homeDigitConfidence: 0,
    awayDigitConfidence: 0,
    ...overrides,
  });
  try {
    const homeCrop = await cropProfileDigitRegion({
      cropPath,
      outputDir,
      frameIndex,
      region,
      variant,
      profile: safeProfile,
      role: "home",
      ffmpegRunner,
      signal,
      timeoutMs,
    });
    const awayCrop = await cropProfileDigitRegion({
      cropPath,
      outputDir,
      frameIndex,
      region,
      variant,
      profile: safeProfile,
      role: "away",
      ffmpegRunner,
      signal,
      timeoutMs,
    });
    if (!homeCrop || !awayCrop) {
      return emptyResult({
        reasons: ["profile_digit_crop_missing"],
        homeDigitCropPath: homeCrop && homeCrop.cropPath,
        awayDigitCropPath: awayCrop && awayCrop.cropPath,
      });
    }
    const readDigit = async (digitCrop) => raceWithTimeout(ocrAdapter.readTextFromImage({
      imagePath: digitCrop.cropPath,
      psm: "10",
      whitelist: "0123456789OI",
      signal,
      timeoutMs: Math.min(timeoutMs, 5000),
    }), { signal, timeoutMs: Math.min(timeoutMs, 5000) });
    const [homeOcr, awayOcr] = await Promise.all([readDigit(homeCrop), readDigit(awayCrop)]);
    const parsed = parseScorebugDigitGroups(`${homeOcr && homeOcr.text || ""} ${awayOcr && awayOcr.text || ""}`);
    const homeDigitConfidence = round(clamp(homeOcr && homeOcr.confidence, 0, 1));
    const awayDigitConfidence = round(clamp(awayOcr && awayOcr.confidence, 0, 1));
    if (!parsed.score) {
      return emptyResult({
        reasons: parsed.reasonCodes,
        homeDigitCropPath: homeCrop.cropPath,
        awayDigitCropPath: awayCrop.cropPath,
        homeOcrText: homeOcr && homeOcr.text,
        awayOcrText: awayOcr && awayOcr.text,
        homeDigitConfidence,
        awayDigitConfidence,
      });
    }
    const confidence = round(Math.max(0.74, Math.min(Number(homeOcr.confidence || 0.74), Number(awayOcr.confidence || 0.74))));
    return {
      status: "readable",
      score: parsed.score,
      confidence,
      reasons: ["profile_digit_ocr_used"],
      homeDigitCropPath: homeCrop.cropPath,
      awayDigitCropPath: awayCrop.cropPath,
      homeOcrText: homeOcr && homeOcr.text,
      awayOcrText: awayOcr && awayOcr.text,
      homeDigitConfidence,
      awayDigitConfidence,
      digitBoxes: [
        { role: "home", digit: String(parsed.score.home), confidence, ...homeCrop.roi },
        { role: "away", digit: String(parsed.score.away), confidence, ...awayCrop.roi },
      ],
    };
  } catch {
    return emptyResult({ reasons: ["profile_digit_ocr_failed_closed"] });
  }
}

function shouldRunProfileDigitOcrFallback({
  scorebugFirstOnly = false,
  layoutProfile = null,
  digitReading = null,
  scoreOnlyOcr = null,
} = {}) {
  if (!layoutProfile || !digitReading || digitReading.status === "readable") return false;
  if (!scorebugFirstOnly) return true;
  const scoreOnlyText = sanitizeText(scoreOnlyOcr && scoreOnlyOcr.text || "", 80);
  const digitLikeCount = (scoreOnlyText.match(/[0-9OI]/g) || []).length;
  const foregroundGroupCount = Number(
    digitReading &&
      digitReading.imageSegmentation &&
      digitReading.imageSegmentation.foregroundGroupCount || 0,
  );
  return digitLikeCount > 0 || foregroundGroupCount >= 2;
}

function cleanupOcrCrops(outputDir) {
  if (!outputDir) return { cleaned: false };
  const safeOutputDir = assertStoragePath(outputDir, "staging");
  if (!basename(safeOutputDir).startsWith("ocr_")) return { cleaned: false };
  try {
    rmSync(safeOutputDir, { recursive: true, force: true });
    return { cleaned: true };
  } catch {
    return { cleaned: false };
  }
}

class LocalScoreboardOcrProviderAdapter extends DeterministicScoreboardOcrProvider {
  constructor({
    enabled = CONFIG.scoreboardOcr.enabled,
    bin = CONFIG.scoreboardOcr.bin,
    timeoutMs = CONFIG.scoreboardOcr.timeoutMs,
    ocrAdapter = null,
    ocrRunner = null,
    commandChecker = null,
    cropper = null,
    ffmpegRunner = null,
    digitReader = null,
    digitCalibration = null,
  } = {}) {
    super();
    this.enabled = Boolean(enabled);
    this.timeoutMs = Math.max(250, Math.min(60000, Number(timeoutMs) || DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS));
    this.ocrAdapter = ocrAdapter || new LocalOcrCommandAdapter({
      bin,
      enabled: this.enabled,
      timeoutMs: this.timeoutMs,
      runner: ocrRunner,
      commandChecker,
    });
    this.cropperInjected = Boolean(cropper);
    this.cropper = cropper || cropScoreboardRegion;
    this.ffmpegRunner = ffmpegRunner || runFfmpeg;
    this.digitReader = digitReader || readScorebugDigitsAsync;
    this.digitCalibration = digitCalibration;
  }

  health() {
    const adapterHealth = this.ocrAdapter.health();
    return {
      ...super.health(),
      status: adapterHealth.status,
      providerMode: adapterHealth.providerMode,
      realOcrEnabled: this.enabled,
      localOcrEnabled: this.enabled,
      runtimeAvailable: Boolean(adapterHealth.runtimeAvailable),
      fallbackAvailable: true,
      networkRequired: false,
      commandConfigured: Boolean(adapterHealth.commandConfigured),
      capabilities: [
        "scoreboard_region_sampling",
        "full_source_periodic_sampling",
        "ocr_preprocessing_variants",
        "broadcast_scorebug_layout_profiles",
        "score_only_crop_extraction",
        "scorebug_digit_calibration_diagnostics",
        "focused_scorebug_digit_reader",
        "local_command_ocr",
        "safe_empty_fallback",
      ],
    };
  }

  async analyzeScoreboardOcr(input = {}) {
    if (input.signal && input.signal.aborted) throw cancellationError();
    if (!this.enabled || !this.ocrAdapter.runtimeAvailable()) return deterministicFallback(input);
    if (!this.cropperInjected && this.ffmpegRunner === runFfmpeg && !commandAvailable(CONFIG.ffmpegBin)) return deterministicFallback(input);

    const metadata = input.metadata || {};
    const scorebugFirstOnly = Boolean(input.scorebugFirstOnly);
    const scorebugFirstRegionIds = scorebugFirstOnly ? safeScorebugFirstRegionIds(input.scorebugFirstRegionIds) : [];
    const outputDir = ocrCropOutputDir(input);
    const qa = createScoreboardOcrQaContext(input);
    const digitCalibration = validateScorebugCalibration(input.digitCalibration || input.scorebugDigitCalibration || this.digitCalibration);
    qa.digitCalibrationSummary = calibrationSummary(digitCalibration);
    let frames = [];
    try {
      frames = await extractOcrFramesFromSource({
        ...input,
        outputDir,
        ffmpegRunner: this.ffmpegRunner,
      });
      if (!frames.length) {
        frames = selectOcrFrames(input);
      }
      frames = frames
        .map((frame) => assertOcrFrame(frame))
        .filter((frame) => frame && frame.localPath)
        .slice(0, MAX_SCOREBOARD_OCR_FRAMES);
    } catch {
      return deterministicFallback(input);
    }
    if (!frames.length) return deterministicFallback(input);

    const observations = [];
    let cropCount = 0;
    let previousDiagnosticScore = null;
    const regionIdsUsed = new Set();
    const variants = scoreboardOcrPreprocessVariants();
    const activeVariants = scorebugFirstOnly ? scorebugFirstPreprocessVariants() : variants;
    const ocrTimeoutMs = scorebugFirstOnly
      ? Math.max(250, Math.min(this.timeoutMs, 3500, Number(input.timeoutMs || this.timeoutMs)))
      : this.timeoutMs;
    try {
      const regionsByFrame = frames.map((frame) => {
        const regions = regionHintsForFrame(frame, metadata).slice(0, MAX_SCOREBOARD_REGIONS);
        return scorebugFirstOnly ? scorebugFirstRegions(regions, scorebugFirstRegionIds) : regions;
      });
      const frameScoreFound = new Set();
      for (const variant of activeVariants) {
        for (let regionIndex = 0; regionIndex < MAX_SCOREBOARD_REGIONS; regionIndex += 1) {
          for (const [frameIndex, frame] of frames.entries()) {
            if (frameScoreFound.has(frameIndex)) continue;
            if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
            const region = regionsByFrame[frameIndex] && regionsByFrame[frameIndex][regionIndex];
            if (!region) continue;
            regionIdsUsed.add(region.id);
            if (input.signal && input.signal.aborted) throw cancellationError();
            const cropPath = await this.cropper({
              frame,
              region,
              outputDir,
              frameIndex,
              variant,
              ffmpegRunner: this.ffmpegRunner,
              signal: input.signal,
              timeoutMs: Math.min(ocrTimeoutMs, scorebugFirstOnly ? 1800 : CONFIG.analysisTimeoutMs),
            });
            const safeCropPath = assertStoragePath(cropPath, "staging");
            const layoutProfile = selectScorebugLayoutProfile(region);
            let scoreOnlyCrop = null;
            let scoreOnlyOcr = null;
            let scoreOnlyScore = null;
            if (layoutProfile) {
              try {
                scoreOnlyCrop = await cropScoreOnlyRegion({
                  cropPath: safeCropPath,
                  outputDir,
                  frameIndex,
                  region,
                  variant,
                  profile: layoutProfile,
                  ffmpegRunner: this.ffmpegRunner,
                  signal: input.signal,
                  timeoutMs: Math.min(ocrTimeoutMs, scorebugFirstOnly ? 1800 : CONFIG.analysisTimeoutMs),
                });
              } catch {
                scoreOnlyCrop = null;
              }
            }
            if (scoreOnlyCrop && scoreOnlyCrop.cropPath) {
              try {
                scoreOnlyOcr = await raceWithTimeout(this.ocrAdapter.readTextFromImage({
                  imagePath: scoreOnlyCrop.cropPath,
                  psm: "7",
                  whitelist: "0123456789OI:-",
                  signal: input.signal,
                  timeoutMs: Math.min(ocrTimeoutMs, 3500),
                }), { signal: input.signal, timeoutMs: Math.min(ocrTimeoutMs, 3500) });
                scoreOnlyScore = scoreOnlyOcr.rejected ? null : parseScoreOnlyScore(scoreOnlyOcr.text);
              } catch {
                scoreOnlyOcr = { text: "", confidence: 0.05, rejected: true };
                scoreOnlyScore = null;
              }
            }
            const ocr = scorebugFirstOnly
              ? {
                  text: scoreOnlyScore ? scoreOnlyScore.text : "",
                  confidence: scoreOnlyScore ? scoreOnlyOcr && scoreOnlyOcr.confidence || 0.74 : 0.05,
                  rejected: !scoreOnlyScore,
                  skipped: true,
                  reason: scoreOnlyScore
                    ? "scorebug_first_structured_score_available"
                    : "scorebug_first_full_crop_ocr_skipped",
                }
              : await raceWithTimeout(this.ocrAdapter.readTextFromImage({
                  imagePath: safeCropPath,
                  psm: variant.psm,
                  whitelist: variant.whitelist,
                  signal: input.signal,
                  timeoutMs: ocrTimeoutMs,
                }), { signal: input.signal, timeoutMs: ocrTimeoutMs });
            const digitCropPath = scoreOnlyCrop && scoreOnlyCrop.cropPath ? scoreOnlyCrop.cropPath : safeCropPath;
            const digitCalibrationForCrop = scoreOnlyCrop && scoreOnlyCrop.digitCalibration
              ? scoreOnlyCrop.digitCalibration
              : digitCalibration;
            let digitReading = await Promise.resolve(this.digitReader({
              frame,
              crop: {
                timestamp: frame.timestamp,
                cropPath: digitCropPath,
                originalCropPath: safeCropPath,
                scoreOnlyCropPath: scoreOnlyCrop && scoreOnlyCrop.cropPath,
                layoutId: layoutProfile && layoutProfile.layoutId,
                decoderOutputDir: outputDir,
                ffmpegRunner: this.ffmpegRunner,
                decoderTimeoutMs: Math.min(ocrTimeoutMs, 3500),
              },
              regionId: region.id,
              timestamp: frame.timestamp,
              metadata,
              calibration: digitCalibrationForCrop,
              signal: input.signal,
            }));
            if (!scorebugFirstOnly && scoreOnlyCrop && digitReading.status !== "readable") {
              const fullCropDigitReading = await Promise.resolve(this.digitReader({
                frame,
                crop: {
                  timestamp: frame.timestamp,
                  cropPath: safeCropPath,
                  scoreOnlyCropPath: scoreOnlyCrop.cropPath,
                  layoutId: layoutProfile && layoutProfile.layoutId,
                  decoderOutputDir: outputDir,
                  ffmpegRunner: this.ffmpegRunner,
                  decoderTimeoutMs: Math.min(ocrTimeoutMs, 3500),
                },
                regionId: region.id,
                timestamp: frame.timestamp,
                metadata,
                calibration: layoutProfile
                  ? scorebugProfileFullCropDigitCalibration(layoutProfile, digitCalibration)
                  : digitCalibration,
                signal: input.signal,
              }));
              if (fullCropDigitReading.status === "readable") {
                digitReading = {
                  ...fullCropDigitReading,
                  reasons: [...(Array.isArray(fullCropDigitReading.reasons) ? fullCropDigitReading.reasons : []), "full_crop_digit_fallback_used"],
                };
              }
            }
            let profileDigitOcr = null;
            if (shouldRunProfileDigitOcrFallback({
              scorebugFirstOnly,
              layoutProfile,
              digitReading,
              scoreOnlyOcr,
            })) {
              profileDigitOcr = await readProfileDigitOcr({
                cropPath: safeCropPath,
                outputDir,
                frameIndex,
                region,
                variant,
                profile: layoutProfile,
                ocrAdapter: this.ocrAdapter,
                ffmpegRunner: this.ffmpegRunner,
                timeoutMs: ocrTimeoutMs,
                signal: input.signal,
              });
              if (profileDigitOcr && profileDigitOcr.status === "readable") {
                digitReading = {
                  ...digitReading,
                  status: "readable",
                  score: profileDigitOcr.score,
                  confidence: profileDigitOcr.confidence,
                  digitBoxes: profileDigitOcr.digitBoxes,
                  reasons: profileDigitOcr.reasons,
                  method: "profile-digit-ocr",
                };
              }
            }
            const digitSummary = digitReaderSummary(digitReading);
            const digitScore = digitReading.status === "readable" ? digitReading.score : null;
            const structuredScore = digitScore || scoreOnlyScore;
            const parsedScore = structuredScore ||
              (ocr.rejected
                ? null
                : scoreAllowedForRegion({
                    regionId: region.id,
                    text: ocr.text,
                    score: parseScoreboardScore(ocr.text),
                  }));
            const parsedClock = ocr.rejected ? null : parseClock(ocr.text);
            const scoreSource = digitScore
              ? digitReading.method === "profile-digit-ocr"
                ? `local_scorebug_profile_digit_ocr_${variant.id}`
                : `local_scorebug_digit_reader_${variant.id}`
              : scoreOnlyScore
                ? `local_scorebug_score_only_ocr_${variant.id}`
                : parsedScore
                  ? `local_scoreboard_ocr_${variant.id}`
                  : null;
            const scoreConfidence = digitScore
              ? digitReading.confidence
              : scoreOnlyScore
                ? Math.max(Number(scoreOnlyOcr && scoreOnlyOcr.confidence || 0), 0.74)
                : ocr.confidence;
            const scoreRejected = !parsedScore && Boolean(ocr.rejected);
            const calibrationDiagnostic = buildScorebugAttemptDiagnostic({
              layoutId: layoutProfile && layoutProfile.layoutId,
              regionId: region.id,
              score: structuredScore || parsedScore,
              scoreOnlyText: scoreOnlyOcr && scoreOnlyOcr.text,
              ocrText: ocr.text,
              clock: parsedClock,
              confidence: scoreConfidence,
              minConfidence: layoutProfile && layoutProfile.minConfidence,
              source: scoreSource,
              digitReading,
              previousScore: previousDiagnosticScore,
            });
            if (calibrationDiagnostic.accepted && (structuredScore || parsedScore)) {
              previousDiagnosticScore = structuredScore || parsedScore;
            }
            const reader = readScoreboardCandidate({
              id: `ocr_${frameIndex + 1}_${cropCount + 1}`,
              timestamp: frame.timestamp,
              start: frame.windowStart ?? frame.timestamp - 0.8,
              end: frame.windowEnd ?? frame.timestamp + 0.8,
              regionId: region.id,
              preprocessingVariant: variant.id,
              source: scoreSource || `local_scoreboard_ocr_${variant.id}`,
              text: ocr.text,
              score: parsedScore,
              clock: parsedClock,
              rejected: scoreRejected,
              confidence: scoreConfidence,
              layoutId: layoutProfile && layoutProfile.layoutId,
            });
            const qaRow = recordScoreboardOcrQaAttempt({
              qa,
              cropPath: safeCropPath,
              scoreOnlyCropPath: scoreOnlyCrop && scoreOnlyCrop.cropPath,
              frame,
              frameIndex,
              region,
              variant,
              ocr,
              scoreOnlyOcr,
              scoreOnlyScore,
              layoutProfile,
              scoreSource,
              reader,
              digitReading,
              profileDigitOcr,
              calibrationDiagnostic,
            });
            observations.push({
              id: `ocr_${frameIndex + 1}_${cropCount + 1}`,
              timestamp: frame.timestamp,
              start: frame.windowStart ?? frame.timestamp - 0.8,
              end: frame.windowEnd ?? frame.timestamp + 0.8,
              regionId: region.id,
              preprocessingVariant: variant.id,
              text: ocr.text,
              score: parsedScore,
              confidence: scoreConfidence,
              rejected: scoreRejected,
              source: scoreSource || `local_scoreboard_ocr_${variant.id}`,
              digitSignatures: digitReading && digitReading.imageSegmentation
                ? digitReading.imageSegmentation.digitSignatures || null
                : null,
              imageSegmentationStatus: digitSummary.imageSegmentationStatus,
              imageDecoderStatus: digitSummary.imageDecoderStatus,
              imageDecoderMode: digitSummary.imageDecoderMode,
              layoutId: layoutProfile && layoutProfile.layoutId,
              scoreOnlyCropRef: qaRow && qaRow.scoreOnlyCropRef,
            });
            cropCount += 1;
            if (parsedScore) {
              frameScoreFound.add(frameIndex);
            }
          }
          if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
        }
        if (cropCount >= MAX_SCOREBOARD_OCR_CROPS) break;
      }
      const digitTemplateRecovery = recoverScoresFromDigitTemplates(observations);
      const timeline = buildScoreboardTimelineFromObservations(digitTemplateRecovery.observations);
      const evidence = timeline.evidence;
      const result = validateScoreboardOcrOutput({
        providerMode: "local-scoreboard-ocr-command",
        fallbackUsed: evidence.length === 0,
        evidence,
        roiCalibration: timeline.roiCalibration,
        scorebugDebug: {
          ...timeline.scorebugDebug,
          digitTemplateRecovery: digitTemplateRecovery.summary,
          reasonCodes: [
            ...(Array.isArray(timeline.scorebugDebug && timeline.scorebugDebug.reasonCodes)
              ? timeline.scorebugDebug.reasonCodes
              : []),
            ...(digitTemplateRecovery.summary.applied ? ["scorebug_digit_template_recovery"] : []),
          ],
        },
        sampledFrameCount: frames.length,
        regionCount: cropCount,
        regionIdsUsed: [...regionIdsUsed],
        preprocessingVariantCount: activeVariants.length,
      }, metadata);
      const qaReport = writeScoreboardOcrQaReport({ qa, scoreboardOcr: result, status: "completed" });
      const validatedResult = qaReport
        ? validateScoreboardOcrOutput({
            providerMode: result.providerMode,
            fallbackUsed: result.fallbackUsed,
            evidence: result.evidence,
            roiCalibration: result.summary.roiCalibration,
            scorebugDebug: result.summary.scorebugDebug,
            sampledFrameCount: result.summary.sampledFrameCount,
            regionCount: result.summary.regionCount,
            regionIdsUsed: result.summary.regionIdsUsed,
            preprocessingVariantCount: result.summary.preprocessingVariantCount,
            qaReport,
          }, metadata)
        : result;
      return {
        ...validatedResult,
        _internalDigitObservations: internalDigitTemplateObservations(digitTemplateRecovery.observations),
      };
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      return deterministicFallback(input);
    } finally {
      cleanupOcrCrops(outputDir);
    }
  }
}

function createScoreboardOcrProvider(options = {}) {
  const { mode, client } = options;
  const safeMode = sanitizeText(mode || CONFIG.scoreboardOcr.provider || "", 80).toLowerCase();
  if (safeMode === "external" || safeMode === "external-scoreboard-ocr-adapter") {
    return new ExternalScoreboardOcrProviderAdapter({ client });
  }
  if (safeMode === "local" || safeMode === "local-scoreboard-ocr-command") {
    return new LocalScoreboardOcrProviderAdapter(options);
  }
  return new DeterministicScoreboardOcrProvider();
}

async function analyzeScoreboardOcr(input = {}) {
  const provider = input.provider || createScoreboardOcrProvider({
    ...input,
    mode: input.providerMode || input.mode,
    client: input.providerClient || input.client,
  });
  return provider.analyzeScoreboardOcr(input);
}

function publicScoreboardOcr(scoreboardOcr) {
  const safe = scoreboardOcr && typeof scoreboardOcr === "object" ? scoreboardOcr : {};
  const chunkSummary = normalizeScoreboardOcrChunkSummary(safe.chunkSummary || (safe.summary && safe.summary.chunkSummary));
  return {
    providerMode: sanitizeText(safe.providerMode || "deterministic-scoreboard-ocr", 60),
    fallbackUsed: Boolean(safe.fallbackUsed),
    confidence: round(clamp(safe.confidence, 0, 1)),
    summary: safe.summary && typeof safe.summary === "object"
      ? {
          evidenceCount: Number(safe.summary.evidenceCount || 0),
          scoreChangeCount: Number(safe.summary.scoreChangeCount || 0),
          scoreUnchangedCount: Number(safe.summary.scoreUnchangedCount || 0),
          scoreRevertedCount: Number(safe.summary.scoreRevertedCount || 0),
          ambiguousCount: Number(safe.summary.ambiguousCount || 0),
          clockOnlyCount: Number(safe.summary.clockOnlyCount || 0),
          unreadableCount: Number(safe.summary.unreadableCount || 0),
          sampledFrameCount: Number(safe.summary.sampledFrameCount || 0),
          regionCount: Number(safe.summary.regionCount || 0),
          regionIdsUsed: Array.isArray(safe.summary.regionIdsUsed)
            ? safe.summary.regionIdsUsed.map((id) => sanitizeText(id, 64)).filter(Boolean).slice(0, MAX_SCOREBOARD_REGIONS)
            : [],
          preprocessingVariantCount: Number(safe.summary.preprocessingVariantCount || 0),
          roiCalibration: normalizeRoiCalibrationSummary(safe.summary.roiCalibration),
          scorebugDebug: normalizeScorebugDebugSummary(safe.summary.scorebugDebug),
          qaReport: normalizeQaReportSummary(safe.summary.qaReport),
          chunkSummary,
          scoreTimeline: Array.isArray(safe.summary.scoreTimeline)
            ? safe.summary.scoreTimeline.map((item) => ({
                timestamp: Number(item.timestamp || 0),
                status: sanitizeText(item.status || "unknown", 40),
                scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
                scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
                temporalConsistency: Boolean(item.temporalConsistency),
                imageSegmentationStatus: item.imageSegmentationStatus ? sanitizeText(item.imageSegmentationStatus, 40) : null,
                imageDecoderStatus: item.imageDecoderStatus ? sanitizeText(item.imageDecoderStatus, 40) : null,
                imageDecoderMode: item.imageDecoderMode ? sanitizeText(item.imageDecoderMode, 40) : null,
                layoutId: item.layoutId ? sanitizeText(item.layoutId, 80) : null,
                scoreOnlyCropRef: item.scoreOnlyCropRef ? sanitizeText(item.scoreOnlyCropRef, 180) : null,
                transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
                transitionReasonCodes: Array.isArray(item.transitionReasonCodes)
                  ? item.transitionReasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
                  : [],
              })).slice(0, MAX_SCOREBOARD_OCR_FRAMES)
            : [],
          fallbackUsed: Boolean(safe.summary.fallbackUsed),
        }
      : null,
    qaReport: normalizeQaReportSummary(safe.qaReport),
    chunkSummary,
    evidence: Array.isArray(safe.evidence)
      ? safe.evidence.map((item) => ({
          id: sanitizeText(item.id, 80),
          timestamp: Number(item.timestamp || 0),
          start: Number(item.start || 0),
          end: Number(item.end || 0),
          status: sanitizeText(item.status || "unknown", 40),
          scoreBefore: item.scoreBefore ? sanitizeText(item.scoreBefore, 16) : null,
          scoreAfter: item.scoreAfter ? sanitizeText(item.scoreAfter, 16) : null,
          changedSide: item.changedSide ? sanitizeText(item.changedSide, 16) : null,
          confidence: Number(item.confidence || 0),
          temporalConsistency: Boolean(item.temporalConsistency),
          ambiguous: Boolean(item.ambiguous),
          scoreChanged: Boolean(item.scoreChanged),
          scoreUnchanged: Boolean(item.scoreUnchanged),
          scoreReverted: Boolean(item.scoreReverted),
          clock: item.clock ? sanitizeText(item.clock, 16) : null,
          source: sanitizeText(item.source || "scoreboard_ocr", 60),
          imageSegmentationStatus: item.imageSegmentationStatus ? sanitizeText(item.imageSegmentationStatus, 40) : null,
          imageDecoderStatus: item.imageDecoderStatus ? sanitizeText(item.imageDecoderStatus, 40) : null,
          imageDecoderMode: item.imageDecoderMode ? sanitizeText(item.imageDecoderMode, 40) : null,
          layoutId: item.layoutId ? sanitizeText(item.layoutId, 80) : null,
          scoreOnlyCropRef: item.scoreOnlyCropRef ? sanitizeText(item.scoreOnlyCropRef, 180) : null,
          transitionDecision: item.transitionDecision ? sanitizeText(item.transitionDecision, 60) : null,
          transitionReasonCodes: Array.isArray(item.transitionReasonCodes)
            ? item.transitionReasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
            : [],
        }))
      : [],
  };
}

function scoreboardOcrHealth() {
  return createScoreboardOcrProvider().health();
}

module.exports = {
  DEFAULT_SCOREBOARD_OCR_TIMEOUT_MS,
  MAX_SCOREBOARD_OCR_FRAMES,
  MAX_SCOREBOARD_REGIONS,
  MAX_SCOREBOARD_OCR_CROPS,
  SCOREBOARD_OCR_QA_LATEST_RELATIVE_PATH,
  SCOREBOARD_OCR_QA_RELATIVE_DIR,
  DeterministicScoreboardOcrProvider,
  ExternalScoreboardOcrProviderAdapter,
  LocalScoreboardOcrProviderAdapter,
  analyzeScoreboardOcr,
  cleanupOcrCrops,
  cropScoreOnlyRegion,
  cropScoreboardRegion,
  createScoreboardOcrProvider,
  defaultScoreboardRegions,
  deterministicScoreboardOcr,
  digitSignatureSimilarity,
  extractOcrFramesFromSource,
  normalizeRegion,
  normalizeScoreboardOcrChunkSummary,
  publicScoreboardOcr,
  recoverScoresFromDigitTemplates,
  scoreboardOcrHealth,
  scorebugFirstPreprocessVariants,
  scoreboardOcrPreprocessVariants,
  selectScorebugLayoutProfile,
  selectOcrFrames,
  selectOcrSamplingWindows,
  validateScoreboardOcrOutput,
  writeScoreboardOcrQaReport,
};
