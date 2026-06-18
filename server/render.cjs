const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { normalizeStylePreset } = require("./edit-plan.cjs");
const { commandAvailable } = require("./media.cjs");

const RENDER_STYLE_CONFIG = Object.freeze({
  clean_sports: {
    captionFont: 56,
    squareCaptionFont: 46,
    labelFont: 36,
    endFont: 42,
    contrast: 1.04,
    saturation: 1.06,
    flashAlpha: 0.05,
    accentAlpha: 0.12,
    showTopLabel: false,
  },
  social_sports_v1: {
    captionFont: 64,
    squareCaptionFont: 50,
    labelFont: 42,
    endFont: 46,
    contrast: 1.08,
    saturation: 1.12,
    flashAlpha: 0.1,
    accentAlpha: 0.18,
    showTopLabel: true,
  },
  punchy_highlight: {
    captionFont: 70,
    squareCaptionFont: 54,
    labelFont: 44,
    endFont: 50,
    contrast: 1.12,
    saturation: 1.18,
    flashAlpha: 0.14,
    accentAlpha: 0.24,
    showTopLabel: true,
  },
});

const ASS_COLORS = Object.freeze({
  white: "&H00FFFFFF",
  gold: "&H005ED3F4",
  cyan: "&H00F4F45E",
  red: "&H005F4AE8",
  green: "&H0071BF2F",
});

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

function renderStyleConfig(plan = {}) {
  const stylePreset = normalizeStylePreset(plan.stylePreset);
  return {
    name: stylePreset,
    ...RENDER_STYLE_CONFIG[stylePreset],
  };
}

function labelForHighlightType(highlightType) {
  const labels = {
    goal: "GOAL",
    shot_on_target: "SHOT ON TARGET",
    near_miss: "NEAR MISS",
    big_chance: "BIG CHANCE",
    save: "KEEPER SAVE",
    foul: "FOUL",
    hard_foul: "HARD FOUL",
    card_moment: "CARD MOMENT",
    counter_attack: "COUNTER ATTACK",
    skill_move: "SKILL MOVE",
    crowd_reaction: "CROWD REACTION",
    commentator_peak: "COMMENTATOR PEAK",
    replay_or_reaction: "REPLAY MOMENT",
    replay_worthy_moment: "REPLAY-WORTHY",
    audio_energy_spike: "ENERGY SPIKE",
    unknown_action: "KEY PHASE",
    generic_highlight: "KEY MOMENT",
  };
  return labels[highlightType] || labels.generic_highlight;
}

function goalOutcomeBadgeLabel(goalOutcome = {}) {
  if (!goalOutcome || goalOutcome.eventType !== "ball_in_net") return null;
  const labels = {
    confirmed_goal: "CONFIRMED",
    disallowed_offside: "OFFSIDE - NO GOAL",
    possible_offside: "POSSIBLE OFFSIDE",
    unknown_decision: "DECISION UNCLEAR",
  };
  return labels[goalOutcome.outcome] || null;
}

function topLabelForPlan(plan = {}) {
  return goalOutcomeBadgeLabel(plan.goalOutcome) || labelForHighlightType(plan.highlightType);
}

function goalOutcomeBadges(plan = {}, duration = 0) {
  const badges = [];
  const planLabel = goalOutcomeBadgeLabel(plan.goalOutcome);
  if (planLabel) {
    badges.push({ start: 0, end: Math.min(Number(duration) || 0, 4.5), label: planLabel });
  }
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  for (const segment of segments) {
    const label = goalOutcomeBadgeLabel(segment && segment.goalOutcome);
    if (!label) continue;
    const start = Number(segment.timelineStart || 0);
    const end = Math.min(Number(segment.timelineEnd || start + 4.5), start + 4.5);
    if (end > start) badges.push({ start, end, label });
  }
  return badges.slice(0, 8);
}

function renderDimensions(plan = {}) {
  const output = plan.export && typeof plan.export === "object" ? plan.export : {};
  const width = Number(output.width);
  const height = Number(output.height);
  if (width === 1080 && height === 1080) return { width, height };
  return { width: 1080, height: 1920 };
}

function endBeatText(plan = {}) {
  if (plan.endBeatText) return escapeAss(plan.endBeatText);
  const storyCaptions = plan.footballStoryPlan && Array.isArray(plan.footballStoryPlan.captionBeats)
    ? plan.footballStoryPlan.captionBeats
    : [];
  const closing = storyCaptions.find((caption) => caption.role === "closing_punch") || storyCaptions[storyCaptions.length - 1];
  return escapeAss((closing && closing.text) || "WATCH IT AGAIN");
}

function captionStyleName(caption) {
  const role = String(caption.role || "caption").replace(/[^A-Za-z0-9_]/g, "_");
  return `Caption_${role}_${Number(caption.index) || 0}`;
}

function assColorForToken(token) {
  return ASS_COLORS[token] || ASS_COLORS.gold;
}

function alignmentForLayout(layout) {
  const safe = String(layout || "bottom");
  if (safe === "top") return 8;
  if (safe === "center") return 5;
  if (safe === "split") return 8;
  return 2;
}

function marginForCaption(caption, dimensions) {
  const square = dimensions.width === dimensions.height;
  const layout = caption.layout || "bottom";
  if (layout === "top") return square ? 78 : 112;
  if (layout === "center") return 0;
  if (layout === "split") return square ? 132 : 210;
  return square ? 78 : 190;
}

function fontSizeForCaption(caption, dimensions, config) {
  const base = dimensions.width === dimensions.height ? config.squareCaptionFont : config.captionFont;
  const scale = Number(caption.style && caption.style.fontScale) || 1;
  return Math.round(base * Math.max(0.72, Math.min(1.25, scale)));
}

function wrapCaptionLines(text, caption, dimensions) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const fontScale = Number(caption.style && caption.style.fontScale) || 1;
  const layout = caption.layout || "bottom";
  const maxLines = Math.max(1, Math.min(3, Number(caption.style && caption.style.maxLines) || 2));
  const baseChars = dimensions.width === dimensions.height ? 22 : 18;
  const maxChars = Math.max(10, Math.round((layout === "top" ? baseChars + 12 : baseChars) / Math.max(0.8, fontScale)));
  const words = raw.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  const bounded = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const extra = lines.slice(maxLines - 1).join(" ");
    bounded[maxLines - 1] = `${extra.slice(0, Math.max(8, maxChars - 3)).trim()}...`;
  }
  return bounded.map((line) => escapeAss(line));
}

function emphasisWordsForCaption(caption, plan) {
  const emphasis = Array.isArray(plan.captionEmphasis)
    ? plan.captionEmphasis.find((item) => Number(item.captionIndex) === Number(caption.index))
    : null;
  const words = emphasis && Array.isArray(emphasis.words)
    ? emphasis.words.slice(0, 3)
    : String(caption.text || "")
      .split(/\s+/)
      .filter((word) => word.length >= 4)
      .slice(0, caption.emphasis === "detail" ? 1 : 2);
  return words;
}

function emphasizedAssText(caption, plan, dimensions) {
  const styleName = captionStyleName(caption);
  const displayText = caption.style && caption.style.uppercase ? String(caption.text || "").toUpperCase() : String(caption.text || "");
  let text = wrapCaptionLines(displayText, caption, dimensions).join("\\N");
  const words = emphasisWordsForCaption(caption, plan);
  for (const word of words) {
    const safeWord = escapeAss(word).trim();
    if (!safeWord) continue;
    const pattern = new RegExp(`\\b(${escapeRegExp(safeWord)})\\b`, "gi");
    const highlightColor = assColorForToken(caption.style && caption.style.highlightColor);
    text = text.replace(pattern, `{\\c${highlightColor}\\b1}$1{\\r${styleName}}`);
  }
  const entranceMs = Math.max(80, Math.min(450, Number(caption.timing && caption.timing.entranceMs) || 160));
  const exitMs = Math.max(80, Math.min(350, Number(caption.timing && caption.timing.exitMs) || 120));
  const startScale = caption.emphasis === "shout" ? 86 : caption.emphasis === "detail" ? 96 : 92;
  const peakScale = caption.emphasis === "shout" ? 104 : caption.emphasis === "strong" ? 102 : 100;
  return `{\\fad(${entranceMs},${exitMs})\\fscx${startScale}\\fscy${startScale}\\t(0,${entranceMs},\\fscx${peakScale}\\fscy${peakScale})}${text}`;
}

function captionStyleLine(caption, dimensions, config) {
  const styleName = captionStyleName(caption);
  const fontSize = fontSizeForCaption(caption, dimensions, config);
  const outline = Number(caption.style && caption.style.stroke) || 5;
  const shadow = Number(caption.style && caption.style.shadow) || 2;
  const alignment = alignmentForLayout(caption.layout);
  const margin = marginForCaption(caption, dimensions);
  const backColour = caption.emphasis === "detail" ? "&H66000000" : "&HAA000000";
  return `Style: ${styleName},Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00151A18,${backColour},-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},64,64,${margin},1`;
}

function writeAssSubtitles(plan, outputPath) {
  const segmentDuration = Array.isArray(plan.segments)
    ? plan.segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.sourceEnd) - Number(segment.sourceStart)), 0)
    : 0;
  const duration = Math.max(0.1, Number(plan.totalDuration) || segmentDuration || Number(plan.sourceEnd - plan.sourceStart) || 0.1);
  const dimensions = renderDimensions(plan);
  const config = renderStyleConfig(plan);
  const square = dimensions.width === dimensions.height;
  const captions = Array.isArray(plan.captions) ? plan.captions : [];
  const uniqueStyleLines = captions.map((caption) => captionStyleLine(caption, dimensions, config));
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${dimensions.width}`,
    `PlayResY: ${dimensions.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...uniqueStyleLines,
    `Style: TopLabel,Arial,${config.labelFont},&H00FFFFFF,&H000000FF,&H00151A18,&HCC111614,-1,0,0,0,100,100,0,0,1,3,1,8,60,60,${square ? 48 : 72},1`,
    `Style: OutcomeBadge,Arial,${Math.max(32, Math.round(config.labelFont * 0.82))},&H00FFFFFF,&H000000FF,&H00151A18,&HDD111614,-1,0,0,0,100,100,0,0,1,3,1,9,64,64,${square ? 96 : 142},1`,
    `Style: EndBeat,Arial,${config.endFont},&H005ED3F4,&H000000FF,&H00151A18,&HAA000000,-1,0,0,0,100,100,0,0,1,4,1,2,70,70,${square ? 70 : 92},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (config.showTopLabel) {
    lines.push(
      `Dialogue: 1,${assTime(0)},${assTime(Math.min(2.4, duration))},TopLabel,,0,0,0,,${escapeAss(topLabelForPlan(plan))} · ${escapeAss(config.name.replace(/_/g, " ").toUpperCase())}`,
    );
  }
  for (const badge of goalOutcomeBadges(plan, duration)) {
    lines.push(
      `Dialogue: 2,${assTime(badge.start)},${assTime(badge.end)},OutcomeBadge,,0,0,0,,${escapeAss(badge.label)}`,
    );
  }
  for (const caption of captions) {
    lines.push(
      `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},${captionStyleName(caption)},,0,0,0,,${emphasizedAssText(caption, plan, dimensions)}`,
    );
  }
  if (config.showTopLabel && duration >= 2.2) {
    lines.push(
      `Dialogue: 1,${assTime(Math.max(0, duration - 1.35))},${assTime(duration)},EndBeat,,0,0,0,,${endBeatText(plan)}`,
    );
  }
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function escapeFilterPath(path) {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function safeAnimationCues(plan = {}) {
  return (Array.isArray(plan.animationCues) ? plan.animationCues : [])
    .filter((cue) => cue && typeof cue.type === "string" && Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)) && Number(cue.end) > Number(cue.start))
    .slice(0, 10)
    .map((cue) => ({
      type: cue.type,
      start: Number(cue.start.toFixed ? cue.start.toFixed(2) : Number(cue.start).toFixed(2)),
      end: Number(cue.end.toFixed ? cue.end.toFixed(2) : Number(cue.end).toFixed(2)),
    }));
}

function hasCue(plan, types) {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  return safeAnimationCues(plan).some((cue) => wanted.has(cue.type));
}

function cueEnable(cue) {
  return `between(t,${cue.start},${cue.end})`;
}

function visualEffectFilters(plan, dimensions, config) {
  const filters = [];
  for (const cue of safeAnimationCues(plan)) {
    const enable = cueEnable(cue);
    if (cue.type === "intro_hook") {
      filters.push(`drawbox=x=0:y=${dimensions.height - 12}:w=${dimensions.width}:h=12:color=white@${config.accentAlpha}:t=fill:enable='${enable}'`);
    } else if (cue.type === "beat_cut") {
      filters.push(`drawbox=x=0:y=0:w=${dimensions.width}:h=8:color=white@${config.accentAlpha}:t=fill:enable='${enable}'`);
      filters.push(`drawbox=x=0:y=${dimensions.height - 8}:w=${dimensions.width}:h=8:color=white@${config.accentAlpha}:t=fill:enable='${enable}'`);
    } else if (cue.type === "punch_zoom") {
      filters.push(`drawbox=x=0:y=0:w=${dimensions.width}:h=${dimensions.height}:color=white@${config.accentAlpha}:t=10:enable='${enable}'`);
    } else if (cue.type === "impact_flash") {
      filters.push(`drawbox=x=0:y=0:w=${dimensions.width}:h=${dimensions.height}:color=white@${config.flashAlpha}:t=fill:enable='${enable}'`);
    } else if (cue.type === "replay_stutter") {
      filters.push(`drawbox=x=0:y=${Math.round(dimensions.height * 0.32)}:w=${dimensions.width}:h=5:color=white@${config.accentAlpha}:t=fill:enable='${enable}'`);
      filters.push(`drawbox=x=0:y=${Math.round(dimensions.height * 0.68)}:w=${dimensions.width}:h=5:color=white@${config.accentAlpha}:t=fill:enable='${enable}'`);
    }
  }
  return filters;
}

function activeSoftFollowCrop(plan = {}) {
  const cropPlan = plan.cropPlan && typeof plan.cropPlan === "object" ? plan.cropPlan : null;
  if (
    !cropPlan ||
    cropPlan.mode !== "soft_follow" ||
    cropPlan.fallbackUsed ||
    cropPlan.textObstructionRisk ||
    Number(cropPlan.confidence || 0) < 0.86
  ) return null;
  const box = cropPlan.cropBox;
  if (!box || [box.x, box.y, box.width, box.height].some((value) => !Number.isFinite(Number(value)))) return null;
  if (Number(box.width) <= 1 || Number(box.height) <= 1) return null;
  return {
    x: Math.max(0, Math.round(Number(box.x))),
    y: Math.max(0, Math.round(Number(box.y))),
    width: Math.max(2, Math.round(Number(box.width))),
    height: Math.max(2, Math.round(Number(box.height))),
  };
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

function concatFileLine(filePath) {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

function normalizedRenderSegments(plan = {}) {
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  return segments.map((segment, index) => {
    const sourceStart = Number(segment.sourceStart);
    const sourceEnd = Number(segment.sourceEnd);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return null;
    return {
      id: segment.id || `segment_${index + 1}`,
      sourceStart,
      sourceEnd,
      duration: Number((sourceEnd - sourceStart).toFixed(2)),
    };
  }).filter(Boolean);
}

function singleWindowPlan(plan, duration) {
  return {
    ...plan,
    mode: "single_moment",
    sourceStart: 0,
    sourceEnd: Number(duration.toFixed(2)),
    totalDuration: Number(duration.toFixed(2)),
    segments: Array.isArray(plan.segments) ? plan.segments : [],
  };
}

async function renderSingleWindowShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner = runFfmpeg }) {
  writeAssSubtitles(plan, subtitlesPath);
  const duration = Number((Number(plan.totalDuration) || plan.sourceEnd - plan.sourceStart).toFixed(2));
  const dimensions = renderDimensions(plan);
  const config = renderStyleConfig(plan);
  const subtitlesFilter = `subtitles=filename='${escapeFilterPath(subtitlesPath)}'`;
  const toneFilter = `eq=contrast=${config.contrast}:saturation=${config.saturation}`;
  const effects = visualEffectFilters(plan, dimensions, config);
  const finishingFilters = ["setsar=1", toneFilter, ...effects, subtitlesFilter];
  const backgroundPush = hasCue(plan, ["subtle_camera_push", "punch_zoom"]) ? 1.035 : 1;
  const backgroundWidth = Math.round(dimensions.width * backgroundPush);
  const backgroundHeight = Math.round(dimensions.height * backgroundPush);
  const softFollowCrop = activeSoftFollowCrop(plan);
  const filter = softFollowCrop
    ? [
        `[0:v]crop=${softFollowCrop.width}:${softFollowCrop.height}:${softFollowCrop.x}:${softFollowCrop.y}`,
        `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase`,
        `crop=${dimensions.width}:${dimensions.height}`,
        `${finishingFilters.join(",")}[v]`,
      ].join(",")
    : ["wide_safe", "wide_safe_vertical"].includes(plan.framingMode)
    ? [
        `[0:v]scale=${backgroundWidth}:${backgroundHeight}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height},boxblur=18:1[bg]`,
        `[0:v]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,${finishingFilters.join(",")}[v]`,
      ].join(";")
    : [
        `[0:v]scale=${Math.round(dimensions.width * 1.04)}:${Math.round(dimensions.height * 1.04)}:force_original_aspect_ratio=increase`,
        `crop=${dimensions.width}:${dimensions.height}`,
        `${finishingFilters.join(",")}[v]`,
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
  await ffmpegRunner(args, { signal });
  return outputPath;
}

async function renderMultiSegmentShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner = runFfmpeg }) {
  const segments = normalizedRenderSegments(plan);
  if (segments.length < 2) {
    throw new AppError("RENDER_FAILED", "Multi-moment render needs at least two valid segments.", 500);
  }
  const totalDuration = Number(segments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(2));
  if (!Number.isFinite(totalDuration) || totalDuration <= 0 || totalDuration > 60) {
    throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
  }
  const tempDir = mkdtempSync(join(dirname(outputPath), `.shortsengine-${basename(outputPath, ".mp4")}-`));
  const segmentPaths = [];
  try {
    for (const [index, segment] of segments.entries()) {
      const segmentPath = join(tempDir, `segment-${String(index + 1).padStart(2, "0")}.mp4`);
      segmentPaths.push(segmentPath);
      await ffmpegRunner([
        "-y",
        "-ss",
        String(segment.sourceStart),
        "-i",
        inputPath,
        "-t",
        String(segment.duration),
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
        segmentPath,
      ], { signal });
    }
    const concatListPath = join(tempDir, "concat.txt");
    const concatPath = join(tempDir, "joined.mp4");
    writeFileSync(concatListPath, `${segmentPaths.map(concatFileLine).join("\n")}\n`, "utf8");
    await ffmpegRunner([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      concatPath,
    ], { signal });
    await renderSingleWindowShort({
      inputPath: concatPath,
      outputPath,
      subtitlesPath,
      plan: singleWindowPlan(plan, totalDuration),
      signal,
      ffmpegRunner,
    });
    return outputPath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function renderShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner = runFfmpeg }) {
  if (Array.isArray(plan && plan.segments) && plan.segments.length > 1) {
    return renderMultiSegmentShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner });
  }
  return renderSingleWindowShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner });
}

module.exports = {
  assTime,
  writeAssSubtitles,
  runFfmpeg,
  extractAudio,
  renderShort,
};
