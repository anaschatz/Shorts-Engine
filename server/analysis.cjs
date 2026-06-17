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
  validateEditPlan,
} = require("./edit-plan.cjs");
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

function reasonCodesForCaption(caption, signals, visualSignals) {
  const text = caption.text || "";
  const center = (caption.start + caption.end) / 2;
  const reasons = [];
  const nearbyAudioPeaks = nearby(signals.audioPeaks, center, 4);
  const nearbySceneChanges = nearby(signals.sceneChanges, center, 3);
  if (hasGoalLanguage(text)) reasons.push("goal");
  if (hasTerm(text, HARD_FOUL_TERMS)) reasons.push("hard_foul");
  if (hasTerm(text, FOUL_TERMS)) reasons.push("foul");
  if (hasTerm(text, CARD_TERMS)) reasons.push("card_moment");
  if (hasTerm(text, SAVE_TERMS)) reasons.push("save");
  if (hasTerm(text, BIG_CHANCE_TERMS)) reasons.push("big_chance");
  if (hasTerm(text, SHOT_TERMS)) reasons.push("shot_on_target");
  if (hasTerm(text, COUNTER_TERMS)) reasons.push("counter_attack");
  if (hasTerm(text, SKILL_TERMS)) reasons.push("skill_move");
  if (hasTerm(text, BUILD_UP_TERMS)) reasons.push("replay_worthy_moment");
  if (hasTerm(text, REPLAY_TERMS)) reasons.push("replay_worthy_moment");
  if (hasTerm(text, CROWD_REACTION_TERMS)) reasons.push("crowd_reaction");
  if (/[!]{1,}|[Α-ΩA-Z]{5,}/.test(text)) reasons.push("commentator_peak");
  if (nearbyAudioPeaks.length) reasons.push("audio_energy_spike");
  if (nearbyAudioPeaks.some((peak) => Number(peak.energyScore || 0) >= 0.88) && hasTerm(text, CROWD_REACTION_TERMS)) {
    reasons.push("crowd_spike");
  }
  if (nearbySceneChanges.length >= 1) reasons.push("scene_change_cluster");
  reasons.push(...visualReasonCodesNear(visualSignals, center, 3));
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
    visual_foul_like_contact: 0.18,
    visual_shot_like_motion: 0.17,
    visual_fast_break: 0.16,
    visual_crowd_reaction: 0.15,
    visual_replay_indicator: 0.1,
    visual_scoreboard_context: 0.04,
    visual_goal_area: 0.06,
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
  return clamp(0.22 + reasons.reduce((sum, reason) => sum + (weights[reason] || 0.04), 0), 0.12, 0.99);
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
  if (reasons.includes("visual_replay_indicator")) return "replay_or_reaction";
  if (reasons.includes("crowd_reaction") || reasons.includes("crowd_spike")) return "crowd_reaction";
  if (reasons.includes("replay_or_reaction")) return "replay_or_reaction";
  if (reasons.includes("replay_worthy_moment")) return "replay_worthy_moment";
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

function evidenceForReasons(reasons = [], caption = null, signals = {}, center = null, visualSignals = null) {
  const reasonSet = new Set(reasons);
  const nearbyAudio = center == null ? [] : nearby(signals.audioPeaks, center, 4);
  const nearbyScenes = center == null ? [] : nearby(signals.sceneChanges, center, 3);
  return {
    goalEvidence: reasonSet.has("goal"),
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
      source: "fallback",
    };
  });
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
    const moment = {
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
      evidence: evidenceForReasons(reasonCodes, caption, safeSignals, center, safeVisualSignals),
      captionIntent: captionIntentForHighlightType(highlightType),
      source: "analysis",
    };
    moment.hook = hookForMoment(moment, preset);
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
    return {
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
      evidence: evidenceForReasons(reasonCodes, null, safeSignals, center, safeVisualSignals),
      captionIntent: captionIntentForHighlightType(highlightType),
      source: "analysis",
    };
  });

  const visualOnlyMoments = safeVisualSignals.windows.slice(0, 4).map((window, index) => {
    const center = clamp(window.center, 0, duration);
    const start = Number(clamp(window.start, 0, Math.max(0, duration - 3)).toFixed(2));
    const end = Number(clamp(window.end, start + 3, duration).toFixed(2));
    const reasonCodes = visualReasonCodesForWindow(window);
    const highlightType = visualHighlightTypeForReasons(reasonCodes);
    const score = scoreReasons(reasonCodes) + Number(window.confidence || 0) * 0.12;
    return {
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
      evidence: evidenceForReasons(reasonCodes, null, safeSignals, center, safeVisualSignals),
      captionIntent: captionIntentForHighlightType(highlightType),
      source: "vision",
    };
  });

  const merged = [...captionMoments, ...signalOnlyMoments, ...visualOnlyMoments]
    .filter((moment) => moment.end - moment.start >= 3)
    .sort((a, b) => b.retentionScore - a.retentionScore || a.start - b.start);
  const deduped = [];
  for (const moment of merged) {
    if (deduped.some((existing) => Math.abs(existing.center - moment.center) < 2.5)) continue;
    deduped.push({ ...moment, rank: deduped.length + 1 });
    if (deduped.length >= 3) break;
  }
  const moments = deduped.length ? deduped : createFallbackMoments(safeSignals, preset, safeVisualSignals);
  return {
    fallback: moments.every((moment) => moment.source === "fallback"),
    moments: moments.map((moment, index) => ({
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
  if (reasons.includes("visual_shot_like_motion") || reasons.includes("visual_save_like_motion")) effects.push("subtle_punch_in");
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

function framingReasonForVisualSummary(summary) {
  if (!summary || !summary.windowCount) return "wide_safe_default_no_visual_tracking";
  if (summary.actionFocusConfidence < 0.82) return "wide_safe_visual_context_low_confidence";
  return "wide_safe_visual_context_no_object_tracking";
}

function createCandidateEditPlans({
  moments,
  metadata,
  title = "ShortsEngine Short",
  preset = "hype",
  transcript = null,
  mediaSignals = null,
  visualSignals = null,
  language = "auto",
  styleTarget = "vertical_9_16",
  editIntensity = "balanced",
  stylePreset = "social_sports_v1",
} = {}) {
  const renderStylePreset = normalizeStylePreset(stylePreset);
  const candidates = (Array.isArray(moments) ? moments : []).slice(0, 3).map((moment) => {
    const visualEvidenceSummary = visualEvidenceSummaryForMoment(moment);
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
      styleTarget: normalizeStyleTarget(styleTarget),
      editIntensity: normalizeEditIntensity(editIntensity),
    });
    const highlightType = storyPlan.selectedMoment.highlightType || moment.highlightType || highlightTypeForReasons(moment.reasonCodes || []);
    const duration = storyPlan.selectedMoment.end - storyPlan.selectedMoment.start;
    const hook = sanitizeText(storyPlan.hook || moment.hook || hookForHighlightType(highlightType, preset), 96);
    const captions = Array.isArray(storyPlan.captionBeats) && storyPlan.captionBeats.length
      ? storyPlan.captionBeats
      : createFallbackCaptions(duration, preset, { highlightType, hook });
    const framingMode = storyPlan.framingIntent.mode || framingModeForMetadata(metadata);
    const actionFocusConfidence = visualEvidenceSummary.actionFocusConfidence;
    const framingReason = storyPlan.framingIntent.reason || framingReasonForVisualSummary(visualEvidenceSummary);
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
      confidence: storyPlan.confidence || moment.confidence,
      hook,
      title: sanitizeText(title, 120),
      captions,
      effects: effectsForReasons(moment.reasonCodes || []),
      framingMode,
      framingReason,
      actionFocusConfidence,
      visualEvidenceSummary,
      cropStrategy: storyPlan.cropStrategy || createCropStrategy(metadata, framingMode),
      stylePreset: renderStylePreset,
      styleTarget: storyPlan.styleTarget,
      editIntensity: storyPlan.editIntensity,
      footballStoryPlan: storyPlan,
      captionEmphasis,
      animationCues,
      safetyNotes: [
        ...storyPlan.safetyNotes,
        "No object or ball tracking is claimed in v1.",
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
        captionIntent: moment.captionIntent || captionIntentForHighlightType(highlightType),
        source: moment.source,
      },
      export: {
        ...storyPlan.export,
      },
    };
    return validateEditPlan(plan, metadata);
  });
  if (!candidates.length) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
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
      "false_goal_guard",
      "football_story_planner",
      "contextual_caption_planning",
      "reference_style_animation_cues",
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
  captionIntentForHighlightType,
  reasonCodesForCaption,
  scoreReasons,
  titleForHighlightType,
  visualEvidenceSummaryForMoment,
};
