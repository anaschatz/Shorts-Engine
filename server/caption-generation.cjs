const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const {
  CAPTION_EMPHASIS,
  CAPTION_LAYOUTS,
  CAPTION_RISK_FLAGS,
  CAPTION_ROLES,
  HIGHLIGHT_TYPES,
  captionIntentForHighlightType,
  hasGoalLanguage,
  normalizeCaptions,
} = require("./edit-plan.cjs");

const DEFAULT_CAPTION_COUNT = 5;
const REACTION_REASONS = Object.freeze([
  "audio_energy_spike",
  "audio_peak",
  "commentator_peak",
  "crowd_reaction",
  "crowd_spike",
  "visual_crowd_reaction",
]);
const ACTION_REASONS = Object.freeze([
  "big_chance",
  "card_moment",
  "counter_attack",
  "foul",
  "goal",
  "hard_foul",
  "near_miss",
  "save",
  "shot_on_target",
  "skill_move",
  "visual_fast_break",
  "visual_foul_like_contact",
  "visual_keeper_action",
  "visual_ball_in_net",
  "visual_celebration_after_shot",
  "visual_ball_toward_goal",
  "visual_shot_contact",
  "visual_save_like_motion",
  "visual_shot_like_motion",
]);
const WEAK_REASONS = Object.freeze([
  "scene_change_cluster",
  "visual_ball_visible",
  "visual_goal_area",
  "visual_scoreboard_context",
  "visual_unknown_action",
]);
const REPLAY_REASONS = Object.freeze([
  "replay_or_reaction",
  "replay_worthy_moment",
  "visual_replay_indicator",
]);
const CONTEXT_HIGHLIGHT_TYPES = Object.freeze([
  "audio_energy_spike",
  "commentator_peak",
  "crowd_reaction",
  "replay_or_reaction",
  "replay_worthy_moment",
]);
const STRONG_ACTION_TYPES = Object.freeze([
  "big_chance",
  "card_moment",
  "counter_attack",
  "foul",
  "hard_foul",
  "near_miss",
  "save",
  "shot_on_target",
  "skill_move",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function normalizeToken(value, fallback, allowed = null, maxLength = 80) {
  const safe = sanitizeText(value || fallback, maxLength).toLowerCase();
  if (allowed && !allowed.includes(safe)) return fallback;
  return safe || fallback;
}

function languageKey(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  return safe === "el" || safe.includes("greek") || safe.includes("ελλην") ? "el" : "en";
}

function safeReasons(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((reason) => sanitizeText(reason, 60)).filter(Boolean))].slice(0, 12);
}

function hasAnyReason(reasonCodes, expected) {
  const reasonSet = new Set(reasonCodes);
  return expected.some((reason) => reasonSet.has(reason));
}

function evidenceKind({ highlightType, reasonCodes = [] } = {}) {
  const normalizedReasons = safeReasons(reasonCodes);
  const actionLed = STRONG_ACTION_TYPES.includes(highlightType) || hasAnyReason(normalizedReasons, ACTION_REASONS);
  const hasReactionContext = hasAnyReason(normalizedReasons, REACTION_REASONS);
  const hasReplayContext = REPLAY_REASONS.includes(highlightType) || hasAnyReason(normalizedReasons, REPLAY_REASONS);
  const contextLed = CONTEXT_HIGHLIGHT_TYPES.includes(highlightType) && (hasReactionContext || hasReplayContext);
  const hasWeakEvidence = hasAnyReason(normalizedReasons, WEAK_REASONS);
  return {
    actionLed,
    hasReactionContext,
    hasReplayContext,
    reactionOnly: hasReactionContext && !actionLed && !hasReplayContext,
    weakOrUnknown: ["unknown_action", "generic_highlight"].includes(highlightType) || (hasWeakEvidence && !actionLed && !contextLed),
  };
}

function roleForIndex(index, count) {
  if (index === 0) return "opening_hook";
  if (index === 1) return "context";
  if (index === count - 1) return "closing_punch";
  if (index === count - 2) return "reaction";
  return "action_callout";
}

function emphasisForRole(role) {
  if (role === "opening_hook") return "shout";
  if (role === "context") return "detail";
  if (role === "reaction") return "strong";
  return "strong";
}

function layoutForRole(role) {
  if (role === "opening_hook") return "center";
  if (role === "context") return "top";
  return "bottom";
}

function timingForRole(role) {
  return {
    entranceMs: role === "opening_hook" ? 180 : role === "context" ? 130 : 150,
    exitMs: 120,
  };
}

function styleForRole(role, emphasis, layout) {
  return {
    fontScale: role === "opening_hook" ? 1.12 : role === "context" ? 0.78 : 1,
    stroke: role === "context" ? 3 : 5,
    shadow: 2,
    highlightColor: emphasis === "detail" ? "cyan" : emphasis === "warning" ? "red" : "gold",
    uppercase: role !== "context",
    maxLines: layout === "top" ? 1 : 2,
  };
}

function captionTiming(duration, index, count) {
  const safeDuration = Math.max(0.4, Number(duration) || 0.4);
  const segment = Math.max(1.1, safeDuration / count);
  const start = Number(Math.min(safeDuration - 0.4, index * segment).toFixed(2));
  const end = Number(Math.min(safeDuration, start + Math.max(1.2, segment - 0.18)).toFixed(2));
  return { start, end };
}

function captionEvidenceFor({ highlightType, reasonCodes, goalEvidence, role }) {
  const reasons = safeReasons(reasonCodes);
  return {
    alignedHighlightType: highlightType,
    highlightType,
    reasonCodes: reasons,
    visualReasonCodes: reasons.filter((reason) => /^visual_/.test(reason)),
    goalEvidence: Boolean(goalEvidence),
    role,
  };
}

function captionRiskFlagsFor({ text, highlightType, goalEvidence, isReactionOnly }) {
  const flags = [];
  if (highlightType !== "goal" && hasGoalLanguage(text) && !goalEvidence) {
    flags.push("goal_language_without_evidence");
  }
  if (isReactionOnly) flags.push("crowd_context_only");
  return [...new Set(flags)];
}

function neutralCopy(language, useTitleContext, titleContext) {
  if (languageKey(language) === "el") {
    return {
      hook: "ΔΕΣ ΠΩΣ ΧΤΙΖΕΤΑΙ Η ΦΑΣΗ",
      context: useTitleContext && titleContext ? titleContext : "Η πίεση ανεβαίνει χωρίς καθαρή τελική φάση",
      main: "Η φάση ακόμη ψάχνει τη σωστή στιγμή",
      reaction: "Η ένταση μένει στο πλαίσιο της πίεσης",
      closing: "Ξαναδές τη λεπτομέρεια",
    };
  }
  return {
    hook: "WATCH THE PLAY DEVELOP",
    context: useTitleContext && titleContext ? titleContext : "Pressure builds without a clear final action",
    main: "The phase is still looking for the key touch",
    reaction: "The reaction stays in pressure context",
    closing: "Replay the detail",
  };
}

function supportiveReactionLine(highlightType, language) {
  const greek = languageKey(language) === "el";
  const lines = greek
    ? {
        big_chance: "Η κερκίδα αντιδρά μετά τη μεγάλη φάση",
        shot_on_target: "Η αντίδραση έρχεται μετά την πίεση",
        near_miss: "Το γήπεδο ένιωσε πόσο κοντά πήγε",
        save: "Η κερκίδα αντιδρά στην επέμβαση",
        foul: "Η αντίδραση ακολουθεί την επαφή",
        hard_foul: "Το γήπεδο αντιδρά στο δυνατό μαρκάρισμα",
        counter_attack: "Η ένταση ανεβαίνει με την αντεπίθεση",
      }
    : {
        big_chance: "The crowd reacts after the big chance",
        shot_on_target: "The reaction follows the pressure",
        near_miss: "The stadium felt how close that was",
        save: "The crowd reacts to the stop",
        foul: "The reaction follows the contact",
        hard_foul: "The stadium reacts to the heavy challenge",
        counter_attack: "The noise rises with the runner on the break",
      };
  return lines[highlightType] || (greek ? "Η αντίδραση έρχεται μετά τη φάση" : "The reaction follows the play");
}

function safeNoGoalLine(highlightType, role, language) {
  const greek = languageKey(language) === "el";
  const lines = greek
    ? {
        big_chance: "Η μεγάλη φάση ανοίγει",
        shot_on_target: "Το σουτ ανεβάζει την πίεση",
        near_miss: "Παραλίγο η μεγάλη στιγμή",
        save: "Ο τερματοφύλακας αντιδρά στην ώρα του",
        foul: "Η επαφή αλλάζει τον ρυθμό",
        hard_foul: "Το μαρκάρισμα φέρνει μεγάλη αντίδραση",
        counter_attack: "Ο χώρος ανοίγει στην αντεπίθεση",
        crowd_reaction: "Η κερκίδα αντιδρά στη φάση",
      }
    : {
        big_chance: "The big chance opens",
        shot_on_target: "The shot raises the pressure",
        near_miss: "So close to the big moment",
        save: "The keeper reacts in time",
        foul: "The contact changes the tempo",
        hard_foul: "The challenge brings a big reaction",
        counter_attack: "Space opens on the break",
        crowd_reaction: "The crowd reacts to the play",
      };
  if (role === "closing_punch") return greek ? "Ξαναδές το timing" : "Replay the timing";
  return lines[highlightType] || (greek ? "Η φάση χτίζεται με πίεση" : "The play builds with pressure");
}

function specificActionCopy(highlightType, language) {
  const greek = languageKey(language) === "el";
  const copy = greek
    ? {
        big_chance: ["Η ΜΕΓΑΛΗ ΦΑΣΗ ΑΝΟΙΓΕΙ", "Ο κίνδυνος χτίζεται γρήγορα", "Παραλίγο να τους τιμωρήσει", /φάση|κίνδυνος|πίεση|παραλίγο/i],
        shot_on_target: ["ΤΟ ΣΟΥΤ ΑΝΕΒΑΖΕΙ ΤΗΝ ΠΙΕΣΗ", "Η γωνία ανοίγει γρήγορα", "Η προσπάθεια φτάνει στην εστία", /σουτ|πίεση|προσπάθεια|γωνία/i],
        near_miss: ["ΠΑΡΑΛΙΓΟ Η ΜΕΓΑΛΗ ΣΤΙΓΜΗ", "Η γωνία ανοίγει για λίγο", "Η φάση περνάει κοντά", /παραλίγο|γωνία|κοντά|φάση/i],
        save: ["ΤΕΡΑΣΤΙΑ ΑΠΟΚΡΟΥΣΗ", "Η φάση δείχνει ανοιχτή", "Ο τερματοφύλακας αντιδρά στην ώρα του", /απόκρουση|τερματοφύλακας|επέμβαση/i],
        foul: ["Η ΕΠΑΦΗ ΑΛΛΑΖΕΙ ΤΟΝ ΡΥΘΜΟ", "Το μαρκάρισμα κόβει τη ροή", "Η ένταση ανεβαίνει μετά την επαφή", /επαφή|μαρκάρισμα|ρυθμό/i],
        hard_foul: ["ΒΑΡΙΑ ΕΠΑΦΗ", "Το δυνατό μαρκάρισμα κόβει τη ροή", "Η ένταση ανεβαίνει μετά την επαφή", /επαφή|μαρκάρισμα|δυνατό|βαριά/i],
        counter_attack: ["Η ΑΝΤΕΠΙΘΕΣΗ ΞΕΚΙΝΑ", "Ο χώρος ανοίγει πίσω από τη γραμμή", "Το τρέξιμο αλλάζει τη φάση", /αντεπίθεση|χώρος|τρέξιμο/i],
      }
    : {
        big_chance: ["THE BIG CHANCE OPENS", "The danger builds quickly", "Almost punished them", /chance|danger|pressure|almost|window|run/i],
        shot_on_target: ["THE SHOT RAISES THE PRESSURE", "The angle opens fast", "The effort reaches the target", /shot|pressure|effort|angle|target/i],
        near_miss: ["SO CLOSE TO THE MOMENT", "The angle opens for a second", "The chance slides just past", /close|angle|chance|almost|past/i],
        save: ["HUGE SAVE", "The chance looks open", "The keeper reacts in time", /save|keeper|stop|reacts|denied/i],
        foul: ["THE CONTACT CHANGES THE TEMPO", "The challenge breaks the rhythm", "The reaction follows the contact", /contact|challenge|tempo|rhythm/i],
        hard_foul: ["HEAVY CONTACT", "The challenge breaks the rhythm", "The reaction follows the contact", /contact|challenge|heavy|tempo/i],
        counter_attack: ["THE BREAK IS ON", "Space opens behind the line", "The runner changes the phase", /break|counter|space|run|runner|transition/i],
      };
  const value = copy[highlightType];
  if (!value) return null;
  return {
    hook: value[0],
    context: value[1],
    main: value[2],
    matcher: value[3],
  };
}

function ensureActionSpecificLines(lines, highlightType, language, kind) {
  const specific = specificActionCopy(highlightType, language);
  if (!specific || !kind.actionLed || kind.reactionOnly) return lines;
  const primaryText = [lines.hook, lines.context, lines.main].join(" ");
  if (specific.matcher.test(primaryText)) return lines;
  return {
    ...lines,
    hook: specific.hook,
    context: specific.context,
    main: specific.main,
  };
}

function safeNoGoalText(text, highlightType, role, language, goalEvidence) {
  const safeText = sanitizeText(text, 96);
  if (goalEvidence || highlightType === "goal" || !hasGoalLanguage(safeText)) return safeText;
  return safeNoGoalLine(highlightType, role, language);
}

function linesForInput(input = {}) {
  const language = input.language || "en";
  const highlightType = normalizeToken(input.highlightType, "generic_highlight", HIGHLIGHT_TYPES, 40);
  const reasonCodes = safeReasons(input.reasonCodes);
  const kind = evidenceKind({ highlightType, reasonCodes });
  const base = input.copy && typeof input.copy === "object" ? input.copy : {};
  const goalEvidence = Boolean(input.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal")));
  if (kind.weakOrUnknown && !goalEvidence) {
    return neutralCopy(language, Boolean(input.useTitleContext), sanitizeText(input.titleContext, 96));
  }
  const lines = {
    hook: base.hook || safeNoGoalLine(highlightType, "opening_hook", language),
    context: input.useTitleContext && input.titleContext ? input.titleContext : base.context,
    main: base.main || safeNoGoalLine(highlightType, "action_callout", language),
    reaction: base.reaction || supportiveReactionLine(highlightType, language),
    closing: base.closing || safeNoGoalLine(highlightType, "closing_punch", language),
  };
  if (kind.actionLed && kind.hasReactionContext && !kind.reactionOnly) {
    lines.reaction = supportiveReactionLine(highlightType, language);
  }
  if (kind.reactionOnly) {
    lines.main = base.main || supportiveReactionLine("crowd_reaction", language);
  }
  return ensureActionSpecificLines(lines, highlightType, language, kind);
}

function buildCaption(line, index, count, input) {
  const highlightType = normalizeToken(input.highlightType, "generic_highlight", HIGHLIGHT_TYPES, 40);
  const reasonCodes = safeReasons(input.reasonCodes);
  const goalEvidence = Boolean(input.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal")));
  const kind = evidenceKind({ highlightType, reasonCodes });
  const role = roleForIndex(index, count);
  const emphasis = emphasisForRole(role);
  const layout = layoutForRole(role);
  const timing = captionTiming(input.duration, index, count);
  const text = safeNoGoalText(line, highlightType, role, input.language, goalEvidence);
  return {
    ...timing,
    text,
    role,
    emphasis,
    layout,
    timing: timingForRole(role),
    style: styleForRole(role, emphasis, layout),
    captionIntent: captionIntentForHighlightType(highlightType, role),
    captionSource: `caption_generation:deterministic:${highlightType}:${role}`,
    captionEvidence: captionEvidenceFor({ highlightType, reasonCodes, goalEvidence, role }),
    captionRiskFlags: captionRiskFlagsFor({
      text,
      highlightType,
      goalEvidence,
      isReactionOnly: kind.reactionOnly,
    }),
  };
}

function generateEvidenceAwareCaptions(input = {}) {
  const highlightType = normalizeToken(input.highlightType, "generic_highlight", HIGHLIGHT_TYPES, 40);
  const reasonCodes = safeReasons(input.reasonCodes);
  const goalEvidence = Boolean(input.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal")));
  const lineMap = linesForInput({ ...input, highlightType, reasonCodes, goalEvidence });
  const lines = [lineMap.hook, lineMap.context, lineMap.main, lineMap.reaction, lineMap.closing]
    .map((line) => sanitizeText(line, 96))
    .filter(Boolean)
    .slice(0, DEFAULT_CAPTION_COUNT);
  const captions = lines.map((line, index) => buildCaption(line, index, lines.length, {
    ...input,
    highlightType,
    reasonCodes,
    goalEvidence,
  }));
  return validateCaptionGenerationResult({
    providerMode: "deterministic",
    fallbackUsed: false,
    warnings: [],
    captions,
  }, { ...input, highlightType, reasonCodes, goalEvidence });
}

function assertCaptionMetadata(caption, index) {
  if (!caption || typeof caption !== "object" || Array.isArray(caption)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const role = normalizeToken(caption.role, "", CAPTION_ROLES, 40);
  const emphasis = normalizeToken(caption.emphasis, "", CAPTION_EMPHASIS, 40);
  const layout = normalizeToken(caption.layout, "", CAPTION_LAYOUTS, 40);
  if (!sanitizeText(caption.text, 96) || !role || !emphasis || !layout) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (!sanitizeText(caption.captionIntent, 80) || !sanitizeText(caption.captionSource, 96)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (!caption.captionEvidence || typeof caption.captionEvidence !== "object" || Array.isArray(caption.captionEvidence)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (!Array.isArray(caption.captionRiskFlags)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const hasUnknownFlag = caption.captionRiskFlags
    .map((flag) => sanitizeText(flag, 60).toLowerCase())
    .some((flag) => !CAPTION_RISK_FLAGS.includes(flag));
  if (hasUnknownFlag) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return index;
}

function validateCaptionGenerationResult(result, input = {}, options = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const highlightType = normalizeToken(input.highlightType, "generic_highlight", HIGHLIGHT_TYPES, 40);
  const reasonCodes = safeReasons(input.reasonCodes);
  const goalEvidence = Boolean(input.goalEvidence || (highlightType === "goal" && reasonCodes.includes("goal")));
  const duration = Math.max(0.4, Number(input.duration) || 0.4);
  const captions = Array.isArray(result.captions) ? result.captions : [];
  if (captions.length < 3 || captions.length > 6) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  captions.forEach(assertCaptionMetadata);
  const normalized = normalizeCaptions(captions, 0, duration, { highlightType, reasonCodes, goalEvidence });
  if (!normalized.length || normalized.some((caption) => caption.captionEvidence.alignedHighlightType !== highlightType)) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  if (normalized.some((caption) => caption.captionRiskFlags.includes("goal_language_without_evidence"))) {
    throw new AppError("CAPTION_PROVIDER_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    providerMode: sanitizeText(result.providerMode || options.providerMode || "deterministic", 40),
    fallbackUsed: Boolean(result.fallbackUsed),
    warnings: (Array.isArray(result.warnings) ? result.warnings : []).map((warning) => sanitizeText(warning, 80)).filter(Boolean).slice(0, 6),
    captions: normalized,
  };
}

function captionGenerationHealth() {
  return {
    providerMode: "deterministic",
    networkCalls: false,
    apiKeyRequired: false,
    fallbackAvailable: true,
  };
}

module.exports = {
  captionGenerationHealth,
  evidenceKind,
  generateEvidenceAwareCaptions,
  validateCaptionGenerationResult,
};
