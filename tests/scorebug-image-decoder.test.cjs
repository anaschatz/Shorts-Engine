const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { decodeScorebugCrop, detectImageFormat } = require("../server/scorebug-image-decoder.cjs");
const { safeResolve } = require("../server/storage.cjs");

function createFixtureDir(name) {
  const dir = safeResolve(CONFIG.stagingDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakePng(filePath) {
  writeFileSync(filePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
}

function writeTinyPgm(filePath) {
  const width = 16;
  const height = 16;
  const pixels = Array.from({ length: width * height }, (_, index) => (index % 2 ? 255 : 0));
  writeFileSync(filePath, `P2\n${width} ${height}\n255\n${pixels.join(" ")}\n`, "utf8");
}

test("scorebug image decoder converts staging PNG crops through mocked ffmpeg", async () => {
  const dir = createFixtureDir("scorebug-decoder-png");
  let outputPath = null;
  try {
    const cropPath = join(dir, "scorebug.png");
    writeFakePng(cropPath);
    const result = await decodeScorebugCrop({
      cropPath,
      outputDir: dir,
      ffmpegRunner: async (args) => {
        assert.deepEqual(args.slice(0, 4), ["-y", "-i", cropPath, "-vf"]);
        assert.equal(args.includes("|"), false);
        outputPath = args[args.length - 1];
        writeTinyPgm(outputPath);
      },
    });

    assert.equal(result.status, "decoded");
    assert.equal(result.imageFormat, "png");
    assert.equal(result.decoderMode, "ffmpeg-pgm");
    assert.equal(result.width, 16);
    assert.equal(result.height, 16);
    assert.equal(result.pixels.length, 256);
    assert.equal(outputPath ? existsSync(outputPath) : false, false);
    assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|localPath|stdout|stderr|token|secret/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scorebug image decoder rejects unsafe paths and unsupported formats", async () => {
  const dir = createFixtureDir("scorebug-decoder-safe");
  try {
    const cropPath = join(dir, "scorebug.txt");
    writeFileSync(cropPath, "not an image", "utf8");
    assert.equal(detectImageFormat(Buffer.from("not an image")), "unknown");
    const unsupported = await decodeScorebugCrop({
      cropPath,
      outputDir: dir,
      ffmpegRunner: async () => {
        throw new Error("should not run");
      },
    });
    assert.equal(unsupported.status, "unsupported");
    assert.ok(unsupported.reasons.includes("unsupported_image_format"));

    await assert.rejects(
      decodeScorebugCrop({ cropPath: "/tmp/not-staging.png", outputDir: dir }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scorebug image decoder fails closed on missing ffmpeg, timeout and corrupt decoded output", async () => {
  const dir = createFixtureDir("scorebug-decoder-failures");
  try {
    const cropPath = join(dir, "scorebug.png");
    writeFakePng(cropPath);

    const missing = await decodeScorebugCrop({
      cropPath,
      outputDir: dir,
      ffmpegRunner: async () => {
        const error = new Error("ffmpeg missing /Users/example");
        error.code = "FFMPEG_MISSING";
        throw error;
      },
    });
    assert.equal(missing.status, "unreadable");
    assert.ok(missing.reasons.includes("image_decoder_unavailable"));

    const timeout = await decodeScorebugCrop({
      cropPath,
      outputDir: dir,
      timeout: 5,
      ffmpegRunner: () => new Promise(() => {}),
    });
    assert.equal(timeout.status, "unreadable");
    assert.ok(timeout.reasons.includes("image_decoder_timeout"));

    const corrupt = await decodeScorebugCrop({
      cropPath,
      outputDir: dir,
      ffmpegRunner: async (args) => {
        writeFileSync(args[args.length - 1], "bad pgm", "utf8");
      },
    });
    assert.equal(corrupt.status, "unreadable");
    assert.ok(corrupt.reasons.includes("image_decoder_failed_closed"));
    assert.doesNotMatch(JSON.stringify({ missing, timeout, corrupt }), /\/Users|\/private|stdout|stderr|token|secret/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
