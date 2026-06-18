const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const {
  createAnimationCues,
  createCaptionEmphasis,
  createCropStrategy,
  createFallbackCaptions,
  framingModeForMetadata,
  hasGoalLanguage,
  hookForHighlightType,
  normalizeStylePreset,
  normalizeGoalOutcome,
  validateEditPlan,
} = require("./edit-plan.cjs");
const {
  calibrateCropPlan,
  containsBox,
  cropStrategyFromPlan,
  publicVisualTrackingSummary,
} = require("./visual-tracking.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { runFfmpeg } = require("./render.cjs");
const {
  summarizeVisualSignals,
  validateVisualSignals,
  visualHighlightTypeForReasons,
  visualReasonCodesForWindow,
} = require("./vision.cjs");
const {
  createFootballStoryPlan,
  normalizeEditIntensity,
  normalizeStyleTarget,
} = require("./football-story-planner.cjs");

const SHOT_TERMS = [
  "shot",
  "strike",
  "effort",
  "on target",
  "σουτ",
  "τελειωμα",
  "τελείωμα",
  "προσπαθεια",
  "προσπάθεια",
];

const SAVE_TERMS = [
  "save",
  "keeper",
  "goalkeeper",
  "stops it",
  "αποκρουση",
  "απόκρουση",
  "τερματοφυλακας",
  "τερματοφύλακας",
];

const BIG_CHANCE_TERMS = [
  "chance",
  "big chance",
  "so close",
  "nearly",
  "almost",
  "δοκαρι",
  "δοκάρι",
  "ευκαιρια",
  "ευκαιρία",
];

const FOUL_TERMS = [
  "foul",
  "challenge",
  "tackle",
  "contact",
  "σύγκρουση",
  "συγκρουση",
  "φαουλ",
  "φάουλ",
  "μαρκαρισμα",
  "μαρκάρισμα",
];

const HARD_FOUL_TERMS = [
  "heavy contact",
  "bad foul",
  "hard foul",
  "late challenge",
  "dangerous tackle",
  "σκληρο",
  "σκληρό",
  "δυνατο",
  "δυνατό",
];

const CARD_TERMS = ["yellow card", "red card", "card", "booking", "sent off", "κάρτα", "καρτα", "αποβολη", "αποβολή"];

const COUNTER_TERMS = [
  "counter",
  "counter attack",
  "break",
  "transition",
  "final attack",
  "αντεπιθεση",
  "αντεπίθεση",
];

const SKILL_TERMS = [
  "dribble",
  "nutmeg",
  "skill",
  "touch",
  "turn",
  "ντριμπλα",
  "ντρίμπλα",
  "προσποιηση",
  "προσποίηση",
];

const STRONG_SKILL_TERMS = [
  "dribble",
  "nutmeg",
  "skill",
  "ντριμπλα",
  "ντρίμπλα",
  "προσποιηση",
  "προσποίηση",
];

const WEAK_SKILL_TERMS = ["touch", "turn"];

const BUILD_UP_TERMS = [
  "assist",
  "pass",
  "run",
  "lane",
  "defender",
  "build-up",
  "build up",
  "press",
  "movement",
  "πάσα",
  "πασα",
  "κινηση",
  "κίνηση",
  "αμυνα",
  "άμυνα",
];

const REPLAY_TERMS = ["replay", "again", "angle", "ριπλεϊ", "ριπλει", "ξανα", "επανάληψη", "επαναληψη"];
const CROWD_TERMS = ["crowd", "stadium", "fans", "roar", "κερκιδα", "κερκίδα", "κόσμος", "κοσμος"];
const CROWD_REACTION_TERMS = [...CROWD_TERMS, "stands", "supporters", "reaction", "noise", "κερκίδα", "αντιδραση", "αντίδραση"];
const COMMENTARY_TERMS = [
  "the call tells",
  "commentator",
  "commentary",
  "broadcast voice",
  "φωνη εκφωνητη",
  "φωνή εκφωνητή",
  "εκφωνητης",
  "εκφωνητής",
  "περιγραφη",
  "περιγραφή",
];

const OFFSIDE_TERMS = [
  "offside",
  "flag is up",
  "flag goes up",
  "assistant referee",
  "οφσαιντ",
  "οφσάιντ",
  "σημαια",
  "σημαία",
  "εποπτης",
  "επόπτης",
];

const DISALLOWED_TERMS = [
  "disallowed",
  "ruled out",
  "chalked off",
  "no goal",
  "does not count",
  "won't count",
  "will not count",
  "ακυρωνεται",
  "ακυρώνεται",
  "ακυρωθηκε",
  "ακυρώθηκε",
  "δεν μετρα",
  "δεν μέτρα",
  "δεν μετρά",
];

const VAR_TERMS = ["var", "check", "review", "checking", "video assistant", "ελεγχος", "έλεγχος"];

const CONFIRMED_GOAL_TERMS = [
  "goal confirmed",
  "it counts",
  "the goal stands",
  "finish counts",
  "μετραει",
  "μετράει",
  "το γκολ μετρα",
  "το γκολ μετρά",
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueTimes(times, duration) {
  const seen = new Set();
  return times
    .map((time) => Number(time.toFixed(2)))
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= duration)
    .filter((time) => {
      const key = Math.round(time * 2) / 2;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a - b);
}

function fallbackAudioPeaks(duration, hasAudio) {
  if (!hasAudio || duration < 3) return [];
  return uniqueTimes([duration * 0.34, duration * 0.62, Math.max(1, duration - 2)], duration).map((time, index) => ({
    time,
    energyScore: Number((0.62 - index * 0.06).toFixed(2)),
    source: "estimated",
  }));
}

function fallbackSceneChanges(duration) {
  if (duration < 3) return [];
  return uniqueTimes([duration * 0.18, duration * 0.44, duration * 0.72], duration).map((time, index) => ({
    time,
    confidence: Number((0.54 - index * 0.03).toFixed(2)),
    source: "estimated",
  }));
}

async function detectSceneChanges(inputPath, metadata, { signal, ffmpegRunner = runFfmpeg } = {}) {
  const duration = seconds(metadata.durationSeconds);
  if (!inputPath || !commandAvailable(CONFIG.ffmpegBin)) return fallbackSceneChanges(duration);
  try {
    const result = await ffmpegRunner(
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        "-vf",
        "select=gt(scene\\,0.32),showinfo",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 30000) },
    );
    const times = [...String(result.stderr || "").matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
    const changes = uniqueTimes(times, duration).slice(0, 12).map((time) => ({
      time,
      confidence: 0.74,
      source: "ffmpeg_scene",
    }));
    return changes.length ? changes : fallbackSceneChanges(duration);
  } catch {
    return fallbackSceneChanges(duration);
  }
}

function nonSilentSegmentsFromSilenceEvents(stderr, duration) {
  const starts = [...String(stderr || "").matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const ends = [...String(stderr || "").matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  if (!starts.length && !ends.length) return [];
  const segments = [];
  let cursor = 0;
  starts.forEach((start, index) => {
    if (start - cursor >= 0.7) segments.push({ start: cursor, end: start });
    cursor = Math.max(cursor, ends[index] || start);
  });
  if (duration - cursor >= 0.7) segments.push({ start: cursor, end: duration });
  return segments;
}

async function detectAudioPeaks(inputPath, metadata, { signal, ffmpegRunner = runFfmpeg } = {}) {
  const duration = seconds(metadata.durationSeconds);
  if (!metadata.hasAudio) return [];
  if (!inputPath || !commandAvailable(CONFIG.ffmpegBin)) return fallbackAudioPeaks(duration, metadata.hasAudio);
  try {
    const result = await ffmpegRunner(
      ["-hide_banner", "-nostats", "-i", inputPath, "-af", "silencedetect=noise=-28dB:d=0.35", "-f", "null", "-"],
      { signal, timeoutMs: Math.min(CONFIG.analysisTimeoutMs, 30000) },
    );
    const segments = nonSilentSegmentsFromSilenceEvents(result.stderr, duration);
    const peaks = segments
      .map((segment) => ({
        time: Number(((segment.start + segment.end) / 2).toFixed(2)),
        energyScore: Number(clamp((segment.end - segment.start) / 8, 0.45, 0.95).toFixed(2)),
        source: "ffmpeg_audio_activity",
      }))
      .slice(0, 10);
    return peaks.length ? peaks : fallbackAudioPeaks(duration, metadata.hasAudio);
  } catch {
    return fallbackAudioPeaks(duration, metadata.hasAudio);
  }
}

async function extractMediaSignals({ inputPath, metadata, signal, ffmpegRunner } = {}) {
  const safeMetadata = metadata || {};
  const duration = seconds(safeMetadata.durationSeconds);
  const width = Number(safeMetadata.width || 0);
  const height = Number(safeMetadata.height || 0);
  const [audioPeaks, sceneChanges] = await Promise.all([
    detectAudioPeaks(inputPath, safeMetadata, { signal, ffmpegRunner }),
    detectSceneChanges(inputPath, safeMetadata, { signal, ffmpegRunner }),
  ]);
  const highMotionCandidates = uniqueTimes(
    [...sceneChanges.map((item) => item.time), ...audioPeaks.map((item) => item.time)].slice(0, 8),
    duration,
  ).map((time) => ({ time, confidence: 0.58, source: "signal_cluster" }));
  return {
    durationSeconds: duration,
    width,
    height,
    aspectRatio: height ? Number((width / height).toFixed(3)) : null,
    hasAudio: Boolean(safeMetadata.hasAudio),
    audioPeaks,
    sceneChanges,
    highMotionCandidates,
    thumbnailSamples: uniqueTimes([duration * 0.2, duration * 0.5, duration * 0.8], duration).map((time) => ({
      time,
      label: "sample_frame",
    })),
  };
}

function normalizedCaptions(transcript) {
  return (Array.isArray(transcript && transcript.captions) ? transcript.captions : [])
    .map((caption) => ({
      start: seconds(caption.start),
      end: seconds(caption.end || seconds(caption.start) + 1.5),
      text: sanitizeText(caption.text, 160),
    }))
    .filter((caption) => caption.text && caption.end > caption.start)
    .sort((a, b) => a.start - b.start);
}

function hasTerm(text, terms) {
  const normalized = sanitizeText(text, 400).toLowerCase();
  return terms.some((term) => {
    const normalizedTerm = sanitizeText(term, 80).toLowerCase();
    if (!normalizedTerm) return false;
    if (/^[a-z0-9\s-]+$/.test(normalizedTerm)) {
      const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return new RegExp(`\\b${escaped}\\b`, "i").test(normalized);
    }
    return normalized.includes(normalizedTerm);
  });
}

function nearby(items, center, radiusSeconds) {
  return (items || []).filter((item) => Math.abs(seconds(item.time) - center) <= radiusSeconds);
}

function visualWindowsNear(visualSignals, center, radiusSeconds) {
  const windows = Array.isArray(visualSignals && visualSignals.windows) ? visualSignals.windows : [];
  return windows.filter((window) => {
    const visualCenter = seconds(window.center ?? (seconds(window.start) + seconds(window.end)) / 2);
    const overlaps = seconds(window.start) <= center + radiusSeconds && seconds(window.end) >= center - radiusSeconds;
    return overlaps || Math.abs(visualCenter - center) <= radiusSeconds;
  });
}

function visualReasonCodesNear(visualSignals, center, radiusSeconds) {
  return [...new Set(visualWindowsNear(visualSignals, center, radiusSeconds).flatMap(visualReasonCodesForWindow))];
}

const ACTION_VISUAL_REASONS = Object.freeze([
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
]);

const PRIMARY_ACTION_REASONS = Object.freeze([
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

const REACTION_CONTEXT_REASONS = Object.freeze([
  "crowd_reaction",
  "crowd_spike",
  "visual_crowd_reaction",
  "commentator_peak",
  "audio_energy_spike",
  "audio_peak",
]);

const SUPPORTING_CONTEXT_REASONS = Object.freeze([
  "scene_change_cluster",
  "replay_worthy_moment",
  "replay_or_reaction",
  "visual_replay_indicator",
  "visual_scoreboard_context",
  "visual_offside_flag",
  "visual_var_check",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
  "visual_goal_area",
  "visual_goal_mouth",
  "visual_ball_visible",
  "visual_unknown_action",
]);

const GOAL_SEQUENCE_REASON_CODES = Object.freeze([
  "goal",
  "shot_on_target",
  "big_chance",
  "visual_shot_like_motion",
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_goal_area",
  "visual_goal_mouth",
  "visual_keeper_action",
  "visual_save_like_motion",
  "visual_ball_in_net",
  "visual_celebration_after_shot",
  "visual_ball_visible",
  "audio_energy_spike",
  "crowd_spike",
  "crowd_reaction",
  "commentator_peak",
  "visual_crowd_reaction",
  "visual_scoreboard_context",
  "visual_offside_flag",
  "visual_var_check",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
]);

function visualReasonsAreScoreboardOnly(reasons = []) {
  return reasons.includes("visual_scoreboard_context") && !reasons.some((reason) => ACTION_VISUAL_REASONS.includes(reason));
}

function shouldTreatCaptionAsSkillMove(text, visualReasons = []) {
  if (hasTerm(text, STRONG_SKILL_TERMS)) return true;
  if (!hasTerm(text, WEAK_SKILL_TERMS)) return false;
  if (visualReasonsAreScoreboardOnly(visualReasons)) return false;
  return visualReasons.some((reason) => ACTION_VISUAL_REASONS.includes(reason));
}

function reasonCodesForCaption(caption, signals, visualSignals) {
  const text = caption.text || "";
  const center = (caption.start + caption.end) / 2;
  const reasons = [];
  const nearbyAudioPeaks = nearby(signals.audioPeaks, center, 4);
  const nearbySceneChanges = nearby(signals.sceneChanges, center, 3);
  const nearbyVisualReasons = visualReasonCodesNear(visualSignals, center, 3);
  if (hasGoalLanguage(text)) reasons.push("goal");
  if (hasTerm(text, HARD_FOUL_TERMS)) reasons.push("hard_foul");
  if (hasTerm(text, FOUL_TERMS)) reasons.push("foul");
  if (hasTerm(text, CARD_TERMS)) reasons.push("card_moment");
  if (hasTerm(text, SAVE_TERMS)) reasons.push("save");
  if (hasTerm(text, BIG_CHANCE_TERMS)) reasons.push("big_chance");
  if (hasTerm(text, SHOT_TERMS)) reasons.push("shot_on_target");
  if (hasTerm(text, COUNTER_TERMS)) reasons.push("counter_attack");
  if (shouldTreatCaptionAsSkillMove(text, nearbyVisualReasons)) reasons.push("skill_move");
  if (hasTerm(text, BUILD_UP_TERMS)) reasons.push("replay_worthy_moment");
  if (hasTerm(text, REPLAY_TERMS)) reasons.push("replay_worthy_moment");
  if (hasTerm(text, CROWD_REACTION_TERMS)) reasons.push("crowd_reaction");
  if (hasTerm(text, COMMENTARY_TERMS)) reasons.push("commentator_peak");
  if (/[!]{1,}|[Α-ΩA-Z]{5,}/.test(text)) reasons.push("commentator_peak");
  if (nearbyAudioPeaks.length) reasons.push("audio_energy_spike");
  if (nearbyAudioPeaks.some((peak) => Number(peak.energyScore || 0) >= 0.88) && hasTerm(text, CROWD_REACTION_TERMS)) {
    reasons.push("crowd_spike");
  }
  if (nearbySceneChanges.length >= 1) reasons.push("scene_change_cluster");
  reasons.push(...nearbyVisualReasons);
  if (nearbyVisualReasons.includes("visual_replay_indicator")) {
    reasons.push("replay_worthy_moment");
  }
  if (!reasons.length) reasons.push("generic_highlight");
  return [...new Set(reasons)];
}

function scoreReasons(reasons) {
  const weights = {
    goal: 0.32,
    big_chance: 0.22,
    save: 0.21,
    hard_foul: 0.2,
    shot_on_target: 0.18,
    counter_attack: 0.16,
    skill_move: 0.14,
    audio_energy_spike: 0.14,
    audio_peak: 0.14,
    commentator_peak: 0.14,
    crowd_spike: 0.13,
    crowd_reaction: 0.12,
    visual_save_like_motion: 0.2,
    visual_keeper_action: 0.18,
    visual_foul_like_contact: 0.18,
    visual_shot_like_motion: 0.17,
    visual_shot_contact: 0.19,
    visual_ball_toward_goal: 0.17,
    visual_ball_in_net: 0.24,
    visual_celebration_after_shot: 0.2,
    visual_fast_break: 0.16,
    visual_crowd_reaction: 0.15,
    visual_replay_indicator: 0.1,
    visual_scoreboard_context: 0.04,
    visual_goal_area: 0.06,
    visual_goal_mouth: 0.08,
    visual_ball_visible: 0.05,
    visual_unknown_action: 0.03,
    scene_change_cluster: 0.1,
    replay_worthy_moment: 0.08,
    replay_or_reaction: 0.08,
    foul: 0.08,
    card_moment: 0.08,
    unknown_action: 0.02,
    generic_highlight: 0.03,
  };
  const base = 0.22 + reasons.reduce((sum, reason) => sum + (weights[reason] || 0.04), 0);
  const reasonSet = new Set(reasons);
  const primaryActionCount = PRIMARY_ACTION_REASONS.filter((reason) => reasonSet.has(reason)).length;
  const reactionContextCount = REACTION_CONTEXT_REASONS.filter((reason) => reasonSet.has(reason)).length;
  const actionBoost = Math.min(0.18, primaryActionCount * 0.055);
  const reactionOnlyPenalty = primaryActionCount === 0 && reactionContextCount > 0 ? 0.1 : 0;
  const scoreboardOnlyPenalty = visualReasonsAreScoreboardOnly(reasons) ? 0.12 : 0;
  return clamp(base + actionBoost - reactionOnlyPenalty - scoreboardOnlyPenalty, 0.12, 0.99);
}

function firstWindowTime(windows = [], predicate, fallback = null) {
  const match = windows
    .filter((window) => predicate(new Set(visualReasonCodesForWindow(window)), window))
    .sort((a, b) => seconds(a.start) - seconds(b.start))[0];
  if (!match) return fallback;
  return Number(seconds(match.start).toFixed(2));
}

function lastWindowTime(windows = [], predicate, fallback = null) {
  const match = windows
    .filter((window) => predicate(new Set(visualReasonCodesForWindow(window)), window))
    .sort((a, b) => seconds(b.end) - seconds(a.end))[0];
  if (!match) return fallback;
  return Number(seconds(match.end).toFixed(2));
}

function goalEvidenceForContext({ reasons = [], visualWindows = [], center = null } = {}) {
  const reasonSet = new Set(reasons);
  const visualReasons = new Set(visualWindows.flatMap(visualReasonCodesForWindow));
  const allReasons = new Set([...reasonSet, ...visualReasons]);
  const hasExplicitTextGoal = reasonSet.has("goal");
  const hasShotContact = hasExplicitTextGoal ||
    allReasons.has("shot_on_target") ||
    allReasons.has("big_chance") ||
    allReasons.has("visual_shot_like_motion") ||
    allReasons.has("visual_shot_contact");
  const hasBallTowardGoal = allReasons.has("visual_ball_toward_goal");
  const hasGoalMouthFrame = allReasons.has("visual_goal_mouth") || allReasons.has("visual_goal_area");
  const hasKeeperAction = allReasons.has("visual_keeper_action") || allReasons.has("visual_save_like_motion");
  const hasBallInNetOrLineCross = allReasons.has("visual_ball_in_net");
  const hasCelebrationAfterShot = allReasons.has("visual_celebration_after_shot");
  const hasSupportingReaction = [
    "audio_energy_spike",
    "crowd_spike",
    "crowd_reaction",
    "commentator_peak",
    "visual_crowd_reaction",
    "visual_scoreboard_context",
  ].some((reason) => allReasons.has(reason));
  const strongVisualChain = hasShotContact &&
    hasBallTowardGoal &&
    hasGoalMouthFrame &&
    (hasBallInNetOrLineCross || hasCelebrationAfterShot);
  const mediumVisualChain = hasShotContact &&
    hasGoalMouthFrame &&
    (hasBallTowardGoal || hasKeeperAction) &&
    (hasBallInNetOrLineCross || hasCelebrationAfterShot || hasSupportingReaction);
  const weakVisualChain = hasShotContact && hasGoalMouthFrame;
  const evidenceLevel = hasExplicitTextGoal || strongVisualChain
    ? "strong"
    : mediumVisualChain
      ? "medium"
      : weakVisualChain
        ? "weak"
        : "none";
  const cueCount = [
    hasShotContact,
    hasBallTowardGoal,
    hasGoalMouthFrame,
    hasKeeperAction,
    hasBallInNetOrLineCross,
    hasCelebrationAfterShot,
    hasSupportingReaction,
  ].filter(Boolean).length;
  const maxVisualConfidence = visualWindows.length
    ? Math.max(...visualWindows.map((window) => Number(window.confidence || 0)))
    : 0;
  const confidence = Number(clamp(
    (hasExplicitTextGoal ? 0.76 : 0.2) + cueCount * 0.075 + maxVisualConfidence * 0.22,
    evidenceLevel === "none" ? 0 : 0.12,
    0.96,
  ).toFixed(2));
  const shotStart = firstWindowTime(
    visualWindows,
    (windowReasons) => (
      windowReasons.has("visual_shot_contact") ||
      windowReasons.has("visual_shot_like_motion") ||
      windowReasons.has("visual_ball_toward_goal")
    ),
    Number.isFinite(Number(center)) ? Number(Math.max(0, Number(center) - 1.5).toFixed(2)) : null,
  );
  const payoffEnd = lastWindowTime(
    visualWindows,
    (windowReasons) => (
      windowReasons.has("visual_ball_in_net") ||
      windowReasons.has("visual_celebration_after_shot") ||
      windowReasons.has("visual_crowd_reaction")
    ),
    Number.isFinite(Number(center)) ? Number((Number(center) + 2).toFixed(2)) : null,
  );
  return {
    hasShotContact,
    hasBallTowardGoal,
    hasGoalMouthFrame,
    hasKeeperAction,
    hasBallInNetOrLineCross,
    hasCelebrationAfterShot,
    hasSupportingReaction,
    explicitTextGoal: hasExplicitTextGoal,
    confidence,
    evidenceLevel,
    goalClaimAllowed: evidenceLevel === "strong",
    shotStart,
    payoffEnd,
    reasonCodes: [...allReasons].filter((reason) => GOAL_SEQUENCE_REASON_CODES.includes(reason)).slice(0, 16),
  };
}

function goalEvidenceForMomentContext({ reasons = [], center = null, start = null, end = null, visualSignals = null } = {}) {
  const rangeStart = Number.isFinite(Number(start)) ? seconds(start) : Number(center) - 8;
  const rangeEnd = Number.isFinite(Number(end)) ? seconds(end) : Number(center) + 8;
  const windows = Array.isArray(visualSignals && visualSignals.windows) ? visualSignals.windows : [];
  const visualWindows = windows.filter((window) => {
    const windowStart = seconds(window.start);
    const windowEnd = seconds(window.end);
    const windowCenter = seconds(window.center ?? (windowStart + windowEnd) / 2);
    return windowEnd >= rangeStart - 3 && windowStart <= rangeEnd + 3 && (
      !Number.isFinite(Number(center)) || Math.abs(windowCenter - Number(center)) <= 9
    );
  });
  return goalEvidenceForContext({ reasons, visualWindows, center });
}

function captionEvidenceInRange(captions = [], start = 0, end = 0) {
  return (Array.isArray(captions) ? captions : [])
    .filter((caption) => seconds(caption.start) <= end && seconds(caption.end) >= start)
    .map((caption) => {
      const text = sanitizeText(caption.text, 180);
      const evidence = [];
      if (hasTerm(text, OFFSIDE_TERMS)) evidence.push("offside_commentary");
      if (/flag/i.test(text) || hasTerm(text, ["σημαια", "σημαία"])) evidence.push("flag_commentary");
      if (hasTerm(text, DISALLOWED_TERMS)) evidence.push("disallowed_commentary");
      if (hasTerm(text, VAR_TERMS)) evidence.push("var_check");
      if (/no\s+goal/i.test(text) || /δεν\s+μετρ/i.test(text)) evidence.push("no_goal_commentary");
      if (hasTerm(text, CONFIRMED_GOAL_TERMS)) evidence.push("confirmed_by_commentary");
      if (hasGoalLanguage(text)) evidence.push("explicit_goal_language");
      return {
        start: seconds(caption.start),
        end: seconds(caption.end),
        text,
        evidence: [...new Set(evidence)],
      };
    })
    .filter((item) => item.evidence.length);
}

function decisionVisualEvidence(windows = []) {
  const reasonCodes = [...new Set((Array.isArray(windows) ? windows : []).flatMap(visualReasonCodesForWindow))];
  return reasonCodes.filter((reason) => [
    "visual_offside_flag",
    "visual_var_check",
    "visual_no_goal_decision",
    "visual_offside_line",
    "visual_referee_decision",
    "visual_replay_indicator",
  ].includes(reason));
}

function goalOutcomeForContext({
  reasons = [],
  goalEvidence = {},
  visualWindows = [],
  captions = [],
  start = 0,
  end = 0,
  payoffEnd = null,
} = {}) {
  const reasonSet = new Set(Array.isArray(reasons) ? reasons : []);
  const ballInNet = Boolean(
    goalEvidence.hasBallInNetOrLineCross ||
    reasonSet.has("visual_ball_in_net") ||
    reasonSet.has("goal"),
  );
  if (!ballInNet) {
    return normalizeGoalOutcome(null, { highlightType: highlightTypeForReasons(reasons), reasonCodes: reasons });
  }
  const decisionStart = Number.isFinite(Number(payoffEnd)) ? Math.max(start, seconds(payoffEnd) - 0.25) : start;
  const textEvidenceItems = captionEvidenceInRange(captions, decisionStart, end);
  const allTextEvidenceItems = captionEvidenceInRange(captions, start, end);
  const textEvidence = [...new Set(textEvidenceItems.flatMap((item) => item.evidence))];
  const allTextEvidence = [...new Set(allTextEvidenceItems.flatMap((item) => item.evidence))];
  const visualEvidence = decisionVisualEvidence(visualWindows);
  const decisionEvidence = [...new Set([
    "ball_in_net",
    ...textEvidence,
    ...visualEvidence,
  ].filter(Boolean))];
  const hasOffside = decisionEvidence.some((code) => [
    "offside_commentary",
    "flag_commentary",
    "visual_offside_flag",
    "visual_offside_line",
  ].includes(code));
  const hasDisallowed = decisionEvidence.some((code) => [
    "disallowed_commentary",
    "no_goal_commentary",
    "visual_no_goal_decision",
  ].includes(code));
  const hasVar = decisionEvidence.includes("var_check") || decisionEvidence.includes("visual_var_check");
  const hasConfirmed = decisionEvidence.includes("confirmed_by_commentary") ||
    (allTextEvidence.includes("explicit_goal_language") && !hasOffside && !hasDisallowed && !hasVar);
  const decisionTimestamp = textEvidenceItems[0]
    ? textEvidenceItems[0].start
    : (visualWindows.find((window) => decisionVisualEvidence([window]).length) || {}).start;
  const outcome = hasOffside && hasDisallowed
    ? "disallowed_offside"
    : hasOffside || hasVar
      ? "possible_offside"
      : hasConfirmed
        ? "confirmed_goal"
        : "unknown_decision";
  const confidence = outcome === "disallowed_offside"
    ? 0.92
    : outcome === "possible_offside"
      ? 0.74
      : outcome === "confirmed_goal"
        ? Math.max(0.72, Number(goalEvidence.confidence || 0))
        : Math.max(0.45, Math.min(0.68, Number(goalEvidence.confidence || 0.48)));
  const postContextSeconds = Math.max(0, Number((end - Math.max(start, Number(goalEvidence.payoffEnd || payoffEnd || start))).toFixed(2)));
  return normalizeGoalOutcome({
    eventType: "ball_in_net",
    outcome,
    offsideStatus: outcome === "disallowed_offside" ? "offside" : outcome === "possible_offside" ? "possible" : outcome === "confirmed_goal" ? "onside" : "unknown",
    decisionEvidence,
    decisionTimestamp: Number.isFinite(Number(decisionTimestamp)) ? Number(decisionTimestamp) : null,
    confidence,
    requiresPostContext: outcome !== "confirmed_goal",
    postContextSeconds: Math.min(15, postContextSeconds),
    captionSafetyFlags: outcome === "disallowed_offside"
      ? ["offside_decision_context"]
      : ["possible_offside", "unknown_decision"].includes(outcome)
        ? ["goal_outcome_uncertain"]
        : [],
  }, { highlightType: "goal", reasonCodes: reasons });
}

function reasonCodesWithGoalEvidence(reasons = [], goalEvidence = {}) {
  const safeReasons = [...new Set(Array.isArray(reasons) ? reasons : [])];
  if (goalEvidence.goalClaimAllowed && !safeReasons.includes("goal")) {
    return ["goal", ...safeReasons];
  }
  if (!goalEvidence.goalClaimAllowed) {
    return safeReasons.filter((reason) => reason !== "goal");
  }
  return safeReasons;
}

function actionFirstScore(score, reasons = [], goalEvidence = {}) {
  const reasonSet = new Set(reasons);
  const primaryActionCount = PRIMARY_ACTION_REASONS.filter((reason) => reasonSet.has(reason)).length;
  const reactionContextCount = REACTION_CONTEXT_REASONS.filter((reason) => reasonSet.has(reason)).length;
  const reactionOnly = reactionContextCount > 0 && primaryActionCount === 0;
  const goalBoost = goalEvidence.goalClaimAllowed
    ? 0.24
    : goalEvidence.evidenceLevel === "medium"
      ? 0.12
      : goalEvidence.evidenceLevel === "weak"
        ? 0.04
        : 0;
  const reactionPenalty = reactionOnly ? 0.18 : 0;
  const supportPenalty = reasonSet.has("visual_crowd_reaction") && primaryActionCount === 0 ? 0.08 : 0;
  return clamp(score + goalBoost - reactionPenalty - supportPenalty, 0.12, 0.99);
}

function openingContextPenalty({ reasons = [], start = 0, center = 0, duration = 0 } = {}) {
  const mediaDuration = seconds(duration);
  if (mediaDuration < 90) return null;
  const safeCenter = Number.isFinite(Number(center)) ? seconds(center) : seconds(start);
  const openingBoundary = Math.min(45, Math.max(18, mediaDuration * 0.12));
  if (safeCenter > openingBoundary) return null;

  const reasonSet = new Set(reasons);
  const primaryActionCount = PRIMARY_ACTION_REASONS.filter((reason) => reasonSet.has(reason)).length;
  if (primaryActionCount > 0 || reasonSet.has("goal")) return null;

  const reactionContextCount = REACTION_CONTEXT_REASONS.filter((reason) => reasonSet.has(reason)).length;
  const replayOrWeakContext = [...reasonSet].some((reason) => (
    SUPPORTING_CONTEXT_REASONS.includes(reason) ||
    reason === "scene_change_cluster" ||
    reason === "visual_unknown_action"
  ));
  const penalty = reactionContextCount > 0 ? 0.1 : replayOrWeakContext ? 0.18 : 0.12;
  return {
    code: "opening_context_without_action",
    penalty,
    openingBoundary: Number(openingBoundary.toFixed(2)),
  };
}

function actionEvidenceStrength(reasons = []) {
  const reasonSet = new Set(reasons);
  if (reasonSet.has("goal")) return 1;
  const primaryScore = PRIMARY_ACTION_REASONS.reduce((score, reason) => {
    if (!reasonSet.has(reason)) return score;
    if (reason.startsWith("visual_")) return score + 0.18;
    if (["big_chance", "save", "hard_foul", "counter_attack"].includes(reason)) return score + 0.22;
    return score + 0.14;
  }, 0);
  return Number(clamp(primaryScore, 0, 1).toFixed(2));
}

function safeCueList(reasons = [], allowed = []) {
  const allowedSet = new Set(allowed);
  return [...new Set(reasons.filter((reason) => allowedSet.has(reason)).map((reason) => sanitizeText(reason, 60)))].slice(0, 8);
}

function rankingExplanationForMoment({
  reasons = [],
  score = 0,
  source = "analysis",
  visualSignals = null,
  goalEvidence = null,
  goalOutcome = null,
  contextPenalty = null,
} = {}) {
  const reasonSet = new Set(reasons);
  const actionCues = safeCueList(reasons, PRIMARY_ACTION_REASONS);
  const reactionCues = safeCueList(reasons, REACTION_CONTEXT_REASONS);
  const supportingCues = safeCueList(reasons, SUPPORTING_CONTEXT_REASONS);
  const suppressedCues = [];
  const rejectedClaims = [];
  const actionStrength = actionEvidenceStrength(reasons);
  const actionSequence = actionSequenceForReasons(reasons, goalEvidence || {});
  if (!actionCues.length && reactionCues.length) {
    suppressedCues.push("reaction_context_without_visible_action");
  }
  if (visualReasonsAreScoreboardOnly(reasons)) {
    suppressedCues.push("scoreboard_context_support_only");
  }
  if (!reasonSet.has("goal") && (reasonSet.has("visual_goal_area") || reasonSet.has("visual_goal_mouth") || reasonSet.has("visual_shot_like_motion"))) {
    rejectedClaims.push("goal_claim_rejected_without_explicit_goal_evidence");
  }
  if (goalEvidence && goalEvidence.evidenceLevel && goalEvidence.evidenceLevel !== "none" && !goalEvidence.goalClaimAllowed) {
    rejectedClaims.push("goal_claim_rejected_until_goal_sequence_is_stronger");
  }
  if (contextPenalty && contextPenalty.code) {
    suppressedCues.push(contextPenalty.code);
  }
  return {
    rankingVersion: 3,
    score: Number(clamp(score, 0, 1).toFixed(2)),
    actionEvidenceStrength: actionStrength,
    actionSequence,
    contextPenalty: contextPenalty
      ? {
          code: sanitizeText(contextPenalty.code, 80),
          penalty: Number(clamp(contextPenalty.penalty, 0, 1).toFixed(2)),
          openingBoundary: Number(contextPenalty.openingBoundary || 0),
        }
      : null,
    goalEvidence: goalEvidence || null,
    goalOutcome: goalOutcome || null,
    boostCues: actionCues,
    supportingCues,
    reactionContextCues: reactionCues,
    suppressedCues: suppressedCues.slice(0, 6),
    rejectedClaims: rejectedClaims.slice(0, 4),
    fallbackUsed: source === "fallback" || Boolean(visualSignals && visualSignals.fallbackUsed),
    selectedAsPrimary: false,
  };
}

function highlightTypeForReasons(reasons = []) {
  if (reasons.includes("goal")) return "goal";
  if (reasons.includes("hard_foul")) return "hard_foul";
  if (reasons.includes("card_moment")) return "card_moment";
  if (reasons.includes("foul")) return "foul";
  if (reasons.includes("save")) return "save";
  if (reasons.includes("big_chance")) return "big_chance";
  if (reasons.includes("shot_on_target")) return "shot_on_target";
  if (reasons.includes("counter_attack")) return "counter_attack";
  if (reasons.includes("skill_move")) return "skill_move";
  if (reasons.includes("visual_save_like_motion")) return "save";
  if (reasons.includes("visual_foul_like_contact")) return "foul";
  if (reasons.includes("visual_fast_break")) return "counter_attack";
  if (reasons.includes("visual_crowd_reaction") && (reasons.includes("audio_energy_spike") || reasons.includes("crowd_spike"))) {
    return "crowd_reaction";
  }
  if (reasons.includes("visual_shot_like_motion")) return "big_chance";
  if (reasons.includes("visual_crowd_reaction")) return "crowd_reaction";
  if (reasons.includes("replay_worthy_moment")) return "replay_worthy_moment";
  if (reasons.includes("visual_replay_indicator") || reasons.includes("replay_or_reaction")) return "replay_or_reaction";
  if (reasons.includes("crowd_reaction") || reasons.includes("crowd_spike")) return "crowd_reaction";
  if (reasons.includes("commentator_peak")) return "commentator_peak";
  if (reasons.includes("audio_energy_spike") || reasons.includes("audio_peak")) return "audio_energy_spike";
  if (reasons.includes("unknown_action")) return "unknown_action";
  if (
    reasons.includes("visual_unknown_action") ||
    reasons.includes("visual_goal_area") ||
    reasons.includes("visual_scoreboard_context") ||
    reasons.includes("visual_ball_visible")
  ) {
    return "unknown_action";
  }
  return "generic_highlight";
}

function titleForHighlightType(highlightType) {
  const titles = {
    goal: "Goal impact beat",
    shot_on_target: "Shot on target",
    near_miss: "Near miss reaction",
    big_chance: "Big chance",
    save: "Keeper save",
    foul: "Foul tempo shift",
    hard_foul: "Hard foul reaction",
    card_moment: "Card moment",
    counter_attack: "Counter attack window",
    skill_move: "Skill move highlight",
    crowd_reaction: "Crowd reaction",
    commentator_peak: "Commentator peak",
    replay_or_reaction: "Replay or reaction beat",
    replay_worthy_moment: "Replay-worthy play",
    audio_energy_spike: "Audio energy spike",
    unknown_action: "Unknown action pressure phase",
    generic_highlight: "High-intensity moment",
  };
  return titles[highlightType] || titles.generic_highlight;
}

function visualEvidenceForCenter(visualSignals, center) {
  const nearbyVisualWindows = center == null ? [] : visualWindowsNear(visualSignals, center, 3);
  const summary = summarizeVisualSignals({
    providerMode: visualSignals && visualSignals.providerMode,
    fallbackUsed: visualSignals && visualSignals.fallbackUsed,
    windows: nearbyVisualWindows,
  });
  return {
    providerMode: summary.providerMode,
    fallbackUsed: summary.fallbackUsed,
    windowCount: summary.windowCount,
    topTypes: summary.topTypes,
    reasonCodes: summary.reasonCodes,
    actionFocusConfidence: summary.actionFocusConfidence,
    goalClaimAllowed: false,
    windows: nearbyVisualWindows.map((window) => ({
      start: window.start,
      end: window.end,
      type: window.type,
      types: window.types,
      confidence: window.confidence,
      reasonCodes: visualReasonCodesForWindow(window),
    })),
  };
}

function reasonSetHasAny(reasonSet, values = []) {
  return values.some((reason) => reasonSet.has(reason));
}

function actionSequenceForReasons(reasons = [], goalEvidence = {}) {
  const reasonSet = new Set(Array.isArray(reasons) ? reasons : []);
  const buildUp = reasonSetHasAny(reasonSet, [
    "big_chance",
    "counter_attack",
    "skill_move",
    "visual_fast_break",
    "visual_ball_visible",
  ]);
  const shotOrContact = reasonSetHasAny(reasonSet, [
    "shot_on_target",
    "hard_foul",
    "foul",
    "save",
    "visual_shot_like_motion",
    "visual_shot_contact",
    "visual_save_like_motion",
    "visual_foul_like_contact",
  ]);
  const ballTrajectory = reasonSetHasAny(reasonSet, [
    "visual_ball_toward_goal",
    "visual_ball_visible",
  ]);
  const goalmouthOrKeeper = reasonSetHasAny(reasonSet, [
    "visual_goal_area",
    "visual_goal_mouth",
    "visual_keeper_action",
    "visual_save_like_motion",
  ]);
  const payoff = reasonSetHasAny(reasonSet, [
    "goal",
    "save",
    "visual_ball_in_net",
    "visual_celebration_after_shot",
    "visual_keeper_action",
    "visual_save_like_motion",
  ]);
  const reactionSupport = reasonSetHasAny(reasonSet, REACTION_CONTEXT_REASONS);
  const replaySupport = reasonSetHasAny(reasonSet, [
    "replay_or_reaction",
    "replay_worthy_moment",
    "visual_replay_indicator",
  ]);
  const actionStageCount = [buildUp, shotOrContact, ballTrajectory, goalmouthOrKeeper, payoff].filter(Boolean).length;
  const reactionOnly = reactionSupport && actionStageCount === 0 && !replaySupport;
  return {
    buildUp,
    shotOrContact,
    ballTrajectory,
    goalmouthOrKeeper,
    payoff,
    reactionSupport,
    replaySupport,
    reactionOnly,
    actionStageCount,
    primaryEvidence: reactionOnly ? "reaction_support" : actionStageCount > 0 ? "action_sequence" : replaySupport ? "replay_context" : "weak_context",
    goalEvidenceLevel: sanitizeText(goalEvidence && goalEvidence.evidenceLevel || "none", 24),
    goalClaimAllowed: Boolean(goalEvidence && goalEvidence.goalClaimAllowed),
  };
}

function evidenceForReasons(reasons = [], caption = null, signals = {}, center = null, visualSignals = null, range = {}) {
  const reasonSet = new Set(reasons);
  const nearbyAudio = center == null ? [] : nearby(signals.audioPeaks, center, 4);
  const nearbyScenes = center == null ? [] : nearby(signals.sceneChanges, center, 3);
  const goalEvidence = goalEvidenceForMomentContext({
    reasons,
    center,
    start: range.start,
    end: range.end,
    visualSignals,
  });
  const actionSequence = actionSequenceForReasons(reasons, goalEvidence);
  return {
    goalEvidence,
    actionSequence,
    goalClaimAllowed: reasonSet.has("goal") && goalEvidence.goalClaimAllowed,
    captionEvidence: caption ? sanitizeText(caption.text, 160) : null,
    audioPeakCount: nearbyAudio.length,
    strongestAudioScore: nearbyAudio.reduce((max, item) => Math.max(max, Number(item.energyScore || 0)), 0),
    sceneChangeCount: nearbyScenes.length,
    reasonCodes: [...reasonSet],
    visual: visualEvidenceForCenter(visualSignals, center),
  };
}

function captionIntentForHighlightType(highlightType) {
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
  return intents[highlightType] || intents.generic_highlight;
}

function captionMatchesMomentIntent(text, highlightType) {
  if (!text) return false;
  if (highlightType === "goal") return hasGoalLanguage(text);
  const checks = {
    shot_on_target: [...SHOT_TERMS, ...BIG_CHANCE_TERMS],
    near_miss: BIG_CHANCE_TERMS,
    big_chance: [...BIG_CHANCE_TERMS, ...SHOT_TERMS],
    save: SAVE_TERMS,
    foul: FOUL_TERMS,
    hard_foul: [...FOUL_TERMS, ...HARD_FOUL_TERMS],
    card_moment: CARD_TERMS,
    counter_attack: COUNTER_TERMS,
    skill_move: SKILL_TERMS,
    crowd_reaction: CROWD_REACTION_TERMS,
    commentator_peak: CROWD_REACTION_TERMS,
    replay_or_reaction: REPLAY_TERMS,
    replay_worthy_moment: REPLAY_TERMS,
    audio_energy_spike: CROWD_REACTION_TERMS,
  };
  const terms = checks[highlightType];
  if (!terms) return ["unknown_action", "generic_highlight"].includes(highlightType);
  return hasTerm(text, terms);
}

function momentNeedsAlignedFallback(moment, selected) {
  if (!moment || !Array.isArray(selected) || !selected.length) return false;
  const visualOnly = moment.source === "vision" || (Array.isArray(moment.reasonCodes) && moment.reasonCodes.some((reason) => /^visual_/.test(reason)));
  if (!visualOnly) return false;
  const highlightType = moment.highlightType || highlightTypeForReasons(moment.reasonCodes || []);
  if (["unknown_action", "generic_highlight"].includes(highlightType)) return false;
  return !selected.some((caption) => captionMatchesMomentIntent(caption.text, highlightType));
}

function hookForMoment(moment, preset) {
  return hookForHighlightType(moment.highlightType || highlightTypeForReasons(moment.reasonCodes), preset);
}

function captionBeatsForMoment(moment, captions, preset) {
  const selected = captions.filter((caption) => caption.start < moment.end && caption.end > moment.start).slice(0, 4);
  const highlightType = moment.highlightType || highlightTypeForReasons(moment.reasonCodes);
  const selectedHasMisleadingGoal = highlightType !== "goal" && selected.some((caption) => hasGoalLanguage(caption.text));
  if (selected.length && !selectedHasMisleadingGoal && !momentNeedsAlignedFallback(moment, selected)) {
    return selected.map((caption) => ({
      start: Number(Math.max(0, caption.start - moment.start).toFixed(2)),
      end: Number(Math.min(moment.end - moment.start, caption.end - moment.start).toFixed(2)),
      text: caption.text,
    }));
  }
  return createFallbackCaptions(moment.end - moment.start, preset, {
    highlightType,
    hook: moment.hook || hookForHighlightType(highlightType, preset),
  });
}

function createFallbackMoments(signals, preset, visualSignals = null) {
  const duration = seconds(signals.durationSeconds || 18);
  const centers = uniqueTimes(
    [signals.audioPeaks && signals.audioPeaks[0] ? signals.audioPeaks[0].time : duration * 0.42, duration * 0.68],
    duration,
  );
  return centers.slice(0, 2).map((center, index) => {
    const start = Number(clamp(center - 3.5, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(start + Math.min(10, duration - start), start + 3, duration).toFixed(2));
    const reasonCodes = index === 0 ? ["audio_energy_spike"] : ["replay_worthy_moment", "scene_change_cluster"];
    const highlightType = highlightTypeForReasons(reasonCodes);
    const score = scoreReasons(reasonCodes) - 0.12;
    return {
      id: `mom_fallback_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center,
      title: titleForHighlightType(highlightType),
      summary: "Deterministic fallback because transcript or signals were limited.",
      reasonCodes,
      highlightType,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: preset,
      hook: hookForHighlightType(highlightType, preset),
      evidence: evidenceForReasons(reasonCodes, null, signals, center, visualSignals),
      captionIntent: captionIntentForHighlightType(highlightType),
      rankingExplanation: rankingExplanationForMoment({ reasons: reasonCodes, score, source: "fallback", visualSignals }),
      source: "fallback",
    };
  });
}

function expandWindowForGoalEvidence(moment, duration, goalEvidence = {}) {
  const hasGoalSequence = ["strong", "medium"].includes(goalEvidence.evidenceLevel);
  if (!hasGoalSequence) return { start: moment.start, end: moment.end };
  const mediaDuration = Math.max(0, Number(duration) || 0);
  if (!mediaDuration) return { start: moment.start, end: moment.end };
  const shotStart = Number.isFinite(Number(goalEvidence.shotStart)) ? Number(goalEvidence.shotStart) : Number(moment.center || moment.start);
  const payoffEnd = Number.isFinite(Number(goalEvidence.payoffEnd)) ? Number(goalEvidence.payoffEnd) : Number(moment.end);
  const needsDecisionContext = Boolean(goalEvidence.hasBallInNetOrLineCross || goalEvidence.explicitTextGoal);
  const postContextSeconds = needsDecisionContext ? 13 : 4.5;
  const minDuration = needsDecisionContext ? 18 : goalEvidence.goalClaimAllowed ? 12 : 10;
  const maxDuration = needsDecisionContext ? 30 : goalEvidence.goalClaimAllowed ? 22 : 16;
  let start = Math.min(Number(moment.start), Math.max(0, shotStart - 3.5));
  let end = Math.max(Number(moment.end), Math.min(mediaDuration, payoffEnd + postContextSeconds));
  if (end - start < minDuration) {
    const missing = minDuration - (end - start);
    start = Math.max(0, start - missing * 0.55);
    end = Math.min(mediaDuration, end + missing * 0.45);
  }
  if (end - start > maxDuration) {
    start = Math.max(0, Math.min(start, shotStart - 3));
    end = Math.min(mediaDuration, start + maxDuration);
    if (payoffEnd > end) {
      end = Math.min(mediaDuration, payoffEnd + 2);
      start = Math.max(0, end - maxDuration);
    }
  }
  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
  };
}

function normalizeMomentWithEvidence(moment, { signals = {}, visualSignals = null, captions = [], preset = "hype" } = {}) {
  const { _caption: sourceCaption, ...publicMoment } = moment || {};
  const duration = seconds(signals.durationSeconds || 18);
  const initialReasons = Array.isArray(publicMoment.reasonCodes) ? publicMoment.reasonCodes : [];
  const initialGoalEvidence = goalEvidenceForMomentContext({
    reasons: initialReasons,
    center: publicMoment.center,
    start: publicMoment.start,
    end: publicMoment.end,
    visualSignals,
  });
  const reasonCodes = reasonCodesWithGoalEvidence(initialReasons, initialGoalEvidence);
  const window = expandWindowForGoalEvidence({ ...publicMoment, reasonCodes }, duration, initialGoalEvidence);
  const center = Number(((window.start + window.end) / 2).toFixed(2));
  const goalEvidence = goalEvidenceForMomentContext({
    reasons: reasonCodes,
    center,
    start: window.start,
    end: window.end,
    visualSignals,
  });
  const finalReasons = reasonCodesWithGoalEvidence(reasonCodes, goalEvidence);
  const highlightType = highlightTypeForReasons(finalReasons);
  const visualWindows = Array.isArray(visualSignals && visualSignals.windows)
    ? visualSignals.windows.filter((visualWindow) => seconds(visualWindow.end) >= window.start - 1 && seconds(visualWindow.start) <= window.end + 1)
    : [];
  const goalOutcome = goalOutcomeForContext({
    reasons: finalReasons,
    goalEvidence,
    visualWindows,
    captions,
    start: window.start,
    end: window.end,
    payoffEnd: goalEvidence.payoffEnd,
  });
  const baseScore = Number(publicMoment.confidence ?? scoreReasons(finalReasons));
  const unpenalizedScore = actionFirstScore(baseScore, finalReasons, goalEvidence);
  const contextPenalty = openingContextPenalty({
    reasons: finalReasons,
    start: window.start,
    center,
    duration,
  });
  const score = clamp(unpenalizedScore - (contextPenalty ? contextPenalty.penalty : 0), 0.12, 0.99);
  return {
    ...publicMoment,
    start: window.start,
    end: window.end,
    center,
    title: titleForHighlightType(highlightType),
    reasonCodes: finalReasons,
    highlightType,
    confidence: Number(score.toFixed(2)),
    retentionScore: Math.round(score * 100),
    suggestedPreset: finalReasons.includes("counter_attack") || finalReasons.includes("skill_move") ? "tactical" : (publicMoment.suggestedPreset || preset),
    hook: hookForHighlightType(highlightType, preset),
    evidence: {
      ...evidenceForReasons(finalReasons, sourceCaption || null, signals, center, visualSignals, window),
      goalOutcome,
    },
    captionIntent: captionIntentForHighlightType(highlightType),
    rankingExplanation: rankingExplanationForMoment({
      reasons: finalReasons,
      score,
      source: publicMoment.source,
      visualSignals,
      goalEvidence,
      goalOutcome,
      contextPenalty,
    }),
  };
}

function createGoalSequenceMoments(safeVisualSignals, safeSignals, captions = [], preset = "hype") {
  const windows = Array.isArray(safeVisualSignals && safeVisualSignals.windows) ? safeVisualSignals.windows : [];
  const duration = seconds(safeSignals.durationSeconds || 18);
  if (!windows.length) return [];
  const sorted = [...windows].sort((a, b) => seconds(a.start) - seconds(b.start));
  const moments = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const anchor = sorted[index];
    const anchorCenter = seconds(anchor.center ?? (seconds(anchor.start) + seconds(anchor.end)) / 2);
    const cluster = sorted.filter((window) => {
      const center = seconds(window.center ?? (seconds(window.start) + seconds(window.end)) / 2);
      return Math.abs(center - anchorCenter) <= 9;
    });
    const reasons = [...new Set(cluster.flatMap(visualReasonCodesForWindow))];
    const goalEvidence = goalEvidenceForContext({ reasons, visualWindows: cluster, center: anchorCenter });
    if (!["strong", "medium"].includes(goalEvidence.evidenceLevel)) continue;
    const start = Number(clamp(Math.min(...cluster.map((window) => seconds(window.start))) - 2.5, 0, duration).toFixed(2));
    const end = Number(clamp(Math.max(...cluster.map((window) => seconds(window.end))) + 3.5, start + 3, duration).toFixed(2));
    const reasonCodes = reasonCodesWithGoalEvidence(reasons, goalEvidence);
    const base = scoreReasons(reasonCodes) + 0.08;
    const moment = normalizeMomentWithEvidence({
      id: `mom_goal_sequence_${moments.length + 1}`,
      rank: moments.length + 1,
      start,
      end,
      center: Number(((start + end) / 2).toFixed(2)),
      title: titleForHighlightType(highlightTypeForReasons(reasonCodes)),
      summary: goalEvidence.goalClaimAllowed
        ? "Detected from explicit goal sequence evidence."
        : "Detected from goal-mouth action sequence without final goal claim.",
      reasonCodes,
      highlightType: highlightTypeForReasons(reasonCodes),
      confidence: Number(clamp(base, 0.12, 0.95).toFixed(2)),
      retentionScore: Math.round(clamp(base, 0.12, 0.95) * 100),
      suggestedPreset: preset,
      source: "vision_goal_sequence",
    }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset });
    moments.push(moment);
    if (moments.length >= 2) break;
  }
  return moments;
}

function detectHighlights({ transcript, signals, visualSignals, preset = "hype" } = {}) {
  const safeSignals = signals || { durationSeconds: 18, audioPeaks: [], sceneChanges: [] };
  const duration = seconds(safeSignals.durationSeconds || 18);
  const safeVisualSignals = validateVisualSignals(
    visualSignals || safeSignals.visualSignals || { providerMode: "mock", fallbackUsed: true, windows: [] },
    safeSignals,
  );
  const captions = normalizedCaptions(transcript);
  const captionMoments = captions.map((caption, index) => {
    const center = clamp((caption.start + caption.end) / 2, 0, duration);
    const start = Number(clamp(center - 4, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(Math.max(center + 5, start + 6), start + 3, duration).toFixed(2));
    const reasonCodes = reasonCodesForCaption(caption, safeSignals, safeVisualSignals);
    const highlightType = highlightTypeForReasons(reasonCodes);
    const score = scoreReasons(reasonCodes);
    const moment = normalizeMomentWithEvidence({
      id: `mom_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center: Number(center.toFixed(2)),
      title: titleForHighlightType(highlightType),
      summary: caption.text,
      reasonCodes,
      highlightType,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: reasonCodes.includes("counter_attack") || reasonCodes.includes("skill_move") ? "tactical" : preset,
      evidence: evidenceForReasons(reasonCodes, caption, safeSignals, center, safeVisualSignals, { start, end }),
      captionIntent: captionIntentForHighlightType(highlightType),
      rankingExplanation: rankingExplanationForMoment({ reasons: reasonCodes, score, source: "analysis", visualSignals: safeVisualSignals }),
      source: "analysis",
      _caption: caption,
    }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset });
    return moment;
  });

  const signalOnlyMoments = (safeSignals.audioPeaks || []).slice(0, 4).map((peak, index) => {
    const center = clamp(peak.time, 0, duration);
    const start = Number(clamp(center - 4, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(start + 8, start + 3, duration).toFixed(2));
    const reasonCodes = [
      "audio_energy_spike",
      Number(peak.energyScore || 0) >= 0.88 ? "crowd_spike" : "",
      nearby(safeSignals.sceneChanges, center, 3).length ? "scene_change_cluster" : "",
      ...visualReasonCodesNear(safeVisualSignals, center, 3),
    ].filter(Boolean);
    const highlightType = highlightTypeForReasons(reasonCodes);
    const score = scoreReasons(reasonCodes) - 0.04;
    return normalizeMomentWithEvidence({
      id: `mom_signal_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center: Number(center.toFixed(2)),
      title: titleForHighlightType(highlightType),
      summary: "Detected from media signals.",
      reasonCodes,
      highlightType,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: preset,
      hook: hookForHighlightType(highlightType, preset),
      evidence: evidenceForReasons(reasonCodes, null, safeSignals, center, safeVisualSignals, { start, end }),
      captionIntent: captionIntentForHighlightType(highlightType),
      rankingExplanation: rankingExplanationForMoment({ reasons: reasonCodes, score, source: "signals", visualSignals: safeVisualSignals }),
      source: "analysis",
    }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset });
  });

  const visualOnlyMoments = safeVisualSignals.windows.slice(0, 4).map((window, index) => {
    const center = clamp(window.center, 0, duration);
    const start = Number(clamp(window.start, 0, Math.max(0, duration - 3)).toFixed(2));
    const end = Number(clamp(window.end, start + 3, duration).toFixed(2));
    const reasonCodes = [
      ...visualReasonCodesForWindow(window),
      visualReasonCodesForWindow(window).includes("visual_replay_indicator") ? "replay_worthy_moment" : "",
    ].filter(Boolean);
    const highlightType = visualHighlightTypeForReasons(reasonCodes);
    const score = scoreReasons(reasonCodes) + Number(window.confidence || 0) * 0.16;
    return normalizeMomentWithEvidence({
      id: `mom_visual_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center: Number(center.toFixed(2)),
      title: titleForHighlightType(highlightType),
      summary: "Detected from safe visual motion signals.",
      reasonCodes,
      highlightType,
      confidence: Number(clamp(score, 0.12, 0.9).toFixed(2)),
      retentionScore: Math.round(clamp(score, 0.12, 0.9) * 100),
      suggestedPreset: highlightType === "counter_attack" ? "tactical" : preset,
      hook: hookForHighlightType(highlightType, preset),
      evidence: evidenceForReasons(reasonCodes, null, safeSignals, center, safeVisualSignals, { start, end }),
      captionIntent: captionIntentForHighlightType(highlightType),
      rankingExplanation: rankingExplanationForMoment({ reasons: reasonCodes, score, source: "vision", visualSignals: safeVisualSignals }),
      source: "vision",
    }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset });
  });

  const goalSequenceMoments = createGoalSequenceMoments(safeVisualSignals, safeSignals, captions, preset);

  const merged = [...goalSequenceMoments, ...captionMoments, ...signalOnlyMoments, ...visualOnlyMoments]
    .filter((moment) => moment.end - moment.start >= 3)
    .sort((a, b) => b.retentionScore - a.retentionScore || a.start - b.start);
  const deduped = [];
  for (const moment of merged) {
    if (deduped.some((existing) => Math.abs(existing.center - moment.center) < 2.5)) continue;
    deduped.push({ ...moment, rank: deduped.length + 1 });
    if (deduped.length >= 7) break;
  }
  const moments = deduped.length ? deduped : createFallbackMoments(safeSignals, preset, safeVisualSignals);
  const rankedMoments = moments.map((moment, index) => ({
    ...moment,
    rank: index + 1,
    rankingExplanation: {
      ...(moment.rankingExplanation || rankingExplanationForMoment({
        reasons: moment.reasonCodes || [],
        score: Number(moment.confidence || 0),
        source: moment.source,
        visualSignals: safeVisualSignals,
      })),
      selectedAsPrimary: index === 0,
    },
  }));
  return {
    fallback: rankedMoments.every((moment) => moment.source === "fallback"),
    explainability: {
      selectedMomentId: rankedMoments[0] ? rankedMoments[0].id : null,
      selectedHighlightType: rankedMoments[0] ? rankedMoments[0].highlightType : null,
      selectedBecause: rankedMoments[0] ? rankedMoments[0].rankingExplanation.boostCues : [],
      fallbackUsed: rankedMoments.every((moment) => moment.source === "fallback"),
      goalClaimRejected: rankedMoments.some((moment) => (
        moment.rankingExplanation &&
        Array.isArray(moment.rankingExplanation.rejectedClaims) &&
        moment.rankingExplanation.rejectedClaims.includes("goal_claim_rejected_without_explicit_goal_evidence")
      )),
    },
    moments: rankedMoments.map((moment, index) => ({
      ...moment,
      rank: index + 1,
      captionBeats: captionBeatsForMoment(moment, captions, moment.suggestedPreset || preset),
    })),
  };
}

function effectsForReasons(reasons) {
  const effects = ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "brand_safe_template"];
  if (reasons.includes("audio_energy_spike") || reasons.includes("audio_peak")) effects.push("beat_sync_pulse");
  if (reasons.includes("scene_change_cluster")) effects.push("scene_snap_zoom");
  if (reasons.includes("counter_attack") || reasons.includes("skill_move") || reasons.includes("visual_fast_break")) {
    effects.push("action_lane_emphasis");
  }
  if (
    reasons.includes("visual_shot_like_motion") ||
    reasons.includes("visual_shot_contact") ||
    reasons.includes("visual_ball_toward_goal") ||
    reasons.includes("visual_save_like_motion") ||
    reasons.includes("visual_keeper_action")
  ) effects.push("subtle_punch_in");
  if (reasons.includes("visual_foul_like_contact")) effects.push("impact_freeze_frame");
  if (reasons.includes("visual_crowd_reaction") || reasons.includes("crowd_spike")) effects.push("beat_sync_pulse");
  if (reasons.includes("replay_worthy_moment") || reasons.includes("visual_replay_indicator")) effects.push("replay_stutter");
  return [...new Set(effects)];
}

function visualEvidenceSummaryForMoment(moment) {
  const visual = moment && moment.evidence && moment.evidence.visual;
  if (!visual || typeof visual !== "object") {
    return {
      providerMode: "mock",
      fallbackUsed: true,
      windowCount: 0,
      topTypes: [],
      reasonCodes: [],
      actionFocusConfidence: 0,
      goalClaimAllowed: false,
    };
  }
  return {
    providerMode: sanitizeText(visual.providerMode || "mock", 40),
    fallbackUsed: Boolean(visual.fallbackUsed),
    windowCount: Math.max(0, Number(visual.windowCount || 0)),
    topTypes: Array.isArray(visual.topTypes) ? visual.topTypes.map((type) => sanitizeText(type, 48)).filter(Boolean).slice(0, 8) : [],
    reasonCodes: Array.isArray(visual.reasonCodes)
      ? visual.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 8)
      : [],
    actionFocusConfidence: Number(clamp(visual.actionFocusConfidence, 0, 1).toFixed(2)),
    goalClaimAllowed: false,
  };
}

function actionSequenceSummaryForMoment(moment) {
  const sequence = moment && moment.evidence && moment.evidence.actionSequence;
  if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) {
    return actionSequenceForReasons(moment && moment.reasonCodes || [], moment && moment.evidence && moment.evidence.goalEvidence || {});
  }
  return {
    buildUp: Boolean(sequence.buildUp),
    shotOrContact: Boolean(sequence.shotOrContact),
    ballTrajectory: Boolean(sequence.ballTrajectory),
    goalmouthOrKeeper: Boolean(sequence.goalmouthOrKeeper),
    payoff: Boolean(sequence.payoff),
    reactionSupport: Boolean(sequence.reactionSupport),
    replaySupport: Boolean(sequence.replaySupport),
    reactionOnly: Boolean(sequence.reactionOnly),
    actionStageCount: Math.max(0, Math.min(5, Math.round(Number(sequence.actionStageCount || 0)))),
    primaryEvidence: sanitizeText(sequence.primaryEvidence || "weak_context", 40),
    goalEvidenceLevel: sanitizeText(sequence.goalEvidenceLevel || "none", 24),
    goalClaimAllowed: Boolean(sequence.goalClaimAllowed),
  };
}

function framingReasonForVisualSummary(summary) {
  if (!summary || !summary.windowCount) return "wide_safe_default_no_visual_tracking";
  if (summary.actionFocusConfidence < 0.82) return "wide_safe_visual_context_low_confidence";
  return "wide_safe_visual_context_no_object_tracking";
}

function audioEvidenceSummaryForMoment(moment, mediaSignals = {}) {
  const audioPeaks = Array.isArray(mediaSignals && mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : [];
  const start = seconds(moment && moment.start);
  const end = seconds(moment && moment.end);
  const nearbyPeaks = audioPeaks.filter((peak) => seconds(peak.time) >= start - 0.5 && seconds(peak.time) <= end + 0.5);
  const maxEnergyScore = nearbyPeaks.length
    ? Math.max(...nearbyPeaks.map((peak) => seconds(peak.energyScore)))
    : 0;
  return {
    audioPeakCount: nearbyPeaks.length,
    maxEnergyScore: Number(maxEnergyScore.toFixed(2)),
    crowdOrCommentaryEvidence: Boolean((moment && moment.reasonCodes || []).some((reason) => (
      ["audio_energy_spike", "crowd_spike", "commentary_peak", "crowd_reaction"].includes(reason)
    ))),
  };
}

function planHasGoalLanguageSafe(plan) {
  const captionTexts = Array.isArray(plan && plan.captions) ? plan.captions.map((caption) => caption.text) : [];
  return [plan && plan.hook, ...captionTexts].some(hasGoalLanguage);
}

function goalOutcomeForMoment(moment = {}) {
  return normalizeGoalOutcome(moment && moment.evidence && moment.evidence.goalOutcome, {
    highlightType: moment.highlightType || highlightTypeForReasons(moment.reasonCodes || []),
    reasonCodes: Array.isArray(moment.reasonCodes) ? moment.reasonCodes : [],
  });
}

function hookForGoalOutcome(goalOutcome = {}, fallback = "BALL IN THE NET") {
  const hooks = {
    confirmed_goal: "GOAL CONFIRMED",
    disallowed_offside: "OFFSIDE - NO GOAL",
    possible_offside: "WAS HE OFF?",
    unknown_decision: "BALL IN THE NET",
  };
  return hooks[goalOutcome.outcome] || fallback;
}

function captionsForGoalOutcome({ goalOutcome, duration, preset, highlightType, reasonCodes }) {
  if (!goalOutcome || goalOutcome.eventType !== "ball_in_net") return null;
  return createFallbackCaptions(duration, preset, {
    highlightType,
    reasonCodes,
    goalOutcome,
    goalEvidence: goalOutcome.outcome === "confirmed_goal",
  });
}

function visualQaForPlan(plan = {}) {
  const cropPlan = plan.cropPlan && typeof plan.cropPlan === "object" ? plan.cropPlan : null;
  const tracking = plan.visualTrackingSummary && typeof plan.visualTrackingSummary === "object" ? plan.visualTrackingSummary : {};
  const actionZones = cropPlan && Array.isArray(cropPlan.actionSafeZones) ? cropPlan.actionSafeZones : [];
  const actionSafeZoneCoverage = cropPlan && cropPlan.safeArea && actionZones.length
    ? (actionZones.every((zone) => containsBox(cropPlan.safeArea, zone)) ? 1 : 0)
    : 1;
  const softFollowAllowed = Boolean(cropPlan && cropPlan.mode === "soft_follow" && !cropPlan.fallbackUsed && !cropPlan.textObstructionRisk);
  const fallbackReason = cropPlan && Array.isArray(cropPlan.reasonCodes) ? cropPlan.reasonCodes[0] || null : null;
  return {
    selectedCropMode: cropPlan ? cropPlan.mode : "wide_safe",
    trackingProviderMode: sanitizeText(tracking.trackingProviderMode || "visual-tracking-heuristic", 60),
    trackingConfidence: Number(tracking.trackingConfidence || 0),
    ballVisibilityConfidence: Number(tracking.ballCandidateConfidence || 0),
    playerClusterConfidence: Number(tracking.playerClusterConfidence || 0),
    ballTrackCount: Number(tracking.ballTrackCount || 0),
    playerClusterCount: Number(tracking.playerClusterCount || 0),
    actionSafeZoneCoverage,
    captionObstructionRisk: Boolean(cropPlan && cropPlan.textObstructionRisk),
    fallbackReason,
    softFollowAllowed,
    softFollowBlockedReason: softFollowAllowed ? null : fallbackReason || "wide_safe_default",
    goalClaimAllowed: false,
  };
}

function reviewMetadataForPlan(plan, moment, mediaSignals = {}) {
  return {
    renderStylePreset: plan.stylePreset,
    captionRoles: Array.isArray(plan.captions) ? plan.captions.map((caption) => caption.role) : [],
    animationCueTypes: Array.isArray(plan.animationCues) ? [...new Set(plan.animationCues.map((cue) => cue.type).filter(Boolean))] : [],
    targetAspectRatio: plan.aspectRatio,
    highlightType: plan.highlightType,
    forbiddenClaimChecks: {
      goalLanguage: planHasGoalLanguageSafe(plan),
      goalEvidence: plan.highlightType === "goal" && Array.isArray(plan.reasonCodes) && plan.reasonCodes.includes("goal"),
    },
    framingMode: plan.framingMode,
    cropPlan: plan.cropPlan
      ? {
          mode: plan.cropPlan.mode,
          confidence: plan.cropPlan.confidence,
          fallbackUsed: plan.cropPlan.fallbackUsed,
          reasonCodes: plan.cropPlan.reasonCodes,
          textObstructionRisk: Boolean(plan.cropPlan.textObstructionRisk),
      }
      : null,
    visualTrackingSummary: plan.visualTrackingSummary || null,
    visualQA: plan.visualQA || visualQaForPlan(plan),
    visualEvidenceSummary: plan.visualEvidenceSummary || null,
    actionSequenceSummary: plan.actionSequenceSummary || actionSequenceSummaryForMoment(moment),
    goalOutcome: plan.goalOutcome || goalOutcomeForMoment(moment),
    audioEvidenceSummary: audioEvidenceSummaryForMoment(moment, mediaSignals),
    captionGeneration: plan.footballStoryPlan && plan.footballStoryPlan.captionGeneration
      ? plan.footballStoryPlan.captionGeneration
      : null,
  };
}

const MULTI_MOMENT_COMPILATION = Object.freeze({
  minSourceDuration: 45,
  minSegments: 3,
  maxSegments: 7,
  minTotalDuration: 35,
  maxTotalDuration: 60,
});

const PRIMARY_MULTI_MOMENT_TYPES = Object.freeze([
  "goal",
  "big_chance",
  "shot_on_target",
  "near_miss",
  "save",
  "hard_foul",
  "foul",
  "card_moment",
  "counter_attack",
  "skill_move",
  "replay_worthy_moment",
]);

function momentSuppressedCues(moment = {}) {
  return moment.rankingExplanation && Array.isArray(moment.rankingExplanation.suppressedCues)
    ? moment.rankingExplanation.suppressedCues
    : [];
}

function hasPrimaryMomentAction(moment = {}) {
  const highlightType = sanitizeText(moment.highlightType || "", 40);
  const reasonCodes = Array.isArray(moment.reasonCodes) ? moment.reasonCodes : [];
  const reasonSet = new Set(reasonCodes);
  return PRIMARY_MULTI_MOMENT_TYPES.includes(highlightType) ||
    PRIMARY_ACTION_REASONS.some((reason) => reasonSet.has(reason));
}

function isOpeningFillerMoment(moment = {}) {
  return momentSuppressedCues(moment).includes("opening_context_without_action") && !hasPrimaryMomentAction(moment);
}

function isReactionOnlyMoment(moment = {}) {
  const summary = actionSequenceSummaryForMoment(moment);
  if (summary.reactionOnly) return true;
  const reasonCodes = Array.isArray(moment.reasonCodes) ? moment.reasonCodes : [];
  const reasonSet = new Set(reasonCodes);
  return REACTION_CONTEXT_REASONS.some((reason) => reasonSet.has(reason)) && !hasPrimaryMomentAction(moment);
}

function compilationSelectionScore(candidate = {}) {
  const moment = candidate.analysisMoment || {};
  const actionSummary = candidate.actionSequenceSummary || actionSequenceSummaryForMoment(moment);
  const actionBoost = hasPrimaryMomentAction(moment) ? 18 : 0;
  const replayBoost = candidate.highlightType === "replay_worthy_moment" ? 8 : 0;
  const reactionPenalty = isReactionOnlyMoment(moment) ? 9 : 0;
  const openingPenalty = isOpeningFillerMoment(moment) ? 100 : 0;
  const sequenceBoost = Number(actionSummary.actionStageCount || 0) * 2;
  return Number(candidate.retentionScore || 0) + actionBoost + replayBoost + sequenceBoost - reactionPenalty - openingPenalty;
}

function sourceOverlapRatio(a = {}, b = {}) {
  const left = Math.max(Number(a.sourceStart || 0), Number(b.sourceStart || 0));
  const right = Math.min(Number(a.sourceEnd || 0), Number(b.sourceEnd || 0));
  const overlap = Math.max(0, right - left);
  const duration = Math.max(0.1, Math.min(
    Number(a.sourceEnd || 0) - Number(a.sourceStart || 0),
    Number(b.sourceEnd || 0) - Number(b.sourceStart || 0),
  ));
  return overlap / duration;
}

function uniqueReasonCodes(candidates = []) {
  return [...new Set(candidates.flatMap((candidate) => (
    Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : []
  )))].filter((reason) => reason !== "goal").slice(0, 18);
}

function segmentWhySelected(candidate = {}) {
  const moment = candidate.analysisMoment || {};
  if (hasPrimaryMomentAction(moment)) return "Action evidence selected before reaction payoff.";
  if (candidate.highlightType === "replay_worthy_moment") return "Replay context selected as supporting football detail.";
  if (isReactionOnlyMoment(moment)) return "Reaction included only with the action lead-in window.";
  return "Selected as a bounded football phase.";
}

function segmentSafetyFlags(candidate = {}) {
  const flags = [];
  const moment = candidate.analysisMoment || {};
  if (isOpeningFillerMoment(moment)) flags.push("opening_context_without_action");
  if (isReactionOnlyMoment(moment)) flags.push("reaction_support_only");
  if (candidate.framingMode === "wide_safe_vertical") flags.push("wide_safe_full_frame");
  if (candidate.highlightType !== "goal") flags.push("no_goal_claim_without_evidence");
  return flags;
}

function segmentCaptionText(segment, index) {
  const phase = `PHASE ${index + 1}`;
  const outcome = segment && segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
    ? segment.goalOutcome.outcome
    : null;
  if (outcome === "confirmed_goal") return `${phase}: GOAL CONFIRMED`;
  if (outcome === "disallowed_offside") return `${phase}: OFFSIDE - NO GOAL`;
  if (outcome === "possible_offside") return `${phase}: WAS HE OFF?`;
  if (outcome === "unknown_decision") return `${phase}: BALL IN THE NET`;
  const labels = {
    goal: `${phase}: BALL IN THE NET`,
    big_chance: `${phase}: THE CHANCE OPENS`,
    shot_on_target: `${phase}: SHOT UNDER PRESSURE`,
    near_miss: `${phase}: SO CLOSE`,
    save: `${phase}: KEEPER REACTS`,
    foul: `${phase}: CONTACT CHANGES TEMPO`,
    hard_foul: `${phase}: HEAVY CONTACT`,
    card_moment: `${phase}: REFEREE DECISION`,
    counter_attack: `${phase}: SPACE OPENS FAST`,
    skill_move: `${phase}: ONE TOUCH OPENS IT`,
    replay_worthy_moment: `${phase}: REPLAY THE DETAIL`,
    crowd_reaction: `${phase}: REACTION AFTER THE PLAY`,
    commentator_peak: `${phase}: THE CALL FOLLOWS THE ACTION`,
    audio_energy_spike: `${phase}: ENERGY AFTER THE PHASE`,
    unknown_action: `${phase}: PRESSURE BUILDS`,
    generic_highlight: `${phase}: PLAY DEVELOPS`,
  };
  return labels[segment.highlightType] || labels.generic_highlight;
}

function captionsForCompilation(segments, totalDuration) {
  const captions = [{
    start: 0,
    end: Math.min(2.2, totalDuration),
    text: "BEST PHASES ONLY",
    role: "opening_hook",
    emphasis: "shout",
    layout: "center",
    captionIntent: "multi_moment_hook",
    captionSource: "multi_moment_builder:opening_hook",
    captionEvidence: {
      alignedHighlightType: "generic_highlight",
      highlightType: "generic_highlight",
      reasonCodes: ["generic_highlight"],
      visualReasonCodes: [],
      goalEvidence: false,
      role: "opening_hook",
    },
    captionRiskFlags: [],
  }];
  for (const [index, segment] of segments.entries()) {
    const start = Number(Math.min(segment.timelineEnd - 0.5, segment.timelineStart + 0.45).toFixed(2));
    const end = Number(Math.min(segment.timelineEnd, start + Math.min(3.2, Math.max(1.4, segment.duration - 0.7))).toFixed(2));
    if (end <= start) continue;
    const role = index === segments.length - 1 ? "reaction" : "action_callout";
    captions.push({
      start,
      end,
      text: segmentCaptionText(segment, index),
      role,
      emphasis: role === "reaction" ? "strong" : "strong",
      layout: "bottom",
      captionIntent: captionIntentForHighlightType(segment.highlightType, role),
      captionSource: `multi_moment_builder:${segment.highlightType}:${index + 1}`,
      captionEvidence: {
        alignedHighlightType: segment.highlightType,
        highlightType: segment.highlightType,
        reasonCodes: segment.reasonCodes,
        visualReasonCodes: segment.reasonCodes.filter((reason) => /^visual_/.test(reason)),
        goalEvidence: segment.goalOutcome && segment.goalOutcome.outcome === "confirmed_goal",
        goalOutcome: segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
          ? { outcome: segment.goalOutcome.outcome, offsideStatus: segment.goalOutcome.offsideStatus }
          : null,
        role,
      },
      captionRiskFlags: Array.isArray(segment.captionSafetyFlags)
        ? segment.captionSafetyFlags
        : segment.goalOutcome && segment.goalOutcome.outcome === "disallowed_offside"
          ? ["offside_decision_context"]
          : segment.goalOutcome && ["possible_offside", "unknown_decision"].includes(segment.goalOutcome.outcome)
            ? ["goal_outcome_uncertain"]
            : [],
    });
  }
  captions.push({
    start: Math.max(0, Number((totalDuration - 2.4).toFixed(2))),
    end: totalDuration,
    text: "RUN THE WHOLE SEQUENCE BACK",
    role: "closing_punch",
    emphasis: "strong",
    layout: "bottom",
    captionIntent: "multi_moment_replay_prompt",
    captionSource: "multi_moment_builder:closing_punch",
    captionEvidence: {
      alignedHighlightType: "generic_highlight",
      highlightType: "generic_highlight",
      reasonCodes: ["replay_worthy_moment"],
      visualReasonCodes: [],
      goalEvidence: false,
      role: "closing_punch",
    },
    captionRiskFlags: [],
  });
  return captions;
}

function animationCuesForCompilation(segments, totalDuration, reasonCodes = []) {
  const cues = createAnimationCues(totalDuration, reasonCodes);
  for (const segment of segments.slice(1, 5)) {
    const boundary = Math.max(0.1, Number(segment.timelineStart || 0));
    cues.push({
      type: "beat_cut",
      start: Number(Math.max(0, boundary - 0.08).toFixed(2)),
      end: Number(Math.min(totalDuration, boundary + 0.28).toFixed(2)),
    });
  }
  return cues.filter((cue) => cue.end > cue.start).slice(0, 10);
}

function selectCompilationCandidates(singleCandidates = [], metadata = {}) {
  const mediaDuration = Number(metadata.durationSeconds || 0);
  if (mediaDuration < MULTI_MOMENT_COMPILATION.minSourceDuration) return [];
  const selected = [];
  let totalDuration = 0;
  const ranked = singleCandidates
    .filter((candidate) => candidate && !isOpeningFillerMoment(candidate.analysisMoment))
    .sort((a, b) => compilationSelectionScore(b) - compilationSelectionScore(a) || a.sourceStart - b.sourceStart);
  for (const candidate of ranked) {
    if (selected.some((existing) => sourceOverlapRatio(existing, candidate) > 0.35)) continue;
    const duration = Number((candidate.sourceEnd - candidate.sourceStart).toFixed(2));
    if (duration < 3) continue;
    if (totalDuration + duration > MULTI_MOMENT_COMPILATION.maxTotalDuration) {
      if (totalDuration >= MULTI_MOMENT_COMPILATION.minTotalDuration) continue;
      const remaining = Number((MULTI_MOMENT_COMPILATION.maxTotalDuration - totalDuration).toFixed(2));
      if (remaining < 6) continue;
      selected.push({ ...candidate, sourceEnd: Number((candidate.sourceStart + remaining).toFixed(2)) });
      totalDuration += remaining;
      break;
    }
    selected.push(candidate);
    totalDuration += duration;
    if (selected.length >= MULTI_MOMENT_COMPILATION.maxSegments || totalDuration >= MULTI_MOMENT_COMPILATION.minTotalDuration) {
      const actionCount = selected.filter((item) => hasPrimaryMomentAction(item.analysisMoment)).length;
      if (selected.length >= MULTI_MOMENT_COMPILATION.minSegments && (actionCount > 0 || selected.length >= 3)) break;
    }
  }
  const chronological = selected.sort((a, b) => a.sourceStart - b.sourceStart);
  const finalDuration = chronological.reduce((sum, candidate) => sum + Number(candidate.sourceEnd - candidate.sourceStart), 0);
  if (chronological.length < MULTI_MOMENT_COMPILATION.minSegments) return [];
  if (finalDuration < MULTI_MOMENT_COMPILATION.minTotalDuration) return [];
  return chronological.slice(0, MULTI_MOMENT_COMPILATION.maxSegments);
}

function createMultiMomentCompilationPlan({ singleCandidates, metadata, title, renderStylePreset, styleTarget, editIntensity, mediaSignals }) {
  const selectedCandidates = selectCompilationCandidates(singleCandidates, metadata);
  if (!selectedCandidates.length) return null;
  let cursor = 0;
  const segments = selectedCandidates.map((candidate, index) => {
    const duration = Number((candidate.sourceEnd - candidate.sourceStart).toFixed(2));
    const timelineStart = Number(cursor.toFixed(2));
    cursor += duration;
    const moment = candidate.analysisMoment || {};
    return {
      id: sanitizeText(candidate.candidateId || moment.id || `multi_segment_${index + 1}`, 64),
      sourceStart: Number(candidate.sourceStart.toFixed(2)),
      sourceEnd: Number(candidate.sourceEnd.toFixed(2)),
      duration,
      timelineStart,
      timelineEnd: Number(cursor.toFixed(2)),
      highlightType: candidate.highlightType,
      reasonCodes: Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : [],
      goalOutcome: candidate.goalOutcome || goalOutcomeForMoment(moment),
      confidence: candidate.confidence,
      retentionScore: candidate.retentionScore,
      captionTheme: captionIntentForHighlightType(candidate.highlightType),
      actionSequenceSummary: candidate.actionSequenceSummary || actionSequenceSummaryForMoment(moment),
      whySelected: segmentWhySelected(candidate),
      safetyFlags: segmentSafetyFlags(candidate),
      captionSafetyFlags: candidate.goalOutcome && Array.isArray(candidate.goalOutcome.captionSafetyFlags)
        ? candidate.goalOutcome.captionSafetyFlags
        : [],
    };
  });
  const totalDuration = Number(cursor.toFixed(2));
  const reasonCodes = uniqueReasonCodes(selectedCandidates);
  const captions = captionsForCompilation(segments, totalDuration);
  const primary = selectedCandidates.find((candidate) => hasPrimaryMomentAction(candidate.analysisMoment)) || selectedCandidates[0];
  const baseCropPlan = primary.cropPlan || calibrateCropPlan({ metadata, targetAspectRatio: primary.aspectRatio || "9:16" });
  const cropPlan = {
    ...baseCropPlan,
    mode: baseCropPlan.mode === "soft_follow" ? "wide_safe" : baseCropPlan.mode,
    fallbackUsed: true,
    reasonCodes: [...new Set([...(baseCropPlan.reasonCodes || []), "multi_moment_wide_safe_default"])].slice(0, 8),
  };
  const plan = {
    mode: "multi_moment_compilation",
    sourceStart: segments[0].sourceStart,
    sourceEnd: Math.max(...segments.map((segment) => segment.sourceEnd)),
    segments,
    totalDuration,
    aspectRatio: primary.aspectRatio || "9:16",
    highlightType: "generic_highlight",
    confidence: Number(clamp(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0) / selectedCandidates.length, 0, 1).toFixed(2)),
    hook: "BEST PHASES ONLY",
    title: sanitizeText(title, 120),
    captions,
    effects: [...new Set(selectedCandidates.flatMap((candidate) => candidate.effects || []))].slice(0, 8),
    framingMode: "wide_safe_vertical",
    framingReason: "wide_safe_multi_moment_preserves_ball_players",
    actionFocusConfidence: Math.max(...selectedCandidates.map((candidate) => Number(candidate.actionFocusConfidence || 0))),
    visualEvidenceSummary: primary.visualEvidenceSummary,
    visualTrackingSummary: primary.visualTrackingSummary,
    actionSequenceSummary: {
      ...actionSequenceSummaryForMoment(primary.analysisMoment || {}),
      multiMomentSegmentCount: segments.length,
      reactionOnly: false,
    },
    cropPlan,
    cropStrategy: createCropStrategy(metadata, "wide_safe_vertical"),
    visualQA: null,
    stylePreset: renderStylePreset,
    styleTarget,
    editIntensity,
    footballStoryPlan: {
      storyType: "multi_moment_compilation",
      primarySubject: sanitizeText(title, 96),
      hook: "BEST PHASES ONLY",
      contextLine: `${segments.length} selected phases in match order`,
      selectedMoment: {
        id: "multi_moment_compilation",
        start: segments[0].sourceStart,
        end: Math.max(...segments.map((segment) => segment.sourceEnd)),
        originalStart: segments[0].sourceStart,
        originalEnd: Math.max(...segments.map((segment) => segment.sourceEnd)),
        highlightType: "generic_highlight",
        reasonCodes,
        actionSequenceSummary: null,
      },
      supportingMoments: segments.map((segment) => ({
        id: segment.id,
        highlightType: segment.highlightType,
        start: segment.sourceStart,
        end: segment.sourceEnd,
        goalOutcome: segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
          ? {
              outcome: segment.goalOutcome.outcome,
              offsideStatus: segment.goalOutcome.offsideStatus,
            }
          : null,
      })),
      captionBeats: captions,
      captionGeneration: {
        providerMode: "deterministic_multi_moment",
        fallbackUsed: false,
        warnings: [],
      },
      framingIntent: {
        mode: "wide_safe_vertical",
        aspectRatio: primary.aspectRatio || "9:16",
        punchInAllowed: false,
        reason: "wide_safe_multi_moment_preserves_ball_players",
        actionFocusConfidence: Math.max(...selectedCandidates.map((candidate) => Number(candidate.actionFocusConfidence || 0))),
      },
      animationIntent: {
        intensity: editIntensity,
        cueTypes: animationCuesForCompilation(segments, totalDuration, reasonCodes).map((cue) => cue.type),
        maxCueCount: 10,
        excessiveFlashingGuard: true,
        evidenceAlignedOnly: true,
      },
      animationCues: animationCuesForCompilation(segments, totalDuration, reasonCodes),
      aspectRatio: primary.aspectRatio || "9:16",
      export: primary.export,
      confidence: Number(clamp(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0) / selectedCandidates.length, 0, 1).toFixed(2)),
      safetyNotes: [
        "Compilation excludes opening context without action evidence.",
        "Reaction moments are included only with action lead-in windows.",
        "Goal language is not used without explicit goal evidence.",
      ],
      captionEmphasis: createCaptionEmphasis(captions, "generic_highlight"),
      cropStrategy: createCropStrategy(metadata, "wide_safe_vertical"),
      styleTarget,
      editIntensity,
    },
    captionEmphasis: createCaptionEmphasis(captions, "generic_highlight"),
    animationCues: animationCuesForCompilation(segments, totalDuration, reasonCodes),
    safetyNotes: [
      "Multi-moment compilation keeps selected phases in chronological order.",
      "Opening ceremony and generic intro context are excluded unless action evidence is present.",
      "Reaction-only evidence is treated as support and rendered with lead-in.",
      "Wide-safe framing preserves ball/player context across all segments.",
    ],
    candidateId: "multi_moment_compilation",
    rank: 1,
    retentionScore: Math.round(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.retentionScore || 0), 0) / selectedCandidates.length),
    reasonCodes,
    analysisMoment: {
      id: "multi_moment_compilation",
      title: "Multi-moment football compilation",
      summary: `${segments.length} selected phases in chronological order.`,
      confidence: Number(clamp(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0) / selectedCandidates.length, 0, 1).toFixed(2)),
      highlightType: "generic_highlight",
      retentionScore: Math.round(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.retentionScore || 0), 0) / selectedCandidates.length),
      reasonCodes,
      evidence: null,
      visualTrackingSummary: primary.visualTrackingSummary,
      actionSequenceSummary: null,
      captionIntent: "multi_moment_compilation",
      source: "multi_moment_builder",
    },
    export: {
      ...primary.export,
    },
  };
  const validated = validateEditPlan(plan, metadata);
  validated.visualQA = visualQaForPlan(validated);
  return {
    ...validated,
    reviewMetadata: {
      ...reviewMetadataForPlan(validated, primary.analysisMoment || {}, mediaSignals),
      multiMoment: {
        segmentCount: segments.length,
        totalDuration,
        segmentTimestamps: segments.map((segment) => ({
          sourceStart: segment.sourceStart,
          sourceEnd: segment.sourceEnd,
          highlightType: segment.highlightType,
          goalOutcome: segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
            ? {
                outcome: segment.goalOutcome.outcome,
                offsideStatus: segment.goalOutcome.offsideStatus,
                decisionTimestamp: segment.goalOutcome.decisionTimestamp,
              }
            : null,
          whySelected: segment.whySelected,
          safetyFlags: segment.safetyFlags,
        })),
      },
    },
  };
}

function createCandidateEditPlans({
  moments,
  metadata,
  title = "ShortsEngine Short",
  preset = "hype",
  transcript = null,
  mediaSignals = null,
  visualSignals = null,
  visualTracking = null,
  language = "auto",
  styleTarget = "vertical_9_16",
  editIntensity = "balanced",
  stylePreset = "social_sports_v1",
  captionProvider = null,
} = {}) {
  const renderStylePreset = normalizeStylePreset(stylePreset);
  const singleCandidates = (Array.isArray(moments) ? moments : []).slice(0, 7).map((moment) => {
    const visualEvidenceSummary = visualEvidenceSummaryForMoment(moment);
    const visualTrackingSummary = publicVisualTrackingSummary(visualTracking || null, metadata);
    const actionSequenceSummary = actionSequenceSummaryForMoment(moment);
    const storyPlan = createFootballStoryPlan({
      title,
      language: language || (transcript && transcript.language) || "auto",
      transcript,
      mediaSignals,
      visualSignals,
      metadata,
      moments,
      selectedMoment: moment,
      visualEvidenceSummary,
      actionSequenceSummary,
      styleTarget: normalizeStyleTarget(styleTarget),
      editIntensity: normalizeEditIntensity(editIntensity),
      stylePreset: renderStylePreset,
      captionProvider,
    });
    const highlightType = storyPlan.selectedMoment.highlightType || moment.highlightType || highlightTypeForReasons(moment.reasonCodes || []);
    const duration = storyPlan.selectedMoment.end - storyPlan.selectedMoment.start;
    const goalOutcome = goalOutcomeForMoment(moment);
    const hook = sanitizeText(
      goalOutcome.eventType === "ball_in_net"
        ? hookForGoalOutcome(goalOutcome, storyPlan.hook || moment.hook || hookForHighlightType(highlightType, preset))
        : storyPlan.hook || moment.hook || hookForHighlightType(highlightType, preset),
      96,
    );
    const outcomeCaptions = captionsForGoalOutcome({
      goalOutcome,
      duration,
      preset,
      highlightType,
      reasonCodes: moment.reasonCodes || [],
    });
    const captions = outcomeCaptions || (Array.isArray(storyPlan.captionBeats) && storyPlan.captionBeats.length
      ? storyPlan.captionBeats
      : createFallbackCaptions(duration, preset, { highlightType, hook }));
    const framingMode = storyPlan.framingIntent.mode || framingModeForMetadata(metadata);
    const actionFocusConfidence = visualEvidenceSummary.actionFocusConfidence;
    const framingReason = storyPlan.framingIntent.reason || framingReasonForVisualSummary(visualEvidenceSummary);
    const cropPlan = calibrateCropPlan({
      metadata,
      trackingSummary: visualTrackingSummary,
      candidateMoment: moment,
      targetAspectRatio: storyPlan.aspectRatio,
      captions,
    });
    const captionEmphasis = Array.isArray(storyPlan.captionEmphasis) && storyPlan.captionEmphasis.length
      ? storyPlan.captionEmphasis
      : createCaptionEmphasis(captions, highlightType);
    const animationCues = Array.isArray(storyPlan.animationCues) && storyPlan.animationCues.length
      ? storyPlan.animationCues
      : createAnimationCues(duration, moment.reasonCodes || []);
    const plan = {
      sourceStart: storyPlan.selectedMoment.start,
      sourceEnd: storyPlan.selectedMoment.end,
      aspectRatio: storyPlan.aspectRatio,
      highlightType,
      goalOutcome,
      confidence: storyPlan.confidence || moment.confidence,
      hook,
      title: sanitizeText(title, 120),
      captions,
      effects: effectsForReasons(moment.reasonCodes || []),
      framingMode,
      framingReason,
      actionFocusConfidence,
      visualEvidenceSummary,
      visualTrackingSummary,
      actionSequenceSummary,
      cropPlan,
      cropStrategy: cropStrategyFromPlan(cropPlan, metadata) || storyPlan.cropStrategy || createCropStrategy(metadata, framingMode),
      visualQA: null,
      stylePreset: renderStylePreset,
      styleTarget: storyPlan.styleTarget,
      editIntensity: storyPlan.editIntensity,
      footballStoryPlan: storyPlan,
      captionEmphasis,
      animationCues,
      safetyNotes: [
        ...storyPlan.safetyNotes,
        "Tracking metadata is confidence-gated and falls back to wide-safe framing when uncertain.",
        "Visual signals are contextual only and never imply a goal without explicit goal evidence.",
        framingMode === "wide_safe_vertical"
          ? "Wide-safe framing keeps the full source frame visible over a blurred fill."
          : "Center framing is bounded and conservative.",
      ],
      candidateId: moment.id,
      rank: moment.rank,
      retentionScore: moment.retentionScore,
      reasonCodes: moment.reasonCodes || [],
      analysisMoment: {
        id: moment.id,
        title: moment.title,
        summary: moment.summary,
        confidence: moment.confidence,
        highlightType,
        retentionScore: moment.retentionScore,
        reasonCodes: moment.reasonCodes || [],
        evidence: moment.evidence || null,
        goalOutcome,
        visualTrackingSummary,
        actionSequenceSummary,
        captionIntent: moment.captionIntent || captionIntentForHighlightType(highlightType),
        source: moment.source,
      },
      export: {
        ...storyPlan.export,
      },
    };
    const validated = validateEditPlan(plan, metadata);
    validated.visualQA = visualQaForPlan(validated);
    return {
      ...validated,
      reviewMetadata: reviewMetadataForPlan(validated, moment, mediaSignals),
    };
  });
  if (!singleCandidates.length) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const multiMomentCandidate = createMultiMomentCompilationPlan({
    singleCandidates,
    metadata,
    title,
    renderStylePreset,
    styleTarget: normalizeStyleTarget(styleTarget),
    editIntensity: normalizeEditIntensity(editIntensity),
    mediaSignals,
  });
  const candidates = multiMomentCandidate
    ? [multiMomentCandidate, ...singleCandidates.map((candidate, index) => ({ ...candidate, rank: index + 2 }))]
    : singleCandidates;
  return candidates;
}

function analysisHealth() {
  return {
    ready: true,
    mode: "deterministic-signal-ranking",
    ffmpegSignals: commandAvailable(CONFIG.ffmpegBin),
    features: [
      "media_signals",
      "football_highlight_taxonomy",
      "evidence_based_goal_guard",
      "commentary_crowd_signal_scoring",
      "vision_safe_action_signals",
      "goal_evidence_sequence_detection",
      "goal_outcome_offside_context",
      "action_first_story_windows",
      "false_goal_guard",
      "football_story_planner",
      "contextual_caption_planning",
      "reference_style_animation_cues",
      "multi_moment_compilation",
      "highlight_ranking",
      "candidate_edit_plans",
    ],
  };
}

module.exports = {
  analysisHealth,
  captionBeatsForMoment,
  createCandidateEditPlans,
  detectAudioPeaks,
  detectHighlights,
  detectSceneChanges,
  extractMediaSignals,
  fallbackAudioPeaks,
  fallbackSceneChanges,
  evidenceForReasons,
  highlightTypeForReasons,
  reviewMetadataForPlan,
  captionIntentForHighlightType,
  reasonCodesForCaption,
  scoreReasons,
  titleForHighlightType,
  visualEvidenceSummaryForMoment,
};
