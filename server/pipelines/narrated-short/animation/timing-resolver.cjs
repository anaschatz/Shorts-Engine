const { AppError } = require("../../../errors.cjs");

const ANCHORS = new Set(["absolute", "beat_start", "beat_end", "word_start", "word_end"]);

function fail(field, message) {
  throw new AppError("ANIMATION_TIMING_INVALID", message || "Animation timing anchor is invalid.", 400, { field });
}

function resolveTimingAnchor(anchor, timing, scene, field = "anchor") {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) || !ANCHORS.has(anchor.anchor)) fail(field);
  const offset = anchor.offsetFrames === undefined ? 0 : anchor.offsetFrames;
  if (!Number.isInteger(offset) || offset < -90 || offset > 90) fail(`${field}.offsetFrames`);
  let base;
  if (anchor.anchor === "absolute") {
    if (!Number.isInteger(anchor.frame)) fail(`${field}.frame`);
    base = anchor.frame;
  } else if (anchor.anchor.startsWith("beat_")) {
    const beat = timing?.beats?.find((candidate) => candidate.beatId === anchor.beatId);
    if (!beat) fail(`${field}.beatId`, "Animation timing references an unknown beat.");
    base = anchor.anchor === "beat_start" ? beat.startFrame : beat.endFrame - 1;
  } else {
    if (!Number.isInteger(anchor.wordIndex)) fail(`${field}.wordIndex`);
    const word = timing?.words?.find((candidate) => candidate.index === anchor.wordIndex);
    if (!word) fail(`${field}.wordIndex`, "Animation timing references an unknown word.");
    base = anchor.anchor === "word_start" ? word.startFrame : word.endFrame - 1;
  }
  const resolvedFrame = base + offset;
  if (!Number.isInteger(resolvedFrame) || resolvedFrame < 0 || resolvedFrame >= timing.durationFrames || resolvedFrame < scene.startFrame || resolvedFrame >= scene.endFrame) fail(`${field}.resolvedFrame`, "Resolved timing falls outside its scene.");
  if (anchor.resolvedFrame !== undefined && anchor.resolvedFrame !== resolvedFrame) fail(`${field}.resolvedFrame`, "Resolved timing does not match its semantic anchor.");
  return resolvedFrame;
}

module.exports = { resolveTimingAnchor };
