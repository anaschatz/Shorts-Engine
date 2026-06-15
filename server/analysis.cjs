const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { createFallbackCaptions, HOOKS, validateEditPlan } = require("./edit-plan.cjs");
const { commandAvailable, sanitizeText } = require("./media.cjs");
const { runFfmpeg } = require("./render.cjs");

const GOAL_TERMS = [
  "goal",
  "finish",
  "finishes",
  "score",
  "scores",
  "shot",
  "strike",
  "save",
  "keeper",
  "γκολ",
  "τελειωμα",
  "τελείωμα",
  "σουτ",
  "αποκρουση",
  "απόκρουση",
  "δοκαρι",
  "δοκάρι",
  "δικτυα",
  "δίχτυα",
];

const TACTICAL_TERMS = [
  "assist",
  "pass",
  "run",
  "lane",
  "defender",
  "build-up",
  "build up",
  "press",
  "πάσα",
  "πασα",
  "κινηση",
  "κίνηση",
  "αμυνα",
  "άμυνα",
  "αντεπιθεση",
  "αντεπίθεση",
];

const REPLAY_TERMS = ["replay", "again", "angle", "ριπλεϊ", "ριπλει", "ξανα", "επανάληψη", "επαναληψη"];
const CROWD_TERMS = ["crowd", "stadium", "fans", "roar", "κερκιδα", "κερκίδα", "κόσμος", "κοσμος"];

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
  return terms.some((term) => normalized.includes(term));
}

function nearby(items, center, radiusSeconds) {
  return (items || []).filter((item) => Math.abs(seconds(item.time) - center) <= radiusSeconds);
}

function reasonCodesForCaption(caption, signals) {
  const text = caption.text || "";
  const center = (caption.start + caption.end) / 2;
  const reasons = [];
  if (hasTerm(text, GOAL_TERMS)) reasons.push("goal_like_phrase");
  if (hasTerm(text, TACTICAL_TERMS)) reasons.push("tactical_build_up");
  if (hasTerm(text, REPLAY_TERMS)) reasons.push("replay_marker");
  if (hasTerm(text, CROWD_TERMS)) reasons.push("crowd_reaction");
  if (/[!]{1,}|[Α-ΩA-Z]{5,}/.test(text)) reasons.push("commentator_emphasis");
  if (nearby(signals.audioPeaks, center, 4).length) reasons.push("audio_peak");
  if (nearby(signals.sceneChanges, center, 3).length >= 1) reasons.push("scene_change_cluster");
  return [...new Set(reasons)];
}

function scoreReasons(reasons) {
  const weights = {
    goal_like_phrase: 0.3,
    audio_peak: 0.18,
    commentator_emphasis: 0.14,
    crowd_reaction: 0.12,
    scene_change_cluster: 0.1,
    replay_marker: 0.08,
    tactical_build_up: 0.08,
  };
  return clamp(0.22 + reasons.reduce((sum, reason) => sum + (weights[reason] || 0.04), 0), 0.12, 0.99);
}

function hookForMoment(moment, preset) {
  if (moment.reasonCodes.includes("goal_like_phrase")) return HOOKS.hype;
  if (moment.reasonCodes.includes("tactical_build_up")) return HOOKS.tactical;
  if (moment.reasonCodes.includes("crowd_reaction")) return HOOKS.fan;
  return HOOKS[preset] || HOOKS.hype;
}

function captionBeatsForMoment(moment, captions, preset) {
  const selected = captions.filter((caption) => caption.start < moment.end && caption.end > moment.start).slice(0, 4);
  if (selected.length) {
    return selected.map((caption) => ({
      start: Number(Math.max(0, caption.start - moment.start).toFixed(2)),
      end: Number(Math.min(moment.end - moment.start, caption.end - moment.start).toFixed(2)),
      text: caption.text,
    }));
  }
  return createFallbackCaptions(moment.end - moment.start, preset);
}

function createFallbackMoments(signals, preset) {
  const duration = seconds(signals.durationSeconds || 18);
  const centers = uniqueTimes(
    [signals.audioPeaks && signals.audioPeaks[0] ? signals.audioPeaks[0].time : duration * 0.42, duration * 0.68],
    duration,
  );
  return centers.slice(0, 2).map((center, index) => {
    const start = Number(clamp(center - 3.5, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(start + Math.min(10, duration - start), start + 3, duration).toFixed(2));
    const reasonCodes = index === 0 ? ["audio_peak"] : ["scene_change_cluster"];
    const score = scoreReasons(reasonCodes) - 0.12;
    return {
      id: `mom_fallback_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center,
      title: index === 0 ? "Estimated impact moment" : "Estimated replay window",
      summary: "Deterministic fallback because transcript or signals were limited.",
      reasonCodes,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: preset,
      hook: HOOKS[preset] || HOOKS.hype,
      source: "fallback",
    };
  });
}

function detectHighlights({ transcript, signals, preset = "hype" } = {}) {
  const safeSignals = signals || { durationSeconds: 18, audioPeaks: [], sceneChanges: [] };
  const duration = seconds(safeSignals.durationSeconds || 18);
  const captions = normalizedCaptions(transcript);
  const captionMoments = captions.map((caption, index) => {
    const center = clamp((caption.start + caption.end) / 2, 0, duration);
    const start = Number(clamp(center - 4, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(Math.max(center + 5, start + 6), start + 3, duration).toFixed(2));
    const reasonCodes = reasonCodesForCaption(caption, safeSignals);
    const score = scoreReasons(reasonCodes);
    const moment = {
      id: `mom_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center: Number(center.toFixed(2)),
      title: reasonCodes.includes("goal_like_phrase") ? "Goal-like impact beat" : "Short-form highlight beat",
      summary: caption.text,
      reasonCodes,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: reasonCodes.includes("tactical_build_up") ? "tactical" : preset,
      source: "analysis",
    };
    moment.hook = hookForMoment(moment, preset);
    return moment;
  });

  const signalOnlyMoments = (safeSignals.audioPeaks || []).slice(0, 4).map((peak, index) => {
    const center = clamp(peak.time, 0, duration);
    const start = Number(clamp(center - 4, 0, Math.max(0, duration - 6)).toFixed(2));
    const end = Number(clamp(start + 8, start + 3, duration).toFixed(2));
    const reasonCodes = ["audio_peak", nearby(safeSignals.sceneChanges, center, 3).length ? "scene_change_cluster" : ""].filter(Boolean);
    const score = scoreReasons(reasonCodes) - 0.04;
    return {
      id: `mom_signal_${index + 1}`,
      rank: index + 1,
      start,
      end,
      center: Number(center.toFixed(2)),
      title: "Audio energy spike",
      summary: "Detected from media signals.",
      reasonCodes,
      confidence: Number(score.toFixed(2)),
      retentionScore: Math.round(score * 100),
      suggestedPreset: preset,
      hook: HOOKS[preset] || HOOKS.hype,
      source: "analysis",
    };
  });

  const merged = [...captionMoments, ...signalOnlyMoments]
    .filter((moment) => moment.end - moment.start >= 3)
    .sort((a, b) => b.retentionScore - a.retentionScore || a.start - b.start);
  const deduped = [];
  for (const moment of merged) {
    if (deduped.some((existing) => Math.abs(existing.center - moment.center) < 2.5)) continue;
    deduped.push({ ...moment, rank: deduped.length + 1 });
    if (deduped.length >= 3) break;
  }
  const moments = deduped.length ? deduped : createFallbackMoments(safeSignals, preset);
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
  const effects = ["center_crop_9_16", "punch_captions", "brand_safe_template"];
  if (reasons.includes("audio_peak")) effects.push("beat_sync_cut");
  if (reasons.includes("scene_change_cluster")) effects.push("scene_snap_zoom");
  if (reasons.includes("tactical_build_up")) effects.push("passing_lane_emphasis");
  if (reasons.includes("replay_marker")) effects.push("replay_stutter");
  return [...new Set(effects)];
}

function createCandidateEditPlans({ moments, metadata, title = "ShortsEngine Short", preset = "hype" } = {}) {
  const candidates = (Array.isArray(moments) ? moments : []).slice(0, 3).map((moment) => {
    const plan = {
      sourceStart: moment.start,
      sourceEnd: moment.end,
      aspectRatio: "9:16",
      hook: sanitizeText(moment.hook || HOOKS[preset] || HOOKS.hype, 96),
      title: sanitizeText(title, 120),
      captions: moment.captionBeats && moment.captionBeats.length ? moment.captionBeats : createFallbackCaptions(moment.end - moment.start, preset),
      effects: effectsForReasons(moment.reasonCodes || []),
      stylePreset: moment.suggestedPreset || preset,
      candidateId: moment.id,
      rank: moment.rank,
      retentionScore: moment.retentionScore,
      reasonCodes: moment.reasonCodes || [],
      analysisMoment: {
        id: moment.id,
        title: moment.title,
        summary: moment.summary,
        confidence: moment.confidence,
        retentionScore: moment.retentionScore,
        reasonCodes: moment.reasonCodes || [],
        source: moment.source,
      },
      export: {
        width: 1080,
        height: 1920,
        format: "mp4",
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
    features: ["media_signals", "highlight_ranking", "candidate_edit_plans"],
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
  reasonCodesForCaption,
  scoreReasons,
};
