const { execFile } = require("node:child_process");
const { spawnSync } = require("node:child_process");
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

function parseScoreboardScore(text) {
  const safe = normalizeOcrText(text)
    .replace(/[–—]/g, "-")
    .replace(/\bO\b/g, "0")
    .replace(/(\d)\s*[lI]\s*(\d)/g, "$1-$2");
  const matches = [...safe.matchAll(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/g)];
  for (const match of matches) {
    const home = Number(match[1]);
    const away = Number(match[2]);
    if (!Number.isInteger(home) || !Number.isInteger(away)) continue;
    if (home < 0 || away < 0 || home > 30 || away > 30) continue;
    return { home, away, text: `${home}-${away}` };
  }
  return null;
}

function scoreDelta(before, after) {
  if (!before || !after) return 0;
  return Math.abs(after.home - before.home) + Math.abs(after.away - before.away);
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

  const evidence = [];
  let previousScore = null;
  for (const [index, observation] of bestByTimestamp.entries()) {
    let status = "unreadable";
    let scoreBefore = null;
    let scoreAfter = observation.score ? observation.score.text : null;
    let temporalConsistency = false;
    if (observation.rejected || (!observation.score && !observation.clock && !observation.textPresent)) {
      status = "unreadable";
    } else if (observation.score && previousScore) {
      const delta = scoreDelta(previousScore, observation.score);
      scoreBefore = previousScore.text;
      if (delta === 1) {
        status = "score_changed";
        temporalConsistency = true;
      } else if (delta === 0) {
        status = "score_unchanged";
        temporalConsistency = true;
      } else {
        status = "ambiguous";
      }
    } else if (observation.score) {
      status = "ambiguous";
    } else if (observation.clock) {
      status = "clock_only";
    } else {
      status = "ambiguous";
    }

    evidence.push({
      id: `local_scoreboard_ocr_${index + 1}`,
      timestamp: round(observation.timestamp),
      start: round(observation.start),
      end: round(observation.end),
      status,
      scoreBefore,
      scoreAfter,
      detectedScoreText: scoreAfter,
      clock: observation.clock,
      temporalConsistency,
      confidence: round(observation.confidence),
      source: observation.source,
      regionId: observation.regionId,
    });
    if (observation.score) previousScore = observation.score;
  }
  return evidence;
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

  async readTextFromImage({ imagePath, signal, timeoutMs } = {}) {
    if (!this.enabled || !this.runtimeAvailable()) {
      return { text: "", confidence: 0, skipped: true, reason: "local_ocr_unavailable" };
    }
    const safeImagePath = assertStoragePath(imagePath, "staging");
    const result = await this.runner(this.bin, [safeImagePath, "stdout", "--psm", "7", "--oem", "1"], {
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
