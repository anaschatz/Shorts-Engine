const { existsSync } = require("node:fs");
const { dirname } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { normalizeCaptionManifest } = require("./contract.cjs");

const MAX_ASS_BYTES = 256 * 1024;

function captionFontConfig(env = process.env) {
  const configured = String(env.SHORTSENGINE_CAPTION_FONT_FILE || "").trim();
  const candidates = configured ? [configured] : ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];
  const filePath = candidates.find((candidate) => existsSync(candidate)) || null;
  return { available: Boolean(filePath), name: configured ? String(env.SHORTSENGINE_CAPTION_FONT_NAME || "Arial").trim() : filePath && filePath.includes("DejaVu") ? "DejaVu Sans" : "Arial", filePath, fontsDir: filePath ? dirname(filePath) : null };
}

function assTime(frame, mode = "start") {
  if (!Number.isInteger(frame) || frame < 0) throw new AppError("CAPTION_CONTRACT_INVALID", SAFE_MESSAGES.CAPTION_CONTRACT_INVALID, 409, { field: "frame" });
  const centiseconds = mode === "end" ? Math.ceil(frame * 100 / 30) : Math.floor(frame * 100 / 30);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(value) {
  return String(value || "").normalize("NFC").replace(/\\/g, "／").replace(/[{}]/g, (character) => character === "{" ? "（" : "）").replace(/[\r\n]+/g, " ");
}

function cueAssText(cue) {
  const lineEnds = [];
  let total = 0;
  cue.lines.forEach((line) => { total += line.split(/\s+/).filter(Boolean).length; lineEnds.push(total); });
  return cue.words.map((word, index) => {
    const nextStart = index + 1 < cue.words.length ? cue.words[index + 1].startFrame : cue.endFrame;
    const duration = Math.max(1, Math.round((nextStart - word.startFrame) * 100 / 30));
    const separator = lineEnds.includes(index + 1) && index + 1 < cue.words.length ? "\\N" : index + 1 < cue.words.length ? " " : "";
    return `{\\kf${duration}}${escapeAssText(word.text)}${separator}`;
  }).join("");
}

function generateAss(input, options = {}) {
  const manifest = normalizeCaptionManifest(input);
  const font = options.font || captionFontConfig(options.env || process.env);
  if (!font.available || !font.name || !font.filePath) throw new AppError("CAPTION_FONT_UNAVAILABLE", SAFE_MESSAGES.CAPTION_FONT_UNAVAILABLE, 409);
  const marginV = Math.round(1280 * (1 - manifest.safeZone.bottom));
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 720", "PlayResY: 1280", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Narration,${font.name},54,&H0000D7FF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,58,58,${marginV},1`, "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...manifest.cues.map((cue) => `Dialogue: 0,${assTime(cue.startFrame)},${assTime(cue.endFrame, "end")},Narration,,0,0,0,,${cueAssText(cue)}`),
    "",
  ];
  const buffer = Buffer.from(lines.join("\n"), "utf8");
  if (buffer.byteLength > MAX_ASS_BYTES) throw new AppError("ASS_GENERATION_FAILED", SAFE_MESSAGES.ASS_GENERATION_FAILED, 409);
  return { buffer, font: { name: font.name, fontsDir: font.fontsDir }, cueCount: manifest.cues.length, rendererVersion: manifest.rendererVersion };
}

module.exports = { MAX_ASS_BYTES, assTime, captionFontConfig, cueAssText, escapeAssText, generateAss };
