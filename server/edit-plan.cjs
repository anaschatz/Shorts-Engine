const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const HOOKS = Object.freeze({
  hype: "Η ΦΑΣΗ ΠΟΥ ΑΝΕΒΑΣΕ ΤΗΝ ΕΝΤΑΣΗ",
  drama: "ΟΛΑ ΠΑΙΧΤΗΚΑΝ ΣΕ ΑΥΤΑ ΤΑ 3 ΔΕΥΤΕΡΟΛΕΠΤΑ",
  tactical: "Η ΚΙΝΗΣΗ ΠΟΥ ΑΝΟΙΞΕ ΟΛΗ ΤΗΝ ΑΜΥΝΑ",
  fan: "ΑΥΤΟ ΔΕΝ ΓΙΝΕΤΑΙ ΝΑ ΜΗΝ ΤΟ ΞΑΝΑΔΕΙΣ",
});

const HIGHLIGHT_TYPES = Object.freeze([
  "goal",
  "shot_on_target",
  "near_miss",
  "big_chance",
  "save",
  "foul",
  "hard_foul",
  "card_moment",
  "counter_attack",
  "skill_move",
  "crowd_reaction",
  "commentator_peak",
  "replay_or_reaction",
  "replay_worthy_moment",
  "audio_energy_spike",
  "unknown_action",
  "generic_highlight",
]);

const FRAMING_MODES = Object.freeze(["safe_center", "action_bias", "wide_safe", "wide_safe_vertical"]);
const STYLE_PRESETS = Object.freeze(["hype", "drama", "tactical", "fan", "social_sports_v1"]);
const ASPECT_RATIOS = Object.freeze(["9:16", "1:1"]);
const ANIMATION_CUE_TYPES = Object.freeze([
  "intro_hook",
  "caption_pop",
  "beat_pulse",
  "subtle_punch_in",
  "end_replay_prompt",
  "punch_zoom",
  "impact_flash",
  "kinetic_caption",
  "scorebug_blur_guard",
  "replay_stutter",
  "freeze_frame",
  "beat_cut",
  "subtle_camera_push",
]);
const CAPTION_EMPHASIS_STYLES = Object.freeze(["kinetic_bold"]);
const EFFECT_TYPES = Object.freeze([
  "wide_safe_framing",
  "social_caption_pop",
  "caption_emphasis",
  "brand_safe_template",
  "beat_sync_pulse",
  "scene_snap_zoom",
  "action_lane_emphasis",
  "subtle_punch_in",
  "impact_freeze_frame",
  "replay_stutter",
]);
const VISUAL_EVIDENCE_TYPES = Object.freeze([
  "ball_visible",
  "player_cluster",
  "goal_area_visible",
  "penalty_box_visible",
  "shot_like_motion",
  "save_like_motion",
  "foul_like_contact",
  "fast_break_motion",
  "replay_indicator",
  "crowd_reaction",
  "camera_pan",
  "scoreboard_context",
  "unknown_visual_action",
]);
const VISUAL_EVIDENCE_REASON_CODES = Object.freeze([
  "visual_ball_visible",
  "visual_goal_area",
  "visual_shot_like_motion",
  "visual_save_like_motion",
  "visual_foul_like_contact",
  "visual_fast_break",
  "visual_replay_indicator",
  "visual_crowd_reaction",
  "visual_scoreboard_context",
  "visual_unknown_action",
]);
const GOAL_LANGUAGE_RE = /\b(scored|scores|equalises|equalizes|back of the net|into the net|finds the net)\b|γκολ|σκοραρ|σκόραρ/i;
const GOAL_WORD_RE = /\bgo+als?\b/gi;
const NON_EVENT_GOAL_CONTEXT_RE = /\b(?:behind|towards?|near|around|beside|from behind|in front of)\s+(?:the\s+)?goals?\b|\bno\s+goals?\b/i;

const HIGHLIGHT_HOOKS = Object.freeze({
  goal: "ΤΟ ΓΚΟΛ ΠΟΥ ΑΛΛΑΞΕ ΤΟ ΜΑΤΣ",
  shot_on_target: "ΣΟΥΤ ΠΟΥ ΑΝΕΒΑΣΕ ΤΗΝ ΕΝΤΑΣΗ",
  near_miss: "ΠΑΡΑ ΛΙΓΟ ΝΑ ΜΠΕΙ",
  big_chance: "Η ΜΕΓΑΛΗ ΦΑΣΗ",
  save: "Η ΑΠΟΚΡΟΥΣΗ ΠΟΥ ΚΡΑΤΗΣΕ ΤΟ ΜΑΤΣ",
  foul: "ΤΟ ΜΑΡΚΑΡΙΣΜΑ ΠΟΥ ΑΛΛΑΞΕ ΤΟΝ ΡΥΘΜΟ",
  hard_foul: "ΣΚΛΗΡΗ ΕΠΑΦΗ, ΜΕΓΑΛΗ ΑΝΤΙΔΡΑΣΗ",
  card_moment: "Η ΦΑΣΗ ΠΟΥ ΑΝΑΨΕ ΤΟ ΜΑΤΣ",
  counter_attack: "Η ΑΝΤΕΠΙΘΕΣΗ ΑΝΟΙΞΕ ΧΩΡΟ",
  skill_move: "Η ΚΙΝΗΣΗ ΠΟΥ ΑΝΟΙΞΕ ΤΗ ΦΑΣΗ",
  crowd_reaction: "ΑΚΟΥ ΤΗΝ ΚΕΡΚΙΔΑ",
  commentator_peak: "Ο ΕΚΦΩΝΗΤΗΣ ΤΟ ΕΝΙΩΣΕ",
  replay_or_reaction: "Η ΦΑΣΗ ΠΟΥ ΘΕΛΕΙ REPLAY",
  replay_worthy_moment: "Η ΦΑΣΗ ΠΟΥ ΘΕΛΕΙ REPLAY",
  audio_energy_spike: "Η ΕΝΤΑΣΗ ΑΝΕΒΗΚΕ ΑΠΟΤΟΜΑ",
  unknown_action: "ΔΕΣ ΠΩΣ ΑΝΕΒΑΙΝΕΙ Η ΠΙΕΣΗ",
  generic_highlight: "ΔΕΣ ΤΗΝ ΕΞΕΛΙΞΗ ΤΗΣ ΦΑΣΗΣ",
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function normalizeHighlightType(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  return HIGHLIGHT_TYPES.includes(safe) ? safe : "generic_highlight";
}

function normalizeFramingMode(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  if (safe === "wide_safe") return "wide_safe_vertical";
  return FRAMING_MODES.includes(safe) ? safe : "wide_safe_vertical";
}

function normalizeStylePreset(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  return STYLE_PRESETS.includes(safe) ? safe : "social_sports_v1";
}

function assertAllowedToken(value, allowed, message, maxLength = 60) {
  const safe = sanitizeText(value, maxLength).toLowerCase();
  if (!allowed.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", message, 400);
  }
  return safe;
}

function assertAllowedList(values, allowed, message, maxLength = 60) {
  const rawValues = Array.isArray(values) ? values : [];
  return [...new Set(rawValues.map((value) => assertAllowedToken(value, allowed, message, maxLength)))];
}

function hasGoalLanguage(value) {
  const text = sanitizeText(value, 240);
  if (GOAL_LANGUAGE_RE.test(text)) return true;
  const matches = [...text.matchAll(GOAL_WORD_RE)];
  return matches.some((match) => {
    const context = text.slice(Math.max(0, match.index - 28), Math.min(text.length, match.index + match[0].length + 28));
    return !NON_EVENT_GOAL_CONTEXT_RE.test(context);
  });
}

function assertNoMisleadingGoalLanguage({ hook, captions, highlightType, reasonCodes }) {
  const hasGoalEvidence = highlightType === "goal" && Array.isArray(reasonCodes) && reasonCodes.includes("goal");
  if (hasGoalEvidence) return;
  const texts = [hook, ...(Array.isArray(captions) ? captions.map((caption) => caption && caption.text) : [])];
  if (texts.some(hasGoalLanguage)) {
    throw new AppError("VALIDATION_ERROR", "Edit plan uses goal language without goal evidence.", 400);
  }
}

function normalizeCaptions(captions, sourceStart, sourceEnd) {
  const duration = sourceEnd - sourceStart;
  const safe = Array.isArray(captions) ? captions : [];
  const normalized = safe
    .map((caption, index) => {
      const start = clamp(caption.start, 0, duration);
      const end = clamp(caption.end, start + 0.4, duration);
      const text = sanitizeText(caption.text, 96);
      if (!text) return null;
      return {
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        text,
        index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  return normalized;
}

function hookForHighlightType(highlightType, preset) {
  const safeType = normalizeHighlightType(highlightType);
  return sanitizeText(HIGHLIGHT_HOOKS[safeType] || HOOKS[preset] || HOOKS.hype, 96);
}

function createFallbackCaptions(duration, preset, options = {}) {
  const highlightType = normalizeHighlightType(options.highlightType);
  const beatsByType = {
    goal: ["THE FINISH CHANGED THE MATCH", "WATCH THE MOVEMENT BEFORE IT", "REPLAY THE BUILD-UP"],
    shot_on_target: ["THE CHANCE OPENS FAST", "ONE TOUCH CREATES THE DANGER", "REPLAY THE PRESSURE"],
    near_miss: ["THE CROWD THOUGHT IT WAS IN", "SO CLOSE TO THE BIG MOMENT", "RUN IT BACK"],
    big_chance: ["THE WINDOW OPENS FOR A SECOND", "THE PRESSURE HITS FAST", "WATCH THE RUN"],
    save: ["THE KEEPER REACTS JUST IN TIME", "SO CLOSE", "RUN IT BACK"],
    foul: ["THE TEMPO CHANGES HERE", "CONTACT, REACTION, PRESSURE", "WATCH THE AFTERMATH"],
    hard_foul: ["HEAVY CONTACT, HUGE REACTION", "THE MATCH GETS HEATED", "REPLAY THE CHALLENGE"],
    card_moment: ["THE REFEREE HAS A DECISION", "EVERYONE REACTS", "WATCH THE TEMPO SHIFT"],
    counter_attack: ["SPACE OPENS INSTANTLY", "THE BREAK IS ON", "WATCH THE RUNNER"],
    skill_move: ["ONE TOUCH CHANGES THE PLAY", "THE DEFENDER HAS TO TURN", "REPLAY THE MOVE"],
    crowd_reaction: ["THE STADIUM TELLS THE STORY", "THE ENERGY JUMPS", "RUN IT BACK"],
    commentator_peak: ["THE CALL TELLS YOU THE MOMENT", "THE PRESSURE JUMPS", "WATCH THE REACTION"],
    replay_or_reaction: ["THE DETAIL IS IN THE BUILD-UP", "WATCH IT AGAIN", "REPLAY-WORTHY"],
    replay_worthy_moment: ["THE DETAIL IS IN THE BUILD-UP", "WATCH IT AGAIN", "REPLAY-WORTHY"],
    audio_energy_spike: ["THE CROWD TELLS YOU EVERYTHING", "THE ENERGY JUMPS", "WATCH THE BUILD-UP"],
    unknown_action: ["THE PRESSURE BUILDS", "THE PLAY OPENS UP", "WATCH THE DETAIL"],
    generic_highlight: ["THE PRESSURE BUILDS", "THE PLAY OPENS UP", "WATCH THE DETAIL"],
  };
  const beats = beatsByType[highlightType] || beatsByType.generic_highlight;
  const segment = Math.max(1.8, duration / beats.length);
  return beats.map((text, index) => ({
    start: Number((index * segment).toFixed(2)),
    end: Number(Math.min(duration, index * segment + segment - 0.15).toFixed(2)),
    text,
  })).filter((caption) => caption.end > caption.start);
}

function createCaptionEmphasis(captions, highlightType) {
  const priorityWords = {
    goal: ["GOAL", "FINISH"],
    shot_on_target: ["CLOSE", "CHANCE"],
    near_miss: ["CLOSE", "REACTION"],
    big_chance: ["CHANCE", "CLOSE"],
    save: ["SAVE", "KEEPER"],
    foul: ["CHALLENGE", "CONTACT"],
    hard_foul: ["CONTACT", "REACTION"],
    card_moment: ["DECISION", "HEATED"],
    counter_attack: ["BREAK", "SPACE"],
    skill_move: ["TOUCH", "MOVE"],
    crowd_reaction: ["CROWD", "ENERGY"],
    commentator_peak: ["CALL", "PRESSURE"],
    replay_or_reaction: ["REPLAY", "DETAIL"],
    replay_worthy_moment: ["REPLAY", "DETAIL"],
    audio_energy_spike: ["ENERGY", "CROWD"],
    unknown_action: ["WATCH", "PRESSURE"],
    generic_highlight: ["WATCH", "BUILD-UP"],
  };
  return (Array.isArray(captions) ? captions : []).slice(0, 2).map((caption, index) => ({
    captionIndex: index,
    words: (priorityWords[highlightType] || priorityWords.generic_highlight).slice(0, 2),
    style: "kinetic_bold",
    start: Number(caption.start || 0),
    end: Number(caption.end || 0),
  }));
}

function createAnimationCues(duration, reasonCodes = []) {
  const safeDuration = Math.max(1, Number(duration) || 1);
  const cues = [
    { type: "intro_hook", start: 0, end: Math.min(1.2, safeDuration) },
    { type: "kinetic_caption", start: 0.2, end: Math.min(1.8, safeDuration) },
    { type: "end_replay_prompt", start: Math.max(0, safeDuration - 1.3), end: safeDuration },
  ];
  if (reasonCodes.includes("audio_energy_spike") || reasonCodes.includes("audio_peak")) {
    cues.push({ type: "beat_pulse", start: Math.min(1.6, safeDuration - 0.2), end: Math.min(2.1, safeDuration) });
  }
  if (
    reasonCodes.includes("scene_change_cluster") ||
    reasonCodes.includes("replay_worthy_moment") ||
    reasonCodes.includes("visual_shot_like_motion") ||
    reasonCodes.includes("visual_save_like_motion") ||
    reasonCodes.includes("visual_foul_like_contact") ||
    reasonCodes.includes("visual_fast_break")
  ) {
    cues.push({ type: "subtle_camera_push", start: Math.min(2.2, safeDuration - 0.2), end: Math.min(3.2, safeDuration) });
  }
  return cues.filter((cue) => cue.end > cue.start).map((cue) => ({
    type: cue.type,
    start: Number(cue.start.toFixed(2)),
    end: Number(cue.end.toFixed(2)),
  }));
}

function exportForAspectRatio(aspectRatio) {
  return aspectRatio === "1:1"
    ? { width: 1080, height: 1080, format: "mp4" }
    : { width: 1080, height: 1920, format: "mp4" };
}

function createCropStrategy(metadata = {}, framingMode = "wide_safe_vertical") {
  const width = Math.max(1, Number(metadata.width) || 1920);
  const height = Math.max(1, Number(metadata.height) || 1080);
  const mode = normalizeFramingMode(framingMode);
  if (mode === "wide_safe_vertical") {
    return {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width,
      height,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    };
  }
  return {
    type: mode === "action_bias" ? "bounded_center_bias" : "center_crop",
    x: 0,
    y: 0,
    width,
    height,
    zoom: mode === "action_bias" ? 1.04 : 1.02,
    background: "none",
    preserveFullFrame: false,
    maxCropPercent: mode === "action_bias" ? 0.18 : 0.22,
  };
}

function normalizeVisualEvidenceSummary(value) {
  const summary = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    providerMode: sanitizeText(summary.providerMode || "mock", 40),
    fallbackUsed: Boolean(summary.fallbackUsed),
    windowCount: clamp(summary.windowCount || 0, 0, 24),
    topTypes: Array.isArray(summary.topTypes)
      ? assertAllowedList(summary.topTypes, VISUAL_EVIDENCE_TYPES, "Visual evidence type is invalid.", 48).slice(0, 8)
      : [],
    reasonCodes: Array.isArray(summary.reasonCodes)
      ? assertAllowedList(summary.reasonCodes, VISUAL_EVIDENCE_REASON_CODES, "Visual evidence reason code is invalid.", 60).slice(0, 8)
      : [],
    actionFocusConfidence: Number(clamp(summary.actionFocusConfidence, 0, 1).toFixed(2)),
    goalClaimAllowed: false,
  };
}

function normalizeCaptionEmphasisItems(items, duration) {
  const rawItems = Array.isArray(items) ? items : [];
  const normalized = rawItems.slice(0, 6).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const style = assertAllowedToken(item.style || "kinetic_bold", CAPTION_EMPHASIS_STYLES, "Caption emphasis style is invalid.", 32);
    const start = clamp(item.start, 0, duration);
    const end = clamp(item.end, 0, duration);
    const words = Array.isArray(item.words) ? item.words.map((word) => sanitizeText(word, 24)).filter(Boolean).slice(0, 3) : [];
    if (!words.length || end <= start) return null;
    return {
      captionIndex: Math.max(0, Math.floor(Number(item.captionIndex) || 0)),
      words,
      style,
      start,
      end,
    };
  }).filter(Boolean);
  if (normalized.length !== rawItems.length) {
    throw new AppError("VALIDATION_ERROR", "Caption emphasis timing or style is invalid.", 400);
  }
  return normalized;
}

function normalizeEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return assertAllowedList(effects, EFFECT_TYPES, "Edit plan effect is invalid.", 40);
}

function framingModeForMetadata(metadata = {}) {
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return "wide_safe_vertical";
  return width / height > 1.2 ? "wide_safe_vertical" : "safe_center";
}

function createEditPlan({ metadata, transcript, preset = "hype", title = "ShortsEngine Short" }) {
  const sourceStart = 0;
  const sourceEnd = Math.min(Number(metadata.durationSeconds || 0), 18);
  const safeEnd = sourceEnd >= 3 ? sourceEnd : Math.min(Number(metadata.durationSeconds || 3), 3);
  const duration = safeEnd - sourceStart;
  const highlightType = "generic_highlight";
  const hook = hookForHighlightType(highlightType, preset);
  const captions =
    transcript && Array.isArray(transcript.captions) && transcript.captions.length > 0
      ? normalizeCaptions(transcript.captions, sourceStart, safeEnd)
      : createFallbackCaptions(duration, preset, { highlightType, hook });
  const framingMode = framingModeForMetadata(metadata);
  return {
    sourceStart,
    sourceEnd: Number(safeEnd.toFixed(2)),
    aspectRatio: "9:16",
    highlightType,
    confidence: 0.5,
    hook,
    title: sanitizeText(title, 120),
    captions: captions.length ? captions : createFallbackCaptions(duration, preset, { highlightType, hook }),
    effects: ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "brand_safe_template"],
    framingMode,
    framingReason: "wide_safe_default_no_visual_tracking",
    actionFocusConfidence: 0,
    visualEvidenceSummary: normalizeVisualEvidenceSummary(null),
    cropStrategy: createCropStrategy(metadata, framingMode),
    stylePreset: "social_sports_v1",
    captionEmphasis: createCaptionEmphasis(captions, highlightType),
    animationCues: createAnimationCues(duration, ["generic_highlight"]),
    safetyNotes: ["No ball tracking claim; wide-safe framing preserves the full source frame when needed."],
    export: {
      width: 1080,
      height: 1920,
      format: "mp4",
    },
  };
}

function validateEditPlan(plan, metadata = {}) {
  if (!plan || typeof plan !== "object") {
    throw new AppError("VALIDATION_ERROR", "Edit plan is missing.", 400);
  }
  const sourceStart = Number(plan.sourceStart);
  const sourceEnd = Number(plan.sourceEnd);
  const mediaDuration = Number(metadata.durationSeconds || sourceEnd);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd <= sourceStart) {
    throw new AppError("VALIDATION_ERROR", "Edit plan source range is invalid.", 400);
  }
  if (sourceEnd - sourceStart > 60) {
    throw new AppError("VALIDATION_ERROR", "MVP render window cannot exceed 60 seconds.", 400);
  }
  if (sourceEnd > mediaDuration + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Edit plan exceeds media duration.", 400);
  }
  const aspectRatio = ASPECT_RATIOS.includes(sanitizeText(plan.aspectRatio || "9:16", 12)) ? sanitizeText(plan.aspectRatio || "9:16", 12) : null;
  if (!aspectRatio) {
    throw new AppError("VALIDATION_ERROR", "Unsupported export aspect ratio.", 400);
  }
  const expectedExport = exportForAspectRatio(aspectRatio);
  if (
    !plan.export ||
    plan.export.width !== expectedExport.width ||
    plan.export.height !== expectedExport.height ||
    plan.export.format !== expectedExport.format
  ) {
    throw new AppError("VALIDATION_ERROR", "Export settings do not match the selected aspect ratio.", 400);
  }
  const highlightType = assertAllowedToken(plan.highlightType, HIGHLIGHT_TYPES, "Unsupported highlight type.", 40);
  const rawFramingMode = sanitizeText(plan.framingMode || "wide_safe_vertical", 40).toLowerCase();
  if (rawFramingMode !== "wide_safe" && !FRAMING_MODES.includes(rawFramingMode)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported framing mode.", 400);
  }
  const framingMode = normalizeFramingMode(plan.framingMode);
  const stylePreset = normalizeStylePreset(plan.stylePreset);
  const visualEvidenceSummary = normalizeVisualEvidenceSummary(plan.visualEvidenceSummary);
  const actionFocusConfidence = Number(clamp(plan.actionFocusConfidence ?? visualEvidenceSummary.actionFocusConfidence, 0, 1).toFixed(2));
  const framingReason = sanitizeText(plan.framingReason || "wide_safe_default_no_visual_tracking", 120);
  if (framingMode === "action_bias" && actionFocusConfidence < 0.82) {
    throw new AppError("VALIDATION_ERROR", "Action-biased framing needs high-confidence visual action focus.", 400);
  }
  if (plan.stylePreset && !STYLE_PRESETS.includes(sanitizeText(plan.stylePreset, 40).toLowerCase())) {
    throw new AppError("VALIDATION_ERROR", "Unsupported edit style preset.", 400);
  }
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean) : [];
  const captions = normalizeCaptions(plan.captions, sourceStart, sourceEnd);
  if (captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Edit plan needs at least one caption.", 400);
  }
  const hook = sanitizeText(plan.hook || hookForHighlightType(highlightType, stylePreset), 96);
  assertNoMisleadingGoalLanguage({ hook, captions, highlightType, reasonCodes });
  const cropStrategy = plan.cropStrategy && typeof plan.cropStrategy === "object"
    ? {
        type: sanitizeText(plan.cropStrategy.type || "wide_safe_contain", 40),
        x: clamp(plan.cropStrategy.x, 0, Number(metadata.width || 1920)),
        y: clamp(plan.cropStrategy.y, 0, Number(metadata.height || 1080)),
        width: clamp(plan.cropStrategy.width, 1, Number(metadata.width || plan.cropStrategy.width || 1920)),
        height: clamp(plan.cropStrategy.height, 1, Number(metadata.height || plan.cropStrategy.height || 1080)),
        zoom: clamp(plan.cropStrategy.zoom || 1, 1, 1.08),
        background: sanitizeText(plan.cropStrategy.background || "blurred_fill", 40),
        preserveFullFrame: Boolean(plan.cropStrategy.preserveFullFrame),
        maxCropPercent: clamp(plan.cropStrategy.maxCropPercent || 0, 0, 0.35),
      }
    : createCropStrategy(metadata, framingMode);
  if (cropStrategy.x + cropStrategy.width > Number(metadata.width || cropStrategy.width) + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Crop strategy exceeds media width.", 400);
  }
  if (cropStrategy.y + cropStrategy.height > Number(metadata.height || cropStrategy.height) + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Crop strategy exceeds media height.", 400);
  }
  const duration = sourceEnd - sourceStart;
  const captionEmphasis = Array.isArray(plan.captionEmphasis)
    ? normalizeCaptionEmphasisItems(plan.captionEmphasis, duration)
    : createCaptionEmphasis(captions, highlightType);
  const rawAnimationCues = Array.isArray(plan.animationCues) ? plan.animationCues.slice(0, 10) : null;
  const unsupportedAnimationCues = [];
  let animationCues = rawAnimationCues
    ? rawAnimationCues.map((cue) => {
        const type = sanitizeText(cue && cue.type, 40);
        const start = clamp(cue && cue.start, 0, duration);
        const end = clamp(cue && cue.end, 0, duration);
        if (!ANIMATION_CUE_TYPES.includes(type) || end <= start) {
          unsupportedAnimationCues.push({ type: type || "unknown", reason: "unsupported_or_invalid_timing" });
          return null;
        }
        return { type, start, end };
      }).filter(Boolean)
    : createAnimationCues(duration, reasonCodes);
  if (!animationCues.length) animationCues = createAnimationCues(duration, reasonCodes);
  return {
    ...plan,
    sourceStart,
    sourceEnd,
    aspectRatio,
    hook,
    highlightType,
    confidence: clamp(plan.confidence, 0, 1),
    framingMode,
    framingReason,
    actionFocusConfidence,
    visualEvidenceSummary,
    cropStrategy,
    stylePreset,
    captionEmphasis,
    animationCues,
    unsupportedAnimationCues,
    safetyNotes: Array.isArray(plan.safetyNotes) ? plan.safetyNotes.map((note) => sanitizeText(note, 160)).filter(Boolean).slice(0, 6) : [],
    captions,
    effects: normalizeEffects(plan.effects),
    reasonCodes,
    export: expectedExport,
  };
}

module.exports = {
  ANIMATION_CUE_TYPES,
  ASPECT_RATIOS,
  CAPTION_EMPHASIS_STYLES,
  EFFECT_TYPES,
  FRAMING_MODES,
  HIGHLIGHT_TYPES,
  HOOKS,
  STYLE_PRESETS,
  createFallbackCaptions,
  createAnimationCues,
  createCaptionEmphasis,
  createCropStrategy,
  createEditPlan,
  framingModeForMetadata,
  hasGoalLanguage,
  hookForHighlightType,
  validateEditPlan,
};
