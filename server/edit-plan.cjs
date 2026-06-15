const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const HOOKS = Object.freeze({
  hype: "ΤΟ ΓΚΟΛ ΠΟΥ ΑΛΛΑΞΕ ΤΟ ΜΑΤΣ",
  drama: "ΟΛΑ ΠΑΙΧΤΗΚΑΝ ΣΕ ΑΥΤΑ ΤΑ 3 ΔΕΥΤΕΡΟΛΕΠΤΑ",
  tactical: "Η ΚΙΝΗΣΗ ΠΟΥ ΑΝΟΙΞΕ ΟΛΗ ΤΗΝ ΑΜΥΝΑ",
  fan: "ΑΥΤΟ ΔΕΝ ΓΙΝΕΤΑΙ ΝΑ ΜΗΝ ΤΟ ΞΑΝΑΔΕΙΣ",
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
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

function createFallbackCaptions(duration, preset) {
  const hook = HOOKS[preset] || HOOKS.hype;
  const beats = [
    hook,
    "Η ΦΑΣΗ ΧΤΙΖΕΤΑΙ ΜΕ ΤΕΛΕΙΟ TIMING",
    "ΚΟΙΤΑ ΤΗΝ ΚΙΝΗΣΗ ΠΡΙΝ ΤΟ ΤΕΛΕΙΩΜΑ",
    "ΑΥΤΟ ΕΙΝΑΙ SHORT ΠΟΥ ΚΡΑΤΑΕΙ RETENTION",
  ];
  const segment = Math.max(1.8, duration / beats.length);
  return beats.map((text, index) => ({
    start: Number((index * segment).toFixed(2)),
    end: Number(Math.min(duration, index * segment + segment - 0.15).toFixed(2)),
    text,
  }));
}

function createEditPlan({ metadata, transcript, preset = "hype", title = "ShortsEngine Short" }) {
  const sourceStart = 0;
  const sourceEnd = Math.min(Number(metadata.durationSeconds || 0), 18);
  const safeEnd = sourceEnd >= 3 ? sourceEnd : Math.min(Number(metadata.durationSeconds || 3), 3);
  const duration = safeEnd - sourceStart;
  const captions =
    transcript && Array.isArray(transcript.captions) && transcript.captions.length > 0
      ? normalizeCaptions(transcript.captions, sourceStart, safeEnd)
      : createFallbackCaptions(duration, preset);
  return {
    sourceStart,
    sourceEnd: Number(safeEnd.toFixed(2)),
    aspectRatio: "9:16",
    hook: sanitizeText(HOOKS[preset] || HOOKS.hype, 96),
    title: sanitizeText(title, 120),
    captions: captions.length ? captions : createFallbackCaptions(duration, preset),
    effects: ["center_crop_9_16", "subtle_zoom", "punch_captions", "brand_safe_template"],
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
  if (plan.aspectRatio !== "9:16") {
    throw new AppError("VALIDATION_ERROR", "Only 9:16 export is supported in this MVP.", 400);
  }
  if (!plan.export || plan.export.width !== 1080 || plan.export.height !== 1920 || plan.export.format !== "mp4") {
    throw new AppError("VALIDATION_ERROR", "Export settings must be 1080x1920 MP4.", 400);
  }
  const captions = normalizeCaptions(plan.captions, sourceStart, sourceEnd);
  if (captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Edit plan needs at least one caption.", 400);
  }
  return {
    ...plan,
    sourceStart,
    sourceEnd,
    hook: sanitizeText(plan.hook, 96),
    captions,
    effects: Array.isArray(plan.effects) ? plan.effects.map((effect) => sanitizeText(effect, 40)).filter(Boolean) : [],
    export: { width: 1080, height: 1920, format: "mp4" },
  };
}

module.exports = {
  HOOKS,
  createFallbackCaptions,
  createEditPlan,
  validateEditPlan,
};
