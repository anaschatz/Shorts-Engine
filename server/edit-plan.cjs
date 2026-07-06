const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { calibrateCropPlan, cropStrategyFromPlan, validateCropPlan } = require("./visual-tracking.cjs");

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
const RENDER_STYLE_PRESETS = Object.freeze(["clean_sports", "social_sports_v1", "punchy_highlight", "reference_football_multi_goal_v1"]);
const STYLE_PRESET_ALIASES = Object.freeze({
  hype: "punchy_highlight",
  drama: "social_sports_v1",
  tactical: "clean_sports",
  fan: "punchy_highlight",
});
const STYLE_PRESETS = Object.freeze([...RENDER_STYLE_PRESETS, ...Object.keys(STYLE_PRESET_ALIASES)]);
const ASPECT_RATIOS = Object.freeze(["9:16", "1:1"]);
const ANIMATION_CUE_TYPES = Object.freeze([
  "intro_hook",
  "caption_pop",
  "caption_word_pop",
  "beat_pulse",
  "subtle_punch_in",
  "end_replay_prompt",
  "punch_zoom",
  "impact_flash",
  "subtle_shake",
  "kinetic_caption",
  "goal_counter_overlay",
  "smooth_flash_transition",
  "scorebug_blur_guard",
  "replay_stutter",
  "freeze_frame",
  "beat_cut",
  "subtle_camera_push",
]);
const CAPTION_EMPHASIS_STYLES = Object.freeze(["kinetic_bold"]);
const CAPTION_ROLES = Object.freeze(["opening_hook", "context", "action_callout", "reaction", "closing_punch"]);
const CAPTION_EMPHASIS = Object.freeze(["normal", "strong", "shout", "detail", "warning"]);
const CAPTION_LAYOUTS = Object.freeze(["bottom", "center", "top", "split"]);
const CAPTION_HIGHLIGHT_COLORS = Object.freeze(["white", "gold", "cyan", "red", "green"]);
const CAPTION_RISK_FLAGS = Object.freeze([
  "goal_language_without_evidence",
  "confirmed_goal_without_decision_evidence",
  "offside_decision_context",
  "goal_outcome_uncertain",
  "generic_hype_on_action",
  "caption_action_mismatch",
  "crowd_context_only",
]);
const MAX_ACTIVE_WORD_DURATION_SECONDS = 1.35;
const ANIMATION_CUE_LIMITS = Object.freeze({
  intro_hook: 1.8,
  caption_pop: 2.4,
  caption_word_pop: 3.2,
  beat_pulse: 0.55,
  subtle_punch_in: 1.4,
  end_replay_prompt: 1.8,
  punch_zoom: 1.25,
  impact_flash: 0.18,
  subtle_shake: 0.35,
  kinetic_caption: 3,
  goal_counter_overlay: 4,
  smooth_flash_transition: 0.55,
  scorebug_blur_guard: 3,
  replay_stutter: 1.4,
  freeze_frame: 0.75,
  beat_cut: 0.45,
  subtle_camera_push: 3.5,
});
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
  "creative_color_grade",
  "safe_mild_zoom",
  "caption_safe_overlay",
  "goal_counter_overlay",
]);
const HOOK_TYPES = Object.freeze(["goal_payoff", "shot", "save", "collision", "dramatic_moment", "neutral_football"]);
const AUDIO_MODES = Object.freeze(["source", "muted", "licensed_local", "platform_native_placeholder"]);
const AUDIO_LICENSE_STATUSES = Object.freeze([
  "source_rights_confirmed",
  "muted_safe",
  "licensed_local",
  "platform_native_required",
  "operator_review_required",
]);
const CAPTION_STYLE_PRESETS = Object.freeze(["hormozi_kinetic_safe_v1", "sports_dynamic_safe_v1"]);
const CAPTION_SAFE_AREAS = Object.freeze(["center_safe", "lower_third_safe", "upper_third_safe"]);
const CAPTION_CONTRAST_MODES = Object.freeze(["outline_shadow", "boxed_shadow"]);
const EDIT_PLAN_MODES = Object.freeze(["single_moment", "multi_moment_compilation"]);
const MULTI_MOMENT_LIMITS = Object.freeze({
  minSegments: 1,
  maxSegments: 7,
  minSegmentDuration: 3,
  maxSegmentDuration: 64,
  maxTotalDuration: 210,
});
const VISUAL_EVIDENCE_TYPES = Object.freeze([
  "ball_visible",
  "player_cluster",
  "goal_area_visible",
  "penalty_box_visible",
  "goal_mouth_visible",
  "shot_like_motion",
  "shot_contact",
  "ball_toward_goal",
  "save_like_motion",
  "keeper_action",
  "ball_in_net",
  "celebration_after_shot",
  "foul_like_contact",
  "fast_break_motion",
  "replay_indicator",
  "crowd_reaction",
  "camera_pan",
  "scoreboard_context",
  "assistant_referee_flag",
  "referee_no_goal_signal",
  "referee_goal_signal",
  "var_screen",
  "var_check_graphic",
  "var_decision_graphic",
  "scoreboard_no_goal",
  "scoreboard_goal_removed",
  "scoreboard_goal_confirmed",
  "replay_line",
  "offside_line_replay",
  "replay_angle",
  "referee_signal",
  "crowd_confusion",
  "celebration_after_whistle",
  "unknown_visual_action",
]);
const VISUAL_EVIDENCE_REASON_CODES = Object.freeze([
  "visual_ball_visible",
  "visual_goal_area",
  "visual_goal_mouth",
  "visual_shot_like_motion",
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_ball_in_net",
  "visual_celebration_after_shot",
  "visual_foul_like_contact",
  "visual_fast_break",
  "visual_replay_indicator",
  "visual_crowd_reaction",
  "visual_scoreboard_context",
  "visual_offside_flag",
  "visual_var_check",
  "visual_var_decision",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
  "visual_referee_no_goal_signal",
  "visual_referee_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_scoreboard_goal_confirmed",
  "visual_replay_indicator",
  "visual_replay_angle",
  "visual_crowd_confusion",
  "visual_celebration_after_whistle",
  "visual_unknown_action",
]);
const GOAL_EVENT_TYPES = Object.freeze(["none", "ball_in_net"]);
const GOAL_OUTCOMES = Object.freeze(["none", "confirmed_goal", "disallowed_offside", "possible_offside", "unknown_decision"]);
const OFFSIDE_STATUSES = Object.freeze(["none", "offside", "onside", "possible", "unknown"]);
const GOAL_DECISION_EVIDENCE_CODES = Object.freeze([
  "explicit_goal_language",
  "ball_in_net",
  "scoreboard_backed_goal_sequence",
  "scoreboard_ocr_score_change",
  "scoreboard_ocr_score_unchanged",
  "scoreboard_ocr_goal_removed",
  "scoreboard_temporal_consistency",
  "confirmed_by_commentary",
  "commentator_goal_call_support",
  "crowd_reaction_support",
  "combined_goal_confirmation",
  "kickoff_after_goal",
  "offside_commentary",
  "flag_commentary",
  "disallowed_commentary",
  "var_check",
  "no_goal_commentary",
  "visual_offside_flag",
  "visual_var_check",
  "visual_var_decision",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
  "visual_referee_no_goal_signal",
  "visual_referee_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_scoreboard_goal_confirmed",
  "visual_replay_indicator",
  "visual_replay_angle",
  "visual_crowd_confusion",
  "visual_crowd_reaction",
  "visual_celebration_after_whistle",
  "audio_energy_spike",
  "scene_change_cluster",
  "replay_goal_confirmation",
  "var_decision",
  "scoreboard_goal_removed",
  "scoreboard_goal_confirmed",
  "replay_context",
]);
const GOAL_OUTCOME_BADGES = Object.freeze([
  "CONFIRMED",
  "CONFIRMED GOAL",
  "OFFSIDE",
  "OFFSIDE - NO GOAL",
  "VAR CHECK",
  "POSSIBLE OFFSIDE",
  "DECISION UNCLEAR",
]);
const GOAL_LANGUAGE_RE = /\b(scored|scores|equalises|equalizes|back of the net|into the net|finds the net)\b|γκολ|σκοραρ|σκόραρ/i;
const GOAL_WORD_RE = /\bgo+als?\b/gi;
const NON_EVENT_GOAL_CONTEXT_RE = /\b(?:behind|towards?|near|around|beside|from behind|in front of)\s+(?:the\s+)?goals?\b|\bno\s+goals?\b/i;
const DECISION_SAFE_GOAL_CONTEXT_RE = /\b(?:offside|flag|ruled\s+out|disallowed|no\s+goal|var|check|decision|chalked\s+off|ακυρ|οφσάιντ|οφσαιντ|σημαια|σημαία|δεν\s+μετρα|δεν\s+μέτρα)\b/i;
const SEGMENT_PRIMARY_ACTION_REASONS = Object.freeze([
  "goal",
  "big_chance",
  "shot_on_target",
  "save",
  "hard_foul",
  "foul",
  "card_moment",
  "counter_attack",
  "skill_move",
  "visual_shot_like_motion",
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_ball_in_net",
  "visual_celebration_after_shot",
  "visual_foul_like_contact",
  "visual_fast_break",
]);

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
  if (RENDER_STYLE_PRESETS.includes(safe)) return safe;
  return STYLE_PRESET_ALIASES[safe] || "social_sports_v1";
}

function isKnownStylePreset(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  return RENDER_STYLE_PRESETS.includes(safe) || Object.prototype.hasOwnProperty.call(STYLE_PRESET_ALIASES, safe);
}

function assertAllowedToken(value, allowed, message, maxLength = 60) {
  const safe = sanitizeText(value, maxLength).toLowerCase();
  if (!allowed.includes(safe)) {
    throw new AppError("VALIDATION_ERROR", `${message} (${safe || "empty"})`, 400);
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

function hasDecisionSafeGoalLanguage(value) {
  const text = sanitizeText(value, 240);
  if (!hasGoalLanguage(text)) return true;
  return DECISION_SAFE_GOAL_CONTEXT_RE.test(text);
}

function normalizeGoalOutcome(value, context = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const reasonCodes = Array.isArray(context.reasonCodes) ? context.reasonCodes : [];
  const eventType = assertAllowedToken(
    raw.eventType || (reasonCodes.includes("visual_ball_in_net") || context.highlightType === "goal" ? "ball_in_net" : "none"),
    GOAL_EVENT_TYPES,
    "Goal outcome event type is invalid.",
    32,
  );
  const defaultOutcome = eventType === "ball_in_net"
    ? context.highlightType === "goal" && reasonCodes.includes("goal") ? "confirmed_goal" : "unknown_decision"
    : "none";
  const outcome = assertAllowedToken(raw.outcome || defaultOutcome, GOAL_OUTCOMES, "Goal outcome is invalid.", 40);
  const defaultOffsideStatus = outcome === "disallowed_offside"
    ? "offside"
    : outcome === "confirmed_goal"
      ? "onside"
      : outcome === "possible_offside"
        ? "possible"
        : eventType === "ball_in_net"
          ? "unknown"
          : "none";
  const offsideStatus = assertAllowedToken(raw.offsideStatus || defaultOffsideStatus, OFFSIDE_STATUSES, "Offside status is invalid.", 32);
  if (eventType === "none" && outcome !== "none") {
    throw new AppError("VALIDATION_ERROR", "Goal outcome needs a ball-in-net event.", 400);
  }
  if (eventType === "ball_in_net" && outcome === "none") {
    throw new AppError("VALIDATION_ERROR", "Ball-in-net event needs a goal outcome.", 400);
  }
  if (outcome === "disallowed_offside" && offsideStatus !== "offside") {
    throw new AppError("VALIDATION_ERROR", "Disallowed offside outcome needs offside status.", 400);
  }
  if (outcome === "confirmed_goal" && offsideStatus === "offside") {
    throw new AppError("VALIDATION_ERROR", "Confirmed goal cannot have offside status.", 400);
  }
  const decisionEvidence = Array.isArray(raw.decisionEvidence)
    ? assertAllowedList(raw.decisionEvidence, GOAL_DECISION_EVIDENCE_CODES, "Goal decision evidence is invalid.", 64).slice(0, 12)
    : [];
  const decisionTimestamp = raw.decisionTimestamp == null || raw.decisionTimestamp === ""
    ? null
    : Number(raw.decisionTimestamp);
  if (decisionTimestamp !== null && (!Number.isFinite(decisionTimestamp) || decisionTimestamp < 0)) {
    throw new AppError("VALIDATION_ERROR", "Goal decision timestamp is invalid.", 400);
  }
  const postContextSeconds = raw.postContextSeconds == null || raw.postContextSeconds === ""
    ? 0
    : clamp(raw.postContextSeconds, 0, 15);
  const rawDecisionWindow = raw.decisionWindow && typeof raw.decisionWindow === "object" && !Array.isArray(raw.decisionWindow)
    ? raw.decisionWindow
    : null;
  const decisionWindow = rawDecisionWindow
    ? {
        start: Number(rawDecisionWindow.start),
        end: Number(rawDecisionWindow.end),
      }
    : null;
  if (decisionWindow && (
    !Number.isFinite(decisionWindow.start) ||
    !Number.isFinite(decisionWindow.end) ||
    decisionWindow.start < 0 ||
    decisionWindow.end <= decisionWindow.start
  )) {
    throw new AppError("VALIDATION_ERROR", "Goal decision window is invalid.", 400);
  }
  const requiresPostContext = Boolean(raw.requiresPostContext ?? (eventType === "ball_in_net" && outcome !== "confirmed_goal"));
  const captionSafetyFlags = Array.isArray(raw.captionSafetyFlags)
    ? raw.captionSafetyFlags.map((flag) => sanitizeText(flag, 80)).filter(Boolean).slice(0, 8)
    : [];
  const rawSafeCaptionBadge = raw.safeCaptionBadge ? sanitizeText(raw.safeCaptionBadge, 32).toUpperCase() : null;
  if (rawSafeCaptionBadge && !GOAL_OUTCOME_BADGES.includes(rawSafeCaptionBadge)) {
    throw new AppError("VALIDATION_ERROR", "Goal outcome badge is invalid.", 400);
  }
  const rawBadge = raw.badge ? sanitizeText(raw.badge, 32).toUpperCase() : null;
  if (rawBadge && !GOAL_OUTCOME_BADGES.includes(rawBadge)) {
    throw new AppError("VALIDATION_ERROR", "Goal outcome badge is invalid.", 400);
  }
  const safeCaptionBadge = rawSafeCaptionBadge || rawBadge || (outcome === "confirmed_goal"
    ? "CONFIRMED GOAL"
    : outcome === "disallowed_offside"
      ? "OFFSIDE - NO GOAL"
      : outcome === "possible_offside"
        ? decisionEvidence.some((code) => code === "var_check" || code === "var_decision" || code === "visual_var_check" || code === "visual_var_decision")
          ? "VAR CHECK"
          : "POSSIBLE OFFSIDE"
        : eventType === "ball_in_net"
          ? "DECISION UNCLEAR"
          : null);
  const badge = rawBadge || safeCaptionBadge;
  return {
    eventType,
    outcome,
    offsideStatus,
    decisionEvidence,
    decisionTimestamp: decisionTimestamp === null ? null : Number(decisionTimestamp.toFixed(2)),
    decisionWindow: decisionWindow
      ? {
          start: Number(decisionWindow.start.toFixed(2)),
          end: Number(decisionWindow.end.toFixed(2)),
        }
      : null,
    confidence: Number(clamp(raw.confidence ?? (outcome === "none" ? 0 : 0.5), 0, 1).toFixed(2)),
    requiresPostContext,
    postContextSeconds: Number(postContextSeconds.toFixed(2)),
    badge,
    safeCaptionBadge,
    explanation: sanitizeText(raw.explanation || "", 180),
    captionSafetyFlags,
  };
}

function hasConfirmedGoalOutcome(goalOutcome) {
  return goalOutcome && goalOutcome.eventType === "ball_in_net" && goalOutcome.outcome === "confirmed_goal";
}

function assertNoMisleadingGoalLanguage({ hook, captions, highlightType, reasonCodes, goalOutcome }) {
  const hasGoalEvidence = highlightType === "goal" && Array.isArray(reasonCodes) && reasonCodes.includes("goal");
  if (hasGoalEvidence && hasConfirmedGoalOutcome(goalOutcome)) return;
  const texts = [hook, ...(Array.isArray(captions) ? captions.map((caption) => caption && caption.text) : [])];
  if (goalOutcome && goalOutcome.eventType === "ball_in_net" && goalOutcome.outcome !== "confirmed_goal") {
    const unsafe = texts.filter((text) => hasGoalLanguage(text) && !hasDecisionSafeGoalLanguage(text));
    if (unsafe.length) {
      throw new AppError("VALIDATION_ERROR", "Goal outcome captions need decision-safe language.", 400);
    }
    return;
  }
  if (texts.some((text) => hasGoalLanguage(text) && !hasDecisionSafeGoalLanguage(text))) {
    throw new AppError("VALIDATION_ERROR", "Edit plan uses goal language without goal evidence.", 400);
  }
}

function captionRoleForIndex(value, index, total) {
  const safe = sanitizeText(value, 40).toLowerCase();
  if (CAPTION_ROLES.includes(safe)) return safe;
  if (safe === "story_beat") {
    if (index === 1) return "context";
    if (index >= total - 2) return "reaction";
    return "action_callout";
  }
  if (index === 0) return "opening_hook";
  if (index === total - 1) return "closing_punch";
  if (index === 1) return "context";
  if (index === total - 2) return "reaction";
  return "action_callout";
}

function captionEmphasisForRole(value, role) {
  const safe = sanitizeText(value, 40).toLowerCase();
  if (CAPTION_EMPHASIS.includes(safe)) return safe;
  if (role === "opening_hook") return "shout";
  if (role === "context") return "detail";
  if (role === "closing_punch") return "strong";
  if (role === "reaction") return "strong";
  return "strong";
}

function captionLayoutForRole(value, role) {
  const safe = sanitizeText(value, 40).toLowerCase();
  if (CAPTION_LAYOUTS.includes(safe)) return safe;
  if (role === "opening_hook") return "center";
  if (role === "context") return "top";
  if (role === "action_callout") return "bottom";
  if (role === "reaction") return "bottom";
  return "bottom";
}

function captionStyleForRole(caption, role, emphasis, layout) {
  const style = caption && typeof caption.style === "object" && !Array.isArray(caption.style) ? caption.style : {};
  const defaultColor = emphasis === "warning" ? "red" : emphasis === "detail" ? "cyan" : "gold";
  const highlightColor = assertAllowedToken(style.highlightColor || caption.highlightColor || defaultColor, CAPTION_HIGHLIGHT_COLORS, "Caption highlight color is invalid.", 24);
  return {
    fontScale: Number(clamp(style.fontScale ?? caption.fontScale ?? (role === "context" ? 0.82 : role === "opening_hook" ? 1.12 : 1), 0.72, 1.25).toFixed(2)),
    stroke: Number(clamp(style.stroke ?? caption.stroke ?? (emphasis === "detail" ? 3 : 5), 2, 7).toFixed(1)),
    shadow: Number(clamp(style.shadow ?? caption.shadow ?? 2, 0, 4).toFixed(1)),
    highlightColor,
    uppercase: Boolean(style.uppercase ?? caption.uppercase ?? emphasis === "shout"),
    maxLines: Math.max(1, Math.min(3, Math.round(Number(style.maxLines ?? caption.maxLines ?? (layout === "top" ? 1 : 2)) || 2))),
  };
}

function captionTimingTokens(caption, role) {
  const timing = caption && typeof caption.timing === "object" && !Array.isArray(caption.timing) ? caption.timing : {};
  const entranceFallback = role === "opening_hook" ? 180 : role === "context" ? 130 : 160;
  return {
    entranceMs: Math.round(clamp(timing.entranceMs ?? caption.entranceMs ?? entranceFallback, 80, 450)),
    exitMs: Math.round(clamp(timing.exitMs ?? caption.exitMs ?? 120, 80, 350)),
  };
}

function captionIntentForHighlightType(highlightType, role = "action_callout") {
  const safeType = normalizeHighlightType(highlightType);
  const intents = {
    goal: "goal_claim_allowed",
    shot_on_target: "chance_pressure",
    near_miss: "near_miss_reaction",
    big_chance: "big_chance_pressure",
    save: "keeper_save_reaction",
    foul: "foul_contact",
    hard_foul: "hard_contact_reaction",
    card_moment: "referee_decision",
    counter_attack: "transition_space",
    skill_move: "skill_detail",
    crowd_reaction: "crowd_energy",
    commentator_peak: "commentary_energy",
    replay_or_reaction: "replay_detail",
    replay_worthy_moment: "replay_detail",
    audio_energy_spike: "audio_energy",
    unknown_action: "neutral_pressure",
    generic_highlight: "neutral_pressure",
  };
  const intent = intents[safeType] || intents.generic_highlight;
  if (role === "context") return `${intent}_context`;
  if (role === "reaction") return `${intent}_reaction`;
  if (role === "closing_punch") return `${intent}_replay_prompt`;
  return intent;
}

function normalizeCaptionEvidence(value, context, role) {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const highlightType = normalizeHighlightType(evidence.highlightType || context.highlightType);
  const alignedHighlightType = normalizeHighlightType(evidence.alignedHighlightType || evidence.highlightType || context.highlightType);
  const reasonCodes = Array.isArray(evidence.reasonCodes)
    ? evidence.reasonCodes
    : context.reasonCodes;
  const visualReasonCodes = Array.isArray(evidence.visualReasonCodes)
    ? evidence.visualReasonCodes
    : reasonCodes.filter((reason) => /^visual_/.test(reason));
  return {
    alignedHighlightType,
    highlightType,
    reasonCodes: reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 10),
    visualReasonCodes: visualReasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 10),
    goalEvidence: Boolean(evidence.goalEvidence ?? context.goalEvidence),
    goalOutcome: context.goalOutcome && context.goalOutcome.eventType === "ball_in_net"
      ? {
          outcome: context.goalOutcome.outcome,
          offsideStatus: context.goalOutcome.offsideStatus,
        }
      : null,
    role: sanitizeText(evidence.role || role, 40),
  };
}

function normalizeCaptionRiskFlags(value, text, context) {
  const rawFlags = Array.isArray(value) ? value : [];
  const flags = rawFlags
    .map((flag) => sanitizeText(flag, 60).toLowerCase())
    .filter((flag) => CAPTION_RISK_FLAGS.includes(flag));
  if (hasGoalLanguage(text) && !context.goalEvidence && !hasDecisionSafeGoalLanguage(text)) flags.push("goal_language_without_evidence");
  if (context.goalOutcome && context.goalOutcome.outcome === "disallowed_offside") flags.push("offside_decision_context");
  if (context.goalOutcome && ["possible_offside", "unknown_decision"].includes(context.goalOutcome.outcome)) flags.push("goal_outcome_uncertain");
  if (context.isReactionOnly) flags.push("crowd_context_only");
  return [...new Set(flags)].slice(0, 6);
}

function captionWords(text) {
  return sanitizeText(text, 96)
    .split(/\s+/)
    .map((word) => sanitizeText(word, 24))
    .filter(Boolean)
    .slice(0, 12);
}

function defaultEmphasisWords(words = [], role = "action_callout") {
  const eligible = words
    .map((word) => sanitizeText(word, 24))
    .filter((word) => word.length >= 4 || /goal|save|shot|off|var|γκολ/i.test(word));
  return (role === "opening_hook" ? eligible.slice(0, 3) : eligible.slice(0, 2));
}

function normalizeActiveWordTiming(value, words, start, end) {
  const duration = Math.max(0.2, end - start);
  const raw = Array.isArray(value) ? value : [];
  if (raw.length) {
    const normalized = raw.slice(0, words.length).map((item, index) => {
      const rawWord = sanitizeText(item && item.word || words[index], 24);
      const itemStart = clamp(item && item.start, start, end);
      const itemEnd = clamp(
        item && item.end,
        itemStart + 0.08,
        Math.min(end, itemStart + MAX_ACTIVE_WORD_DURATION_SECONDS),
      );
      if (!rawWord || itemEnd <= itemStart) return null;
      return {
        word: rawWord,
        start: Number(itemStart.toFixed(2)),
        end: Number(itemEnd.toFixed(2)),
        active: true,
      };
    }).filter(Boolean);
    if (normalized.length === words.length) return normalized;
  }
  const wordDuration = duration / Math.max(1, words.length);
  return words.map((word, index) => {
    const itemStart = Number((start + index * wordDuration).toFixed(2));
    const itemEnd = Number(Math.min(
      end,
      itemStart + MAX_ACTIVE_WORD_DURATION_SECONDS,
      itemStart + Math.max(0.12, wordDuration * 0.9),
    ).toFixed(2));
    return {
      word,
      start: itemStart,
      end: itemEnd,
      active: true,
    };
  });
}

function captionSafeAreaForLayout(layout) {
  if (layout === "top") {
    return {
      name: "upper_third_safe",
      avoidsScorebug: false,
      maxWidthPercent: 0.82,
      maxHeightPercent: 0.16,
      verticalAnchor: "top",
    };
  }
  if (layout === "center") {
    return {
      name: "center_safe",
      avoidsScorebug: true,
      maxWidthPercent: 0.84,
      maxHeightPercent: 0.22,
      verticalAnchor: "center",
    };
  }
  return {
    name: "lower_third_safe",
    avoidsScorebug: true,
    maxWidthPercent: 0.86,
    maxHeightPercent: 0.2,
    verticalAnchor: "bottom",
  };
}

function normalizeCaptionDynamicMetadata(caption, { text, start, end, role, layout, stylePreset }) {
  const words = captionWords(text);
  const emphasisWords = Array.isArray(caption.emphasisWords)
    ? caption.emphasisWords.map((word) => sanitizeText(word, 24)).filter(Boolean).slice(0, 4)
    : defaultEmphasisWords(words, role);
  const safeArea = caption.safeArea && typeof caption.safeArea === "object" && !Array.isArray(caption.safeArea)
    ? caption.safeArea
    : captionSafeAreaForLayout(layout);
  const safeAreaName = assertAllowedToken(safeArea.name || safeArea.zone || captionSafeAreaForLayout(layout).name, CAPTION_SAFE_AREAS, "Caption safe area is invalid.", 32);
  const contrastMode = assertAllowedToken(caption.contrastMode || (caption.style && caption.style.contrastMode) || "outline_shadow", CAPTION_CONTRAST_MODES, "Caption contrast mode is invalid.", 32);
  const preset = assertAllowedToken(caption.stylePreset || stylePreset || "hormozi_kinetic_safe_v1", CAPTION_STYLE_PRESETS, "Caption style preset is invalid.", 48);
  return {
    captionId: sanitizeText(caption.captionId || `cap_${role}_${Math.round(start * 100)}`, 48),
    words,
    activeWordTiming: normalizeActiveWordTiming(caption.activeWordTiming, words, start, end),
    emphasisWords,
    stylePreset: preset,
    safeArea: {
      name: safeAreaName,
      avoidsScorebug: Boolean(safeArea.avoidsScorebug ?? safeAreaName !== "upper_third_safe"),
      maxWidthPercent: Number(clamp(safeArea.maxWidthPercent ?? 0.86, 0.62, 0.92).toFixed(2)),
      maxHeightPercent: Number(clamp(safeArea.maxHeightPercent ?? 0.2, 0.1, 0.28).toFixed(2)),
      verticalAnchor: sanitizeText(safeArea.verticalAnchor || captionSafeAreaForLayout(layout).verticalAnchor, 24),
    },
    maxLineLength: Math.max(10, Math.min(24, Math.round(Number(caption.maxLineLength || caption.maxLineChars || 18) || 18))),
    contrastMode,
  };
}

function normalizeCaptionSource(value, highlightType, role) {
  const safe = sanitizeText(value, 96);
  if (safe) return safe;
  return `edit_plan:${normalizeHighlightType(highlightType)}:${sanitizeText(role, 40) || "caption"}`;
}

function normalizeCaptionContext(context = {}) {
  const highlightType = normalizeHighlightType(context.highlightType || "generic_highlight");
  const reasonCodes = Array.isArray(context.reasonCodes)
    ? context.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 12)
    : [];
  const reactionReasons = new Set(["crowd_reaction", "crowd_spike", "visual_crowd_reaction", "commentator_peak", "audio_energy_spike", "audio_peak"]);
  const actionReasons = new Set(["goal", "big_chance", "shot_on_target", "save", "hard_foul", "foul", "card_moment", "counter_attack", "skill_move", "visual_shot_like_motion", "visual_save_like_motion", "visual_foul_like_contact", "visual_fast_break"]);
  const goalOutcome = normalizeGoalOutcome(context.goalOutcome, { highlightType, reasonCodes });
  return {
    highlightType,
    reasonCodes,
    goalOutcome,
    goalEvidence: Boolean(context.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal") && hasConfirmedGoalOutcome(goalOutcome))),
    isReactionOnly: reasonCodes.some((reason) => reactionReasons.has(reason)) && !reasonCodes.some((reason) => actionReasons.has(reason)),
  };
}

function normalizeCaptionItem(caption, index, total, sourceStart, sourceEnd, context = {}) {
  const duration = sourceEnd - sourceStart;
  const start = clamp(caption.start, 0, duration);
  const end = clamp(caption.end, start + 0.4, duration);
  const text = sanitizeText(caption.text, 96);
  if (!text) return null;
  const role = captionRoleForIndex(caption.role, index, total);
  const emphasis = captionEmphasisForRole(caption.emphasis, role);
  const layout = captionLayoutForRole(caption.layout, role);
  const captionIntent = sanitizeText(caption.captionIntent || captionIntentForHighlightType(context.highlightType, role), 80);
  const captionEvidence = normalizeCaptionEvidence(caption.captionEvidence, context, role);
  const captionSource = normalizeCaptionSource(caption.captionSource, context.highlightType, role);
  const captionRiskFlags = normalizeCaptionRiskFlags(caption.captionRiskFlags, text, context);
  const dynamicMetadata = normalizeCaptionDynamicMetadata(caption, {
    text,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    role,
    layout,
    stylePreset: caption.stylePreset,
  });
  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    text,
    index,
    role,
    emphasis,
    layout,
    timing: captionTimingTokens(caption, role),
    style: captionStyleForRole(caption, role, emphasis, layout),
    captionIntent,
    captionEvidence,
    captionSource,
    captionRiskFlags,
    captionId: dynamicMetadata.captionId,
    words: dynamicMetadata.words,
    activeWordTiming: dynamicMetadata.activeWordTiming,
    emphasisWords: dynamicMetadata.emphasisWords,
    stylePreset: dynamicMetadata.stylePreset,
    safeArea: dynamicMetadata.safeArea,
    maxLineLength: dynamicMetadata.maxLineLength,
    contrastMode: dynamicMetadata.contrastMode,
  };
}

function normalizeCaptions(captions, sourceStart, sourceEnd, context = {}) {
  const duration = sourceEnd - sourceStart;
  const safe = Array.isArray(captions) ? captions : [];
  const normalizedContext = normalizeCaptionContext(context);
  const normalized = safe
    .map((caption, index) => normalizeCaptionItem(caption || {}, index, safe.length, sourceStart, sourceEnd, normalizedContext))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  normalized.forEach((caption, index) => {
    caption.index = index;
  });
  if (duration <= 0) return [];
  return normalized;
}

function hookForHighlightType(highlightType, preset) {
  const safeType = normalizeHighlightType(highlightType);
  return sanitizeText(HIGHLIGHT_HOOKS[safeType] || HOOKS[preset] || HOOKS.hype, 96);
}

function createFallbackCaptions(duration, preset, options = {}) {
  const highlightType = normalizeHighlightType(options.highlightType);
  const reasonCodes = Array.isArray(options.reasonCodes)
    ? options.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 10)
    : [highlightType].filter((reason) => reason !== "generic_highlight");
  const goalOutcome = normalizeGoalOutcome(options.goalOutcome, { highlightType, reasonCodes });
  const goalEvidence = Boolean(options.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal") && hasConfirmedGoalOutcome(goalOutcome)));
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
  const outcomeBeats = {
    confirmed_goal: ["GOAL CONFIRMED", "THE FINISH COUNTS", "REPLAY THE BUILD-UP"],
    disallowed_offside: ["GOAL... BUT THE FLAG IS UP", "OFFSIDE - NO GOAL", "FINISH RULED OUT"],
    possible_offside: ["WAS HE OFF?", "FLAG CHECK COMING", "DECISION NOT CLEAR"],
    unknown_decision: ["BALL IN THE NET", "DECISION NOT CLEAR", "WATCH THE FULL CONTEXT"],
  };
  const beats = goalOutcome.eventType === "ball_in_net"
    ? outcomeBeats[goalOutcome.outcome] || outcomeBeats.unknown_decision
    : beatsByType[highlightType] || beatsByType.generic_highlight;
  return beats.map((text, index) => {
    const role = index === 0 ? "opening_hook" : index === beats.length - 1 ? "closing_punch" : index === 1 ? "action_callout" : "reaction";
    const firstDuration = Math.min(2, Math.max(0.85, duration * 0.28));
    const lastDuration = Math.min(2.8, Math.max(1.1, duration * 0.22));
    const middleStart = Math.min(
      Math.max(firstDuration + 0.15, duration * 0.45),
      Math.max(firstDuration + 0.15, duration - lastDuration - 1.2),
    );
    const middleEnd = Math.min(
      duration - lastDuration - 0.15,
      middleStart + Math.min(3.2, Math.max(1.35, duration * 0.18)),
    );
    const lastStart = Math.max(middleEnd + 0.15, duration - lastDuration);
    const timing = index === 0
      ? { start: 0, end: Math.min(duration, firstDuration) }
      : index === beats.length - 1
        ? { start: Math.max(0, Math.min(lastStart, duration - 0.5)), end: duration }
        : { start: Math.max(0, middleStart), end: Math.max(middleStart + 0.5, middleEnd) };
    return {
      start: Number(timing.start.toFixed(2)),
      end: Number(Math.min(duration, timing.end).toFixed(2)),
      text,
      role,
      captionIntent: captionIntentForHighlightType(highlightType, role),
      captionSource: `fallback:${highlightType}:${role}`,
      captionEvidence: {
        alignedHighlightType: highlightType,
        highlightType,
        reasonCodes,
        visualReasonCodes: reasonCodes.filter((reason) => /^visual_/.test(reason)),
        goalEvidence,
        goalOutcome: goalOutcome.eventType === "ball_in_net"
          ? { outcome: goalOutcome.outcome, offsideStatus: goalOutcome.offsideStatus }
          : null,
        role,
      },
      captionRiskFlags: goalOutcome.outcome === "disallowed_offside"
        ? ["offside_decision_context"]
        : ["possible_offside", "unknown_decision"].includes(goalOutcome.outcome)
          ? ["goal_outcome_uncertain"]
          : [],
    };
  }).filter((caption) => caption.end > caption.start);
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
    { type: "intro_hook", start: 0, end: Math.min(1.2, safeDuration), reason: "first_two_seconds_hook", evidenceCode: reasonCodes[0] || "generic_highlight", intensity: "medium" },
    { type: "caption_word_pop", start: 0, end: Math.min(2.4, safeDuration), reason: "dynamic_word_caption_hook", evidenceCode: "caption_readability", intensity: "medium" },
    { type: "kinetic_caption", start: 0.2, end: Math.min(1.8, safeDuration), reason: "caption_motion_readability", evidenceCode: "caption_readability", intensity: "medium" },
    { type: "goal_counter_overlay", start: 0, end: Math.min(3.6, safeDuration), reason: "social_goal_progress_context", evidenceCode: "score_context", intensity: "low" },
    { type: "end_replay_prompt", start: Math.max(0, safeDuration - 1.3), end: safeDuration, reason: "closing_rewatch_prompt", evidenceCode: "closing_punch", intensity: "low" },
  ];
  if (reasonCodes.includes("audio_energy_spike") || reasonCodes.includes("audio_peak")) {
    cues.push({ type: "beat_pulse", start: Math.min(1.6, safeDuration - 0.2), end: Math.min(2.1, safeDuration), reason: "audio_energy_sync", evidenceCode: "audio_energy_spike", intensity: "low" });
  }
  if (
    reasonCodes.includes("scene_change_cluster") ||
    reasonCodes.includes("replay_worthy_moment") ||
    reasonCodes.includes("visual_shot_like_motion") ||
    reasonCodes.includes("visual_shot_contact") ||
    reasonCodes.includes("visual_ball_toward_goal") ||
    reasonCodes.includes("visual_save_like_motion") ||
    reasonCodes.includes("visual_keeper_action") ||
    reasonCodes.includes("visual_ball_in_net") ||
    reasonCodes.includes("visual_foul_like_contact") ||
    reasonCodes.includes("visual_fast_break")
  ) {
    cues.push({ type: "subtle_camera_push", start: Math.min(2.2, safeDuration - 0.2), end: Math.min(3.2, safeDuration), reason: "action_focus_motion", evidenceCode: "visual_action_evidence", intensity: "low" });
  }
  if (reasonCodes.includes("goal") || reasonCodes.includes("visual_ball_in_net") || reasonCodes.includes("visual_shot_contact")) {
    cues.push({ type: "punch_zoom", start: 0, end: Math.min(1.05, safeDuration), reason: "evidence_backed_hook_payoff", evidenceCode: "goal_or_shot_evidence", intensity: "medium" });
    cues.push({ type: "smooth_flash_transition", start: Math.min(1.15, safeDuration - 0.1), end: Math.min(1.55, safeDuration), reason: "hook_to_sequence_transition", evidenceCode: "goal_or_shot_evidence", intensity: "low" });
  }
  if (reasonCodes.includes("hard_foul") || reasonCodes.includes("visual_foul_like_contact")) {
    cues.push({ type: "subtle_shake", start: Math.min(0.9, safeDuration - 0.1), end: Math.min(1.2, safeDuration), reason: "contact_impact_moment", evidenceCode: "visual_foul_like_contact", intensity: "low" });
  }
  return cues.filter((cue) => cue.end > cue.start).map((cue) => ({
    type: cue.type,
    start: Number(cue.start.toFixed(2)),
    end: Number(cue.end.toFixed(2)),
    intensity: cue.intensity,
    reason: sanitizeText(cue.reason, 80),
    evidenceCode: sanitizeText(cue.evidenceCode, 60),
    safeForMotion: true,
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

function defaultCropPlan(metadata = {}, aspectRatio = "9:16") {
  return calibrateCropPlan({ metadata, targetAspectRatio: aspectRatio });
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

function normalizeAnimationCue(cue, duration, unsupportedAnimationCues) {
  const type = sanitizeText(cue && cue.type, 40).toLowerCase();
  const start = clamp(cue && cue.start, 0, duration);
  let end = clamp(cue && cue.end, 0, duration);
  if (!ANIMATION_CUE_TYPES.includes(type) || end <= start) {
    unsupportedAnimationCues.push({ type: type || "unknown", reason: "unsupported_or_invalid_timing" });
    return null;
  }
  const maxDuration = ANIMATION_CUE_LIMITS[type] || 2;
  if (end - start > maxDuration) {
    end = Math.min(duration, start + maxDuration);
  }
  if (end <= start) {
    unsupportedAnimationCues.push({ type, reason: "duration_limit_invalidated_cue" });
    return null;
  }
  return {
    type,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    intensity: assertAllowedToken(cue && cue.intensity || "low", ["low", "medium", "high"], "Animation cue intensity is invalid.", 24),
    reason: sanitizeText(cue && cue.reason || "evidence_aligned_motion", 80),
    evidenceCode: sanitizeText(cue && cue.evidenceCode || cue && cue.reasonCode || "visual_action_evidence", 60),
    safeForMotion: Boolean(cue && cue.safeForMotion !== false),
  };
}

function normalizeEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return assertAllowedList(effects, EFFECT_TYPES, "Edit plan effect is invalid.", 40);
}

function segmentHasPrimaryAction(reasonCodes = [], highlightType = "generic_highlight") {
  const reasonSet = new Set(Array.isArray(reasonCodes) ? reasonCodes : []);
  return normalizeHighlightType(highlightType) === "goal" ||
    SEGMENT_PRIMARY_ACTION_REASONS.some((reason) => reasonSet.has(reason) || reason === normalizeHighlightType(highlightType));
}

function finiteTimestamp(value, min, max, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Number(clamp(parsed, min, max).toFixed(2));
}

function normalizeSegmentGoalPhase(segment = {}, context = {}) {
  const raw = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const reasonSet = new Set(context.reasonCodes || []);
  const confirmedGoal = context.highlightType === "goal" &&
    context.goalOutcome &&
    context.goalOutcome.eventType === "ball_in_net" &&
    context.goalOutcome.outcome === "confirmed_goal";
  const buildupStart = finiteTimestamp(
    segment.buildupStart ?? raw.buildupStart ?? raw.liveActionStart,
    context.sourceStart,
    context.sourceEnd,
    context.sourceStart,
  );
  const shotStart = finiteTimestamp(segment.shotStart ?? raw.shotStart, context.sourceStart, context.sourceEnd, null);
  const normalizedFinishFrame = normalizeFinishFrameEvidence(
    segment.finishFrameEvidence ||
      raw.finishFrameEvidence ||
      (raw.visualGoalPayoff && raw.visualGoalPayoff.finishFrameEvidence),
    context,
  );
  const rawFinishTime = finiteTimestamp(segment.finishTime ?? raw.finishTime, context.sourceStart, context.sourceEnd, null);
  const finishFrameCanBind = normalizedFinishFrame &&
    normalizedFinishFrame.frameTime != null &&
    normalizedFinishFrame.hasVisibleFinish &&
    normalizedFinishFrame.hasBallInNetOrPayoff &&
    normalizedFinishFrame.hasGoalMouth &&
    normalizedFinishFrame.isBlurred !== true &&
    normalizedFinishFrame.isOverZoomed !== true &&
    normalizedFinishFrame.isLabelOnly !== true &&
    normalizedFinishFrame.isReplayOnly !== true &&
    normalizedFinishFrame.isCelebrationOnly !== true &&
    normalizedFinishFrame.isScoreboardOnly !== true;
  const finishTime = finishFrameCanBind ? normalizedFinishFrame.frameTime : rawFinishTime;
  const rawConfirmationTime = finiteTimestamp(segment.confirmationTime ?? raw.confirmationTime, context.sourceStart, context.sourceEnd, null);
  const confirmationTime = confirmedGoal &&
    finishFrameCanBind &&
    finishTime != null &&
    (
      rawConfirmationTime == null ||
      rawConfirmationTime < finishTime - 0.25
    )
    ? finiteTimestamp(finishTime + 0.2, context.sourceStart, context.sourceEnd, rawConfirmationTime)
    : rawConfirmationTime;
  const replayUsed = Boolean(
    segment.replayUsed ||
    raw.replayUsed ||
    reasonSet.has("visual_replay_indicator") ||
    reasonSet.has("visual_replay_angle") ||
    reasonSet.has("replay_goal_confirmation"),
  );
  const hasShot = raw.hasShot == null
    ? reasonSet.has("visual_shot_contact") || reasonSet.has("visual_shot_like_motion") || reasonSet.has("visual_ball_toward_goal") || reasonSet.has("shot_sequence_support")
    : Boolean(raw.hasShot);
  const hasVisibleGoalPayoff = reasonSet.has("visual_ball_in_net") ||
    reasonSet.has("ball_in_net") ||
    (reasonSet.has("live_shot_finish_sequence") && hasShot);
  const hasFinish = raw.hasFinish == null
    ? hasVisibleGoalPayoff
    : Boolean(raw.hasFinish) && hasVisibleGoalPayoff;
  const replayOnly = Boolean(segment.replayOnly || raw.replayOnly) || (replayUsed && !hasShot);
  const hasBuildupFromWindow = shotStart == null
    ? context.sourceEnd - context.sourceStart >= 8
    : context.sourceStart <= shotStart - 2;
  const phaseCoverage = {
    hasBuildup: raw.hasBuildup == null ? hasBuildupFromWindow : Boolean(raw.hasBuildup) || hasBuildupFromWindow,
    hasShot,
    hasFinish,
    hasConfirmation: raw.hasConfirmation == null
      ? confirmedGoal || reasonSet.has("visual_scoreboard_goal_confirmed") || reasonSet.has("visual_referee_goal_signal") || reasonSet.has("confirmed_by_commentary")
      : Boolean(raw.hasConfirmation),
    replayUsed,
    replayOnly,
    visualGoalPayoff: {
      hasVisibleGoalPayoff,
      hasBallInNetEvidence: reasonSet.has("visual_ball_in_net") || reasonSet.has("ball_in_net"),
      hasLiveFinishSequence: reasonSet.has("live_shot_finish_sequence") && hasShot,
      scoreboardOnly: (reasonSet.has("scoreboard_backed_goal_sequence") || reasonSet.has("scoreboard_ocr_score_change")) && !hasVisibleGoalPayoff,
      finishFrameEvidence: normalizedFinishFrame,
    },
    finishFrameEvidence: normalizedFinishFrame,
  };
  if (confirmedGoal && (phaseCoverage.replayOnly || !phaseCoverage.hasShot || !phaseCoverage.hasFinish)) {
    throw new AppError("VALIDATION_ERROR", "Confirmed goal segment must include live shot and finish evidence.", 400);
  }
  return {
    goalNumber: Number.isFinite(Number(segment.goalNumber)) ? Math.max(1, Math.round(Number(segment.goalNumber))) : null,
    buildupStart,
    shotStart,
    finishTime,
    confirmationTime,
    replayUsed,
    replayOnly,
    phaseCoverage,
  };
}

function normalizeFinishFrameEvidence(value = {}, context = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!raw) return null;
  const frameTime = finiteTimestamp(raw.frameTime ?? raw.time ?? raw.timestamp, context.sourceStart, context.sourceEnd, null);
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Number(clamp(Number(raw.confidence), 0, 1).toFixed(2))
    : null;
  const evidenceCodes = Array.isArray(raw.evidenceCodes || raw.reasonCodes)
    ? (raw.evidenceCodes || raw.reasonCodes).map((code) => sanitizeText(code, 80)).filter(Boolean).slice(0, 8)
    : [];
  return {
    frameTime,
    confidence,
    hasVisibleFinish: raw.hasVisibleFinish === true || raw.visibleFinish === true,
    hasBallInNetOrPayoff: raw.hasBallInNetOrPayoff === true ||
      raw.hasBallInNet === true ||
      raw.hasClearPayoff === true ||
      raw.ballInNetOrPayoffVisible === true,
    hasGoalMouth: raw.hasGoalMouth === true || raw.goalMouthVisible === true,
    isBlurred: raw.isBlurred === true || raw.blurred === true || raw.blurRisk === true,
    isOverZoomed: raw.isOverZoomed === true || raw.overZoomed === true || raw.overZoomRisk === true,
    isLabelOnly: raw.isLabelOnly === true || raw.labelOnly === true || raw.captionOnly === true,
    isReplayOnly: raw.isReplayOnly === true || raw.replayOnly === true,
    isCelebrationOnly: raw.isCelebrationOnly === true || raw.celebrationOnly === true,
    isScoreboardOnly: raw.isScoreboardOnly === true || raw.scoreboardOnly === true,
    evidenceCodes,
  };
}

function normalizeScoreText(value) {
  const text = sanitizeText(value || "", 16).replace(/\s+/g, "");
  if (!/^\d{1,2}[-:]\d{1,2}$/.test(text)) return null;
  return text.replace(":", "-");
}

function normalizedEditPlanMode(value, hasSegments) {
  const safe = sanitizeText(value || (hasSegments ? "multi_moment_compilation" : "single_moment"), 40).toLowerCase();
  if (EDIT_PLAN_MODES.includes(safe)) return safe;
  throw new AppError("VALIDATION_ERROR", "Unsupported edit plan mode.", 400);
}

function overlapSeconds(a, b) {
  const left = Math.max(a.sourceStart, b.sourceStart);
  const right = Math.min(a.sourceEnd, b.sourceEnd);
  return Math.max(0, right - left);
}

function normalizeSegmentItem(segment, index, metadata = {}) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    throw new AppError("VALIDATION_ERROR", "Edit plan segment is invalid.", 400);
  }
  const mediaDuration = Number(metadata.durationSeconds || 0);
  const sourceStart = Number(segment.sourceStart);
  const sourceEnd = Number(segment.sourceEnd);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd <= sourceStart) {
    throw new AppError("VALIDATION_ERROR", "Edit plan segment source range is invalid.", 400);
  }
  if (mediaDuration > 0 && sourceEnd > mediaDuration + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Edit plan segment exceeds media duration.", 400);
  }
  const segmentDuration = Number((sourceEnd - sourceStart).toFixed(3));
  if (segmentDuration < MULTI_MOMENT_LIMITS.minSegmentDuration || segmentDuration > MULTI_MOMENT_LIMITS.maxSegmentDuration) {
    throw new AppError("VALIDATION_ERROR", "Edit plan segment duration is outside allowed bounds.", 400);
  }
  const highlightType = normalizeHighlightType(segment.highlightType);
  const reasonCodes = Array.isArray(segment.reasonCodes)
    ? segment.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 12)
    : [];
  const rawSafetyFlags = Array.isArray(segment.safetyFlags) ? segment.safetyFlags : [];
  const safetyFlags = rawSafetyFlags.map((flag) => sanitizeText(flag, 80)).filter(Boolean).slice(0, 8);
  if (safetyFlags.includes("opening_context_without_action") && !segmentHasPrimaryAction(reasonCodes, highlightType)) {
    throw new AppError("VALIDATION_ERROR", "Opening context segment needs explicit action evidence.", 400);
  }
  const goalOutcome = normalizeGoalOutcome(segment.goalOutcome, { highlightType, reasonCodes });
  const goalPhase = normalizeSegmentGoalPhase(segment, {
    sourceStart,
    sourceEnd,
    highlightType,
    reasonCodes,
    goalOutcome,
  });
  return {
    id: sanitizeText(segment.id || `segment_${index + 1}`, 64),
    sourceStart: Number(sourceStart.toFixed(2)),
    sourceEnd: Number(sourceEnd.toFixed(2)),
    duration: Number(segmentDuration.toFixed(2)),
    highlightType,
    reasonCodes,
    goalOutcome,
    goalNumber: goalPhase.goalNumber,
    scoreBefore: normalizeScoreText(segment.scoreBefore || goalPhase.scoreBefore || (goalOutcome && goalOutcome.scoreBefore)),
    scoreAfter: normalizeScoreText(segment.scoreAfter || goalPhase.scoreAfter || (goalOutcome && goalOutcome.scoreAfter)),
    scoreChangeTime: Number.isFinite(Number(segment.scoreChangeTime ?? goalPhase.scoreChangeTime ?? (goalOutcome && goalOutcome.scoreChangeTime)))
      ? Number(Number(segment.scoreChangeTime ?? goalPhase.scoreChangeTime ?? (goalOutcome && goalOutcome.scoreChangeTime)).toFixed(2))
      : null,
    buildupStart: goalPhase.buildupStart,
    shotStart: goalPhase.shotStart,
    finishTime: goalPhase.finishTime,
    confirmationTime: goalPhase.confirmationTime,
    replayUsed: goalPhase.replayUsed,
    replayOnly: goalPhase.replayOnly,
    referenceGoalPacing: Boolean(segment.referenceGoalPacing),
    phaseCoverage: goalPhase.phaseCoverage,
    finishFrameEvidence: goalPhase.phaseCoverage.finishFrameEvidence ||
      normalizeFinishFrameEvidence(
        segment.finishFrameEvidence ||
          (segment.phaseCoverage && segment.phaseCoverage.finishFrameEvidence) ||
          (segment.phaseCoverage && segment.phaseCoverage.visualGoalPayoff && segment.phaseCoverage.visualGoalPayoff.finishFrameEvidence),
        { sourceStart, sourceEnd },
      ),
    boundarySmoothing: segment.boundarySmoothing && typeof segment.boundarySmoothing === "object" && !Array.isArray(segment.boundarySmoothing)
      ? {
          applied: Boolean(segment.boundarySmoothing.applied),
          smoothingLevel: sanitizeText(segment.boundarySmoothing.smoothingLevel || "", 40),
          preActionPaddingSeconds: Number.isFinite(Number(segment.boundarySmoothing.preActionPaddingSeconds))
            ? Number(Number(segment.boundarySmoothing.preActionPaddingSeconds).toFixed(2))
            : null,
          postConfirmationPaddingSeconds: Number.isFinite(Number(segment.boundarySmoothing.postConfirmationPaddingSeconds))
            ? Number(Number(segment.boundarySmoothing.postConfirmationPaddingSeconds).toFixed(2))
            : null,
          reason: sanitizeText(segment.boundarySmoothing.reason || "", 120),
        }
      : null,
    confidence: Number(clamp(segment.confidence, 0, 1).toFixed(2)),
    retentionScore: Math.round(clamp(segment.retentionScore || segment.confidence * 100, 0, 100)),
    captionTheme: sanitizeText(segment.captionTheme || captionIntentForHighlightType(highlightType), 80),
    actionSequenceSummary: segment.actionSequenceSummary && typeof segment.actionSequenceSummary === "object" && !Array.isArray(segment.actionSequenceSummary)
      ? segment.actionSequenceSummary
      : null,
    whySelected: sanitizeText(segment.whySelected || "Selected as a bounded football phase.", 160),
    safetyFlags,
  };
}

function normalizeSegments(segments, metadata = {}) {
  const rawSegments = Array.isArray(segments) ? segments : [];
  if (!rawSegments.length) return [];
  if (rawSegments.length < MULTI_MOMENT_LIMITS.minSegments || rawSegments.length > MULTI_MOMENT_LIMITS.maxSegments) {
    throw new AppError("VALIDATION_ERROR", "Edit plan segment count is outside allowed bounds.", 400);
  }
  const normalized = rawSegments
    .map((segment, index) => normalizeSegmentItem(segment, index, metadata))
    .sort((a, b) => a.sourceStart - b.sourceStart);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    const overlap = overlapSeconds(previous, current);
    if (!overlap) continue;
    const smallestDuration = Math.min(previous.duration, current.duration);
    const intentionalReplay = previous.reasonCodes.includes("visual_replay_indicator") ||
      previous.reasonCodes.includes("replay_worthy_moment") ||
      current.reasonCodes.includes("visual_replay_indicator") ||
      current.reasonCodes.includes("replay_worthy_moment");
    const confirmedGoalOverlap = previous.highlightType === "goal" &&
      current.highlightType === "goal" &&
      previous.goalOutcome &&
      current.goalOutcome &&
      previous.goalOutcome.outcome === "confirmed_goal" &&
      current.goalOutcome.outcome === "confirmed_goal" &&
      overlap / Math.max(0.1, smallestDuration) <= 0.95;
    if (!intentionalReplay && !confirmedGoalOverlap) {
      throw new AppError("VALIDATION_ERROR", "Edit plan segments overlap too much.", 400);
    }
    if (intentionalReplay && !confirmedGoalOverlap && overlap / Math.max(0.1, smallestDuration) > 0.35) {
      throw new AppError("VALIDATION_ERROR", "Edit plan segments overlap too much.", 400);
    }
  }
  let cursor = 0;
  const withTimeline = normalized.map((segment) => {
    const timelineStart = Number(cursor.toFixed(2));
    cursor += segment.duration;
    return {
      ...segment,
      timelineStart,
      timelineEnd: Number(cursor.toFixed(2)),
    };
  });
  const totalDuration = Number(cursor.toFixed(2));
  if (totalDuration > MULTI_MOMENT_LIMITS.maxTotalDuration) {
    throw new AppError("VALIDATION_ERROR", "Multi-moment edit plan exceeds allowed total duration.", 400);
  }
  return withTimeline;
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
  const reasonCodes = ["generic_highlight"];
  const hook = hookForHighlightType(highlightType, preset);
  const captions =
    transcript && Array.isArray(transcript.captions) && transcript.captions.length > 0
      ? normalizeCaptions(transcript.captions, sourceStart, safeEnd, { highlightType, reasonCodes })
      : createFallbackCaptions(duration, preset, { highlightType, hook, reasonCodes });
  const framingMode = framingModeForMetadata(metadata);
  return {
    sourceStart,
    sourceEnd: Number(safeEnd.toFixed(2)),
    aspectRatio: "9:16",
    highlightType,
    confidence: 0.5,
    hook,
    title: sanitizeText(title, 120),
    captions: captions.length ? captions : createFallbackCaptions(duration, preset, { highlightType, hook, reasonCodes }),
    effects: ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "brand_safe_template"],
    framingMode,
    framingReason: "wide_safe_default_no_visual_tracking",
    actionFocusConfidence: 0,
    visualEvidenceSummary: normalizeVisualEvidenceSummary(null),
    cropPlan: defaultCropPlan(metadata, "9:16"),
    cropStrategy: createCropStrategy(metadata, framingMode),
    stylePreset: normalizeStylePreset("social_sports_v1"),
    captionEmphasis: createCaptionEmphasis(captions, highlightType),
    animationCues: createAnimationCues(duration, reasonCodes),
    audioPolicy: { audioMode: "source" },
    creativeStyleTransforms: { colorGrade: "sports_pop_safe", mildZoom: 1.02 },
    safetyNotes: ["No ball tracking claim; wide-safe framing preserves the full source frame when needed."],
    export: {
      width: 1080,
      height: 1920,
      format: "mp4",
    },
  };
}

function hookTypeForPlan({ highlightType, reasonCodes = [], goalOutcome = null } = {}) {
  const reasons = new Set(reasonCodes);
  if (highlightType === "goal" && hasConfirmedGoalOutcome(goalOutcome)) return "goal_payoff";
  if (highlightType === "save" || reasons.has("visual_save_like_motion") || reasons.has("visual_keeper_action")) return "save";
  if (highlightType === "hard_foul" || highlightType === "foul" || reasons.has("visual_foul_like_contact")) return "collision";
  if (["shot_on_target", "big_chance", "near_miss"].includes(highlightType) || reasons.has("visual_shot_contact") || reasons.has("visual_shot_like_motion")) return "shot";
  if (reasons.has("audio_energy_spike") || reasons.has("crowd_spike")) return "dramatic_moment";
  return "neutral_football";
}

function hookSourceWindowForSegments(segments = [], hookType = "neutral_football") {
  const goalSegment = segments.find((segment) => segment.highlightType === "goal" && hasConfirmedGoalOutcome(segment.goalOutcome));
  const primary = goalSegment || segments.find((segment) => segment.highlightType !== "crowd_reaction") || segments[0] || null;
  if (!primary) return null;
  const sourceStart = Number(primary.sourceStart);
  const sourceEnd = Number(primary.sourceEnd);
  const payoffTime = Number(primary.finishTime || primary.shotStart || sourceStart + Math.min(2, Math.max(0.8, (sourceEnd - sourceStart) * 0.25)));
  const start = hookType === "goal_payoff" || hookType === "shot" || hookType === "save"
    ? Math.max(sourceStart, payoffTime - 0.65)
    : sourceStart;
  const end = Math.min(sourceEnd, start + 1.6);
  return {
    sourceStart: Number(start.toFixed(2)),
    sourceEnd: Number(Math.max(start + 0.8, end).toFixed(2)),
    relatedGoalNumber: Number.isFinite(Number(primary.goalNumber)) ? Number(primary.goalNumber) : null,
  };
}

function normalizeHookPlan(plan, { renderDuration, highlightType, reasonCodes, goalOutcome, segments }) {
  const raw = plan.hookPlan && typeof plan.hookPlan === "object" && !Array.isArray(plan.hookPlan) ? plan.hookPlan : {};
  const derivedHookType = hookTypeForPlan({ highlightType, reasonCodes, goalOutcome });
  const hookType = assertAllowedToken(raw.hookType || derivedHookType, HOOK_TYPES, "Hook type is invalid.", 40);
  const hookStart = clamp(raw.hookStart ?? 0, 0, Math.min(2, renderDuration));
  const hookEnd = clamp(raw.hookEnd ?? Math.min(1.6, renderDuration), hookStart + 0.8, Math.min(2, renderDuration));
  const evidenceCodes = Array.isArray(raw.evidenceCodes)
    ? raw.evidenceCodes.map((code) => sanitizeText(code, 60)).filter(Boolean).slice(0, 8)
    : reasonCodes.slice(0, 8);
  const sourceWindow = hookSourceWindowForSegments(segments, hookType);
  const hookText = sanitizeText(raw.hookText || plan.hook || hookForHighlightType(highlightType, plan.stylePreset), 96);
  const noFalseGoalClaim = !(hasGoalLanguage(hookText) && !(highlightType === "goal" && hasConfirmedGoalOutcome(goalOutcome)));
  return {
    hookStart: Number(hookStart.toFixed(2)),
    hookEnd: Number(hookEnd.toFixed(2)),
    hookType,
    hookText,
    evidenceCodes,
    relatedGoalNumber: Number.isFinite(Number(raw.relatedGoalNumber))
      ? Math.max(1, Math.round(Number(raw.relatedGoalNumber)))
      : sourceWindow && sourceWindow.relatedGoalNumber,
    noFalseGoalClaim,
    coldOpen: true,
    timelinePlacement: "first_two_seconds",
    sourceStart: raw.sourceStart == null && sourceWindow ? sourceWindow.sourceStart : finiteTimestamp(raw.sourceStart, 0, Number.MAX_SAFE_INTEGER, sourceWindow && sourceWindow.sourceStart),
    sourceEnd: raw.sourceEnd == null && sourceWindow ? sourceWindow.sourceEnd : finiteTimestamp(raw.sourceEnd, 0, Number.MAX_SAFE_INTEGER, sourceWindow && sourceWindow.sourceEnd),
  };
}

function normalizeAudioPolicy(policy = {}, metadata = {}) {
  const raw = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  if (raw.copyrightEvasion || raw.bypassDetection || raw.avoidCopyrightDetection) {
    throw new AppError("VALIDATION_ERROR", "Audio policy cannot include copyright evasion behavior.", 400);
  }
  const audioMode = assertAllowedToken(raw.audioMode || (metadata.hasAudio === false ? "muted" : "source"), AUDIO_MODES, "Audio mode is invalid.", 40);
  const licenseFallback = audioMode === "muted"
    ? "muted_safe"
    : audioMode === "licensed_local"
      ? "licensed_local"
      : audioMode === "platform_native_placeholder"
        ? "platform_native_required"
        : "source_rights_confirmed";
  const licenseStatus = assertAllowedToken(raw.licenseStatus || licenseFallback, AUDIO_LICENSE_STATUSES, "Audio license status is invalid.", 48);
  const source = sanitizeText(raw.source || (audioMode === "source" ? "source_audio" : audioMode), 80).toLowerCase();
  if (/trending|copyrighted|spotify|apple_music|youtube_music|commercial_track/.test(source)) {
    throw new AppError("VALIDATION_ERROR", "Audio policy cannot bundle copyrighted or trending tracks by default.", 400);
  }
  if (audioMode === "licensed_local" && !/^licensed_local/.test(source)) {
    throw new AppError("VALIDATION_ERROR", "Licensed local audio needs reviewed local license metadata.", 400);
  }
  return {
    audioMode,
    licenseStatus,
    source,
    safeForExport: audioMode !== "licensed_local" || licenseStatus === "licensed_local",
    operatorActionRequired: audioMode === "platform_native_placeholder" || licenseStatus === "operator_review_required",
    normalization: "safe_loudness",
    externalAudioBundled: audioMode === "licensed_local",
    copyrightedTrackBundled: false,
    platformNativeInstructions: audioMode === "platform_native_placeholder"
      ? sanitizeText(raw.platformNativeInstructions || "Add platform-native licensed/trending audio during upload.", 140)
      : null,
  };
}

function normalizeCreativeStyleTransforms(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (raw.mirror === true || raw.copyrightEvasion === true || raw.bypassDetection === true || raw.hideWatermark === true || raw.obscureScorebug === true) {
    throw new AppError("VALIDATION_ERROR", "Creative styling cannot be used for copyright evasion.", 400);
  }
  return {
    colorGrade: sanitizeText(raw.colorGrade || "sports_pop_safe", 40),
    mildZoom: Number(clamp(raw.mildZoom ?? raw.zoom ?? 1.02, 1, 1.05).toFixed(2)),
    sharpen: Number(clamp(raw.sharpen ?? 0.12, 0, 0.3).toFixed(2)),
    contrastBoost: Number(clamp(raw.contrastBoost ?? 0.08, 0, 0.18).toFixed(2)),
    mirror: false,
    copyrightEvasion: false,
    watermarkObscuring: false,
    purpose: "creative_polish_readability_and_framing",
  };
}

function validateEditPlan(plan, metadata = {}) {
  if (!plan || typeof plan !== "object") {
    throw new AppError("VALIDATION_ERROR", "Edit plan is missing.", 400);
  }
  const segments = normalizeSegments(plan.segments, metadata);
  const hasSegments = segments.length > 0;
  const mode = normalizedEditPlanMode(plan.mode, hasSegments);
  if (mode === "multi_moment_compilation" && !hasSegments) {
    throw new AppError("VALIDATION_ERROR", "Multi-moment edit plan needs segments.", 400);
  }
  const totalDuration = hasSegments
    ? Number(segments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(2))
    : null;
  const sourceStart = hasSegments
    ? Number(segments[0].sourceStart)
    : Number(plan.sourceStart);
  const sourceEnd = hasSegments
    ? Number(Math.max(...segments.map((segment) => segment.sourceEnd)).toFixed(2))
    : Number(plan.sourceEnd);
  const mediaDuration = Number(metadata.durationSeconds || sourceEnd);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd <= sourceStart) {
    throw new AppError("VALIDATION_ERROR", "Edit plan source range is invalid.", 400);
  }
  if (!hasSegments && sourceEnd - sourceStart > MULTI_MOMENT_LIMITS.maxSegmentDuration) {
    throw new AppError("VALIDATION_ERROR", "MVP render window cannot exceed 64 seconds.", 400);
  }
  if (!hasSegments && sourceEnd > mediaDuration + 0.25) {
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
  if (plan.stylePreset && !isKnownStylePreset(plan.stylePreset)) {
    throw new AppError("VALIDATION_ERROR", "Unsupported edit style preset.", 400);
  }
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean) : [];
  const goalOutcome = normalizeGoalOutcome(plan.goalOutcome, { highlightType, reasonCodes });
  const goalEvidence = highlightType === "goal" && reasonCodes.includes("goal") && hasConfirmedGoalOutcome(goalOutcome);
  const renderDuration = hasSegments ? totalDuration : sourceEnd - sourceStart;
  const captions = normalizeCaptions(plan.captions, 0, renderDuration, { highlightType, reasonCodes, goalEvidence, goalOutcome });
  if (captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Edit plan needs at least one caption.", 400);
  }
  const hook = sanitizeText(plan.hook || hookForHighlightType(highlightType, stylePreset), 96);
  assertNoMisleadingGoalLanguage({ hook, captions, highlightType, reasonCodes, goalOutcome });
  if (captions.some((caption) => caption.captionRiskFlags.includes("goal_language_without_evidence"))) {
    throw new AppError("VALIDATION_ERROR", "Caption uses goal language without goal evidence.", 400);
  }
  const hasExplicitCropPlan = plan.cropPlan && typeof plan.cropPlan === "object";
  const cropPlan = validateCropPlan(
    hasExplicitCropPlan
      ? { ...plan.cropPlan, targetAspectRatio: plan.cropPlan.targetAspectRatio || aspectRatio }
      : defaultCropPlan(metadata, aspectRatio),
    metadata,
  );
  const derivedCropStrategy = cropStrategyFromPlan(cropPlan, metadata);
  let cropStrategy = plan.cropStrategy && typeof plan.cropStrategy === "object"
    ? {
        type: sanitizeText(plan.cropStrategy.type || derivedCropStrategy.type, 40),
        x: clamp(plan.cropStrategy.x, 0, Number(metadata.width || 1920)),
        y: clamp(plan.cropStrategy.y, 0, Number(metadata.height || 1080)),
        width: clamp(plan.cropStrategy.width, 1, Number(metadata.width || plan.cropStrategy.width || 1920)),
        height: clamp(plan.cropStrategy.height, 1, Number(metadata.height || plan.cropStrategy.height || 1080)),
        zoom: clamp(plan.cropStrategy.zoom || derivedCropStrategy.zoom, 1, 1.08),
        background: sanitizeText(plan.cropStrategy.background || derivedCropStrategy.background, 40),
        preserveFullFrame: Boolean(plan.cropStrategy.preserveFullFrame),
        maxCropPercent: clamp(plan.cropStrategy.maxCropPercent || derivedCropStrategy.maxCropPercent, 0, 0.35),
      }
    : derivedCropStrategy;
  if (cropPlan.mode === "soft_follow" && cropStrategy.preserveFullFrame) {
    throw new AppError("VALIDATION_ERROR", "Soft-follow crop plan cannot preserve the full frame.", 400);
  }
  if (cropPlan.mode !== "soft_follow" && cropStrategy.preserveFullFrame !== true) {
    if (hasExplicitCropPlan) {
      throw new AppError("VALIDATION_ERROR", "Low-confidence crop plan must preserve the full frame.", 400);
    }
    cropStrategy = derivedCropStrategy;
  }
  if (cropStrategy.x + cropStrategy.width > Number(metadata.width || cropStrategy.width) + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Crop strategy exceeds media width.", 400);
  }
  if (cropStrategy.y + cropStrategy.height > Number(metadata.height || cropStrategy.height) + 0.25) {
    throw new AppError("VALIDATION_ERROR", "Crop strategy exceeds media height.", 400);
  }
  const captionEmphasis = Array.isArray(plan.captionEmphasis)
    ? normalizeCaptionEmphasisItems(plan.captionEmphasis, renderDuration)
    : createCaptionEmphasis(captions, highlightType);
  const rawAnimationCues = Array.isArray(plan.animationCues) ? plan.animationCues.slice(0, 10) : null;
  const unsupportedAnimationCues = [];
  let animationCues = rawAnimationCues
    ? rawAnimationCues.map((cue) => normalizeAnimationCue(cue, renderDuration, unsupportedAnimationCues)).filter(Boolean)
    : createAnimationCues(renderDuration, reasonCodes);
  if (!animationCues.length) animationCues = createAnimationCues(renderDuration, reasonCodes);
  const hookPlan = normalizeHookPlan(plan, {
    renderDuration,
    highlightType,
    reasonCodes,
    goalOutcome,
    segments,
  });
  if (!hookPlan.noFalseGoalClaim) {
    throw new AppError("VALIDATION_ERROR", "Hook uses goal language without confirmed goal evidence.", 400);
  }
  const audioPolicy = normalizeAudioPolicy(plan.audioPolicy, metadata);
  const creativeStyleTransforms = normalizeCreativeStyleTransforms(plan.creativeStyleTransforms);
  return {
    ...plan,
    mode,
    sourceStart,
    sourceEnd,
    segments,
    totalDuration: hasSegments ? totalDuration : Number(renderDuration.toFixed(2)),
    aspectRatio,
    hook,
    highlightType,
    goalOutcome,
    confidence: clamp(plan.confidence, 0, 1),
    framingMode,
    framingReason,
    actionFocusConfidence,
    visualEvidenceSummary,
    cropPlan,
    cropStrategy,
    stylePreset,
    hookPlan,
    audioPolicy,
    creativeStyleTransforms,
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
  ANIMATION_CUE_LIMITS,
  ASPECT_RATIOS,
  AUDIO_LICENSE_STATUSES,
  AUDIO_MODES,
  CAPTION_EMPHASIS,
  CAPTION_EMPHASIS_STYLES,
  CAPTION_HIGHLIGHT_COLORS,
  CAPTION_LAYOUTS,
  CAPTION_RISK_FLAGS,
  CAPTION_ROLES,
  CAPTION_SAFE_AREAS,
  CAPTION_STYLE_PRESETS,
  CAPTION_CONTRAST_MODES,
  EFFECT_TYPES,
  FRAMING_MODES,
  GOAL_DECISION_EVIDENCE_CODES,
  GOAL_EVENT_TYPES,
  GOAL_OUTCOMES,
  GOAL_OUTCOME_BADGES,
  HOOK_TYPES,
  OFFSIDE_STATUSES,
  HIGHLIGHT_TYPES,
  HOOKS,
  RENDER_STYLE_PRESETS,
  STYLE_PRESETS,
  createFallbackCaptions,
  createAnimationCues,
  createCaptionEmphasis,
  createCropStrategy,
  defaultCropPlan,
  createEditPlan,
  captionIntentForHighlightType,
  framingModeForMetadata,
  hasGoalLanguage,
  hasDecisionSafeGoalLanguage,
  hookForHighlightType,
  isKnownStylePreset,
  normalizeCaptions,
  normalizeGoalOutcome,
  normalizeStylePreset,
  normalizeAudioPolicy,
  normalizeCreativeStyleTransforms,
  validateEditPlan,
};
