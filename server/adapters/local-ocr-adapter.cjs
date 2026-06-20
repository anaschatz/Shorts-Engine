const { execFile } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const { buildStableScoreTimeline, readScoreboardCandidate } = require("../scoreboard-reader.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { sanitizeText } = require("../media.cjs");

const DEFAULT_LOCAL_OCR_TIMEOUT_MS = 10000;
const MAX_OCR_STDOUT_BYTES = 4096;

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

function ocrDigitFromToken(value) {
  const token = String(value || "");
  if (token.length > 3) return null;
  const matches = token.match(/[0-9OoIl|]/g) || [];
  if (matches.length !== 1) return null;
  return ocrDigit(matches[0]);
}

function isTeamToken(value) {
  return /^[A-Z]{2,5}[0-9OoIl|]?$/.test(String(value || ""));
}

function tokenizedScoreCandidates(text) {
  const tokens = String(text || "").match(/[A-Z]{2,5}[0-9OoIl|]?|[A-Z]{0,2}[0-9OoIl|][A-Z]{0,2}/g) || [];
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
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j += 1) {
      const home = ocrDigitFromToken(tokens[j]);
      if (home === null) continue;
      for (let k = j + 1; k < Math.min(tokens.length, j + 4); k += 1) {
        const away = ocrDigitFromToken(tokens[k]);
        if (away === null) continue;
        const rejectedDigitLikeBetweenScores = tokens
          .slice(j + 1, k)
          .some((token) => /[0-9]/.test(token) && ocrDigitFromToken(token) === null);
        if (rejectedDigitLikeBetweenScores) continue;
        for (let l = k + 1; l < Math.min(tokens.length, k + 5); l += 1) {
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
  if (maxScore < 5) return [];
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
    if (!Number.isInteger(home) || !Number.isInteger(away)) return;
    if (home < 0 || away < 0 || home > 30 || away > 30) return;
    candidates.push({ home, away, text: `${home}-${away}` });
  };
  for (const match of safe.matchAll(/(?:^|[^0-9])(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/g)) {
    addCandidate(match[1], match[2]);
  }
  if (!candidates.length) {
    for (const match of safe.matchAll(/(?:^|[^0-9])([0-9])\s*:\s*([0-9])(?!\d)/g)) {
      addCandidate(match[1], match[2]);
    }
  }
  if (!candidates.length) {
    for (const candidate of tokenizedScoreCandidates(withoutClock)) {
      addCandidate(candidate.home, candidate.away);
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.text, candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function confidenceForObservation({ text, score, clock, rejected } = {}) {
  if (rejected) return 0.05;
  if (score) return 0.78;
  if (clock) return 0.64;
  if (text) return 0.42;
  return 0.05;
}

function buildScoreboardEvidenceFromObservations(observations = []) {
  const safeObservations = (Array.isArray(observations) ? observations : [])
    .map((observation, index) => {
      const text = normalizeOcrText(observation.text || "");
      const rejected = Boolean(observation.rejected) || hasUnsafeOcrText(text);
      const score = rejected ? null : parseScoreboardScore(text);
      const clock = rejected ? null : parseClock(text);
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
        confidence: Number(observation.confidence || confidenceForObservation({ text, score, clock, rejected })),
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
        confidence: Number(observation.confidence || confidenceForObservation({ text, score, clock, rejected })),
        reading,
      };
    })
    .filter((observation) => Number.isFinite(observation.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const bestByTimestamp = [];
  for (const observation of safeObservations) {
    const existing = bestByTimestamp.find((item) => Math.abs(item.timestamp - observation.timestamp) < 0.2);
    if (!existing) {
      bestByTimestamp.push(observation);
      continue;
    }
    const existingScore = (existing.score ? 2 : 0) + (existing.clock ? 1 : 0) + existing.confidence;
    const nextScore = (observation.score ? 2 : 0) + (observation.clock ? 1 : 0) + observation.confidence;
    if (nextScore > existingScore) Object.assign(existing, observation);
  }

  return buildStableScoreTimeline(bestByTimestamp.map((observation) => observation.reading), { minStableReads: 2 })
    .map((item, index) => ({
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
      ambiguityReasons: item.ambiguityReasons,
    }));
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
    const safePsm = ["6", "7", "11"].includes(String(psm || "")) ? String(psm) : "7";
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
  hasUnsafeOcrText,
  normalizeOcrText,
  ocrCommandAvailable,
  parseClock,
  parseScoreboardScore,
};
