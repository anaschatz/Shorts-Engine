const { gate } = require("./contract.cjs");

function runTimelineQa({ timeline, timelineArtifact, alignment, caption }) {
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  const clips = tracks.flatMap((track) => Array.isArray(track.clips) ? track.clips : []);
  const validClips = clips.every((clip) => Number.isInteger(clip.startFrame) && Number.isInteger(clip.endFrame) && clip.startFrame >= 0 && clip.endFrame > clip.startFrame && clip.endFrame <= timeline.totalFrames);
  const beatValid = timeline.beatTimings.length === alignment.beats.length && timeline.beatTimings.every((beat, index) => beat.beatId === alignment.beats[index].beatId && beat.startFrame === alignment.beats[index].startFrame && beat.endFrame === alignment.beats[index].endFrame);
  const captionValid = caption.cues.every((cue) => cue.startFrame >= 0 && cue.endFrame <= timeline.totalFrames);
  return [
    gate("TIMELINE_HASH_VALID", "timeline", timelineArtifact.envelope.contentHash === timeline.contentHash, { expected: timeline.contentHash, actual: timelineArtifact.envelope.contentHash }),
    gate("TIMELINE_ALIGNED_MODE", "timeline", timeline.timingMode === "uploaded_aligned", { expected: "uploaded_aligned", actual: timeline.timingMode }),
    gate("TIMELINE_DURATION_VALID", "timeline", timeline.totalFrames === alignment.durationFrames, { expected: alignment.durationFrames, actual: timeline.totalFrames }),
    gate("TIMELINE_BEATS_VALID", "timeline", beatValid, { expected: alignment.beats.length, actual: timeline.beatTimings.length }),
    gate("TIMELINE_SCENES_VALID", "timeline", validClips, { count: clips.length }),
    gate("TIMELINE_CAPTIONS_VALID", "timeline", captionValid, { count: caption.cues.length }),
    gate("TIMELINE_TRACKS_COMPLETE", "timeline", ["background", "visual_scene", "caption", "narration"].every((type) => tracks.some((track) => track.type === type)), { count: tracks.length }),
  ];
}
module.exports = { runTimelineQa };
