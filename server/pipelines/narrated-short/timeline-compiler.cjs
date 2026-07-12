const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { normalizeDraftBundle, contentHash } = require("./contracts.cjs");
const { normalizeNarrationManifest } = require("./narration-contract.cjs");
const { RENDERER_VERSION, templateVersionsFor } = require("./scene-renderer-registry.cjs");
const { verticalDescriptor } = require("./vertical-registry.cjs");

function token(value) {
  return String(value || "")
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}']+/gu, "")
    .trim();
}

function spokenTokens(value) {
  return String(value || "").split(/\s+/).map(token).filter(Boolean);
}

function alignBeats(script, narration) {
  const narrationTokens = narration.words.map((word) => token(word.text));
  const timings = [];
  let cursor = 0;
  for (const beat of script.beats) {
    const expected = spokenTokens(beat.spokenText);
    if (!expected.length || cursor + expected.length > narrationTokens.length) {
      throw new AppError("NARRATION_ALIGNMENT_FAILED", "Narration does not cover the approved script.", 409, { beatId: beat.id });
    }
    const actual = narrationTokens.slice(cursor, cursor + expected.length);
    if (expected.some((value, index) => value !== actual[index])) {
      throw new AppError("NARRATION_ALIGNMENT_FAILED", "Narration words do not match the approved script.", 409, { beatId: beat.id });
    }
    const words = narration.words.slice(cursor, cursor + expected.length);
    timings.push({
      beatId: beat.id,
      startFrame: words[0].startFrame,
      endFrame: words[words.length - 1].endFrame,
      wordStartIndex: cursor,
      wordEndIndex: cursor + expected.length,
    });
    cursor += expected.length;
  }
  if (cursor !== narration.words.length) {
    throw new AppError("NARRATION_ALIGNMENT_FAILED", "Narration contains words outside the approved script.", 409);
  }
  return timings;
}

function compileTimeline(input = {}) {
  const bundle = normalizeDraftBundle(input.draftBundle);
  const narration = normalizeNarrationManifest(input.narrationManifest);
  const vertical = verticalDescriptor(bundle.verticalId, bundle.brief.formatId);
  const fps = 30;
  const beatTimings = alignBeats(bundle.script, narration);
  const timingByBeat = new Map(beatTimings.map((timing) => [timing.beatId, timing]));
  const visualClips = bundle.storyboard.scenes.map((scene) => {
    const timings = scene.beatIds.map((beatId) => timingByBeat.get(beatId));
    return {
      id: scene.id,
      sceneId: scene.id,
      verticalId: vertical.verticalId,
      template: scene.template,
      templateVersion: "1.0.0",
      reconstructionMode: scene.reconstructionMode || null,
      visualMode: scene.visualMode || null,
      disclosure: scene.disclosure || null,
      startFrame: Math.min(...timings.map((timing) => timing.startFrame)),
      endFrame: Math.max(...timings.map((timing) => timing.endFrame)),
      operations: scene.operations,
    };
  });
  for (let index = 1; index < visualClips.length; index += 1) {
    if (visualClips[index].startFrame < visualClips[index - 1].endFrame) {
      throw new AppError("TIMELINE_INVALID", "Visual scenes overlap.", 409, { sceneId: visualClips[index].sceneId });
    }
  }
  const captions = bundle.script.beats.map((beat) => {
    const timing = timingByBeat.get(beat.id);
    return {
      id: `caption_${beat.id}`,
      beatId: beat.id,
      role: beat.role,
      text: beat.onScreenText,
      startFrame: timing.startFrame,
      endFrame: timing.endFrame,
      words: narration.words.slice(timing.wordStartIndex, timing.wordEndIndex),
    };
  });
  const seedSource = contentHash({
    draft: bundle.contentHash,
    narration: narration.contentHash,
  });
  const timeline = {
    schemaVersion: vertical.schemaVersion,
    verticalId: vertical.verticalId,
    formatId: bundle.brief.formatId,
    timingMode: input.timingMode || (narration.providerMode === "uploaded_aligned" ? "uploaded_aligned" : "estimated_silent"),
    alignmentArtifactId: input.alignmentArtifactId || null,
    alignmentHash: input.alignmentHash || null,
    audioArtifactId: narration.audioArtifactId,
    audioHash: narration.audioHash,
    rendererVersion: RENDERER_VERSION,
    fps,
    width: Number(input.width || 1080),
    height: Number(input.height || 1920),
    totalFrames: narration.durationFrames,
    tracks: [
      { type: "background", zIndex: 0, clips: [{ id: "background", startFrame: 0, endFrame: narration.durationFrames }] },
      { type: vertical.timelineTrackType, zIndex: 10, clips: visualClips },
      { type: "caption", zIndex: 30, clips: captions },
      { type: "narration", zIndex: 50, clips: [{ id: "narration", startFrame: 0, endFrame: narration.durationFrames, audioArtifactId: narration.audioArtifactId }] },
    ],
    beatTimings,
    templateVersions: templateVersionsFor(vertical.verticalId, visualClips.map((clip) => clip.template), bundle.brief.formatId),
    assetManifestHash: input.assetManifestHash || "0".repeat(64),
    seed: Number.parseInt(seedSource.slice(0, 8), 16),
  };
  if (![720, 1080].includes(timeline.width) || ![1280, 1920].includes(timeline.height) || timeline.height / timeline.width !== 16 / 9) {
    throw new AppError("TIMELINE_INVALID", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "dimensions" });
  }
  return { ...timeline, contentHash: contentHash(timeline) };
}

function timelineTrack(timeline, type) {
  return timeline.tracks.find((track) => track.type === type) || null;
}

module.exports = {
  alignBeats,
  compileTimeline,
  timelineTrack,
};
