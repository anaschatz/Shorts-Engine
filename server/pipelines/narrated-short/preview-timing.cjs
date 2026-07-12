const { normalizeDraftBundle, contentHash } = require("./contracts.cjs");
const { normalizeNarrationManifest } = require("./narration-contract.cjs");

function createPreviewTimingManifest(draftInput) {
  const draft = normalizeDraftBundle(draftInput);
  const tokens = draft.script.beats.flatMap((beat) => beat.spokenText.split(/\s+/).filter(Boolean));
  const totalFrames = draft.script.estimatedSeconds * 30;
  const paddingFrames = Math.min(15, Math.max(3, Math.floor(totalFrames * 0.01)));
  const availableFrames = totalFrames - (paddingFrames * 2);
  const baseFrames = Math.floor(availableFrames / tokens.length);
  let remainder = availableFrames - (baseFrames * tokens.length);
  let cursor = paddingFrames;
  const words = tokens.map((text) => {
    const wordFrames = baseFrames + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    const word = { text, startFrame: cursor, endFrame: cursor + wordFrames };
    cursor = word.endFrame;
    return word;
  });
  return normalizeNarrationManifest({
    providerMode: "timing_estimate",
    voiceProfileId: "preview_silent",
    audioArtifactId: `art_${contentHash({ draft: draft.contentHash, mode: "preview_silent" }).slice(0, 40)}`,
    audioHash: contentHash({ draft: draft.contentHash, silence: true }),
    sampleRate: 48000,
    durationFrames: totalFrames,
    words,
    rights: { commercialUseAllowed: true, consentReference: "silent_preview_no_voice" },
  });
}

module.exports = { createPreviewTimingManifest };
