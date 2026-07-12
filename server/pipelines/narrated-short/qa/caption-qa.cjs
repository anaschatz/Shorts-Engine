const { CAPTION_PROFILE, CAPTION_PROFILE_VERSION, CAPTION_RENDERER_VERSION, SAFE_ZONE } = require("../captions/contract.cjs");
const { gate } = require("./contract.cjs");

function runCaptionQa({ alignment, caption, captionAssArtifact, renderResult, fontAvailable }) {
  const words = caption.cues.flatMap((cue) => cue.words);
  const exactWords = words.length === alignment.words.length && words.every((word, index) => word.wordIndex === index && word.text === alignment.words[index].text && word.startFrame === alignment.words[index].startFrame && word.endFrame === alignment.words[index].endFrame);
  const timings = caption.cues.every((cue, index) => cue.startFrame >= (index ? caption.cues[index - 1].endFrame : 0) && cue.endFrame <= caption.durationFrames && cue.endFrame > cue.startFrame);
  const safe = JSON.stringify(caption.safeZone) === JSON.stringify(SAFE_ZONE) && caption.cues.every((cue) => cue.lines.length <= 2);
  return [
    gate("CAPTION_ALIGNMENT_EXACT", "caption", caption.alignmentHash === alignment.contentHash || exactWords),
    gate("CAPTION_WORD_COVERAGE_COMPLETE", "caption", exactWords, { expected: alignment.words.length, actual: words.length }),
    gate("CAPTION_TIMINGS_VALID", "caption", timings, { count: caption.cues.length }),
    gate("CAPTION_SAFE_ZONE_VALID", "caption", safe, { profile: CAPTION_PROFILE }),
    gate("CAPTION_FONT_VALID", "caption", fontAvailable === true),
    gate("CAPTION_ASS_BOUND", "caption", caption.profileVersion === CAPTION_PROFILE_VERSION && caption.rendererVersion === CAPTION_RENDERER_VERSION && captionAssArtifact.checksumSha256.length === 64),
    gate("CAPTION_BURN_CONFIRMED", "caption", renderResult.captionsIncluded === true && renderResult.captionsBurned === true),
  ];
}
module.exports = { runCaptionQa };
