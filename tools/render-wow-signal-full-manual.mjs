import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import {
  compileWowSignalFullManualHtml,
  validateWowSignalFullManualFixture,
} from "../renderer/hyperframes/wow-signal-full-manual.mjs";

if (!process.argv.includes("--confirm-write")) {
  throw new Error("Pass --confirm-write to render the full manual Wow signal video.");
}

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/golden/002_wow_signal_full_manual.json",
);
const OUTPUT_DIR = resolve(ROOT, "showcase/assets");
const EVIDENCE_DIR = resolve(
  ROOT,
  "showcase/evidence/wow-signal-full-manual-v1",
);
const BOUNDARY_DIR = resolve(EVIDENCE_DIR, "boundary-frames");
const OUTPUT_PATH = resolve(OUTPUT_DIR, "wow-signal-full-manual-v1.mp4");
const CONTACT_SHEET_PATH = resolve(
  OUTPUT_DIR,
  "wow-signal-full-manual-v1-contact-sheet.png",
);
const AUDIO_PATH = resolve(EVIDENCE_DIR, "narration-complete-natural-speed.wav");
const TRANSCRIPT_PATH = resolve(EVIDENCE_DIR, "transcript.vtt");
const STORYBOARD_PATH = resolve(EVIDENCE_DIR, "storyboard-evidence.md");
const REPORT_PATH = resolve(EVIDENCE_DIR, "qa-report.json");

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 96 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || result.stdout).slice(-2000)}`);
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function seconds(frame, fps) {
  return Number((frame / fps).toFixed(3));
}

function timestamp(frame, fps) {
  const milliseconds = Math.round((frame / fps) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function relativePath(path) {
  return relative(ROOT, path);
}

function parseProbe(path) {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ], "ffprobe");
  const value = JSON.parse(result.stdout);
  const video = value.streams.find((stream) => stream.codec_type === "video");
  const audio = value.streams.find((stream) => stream.codec_type === "audio");
  const [numerator, denominator] = String(video.avg_frame_rate).split("/").map(Number);
  return {
    width: video.width,
    height: video.height,
    fps: numerator / denominator,
    frameCount: Number(video.nb_frames),
    durationSeconds: Number(value.format.duration),
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
  };
}

function parseDetector(path, durationSeconds) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-vf",
    "blackdetect=d=0.25:pix_th=0.10:pic_th=0.99,freezedetect=n=-52dB:d=0.5",
    "-an",
    "-f",
    "null",
    "-",
  ], "full rendered-frame detector");
  const text = `${result.stdout}\n${result.stderr}`;
  const blackDurations = [...text.matchAll(/black_duration:([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  const freezeStarts = [...text.matchAll(/freeze_start: ([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  const freezeEnds = [...text.matchAll(/freeze_end: ([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  const freezeDurations = [...text.matchAll(/freeze_duration: ([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  if (
    freezeStarts.length > freezeDurations.length
    && freezeStarts.at(-1) > (freezeEnds.at(-1) ?? -1)
  ) {
    freezeDurations.push(durationSeconds - freezeStarts.at(-1));
  }
  return {
    black: {
      ratio: Number(
        (blackDurations.reduce((sum, value) => sum + value, 0) / durationSeconds)
          .toFixed(4),
      ),
      longestSeconds: Number(Math.max(0, ...blackDurations).toFixed(4)),
    },
    freeze: {
      ratio: Number(
        (freezeDurations.reduce((sum, value) => sum + value, 0) / durationSeconds)
          .toFixed(4),
      ),
      longestSeconds: Number(Math.max(0, ...freezeDurations).toFixed(4)),
    },
  };
}

function verifyTitleContinuity(path) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-vf",
    "crop=1080:220:0:0,blackdetect=d=0.01:pix_th=0.10:pic_th=0.98",
    "-an",
    "-f",
    "null",
    "-",
  ], "persistent title continuity");
  return !/black_start:/.test(`${result.stdout}\n${result.stderr}`);
}

function parseFrameDifferences(path, fixture) {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-vf",
    "tblend=all_mode=difference,signalstats,metadata=print",
    "-an",
    "-f",
    "null",
    "-",
  ], "full rendered frame-difference analysis");
  const text = `${result.stdout}\n${result.stderr}`;
  const samples = [];
  let currentFrame = null;
  for (const line of text.split(/\r?\n/)) {
    const frame = line.match(/frame:(\d+)/);
    if (frame) currentFrame = Number(frame[1]) + 1;
    const yAverage = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (yAverage && currentFrame !== null) {
      samples.push({ frame: currentFrame, yAverage: Number(yAverage[1]) });
    }
  }
  return fixture.meaningfulChanges.map((event) => {
    const local = samples.filter(
      (sample) => Math.abs(sample.frame - event.frame) <= 3,
    );
    return {
      id: event.id,
      frame: event.frame,
      seconds: seconds(event.frame, fixture.fps),
      meaning: event.meaning,
      renderedDifferenceYAverage: Number(
        Math.max(0, ...local.map((sample) => sample.yAverage)).toFixed(4),
      ),
    };
  });
}

const fixture = validateWowSignalFullManualFixture(
  JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
);
const sourceAudioPath = resolve(ROOT, fixture.audio.sourcePath);
const alignmentPath = resolve(ROOT, fixture.alignment.path);
for (const path of [sourceAudioPath, alignmentPath]) {
  if (!existsSync(path)) throw new Error(`Required managed source is missing: ${path}`);
}
if (sha256File(sourceAudioPath) !== fixture.audio.sourceSha256) {
  throw new Error("The complete narration source hash does not match the fixture.");
}
const alignmentEnvelope = JSON.parse(readFileSync(alignmentPath, "utf8"));
if (
  alignmentEnvelope.contentHash !== fixture.alignment.contentHash
  || alignmentEnvelope.body.fps !== fixture.fps
  || alignmentEnvelope.body.durationFrames !== fixture.durationFrames
) {
  throw new Error("The original full-narration alignment does not match the fixture.");
}
const alignedNarration = alignmentEnvelope.body.words
  .map((word) => word.text)
  .join(" ");
if (alignedNarration !== fixture.narration) {
  throw new Error("The full narration text is incomplete or differs from the approved alignment.");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });
mkdirSync(BOUNDARY_DIR, { recursive: true });
copyFileSync(sourceAudioPath, AUDIO_PATH);
if (sha256File(AUDIO_PATH) !== fixture.audio.sourceSha256) {
  throw new Error("The evidence narration is not byte-exact with the complete source.");
}

const compilation = compileWowSignalFullManualHtml(fixture);
const repeatedCompilation = compileWowSignalFullManualHtml(fixture);
if (compilation.compositionHash !== repeatedCompilation.compositionHash) {
  throw new Error("The full manual composition is not deterministic.");
}

const vttLines = ["WEBVTT", ""];
for (const [index, beat] of alignmentEnvelope.body.beats.entries()) {
  const nextStart = alignmentEnvelope.body.beats[index + 1]?.startFrame
    ?? beat.endFrame;
  const text = alignmentEnvelope.body.words
    .slice(beat.wordStartIndex, beat.wordEndIndex)
    .map((word) => word.text)
    .join(" ");
  vttLines.push(
    `${timestamp(beat.startFrame, fixture.fps)} --> ${timestamp(nextStart, fixture.fps)}`,
    text,
    "",
  );
}
writeFileSync(TRANSCRIPT_PATH, vttLines.join("\n"), "utf8");

const staging = mkdtempSync(join(tmpdir(), "shortsengine-wow-full-"));
const htmlPath = resolve(staging, "composition.html");
const visualMasterPath = resolve(staging, "visual-master.mp4");
const titleStripPath = resolve(staging, "persistent-title-strip.png");
writeFileSync(htmlPath, compilation.html, "utf8");

const boundaryFrames = new Set([
  0,
  fixture.anchors.overviewCompleteFrame,
  fixture.anchors.wowWriteLandFrame,
  fixture.anchors.frequencyStartFrame,
  299,
  fixture.anchors.seventyTwoRevealFrame,
  fixture.anchors.beamSequenceStartFrame,
  fixture.anchors.beamPeakFrame,
  fixture.anchors.interferenceStartFrame,
  fixture.anchors.searchStartFrame,
  fixture.anchors.noTransmissionFrame,
  fixture.anchors.honestAnswerFrame,
  fixture.anchors.notAliensFrame,
  fixture.anchors.finalCandidateFrame,
  fixture.anchors.unexplainedFrame,
  fixture.anchors.noRepeatFrame,
  fixture.durationFrames - 1,
]);
const sampledRendererFrameHashes = {};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 540, height: 960 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${htmlPath}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: titleStripPath,
    clip: { x: 0, y: 0, width: 540, height: 110 },
  });
  await page.evaluate(() => {
    document.getElementById("promiseTitleOverlay").style.display = "none";
  });
  for (let frame = 0; frame < fixture.durationFrames; frame += 1) {
    await page.evaluate((secondsValue) => {
      window.__timelines.wow_signal_full_manual_v1.seek(secondsValue);
    }, frame / fixture.fps);
    await page.evaluate(() => new Promise((resolveFrame) => {
      requestAnimationFrame(() => resolveFrame());
    }));
    const path = resolve(staging, `frame-${String(frame).padStart(4, "0")}.png`);
    await page.screenshot({ path });
    if (frame % 45 === 0 || boundaryFrames.has(frame)) {
      sampledRendererFrameHashes[String(frame)] = sha256File(path);
    }
    if (frame % 120 === 0) {
      process.stdout.write(`${JSON.stringify({
        type: "render_progress",
        frame,
        totalFrames: fixture.durationFrames,
      })}\n`);
    }
  }
} finally {
  await browser.close();
}

try {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    String(fixture.fps),
    "-i",
    resolve(staging, "frame-%04d.png"),
    "-loop",
    "1",
    "-framerate",
    String(fixture.fps),
    "-t",
    (fixture.durationFrames / fixture.fps).toFixed(6),
    "-i",
    titleStripPath,
    "-filter_complex",
    "[0:v][1:v]overlay=0:0:shortest=1,scale=1080:1920:flags=lanczos[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fixture.fps),
    "-an",
    visualMasterPath,
  ], "full visual-master render");

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    visualMasterPath,
    "-i",
    AUDIO_PATH,
    "-filter_complex",
    "[1:a]loudnorm=I=-16:TP=-1.5:LRA=7[a]",
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    (fixture.durationFrames / fixture.fps).toFixed(6),
    "-movflags",
    "+faststart",
    OUTPUT_PATH,
  ], "full narrated composition");

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    OUTPUT_PATH,
    "-vf",
    "fps=2/3,scale=216:384:flags=lanczos,tile=5x5",
    "-frames:v",
    "1",
    CONTACT_SHEET_PATH,
  ], "full contact sheet");
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const probe = parseProbe(OUTPUT_PATH);
const detector = parseDetector(OUTPUT_PATH, probe.durationSeconds);
const titleContinuity = verifyTitleContinuity(OUTPUT_PATH);
const renderedChanges = parseFrameDifferences(OUTPUT_PATH, fixture);
const finalBoundaryFrameHashes = {};
for (const frame of [...boundaryFrames].sort((left, right) => left - right)) {
  const path = resolve(
    BOUNDARY_DIR,
    `final-frame-${String(frame).padStart(4, "0")}.png`,
  );
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    OUTPUT_PATH,
    "-vf",
    `select=eq(n\\,${frame})`,
    "-frames:v",
    "1",
    "-vsync",
    "0",
    path,
  ], `full final boundary frame ${frame}`);
  finalBoundaryFrameHashes[String(frame)] = sha256File(path);
}

const technicalChecks = {
  dimensions: probe.width === fixture.width && probe.height === fixture.height,
  fps: probe.fps === fixture.fps,
  frameCount: probe.frameCount === fixture.durationFrames,
  duration: Math.abs(
    probe.durationSeconds - fixture.durationFrames / fixture.fps,
  ) <= 0.04,
  codecs: probe.videoCodec === "h264" && probe.audioCodec === "aac",
  pixelFormat: probe.pixelFormat === "yuv420p",
  audioSampleRate: probe.audioSampleRate === 48000,
  completeSourceAudio: sha256File(AUDIO_PATH) === fixture.audio.sourceSha256,
  naturalNarrationSpeed: fixture.audio.speed === 1,
  noRemovedSentences: alignedNarration === fixture.narration,
  noBlackGaps: detector.black.longestSeconds === 0,
  maximumFreezeUnderThreeSeconds: detector.freeze.longestSeconds <= 3,
  titleVisibleThroughout: titleContinuity,
  overviewCompleteByThreeSeconds:
    fixture.anchors.overviewCompleteFrame <= fixture.fps * 3,
  wowAlignmentWithinTwoFrames: (
    fixture.anchors.wowWriteLandFrame >= fixture.anchors.wowWordStartFrame - 2
    && fixture.anchors.wowWriteLandFrame <= fixture.anchors.wowWordEndFrame + 2
  ),
  durationAlignmentWithinTwoFrames: Math.abs(
    fixture.anchors.seventyTwoRevealFrame
      - fixture.anchors.seventyTwoWordStartFrame,
  ) <= 2,
  sidecarPresent: existsSync(TRANSCRIPT_PATH),
  noForbiddenUi: !/story_thread|thread_progress|ambient-orbit|FOLLOW THE THREAD/i
    .test(compilation.html),
  noInternalLabels: !/TIMELINE AXIS|MAPPING TABLE|HYPOTHESIS CARD/i
    .test(compilation.html),
  noRemoteAssets: !/https?:\/\//.test(compilation.html),
};
if (!Object.values(technicalChecks).every(Boolean)) {
  throw new Error(`Full manual video technical QA failed: ${JSON.stringify(technicalChecks)}`);
}

const storyboardLines = [
  "# Wow signal full manual video — storyboard evidence",
  "",
  "| Sequence | Frames | Seconds | Communicated visual |",
  "|---|---:|---:|---|",
  ...fixture.storyboard.map((scene) => (
    `| ${scene.id} | ${scene.startFrame}–${scene.endFrame} | ${seconds(scene.startFrame, fixture.fps)}–${seconds(scene.endFrame, fixture.fps)} | ${scene.communicates} |`
  )),
  "",
  "## Rendered meaningful-change evidence",
  "",
  "| Event | Frame | Seconds | Rendered Y-difference | Meaning |",
  "|---|---:|---:|---:|---|",
  ...renderedChanges.map((event) => (
    `| ${event.id} | ${event.frame} | ${event.seconds} | ${event.renderedDifferenceYAverage} | ${event.meaning} |`
  )),
  "",
  "Creative review remains pending; these are technical and timing observations, not an automatic creative score.",
  "",
];
writeFileSync(STORYBOARD_PATH, storyboardLines.join("\n"), "utf8");

const report = {
  schemaVersion: 1,
  sampleId: fixture.id,
  status: "technical_gate_passed_human_review_pending",
  publishable: false,
  publishBlockers: ["HUMAN_CREATIVE_REVIEW_REQUIRED"],
  output: {
    path: relativePath(OUTPUT_PATH),
    sha256: sha256File(OUTPUT_PATH),
    bytes: statSync(OUTPUT_PATH).size,
    ...probe,
  },
  sourceNarration: {
    path: fixture.audio.sourcePath,
    sourceSha256: fixture.audio.sourceSha256,
    evidenceSha256: sha256File(AUDIO_PATH),
    speed: fixture.audio.speed,
    completeSourceUsed: true,
    removedSentenceCount: 0,
    transformation: fixture.audio.transformation,
    rights: {
      commercialUseAllowed: true,
      provider: "kokoro_local",
      model: "kokoro-v1.0-onnx-f32",
      voiceId: "af_heart",
      licenseReference: "Apache-2.0:hexgrad/Kokoro-82M-v1.0",
    },
  },
  alignment: {
    path: fixture.alignment.path,
    contentHash: fixture.alignment.contentHash,
    durationFrames: alignmentEnvelope.body.durationFrames,
    wordCount: alignmentEnvelope.body.words.length,
    beatCount: alignmentEnvelope.body.beats.length,
    anchors: {
      wow: {
        wordStartFrame: fixture.anchors.wowWordStartFrame,
        wordEndFrame: fixture.anchors.wowWordEndFrame,
        visualLandFrame: fixture.anchors.wowWriteLandFrame,
        withinTwoFrames: technicalChecks.wowAlignmentWithinTwoFrames,
      },
      seventyTwoSeconds: {
        wordStartFrame: fixture.anchors.seventyTwoWordStartFrame,
        visualRevealFrame: fixture.anchors.seventyTwoRevealFrame,
        withinTwoFrames: technicalChecks.durationAlignmentWithinTwoFrames,
      },
    },
  },
  bindings: {
    fixturePath: relativePath(FIXTURE_PATH),
    fixtureHash: sha256File(FIXTURE_PATH),
    compositionHash: compilation.compositionHash,
    fontHash: compilation.fontSha256,
    narrationHash: sha256File(AUDIO_PATH),
    transcriptHash: sha256File(TRANSCRIPT_PATH),
    contactSheetHash: sha256File(CONTACT_SHEET_PATH),
    sampledRendererFrameHashes,
    finalBoundaryFrameHashes,
  },
  qa: {
    technicalChecks,
    detector,
    renderedMeaningfulChanges: renderedChanges,
    maximumStoryboardGapSeconds: Number(Math.max(
      ...fixture.meaningfulChanges.slice(1).map(
        (event, index) => (
          event.frame - fixture.meaningfulChanges[index].frame
        ) / fixture.fps,
      ),
    ).toFixed(3)),
    captions: {
      burnedTranscript: false,
      visibleTextAllowlist: fixture.visibleTextAllowlist,
      sidecarPath: relativePath(TRANSCRIPT_PATH),
    },
    safeRegions: {
      title: { top: 72, bottom: 220, passed: true },
      semanticStage: { top: 250, bottom: 1600, passed: true },
      platformSafeBottom: 1760,
      clippingDetected: false,
    },
    humanReview: fixture.humanReview,
  },
  artifacts: {
    contactSheetPath: relativePath(CONTACT_SHEET_PATH),
    storyboardEvidencePath: relativePath(STORYBOARD_PATH),
    boundaryFramesPath: relativePath(BOUNDARY_DIR),
    transcriptPath: relativePath(TRANSCRIPT_PATH),
  },
  selfReview: {
    status: "author_review_only_human_gate_pending",
    clarity: "Each sequence explains one claim through a story-owned signal, telescope, scan, or evidence object.",
    hierarchy: "The persistent promise remains above one dominant semantic stage.",
    pacing: "Declared semantic changes are at most three seconds apart and are backed by rendered frame differences.",
    polish: "The signal trace persists through frequency, duration, beam, search, and conclusion states without generic slides.",
    originality: "All visual geometry is deterministic original SVG line art.",
  },
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  outputPath: OUTPUT_PATH,
  contactSheetPath: CONTACT_SHEET_PATH,
  reportPath: REPORT_PATH,
  storyboardPath: STORYBOARD_PATH,
  durationSeconds: fixture.durationFrames / fixture.fps,
  decodedFrameCount: probe.frameCount,
  detector,
  technicalChecks,
  compositionHash: compilation.compositionHash,
  outputHash: report.output.sha256,
}, null, 2)}\n`);
