const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const {
  enhanceVisualLayer,
  videoEnhancementConfig,
} = require("../server/video-enhancement.cjs");

test("video enhancement defaults to automatic detection with conservative football settings", () => {
  const config = videoEnhancementConfig({}, {
    runtimeProbe: ({ binary, modelDir }) => ({ available: false, binary, modelDir, reason: "runtime_missing" }),
  });
  assert.equal(config.mode, "auto");
  assert.equal(config.required, false);
  assert.equal(config.enabled, false);
  assert.equal(config.autoDetected, false);
  assert.equal(config.provider, "realesrgan-python");
  assert.equal(config.model, "realesrgan-x4plus");
  assert.equal(config.scale, 4);
  assert.equal(config.fps, 12);
  assert.equal(config.timeoutMs, 120000);
});

test("automatic mode enables enhancement when binary and model files are detected", () => {
  const config = videoEnhancementConfig({}, {
    runtimeProbe: () => ({
      available: true,
      binary: "/opt/realesrgan/realesrgan-ncnn-vulkan",
      modelDir: "/opt/realesrgan/models",
      reason: null,
    }),
  });
  assert.equal(config.mode, "auto");
  assert.equal(config.enabled, true);
  assert.equal(config.autoDetected, true);
  assert.equal(config.binary, "/opt/realesrgan/realesrgan-ncnn-vulkan");
  assert.equal(config.modelDir, "/opt/realesrgan/models");
});

test("automatic mode discovers the managed NCNN runtime without absolute env paths", () => {
  const managedRuntimeDir = resolve("var/runtimes/realesrgan-test-runtime");
  const config = videoEnhancementConfig({
    SHORTSENGINE_REALESRGAN_BIN: "managed",
    SHORTSENGINE_VIDEO_ENHANCEMENT_PROVIDER: "realesrgan-ncnn",
  }, {
    managedRuntimeDir,
    runtimeProbe: ({ binary, modelDir }) => ({ available: true, binary, modelDir, reason: null }),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.runtimeSource, "managed");
  assert.equal(config.binary, join(managedRuntimeDir, "realesrgan-ncnn-vulkan"));
  assert.equal(config.modelDir, join(managedRuntimeDir, "models"));
});

test("automatic mode discovers the managed Python Real-ESRGAN runtime", () => {
  const config = videoEnhancementConfig({}, {
    runtimeProbe: ({ binary, modelPath, adapterPath }) => ({
      available: true,
      binary,
      modelPath,
      adapterPath,
      reason: null,
    }),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "realesrgan-python");
  assert.equal(config.runtimeSource, "managed");
  assert.match(config.binary, /var\/runtimes\/realesrgan-venv310\/bin\/python3$/);
  assert.match(config.modelPath, /var\/runtimes\/models\/RealESRGAN_x4plus\.pth$/);
  assert.match(config.adapterPath, /tools\/realesrgan-enhance\.py$/);
});

test("absolute Real-ESRGAN runtime paths may contain spaces because execution never uses a shell", () => {
  const config = videoEnhancementConfig({
    SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED: "1",
    SHORTSENGINE_VIDEO_ENHANCEMENT_PROVIDER: "realesrgan-ncnn",
    SHORTSENGINE_REALESRGAN_BIN: "/opt/Short Form/realesrgan-ncnn-vulkan",
    SHORTSENGINE_REALESRGAN_MODEL_DIR: "/opt/Short Form/models",
  }, {
    runtimeProbe: ({ binary, modelDir }) => ({ available: true, binary, modelDir, reason: null }),
  });
  assert.equal(config.binary, "/opt/Short Form/realesrgan-ncnn-vulkan");
  assert.equal(config.modelDir, "/opt/Short Form/models");
});

test("Real-ESRGAN adapter extracts frames, runs NCNN, and rebuilds a lossless visual layer", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "shortsengine-enhancer-test-"));
  const ffmpegCalls = [];
  const enhancerCalls = [];
  const config = videoEnhancementConfig({
    SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED: "1",
    SHORTSENGINE_VIDEO_ENHANCEMENT_PROVIDER: "realesrgan-ncnn",
    SHORTSENGINE_REALESRGAN_BIN: "realesrgan-ncnn-vulkan",
    SHORTSENGINE_REALESRGAN_MODEL: "realesrgan-x4plus",
    SHORTSENGINE_REALESRGAN_SCALE: "2",
    SHORTSENGINE_REALESRGAN_TILE: "128",
    SHORTSENGINE_VIDEO_ENHANCEMENT_FPS: "30",
  });

  const result = await enhanceVisualLayer({
    inputPath: join(workDir, "clean.mkv"),
    outputPath: join(workDir, "enhanced.mkv"),
    workDir,
    config,
    ffmpegRunner: async (args) => ffmpegCalls.push(args),
    commandRunner: async (binary, args) => enhancerCalls.push({ binary, args }),
    frameInspector: () => ({ inputCount: 12, outputCount: 12 }),
  });

  assert.equal(ffmpegCalls.length, 2);
  assert.equal(enhancerCalls.length, 1);
  assert.equal(enhancerCalls[0].binary, "realesrgan-ncnn-vulkan");
  assert.equal(enhancerCalls[0].args[enhancerCalls[0].args.indexOf("-n") + 1], "realesrgan-x4plus");
  assert.equal(enhancerCalls[0].args[enhancerCalls[0].args.indexOf("-s") + 1], "2");
  assert.equal(enhancerCalls[0].args[enhancerCalls[0].args.indexOf("-t") + 1], "128");
  assert.equal(ffmpegCalls[1][ffmpegCalls[1].indexOf("-qp") + 1], "0");
  assert.deepEqual(result, {
    enabled: true,
    applied: true,
    provider: "realesrgan-ncnn",
    model: "realesrgan-x4plus",
    scale: 2,
    fps: 30,
    temporalMode: "frame_independent",
    overlayProtection: "compose_after_enhancement",
    enhancedFrameCount: 12,
    device: "vulkan",
  });
});

test("managed Python adapter uses safe argv and requires a complete output sequence", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "shortsengine-python-enhancer-test-"));
  const calls = [];
  const config = videoEnhancementConfig({
    SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED: "1",
  }, {
    runtimeProbe: ({ binary, modelPath, adapterPath }) => ({ available: true, binary, modelPath, adapterPath, reason: null }),
  });
  await assert.rejects(enhanceVisualLayer({
    inputPath: join(workDir, "clean.mkv"),
    outputPath: join(workDir, "enhanced.mkv"),
    workDir,
    config,
    ffmpegRunner: async () => {},
    commandRunner: async (binary, args) => calls.push({ binary, args }),
    frameInspector: () => ({ inputCount: 12, outputCount: 11 }),
  }), (error) => error && error.code === "VIDEO_ENHANCEMENT_INCOMPLETE");
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /realesrgan-enhance\.py$/);
  assert.ok(calls[0].args.includes("--model-path"));
  assert.ok(calls[0].args.includes("--device"));
});

test("video enhancement rejects unsupported models before spawning a process", () => {
  assert.throws(() => videoEnhancementConfig({
    SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED: "1",
    SHORTSENGINE_REALESRGAN_MODEL: "unknown-model",
  }), /Invalid Real-ESRGAN model/);
});

test("video enhancement requirement rejects ambiguous configuration", () => {
  assert.throws(() => videoEnhancementConfig({
    SHORTSENGINE_VIDEO_ENHANCEMENT_REQUIRED: "sometimes",
  }), /Invalid video enhancement requirement/);
});

test("Python Real-ESRGAN model configuration rejects relative operator paths", () => {
  assert.throws(() => videoEnhancementConfig({
    SHORTSENGINE_REALESRGAN_MODEL_PATH: "models/RealESRGAN_x4plus.pth",
  }), /Invalid Real-ESRGAN model path/);
});
