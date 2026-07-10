const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { commandAvailable, sanitizeText } = require("../media.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { detectCelebrationHeads } = require("./apple-vision-head-adapter.cjs");
const {
  trackingFallback,
  validateTrackingProviderOutput,
} = require("../tracking-provider.cjs");

const PROVIDER_MODE = "ffmpeg-football-tracking";
const MAX_TRACKING_FRAMES = 32;
const DEFAULT_TIMEOUT_MS = 12000;
const DECODE_WIDTH = 320;
const MAX_DECODE_BYTES = 4 * 1024 * 1024;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 2));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function safeTimeout(value) {
  const parsed = Number(value);
  return Math.max(1000, Math.min(20000, Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_TIMEOUT_MS));
}

function decodedDimensions(metadata = {}) {
  const width = Math.max(1, Number(metadata.width || 1920));
  const height = Math.max(1, Number(metadata.height || 1080));
  if (width >= height) {
    return { width: DECODE_WIDTH, height: even(DECODE_WIDTH * height / width) };
  }
  return { width: even(DECODE_WIDTH * width / height), height: DECODE_WIDTH };
}

function safeFrames(frames = [], metadata = {}) {
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  return (Array.isArray(frames) ? frames : [])
    .slice(0, MAX_TRACKING_FRAMES)
    .map((frame, index) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
      let localPath;
      try {
        localPath = assertStoragePath(frame.localPath, "staging");
      } catch {
        return null;
      }
      const time = Number(frame.timestamp);
      if (!existsSync(localPath) || !Number.isFinite(time) || time < 0 || (duration && time > duration + 0.25)) {
        return null;
      }
      return {
        id: sanitizeText(frame.id || `tracking_frame_${index + 1}`, 64),
        time: round(time, 2),
        localPath,
        visualHints: Array.isArray(frame.visualHints)
          ? frame.visualHints.map((hint) => sanitizeText(hint, 48)).filter(Boolean).slice(0, 4)
          : [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function defaultFrameDecoder(frame, { ffmpegBin = CONFIG.ffmpegBin, dimensions, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, [
      "-v", "error",
      "-i", frame.localPath,
      "-vf", `scale=${dimensions.width}:${dimensions.height}:flags=fast_bilinear`,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ], {
      encoding: null,
      maxBuffer: MAX_DECODE_BYTES,
      timeout: Math.max(500, Math.min(2500, timeoutMs)),
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
      const expectedBytes = dimensions.width * dimensions.height * 3;
      if (data.length !== expectedBytes) {
        reject(new Error("TRACKING_FRAME_DECODE_INVALID"));
        return;
      }
      resolve({ ...dimensions, data });
    });
  });
}

function pixelAt(image, x, y) {
  const index = (y * image.width + x) * 3;
  return [image.data[index], image.data[index + 1], image.data[index + 2]];
}

function grassPixel(r, g, b) {
  return g >= 42 && g - r >= 9 && g - b >= 4 && g >= r * 1.08 && g >= b * 1.03;
}

function whitePixel(r, g, b) {
  return (r + g + b) / 3 >= 174 && Math.max(r, g, b) - Math.min(r, g, b) <= 58;
}

function hasGrassNeighbor(image, x, y) {
  for (let dy = -2; dy <= 2; dy += 2) {
    for (let dx = -2; dx <= 2; dx += 2) {
      if (dx === 0 && dy === 0) continue;
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      if (grassPixel(...pixelAt(image, px, py))) return true;
    }
  }
  return false;
}

function connectedComponents(mask, width, height, maxComponents = 400) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queueX = new Int16Array(mask.length);
  const queueY = new Int16Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (!mask[startIndex] || visited[startIndex]) continue;
      let head = 0;
      let tail = 1;
      queueX[0] = x;
      queueY[0] = y;
      visited[startIndex] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      while (head < tail) {
        const currentX = queueX[head];
        const currentY = queueY[head];
        head += 1;
        area += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);
        for (let offset = 0; offset < 4; offset += 1) {
          const nextX = currentX + [1, -1, 0, 0][offset];
          const nextY = currentY + [0, 0, 1, -1][offset];
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const nextIndex = nextY * width + nextX;
          if (!mask[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          queueX[tail] = nextX;
          queueY[tail] = nextY;
          tail += 1;
        }
      }
      components.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area,
      });
      if (components.length >= maxComponents) return components;
    }
  }
  return components;
}

function weightedCluster(components, image) {
  const candidates = components.filter((component) => (
    component.area >= 3 &&
    component.area <= 220 &&
    component.width <= 18 &&
    component.height >= 2 &&
    component.height <= 32
  ));
  if (!candidates.length) return null;
  let best = null;
  for (const candidate of candidates) {
    const centerX = candidate.x + candidate.width / 2;
    let weight = 0;
    for (const other of candidates) {
      const otherX = other.x + other.width / 2;
      const distance = Math.abs(centerX - otherX);
      if (distance > image.width * 0.24) continue;
      weight += Math.sqrt(other.area) * (1 - distance / (image.width * 0.24));
    }
    if (!best || weight > best.weight) best = { centerX, weight };
  }
  const included = candidates.filter((candidate) => (
    Math.abs(candidate.x + candidate.width / 2 - best.centerX) <= image.width * 0.24
  ));
  const left = Math.min(...included.map((item) => item.x));
  const top = Math.min(...included.map((item) => item.y));
  const right = Math.max(...included.map((item) => item.x + item.width));
  const bottom = Math.max(...included.map((item) => item.y + item.height));
  return {
    box: { x: left, y: top, width: right - left, height: bottom - top },
    centerX: included.reduce((sum, item) => sum + (item.x + item.width / 2) * Math.sqrt(item.area), 0) /
      Math.max(1, included.reduce((sum, item) => sum + Math.sqrt(item.area), 0)),
    confidence: clamp(0.46 + included.length * 0.035, 0.46, 0.84),
  };
}

function ballCandidate(components, cluster, image, previous) {
  if (!cluster) return null;
  const candidates = components.filter((component) => {
    const ratio = Math.max(component.width, component.height) / Math.max(1, Math.min(component.width, component.height));
    return component.area >= 1 && component.area <= 20 && component.width <= 7 && component.height <= 7 && ratio <= 3.2;
  });
  let best = null;
  for (const candidate of candidates) {
    const centerX = candidate.x + candidate.width / 2;
    const centerY = candidate.y + candidate.height / 2;
    const roundness = Math.min(candidate.width, candidate.height) / Math.max(candidate.width, candidate.height);
    const sizeScore = 1 - Math.min(1, Math.abs(candidate.area - 5) / 15);
    const centerScore = 1 - Math.min(1, Math.abs(centerX - image.width / 2) / (image.width / 2));
    const clusterScore = cluster
      ? 1 - Math.min(1, Math.abs(centerX - cluster.centerX) / (image.width * 0.42))
      : 0.25;
    if (Math.abs(centerX - cluster.centerX) > image.width * 0.32) continue;
    const continuityScore = previous
      ? 1 - Math.min(1, Math.hypot(centerX - previous.x, centerY - previous.y) / (image.width * 0.42))
      : 0.45;
    const score = roundness * 0.18 + sizeScore * 0.18 + centerScore * 0.2 + clusterScore * 0.28 + continuityScore * 0.16;
    if (!best || score > best.score) best = { box: candidate, x: centerX, y: centerY, score };
  }
  if (!best || best.score < 0.52) return null;
  return {
    ...best,
    confidence: clamp(0.42 + best.score * 0.48, 0.5, 0.9),
  };
}

function analyzeDecodedFrame(image, previousBall = null) {
  const pixelCount = image.width * image.height;
  const playerMask = new Uint8Array(pixelCount);
  const whiteMask = new Uint8Array(pixelCount);
  const minY = Math.floor(image.height * 0.18);
  const maxY = Math.floor(image.height * 0.94);
  let grassCount = 0;
  for (let y = minY; y < maxY; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const index = y * image.width + x;
      const [r, g, b] = pixelAt(image, x, y);
      if (grassPixel(r, g, b)) {
        grassCount += 1;
        continue;
      }
      if (!hasGrassNeighbor(image, x, y)) continue;
      if (whitePixel(r, g, b)) whiteMask[index] = 1;
      else playerMask[index] = 1;
    }
  }
  const grassCoverage = grassCount / Math.max(1, image.width * (maxY - minY));
  if (grassCoverage < 0.42) return { grassCoverage, cluster: null, ball: null };
  const playerComponents = connectedComponents(playerMask, image.width, image.height);
  const whiteComponents = connectedComponents(whiteMask, image.width, image.height);
  const cluster = weightedCluster(playerComponents, image);
  const ball = ballCandidate(whiteComponents, cluster, image, previousBall);
  return { grassCoverage, cluster, ball };
}

function scaleBox(box, image, metadata = {}) {
  if (!box) return null;
  const mediaWidth = Math.max(1, Number(metadata.width || 1920));
  const mediaHeight = Math.max(1, Number(metadata.height || 1080));
  return {
    x: Math.max(0, Math.round(box.x * mediaWidth / image.width)),
    y: Math.max(0, Math.round(box.y * mediaHeight / image.height)),
    width: Math.max(1, Math.round(box.width * mediaWidth / image.width)),
    height: Math.max(1, Math.round(box.height * mediaHeight / image.height)),
  };
}

function centerForSample(ball, cluster, celebrationHead, image, metadata = {}) {
  const mediaWidth = Math.max(1, Number(metadata.width || 1920));
  const mediaHeight = Math.max(1, Number(metadata.height || 1080));
  if (celebrationHead && celebrationHead.confidence >= 0.66) {
    return {
      x: round(clamp(celebrationHead.x / image.width * mediaWidth, 0, mediaWidth), 2),
      y: round(clamp(celebrationHead.y / image.height * mediaHeight, 0, mediaHeight), 2),
    };
  }
  const ballWeight = ball ? clamp(ball.confidence, 0.5, 0.9) : 0;
  const clusterWeight = cluster ? clamp(cluster.confidence, 0.4, 0.85) : 0;
  const total = Math.max(0.01, ballWeight + clusterWeight);
  const x = ((ball ? ball.x : image.width / 2) * ballWeight + (cluster ? cluster.centerX : image.width / 2) * clusterWeight) / total;
  const y = ball ? ball.y : cluster ? cluster.box.y + cluster.box.height / 2 : image.height / 2;
  return {
    x: round(clamp(x / image.width * mediaWidth, 0, mediaWidth), 2),
    y: round(clamp(y / image.height * mediaHeight, 0, mediaHeight), 2),
  };
}

function validateTemporalBalls(samples, metadata = {}) {
  const mediaWidth = Math.max(1, Number(metadata.width || 1920));
  const ballSamples = samples.filter((sample) => sample.ballBox && sample.ballConfidence >= 0.52);
  return samples.map((sample) => {
    if (!sample.ballBox) return sample;
    const center = {
      x: sample.ballBox.x + sample.ballBox.width / 2,
      y: sample.ballBox.y + sample.ballBox.height / 2,
    };
    const neighbors = ballSamples.filter((candidate) => {
      if (candidate === sample) return false;
      const deltaTime = Math.abs(candidate.time - sample.time);
      if (deltaTime > 10) return false;
      const candidateX = candidate.ballBox.x + candidate.ballBox.width / 2;
      return Math.abs(candidateX - center.x) / mediaWidth <= 0.46;
    });
    if (sample.ballConfidence < 0.7 && !neighbors.length) {
      return {
        ...sample,
        ballBox: null,
        ballConfidence: 0,
        source: "player_cluster_fallback",
        reasonCodes: [...new Set([...(sample.reasonCodes || []), "tracking_implausible_jump_rejected"])],
      };
    }
    return sample;
  });
}

function unionBoxes(boxes, metadata = {}) {
  const safe = boxes.filter(Boolean);
  if (!safe.length) return null;
  const mediaWidth = Math.max(1, Number(metadata.width || 1920));
  const mediaHeight = Math.max(1, Number(metadata.height || 1080));
  const left = Math.max(0, Math.min(...safe.map((box) => box.x)));
  const top = Math.max(0, Math.min(...safe.map((box) => box.y)));
  const right = Math.min(mediaWidth, Math.max(...safe.map((box) => box.x + box.width)));
  const bottom = Math.min(mediaHeight, Math.max(...safe.map((box) => box.y + box.height)));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function cancelled() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

class FfmpegFootballTrackingAdapter {
  constructor({
    enabled = true,
    ffmpegBin = CONFIG.ffmpegBin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    frameDecoder = defaultFrameDecoder,
    celebrationHeadDetector = detectCelebrationHeads,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.ffmpegBin = sanitizeText(ffmpegBin || CONFIG.ffmpegBin, 120);
    this.timeoutMs = safeTimeout(timeoutMs);
    this.frameDecoder = frameDecoder;
    this.celebrationHeadDetector = typeof celebrationHeadDetector === "function" ? celebrationHeadDetector : null;
  }

  health() {
    const ready = this.enabled && commandAvailable(this.ffmpegBin);
    return {
      ready,
      enabled: this.enabled,
      mode: PROVIDER_MODE,
      objectTracking: ready,
      fallbackMode: "safe-tracking-fallback",
      goalClaimAllowed: false,
      networkRequired: false,
      failure: ready ? null : { code: "FFMPEG_TRACKING_UNAVAILABLE", phase: "football_tracking", retryable: true },
    };
  }

  async analyzeTracking(input = {}) {
    if (input.signal && input.signal.aborted) throw cancelled();
    const metadata = input.metadata || {};
    const frames = safeFrames(input.frames, metadata);
    if (!this.enabled || !frames.length || (this.frameDecoder === defaultFrameDecoder && !commandAvailable(this.ffmpegBin))) {
      return trackingFallback({
        metadata,
        frames: input.frames,
        reason: "tracking_provider_disabled",
        failure: { code: "FFMPEG_TRACKING_UNAVAILABLE", phase: "football_tracking", retryable: true },
      });
    }
    const dimensions = decodedDimensions(metadata);
    let faceDetectionByTime = new Map();
    if (this.celebrationHeadDetector && frames.some((frame) => frame.visualHints.includes("celebration_head"))) {
      try {
        const headResult = await this.celebrationHeadDetector({
          frames,
          metadata,
          signal: input.signal,
          timeoutMs: Math.min(10000, this.timeoutMs),
        });
        faceDetectionByTime = new Map((Array.isArray(headResult && headResult.detections) ? headResult.detections : [])
          .map((detection) => [Number(detection.time).toFixed(2), detection]));
      } catch {
        faceDetectionByTime = new Map();
      }
    }
    const startedAt = Date.now();
    const rawSamples = [];
    let previousBall = null;
    let previousFrameTime = null;
    let previousPhase = null;
    for (const frame of frames) {
      if (input.signal && input.signal.aborted) throw cancelled();
      if (Date.now() - startedAt >= this.timeoutMs) break;
      try {
        const scorerFollow = frame.visualHints.includes("scorer_follow") || frame.visualHints.includes("celebration_head");
        const phase = scorerFollow ? "scorer_follow" : "ball_follow";
        if (
          previousFrameTime == null ||
          frame.time - previousFrameTime > 10 ||
          (phase === "ball_follow" && previousPhase === "scorer_follow")
        ) previousBall = null;
        const decoded = await this.frameDecoder(frame, {
          ffmpegBin: this.ffmpegBin,
          dimensions,
          timeoutMs: this.timeoutMs - (Date.now() - startedAt),
        });
        const result = analyzeDecodedFrame(decoded, previousBall);
        const celebrationHeadRequested = scorerFollow;
        const detectedFace = celebrationHeadRequested
          ? faceDetectionByTime.get(Number(frame.time).toFixed(2)) || null
          : null;
        const detectedHead = detectedFace
          ? {
              ...detectedFace,
              confidence: Number(detectedFace.celebrationHeadConfidence || 0),
            }
          : null;
        const celebrationHead = detectedHead;
        if (!result.cluster && !result.ball && !celebrationHead && !scorerFollow) continue;
        if (!scorerFollow && result.ball) previousBall = { x: result.ball.x, y: result.ball.y };
        previousFrameTime = frame.time;
        previousPhase = phase;
        const reliableBall = result.ball && result.ball.confidence >= 0.72 ? result.ball : null;
        const reliableCelebrationHead = celebrationHead && celebrationHead.confidence >= 0.66
          ? celebrationHead
          : null;
        const ballBox = scaleBox(reliableBall && reliableBall.box, decoded, metadata);
        const playerClusterBox = scaleBox(result.cluster && result.cluster.box, decoded, metadata);
        const celebrationHeadBox = detectedFace && reliableCelebrationHead
          ? detectedFace.celebrationHeadBox
          : null;
        const celebrationHeadCenter = celebrationHeadBox
          ? {
              x: celebrationHeadBox.x + celebrationHeadBox.width / 2,
              y: celebrationHeadBox.y + celebrationHeadBox.height / 2,
            }
          : null;
        const celebrationGroupCenter = scorerFollow && playerClusterBox
          ? {
              x: playerClusterBox.x + playerClusterBox.width / 2,
              y: playerClusterBox.y + playerClusterBox.height / 2,
            }
          : null;
        rawSamples.push({
          time: frame.time,
          ballBox: scorerFollow ? null : ballBox,
          ballConfidence: scorerFollow ? 0 : round(reliableBall && reliableBall.confidence || 0, 2),
          playerClusterBox,
          playerClusterConfidence: round(result.cluster && result.cluster.confidence || 0, 2),
          celebrationHeadBox,
          celebrationHeadConfidence: round(reliableCelebrationHead && reliableCelebrationHead.confidence || 0, 2),
          actionCenter: celebrationHeadCenter || celebrationGroupCenter || centerForSample(reliableBall, result.cluster, reliableCelebrationHead, decoded, metadata),
          cameraMotion: 0,
          source: reliableCelebrationHead
            ? detectedFace.source
            : scorerFollow && playerClusterBox
              ? "celebration_group_fallback"
            : scorerFollow
              ? "celebration_wide_safe_fallback"
            : reliableBall
              ? "ball_detection"
              : "player_cluster_fallback",
          phase,
          reasonCodes: [
            "tracking_scoreboard_excluded",
            ...(!scorerFollow && reliableBall ? ["tracking_ball_visible"] : ["tracking_ball_occluded"]),
            ...(result.cluster ? ["tracking_player_cluster"] : []),
            ...(reliableCelebrationHead ? ["tracking_celebration_head_visible"] : []),
            ...(celebrationHeadRequested && !reliableCelebrationHead ? ["tracking_celebration_head_fallback"] : []),
          ],
        });
      } catch {
        // A corrupt sample is ignored; the bounded provider can still use other frames.
      }
    }
    const samples = validateTemporalBalls(rawSamples, metadata);
    const ballTracks = samples.filter((sample) => sample.ballBox).map((sample) => ({
      timestamp: sample.time,
      label: "ball",
      confidence: sample.ballConfidence,
      bounds: sample.ballBox,
    }));
    const playerClusters = samples.filter((sample) => sample.playerClusterBox).map((sample) => ({
      timestamp: sample.time,
      label: "player_cluster",
      confidence: sample.playerClusterConfidence,
      bounds: sample.playerClusterBox,
    }));
    const actionBounds = unionBoxes([
      ...ballTracks.map((track) => track.bounds),
      ...playerClusters.map((track) => track.bounds),
    ], metadata);
    const confidence = round(clamp(
      ballTracks.length / Math.max(2, samples.length) * 0.48 +
      playerClusters.length / Math.max(3, samples.length) * 0.3 +
      (samples.length >= 4 ? 0.16 : 0),
      0,
      0.92,
    ), 2);
    if (samples.length < 3 || ballTracks.length < 2 || playerClusters.length < 2 || confidence < 0.52) {
      return trackingFallback({
        metadata,
        frames: input.frames,
        reason: "tracking_action_uncertain",
        failure: { code: "FFMPEG_TRACKING_LOW_CONFIDENCE", phase: "football_tracking", retryable: false },
      });
    }
    return validateTrackingProviderOutput({
      providerMode: PROVIDER_MODE,
      fallbackUsed: false,
      frameCount: frames.length,
      ballTracks,
      playerClusters,
      samples,
      actionBounds,
      actionCenter: samples[Math.floor(samples.length / 2)].actionCenter,
      cameraMotionLevel: 0,
      confidence,
      reasonCodes: [
        "tracking_ball_visible",
        "tracking_player_cluster",
        "tracking_action_bounds",
        "tracking_scoreboard_excluded",
      ],
      failure: null,
      goalClaimAllowed: false,
    }, metadata);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  FfmpegFootballTrackingAdapter,
  MAX_TRACKING_FRAMES,
  PROVIDER_MODE,
  analyzeDecodedFrame,
  decodedDimensions,
};
