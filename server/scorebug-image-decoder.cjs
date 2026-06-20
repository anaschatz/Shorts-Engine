const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, statSync } = require("node:fs");
const { basename, dirname } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { runFfmpeg } = require("./render.cjs");
const { assertStoragePath, safeResolve } = require("./storage.cjs");

const MAX_DECODE_BYTES = 1024 * 1024;
const DEFAULT_MAX_WIDTH = 512;
const DEFAULT_MAX_HEIGHT = 256;
const DEFAULT_TIMEOUT_MS = 8000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function isWhitespace(byte) {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}

function skipWhitespaceAndComments(buffer, offset) {
  let index = offset;
  while (index < buffer.length) {
    while (index < buffer.length && isWhitespace(buffer[index])) index += 1;
    if (buffer[index] !== 35) break;
    while (index < buffer.length && buffer[index] !== 10) index += 1;
  }
  return index;
}

function readToken(buffer, offset) {
  const start = skipWhitespaceAndComments(buffer, offset);
  let end = start;
  while (end < buffer.length && !isWhitespace(buffer[end]) && buffer[end] !== 35) end += 1;
  return {
    token: buffer.slice(start, end).toString("ascii"),
    offset: end,
  };
}

function parsePgmBuffer(buffer) {
  const magic = readToken(buffer, 0);
  if (magic.token !== "P2" && magic.token !== "P5") return null;
  const widthToken = readToken(buffer, magic.offset);
  const heightToken = readToken(buffer, widthToken.offset);
  const maxToken = readToken(buffer, heightToken.offset);
  const width = Number(widthToken.token);
  const height = Number(heightToken.token);
  const maxValue = Number(maxToken.token);
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(maxValue)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (width < 8 || height < 8 || width > DEFAULT_MAX_WIDTH || height > DEFAULT_MAX_HEIGHT || maxValue < 1 || maxValue > 255) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const expected = width * height;
  if (magic.token === "P2") {
    let offset = maxToken.offset;
    const values = [];
    for (let index = 0; index < expected; index += 1) {
      const next = readToken(buffer, offset);
      if (!next.token) break;
      const value = Number(next.token);
      if (!Number.isFinite(value) || value < 0 || value > maxValue) {
        throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
      }
      values.push(Math.round((value / maxValue) * 255));
      offset = next.offset;
    }
    if (values.length !== expected) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    return { width, height, imageFormat: "pgm-p2", pixels: values };
  }
  let dataOffset = maxToken.offset;
  if (isWhitespace(buffer[dataOffset])) dataOffset += 1;
  const data = buffer.slice(dataOffset, dataOffset + expected);
  if (data.length !== expected) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    width,
    height,
    imageFormat: "pgm-p5",
    pixels: Array.from(data),
  };
}

function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 4) return "unknown";
  if (buffer[0] === 0x50 && (buffer[1] === 0x32 || buffer[1] === 0x35)) return `pgm-p${String.fromCharCode(buffer[1]).toLowerCase()}`;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  return "unknown";
}

function safeDecoderResult({ status = "unreadable", imageFormat = "unknown", reasons = [], decoderMode = "ffmpeg-pgm" } = {}) {
  return {
    status,
    imageFormat,
    width: 0,
    height: 0,
    pixels: [],
    reasons: (Array.isArray(reasons) ? reasons : [reasons]).filter(Boolean).slice(0, 8),
    decoderMode,
  };
}

function timeoutMs(value) {
  return Math.max(250, Math.min(30000, Number(value) || DEFAULT_TIMEOUT_MS));
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithDecoderTimeout(promise, { signal = null, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return Promise.reject(cancellationError());
  let timer = null;
  let abortListener = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => finish(reject, cancellationError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => {
      finish(reject, new AppError("SCOREBUG_IMAGE_DECODER_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, timeoutMs(timeout));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function decodeScorebugCrop({
  cropPath,
  outputDir = null,
  ffmpegRunner = runFfmpeg,
  signal = null,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
  timeout = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (signal && signal.aborted) throw cancellationError();
  const safeCropPath = assertStoragePath(cropPath, "staging");
  if (!existsSync(safeCropPath)) {
    return safeDecoderResult({ imageFormat: "missing", reasons: ["crop_missing"] });
  }
  const stat = statSync(safeCropPath);
  if (!stat.isFile() || stat.size <= 0) {
    return safeDecoderResult({ reasons: ["crop_empty_or_not_file"] });
  }
  if (stat.size > MAX_DECODE_BYTES) {
    return safeDecoderResult({ reasons: ["crop_too_large"] });
  }
  const inputBuffer = readFileSync(safeCropPath);
  const imageFormat = detectImageFormat(inputBuffer);
  if (imageFormat.startsWith("pgm")) {
    const parsed = parsePgmBuffer(inputBuffer);
    return parsed
      ? { status: "decoded", decoderMode: "direct-pgm", reasons: [], ...parsed }
      : safeDecoderResult({ status: "unsupported", imageFormat, reasons: ["unsupported_image_format"], decoderMode: "direct-pgm" });
  }
  if (imageFormat !== "png" && imageFormat !== "jpeg") {
    return safeDecoderResult({ status: "unsupported", imageFormat, reasons: ["unsupported_image_format"] });
  }
  if (typeof ffmpegRunner !== "function") {
    return safeDecoderResult({ imageFormat, reasons: ["image_decoder_unavailable"] });
  }
  const safeOutputDir = outputDir ? assertStoragePath(outputDir, "staging") : assertStoragePath(dirname(safeCropPath), "staging");
  mkdirSync(safeOutputDir, { recursive: true });
  const filePart = basename(safeCropPath).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "scorebug";
  const decodedPath = safeResolve(safeOutputDir, `${filePart}.decoded-${randomUUID()}.pgm`);
  const width = Math.max(8, Math.min(DEFAULT_MAX_WIDTH, Math.round(Number(maxWidth) || DEFAULT_MAX_WIDTH)));
  const height = Math.max(8, Math.min(DEFAULT_MAX_HEIGHT, Math.round(Number(maxHeight) || DEFAULT_MAX_HEIGHT)));
  try {
    await raceWithDecoderTimeout(ffmpegRunner([
      "-y",
      "-i",
      safeCropPath,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=gray`,
      "-frames:v",
      "1",
      decodedPath,
    ], { signal, timeoutMs: timeoutMs(timeout) }), { signal, timeout });
    if (!existsSync(decodedPath)) {
      return safeDecoderResult({ imageFormat, reasons: ["image_decoder_failed_closed"] });
    }
    const decoded = parsePgmBuffer(readFileSync(decodedPath));
    if (!decoded) {
      return safeDecoderResult({ imageFormat, reasons: ["image_decoder_failed_closed"] });
    }
    return {
      status: "decoded",
      decoderMode: "ffmpeg-pgm",
      reasons: [],
      ...decoded,
      imageFormat,
    };
  } catch (error) {
    if (error && error.code === "JOB_CANCELLED") throw error;
    if (error && (error.code === "FFMPEG_MISSING" || error.code === "ENOENT")) {
      return safeDecoderResult({ imageFormat, reasons: ["image_decoder_unavailable"] });
    }
    if (error && error.code === "SCOREBUG_IMAGE_DECODER_TIMEOUT") {
      return safeDecoderResult({ imageFormat, reasons: ["image_decoder_timeout"] });
    }
    return safeDecoderResult({ imageFormat, reasons: ["image_decoder_failed_closed"] });
  } finally {
    rmSync(decodedPath, { force: true });
  }
}

module.exports = {
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MAX_WIDTH,
  detectImageFormat,
  decodeScorebugCrop,
  parsePgmBuffer,
};
