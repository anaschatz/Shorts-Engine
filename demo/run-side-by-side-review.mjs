import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "./report-safety.mjs";

const require = createRequire(import.meta.url);
const { commandAvailable } = require("../server/media.cjs");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_GENERATED = "manual-downloads/shortsengine-gxiRyFZXJV8-result.mp4";
const DEFAULT_REFERENCE = "manual-downloads/shortsengine-youtube-short.mp4";
const DEFAULT_RESULTS_DIR = "demo/results";
const REVIEW_SCHEMA_VERSION = 1;

function normalizeRelative(value) {
  return String(value || "").split(sep).join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function safeRelativeRef(rootDir, candidate) {
  const resolvedRoot = resolve(rootDir);
  const resolved = resolve(resolvedRoot, candidate);
  if (!isInside(resolvedRoot, resolved)) {
    return {
      ok: false,
      code: "SIDE_BY_SIDE_UNSAFE_RELATIVE_REF",
      message: "The review input must stay inside the workspace.",
    };
  }
  const relativePath = normalizeRelative(relative(resolvedRoot, resolved));
  if (!relativePath || relativePath.startsWith("../") || relativePath.includes("\0")) {
    return {
      ok: false,
      code: "SIDE_BY_SIDE_UNSAFE_RELATIVE_REF",
      message: "The review input must use a safe relative reference.",
    };
  }
  return { ok: true, resolvedFile: resolved, relativePath };
}

function parseFrameRate(value) {
  const text = String(value || "");
  if (!text || text === "0/0") return null;
  const [num, den] = text.split("/").map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
    return Number((num / den).toFixed(3));
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : null;
}

function aspectLabel(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return "unknown";
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) <= 0.04) return "9:16";
  if (Math.abs(ratio - 16 / 9) <= 0.06) return "16:9";
  if (Math.abs(ratio - 1) <= 0.05) return "1:1";
  return `${width}:${height}`;
}

function orientation(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "unknown";
  if (Math.abs(width - height) <= Math.max(width, height) * 0.05) return "square";
  return width < height ? "vertical" : "horizontal";
}

function publicVideoMetadata(role, input, probeResult) {
  return {
    role,
    relativePath: input.relativePath,
    exists: probeResult.exists,
    readable: probeResult.readable,
    sizeBytes: probeResult.sizeBytes,
    durationSeconds: probeResult.durationSeconds,
    width: probeResult.width,
    height: probeResult.height,
    fps: probeResult.fps,
    aspectRatio: probeResult.aspectRatio,
    aspectLabel: probeResult.aspectLabel,
    orientation: probeResult.orientation,
    videoCodec: probeResult.videoCodec,
    audioPresent: probeResult.audioPresent,
    errorCode: probeResult.errorCode,
  };
}

function probeVideo(input, options = {}) {
  const ffprobeBin = options.ffprobeBin || "ffprobe";
  if (!input.ok) {
    return { exists: false, readable: false, errorCode: input.code };
  }
  if (extname(input.resolvedFile).toLowerCase() !== ".mp4") {
    return { exists: false, readable: false, errorCode: "SIDE_BY_SIDE_UNSUPPORTED_EXTENSION" };
  }
  if (!existsSync(input.resolvedFile)) {
    return { exists: false, readable: false, errorCode: "SIDE_BY_SIDE_INPUT_MISSING" };
  }
  if (!commandAvailable(ffprobeBin)) {
    const stats = statSync(input.resolvedFile);
    return {
      exists: true,
      readable: false,
      sizeBytes: stats.size,
      errorCode: "FFPROBE_UNAVAILABLE",
    };
  }

  const result = spawnSync(
    ffprobeBin,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      input.resolvedFile,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  if (result.status !== 0) {
    return { exists: true, readable: false, errorCode: "FFPROBE_FAILED" };
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video") || {};
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const width = Number(video.width);
    const height = Number(video.height);
    const duration = Number(parsed.format?.duration);
    const size = Number(parsed.format?.size);
    const ratio = Number.isFinite(width) && Number.isFinite(height) && height > 0
      ? Number((width / height).toFixed(4))
      : null;
    return {
      exists: true,
      readable: true,
      sizeBytes: Number.isFinite(size) ? size : statSync(input.resolvedFile).size,
      durationSeconds: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
      aspectRatio: ratio,
      aspectLabel: aspectLabel(width, height),
      orientation: orientation(width, height),
      videoCodec: video.codec_name || "unknown",
      audioPresent: Boolean(audio),
      errorCode: null,
    };
  } catch {
    return { exists: true, readable: false, errorCode: "FFPROBE_JSON_INVALID" };
  }
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scoreAspectFit(generated, reference) {
  if (!generated.readable || !generated.aspectRatio) return 0;
  const targetRatio = reference?.readable && reference.orientation === "vertical" && reference.aspectRatio
    ? reference.aspectRatio
    : 9 / 16;
  const delta = Math.abs(generated.aspectRatio - targetRatio);
  if (delta <= 0.035) return 1;
  if (delta <= 0.08) return 0.8;
  if (generated.orientation === "vertical") return 0.55;
  return 0.2;
}

function scoreDurationFit(generated, reference) {
  if (!generated.readable || !Number.isFinite(generated.durationSeconds)) return 0;
  if (reference?.readable && Number.isFinite(reference.durationSeconds) && reference.durationSeconds > 0) {
    const delta = Math.abs(generated.durationSeconds - reference.durationSeconds) / reference.durationSeconds;
    if (delta <= 0.15) return 1;
    if (delta <= 0.35) return 0.8;
    if (delta <= 0.6) return 0.55;
    return 0.3;
  }
  return generated.durationSeconds >= 8 && generated.durationSeconds <= 35 ? 0.85 : 0.45;
}

function scoreResolutionFit(generated) {
  if (!generated.readable || !generated.width || !generated.height) return 0;
  if (generated.orientation === "vertical" && generated.width >= 720 && generated.height >= 1280) return 1;
  if (generated.orientation === "vertical" && generated.width >= 540 && generated.height >= 960) return 0.75;
  if (generated.orientation === "horizontal") return 0.25;
  return 0.5;
}

function buildMetrics(generated, reference, contactSheets) {
  const aspectRatioFit = scoreAspectFit(generated, reference);
  const durationFit = scoreDurationFit(generated, reference);
  const resolutionFit = scoreResolutionFit(generated);
  const fileReadable = generated.readable && reference.readable ? 1 : 0;
  const contactSheetAvailable = contactSheets.some((sheet) => sheet.generated) ? 1 : 0;
  const machineScore = Math.round(
    100 *
      clampScore(
        aspectRatioFit * 0.35 +
          durationFit * 0.2 +
          resolutionFit * 0.2 +
          fileReadable * 0.15 +
          contactSheetAvailable * 0.1
      )
  );
  return {
    machineScore,
    aspectRatioFit,
    durationFit,
    resolutionFit,
    fileReadable,
    contactSheetAvailable,
    humanReviewRequired: true,
  };
}

function checklistFromMetrics(metrics) {
  return [
    {
      id: "aspect_ratio",
      label: "Generated result uses short-form vertical framing",
      status: metrics.aspectRatioFit >= 0.8 ? "passed" : "needs_review",
      evidence: "Machine scored from probed width/height metadata.",
    },
    {
      id: "duration_pacing",
      label: "Generated result has comparable short-form pacing",
      status: metrics.durationFit >= 0.8 ? "passed" : "needs_review",
      evidence: "Machine scored from generated/reference duration delta.",
    },
    {
      id: "moment_selection",
      label: "Moment selection matches the most engaging football action",
      status: "needs_human_review",
      evidence: "Requires visual/audio review of chance, save, foul, counter, replay or crowd reaction context.",
    },
    {
      id: "caption_action_alignment",
      label: "On-screen text matches what is happening in the clip",
      status: "needs_human_review",
      evidence: "Requires comparing captions against visible action and commentary context.",
    },
    {
      id: "ball_player_framing",
      label: "Crop keeps the ball, players and key action visible",
      status: "needs_human_review",
      evidence: "Requires reviewing contact sheets and playback; this runner does not infer ball location.",
    },
    {
      id: "trend_editing_style",
      label: "Editing rhythm, captions and animations feel close to the reference style",
      status: "needs_human_review",
      evidence: "Requires playback review; metadata alone cannot validate style quality.",
    },
    {
      id: "false_goal_guard",
      label: "The result does not claim goal without explicit evidence",
      status: "needs_human_review",
      evidence: "Requires caption/text review against the actual moment.",
    },
  ];
}

function createContactSheet(input, role, rootDir, options = {}) {
  const ffmpegBin = options.ffmpegBin || "ffmpeg";
  const outputRelative = normalizeRelative(
    join(DEFAULT_RESULTS_DIR, "side-by-side-artifacts", `${role}-contact-sheet.jpg`)
  );
  const output = safeRelativeRef(rootDir, outputRelative);
  if (!input.ok || !existsSync(input.resolvedFile)) {
    return { role, generated: false, reason: "input-missing" };
  }
  if (!output.ok) {
    return { role, generated: false, reason: "unsafe-output-ref" };
  }
  if (!commandAvailable(ffmpegBin)) {
    return { role, generated: false, reason: "ffmpeg-unavailable" };
  }
  mkdirSync(dirname(output.resolvedFile), { recursive: true });
  const result = spawnSync(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input.resolvedFile,
      "-vf",
      "fps=1/2,scale=270:-1:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:black,tile=3x2",
      "-frames:v",
      "1",
      output.resolvedFile,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  if (result.status !== 0 || !existsSync(output.resolvedFile)) {
    return { role, generated: false, reason: "ffmpeg-contact-sheet-failed" };
  }
  return { role, generated: true, relativePath: output.relativePath };
}

function failureCasesFromInputs(generatedInput, referenceInput, generatedProbe, referenceProbe, leak) {
  const failures = [];
  if (!generatedInput.ok) failures.push({ code: generatedInput.code, role: "generated", message: generatedInput.message });
  if (!referenceInput.ok) failures.push({ code: referenceInput.code, role: "reference", message: referenceInput.message });
  if (!generatedProbe.readable) {
    failures.push({
      code: generatedProbe.errorCode || "SIDE_BY_SIDE_GENERATED_UNREADABLE",
      role: "generated",
      message: "Generated result could not be read safely.",
    });
  }
  if (!referenceProbe.readable) {
    failures.push({
      code: referenceProbe.errorCode || "SIDE_BY_SIDE_REFERENCE_UNREADABLE",
      role: "reference",
      message: "Reference video could not be read safely.",
    });
  }
  if (leak) {
    failures.push({
      code: "REPORT_LEAK_GUARD",
      message: "The side-by-side report contained unsafe data and was marked failed.",
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
  return failures;
}

function buildSideBySideReview(options = {}) {
  const rootDir = resolve(options.rootDir || DEFAULT_ROOT_DIR);
  const generatedInput = safeRelativeRef(rootDir, options.generated || DEFAULT_GENERATED);
  const referenceInput = safeRelativeRef(rootDir, options.reference || DEFAULT_REFERENCE);
  const timestamp = options.now || new Date().toISOString();
  const command = "npm run demo:compare";
  const generatedProbe = options.probeVideo
    ? options.probeVideo(generatedInput, { role: "generated" })
    : probeVideo(generatedInput, options);
  const referenceProbe = options.probeVideo
    ? options.probeVideo(referenceInput, { role: "reference" })
    : probeVideo(referenceInput, options);
  const contactSheets = options.createContactSheets === false
    ? []
    : [
        createContactSheet(generatedInput, "generated", rootDir, options),
        createContactSheet(referenceInput, "reference", rootDir, options),
      ];
  const generated = publicVideoMetadata("generated", generatedInput, generatedProbe);
  const reference = publicVideoMetadata("reference", referenceInput, referenceProbe);
  const metrics = buildMetrics(generated, reference, contactSheets);
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: timestamp,
    command,
    phase: "side_by_side_review",
    status: "passed",
    passed: true,
    skipped: false,
    comparison: {
      generated,
      reference,
    },
    metrics,
    checklist: checklistFromMetrics(metrics),
    artifacts: {
      contactSheets,
      logsDownloaded: false,
      rawArtifactsRequired: false,
    },
    failedCases: [],
    limitations: [
      "This runner scores structural video metadata and creates review artifacts; it does not replace human visual judgement.",
      "Moment quality, caption/action fit, ball tracking and animation taste stay marked for human review.",
      "No raw logs, absolute paths, provider output or external artifacts are included in reports.",
    ],
    nextAction: "Review both contact sheets and playback, then score the checklist items that require human judgement.",
  };
  const leak = findSensitiveLeak(report);
  const failedCases = failureCasesFromInputs(generatedInput, referenceInput, generatedProbe, referenceProbe, leak);
  if (failedCases.length > 0) {
    report.status = "failed";
    report.passed = false;
    report.failedCases = failedCases;
    report.nextAction = "Fix the failed input/report issue, then rerun npm run demo:compare.";
  }
  return report;
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function writeSideBySideReviewReport(report, resultsDir = DEFAULT_RESULTS_DIR, rootDir = DEFAULT_ROOT_DIR) {
  const outputDir = safeRelativeRef(rootDir, resultsDir);
  if (!outputDir.ok) {
    throw new Error("SIDE_BY_SIDE_RESULTS_DIR_UNSAFE");
  }
  mkdirSync(outputDir.resolvedFile, { recursive: true });
  const latest = safeRelativeRef(rootDir, join(resultsDir, "side-by-side-latest.json"));
  const timestamped = safeRelativeRef(rootDir, join(resultsDir, `side-by-side-${safeTimestamp(report.generatedAt)}.json`));
  if (!latest.ok || !timestamped.ok) {
    throw new Error("SIDE_BY_SIDE_REPORT_REF_UNSAFE");
  }
  const leak = findSensitiveLeak(report);
  if (leak) {
    const failedReport = {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      generatedAt: report.generatedAt || new Date().toISOString(),
      command: report.command || "npm run demo:compare",
      phase: "side_by_side_review",
      status: "failed",
      passed: false,
      skipped: false,
      failedCases: [
        {
          code: "REPORT_LEAK_GUARD",
          message: "The side-by-side report contained unsafe data and was not written.",
          leakCode: leak.code,
          leakPath: leak.path,
        },
      ],
    };
    writeFileSync(latest.resolvedFile, `${JSON.stringify(failedReport, null, 2)}\n`);
    writeFileSync(timestamped.resolvedFile, `${JSON.stringify(failedReport, null, 2)}\n`);
    return { latestPath: latest.relativePath, reportPath: timestamped.relativePath, report: failedReport };
  }
  writeFileSync(latest.resolvedFile, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(timestamped.resolvedFile, `${JSON.stringify(report, null, 2)}\n`);
  return { latestPath: latest.relativePath, reportPath: timestamped.relativePath, report };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--generated=")) options.generated = arg.slice("--generated=".length);
    else if (arg.startsWith("--reference=")) options.reference = arg.slice("--reference=".length);
    else if (arg.startsWith("--results=")) options.resultsDir = arg.slice("--results=".length);
    else if (arg === "--no-contact-sheet") options.createContactSheets = false;
  }
  return options;
}

function runCli() {
  const options = parseArgs();
  const rootDir = DEFAULT_ROOT_DIR;
  const report = buildSideBySideReview({ ...options, rootDir });
  const written = writeSideBySideReviewReport(report, options.resultsDir || DEFAULT_RESULTS_DIR, rootDir);
  const summary = {
    status: written.report.status,
    passed: written.report.passed,
    machineScore: written.report.metrics?.machineScore ?? null,
    latestPath: written.latestPath,
    reportPath: written.reportPath,
    failedCases: written.report.failedCases,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return written.report.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}

export {
  DEFAULT_GENERATED,
  DEFAULT_REFERENCE,
  REVIEW_SCHEMA_VERSION,
  buildMetrics,
  buildSideBySideReview,
  parseArgs,
  probeVideo,
  safeRelativeRef,
  writeSideBySideReviewReport,
};
