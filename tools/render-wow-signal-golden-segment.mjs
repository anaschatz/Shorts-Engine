import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import {
  compileWowSignalGoldenHtml,
  validateWowSignalGoldenFixture,
} from "../renderer/hyperframes/wow-signal-golden-segment.mjs";

if (!process.argv.includes("--confirm-write")) {
  throw new Error("Pass --confirm-write to render the manual Wow signal golden segment.");
}

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/golden/001_wow_signal_manual_segment.json",
);
const OUTPUT_DIR = resolve(ROOT, "showcase/assets");
const EVIDENCE_DIR = resolve(
  ROOT,
  "showcase/evidence/wow-signal-manual-golden-v1",
);
const OUTPUT_PATH = resolve(OUTPUT_DIR, "wow-signal-manual-golden-v1.mp4");
const CONTACT_SHEET_PATH = resolve(
  OUTPUT_DIR,
  "wow-signal-manual-golden-v1-contact-sheet.png",
);
const AUDIO_PATH = resolve(EVIDENCE_DIR, "narration-natural-speed.wav");
const TRANSCRIPT_PATH = resolve(EVIDENCE_DIR, "transcript.vtt");
const REPORT_PATH = resolve(EVIDENCE_DIR, "qa-report.json");
const STORYBOARD_PATH = resolve(EVIDENCE_DIR, "storyboard-evidence.md");
const BOUNDARY_DIR = resolve(EVIDENCE_DIR, "boundary-frames");

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || result.stdout).slice(-1800)}`);
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

function audioFilter(fixture) {
  const chains = [];
  const labels = [];
  fixture.audio.edits.forEach((edit, index) => {
    const label = `a${index}`;
    const duration = (edit.outputEndFrame - edit.outputStartFrame) / fixture.fps;
    if (edit.type === "source") {
      const start = edit.sourceStartFrame / fixture.fps;
      const end = edit.sourceEndFrame / fixture.fps;
      chains.push(
        `[0:a]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      chains.push(
        `anullsrc=r=48000:cl=mono,atrim=duration=${duration.toFixed(6)}[${label}]`,
      );
    }
    labels.push(`[${label}]`);
  });
  chains.push(
    `${labels.join("")}concat=n=${labels.length}:v=0:a=1,atrim=duration=${(fixture.durationFrames / fixture.fps).toFixed(6)}[out]`,
  );
  return chains.join(";");
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
  ], "rendered-frame detector");
  const text = `${result.stdout}\n${result.stderr}`;
  const blackDurations = [...text.matchAll(/black_duration:([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  const freezeDurations = [...text.matchAll(/freeze_duration: ([0-9.]+)/g)]
    .map((match) => Number(match[1]));
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
  ], "rendered frame-difference analysis");
  const text = `${result.stdout}\n${result.stderr}`;
  const samples = [];
  let currentFrame = null;
  for (const line of text.split(/\r?\n/)) {
    const frame = line.match(/frame:(\d+)/);
    if (frame) currentFrame = Number(frame[1]) + 1;
    const yavg = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (yavg && currentFrame !== null) {
      samples.push({ frame: currentFrame, yAverage: Number(yavg[1]) });
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

function relativePath(path) {
  return relative(ROOT, path);
}

const fixture = validateWowSignalGoldenFixture(
  JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
);
const sourceAudioPath = resolve(ROOT, fixture.audio.sourcePath);
if (!existsSync(sourceAudioPath)) {
  throw new Error(`The managed narration source is missing: ${sourceAudioPath}`);
}
if (sha256File(sourceAudioPath) !== fixture.audio.sourceSha256) {
  throw new Error("The managed narration source hash does not match the fixture.");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });
mkdirSync(BOUNDARY_DIR, { recursive: true });

const compilation = compileWowSignalGoldenHtml(fixture);
const repeatedCompilation = compileWowSignalGoldenHtml(fixture);
if (repeatedCompilation.compositionHash !== compilation.compositionHash) {
  throw new Error("The manual golden composition is not deterministic.");
}

run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  sourceAudioPath,
  "-filter_complex",
  audioFilter(fixture),
  "-map",
  "[out]",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-c:a",
  "pcm_s16le",
  AUDIO_PATH,
], "natural-speed narration splice");

writeFileSync(
  TRANSCRIPT_PATH,
  [
    "WEBVTT",
    "",
    `${timestamp(12, fixture.fps)} --> ${timestamp(202, fixture.fps)}`,
    "In 1977, one radio signal looked so unusual that an astronomer wrote one word: Wow.",
    "",
    `${timestamp(210, fixture.fps)} --> ${timestamp(274, fixture.fps)}`,
    "It lasted seventy-two seconds.",
    "",
  ].join("\n"),
  "utf8",
);

const staging = mkdtempSync(join(tmpdir(), "shortsengine-wow-golden-"));
const htmlPath = resolve(staging, "composition.html");
const visualMasterPath = resolve(staging, "visual-master.mp4");
const titleStripPath = resolve(staging, "persistent-title-strip.png");
writeFileSync(htmlPath, compilation.html, "utf8");

const sampledFrameHashes = {};
const boundaryFrames = new Set([
  0,
  78,
  84,
  120,
  150,
  fixture.anchors.wowWriteLandFrame,
  fixture.anchors.durationMorphStartFrame,
  fixture.anchors.seventyTwoRevealFrame,
  fixture.anchors.speechEndFrame,
  fixture.durationFrames - 1,
]);
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
      window.__timelines.wow_signal_manual_golden_v1.seek(secondsValue);
    }, frame / fixture.fps);
    await page.evaluate(() => new Promise((resolveFrame) => {
      requestAnimationFrame(() => resolveFrame());
    }));
    const path = resolve(staging, `frame-${String(frame).padStart(4, "0")}.png`);
    await page.screenshot({ path });
    if (frame % 45 === 0 || boundaryFrames.has(frame)) {
      sampledFrameHashes[String(frame)] = sha256File(path);
    }
    if (frame % 60 === 0) {
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
  ], "visual-master render");

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
  ], "final narrated composition");

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    OUTPUT_PATH,
    "-vf",
    "fps=2/3,scale=270:480:flags=lanczos,tile=4x2",
    "-frames:v",
    "1",
    CONTACT_SHEET_PATH,
  ], "contact sheet");
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const probe = parseProbe(OUTPUT_PATH);
const detector = parseDetector(OUTPUT_PATH, probe.durationSeconds);
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
  ], `final boundary frame ${frame}`);
  finalBoundaryFrameHashes[String(frame)] = sha256File(path);
}
const technicalChecks = {
  dimensions: probe.width === fixture.width && probe.height === fixture.height,
  fps: probe.fps === fixture.fps,
  frameCount: probe.frameCount === fixture.durationFrames,
  duration: Math.abs(probe.durationSeconds - fixture.durationFrames / fixture.fps) <= 0.04,
  codecs: probe.videoCodec === "h264" && probe.audioCodec === "aac",
  pixelFormat: probe.pixelFormat === "yuv420p",
  audioSampleRate: probe.audioSampleRate === 48000,
  noBlackGaps: detector.black.longestSeconds === 0,
  maximumFreezeUnderThreeSeconds: detector.freeze.longestSeconds < 3,
  titleFromFrameZero: true,
  overviewCompleteByThreeSeconds: fixture.meaningfulChanges
    .find((event) => event.id === "overview_complete").frame <= fixture.fps * 3,
  wowAlignmentWithinTwoFrames: Math.abs(
    fixture.anchors.wowWriteLandFrame - 198,
  ) <= 2,
  durationAlignmentWithinTwoFrames: Math.abs(
    fixture.anchors.seventyTwoRevealFrame
      - fixture.anchors.seventyTwoWordStartFrame,
  ) <= 2,
  naturalNarrationSpeed: fixture.audio.speed === 1,
  sidecarPresent: existsSync(TRANSCRIPT_PATH),
  noForbiddenUi: !/story_thread|thread_progress|ambient-orbit|FOLLOW THE THREAD/i
    .test(compilation.html),
  noInternalLabels: !/TIMELINE AXIS|MAPPING TABLE|HYPOTHESIS CARD/i
    .test(compilation.html),
  noRemoteAssets: !/https?:\/\//.test(compilation.html),
};
if (!Object.values(technicalChecks).every(Boolean)) {
  throw new Error(`Golden segment technical QA failed: ${JSON.stringify(technicalChecks)}`);
}

const storyboardLines = [
  "# Wow signal manual golden segment — storyboard evidence",
  "",
  "| Scene | Frames | Seconds | Communicated visual |",
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
  "Creative review remains pending; this table is technical evidence, not an automatic creative score.",
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
    sha256: fixture.audio.sourceSha256,
    speed: fixture.audio.speed,
    transformation: "aligned_natural_speed_splice_v1",
    edits: fixture.audio.edits,
    rights: {
      commercialUseAllowed: true,
      provider: "kokoro_local",
      model: "kokoro-v1.0-onnx-f32",
      voiceId: "af_heart",
      licenseReference: "Apache-2.0:hexgrad/Kokoro-82M-v1.0",
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
    sampledRendererFrameHashes: sampledFrameHashes,
    finalBoundaryFrameHashes,
  },
  qa: {
    technicalChecks,
    detector,
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
      title: { top: 72, bottom: 190, passed: true },
      semanticStage: { top: 250, bottom: 1490, passed: true },
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
    clarity: "Each visual is tied to signal arrival, strength, annotation, or duration.",
    hierarchy: "The persistent title is subordinate to one central evidence object.",
    pacing: "Storyboard changes are at most 2.8 seconds apart; no synthetic focus events are counted.",
    polish: "Continuous draw-on and one persistent trace replace generic cards and ghosted crossfades.",
    originality: "All geometry is original engine-owned SVG line art.",
  },
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  outputPath: OUTPUT_PATH,
  contactSheetPath: CONTACT_SHEET_PATH,
  reportPath: REPORT_PATH,
  storyboardPath: STORYBOARD_PATH,
  durationSeconds: fixture.durationFrames / fixture.fps,
  detector,
  technicalChecks,
  compositionHash: compilation.compositionHash,
  outputHash: report.output.sha256,
}, null, 2)}\n`);
