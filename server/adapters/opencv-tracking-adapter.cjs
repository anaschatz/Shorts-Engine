const { execFile, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { assertStoragePath } = require("../storage.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText } = require("../media.cjs");
const {
  trackingFallback,
  validateTrackingProviderOutput,
} = require("../tracking-provider.cjs");

const DEFAULT_OPENCV_TIMEOUT_MS = 3500;
const MAX_OPENCV_FRAMES = 16;
const MAX_RUNTIME_OUTPUT_BYTES = 64 * 1024;
const OPENCV_PROVIDER_MODE = "opencv-object-tracking";
const OPENCV_DISABLED_MODE = "opencv-tracking-disabled";

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function safeExecutable(value = "python3") {
  const raw = sanitizeText(value || "python3", 120);
  if (
    !raw ||
    raw.includes("\u0000") ||
    /[\s`$;&|<>]/.test(raw) ||
    raw.includes("\\") ||
    raw.includes("..")
  ) {
    return "python3";
  }
  return raw;
}

function safeTimeout(value = DEFAULT_OPENCV_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_OPENCV_TIMEOUT_MS;
  return Math.max(250, Math.min(12000, Math.round(parsed)));
}

function safeFailure(code, phase = "opencv_tracking", retryable = false) {
  return {
    code: sanitizeText(code || "OPENCV_TRACKING_LOW_CONFIDENCE", 80),
    phase: sanitizeText(phase, 80),
    retryable: Boolean(retryable),
  };
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function safeFrames(frames = [], metadata = {}) {
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  return (Array.isArray(frames) ? frames : [])
    .slice(0, MAX_OPENCV_FRAMES)
    .map((frame, index) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
      const localPath = assertStoragePath(frame.localPath, "staging");
      if (!existsSync(localPath)) return null;
      const timestamp = Number(frame.timestamp);
      const width = Number(frame.width);
      const height = Number(frame.height);
      if (!Number.isFinite(timestamp) || timestamp < 0 || (duration && timestamp > duration + 0.25)) return null;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 1280 || height > 1280) {
        return null;
      }
      return {
        id: sanitizeText(frame.id || `frame_${index + 1}`, 64),
        timestamp: round(timestamp, 2),
        width: Math.round(width),
        height: Math.round(height),
        localPath,
      };
    })
    .filter(Boolean);
}

function publicFrameManifest(frames = []) {
  return frames.map((frame) => ({
    id: frame.id,
    timestamp: frame.timestamp,
    width: frame.width,
    height: frame.height,
    localPath: frame.localPath,
  }));
}

function defaultCommandRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      timeout: safeTimeout(options.timeoutMs),
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ status: 0, stdout: String(stdout || "") });
    });
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
        reject(cancellationError());
        return;
      }
      options.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
        reject(cancellationError());
      }, { once: true });
    }
  });
}

function defaultCommandRunnerSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    timeout: safeTimeout(options.timeoutMs),
    maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
    encoding: "utf8",
  });
  if (result.error) {
    return { status: 1, errorCode: result.error.code || "OPENCV_RUNTIME_MISSING" };
  }
  return {
    status: Number(result.status || 0),
  };
}

function pythonProbeScript() {
  return "import cv2; print('ok')";
}

function opencvAnalysisScript() {
  return `
import json, sys

try:
    import cv2
    import numpy as np
except Exception:
    print(json.dumps({"ok": False, "code": "OPENCV_IMPORT_FAILED"}))
    sys.exit(0)

payload = json.loads(sys.argv[1])
metadata = payload.get("metadata") or {}
frames = (payload.get("frames") or [])[:16]
media_width = int(metadata.get("width") or 1920)
media_height = int(metadata.get("height") or 1080)

ball_tracks = []
player_clusters = []
all_boxes = []

def scale_box(box, source_width, source_height):
    x, y, w, h = box
    sx = float(media_width) / max(1, source_width)
    sy = float(media_height) / max(1, source_height)
    return {
        "x": int(max(0, round(x * sx))),
        "y": int(max(0, round(y * sy))),
        "width": int(max(1, round(w * sx))),
        "height": int(max(1, round(h * sy))),
    }

for frame in frames:
    img = cv2.imread(frame.get("localPath", ""))
    if img is None:
        continue
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, np.array([35, 35, 35]), np.array([95, 255, 255]))
    foreground = cv2.bitwise_not(green)
    foreground = cv2.medianBlur(foreground, 5)
    contours, _ = cv2.findContours(foreground, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    small_candidates = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < 8 or area > max(12000, w * h * 0.08):
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw <= 0 or bh <= 0:
            continue
        boxes.append((x, y, bw, bh, area))
        ratio = max(bw, bh) / max(1, min(bw, bh))
        if 8 <= area <= 900 and ratio <= 2.2:
            small_candidates.append((x, y, bw, bh, area))
    boxes.sort(key=lambda item: item[4], reverse=True)
    small_candidates.sort(key=lambda item: item[4])
    timestamp = float(frame.get("timestamp") or 0)
    if small_candidates:
        x, y, bw, bh, _ = small_candidates[0]
        bounds = scale_box((x, y, bw, bh), w, h)
        ball_tracks.append({
            "timestamp": timestamp,
            "label": "ball",
            "confidence": 0.68,
            "bounds": bounds,
        })
        all_boxes.append(bounds)
    cluster_boxes = boxes[:6]
    if cluster_boxes:
        left = min(item[0] for item in cluster_boxes)
        top = min(item[1] for item in cluster_boxes)
        right = max(item[0] + item[2] for item in cluster_boxes)
        bottom = max(item[1] + item[3] for item in cluster_boxes)
        bounds = scale_box((left, top, right - left, bottom - top), w, h)
        player_clusters.append({
            "timestamp": timestamp,
            "label": "player_cluster",
            "confidence": 0.62,
            "bounds": bounds,
        })
        all_boxes.append(bounds)

if not ball_tracks or not player_clusters:
    print(json.dumps({
        "ok": True,
        "providerMode": "opencv-object-tracking",
        "fallbackUsed": True,
        "frameCount": len(frames),
        "ballTracks": [],
        "playerClusters": [],
        "actionBounds": None,
        "actionCenter": None,
        "cameraMotionLevel": 0.0,
        "confidence": 0.0,
        "reasonCodes": ["tracking_action_uncertain"],
        "failure": {"code": "OPENCV_TRACKING_LOW_CONFIDENCE", "phase": "opencv_tracking", "retryable": False},
        "goalClaimAllowed": False
    }))
    sys.exit(0)

left = max(0, min(box["x"] for box in all_boxes))
top = max(0, min(box["y"] for box in all_boxes))
right = min(media_width, max(box["x"] + box["width"] for box in all_boxes))
bottom = min(media_height, max(box["y"] + box["height"] for box in all_boxes))
action_bounds = {"x": left, "y": top, "width": max(1, right - left), "height": max(1, bottom - top)}
confidence = min(0.9, 0.48 + min(len(ball_tracks), 3) * 0.08 + min(len(player_clusters), 3) * 0.06)

print(json.dumps({
    "ok": True,
    "providerMode": "opencv-object-tracking",
    "fallbackUsed": False,
    "frameCount": len(frames),
    "ballTracks": ball_tracks[:12],
    "playerClusters": player_clusters[:8],
    "actionBounds": action_bounds,
    "actionCenter": {"x": action_bounds["x"] + action_bounds["width"] / 2, "y": action_bounds["y"] + action_bounds["height"] / 2},
    "cameraMotionLevel": 0.0,
    "confidence": confidence,
    "reasonCodes": ["tracking_ball_visible", "tracking_player_cluster", "tracking_action_bounds"],
    "failure": None,
    "goalClaimAllowed": False
}))
`.trim();
}

function detectOpenCvRuntime({
  enabled = false,
  pythonBin = process.env.SHORTSENGINE_OPENCV_PYTHON_BIN || "python3",
  timeoutMs = process.env.SHORTSENGINE_OPENCV_TRACKING_TIMEOUT_MS || DEFAULT_OPENCV_TIMEOUT_MS,
  commandRunnerSync = defaultCommandRunnerSync,
} = {}) {
  const configuredTimeoutMs = safeTimeout(timeoutMs);
  if (!enabled) {
    return {
      ready: true,
      enabled: false,
      mode: OPENCV_DISABLED_MODE,
      pythonAvailable: false,
      opencvAvailable: false,
      objectTracking: false,
      fallbackMode: "safe-tracking-fallback",
      timeoutMs: configuredTimeoutMs,
      failure: null,
      goalClaimAllowed: false,
      networkRequired: false,
    };
  }
  const result = commandRunnerSync(safeExecutable(pythonBin), ["-c", pythonProbeScript()], { timeoutMs: Math.min(1500, configuredTimeoutMs) });
  if (!result || result.status !== 0) {
    const code = result && result.errorCode === "ENOENT" ? "OPENCV_RUNTIME_MISSING" : "OPENCV_IMPORT_FAILED";
    return {
      ready: false,
      enabled: true,
      mode: OPENCV_PROVIDER_MODE,
      pythonAvailable: code !== "OPENCV_RUNTIME_MISSING",
      opencvAvailable: false,
      objectTracking: false,
      fallbackMode: "safe-tracking-fallback",
      timeoutMs: configuredTimeoutMs,
      failure: safeFailure(code, "opencv_runtime_detection", true),
      goalClaimAllowed: false,
      networkRequired: false,
    };
  }
  return {
    ready: true,
    enabled: true,
    mode: OPENCV_PROVIDER_MODE,
    pythonAvailable: true,
    opencvAvailable: true,
    objectTracking: true,
    fallbackMode: "safe-tracking-fallback",
    timeoutMs: configuredTimeoutMs,
    failure: null,
    goalClaimAllowed: false,
    networkRequired: false,
  };
}

function fallback({ input = {}, reason = "tracking_provider_disabled", code = "OPENCV_RUNTIME_MISSING", retryable = true } = {}) {
  return trackingFallback({
    metadata: input.metadata,
    frames: input.frames,
    reason,
    failure: safeFailure(code, "opencv_tracking", retryable),
  });
}

class OpenCvTrackingAdapter {
  constructor({
    enabled = boolFromEnv(process.env.SHORTSENGINE_OPENCV_TRACKING_ENABLED) ||
      String(process.env.SHORTSENGINE_TRACKING_PROVIDER || "").toLowerCase() === "opencv",
    pythonBin = process.env.SHORTSENGINE_OPENCV_PYTHON_BIN || "python3",
    timeoutMs = process.env.SHORTSENGINE_OPENCV_TRACKING_TIMEOUT_MS || DEFAULT_OPENCV_TIMEOUT_MS,
    commandRunner = defaultCommandRunner,
    commandRunnerSync = defaultCommandRunnerSync,
    client = null,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.pythonBin = safeExecutable(pythonBin);
    this.timeoutMs = safeTimeout(timeoutMs);
    this.commandRunner = commandRunner;
    this.commandRunnerSync = commandRunnerSync;
    this.client = client;
  }

  health() {
    if (this.client && typeof this.client.analyzeTracking === "function") {
      return {
        ready: true,
        enabled: true,
        mode: OPENCV_PROVIDER_MODE,
        pythonAvailable: false,
        opencvAvailable: false,
        objectTracking: true,
        fallbackMode: "safe-tracking-fallback",
        timeoutMs: this.timeoutMs,
        failure: null,
        goalClaimAllowed: false,
        networkRequired: false,
      };
    }
    return detectOpenCvRuntime({
      enabled: this.enabled,
      pythonBin: this.pythonBin,
      timeoutMs: this.timeoutMs,
      commandRunnerSync: this.commandRunnerSync,
    });
  }

  async analyzeTracking(input = {}) {
    if (input.signal && input.signal.aborted) throw cancellationError();
    if (!this.enabled && !this.client) {
      return fallback({
        input,
        reason: "tracking_provider_disabled",
        code: "OPENCV_TRACKING_DISABLED",
        retryable: false,
      });
    }
    if (this.client && typeof this.client.analyzeTracking === "function") {
      try {
        const output = await this.client.analyzeTracking({
          frames: Array.isArray(input.frames) ? input.frames.slice(0, MAX_OPENCV_FRAMES) : [],
          metadata: input.metadata || {},
          candidateWindows: Array.isArray(input.candidateWindows) ? input.candidateWindows : [],
          visualSignals: input.visualSignals || {},
          mediaSignals: input.mediaSignals || {},
          signal: input.signal || null,
        });
        return validateTrackingProviderOutput({
          ...output,
          providerMode: OPENCV_PROVIDER_MODE,
          goalClaimAllowed: false,
        }, input.metadata || {});
      } catch (error) {
        if (error && error.code === "JOB_CANCELLED") throw error;
        return fallback({
          input,
          reason: "tracking_provider_failed",
          code: error && error.code ? error.code : "OPENCV_OUTPUT_INVALID",
          retryable: true,
        });
      }
    }
    const runtime = this.health();
    if (!runtime.enabled || !runtime.ready) {
      return fallback({
        input,
        reason: runtime.failure && runtime.failure.code === "OPENCV_IMPORT_FAILED"
          ? "tracking_provider_failed"
          : "tracking_provider_disabled",
        code: runtime.failure && runtime.failure.code || "OPENCV_RUNTIME_MISSING",
        retryable: true,
      });
    }
    let frames = [];
    try {
      frames = safeFrames(input.frames, input.metadata || {});
    } catch {
      return fallback({
        input,
        reason: "tracking_provider_output_invalid",
        code: "OPENCV_OUTPUT_INVALID",
        retryable: false,
      });
    }
    if (!frames.length) {
      return fallback({
        input,
        reason: "tracking_fallback_no_ball_player_evidence",
        code: "OPENCV_TRACKING_LOW_CONFIDENCE",
        retryable: false,
      });
    }
    try {
      const result = await this.commandRunner(this.pythonBin, [
        "-c",
        opencvAnalysisScript(),
        JSON.stringify({
          frames: publicFrameManifest(frames),
          metadata: input.metadata || {},
        }),
      ], {
        signal: input.signal,
        timeoutMs: input.timeoutMs || this.timeoutMs,
      });
      const parsed = JSON.parse(String(result && result.stdout || "{}"));
      if (parsed && parsed.ok === false) {
        return fallback({
          input,
          reason: "tracking_provider_failed",
          code: parsed.code || "OPENCV_IMPORT_FAILED",
          retryable: true,
        });
      }
      const safe = validateTrackingProviderOutput({
        ...parsed,
        providerMode: OPENCV_PROVIDER_MODE,
        goalClaimAllowed: false,
      }, input.metadata || {});
      if (safe.fallbackUsed || safe.confidence < 0.5) {
        return trackingFallback({
          metadata: input.metadata,
          frames: input.frames,
          reason: "tracking_action_uncertain",
          failure: safeFailure("OPENCV_TRACKING_LOW_CONFIDENCE", "opencv_tracking", false),
        });
      }
      return safe;
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      const isTimeout = error && (error.killed || error.code === "ETIMEDOUT" || /timeout/i.test(String(error.message || "")));
      return fallback({
        input,
        reason: isTimeout ? "tracking_provider_timeout" : "tracking_provider_failed",
        code: isTimeout ? "OPENCV_TRACKING_TIMEOUT" : "OPENCV_OUTPUT_INVALID",
        retryable: true,
      });
    }
  }
}

function analyzeWithOpenCvTracking(input = {}) {
  const adapter = input.provider instanceof OpenCvTrackingAdapter
    ? input.provider
    : new OpenCvTrackingAdapter({
        enabled: input.enabled,
        pythonBin: input.pythonBin,
        timeoutMs: input.timeoutMs,
        commandRunner: input.commandRunner,
        commandRunnerSync: input.commandRunnerSync,
        client: input.client,
      });
  return adapter.analyzeTracking(input);
}

module.exports = {
  DEFAULT_OPENCV_TIMEOUT_MS,
  OPENCV_DISABLED_MODE,
  OPENCV_PROVIDER_MODE,
  OpenCvTrackingAdapter,
  analyzeWithOpenCvTracking,
  detectOpenCvRuntime,
};
