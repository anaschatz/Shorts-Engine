const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { extname } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

function sanitizeText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeFileName(value) {
  const baseName = sanitizeText(value, 180).split(/[\\/]/).pop() || "";
  return (
    baseName
      .replace(/[<>:"|?*]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "untitled-video"
  );
}

function extensionOf(fileName) {
  return extname(sanitizeFileName(fileName)).replace(".", "").toLowerCase();
}

function validateFileName(fileName) {
  const raw = String(fileName || "");
  if (!raw.trim() || raw.length > 180 || /[\\/]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new AppError("FILE_NAME_UNSAFE", SAFE_MESSAGES.FILE_NAME_UNSAFE, 400);
  }
  const safeName = sanitizeFileName(raw);
  const extension = extensionOf(safeName);
  if (!CONFIG.allowedExtensions.includes(extension)) {
    throw new AppError("FILE_TYPE_UNSUPPORTED", SAFE_MESSAGES.FILE_TYPE_UNSUPPORTED, 415);
  }
  if (/\.(exe|js|mjs|html|svg|php|sh|bat|cmd|ps1)\./i.test(safeName)) {
    throw new AppError("FILE_NAME_UNSAFE", SAFE_MESSAGES.FILE_NAME_UNSAFE, 400);
  }
  return { safeName, extension };
}

function detectContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "webm";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "qt  ") return "mov";
    return "mp4";
  }
  return null;
}

function validateSignature(buffer, extension, mimeType) {
  const container = detectContainer(buffer.subarray(0, 32));
  if (!container) {
    throw new AppError("FILE_SIGNATURE_UNSUPPORTED", SAFE_MESSAGES.FILE_SIGNATURE_UNSUPPORTED, 415);
  }
  const normalizedMime = sanitizeText(mimeType, 80).toLowerCase();
  if (container === "webm" && extension !== "webm") {
    throw new AppError("FILE_SIGNATURE_MISMATCH", SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH, 415);
  }
  if (container !== "webm" && extension === "webm") {
    throw new AppError("FILE_SIGNATURE_MISMATCH", SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH, 415);
  }
  if (normalizedMime && !CONFIG.allowedMimeTypes.includes(normalizedMime)) {
    throw new AppError("FILE_TYPE_UNSUPPORTED", SAFE_MESSAGES.FILE_TYPE_UNSUPPORTED, 415);
  }
  if (normalizedMime === "video/webm" && container !== "webm") {
    throw new AppError("FILE_SIGNATURE_MISMATCH", SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH, 415);
  }
  return container;
}

function validateUploadCandidate({ fileName, mimeType, size, buffer }) {
  if (!buffer || buffer.length === 0 || !size) {
    throw new AppError("FILE_TOO_SMALL", SAFE_MESSAGES.FILE_TOO_SMALL, 400);
  }
  if (size > CONFIG.maxUploadBytes) {
    throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
  }
  const { safeName, extension } = validateFileName(fileName);
  const container = validateSignature(buffer, extension, mimeType);
  return {
    safeName,
    extension,
    container,
    mimeType: sanitizeText(mimeType, 80).toLowerCase(),
    size,
    sha256: sha256(buffer),
  };
}

function sha256(bufferOrPath) {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(bufferOrPath)) hash.update(bufferOrPath);
  else hash.update(readFileSync(bufferOrPath));
  return hash.digest("hex");
}

function commandAvailable(command) {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

function toolHealth() {
  return {
    ffmpeg: commandAvailable(CONFIG.ffmpegBin),
    ffprobe: commandAvailable(CONFIG.ffprobeBin),
    ffmpegBin: CONFIG.ffmpegBin,
    ffprobeBin: CONFIG.ffprobeBin,
  };
}

function ffprobeJson(filePath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!commandAvailable(CONFIG.ffprobeBin)) {
      reject(new AppError("FFPROBE_MISSING", SAFE_MESSAGES.FFPROBE_MISSING, 503));
      return;
    }
    const child = spawn(CONFIG.ffprobeBin, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("VIDEO_DURATION_INVALID", SAFE_MESSAGES.VIDEO_DURATION_INVALID, 400));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new AppError("FFPROBE_MISSING", SAFE_MESSAGES.FFPROBE_MISSING, 503));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new AppError("VIDEO_DURATION_INVALID", SAFE_MESSAGES.VIDEO_DURATION_INVALID, 400, { stderr }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new AppError("VIDEO_DURATION_INVALID", SAFE_MESSAGES.VIDEO_DURATION_INVALID, 400));
      }
    });
  });
}

async function probeMedia(filePath) {
  const info = await ffprobeJson(filePath);
  const videoStream = (info.streams || []).find((stream) => stream.codec_type === "video");
  const audioStream = (info.streams || []).find((stream) => stream.codec_type === "audio");
  const duration = Number(info.format && info.format.duration);
  if (!Number.isFinite(duration)) {
    throw new AppError("VIDEO_DURATION_INVALID", SAFE_MESSAGES.VIDEO_DURATION_INVALID, 400);
  }
  if (duration < CONFIG.minDurationSeconds) {
    throw new AppError("VIDEO_TOO_SHORT", SAFE_MESSAGES.VIDEO_TOO_SHORT, 400);
  }
  if (duration > CONFIG.maxDurationSeconds) {
    throw new AppError("VIDEO_TOO_LONG", SAFE_MESSAGES.VIDEO_TOO_LONG, 400);
  }
  if (!videoStream) {
    throw new AppError("VIDEO_DURATION_INVALID", "No video stream was found.", 400);
  }
  return {
    durationSeconds: duration,
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream.codec_name || null,
    audioCodec: audioStream ? audioStream.codec_name || null : null,
  };
}

module.exports = {
  sanitizeText,
  sanitizeFileName,
  extensionOf,
  validateFileName,
  detectContainer,
  validateSignature,
  validateUploadCandidate,
  sha256,
  commandAvailable,
  toolHealth,
  ffprobeJson,
  probeMedia,
};
