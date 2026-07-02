const { execFile } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const { buildStableScoreTimeline, readScoreboardCandidate } = require("../scoreboard-reader.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { sanitizeText } = require("../media.cjs");

const DEFAULT_LOCAL_OCR_TIMEOUT_MS = 10000;
const MAX_OCR_STDOUT_BYTES = 4096;
const MAX_REASONABLE_TEAM_SCORE = 9;
const MAX_REASONABLE_TOTAL_SCORE = 12;
const MAX_ROI_CANDIDATES = 8;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function hasUnsafeOcrText(value) {
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i.test(String(value || ""));
}

function normalizeOcrText(value) {
  return sanitizeText(String(value || "").replace(/[|]/g, " "), 240);
}

function ocrCommandAvailable(command) {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function parseClock(text) {
  const safe = normalizeOcrText(text);
  const match = safe.match(/\b(?:[0-2]?\d:)?[0-5]?\d:[0-5]\d\b/);
  return match ? match[0] : null;
}

function ocrDigit(value) {
  const text = String(value || "");
  if (/^[Oo]$/.test(text)) return "0";
  if (/^[Il|]$/.test(text)) return "1";
  return text;
}

function ocrDigitFromToken(value, { allowLetterSubstitutions = false } = {}) {
  const token = String(value || "");
  if (token.length > 3) return null;
  if (!allowLetterSubstitutions && !/^[0-9]$/.test(token)) return null;
  const matches = token.match(/[0-9OoIl|]/g) || [];
  if (matches.length !== 1) return null;
  return ocrDigit(matches[0]);
}

function isTeamToken(value) {
  const token = String(value || "");
  return /^[A-Z]{2,5}[0-9OoIl|]?$/.test(token) && !/^[A-Z]$/.test(token);
}

function plausibleScore(home, away) {
  return Number.isInteger(home) &&
    Number.isInteger(away) &&
    home >= 0 &&
    away >= 0 &&
    home <= MAX_REASONABLE_TEAM_SCORE &&
    away <= MAX_REASONABLE_TEAM_SCORE &&
    home + away <= MAX_REASONABLE_TOTAL_SCORE;
}

function tokenizedScoreCandidates(text) {
  const tokens = (String(text || "").match(/[A-Z0-9OoIl|]+/g) || [])
    .filter((token) => isTeamToken(token) || /^[0-9OoIl|]{1,3}$/.test(token));
  if (tokens.length > 10) return [];
  const candidates = [];
  const teamQuality = (token) => {
    const text = String(token || "");
    if (/^[A-Z]{3}$/.test(text)) return 2;
    if (/^[A-Z]{3}[0-9OoIl|]$/.test(text)) return 1.5;
    if (/^[A-Z]{2,4}$/.test(text)) return 1;
    return 0;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isTeamToken(tokens[i])) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + 3); j += 1) {
      const home = ocrDigitFromToken(tokens[j], { allowLetterSubstitutions: false });
      if (home === null) continue;
      for (let k = j + 1; k < Math.min(tokens.length, j + 3); k += 1) {
        const away = ocrDigitFromToken(tokens[k], { allowLetterSubstitutions: false });
        if (away === null) continue;
        if (!plausibleScore(Number(home), Number(away)) || Number(home) + Number(away) > 8) continue;
        const rejectedDigitLikeBetweenScores = tokens
          .slice(j + 1, k)
          .some((token) => /[0-9]/.test(token) && ocrDigitFromToken(token) === null);
        if (rejectedDigitLikeBetweenScores) continue;
        for (let l = k + 1; l < Math.min(tokens.length, k + 3); l += 1) {
          if (!isTeamToken(tokens[l])) continue;
          const score = teamQuality(tokens[i]) +
            teamQuality(tokens[l]) +
            (tokens[j].length === 1 ? 1 : 0) +
            (tokens[k].length === 1 ? 1 : 0) +
            (j === i + 1 ? 1 : 0) +
            (k === j + 1 ? 1 : 0) +
            (l === k + 1 ? 1 : 0);
          candidates.push({ home, away, score });
          break;
        }
      }
    }
  }
  const maxScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
  if (maxScore < 7) return [];
  return candidates.filter((candidate) => candidate.score === maxScore);
}

function parseScoreboardScore(text) {
  const safe = normalizeOcrText(text)
    .replace(/[–—]/g, "-")
    .replace(/([0-9OoIl|])\s*[-]\s*([0-9OoIl|])/g, (_, home, away) => `${ocrDigit(home)}-${ocrDigit(away)}`)
    .replace(/([0-9OoIl|])\s*[:]\s*([0-9OoIl|])/g, (_, home, away) => `${ocrDigit(home)}:${ocrDigit(away)}`)
    .replace(/(\d)\s*[lI|]\s*(\d)/g, "$1-$2");
  const withoutClock = safe.replace(/\b(?:[0-2]?\d:)?[0-5]?\d:[0-5]\d\b/g, " ");
  const candidates = [];
  const addCandidate = (homeText, awayText) => {
    const home = Number(homeText);
    const away = Number(awayText);
    if (!plausibleScore(home, away)) return;
    candidates.push({ home, away, text: `${home}-${away}` });
  };
  for (const match of withoutClock.matchAll(/(?:^|[^0-9])(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/g)) {
    addCandidate(match[1], match[2]);
  }
  if (!candidates.length && /\b[A-Z]{2,5}:\d{2}\b/.test(withoutClock)) {
    return null;
  }
  if (!candidates.length) {
    for (const candidate of tokenizedScoreCandidates(withoutClock)) {
      addCandidate(candidate.home, candidate.away);
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.text, candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function parseScoreOnlyScore(text) {
  const safe = normalizeOcrText(text)
    .replace(/[–—]/g, "-")
    .replace(/([0-9OoIl|])\s*[-:]\s*([0-9OoIl|])/g, (_, home, away) => `${ocrDigit(home)}-${ocrDigit(away)}`);
  if (!safe || parseClock(safe)) return null;
  const nonDigitLetters = safe.replace(/[0-9OoIl|\s_.:-]/g, "");
  if (/[A-Z]/i.test(nonDigitLetters)) return null;
  const digitLike = safe.match(/[0-9OoIl|]/g) || [];
  if (digitLike.length !== 2) return null;
  const home = Number(ocrDigit(digitLike[0]));
  const away = Number(ocrDigit(digitLike[1]));
  if (!plausibleScore(home, away)) return null;
  return { home, away, text: `${home}-${away}` };
}

function scoreAllowedForRegion({ regionId = "scoreboard_region", text = "", score = null } = {}) {
  if (!score) return null;
  const safeRegion = sanitizeText(regionId || "scoreboard_region", 80);
  const safeText = normalizeOcrText(text);
  const broadQaRegion = /^(?:scoreboard_top_|broadcast_top_band)/.test(safeRegion);
  if (!broadQaRegion) return score;
  return /[0-9OoIl|]\s*[-]\s*[0-9OoIl|]/.test(safeText) ? score : null;
}

function confidenceForObservation({ text, score, clock, rejected } = {}) {
  if (rejected) return 0.05;
  if (score) return 0.78;
  if (clock) return 0.64;
  if (text) return 0.42;
  return 0.05;
}

function normalizeObservation(observation = {}, index = 0) {
  const text = normalizeOcrText(observation.text || "");
  const rejected = Boolean(observation.rejected) || hasUnsafeOcrText(text);
  const structuredScore = observation.score &&
    Number.isInteger(observation.score.home) &&
    Number.isInteger(observation.score.away) &&
    plausibleScore(observation.score.home, observation.score.away)
    ? { home: observation.score.home, away: observation.score.away, text: `${observation.score.home}-${observation.score.away}` }
    : null;
  const parsedScore = rejected || structuredScore ? null : parseScoreboardScore(text);
  const score = rejected ? null : scoreAllowedForRegion({
    regionId: observation.regionId || "scoreboard_region",
    text,
    score: structuredScore || parsedScore,
  });
  const clock = rejected ? null : parseClock(text);
  const confidence = Number(observation.confidence || confidenceForObservation({ text, score, clock, rejected }));
  const reading = readScoreboardCandidate({
    id: observation.id || `local_ocr_observation_${index + 1}`,
    timestamp: Number(observation.timestamp || 0),
    start: Number(observation.start ?? Number(observation.timestamp || 0) - 0.8),
    end: Number(observation.end ?? Number(observation.timestamp || 0) + 0.8),
    regionId: observation.regionId || "scoreboard_region",
    preprocessingVariant: observation.preprocessingVariant || observation.variantId || observation.source,
    source: observation.source || "local_ocr_command",
    text,
    score,
    clock,
    rejected,
    confidence,
    layoutId: observation.layoutId,
    scoreOnlyCropRef: observation.scoreOnlyCropRef,
  });
  return {
    id: sanitizeText(observation.id || `local_ocr_observation_${index + 1}`, 80),
    timestamp: Number(observation.timestamp || 0),
    start: Number(observation.start ?? Number(observation.timestamp || 0) - 0.8),
    end: Number(observation.end ?? Number(observation.timestamp || 0) + 0.8),
    regionId: sanitizeText(observation.regionId || "scoreboard_region", 80),
    source: sanitizeText(observation.source || "local_ocr_command", 60),
    score,
    clock,
    textPresent: Boolean(text),
    rejected,
    confidence,
    reading,
    imageSegmentationStatus: sanitizeText(observation.imageSegmentationStatus || "", 40) || null,
    imageDecoderStatus: sanitizeText(observation.imageDecoderStatus || "", 40) || null,
    imageDecoderMode: sanitizeText(observation.imageDecoderMode || "", 40) || null,
    layoutId: sanitizeText(observation.layoutId || "", 80) || null,
    scoreOnlyCropRef: sanitizeText(observation.scoreOnlyCropRef || "", 180) || null,
  };
}

function observationRank(observation = {}) {
  return (observation.score ? 2 : 0) + (observation.clock ? 1 : 0) + observation.confidence;
}

function bestObservationsByTimestamp(observations = []) {
  const bestByTimestamp = [];
  for (const observation of observations) {
    const existing = bestByTimestamp.find((item) => Math.abs(item.timestamp - observation.timestamp) < 0.2);
    if (!existing) {
      bestByTimestamp.push({ ...observation });
      continue;
    }
    if (observationRank(observation) > observationRank(existing)) Object.assign(existing, observation);
  }
  return bestByTimestamp.sort((a, b) => a.timestamp - b.timestamp);
}

function timelineToEvidence(timeline = []) {
  return timeline.map((item, index) => ({
    id: `local_scoreboard_ocr_${index + 1}`,
    timestamp: round(item.timestamp),
    start: round(item.start),
    end: round(item.end),
    status: item.status,
    scoreBefore: item.scoreBefore,
    scoreAfter: item.scoreAfter,
    detectedScoreText: item.detectedScoreText,
    clock: item.clock,
    temporalConsistency: item.temporalConsistency,
    confidence: round(item.confidence),
    source: item.source,
    regionId: item.regionId,
    preprocessingVariant: item.preprocessingVariant,
    imageSegmentationStatus: item.imageSegmentationStatus,
    imageDecoderStatus: item.imageDecoderStatus,
    imageDecoderMode: item.imageDecoderMode,
    layoutId: item.layoutId,
    scoreOnlyCropRef: item.scoreOnlyCropRef,
    transitionDecision: item.transitionDecision,
    transitionReasonCodes: item.transitionReasonCodes,
    ambiguityReasons: item.ambiguityReasons,
  }));
}

function timelineStats(timeline = []) {
  const scoreChangeCount = timeline.filter((item) => item.status === "score_changed").length;
  const revertedCount = timeline.filter((item) => item.status === "goal_removed").length;
  const unchangedCount = timeline.filter((item) => item.status === "score_unchanged").length;
  const ambiguousCount = timeline.filter((item) => item.status === "ambiguous").length;
  const readableCount = timeline.filter((item) => item.scoreAfter).length;
  const timestamps = timeline.map((item) => Number(item.timestamp)).filter(Number.isFinite);
  const confidenceSum = timeline.reduce((sum, item) => sum + Number(item.confidence || 0), 0);
  return {
    scoreChangeCount,
    revertedCount,
    unchangedCount,
    ambiguousCount,
    readableCount,
    observationCount: timeline.length,
    firstTimestamp: timestamps.length ? round(Math.min(...timestamps)) : null,
    lastTimestamp: timestamps.length ? round(Math.max(...timestamps)) : null,
    averageConfidence: timeline.length ? round(confidenceSum / timeline.length) : 0,
  };
}

function regionPreference(regionId = "") {
  const safe = sanitizeText(regionId || "", 80);
  if (/^scorebug_broadcast_compact$/.test(safe)) return 18;
  if (/^scorebug_/.test(safe)) return 14;
  if (/^scoreboard_top_/.test(safe)) return 4;
  if (/broadcast_top_band/.test(safe)) return -6;
  return 0;
}

function scoreRoiTimeline(candidate = {}) {
  const stats = candidate.stats || timelineStats(candidate.timeline);
  const span = stats.firstTimestamp == null || stats.lastTimestamp == null
    ? 0
    : Math.max(0, stats.lastTimestamp - stats.firstTimestamp);
  return round(
    stats.scoreChangeCount * 110 +
    stats.revertedCount * 90 +
    stats.unchangedCount * 8 +
    stats.readableCount * 4 +
    stats.averageConfidence * 12 +
    Math.min(12, span / 60) +
    regionPreference(candidate.regionId) -
    stats.ambiguousCount * 1.5,
  );
}

function candidateSummary(candidate = {}, selected = false) {
  const stats = candidate.stats || timelineStats(candidate.timeline);
  return {
    regionId: sanitizeText(candidate.regionId || "scoreboard_region", 80),
    layoutId: candidate.layoutId ? sanitizeText(candidate.layoutId, 80) : null,
    selected: Boolean(selected),
    score: round(candidate.score),
    observationCount: stats.observationCount,
    readableCount: stats.readableCount,
    scoreChangeCount: stats.scoreChangeCount,
    revertedCount: stats.revertedCount,
    unchangedCount: stats.unchangedCount,
    ambiguousCount: stats.ambiguousCount,
    firstTimestamp: stats.firstTimestamp,
    lastTimestamp: stats.lastTimestamp,
    averageConfidence: stats.averageConfidence,
  };
}

function buildScoreboardTimelineFromObservations(observations = []) {
  const safeObservations = (Array.isArray(observations) ? observations : [])
    .map(normalizeObservation)
    .filter((observation) => Number.isFinite(observation.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const globalTimeline = buildStableScoreTimeline(
    bestObservationsByTimestamp(safeObservations).map((observation) => observation.reading),
    { minStableReads: 2 },
  );
  const groups = new Map();
  for (const observation of safeObservations) {
    const key = `${observation.regionId}::${observation.layoutId || "none"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        regionId: observation.regionId,
        layoutId: observation.layoutId,
        observations: [],
      });
    }
    groups.get(key).observations.push(observation);
  }
  const candidates = [...groups.values()]
    .map((group) => {
      const timeline = buildStableScoreTimeline(
        bestObservationsByTimestamp(group.observations).map((observation) => observation.reading),
        { minStableReads: 2 },
      );
      const candidate = {
        ...group,
        timeline,
        stats: timelineStats(timeline),
      };
      return {
        ...candidate,
        score: scoreRoiTimeline(candidate),
      };
    })
    .filter((candidate) => candidate.timeline.length)
    .sort((a, b) => b.score - a.score || regionPreference(b.regionId) - regionPreference(a.regionId));
  const globalStats = timelineStats(globalTimeline);
  const globalCandidate = {
    key: "global::mixed",
    regionId: "mixed_best_by_timestamp",
    layoutId: null,
    timeline: globalTimeline,
    stats: globalStats,
    score: scoreRoiTimeline({
      regionId: "mixed_best_by_timestamp",
      timeline: globalTimeline,
      stats: globalStats,
    }),
  };
  const selected = candidates[0] && candidates[0].score >= globalCandidate.score - 8
    ? candidates[0]
    : globalCandidate;
  return {
    evidence: timelineToEvidence(selected.timeline),
    roiCalibration: {
      selectedRoi: candidateSummary(selected, true),
      candidateCount: candidates.length,
      rejectedRois: candidates
        .filter((candidate) => candidate.key !== selected.key)
        .slice(0, MAX_ROI_CANDIDATES)
        .map((candidate) => candidateSummary(candidate, false)),
      globalFallback: selected.key === "global::mixed",
      reasonCodes: [
        selected.key === "global::mixed" ? "mixed_timestamp_timeline_selected" : "scorebug_roi_timeline_selected",
        ...(selected.stats.scoreChangeCount ? ["stable_score_change_detected"] : []),
        ...(selected.stats.revertedCount ? ["score_revert_detected"] : []),
      ],
    },
  };
}

function buildScoreboardEvidenceFromObservations(observations = []) {
  return buildScoreboardTimelineFromObservations(observations).evidence;
}

function execFileRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_OCR_STDOUT_BYTES,
      timeout: Math.max(250, Number(options.timeoutMs) || DEFAULT_LOCAL_OCR_TIMEOUT_MS),
      signal: options.signal || undefined,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

function safeOcrWhitelist(value) {
  const text = sanitizeText(String(value || "").replace(/\s+/g, ""), 96).toUpperCase();
  if (!text) return "";
  return /^[A-Z0-9:.-]+$/.test(text) ? text.slice(0, 96) : "";
}

class LocalOcrCommandAdapter {
  constructor({
    bin = "tesseract",
    enabled = false,
    timeoutMs = DEFAULT_LOCAL_OCR_TIMEOUT_MS,
    runner = null,
    commandChecker = null,
  } = {}) {
    this.bin = sanitizeText(bin || "tesseract", 160);
    this.enabled = Boolean(enabled);
    this.timeoutMs = Math.max(250, Math.min(60000, Number(timeoutMs) || DEFAULT_LOCAL_OCR_TIMEOUT_MS));
    this.runner = runner || execFileRunner;
    this.commandChecker = commandChecker || ocrCommandAvailable;
  }

  runtimeAvailable() {
    if (!this.enabled) return false;
    if (this.runner !== execFileRunner) return true;
    return this.commandChecker(this.bin);
  }

  health() {
    const runtimeAvailable = this.runtimeAvailable();
    return {
      ready: true,
      status: this.enabled && runtimeAvailable ? "ready" : "degraded",
      providerMode: this.enabled ? "local-scoreboard-ocr-command" : "local-scoreboard-ocr-disabled",
      localOcrEnabled: this.enabled,
      runtimeAvailable,
      fallbackAvailable: true,
      networkRequired: false,
      commandConfigured: Boolean(this.bin),
    };
  }

  async readTextFromImage({ imagePath, psm = "7", whitelist = "", signal, timeoutMs } = {}) {
    if (!this.enabled || !this.runtimeAvailable()) {
      return { text: "", confidence: 0, skipped: true, reason: "local_ocr_unavailable" };
    }
    const safeImagePath = assertStoragePath(imagePath, "staging");
    const safePsm = ["6", "7", "10", "11"].includes(String(psm || "")) ? String(psm) : "7";
    const safeWhitelist = safeOcrWhitelist(whitelist);
    const args = [safeImagePath, "stdout", "--psm", safePsm, "--oem", "1"];
    if (safeWhitelist) args.push("-c", `tessedit_char_whitelist=${safeWhitelist}`);
    const result = await this.runner(this.bin, args, {
      signal,
      timeoutMs: timeoutMs || this.timeoutMs,
    });
    const text = normalizeOcrText(typeof result === "string" ? result : result && result.stdout);
    if (hasUnsafeOcrText(text)) {
      return { text: "", confidence: 0.05, rejected: true };
    }
    return {
      text,
      confidence: confidenceForObservation({
        text,
        score: parseScoreboardScore(text),
        clock: parseClock(text),
      }),
    };
  }
}

module.exports = {
  DEFAULT_LOCAL_OCR_TIMEOUT_MS,
  LocalOcrCommandAdapter,
  buildScoreboardEvidenceFromObservations,
  buildScoreboardTimelineFromObservations,
  hasUnsafeOcrText,
  normalizeOcrText,
  ocrCommandAvailable,
  parseClock,
  parseScoreboardScore,
  parseScoreOnlyScore,
  scoreAllowedForRegion,
};
