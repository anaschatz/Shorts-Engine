const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { segmentScorebugDigits } = require("./scorebug-image-segmentation.cjs");

const DIGIT_READER_STATUSES = Object.freeze(["readable", "ambiguous", "unreadable"]);
const DEFAULT_LAYOUT_ID = "default-focused-scorebug";
const MAX_DIGIT_BOXES = 8;
const MAX_CALIBRATION_READINGS = 96;
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function isFocusedScorebugRegion(regionId) {
  return /^scorebug_[A-Za-z0-9_-]+$/.test(sanitizeText(regionId || "", 80));
}

function scoreText(score = {}) {
  if (!Number.isInteger(score.home) || !Number.isInteger(score.away)) return null;
  return `${score.home}-${score.away}`;
}

function normalizeScore(score = {}) {
  if (!score || typeof score !== "object" || Array.isArray(score)) return null;
  const home = Number(score.home);
  const away = Number(score.away);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0 || home > 9 || away > 9 || home + away > 12) return null;
  return { home, away, text: `${home}-${away}` };
}

function normalizeRoi(value = {}, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const x = clamp(value.x ?? value.left ?? fallback.x ?? 0, 0, 1);
  const y = clamp(value.y ?? value.top ?? fallback.y ?? 0, 0, 1);
  const width = clamp(value.width ?? fallback.width ?? 0.08, 0.01, 1 - x);
  const height = clamp(value.height ?? fallback.height ?? 0.5, 0.01, 1 - y);
  return {
    x: round(x, 4),
    y: round(y, 4),
    width: round(width, 4),
    height: round(height, 4),
  };
}

function defaultDigitBoxes(score, calibration = {}) {
  const homeRoi = normalizeRoi(calibration.homeDigitRoi, { x: 0.42, y: 0.24, width: 0.08, height: 0.52 });
  const awayRoi = normalizeRoi(calibration.awayDigitRoi, { x: 0.58, y: 0.24, width: 0.08, height: 0.52 });
  if (!score || !homeRoi || !awayRoi) return [];
  return [
    { role: "home", digit: String(score.home), confidence: 0.86, ...homeRoi },
    { role: "away", digit: String(score.away), confidence: 0.86, ...awayRoi },
  ];
}

function normalizeDigitBox(value = {}, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const digit = Number(value.digit);
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null;
  const role = sanitizeText(value.role || fallback.role || "unknown", 16);
  if (!["home", "away", "separator", "unknown"].includes(role)) return null;
  const roi = normalizeRoi(value, fallback);
  if (!roi) return null;
  return {
    role,
    digit: String(digit),
    confidence: round(clamp(value.confidence ?? fallback.confidence ?? 0.5, 0, 1)),
    ...roi,
  };
}

function normalizeDigitBoxes(boxes = [], fallbackScore = null, calibration = {}) {
  const source = Array.isArray(boxes) && boxes.length ? boxes : defaultDigitBoxes(fallbackScore, calibration);
  return source
    .map((box) => normalizeDigitBox(box))
    .filter(Boolean)
    .slice(0, MAX_DIGIT_BOXES);
}

function normalizeCalibrationReading(value = {}, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) return null;
  const timestamp = seconds(value.timestamp ?? value.time ?? value.center, Number.NaN);
  if (!Number.isFinite(timestamp)) return null;
  const score = normalizeScore(value.score || {
    home: value.home ?? value.homeScore,
    away: value.away ?? value.awayScore,
  });
  const regionId = sanitizeText(value.regionId || value.region || "scorebug_broadcast_compact", 80);
  const confidence = round(clamp(value.confidence ?? 0.8, 0, 1));
  const digitBoxes = normalizeDigitBoxes(value.digitBoxes, score, value);
  return {
    id: sanitizeText(value.id || `scorebug_calibration_reading_${index + 1}`, 80),
    timestamp: round(timestamp),
    regionId,
    score,
    confidence,
    digitBoxes,
    source: sanitizeText(value.source || "scorebug_digit_calibration", 60),
  };
}

function validateScorebugCalibration(value = {}) {
  if (value === null || value === undefined || value === false) {
    return {
      enabled: false,
      layoutId: DEFAULT_LAYOUT_ID,
      minConfidence: 0.82,
      timestampToleranceSeconds: 0.75,
      homeDigitRoi: normalizeRoi({}, { x: 0.42, y: 0.24, width: 0.08, height: 0.52 }),
      awayDigitRoi: normalizeRoi({}, { x: 0.58, y: 0.24, width: 0.08, height: 0.52 }),
      hasExplicitDigitRois: false,
      readings: [],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const readings = (Array.isArray(value.readings) ? value.readings : [])
    .map((reading, index) => normalizeCalibrationReading(reading, index))
    .filter(Boolean)
    .slice(0, MAX_CALIBRATION_READINGS);
  return {
    enabled: Boolean(value.enabled ?? readings.length),
    layoutId: sanitizeText(value.layoutId || value.knownBroadcasterLayoutId || DEFAULT_LAYOUT_ID, 80),
    minConfidence: round(clamp(value.minConfidence ?? value.confidenceThreshold ?? 0.82, 0.55, 0.98)),
    timestampToleranceSeconds: round(clamp(value.timestampToleranceSeconds ?? 0.75, 0.05, 3)),
    homeDigitRoi: normalizeRoi(value.homeDigitRoi, { x: 0.42, y: 0.24, width: 0.08, height: 0.52 }),
    awayDigitRoi: normalizeRoi(value.awayDigitRoi, { x: 0.58, y: 0.24, width: 0.08, height: 0.52 }),
    hasExplicitDigitRois: value.hasExplicitDigitRois === true ||
      (value.hasExplicitDigitRois === undefined && Boolean(value.homeDigitRoi && value.awayDigitRoi)),
    readings,
  };
}

function calibrationSummary(calibration = {}) {
  if (calibration && typeof calibration === "object" && !Array.isArray(calibration) && !hasUnsafeValue(calibration) && Number.isInteger(calibration.readingCount)) {
    return {
      enabled: Boolean(calibration.enabled),
      layoutId: sanitizeText(calibration.layoutId || DEFAULT_LAYOUT_ID, 80),
      minConfidence: round(clamp(calibration.minConfidence ?? 0.82, 0.55, 0.98)),
      readingCount: Math.max(0, Math.min(MAX_CALIBRATION_READINGS, Number(calibration.readingCount || 0))),
    };
  }
  const safe = validateScorebugCalibration(calibration);
  return {
    enabled: safe.enabled,
    layoutId: safe.layoutId,
    minConfidence: safe.minConfidence,
    readingCount: safe.readings.length,
  };
}

function readingFromFrameOrCrop({ frame = {}, crop = {}, regionId = "", timestamp = 0 } = {}) {
  const sources = [
    crop && crop.scorebugDigits,
    frame && frame.scorebugDigits,
    crop && crop.digitReading,
    frame && frame.digitReading,
  ].filter(Boolean);
  for (const source of sources) {
    const readings = Array.isArray(source) ? source : [source];
    const normalized = readings
      .map((reading, index) => normalizeCalibrationReading({
        ...reading,
        timestamp: reading.timestamp ?? timestamp,
        regionId: reading.regionId || regionId,
      }, index))
      .filter(Boolean);
    const match = normalized.find((reading) => !regionId || reading.regionId === regionId);
    if (match) return match;
  }
  return null;
}

function readingFromCalibration({ calibration = {}, timestamp = 0, regionId = "" } = {}) {
  const safe = validateScorebugCalibration(calibration);
  if (!safe.enabled || !safe.readings.length) return null;
  const focused = safe.readings
    .filter((reading) => !regionId || reading.regionId === regionId)
    .map((reading) => ({ reading, distance: Math.abs(reading.timestamp - seconds(timestamp)) }))
    .filter((item) => item.distance <= safe.timestampToleranceSeconds)
    .sort((a, b) => a.distance - b.distance || b.reading.confidence - a.reading.confidence);
  return focused[0] ? focused[0].reading : null;
}

function statusFromReading(reading, calibration) {
  if (!reading || !reading.score) return {
    status: "unreadable",
    reasons: ["digit_boxes_missing"],
  };
  const boxes = normalizeDigitBoxes(reading.digitBoxes, reading.score, calibration);
  const homeBoxes = boxes.filter((box) => box.role === "home");
  const awayBoxes = boxes.filter((box) => box.role === "away");
  if (!homeBoxes.length || !awayBoxes.length) return {
    status: "ambiguous",
    reasons: ["home_or_away_digit_box_missing"],
  };
  if (reading.confidence < calibration.minConfidence) return {
    status: "ambiguous",
    reasons: ["digit_confidence_below_threshold"],
  };
  if (homeBoxes.some((box) => box.confidence < calibration.minConfidence - 0.1) ||
    awayBoxes.some((box) => box.confidence < calibration.minConfidence - 0.1)) {
    return {
      status: "ambiguous",
      reasons: ["digit_box_confidence_below_threshold"],
    };
  }
  return { status: "readable", reasons: [] };
}

function imageSegmentationReading({ crop = {}, regionId = "", timestamp = 0, calibration = {}, signal = null } = {}) {
  const cropPath = crop.cropPath || crop.imagePath || crop.localPath;
  const imageProbe = crop.imageProbe;
  if (!cropPath && typeof imageProbe !== "function") return null;
  return segmentScorebugDigits({
    cropPath,
    regionId,
    timestamp,
    calibration: calibration && calibration.hasExplicitDigitRois ? calibration : {},
    imageProbe,
    signal,
  });
}

function readScorebugDigits({
  frame = {},
  crop = {},
  regionId = "scoreboard_region",
  timestamp = null,
  calibration = null,
  signal = null,
} = {}) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const safeRegionId = sanitizeText(regionId || "scoreboard_region", 80);
  const safeTimestamp = round(seconds(timestamp ?? frame.timestamp ?? crop.timestamp, 0));
  const safeCalibration = validateScorebugCalibration(calibration);
  if (!isFocusedScorebugRegion(safeRegionId)) {
    return {
      status: "unreadable",
      timestamp: safeTimestamp,
      regionId: safeRegionId,
      score: null,
      confidence: 0,
      digitBoxes: [],
      reasons: ["region_not_focused_for_truth"],
      method: "digit-segmentation",
      calibrationUsed: calibrationSummary(safeCalibration),
    };
  }
  const explicitReading = readingFromFrameOrCrop({ frame, crop, regionId: safeRegionId, timestamp: safeTimestamp });
  if (explicitReading) {
    const boxes = normalizeDigitBoxes(explicitReading.digitBoxes, explicitReading.score, safeCalibration);
    const status = statusFromReading({ ...explicitReading, digitBoxes: boxes }, safeCalibration);
    return {
      status: DIGIT_READER_STATUSES.includes(status.status) ? status.status : "unreadable",
      timestamp: safeTimestamp,
      regionId: safeRegionId,
      score: status.status === "readable" ? explicitReading.score : null,
      confidence: round(clamp(explicitReading.confidence, 0, 1)),
      digitBoxes: boxes,
      reasons: status.reasons,
      method: "structured-digit-reading",
      calibrationUsed: calibrationSummary(safeCalibration),
    };
  }

  const segmented = imageSegmentationReading({
    crop,
    regionId: safeRegionId,
    timestamp: safeTimestamp,
    calibration: safeCalibration,
    signal,
  });
  if (segmented && segmented.status === "readable") {
    return {
      ...segmented,
      calibrationUsed: calibrationSummary(safeCalibration),
    };
  }

  const reading = readingFromCalibration({ calibration: safeCalibration, regionId: safeRegionId, timestamp: safeTimestamp });
  if (!reading) {
    return {
      status: segmented ? segmented.status : "ambiguous",
      timestamp: safeTimestamp,
      regionId: safeRegionId,
      score: null,
      confidence: segmented ? segmented.confidence : 0.1,
      digitBoxes: [],
      reasons: segmented
        ? [...segmented.reasons, "calibrated_digit_boxes_missing"].slice(0, 8)
        : ["calibrated_digit_boxes_missing"],
      method: "digit-segmentation",
      calibrationUsed: calibrationSummary(safeCalibration),
      imageSegmentation: segmented ? segmented.imageSegmentation : undefined,
    };
  }
  const boxes = normalizeDigitBoxes(reading.digitBoxes, reading.score, safeCalibration);
  const status = statusFromReading({ ...reading, digitBoxes: boxes }, safeCalibration);
  return {
    status: DIGIT_READER_STATUSES.includes(status.status) ? status.status : "unreadable",
    timestamp: safeTimestamp,
    regionId: safeRegionId,
    score: status.status === "readable" ? reading.score : null,
    confidence: round(clamp(reading.confidence, 0, 1)),
    digitBoxes: boxes,
    reasons: status.reasons,
    method: "digit-segmentation",
    calibrationUsed: calibrationSummary(safeCalibration),
  };
}

function digitReaderSummary(reading = {}) {
  const boxes = Array.isArray(reading.digitBoxes) ? reading.digitBoxes : [];
  const homeBoxes = boxes.filter((box) => box.role === "home");
  const awayBoxes = boxes.filter((box) => box.role === "away");
  return {
    digitReaderStatus: sanitizeText(reading.status || "unreadable", 32),
    digitBoxCount: boxes.length,
    homeDigitConfidence: homeBoxes.length ? round(Math.max(...homeBoxes.map((box) => Number(box.confidence || 0)))) : 0,
    awayDigitConfidence: awayBoxes.length ? round(Math.max(...awayBoxes.map((box) => Number(box.confidence || 0)))) : 0,
    scoreConfidence: round(reading.confidence || 0),
    digitReaderReasons: (Array.isArray(reading.reasons) ? reading.reasons : [])
      .map((reason) => sanitizeText(reason, 60))
      .filter(Boolean)
      .slice(0, 6),
    imageSegmentationStatus: reading.imageSegmentation
      ? sanitizeText(reading.imageSegmentation.status || "unreadable", 32)
      : null,
    imageSegmentationFormat: reading.imageSegmentation
      ? sanitizeText(reading.imageSegmentation.imageFormat || "unknown", 24)
      : null,
    imageSegmentationGroups: reading.imageSegmentation
      ? Math.max(0, Math.min(99, Number(reading.imageSegmentation.foregroundGroupCount || 0)))
      : 0,
    imageSegmentationReasons: reading.imageSegmentation && Array.isArray(reading.imageSegmentation.reasons)
      ? reading.imageSegmentation.reasons.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 6)
      : [],
    calibrationUsed: reading.calibrationUsed ? calibrationSummary(reading.calibrationUsed) : null,
  };
}

module.exports = {
  DIGIT_READER_STATUSES,
  calibrationSummary,
  digitReaderSummary,
  isFocusedScorebugRegion,
  normalizeDigitBoxes,
  normalizeScore,
  readScorebugDigits,
  scoreText,
  validateScorebugCalibration,
};
