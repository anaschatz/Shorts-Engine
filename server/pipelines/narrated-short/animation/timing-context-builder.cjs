const { AppError } = require("../../../errors.cjs");
const { normalizeDraftBundle } = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");

function stale(field) {
  throw new AppError("ANIMATION_TIMING_BINDING_MISMATCH", "Animation timing does not match the approved narration.", 409, { field });
}

function buildProductionTimingContext(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const alignment = normalizeAlignment(input.alignment);
  const projectId = String(input.projectId || alignment.projectId);
  const projectRevision = Number(input.projectRevision || alignment.projectRevision);
  const draftArtifactId = String(input.draftArtifactId || alignment.draftArtifactId);
  const draftHash = String(input.draftHash || draft.contentHash);
  const alignmentHash = String(input.alignmentHash || alignment.contentHash);

  if (draft.verticalId !== "dark_curiosity" || projectId !== alignment.projectId) stale("projectId");
  if (projectRevision !== alignment.projectRevision) stale("projectRevision");
  if (draftArtifactId !== alignment.draftArtifactId) stale("draftArtifactId");
  if (draftHash !== draft.contentHash || alignment.draftHash !== draftHash) stale("draftHash");
  if (alignment.scriptHash !== draft.script.contentHash) stale("scriptHash");
  if (alignmentHash !== alignment.contentHash) stale("alignmentHash");
  const scriptBeatIds = draft.script.beats.map((beat) => beat.id);
  if (scriptBeatIds.length !== alignment.beats.length || scriptBeatIds.some((beatId, index) => alignment.beats[index].beatId !== beatId)) stale("beats");

  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: alignment.fps,
    durationFrames: alignment.durationFrames,
    alignmentHash,
    draftHash,
    words: alignment.words.map(({ index, text, startFrame, endFrame }) => ({ index, text, startFrame, endFrame })),
    beats: alignment.beats.map(({ beatId, wordStartIndex, wordEndIndex, startFrame, endFrame }) => ({ beatId, wordStartIndex, wordEndIndex, startFrame, endFrame })),
  });
}

module.exports = { buildProductionTimingContext };
