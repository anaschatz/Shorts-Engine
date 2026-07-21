const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { AppError } = require("../../../errors.cjs");

const DEFAULT_MOTION_THRESHOLD = 0.0002;
const TEMPORAL_MOTION_METRIC_PROFILE_ID =
  "dark_curiosity_luma_temporal_motion_v1";

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

function normalizedRanges(input, field, maximumFrame = null) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((range) => !range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.startFrame < 0 || range.endFrame <= range.startFrame || (maximumFrame !== null && range.endFrame > maximumFrame))) throw new AppError("ANIMATION_QA_FAILED", `Animation ${field} ranges are invalid.`, 500);
  return input.map((range, index) => ({ id: typeof range.id === "string" && range.id ? range.id : `${field}_${index}`, startFrame: range.startFrame, endFrame: range.endFrame }));
}

function temporalEntries(values, firstFrame, isHeld) {
  return values.map((energy, index) => ({
    energy,
    frame: index + firstFrame,
  })).filter((entry) => !isHeld(entry.frame));
}

function peak(values, firstFrame) {
  if (!values.length) return { energy: 0, frame: null };
  const energy = Math.max(...values);
  return { energy, frame: values.indexOf(energy) + firstFrame };
}

function peakEntries(entries) {
  if (!entries.length) return { energy: 0, frame: null };
  return entries.reduce((maximum, entry) => (
    entry.energy > maximum.energy ? entry : maximum
  ));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0)
    / Math.max(1, values.length);
}

function analyzeConsecutiveFrames(buffer, width, height, options = {}) {
  const frameBytes = width * height;
  if (!Buffer.isBuffer(buffer) || !frameBytes || buffer.length % frameBytes !== 0) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark frames are invalid.", 500);
  const count = buffer.length / frameBytes;
  if (count < 2) throw new AppError("ANIMATION_QA_FAILED", "Animation benchmark requires consecutive frames.", 500);
  const threshold = options.motionThreshold === undefined ? DEFAULT_MOTION_THRESHOLD : Number(options.motionThreshold);
  const rollingWindowFrames = options.rollingWindowFrames === undefined ? Math.min(51, count - 1) : options.rollingWindowFrames;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1 || !Number.isInteger(rollingWindowFrames) || rollingWindowFrames < 2 || rollingWindowFrames > count) throw new AppError("ANIMATION_QA_FAILED", "Animation motion analysis options are invalid.", 500);
  const holds = normalizedRanges(
    options.readabilityHolds,
    "readability_hold",
    count,
  );
  const segments = normalizedRanges(options.segments, "segment", count);
  if (
    new Set(segments.map((segment) => segment.id)).size !== segments.length
    || segments.some((segment, index) => (
      index > 0 && segment.startFrame < segments[index - 1].endFrame
    ))
  ) throw new AppError("ANIMATION_QA_FAILED", "Animation segment ranges are invalid.", 500);
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
  const accelerationEnergies = [], jerkEnergies = [];
  let previous = null;
  let previousVelocity = null;
  let previousAcceleration = null;
  for (let index = 0; index < count; index += 1) {
    const frame = buffer.subarray(index * frameBytes, (index + 1) * frameBytes);
    hashes.push(createHash("sha256").update(frame).digest("hex"));
    const velocity = previous ? new Int16Array(frameBytes) : null;
    const acceleration = previousVelocity
      ? new Int16Array(frameBytes)
      : null;
    let sum = 0, difference = 0, accelerationDifference = 0;
    let jerkDifference = 0;
    for (let pixel = 0; pixel < frame.length; pixel += 1) {
      if (mask && !mask[pixel]) continue;
      sum += frame[pixel];
      if (previous) {
        const currentVelocity = frame[pixel] - previous[pixel];
        velocity[pixel] = currentVelocity;
        difference += Math.abs(currentVelocity);
        if (previousVelocity) {
          const currentAcceleration = currentVelocity
            - previousVelocity[pixel];
          acceleration[pixel] = currentAcceleration;
          accelerationDifference += Math.abs(currentAcceleration);
          if (previousAcceleration) {
            jerkDifference += Math.abs(
              currentAcceleration - previousAcceleration[pixel],
            );
          }
        }
      }
    }
    means.push(sum / selectedPixels);
    if (previous) energies.push(difference / (selectedPixels * 255));
    if (previousVelocity) {
      accelerationEnergies.push(
        accelerationDifference / (selectedPixels * 510),
      );
    }
    if (previousAcceleration) {
      jerkEnergies.push(jerkDifference / (selectedPixels * 1020));
    }
    previous = frame;
    previousVelocity = velocity;
    previousAcceleration = acceleration;
  }
  const activeTransitions = temporalEntries(energies, 1, isHeld);
  const activeAccelerations = temporalEntries(
    accelerationEnergies,
    2,
    isHeld,
  );
  const activeJerks = temporalEntries(jerkEnergies, 3, isHeld);
  const activeEnergies = activeTransitions.map((entry) => entry.energy);
  const activeAccelerationEnergies = activeAccelerations.map(
    (entry) => entry.energy,
  );
  const activeJerkEnergies = activeJerks.map((entry) => entry.energy);
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
  const peakMotion = peak(energies, 1);
  const peakAcceleration = peakEntries(activeAccelerations);
  const peakJerk = peakEntries(activeJerks);
  const segmentMetrics = segments.map((segment) => {
    const entries = activeTransitions.filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame);
    const values = entries.map((entry) => entry.energy);
    const accelerationValues = activeAccelerations
      .filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame)
      .map((entry) => entry.energy);
    const jerkValues = activeJerks
      .filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame)
      .map((entry) => entry.energy);
    return Object.freeze({ id: segment.id, startFrame: segment.startFrame, endFrame: segment.endFrame, transitionCount: values.length, totalMotionEnergy: values.reduce((sum, value) => sum + value, 0), meanMotionEnergy: mean(values), stasisRatio: values.filter((value) => value < threshold).length / Math.max(1, values.length), meanAccelerationEnergy: mean(accelerationValues), accelerationEnergyP99: percentile(accelerationValues, 0.99), meanJerkEnergy: mean(jerkValues), jerkEnergyP99: percentile(jerkValues, 0.99), peakJerkEnergy: jerkValues.length ? Math.max(...jerkValues) : 0 });
  });
  const boundaryFrames = segments.slice(1).map((segment) => segment.startFrame);
  const boundaryMetrics = boundaryFrames.map((frame) => {
    const motionEnergy = energies[frame - 1] || 0;
    const accelerationEnergy = accelerationEnergies[frame - 2] || 0;
    const jerkEnergy = jerkEnergies[frame - 3] || 0;
    const local = activeTransitions.filter((entry) => (
      entry.frame >= Math.max(1, frame - 6)
      && entry.frame <= Math.min(count - 1, frame + 6)
      && entry.frame !== frame
    )).map((entry) => entry.energy);
    const localBaseline = percentile(local, 0.5);
    return Object.freeze({
      frame,
      motionEnergy,
      accelerationEnergy,
      jerkEnergy,
      localBaseline,
      jumpRatio: motionEnergy / Math.max(threshold, localBaseline),
    });
  });
  const consecutiveStasisRatio = activeEnergies.filter((value) => value < threshold).length / Math.max(1, activeEnergies.length);
  const meanMotionEnergy = totalActiveEnergy / Math.max(1, activeEnergies.length);
  return Object.freeze({
    temporalMetricProfileId: TEMPORAL_MOTION_METRIC_PROFILE_ID,
    temporalThresholdStatus: "provisional",
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
    peakMotionEnergy: peakMotion.energy,
    peakMotionFrame: peakMotion.frame,
    meanAccelerationEnergy: mean(activeAccelerationEnergies),
    analyzedAccelerationTransitionCount: activeAccelerationEnergies.length,
    accelerationEnergyP90: percentile(activeAccelerationEnergies, 0.9),
    accelerationEnergyP99: percentile(activeAccelerationEnergies, 0.99),
    peakAccelerationEnergy: peakAcceleration.energy,
    peakAccelerationFrame: peakAcceleration.frame,
    meanJerkEnergy: mean(activeJerkEnergies),
    analyzedJerkTransitionCount: activeJerkEnergies.length,
    jerkEnergyP90: percentile(activeJerkEnergies, 0.9),
    jerkEnergyP99: percentile(activeJerkEnergies, 0.99),
    peakJerkEnergy: peakJerk.energy,
    peakJerkFrame: peakJerk.frame,
    boundaryMetrics,
    maximumBoundaryJumpRatio: boundaryMetrics.length
      ? Math.max(...boundaryMetrics.map((entry) => entry.jumpRatio))
      : 0,
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

function evaluateTemporalMotionQuality(motion, limits = {}) {
  const maximumJerkP99 = limits.maximumJerkP99 ?? 0.18;
  const maximumPeakJerk = limits.maximumPeakJerk ?? 0.45;
  const maximumBoundaryJumpRatio = limits.maximumBoundaryJumpRatio ?? 30;
  if (
    ![maximumJerkP99, maximumPeakJerk, maximumBoundaryJumpRatio]
      .every(Number.isFinite)
    || maximumJerkP99 <= 0
    || maximumPeakJerk <= 0
    || maximumBoundaryJumpRatio <= 1
    || !motion
    || motion.temporalMetricProfileId !== TEMPORAL_MOTION_METRIC_PROFILE_ID
    || motion.temporalThresholdStatus !== "provisional"
    || ![
      motion.jerkEnergyP99,
      motion.peakJerkEnergy,
      motion.maximumBoundaryJumpRatio,
    ].every((value) => (
      Number.isFinite(value)
      && value >= 0
      && value <= Number.MAX_SAFE_INTEGER
      && !Object.is(value, -0)
    ))
    || motion.jerkEnergyP99 > 1
    || motion.peakJerkEnergy > 1
    || motion.jerkEnergyP99 > motion.peakJerkEnergy
    || !Number.isInteger(motion.analyzedJerkTransitionCount)
    || motion.analyzedJerkTransitionCount < 0
    || !Array.isArray(motion.boundaryMetrics)
    || !Array.isArray(motion.segmentMetrics)
  ) throw new AppError("ANIMATION_QA_FAILED", "Animation temporal motion evidence is invalid.", 500);
  const boundaryMetricsValid = motion.boundaryMetrics.every((entry, index) => (
    entry
    && Number.isInteger(entry.frame)
    && entry.frame >= 1
    && (index === 0 || entry.frame > motion.boundaryMetrics[index - 1].frame)
    && [
      entry.motionEnergy,
      entry.accelerationEnergy,
      entry.jerkEnergy,
      entry.localBaseline,
      entry.jumpRatio,
    ].every((value) => (
      Number.isFinite(value)
      && value >= 0
      && value <= Number.MAX_SAFE_INTEGER
      && !Object.is(value, -0)
    ))
  ));
  if (!boundaryMetricsValid) {
    throw new AppError("ANIMATION_QA_FAILED", "Animation temporal motion evidence is invalid.", 500);
  }
  const expectedBoundaryCount = Math.max(0, motion.segmentMetrics.length - 1);
  const boundaryMaximum = motion.boundaryMetrics.length
    ? Math.max(...motion.boundaryMetrics.map((entry) => entry.jumpRatio))
    : 0;
  if (
    motion.boundaryMetrics.length !== expectedBoundaryCount
    || Math.abs(boundaryMaximum - motion.maximumBoundaryJumpRatio) > 1e-12
  ) throw new AppError("ANIMATION_QA_FAILED", "Animation temporal motion evidence is invalid.", 500);
  const jerkEvidence = motion.analyzedJerkTransitionCount > 0;
  const sentenceBoundaryEvidence = expectedBoundaryCount > 0;
  return Object.freeze({
    temporalEvidence: jerkEvidence && sentenceBoundaryEvidence,
    jerkInRange: jerkEvidence
      && motion.jerkEnergyP99 <= maximumJerkP99
      && motion.peakJerkEnergy <= maximumPeakJerk,
    sentenceBoundaryContinuity:
      sentenceBoundaryEvidence
      && motion.maximumBoundaryJumpRatio <= maximumBoundaryJumpRatio,
  });
}

function normalizeSemanticGeometryRequirements(value = false) {
  if (value === false || value === undefined) return Object.freeze({
    persistentContinuity: false,
    transitionContinuity: false,
    focusExclusivity: false,
    primaryRoi: false,
    mobileLegibility: false,
  });
  if (value === true) return Object.freeze({
    persistentContinuity: true,
    transitionContinuity: true,
    focusExclusivity: true,
    primaryRoi: true,
    mobileLegibility: true,
  });
  const keys = ["persistentContinuity", "transitionContinuity", "focusExclusivity", "primaryRoi", "mobileLegibility"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|") || keys.some((key) => typeof value[key] !== "boolean")) {
    throw new AppError("ANIMATION_QA_FAILED", "Animation semantic geometry requirements are invalid.", 500);
  }
  if (value.transitionContinuity && !value.persistentContinuity) {
    throw new AppError("ANIMATION_QA_FAILED", "Animation transition continuity requires persistent continuity.", 500);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function evaluateGeometryQuality(geometry, semanticGeometryRequirements = false) {
  const requirements = normalizeSemanticGeometryRequirements(semanticGeometryRequirements);
  return Object.freeze({
    geometryAudit: geometry.passed === true,
    captionSafeZone: Array.isArray(geometry.captionSafeZoneViolations) && geometry.captionSafeZoneViolations.length === 0,
    clipping: Array.isArray(geometry.clippedEntities) && geometry.clippedEntities.length === 0,
    persistentContinuity: !requirements.persistentContinuity || (Array.isArray(geometry.persistentContinuityViolations) && geometry.persistentContinuityViolations.length === 0 && Number.isInteger(geometry.persistentObservationCount) && geometry.persistentObservationCount > 0 && (!requirements.transitionContinuity || (Array.isArray(geometry.observedTransitionIds) && geometry.observedTransitionIds.length > 0))),
    focusExclusivity: !requirements.focusExclusivity || (Array.isArray(geometry.focusViolations) && geometry.focusViolations.length === 0 && Array.isArray(geometry.observedFocusIntervalIds) && geometry.observedFocusIntervalIds.length > 0),
    primaryRoi: !requirements.primaryRoi || (Array.isArray(geometry.primaryRoiViolations) && geometry.primaryRoiViolations.length === 0),
    mobileLegibility: !requirements.mobileLegibility || (Array.isArray(geometry.legibilityViolations) && geometry.legibilityViolations.length === 0 && Array.isArray(geometry.contrastViolations) && geometry.contrastViolations.length === 0 && Number.isInteger(geometry.labelObservationCount) && geometry.labelObservationCount > 0 && Array.isArray(geometry.markedLabelIds) && geometry.markedLabelIds.length > 0 && Array.isArray(geometry.observedLabelIds) && JSON.stringify(geometry.markedLabelIds) === JSON.stringify(geometry.observedLabelIds) && Array.isArray(geometry.unobservedLabelIds) && geometry.unobservedLabelIds.length === 0),
  });
}

function runBenchmarkQa(input) {
  const technical = probeVisualMaster(input.outputPath);
  const geometry = input.geometryAudit || { passed: false, clippedEntities: [], captionSafeZoneViolations: [], semanticRoi: null };
  const semanticGeometryRequirements = input.semanticGeometryRequirements === undefined
    ? input.semanticContinuityRequired === true
    : input.semanticGeometryRequirements;
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
    ...(input.temporalMotionLimits
      ? evaluateTemporalMotionQuality(motion, input.temporalMotionLimits)
      : {}),
    ...evaluateGeometryQuality(geometry, semanticGeometryRequirements),
  };
  return Object.freeze({ passed: Object.values(checks).every(Boolean), checks, technical, motion, samples: motion, geometryAudit: geometry, captionSafeZoneViolations: geometry.captionSafeZoneViolations?.length || 0, clippedEntities: geometry.clippedEntities?.length || 0 });
}

module.exports = { DEFAULT_MOTION_THRESHOLD, TEMPORAL_MOTION_METRIC_PROFILE_ID, analyzeConsecutiveFrames, analyzeSampleFrames, evaluateGeometryQuality, evaluateMotionQuality, evaluateTemporalMotionQuality, extractCheckpointMetrics, extractConsecutiveMotionMetrics, extractRangeMotion, extractSampleMetrics, normalizeSemanticGeometryRequirements, probeVisualMaster, runBenchmarkQa, writeCheckpointContactSheet, writeContactSheet };
