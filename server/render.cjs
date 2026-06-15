const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { commandAvailable } = require("./media.cjs");

function assTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function escapeAss(text) {
  return String(text || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function writeAssSubtitles(plan, outputPath) {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Hook,Arial,78,&H00FFFFFF,&H000000FF,&H00151A18,&H99000000,-1,0,0,0,100,100,0,0,1,5,1,5,70,70,760,1",
    "Style: Caption,Arial,58,&H00FFFFFF,&H000000FF,&H00151A18,&H99000000,-1,0,0,0,100,100,0,0,1,4,1,2,70,70,190,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${assTime(0)},${assTime(Math.min(2, plan.sourceEnd - plan.sourceStart))},Hook,,0,0,0,,${escapeAss(plan.hook)}`,
  ];
  for (const caption of plan.captions) {
    lines.push(
      `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Caption,,0,0,0,,${escapeAss(caption.text)}`,
    );
  }
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function escapeFilterPath(path) {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function runFfmpeg(args, { signal, timeoutMs = CONFIG.renderTimeoutMs, onProgress, ffmpegBin = CONFIG.ffmpegBin } = {}) {
  return new Promise((resolve, reject) => {
    if (!commandAvailable(ffmpegBin)) {
      reject(new AppError("FFMPEG_MISSING", SAFE_MESSAGES.FFMPEG_MISSING, 503));
      return;
    }
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("RENDER_FAILED", "Render timed out.", 500));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
      reject(new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (onProgress) onProgress(stderr);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new AppError("FFMPEG_MISSING", SAFE_MESSAGES.FFMPEG_MISSING, 503));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
      if (code === 0) resolve({ stderr });
      else reject(new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, { stderr: stderr.slice(-1200) }));
    });
  });
}

async function extractAudio(inputPath, outputPath, { signal } = {}) {
  await runFfmpeg(["-y", "-i", inputPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outputPath], {
    signal,
    timeoutMs: 60000,
  });
  return outputPath;
}

async function renderShort({ inputPath, outputPath, subtitlesPath, plan, signal }) {
  writeAssSubtitles(plan, subtitlesPath);
  const duration = Number((plan.sourceEnd - plan.sourceStart).toFixed(2));
  const filter = [
    "scale=1124:1998:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
    "eq=contrast=1.08:saturation=1.12",
    `subtitles=filename='${escapeFilterPath(subtitlesPath)}'`,
  ].join(",");
  const args = [
    "-y",
    "-ss",
    String(plan.sourceStart),
    "-i",
    inputPath,
    "-t",
    String(duration),
    "-vf",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ];
  await runFfmpeg(args, { signal });
  return outputPath;
}

module.exports = {
  assTime,
  writeAssSubtitles,
  runFfmpeg,
  extractAudio,
  renderShort,
};
