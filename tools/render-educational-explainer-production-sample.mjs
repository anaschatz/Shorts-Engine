import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  contentHash,
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  compileProductionAnimation,
} = require(
  "../server/pipelines/narrated-short/animation/production-plan-compiler.cjs",
);
const {
  normalizeAnimationTimingContext,
} = require(
  "../server/pipelines/narrated-short/animation/timing-contract.cjs",
);
const {
  createHyperframesProvider,
} = require(
  "../server/pipelines/narrated-short/animation/providers/hyperframes.cjs",
);
const {
  runEducationalPerceptualQa,
} = require(
  "../server/pipelines/narrated-short/animation/perceptual-qa.cjs",
);
const {
  composeNarratedVisualMaster,
} = require("../server/pipelines/narrated-short/video-compositor.cjs");
const {
  analyzeRenderedVideo,
  runRenderedVideoQa,
} = require("../server/pipelines/narrated-short/qa/rendered-video-qa.cjs");

if (!process.argv.includes("--confirm-write")) {
  throw new Error("Pass --confirm-write to generate the production sample.");
}

const ROOT = resolve(import.meta.dirname, "..");
const FPS = 30;
const TARGET_FRAMES = 45 * FPS;
const FINAL_HOLD_FRAMES = 24;
const CONTEXT_PAUSE_FRAMES = 2;
const PAYOFF_PAUSE_FRAMES = 8;
const INSERTED_PAUSE_FRAMES = CONTEXT_PAUSE_FRAMES + PAYOFF_PAUSE_FRAMES;
const BASE_AUDIO_FRAMES = TARGET_FRAMES - FINAL_HOLD_FRAMES - INSERTED_PAUSE_FRAMES;
const FIXTURE_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json",
);
const ALIGNMENT_PATH = resolve(
  ROOT,
  "data/artifacts/content/prj_d0801ca2-53ce-43b3-8faa-cee2893dc01c/narration_alignment/039dc4368f9b84bf6be2293bd0974731e6135ab3865190927bb87010cd832aa8.json",
);
const NARRATION_MANIFEST_PATH = resolve(
  ROOT,
  "data/artifacts/content/prj_d0801ca2-53ce-43b3-8faa-cee2893dc01c/narration_manifest/94cf7d48eb5b4a935ddcd7f73212b3fe3f8d834ff77145bac6e7303c5734a483.json",
);
const SOURCE_AUDIO_PATH = resolve(
  ROOT,
  "data/audio/narration/prj_d0801ca2-53ce-43b3-8faa-cee2893dc01c/e9ad1ddeca26289753a0fcb75b117935c98dac03188129d3139580a13f1297c9.wav",
);
const OUTPUT_DIR = resolve(ROOT, "showcase/assets");
const EVIDENCE_DIR = resolve(
  ROOT,
  "showcase/evidence/educational-explainer-production-001",
);
const OUTPUT_PATH = resolve(
  OUTPUT_DIR,
  "educational-explainer-production-001.mp4",
);
const PREVIEW_PATH = resolve(
  OUTPUT_DIR,
  "educational-explainer-production-001-preview.gif",
);
const CONTACT_SHEET_PATH = resolve(
  OUTPUT_DIR,
  "educational-explainer-production-001-contact-sheet.png",
);
const AUDIO_PATH = resolve(EVIDENCE_DIR, "narration-45s.wav");
const SLOWED_AUDIO_PATH = resolve(EVIDENCE_DIR, ".narration-slowed.wav");
const TRANSCRIPT_PATH = resolve(EVIDENCE_DIR, "transcript.vtt");
const REPORT_PATH = resolve(EVIDENCE_DIR, "qa-report.json");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || "").slice(-1000)}`);
  }
  return result;
}

function scaledFrame(frame, sourceFrames) {
  return Math.round((frame / sourceFrames) * BASE_AUDIO_FRAMES);
}

function buildTimingContext(draft, alignmentEnvelope) {
  const alignment = alignmentEnvelope.body;
  const sourceFrames = alignment.durationFrames;
  const contextWordIndex = alignment.beats[1].wordStartIndex;
  const payoffWordIndex = alignment.beats.at(-1).wordStartIndex;
  const words = alignment.words.map((word, index) => {
    const pauseOffset = index >= payoffWordIndex
      ? INSERTED_PAUSE_FRAMES
      : index >= contextWordIndex
        ? CONTEXT_PAUSE_FRAMES
        : 0;
    const startFrame = scaledFrame(word.startFrame, sourceFrames) + pauseOffset;
    const endFrame = Math.max(
      startFrame + 1,
      scaledFrame(word.endFrame, sourceFrames) + pauseOffset,
    );
    return { index, text: word.text, startFrame, endFrame };
  });
  const beats = alignment.beats.map((beat) => ({
    beatId: beat.beatId,
    wordStartIndex: beat.wordStartIndex,
    wordEndIndex: beat.wordEndIndex,
    startFrame: words[beat.wordStartIndex].startFrame,
    endFrame: words[beat.wordEndIndex - 1].endFrame,
  }));
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: FPS,
    durationFrames: TARGET_FRAMES,
    alignmentHash: contentHash({
      sourceAlignmentHash: alignmentEnvelope.contentHash,
      transformation: "uniform_atempo_with_readability_pauses_v1",
      sourceFrames,
      baseAudioFrames: BASE_AUDIO_FRAMES,
      insertedPauseFrames: INSERTED_PAUSE_FRAMES,
      finalHoldFrames: FINAL_HOLD_FRAMES,
      targetFrames: TARGET_FRAMES,
    }),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function timestamp(frame) {
  const milliseconds = Math.round((frame / FPS) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`,
  ].join(":");
}

function writeTranscript(draft, timingContext) {
  const lines = ["WEBVTT", ""];
  for (const [index, beat] of timingContext.beats.entries()) {
    const scriptBeat = draft.script.beats.find((entry) => entry.id === beat.beatId);
    const nextStart = timingContext.beats[index + 1]?.startFrame;
    lines.push(`${timestamp(beat.startFrame)} --> ${timestamp(nextStart || beat.endFrame)}`);
    lines.push(scriptBeat.spokenText);
    lines.push("");
  }
  writeFileSync(TRANSCRIPT_PATH, `${lines.join("\n").trimEnd()}\n`, "utf8");
}

function persistJson(name, value) {
  writeFileSync(
    resolve(EVIDENCE_DIR, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

for (const path of [
  FIXTURE_PATH,
  ALIGNMENT_PATH,
  NARRATION_MANIFEST_PATH,
  SOURCE_AUDIO_PATH,
]) {
  if (!existsSync(path)) throw new Error(`Required managed source is missing: ${path}`);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });

const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
const alignmentEnvelope = JSON.parse(readFileSync(ALIGNMENT_PATH, "utf8"));
const narrationManifest = JSON.parse(readFileSync(NARRATION_MANIFEST_PATH, "utf8"));
if (
  alignmentEnvelope.body.draftHash !== draft.contentHash
  || narrationManifest.body.draftHash !== draft.contentHash
  || narrationManifest.body.rights.commercialUseAllowed !== true
  || narrationManifest.body.ttsProvenance.publishable !== true
) {
  throw new Error("Managed narration bindings or rights are invalid.");
}

const timingContext = buildTimingContext(draft, alignmentEnvelope);
const compiled = compileProductionAnimation({
  draft,
  timingContext,
  projectId: "prj_educational_explainer_production_001",
  projectRevision: 1,
  renderProfile: "final",
  animationProfile: "educational-explainer-v1",
});
const perceptualQa = runEducationalPerceptualQa(compiled);
if (perceptualQa.status !== "passed") {
  throw new Error("Educational perceptual QA did not pass.");
}

const atempo = alignmentEnvelope.body.durationFrames / BASE_AUDIO_FRAMES;
run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  SOURCE_AUDIO_PATH,
  "-af",
  `atempo=${atempo.toFixed(9)}`,
  "-ar",
  "48000",
  "-ac",
  "1",
  "-c:a",
  "pcm_s16le",
  SLOWED_AUDIO_PATH,
], "narration transform");

const contextStartSeconds = scaledFrame(
  alignmentEnvelope.body.beats[1].startFrame,
  alignmentEnvelope.body.durationFrames,
) / FPS;
const payoffStartSeconds = scaledFrame(
  alignmentEnvelope.body.beats.at(-1).startFrame,
  alignmentEnvelope.body.durationFrames,
) / FPS;
try {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    SLOWED_AUDIO_PATH,
    "-f",
    "lavfi",
    "-t",
    (CONTEXT_PAUSE_FRAMES / FPS).toFixed(6),
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-f",
    "lavfi",
    "-t",
    (PAYOFF_PAUSE_FRAMES / FPS).toFixed(6),
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-filter_complex",
    [
      `[0:a]atrim=0:${contextStartSeconds.toFixed(6)},asetpts=PTS-STARTPTS[a0]`,
      `[0:a]atrim=${contextStartSeconds.toFixed(6)}:${payoffStartSeconds.toFixed(6)},asetpts=PTS-STARTPTS[a1]`,
      `[0:a]atrim=${payoffStartSeconds.toFixed(6)},asetpts=PTS-STARTPTS[a2]`,
      "[a0][1:a][a1][2:a][a2]concat=n=5:v=0:a=1,apad=pad_dur=1.5[out]",
    ].join(";"),
    "-map",
    "[out]",
    "-t",
    (TARGET_FRAMES / FPS).toFixed(6),
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    AUDIO_PATH,
  ], "narration pause graph");
} finally {
  rmSync(SLOWED_AUDIO_PATH, { force: true });
}

writeTranscript(draft, timingContext);
persistJson("timing-context.json", timingContext);
persistJson("reference-style-spec.json", compiled.referenceStyleSpec);
persistJson("narrative-beat-graph.json", compiled.narrativeBeatGraph);
persistJson("director-plan.json", compiled.directorPlan);
persistJson("animation-ir.json", compiled.animationIR);
persistJson("audio-ir.json", compiled.audioIR);
persistJson("asset-manifest-v2.json", compiled.assetManifest);
copyFileSync(NARRATION_MANIFEST_PATH, resolve(EVIDENCE_DIR, "source-narration-manifest.json"));

const provider = createHyperframesProvider({ providerId: "hyperframes_local" });
const readiness = await provider.doctor();
if (!readiness.ready) throw new Error("HyperFrames is not ready.");
const validated = provider.validate(compiled.animationIR, {
  semanticSourceContext: { draft, timingContext },
});
const render = await provider.render({
  validated,
  stagingDir: OUTPUT_DIR,
  outputName: "visual-master.mp4",
  quality: "high",
  timeoutMs: 1_800_000,
}, null, (progress) => {
  process.stdout.write(`${JSON.stringify({ type: "render_progress", ...progress })}\n`);
});

const timeline = {
  contentHash: contentHash({
    animationIRHash: compiled.animationIR.contentHash,
    audioIRHash: compiled.audioIR.contentHash,
    timingContextHash: timingContext.contentHash,
  }),
  fps: compiled.animationIR.fps,
  width: compiled.animationIR.width,
  height: compiled.animationIR.height,
  totalFrames: compiled.animationIR.durationFrames,
};

let composition;
try {
  composition = await composeNarratedVisualMaster({
    timeline,
    visualMasterPath: render.outputPath,
    outputPath: OUTPUT_PATH,
    audioPath: AUDIO_PATH,
    audioIR: compiled.audioIR,
    renderProfile: "final",
    timeoutMs: 600_000,
  });
} finally {
  rmSync(render.stagingDir, { recursive: true, force: true });
}

const analysis = await analyzeRenderedVideo({
  outputPath: OUTPUT_PATH,
  timeline,
  renderProfile: "final",
});
const technicalGates = runRenderedVideoQa({
  analysis,
  timeline,
  renderProfile: "final",
});
const technicalGatePassed = technicalGates.every((gate) => gate.passed);
if (!technicalGatePassed) {
  throw new Error(`Rendered-video QA failed: ${JSON.stringify(technicalGates.filter((gate) => !gate.passed))}`);
}

run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  OUTPUT_PATH,
  "-t",
  "15",
  "-vf",
  "fps=6,scale=270:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80[p];[s1][p]paletteuse=dither=bayer",
  "-loop",
  "0",
  PREVIEW_PATH,
], "animated preview");

run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  OUTPUT_PATH,
  "-vf",
  "fps=1/9,scale=270:480:flags=lanczos,tile=5x1",
  "-frames:v",
  "1",
  CONTACT_SHEET_PATH,
], "contact sheet");

const report = {
  schemaVersion: 1,
  sampleId: "educational_explainer_production_001",
  status: "technical_gate_passed_human_review_pending",
  publishable: false,
  publishBlockers: ["HUMAN_CREATIVE_REVIEW_REQUIRED"],
  output: {
    path: "showcase/assets/educational-explainer-production-001.mp4",
    sha256: sha256File(OUTPUT_PATH),
    bytes: statSync(OUTPUT_PATH).size,
    width: analysis.width,
    height: analysis.height,
    fps: analysis.fps,
    durationSeconds: analysis.durationSeconds,
    videoCodec: analysis.videoCodec,
    audioCodec: analysis.audioCodec,
  },
  sourceNarration: {
    provider: narrationManifest.body.ttsProvenance.provider,
    model: narrationManifest.body.ttsProvenance.model,
    voiceId: narrationManifest.body.ttsProvenance.voiceId,
    sourceAudioHash: narrationManifest.body.audioHash,
    sourceAlignmentHash: alignmentEnvelope.contentHash,
    commercialUseAllowed: narrationManifest.body.rights.commercialUseAllowed,
    licenseReference: narrationManifest.body.rights.licenseReference,
      transformation: {
      type: "uniform_atempo_with_readability_pauses_v1",
      atempo: Number(atempo.toFixed(9)),
      baseAudioFrames: BASE_AUDIO_FRAMES,
      insertedPauseFrames: INSERTED_PAUSE_FRAMES,
      finalHoldFrames: FINAL_HOLD_FRAMES,
      targetFrames: TARGET_FRAMES,
    },
  },
  bindings: {
    draftHash: draft.contentHash,
    timingContextHash: timingContext.contentHash,
    referenceStyleSpecHash: compiled.referenceStyleSpec.contentHash,
    narrativeBeatGraphHash: compiled.narrativeBeatGraph.contentHash,
    directorPlanHash: compiled.directorPlan.contentHash,
    animationIRHash: compiled.animationIR.contentHash,
    audioIRHash: compiled.audioIR.contentHash,
    assetManifestV2Hash: compiled.assetManifest.contentHash,
    visualMasterHash: render.outputSha256,
    compositionHash: render.compositionHash,
  },
  qa: {
    perceptual: perceptualQa,
    technicalAnalysis: analysis,
    technicalGates,
    technicalGatePassed,
    captions: {
      mode: "integrated_semantic_typography",
      burnedTranscript: false,
      sidecarPath: "showcase/evidence/educational-explainer-production-001/transcript.vtt",
    },
    humanReview: {
      status: "pending",
      requiredDimensions: ["clarity", "hierarchy", "pacing", "polish", "originality"],
      minimumScore: 4,
    },
  },
  compositor: {
    ...composition,
    outputPath: "showcase/assets/educational-explainer-production-001.mp4",
  },
};
persistJson("qa-report.json", report);

process.stdout.write(`${JSON.stringify({
  status: report.status,
  output: OUTPUT_PATH,
  preview: PREVIEW_PATH,
  contactSheet: CONTACT_SHEET_PATH,
  report: REPORT_PATH,
  sha256: report.output.sha256,
  durationSeconds: report.output.durationSeconds,
  technicalGatePassed,
}, null, 2)}\n`);
