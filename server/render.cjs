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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelForHighlightType(highlightType) {
  const labels = {
    goal: "GOAL",
    shot_on_target: "SHOT ON TARGET",
    big_chance: "BIG CHANCE",
    save: "KEEPER SAVE",
    foul: "FOUL",
    hard_foul: "HARD FOUL",
    card_moment: "CARD MOMENT",
    counter_attack: "COUNTER ATTACK",
    skill_move: "SKILL MOVE",
    crowd_reaction: "CROWD REACTION",
    replay_worthy_moment: "REPLAY-WORTHY",
    audio_energy_spike: "ENERGY SPIKE",
    generic_highlight: "KEY MOMENT",
  };
  return labels[highlightType] || labels.generic_highlight;
}

function emphasizedAssText(caption, plan) {
  let text = escapeAss(caption.text);
  if (plan.stylePreset !== "social_sports_v1") return text;
  const emphasis = Array.isArray(plan.captionEmphasis)
    ? plan.captionEmphasis.find((item) => Number(item.captionIndex) === Number(caption.index))
    : null;
  const words = emphasis && Array.isArray(emphasis.words) ? emphasis.words.slice(0, 3) : [];
  for (const word of words) {
    const safeWord = escapeAss(word).trim();
    if (!safeWord) continue;
    const pattern = new RegExp(`\\b(${escapeRegExp(safeWord)})\\b`, "gi");
    text = text.replace(pattern, "{\\c&H005EF4F4&\\b1}$1{\\rSocialCaption}");
  }
  return `{\\t(0,220,\\fscx106\\fscy106)}${text}`;
}

function writeAssSubtitles(plan, outputPath) {
  const duration = Math.max(0.1, Number(plan.sourceEnd - plan.sourceStart) || 0.1);
  const social = plan.stylePreset === "social_sports_v1";
  const captionStyle = social ? "SocialCaption" : "Caption";
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
    "Style: SocialCaption,Arial,64,&H00FFFFFF,&H000000FF,&H00151A18,&HAA000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,210,1",
    "Style: TopLabel,Arial,42,&H00FFFFFF,&H000000FF,&H00151A18,&HCC111614,-1,0,0,0,100,100,0,0,1,3,1,8,60,60,78,1",
    "Style: EndBeat,Arial,46,&H00F4D35E,&H000000FF,&H00151A18,&HAA000000,-1,0,0,0,100,100,0,0,1,4,1,2,70,70,96,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${assTime(0)},${assTime(Math.min(2, duration))},Hook,,0,0,0,,${escapeAss(plan.hook)}`,
  ];
  if (social) {
    lines.push(
      `Dialogue: 1,${assTime(0)},${assTime(Math.min(2.4, duration))},TopLabel,,0,0,0,,${escapeAss(labelForHighlightType(plan.highlightType))} · SOCIAL SPORTS`,
    );
  }
  for (const caption of plan.captions) {
    lines.push(
      `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},${captionStyle},,0,0,0,,${emphasizedAssText(caption, plan)}`,
    );
  }
  if (social && duration >= 2.2) {
    lines.push(
      `Dialogue: 1,${assTime(Math.max(0, duration - 1.35))},${assTime(duration)},EndBeat,,0,0,0,,RUN IT BACK`,
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
  const subtitlesFilter = `subtitles=filename='${escapeFilterPath(subtitlesPath)}'`;
  const filter = plan.framingMode === "wide_safe"
    ? [
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:1[bg]",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]",
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,eq=contrast=1.08:saturation=1.12,${subtitlesFilter}[v]`,
      ].join(";")
    : [
        "[0:v]scale=1124:1998:force_original_aspect_ratio=increase",
        "crop=1080:1920",
        "setsar=1",
        "eq=contrast=1.08:saturation=1.12",
        `${subtitlesFilter}[v]`,
      ].join(",");
  const args = [
    "-y",
    "-ss",
    String(plan.sourceStart),
    "-i",
    inputPath,
    "-t",
    String(duration),
    "-filter_complex",
    filter,
    "-map",
    "[v]",
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
