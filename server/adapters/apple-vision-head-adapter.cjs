const { execFile } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { commandAvailable, sanitizeText } = require("../media.cjs");
const { assertStoragePath } = require("../storage.cjs");

const PROVIDER_MODE = "apple-vision-face-tracking";
const MAX_FRAMES = 16;
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const SCRIPT_PATH = resolve(__dirname, "../../tools/apple-vision-head-tracker.swift");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function safeTimeout(value) {
  const parsed = Number(value);
  return Math.max(500, Math.min(10000, Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_TIMEOUT_MS));
}

function safeFrames(frames = []) {
  return (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && Array.isArray(frame.visualHints) && frame.visualHints.includes("celebration_head"))
    .slice(0, MAX_FRAMES)
    .map((frame, index) => {
      let localPath;
      try {
        localPath = assertStoragePath(frame.localPath, "staging");
      } catch {
        return null;
      }
      const time = Number(frame.time ?? frame.timestamp);
      if (!existsSync(localPath) || !Number.isFinite(time) || time < 0) return null;
      const goalHint = frame.visualHints.find((hint) => /^goal_[1-9][0-9]?$/.test(String(hint)));
      return {
        id: sanitizeText(frame.id || `head_frame_${index + 1}`, 64),
        time: round(time, 2),
        path: localPath,
        goalNumber: goalHint ? Number(goalHint.slice(5)) : null,
      };
    })
    .filter(Boolean);
}

function normalizedFace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  const confidence = Number(value.confidence);
  if (
    ![x, y, width, height, confidence].every(Number.isFinite) ||
    x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x + width > 1.001 || y + height > 1.001 ||
    width * height < 0.00035 || width * height > 0.28 ||
    confidence < 0.35
  ) return null;
  return { x, y, width, height, confidence };
}

function chooseProminentFace(faces = [], previous = null) {
  const candidates = (Array.isArray(faces) ? faces : [])
    .map(normalizedFace)
    .filter(Boolean)
    .map((face) => {
      const centerX = face.x + face.width / 2;
      const centerY = 1 - face.y - face.height / 2;
      const areaScore = clamp(Math.sqrt(face.width * face.height / 0.018), 0, 1);
      const centerScore = 1 - Math.min(1, Math.abs(centerX - 0.5) / 0.5);
      const continuityScore = previous
        ? 1 - Math.min(1, Math.hypot(centerX - previous.x, centerY - previous.y) / 0.55)
        : 0.5;
      const score = areaScore * 0.42 + face.confidence * 0.28 + centerScore * 0.18 + continuityScore * 0.12;
      return { ...face, centerX, centerY, score };
    })
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 0.5) return null;
  if (previous && Math.hypot(best.centerX - previous.x, best.centerY - previous.y) > 0.24) return null;
  const second = candidates[1];
  if (
    second &&
    best.score - second.score < 0.035 &&
    Math.abs(best.centerX - second.centerX) > 0.2
  ) return null;
  return best;
}

function chooseProminentPerson(humans = [], previous = null) {
  const candidates = (Array.isArray(humans) ? humans : [])
    .map((person) => {
      const safe = normalizedFace(person);
      if (!safe || safe.width * safe.height < 0.012) return null;
      const centerX = safe.x + safe.width / 2;
      const centerY = 1 - safe.y - safe.height / 2;
      const areaScore = clamp(Math.sqrt(safe.width * safe.height / 0.14), 0, 1);
      const centerScore = 1 - Math.min(1, Math.abs(centerX - 0.5) / 0.5);
      const continuityScore = previous
        ? 1 - Math.min(1, Math.hypot(centerX - previous.x, centerY - previous.y) / 0.55)
        : 0.5;
      const score = areaScore * 0.48 + safe.confidence * 0.2 + centerScore * 0.2 + continuityScore * 0.12;
      return { ...safe, centerX, centerY, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 0.5) return null;
  if (previous && Math.hypot(best.centerX - previous.x, best.centerY - previous.y) > 0.24) return null;
  const second = candidates[1];
  if (
    second &&
    best.score - second.score < 0.03 &&
    Math.abs(best.centerX - second.centerX) > 0.2
  ) return null;
  return best;
}

function headRegionFromPerson(person) {
  const width = person.width * 0.58;
  const height = Math.min(person.height * 0.28, width * 1.15);
  return {
    x: person.x + (person.width - width) / 2,
    y: person.y + person.height - height,
    width,
    height,
    confidence: person.confidence,
    centerX: person.x + person.width / 2,
    centerY: 1 - (person.y + person.height - height / 2),
    score: person.score,
  };
}

function defaultRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: safeTimeout(options.timeoutMs),
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: options.env,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function safeFailure(code, retryable = false) {
  return {
    code: sanitizeText(code || "APPLE_VISION_FACE_TRACKING_FAILED", 80),
    phase: "celebration_head_tracking",
    retryable: Boolean(retryable),
  };
}

async function detectCelebrationHeads({
  frames = [],
  metadata = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  swiftBin = "/usr/bin/swift",
  runner = defaultRunner,
} = {}) {
  const safe = safeFrames(frames);
  if (!safe.length) {
    return { providerMode: PROVIDER_MODE, detections: [], fallbackUsed: true, failure: null };
  }
  if (process.platform !== "darwin" || !existsSync(SCRIPT_PATH) || !commandAvailable(swiftBin)) {
    return {
      providerMode: PROVIDER_MODE,
      detections: [],
      fallbackUsed: true,
      failure: safeFailure("APPLE_VISION_RUNTIME_UNAVAILABLE", true),
    };
  }
  if (signal && signal.aborted) {
    return {
      providerMode: PROVIDER_MODE,
      detections: [],
      fallbackUsed: true,
      failure: safeFailure("APPLE_VISION_CANCELLED", true),
    };
  }
  const cacheRoot = join(CONFIG.tmpDir, "apple-vision-module-cache");
  mkdirSync(cacheRoot, { recursive: true });
  const manifest = safe.map(({ id, time, path }) => ({ id, time, path }));
  let parsed;
  try {
    const stdout = await runner(swiftBin, [SCRIPT_PATH, JSON.stringify({ frames: manifest })], {
      timeoutMs,
      signal,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: cacheRoot,
        SWIFT_MODULECACHE_PATH: cacheRoot,
      },
    });
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return {
      providerMode: PROVIDER_MODE,
      detections: [],
      fallbackUsed: true,
      failure: safeFailure("APPLE_VISION_FACE_TRACKING_FAILED", true),
    };
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.frames)) {
    return {
      providerMode: PROVIDER_MODE,
      detections: [],
      fallbackUsed: true,
      failure: safeFailure("APPLE_VISION_OUTPUT_INVALID"),
    };
  }
  const mediaWidth = Math.max(1, Number(metadata.width || 1920));
  const mediaHeight = Math.max(1, Number(metadata.height || 1080));
  const rowsById = new Map(parsed.frames.map((row) => [String(row && row.id || ""), row]));
  const previousByGoal = new Map();
  const detections = [];
  for (const frame of safe) {
    const row = rowsById.get(frame.id);
    const previous = previousByGoal.get(frame.goalNumber) || null;
    const face = chooseProminentFace(row && row.faces, previous);
    const person = face ? null : chooseProminentPerson(row && row.humans, previous);
    const head = face || (person ? headRegionFromPerson(person) : null);
    if (!head) continue;
    const box = {
      x: Math.round(head.x * mediaWidth),
      y: Math.round((1 - head.y - head.height) * mediaHeight),
      width: Math.max(1, Math.round(head.width * mediaWidth)),
      height: Math.max(1, Math.round(head.height * mediaHeight)),
    };
    const confidence = round(clamp(0.43 + head.score * 0.42, 0.66, face ? 0.94 : 0.86), 2);
    const center = { x: head.centerX, y: head.centerY };
    previousByGoal.set(frame.goalNumber, center);
    detections.push({
      time: frame.time,
      goalNumber: frame.goalNumber,
      celebrationHeadBox: box,
      celebrationHeadConfidence: confidence,
      source: face ? "celebration_face_detection" : "celebration_person_head_estimate",
    });
  }
  return {
    providerMode: PROVIDER_MODE,
    detections,
    fallbackUsed: detections.length === 0,
    failure: detections.length ? null : safeFailure("APPLE_VISION_FACE_NOT_CLEAR"),
  };
}

module.exports = {
  PROVIDER_MODE,
  chooseProminentFace,
  chooseProminentPerson,
  detectCelebrationHeads,
};
