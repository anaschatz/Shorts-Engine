const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { AppError } = require("../../../errors.cjs");

const DEFAULT_MOTION_THRESHOLD = 0.0002;

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

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * ratio;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function normalizedRanges(input, field) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((range) => !range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.startFrame < 0 || range.endFrame <= range.startFrame)) throw new AppError("ANIMATION_QA_FAILED", `Animation ${field} ranges are invalid.`, 500);
  return input.map((range, index) => ({ id: typeof range.id === "string" && range.id ? range.id : `${field}_${index}`, startFrame: range.startFrame, endFrame: range.endFrame }));
}

function analyzeConsecutiveFrames(buffer, width, height, options = {}) {
  const frameBytes = width * height;
  if (!Buffer.isBuffer(buffer) || !frameBytes || buffer.length % frameBytes !== 0) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark frames are invalid.", 500);
  const count = buffer.length / frameBytes;
  if (count < 2) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark requires consecutive frames.", 500);
  const threshold = options.motionThreshold === undefined ? DEFAULT_MOTION_THRESHOLD : Number(options.motionThreshold);
  const rollingWindowFrames = options.rollingWindowFrames === undefined ? Math.min(51, count - 1) : options.rollingWindowFrames;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1 || !Number.isInteger(rollingWindowFrames) || rollingWindowFrames < 2 || rollingWindowFrames > count) throw new AppError("ANIMATION_QA_FAILED", "Animation motion analysis options are invalid.", 500);
  const holds = normalizedRanges(options.readabilityHolds, "readability_hold");
  const segments = normalizedRanges(options.segments, "segment");
  const mask = options.mask;
  if (mask !== undefined && (!Buffer.isBuffer(mask) || mask.length !== frameBytes)) throw new AppError("ANIMATION_QA_FAILED", "Animation semantic mask is invalid.", 500);
  let selectedPixels = frameBytes;
  if (mask) {
    selectedPixels = 0;
    for (const value of mask) if (value) selectedPixels += 1;
    if (!selectedPixels) throw new AppError("ANIMATION_QA_FAILED", "Animation semantic mask is empty.", 500);
  }
  const isHeld = (frame) => holds.some((range) => frame >= range.startFrame && frame < range.endFrame);
  const hashes = [], means = [], energies = [];
  let previous = null;
  for (let index = 0; index < count; index += 1) {
    const frame = buffer.subarray(index * frameBytes, (index + 1) * frameBytes);
    hashes.push(createHash("sha256").update(frame).digest("hex"));
    let sum = 0, difference = 0;
    for (let pixel = 0; pixel < frame.length; pixel += 1) {
      if (mask && !mask[pixel]) continue;
      sum += frame[pixel];
      if (previous) difference += Math.abs(frame[pixel] - previous[pixel]);
    }
    means.push(sum / selectedPixels);
    if (previous) energies.push(difference / (selectedPixels * 255));
    previous = frame;
  }
  const activeTransitions = energies.map((energy, index) => ({ energy, frame: index + 1 })).filter((entry) => !isHeld(entry.frame));
  const activeEnergies = activeTransitions.map((entry) => entry.energy);
  const firstMeaningful = energies.findIndex((energy) => energy >= threshold);
  let currentStasis = 0, maxContiguousStasisFrames = 0;
  for (let index = 0; index < energies.length; index += 1) {
    const frame = index + 1;
    if (isHeld(frame)) { currentStasis = 0; continue; }
    if (energies[index] < threshold) {
      currentStasis += 1;
      maxContiguousStasisFrames = Math.max(maxContiguousStasisFrames, currentStasis);
    } else currentStasis = 0;
  }
  const totalActiveEnergy = activeEnergies.reduce((sum, value) => sum + value, 0);
  const rollingShare = (transform) => {
    const transformed = energies.map(transform);
    const total = transformed.reduce((sum, value, index) => sum + (isHeld(index + 1) ? 0 : value), 0);
    let maximum = 0, startFrame = 0;
    for (let start = 0; start <= transformed.length - rollingWindowFrames; start += 1) {
      let windowEnergy = 0;
      for (let offset = 0; offset < rollingWindowFrames; offset += 1) {
        const frame = start + offset + 1;
        if (!isHeld(frame)) windowEnergy += transformed[start + offset];
      }
      if (windowEnergy > maximum) { maximum = windowEnergy; startFrame = start + 1; }
    }
    return { share: total > 0 ? maximum / total : 0, startFrame, endFrame: startFrame + rollingWindowFrames - 1 };
  };
  const rawWindow = rollingShare((energy) => energy);
  const perceptualWindow = rollingShare((energy) => Math.sqrt(energy));
  const peakMotionEnergy = Math.max(...energies);
  const peakMotionFrame = energies.indexOf(peakMotionEnergy) + 1;
  const segmentMetrics = segments.map((segment) => {
    const entries = activeTransitions.filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame);
    const values = entries.map((entry) => entry.energy);
    return Object.freeze({ id: segment.id, startFrame: segment.startFrame, endFrame: segment.endFrame, transitionCount: values.length, totalMotionEnergy: values.reduce((sum, value) => sum + value, 0), meanMotionEnergy: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), stasisRatio: values.filter((value) => value < threshold).length / Math.max(1, values.length) });
  });
  const consecutiveStasisRatio = activeEnergies.filter((value) => value < threshold).length / Math.max(1, activeEnergies.length);
  const meanMotionEnergy = totalActiveEnergy / Math.max(1, activeEnergies.length);
  return Object.freeze({
    frameCount: count,
    transitionCount: energies.length,
    analyzedTransitionCount: activeEnergies.length,
    excludedReadabilityHoldTransitions: energies.length - activeEnergies.length,
    semanticPixelCount: selectedPixels,
    motionThreshold: threshold,
    firstMeaningfulMotionFrame: firstMeaningful < 0 ? null : firstMeaningful + 1,
    consecutiveStasisRatio,
    maxContiguousStasisFrames,
    meanMotionEnergy,
    motionEnergyP50: percentile(activeEnergies, 0.5),
    motionEnergyP90: percentile(activeEnergies, 0.9),
    motionEnergyP99: percentile(activeEnergies, 0.99),
    peakMotionEnergy,
    peakMotionFrame,
    segmentMetrics,
    rollingWindowFrames,
    windowEnergyTransform: "sqrt",
    maxWindowMotionShare: perceptualWindow.share,
    maxWindowStartFrame: perceptualWindow.startFrame,
    maxWindowEndFrame: perceptualWindow.endFrame,
    rawMaxWindowMotionShare: rawWindow.share,
    rawMaxWindowStartFrame: rawWindow.startFrame,
    rawMaxWindowEndFrame: rawWindow.endFrame,
    uniqueFrameRatio: new Set(hashes).size / count,
    changedTransitionRatio: activeEnergies.filter((value) => value >= threshold).length / Math.max(1, activeEnergies.length),
    meanLuma: means.reduce((sum, value) => sum + value, 0) / means.length,
    sampleHashes: hashes,
    sampleCount: count,
    stasisRatio: consecutiveStasisRatio,
    motionEnergy: meanMotionEnergy,
  });
}

function analyzeSampleFrames(buffer, width, height, options = {}) {
  return analyzeConsecutiveFrames(buffer, width, height, options);
}

function normalizedRoi(roi, technical) {
  if (roi === undefined || roi === null) return null;
  if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)) throw new AppError("ANIMATION_QA_FAILED", "Animation semantic ROI is invalid.", 500);
  const x = Math.max(0, Math.round(roi.x)), y = Math.max(0, Math.round(roi.y));
  const width = Math.min(technical.width - x, Math.round(roi.width)), height = Math.min(technical.height - y, Math.round(roi.height));
  if (width < 32 || height < 32 || x + width > technical.width || y + height > technical.height) throw new AppError("ANIMATION_QA_FAILED", "Animation semantic ROI is outside the video.", 500);
  return { x, y, width, height };
}

function extractConsecutiveMotionMetrics(outputPath, options = {}) {
  const technical = options.technical || probeVisualMaster(outputPath);
  const roi = normalizedRoi(options.semanticRoi, technical);
  const width = 180;
  const height = roi ? Math.max(2, Math.round((width * roi.height / roi.width) / 2) * 2) : 320;
  const crop = roi ? `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y},` : "";
  const raw = run("ffmpeg", ["-v", "error", "-i", outputPath, "-vf", `${crop}scale=${width}:${height}:flags=area,format=gray`, "-vsync", "0", "-f", "rawvideo", "-"], { binary: true, maxBuffer: 256 * 1024 * 1024 });
  return analyzeConsecutiveFrames(raw, width, height, options);
}

function extractSampleMetrics(outputPath, everyFrames = 10) {
  const width = 180, height = 320;
  const raw = run("ffmpeg", ["-v", "error", "-i", outputPath, "-vf", `select=not(mod(n\\,${everyFrames})),scale=${width}:${height}:flags=area,format=gray`, "-vsync", "0", "-f", "rawvideo", "-"], { binary: true, maxBuffer: 256 * 1024 * 1024 });
  return analyzeConsecutiveFrames(raw, width, height, { rollingWindowFrames: Math.min(10, Math.max(2, Math.floor(raw.length / (width * height)) - 1)) });
}

function writeContactSheet(outputPath, contactSheetPath) {
  run("ffmpeg", ["-y", "-v", "error", "-i", outputPath, "-vf", "select=not(mod(n\\,30)),scale=180:320:flags=lanczos,tile=5x2:padding=6:margin=6:color=0x030712", "-frames:v", "1", contactSheetPath]);
  if (!existsSync(contactSheetPath)) throw new AppError("ANIMATION_QA_FAILED", "Animation contact sheet was not created.", 500);
}

function frameSelectExpression(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 24 || frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame > 10000)) throw new AppError("ANIMATION_QA_FAILED", "Animation checkpoint frames are invalid.", 500);
  return frames.map((frame) => `eq(n\\,${frame})`).join("+");
}

function extractCheckpointMetrics(outputPath, frames) {
  const width = 180, height = 320;
  const raw = run("ffmpeg", ["-v", "error", "-i", outputPath, "-vf", `select=${frameSelectExpression(frames)},scale=${width}:${height}:flags=area,format=gray`, "-vsync", "0", "-f", "rawvideo", "-"], { binary: true, maxBuffer: 128 * 1024 * 1024 });
  const metrics = analyzeConsecutiveFrames(raw, width, height, { rollingWindowFrames: Math.min(6, Math.max(2, frames.length - 1)) });
  if (metrics.sampleCount !== frames.length) throw new AppError("ANIMATION_QA_FAILED", "Animation checkpoint extraction is incomplete.", 500);
  return metrics;
}

function extractRangeMotion(outputPath, startFrame, endFrame) {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) throw new AppError("ANIMATION_QA_FAILED", "Animation motion range is invalid.", 500);
  const width = 180, height = 320;
  const raw = run("ffmpeg", ["-v", "error", "-i", outputPath, "-vf", `select=between(n\\,${startFrame}\\,${endFrame}),scale=${width}:${height}:flags=area,format=gray`, "-vsync", "0", "-f", "rawvideo", "-"], { binary: true, maxBuffer: 128 * 1024 * 1024 });
  return analyzeConsecutiveFrames(raw, width, height, { rollingWindowFrames: Math.min(10, Math.max(2, endFrame - startFrame)) });
}

function writeCheckpointContactSheet(outputPath, contactSheetPath, frames) {
  const columns = Math.min(7, frames.length), rows = Math.ceil(frames.length / columns);
  run("ffmpeg", ["-y", "-v", "error", "-i", outputPath, "-vf", `select=${frameSelectExpression(frames)},scale=180:320:flags=lanczos,tile=${columns}x${rows}:padding=6:margin=6:color=0x030712`, "-frames:v", "1", contactSheetPath]);
  if (!existsSync(contactSheetPath)) throw new AppError("ANIMATION_QA_FAILED", "Animation checkpoint sheet was not created.", 500);
}

function evaluateMotionQuality(motion, limits = {}) {
  const firstMotionFrame = limits.firstMotionFrame ?? 6;
  const maximumStasisRatio = limits.maximumStasisRatio ?? 0.20;
  const maximumContiguousStasisFrames = limits.maximumContiguousStasisFrames ?? 15;
  const maximumWindowMotionShare = limits.maximumWindowMotionShare ?? 0.40;
  return Object.freeze({
    semanticMotion: motion.firstMeaningfulMotionFrame !== null,
    immediateHook: motion.firstMeaningfulMotionFrame !== null && motion.firstMeaningfulMotionFrame <= firstMotionFrame,
    consecutiveStasis: motion.consecutiveStasisRatio < maximumStasisRatio,
    contiguousStasis: motion.maxContiguousStasisFrames <= maximumContiguousStasisFrames,
    balancedMotion: motion.maxWindowMotionShare <= maximumWindowMotionShare,
  });
}

function runBenchmarkQa(input) {
  const technical = probeVisualMaster(input.outputPath);
  const geometry = input.geometryAudit || { passed: false, clippedEntities: [], captionSafeZoneViolations: [], semanticRoi: null };
  const motion = extractConsecutiveMotionMetrics(input.outputPath, { technical, semanticRoi: geometry.semanticRoi, readabilityHolds: input.readabilityHolds || [], segments: input.segments || [], motionThreshold: input.motionThreshold, rollingWindowFrames: 51 });
  const expectedFrames = input.expectedFrameCount || 300, expectedFps = input.expectedFps || 30;
  const checks = {
    exactFrames: technical.frameCount === expectedFrames,
    frameRate: Math.abs(technical.fps - expectedFps) < 0.001,
    dimensions: technical.width === input.width && technical.height === input.height,
    h264Yuv420p: technical.codec === "h264" && technical.pixelFormat === "yuv420p",
    duration: Math.abs(technical.durationSeconds - expectedFrames / expectedFps) < 0.04,
    readableNonBlack: motion.meanLuma > 4,
    ...evaluateMotionQuality(motion),
    geometryAudit: geometry.passed === true,
    captionSafeZone: Array.isArray(geometry.captionSafeZoneViolations) && geometry.captionSafeZoneViolations.length === 0,
    clipping: Array.isArray(geometry.clippedEntities) && geometry.clippedEntities.length === 0,
  };
  return Object.freeze({ passed: Object.values(checks).every(Boolean), checks, technical, motion, samples: motion, geometryAudit: geometry, captionSafeZoneViolations: geometry.captionSafeZoneViolations?.length || 0, clippedEntities: geometry.clippedEntities?.length || 0 });
}

module.exports = { DEFAULT_MOTION_THRESHOLD, analyzeConsecutiveFrames, analyzeSampleFrames, evaluateMotionQuality, extractCheckpointMetrics, extractConsecutiveMotionMetrics, extractRangeMotion, extractSampleMetrics, probeVisualMaster, runBenchmarkQa, writeCheckpointContactSheet, writeContactSheet };
