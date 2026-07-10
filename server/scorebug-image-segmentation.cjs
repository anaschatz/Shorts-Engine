const { existsSync, readFileSync, statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { assertStoragePath } = require("./storage.cjs");
const { decodeScorebugCrop, parsePgmBuffer } = require("./scorebug-image-decoder.cjs");

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_WIDTH = 512;
const MAX_IMAGE_HEIGHT = 256;
const MAX_DIGIT_GROUPS = 2;
const DEFAULT_HOME_ROI = Object.freeze({ x: 0.36, y: 0.16, width: 0.16, height: 0.68 });
const DEFAULT_AWAY_ROI = Object.freeze({ x: 0.56, y: 0.16, width: 0.16, height: 0.68 });
const DIGIT_SIGNATURE_WIDTH = 10;
const DIGIT_SIGNATURE_HEIGHT = 16;

const DIGIT_SEGMENTS = Object.freeze({
  0: "abcdef",
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgecd",
  7: "abc",
  8: "abcdefg",
  9: "abfgcd",
});

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function safeReason(value) {
  return sanitizeText(value || "image_segmentation_unreadable", 80);
}

function isFocusedScorebugRegion(regionId) {
  return /^scorebug_[A-Za-z0-9_-]+$/.test(sanitizeText(regionId || "", 80));
}

function unreadable({ timestamp, regionId, reasons, details = {} } = {}) {
  return {
    status: "unreadable",
    timestamp: round(timestamp),
    regionId: sanitizeText(regionId || "scoreboard_region", 80),
    score: null,
    confidence: 0,
    digitBoxes: [],
    reasons: (Array.isArray(reasons) ? reasons : [reasons]).map(safeReason).filter(Boolean).slice(0, 8),
    method: "image-digit-segmentation",
    imageSegmentation: {
      status: "unreadable",
      componentCount: Math.max(0, Math.min(99, Number(details.componentCount || 0))),
      foregroundGroupCount: Math.max(0, Math.min(99, Number(details.foregroundGroupCount || 0))),
      imageFormat: sanitizeText(details.imageFormat || "unknown", 24),
      decoderStatus: details.decoderStatus ? sanitizeText(details.decoderStatus, 32) : null,
      decoderMode: details.decoderMode ? sanitizeText(details.decoderMode, 32) : null,
      homeDigitCandidates: [],
      awayDigitCandidates: [],
      digitSignatures: details.digitSignatures || null,
      reasons: (Array.isArray(reasons) ? reasons : [reasons]).map(safeReason).filter(Boolean).slice(0, 8),
    },
  };
}

function ambiguous({ timestamp, regionId, reasons, details = {}, home = null, away = null } = {}) {
  return {
    ...unreadable({ timestamp, regionId, reasons, details }),
    status: "ambiguous",
    confidence: 0.1,
    imageSegmentation: {
      status: "ambiguous",
      componentCount: Math.max(0, Math.min(99, Number(details.componentCount || 0))),
      foregroundGroupCount: Math.max(0, Math.min(99, Number(details.foregroundGroupCount || 0))),
      imageFormat: sanitizeText(details.imageFormat || "unknown", 24),
      decoderStatus: details.decoderStatus ? sanitizeText(details.decoderStatus, 32) : null,
      decoderMode: details.decoderMode ? sanitizeText(details.decoderMode, 32) : null,
      homeDigitCandidates: home ? [{ digit: String(home.digit), confidence: round(home.confidence) }] : [],
      awayDigitCandidates: away ? [{ digit: String(away.digit), confidence: round(away.confidence) }] : [],
      digitSignatures: details.digitSignatures || null,
      reasons: (Array.isArray(reasons) ? reasons : [reasons]).map(safeReason).filter(Boolean).slice(0, 8),
    },
  };
}

function safeRoi(value = {}, fallback = DEFAULT_HOME_ROI) {
  const x = clamp(value.x ?? value.left ?? fallback.x, 0, 1);
  const y = clamp(value.y ?? value.top ?? fallback.y, 0, 1);
  const width = clamp(value.width ?? fallback.width, 0.04, 1 - x);
  const height = clamp(value.height ?? fallback.height, 0.12, 1 - y);
  return {
    x: round(x, 4),
    y: round(y, 4),
    width: round(width, 4),
    height: round(height, 4),
  };
}

function loadImage({ cropPath, imageProbe }) {
  if (typeof imageProbe === "function") {
    const probed = imageProbe({ cropPath });
    if (!probed || typeof probed !== "object" || Array.isArray(probed)) return null;
    const width = Math.round(Number(probed.width || 0));
    const height = Math.round(Number(probed.height || 0));
    const pixels = Array.isArray(probed.pixels) ? probed.pixels.map((value) => Math.round(Number(value))) : [];
    if (width < 8 || height < 8 || width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT || pixels.length !== width * height) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    return {
      width,
      height,
      imageFormat: sanitizeText(probed.imageFormat || "probe", 24),
      pixels: pixels.map((value) => clamp(value, 0, 255)),
    };
  }
  if (!cropPath) return null;
  const safeCropPath = assertStoragePath(cropPath, "staging");
  if (!existsSync(safeCropPath)) {
    return { unsupportedReason: "crop_missing", imageFormat: "missing" };
  }
  const stat = statSync(safeCropPath);
  if (!stat.isFile() || stat.size <= 0) {
    return { unsupportedReason: "crop_empty_or_not_file", imageFormat: "unknown" };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return { unsupportedReason: "crop_too_large", imageFormat: "unknown" };
  }
  const buffer = readFileSync(safeCropPath);
  const pgm = parsePgmBuffer(buffer);
  if (pgm) return pgm;
  return { unsupportedReason: "unsupported_image_format", imageFormat: "unsupported" };
}

async function loadImageWithDecoder({
  cropPath,
  imageProbe,
  outputDir = null,
  ffmpegRunner = null,
  signal = null,
  timeoutMs = null,
} = {}) {
  const image = loadImage({ cropPath, imageProbe });
  if (!image || !image.unsupportedReason || image.unsupportedReason !== "unsupported_image_format") {
    return image;
  }
  if (!cropPath || typeof ffmpegRunner !== "function") return image;
  const decoded = await decodeScorebugCrop({
    cropPath,
    outputDir,
    ffmpegRunner,
    signal,
    timeout: timeoutMs,
    maxWidth: MAX_IMAGE_WIDTH,
    maxHeight: MAX_IMAGE_HEIGHT,
  });
  if (decoded.status !== "decoded") {
    return {
      unsupportedReason: decoded.reasons[0] || "image_decoder_failed_closed",
      imageFormat: decoded.imageFormat || image.imageFormat,
      decoderStatus: decoded.status,
      decoderMode: decoded.decoderMode,
      decoderReasons: decoded.reasons,
    };
  }
  return {
    width: decoded.width,
    height: decoded.height,
    imageFormat: decoded.imageFormat,
    pixels: decoded.pixels,
    decoderStatus: decoded.status,
    decoderMode: decoded.decoderMode,
  };
}

function foregroundPolarity(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const dark = sorted[0] ?? 0;
  const light = sorted[sorted.length - 1] ?? 255;
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  if (light - dark < 70) return null;
  return {
    threshold: round((dark + light) / 2),
    darkForeground: mean > 128,
  };
}

function roiBounds(image, roi) {
  const x0 = Math.max(0, Math.floor(roi.x * image.width));
  const y0 = Math.max(0, Math.floor(roi.y * image.height));
  const x1 = Math.min(image.width, Math.ceil((roi.x + roi.width) * image.width));
  const y1 = Math.min(image.height, Math.ceil((roi.y + roi.height) * image.height));
  return { x0, y0, x1, y1, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function pixelAt(image, x, y) {
  return image.pixels[y * image.width + x];
}

function roiPixels(image, bounds) {
  const values = [];
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      values.push(pixelAt(image, x, y));
    }
  }
  return values;
}

function foregroundComponents(image, bounds, polarity) {
  const width = bounds.width;
  const height = bounds.height;
  const foreground = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const indexFor = (x, y) => (y - bounds.y0) * width + (x - bounds.x0);

  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      const value = pixelAt(image, x, y);
      const active = polarity.darkForeground
        ? value <= polarity.threshold
        : value >= polarity.threshold;
      if (active) foreground[indexFor(x, y)] = 1;
    }
  }

  const components = [];
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      const startIndex = indexFor(x, y);
      if (!foreground[startIndex] || visited[startIndex]) continue;
      const queue = [[x, y]];
      visited[startIndex] = 1;
      const points = [];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let touchesBoundary = false;
      while (queue.length) {
        const [currentX, currentY] = queue.pop();
        points.push([currentX, currentY]);
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);
        if (
          currentX === bounds.x0 || currentX === bounds.x1 - 1 ||
          currentY === bounds.y0 || currentY === bounds.y1 - 1
        ) {
          touchesBoundary = true;
        }
        for (const [nextX, nextY] of [
          [currentX - 1, currentY],
          [currentX + 1, currentY],
          [currentX, currentY - 1],
          [currentX, currentY + 1],
        ]) {
          if (nextX < bounds.x0 || nextX >= bounds.x1 || nextY < bounds.y0 || nextY >= bounds.y1) continue;
          const nextIndex = indexFor(nextX, nextY);
          if (!foreground[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          queue.push([nextX, nextY]);
        }
      }
      components.push({ points, minX, maxX, minY, maxY, touchesBoundary });
    }
  }
  return components;
}

function digitAppearanceSignature(image, roi) {
  const bounds = roiBounds(image, roi);
  if (bounds.width < 8 || bounds.height < 12) return null;
  const polarity = foregroundPolarity(roiPixels(image, bounds));
  if (!polarity) return null;
  const component = foregroundComponents(image, bounds, polarity)
    .filter((item) => !item.touchesBoundary)
    .filter((item) => item.maxY - item.minY + 1 >= bounds.height * 0.3)
    .filter((item) => item.points.length >= bounds.width * bounds.height * 0.01)
    .sort((a, b) => b.points.length - a.points.length)[0];
  if (!component) return null;

  const componentWidth = component.maxX - component.minX + 1;
  const componentHeight = component.maxY - component.minY + 1;
  const pointSet = new Set(component.points.map(([x, y]) => `${x}:${y}`));
  let bits = "";
  for (let gridY = 0; gridY < DIGIT_SIGNATURE_HEIGHT; gridY += 1) {
    for (let gridX = 0; gridX < DIGIT_SIGNATURE_WIDTH; gridX += 1) {
      const startX = Math.floor(component.minX + gridX * componentWidth / DIGIT_SIGNATURE_WIDTH);
      const endX = Math.ceil(component.minX + (gridX + 1) * componentWidth / DIGIT_SIGNATURE_WIDTH);
      const startY = Math.floor(component.minY + gridY * componentHeight / DIGIT_SIGNATURE_HEIGHT);
      const endY = Math.ceil(component.minY + (gridY + 1) * componentHeight / DIGIT_SIGNATURE_HEIGHT);
      let sampleCount = 0;
      let foregroundCount = 0;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          sampleCount += 1;
          if (pointSet.has(`${x}:${y}`)) foregroundCount += 1;
        }
      }
      bits += foregroundCount / Math.max(1, sampleCount) >= 0.28 ? "1" : "0";
    }
  }
  return {
    version: 1,
    width: DIGIT_SIGNATURE_WIDTH,
    height: DIGIT_SIGNATURE_HEIGHT,
    bits,
    aspectRatio: round(componentWidth / componentHeight, 4),
    fillRatio: round(component.points.length / Math.max(1, componentWidth * componentHeight), 4),
  };
}

function zoneRatio(image, bounds, zone, polarity) {
  const zx0 = bounds.x0 + Math.floor(zone.x0 * bounds.width);
  const zx1 = bounds.x0 + Math.ceil(zone.x1 * bounds.width);
  const zy0 = bounds.y0 + Math.floor(zone.y0 * bounds.height);
  const zy1 = bounds.y0 + Math.ceil(zone.y1 * bounds.height);
  let count = 0;
  let foreground = 0;
  for (let y = zy0; y < zy1; y += 1) {
    for (let x = zx0; x < zx1; x += 1) {
      const value = pixelAt(image, x, y);
      const isForeground = polarity.darkForeground
        ? value <= polarity.threshold
        : value >= polarity.threshold;
      count += 1;
      if (isForeground) foreground += 1;
    }
  }
  return count ? foreground / count : 0;
}

function classifySevenSegmentDigit(image, roi) {
  const bounds = roiBounds(image, roi);
  if (bounds.width < 8 || bounds.height < 12) return null;
  const polarity = foregroundPolarity(roiPixels(image, bounds));
  if (!polarity) return null;
  const zones = {
    a: { x0: 0.22, x1: 0.78, y0: 0.04, y1: 0.18 },
    b: { x0: 0.68, x1: 0.88, y0: 0.14, y1: 0.46 },
    c: { x0: 0.68, x1: 0.88, y0: 0.54, y1: 0.86 },
    d: { x0: 0.22, x1: 0.78, y0: 0.82, y1: 0.96 },
    e: { x0: 0.12, x1: 0.32, y0: 0.54, y1: 0.86 },
    f: { x0: 0.12, x1: 0.32, y0: 0.14, y1: 0.46 },
    g: { x0: 0.36, x1: 0.64, y0: 0.43, y1: 0.57 },
  };
  const active = Object.entries(zones)
    .filter(([, zone]) => zoneRatio(image, bounds, zone, polarity) >= 0.22)
    .map(([segment]) => segment)
    .join("");
  const pattern = Object.entries(DIGIT_SEGMENTS)
    .find(([, segments]) => [...segments].sort().join("") === [...active].sort().join(""));
  if (!pattern) return null;
  const activeRatios = [...active].map((segment) => zoneRatio(image, bounds, zones[segment], polarity));
  const inactiveRatios = Object.keys(zones)
    .filter((segment) => !active.includes(segment))
    .map((segment) => zoneRatio(image, bounds, zones[segment], polarity));
  const activeScore = activeRatios.length
    ? activeRatios.reduce((sum, value) => sum + value, 0) / activeRatios.length
    : 0;
  const inactivePenalty = inactiveRatios.length
    ? inactiveRatios.reduce((sum, value) => sum + value, 0) / inactiveRatios.length
    : 0;
  const confidence = clamp(0.55 + activeScore * 0.45 - inactivePenalty * 0.25, 0, 0.99);
  if (confidence < 0.78) return null;
  return {
    digit: Number(pattern[0]),
    confidence: round(confidence),
    activeSegments: active,
    bounds,
  };
}

function countForegroundGroups(image) {
  const polarity = foregroundPolarity(image.pixels);
  if (!polarity) return 0;
  const columns = [];
  for (let x = 0; x < image.width; x += 1) {
    let foreground = 0;
    for (let y = 0; y < image.height; y += 1) {
      const value = pixelAt(image, x, y);
      const isForeground = polarity.darkForeground
        ? value <= polarity.threshold
        : value >= polarity.threshold;
      if (isForeground) foreground += 1;
    }
    columns.push(foreground / image.height);
  }
  const activeColumns = columns.map((ratio) => ratio >= 0.08);
  let groups = 0;
  let inGroup = false;
  for (const active of activeColumns) {
    if (active && !inGroup) groups += 1;
    inGroup = active;
    if (!active) inGroup = false;
  }
  return groups;
}

function boxFromRoi(role, digit, roi, confidence) {
  return {
    role,
    digit: String(digit),
    confidence: round(confidence),
    x: round(roi.x, 4),
    y: round(roi.y, 4),
    width: round(roi.width, 4),
    height: round(roi.height, 4),
  };
}

function classifyDigitPair(image, homeRoi, awayRoi) {
  const home = classifySevenSegmentDigit(image, homeRoi);
  const away = classifySevenSegmentDigit(image, awayRoi);
  if (!home || !away) {
    return { home, away, readable: false, confidence: 0 };
  }
  return {
    home,
    away,
    readable: true,
    confidence: round(Math.min(home.confidence, away.confidence)),
  };
}

function segmentLoadedImage({
  image,
  timestamp = 0,
  regionId = "scoreboard_region",
  calibration = {},
} = {}) {
  if (!image) {
    return unreadable({
      timestamp,
      regionId,
      reasons: ["crop_path_missing"],
    });
  }
  if (image.unsupportedReason) {
    const reasons = Array.isArray(image.decoderReasons) && image.decoderReasons.length
      ? image.decoderReasons
      : [image.unsupportedReason];
    return unreadable({
      timestamp,
      regionId,
      reasons,
      details: {
        imageFormat: image.imageFormat,
        decoderStatus: image.decoderStatus,
        decoderMode: image.decoderMode,
      },
    });
  }
  const homeRoi = safeRoi(calibration.homeDigitRoi, DEFAULT_HOME_ROI);
  const awayRoi = safeRoi(calibration.awayDigitRoi, DEFAULT_AWAY_ROI);
  const digitSignatures = {
    home: digitAppearanceSignature(image, homeRoi),
    away: digitAppearanceSignature(image, awayRoi),
  };
  const foregroundGroupCount = countForegroundGroups(image);
  const details = {
    foregroundGroupCount,
    componentCount: foregroundGroupCount,
    imageFormat: image.imageFormat,
    decoderStatus: image.decoderStatus,
    decoderMode: image.decoderMode,
    digitSignatures,
  };
  const fullCropHasExtraGroups = foregroundGroupCount > MAX_DIGIT_GROUPS;
  const layoutCandidates = [
    { id: "focused_digit_roi", homeRoi, awayRoi },
    { id: "legacy_wide_digit_roi", homeRoi: safeRoi({}, DEFAULT_HOME_ROI), awayRoi: safeRoi({}, DEFAULT_AWAY_ROI) },
  ];
  const attempts = layoutCandidates.map((candidate) => ({
    ...candidate,
    ...classifyDigitPair(image, candidate.homeRoi, candidate.awayRoi),
  }));
  const readable = attempts
    .filter((attempt) => attempt.readable)
    .sort((a, b) => b.confidence - a.confidence)[0];
  const bestAttempt = readable || attempts.find((attempt) => attempt.home || attempt.away) || attempts[0];
  if (!readable) {
    return ambiguous({
      timestamp,
      regionId,
      reasons: [
        !bestAttempt.home && !bestAttempt.away ? "home_and_away_digits_unreadable" : "home_or_away_digit_unreadable",
        ...(fullCropHasExtraGroups ? ["clock_like_digit_group_rejected"] : []),
      ],
      details,
      home: bestAttempt.home,
      away: bestAttempt.away,
    });
  }
  const home = readable.home;
  const away = readable.away;
  const selectedHomeRoi = readable.homeRoi;
  const selectedAwayRoi = readable.awayRoi;
  const confidence = round(Math.min(home.confidence, away.confidence));
  const score = { home: home.digit, away: away.digit, text: `${home.digit}-${away.digit}` };
  const digitBoxes = [
    boxFromRoi("home", home.digit, selectedHomeRoi, home.confidence),
    boxFromRoi("away", away.digit, selectedAwayRoi, away.confidence),
  ];
  return {
    status: "readable",
    timestamp: round(timestamp),
    regionId,
    score,
    confidence,
    digitBoxes,
    reasons: [],
    method: "image-digit-segmentation",
    imageSegmentation: {
      status: "readable",
      componentCount: foregroundGroupCount,
      foregroundGroupCount,
      imageFormat: image.imageFormat,
      decoderStatus: image.decoderStatus ? sanitizeText(image.decoderStatus, 32) : null,
      decoderMode: image.decoderMode ? sanitizeText(image.decoderMode, 32) : null,
      homeDigitCandidates: [{ digit: String(home.digit), confidence: home.confidence }],
      awayDigitCandidates: [{ digit: String(away.digit), confidence: away.confidence }],
      digitSignatures,
      reasons: [
        readable.id === "focused_digit_roi" ? "focused_digit_roi_used" : "legacy_wide_digit_roi_used",
        ...(fullCropHasExtraGroups ? ["full_crop_had_extra_groups"] : []),
      ],
    },
  };
}

function segmentScorebugDigits({
  cropPath = null,
  regionId = "scoreboard_region",
  timestamp = 0,
  calibration = {},
  imageProbe = null,
  signal = null,
} = {}) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const safeRegionId = sanitizeText(regionId || "scoreboard_region", 80);
  if (!isFocusedScorebugRegion(safeRegionId)) {
    return unreadable({
      timestamp,
      regionId: safeRegionId,
      reasons: ["region_not_focused_for_truth"],
    });
  }
  let image = null;
  try {
    image = loadImage({ cropPath, imageProbe });
  } catch (error) {
    if (error && error.code) throw error;
    return unreadable({
      timestamp,
      regionId: safeRegionId,
      reasons: ["image_segmentation_failed_closed"],
    });
  }
  return segmentLoadedImage({ image, timestamp, regionId: safeRegionId, calibration });
}

async function segmentScorebugDigitsAsync({
  cropPath = null,
  regionId = "scoreboard_region",
  timestamp = 0,
  calibration = {},
  imageProbe = null,
  outputDir = null,
  ffmpegRunner = null,
  timeoutMs = null,
  signal = null,
} = {}) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const safeRegionId = sanitizeText(regionId || "scoreboard_region", 80);
  if (!isFocusedScorebugRegion(safeRegionId)) {
    return unreadable({
      timestamp,
      regionId: safeRegionId,
      reasons: ["region_not_focused_for_truth"],
    });
  }
  let image = null;
  try {
    image = await loadImageWithDecoder({ cropPath, imageProbe, outputDir, ffmpegRunner, timeoutMs, signal });
  } catch (error) {
    if (error && error.code) throw error;
    return unreadable({
      timestamp,
      regionId: safeRegionId,
      reasons: ["image_segmentation_failed_closed"],
    });
  }
  return segmentLoadedImage({ image, timestamp, regionId: safeRegionId, calibration });
}

module.exports = {
  MAX_DIGIT_GROUPS,
  segmentScorebugDigits,
  segmentScorebugDigitsAsync,
};
