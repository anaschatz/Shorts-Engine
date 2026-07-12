#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_PATH = resolve(ROOT_DIR, "eval/research-sources/ert-world-cup-highlights-20.json");
const RESULTS_DIR = resolve(ROOT_DIR, "eval/results");
const LATEST_PATH = resolve(RESULTS_DIR, "ert-20-live-benchmark-latest.json");
const LIVE_REPORT_PATH = resolve(ROOT_DIR, "demo/results/youtube-live-e2e-latest.json");
const MANUAL_DIR = resolve(ROOT_DIR, "manual-downloads");
const SOURCE_CACHE_DIR = resolve(tmpdir(), "shortsengine-ert-hq-source-cache");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "/opt/homebrew/bin/ffprobe";
const YOUTUBE_DOWNLOADER_BIN = process.env.SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN || "/opt/homebrew/bin/yt-dlp";
const HQ_FORMAT_SELECTOR = "bv*[height>=720][height<=1080][ext=mp4]+ba[ext=m4a]/b[height>=720][ext=mp4]";
const MIN_SOURCE_HEIGHT = 720;
const DEFAULT_PORT = 63400;
const INTER_JOB_COOLDOWN_MS = 5000;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(argv = process.argv.slice(2)) {
  const valueFor = (name) => {
    const item = argv.find((arg) => arg.startsWith(`${name}=`));
    return item ? item.slice(name.length + 1) : null;
  };
  const start = Math.max(1, Number(valueFor("--start") || 1));
  const limitValue = valueFor("--limit");
  const limit = limitValue == null ? null : Math.max(1, Number(limitValue));
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    scoreboardOcr: !argv.includes("--no-ocr"),
    start: Number.isFinite(start) ? Math.floor(start) : 1,
    limit: Number.isFinite(limit) ? Math.floor(limit) : null,
  };
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function safeRelative(filePath) {
  const value = relative(ROOT_DIR, resolve(filePath)).replace(/\\/g, "/");
  if (!value || value.startsWith("../") || value === "..") throw new Error("Unsafe benchmark artifact path.");
  return value;
}

function validateDataset(dataset) {
  if (
    !dataset ||
    dataset.rights?.status !== "confirmed_by_operator" ||
    dataset.rights?.benchmarkEligible !== true ||
    !Array.isArray(dataset.videos) ||
    dataset.videos.length !== 20
  ) {
    throw new Error("The FIFA benchmark dataset is not rights-confirmed and complete.");
  }
  for (const [index, video] of dataset.videos.entries()) {
    if (
      video.index !== index + 1 ||
      !/^[A-Za-z0-9_-]{11}$/.test(String(video.videoId || "")) ||
      video.rightsConfirmed !== true ||
      !Number.isInteger(video.expectedCountedGoals) ||
      video.expectedCountedGoals < 0 ||
      video.expectedCountedGoals > 20 ||
      !String(video.url || "").includes(video.videoId)
    ) {
      throw new Error(`Invalid dataset video at index ${index + 1}.`);
    }
  }
  return dataset;
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32 * 1024);
    });
    child.on("error", (error) => resolveCommand({ exitCode: 1, errorCode: error.code || "SPAWN_FAILED", stdout, stderr }));
    child.on("close", (exitCode) => resolveCommand({ exitCode: exitCode ?? 1, errorCode: null, stdout, stderr }));
  });
}

function benchmarkEnvironment(video, options = {}) {
  const scoreboardOcr = options.scoreboardOcr === true ? "1" : "0";
  return {
    ...process.env,
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN: YOUTUBE_DOWNLOADER_BIN,
    SHORTSENGINE_YOUTUBE_LIVE_E2E: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS: "900000",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT_MS: "120000",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT: String(process.env.SHORTSENGINE_FIFA20_PORT || DEFAULT_PORT),
    SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS: "600000",
    SHORTSENGINE_YOUTUBE_SMOKE_STALL_TIMEOUT_MS: "300000",
    SHORTSENGINE_YOUTUBE_SMOKE_GOAL_SELECTION_MODE: "valid_goals_only",
    SHORTSENGINE_YOUTUBE_SMOKE_COMPOSITION_MODE: "multi_moment",
    SHORTSENGINE_YOUTUBE_SMOKE_EDIT_INTENSITY: "punchy",
    SHORTSENGINE_YOUTUBE_SMOKE_STYLE_PRESET: "reference_football_multi_goal_v1",
    SHORTSENGINE_YOUTUBE_SMOKE_TITLE: String(video.title || "FIFA Match Highlight").replace(/^Highlights\s*\|\s*/i, "").slice(0, 120),
    SHORTSENGINE_RENDER_PROFILE: "quality",
    SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR: scoreboardOcr,
    SHORTSENGINE_SCOREBOARD_OCR_ENABLED: scoreboardOcr,
    SHORTSENGINE_SCOREBOARD_OCR_CHUNK_SECONDS: "90",
    SHORTSENGINE_SCOREBOARD_OCR_FRAMES_PER_CHUNK: "4",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: String(video.expectedCountedGoals),
    SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_FINAL_SCORE: String(video.finalScore),
    SHORTSENGINE_SOURCE_CACHE_ENABLED: "1",
    SHORTSENGINE_SOURCE_CACHE_DIR: SOURCE_CACHE_DIR,
    SHORTSENGINE_SOURCE_CACHE_MAX_BYTES: String(20 * 1024 * 1024 * 1024),
    SHORTSENGINE_YOUTUBE_FORMAT_SELECTOR: HQ_FORMAT_SELECTOR,
    SHORTSENGINE_RENDER_CAPTIONS_ENABLED: "0",
    SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED: "0",
    SHORTSENGINE_VIDEO_ENHANCEMENT_REQUIRED: "0",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_PRESERVE_DATA: "1",
    MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: video.url,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS: video.videoId,
  };
}

function stableArtifactPaths(video) {
  const stem = `ert20-${String(video.index).padStart(2, "0")}-${video.videoId}`;
  return {
    video: resolve(MANUAL_DIR, `${stem}.mp4`),
    contactSheet: resolve(MANUAL_DIR, `${stem}-contact.jpg`),
  };
}

function sourceCachePath(video) {
  return resolve(SOURCE_CACHE_DIR, `${video.videoId}.mp4`);
}

async function probeSourceQuality(filePath) {
  if (!existsSync(filePath)) return null;
  const result = await spawnCommand(FFPROBE_BIN, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "json",
    filePath,
  ]);
  if (result.exitCode !== 0) return null;
  const parsed = (() => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  })();
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const width = Number(stream?.width || 0);
  const height = Number(stream?.height || 0);
  return width > 0 && height > 0 ? { width, height, codec: stream.codec_name || null } : null;
}

async function ensureHighQualitySource(video) {
  mkdirSync(SOURCE_CACHE_DIR, { recursive: true });
  const cachePath = sourceCachePath(video);
  const cached = await probeSourceQuality(cachePath);
  if (cached && cached.height >= MIN_SOURCE_HEIGHT) return { ...cached, cacheHit: true };
  if (existsSync(cachePath)) {
    throw new Error(`Cached source for ${video.videoId} is below ${MIN_SOURCE_HEIGHT}p; remove it before retrying.`);
  }
  const download = await spawnCommand(YOUTUBE_DOWNLOADER_BIN, [
    "--no-playlist",
    "--no-warnings",
    "--continue",
    "--merge-output-format", "mp4",
    "--format", HQ_FORMAT_SELECTOR,
    "--output", cachePath,
    video.url,
  ]);
  if (download.exitCode !== 0) throw new Error(`High-quality source download failed for ${video.videoId}.`);
  const downloaded = await probeSourceQuality(cachePath);
  if (!downloaded || downloaded.height < MIN_SOURCE_HEIGHT) {
    throw new Error(`Source quality gate rejected ${video.videoId}: ${downloaded?.height || 0}p.`);
  }
  return { ...downloaded, cacheHit: false };
}

async function createContactSheet(videoPath, contactPath) {
  const result = await spawnCommand(FFMPEG_BIN, [
    "-v", "error",
    "-y",
    "-i", videoPath,
    "-vf", "fps=1/2,scale=170:-2,tile=6x5:padding=6:margin=6:color=white",
    "-frames:v", "1",
    "-update", "1",
    contactPath,
  ]);
  if (result.exitCode !== 0 || !existsSync(contactPath)) throw new Error("Contact sheet generation failed.");
}

function outputMetrics(report) {
  const proof = report?.outputProof || {};
  const social = proof.renderedSocialPolishQA || {};
  const captions = social.dynamicCaptions || {};
  const countedGoalsIncluded = Number(proof.countedGoalsIncluded ?? 0);
  const humanVisibleGoalsIncluded = Number(proof.humanVisibleGoalsIncluded ?? 0);
  const expectedCountedGoals = Number(proof.expectedCountedGoals ?? 0);
  return {
    durationSeconds: Number(report?.generatedArtifact?.durationSeconds || proof.ffprobe?.durationSeconds || 0) || null,
    width: Number(report?.generatedArtifact?.width || proof.ffprobe?.width || 0) || null,
    height: Number(report?.generatedArtifact?.height || proof.ffprobe?.height || 0) || null,
    sizeBytes: Number(report?.generatedArtifact?.sizeBytes || 0) || null,
    highlightType: report?.smoke?.renderPlan?.highlightType || null,
    socialPolishScore: Number(social.socialPolishScore ?? 0),
    visualPolishScore: Number(proof.renderPolishQA?.visualPolishScore ?? proof.visualPolishScore ?? 0),
    openingHookCaptionRendered: captions.openingHookCaptionRendered === true,
    maxCaptionBeatDuration: Number(captions.maxCaptionBeatDuration ?? 0) || null,
    dynamicWordCaptionCount: Number(captions.dynamicWordCaptionCount ?? 0),
    visualFrameQaPassed: proof.visualFrameQA?.passed === true,
    actionFramingPassed: proof.actionFramingVerdict?.passed === true,
    trackingFallbackUsed: proof.actionFramingVerdict?.fallbackUsed === true,
    countedGoalsFound: Number(proof.countedGoalsFound ?? 0),
    countedGoalsIncluded,
    humanVisibleGoalsIncluded,
    expectedCountedGoals,
    allExpectedCountedGoalsIncluded: proof.allExpectedCountedGoalsIncluded === true || (
      countedGoalsIncluded === expectedCountedGoals &&
      humanVisibleGoalsIncluded === expectedCountedGoals
    ),
    cleanActionLayout: report?.smoke?.renderPlan?.actionLayoutMode !== "blurred_duplicate_background",
    renderFailureRateSample: report?.status === "passed" ? 0 : 1,
    estimatedLocalProviderCostUsd: 0,
  };
}

function compactFailure(report, commandResult) {
  const failure = Array.isArray(report?.failedCases) ? report.failedCases[0] : null;
  const diagnostic = `${commandResult.stderr || ""}\n${commandResult.stdout || ""}`
    .replaceAll(ROOT_DIR, "<workspace>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-2000) || null;
  return {
    code: failure?.code || commandResult.errorCode || `EXIT_${commandResult.exitCode}`,
    phase: failure?.phase || null,
    nextAction: failure?.nextAction || null,
    failedReasons: Array.isArray(failure?.failedReasons) ? failure.failedReasons.slice(0, 12) : [],
    diagnostic,
  };
}

function stateSummary(results, total) {
  const completed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return {
    total,
    attempted: results.length,
    completed,
    failed,
    pending: Math.max(0, total - completed),
    renderFailureRate: results.length ? Number((failed / results.length).toFixed(4)) : null,
    zeroEditPassRate: null,
    averageHumanScore: null,
    estimatedLocalProviderCostUsd: 0,
  };
}

function writeState({ dataset, results, status, startedAt }) {
  const payload = {
    schemaVersion: 1,
    benchmarkId: dataset.datasetId,
    rightsStatus: dataset.rights.status,
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    strategy: {
      compositionMode: "multi_moment",
      goalSelectionMode: "valid_goals_only",
      editIntensity: "punchy",
      stylePreset: "reference_football_multi_goal_v1",
      renderProfile: "quality",
      transcription: "deterministic_mock_first_pass",
      scoreboardOcr: "required_for_every_render",
      goalCoverage: "fail_closed_against_fixture_score",
      actionLayout: "clean_wide_safe_no_blurred_duplicate_background",
      visualReview: "required_for_every_output",
      autoResearchOnFailure: true,
    },
    summary: stateSummary(results, dataset.videos.length),
    results: [...results].sort((left, right) => left.index - right.index),
  };
  atomicWriteJson(LATEST_PATH, payload);
  return payload;
}

async function runOne(video, options = {}) {
  const started = Date.now();
  let sourceQuality;
  try {
    sourceQuality = await ensureHighQualitySource(video);
  } catch (error) {
    return {
      index: video.index,
      videoId: video.videoId,
      title: video.title,
      status: "failed",
      elapsedMs: Date.now() - started,
      failure: { code: "SOURCE_QUALITY_GATE_FAILED", phase: "source", nextAction: "replace-with-720p-or-better-source", failedReasons: [String(error.message || error)] },
      review: { status: "pending_rerender" },
    };
  }
  const commandResult = await spawnCommand(
    process.execPath,
    ["demo/run-youtube-live-e2e.mjs", "--operator"],
    { env: benchmarkEnvironment(video, options) },
  );
  const report = readJson(LIVE_REPORT_PATH, null);
  if (!report || report?.source?.videoId !== video.videoId || report.status !== "passed") {
    return {
      index: video.index,
      videoId: video.videoId,
      title: video.title,
      status: "failed",
      elapsedMs: Date.now() - started,
      failure: compactFailure(report, commandResult),
      review: { status: "pending_rerender" },
    };
  }
  const generatedRef = String(report.generatedArtifact?.relativePath || "");
  const generatedPath = resolve(ROOT_DIR, generatedRef);
  if (!generatedRef.startsWith("manual-downloads/") || !existsSync(generatedPath)) {
    return {
      index: video.index,
      videoId: video.videoId,
      title: video.title,
      status: "failed",
      elapsedMs: Date.now() - started,
      failure: { code: "GENERATED_ARTIFACT_MISSING", phase: "artifact", nextAction: "rerun-video", failedReasons: [] },
      review: { status: "pending_rerender" },
    };
  }
  const stable = stableArtifactPaths(video);
  mkdirSync(MANUAL_DIR, { recursive: true });
  copyFileSync(generatedPath, stable.video);
  await createContactSheet(stable.video, stable.contactSheet);
  return {
    index: video.index,
    videoId: video.videoId,
    title: video.title,
    status: "passed",
    elapsedMs: Date.now() - started,
    reportRef: safeRelative(resolve(ROOT_DIR, `demo/results/youtube-live-e2e-${report.timestamp.replace(/[:.]/g, "-")}.json`)),
    outputRef: safeRelative(stable.video),
    contactSheetRef: safeRelative(stable.contactSheet),
    outputSha256Prefix: report.generatedArtifact?.sha256Prefix || null,
    metrics: outputMetrics(report),
    sourceQuality,
    passMode: options.scoreboardOcr === true ? "strict_all_goals_with_scoreboard_ocr" : "strict_all_goals_without_scoreboard_ocr",
    review: {
      status: "pending_human_visual_review",
      criteria: ["moment_selection", "framing", "captions", "pacing", "action_visibility"],
    },
  };
}

async function main() {
  const args = parseArgs();
  const dataset = validateDataset(readJson(DATASET_PATH));
  const selected = dataset.videos
    .filter((video) => video.index >= args.start)
    .slice(0, args.limit || dataset.videos.length);
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: "ready",
      rightsStatus: dataset.rights.status,
      selected: selected.map(({ index, videoId, title }) => ({ index, videoId, title })),
      output: safeRelative(LATEST_PATH),
    }, null, 2));
    return;
  }

  const previous = readJson(LATEST_PATH, { results: [] });
  const resultsById = new Map((Array.isArray(previous.results) ? previous.results : []).map((result) => [result.videoId, result]));
  const startedAt = previous.startedAt || new Date().toISOString();
  writeState({ dataset, results: [...resultsById.values()], status: "running", startedAt });

  for (const video of selected) {
    const existing = resultsById.get(video.videoId);
    if (
      !args.force &&
      existing?.status === "passed" &&
      existing.outputRef &&
      existing.contactSheetRef &&
      existsSync(resolve(ROOT_DIR, existing.outputRef)) &&
      existsSync(resolve(ROOT_DIR, existing.contactSheetRef))
    ) {
      console.log(`[${video.index}/20] resume: ${video.videoId}`);
      continue;
    }
    console.log(`[${video.index}/20] render: ${video.videoId}`);
    const result = await runOne(video, args);
    resultsById.set(video.videoId, result);
    writeState({ dataset, results: [...resultsById.values()], status: "running", startedAt });
    console.log(`[${video.index}/20] ${result.status}: ${video.videoId}`);
    await delay(INTER_JOB_COOLDOWN_MS);
  }

  const results = [...resultsById.values()];
  const allPassed = dataset.videos.every((video) => resultsById.get(video.videoId)?.status === "passed");
  const finalState = writeState({
    dataset,
    results,
    status: allPassed ? "awaiting_human_visual_review" : "partial",
    startedAt,
  });
  console.log(JSON.stringify({
    status: finalState.status,
    summary: finalState.summary,
    report: safeRelative(LATEST_PATH),
  }, null, 2));
  if (selected.some((video) => resultsById.get(video.videoId)?.status === "failed")) process.exitCode = 1;
}

await main();
