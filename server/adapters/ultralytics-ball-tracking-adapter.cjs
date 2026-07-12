const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { isAbsolute, join, resolve } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText } = require("../media.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { FfmpegFootballTrackingAdapter } = require("./ffmpeg-football-tracking-adapter.cjs");

const PROVIDER_MODE = "ultralytics-dense-ball-tracking";
const MAX_RUNTIME_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MANAGED_RUNTIME_ROOT = resolve(process.cwd(), "var", "runtimes");
const SCRIPT_PATH = resolve(__dirname, "../../tools/dense-ball-track.py");

function insideManagedRuntime(candidate) {
  const resolved = resolve(candidate);
  return resolved === MANAGED_RUNTIME_ROOT || resolved.startsWith(`${MANAGED_RUNTIME_ROOT}/`);
}

function safeRuntimeFile(value, fallback) {
  const candidate = String(value || fallback || "").trim();
  if (!candidate || candidate.length > 600 || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
  if (!insideManagedRuntime(resolved) || !existsSync(resolved)) return null;
  return resolved;
}

function safeInputPath(value) {
  if (!value || typeof value !== "string" || !existsSync(value)) return null;
  for (const area of ["uploads", "staging", "tmp"]) {
    try {
      return assertStoragePath(value, area);
    } catch {
      // Continue through the explicit media-processing roots.
    }
  }
  return null;
}

function safeSegments(values = []) {
  return (Array.isArray(values) ? values : []).slice(0, 12).map((segment, index) => {
    const sourceStart = Number(segment && segment.sourceStart);
    const finishTime = Number(segment && (segment.visibleFinishTime ?? segment.finishTime));
    if (!Number.isFinite(sourceStart) || !Number.isFinite(finishTime) || sourceStart < 0 || finishTime <= sourceStart) {
      return null;
    }
    return {
      goalNumber: Math.max(1, Math.round(Number(segment.goalNumber || index + 1))),
      sourceStart: Number(sourceStart.toFixed(3)),
      finishTime: Number(finishTime.toFixed(3)),
    };
  }).filter(Boolean);
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(parsed)));
}

function safeDevice(value) {
  return String(value || "cpu").trim().toLowerCase() === "mps" ? "mps" : "cpu";
}

function defaultCommandRunner(command, args, { signal, timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, {
      timeout: boundedTimeout(timeoutMs),
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        ...process.env,
        YOLO_CONFIG_DIR: resolve(MANAGED_RUNTIME_ROOT, "ultralytics-config"),
        MPLCONFIGDIR: resolve(MANAGED_RUNTIME_ROOT, "matplotlib"),
      },
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(String(stdout || ""));
    });
    const abort = () => child.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    child.once("close", () => {
      if (signal) signal.removeEventListener("abort", abort);
    });
  });
}

function parseRuntimeOutput(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("dense_tracking_output_missing");
  const parsed = JSON.parse(lines[lines.length - 1]);
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.samples) || !Array.isArray(parsed.goals)) {
    throw new Error("dense_tracking_output_invalid");
  }
  return parsed;
}

function sampledBallTracks(samples = [], maxItems = 32) {
  if (samples.length <= maxItems) {
    return samples.map((sample) => ({
      timestamp: sample.time,
      label: "ball",
      confidence: sample.ballConfidence,
      bounds: sample.ballBox,
    }));
  }
  const tracks = [];
  for (let index = 0; index < maxItems; index += 1) {
    const sampleIndex = Math.round(index * (samples.length - 1) / Math.max(1, maxItems - 1));
    const sample = samples[sampleIndex];
    tracks.push({
      timestamp: sample.time,
      label: "ball",
      confidence: sample.ballConfidence,
      bounds: sample.ballBox,
    });
  }
  return tracks;
}

class UltralyticsBallTrackingAdapter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.pythonBin = safeRuntimeFile(
      options.pythonBin || process.env.SHORTSENGINE_DENSE_TRACKING_PYTHON_BIN,
      "var/runtimes/tracking-venv/bin/python",
    );
    this.modelPath = safeRuntimeFile(
      options.modelPath || process.env.SHORTSENGINE_DENSE_TRACKING_MODEL,
      "var/runtimes/models/football-player-detection.pt",
    );
    this.timeoutMs = boundedTimeout(options.timeoutMs || process.env.SHORTSENGINE_DENSE_TRACKING_TIMEOUT_MS);
    this.device = safeDevice(options.device || process.env.SHORTSENGINE_DENSE_TRACKING_DEVICE);
    this.commandRunner = options.commandRunner || defaultCommandRunner;
    this.baseProvider = options.baseProvider || new FfmpegFootballTrackingAdapter({ enabled: true });
  }

  health() {
    const ready = Boolean(this.enabled && this.pythonBin && this.modelPath && existsSync(SCRIPT_PATH));
    return {
      ready,
      enabled: this.enabled,
      mode: PROVIDER_MODE,
      densePerFrameTracking: ready,
      fallbackMode: "ffmpeg-football-tracking",
      failure: ready ? null : {
        code: "DENSE_BALL_TRACKING_RUNTIME_MISSING",
        phase: "dense_ball_tracking",
        retryable: true,
      },
      goalClaimAllowed: false,
      networkRequired: false,
    };
  }

  async analyzeTracking(input = {}) {
    if (input.signal && input.signal.aborted) {
      throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
    }
    const base = await this.baseProvider.analyzeTracking(input);
    const inputPath = safeInputPath(input.inputPath);
    const segments = safeSegments(input.segments || input.goalSegments);
    if (!this.health().ready || !inputPath || !segments.length) return base;
    try {
      const stdout = await this.commandRunner(this.pythonBin, [
        SCRIPT_PATH,
        "--input",
        inputPath,
        "--model",
        this.modelPath,
        "--segments",
        JSON.stringify(segments),
        "--imgsz",
        "960",
        "--confidence",
        "0.05",
        "--device",
        this.device,
      ], { signal: input.signal, timeoutMs: this.timeoutMs });
      const dense = parseRuntimeOutput(stdout);
      const denseSamples = dense.samples.slice(0, 4096);
      const scorerSamples = Array.isArray(base.samples)
        ? base.samples.filter((sample) => sample && sample.phase === "scorer_follow")
        : [];
      const mergedSamples = [...denseSamples, ...scorerSamples]
        .sort((left, right) => Number(left.time) - Number(right.time))
        .slice(0, 4096);
      if (!dense.perFrameBallContainmentPassed) {
        return {
          ...base,
          providerMode: PROVIDER_MODE,
          densePerFrameTracking: true,
          sourceFrameRate: Number(dense.sourceFrameRate || 0),
          inspectedFrameCount: Number(dense.inspectedFrameCount || 0),
          containedFrameCount: Number(dense.containedFrameCount || 0),
          perFrameBallContainmentPassed: false,
          perGoalBallContainment: dense.goals.slice(0, 12),
          failure: {
            code: "DENSE_BALL_CONTAINMENT_INCOMPLETE",
            phase: "dense_ball_tracking",
            retryable: false,
          },
        };
      }
      return {
        ...base,
        providerMode: PROVIDER_MODE,
        fallbackUsed: false,
        frameCount: Number(dense.inspectedFrameCount || denseSamples.length),
        ballTracks: sampledBallTracks(denseSamples),
        samples: mergedSamples,
        confidence: Math.max(0.52, Math.min(0.95, Number(base.confidence || 0.7))),
        reasonCodes: [...new Set([
          ...(Array.isArray(base.reasonCodes) ? base.reasonCodes : []),
          "tracking_per_frame_ball_containment",
        ])],
        densePerFrameTracking: true,
        sourceFrameRate: Number(dense.sourceFrameRate || 0),
        inspectedFrameCount: Number(dense.inspectedFrameCount || 0),
        containedFrameCount: Number(dense.containedFrameCount || 0),
        perFrameBallContainmentPassed: true,
        perGoalBallContainment: dense.goals.slice(0, 12),
        failure: null,
        goalClaimAllowed: false,
      };
    } catch (error) {
      if (input.signal && input.signal.aborted) {
        throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      }
      return {
        ...base,
        providerMode: PROVIDER_MODE,
        densePerFrameTracking: false,
        perFrameBallContainmentPassed: false,
        failure: {
          code: sanitizeText(error && error.code || "DENSE_BALL_TRACKING_FAILED", 80),
          phase: "dense_ball_tracking",
          retryable: true,
        },
      };
    }
  }
}

module.exports = {
  PROVIDER_MODE,
  UltralyticsBallTrackingAdapter,
  parseRuntimeOutput,
  safeSegments,
};
