const { sanitizeText } = require("./media.cjs");
const {
  createCaptionEmphasis,
  createCropStrategy,
  hasGoalLanguage,
  hookForHighlightType,
} = require("./edit-plan.cjs");

const STYLE_TARGETS = Object.freeze(["auto", "vertical_9_16", "square_1_1"]);
const EDIT_INTENSITIES = Object.freeze(["clean", "balanced", "punchy"]);

const MOMENT_COPY = Object.freeze({
  en: {
    goal: {
      storyType: "goal_story",
      hook: "THE FINISH CHANGES EVERYTHING",
      context: "Watch the move before it happens",
      main: "That touch makes the moment",
      reaction: "The reaction tells you enough",
      closing: "Run the build-up back",
    },
    shot_on_target: {
      storyType: "chance_story",
      hook: "THE CHANCE OPENS FAST",
      context: "The pressure arrives in one pass",
      main: "Almost punished them",
      reaction: "The crowd felt that",
      closing: "Replay the timing",
    },
    near_miss: {
      storyType: "chance_story",
      hook: "SO CLOSE TO THE MOMENT",
      context: "The space appears for a second",
      main: "Almost punished them",
      reaction: "The stadium knew it",
      closing: "Watch the angle again",
    },
    big_chance: {
      storyType: "chance_story",
      hook: "THE BIG CHANCE OPENS",
      context: "The danger builds quickly",
      main: "Almost punished them",
      reaction: "The crowd felt that",
      closing: "Replay the timing",
    },
    save: {
      storyType: "save_story",
      hook: "HUGE SAVE",
      context: "The chance looks open",
      main: "The keeper reacts in time",
      reaction: "That stop keeps it alive",
      closing: "Watch the reaction",
    },
    foul: {
      storyType: "foul_story",
      hook: "THAT CHALLENGE CHANGED THE TEMPO",
      context: "The contact shifts the whole play",
      main: "That was heavy",
      reaction: "Everyone reacts",
      closing: "Replay the challenge",
    },
    hard_foul: {
      storyType: "foul_story",
      hook: "HEAVY CONTACT",
      context: "The tempo snaps in one challenge",
      main: "That was heavy",
      reaction: "The reaction says enough",
      closing: "Replay the challenge",
    },
    card_moment: {
      storyType: "decision_story",
      hook: "THE DECISION MOMENT",
      context: "The referee has to read it",
      main: "Everyone waits for the call",
      reaction: "The match gets heated",
      closing: "Watch the aftermath",
    },
    counter_attack: {
      storyType: "transition_story",
      hook: "THE BREAK IS ON",
      context: "Space opens behind the line",
      main: "The counter opens fast",
      reaction: "One run changes the phase",
      closing: "Watch the runner",
    },
    skill_move: {
      storyType: "skill_story",
      hook: "TOO QUICK",
      context: "One touch changes the angle",
      main: "The defender has to turn",
      reaction: "That move opens the play",
      closing: "Replay the touch",
    },
    crowd_reaction: {
      storyType: "reaction_story",
      hook: "THE CROWD FELT THAT",
      context: "The stadium reacts before the replay",
      main: "That reaction says enough",
      reaction: "The energy jumps",
      closing: "Watch what caused it",
    },
    commentator_peak: {
      storyType: "reaction_story",
      hook: "THE CALL TELLS THE STORY",
      context: "The commentary catches the shift",
      main: "The pressure jumps",
      reaction: "You can hear the moment",
      closing: "Watch the build-up",
    },
    replay_or_reaction: {
      storyType: "replay_story",
      hook: "LOOK AT THE TIMING",
      context: "The detail is easy to miss",
      main: "Watch the angle",
      reaction: "The replay explains it",
      closing: "Run it back once",
    },
    replay_worthy_moment: {
      storyType: "replay_story",
      hook: "LOOK AT THE TIMING",
      context: "The detail is easy to miss",
      main: "Watch the angle",
      reaction: "The replay explains it",
      closing: "Run it back once",
    },
    audio_energy_spike: {
      storyType: "reaction_story",
      hook: "THE STADIUM REACTS",
      context: "The noise rises with the play",
      main: "The crowd felt that",
      reaction: "The energy jumps",
      closing: "Watch what caused it",
    },
    unknown_action: {
      storyType: "pressure_story",
      hook: "WATCH THE PLAY DEVELOP",
      context: "The pressure starts to build",
      main: "The phase opens up",
      reaction: "The next touch matters",
      closing: "Replay the detail",
    },
    generic_highlight: {
      storyType: "pressure_story",
      hook: "WATCH THE PLAY DEVELOP",
      context: "The pressure starts to build",
      main: "The phase opens up",
      reaction: "The next touch matters",
      closing: "Replay the detail",
    },
  },
  el: {
    goal: {
      storyType: "goal_story",
      hook: "Η ΦΑΣΗ ΑΛΛΑΖΕΙ ΤΟ ΜΑΤΣ",
      context: "Δες την κίνηση πριν γίνει",
      main: "Αυτό το άγγιγμα φτιάχνει τη στιγμή",
      reaction: "Η αντίδραση τα λέει όλα",
      closing: "Ξαναδές το build-up",
    },
    shot_on_target: {
      storyType: "chance_story",
      hook: "Η ΦΑΣΗ ΑΝΟΙΓΕΙ ΓΡΗΓΟΡΑ",
      context: "Η πίεση έρχεται με μία πάσα",
      main: "Παραλίγο να τους τιμωρήσει",
      reaction: "Η κερκίδα το ένιωσε",
      closing: "Δες ξανά το timing",
    },
    near_miss: {
      storyType: "chance_story",
      hook: "ΠΑΡΑΛΙΓΟ Η ΜΕΓΑΛΗ ΣΤΙΓΜΗ",
      context: "Ο χώρος ανοίγει για ένα δευτερόλεπτο",
      main: "Παραλίγο να τους τιμωρήσει",
      reaction: "Το γήπεδο το κατάλαβε",
      closing: "Δες ξανά τη γωνία",
    },
    big_chance: {
      storyType: "chance_story",
      hook: "Η ΜΕΓΑΛΗ ΦΑΣΗ ΑΝΟΙΓΕΙ",
      context: "Ο κίνδυνος χτίζεται γρήγορα",
      main: "Παραλίγο να τους τιμωρήσει",
      reaction: "Η κερκίδα το ένιωσε",
      closing: "Δες ξανά το timing",
    },
    save: {
      storyType: "save_story",
      hook: "ΤΕΡΑΣΤΙΑ ΑΠΟΚΡΟΥΣΗ",
      context: "Η φάση δείχνει ανοιχτή",
      main: "Ο keeper αντιδρά στην ώρα του",
      reaction: "Αυτή η επέμβαση το κρατάει ζωντανό",
      closing: "Δες την αντίδραση",
    },
    foul: {
      storyType: "foul_story",
      hook: "ΤΟ ΜΑΡΚΑΡΙΣΜΑ ΑΛΛΑΞΕ ΤΟΝ ΡΥΘΜΟ",
      context: "Η επαφή κόβει τη ροή της φάσης",
      main: "Αυτό ήταν βαρύ",
      reaction: "Όλοι αντιδρούν",
      closing: "Ξαναδές το challenge",
    },
    hard_foul: {
      storyType: "foul_story",
      hook: "ΒΑΡΙΑ ΕΠΑΦΗ",
      context: "Ο ρυθμός σπάει σε μία στιγμή",
      main: "Αυτό ήταν βαρύ",
      reaction: "Η αντίδραση τα λέει όλα",
      closing: "Ξαναδές το challenge",
    },
    card_moment: {
      storyType: "decision_story",
      hook: "Η ΦΑΣΗ ΤΗΣ ΑΠΟΦΑΣΗΣ",
      context: "Ο διαιτητής πρέπει να το διαβάσει",
      main: "Όλοι περιμένουν το σφύριγμα",
      reaction: "Το ματς ανάβει",
      closing: "Δες τι ακολουθεί",
    },
    counter_attack: {
      storyType: "transition_story",
      hook: "Η ΑΝΤΕΠΙΘΕΣΗ ΞΕΚΙΝΑ",
      context: "Ο χώρος ανοίγει πίσω από τη γραμμή",
      main: "Η μετάβαση γίνεται γρήγορα",
      reaction: "Μία κίνηση αλλάζει τη φάση",
      closing: "Δες τον runner",
    },
    skill_move: {
      storyType: "skill_story",
      hook: "ΠΟΛΥ ΓΡΗΓΟΡΟΣ",
      context: "Ένα άγγιγμα αλλάζει τη γωνία",
      main: "Ο αμυντικός γυρίζει αναγκαστικά",
      reaction: "Η κίνηση ανοίγει τη φάση",
      closing: "Ξαναδές το touch",
    },
    crowd_reaction: {
      storyType: "reaction_story",
      hook: "Η ΚΕΡΚΙΔΑ ΤΟ ΕΝΙΩΣΕ",
      context: "Το γήπεδο αντιδρά πριν το replay",
      main: "Αυτή η αντίδραση τα λέει όλα",
      reaction: "Η ένταση ανεβαίνει",
      closing: "Δες τι το προκάλεσε",
    },
    commentator_peak: {
      storyType: "reaction_story",
      hook: "Η ΠΕΡΙΓΡΑΦΗ ΤΑ ΛΕΕΙ ΟΛΑ",
      context: "Ο εκφωνητής πιάνει την αλλαγή",
      main: "Η πίεση ανεβαίνει",
      reaction: "Ακούς τη στιγμή",
      closing: "Δες το build-up",
    },
    replay_or_reaction: {
      storyType: "replay_story",
      hook: "ΔΕΣ ΤΟ TIMING",
      context: "Η λεπτομέρεια χάνεται εύκολα",
      main: "Δες τη γωνία",
      reaction: "Το replay το εξηγεί",
      closing: "Ξαναδές το μία φορά",
    },
    replay_worthy_moment: {
      storyType: "replay_story",
      hook: "ΔΕΣ ΤΟ TIMING",
      context: "Η λεπτομέρεια χάνεται εύκολα",
      main: "Δες τη γωνία",
      reaction: "Το replay το εξηγεί",
      closing: "Ξαναδές το μία φορά",
    },
    audio_energy_spike: {
      storyType: "reaction_story",
      hook: "ΤΟ ΓΗΠΕΔΟ ΑΝΤΙΔΡΑ",
      context: "Ο θόρυβος ανεβαίνει μαζί με τη φάση",
      main: "Η κερκίδα το ένιωσε",
      reaction: "Η ένταση ανεβαίνει",
      closing: "Δες τι το προκάλεσε",
    },
    unknown_action: {
      storyType: "pressure_story",
      hook: "ΔΕΣ ΠΩΣ ΧΤΙΖΕΤΑΙ Η ΦΑΣΗ",
      context: "Η πίεση αρχίζει να ανεβαίνει",
      main: "Η φάση ανοίγει",
      reaction: "Το επόμενο άγγιγμα μετράει",
      closing: "Ξαναδές τη λεπτομέρεια",
    },
    generic_highlight: {
      storyType: "pressure_story",
      hook: "ΔΕΣ ΠΩΣ ΧΤΙΖΕΤΑΙ Η ΦΑΣΗ",
      context: "Η πίεση αρχίζει να ανεβαίνει",
      main: "Η φάση ανοίγει",
      reaction: "Το επόμενο άγγιγμα μετράει",
      closing: "Ξαναδές τη λεπτομέρεια",
    },
  },
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function normalizeStyleTarget(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  if (safe === "vertical" || safe === "shorts" || safe === "vertical_9_16") return "vertical_9_16";
  if (safe === "square" || safe === "square_1_1") return "square_1_1";
  if (safe === "auto") return "auto";
  return "vertical_9_16";
}

function normalizeEditIntensity(value) {
  if (typeof value === "number") {
    if (value >= 76) return "punchy";
    if (value <= 34) return "clean";
    return "balanced";
  }
  const safe = sanitizeText(value, 40).toLowerCase();
  return EDIT_INTENSITIES.includes(safe) ? safe : "balanced";
}

function languageKey(value) {
  const safe = sanitizeText(value, 40).toLowerCase();
  return safe === "el" || safe.includes("ελλην") || safe.includes("greek") ? "el" : "en";
}

function resolveAspectRatio(styleTarget) {
  return normalizeStyleTarget(styleTarget) === "square_1_1" ? "1:1" : "9:16";
}

function exportForAspectRatio(aspectRatio) {
  if (aspectRatio === "1:1") return { width: 1080, height: 1080, format: "mp4" };
  return { width: 1080, height: 1920, format: "mp4" };
}

function highlightCopy(highlightType, language) {
  const catalog = MOMENT_COPY[languageKey(language)] || MOMENT_COPY.en;
  return catalog[highlightType] || catalog.generic_highlight;
}

function hasExplicitGoalEvidence(moment = {}) {
  return moment.highlightType === "goal" && Array.isArray(moment.reasonCodes) && moment.reasonCodes.includes("goal");
}

function safeHighlightType(moment = {}) {
  const type = sanitizeText(moment.highlightType || "generic_highlight", 60).toLowerCase();
  if (type === "goal" && !hasExplicitGoalEvidence(moment)) return "big_chance";
  return type || "generic_highlight";
}

function primarySubjectFromTitle(title, options = {}) {
  const safeTitle = sanitizeText(title, 120);
  if (!safeTitle || /^shortsengine short$/i.test(safeTitle)) return null;
  const beforeDash = safeTitle.split(/\s[-|:]\s/)[0].trim();
  const compact = beforeDash.length >= 3 ? beforeDash : safeTitle;
  if (options.goalEvidence !== true && hasGoalLanguage(compact)) return null;
  return sanitizeText(compact, 54) || null;
}

function contextLineForTitle(title, highlightType, language, options = {}) {
  const copy = highlightCopy(highlightType, language);
  const subject = primarySubjectFromTitle(title, { goalEvidence: options.goalEvidence });
  if (!subject) return copy.context;
  if (languageKey(language) === "el") return `Από το ματς: ${subject}`;
  return `From the match: ${subject}`;
}

function storyDurationFor({ metadata = {}, selectedMoment = {}, editIntensity }) {
  const mediaDuration = Math.max(0, Number(metadata.durationSeconds || 0));
  const momentDuration = Math.max(0, Number(selectedMoment.end || 0) - Number(selectedMoment.start || 0));
  const intensity = normalizeEditIntensity(editIntensity);
  const target = intensity === "punchy" ? 14 : intensity === "clean" ? 10 : 12;
  const desired = Math.max(8, Math.min(25, Math.max(momentDuration, target)));
  if (mediaDuration > 0) return Math.min(mediaDuration, desired);
  return desired;
}

function sourceWindowForMoment({ selectedMoment = {}, metadata = {}, editIntensity }) {
  const mediaDuration = Math.max(0, Number(metadata.durationSeconds || 0));
  const center = Number.isFinite(Number(selectedMoment.center))
    ? Number(selectedMoment.center)
    : (Number(selectedMoment.start || 0) + Number(selectedMoment.end || 0)) / 2;
  const duration = storyDurationFor({ metadata, selectedMoment, editIntensity });
  if (!mediaDuration || mediaDuration <= duration) {
    return {
      sourceStart: 0,
      sourceEnd: Number((mediaDuration || duration).toFixed(2)),
    };
  }
  const start = clamp(center - duration * 0.45, 0, Math.max(0, mediaDuration - duration));
  return {
    sourceStart: Number(start.toFixed(2)),
    sourceEnd: Number(Math.min(mediaDuration, start + duration).toFixed(2)),
  };
}

function captionTiming(duration, index, count) {
  const segment = Math.max(1.1, duration / count);
  const start = Number(Math.min(duration - 0.4, index * segment).toFixed(2));
  const end = Number(Math.min(duration, start + Math.max(1.2, segment - 0.18)).toFixed(2));
  return { start, end };
}

function captionBeats({ copy, title, highlightType, language, duration, includeTitleContext = true, goalEvidence = false }) {
  const lines = [
    copy.hook,
    includeTitleContext ? contextLineForTitle(title, highlightType, language, { goalEvidence }) : copy.context,
    copy.main,
    copy.reaction,
    copy.closing,
  ].filter(Boolean);
  return lines.map((text, index) => ({
    ...captionTiming(duration, index, lines.length),
    text: sanitizeText(text, 96),
    role: index === 0 ? "opening_hook" : index === lines.length - 1 ? "closing_punch" : "story_beat",
  })).filter((caption) => caption.end > caption.start && caption.text);
}

function animationCuesForStory({ duration, highlightType, reasonCodes = [], editIntensity }) {
  const safeDuration = Math.max(1, Number(duration) || 1);
  const intensity = normalizeEditIntensity(editIntensity);
  const cues = [
    { type: "intro_hook", start: 0, end: Math.min(1.2, safeDuration) },
    { type: "kinetic_caption", start: 0.1, end: Math.min(2.1, safeDuration) },
    { type: "subtle_camera_push", start: Math.min(1.3, safeDuration - 0.2), end: Math.min(3.2, safeDuration) },
  ];
  if (intensity !== "clean") {
    cues.push({ type: "beat_cut", start: Math.min(2.6, safeDuration - 0.2), end: Math.min(2.95, safeDuration) });
  }
  if (
    intensity === "punchy" &&
    ["big_chance", "shot_on_target", "near_miss", "save", "foul", "hard_foul", "counter_attack"].includes(highlightType)
  ) {
    cues.push({ type: "punch_zoom", start: Math.min(3.1, safeDuration - 0.2), end: Math.min(4.2, safeDuration) });
  }
  if (intensity === "punchy" && ["foul", "hard_foul", "save", "big_chance"].includes(highlightType)) {
    cues.push({ type: "impact_flash", start: Math.min(4.25, safeDuration - 0.1), end: Math.min(4.38, safeDuration) });
  }
  if (reasonCodes.includes("visual_replay_indicator") || ["replay_or_reaction", "replay_worthy_moment"].includes(highlightType)) {
    cues.push({ type: "replay_stutter", start: Math.max(0, safeDuration - 2.2), end: Math.max(0.4, safeDuration - 1.2) });
  }
  cues.push({ type: "end_replay_prompt", start: Math.max(0, safeDuration - 1.25), end: safeDuration });
  return cues
    .filter((cue) => cue.end > cue.start)
    .slice(0, intensity === "punchy" ? 7 : 5)
    .map((cue) => ({
      type: cue.type,
      start: Number(cue.start.toFixed(2)),
      end: Number(cue.end.toFixed(2)),
    }));
}

function framingIntentForStory({ visualEvidenceSummary = {}, aspectRatio, highlightType }) {
  const actionFocusConfidence = Number(clamp(visualEvidenceSummary.actionFocusConfidence, 0, 1).toFixed(2));
  return {
    mode: "wide_safe_vertical",
    aspectRatio,
    punchInAllowed: actionFocusConfidence >= 0.82 && !["crowd_reaction", "audio_energy_spike"].includes(highlightType),
    reason: actionFocusConfidence >= 0.82
      ? "wide_safe_story_with_high_confidence_action_context"
      : "wide_safe_story_preserves_ball_players",
    actionFocusConfidence,
  };
}

function createFootballStoryPlan(input = {}) {
  const selectedMoment = input.selectedMoment || (Array.isArray(input.moments) ? input.moments[0] : null) || {};
  const language = input.language || (input.transcript && input.transcript.language) || "en";
  const highlightType = safeHighlightType(selectedMoment);
  const copy = highlightCopy(highlightType, language);
  const goalEvidence = hasExplicitGoalEvidence(selectedMoment);
  const styleTarget = normalizeStyleTarget(input.styleTarget);
  const editIntensity = normalizeEditIntensity(input.editIntensity);
  const aspectRatio = resolveAspectRatio(styleTarget);
  const { sourceStart, sourceEnd } = sourceWindowForMoment({
    selectedMoment,
    metadata: input.metadata || {},
    editIntensity,
  });
  const duration = Math.max(0.4, sourceEnd - sourceStart);
  const captions = captionBeats({
    copy,
    title: input.title,
    highlightType,
    language,
    duration,
    goalEvidence,
  });
  const visualEvidenceSummary = input.visualEvidenceSummary || {};
  const framingIntent = framingIntentForStory({ visualEvidenceSummary, aspectRatio, highlightType });
  const reasonCodes = Array.isArray(selectedMoment.reasonCodes) ? selectedMoment.reasonCodes : [];
  const animationCues = animationCuesForStory({
    duration,
    highlightType,
    reasonCodes,
    editIntensity,
  });
  const hook = goalEvidence || !hasGoalLanguage(copy.hook)
    ? copy.hook
    : hookForHighlightType(highlightType, "social_sports_v1");
  return {
    storyType: copy.storyType,
    primarySubject: primarySubjectFromTitle(input.title, { goalEvidence }),
    hook: sanitizeText(hook, 96),
    contextLine: sanitizeText(contextLineForTitle(input.title, highlightType, language, { goalEvidence }), 96),
    selectedMoment: {
      id: sanitizeText(selectedMoment.id || "moment", 64),
      start: Number(sourceStart.toFixed(2)),
      end: Number(sourceEnd.toFixed(2)),
      originalStart: Number(Number(selectedMoment.start || 0).toFixed(2)),
      originalEnd: Number(Number(selectedMoment.end || 0).toFixed(2)),
      highlightType,
      reasonCodes,
    },
    supportingMoments: (Array.isArray(input.moments) ? input.moments : [])
      .filter((moment) => moment && moment.id !== selectedMoment.id)
      .slice(0, 2)
      .map((moment) => ({
        id: sanitizeText(moment.id || "moment", 64),
        highlightType: safeHighlightType(moment),
        start: Number(Number(moment.start || 0).toFixed(2)),
        end: Number(Number(moment.end || 0).toFixed(2)),
      })),
    captionBeats: captions,
    framingIntent,
    animationIntent: {
      intensity: editIntensity,
      cueTypes: animationCues.map((cue) => cue.type),
      maxCueCount: editIntensity === "punchy" ? 7 : 5,
      excessiveFlashingGuard: true,
    },
    animationCues,
    aspectRatio,
    export: exportForAspectRatio(aspectRatio),
    confidence: Number(clamp(selectedMoment.confidence || 0.5, 0, 1).toFixed(2)),
    safetyNotes: [
      "Goal language is allowed only with explicit goal evidence.",
      "Wide-safe story framing preserves ball/player context before punch-in styling.",
      "Animation cues are bounded and unsupported renderer cues are safe to ignore.",
    ],
    captionEmphasis: createCaptionEmphasis(captions, highlightType),
    cropStrategy: createCropStrategy(input.metadata || {}, framingIntent.mode),
    styleTarget,
    editIntensity,
  };
}

module.exports = {
  EDIT_INTENSITIES,
  STYLE_TARGETS,
  createFootballStoryPlan,
  exportForAspectRatio,
  normalizeEditIntensity,
  normalizeStyleTarget,
  resolveAspectRatio,
};
