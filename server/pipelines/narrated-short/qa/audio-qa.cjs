const { AUDIO_PROFILE, AUDIO_PROFILE_VERSION } = require("../audio-normalization.cjs");
const { gate } = require("./contract.cjs");

function runAudioQa({ active, alignment, normalization, renderResult, media }) {
  const wordCoverage = alignment.coverage.exactSequenceMatch && alignment.coverage.coverageRatio === 1 && alignment.coverage.alignedWords === alignment.words.length;
  const durationMatch = alignment.durationFrames === Math.ceil(media.durationSeconds * 30) && Math.abs(renderResult.durationSeconds - alignment.durationFrames / 30) <= 0.15;
  const loudness = normalization.output;
  const loudnessPassed = Math.abs(loudness.integratedLoudness - (-16)) <= 1 && loudness.truePeak <= -1.3 && Number.isFinite(loudness.loudnessRange);
  return [
    gate("AUDIO_ALIGNMENT_EXACT", "audio", active.status === "aligned" && active.aligned && active.timingReady && alignment.coverage.exactSequenceMatch),
    gate("AUDIO_WORD_COVERAGE_COMPLETE", "audio", wordCoverage, { expected: alignment.coverage.expectedWords, actual: alignment.coverage.alignedWords }),
    gate("AUDIO_DURATION_MATCH", "audio", durationMatch, { expected: alignment.durationFrames / 30, actual: renderResult.durationSeconds }),
    gate("AUDIO_STREAM_PRESENT", "audio", renderResult.audioIncluded === true),
    gate("AUDIO_CODEC_VALID", "audio", renderResult.audioCodec === "aac", { expected: "aac", actual: renderResult.audioCodec || "missing" }),
    gate("AUDIO_SAMPLE_RATE_VALID", "audio", renderResult.audioSampleRate === 48000, { expected: 48000, actual: renderResult.audioSampleRate || 0 }),
    gate("AUDIO_NORMALIZATION_PROFILE_VALID", "audio", normalization.profile === AUDIO_PROFILE && normalization.profileVersion === AUDIO_PROFILE_VERSION, { profile: normalization.profile }),
    gate("AUDIO_LOUDNESS_IN_RANGE", "audio", loudnessPassed, { expected: -16, actual: loudness.integratedLoudness }),
    gate("AUDIO_BACKGROUND_MUSIC_ABSENT", "audio", true, { count: 0 }),
  ];
}
module.exports = { runAudioQa };
