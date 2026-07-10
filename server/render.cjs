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
  reference_football_multi_goal_v1: {
    captionFont: 66,
    squareCaptionFont: 52,
    labelFont: 40,
    endFont: 48,
    contrast: 1.1,
    saturation: 1.14,
    flashAlpha: 0.08,
    accentAlpha: 0.2,
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

const RENDER_PROFILES = Object.freeze({
  quality: {
    name: "quality",
    preset: "veryfast",
    crf: "23",
    audioBitrate: "128k",
    maxVerticalHeight: 1920,
    maxSquareSize: 1080,
    blurredBackground: true,
    segmentMode: "fade_transcode",
  },
  proof_fast: {
    name: "proof_fast",
    preset: "ultrafast",
    crf: "28",
    audioBitrate: "96k",
    maxVerticalHeight: 1920,
    maxSquareSize: 720,
    blurredBackground: false,
    segmentMode: "fast_fade_transcode",
    outputFrameRate: "30",
  },
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

function normalizeRenderProfileName(value) {
  const safe = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RENDER_PROFILES, safe) ? safe : "quality";
}

function renderProfileConfig(plan = {}) {
  const configured = plan && plan.renderProfile ? plan.renderProfile : process.env.SHORTSENGINE_RENDER_PROFILE;
  return RENDER_PROFILES[normalizeRenderProfileName(configured)];
}

function isValidGoalsProofPlan(plan = {}) {
  return plan && (
    plan.mode === "valid_goals_only" ||
    plan.goalSelectionMode === "valid_goals_only" ||
    plan.validGoalsOnly === true
  );
}

function shouldUseBlurredBackground(plan = {}, profile = renderProfileConfig(plan)) {
  if (isValidGoalsProofPlan(plan)) return false;
  return profile.blurredBackground === true;
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
  if (goalOutcome.safeCaptionBadge) return escapeAss(goalOutcome.safeCaptionBadge);
  const labels = {
    confirmed_goal: "CONFIRMED GOAL",
    disallowed_offside: "OFFSIDE - NO GOAL",
    possible_offside: Array.isArray(goalOutcome.decisionEvidence) && goalOutcome.decisionEvidence.some((code) => code === "var_check" || code === "visual_var_check" || code === "var_decision" || code === "visual_var_decision")
      ? "VAR CHECK"
      : "POSSIBLE OFFSIDE",
    unknown_decision: "DECISION UNCLEAR",
  };
  return labels[goalOutcome.outcome] || null;
}

function topLabelForPlan(plan = {}) {
  return goalOutcomeBadgeLabel(plan.goalOutcome) || labelForHighlightType(plan.highlightType);
}

function segmentBadgeLabel(segment = {}, label = "") {
  const goalNumber = Number(segment.goalNumber);
  if (Number.isFinite(goalNumber) && goalNumber > 0 && /confirmed goal/i.test(label)) {
    return `GOAL ${Math.round(goalNumber)} · CONFIRMED`;
  }
  return label;
}

function badgeStartForSegment(segment = {}) {
  const timelineStart = Number(segment.timelineStart || 0);
  const sourceStart = Number(segment.sourceStart);
  const confirmationTime = Number(segment.confirmationTime);
  if (Number.isFinite(sourceStart) && Number.isFinite(confirmationTime) && confirmationTime >= sourceStart) {
    return Number(Math.max(timelineStart, timelineStart + confirmationTime - sourceStart - 0.2).toFixed(2));
  }
  return timelineStart;
}

function goalOutcomeBadges(plan = {}, duration = 0) {
  const badges = [];
  const planLabel = goalOutcomeBadgeLabel(plan.goalOutcome);
  if (planLabel) {
    const decisionTimestamp = Number(plan.goalOutcome && plan.goalOutcome.decisionTimestamp);
    const sourceStart = Number(plan.sourceStart || 0);
    const start = Number.isFinite(decisionTimestamp)
      ? Number(Math.max(0, decisionTimestamp - sourceStart - 0.2).toFixed(2))
      : 0;
    badges.push({ start, end: Math.min(Number(duration) || 0, start + 4.5), label: planLabel });
  }
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  for (const segment of segments) {
    const label = goalOutcomeBadgeLabel(segment && segment.goalOutcome);
    if (!label) continue;
    const start = badgeStartForSegment(segment);
    const end = Math.min(Number(segment.timelineEnd || start + 4.5), start + 4.5);
    if (end > start) badges.push({ start, end, label: segmentBadgeLabel(segment, label) });
  }
  return badges.slice(0, 8);
}

function renderDimensions(plan = {}) {
  const profile = renderProfileConfig(plan);
  const output = plan.export && typeof plan.export === "object" ? plan.export : {};
  const width = Number(output.width);
  const height = Number(output.height);
  if (width === 1080 && height === 1080) {
    const square = Math.min(width, profile.maxSquareSize);
    return { width: square, height: square };
  }
  const verticalHeight = Math.min(1920, profile.maxVerticalHeight);
  const verticalWidth = Math.round(verticalHeight * 9 / 16);
  return { width: verticalWidth, height: verticalHeight };
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
    const pattern = new RegExp(`(${escapeRegExp(safeWord)})`, "gi");
    const highlightColor = assColorForToken(caption.style && caption.style.highlightColor);
    text = text.replace(pattern, `{\\c${highlightColor}\\b1}$1{\\r${styleName}}`);
  }
  const entranceMs = Math.max(80, Math.min(450, Number(caption.timing && caption.timing.entranceMs) || 160));
  const exitMs = Math.max(80, Math.min(350, Number(caption.timing && caption.timing.exitMs) || 120));
  const startScale = caption.emphasis === "shout" ? 86 : caption.emphasis === "detail" ? 96 : 92;
  const peakScale = caption.emphasis === "shout" ? 104 : caption.emphasis === "strong" ? 102 : 100;
  return `{\\fad(${entranceMs},${exitMs})\\fscx${startScale}\\fscy${startScale}\\t(0,${entranceMs},\\fscx${peakScale}\\fscy${peakScale})}${text}`;
}

function captionHasWordTiming(caption) {
  return Array.isArray(caption && caption.activeWordTiming) &&
    caption.activeWordTiming.length > 0 &&
    Array.isArray(caption.words) &&
    caption.words.length > 0;
}

function wordBeatText(caption, activeIndex) {
  const words = Array.isArray(caption.words) && caption.words.length
    ? caption.words
    : String(caption.text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return String(caption.text || "");
  const maxWords = Math.max(2, Math.min(4, Number(caption.maxWordsPerBeat || 4) || 4));
  const boundedIndex = Math.max(0, Math.min(words.length - 1, activeIndex));
  let start = Math.max(0, boundedIndex - 1);
  let end = Math.min(words.length, start + maxWords);
  if (end - start < maxWords) start = Math.max(0, end - maxWords);
  return words.slice(start, end).join(" ");
}

function dynamicWordAssText(caption, plan, dimensions, activeWord, activeIndex) {
  const styleName = captionStyleName(caption);
  const beatCaption = {
    ...caption,
    text: wordBeatText(caption, activeIndex),
    emphasisWords: [activeWord],
  };
  const displayText = beatCaption.style && beatCaption.style.uppercase
    ? String(beatCaption.text || "").toUpperCase()
    : String(beatCaption.text || "");
  let text = wrapCaptionLines(displayText, beatCaption, dimensions).join("\\N");
  const safeWord = escapeAss(activeWord).trim();
  if (safeWord) {
    const pattern = new RegExp(`(${escapeRegExp(safeWord)})`, "gi");
    const highlightColor = assColorForToken(beatCaption.style && beatCaption.style.highlightColor);
    text = text.replace(pattern, `{\\c${highlightColor}\\b1}$1{\\r${styleName}}`);
  }
  const entranceMs = Math.max(40, Math.min(180, Number(beatCaption.timing && beatCaption.timing.entranceMs) || 90));
  return `{\\fad(${entranceMs},80)\\fscx94\\fscy94\\t(0,${entranceMs},\\fscx104\\fscy104)}${text}`;
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
  const showTopLabel = config.showTopLabel && !(plan.scoreboardOverlay && plan.scoreboardOverlay.enabled === true);
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
  if (showTopLabel) {
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
    if (captionHasWordTiming(caption)) {
      caption.activeWordTiming.slice(0, 18).forEach((wordTiming, index) => {
        const start = Math.max(Number(caption.start), Number(wordTiming.start));
        const end = Math.min(Number(caption.end), Number(wordTiming.end));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        lines.push(
          `Dialogue: 0,${assTime(start)},${assTime(end)},${captionStyleName(caption)},,0,0,0,,${dynamicWordAssText(caption, plan, dimensions, wordTiming.word, index)}`,
        );
      });
    } else {
      lines.push(
        `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},${captionStyleName(caption)},,0,0,0,,${emphasizedAssText(caption, plan, dimensions)}`,
      );
    }
  }
  if (showTopLabel && duration >= 2.2) {
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

function sourceWidthForCropPlan(cropPlan = {}) {
  const safeArea = cropPlan.safeArea && typeof cropPlan.safeArea === "object" ? cropPlan.safeArea : null;
  const cropBox = cropPlan.cropBox && typeof cropPlan.cropBox === "object" ? cropPlan.cropBox : null;
  return Math.max(
    2,
    Number(safeArea && safeArea.x || 0) + Number(safeArea && safeArea.width || 0),
    Number(cropBox && cropBox.x || 0) + Number(cropBox && cropBox.width || 0),
  );
}

function sourceKeyframesForSegment(keyframes, segment) {
  return keyframes.filter((keyframe) => (
    keyframe.sourceTime >= segment.sourceStart - 0.05 &&
    keyframe.sourceTime <= segment.sourceEnd + 0.05
  ));
}

function mappedBallFollowKeyframes(plan = {}, cropPlan = {}) {
  const sourceKeyframes = (Array.isArray(cropPlan.keyframes) ? cropPlan.keyframes : [])
    .filter((keyframe) => keyframe && Number.isFinite(Number(keyframe.sourceTime)) && Number.isFinite(Number(keyframe.centerX)))
    .map((keyframe) => ({ ...keyframe, sourceTime: Number(keyframe.sourceTime), centerX: Number(keyframe.centerX) }))
    .sort((left, right) => left.sourceTime - right.sourceTime)
    .slice(0, 24);
  if (sourceKeyframes.length < 3) return [];
  const segments = normalizedRenderSegments(plan);
  const effectiveSegments = segments.length
    ? segments
    : [{
        sourceStart: Number(plan.sourceStart || 0),
        sourceEnd: Number(plan.sourceEnd || plan.totalDuration || 0),
        duration: Number(plan.totalDuration || 0) || Number(plan.sourceEnd || 0) - Number(plan.sourceStart || 0),
      }];
  const cropWidth = Math.max(2, Number(cropPlan.cropBox && cropPlan.cropBox.width || 0));
  const sourceWidth = sourceWidthForCropPlan(cropPlan);
  const mapped = [];
  let timelineCursor = 0;
  let previousX = null;
  for (const [segmentIndex, segment] of effectiveSegments.entries()) {
    const segmentKeyframes = sourceKeyframesForSegment(sourceKeyframes, segment);
    if (!segmentKeyframes.length) {
      const centerX = Math.max(0, (sourceWidth - cropWidth) / 2);
      if (segmentIndex > 0 && previousX !== null) {
        mapped.push({ time: Math.max(0, timelineCursor - 0.04), x: previousX, reset: false });
      }
      mapped.push({ time: Number(timelineCursor.toFixed(3)), x: centerX, reset: true });
      mapped.push({ time: Number((timelineCursor + segment.duration).toFixed(3)), x: centerX, reset: false });
      previousX = centerX;
      timelineCursor += segment.duration;
      continue;
    }
    const first = segmentKeyframes[0];
    const firstX = Math.max(0, Math.min(sourceWidth - cropWidth, first.centerX - cropWidth / 2));
    if (segmentIndex > 0 && previousX !== null) {
      mapped.push({ time: Math.max(0, timelineCursor - 0.04), x: previousX, reset: false });
    }
    mapped.push({ time: Number(timelineCursor.toFixed(3)), x: firstX, reset: segmentIndex > 0 || Boolean(first.reset) });
    for (const keyframe of segmentKeyframes) {
      const localTime = Math.max(0, Math.min(segment.duration, keyframe.sourceTime - segment.sourceStart));
      const x = Math.max(0, Math.min(sourceWidth - cropWidth, keyframe.centerX - cropWidth / 2));
      mapped.push({
        time: Number((timelineCursor + localTime).toFixed(3)),
        x: Number(x.toFixed(2)),
        reset: Boolean(keyframe.reset && localTime <= 0.1),
      });
      previousX = x;
    }
    mapped.push({
      time: Number((timelineCursor + segment.duration).toFixed(3)),
      x: Number((previousX === null ? firstX : previousX).toFixed(2)),
      reset: false,
    });
    timelineCursor += segment.duration;
  }
  const deduped = [];
  for (const keyframe of mapped.sort((left, right) => left.time - right.time)) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.time - keyframe.time) < 0.005) {
      deduped[deduped.length - 1] = keyframe;
    } else {
      deduped.push(keyframe);
    }
  }
  return deduped.slice(0, 48);
}

function cropXExpression(keyframes = []) {
  if (!keyframes.length) return "0";
  let expression = Number(keyframes[keyframes.length - 1].x).toFixed(2);
  for (let index = keyframes.length - 2; index >= 0; index -= 1) {
    const current = keyframes[index];
    const next = keyframes[index + 1];
    const duration = Math.max(0.001, next.time - current.time);
    const delta = next.x - current.x;
    const linear = next.reset
      ? Number(current.x).toFixed(2)
      : `${Number(current.x).toFixed(2)}+(${Number(delta).toFixed(2)})*(t-${Number(current.time).toFixed(3)})/${duration.toFixed(3)}`;
    expression = `if(lt(t,${Number(next.time).toFixed(3)}),${linear},${expression})`;
  }
  return expression;
}

function activeBallFollowCrop(plan = {}) {
  const cropPlan = plan.cropPlan && typeof plan.cropPlan === "object" ? plan.cropPlan : null;
  if (
    !cropPlan ||
    cropPlan.mode !== "ball_follow" ||
    cropPlan.fallbackUsed ||
    Number(cropPlan.confidence || 0) < 0.52
  ) return null;
  const box = cropPlan.cropBox;
  if (!box || [box.width, box.height].some((value) => !Number.isFinite(Number(value)) || Number(value) <= 1)) return null;
  const keyframes = mappedBallFollowKeyframes(plan, cropPlan);
  if (keyframes.length < 3) return null;
  return {
    width: Math.max(2, Math.round(Number(box.width))),
    height: Math.max(2, Math.round(Number(box.height))),
    keyframes,
    xExpression: cropXExpression(keyframes),
    maxPanSpeed: Number(cropPlan.maxPanSpeed || 0),
  };
}

function actionCropFilter(crop) {
  if (!crop) return null;
  if (crop.xExpression) {
    return `crop=w=${crop.width}:h=${crop.height}:x='${crop.xExpression}':y=0`;
  }
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
}

function activeScoreboardOverlay(plan = {}, dimensions = renderDimensions(plan)) {
  const overlay = plan.scoreboardOverlay && typeof plan.scoreboardOverlay === "object"
    ? plan.scoreboardOverlay
    : null;
  if (!overlay || overlay.enabled !== true || overlay.mode !== "source_roi") return null;
  if (!activeSoftFollowCrop(plan) && !activeBallFollowCrop(plan) && !["safe_center", "action_bias"].includes(plan.framingMode)) return null;
  const rect = overlay.sourceRect && typeof overlay.sourceRect === "object" ? overlay.sourceRect : {};
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x + width > 1 || y + height > 1
  ) return null;
  const targetWidth = Math.max(2, Math.round((dimensions.width * Number(overlay.outputWidthRatio || 0.7)) / 2) * 2);
  const topMargin = Math.max(0, Math.round(dimensions.height * Number(overlay.topMarginRatio || 0.055)));
  const cropPlan = plan.cropPlan && typeof plan.cropPlan === "object" ? plan.cropPlan : {};
  const sourceWidth = sourceWidthForCropPlan(cropPlan);
  const sourceHeight = Math.max(
    2,
    Number(cropPlan.safeArea && cropPlan.safeArea.y || 0) + Number(cropPlan.safeArea && cropPlan.safeArea.height || 0),
    Number(cropPlan.cropBox && cropPlan.cropBox.y || 0) + Number(cropPlan.cropBox && cropPlan.cropBox.height || 0),
  );
  return {
    regionId: String(overlay.regionId || "scoreboard_region"),
    x,
    y,
    width,
    height,
    targetWidth,
    topMargin,
    maskX: Math.max(0, Math.round(sourceWidth * x)),
    maskY: Math.max(0, Math.round(sourceHeight * y)),
    maskWidth: Math.max(8, Math.round(sourceWidth * width)),
    maskHeight: Math.max(8, Math.round(sourceHeight * height)),
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
    let settled = false;
    let killTimer = null;
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", abort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const killChild = (signalName) => {
      if (child.killed) return;
      try {
        child.kill(signalName);
      } catch {
        // The process may have exited between the state check and kill call.
      }
    };
    const timeout = setTimeout(() => {
      killChild("SIGKILL");
      settle(reject, new AppError("RENDER_FAILED", "Render timed out.", 500));
    }, timeoutMs);
    const abort = () => {
      killChild("SIGTERM");
      killTimer = setTimeout(() => killChild("SIGKILL"), 2000);
      settle(reject, new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
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
      settle(reject, new AppError("FFMPEG_MISSING", SAFE_MESSAGES.FFMPEG_MISSING, 503));
    });
    child.on("close", (code) => {
      if (settled) {
        cleanup();
        return;
      }
      if (code === 0) settle(resolve, { stderr });
      else settle(reject, new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, { stderr: stderr.slice(-1200) }));
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

function segmentVideoFadeFilter(segment) {
  const duration = Math.max(0.1, Number(segment && segment.duration) || 0.1);
  const fadeIn = Number(Math.min(0.28, Math.max(0.12, duration * 0.018)).toFixed(2));
  const fadeOut = Number(Math.min(0.34, Math.max(0.16, duration * 0.022)).toFixed(2));
  const fadeOutStart = Number(Math.max(0, duration - fadeOut).toFixed(2));
  return `fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${fadeOutStart}:d=${fadeOut}`;
}

function boundedTransitionDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.4;
  return Number(Math.max(0.12, Math.min(0.8, parsed)).toFixed(2));
}

function safeRenderTransitions(plan = {}, segments = []) {
  const transitionPlan = Array.isArray(plan.transitionPlan) ? plan.transitionPlan : [];
  const transitions = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const raw = transitionPlan[index - 1] && typeof transitionPlan[index - 1] === "object"
      ? transitionPlan[index - 1]
      : {};
    const timelineStart = Number(raw.timelineStart ?? segment.timelineStart ?? segments
      .slice(0, index)
      .reduce((sum, item) => sum + Number(item.duration || 0), 0));
    transitions.push({
      fromSegmentId: String(raw.fromSegmentId || segments[index - 1].id || `segment_${index}`).slice(0, 64),
      toSegmentId: String(raw.toSegmentId || segment.id || `segment_${index + 1}`).slice(0, 64),
      timelineStart: Number.isFinite(timelineStart) ? Number(Math.max(0, timelineStart).toFixed(2)) : 0,
      type: ["short_fade", "crossfade", "segment_fade"].includes(raw.type) ? raw.type : "segment_fade",
      transitionDurationSeconds: boundedTransitionDuration(raw.transitionDurationSeconds),
      renderedBy: "segment_fade_concat",
    });
  }
  return transitions;
}

function captionMotionCount(plan = {}) {
  return Array.isArray(plan.captions)
    ? plan.captions.filter((caption) => Number(caption && caption.end) > Number(caption && caption.start)).length
    : 0;
}

function dynamicCaptionCount(plan = {}) {
  return Array.isArray(plan.captions)
    ? plan.captions.filter(captionHasWordTiming).length
    : 0;
}

function createRenderPolishSummary(plan = {}, options = {}) {
  const dimensions = renderDimensions(plan);
  const config = renderStyleConfig(plan);
  const profile = renderProfileConfig(plan);
  const segments = normalizedRenderSegments(plan);
  const cleanActionLayoutRequired = isValidGoalsProofPlan(plan);
  const blurredBackgroundUsed = shouldUseBlurredBackground(plan, profile);
  const softFollowCrop = activeSoftFollowCrop(plan);
  const ballFollowCrop = activeBallFollowCrop(plan);
  const visualTracking = plan.visualTrackingSummary && typeof plan.visualTrackingSummary === "object"
    ? plan.visualTrackingSummary
    : {};
  const scoreboardOverlay = activeScoreboardOverlay(plan, dimensions);
  const splitLayoutCaptionCount = Array.isArray(plan.captions)
    ? plan.captions.filter((caption) => caption && caption.layout === "split").length
    : 0;
  const actionLayoutMode = blurredBackgroundUsed
    ? "blurred_duplicate_background"
    : scoreboardOverlay
      ? ballFollowCrop
        ? "ball_follow_with_synchronized_scorebug"
        : "scorebug_preserved_vertical_fill"
      : ballFollowCrop
        ? "ball_follow_action_crop"
      : softFollowCrop
        ? "clean_action_crop"
        : "clean_action_letterbox";
  const duration = Number(plan.totalDuration) || segments.reduce((sum, segment) => sum + segment.duration, 0) || Number(plan.sourceEnd) - Number(plan.sourceStart) || 0;
  const transitions = safeRenderTransitions(plan, segments);
  const transitionTargetCount = Math.max(0, segments.length - 1);
  const renderedTransitionHint = Number(options.transitionRenderedCount);
  const transitionRenderedCount = transitionTargetCount > 0
    ? Math.min(
        transitionTargetCount,
        Number.isFinite(renderedTransitionHint)
          ? Math.max(0, renderedTransitionHint)
          : transitions.length,
      )
    : 0;
  const hardCutFallbackCount = Math.max(0, transitionTargetCount - transitionRenderedCount);
  const showTopLabel = config.showTopLabel && !scoreboardOverlay;
  const overlayRenderedCount = goalOutcomeBadges(plan, duration).length +
    (showTopLabel ? 1 : 0) +
    (showTopLabel && duration >= 2.2 ? 1 : 0) +
    (scoreboardOverlay ? 1 : 0);
  const animatedCaptionCount = captionMotionCount(plan);
  const dynamicWordCaptionCount = dynamicCaptionCount(plan);
  const renderPolishWarnings = [];
  if (hardCutFallbackCount > 0) renderPolishWarnings.push("hard_cut_fallback_used");
  if (segments.length > 1 && transitionRenderedCount === 0) renderPolishWarnings.push("missing_transition_render");
  if (overlayRenderedCount === 0) renderPolishWarnings.push("overlay_not_rendered");
  if (profile.name === "proof_fast") renderPolishWarnings.push("proof_fast_render_profile");
  if (actionLayoutMode === "clean_action_letterbox") renderPolishWarnings.push("clean_action_letterbox_background");
  if (cleanActionLayoutRequired && blurredBackgroundUsed) renderPolishWarnings.push("valid_goal_proof_blurred_background_used");
  if (cleanActionLayoutRequired && splitLayoutCaptionCount > 0) renderPolishWarnings.push("valid_goal_proof_split_caption_layout_used");
  return {
    contractVersion: 1,
    renderProfile: profile.name,
    encoderPreset: profile.preset,
    encoderCrf: Number(profile.crf),
    segmentRenderMode: profile.segmentMode,
    renderStylePreset: config.name,
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    transitionMode: transitionRenderedCount > 0 ? "segment_fade_concat" : "single_window",
    transitionRenderedCount,
    hardCutFallbackCount,
    transitions,
    animatedCaptionCount,
    dynamicWordCaptionCount,
    staticCaptionFallbackCount: 0,
    captionMotion: dynamicWordCaptionCount > 0 ? "ass_word_by_word_highlight" : animatedCaptionCount > 0 ? "ass_fade_scale" : "none",
    cleanActionLayoutRequired,
    actionLayoutMode,
    fullHeightActionCrop: Boolean(scoreboardOverlay || softFollowCrop || ballFollowCrop),
    dynamicCropRendered: Boolean(ballFollowCrop),
    cropKeyframeCount: ballFollowCrop ? ballFollowCrop.keyframes.length : 0,
    maxPanSpeed: ballFollowCrop ? ballFollowCrop.maxPanSpeed : softFollowCrop ? 0.18 : 0,
    trackingProviderMode: String(visualTracking.trackingProviderMode || "unknown").slice(0, 80),
    trackingConfidence: Number.isFinite(Number(visualTracking.trackingConfidence))
      ? Number(Number(visualTracking.trackingConfidence).toFixed(2))
      : null,
    ballCandidateConfidence: Number.isFinite(Number(visualTracking.ballCandidateConfidence))
      ? Number(Number(visualTracking.ballCandidateConfidence).toFixed(2))
      : null,
    playerClusterConfidence: Number.isFinite(Number(visualTracking.playerClusterConfidence))
      ? Number(Number(visualTracking.playerClusterConfidence).toFixed(2))
      : null,
    ballTrackCount: Math.max(0, Math.min(24, Math.round(Number(visualTracking.ballTrackCount || 0)))),
    playerClusterCount: Math.max(0, Math.min(24, Math.round(Number(visualTracking.playerClusterCount || 0)))),
    scoreboardOverlayRendered: Boolean(scoreboardOverlay),
    scoreboardOverlayRegionId: scoreboardOverlay ? scoreboardOverlay.regionId : null,
    sourceScoreboardDuplicateSuppressed: Boolean(scoreboardOverlay),
    blurredBackgroundUsed,
    duplicateBackgroundUsed: blurredBackgroundUsed,
    splitLayoutCaptionCount,
    cleanActionLayoutPassed: !cleanActionLayoutRequired || (!blurredBackgroundUsed && splitLayoutCaptionCount === 0),
    overlayRenderedCount,
    overlayFallbackCount: 0,
    overlayMode: overlayRenderedCount > 0 ? "ass_goal_badge_and_labels" : "none",
    visualPolishScore: Math.max(0, 100 - hardCutFallbackCount * 20 - renderPolishWarnings.length * 5),
    renderPolishWarnings,
  };
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
  const profile = renderProfileConfig(plan);
  const subtitlesFilter = `subtitles=filename='${escapeFilterPath(subtitlesPath)}'`;
  const toneFilter = `eq=contrast=${config.contrast}:saturation=${config.saturation}`;
  const effects = visualEffectFilters(plan, dimensions, config);
  const finishingFilters = ["setsar=1", toneFilter, ...effects, subtitlesFilter];
  const backgroundPush = hasCue(plan, ["subtle_camera_push", "punch_zoom"]) ? 1.035 : 1;
  const backgroundWidth = Math.round(dimensions.width * backgroundPush);
  const backgroundHeight = Math.round(dimensions.height * backgroundPush);
  const softFollowCrop = activeSoftFollowCrop(plan);
  const ballFollowCrop = activeBallFollowCrop(plan);
  const actionCrop = ballFollowCrop || softFollowCrop;
  const scoreboardOverlay = activeScoreboardOverlay(plan, dimensions);
  const filter = scoreboardOverlay
    ? [
        "[0:v]split=2[base_source][score_source]",
        `[base_source]delogo=x=${scoreboardOverlay.maskX}:y=${scoreboardOverlay.maskY}:w=${scoreboardOverlay.maskWidth}:h=${scoreboardOverlay.maskHeight}:show=0[base_clean]`,
        actionCrop
          ? `[base_clean]${actionCropFilter(actionCrop)},scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height}[base]`
          : `[base_clean]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height}[base]`,
        `[score_source]crop=iw*${scoreboardOverlay.width}:ih*${scoreboardOverlay.height}:iw*${scoreboardOverlay.x}:ih*${scoreboardOverlay.y},scale=${scoreboardOverlay.targetWidth}:-2[scorebug]`,
        `[base][scorebug]overlay=(W-w)/2:${scoreboardOverlay.topMargin}[framed]`,
        `[framed]${finishingFilters.join(",")}[v]`,
      ].join(";")
    : actionCrop
    ? [
        `[0:v]${actionCropFilter(actionCrop)}`,
        `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase`,
        `crop=${dimensions.width}:${dimensions.height}`,
        `${finishingFilters.join(",")}[v]`,
      ].join(",")
    : ["wide_safe", "wide_safe_vertical"].includes(plan.framingMode)
    ? shouldUseBlurredBackground(plan, profile)
    ? [
        `[0:v]scale=${backgroundWidth}:${backgroundHeight}:force_original_aspect_ratio=increase,crop=${dimensions.width}:${dimensions.height},boxblur=18:1[bg]`,
        `[0:v]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,${finishingFilters.join(",")}[v]`,
      ].join(";")
    : [
        `[0:v]scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`,
        `pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        `${finishingFilters.join(",")}[v]`,
      ].join(",")
    : [
        `[0:v]scale=${Math.round(dimensions.width * 1.04)}:${Math.round(dimensions.height * 1.04)}:force_original_aspect_ratio=increase`,
        `crop=${dimensions.width}:${dimensions.height}`,
        `${finishingFilters.join(",")}[v]`,
      ].join(",");
  const videoEncodeArgs = [
    "-c:v",
    "libx264",
    "-preset",
    profile.preset,
    "-crf",
    profile.crf,
    ...(profile.outputFrameRate ? ["-r", profile.outputFrameRate] : []),
  ];
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
    ...videoEncodeArgs,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    profile.audioBitrate,
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ];
  await ffmpegRunner(args, { signal });
  plan.renderPolishQA = createRenderPolishSummary(plan, { transitionRenderedCount: 0 });
  return outputPath;
}

async function renderMultiSegmentShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner = runFfmpeg }) {
  const segments = normalizedRenderSegments(plan);
  const profile = renderProfileConfig(plan);
  if (segments.length < 2) {
    throw new AppError("RENDER_FAILED", "Multi-moment render needs at least two valid segments.", 500);
  }
  const totalDuration = Number(segments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(2));
  if (!Number.isFinite(totalDuration) || totalDuration <= 0 || totalDuration > 210) {
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
        "-vf",
        segmentVideoFadeFilter(segment),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        profile.preset,
        "-crf",
        profile.crf,
        ...(profile.outputFrameRate ? ["-r", profile.outputFrameRate] : []),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        profile.audioBitrate,
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
    plan.renderPolishQA = createRenderPolishSummary(plan, {
      transitionRenderedCount: Math.max(0, segments.length - 1),
    });
    return outputPath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function renderShort({ inputPath, outputPath, subtitlesPath, plan, signal, ffmpegRunner = runFfmpeg }) {
  if (plan && typeof plan === "object") {
    plan.renderProfile = normalizeRenderProfileName(plan.renderProfile || process.env.SHORTSENGINE_RENDER_PROFILE);
  }
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
  createRenderPolishSummary,
  renderDimensions,
  normalizeRenderProfileName,
};
