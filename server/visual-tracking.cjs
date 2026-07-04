const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { validateTrackingProviderOutput } = require("./tracking-provider.cjs");
const { visualReasonCodesForWindow } = require("./vision.cjs");

const CROP_PLAN_MODES = Object.freeze(["wide_safe", "soft_follow", "center_safe", "locked_wide"]);
const TARGET_ASPECT_RATIOS = Object.freeze(["9:16", "1:1"]);

const ACTION_REASON_CODES = Object.freeze([
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

const BALL_REASON_CODES = Object.freeze([
  "visual_ball_visible",
  "visual_ball_toward_goal",
  "visual_ball_in_net",
]);

const PLAYER_REASON_CODES = Object.freeze([
  "visual_shot_like_motion",
  "visual_shot_contact",
  "visual_save_like_motion",
  "visual_keeper_action",
  "visual_foul_like_contact",
  "visual_fast_break",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function mediaDimensions(metadata = {}) {
  return {
    width: Math.max(1, Math.round(Number(metadata.width || 1920))),
    height: Math.max(1, Math.round(Number(metadata.height || 1080))),
  };
}

function fullSourceBox(metadata = {}) {
  const { width, height } = mediaDimensions(metadata);
  return { x: 0, y: 0, width, height };
}

function normalizeBox(box, metadata = {}) {
  if (!box || typeof box !== "object" || Array.isArray(box)) return null;
  const { width: mediaWidth, height: mediaHeight } = mediaDimensions(metadata);
  const x = clamp(box.x ?? box.left, 0, mediaWidth);
  const y = clamp(box.y ?? box.top, 0, mediaHeight);
  const width = clamp(box.width, 1, mediaWidth - x);
  const height = clamp(box.height, 1, mediaHeight - y);
  if (x + width > mediaWidth + 0.25 || y + height > mediaHeight + 0.25) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function boxArea(box) {
  if (!box) return 0;
  return Math.max(0, Number(box.width || 0)) * Math.max(0, Number(box.height || 0));
}

function boxCenter(box) {
  return {
    x: round(Number(box.x || 0) + Number(box.width || 0) / 2, 4),
    y: round(Number(box.y || 0) + Number(box.height || 0) / 2, 4),
  };
}

function unionBoxes(boxes, metadata = {}) {
  const safeBoxes = (Array.isArray(boxes) ? boxes : []).filter(Boolean);
  if (!safeBoxes.length) return null;
  const { width: mediaWidth, height: mediaHeight } = mediaDimensions(metadata);
  const left = Math.max(0, Math.min(...safeBoxes.map((box) => box.x)));
  const top = Math.max(0, Math.min(...safeBoxes.map((box) => box.y)));
  const right = Math.min(mediaWidth, Math.max(...safeBoxes.map((box) => box.x + box.width)));
  const bottom = Math.min(mediaHeight, Math.max(...safeBoxes.map((box) => box.y + box.height)));
  return normalizeBox({ x: left, y: top, width: right - left, height: bottom - top }, metadata);
}

function expandBox(box, metadata = {}, paddingRatio = 0.08) {
  if (!box) return null;
  const padX = Number(box.width || 0) * paddingRatio;
  const padY = Number(box.height || 0) * paddingRatio;
  return normalizeBox({
    x: Number(box.x || 0) - padX,
    y: Number(box.y || 0) - padY,
    width: Number(box.width || 0) + padX * 2,
    height: Number(box.height || 0) + padY * 2,
  }, metadata);
}

function containsBox(outer, inner) {
  if (!outer || !inner) return false;
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  return round(intersection / Math.max(1, boxArea(b)), 4);
}

function hasAny(reasons, wanted) {
  const reasonSet = new Set(Array.isArray(reasons) ? reasons : []);
  return wanted.some((reason) => reasonSet.has(reason));
}

function regionForWindow(window, metadata = {}) {
  const explicit = normalizeBox(window && (window.actionBounds || window.bounds || window.box), metadata);
  if (explicit) return explicit;
  const { width, height } = mediaDimensions(metadata);
  const reasons = visualReasonCodesForWindow(window || {});
  const confidence = clamp(window && window.confidence, 0, 1);
  if (!reasons.length || confidence < 0.55) return null;
  if (hasAny(reasons, ["visual_crowd_reaction", "visual_replay_indicator", "visual_scoreboard_context"]) && !hasAny(reasons, ACTION_REASON_CODES)) {
    return null;
  }
  const narrowAction = hasAny(reasons, ["visual_shot_contact", "visual_foul_like_contact", "visual_save_like_motion", "visual_fast_break"]);
  const regionWidth = width * (narrowAction ? 0.52 : 0.68);
  const regionHeight = height * (narrowAction ? 0.62 : 0.72);
  return normalizeBox({
    x: (width - regionWidth) / 2,
    y: height * 0.14,
    width: regionWidth,
    height: regionHeight,
  }, metadata);
}

function safeFrameTimestamps(frames = []) {
  return (Array.isArray(frames) ? frames : [])
    .map((frame) => Number(frame && frame.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .slice(0, 12)
    .map((value) => round(value, 2));
}

function normalizeTrackingSummary(summary, metadata = {}) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return createWideSafeTrackingSummary({ metadata, reason: "tracking_summary_missing" });
  }
  const detectedMotionRegions = (Array.isArray(summary.detectedMotionRegions) ? summary.detectedMotionRegions : [])
    .map((region) => ({
      timestamp: round(region.timestamp, 2),
      confidence: round(clamp(region.confidence, 0, 1), 2),
      reasonCodes: Array.isArray(region.reasonCodes)
        ? region.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean).slice(0, 8)
        : [],
      bounds: normalizeBox(region.bounds, metadata),
    }))
    .filter((region) => region.bounds);
  const actionBounds = normalizeBox(summary.estimatedActionBounds, metadata);
  const actionCenter = summary.estimatedActionCenter && typeof summary.estimatedActionCenter === "object"
    ? {
        x: round(clamp(summary.estimatedActionCenter.x, 0, mediaDimensions(metadata).width), 2),
        y: round(clamp(summary.estimatedActionCenter.y, 0, mediaDimensions(metadata).height), 2),
      }
    : actionBounds
      ? boxCenter(actionBounds)
      : boxCenter(fullSourceBox(metadata));
  const recommendedFramingMode = CROP_PLAN_MODES.includes(summary.recommendedFramingMode)
    ? summary.recommendedFramingMode
    : "wide_safe";
  return {
    frameCount: Math.max(0, Math.min(64, Math.round(Number(summary.frameCount || 0)))),
    sampledTimestamps: (Array.isArray(summary.sampledTimestamps) ? summary.sampledTimestamps : [])
      .map((value) => round(value, 2))
      .filter(Number.isFinite)
      .slice(0, 12),
    detectedMotionRegions,
    estimatedActionCenter: actionCenter,
    estimatedActionBounds: actionBounds,
    ballCandidateConfidence: round(clamp(summary.ballCandidateConfidence, 0, 1), 2),
    playerClusterConfidence: round(clamp(summary.playerClusterConfidence, 0, 1), 2),
    cameraMotionLevel: round(clamp(summary.cameraMotionLevel, 0, 1), 2),
    trackingConfidence: round(clamp(summary.trackingConfidence, 0, 1), 2),
    recommendedFramingMode,
    cropSafetyReason: sanitizeText(summary.cropSafetyReason || "wide_safe_default", 100),
    fallbackUsed: Boolean(summary.fallbackUsed || recommendedFramingMode !== "soft_follow"),
    trackingProviderMode: sanitizeText(summary.trackingProviderMode || summary.providerMode || "visual-tracking-heuristic", 60),
    trackingProviderFailureCode: summary.trackingProviderFailureCode ? sanitizeText(summary.trackingProviderFailureCode, 80) : null,
    ballTrackCount: Math.max(0, Math.min(12, Math.round(Number(summary.ballTrackCount || 0)))),
    playerClusterCount: Math.max(0, Math.min(8, Math.round(Number(summary.playerClusterCount || 0)))),
    goalClaimAllowed: false,
  };
}

function createWideSafeTrackingSummary({ metadata = {}, reason = "wide_safe_default_no_tracking", frames = [] } = {}) {
  return {
    frameCount: Array.isArray(frames) ? Math.min(64, frames.length) : 0,
    sampledTimestamps: safeFrameTimestamps(frames),
    detectedMotionRegions: [],
    estimatedActionCenter: boxCenter(fullSourceBox(metadata)),
    estimatedActionBounds: null,
    ballCandidateConfidence: 0,
    playerClusterConfidence: 0,
    cameraMotionLevel: 0,
    trackingConfidence: 0,
    recommendedFramingMode: "wide_safe",
    cropSafetyReason: sanitizeText(reason, 100),
    fallbackUsed: true,
    trackingProviderMode: "visual-tracking-heuristic",
    trackingProviderFailureCode: null,
    ballTrackCount: 0,
    playerClusterCount: 0,
    goalClaimAllowed: false,
  };
}

function trackingSummaryFromProviderOutput(output, metadata = {}) {
  const safe = validateTrackingProviderOutput(output, metadata);
  const ballConfidence = safe.ballTracks.reduce((max, track) => Math.max(max, track.confidence), 0);
  const playerConfidence = safe.playerClusters.reduce((max, cluster) => Math.max(max, cluster.confidence), 0);
  let recommendedFramingMode = "wide_safe";
  let cropSafetyReason = safe.reasonCodes[0] || "tracking_fallback_no_ball_player_evidence";
  if (safe.cameraMotionLevel >= 0.75) {
    recommendedFramingMode = "locked_wide";
    cropSafetyReason = "locked_wide_camera_motion";
  } else if (!safe.fallbackUsed && safe.confidence >= 0.86 && ballConfidence >= 0.65 && playerConfidence >= 0.55 && safe.actionBounds) {
    recommendedFramingMode = "soft_follow";
    cropSafetyReason = "soft_follow_provider_ball_player_action";
  } else if (!safe.fallbackUsed && safe.confidence >= 0.72 && safe.actionBounds) {
    recommendedFramingMode = "center_safe";
    cropSafetyReason = "center_safe_provider_partial_tracking";
  }
  const detectedMotionRegions = [];
  if (safe.actionBounds) {
    detectedMotionRegions.push({
      timestamp: safe.ballTracks[0] ? safe.ballTracks[0].timestamp : 0,
      confidence: safe.confidence,
      reasonCodes: safe.reasonCodes,
      bounds: safe.actionBounds,
    });
  }
  return normalizeTrackingSummary({
    frameCount: safe.frameCount,
    sampledTimestamps: safe.ballTracks.map((track) => track.timestamp),
    detectedMotionRegions,
    estimatedActionCenter: safe.actionCenter,
    estimatedActionBounds: safe.actionBounds,
    ballCandidateConfidence: ballConfidence,
    playerClusterConfidence: playerConfidence,
    cameraMotionLevel: safe.cameraMotionLevel,
    trackingConfidence: safe.confidence,
    recommendedFramingMode,
    cropSafetyReason,
    fallbackUsed: safe.fallbackUsed || recommendedFramingMode !== "soft_follow",
    trackingProviderMode: safe.providerMode,
    trackingProviderFailureCode: safe.failure && safe.failure.code,
    ballTrackCount: safe.ballTracks.length,
    playerClusterCount: safe.playerClusters.length,
    goalClaimAllowed: false,
  }, metadata);
}

function analyzeVisualTracking(input = {}) {
  const metadata = input.metadata || {};
  if (input.trackingProviderOutput || input.trackingOutput) {
    return trackingSummaryFromProviderOutput(input.trackingProviderOutput || input.trackingOutput, metadata);
  }
  if (input.trackingSummary || input.visualTracking) {
    return normalizeTrackingSummary(input.trackingSummary || input.visualTracking, metadata);
  }
  const frames = Array.isArray(input.frames) ? input.frames : [];
  const windows = Array.isArray(input.visualSignals && input.visualSignals.windows) ? input.visualSignals.windows : [];
  if (!frames.length && !windows.length) {
    return createWideSafeTrackingSummary({ metadata, reason: "wide_safe_no_sampled_frames_or_visual_windows", frames });
  }
  const regions = windows
    .map((window) => {
      const bounds = regionForWindow(window, metadata);
      if (!bounds) return null;
      return {
        timestamp: round(window.center ?? ((Number(window.start || 0) + Number(window.end || 0)) / 2), 2),
        confidence: round(clamp(window.confidence, 0, 1), 2),
        reasonCodes: visualReasonCodesForWindow(window).slice(0, 8),
        bounds,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
  if (!regions.length) {
    return createWideSafeTrackingSummary({ metadata, reason: "wide_safe_no_action_regions", frames });
  }
  const actionBounds = expandBox(unionBoxes(regions.map((region) => region.bounds), metadata), metadata, 0.08);
  const actionCenter = actionBounds ? boxCenter(actionBounds) : boxCenter(fullSourceBox(metadata));
  const maxForReasons = (wanted) => regions.reduce((max, region) => (
    hasAny(region.reasonCodes, wanted) ? Math.max(max, region.confidence) : max
  ), 0);
  const cameraMotionLevel = Math.max(
    maxForReasons(["visual_unknown_action"]),
    (windows || []).some((window) => (window.types || []).includes("camera_pan")) ? 0.78 : 0,
  );
  const ballCandidateConfidence = maxForReasons(BALL_REASON_CODES);
  const playerClusterConfidence = Math.max(maxForReasons(PLAYER_REASON_CODES), regions.length ? 0.58 : 0);
  const actionRegionConfidence = regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length;
  const trackingConfidence = round(clamp(
    actionRegionConfidence * 0.45 + ballCandidateConfidence * 0.3 + playerClusterConfidence * 0.2 - cameraMotionLevel * 0.25,
    0,
    1,
  ), 2);
  let recommendedFramingMode = "wide_safe";
  let cropSafetyReason = "wide_safe_visual_tracking_low_confidence";
  if (cameraMotionLevel >= 0.75) {
    recommendedFramingMode = "locked_wide";
    cropSafetyReason = "locked_wide_camera_motion";
  } else if (trackingConfidence >= 0.86 && ballCandidateConfidence >= 0.65 && playerClusterConfidence >= 0.55) {
    recommendedFramingMode = "soft_follow";
    cropSafetyReason = "soft_follow_stable_ball_player_action";
  } else if (trackingConfidence >= 0.72) {
    recommendedFramingMode = "center_safe";
    cropSafetyReason = "center_safe_partial_action_tracking";
  }
  return normalizeTrackingSummary({
    frameCount: frames.length,
    sampledTimestamps: safeFrameTimestamps(frames),
    detectedMotionRegions: regions,
    estimatedActionCenter: actionCenter,
    estimatedActionBounds: actionBounds,
    ballCandidateConfidence,
    playerClusterConfidence,
    cameraMotionLevel,
    trackingConfidence,
    recommendedFramingMode,
    cropSafetyReason,
    fallbackUsed: recommendedFramingMode !== "soft_follow",
    trackingProviderMode: "visual-tracking-heuristic",
    ballTrackCount: ballCandidateConfidence > 0 ? regions.length : 0,
    playerClusterCount: playerClusterConfidence > 0 ? regions.length : 0,
  }, metadata);
}

function targetRatioValue(targetAspectRatio = "9:16") {
  const safe = TARGET_ASPECT_RATIOS.includes(String(targetAspectRatio)) ? String(targetAspectRatio) : "9:16";
  if (safe === "1:1") return 1;
  return 9 / 16;
}

function cropBoxForCenter({ metadata = {}, center, targetAspectRatio = "9:16" }) {
  const { width, height } = mediaDimensions(metadata);
  const ratio = targetRatioValue(targetAspectRatio);
  let cropHeight = height;
  let cropWidth = cropHeight * ratio;
  if (cropWidth > width) {
    cropWidth = width;
    cropHeight = cropWidth / ratio;
  }
  const x = clamp((center.x || width / 2) - cropWidth / 2, 0, width - cropWidth);
  const y = clamp((center.y || height / 2) - cropHeight / 2, 0, height - cropHeight);
  return normalizeBox({ x, y, width: cropWidth, height: cropHeight }, metadata);
}

function textSafeZonesForAspectRatio(targetAspectRatio = "9:16") {
  if (targetAspectRatio === "1:1") {
    return [
      { name: "top_context", x: 0.08, y: 0.04, width: 0.84, height: 0.16 },
      { name: "bottom_caption", x: 0.08, y: 0.78, width: 0.84, height: 0.18 },
    ];
  }
  return [
    { name: "top_context", x: 0.08, y: 0.05, width: 0.84, height: 0.13 },
    { name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 },
  ];
}

function normalizedTextZoneOverlapsAction(zone, actionZone) {
  if (!zone || !actionZone) return false;
  const left = Math.max(zone.x, actionZone.x);
  const top = Math.max(zone.y, actionZone.y);
  const right = Math.min(zone.x + zone.width, actionZone.x + actionZone.width);
  const bottom = Math.min(zone.y + zone.height, actionZone.y + actionZone.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top) > 0.01;
}

function actionZoneForCrop(actionBounds, cropBox) {
  if (!actionBounds || !cropBox) return null;
  return {
    x: round((actionBounds.x - cropBox.x) / cropBox.width, 4),
    y: round((actionBounds.y - cropBox.y) / cropBox.height, 4),
    width: round(actionBounds.width / cropBox.width, 4),
    height: round(actionBounds.height / cropBox.height, 4),
  };
}

function calibrateCropPlan(input = {}) {
  const metadata = input.metadata || {};
  const targetAspectRatio = TARGET_ASPECT_RATIOS.includes(String(input.targetAspectRatio)) ? String(input.targetAspectRatio) : "9:16";
  const trackingSummary = normalizeTrackingSummary(input.trackingSummary || input.visualTracking, metadata);
  const fullBox = fullSourceBox(metadata);
  const baseReasonCodes = [trackingSummary.cropSafetyReason].filter(Boolean);
  const actionBounds = trackingSummary.estimatedActionBounds
    ? expandBox(trackingSummary.estimatedActionBounds, metadata, 0.04)
    : null;
  let mode = "wide_safe";
  let cropBox = fullBox;
  let confidence = trackingSummary.trackingConfidence;
  let fallbackUsed = true;
  let reasonCodes = baseReasonCodes.length ? baseReasonCodes : ["wide_safe_default"];

  if (trackingSummary.recommendedFramingMode === "locked_wide") {
    mode = "locked_wide";
    reasonCodes = ["locked_wide_camera_motion"];
  } else if (trackingSummary.recommendedFramingMode === "soft_follow" && actionBounds && confidence >= 0.86) {
    const candidateCrop = cropBoxForCenter({
      metadata,
      center: trackingSummary.estimatedActionCenter || boxCenter(actionBounds),
      targetAspectRatio,
    });
    if (candidateCrop && containsBox(candidateCrop, actionBounds)) {
      mode = "soft_follow";
      cropBox = candidateCrop;
      fallbackUsed = false;
      reasonCodes = ["soft_follow_stable_action_bounds"];
    } else {
      mode = "wide_safe";
      confidence = Math.min(confidence, 0.74);
      reasonCodes = ["wide_safe_action_bounds_too_wide_for_safe_crop"];
    }
  } else if (trackingSummary.recommendedFramingMode === "center_safe" && actionBounds && confidence >= 0.72) {
    mode = "center_safe";
    reasonCodes = ["center_safe_partial_tracking"];
  }

  let safeArea = mode === "soft_follow"
    ? normalizeBox({
        x: cropBox.x + cropBox.width * 0.06,
        y: cropBox.y + cropBox.height * 0.06,
        width: cropBox.width * 0.88,
        height: cropBox.height * 0.88,
      }, metadata)
    : fullBox;
  const actionSafeZones = actionBounds ? [actionBounds] : [];
  const textSafeZones = textSafeZonesForAspectRatio(targetAspectRatio);
  const actionOutputZone = actionBounds ? actionZoneForCrop(actionBounds, cropBox) : null;
  let textObstructionRisk = Boolean(
    mode === "soft_follow" &&
    actionOutputZone &&
    textSafeZones.some((zone) => normalizedTextZoneOverlapsAction(zone, actionOutputZone)),
  );
  if (textObstructionRisk) {
    mode = "wide_safe";
    cropBox = fullBox;
    safeArea = fullBox;
    confidence = Math.min(confidence, 0.74);
    fallbackUsed = true;
    reasonCodes = ["wide_safe_caption_action_overlap"];
    textObstructionRisk = false;
  }

  return validateCropPlan({
    mode,
    targetAspectRatio,
    safeArea,
    cropBox,
    confidence: round(confidence, 2),
    reasonCodes,
    textSafeZones,
    actionSafeZones,
    fallbackUsed,
    textObstructionRisk,
  }, metadata);
}

function validateTextSafeZone(zone) {
  if (!zone || typeof zone !== "object" || Array.isArray(zone)) return null;
  const safe = {
    name: sanitizeText(zone.name || "text_zone", 40),
    x: round(clamp(zone.x, 0, 1), 4),
    y: round(clamp(zone.y, 0, 1), 4),
    width: round(clamp(zone.width, 0.01, 1), 4),
    height: round(clamp(zone.height, 0.01, 1), 4),
  };
  if (safe.x + safe.width > 1.0001 || safe.y + safe.height > 1.0001) return null;
  return safe;
}

function validateCropPlan(plan, metadata = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return calibrateCropPlan({ metadata, trackingSummary: createWideSafeTrackingSummary({ metadata }) });
  }
  const mode = CROP_PLAN_MODES.includes(plan.mode) ? plan.mode : null;
  if (!mode) throw new AppError("VALIDATION_ERROR", "Crop plan mode is invalid.", 400);
  const targetAspectRatio = TARGET_ASPECT_RATIOS.includes(String(plan.targetAspectRatio)) ? String(plan.targetAspectRatio) : null;
  if (!targetAspectRatio) throw new AppError("VALIDATION_ERROR", "Crop plan target aspect ratio is invalid.", 400);
  const cropBox = normalizeBox(plan.cropBox, metadata);
  const safeArea = normalizeBox(plan.safeArea, metadata);
  if (!cropBox || !safeArea) throw new AppError("VALIDATION_ERROR", "Crop plan boxes are invalid.", 400);
  const confidence = round(clamp(plan.confidence, 0, 1), 2);
  const actionSafeZones = (Array.isArray(plan.actionSafeZones) ? plan.actionSafeZones : [])
    .map((zone) => normalizeBox(zone, metadata))
    .filter(Boolean)
    .slice(0, 4);
  const textSafeZones = (Array.isArray(plan.textSafeZones) ? plan.textSafeZones : [])
    .map(validateTextSafeZone)
    .filter(Boolean)
    .slice(0, 4);
  if ((plan.actionSafeZones || []).length !== actionSafeZones.length) {
    throw new AppError("VALIDATION_ERROR", "Crop plan action safe zone is invalid.", 400);
  }
  if ((plan.textSafeZones || []).length !== textSafeZones.length) {
    throw new AppError("VALIDATION_ERROR", "Crop plan text safe zone is invalid.", 400);
  }
  if (actionSafeZones.some((zone) => !containsBox(safeArea, zone))) {
    throw new AppError("VALIDATION_ERROR", "Crop plan leaves action outside the safe area.", 400);
  }
  if (mode === "soft_follow" && (confidence < 0.86 || actionSafeZones.some((zone) => !containsBox(cropBox, zone)))) {
    throw new AppError("VALIDATION_ERROR", "Soft-follow crop plan needs high confidence and contained action bounds.", 400);
  }
  if (mode !== "soft_follow" && confidence > 0.95) {
    throw new AppError("VALIDATION_ERROR", "Non-follow crop plan has unsafe overconfident tracking.", 400);
  }
  const computedTextObstructionRisk = Boolean(
    mode === "soft_follow" &&
    actionSafeZones.some((zone) => {
      const outputZone = actionZoneForCrop(zone, cropBox);
      return outputZone && textSafeZones.some((textZone) => normalizedTextZoneOverlapsAction(textZone, outputZone));
    }),
  );
  const actionCenter = actionSafeZones.length
    ? boxCenter(unionBoxes(actionSafeZones, metadata) || cropBox)
    : boxCenter(cropBox);
  const safeMargins = {
    left: round(Math.max(0, safeArea.x - cropBox.x), 2),
    top: round(Math.max(0, safeArea.y - cropBox.y), 2),
    right: round(Math.max(0, cropBox.x + cropBox.width - (safeArea.x + safeArea.width)), 2),
    bottom: round(Math.max(0, cropBox.y + cropBox.height - (safeArea.y + safeArea.height)), 2),
  };
  return {
    mode,
    cropMode: mode,
    targetAspectRatio,
    safeArea,
    cropBox,
    confidence,
    trackingConfidence: confidence,
    actionCenterX: actionCenter.x,
    actionCenterY: actionCenter.y,
    maxPanSpeed: mode === "soft_follow" ? 0.18 : 0,
    safeMargins,
    reasonCodes: Array.isArray(plan.reasonCodes)
      ? plan.reasonCodes.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, 8)
      : [],
    textSafeZones,
    actionSafeZones,
    fallbackUsed: Boolean(plan.fallbackUsed || mode !== "soft_follow"),
    textObstructionRisk: Boolean(mode === "soft_follow" && (plan.textObstructionRisk || computedTextObstructionRisk)),
  };
}

function cropStrategyFromPlan(cropPlan, metadata = {}) {
  const plan = validateCropPlan(cropPlan, metadata);
  const cropBox = plan.cropBox || fullSourceBox(metadata);
  return {
    type: plan.mode === "soft_follow" ? "soft_follow_crop" : "wide_safe_contain",
    x: cropBox.x,
    y: cropBox.y,
    width: cropBox.width,
    height: cropBox.height,
    zoom: plan.mode === "soft_follow" ? 1.02 : 1,
    background: plan.mode === "soft_follow" ? "none" : "blurred_fill",
    preserveFullFrame: plan.mode !== "soft_follow",
    maxCropPercent: plan.mode === "soft_follow" ? 0.28 : 0,
  };
}

function publicVisualTrackingSummary(summary, metadata = {}) {
  const safe = normalizeTrackingSummary(summary, metadata);
  return {
    frameCount: safe.frameCount,
    sampledTimestamps: safe.sampledTimestamps,
    detectedMotionRegions: safe.detectedMotionRegions.map((region) => ({
      timestamp: region.timestamp,
      confidence: region.confidence,
      reasonCodes: region.reasonCodes,
      bounds: region.bounds,
    })),
    estimatedActionCenter: safe.estimatedActionCenter,
    estimatedActionBounds: safe.estimatedActionBounds,
    ballCandidateConfidence: safe.ballCandidateConfidence,
    playerClusterConfidence: safe.playerClusterConfidence,
    cameraMotionLevel: safe.cameraMotionLevel,
    trackingConfidence: safe.trackingConfidence,
    recommendedFramingMode: safe.recommendedFramingMode,
    cropSafetyReason: safe.cropSafetyReason,
    fallbackUsed: safe.fallbackUsed,
    trackingProviderMode: safe.trackingProviderMode,
    trackingProviderFailureCode: safe.trackingProviderFailureCode,
    ballTrackCount: safe.ballTrackCount,
    playerClusterCount: safe.playerClusterCount,
    goalClaimAllowed: false,
  };
}

module.exports = {
  CROP_PLAN_MODES,
  analyzeVisualTracking,
  calibrateCropPlan,
  containsBox,
  cropStrategyFromPlan,
  normalizeTrackingSummary,
  overlapRatio,
  publicVisualTrackingSummary,
  trackingSummaryFromProviderOutput,
  validateCropPlan,
};
