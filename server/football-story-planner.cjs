const { sanitizeText } = require("./media.cjs");
const {
  captionIntentForHighlightType,
  createCaptionEmphasis,
  createCropStrategy,
  hasGoalLanguage,
  hookForHighlightType,
} = require("./edit-plan.cjs");
const {
  createDeterministicCaptionProvider,
  generateCaptionsWithProvider,
} = require("./adapters/caption-provider-adapter.cjs");

const STYLE_TARGETS = Object.freeze(["auto", "vertical_9_16", "square_1_1"]);
const EDIT_INTENSITIES = Object.freeze(["clean", "balanced", "punchy"]);

const MOMENT_COPY = Object.freeze({
  en: {
    goal: {
      storyType: "goal_story",
      hook: "THE FINISH CHANGES THE MATCH",
      context: "Watch the move before it happens",
      main: "The shot writes the moment",
      reaction: "The payoff hits after the finish",
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
      hook: "ΤΟ ΤΕΛΕΙΩΜΑ ΠΟΥ ΑΛΛΑΞΕ ΤΟ ΜΑΤΣ",
      context: "Δες την κίνηση πριν γίνει",
      main: "Το σουτ γράφει τη στιγμή",
      reaction: "Η αντίδραση έρχεται μετά το τελείωμα",
      closing: "Ξαναδές το χτίσιμο",
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
      main: "Ο τερματοφύλακας αντιδρά στην ώρα του",
      reaction: "Αυτή η επέμβαση το κρατάει ζωντανό",
      closing: "Δες την αντίδραση",
    },
    foul: {
      storyType: "foul_story",
      hook: "ΤΟ ΜΑΡΚΑΡΙΣΜΑ ΑΛΛΑΞΕ ΤΟΝ ΡΥΘΜΟ",
      context: "Η επαφή κόβει τη ροή της φάσης",
      main: "Αυτό ήταν βαρύ",
      reaction: "Όλοι αντιδρούν",
      closing: "Ξαναδές το μαρκάρισμα",
    },
    hard_foul: {
      storyType: "foul_story",
      hook: "ΒΑΡΙΑ ΕΠΑΦΗ",
      context: "Ο ρυθμός σπάει σε μία στιγμή",
      main: "Αυτό ήταν βαρύ",
      reaction: "Η αντίδραση τα λέει όλα",
      closing: "Ξαναδές το μαρκάρισμα",
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
      closing: "Δες το τρέξιμο",
    },
    skill_move: {
      storyType: "skill_story",
      hook: "ΠΟΛΥ ΓΡΗΓΟΡΟΣ",
      context: "Ένα άγγιγμα αλλάζει τη γωνία",
      main: "Ο αμυντικός γυρίζει αναγκαστικά",
      reaction: "Η κίνηση ανοίγει τη φάση",
      closing: "Ξαναδές το άγγιγμα",
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
      closing: "Δες το χτίσιμο",
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

function goalEvidenceObject(moment = {}) {
  const evidence = moment && moment.evidence && moment.evidence.goalEvidence;
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : null;
}

function hasGoalSequenceEvidence(moment = {}) {
  const goalEvidence = goalEvidenceObject(moment);
  return Boolean(goalEvidence && ["strong", "medium"].includes(goalEvidence.evidenceLevel));
}

function safeHighlightType(moment = {}) {
  const type = sanitizeText(moment.highlightType || "generic_highlight", 60).toLowerCase();
  if (type === "goal" && !hasExplicitGoalEvidence(moment)) return "big_chance";
  return type || "generic_highlight";
}

function primarySubjectFromTitle(title, options = {}) {
  const safeTitle = sanitizeText(title, 120);
  if (!safeTitle || /^shortsengine short$/i.test(safeTitle)) return null;
  const parts = safeTitle
    .split(/\s*\|\s*/)
    .map((part) => sanitizeText(part, 54))
    .filter(Boolean);
  const matchupRe = /(?:\bvs\.?\b|\bv\b|\s-\s)/i;
  const genericRe = /\b(highlights?|shorts?|group|round|friendly|full match)\b|μουντιάλ|παγκόσμιο|στιγμιότυπα/i;
  const matchupPart = parts.find((part) => matchupRe.test(part));
  const descriptivePart = parts.find((part) => !genericRe.test(part));
  const fallback = safeTitle.split(/\s[-:]\s/)[0].trim();
  const compact = matchupPart || descriptivePart || (fallback.length >= 3 ? fallback : safeTitle);
  if (options.goalEvidence !== true && hasGoalLanguage(compact)) return null;
  return sanitizeText(compact, 54) || null;
}

function contextLineForTitle(title, highlightType, language, options = {}) {
  const copy = highlightCopy(highlightType, language);
  const subject = primarySubjectFromTitle(title, { goalEvidence: options.goalEvidence });
  if (!subject) return copy.context;
  if (languageKey(language) === "el") return `Ματς: ${subject}`;
  return `Match: ${subject}`;
}

const EVIDENCE_CONTEXT_HIGHLIGHT_TYPES = Object.freeze([
  "big_chance",
  "shot_on_target",
  "near_miss",
  "save",
  "foul",
  "hard_foul",
  "counter_attack",
  "replay_or_reaction",
  "replay_worthy_moment",
  "unknown_action",
  "generic_highlight",
]);

const STRONG_ACTION_REASON_CODES = Object.freeze([
  "big_chance",
  "shot_on_target",
  "near_miss",
  "save",
  "foul",
  "hard_foul",
  "counter_attack",
  "visual_shot_like_motion",
  "visual_save_like_motion",
  "visual_foul_like_contact",
  "visual_fast_break",
  "visual_replay_indicator",
  "visual_scoreboard_context",
  "visual_unknown_action",
]);

function hasAnyReason(reasonCodes, expectedReasons) {
  const reasonSet = new Set(Array.isArray(reasonCodes) ? reasonCodes : []);
  return expectedReasons.some((reason) => reasonSet.has(reason));
}

function hasVisualEvidence(visualEvidenceSummary = {}) {
  const reasonCodes = Array.isArray(visualEvidenceSummary.reasonCodes) ? visualEvidenceSummary.reasonCodes : [];
  return Number(visualEvidenceSummary.windowCount || 0) > 0 || reasonCodes.length > 0;
}

function shouldUseEvidenceContext({ highlightType, reasonCodes, visualEvidenceSummary } = {}) {
  if (EVIDENCE_CONTEXT_HIGHLIGHT_TYPES.includes(highlightType)) return true;
  if (hasAnyReason(reasonCodes, STRONG_ACTION_REASON_CODES)) return true;
  return hasVisualEvidence(visualEvidenceSummary) && ["skill_move", "card_moment"].includes(highlightType);
}

function storyDurationFor({ metadata = {}, selectedMoment = {}, editIntensity }) {
  const mediaDuration = Math.max(0, Number(metadata.durationSeconds || 0));
  const momentDuration = Math.max(0, Number(selectedMoment.end || 0) - Number(selectedMoment.start || 0));
  const intensity = normalizeEditIntensity(editIntensity);
  const goalStory = hasExplicitGoalEvidence(selectedMoment) || hasGoalSequenceEvidence(selectedMoment);
  const target = goalStory
    ? (intensity === "punchy" ? 18 : intensity === "clean" ? 14 : 16)
    : (intensity === "punchy" ? 14 : intensity === "clean" ? 10 : 12);
  const desired = Math.max(goalStory ? 12 : 8, Math.min(goalStory ? 22 : 25, Math.max(momentDuration, target)));
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
  const goalEvidence = goalEvidenceObject(selectedMoment);
  const shotStart = goalEvidence && Number.isFinite(Number(goalEvidence.shotStart)) ? Number(goalEvidence.shotStart) : null;
  const payoffEnd = goalEvidence && Number.isFinite(Number(goalEvidence.payoffEnd)) ? Number(goalEvidence.payoffEnd) : null;
  let start = clamp(center - duration * 0.45, 0, Math.max(0, mediaDuration - duration));
  if (shotStart != null || payoffEnd != null) {
    const preferredStart = shotStart != null ? Math.max(0, shotStart - 3.5) : start;
    const preferredEnd = payoffEnd != null ? Math.min(mediaDuration, payoffEnd + 4.5) : preferredStart + duration;
    start = clamp(Math.min(preferredStart, preferredEnd - duration), 0, Math.max(0, mediaDuration - duration));
  }
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

function captionEvidenceForStory({ highlightType, reasonCodes = [], goalEvidence = false, role }) {
  const safeReasons = reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 10);
  return {
    alignedHighlightType: highlightType,
    highlightType,
    reasonCodes: safeReasons,
    visualReasonCodes: safeReasons.filter((reason) => /^visual_/.test(reason)),
    goalEvidence: Boolean(goalEvidence),
    role,
  };
}

function captionRiskFlagsForStory({ text, highlightType, goalEvidence }) {
  const flags = [];
  if (highlightType !== "goal" && hasGoalLanguage(text) && !goalEvidence) {
    flags.push("goal_language_without_evidence");
  }
  return flags;
}

function captionBeats({
  copy,
  title,
  highlightType,
  language,
  duration,
  includeTitleContext = true,
  goalEvidence = false,
  reasonCodes = [],
  visualEvidenceSummary = {},
}) {
  const context = includeTitleContext && !shouldUseEvidenceContext({ highlightType, reasonCodes, visualEvidenceSummary })
    ? contextLineForTitle(title, highlightType, language, { goalEvidence })
    : copy.context;
  const lines = [
    copy.hook,
    context,
    copy.main,
    copy.reaction,
    copy.closing,
  ].filter(Boolean);
  return lines.map((line, index) => {
    const text = sanitizeText(line, 96);
    const role = index === 0
      ? "opening_hook"
      : index === 1
        ? "context"
        : index === lines.length - 1
          ? "closing_punch"
          : index === lines.length - 2
            ? "reaction"
            : "action_callout";
    return {
      ...captionTiming(duration, index, lines.length),
      text,
      role,
      emphasis: index === 0
        ? "shout"
        : index === 1
          ? "detail"
          : index === lines.length - 1
            ? "strong"
            : "strong",
      layout: index === 0 ? "center" : index === 1 ? "top" : "bottom",
      timing: {
        entranceMs: index === 0 ? 180 : 140,
        exitMs: 120,
      },
      style: {
        fontScale: index === 0 ? 1.12 : index === 1 ? 0.78 : 1,
        stroke: index === 1 ? 3 : 5,
        shadow: 2,
        highlightColor: index === 1 ? "cyan" : "gold",
        uppercase: index !== 1,
        maxLines: index === 1 ? 1 : 2,
      },
      captionIntent: captionIntentForHighlightType(highlightType, role),
      captionSource: `football_story_planner:${highlightType}:${role}`,
      captionEvidence: captionEvidenceForStory({ highlightType, reasonCodes, goalEvidence, role }),
      captionRiskFlags: captionRiskFlagsForStory({ text, highlightType, goalEvidence }),
    };
  }).filter((caption) => caption.end > caption.start && caption.text);
}

function transcriptSnippetsForMoment(transcript = {}, selectedMoment = {}) {
  const captions = Array.isArray(transcript && transcript.captions) ? transcript.captions : [];
  const start = Number(selectedMoment.start || 0);
  const end = Number(selectedMoment.end || start);
  return captions
    .filter((caption) => Number(caption.start || 0) <= end + 1.5 && Number(caption.end || caption.start || 0) >= start - 1.5)
    .slice(0, 4)
    .map((caption) => ({
      start: Number(Number(caption.start || 0).toFixed(2)),
      end: Number(Number(caption.end || caption.start || 0).toFixed(2)),
      text: sanitizeText(caption.text, 120),
    }))
    .filter((caption) => caption.text);
}

function captionGenerationForStory({
  copy,
  title,
  highlightType,
  language,
  duration,
  includeTitleContext = true,
  goalEvidence = false,
  reasonCodes = [],
  visualEvidenceSummary = {},
  audioEvidenceSummary = null,
  rankingExplanation = null,
  transcript = null,
  selectedMoment = {},
  stylePreset = "social_sports_v1",
  editIntensity = "balanced",
  captionProvider = null,
}) {
  const useTitleContext = includeTitleContext && !shouldUseEvidenceContext({ highlightType, reasonCodes, visualEvidenceSummary });
  const provider = captionProvider || createDeterministicCaptionProvider();
  return generateCaptionsWithProvider({
    copy,
    title,
    titleContext: contextLineForTitle(title, highlightType, language, { goalEvidence }),
    useTitleContext,
    highlightType,
    language,
    duration,
    goalEvidence,
    reasonCodes,
    visualEvidenceSummary,
    audioEvidenceSummary,
    rankingExplanation,
    transcriptSnippets: transcriptSnippetsForMoment(transcript, selectedMoment),
    stylePreset,
    editIntensity,
  }, { provider });
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
    [
      "big_chance",
      "goal",
      "shot_on_target",
      "near_miss",
      "save",
      "foul",
      "hard_foul",
      "counter_attack",
      "crowd_reaction",
      "commentator_peak",
      "audio_energy_spike",
    ].includes(highlightType)
  ) {
    cues.push({ type: "punch_zoom", start: Math.min(3.1, safeDuration - 0.2), end: Math.min(4.2, safeDuration) });
  }
  if (intensity === "punchy" && ["goal", "foul", "hard_foul", "save", "big_chance", "crowd_reaction", "commentator_peak"].includes(highlightType)) {
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
  const reasonCodes = Array.isArray(selectedMoment.reasonCodes) ? selectedMoment.reasonCodes : [];
  const captionGeneration = captionGenerationForStory({
    copy,
    title: input.title,
    highlightType,
    language,
    duration,
    goalEvidence,
    reasonCodes,
    visualEvidenceSummary: input.visualEvidenceSummary || {},
    audioEvidenceSummary: input.audioEvidenceSummary || null,
    rankingExplanation: selectedMoment.rankingExplanation || null,
    transcript: input.transcript,
    selectedMoment,
    stylePreset: input.stylePreset || "social_sports_v1",
    editIntensity,
    captionProvider: input.captionProvider,
  });
  const captions = captionGeneration.captions;
  const visualEvidenceSummary = input.visualEvidenceSummary || {};
  const framingIntent = framingIntentForStory({ visualEvidenceSummary, aspectRatio, highlightType });
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
    captionGeneration: {
      providerMode: captionGeneration.providerMode,
      fallbackUsed: captionGeneration.fallbackUsed,
      warnings: captionGeneration.warnings,
    },
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
