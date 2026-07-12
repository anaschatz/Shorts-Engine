const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { AppError } = require("../../../errors.cjs");

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: options.binary ? null : "utf8", maxBuffer: options.maxBuffer || 128 * 1024 * 1024, timeout: options.timeout || 120000 });
  if (result.status !== 0) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark QA failed safely.", 500);
  return result.stdout;
}

function probeVisualMaster(outputPath) {
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames:format=duration", "-of", "json", outputPath]));
  const video = (probe.streams || [])[0] || {};
  const [num, den] = String(video.avg_frame_rate || "0/1").split("/").map(Number);
  return { codec: video.codec_name || null, pixelFormat: video.pix_fmt || null, width: Number(video.width), height: Number(video.height), fps: den ? num / den : 0, frameCount: Number(video.nb_read_frames), durationSeconds: Number(probe.format?.duration) };
}

function analyzeSampleFrames(buffer, width, height) {
  const frameBytes = width * height;
  if (!Buffer.isBuffer(buffer) || !frameBytes || buffer.length % frameBytes !== 0) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark samples are invalid.", 500);
  const count = buffer.length / frameBytes;
  const hashes = [], means = [], energies = [];
  let previous = null;
  for (let index = 0; index < count; index += 1) {
    const frame = buffer.subarray(index * frameBytes, (index + 1) * frameBytes);
    hashes.push(createHash("sha256").update(frame).digest("hex"));
    let sum = 0, difference = 0;
    for (let pixel = 0; pixel < frame.length; pixel += 1) { sum += frame[pixel]; if (previous) difference += Math.abs(frame[pixel] - previous[pixel]); }
    means.push(sum / frame.length);
    if (previous) energies.push(difference / (frame.length * 255));
    previous = frame;
  }
  const changed = energies.filter((value) => value > 0.00002).length;
  const stasis = energies.filter((value) => value < 0.0002).length;
  return Object.freeze({ sampleCount: count, sampleHashes: hashes, uniqueFrameRatio: new Set(hashes).size / Math.max(1, count), changedTransitionRatio: changed / Math.max(1, energies.length), stasisRatio: stasis / Math.max(1, energies.length), motionEnergy: energies.reduce((sum, value) => sum + value, 0) / Math.max(1, energies.length), meanLuma: means.reduce((sum, value) => sum + value, 0) / Math.max(1, means.length) });
}

function extractSampleMetrics(outputPath, everyFrames = 10) {
  const width = 180, height = 320;
  const raw = run("ffmpeg", ["-v", "error", "-i", outputPath, "-vf", `select=not(mod(n\\,${everyFrames})),scale=${width}:${height}:flags=area,format=gray`, "-vsync", "0", "-f", "rawvideo", "-"], { binary: true, maxBuffer: 256 * 1024 * 1024 });
  return analyzeSampleFrames(raw, width, height);
}

function writeContactSheet(outputPath, contactSheetPath) {
  run("ffmpeg", ["-y", "-v", "error", "-i", outputPath, "-vf", "select=not(mod(n\\,30)),scale=180:320:flags=lanczos,tile=5x2:padding=6:margin=6:color=0x030712", "-frames:v", "1", contactSheetPath]);
  if (!existsSync(contactSheetPath)) throw new AppError("ANIMATION_QA_FAILED", "Animation contact sheet was not created.", 500);
}

function runBenchmarkQa(input) {
  const technical = probeVisualMaster(input.outputPath);
  const samples = extractSampleMetrics(input.outputPath, 10);
  const checks = {
    exactFrames: technical.frameCount === 300,
    frameRate: Math.abs(technical.fps - 30) < 0.001,
    dimensions: technical.width === input.width && technical.height === input.height,
    h264Yuv420p: technical.codec === "h264" && technical.pixelFormat === "yuv420p",
    duration: Math.abs(technical.durationSeconds - 10) < 0.04,
    readableNonBlack: samples.meanLuma > 4,
    sampledFrameDiversity: samples.changedTransitionRatio >= 0.9 && samples.uniqueFrameRatio >= 0.9,
    stasis: samples.stasisRatio < 0.15,
    motionEnergy: samples.motionEnergy > 0.0002,
    captionSafeZone: input.foregroundMaxY <= input.height * input.captionSafeTopRatio,
    clipping: input.clippedEntities === 0,
  };
  return Object.freeze({ passed: Object.values(checks).every(Boolean), checks, technical, samples, captionSafeZoneViolations: checks.captionSafeZone ? 0 : 1, clippedEntities: input.clippedEntities || 0 });
}

module.exports = { analyzeSampleFrames, extractSampleMetrics, probeVisualMaster, runBenchmarkQa, writeContactSheet };
