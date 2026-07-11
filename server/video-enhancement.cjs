const { spawn, spawnSync } = require("node:child_process");
const { constants, accessSync, existsSync, mkdirSync, readdirSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const PROVIDERS = Object.freeze(["realesrgan-python", "realesrgan-ncnn"]);
const MODELS = Object.freeze([
  "realesrgan-x4plus",
  "realesrnet-x4plus",
  "realesrgan-x4plus-anime",
  "realesr-animevideov3",
]);
const MANAGED_RUNTIME_DIR = resolve(process.cwd(), "var", "runtimes", "realesrgan-ncnn-vulkan");
const MANAGED_BINARY_NAME = "realesrgan-ncnn-vulkan";
const MANAGED_PYTHON_BIN = resolve(process.cwd(), "var", "runtimes", "realesrgan-venv310", "bin", "python3");
const MANAGED_PYTHON_MODEL = resolve(process.cwd(), "var", "runtimes", "models", "RealESRGAN_x4plus.pth");
const PYTHON_ADAPTER_PATH = resolve(process.cwd(), "tools", "realesrgan-enhance.py");

function enhancementMode(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (["", "auto"].includes(normalized)) return "auto";
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return "enabled";
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return "disabled";
  throw new Error("Invalid video enhancement mode configuration.");
}

function boundedInteger(value, fallback, min, max, label) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label} configuration.`);
  }
  return parsed;
}

function booleanSetting(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${label} configuration.`);
}

function safeCommand(value, managedRuntimeDir = MANAGED_RUNTIME_DIR) {
  const requested = String(value || "managed").trim();
  const command = requested === "managed"
    ? join(resolve(managedRuntimeDir), MANAGED_BINARY_NAME)
    : requested;
  const invalidAbsolutePath = isAbsolute(command) && /[\u0000-\u001f\u007f]/.test(command);
  const invalidCommandName = !isAbsolute(command) && /[\s`$;&|<>\\]/.test(command);
  if (!command || command.length > 500 || invalidAbsolutePath || invalidCommandName) {
    throw new Error("Invalid Real-ESRGAN binary configuration.");
  }
  return command;
}

function safeModelDir(value, binary, managedRuntimeDir = MANAGED_RUNTIME_DIR) {
  const raw = String(value || "").trim();
  if (raw === "managed") return join(resolve(managedRuntimeDir), "models");
  if (!raw) return isAbsolute(binary) ? join(dirname(binary), "models") : null;
  if (!isAbsolute(raw) || raw.length > 500 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("Invalid Real-ESRGAN model directory configuration.");
  }
  return raw;
}

function resolveCommandPath(binary) {
  if (isAbsolute(binary)) return binary;
  const result = spawnSync("which", [binary], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function probeRealEsrganRuntime({ binary, modelDir, model }) {
  const resolvedBinary = resolveCommandPath(binary);
  if (!resolvedBinary || !existsSync(resolvedBinary)) {
    return { available: false, binary, modelDir, reason: "runtime_missing" };
  }
  try {
    accessSync(resolvedBinary, constants.X_OK);
  } catch {
    return { available: false, binary: resolvedBinary, modelDir, reason: "runtime_not_executable" };
  }
  const resolvedModelDir = modelDir || join(dirname(resolvedBinary), "models");
  const modelFilesPresent = ["param", "bin"].every((extension) => (
    existsSync(join(resolvedModelDir, `${model}.${extension}`))
  ));
  return {
    available: modelFilesPresent,
    binary: resolvedBinary,
    modelDir: resolvedModelDir,
    reason: modelFilesPresent ? null : "model_files_missing",
  };
}

function safeAbsolutePath(value, fallback, label) {
  const requested = String(value || fallback).trim();
  if ((value && !isAbsolute(requested)) || requested.length > 500 || /[\u0000-\u001f\u007f]/.test(requested)) {
    throw new Error(`Invalid ${label} configuration.`);
  }
  return resolve(requested);
}

function enumSetting(value, fallback, allowed, label) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Invalid ${label} configuration.`);
  return normalized;
}

function probePythonRealEsrganRuntime({ binary, modelPath, adapterPath }) {
  const resolvedBinary = resolveCommandPath(binary);
  if (!resolvedBinary || !existsSync(resolvedBinary)) {
    return { available: false, binary, modelPath, adapterPath, reason: "runtime_missing" };
  }
  try {
    accessSync(resolvedBinary, constants.X_OK);
  } catch {
    return { available: false, binary: resolvedBinary, modelPath, adapterPath, reason: "runtime_not_executable" };
  }
  if (!existsSync(adapterPath)) {
    return { available: false, binary: resolvedBinary, modelPath, adapterPath, reason: "adapter_missing" };
  }
  if (!existsSync(modelPath)) {
    return { available: false, binary: resolvedBinary, modelPath, adapterPath, reason: "model_files_missing" };
  }
  return { available: true, binary: resolvedBinary, modelPath, adapterPath, reason: null };
}

function videoEnhancementConfig(env = process.env, options = {}) {
  const provider = String(env.SHORTSENGINE_VIDEO_ENHANCEMENT_PROVIDER || "realesrgan-python").trim().toLowerCase();
  const model = String(env.SHORTSENGINE_REALESRGAN_MODEL || "realesrgan-x4plus").trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error("Invalid video enhancement provider configuration.");
  if (!MODELS.includes(model)) throw new Error("Invalid Real-ESRGAN model configuration.");
  const managedRuntimeDir = resolve(options.managedRuntimeDir || MANAGED_RUNTIME_DIR);
  const pythonProvider = provider === "realesrgan-python";
  if (pythonProvider && model !== "realesrgan-x4plus") {
    throw new Error("The Python Real-ESRGAN provider supports only realesrgan-x4plus.");
  }
  const binary = pythonProvider
    ? safeCommand(env.SHORTSENGINE_REALESRGAN_PYTHON_BIN || MANAGED_PYTHON_BIN, managedRuntimeDir)
    : safeCommand(env.SHORTSENGINE_REALESRGAN_BIN, managedRuntimeDir);
  const modelDir = pythonProvider ? null : safeModelDir(env.SHORTSENGINE_REALESRGAN_MODEL_DIR, binary, managedRuntimeDir);
  const modelPath = pythonProvider
    ? safeAbsolutePath(env.SHORTSENGINE_REALESRGAN_MODEL_PATH, MANAGED_PYTHON_MODEL, "Real-ESRGAN model path")
    : null;
  const adapterPath = pythonProvider
    ? safeAbsolutePath(options.pythonAdapterPath, PYTHON_ADAPTER_PATH, "Real-ESRGAN adapter path")
    : null;
  const mode = enhancementMode(env.SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED);
  const runtimeProbe = options.runtimeProbe || (pythonProvider ? probePythonRealEsrganRuntime : probeRealEsrganRuntime);
  const runtime = runtimeProbe({ binary, modelDir, modelPath, adapterPath, model });
  return Object.freeze({
    mode,
    required: booleanSetting(env.SHORTSENGINE_VIDEO_ENHANCEMENT_REQUIRED, false, "video enhancement requirement"),
    enabled: mode === "enabled" || (mode === "auto" && runtime.available),
    autoDetected: mode === "auto" && runtime.available,
    runtimeAvailable: runtime.available,
    unavailableReason: runtime.reason,
    provider,
    runtimeSource: binary.startsWith(`${resolve(process.cwd(), "var", "runtimes")}/`)
      ? "managed"
      : isAbsolute(binary) ? "configured" : "path",
    binary: runtime.available ? runtime.binary : binary,
    modelDir: runtime.available ? runtime.modelDir : modelDir,
    modelPath: runtime.available ? runtime.modelPath : modelPath,
    adapterPath: runtime.available ? runtime.adapterPath : adapterPath,
    model,
    scale: boundedInteger(env.SHORTSENGINE_REALESRGAN_SCALE, 4, 2, 6, "Real-ESRGAN scale"),
    tile: boundedInteger(env.SHORTSENGINE_REALESRGAN_TILE, 0, 0, 2048, "Real-ESRGAN tile"),
    fps: boundedInteger(env.SHORTSENGINE_VIDEO_ENHANCEMENT_FPS, 12, 12, 60, "video enhancement FPS"),
    device: enumSetting(
      env.SHORTSENGINE_REALESRGAN_DEVICE,
      "auto",
      ["auto", "mps", "cpu"],
      "Real-ESRGAN device",
    ),
    timeoutMs: boundedInteger(
      env.SHORTSENGINE_VIDEO_ENHANCEMENT_TIMEOUT_MS,
      2 * 60 * 1000,
      1000,
      60 * 60 * 1000,
      "video enhancement timeout",
    ),
  });
}

function inspectEnhancedFrames(inputFrames, outputFrames) {
  const count = (directory) => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name)).length;
  return { inputCount: count(inputFrames), outputCount: count(outputFrames) };
}

function runEnhancerCommand(binary, args, { signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    let killTimer = null;
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-2000);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", abort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const kill = (name) => {
      if (child.killed) return;
      try {
        child.kill(name);
      } catch {
        // The process may have exited between the state check and kill call.
      }
    };
    const timeout = setTimeout(() => {
      kill("SIGKILL");
      settle(reject, new AppError("VIDEO_ENHANCEMENT_FAILED", "Video enhancement timed out.", 500));
    }, timeoutMs);
    const abort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      settle(reject, new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => {
      settle(reject, new AppError(
        "VIDEO_ENHANCER_MISSING",
        "Real-ESRGAN is enabled but its runtime is unavailable.",
        503,
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) settle(resolve, { output });
      else settle(reject, new AppError(
        "VIDEO_ENHANCEMENT_FAILED",
        "Real-ESRGAN could not enhance the video.",
        500,
      ));
    });
  });
}

async function enhanceVisualLayer({
  inputPath,
  outputPath,
  workDir,
  signal,
  ffmpegRunner,
  commandRunner = runEnhancerCommand,
  frameInspector = inspectEnhancedFrames,
  config = videoEnhancementConfig(),
}) {
  if (!config.enabled) {
    return { enabled: false, applied: false, provider: "none", scale: 1, model: null };
  }
  if (typeof ffmpegRunner !== "function") throw new Error("ffmpegRunner is required for video enhancement.");
  const inputFrames = join(workDir, "frames-in");
  const outputFrames = join(workDir, "frames-out");
  mkdirSync(inputFrames, { recursive: true });
  mkdirSync(outputFrames, { recursive: true });

  await ffmpegRunner([
    "-y",
    "-i",
    inputPath,
    "-vsync",
    "0",
    join(inputFrames, "%08d.png"),
  ], { signal, timeoutMs: config.timeoutMs });

  const enhancerArgs = config.provider === "realesrgan-python"
    ? [
        config.adapterPath,
        "--input-dir", inputFrames,
        "--output-dir", outputFrames,
        "--model-path", config.modelPath,
        "--scale", String(config.scale),
        "--tile", String(config.tile),
        "--device", config.device,
      ]
    : [
        "-i", inputFrames,
        "-o", outputFrames,
        ...(config.modelDir ? ["-m", config.modelDir] : []),
        "-n", config.model,
        "-s", String(config.scale),
        "-t", String(config.tile),
        "-f", "png",
      ];
  await commandRunner(config.binary, enhancerArgs, { signal, timeoutMs: config.timeoutMs });

  const frameCounts = frameInspector(inputFrames, outputFrames);
  if (!Number.isInteger(frameCounts.inputCount) || frameCounts.inputCount < 1 || frameCounts.inputCount !== frameCounts.outputCount) {
    throw new AppError("VIDEO_ENHANCEMENT_INCOMPLETE", "Real-ESRGAN returned an incomplete frame sequence.", 500);
  }

  await ffmpegRunner([
    "-y",
    "-framerate",
    String(config.fps),
    "-i",
    join(outputFrames, "%08d.png"),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-qp",
    "0",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ], { signal, timeoutMs: config.timeoutMs });

  return {
    enabled: true,
    applied: true,
    provider: config.provider,
    model: config.model,
    scale: config.scale,
    fps: config.fps,
    temporalMode: "frame_independent",
    overlayProtection: "compose_after_enhancement",
    enhancedFrameCount: frameCounts.outputCount,
    device: config.provider === "realesrgan-python" ? config.device : "vulkan",
  };
}

module.exports = {
  enhanceVisualLayer,
  inspectEnhancedFrames,
  probePythonRealEsrganRuntime,
  probeRealEsrganRuntime,
  runEnhancerCommand,
  videoEnhancementConfig,
};
