const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText } = require("../media.cjs");

const HELPER_PATH = path.resolve(__dirname, "../../tools/faster-whisper-transcribe.py");
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
let cachedProbe = null;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function modelCacheDir(env = process.env) {
  const fallback = path.resolve(CONFIG.dataDir, "models/faster-whisper");
  const configured = String(env.SHORTSENGINE_LOCAL_WHISPER_CACHE_DIR || "").trim();
  if (!configured) return fallback;
  if (configured.length > 500 || configured.includes("\u0000")) throw new Error("Invalid local Whisper cache directory.");
  const resolved = path.resolve(configured);
  const repoData = path.resolve(__dirname, "../../data");
  if (![repoData, tmpdir(), CONFIG.dataDir].some((root) => inside(root, resolved))) throw new Error("Invalid local Whisper cache directory.");
  return resolved;
}

function modeFromEnv(env = process.env) {
  const value = String(env.SHORTSENGINE_LOCAL_WHISPER_MODE || "auto").trim().toLowerCase();
  if (["0", "false", "off", "disabled"].includes(value)) return "disabled";
  if (["1", "true", "on", "enabled", "required"].includes(value)) return "enabled";
  return "auto";
}

function fasterWhisperConfig(env = process.env) {
  return {
    mode: modeFromEnv(env),
    pythonBin: String(env.SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN || "python3").trim(),
    model: String(env.SHORTSENGINE_LOCAL_WHISPER_MODEL || "base").trim(),
    device: String(env.SHORTSENGINE_LOCAL_WHISPER_DEVICE || "cpu").trim(),
    computeType: String(env.SHORTSENGINE_LOCAL_WHISPER_COMPUTE_TYPE || "int8").trim(),
    timeoutMs: Math.max(1000, Math.min(900000, Number(env.SHORTSENGINE_LOCAL_WHISPER_TIMEOUT_MS || 180000))),
    helperPath: HELPER_PATH,
    cacheDir: modelCacheDir(env),
  };
}

function fasterWhisperVersion(env = process.env) {
  const config = fasterWhisperConfig(env);
  const identity = JSON.stringify({ computeType: config.computeType, device: config.device, model: config.model, promptVersion: "narration_alignment_v1" });
  return `local_faster_whisper_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function probeFasterWhisperRuntime(env = process.env, options = {}) {
  const config = fasterWhisperConfig(env);
  if (config.mode === "disabled") return { available: false, reason: "disabled", config };
  const probeKey = `${config.pythonBin}:${config.helperPath}:${config.cacheDir}:${config.model}:${config.device}:${config.computeType}`;
  if (!options.refresh && cachedProbe && cachedProbe.key === probeKey) {
    return { ...cachedProbe.result, config };
  }
  if (!existsSync(config.helperPath)) return { available: false, reason: "helper_missing", config };
  const packageProbe = spawnSync(config.pythonBin, [config.helperPath, "--probe", "--cache-dir", config.cacheDir], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (packageProbe.status !== 0 || !/"available"\s*:\s*true/.test(packageProbe.stdout || "")) {
    const probe = {
      available: false,
      reason: packageProbe.error && packageProbe.error.code === "ENOENT" ? "python_missing" : "package_missing",
    };
    cachedProbe = { key: probeKey, result: probe };
    return { ...probe, config };
  }
  const result = spawnSync(config.pythonBin, [config.helperPath, "--probe-model", "--model", config.model, "--device", config.device, "--compute-type", config.computeType, "--cache-dir", config.cacheDir], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  const probe = {
    available: result.status === 0 && /"available"\s*:\s*true/.test(result.stdout || ""),
    reason: result.error && result.error.code === "ENOENT"
      ? "python_missing"
      : result.status === 0
        ? null
        : "model_unavailable",
  };
  cachedProbe = { key: probeKey, result: probe };
  return { ...probe, config };
}

function normalizeResult(value, language) {
  const rawSegments = Array.isArray(value && value.segments) ? value.segments : [];
  const segments = rawSegments.slice(0, 120).map((segment) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = sanitizeText(segment.text, 240);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return null;
    const words = (Array.isArray(segment.words) ? segment.words : []).slice(0, 120).map((word) => {
      const wordStart = Number(word.start);
      const wordEnd = Number(word.end);
      const safeWord = sanitizeText(word.word, 80);
      if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart || !safeWord) return null;
      return {
        start: wordStart,
        end: wordEnd,
        word: safeWord,
        probability: Math.max(0, Math.min(1, Number(word.probability || 0))),
      };
    }).filter(Boolean);
    return { start, end, text, words };
  }).filter(Boolean);
  if (!segments.length) throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
  return {
    provider: "faster-whisper",
    language: sanitizeText(value.language || language || "auto", 24),
    text: segments.map((segment) => segment.text).join(" ").slice(0, 12000),
    segments,
    captions: segments.slice(0, 60),
  };
}

function transcribeWithFasterWhisper({ audioPath, language = "auto", env = process.env, signal = null, spawnImpl = spawn, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  const config = fasterWhisperConfig(env);
  return new Promise((resolve, reject) => {
    const args = [
      config.helperPath,
      "--audio", audioPath,
      "--model", config.model,
      "--language", language,
      "--device", config.device,
      "--compute-type", config.computeType,
      "--cache-dir", config.cacheDir,
    ];
    const child = spawnImpl(config.pythonBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    timer = setTimeoutImpl(() => {
      child.kill("SIGKILL");
      finish(new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 504));
    }, config.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        finish(new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503));
        return;
      }
      try {
        finish(null, normalizeResult(JSON.parse(stdout), language));
      } catch (_error) {
        finish(new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503));
      }
    });
  });
}

module.exports = {
  fasterWhisperConfig,
  fasterWhisperVersion,
  modelCacheDir,
  probeFasterWhisperRuntime,
  transcribeWithFasterWhisper,
};
