import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CONFIG } = require("../server/config.cjs");
const { commandAvailable } = require("../server/media.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = resolve(ROOT_DIR, "demo", "fixtures");
const DEFAULT_FIXTURE_NAME = "shortsengine-demo-source.mp4";
const DEFAULT_FIXTURE_PATH = resolve(FIXTURE_DIR, DEFAULT_FIXTURE_NAME);
const DEFAULT_DURATION_SECONDS = 9;

function relativeFromRoot(filePath) {
  return relative(ROOT_DIR, filePath).replace(/\\/g, "/");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fixtureMetadata(filePath = DEFAULT_FIXTURE_PATH) {
  if (!existsSync(filePath)) {
    return {
      exists: false,
      fileName: DEFAULT_FIXTURE_NAME,
      relativePath: relativeFromRoot(filePath),
      sizeBytes: 0,
      sha256: null,
      durationSeconds: DEFAULT_DURATION_SECONDS,
    };
  }
  const stat = statSync(filePath);
  return {
    exists: true,
    fileName: DEFAULT_FIXTURE_NAME,
    relativePath: relativeFromRoot(filePath),
    sizeBytes: stat.size,
    sha256: sha256File(filePath),
    durationSeconds: DEFAULT_DURATION_SECONDS,
  };
}

function buildFfmpegFixtureArgs(outputPath = DEFAULT_FIXTURE_PATH, durationSeconds = DEFAULT_DURATION_SECONDS) {
  const duration = Math.max(5, Math.min(15, Number(durationSeconds) || DEFAULT_DURATION_SECONDS));
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1280x720:rate=30:duration=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=880:sample_rate=44100:duration=${duration}`,
    "-t",
    String(duration),
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function ensureDemoFixture(options = {}) {
  const outputPath = resolve(options.outputPath || DEFAULT_FIXTURE_PATH);
  const force = Boolean(options.force);
  const ffmpegBin = options.ffmpegBin || CONFIG.ffmpegBin;
  const durationSeconds = options.durationSeconds || DEFAULT_DURATION_SECONDS;
  if (!force && existsSync(outputPath)) {
    return { ok: true, generated: false, fixture: fixtureMetadata(outputPath), error: null };
  }
  if (!commandAvailable(ffmpegBin)) {
    return {
      ok: false,
      generated: false,
      fixture: fixtureMetadata(outputPath),
      error: { code: "FFMPEG_MISSING", message: "FFmpeg is required to generate the demo fixture." },
    };
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const result = spawnSync(ffmpegBin, buildFfmpegFixtureArgs(outputPath, durationSeconds), {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0 || !existsSync(outputPath)) {
    return {
      ok: false,
      generated: false,
      fixture: fixtureMetadata(outputPath),
      error: { code: "FIXTURE_GENERATION_FAILED", message: "Could not generate the demo video fixture." },
    };
  }
  return { ok: true, generated: true, fixture: fixtureMetadata(outputPath), error: null };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const force = process.argv.includes("--force");
  const result = ensureDemoFixture({ force });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

export {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_FIXTURE_NAME,
  DEFAULT_FIXTURE_PATH,
  FIXTURE_DIR,
  ROOT_DIR,
  buildFfmpegFixtureArgs,
  ensureDemoFixture,
  fixtureMetadata,
  relativeFromRoot,
};
