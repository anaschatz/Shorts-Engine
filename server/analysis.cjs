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
const { analyzeMatchEventTruth, publicMatchEventTruth } = require("./match-event-truth.cjs");
const {
  summarizeVisualSignals,
  validateVisualSignals,
  visualHighlightTypeForReasons,
  visualReasonCodesForWindow,
} = require("./vision.cjs");
const { resolveGoalOutcome } = require("./goal-outcome.cjs");
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

function timeForSignalItem(item) {
  return seconds(item && item.time, Number.NaN);
}

function selectTemporalCoverage(items = [], { maxItems = 10, duration = 0, score = () => 0 } = {}) {
  const safeItems = (Array.isArray(items) ? items : [])
    .filter((item) => Number.isFinite(timeForSignalItem(item)))
    .sort((a, b) => timeForSignalItem(a) - timeForSignalItem(b));
  if (safeItems.length <= maxItems) return safeItems;
  const mediaDuration = Math.max(0, Number(duration) || timeForSignalItem(safeItems[safeItems.length - 1]) || 0);
  const minGap = mediaDuration > 0 ? Math.max(3, mediaDuration / maxItems * 0.45) : 3;
  const selected = [];
  const ranked = [...safeItems].sort((a, b) => Number(score(b) || 0) - Number(score(a) || 0) || timeForSignalItem(a) - timeForSignalItem(b));
  for (const item of ranked) {
    if (selected.length >= maxItems) break;
    const itemTime = timeForSignalItem(item);
    if (selected.some((existing) => Math.abs(timeForSignalItem(existing) - itemTime) < minGap)) continue;
    selected.push(item);
  }
  for (const item of safeItems) {
    if (selected.length >= maxItems) break;
    if (selected.includes(item)) continue;
    selected.push(item);
  }
  return selected.sort((a, b) => timeForSignalItem(a) - timeForSignalItem(b));
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
    const changes = selectTemporalCoverage(
      uniqueTimes(times, duration).map((time) => ({
        time,
        confidence: 0.74,
        source: "ffmpeg_scene",
      })),
      { maxItems: 12, duration, score: (item) => item.confidence },
    ).map((item) => ({
      time: item.time,
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
    const peaks = selectTemporalCoverage(segments
      .map((segment) => ({
        time: Number(((segment.start + segment.end) / 2).toFixed(2)),
        energyScore: Number(clamp((segment.end - segment.start) / 8, 0.45, 0.95).toFixed(2)),
        source: "ffmpeg_audio_activity",
      })), { maxItems: 10, duration, score: (item) => item.energyScore });
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
  const highMotionCandidates = selectTemporalCoverage(
    uniqueTimes([...sceneChanges.map((item) => item.time), ...audioPeaks.map((item) => item.time)], duration)
      .map((time) => ({ time, confidence: 0.58, source: "signal_cluster" })),
    { maxItems: 12, duration, score: (item) => item.confidence },
  );
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
  "visual_var_decision",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
  "visual_referee_no_goal_signal",
  "visual_referee_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_scoreboard_goal_confirmed",
  "visual_replay_angle",
  "visual_crowd_confusion",
  "visual_celebration_after_whistle",
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
  "visual_var_decision",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_decision",
  "visual_referee_no_goal_signal",
  "visual_referee_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_scoreboard_goal_confirmed",
  "visual_replay_angle",
  "visual_crowd_confusion",
  "visual_celebration_after_whistle",
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
  const hasExplicitRange = Number.isFinite(Number(start)) && Number.isFinite(Number(end));
  const centerRadius = hasExplicitRange
    ? Math.max(9, (Math.max(rangeStart, rangeEnd) - Math.min(rangeStart, rangeEnd)) / 2 + 3)
    : 9;
  const windows = Array.isArray(visualSignals && visualSignals.windows) ? visualSignals.windows : [];
  const visualWindows = windows.filter((window) => {
    const windowStart = seconds(window.start);
    const windowEnd = seconds(window.end);
    const windowCenter = seconds(window.center ?? (windowStart + windowEnd) / 2);
    return windowEnd >= rangeStart - 3 && windowStart <= rangeEnd + 3 && (
      !Number.isFinite(Number(center)) || Math.abs(windowCenter - Number(center)) <= centerRadius
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
  if (reasons.includes("visual_shot_like_motion")) return "big_chance";
  if (reasons.includes("visual_shot_contact")) return "big_chance";
  if (reasons.includes("visual_crowd_reaction") && (reasons.includes("audio_energy_spike") || reasons.includes("crowd_spike"))) {
    return "crowd_reaction";
  }
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

function highlightTypeForGoalOutcome(reasons = [], goalOutcome = null) {
  if (
    goalOutcome &&
    goalOutcome.eventType === "ball_in_net" &&
    goalOutcome.outcome === "disallowed_offside"
  ) {
    return "goal";
  }
  const baseType = highlightTypeForReasons(reasons);
  if (
    baseType !== "goal" ||
    !goalOutcome ||
    goalOutcome.eventType !== "ball_in_net" ||
    goalOutcome.outcome === "confirmed_goal"
  ) {
    return baseType;
  }
  return highlightTypeForReasons((Array.isArray(reasons) ? reasons : []).filter((reason) => reason !== "visual_ball_in_net"));
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

function roundedTime(value, fallback = 0) {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Number(Math.max(0, safeValue).toFixed(2));
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

function hasFootballShotOrSaveContext(reasonSet) {
  return reasonSetHasAny(reasonSet, [
    "goal",
    "big_chance",
    "shot_on_target",
    "save",
    "visual_shot_like_motion",
    "visual_shot_contact",
    "visual_ball_toward_goal",
    "visual_save_like_motion",
    "visual_keeper_action",
  ]);
}

function decisionContextStartForWindows(windows = [], fallback = null) {
  return firstWindowTime(
    windows,
    (windowReasons) => (
      windowReasons.has("visual_offside_flag") ||
      windowReasons.has("visual_var_check") ||
      windowReasons.has("visual_var_decision") ||
      windowReasons.has("visual_no_goal_decision") ||
      windowReasons.has("visual_offside_line") ||
      windowReasons.has("visual_referee_decision") ||
      windowReasons.has("visual_referee_no_goal_signal") ||
      windowReasons.has("visual_scoreboard_goal_removed") ||
      windowReasons.has("visual_scoreboard_goal_confirmed")
    ),
    fallback,
  );
}

function footballSequenceForContext({
  start = 0,
  end = 0,
  center = null,
  reasons = [],
  goalEvidence = {},
  goalOutcome = null,
  visualWindows = [],
} = {}) {
  const reasonCodes = [...new Set(Array.isArray(reasons) ? reasons : [])];
  const reasonSet = new Set(reasonCodes);
  const actionSequence = actionSequenceForReasons(reasonCodes, goalEvidence);
  const outcome = normalizeGoalOutcome(goalOutcome, {
    highlightType: highlightTypeForReasons(reasonCodes),
    reasonCodes,
  });
  const hasBallInNet = outcome.eventType === "ball_in_net" ||
    Boolean(goalEvidence && goalEvidence.hasBallInNetOrLineCross) ||
    reasonSet.has("visual_ball_in_net");
  const hasDecisionContext = reasonSetHasAny(reasonSet, [
    "visual_offside_flag",
    "visual_var_check",
    "visual_var_decision",
    "visual_no_goal_decision",
    "visual_offside_line",
    "visual_referee_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
    "visual_scoreboard_goal_confirmed",
  ]);
  const hasShotContext = hasFootballShotOrSaveContext(reasonSet);
  const hasChanceContext = hasShotContext && (
    actionSequence.ballTrajectory ||
    actionSequence.goalmouthOrKeeper ||
    actionSequence.payoff ||
    actionSequence.reactionSupport ||
    actionSequence.replaySupport
  );
  const hasNearGoalContext = hasShotContext && actionSequence.ballTrajectory && (
    actionSequence.goalmouthOrKeeper ||
    actionSequence.payoff ||
    actionSequence.reactionSupport ||
    actionSequence.replaySupport ||
    hasDecisionContext
  );
  if (!hasBallInNet && !hasChanceContext) return null;

  const sequenceType = hasBallInNet ? "goal_sequence" : hasNearGoalContext ? "near_goal_sequence" : "chance_sequence";
  const shotStart = firstWindowTime(
    visualWindows,
    (windowReasons) => (
      windowReasons.has("visual_shot_contact") ||
      windowReasons.has("visual_shot_like_motion") ||
      windowReasons.has("visual_ball_toward_goal")
    ),
    Number.isFinite(Number(goalEvidence && goalEvidence.shotStart))
      ? Number(goalEvidence.shotStart)
      : Number.isFinite(Number(center))
        ? Math.max(0, Number(center) - 1.5)
        : start,
  );
  const payoffWindows = Number.isFinite(Number(shotStart))
    ? visualWindows.filter((window) => seconds(window.end) >= Number(shotStart) - 0.25)
    : visualWindows;
  const payoffStart = firstWindowTime(
    payoffWindows,
    (windowReasons) => (
      windowReasons.has("visual_ball_in_net") ||
      windowReasons.has("visual_save_like_motion") ||
      windowReasons.has("visual_keeper_action") ||
      windowReasons.has("visual_celebration_after_shot") ||
      windowReasons.has("visual_crowd_reaction")
    ),
    Number.isFinite(Number(shotStart)) ? Math.min(end, Number(shotStart) + 2.2) : center,
  );
  const payoffEnd = Number.isFinite(Number(goalEvidence && goalEvidence.payoffEnd))
    ? Number(goalEvidence.payoffEnd)
    : lastWindowTime(
      payoffWindows,
      (windowReasons) => (
        windowReasons.has("visual_ball_in_net") ||
        windowReasons.has("visual_save_like_motion") ||
        windowReasons.has("visual_keeper_action") ||
        windowReasons.has("visual_celebration_after_shot") ||
        windowReasons.has("visual_crowd_reaction")
      ),
      end,
    );
  const decisionContextStart = decisionContextStartForWindows(
    visualWindows,
    outcome.eventType === "ball_in_net" && Number.isFinite(Number(outcome.decisionTimestamp))
      ? Number(outcome.decisionTimestamp)
      : null,
  );
  const missingEvidence = [];
  if (!hasBallInNet) missingEvidence.push("no_ball_in_net_or_explicit_goal_evidence");
  if (!actionSequence.goalmouthOrKeeper) missingEvidence.push("no_goalmouth_or_keeper_context");
  if (!hasDecisionContext && hasBallInNet && outcome.outcome !== "confirmed_goal") missingEvidence.push("decision_context_limited");
  const safeOutcome = hasBallInNet
    ? sanitizeText(outcome.outcome || "unknown_decision", 40)
    : hasDecisionContext
      ? "unknown_decision"
      : hasNearGoalContext
        ? "no_goal"
        : "none";
  const confidence = Number(clamp(
    Number(outcome.confidence || 0) || Number(goalEvidence && goalEvidence.confidence || 0) || Number(actionSequence.actionStageCount || 0) * 0.14 + 0.36,
    0.2,
    hasBallInNet ? 0.96 : 0.84,
  ).toFixed(2));
  return {
    sequenceType,
    start: roundedTime(start),
    shotStart: roundedTime(shotStart, start),
    payoffStart: roundedTime(payoffStart, shotStart || start),
    payoffEnd: roundedTime(payoffEnd, end),
    decisionContextStart: decisionContextStart == null ? null : roundedTime(decisionContextStart),
    end: roundedTime(end),
    outcome: safeOutcome,
    confidence,
    evidenceCodes: [...new Set([...reasonCodes, ...((goalEvidence && goalEvidence.reasonCodes) || [])])]
      .map((reason) => sanitizeText(reason, 60))
      .filter(Boolean)
      .slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 6),
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
  const reasonSet = new Set(Array.isArray(moment.reasonCodes) ? moment.reasonCodes : []);
  const hasDecisionContext = reasonSetHasAny(reasonSet, [
    "visual_offside_flag",
    "visual_var_check",
    "visual_var_decision",
    "visual_no_goal_decision",
    "visual_offside_line",
    "visual_referee_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
  ]);
  const hasConfirmedDecisionContext = reasonSetHasAny(reasonSet, [
    "visual_referee_goal_signal",
    "visual_scoreboard_goal_confirmed",
  ]);
  const truthDrivenValidGoal = moment.source === "match_event_truth_valid_goals_only";
  const needsDecisionContext = Boolean(goalEvidence.hasBallInNetOrLineCross || goalEvidence.explicitTextGoal);
  const confirmedGoalCandidate = Boolean(goalEvidence.goalClaimAllowed && hasConfirmedDecisionContext && !hasDecisionContext);
  const postContextSeconds = confirmedGoalCandidate ? 5.5 : needsDecisionContext ? 13 : 4.5;
  const minDuration = confirmedGoalCandidate ? 10 : needsDecisionContext ? 18 : goalEvidence.goalClaimAllowed ? 12 : 10;
  const maxDuration = truthDrivenValidGoal
    ? VALID_GOAL_ONLY_TIMING.maxSegmentDuration
    : confirmedGoalCandidate
      ? 18
      : needsDecisionContext
        ? 30
        : goalEvidence.goalClaimAllowed
          ? 22
          : 16;
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

function normalizeMomentWithEvidence(moment, { signals = {}, visualSignals = null, captions = [], preset = "hype", goalEvidenceOverride = null } = {}) {
  const { _caption: sourceCaption, _sequenceSupportReasons: sequenceSupportReasons, ...publicMoment } = moment || {};
  const duration = seconds(signals.durationSeconds || 18);
  const initialReasons = Array.isArray(publicMoment.reasonCodes) ? publicMoment.reasonCodes : [];
  const initialGoalEvidence = goalEvidenceOverride || goalEvidenceForMomentContext({
    reasons: initialReasons,
    center: publicMoment.center,
    start: publicMoment.start,
    end: publicMoment.end,
    visualSignals,
  });
  const reasonCodes = reasonCodesWithGoalEvidence(initialReasons, initialGoalEvidence);
  const window = expandWindowForGoalEvidence({ ...publicMoment, reasonCodes }, duration, initialGoalEvidence);
  const center = Number(((window.start + window.end) / 2).toFixed(2));
  const goalEvidence = goalEvidenceOverride || goalEvidenceForMomentContext({
    reasons: reasonCodes,
    center,
    start: window.start,
    end: window.end,
    visualSignals,
  });
  let finalReasons = reasonCodesWithGoalEvidence(reasonCodes, goalEvidence);
  const visualWindows = Array.isArray(visualSignals && visualSignals.windows)
    ? visualSignals.windows.filter((visualWindow) => seconds(visualWindow.end) >= window.start - 1 && seconds(visualWindow.start) <= window.end + 1)
    : [];
  const goalOutcome = resolveGoalOutcome({
    reasons: finalReasons,
    goalEvidence,
    visualWindows,
    captions,
    start: window.start,
    end: window.end,
    payoffEnd: goalEvidence.payoffEnd,
  });
  if (goalOutcome && goalOutcome.eventType === "ball_in_net" && goalOutcome.outcome === "confirmed_goal" && !finalReasons.includes("goal")) {
    finalReasons = ["goal", ...finalReasons];
  }
  const highlightType = highlightTypeForGoalOutcome(finalReasons, goalOutcome);
  const baseEvidence = {
    ...evidenceForReasons(finalReasons, sourceCaption || null, signals, center, visualSignals, window),
    goalEvidence,
    actionSequence: actionSequenceForReasons(finalReasons, goalEvidence),
    goalClaimAllowed: finalReasons.includes("goal") && goalEvidence.goalClaimAllowed,
  };
  const footballSequenceReasons = [...new Set([
    ...finalReasons,
    ...(Array.isArray(sequenceSupportReasons) ? sequenceSupportReasons : []),
  ])];
  const footballSequenceGoalEvidence = footballSequenceReasons.length === finalReasons.length
    ? goalEvidence
    : goalEvidenceForContext({ reasons: footballSequenceReasons, visualWindows, center });
  const footballSequence = footballSequenceForContext({
    start: window.start,
    end: window.end,
    center,
    reasons: footballSequenceReasons,
    goalEvidence: footballSequenceGoalEvidence,
    goalOutcome,
    visualWindows,
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
      ...baseEvidence,
      actionSequence: {
        ...(baseEvidence.actionSequence || actionSequenceForReasons(finalReasons, goalEvidence)),
        footballSequence,
      },
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

const GOAL_DISCOVERY_MAX_ANCHORS = 36;
const GOAL_DISCOVERY_MAX_MOMENTS = 12;

const GOAL_DISCOVERY_CRITICAL_REASONS = Object.freeze([
  "visual_ball_in_net",
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "visual_offside_flag",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_var_check",
  "visual_var_decision",
  "visual_scoreboard_goal_removed",
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_goal_mouth",
  "visual_shot_like_motion",
  "visual_ball_visible",
]);

function visualWindowCenter(window = {}) {
  const start = seconds(window.start);
  const end = seconds(window.end);
  return seconds(window.center ?? (start + end) / 2);
}

function visualWindowKey(window = {}) {
  return `${Number(window.start || 0).toFixed(2)}:${Number(window.end || 0).toFixed(2)}:${visualReasonCodesForWindow(window).join(",")}`;
}

function visualWindowHasAnyReason(window, reasons = []) {
  const reasonSet = new Set(visualReasonCodesForWindow(window));
  return reasons.some((reason) => reasonSet.has(reason));
}

function goalDiscoveryScoreForWindow(window = {}) {
  const reasonSet = new Set(visualReasonCodesForWindow(window));
  const weights = {
    visual_ball_in_net: 1.28,
    visual_scoreboard_goal_confirmed: 1.12,
    visual_referee_goal_signal: 1.08,
    visual_offside_flag: 0.98,
    visual_no_goal_decision: 0.98,
    visual_offside_line: 0.94,
    visual_var_check: 0.84,
    visual_var_decision: 0.84,
    visual_scoreboard_goal_removed: 0.94,
    visual_shot_contact: 0.86,
    visual_ball_toward_goal: 0.8,
    visual_goal_mouth: 0.7,
    visual_shot_like_motion: 0.5,
    visual_ball_visible: 0.22,
    visual_crowd_reaction: 0.12,
    visual_replay_indicator: 0.08,
  };
  const reasonScore = [...reasonSet].reduce((sum, reason) => sum + (weights[reason] || 0), 0);
  return Number((Number(window.confidence || 0) + reasonScore).toFixed(4));
}

function goalDiscoveryBucketIndex(window, duration, bucketCount) {
  if (!duration || bucketCount <= 1) return 0;
  return Math.min(bucketCount - 1, Math.max(0, Math.floor(visualWindowCenter(window) / (duration / bucketCount))));
}

function goalDiscoveryBuckets(windows = [], duration = 0) {
  const bucketCount = Math.min(8, Math.max(3, Math.ceil((duration || 180) / 60)));
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    start: Number(((duration / bucketCount) * index).toFixed(2)),
    end: Number((index === bucketCount - 1 ? duration : (duration / bucketCount) * (index + 1)).toFixed(2)),
    windows: [],
  }));
  for (const window of windows) {
    buckets[goalDiscoveryBucketIndex(window, duration, bucketCount)].windows.push(window);
  }
  return buckets;
}

function rankedGoalDiscoveryWindows(windows = []) {
  return [...windows].sort((a, b) => goalDiscoveryScoreForWindow(b) - goalDiscoveryScoreForWindow(a) || seconds(a.start) - seconds(b.start));
}

function selectGoalDiscoveryAnchors(sortedWindows = [], duration = 0) {
  const buckets = goalDiscoveryBuckets(sortedWindows, duration);
  const selected = [];
  const seen = new Set();
  const add = (window) => {
    if (!window || selected.length >= GOAL_DISCOVERY_MAX_ANCHORS) return false;
    const key = visualWindowKey(window);
    if (seen.has(key)) return false;
    selected.push(window);
    seen.add(key);
    return true;
  };
  const criticalWindows = (windows) => rankedGoalDiscoveryWindows(
    windows.filter((window) => visualWindowHasAnyReason(window, GOAL_DISCOVERY_CRITICAL_REASONS)),
  );
  const lateBucketStart = Math.max(0, Math.floor(buckets.length * 0.66));

  for (const bucket of buckets.slice(lateBucketStart)) {
    for (const window of criticalWindows(bucket.windows).slice(0, 4)) add(window);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const bucket of buckets) {
      const candidate = criticalWindows(bucket.windows).find((window) => !seen.has(visualWindowKey(window)));
      add(candidate);
    }
  }
  for (const bucket of buckets) add(rankedGoalDiscoveryWindows(bucket.windows)[0]);
  for (const window of rankedGoalDiscoveryWindows(sortedWindows)) add(window);

  return selected.sort((a, b) => seconds(a.start) - seconds(b.start));
}

function goalClusterRangeForAnchor(anchor, sortedWindows = [], duration = 0) {
  const anchorCenter = visualWindowCenter(anchor);
  const anchorReasons = new Set(visualReasonCodesForWindow(anchor));
  const decisionAnchor = reasonSetHasAny(anchorReasons, [
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "visual_offside_flag",
    "visual_no_goal_decision",
    "visual_offside_line",
    "visual_var_check",
    "visual_var_decision",
    "visual_scoreboard_goal_removed",
    "visual_referee_decision",
    "visual_referee_no_goal_signal",
  ]);
  const range = {
    start: Math.max(0, anchorCenter - (decisionAnchor ? 18 : 9)),
    end: Math.min(duration || anchorCenter + 18, anchorCenter + (decisionAnchor ? 6 : 18)),
  };
  const initial = sortedWindows.filter((window) => seconds(window.end) >= range.start && seconds(window.start) <= range.end);
  const payoffStart = firstWindowTime(
    initial,
    (windowReasons) => windowReasons.has("visual_ball_in_net") || windowReasons.has("visual_celebration_after_shot"),
    null,
  );
  let decisionStart = decisionContextStartForWindows(initial, null);
  if (!Number.isFinite(Number(decisionStart)) && Number.isFinite(Number(payoffStart))) {
    const lateDecisionWindows = sortedWindows.filter((window) => {
      const windowStart = seconds(window.start);
      return windowStart >= payoffStart && windowStart <= payoffStart + 18;
    });
    decisionStart = decisionContextStartForWindows(lateDecisionWindows, null);
  }
  const shotStart = firstWindowTime(
    sortedWindows.filter((window) => {
      const windowStart = seconds(window.start);
      const minPayoff = Number.isFinite(Number(payoffStart)) ? payoffStart : anchorCenter;
      const maxDecision = Number.isFinite(Number(decisionStart)) ? decisionStart : range.end;
      return windowStart >= Math.max(0, Math.min(range.start, minPayoff - 16)) && windowStart <= Math.max(maxDecision, minPayoff) + 1;
    }),
    (windowReasons) => (
      windowReasons.has("visual_shot_contact") ||
      windowReasons.has("visual_shot_like_motion") ||
      windowReasons.has("visual_ball_toward_goal")
    ),
    null,
  );

  if (Number.isFinite(Number(shotStart))) range.start = Math.max(0, Math.min(range.start, shotStart - 2.5));
  if (Number.isFinite(Number(decisionStart))) range.end = Math.min(duration || decisionStart + 4, Math.max(range.end, decisionStart + 4));
  if (Number.isFinite(Number(payoffStart))) range.end = Math.min(duration || payoffStart + 10, Math.max(range.end, payoffStart + 10));
  return range;
}

function clusterVisualWindowsForGoalAnchor(anchor, sortedWindows = [], duration = 0) {
  const range = goalClusterRangeForAnchor(anchor, sortedWindows, duration);
  return sortedWindows.filter((window) => seconds(window.end) >= range.start && seconds(window.start) <= range.end);
}

function signalReasonsForVisualRange(safeSignals = {}, start = 0, end = 0) {
  const signalReasons = [];
  const nearbyAudioPeaks = (safeSignals.audioPeaks || []).filter((peak) => seconds(peak.time) >= start - 1.5 && seconds(peak.time) <= end + 5);
  if (nearbyAudioPeaks.length) signalReasons.push("audio_energy_spike");
  if (nearbyAudioPeaks.some((peak) => Number(peak.energyScore || 0) >= 0.88)) signalReasons.push("crowd_spike");
  if ((safeSignals.sceneChanges || []).some((change) => seconds(change.time) >= start - 1.5 && seconds(change.time) <= end + 4)) {
    signalReasons.push("scene_change_cluster");
  }
  return [...new Set(signalReasons)];
}

function providerGoalEvents(goalEvidence = null) {
  return Array.isArray(goalEvidence && goalEvidence.events) ? goalEvidence.events : [];
}

function providerGoalEventForRange(goalEvidence = null, start = 0, end = 0) {
  const range = { sourceStart: Number(start || 0), sourceEnd: Number(end || start || 0) };
  return providerGoalEvents(goalEvidence)
    .map((event) => ({
      event,
      overlap: sourceOverlapSeconds(range, {
        sourceStart: Number(event.start || 0),
        sourceEnd: Number(event.end || event.start || 0),
      }),
    }))
    .filter((item) => item.overlap > 0.5)
    .sort((a, b) => b.overlap - a.overlap || Number(a.event.start || 0) - Number(b.event.start || 0))[0]?.event || null;
}

function goalEvidenceContextForProviderEvent(event = null) {
  if (!event || typeof event !== "object") return null;
  const reasonCodes = Array.isArray(event.reasonCodes) ? event.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean) : [];
  const reasonSet = new Set(reasonCodes);
  const outcomeHint = sanitizeText(event.outcomeHint || "", 48);
  const hasBallInNet = Boolean(event.ballInNetEvidence || reasonSet.has("ball_in_net") || reasonSet.has("visual_ball_in_net"));
  const hasScoreboardBackedGoalSequence = reasonSet.has("scoreboard_backed_goal_sequence") &&
    reasonSet.has("shot_sequence_support") &&
    reasonSet.has("scoreboard_ocr_score_change");
  const goalClaimAllowed = outcomeHint === "valid_goal";
  const disallowedOrNoGoal = outcomeHint === "offside_goal" || outcomeHint === "no_goal";
  const evidenceLevel = goalClaimAllowed || disallowedOrNoGoal
    ? "strong"
    : hasBallInNet
      ? "medium"
      : outcomeHint === "non_goal_chance"
        ? "weak"
        : "none";
  return {
    hasShotContact: reasonSet.has("shot_sequence_support") || reasonSet.has("visual_shot_contact"),
    hasBallTowardGoal: reasonSet.has("shot_sequence_support") || reasonSet.has("visual_ball_toward_goal"),
    hasGoalMouthFrame: reasonSet.has("visual_goal_mouth") || reasonSet.has("visual_scoreboard_goal_confirmed"),
    hasKeeperAction: reasonSet.has("visual_keeper_action"),
    hasBallInNetOrLineCross: hasBallInNet || hasScoreboardBackedGoalSequence,
    hasCelebrationAfterShot: reasonSet.has("celebration_only"),
    hasSupportingReaction: Boolean(event.crowdReactionSupport),
    explicitTextGoal: Boolean(event.commentatorGoalCall),
    confidence: Number(clamp(event.confidence, 0.05, 0.98).toFixed(2)),
    evidenceLevel,
    goalClaimAllowed,
    shotStart: Number(event.start || 0),
    payoffEnd: Number(event.end || event.start || 0),
    reasonCodes,
    providerEventOutcome: outcomeHint,
  };
}

function matchEventTruthGoalEvidence(event = {}) {
  const reasonCodes = Array.isArray(event.evidenceCodes) ? event.evidenceCodes : [];
  const reasonSet = new Set(reasonCodes);
  const hasScoreboardBackedGoalSequence = reasonSet.has("scoreboard_backed_goal_sequence") &&
    reasonSetHasAny(reasonSet, ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency", "visual_scoreboard_goal_confirmed"]);
  const isGoalDecision = ["confirmed_goal", "disallowed_offside", "disallowed_no_goal", "possible_goal_unconfirmed"].includes(event.type);
  const goalClaimAllowed = event.type === "confirmed_goal";
  return {
    hasShotContact: reasonSetHasAny(reasonSet, ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal", "shot_sequence_support"]),
    hasBallTowardGoal: reasonSetHasAny(reasonSet, ["visual_ball_toward_goal", "shot_sequence_support"]),
    hasGoalMouthFrame: reasonSetHasAny(reasonSet, ["visual_goal_mouth", "visual_goal_area", "visual_scoreboard_goal_confirmed"]),
    hasKeeperAction: reasonSet.has("visual_keeper_action"),
    hasBallInNetOrLineCross: reasonSetHasAny(reasonSet, ["ball_in_net", "visual_ball_in_net"]) || hasScoreboardBackedGoalSequence,
    hasCelebrationAfterShot: reasonSet.has("visual_celebration_after_shot"),
    hasSupportingReaction: reasonSetHasAny(reasonSet, ["crowd_reaction_support", "visual_crowd_reaction", "audio_energy_spike"]),
    explicitTextGoal: reasonSetHasAny(reasonSet, ["confirmed_by_commentary", "commentator_goal_call_support"]),
    confidence: Number(clamp(event.confidence, 0.05, 0.98).toFixed(2)),
    evidenceLevel: goalClaimAllowed || event.type === "disallowed_offside" || event.type === "disallowed_no_goal"
      ? "strong"
      : isGoalDecision
        ? "medium"
        : "weak",
    goalClaimAllowed,
    shotStart: Number(event.shotWindow && event.shotWindow.start || event.sourceStart || 0),
    payoffEnd: Number(event.payoffWindow && event.payoffWindow.end || event.sourceEnd || 0),
    reasonCodes: reasonCodes.slice(0, 16),
    truthEventType: event.type,
  };
}

function reasonCodesForTruthEvent(event = {}) {
  const base = Array.isArray(event.evidenceCodes) ? event.evidenceCodes : [];
  const byType = {
    confirmed_goal: ["goal"],
    disallowed_offside: ["visual_ball_in_net", "visual_offside_flag"],
    disallowed_no_goal: ["visual_ball_in_net", "visual_no_goal_decision"],
    possible_goal_unconfirmed: ["big_chance", "visual_ball_in_net"],
    big_chance: ["big_chance"],
    save: ["save"],
    foul: ["foul"],
    replay: ["replay_worthy_moment"],
    crowd_reaction: ["crowd_reaction"],
    neutral: ["generic_highlight"],
  };
  const signalCodes = ["disallowed_offside", "disallowed_no_goal", "crowd_reaction", "replay"].includes(event.type)
    ? base.filter((code) => code === "audio_energy_spike" || code === "scene_change_cluster")
    : [];
  const visualCodes = base.filter((code) => {
    if (!/^visual_/.test(code)) return false;
    if (event.type === "possible_goal_unconfirmed" && code === "visual_ball_visible") return false;
    return true;
  });
  return [...new Set([...(byType[event.type] || []), ...signalCodes, ...visualCodes])].slice(0, 18);
}

function highlightTypeForTruthEvent(event = {}, reasonCodes = []) {
  if (event.type === "confirmed_goal") return "goal";
  if (event.type === "big_chance") return "big_chance";
  if (event.type === "save") return "save";
  if (event.type === "foul") return "foul";
  if (event.type === "replay") return "replay_worthy_moment";
  if (event.type === "crowd_reaction") return "crowd_reaction";
  if (event.type === "disallowed_offside" || event.type === "disallowed_no_goal" || event.type === "possible_goal_unconfirmed") {
    return "goal";
  }
  return highlightTypeForReasons(reasonCodes);
}

function createMatchEventTruthMoments(matchEventTruth, safeSignals, safeVisualSignals, captions = [], preset = "hype") {
  const truth = publicMatchEventTruth(matchEventTruth);
  const events = Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [];
  return events
    .filter((event) => event.sourceEnd - event.sourceStart >= 3)
    .slice(0, 12)
    .map((event, index) => {
      const reasonCodes = reasonCodesForTruthEvent(event);
      const highlightType = highlightTypeForTruthEvent(event, reasonCodes);
      const confidence = Number(clamp(event.confidence + (event.type === "confirmed_goal" ? 0.08 : 0.02), 0.12, 0.97).toFixed(2));
      return normalizeMomentWithEvidence({
        id: `mom_truth_${index + 1}_${event.id}`,
        rank: index + 1,
        start: event.sourceStart,
        end: event.sourceEnd,
        center: Number(((event.sourceStart + event.sourceEnd) / 2).toFixed(2)),
        title: titleForHighlightType(highlightType),
        summary: `Match event truth classified this as ${event.type}.`,
        reasonCodes,
        highlightType,
        confidence,
        retentionScore: Math.round(confidence * 100),
        suggestedPreset: preset,
        source: "match_event_truth",
        captionIntent: event.captionIntent || captionIntentForHighlightType(highlightType),
        rankingExplanation: rankingExplanationForMoment({
          reasons: reasonCodes,
          score: confidence,
          source: "match_event_truth",
          visualSignals: safeVisualSignals,
          goalEvidence: matchEventTruthGoalEvidence(event),
        }),
      }, {
        signals: safeSignals,
        visualSignals: safeVisualSignals,
        captions,
        preset,
        goalEvidenceOverride: matchEventTruthGoalEvidence(event),
      });
    });
}

function createGoalSequenceMoments(safeVisualSignals, safeSignals, captions = [], preset = "hype", providerGoalEvidence = null) {
  const windows = Array.isArray(safeVisualSignals && safeVisualSignals.windows) ? safeVisualSignals.windows : [];
  const duration = seconds(safeSignals.durationSeconds || 18);
  if (!windows.length) return [];
  const sorted = [...windows].sort((a, b) => seconds(a.start) - seconds(b.start));
  const anchors = duration >= 180 ? selectGoalDiscoveryAnchors(sorted, duration) : sorted;
  const moments = [];
  const coveredRanges = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const anchorCenter = seconds(anchor.center ?? (seconds(anchor.start) + seconds(anchor.end)) / 2);
    const cluster = clusterVisualWindowsForGoalAnchor(anchor, sorted, duration);
    if (!cluster.length) continue;
    const clusterStart = Math.min(...cluster.map((window) => seconds(window.start)));
    const clusterEnd = Math.max(...cluster.map((window) => seconds(window.end)));
    const alreadyCovered = coveredRanges.some((range) => sourceOverlapSeconds(
      { sourceStart: range.start, sourceEnd: range.end },
      { sourceStart: clusterStart, sourceEnd: clusterEnd },
    ) > 0.5);
    if (alreadyCovered) continue;
    const signalReasons = signalReasonsForVisualRange(safeSignals, clusterStart, clusterEnd);
    const rawVisualReasons = [...new Set(cluster.flatMap(visualReasonCodesForWindow))];
    const firstShotTime = firstWindowTime(
      cluster,
      (windowReasons) => (
        windowReasons.has("visual_shot_contact") ||
        windowReasons.has("visual_shot_like_motion") ||
        windowReasons.has("visual_ball_toward_goal") ||
        windowReasons.has("visual_save_like_motion") ||
        windowReasons.has("visual_keeper_action")
      ),
      clusterStart,
    );
    const visualReasons = [...new Set(cluster.flatMap((window) => {
      const windowReasons = visualReasonCodesForWindow(window);
      if (windowReasons.includes("visual_crowd_reaction") && seconds(window.end) < Number(firstShotTime) - 0.25) {
        return windowReasons.filter((reason) => reason !== "visual_crowd_reaction");
      }
      return windowReasons;
    }))];
    const providerEvent = providerGoalEventForRange(providerGoalEvidence, clusterStart, clusterEnd);
    const providerGoalContext = goalEvidenceContextForProviderEvent(providerEvent);
    const providerReasons = providerGoalContext ? providerGoalContext.reasonCodes : [];
    const sequenceReasons = [...new Set([...rawVisualReasons, ...signalReasons, ...providerReasons])];
    const goalEvidence = providerGoalContext || goalEvidenceForContext({ reasons: sequenceReasons, visualWindows: cluster, center: anchorCenter });
    const actionSequence = actionSequenceForReasons(sequenceReasons, goalEvidence);
    const reasonSet = new Set(sequenceReasons);
    const hasFootballActionContext = hasFootballShotOrSaveContext(reasonSet);
    const hasGoalSequence = ["strong", "medium"].includes(goalEvidence.evidenceLevel);
    const hasNearGoalSequence = hasFootballActionContext &&
      actionSequence.ballTrajectory &&
      (
        actionSequence.goalmouthOrKeeper ||
        actionSequence.payoff ||
        actionSequence.reactionSupport ||
        actionSequence.replaySupport
      );
    const hasChanceSequence = hasFootballActionContext && actionSequence.ballTrajectory && actionSequence.actionStageCount >= 2;
    if (!hasGoalSequence && !hasNearGoalSequence && !hasChanceSequence) continue;
    const preHandle = hasGoalSequence ? 3 : 4.5;
    const hasDecisionContext = reasonSetHasAny(reasonSet, [
      "visual_scoreboard_goal_confirmed",
      "visual_referee_goal_signal",
      "visual_offside_flag",
      "visual_no_goal_decision",
      "visual_offside_line",
      "visual_var_check",
      "visual_var_decision",
      "visual_scoreboard_goal_removed",
      "visual_referee_decision",
      "visual_referee_no_goal_signal",
    ]);
    const postHandle = hasGoalSequence && hasDecisionContext ? 4.5 : hasGoalSequence ? 7.5 : hasNearGoalSequence ? 8.5 : 6;
    const effectiveClusterStart = !hasGoalSequence &&
      Number.isFinite(Number(firstShotTime)) &&
      Number(firstShotTime) - clusterStart > 8
      ? Number(firstShotTime)
      : clusterStart;
    let start = Number(clamp(effectiveClusterStart - preHandle, 0, duration).toFixed(2));
    let end = Number(clamp(clusterEnd + postHandle, start + 3, duration).toFixed(2));
    const minDuration = hasGoalSequence && hasDecisionContext ? 12 : hasGoalSequence ? 18 : hasNearGoalSequence ? 16 : 12;
    const maxDuration = hasGoalSequence && hasDecisionContext ? 22 : hasGoalSequence ? 30 : hasNearGoalSequence ? 24 : 18;
    if (end - start < minDuration) {
      const missing = minDuration - (end - start);
      start = Number(clamp(start - missing * 0.45, 0, duration).toFixed(2));
      end = Number(clamp(end + missing * 0.55, start + 3, duration).toFixed(2));
    }
    if (end - start > maxDuration) {
      end = Number(Math.min(duration, start + maxDuration).toFixed(2));
    }
    const reasonCodes = reasonCodesWithGoalEvidence([...new Set([...visualReasons, ...providerReasons])], goalEvidence);
    const base = scoreReasons(reasonCodes) + (hasGoalSequence ? 0.08 : 0.04);
    const moment = normalizeMomentWithEvidence({
      id: `${hasGoalSequence ? "mom_goal_sequence" : "mom_football_sequence"}_${moments.length + 1}`,
      rank: moments.length + 1,
      start,
      end,
      center: Number(((start + end) / 2).toFixed(2)),
      title: titleForHighlightType(highlightTypeForReasons(reasonCodes)),
      summary: goalEvidence.goalClaimAllowed
        ? "Detected from explicit goal sequence evidence."
        : hasNearGoalSequence
          ? "Detected from a shot sequence with reaction support and no goal claim."
          : "Detected from a bounded football action sequence.",
      reasonCodes,
      highlightType: highlightTypeForReasons(reasonCodes),
      confidence: Number(clamp(base, 0.12, 0.95).toFixed(2)),
      retentionScore: Math.round(clamp(base, 0.12, 0.95) * 100),
      suggestedPreset: preset,
      source: hasGoalSequence ? "vision_goal_sequence" : "vision_football_sequence",
      _sequenceSupportReasons: signalReasons,
    }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset, goalEvidenceOverride: providerGoalContext });
    moments.push(moment);
    coveredRanges.push({ start: moment.start, end: moment.end });
    if (moments.length >= GOAL_DISCOVERY_MAX_MOMENTS) break;
  }
  if (moments.length < GOAL_DISCOVERY_MAX_MOMENTS) {
    for (const anchor of sorted) {
      if (moments.length >= GOAL_DISCOVERY_MAX_MOMENTS) break;
      const anchorReasons = new Set(visualReasonCodesForWindow(anchor));
      if (!hasFootballShotOrSaveContext(anchorReasons)) continue;
      const anchorCenter = visualWindowCenter(anchor);
      const cluster = sorted.filter((window) => Math.abs(visualWindowCenter(window) - anchorCenter) <= 9);
      const clusterStart = Math.min(...cluster.map((window) => seconds(window.start)));
      const clusterEnd = Math.max(...cluster.map((window) => seconds(window.end)));
      const alreadyCovered = coveredRanges.some((range) => sourceOverlapSeconds(
        { sourceStart: range.start, sourceEnd: range.end },
        { sourceStart: clusterStart, sourceEnd: clusterEnd },
      ) > 0.5);
      if (alreadyCovered) continue;
      const signalReasons = signalReasonsForVisualRange(safeSignals, clusterStart, clusterEnd);
      const rawVisualReasons = [...new Set(cluster.flatMap(visualReasonCodesForWindow))];
      const sequenceReasons = [...new Set([...rawVisualReasons, ...signalReasons])];
      const goalEvidence = goalEvidenceForContext({ reasons: sequenceReasons, visualWindows: cluster, center: anchorCenter });
      if (goalEvidence.hasBallInNetOrLineCross) continue;
      const actionSequence = actionSequenceForReasons(sequenceReasons, goalEvidence);
      const reasonSet = new Set(sequenceReasons);
      const hasFootballActionContext = hasFootballShotOrSaveContext(reasonSet);
      const hasNearGoalSequence = hasFootballActionContext &&
        actionSequence.ballTrajectory &&
        (
          actionSequence.goalmouthOrKeeper ||
          actionSequence.payoff ||
          actionSequence.reactionSupport ||
          actionSequence.replaySupport
        );
      const hasChanceSequence = hasFootballActionContext && actionSequence.ballTrajectory && actionSequence.actionStageCount >= 2;
      if (!hasNearGoalSequence && !hasChanceSequence) continue;
      let start = Number(clamp(clusterStart - 4.5, 0, duration).toFixed(2));
      let end = Number(clamp(clusterEnd + (hasNearGoalSequence ? 8.5 : 6), start + 3, duration).toFixed(2));
      const minDuration = hasNearGoalSequence ? 16 : 12;
      const maxDuration = hasNearGoalSequence ? 24 : 18;
      if (end - start < minDuration) {
        const missing = minDuration - (end - start);
        start = Number(clamp(start - missing * 0.45, 0, duration).toFixed(2));
        end = Number(clamp(end + missing * 0.55, start + 3, duration).toFixed(2));
      }
      if (end - start > maxDuration) {
        end = Number(Math.min(duration, start + maxDuration).toFixed(2));
      }
      const reasonCodes = reasonCodesWithGoalEvidence(rawVisualReasons, goalEvidence);
      const base = scoreReasons(reasonCodes) + 0.04;
      const moment = normalizeMomentWithEvidence({
        id: `mom_football_sequence_${moments.length + 1}`,
        rank: moments.length + 1,
        start,
        end,
        center: Number(((start + end) / 2).toFixed(2)),
        title: titleForHighlightType(highlightTypeForReasons(reasonCodes)),
        summary: hasNearGoalSequence
          ? "Detected from a shot sequence with reaction support and no goal claim."
          : "Detected from a bounded football action sequence.",
        reasonCodes,
        highlightType: highlightTypeForReasons(reasonCodes),
        confidence: Number(clamp(base, 0.12, 0.9).toFixed(2)),
        retentionScore: Math.round(clamp(base, 0.12, 0.9) * 100),
        suggestedPreset: preset,
        source: "vision_football_sequence",
        _sequenceSupportReasons: signalReasons,
      }, { signals: safeSignals, visualSignals: safeVisualSignals, captions, preset });
      moments.push(moment);
      coveredRanges.push({ start: moment.start, end: moment.end });
    }
  }
  return moments;
}

function goalDiscoverySummary({ safeVisualSignals = {}, safeSignals = {}, goalSequenceMoments = [], goalEvidence = null, matchEventTruth = null } = {}) {
  const duration = seconds(safeSignals.durationSeconds || 0);
  const windows = Array.isArray(safeVisualSignals.windows) ? safeVisualSignals.windows : [];
  const buckets = goalDiscoveryBuckets(windows, duration);
  const bucketSummaries = buckets.map((bucket) => {
    const reasonCodes = [...new Set(
      rankedGoalDiscoveryWindows(bucket.windows)
        .slice(0, 4)
        .flatMap(visualReasonCodesForWindow),
    )].slice(0, 10);
    return {
      index: bucket.index,
      start: bucket.start,
      end: bucket.end,
      windowCount: bucket.windows.length,
      topReasonCodes: reasonCodes,
    };
  });
  const outcomes = goalSequenceMoments.map((moment) => ({
    id: sanitizeText(moment.id, 80),
    start: Number(moment.start || 0),
    end: Number(moment.end || 0),
    highlightType: sanitizeText(moment.highlightType || "generic_highlight", 48),
    goalOutcome: moment.evidence && moment.evidence.goalOutcome && moment.evidence.goalOutcome.eventType === "ball_in_net"
      ? {
          outcome: sanitizeText(moment.evidence.goalOutcome.outcome, 40),
          offsideStatus: sanitizeText(moment.evidence.goalOutcome.offsideStatus, 32),
          decisionTimestamp: moment.evidence.goalOutcome.decisionTimestamp == null
            ? null
            : Number(moment.evidence.goalOutcome.decisionTimestamp),
        }
      : null,
    reasonCodes: Array.isArray(moment.reasonCodes) ? moment.reasonCodes.map((reason) => sanitizeText(reason, 64)).slice(0, 12) : [],
  }));
  return {
    version: 1,
    sourceDuration: Number(duration.toFixed(2)),
    visualWindowCount: windows.length,
    bucketCount: buckets.length,
    lateBucketInspected: bucketSummaries.some((bucket) => bucket.index >= Math.floor(buckets.length * 0.66) && bucket.windowCount > 0),
    candidateWindowsByBucket: bucketSummaries,
    selectedValidGoals: outcomes.filter((item) => item.goalOutcome && item.goalOutcome.outcome === "confirmed_goal"),
    excludedOffsideOrNoGoal: outcomes.filter((item) => item.goalOutcome && ["disallowed_offside", "possible_offside"].includes(item.goalOutcome.outcome)),
    excludedUnconfirmedBallInNet: outcomes.filter((item) => item.goalOutcome && item.goalOutcome.outcome === "unknown_decision"),
    excludedBigChances: outcomes.filter((item) => !item.goalOutcome && item.highlightType !== "goal").slice(0, 8),
    goalEvidence: goalEvidence && goalEvidence.summary
      ? {
          eventCount: Number(goalEvidence.summary.eventCount || 0),
          validGoalCount: Number(goalEvidence.summary.validGoalCount || 0),
          offsideOrNoGoalCount: Number(goalEvidence.summary.offsideOrNoGoalCount || 0),
          unconfirmedGoalCount: Number(goalEvidence.summary.unconfirmedGoalCount || 0),
          celebrationOnlyCount: Number(goalEvidence.summary.celebrationOnlyCount || 0),
          anthemOrIntroCount: Number(goalEvidence.summary.anthemOrIntroCount || 0),
          ocrEvidenceCount: Number(goalEvidence.summary.ocrEvidenceCount || 0),
          scoreboardConfirmedGoalCount: Number(goalEvidence.summary.scoreboardConfirmedGoalCount || 0),
          ambiguousOcrCount: Number(goalEvidence.summary.ambiguousOcrCount || 0),
          goalEvidenceCoverage: Number(goalEvidence.summary.goalEvidenceCoverage || 0),
        }
      : null,
    matchEventTruth: matchEventTruth && matchEventTruth.summary
      ? {
          eventCount: Number(matchEventTruth.summary.eventCount || 0),
          confirmedGoalCount: Number(matchEventTruth.summary.confirmedGoalCount || 0),
          disallowedGoalCount: Number(matchEventTruth.summary.disallowedGoalCount || 0),
          possibleGoalCount: Number(matchEventTruth.summary.possibleGoalCount || 0),
          lateConfirmedGoalCount: Number(matchEventTruth.summary.lateConfirmedGoalCount || 0),
          noFalseGoalFromOcrOnly: Number(matchEventTruth.summary.noFalseGoalFromOcrOnly || 0),
          ocrQaSupportStatus: sanitizeText(matchEventTruth.summary.ocrQaSupportStatus || "ignored", 32),
        }
      : null,
  };
}

function detectHighlights({ transcript, signals, visualSignals, goalEvidence = null, matchEventTruth = null, preset = "hype" } = {}) {
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

  const signalOnlyMoments = selectTemporalCoverage(safeSignals.audioPeaks || [], {
    maxItems: 6,
    duration,
    score: (peak) => peak.energyScore,
  }).map((peak, index) => {
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

  const visualOnlyMoments = selectTemporalCoverage(safeVisualSignals.windows, {
    maxItems: 8,
    duration,
    score: (window) => window.confidence,
  }).map((window, index) => {
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

  const safeMatchEventTruth = matchEventTruth || analyzeMatchEventTruth({
    metadata: safeSignals,
    transcript,
    mediaSignals: safeSignals,
    visualSignals: safeVisualSignals,
    goalEvidence,
  });
  const truthMoments = createMatchEventTruthMoments(safeMatchEventTruth, safeSignals, safeVisualSignals, captions, preset);
  const goalSequenceMoments = createGoalSequenceMoments(safeVisualSignals, safeSignals, captions, preset, goalEvidence);
  const discoverySummary = goalDiscoverySummary({ safeVisualSignals, safeSignals, goalSequenceMoments: [...truthMoments, ...goalSequenceMoments], goalEvidence, matchEventTruth: safeMatchEventTruth });

  const merged = [...truthMoments, ...goalSequenceMoments, ...captionMoments, ...signalOnlyMoments, ...visualOnlyMoments]
    .filter((moment) => moment.end - moment.start >= 3)
    .sort((a, b) => b.retentionScore - a.retentionScore || a.start - b.start);
  const deduped = [];
  const addMoment = (moment) => {
    if (deduped.some((existing) => Math.abs(existing.center - moment.center) < 2.5)) return false;
    deduped.push({ ...moment, rank: deduped.length + 1 });
    return true;
  };
  for (const moment of merged.filter(isGoalCoverageMoment).sort((a, b) => a.start - b.start)) {
    addMoment(moment);
  }
  for (const moment of goalSequenceMoments.filter((moment) => !isGoalCoverageMoment(moment)).sort((a, b) => a.start - b.start)) {
    addMoment(moment);
  }
  for (const moment of merged) {
    if (deduped.length >= 12) break;
    addMoment(moment);
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
      goalDiscovery: discoverySummary,
      matchEventTruth: publicMatchEventTruth(safeMatchEventTruth),
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
    const fallbackSequence = actionSequenceForReasons(moment && moment.reasonCodes || [], moment && moment.evidence && moment.evidence.goalEvidence || {});
    const footballSequence = footballSequenceForContext({
      start: moment && moment.start,
      end: moment && moment.end,
      center: moment && moment.center,
      reasons: moment && moment.reasonCodes || [],
      goalEvidence: moment && moment.evidence && moment.evidence.goalEvidence || {},
      goalOutcome: moment && moment.evidence && moment.evidence.goalOutcome || null,
    });
    return {
      ...fallbackSequence,
      footballSequence,
    };
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
    footballSequence: sequence.footballSequence && typeof sequence.footballSequence === "object" && !Array.isArray(sequence.footballSequence)
      ? {
          sequenceType: sanitizeText(sequence.footballSequence.sequenceType || "chance_sequence", 40),
          start: roundedTime(sequence.footballSequence.start),
          shotStart: roundedTime(sequence.footballSequence.shotStart),
          payoffStart: roundedTime(sequence.footballSequence.payoffStart),
          payoffEnd: roundedTime(sequence.footballSequence.payoffEnd),
          decisionContextStart: sequence.footballSequence.decisionContextStart == null
            ? null
            : roundedTime(sequence.footballSequence.decisionContextStart),
          end: roundedTime(sequence.footballSequence.end),
          outcome: sanitizeText(sequence.footballSequence.outcome || "none", 40),
          confidence: Number(clamp(sequence.footballSequence.confidence, 0, 1).toFixed(2)),
          evidenceCodes: Array.isArray(sequence.footballSequence.evidenceCodes)
            ? sequence.footballSequence.evidenceCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 16)
            : [],
          missingEvidence: Array.isArray(sequence.footballSequence.missingEvidence)
            ? sequence.footballSequence.missingEvidence.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 6)
            : [],
        }
      : null,
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
  minTotalDuration: 45,
  maxTotalDuration: 90,
});

const VALID_GOAL_ONLY_TIMING = Object.freeze({
  minSegmentDuration: 10,
  maxSegmentDuration: 29.5,
  preContextSeconds: 1.2,
  postContextSeconds: 3.8,
  decisionPostSeconds: 1.4,
  minTransitionGapSeconds: 0.25,
});

const GOAL_SELECTION_MODES = Object.freeze({
  balanced: "balanced",
  validGoalsOnly: "valid_goals_only",
});

function normalizeGoalSelectionMode(value) {
  return value === GOAL_SELECTION_MODES.validGoalsOnly
    ? GOAL_SELECTION_MODES.validGoalsOnly
    : GOAL_SELECTION_MODES.balanced;
}

function truthEventsForValidGoalsOnly(matchEventTruth = null) {
  const raw = matchEventTruth && typeof matchEventTruth === "object"
    ? {
        ...matchEventTruth,
        events: Array.isArray(matchEventTruth.events)
          ? matchEventTruth.events
          : Array.isArray(matchEventTruth.selectedEvents)
            ? matchEventTruth.selectedEvents
            : [],
        rejectedEvents: Array.isArray(matchEventTruth.rejectedEvents) ? matchEventTruth.rejectedEvents : [],
      }
    : matchEventTruth;
  const truth = publicMatchEventTruth(raw);
  const selectedEvents = Array.isArray(truth.selectedEvents) ? truth.selectedEvents : [];
  return selectedEvents
    .filter((event) => event.type === "confirmed_goal" && event.outcome === "confirmed_goal")
    .sort((a, b) => Number(a.sourceStart || 0) - Number(b.sourceStart || 0));
}

function truthGoalReasonCodes(event = {}) {
  const evidenceCodes = Array.isArray(event.evidenceCodes) ? event.evidenceCodes : [];
  return [...new Set([
    "goal",
    evidenceCodes.includes("scoreboard_backed_goal_sequence") ? "scoreboard_backed_goal_sequence" : "visual_ball_in_net",
    ...evidenceCodes.filter((code) => (
      code === "scoreboard_backed_goal_sequence" ||
      code === "ball_in_net" ||
      code === "visual_ball_in_net" ||
      code === "visual_shot_contact" ||
      code === "visual_shot_like_motion" ||
      code === "visual_ball_toward_goal" ||
      code === "visual_goal_mouth" ||
      code === "visual_scoreboard_goal_confirmed" ||
      code === "visual_referee_goal_signal" ||
      code === "confirmed_by_commentary" ||
      code === "scoreboard_ocr_score_change" ||
      code === "scoreboard_temporal_consistency" ||
      code === "audio_energy_spike" ||
      code === "scene_change_cluster"
    )),
  ])].slice(0, 18);
}

function truthGoalWindowForPlan(event = {}, metadata = {}) {
  const duration = Math.max(0, Number(metadata.durationSeconds || 0));
  const eventStart = Number(event.sourceStart || 0);
  const eventEnd = Math.max(eventStart + 0.5, Number(event.sourceEnd || eventStart + 1));
  const buildupStart = event.buildupWindow && Number.isFinite(Number(event.buildupWindow.start))
    ? Number(event.buildupWindow.start)
    : eventStart;
  const shotStart = event.shotWindow && Number.isFinite(Number(event.shotWindow.start))
    ? Number(event.shotWindow.start)
    : eventStart;
  const payoffEnd = event.payoffWindow && Number.isFinite(Number(event.payoffWindow.end))
    ? Number(event.payoffWindow.end)
    : eventEnd;
  const decisionEnd = event.decisionWindow && Number.isFinite(Number(event.decisionWindow.end))
    ? Number(event.decisionWindow.end)
    : payoffEnd;
  let sourceStart = Math.max(0, Math.min(eventStart, buildupStart, shotStart) - VALID_GOAL_ONLY_TIMING.preContextSeconds);
  let sourceEnd = Math.max(
    eventEnd,
    payoffEnd + VALID_GOAL_ONLY_TIMING.postContextSeconds,
    decisionEnd + VALID_GOAL_ONLY_TIMING.decisionPostSeconds,
  );
  if (duration > 0) sourceEnd = Math.min(duration, sourceEnd);
  if (sourceEnd - sourceStart < VALID_GOAL_ONLY_TIMING.minSegmentDuration) {
    const missing = VALID_GOAL_ONLY_TIMING.minSegmentDuration - (sourceEnd - sourceStart);
    sourceStart = Math.max(0, sourceStart - missing * 0.55);
    sourceEnd = Math.min(duration || sourceEnd + missing * 0.45, sourceEnd + missing * 0.45);
  }
  if (sourceEnd - sourceStart > VALID_GOAL_ONLY_TIMING.maxSegmentDuration) {
    sourceEnd = Math.min(duration || sourceStart + VALID_GOAL_ONLY_TIMING.maxSegmentDuration, sourceStart + VALID_GOAL_ONLY_TIMING.maxSegmentDuration);
  }
  return {
    sourceStart: Number(sourceStart.toFixed(2)),
    sourceEnd: Number(Math.max(sourceStart + 3, sourceEnd).toFixed(2)),
  };
}

function truthGoalOutcomeForEvent(event = {}) {
  const evidenceSet = new Set(Array.isArray(event.evidenceCodes) ? event.evidenceCodes : []);
  const decisionEvidence = [];
  if (evidenceSet.has("scoreboard_ocr_score_change") || evidenceSet.has("scoreboard_temporal_consistency")) {
    decisionEvidence.push("scoreboard_goal_confirmed");
  }
  if (evidenceSet.has("scoreboard_backed_goal_sequence")) decisionEvidence.push("scoreboard_backed_goal_sequence");
  if (evidenceSet.has("visual_scoreboard_goal_confirmed")) decisionEvidence.push("visual_scoreboard_goal_confirmed");
  if (evidenceSet.has("visual_referee_goal_signal")) decisionEvidence.push("visual_referee_goal_signal");
  if (evidenceSet.has("confirmed_by_commentary")) decisionEvidence.push("confirmed_by_commentary");
  return normalizeGoalOutcome({
    eventType: "ball_in_net",
    outcome: "confirmed_goal",
    offsideStatus: "onside",
    confidence: event.confidence,
    decisionTimestamp: event.decisionWindow && Number.isFinite(Number(event.decisionWindow.start))
      ? Number(event.decisionWindow.start)
      : event.payoffWindow && Number.isFinite(Number(event.payoffWindow.end))
        ? Number(event.payoffWindow.end)
        : event.sourceEnd,
    decisionEvidence,
  }, { highlightType: "goal", reasonCodes: ["goal", "visual_ball_in_net"] });
}

function createTruthDrivenValidGoalMoments({ matchEventTruth, metadata, signals, visualSignals, captions, preset = "hype" } = {}) {
  const events = truthEventsForValidGoalsOnly(matchEventTruth);
  return events.map((event, index) => {
    const { sourceStart, sourceEnd } = truthGoalWindowForPlan(event, metadata || signals || {});
    const reasonCodes = truthGoalReasonCodes(event);
    const confidence = Number(clamp(Number(event.confidence || 0.9) + 0.04, 0.12, 0.98).toFixed(2));
    return normalizeMomentWithEvidence({
      id: `mom_valid_goal_truth_${index + 1}_${event.id}`,
      rank: index + 1,
      start: sourceStart,
      end: sourceEnd,
      center: Number(((sourceStart + sourceEnd) / 2).toFixed(2)),
      title: titleForHighlightType("goal"),
      summary: "Confirmed valid goal selected from match event truth.",
      reasonCodes,
      highlightType: "goal",
      confidence,
      retentionScore: Math.round(confidence * 100),
      suggestedPreset: preset,
      source: "match_event_truth_valid_goals_only",
      captionIntent: "confirmed_goal_caption",
      evidence: {
        goalOutcome: truthGoalOutcomeForEvent(event),
      },
      rankingExplanation: rankingExplanationForMoment({
        reasons: reasonCodes,
        score: confidence,
        source: "match_event_truth_valid_goals_only",
        visualSignals,
        goalEvidence: matchEventTruthGoalEvidence(event),
      }),
    }, {
      signals: signals || metadata || {},
      visualSignals,
      captions,
      preset,
      goalEvidenceOverride: matchEventTruthGoalEvidence(event),
    });
  });
}

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

const STRONG_MULTI_MOMENT_ACTION_TYPES = Object.freeze([
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
]);

const STRONG_MULTI_MOMENT_ACTION_REASONS = Object.freeze([
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
  "visual_shot_like_motion",
  "visual_shot_contact",
  "visual_ball_toward_goal",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_ball_in_net",
  "visual_foul_like_contact",
  "visual_fast_break",
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

function hasStrongCompilationAction(candidate = {}) {
  const moment = candidate.analysisMoment || {};
  const highlightType = sanitizeText(candidate.highlightType || moment.highlightType || "", 40);
  if (STRONG_MULTI_MOMENT_ACTION_TYPES.includes(highlightType)) return true;
  const reasonCodes = Array.isArray(candidate.reasonCodes)
    ? candidate.reasonCodes
    : Array.isArray(moment.reasonCodes)
      ? moment.reasonCodes
      : [];
  const reasonSet = new Set(reasonCodes);
  return STRONG_MULTI_MOMENT_ACTION_REASONS.some((reason) => reasonSet.has(reason));
}

function isWeakOpeningCompilationCandidate(candidate = {}, metadata = {}) {
  const mediaDuration = Number(metadata.durationSeconds || 0);
  if (mediaDuration < 90) return false;
  const sourceStart = Number(candidate.sourceStart || 0);
  const openingCutoff = 16;
  if (sourceStart >= openingCutoff) return false;
  return !hasStrongCompilationAction(candidate);
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
  const footballSequence = actionSummary && actionSummary.footballSequence;
  const actionBoost = hasPrimaryMomentAction(moment) ? 18 : 0;
  const replayBoost = candidate.highlightType === "replay_worthy_moment" ? 8 : 0;
  const reactionPenalty = isReactionOnlyMoment(moment) ? 9 : 0;
  const openingPenalty = isOpeningFillerMoment(moment) ? 100 : 0;
  const sequenceBoost = Number(actionSummary.actionStageCount || 0) * 2;
  const footballSequenceBoost = footballSequence && footballSequence.sequenceType === "goal_sequence"
    ? 12
    : footballSequence && footballSequence.sequenceType === "near_goal_sequence"
      ? 8
      : footballSequence && footballSequence.sequenceType === "chance_sequence"
        ? 4
        : 0;
  return Number(candidate.retentionScore || 0) + actionBoost + replayBoost + sequenceBoost + footballSequenceBoost - reactionPenalty - openingPenalty;
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

function sourceOverlapSeconds(a = {}, b = {}) {
  const left = Math.max(Number(a.sourceStart || 0), Number(b.sourceStart || 0));
  const right = Math.min(Number(a.sourceEnd || 0), Number(b.sourceEnd || 0));
  return Math.max(0, right - left);
}

function isReplayCandidate(candidate = {}) {
  const reasonCodes = Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : [];
  return candidate.highlightType === "replay_worthy_moment" ||
    reasonCodes.includes("visual_replay_indicator") ||
    reasonCodes.includes("replay_worthy_moment");
}

function isGoalCoverageMoment(moment = {}) {
  const reasonCodes = Array.isArray(moment.reasonCodes) ? moment.reasonCodes : [];
  const goalOutcome = goalOutcomeForMoment(moment);
  return moment.highlightType === "goal" ||
    reasonCodes.includes("visual_ball_in_net") ||
    (goalOutcome && goalOutcome.eventType === "ball_in_net");
}

function isGoalCoverageCandidate(candidate = {}) {
  const moment = candidate.analysisMoment || candidate || {};
  const reasonCodes = Array.isArray(candidate.reasonCodes)
    ? candidate.reasonCodes
    : Array.isArray(moment.reasonCodes)
      ? moment.reasonCodes
      : [];
  const goalOutcome = candidate.goalOutcome || goalOutcomeForMoment(moment);
  return candidate.highlightType === "goal" ||
    isGoalCoverageMoment(moment) ||
    reasonCodes.includes("visual_ball_in_net") ||
    (goalOutcome && goalOutcome.eventType === "ball_in_net");
}

function isConfirmedGoalCandidate(candidate = {}) {
  const moment = candidate.analysisMoment || candidate || {};
  const reasonCodes = Array.isArray(candidate.reasonCodes)
    ? candidate.reasonCodes
    : Array.isArray(moment.reasonCodes)
      ? moment.reasonCodes
      : [];
  const goalOutcome = candidate.goalOutcome || goalOutcomeForMoment(moment);
  const reasonSet = new Set(reasonCodes);
  const hasBallInNetEvidence = reasonSet.has("visual_ball_in_net") || reasonSet.has("ball_in_net");
  const hasScoreboardBackedGoalEvidence = reasonSet.has("scoreboard_backed_goal_sequence") &&
    (reasonSet.has("scoreboard_ocr_score_change") || reasonSet.has("scoreboard_temporal_consistency"));
  const hasGoalEventEvidence = hasBallInNetEvidence || hasScoreboardBackedGoalEvidence;
  const hasActionEvidence = hasGoalEventEvidence && (
    reasonSet.has("visual_shot_contact") ||
    reasonSet.has("visual_ball_toward_goal") ||
    reasonSet.has("visual_shot_like_motion") ||
    reasonSet.has("shot_sequence_support") ||
    (
      moment.actionSequenceSummary &&
      moment.actionSequenceSummary.footballSequence &&
      moment.actionSequenceSummary.footballSequence.sequenceType === "goal_sequence" &&
      moment.actionSequenceSummary.footballSequence.payoff !== false
    )
  );
  return candidate.highlightType === "goal" &&
    reasonCodes.includes("goal") &&
    hasActionEvidence &&
    goalOutcome &&
    goalOutcome.eventType === "ball_in_net" &&
    goalOutcome.outcome === "confirmed_goal" &&
    goalOutcome.offsideStatus !== "offside";
}

function hasUnsafeCompilationOverlap(existing = {}, candidate = {}) {
  const overlap = sourceOverlapSeconds(existing, candidate);
  if (overlap <= 0.5) return false;
  if (isReplayCandidate(existing) || isReplayCandidate(candidate)) {
    return sourceOverlapRatio(existing, candidate) > 0.35;
  }
  return true;
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

function candidateStableKey(candidate = {}) {
  const moment = candidate.analysisMoment || {};
  return sanitizeText(
    candidate.candidateId ||
      moment.id ||
      `${candidate.highlightType || "candidate"}:${Number(candidate.sourceStart || 0).toFixed(2)}-${Number(candidate.sourceEnd || 0).toFixed(2)}`,
    96,
  );
}

function compilationHandlesForCandidate(candidate = {}) {
  const moment = candidate.analysisMoment || {};
  const goalOutcome = candidate.goalOutcome || goalOutcomeForMoment(moment);
  if (isConfirmedGoalCandidate(candidate)) {
    const sourceEnd = Number(candidate.sourceEnd ?? moment.end);
    const decisionTimestamp = Number(goalOutcome && goalOutcome.decisionTimestamp);
    const decisionPost = Number.isFinite(decisionTimestamp) && Number.isFinite(sourceEnd) && decisionTimestamp > sourceEnd
      ? decisionTimestamp - sourceEnd + 0.8
      : 0.75;
    return { pre: 0.25, post: Number(clamp(Math.max(0.75, decisionPost), 0.75, 1.6).toFixed(2)) };
  }
  if (isGoalCoverageCandidate(candidate)) {
    return goalOutcome && goalOutcome.requiresPostContext
      ? { pre: 5, post: 12 }
      : { pre: 5, post: 9 };
  }
  if (hasStrongCompilationAction(candidate)) {
    return { pre: 3.2, post: 4.5 };
  }
  if (isReactionOnlyMoment(moment)) {
    return { pre: 2.6, post: 3.2 };
  }
  return { pre: 2, post: 2.8 };
}

function limitCandidateDurationWithHandles(candidate = {}, maxDuration = 30, mediaDuration = 0) {
  const originalStart = Number(candidate.originalSourceStart ?? candidate.sourceStart);
  const originalEnd = Number(candidate.originalSourceEnd ?? candidate.sourceEnd);
  const originalDuration = Math.max(0, originalEnd - originalStart);
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart) return candidate;
  if (candidate.sourceEnd - candidate.sourceStart <= maxDuration) return candidate;

  if (originalDuration >= maxDuration) {
    return {
      ...candidate,
      sourceStart: Number(originalStart.toFixed(2)),
      sourceEnd: Number(Math.min(mediaDuration || originalStart + maxDuration, originalStart + maxDuration).toFixed(2)),
    };
  }

  const extraBudget = Math.max(0, maxDuration - originalDuration);
  const currentPre = Math.max(0, originalStart - Number(candidate.sourceStart));
  const currentPost = Math.max(0, Number(candidate.sourceEnd) - originalEnd);
  const preBudget = Math.min(currentPre, extraBudget * (isGoalCoverageCandidate(candidate) ? 0.36 : 0.5));
  const postBudget = Math.min(currentPost, extraBudget - preBudget);
  const start = Math.max(0, originalStart - preBudget);
  const end = Math.min(mediaDuration || originalEnd + postBudget, originalEnd + postBudget);
  return {
    ...candidate,
    sourceStart: Number(start.toFixed(2)),
    sourceEnd: Number(end.toFixed(2)),
  };
}

function roundTimestamp(value) {
  return Number(Number(value || 0).toFixed(2));
}

function compilationBoundaryBetween(previous = {}, current = {}) {
  const previousOriginalEnd = Number(previous.originalSourceEnd ?? previous.sourceEnd);
  const currentOriginalStart = Number(current.originalSourceStart ?? current.sourceStart);
  if (Number.isFinite(previousOriginalEnd) && Number.isFinite(currentOriginalStart)) {
    return (previousOriginalEnd + currentOriginalStart) / 2;
  }
  return (Number(previous.sourceEnd || 0) + Number(current.sourceStart || 0)) / 2;
}

function sanitizeExpandedCompilationOverlaps(expanded = []) {
  const sanitized = [];
  for (const candidate of expanded) {
    const current = { ...candidate };
    if (current.sourceEnd - current.sourceStart < 3) continue;
    if (!sanitized.length) {
      sanitized.push(current);
      continue;
    }

    const previous = sanitized[sanitized.length - 1];
    if (previous.sourceEnd > current.sourceStart) {
      const previousMinEnd = Number((previous.sourceStart + 3).toFixed(2));
      const currentMaxStart = Number((current.sourceEnd - 3).toFixed(2));
      if (previousMinEnd > currentMaxStart) continue;

      const boundary = roundTimestamp(clamp(
        compilationBoundaryBetween(previous, current),
        previousMinEnd,
        currentMaxStart,
      ));
      previous.sourceEnd = roundTimestamp(Math.min(previous.sourceEnd, boundary));
      current.sourceStart = roundTimestamp(Math.max(current.sourceStart, boundary));
    }

    if (current.sourceEnd - current.sourceStart >= 3) sanitized.push(current);
  }
  return sanitized;
}

function expandCompilationCandidateWindows(candidates = [], metadata = {}) {
  const mediaDuration = Math.max(0, Number(metadata.durationSeconds || 0));
  const maxSegmentDuration = 29.5;
  const expanded = candidates
    .map((candidate) => {
      const sourceStart = Number(candidate.sourceStart);
      const sourceEnd = Number(candidate.sourceEnd);
      const handles = compilationHandlesForCandidate(candidate);
      const next = {
        ...candidate,
        originalSourceStart: Number(sourceStart.toFixed(2)),
        originalSourceEnd: Number(sourceEnd.toFixed(2)),
        sourceStart: Number(Math.max(0, sourceStart - handles.pre).toFixed(2)),
        sourceEnd: Number(Math.min(mediaDuration || sourceEnd + handles.post, sourceEnd + handles.post).toFixed(2)),
      };
      return limitCandidateDurationWithHandles(next, maxSegmentDuration, mediaDuration);
    })
    .sort((a, b) => a.sourceStart - b.sourceStart);

  const sanitized = sanitizeExpandedCompilationOverlaps(expanded);

  let totalDuration = sanitized.reduce((sum, candidate) => sum + Math.max(0, candidate.sourceEnd - candidate.sourceStart), 0);
  for (let index = sanitized.length - 1; index >= 0 && totalDuration > MULTI_MOMENT_COMPILATION.maxTotalDuration; index -= 1) {
    const candidate = sanitized[index];
    const removablePostHandle = Math.max(0, candidate.sourceEnd - Number(candidate.originalSourceEnd ?? candidate.sourceEnd));
    const cut = Math.min(removablePostHandle, totalDuration - MULTI_MOMENT_COMPILATION.maxTotalDuration);
    if (cut <= 0) continue;
    candidate.sourceEnd = Number((candidate.sourceEnd - cut).toFixed(2));
    totalDuration -= cut;
  }
  for (let index = 0; index < sanitized.length && totalDuration > MULTI_MOMENT_COMPILATION.maxTotalDuration; index += 1) {
    const candidate = sanitized[index];
    const removablePreHandle = Math.max(0, Number(candidate.originalSourceStart ?? candidate.sourceStart) - candidate.sourceStart);
    const cut = Math.min(removablePreHandle, totalDuration - MULTI_MOMENT_COMPILATION.maxTotalDuration);
    if (cut <= 0) continue;
    candidate.sourceStart = Number((candidate.sourceStart + cut).toFixed(2));
    totalDuration -= cut;
  }
  return sanitized.map((candidate) => ({
    ...candidate,
    sourceStart: Number(candidate.sourceStart.toFixed(2)),
    sourceEnd: Number(candidate.sourceEnd.toFixed(2)),
  })).filter((candidate) => candidate.sourceEnd - candidate.sourceStart >= 3);
}

function segmentCaptionText(segment, index) {
  const phase = `MOMENT ${index + 1}`;
  const outcome = segment && segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
    ? segment.goalOutcome.outcome
    : null;
  if (outcome === "confirmed_goal") return `${phase}: FINISH COUNTS`;
  if (outcome === "disallowed_offside") return `${phase}: OFFSIDE - NO GOAL`;
  if (outcome === "possible_offside") return `${phase}: VAR CHECK`;
  if (outcome === "unknown_decision") return `${phase}: DECISION UNCLEAR`;
  const reasons = new Set(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []);
  const footballSequence = segment &&
    segment.actionSequenceSummary &&
    segment.actionSequenceSummary.footballSequence &&
    typeof segment.actionSequenceSummary.footballSequence === "object"
    ? segment.actionSequenceSummary.footballSequence
    : null;
  if (footballSequence && footballSequence.outcome === "disallowed_offside") return `${phase}: OFFSIDE - NO GOAL`;
  if (footballSequence && footballSequence.outcome === "possible_offside") return `${phase}: VAR CHECK`;
  if (footballSequence && footballSequence.outcome === "unknown_decision" && reasons.has("visual_ball_in_net")) {
    return `${phase}: DECISION UNCLEAR`;
  }
  if (footballSequence && footballSequence.sequenceType === "near_goal_sequence") {
    if (reasons.has("visual_save_like_motion") || reasons.has("visual_keeper_action") || segment.highlightType === "save") {
      return `${phase}: KEEPER HAS TO REACT`;
    }
    if (reasons.has("visual_replay_indicator") || reasons.has("replay_worthy_moment")) return `${phase}: CHECK THE ANGLE`;
    return `${phase}: SHOT OPENS UP`;
  }
  if (footballSequence && footballSequence.sequenceType === "chance_sequence") return `${phase}: BIG CHANCE`;
  if (reasons.has("visual_shot_like_motion") || reasons.has("visual_shot_contact") || reasons.has("visual_ball_toward_goal")) {
    return `${phase}: SHOT OPENS UP`;
  }
  if (reasons.has("visual_save_like_motion") || reasons.has("visual_keeper_action")) return `${phase}: KEEPER HAS TO REACT`;
  if (reasons.has("visual_fast_break") || reasons.has("counter_attack")) return `${phase}: SPACE OPENS`;
  if (reasons.has("visual_foul_like_contact")) return `${phase}: CONTACT CHANGES IT`;
  if (reasons.has("visual_replay_indicator") || reasons.has("replay_worthy_moment")) return `${phase}: CHECK THE ANGLE`;
  if (reasons.has("visual_crowd_reaction") || reasons.has("crowd_reaction") || reasons.has("audio_energy_spike")) {
    return `${phase}: REACTION AFTER THE PLAY`;
  }
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
    unknown_action: `${phase}: WATCH THE BUILD-UP`,
    generic_highlight: `${phase}: WATCH THE BUILD-UP`,
  };
  return labels[segment.highlightType] || labels.generic_highlight;
}

function openingCaptionTextForCompilation(segments = []) {
  const goalCount = segments.filter((segment) => segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net").length;
  const confirmedGoalCount = segments.filter((segment) => segment.goalOutcome && segment.goalOutcome.outcome === "confirmed_goal").length;
  if (segments.length > 0 && confirmedGoalCount === segments.length) return "VALID FINISHES ONLY";
  if (goalCount >= 2) return "EVERY FINISH SEQUENCE";
  if (goalCount === 1) return "FINISH + KEY PHASES";
  const sequenceCount = segments.filter((segment) => (
    segment.actionSequenceSummary &&
    segment.actionSequenceSummary.footballSequence &&
    ["near_goal_sequence", "chance_sequence"].includes(segment.actionSequenceSummary.footballSequence.sequenceType)
  )).length;
  if (sequenceCount >= 2) return "EVERY BIG MOMENT";
  const chanceCount = segments.filter((segment) => ["big_chance", "shot_on_target", "near_miss", "save"].includes(segment.highlightType)).length;
  if (chanceCount >= 2) return "EVERY BIG CHANCE";
  return "KEY PHASES ONLY";
}

function closingCaptionTextForCompilation(segments = []) {
  const confirmedGoalCount = segments.filter((segment) => segment.goalOutcome && segment.goalOutcome.outcome === "confirmed_goal").length;
  if (segments.length > 0 && confirmedGoalCount === segments.length) {
    return "ONLY VALID FINISHES";
  }
  if (segments.some((segment) => segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net")) {
    return "CHECK EVERY DECISION";
  }
  if (segments.some((segment) => ["big_chance", "shot_on_target", "near_miss", "save"].includes(segment.highlightType))) {
    return "RUN THE CHANCES BACK";
  }
  return "RUN THE BEST PHASES BACK";
}

function captionsForCompilation(segments, totalDuration) {
  const captions = [{
    start: 0,
    end: Math.min(2.2, totalDuration),
    text: openingCaptionTextForCompilation(segments),
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
    const firstSegmentCaptionStart = index === 0 ? 2.35 : segment.timelineStart + 0.45;
    const start = Number(Math.min(segment.timelineEnd - 0.5, firstSegmentCaptionStart).toFixed(2));
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
    text: closingCaptionTextForCompilation(segments),
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

function transitionPlanForCompilation(segments = []) {
  return (Array.isArray(segments) ? segments : []).slice(1).map((segment, index) => ({
    fromSegmentId: sanitizeText(segments[index] && segments[index].id || `segment_${index + 1}`, 64),
    toSegmentId: sanitizeText(segment.id || `segment_${index + 2}`, 64),
    timelineStart: Number(Math.max(0, Number(segment.timelineStart || 0)).toFixed(2)),
    type: "short_fade",
    cutStyle: "smooth_beat_cut",
    fadeOutSeconds: 0.22,
    fadeInSeconds: 0.18,
    reasonCode: "smooth_goal_sequence_transition",
  }));
}

function selectCompilationCandidates(singleCandidates = [], metadata = {}) {
  const mediaDuration = Number(metadata.durationSeconds || 0);
  if (mediaDuration < MULTI_MOMENT_COMPILATION.minSourceDuration) return [];
  const selected = [];
  const selectedKeys = new Set();
  let totalDuration = 0;
  const ranked = singleCandidates
    .filter((candidate) => candidate && !isOpeningFillerMoment(candidate.analysisMoment) && !isWeakOpeningCompilationCandidate(candidate, metadata))
    .sort((a, b) => compilationSelectionScore(b) - compilationSelectionScore(a) || a.sourceStart - b.sourceStart);

  const addCandidate = (candidate) => {
    const key = candidateStableKey(candidate);
    if (selectedKeys.has(key)) return false;
    if (selected.some((existing) => hasUnsafeCompilationOverlap(existing, candidate))) return false;
    const duration = Number((candidate.sourceEnd - candidate.sourceStart).toFixed(2));
    if (duration < 3) return false;
    if (totalDuration + duration > MULTI_MOMENT_COMPILATION.maxTotalDuration) {
      if (totalDuration >= MULTI_MOMENT_COMPILATION.minTotalDuration) return false;
      const remaining = Number((MULTI_MOMENT_COMPILATION.maxTotalDuration - totalDuration).toFixed(2));
      if (remaining < 6) return false;
      selected.push({ ...candidate, sourceEnd: Number((candidate.sourceStart + remaining).toFixed(2)) });
      selectedKeys.add(key);
      totalDuration += remaining;
      return true;
    }
    selected.push(candidate);
    selectedKeys.add(key);
    totalDuration += duration;
    return true;
  };

  const goalCoverageCandidates = ranked
    .filter(isGoalCoverageCandidate)
    .sort((a, b) => a.sourceStart - b.sourceStart);
  const confirmedGoalCandidates = ranked
    .filter(isConfirmedGoalCandidate)
    .sort((a, b) => a.sourceStart - b.sourceStart);
  if (confirmedGoalCandidates.length >= 2) {
    for (const candidate of confirmedGoalCandidates) {
      if (selected.length >= MULTI_MOMENT_COMPILATION.maxSegments) break;
      addCandidate(candidate);
    }
    const chronological = expandCompilationCandidateWindows(
      selected.sort((a, b) => a.sourceStart - b.sourceStart),
      metadata,
    );
    const finalDuration = chronological.reduce((sum, candidate) => sum + Number(candidate.sourceEnd - candidate.sourceStart), 0);
    if (chronological.length >= 2 && finalDuration <= MULTI_MOMENT_COMPILATION.maxTotalDuration) {
      return chronological.slice(0, MULTI_MOMENT_COMPILATION.maxSegments);
    }
    selected.length = 0;
    selectedKeys.clear();
    totalDuration = 0;
  }
  for (const candidate of goalCoverageCandidates) {
    if (selected.length >= MULTI_MOMENT_COMPILATION.maxSegments) break;
    addCandidate(candidate);
  }

  for (const candidate of ranked) {
    if (selectedKeys.has(candidateStableKey(candidate))) continue;
    if (!addCandidate(candidate)) continue;
    if (selected.length >= MULTI_MOMENT_COMPILATION.maxSegments || totalDuration >= MULTI_MOMENT_COMPILATION.minTotalDuration) {
      const missingGoalCoverage = goalCoverageCandidates.some((goalCandidate) => (
        !selected.some((existing) => sourceOverlapSeconds(existing, goalCandidate) > 0.5)
      ));
      if (missingGoalCoverage && totalDuration < MULTI_MOMENT_COMPILATION.maxTotalDuration) continue;
      const actionCount = selected.filter((item) => hasPrimaryMomentAction(item.analysisMoment)).length;
      const contextCoverageReady = selected.length >= 5 || totalDuration >= 72;
      if (selected.length >= MULTI_MOMENT_COMPILATION.minSegments && (actionCount > 0 || contextCoverageReady)) break;
    }
  }
  const chronological = expandCompilationCandidateWindows(
    selected.sort((a, b) => a.sourceStart - b.sourceStart),
    metadata,
  );
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
  const transitionPlan = transitionPlanForCompilation(segments);
  const primary = selectedCandidates.find((candidate) => hasPrimaryMomentAction(candidate.analysisMoment)) || selectedCandidates[0];
  const compilationHook = openingCaptionTextForCompilation(segments);
  const compilationClosing = closingCaptionTextForCompilation(segments);
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
    transitionPlan,
    goalSelectionMode: segments.every((segment) => (
      segment.highlightType === "goal" &&
      segment.goalOutcome &&
      segment.goalOutcome.outcome === "confirmed_goal"
    )) ? GOAL_SELECTION_MODES.validGoalsOnly : GOAL_SELECTION_MODES.balanced,
    totalDuration,
    aspectRatio: primary.aspectRatio || "9:16",
    highlightType: "generic_highlight",
    confidence: Number(clamp(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0) / selectedCandidates.length, 0, 1).toFixed(2)),
    hook: compilationHook,
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
      hook: compilationHook,
      contextLine: `${segments.length} selected football moments in match order`,
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
        footballSequence: segment.actionSequenceSummary && segment.actionSequenceSummary.footballSequence
          ? {
              sequenceType: segment.actionSequenceSummary.footballSequence.sequenceType,
              outcome: segment.actionSequenceSummary.footballSequence.outcome,
              confidence: segment.actionSequenceSummary.footballSequence.confidence,
            }
          : null,
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
        transitionCount: transitionPlan.length,
        transitionStyle: transitionPlan.length ? "short_fade" : "single_segment",
      },
      animationCues: animationCuesForCompilation(segments, totalDuration, reasonCodes),
      aspectRatio: primary.aspectRatio || "9:16",
      export: primary.export,
      confidence: Number(clamp(selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0) / selectedCandidates.length, 0, 1).toFixed(2)),
      safetyNotes: [
        "Compilation excludes opening context without action evidence.",
        "Reaction moments are included only with action lead-in windows.",
        "Goal language is not used without explicit goal evidence.",
        "Segment captions describe visible action or decision context instead of generic pressure.",
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
      endBeatText: compilationClosing,
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
          footballSequence: segment.actionSequenceSummary && segment.actionSequenceSummary.footballSequence
            ? {
                sequenceType: segment.actionSequenceSummary.footballSequence.sequenceType,
                outcome: segment.actionSequenceSummary.footballSequence.outcome,
                confidence: segment.actionSequenceSummary.footballSequence.confidence,
              }
            : null,
          whySelected: segment.whySelected,
          safetyFlags: segment.safetyFlags,
        })),
        transitionPlan,
        validGoalsOnly: segments.every((segment) => (
          segment.highlightType === "goal" &&
          segment.goalOutcome &&
          segment.goalOutcome.outcome === "confirmed_goal"
        )),
        smoothTransitionCoverage: segments.length <= 1 ? 1 : Number((transitionPlan.length / (segments.length - 1)).toFixed(2)),
      },
    },
  };
}

function prioritizeCandidateMoments(moments = []) {
  const safeMoments = (Array.isArray(moments) ? moments : []).filter(Boolean);
  const goalMoments = safeMoments
    .filter(isGoalCoverageMoment)
    .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  const goalIds = new Set(goalMoments.map((moment) => moment.id));
  const sequenceMoments = safeMoments
    .filter((moment) => !goalIds.has(moment.id) && moment.source === "vision_football_sequence")
    .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  const sequenceIds = new Set(sequenceMoments.map((moment) => moment.id));
  const remaining = safeMoments
    .filter((moment) => !goalIds.has(moment.id) && !sequenceIds.has(moment.id))
    .sort((a, b) => Number(b.retentionScore || 0) - Number(a.retentionScore || 0) || Number(a.start || 0) - Number(b.start || 0));
  return [...goalMoments, ...sequenceMoments, ...remaining].slice(0, 12);
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
  matchEventTruth = null,
  language = "auto",
  styleTarget = "vertical_9_16",
  editIntensity = "balanced",
  stylePreset = "social_sports_v1",
  captionProvider = null,
} = {}) {
  const renderStylePreset = normalizeStylePreset(stylePreset);
  const goalSelectionMode = normalizeGoalSelectionMode(metadata && metadata.goalSelectionMode);
  const truthDrivenValidGoalMoments = goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly
    ? createTruthDrivenValidGoalMoments({
        matchEventTruth,
        metadata,
        signals: mediaSignals || metadata || {},
        visualSignals,
        captions: normalizedCaptions(transcript),
        preset,
      })
    : [];
  const prioritizedMoments = goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly
    ? truthDrivenValidGoalMoments
    : prioritizeCandidateMoments(moments);
  const candidateMoments = goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly
    ? prioritizedMoments.filter(isConfirmedGoalCandidate)
    : prioritizedMoments;
  if (!candidateMoments.length) {
    if (goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly) return [];
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const allSingleCandidates = candidateMoments.map((moment) => {
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
    const selectedMoment = goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly &&
      moment.source === "match_event_truth_valid_goals_only"
      ? {
          ...storyPlan.selectedMoment,
          start: Number(moment.start),
          end: Number(moment.end),
          originalStart: Number(moment.start),
          originalEnd: Number(moment.end),
        }
      : storyPlan.selectedMoment;
    const storyPlanForPlan = selectedMoment === storyPlan.selectedMoment
      ? storyPlan
      : { ...storyPlan, selectedMoment };
    const goalOutcome = goalOutcomeForMoment(moment);
    const storyHighlightType = selectedMoment.highlightType || moment.highlightType || highlightTypeForReasons(moment.reasonCodes || []);
    const highlightType = goalOutcome && goalOutcome.eventType === "ball_in_net" ? "goal" : storyHighlightType;
    const duration = selectedMoment.end - selectedMoment.start;
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
      sourceStart: selectedMoment.start,
      sourceEnd: selectedMoment.end,
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
      footballStoryPlan: storyPlanForPlan,
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
        rankingExplanation: moment.rankingExplanation || null,
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
  const singleCandidates = goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly
    ? allSingleCandidates.filter(isConfirmedGoalCandidate)
    : allSingleCandidates;
  if (!singleCandidates.length) {
    if (goalSelectionMode === GOAL_SELECTION_MODES.validGoalsOnly) return [];
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
      "match_event_truth_layer",
      "truth_driven_valid_goals_only",
      "referee_var_offside_decision_detection",
      "real_goal_evidence_provider_boundary",
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
