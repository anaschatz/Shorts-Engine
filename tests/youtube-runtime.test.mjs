import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  cleanupGeneratedProofArtifacts,
  DEFAULT_TIMEOUT_MS,
  isManagedLiveProofMp4,
  liveServerEnvironment,
  runYouTubeLiveE2E,
  smokeEnvForLive,
  writeYouTubeLiveE2EReport,
} from "../demo/run-youtube-live-e2e.mjs";
import {
  computedIngestRequestTimeoutMs,
  runYouTubeSmoke,
  safeDownloadArtifactRef,
  writeYouTubeSmokeReport,
} from "../demo/run-youtube-smoke.mjs";
import {
  YouTubeDoctorError,
  checkYouTubeIngest,
  safeError as safeDoctorError,
} from "../tools/release/check-youtube-ingest.mjs";

const VIDEO_ID = "dQw4w9WgXcQ";
const SAFE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function readyStorage() {
  return {
    staging: { exists: true, readable: true, writable: true },
    tmp: { exists: true, readable: true, writable: true },
    artifacts: { exists: true, readable: true, writable: true },
  };
}

function jsonResponse(payload, status = 200, requestId = "req_test") {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function mp4Response() {
  const buffer = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    Buffer.alloc(128),
  ]);
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(buffer.length),
      "x-request-id": "req_download",
    },
  });
}

function renderPolishQA(overrides = {}) {
  return {
    contractVersion: 1,
    renderStylePreset: "punchy_highlight",
    outputWidth: 1080,
    outputHeight: 1920,
    transitionMode: "segment_fade_concat",
    transitionRenderedCount: 0,
    hardCutFallbackCount: 0,
    transitions: [],
    animatedCaptionCount: 2,
    dynamicWordCaptionCount: 2,
    staticCaptionFallbackCount: 0,
    captionMotion: "ass_word_by_word_highlight",
    overlayRenderedCount: 2,
    overlayFallbackCount: 0,
    overlayMode: "ass_goal_badge_and_labels",
    visualPolishScore: 100,
    renderPolishWarnings: [],
    ...overrides,
  };
}

function completedJobEditPlan(overrides = {}) {
  return {
    mode: "single_moment",
    sourceStart: 0,
    sourceEnd: 12,
    totalDuration: 12,
    aspectRatio: "9:16",
    highlightType: "big_chance",
    confidence: 0.86,
    hook: "THE CHANCE OPENS",
    captions: [
      {
        start: 0.2,
        end: 2.2,
        text: "THE CHANCE OPENS",
        role: "opening_hook",
        words: ["THE", "CHANCE", "OPENS"],
        activeWordTiming: [
          { word: "THE", start: 0.2, end: 0.7 },
          { word: "CHANCE", start: 0.7, end: 1.4 },
          { word: "OPENS", start: 1.4, end: 2.1 },
        ],
        stylePreset: "hormozi_sports",
        contrastMode: "outlined_shadow",
        safeArea: { name: "lower_third" },
        captionRiskFlags: [],
      },
      {
        start: 8.8,
        end: 11.6,
        text: "WATCH THE REPLAY",
        role: "closing_punch",
        words: ["WATCH", "THE", "REPLAY"],
        activeWordTiming: [
          { word: "WATCH", start: 8.8, end: 9.5 },
          { word: "THE", start: 9.5, end: 10.1 },
          { word: "REPLAY", start: 10.1, end: 11.2 },
        ],
        stylePreset: "hormozi_sports",
        contrastMode: "outlined_shadow",
        safeArea: { name: "lower_third" },
        captionRiskFlags: [],
      },
    ],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2, safeForMotion: true },
      { type: "caption_word_pop", start: 0.2, end: 2.2, safeForMotion: true },
      { type: "beat_cut", start: 7.8, end: 8.1 },
    ],
    audioPolicy: {
      audioMode: "source_only",
      licenseStatus: "source_rights_confirmed",
      source: "original_source_audio",
      externalAudioBundled: false,
      copyrightedTrackBundled: false,
      operatorActionRequired: false,
      copyrightEvasion: false,
      bypassDetection: false,
      avoidCopyrightDetection: false,
    },
    creativeStyleTransforms: {
      colorGrade: "sports_clean",
      mildZoom: 1.02,
      mirror: false,
      copyrightEvasion: false,
      watermarkObscuring: false,
    },
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    styleTarget: "vertical_9_16",
    editIntensity: "punchy",
    cropPlan: { mode: "wide_safe", fallbackUsed: true },
    reasonCodes: ["big_chance", "visual_shot_like_motion"],
    visualPolishQA: {
      contractVersion: 1,
      countedGoalsIncluded: 0,
      replayOnlySegments: 0,
      averageGoalSegmentDuration: 12,
      abruptCutRiskCount: 0,
      captionsAlignedCount: 2,
      captionsMisalignedCount: 0,
      visualPolishScore: 96,
      score: 0.96,
      referenceSimilarityNotes: ["mock_reference_style_ready"],
    },
    renderPolishQA: renderPolishQA(),
    ...overrides,
  };
}

function createFetchMock(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const pathKey = `${method} ${parsed.pathname}`;
    calls.push({ key, body: options.body || null });
    if (overrides[key]) return overrides[key]({ url: String(url), options });
    if (overrides[pathKey]) return overrides[pathKey]({ url: String(url), options });
    if (pathKey === "GET /health") {
      return jsonResponse({
        ok: true,
        data: {
          service: "shortsengine-mvp",
          status: "ready",
          requestId: "rid_health",
          ffmpeg: { ffmpeg: true, ffprobe: true },
          youtubeIngest: {
            enabled: true,
            mode: "local",
            ready: true,
            downloaderConfigured: true,
            ingestAvailable: true,
          },
        },
      }, 200, "req_health");
    }
    if (pathKey === "POST /api/youtube/validate") {
      const body = JSON.parse(options.body);
      assert.equal(body.url, SAFE_URL);
      assert.equal(body.rightsConfirmed, true);
      return jsonResponse({
        ok: true,
        data: {
          source: {
            sourceType: "youtube",
            kind: "watch",
            videoId: VIDEO_ID,
            ingestAvailable: true,
            downloaderConfigured: true,
          },
        },
      }, 200, "req_validate");
    }
    if (pathKey === "POST /api/youtube/ingest") {
      const body = JSON.parse(options.body);
      assert.equal(body.url, SAFE_URL);
      assert.equal(body.rightsConfirmed, true);
      return jsonResponse({
        ok: true,
        data: {
          project: { id: "prj_12345678", status: "draft" },
          upload: {
            id: "upl_12345678",
            projectId: "prj_12345678",
            metadata: { durationSeconds: 12, width: 1280, height: 720 },
            artifact: { id: "upl_12345678", type: "upload", status: "available", size: 1024 },
          },
          source: {
            sourceType: "youtube",
            kind: "watch",
            videoId: VIDEO_ID,
            durationSeconds: 12,
          },
        },
      }, 201, "req_ingest");
    }
    if (pathKey === "POST /api/projects/prj_12345678/generate") {
      const body = JSON.parse(options.body);
      assert.equal(body.rightsConfirmed, true);
      assert.match(body.idempotencyKey, /^youtube_smoke_/);
      return jsonResponse({
        ok: true,
        data: {
          job: { id: "job_12345678", projectId: "prj_12345678", uploadId: "upl_12345678", status: "queued" },
        },
      }, 202, "req_generate");
    }
    if (pathKey === "GET /api/jobs/job_12345678") {
      return jsonResponse({
        ok: true,
        data: {
          job: {
            id: "job_12345678",
            projectId: "prj_12345678",
            uploadId: "upl_12345678",
            status: "completed",
            progress: 100,
            step: "completed",
            exportId: "exp_12345678",
            editPlan: completedJobEditPlan(),
            candidatePlans: [completedJobEditPlan({ candidateId: "candidate_primary" })],
          },
        },
      }, 200, "req_job");
    }
    if (pathKey === "GET /api/exports/exp_12345678/download") return mp4Response();
    return jsonResponse({ ok: false, error: { code: "TEST_ROUTE_NOT_FOUND", message: "Missing mocked route." } }, 404);
  };
  return { fetchImpl, calls };
}

function smokeEnv(overrides = {}) {
  return {
    SHORTSENGINE_YOUTUBE_SMOKE: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL: "http://127.0.0.1:4175",
    ...overrides,
  };
}

function savedArtifactRef() {
  return `manual-downloads/test-youtube-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
}

test("youtube doctor disabled default returns a safe skipped summary", async () => {
  let downloaderChecked = false;
  const result = await checkYouTubeIngest({
    env: {},
    nowMs: Date.parse("2026-06-16T00:00:00.000Z"),
    commandAvailable: () => true,
    downloaderAvailable: () => {
      downloaderChecked = true;
      return false;
    },
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "YOUTUBE_INGEST_DISABLED");
  assert.equal(result.youtubeIngest.enabled, false);
  assert.match(result.nextAction, /SHORTSENGINE_YOUTUBE_INGEST_ENABLED/);
  assert.equal(downloaderChecked, false);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor enabled reports missing downloader safely", async () => {
  const result = await checkYouTubeIngest({
    env: { SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1" },
    commandAvailable: () => true,
    downloaderAvailable: () => false,
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(result.youtubeIngest.ingestAvailable, false);
  assert.match(result.nextAction, /downloader|SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN/);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor accepts operator source cache when downloader is missing", async () => {
  const result = await checkYouTubeIngest({
    env: {
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_SOURCE_CACHE_ENABLED: "1",
      SHORTSENGINE_SOURCE_CACHE_REQUIRE_CHECKSUM: "1",
    },
    commandAvailable: () => true,
    downloaderAvailable: () => false,
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(result.youtubeIngest.ingestAvailable, true);
  assert.equal(result.youtubeIngest.downloaderConfigured, false);
  assert.equal(result.youtubeIngest.sourceCache.enabled, true);
  assert.equal(result.youtubeIngest.sourceCache.requireChecksum, true);
  const downloaderCheck = result.checks.find((check) => check.name === "downloader_available");
  assert.equal(downloaderCheck.status, "skipped");
  assert.equal(downloaderCheck.code, "SOURCE_CACHE_MISS");
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor reports safe downloader runtime strategy when enabled", async () => {
  const result = await checkYouTubeIngest({
    env: {
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_YOUTUBE_FORMAT_SELECTOR: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      SHORTSENGINE_YOUTUBE_FALLBACK_FORMAT_SELECTOR: "best[ext=mp4]/best",
      SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS: "3",
      SHORTSENGINE_YOUTUBE_PLAYER_CLIENT: "android",
    },
    commandAvailable: () => true,
    downloaderAvailable: () => true,
    downloaderVersion: () => ({ available: true, version: "2026.01.01" }),
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.youtubeIngest.downloaderConfigured, true);
  assert.equal(result.youtubeIngest.downloaderVersion, "2026.01.01");
  assert.equal(result.youtubeIngest.formatStrategy.attemptsConfigured, 3);
  assert.equal(result.youtubeIngest.formatStrategy.playerClient, "android");
  assert.equal(result.youtubeIngest.formatStrategy.fallbackFormatSelector, "best[ext=mp4]/best");
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor live health shape failures include safe next actions", async () => {
  const result = await checkYouTubeIngest({
    env: {
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_YOUTUBE_DOCTOR_URL: "http://127.0.0.1:4175",
    },
    commandAvailable: () => true,
    downloaderAvailable: () => true,
    storageHealth: readyStorage,
    fetchImpl: async () => jsonResponse({
      ok: true,
      data: {
        service: "shortsengine-mvp",
        status: "ready",
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING");
  assert.equal(result.serverHealth.code, "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING");
  assert.match(result.serverHealth.nextAction, /youtubeIngest-shape/);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor safeError maps live health shape errors to operator guidance", () => {
  const safe = safeDoctorError(new YouTubeDoctorError(
    "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID",
    "Health youtubeIngest readiness shape is invalid.",
  ));
  assert.equal(safe.status, "failed");
  assert.match(safe.nextAction, /youtubeIngest-shape/);
  assert.equal(findSensitiveLeak(safe), null);
});

test("youtube smoke skips safely without explicit flag", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "skipped");
  assert.equal(calls, 0);
  assert.equal(report.checks[0].code, "YOUTUBE_SMOKE_DISABLED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke rejects unsafe URLs before network", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_URL: `${SAFE_URL}&list=PL123` }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(calls, 0);
  assert.equal(report.failedCases[0].code, "YOUTUBE_PLAYLIST_UNSUPPORTED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke requires allowlist or explicit manual flag before network", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "0", SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS: "" }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(calls, 0);
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_URL_NOT_ALLOWED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke validates bounded per-request timeout before network work", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS: "0" }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(calls, 0);
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_REQUEST_TIMEOUT_INVALID");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke defaults ingest request timeout to cover bounded downloader retries", () => {
  assert.equal(computedIngestRequestTimeoutMs({}), 270000);
  assert.equal(computedIngestRequestTimeoutMs({
    SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS: "60000",
    SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS: "3",
  }), 210000);
  assert.equal(computedIngestRequestTimeoutMs({
    SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS: "900000",
    SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS: "2",
  }), 1800000);
  assert.equal(computedIngestRequestTimeoutMs({
    SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS: "1000",
  }), "1000");
});

test("youtube live server environment maps operator download timeout to backend downloader timeout", () => {
  const env = liveServerEnvironment({
    port: 4175,
    dataDir: "/tmp/shortsengine-test-data",
    env: {
      SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS: "600000",
      SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS: "2",
    },
  });
  assert.equal(env.SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS, "600000");
  assert.equal(env.SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS, "600000");
  assert.equal(env.SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS, "1230000");
});

test("youtube live smoke environment maps operator download timeout to ingest request timeout", () => {
  const env = smokeEnvForLive({
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS: "600000",
    SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS: "2",
  }, "http://127.0.0.1:4175");
  assert.equal(env.SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS, "600000");
  assert.equal(env.SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS, "600000");
  assert.equal(env.SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS, "1230000");
  assert.equal(env.SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL, "http://127.0.0.1:4175");
});

test("youtube smoke request timeout reports exact ingest phase and step", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": ({ options }) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS: "1000" }),
    fetchImpl,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_INGEST_TIMEOUT");
  assert.equal(report.failedCases[0].phase, "ingest");
  assert.equal(report.failedCases[0].step, "download_source");
  assert.equal(report.failedCases[0].substep, "youtube_downloader");
  assert.equal(report.failedCases[0].timeoutMs, 1000);
  assert.equal(report.failedCases[0].elapsedMs >= 900, true);
  assert.match(report.failedCases[0].nextAction, /ingest-request-timeout/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke ingest API failures report downloader phase details", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": () => jsonResponse({
      ok: false,
      error: {
        code: "YOUTUBE_DOWNLOAD_FAILED",
        message: "Download failed.",
        safeMessage: "The YouTube ingest download failed safely.",
        failureReason: "download_failed",
        nextAction: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
        retryable: true,
        attempts: 2,
        attemptsConfigured: 2,
        elapsedMs: 245000,
        timeoutMs: 120000,
        formatSelector: "best[ext=mp4]/best",
        fallbackFormatSelector: "best[ext=mp4]/best",
        fallbackUsed: true,
        sourceAcquisitionStatus: "failed",
        stallClassification: "no_progress_timeout",
        heartbeatIntervalMs: 5000,
        noProgressTimeoutMs: 45000,
        progressHeartbeatCount: 12,
        progressEventCount: 1,
        progressBytesObserved: 4096,
        lastProgressAgeMs: 250,
        timeoutClassification: "DOWNLOAD_TIMED_OUT_WITH_PROGRESS",
        bytesStillMovingAtTimeout: true,
        continueEnabled: true,
        continueAttempted: true,
        resumableStateEnabled: false,
        resumeStateRetained: false,
        metadataPreflightStatus: "local",
        metadataPreflightDurationSeconds: 540,
        partialCleanupSucceeded: true,
        partialCleanupRemovedCount: 2,
        cleanupSucceeded: true,
        downloadedOutputReady: false,
      },
    }, 502, "req_ingest_failed"),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_DOWNLOAD_FAILED");
  assert.equal(report.failedCases[0].message, "The YouTube ingest download failed safely.");
  assert.equal(report.failedCases[0].safeMessage, "The YouTube ingest download failed safely.");
  assert.equal(report.failedCases[0].failureReason, "download_failed");
  assert.equal(report.failedCases[0].phase, "ingest");
  assert.equal(report.failedCases[0].step, "download_source");
  assert.equal(report.failedCases[0].substep, "youtube_downloader");
  assert.equal(report.failedCases[0].attempts, 2);
  assert.equal(report.failedCases[0].attemptsConfigured, 2);
  assert.equal(report.failedCases[0].elapsedMs, 245000);
  assert.equal(report.failedCases[0].retryable, true);
  assert.equal(report.failedCases[0].fallbackUsed, true);
  assert.equal(report.failedCases[0].sourceAcquisitionStatus, "failed");
  assert.equal(report.failedCases[0].stallClassification, "no_progress_timeout");
  assert.equal(report.failedCases[0].heartbeatIntervalMs, 5000);
  assert.equal(report.failedCases[0].noProgressTimeoutMs, 45000);
  assert.equal(report.failedCases[0].progressHeartbeatCount, 12);
  assert.equal(report.failedCases[0].progressEventCount, 1);
  assert.equal(report.failedCases[0].progressBytesObserved, 4096);
  assert.equal(report.failedCases[0].lastProgressAgeMs, 250);
  assert.equal(report.failedCases[0].timeoutClassification, "DOWNLOAD_TIMED_OUT_WITH_PROGRESS");
  assert.equal(report.failedCases[0].bytesStillMovingAtTimeout, true);
  assert.equal(report.failedCases[0].continueEnabled, true);
  assert.equal(report.failedCases[0].continueAttempted, true);
  assert.equal(report.failedCases[0].resumableStateEnabled, false);
  assert.equal(report.failedCases[0].resumeStateRetained, false);
  assert.equal(report.failedCases[0].formatSelector, "best[ext=mp4]/best");
  assert.equal(report.failedCases[0].metadataPreflightStatus, "local");
  assert.equal(report.failedCases[0].metadataPreflightDurationSeconds, 540);
  assert.equal(report.failedCases[0].partialCleanupSucceeded, true);
  assert.equal(report.failedCases[0].partialCleanupRemovedCount, 2);
  assert.equal(report.failedCases[0].cleanupSucceeded, true);
  assert.equal(report.failedCases[0].downloadedOutputReady, false);
  assert.equal(report.steps.at(-1).phase, "ingest");
  assert.equal(report.steps.at(-1).activeStep, "download_source");
  assert.equal(report.steps.at(-1).substep, "youtube_downloader");
  assert.equal(report.failedCases[0].nextAction, "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke ingest connection close reports safe downloader context", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": () => {
      throw Object.assign(new Error("socket closed with raw stderr token /Users/raw"), { code: "ECONNRESET" });
    },
  });
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS: "600000" }),
    fetchImpl,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_CONNECTION_CLOSED");
  assert.equal(report.failedCases[0].message, "The YouTube ingest connection closed before the downloader returned a structured result.");
  assert.equal(report.failedCases[0].safeMessage, "The YouTube ingest connection closed before the downloader returned a structured result.");
  assert.equal(report.failedCases[0].failureReason, "ingest_connection_closed_before_downloader_result");
  assert.equal(report.failedCases[0].phase, "ingest");
  assert.equal(report.failedCases[0].step, "download_source");
  assert.equal(report.failedCases[0].substep, "youtube_downloader");
  assert.equal(report.failedCases[0].timeoutMs, 600000);
  assert.equal(report.failedCases[0].retryable, true);
  assert.equal(report.failedCases[0].causeCode, "ECONNRESET");
  assert.equal(report.failedCases[0].nextAction, "inspect-server-ingest-runtime-and-retry-with-authorized-source-cache-or-longer-download-budget");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke stalled job report preserves active progress substep safely", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /api/jobs/job_12345678": () => jsonResponse({
      ok: true,
      data: {
        job: {
          id: "job_12345678",
          projectId: "prj_12345678",
          uploadId: "upl_12345678",
          status: "processing",
          progress: 22,
          step: "analyze_media",
          exportId: null,
          progressMeta: {
            phase: "analysis",
            step: "analyze_media",
            substep: "media_signal_extraction",
            startedAt: "2026-07-02T15:00:00.000Z",
            longSource: true,
            scorebugFirst: false,
            budgetMs: 45000,
          },
        },
      },
    }, 200, "req_job"),
  });
  const report = await runYouTubeSmoke({
    env: smokeEnv({
      SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS: "15000",
      SHORTSENGINE_YOUTUBE_SMOKE_STALL_TIMEOUT_MS: "1000",
      SHORTSENGINE_YOUTUBE_SMOKE_POLL_INTERVAL_MS: "100",
    }),
    fetchImpl,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "JOB_PROGRESS_STALLED");
  assert.equal(report.failedCases[0].phase, "render");
  assert.equal(report.failedCases[0].step, "analyze_media");
  assert.equal(report.failedCases[0].substep, "media_signal_extraction");
  assert.equal(report.failedCases[0].stalled, true);
  assert.equal(report.failedCases[0].currentJob.progressMeta.longSource, true);
  assert.equal(report.jobLifecycle.at(-1).progressMeta.substep, "media_signal_extraction");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke failed job report preserves terminal progress substep safely", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /api/jobs/job_12345678": () => jsonResponse({
      ok: true,
      data: {
        job: {
          id: "job_12345678",
          projectId: "prj_12345678",
          uploadId: "upl_12345678",
          status: "failed",
          progress: 28,
          step: "run_scorebug_ocr",
          exportId: null,
          progressMeta: {
            phase: "analysis",
            step: "run_scorebug_ocr",
            substep: "scorebug_first_chunk",
            startedAt: "2026-07-02T15:00:00.000Z",
            longSource: true,
            scorebugFirst: true,
            budgetMs: 250,
            chunkIndex: 3,
            chunkCount: 8,
            chunkStart: 180,
            chunkEnd: 270,
            scannedChunks: 2,
            discoveredScoreChanges: 1,
            totalBudgetMs: 45000,
            chunkTimeoutMs: 250,
          },
          error: { code: "SCOREBOARD_OCR_TIMEOUT", message: "The video analysis failed." },
        },
      },
    }, 200, "req_job_failed"),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "SCOREBOARD_OCR_TIMEOUT");
  assert.equal(report.failedCases[0].phase, "analysis");
  assert.equal(report.failedCases[0].step, "run_scorebug_ocr");
  assert.equal(report.failedCases[0].substep, "scorebug_first_chunk");
  assert.equal(report.failedCases[0].timeoutMs, 250);
  assert.equal(report.failedCases[0].chunkIndex, 3);
  assert.equal(report.failedCases[0].chunkCount, 8);
  assert.equal(report.failedCases[0].chunkStart, 180);
  assert.equal(report.failedCases[0].chunkEnd, 270);
  assert.equal(report.failedCases[0].scannedChunks, 2);
  assert.equal(report.failedCases[0].discoveredScoreChanges, 1);
  assert.equal(report.failedCases[0].currentJob.status, "failed");
  assert.equal(report.failedCases[0].currentJob.progressMeta.chunkIndex, 3);
  assert.equal(report.failedCases[0].currentJob.error.code, "SCOREBOARD_OCR_TIMEOUT");
  assert.equal(report.failedCases[0].nextAction, "reduce-scorebug-ocr-sampling-or-disable-live-scoreboard-ocr-and-rerun-proof");
  assert.equal(report.steps.at(-1).activeStep, "run_scorebug_ocr");
  assert.equal(report.jobLifecycle.at(-1).progressMeta.budgetMs, 250);
  assert.equal(report.jobLifecycle.at(-1).progressMeta.chunkIndex, 3);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke polling failure preserves last active chunk context", async () => {
  let jobPollCount = 0;
  const { fetchImpl } = createFetchMock({
    "GET /api/jobs/job_12345678": () => {
      jobPollCount += 1;
      if (jobPollCount > 1) {
        throw Object.assign(new Error("socket closed while polling"), { code: "ECONNRESET" });
      }
      return jsonResponse({
        ok: true,
        data: {
          job: {
            id: "job_12345678",
            projectId: "prj_12345678",
            uploadId: "upl_12345678",
            status: "processing",
            progress: 31,
            step: "run_scorebug_ocr",
            exportId: null,
            progressMeta: {
              phase: "analysis",
              step: "run_scorebug_ocr",
              substep: "scorebug_first_chunk",
              longSource: true,
              scorebugFirst: true,
              budgetMs: 10000,
              chunkIndex: 2,
              chunkCount: 6,
              chunkStart: 90,
              chunkEnd: 180,
              scannedChunks: 1,
              discoveredScoreChanges: 1,
              totalBudgetMs: 60000,
              chunkTimeoutMs: 10000,
            },
          },
        },
      }, 200, "req_job_processing");
    },
  });

  const report = await runYouTubeSmoke({
    env: smokeEnv({
      SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS: "5000",
      SHORTSENGINE_YOUTUBE_SMOKE_POLL_INTERVAL_MS: "100",
    }),
    fetchImpl,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_CONNECTION_CLOSED");
  assert.equal(report.failedCases[0].causeCode, "ECONNRESET");
  assert.equal(report.failedCases[0].phase, "render");
  assert.equal(report.failedCases[0].step, "run_scorebug_ocr");
  assert.equal(report.failedCases[0].substep, "scorebug_first_chunk");
  assert.equal(report.failedCases[0].currentJob.progressMeta.chunkIndex, 2);
  assert.equal(report.failedCases[0].currentJob.progressMeta.chunkCount, 6);
  assert.equal(report.failedCases[0].currentJob.progressMeta.scannedChunks, 1);
  assert.equal(report.jobLifecycle.at(-1).progressMeta.discoveredScoreChanges, 1);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke successful mocked flow validates ingest generate job and download contract", async () => {
  const { fetchImpl, calls } = createFetchMock();
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "passed");
  assert.equal(report.ids.projectId, "prj_12345678");
  assert.equal(report.ids.uploadId, "upl_12345678");
  assert.equal(report.ids.jobId, "job_12345678");
  assert.equal(report.ids.exportId, "exp_12345678");
  assert.equal(report.export.contentType, "video/mp4");
  assert.equal(report.export.sizeBytes > 0, true);
  assert.equal(report.renderPlan.mode, "single_moment");
  assert.equal(report.renderPlan.totalDuration, 12);
  assert.equal(report.renderPlan.captionCount, 2);
  assert.equal(report.renderPlan.animationCueTypes.includes("beat_cut"), true);
  assert.equal(report.renderPlan.countedGoalProof.finalSegmentCount, 0);
  assert.deepEqual(report.renderPlan.countedGoalProof.selectedValidGoals, []);
  assert.equal(report.steps.every((step) => !Object.hasOwn(step, "requestId")), true);
  assert.equal(report.steps.every((step) => step.status !== "passed" || step.requestIdPresent === true || step.step === "job"), true);
  assert.deepEqual(calls.map((call) => call.key), [
    "GET /health",
    "POST /api/youtube/validate",
    "POST /api/youtube/ingest",
    "POST /api/projects/prj_12345678/generate",
    "GET /api/jobs/job_12345678?view=summary",
    "GET /api/exports/exp_12345678/download",
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SAFE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke render summary includes safe counted-goal proof details", async () => {
  const validGoalSegments = [
    {
      id: "seg_goal_1",
      sourceStart: 271,
      sourceEnd: 286,
      timelineStart: 0,
      timelineEnd: 15,
      duration: 15,
      highlightType: "goal",
      goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside", safeCaptionBadge: "GOAL GIVEN" },
      reasonCodes: ["goal", "scoreboard_backed_goal_sequence", "scoreboard_ocr_score_change"],
      whySelected: "Confirmed counted goal selected from match truth.",
      safetyFlags: [],
    },
    {
      id: "seg_goal_2",
      sourceStart: 357,
      sourceEnd: 372,
      timelineStart: 15,
      timelineEnd: 30,
      duration: 15,
      highlightType: "goal",
      goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside", safeCaptionBadge: "THIS ONE COUNTS" },
      reasonCodes: ["goal", "visual_ball_in_net", "visual_referee_goal_signal"],
      whySelected: "Confirmed counted goal selected from match truth.",
      safetyFlags: [],
    },
  ];
  const editPlan = completedJobEditPlan({
    mode: "multi_moment_compilation",
    highlightType: "generic_highlight",
    goalSelectionMode: "valid_goals_only",
    sourceStart: 271,
    sourceEnd: 372,
    totalDuration: 30,
    segments: validGoalSegments,
  });
  const { fetchImpl } = createFetchMock({
    "GET /api/jobs/job_12345678": () => jsonResponse({
      ok: true,
      data: {
        job: {
          id: "job_12345678",
          projectId: "prj_12345678",
          uploadId: "upl_12345678",
          status: "completed",
          progress: 100,
          step: "completed",
          exportId: "exp_12345678",
          editPlan,
          candidatePlans: [editPlan],
          goalEvidence: {
            events: [
              { id: "goal_1", start: 271, end: 286, outcomeHint: "valid_goal", confidence: 0.94, reasonCodes: ["scoreboard_ocr_score_change"] },
              { id: "offside_1", start: 160, end: 174, outcomeHint: "offside_goal", confidence: 0.9, reasonCodes: ["visual_offside_flag", "scoreboard_ocr_score_unchanged"] },
              { id: "unknown_1", start: 210, end: 225, outcomeHint: "possible_goal_unconfirmed", confidence: 0.66, reasonCodes: ["visual_ball_in_net"] },
              { id: "goal_2", start: 357, end: 372, outcomeHint: "valid_goal", confidence: 0.93, reasonCodes: ["visual_referee_goal_signal"] },
            ],
          },
          matchEventTruth: {
            summary: {
              confirmedGoalCount: 2,
              disallowedGoalCount: 1,
              possibleGoalCount: 1,
              lateConfirmedGoalCount: 2,
              scoreChangeAnchorsFound: 2,
              stableScoreChangeAnchorCount: 2,
              revertedScoreChangeAnchorCount: 0,
              anchorsLinkedToGoalPhaseCount: 2,
              anchorsMissingVisualSupportCount: 0,
              noFalseGoalFromOcrOnly: 1,
            },
            scoreChangeAnchors: [
              {
                id: "anchor_goal_1",
                scoreBefore: "0-0",
                scoreAfter: "1-0",
                firstSeenAt: 282,
                confirmedAt: 286,
                stableUntil: 294,
                reverted: false,
                confidence: 0.94,
                source: "scoreboard_ocr",
                roiId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                outcome: "counted_goal",
                selectedForRender: true,
                linkedEventType: "confirmed_goal",
                hasLiveAction: true,
                hasVisibleFinish: true,
                replayOnly: false,
                missingEvidence: [],
                evidenceCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
              },
              {
                id: "anchor_goal_2",
                scoreBefore: "1-0",
                scoreAfter: "2-0",
                firstSeenAt: 366,
                confirmedAt: 372,
                stableUntil: 380,
                reverted: false,
                confidence: 0.93,
                source: "scoreboard_ocr",
                roiId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                outcome: "counted_goal",
                selectedForRender: true,
                linkedEventType: "confirmed_goal",
                hasLiveAction: true,
                hasVisibleFinish: true,
                replayOnly: false,
                missingEvidence: [],
                evidenceCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
              },
            ],
            selectedEvents: [
              {
                id: "truth_goal_1",
                type: "confirmed_goal",
                eventType: "valid_goal",
                truthStatus: "valid_goal",
                outcome: "confirmed_goal",
                sourceStart: 271,
                sourceEnd: 286,
                evidence: ["scoreboard_ocr_score_change", "scoreboard_backed_goal_sequence"],
                disqualifiers: [],
                confidence: 0.94,
              },
              {
                id: "truth_goal_2",
                type: "confirmed_goal",
                eventType: "valid_goal",
                truthStatus: "valid_goal",
                outcome: "confirmed_goal",
                sourceStart: 357,
                sourceEnd: 372,
                evidence: ["visual_ball_in_net", "visual_referee_goal_signal"],
                disqualifiers: [],
                confidence: 0.93,
              },
            ],
            rejectedEvents: [
              {
                id: "truth_offside_1",
                type: "disallowed_offside",
                eventType: "disallowed_goal",
                truthStatus: "disallowed_goal",
                outcome: "disallowed_offside",
                sourceStart: 160,
                sourceEnd: 174,
                decisionWindowStart: 171,
                decisionWindowEnd: 174,
                evidence: ["visual_offside_flag", "scoreboard_ocr_score_unchanged"],
                disqualifiers: ["offside", "no_goal_decision"],
                confidence: 0.9,
              },
              {
                id: "truth_unknown_1",
                type: "possible_goal_unconfirmed",
                eventType: "goal_candidate",
                truthStatus: "unknown",
                outcome: "possible_goal_unconfirmed",
                sourceStart: 210,
                sourceEnd: 225,
                evidence: ["visual_ball_in_net"],
                disqualifiers: ["unconfirmed_goal_decision"],
                confidence: 0.66,
              },
            ],
          },
        },
      },
    }, 200, "req_job"),
  });

  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  const proof = report.renderPlan.countedGoalProof;

  assert.equal(report.status, "passed");
  assert.equal(report.renderPlan.goalSelectionMode, "valid_goals_only");
  assert.equal(proof.finalSegmentCount, 2);
  assert.equal(proof.selectedValidGoals.length, 2);
  assert.equal(proof.excludedOffsideOrNoGoal.length, 1);
  assert.equal(proof.excludedUnknowns.length, 1);
  assert.equal(proof.detectedGoalCandidates.length, 4);
  assert.equal(proof.scoreChangeAnchors.length, 2);
  assert.equal(proof.scoreChangeAnchors[0].scoreBefore, "0-0");
  assert.equal(proof.scoreChangeAnchors[0].selectedForRender, true);
  assert.equal(proof.summary.stableScoreChangeAnchorCount, 2);
  assert.equal(proof.summary.anchorsMissingVisualSupportCount, 0);
  assert.equal(proof.summary.confirmedGoalCount, 2);
  assert.equal(proof.logsDownloaded, false);
  assert.equal(proof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke fails closed when a long source does not expose a multi-moment render plan", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": () => jsonResponse({
      ok: true,
      data: {
        project: { id: "prj_12345678", status: "draft" },
        upload: {
          id: "upl_12345678",
          projectId: "prj_12345678",
          metadata: { durationSeconds: 120, width: 1280, height: 720 },
          artifact: { id: "upl_12345678", type: "upload", status: "available", size: 1024 },
        },
        source: {
          sourceType: "youtube",
          kind: "watch",
          videoId: VIDEO_ID,
          durationSeconds: 120,
        },
      },
    }, 201, "req_ingest"),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_RENDER_PLAN_NOT_MULTI_MOMENT");
  assert.equal(report.renderPlan, null);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke surfaces safe video output QA when the render job fails the final gate", async () => {
  const videoOutputQA = failedVideoOutputQA();
  const { fetchImpl } = createFetchMock({
    "GET /api/jobs/job_12345678": () => jsonResponse({
      ok: true,
      data: {
        job: {
          id: "job_12345678",
          projectId: "prj_12345678",
          uploadId: "upl_12345678",
          status: "failed",
          progress: 72,
          step: "failed",
          exportId: null,
          error: { code: "VIDEO_OUTPUT_QA_FAILED", message: "Final video output did not pass QA." },
          videoOutputQA,
          editPlan: {
            ...completedJobEditPlan(),
            goalSelectionMode: "valid_goals_only",
            videoOutputQA,
          },
        },
      },
    }, 200, "req_job"),
  });

  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "VIDEO_OUTPUT_QA_FAILED");
  assert.equal(report.failedCases[0].countedGoalEventCount, 3);
  assert.equal(report.failedCases[0].actualConfirmedGoalSegmentCount, 2);
  assert.equal(report.failedCases[0].coveredGoalCount, 2);
  assert.deepEqual(report.failedCases[0].missingGoalNumbers, [3]);
  assert.deepEqual(report.failedCases[0].failedReasons, ["missing_or_invalid_counted_goal_segment"]);
  assert.equal(report.jobLifecycle.at(-1).videoOutputQA.status, "failed");
  assert.equal(report.jobLifecycle.at(-1).videoOutputQA.logsDownloaded, false);
  assert.equal(report.jobLifecycle.at(-1).videoOutputQA.artifactsDownloaded, false);
  assert.equal(report.renderPlan, null);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke can save a verified generated artifact under manual-downloads", async () => {
  const artifactRef = savedArtifactRef();
  const { fetchImpl } = createFetchMock();
  try {
    const report = await runYouTubeSmoke({
      env: smokeEnv({
        SHORTSENGINE_YOUTUBE_SMOKE_SAVE_DOWNLOAD: "1",
        SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_ARTIFACT: artifactRef,
      }),
      fetchImpl,
    });
    assert.equal(report.status, "passed");
    assert.equal(report.generatedArtifact.relativePath, artifactRef);
    assert.equal(report.generatedArtifact.downloadVerified, true);
    assert.equal(report.generatedArtifact.projectId, "prj_12345678");
    assert.equal(report.generatedArtifact.jobId, "job_12345678");
    assert.equal(report.generatedArtifact.exportId, "exp_12345678");
    assert.equal(report.generatedArtifact.durationSeconds, 12);
    assert.equal(existsSync(artifactRef), true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(artifactRef, { force: true });
  }
});

test("youtube smoke artifact refs fail closed outside manual-downloads", () => {
  assert.throws(
    () => safeDownloadArtifactRef("demo/results/generated.mp4"),
    /manual-downloads/,
  );
  assert.throws(
    () => safeDownloadArtifactRef("manual-downloads/../generated.mp4"),
    /manual-downloads|workspace/,
  );
});

test("youtube smoke fails closed when health is not ready", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /health": () => jsonResponse({
      ok: true,
      data: {
        service: "shortsengine-mvp",
        status: "degraded",
        requestId: "rid_health",
        ffmpeg: { ffmpeg: true, ffprobe: true },
        youtubeIngest: {
          enabled: true,
          mode: "local",
          ready: false,
          downloaderConfigured: true,
          ingestAvailable: true,
        },
      },
    }),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_HEALTH_NOT_READY");
  assert.match(report.failedCases[0].nextAction, /ready-server/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke report writer creates stable safe latest report", async () => {
  const { fetchImpl } = createFetchMock();
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  const outputDir = mkdtempSync(join(tmpdir(), "shortsengine-youtube-smoke-"));
  const written = writeYouTubeSmokeReport(report, outputDir);
  const latestFile = join(outputDir, "youtube-smoke-latest.json");
  assert.equal(existsSync(latestFile), true);
  assert.equal(written.latestPath.endsWith("youtube-smoke-latest.json"), true);
  const persisted = JSON.parse(readFileSync(latestFile, "utf8"));
  assert.equal(persisted.status, "passed");
  assert.equal(findSensitiveLeak(persisted), null);
});

test("youtube smoke fails closed when public responses leak unsafe fields", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": () => jsonResponse({
      ok: true,
      data: {
        project: { id: "prj_12345678" },
        upload: {
          id: "upl_12345678",
          storageKey: "private/storage/key.mp4",
          metadata: { durationSeconds: 12 },
          artifact: { id: "upl_12345678", type: "upload", status: "available", size: 1024 },
        },
        source: { sourceType: "youtube", videoId: VIDEO_ID, durationSeconds: 12 },
      },
    }, 201),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_RESPONSE_LEAK");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke fails closed when public responses contain raw downloader output", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/validate": () => jsonResponse({
      ok: true,
      data: {
        source: {
          sourceType: "youtube",
          kind: "watch",
          videoId: VIDEO_ID,
          ingestAvailable: true,
          downloaderConfigured: true,
          stdout: "yt-dlp --cookies /tmp/private-cookie.txt",
        },
      },
    }, 200),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_RESPONSE_LEAK");
  assert.match(report.failedCases[0].nextAction, /public-api-response/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke validates downloaded MP4 signature", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /api/exports/exp_12345678/download": () => new Response(Buffer.from("not an mp4"), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "10",
        "x-request-id": "req_download",
      },
    }),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID");
  assert.match(report.failedCases[0].nextAction, /render-output/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke timeout and runtime failures produce safe summaries", async () => {
  const report = await runYouTubeSmoke({
    env: smokeEnv(),
    fetchImpl: async () => {
      throw new Error("/tmp/local/path SHORTSENGINE_YOUTUBE_SMOKE_TOKEN secret YOUTUBE_COOKIE: private-cookie");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_FETCH_FAILED");
  assert.equal(findSensitiveLeak(report), null);
  assert.doesNotMatch(JSON.stringify(report), /\/tmp|SHORTSENGINE_YOUTUBE_SMOKE_TOKEN|YOUTUBE_COOKIE|private-cookie|secret/);
});

function liveEnv(overrides = {}) {
  return {
    SHORTSENGINE_YOUTUBE_LIVE_E2E: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    ...overrides,
  };
}

test("youtube live server env enables local scoreboard OCR only with explicit operator alias", () => {
  const defaultEnv = liveServerEnvironment({
    port: 4175,
    dataDir: "tmp/live-proof-data",
    env: liveEnv({
      SHORTSENGINE_SCOREBOARD_OCR_ENABLED: undefined,
      SHORTSENGINE_SCOREBOARD_OCR_PROVIDER: undefined,
      SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS: undefined,
    }),
  });
  assert.equal(defaultEnv.SHORTSENGINE_SCOREBOARD_OCR_ENABLED, undefined);
  assert.equal(defaultEnv.SHORTSENGINE_SCOREBOARD_OCR_PROVIDER, undefined);
  assert.equal(defaultEnv.SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS, undefined);
  assert.equal(defaultEnv.MATCHCUTS_TRANSCRIPTION_PROVIDER, "mock");
  assert.equal(defaultEnv.SHORTSENGINE_YOUTUBE_INGEST_ENABLED, "1");
  assert.equal(defaultEnv.SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS, "900000");
  assert.equal(defaultEnv.SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS, "900000");
  assert.equal(defaultEnv.SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS, "1800000");

  const ocrEnv = liveServerEnvironment({
    port: 4176,
    dataDir: "tmp/live-proof-data-ocr",
    env: liveEnv({
      SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR: "1",
      SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR_QA: "1",
    }),
  });
  assert.equal(ocrEnv.SHORTSENGINE_SCOREBOARD_OCR_ENABLED, "1");
  assert.equal(ocrEnv.SHORTSENGINE_SCOREBOARD_OCR_PROVIDER, "local");
  assert.equal(ocrEnv.SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS, "1");
  assert.equal(ocrEnv.SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS, "300000");
  assert.equal(ocrEnv.PORT, "4176");

  const explicitJobTimeoutEnv = liveServerEnvironment({
    port: 4177,
    dataDir: "tmp/live-proof-data-ocr-explicit",
    env: liveEnv({
      SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR: "1",
      SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS: "120000",
    }),
  });
  assert.equal(explicitJobTimeoutEnv.SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS, "120000");
});

function passedDoctor() {
  return {
    ok: true,
    status: "passed",
    code: null,
    youtubeIngest: {
      enabled: true,
      mode: "local",
      downloaderConfigured: true,
      ingestAvailable: true,
      defaultDisabled: false,
    },
    ffmpeg: { ffmpeg: true, ffprobe: true },
    storage: { stagingReady: true, tmpReady: true, artifactsReady: true },
    serverHealth: { checked: false },
  };
}

function passedSmokeReport() {
  return {
    status: "passed",
    source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
    target: { configured: true, protocol: "http", hostType: "local", mount: "root" },
    checks: [
      { name: "youtube_ingest_created_project", passed: true },
      { name: "youtube_ingest_created_upload", passed: true },
      { name: "youtube_render_created_export", passed: true },
      { name: "youtube_download_mp4_signature_valid", passed: true },
    ],
    steps: [
      { step: "health", status: "passed", requestIdPresent: true },
      { step: "validate", status: "passed", requestIdPresent: true, videoId: VIDEO_ID },
      { step: "ingest", status: "passed", requestIdPresent: true, projectId: "prj_12345678", uploadId: "upl_12345678" },
      { step: "generate", status: "passed", requestIdPresent: true, jobId: "job_12345678" },
      { step: "job", status: "passed", jobId: "job_12345678", exportId: "exp_12345678" },
      { step: "download", status: "passed", requestIdPresent: true, exportId: "exp_12345678", sizeBytes: 140 },
    ],
    ids: {
      projectId: "prj_12345678",
      uploadId: "upl_12345678",
      artifactId: "upl_12345678",
      jobId: "job_12345678",
      exportId: "exp_12345678",
    },
    health: {
      status: "ready",
      ffmpeg: true,
      ffprobe: true,
      youtubeIngest: {
        enabled: true,
        downloaderConfigured: true,
        ingestAvailable: true,
        mode: "local",
      },
      requestIdPresent: true,
    },
    jobLifecycle: [
      { id: "job_12345678", status: "completed", progress: 100, exportId: "exp_12345678" },
    ],
    renderPlan: {
      mode: "single_moment",
      highlightType: "big_chance",
      sourceStart: 0,
      sourceEnd: 12,
      totalDuration: 12,
      segmentCount: 0,
      segments: [],
      captionCount: 2,
      captions: [
        { index: 1, start: 0.2, end: 2.2, text: "THE CHANCE OPENS", role: "opening_hook", riskFlags: [] },
        { index: 2, start: 8.8, end: 11.6, text: "WATCH THE REPLAY", role: "closing_punch", riskFlags: [] },
      ],
      animationCueCount: 2,
      animationCueTypes: ["intro_hook", "beat_cut"],
      framingMode: "wide_safe_vertical",
      stylePreset: "punchy_highlight",
      styleTarget: "vertical_9_16",
      editIntensity: "punchy",
      cropPlanMode: "wide_safe",
      candidateCount: 1,
      visualPolishQA: {
        contractVersion: 1,
        countedGoalsIncluded: 0,
        replayOnlySegments: 0,
        averageGoalSegmentDuration: 12,
        abruptCutRiskCount: 0,
        captionsAlignedCount: 2,
        captionsMisalignedCount: 0,
        visualPolishScore: 96,
        score: 0.96,
        referenceSimilarityNotes: ["mock_reference_style_ready"],
      },
      renderPolishQA: renderPolishQA(),
      editAssembly: {
        contractVersion: 1,
        segmentCount: 0,
        segments: [],
        transitions: [],
      },
      topCandidates: [{ index: 1, mode: "single_moment", highlightType: "big_chance", segmentCount: 0, totalDuration: 12 }],
    },
    export: { status: 200, contentType: "video/mp4", sizeBytes: 140, sha256Prefix: "abc123" },
    generatedArtifact: {
      type: "rendered_video",
      status: "available",
      relativePath: "manual-downloads/shortsengine-youtube-dQw4w9WgXcQ-test.mp4",
      sourceType: "youtube",
      videoId: VIDEO_ID,
      projectId: "prj_12345678",
      uploadId: "upl_12345678",
      jobId: "job_12345678",
      exportId: "exp_12345678",
      sizeBytes: 140,
      contentType: "video/mp4",
      sha256Prefix: "abc123",
      durationSeconds: 12,
      width: 1280,
      height: 720,
      downloadVerified: true,
      logsDownloaded: false,
      rawDownloaderOutputIncluded: false,
    },
    failedCases: [],
  };
}

function failedVideoOutputQA(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "failed",
    passed: false,
    goalSelectionMode: "valid_goals_only",
    expectedGoalCount: 3,
    actualSegmentCount: 2,
    actualConfirmedGoalSegmentCount: 2,
    coveredGoalCount: 2,
    missingGoalNumbers: [3],
    extraGoalSegmentCount: 0,
    failedReasons: ["missing_or_invalid_counted_goal_segment"],
    invalidSegments: [],
    matches: [
      { goalNumber: 1, segmentIndex: 1, covered: true, reasons: [] },
      { goalNumber: 2, segmentIndex: 2, covered: true, reasons: [] },
      { goalNumber: 3, segmentIndex: null, covered: false, reasons: ["missing_segment_for_counted_goal"] },
    ],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ...overrides,
  };
}

function countedGoalSmokeReport() {
  const report = passedSmokeReport();
  const segments = [1, 2, 3].map((goalNumber, index) => {
    const sourceStart = 90 + index * 90;
    return {
      index: goalNumber,
      id: `goal_${goalNumber}`,
      sourceStart,
      shotStart: sourceStart + 10,
      finishTime: sourceStart + 14,
      confirmationTime: sourceStart + 22,
      sourceEnd: sourceStart + 24,
      duration: 24,
      timelineStart: index * 24,
      timelineEnd: (index + 1) * 24,
      goalNumber,
      highlightType: "goal",
      goalOutcome: {
        eventType: "goal",
        outcome: "confirmed_goal",
        offsideStatus: "onside",
        safeCaptionBadge: "Goal confirmed",
      },
      replayUsed: false,
      replayOnly: false,
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        visualGoalPayoff: {
          hasVisibleGoalPayoff: true,
          hasBallInNetEvidence: true,
          hasLiveFinishSequence: true,
          scoreboardOnly: false,
          evidenceCodes: ["visual_ball_in_net", "live_shot_finish_sequence", "scoreboard_goal_confirmation"],
        },
      },
      visualGoalGate: {
        passed: true,
        confidence: 1,
        failureCode: null,
        evidence: {
          hasBuildupFrames: true,
          hasShotFrames: true,
          hasGoalmouthFrames: true,
          hasPayoffFrames: true,
          hasConfirmationAfterFinish: true,
        },
        sampledFrames: [
          { label: "source_start", time: sourceStart },
          { label: "shot_start", time: sourceStart + 10 },
          { label: "finish", time: sourceStart + 14 },
          { label: "confirmation", time: sourceStart + 22 },
        ],
      },
      reasonCodes: [
        "goal",
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_goal_mouth",
        "visual_ball_in_net",
        "visual_scoreboard_goal_confirmed",
        "scoreboard_ocr_score_change",
      ],
      whySelected: "Confirmed counted goal selected from match truth.",
      safetyFlags: [],
    };
  });
  report.renderPlan = {
    ...report.renderPlan,
    mode: "multi_moment_compilation",
    highlightType: "goal",
    totalDuration: 72,
    segmentCount: 3,
    segments,
    goalSelectionMode: "valid_goals_only",
    countedGoalProof: {
      goalSelectionMode: "valid_goals_only",
      finalSegmentCount: 3,
      selectedTimelineWindows: segments.map((segment) => ({
        index: segment.index,
        sourceStart: segment.sourceStart,
        shotStart: segment.shotStart,
        finishTime: segment.finishTime,
        confirmationTime: segment.confirmationTime,
        sourceEnd: segment.sourceEnd,
        goalNumber: segment.goalNumber,
        highlightType: segment.highlightType,
        goalOutcome: segment.goalOutcome,
        replayUsed: segment.replayUsed,
        replayOnly: segment.replayOnly,
        phaseCoverage: segment.phaseCoverage,
        visualGoalGate: segment.visualGoalGate,
      })),
      detectedGoalCandidates: [],
      selectedValidGoals: segments.map((segment) => ({
        id: segment.id,
        type: "confirmed_goal",
        outcome: "confirmed_goal",
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
      })),
      scoreChangeAnchors: segments.map((segment, index) => ({
        id: `anchor_goal_${segment.goalNumber}`,
        scoreBefore: `${index}-0`,
        scoreAfter: `${index + 1}-0`,
        firstSeenAt: segment.confirmationTime - 2,
        confirmedAt: segment.confirmationTime,
        stableUntil: segment.confirmationTime + 8,
        reverted: false,
        confidence: 0.93,
        source: "scoreboard_ocr",
        roiId: "scorebug_broadcast_compact",
        layoutId: "broadcast-compact-score-only-v1",
        outcome: "counted_goal",
        selectedForRender: true,
        linkedEventType: "confirmed_goal",
        hasLiveAction: true,
        hasVisibleFinish: true,
        replayOnly: false,
        missingEvidence: [],
        evidenceCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
      })),
      excludedOffsideOrNoGoal: [],
      excludedUnknowns: [],
      summary: {
        confirmedGoalCount: 3,
        disallowedGoalCount: 0,
        possibleGoalCount: 0,
        lateConfirmedGoalCount: 1,
        scoreChangeAnchorsFound: 3,
        stableScoreChangeAnchorCount: 3,
        revertedScoreChangeAnchorCount: 0,
        anchorsLinkedToGoalPhaseCount: 3,
        anchorsMissingVisualSupportCount: 0,
      },
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    visualPolishQA: {
      contractVersion: 1,
      countedGoalsIncluded: 3,
      countedGoalRecall: 1,
      humanVisibleGoalsIncluded: 3,
      humanVisibleGoalRecall: 1,
      passedVisualGate: true,
      failedVisibleGoalSegments: [],
      replayOnlySegments: 0,
      replayOnlyGoalRate: 0,
      averageGoalSegmentDuration: 24,
      targetGoalSegmentDuration: 35,
      referenceMaxGoalSegmentDuration: 45,
      excessiveTailCount: 0,
      excessiveTailRate: 0,
      nonGoalFillerCount: 0,
      nonGoalFillerRate: 0,
      abruptCutRiskCount: 0,
      captionsAlignedCount: 5,
      captionsMisalignedCount: 0,
      actionBoundaryScore: 1,
      referencePacingScore: 1,
      visualPolishScore: 97,
      score: 0.97,
      referenceSimilarityNotes: ["chronological_multi_goal_sequence", "smooth_transitions_declared"],
    },
    renderPolishQA: renderPolishQA({
      renderStylePreset: "reference_football_multi_goal_v1",
      transitionRenderedCount: 2,
      hardCutFallbackCount: 0,
      transitions: [
        { fromSegmentId: "goal_1", toSegmentId: "goal_2", timelineStart: 24, type: "short_fade", transitionDurationSeconds: 0.4, renderedBy: "segment_fade_concat" },
        { fromSegmentId: "goal_2", toSegmentId: "goal_3", timelineStart: 48, type: "short_fade", transitionDurationSeconds: 0.4, renderedBy: "segment_fade_concat" },
      ],
      animatedCaptionCount: 5,
      dynamicWordCaptionCount: 5,
      overlayRenderedCount: 5,
      visualPolishScore: 100,
    }),
  };
  return report;
}

test("youtube live proof cleanup deletes only managed generated MP4 artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-live-cleanup-"));
  const manual = join(root, "manual-downloads");
  const data = join(root, "data", "renders");
  mkdirSync(manual, { recursive: true });
  mkdirSync(data, { recursive: true });
  const staleGenerated = join(manual, "shortsengine-youtube-dQw4w9WgXcQ-2026-06-20T11-23-53-191Z.mp4");
  const staleApproved = join(manual, "shortsengine-manual-approved-gxiRyFZXJV8-2026-06-20T10-20-00Z.mp4");
  const reference = join(manual, "shortsengine-youtube-short.mp4");
  const operatorFile = join(manual, "generated.mp4");
  const render = join(data, "render.mp4");
  for (const file of [staleGenerated, staleApproved, reference, operatorFile, render]) {
    writeFileSync(file, "mp4", "utf8");
  }

  assert.equal(isManagedLiveProofMp4("shortsengine-youtube-short.mp4"), false);
  assert.equal(isManagedLiveProofMp4("shortsengine-youtube-dQw4w9WgXcQ-2026-06-20T11-23-53-191Z.mp4"), true);
  const summary = cleanupGeneratedProofArtifacts({ rootDir: root });

  assert.equal(summary.directory, "manual-downloads");
  assert.equal(summary.deletedCount, 2);
  assert.equal(existsSync(staleGenerated), false);
  assert.equal(existsSync(staleApproved), false);
  assert.equal(existsSync(reference), true);
  assert.equal(existsSync(operatorFile), true);
  assert.equal(existsSync(render), true);
  assert.equal(summary.destructiveOutsideManualDownloads, false);
  rmSync(root, { recursive: true, force: true });
});

test("youtube live local e2e skips safely without explicit flag", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: {},
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
    runYouTubeSmoke: async () => {
      throw new Error("should not run smoke");
    },
  });
  assert.equal(report.status, "skipped");
  assert.equal(report.command, "youtube:proof");
  assert.equal(report.passed, false);
  assert.equal(report.skipped, true);
  assert.equal(report.phase, "skipped");
  assert.match(report.nextAction, /SHORTSENGINE_YOUTUBE_LIVE_E2E/);
  assert.match(report.triage.nextAction, /SHORTSENGINE_YOUTUBE_LIVE_E2E/);
  assert.equal(report.triage.preflight.ingestEnabled, false);
  assert.equal(report.checks[0].code, "YOUTUBE_LIVE_E2E_DISABLED");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube operator proof command skips safely by default", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    commandName: "youtube:proof:operator",
    env: {},
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.command, "youtube:proof:operator");
  assert.equal(report.status, "skipped");
  assert.equal(report.phase, "skipped");
  assert.equal(report.passed, false);
  assert.equal(report.skipped, true);
  assert.equal(serverStarted, false);
  assert.match(report.nextAction, /SHORTSENGINE_YOUTUBE_LIVE_E2E/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e runs env check before doctor or server work", async () => {
  const order = [];
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkEnvironment: () => {
      order.push("env");
      return {
        ok: true,
        youtubeIngest: {
          enabled: true,
          liveE2E: {
            enabled: true,
            rightsConfirmed: true,
            sourceConfigured: true,
            allowlistedSourceConfigured: false,
            allowUnlisted: true,
            portConfigured: false,
            timeoutMs: 900000,
          },
        },
      };
    },
    checkYouTubeIngest: async () => {
      order.push("doctor");
      return passedDoctor();
    },
    getFreePort: async () => {
      order.push("port");
      return 4175;
    },
    startServer: () => {
      order.push("server");
      return { child: { exitCode: null, signalCode: null }, events: [] };
    },
    stopServer: async () => {},
    waitForServerReady: async () => {
      order.push("ready");
      return { attempts: 2, waitedMs: 25, status: 200 };
    },
    runYouTubeSmoke: async () => {
      order.push("smoke");
      return passedSmokeReport();
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(report.passed, true);
  assert.equal(report.skipped, false);
  assert.deepEqual(order, ["env", "doctor", "port", "server", "ready", "smoke"]);
  assert.deepEqual(report.steps.map((step) => step.step), ["env", "fresh-output-cleanup", "doctor", "server", "server-ready", "smoke", "ffprobe"]);
  assert.equal(report.triage.preflight.sourceConfigured, true);
  assert.equal(report.triage.doctor.downloaderConfigured, true);
});

test("youtube live local e2e accepts default operator proof timeout", async () => {
  let doctorCalled = false;
  let smokeEnvReceived = null;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR: "1" }),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    checkEnvironment: () => ({
      ok: true,
      youtubeIngest: {
        enabled: true,
        liveE2E: {
          enabled: true,
          rightsConfirmed: true,
          sourceConfigured: true,
          allowlistedSourceConfigured: false,
          allowUnlisted: true,
          portConfigured: false,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
      },
    }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async ({ env }) => {
      smokeEnvReceived = env;
      return passedSmokeReport();
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(doctorCalled, true);
  assert.equal(smokeEnvReceived.SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS, "300000");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e env failures stop before doctor or server", async () => {
  let doctorCalled = false;
  let serverStarted = false;
  const error = Object.assign(new Error("Live YouTube E2E requires an authorized YouTube URL."), {
    code: "ENV_YOUTUBE_LIVE_E2E_URL_MISSING",
  });
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: "" }),
    checkEnvironment: () => {
      throw error;
    },
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_URL_MISSING");
  assert.equal(report.failedCases[0].phase, "env");
  assert.match(report.failedCases[0].nextAction, /SHORTSENGINE_YOUTUBE_LIVE_E2E_URL/);
  assert.equal(doctorCalled, false);
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects invalid operator download timeout before server", async () => {
  let doctorCalled = false;
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS: "999999999" }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_INVALID");
  assert.equal(report.failedCases[0].phase, "env");
  assert.match(report.failedCases[0].nextAction, /SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS/);
  assert.equal(doctorCalled, false);
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e requires ingest before proof work", async () => {
  let doctorCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "0" }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED");
  assert.equal(doctorCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e requires rights confirmation before server work", async () => {
  let doctorCalled = false;
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "0" }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED");
  assert.equal(doctorCalled, false);
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e requires a configured URL before server work", async () => {
  let doctorCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: "" }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_URL_MISSING");
  assert.equal(doctorCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects unsafe URL before doctor and server", async () => {
  let doctorCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: `${SAFE_URL}&list=PL123` }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_URL_INVALID");
  assert.equal(doctorCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects unallowlisted URL before doctor and server", async () => {
  let doctorCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({
      SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "0",
      SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS: "",
    }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_YOUTUBE_LIVE_E2E_URL_NOT_ALLOWED");
  assert.equal(doctorCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e fails safely when doctor is not ready", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => ({
      ok: false,
      status: "failed",
      code: "YOUTUBE_DOWNLOADER_MISSING",
      nextAction: "install-configure-downloader-or-set-SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN",
      youtubeIngest: { enabled: true, downloaderConfigured: false, ingestAvailable: false },
    }),
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "doctor");
  assert.equal(report.failedCases[0].code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(report.failedCases[0].phase, "doctor");
  assert.equal(report.triage.failedPhase, "doctor");
  assert.match(report.triage.nextAction, /downloader|SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN/);
  assert.equal(report.doctor.code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e reports server bind failures as environment limitations", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => {
      throw Object.assign(new Error("bind failed"), { code: "EPERM" });
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "server-bind");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED");
  assert.equal(report.failedCases[0].phase, "server-bind");
  assert.match(report.failedCases[0].nextAction, /restricted-sandbox|local-port/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e waits for server readiness before smoke", async () => {
  const order = [];
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => {
      order.push("server");
      return { child: { exitCode: null, signalCode: null }, events: [] };
    },
    waitForServerReady: async () => {
      order.push("ready");
      return { attempts: 3, waitedMs: 50, status: 200 };
    },
    runYouTubeSmoke: async () => {
      order.push("smoke");
      return passedSmokeReport();
    },
    stopServer: async () => {
      order.push("stop");
    },
  });
  assert.equal(report.status, "passed");
  assert.deepEqual(order, ["server", "ready", "smoke", "stop"]);
  const readyStep = report.steps.find((step) => step.step === "server-ready");
  assert.equal(readyStep.status, "passed");
  assert.equal(readyStep.attempts, 3);
  assert.equal(readyStep.waitedMs, 50);
  assert.equal(readyStep.httpStatus, 200);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e fails safely when server readiness times out", async () => {
  let smokeCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    waitForServerReady: async () => {
      throw Object.assign(new Error("local absolute path should not leak /Users/example"), {
        code: "YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT",
        details: { phase: "server-ready" },
      });
    },
    runYouTubeSmoke: async () => {
      smokeCalled = true;
      return passedSmokeReport();
    },
    stopServer: async () => {},
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "server-ready");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT");
  assert.equal(report.failedCases[0].phase, "server-ready");
  assert.equal(smokeCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e timeout preserves server progress context", async () => {
  let stopped = false;
  const progressEvent = {
    stream: "stdout",
    level: "info",
    event: "job_progress",
    progressMeta: {
      phase: "analysis",
      step: "run_scorebug_ocr",
      substep: "scorebug_first_chunk",
      longSource: true,
      scorebugFirst: true,
      budgetMs: 10000,
      chunkIndex: 4,
      chunkCount: 9,
      chunkStart: 270,
      chunkEnd: 360,
      scannedChunks: 3,
      discoveredScoreChanges: 2,
      elapsedMs: 8100,
      totalBudgetMs: 90000,
      chunkTimeoutMs: 10000,
      sampledFrameTimestamps: [276, 292, 318, 344],
      roiCandidateIds: [
        "scorebug_broadcast_compact",
        "scorebug_left_compact",
        "scoreboard_top_left",
        "scoreboard_top_center",
        "scoreboard_top_right",
      ],
    },
  };
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    timeoutMs: 1000,
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [progressEvent] }),
    stopServer: async () => {
      stopped = true;
    },
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => new Promise(() => {}),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.phase, "render");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_TIMEOUT");
  assert.equal(report.failedCases[0].step, "run_youtube_smoke");
  assert.equal(report.failedCases[0].substep, "job_lifecycle");
  assert.equal(report.logsDownloaded, false);
  assert.equal(report.artifactsDownloaded, false);
  assert.equal(stopped, true);
  assert.equal(report.serverEvents[0].progressMeta.step, "run_scorebug_ocr");
  assert.equal(report.currentJob.status, "processing");
  assert.equal(report.currentJob.progressMeta.chunkIndex, 4);
  assert.equal(report.currentJob.progressMeta.discoveredScoreChanges, 2);
  assert.equal(report.outputProof.outputMp4, null);
  assert.equal(report.outputProof.scoreboardOcrAttempted, true);
  assert.equal(report.outputProof.scoreboardOcrEnabled, true);
  assert.equal(report.outputProof.scoreboardOcrProviderMode, "chunked-scoreboard-ocr");
  assert.equal(report.outputProof.ocrChunkSummary.mode, "chunked_scorebug_first_ocr");
  assert.equal(report.outputProof.ocrChunkSummary.chunkCount, 9);
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].index, 4);
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].status, "active");
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].plannedFrameCount, 4);
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].attemptedRoiCount, 5);
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].attemptedObservationCount, 20);
  assert.equal(report.outputProof.scorebugDebug.attemptedRoiCount, 5);
  assert.equal(report.outputProof.scorebugDebug.reasonCodes.includes("scorebug_roi_candidates_attempted"), true);
  assert.equal(report.outputProof.logsDownloaded, false);
  assert.equal(report.outputProof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e failed OCR smoke preserves terminal job chunk summary", async () => {
  const currentJob = {
    id: "job_12345678",
    projectId: "prj_12345678",
    uploadId: "upl_12345678",
    status: "failed",
    progress: 28,
    step: "failed",
    exportId: null,
    progressMeta: {
      phase: "analysis",
      step: "run_scorebug_ocr",
      substep: "scorebug_first_chunk",
      longSource: true,
      scorebugFirst: true,
      budgetMs: 15000,
      chunkIndex: 1,
      chunkCount: 8,
      chunkStart: 0,
      chunkEnd: 90,
      scannedChunks: 0,
      discoveredScoreChanges: 0,
      elapsedMs: 1,
      totalBudgetMs: 120000,
      chunkTimeoutMs: 15000,
    },
    error: { code: "SCOREBOARD_OCR_TIMEOUT", message: "The video analysis failed." },
    scoreboardOcr: {
      providerMode: "chunked-scoreboard-ocr",
      fallbackUsed: true,
      confidence: 0,
      summary: {
        evidenceCount: 0,
        scoreChangeCount: 0,
        scoreRevertedCount: 0,
        ambiguousCount: 0,
        unreadableCount: 0,
        sampledFrameCount: 0,
        regionCount: 0,
        regionIdsUsed: [],
        preprocessingVariantCount: 0,
        chunkSummary: {
          mode: "chunked_scorebug_first_ocr",
          chunkCount: 8,
          scannedChunks: 0,
          skippedChunks: 8,
          timedOutChunks: 1,
          failedChunks: 0,
          scannedDurationSeconds: 0,
          discoveredScoreChanges: 0,
          totalBudgetMs: 120000,
          chunkTimeoutMs: 15000,
          chunks: [
            { index: 1, start: 0, end: 90, status: "timed_out", sampledFrameCount: 4, evidenceCount: 0, scoreChangeCount: 0, skippedReason: "SCOREBOARD_OCR_TIMEOUT", elapsedMs: 15000, timeoutMs: 15000 },
            { index: 2, start: 90, end: 180, status: "skipped", sampledFrameCount: 4, evidenceCount: 0, scoreChangeCount: 0, skippedReason: "SCOREBOARD_OCR_NOT_SCANNED", elapsedMs: 15000, timeoutMs: 0 },
          ],
        },
        scorebugDebug: {
          attemptedRoiCount: 0,
          attemptedObservationCount: 0,
          textPresentObservationCount: 0,
          readableObservationCount: 0,
          state: "scorebug_all_chunks_timed_out",
          nextAction: "inspect-scorebug-chunk-report-and-calibrate-roi-or-budgets",
          qaRecommended: true,
          reasonCodes: ["chunked_scorebug_first_ocr", "scorebug_chunk_timeout_recorded"],
        },
      },
    },
  };
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "5" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => ({
      status: "failed",
      source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
      steps: [{
        step: "failure",
        status: "failed",
        code: "SCOREBOARD_OCR_TIMEOUT",
        phase: "analysis",
        activeStep: "run_scorebug_ocr",
        substep: "scorebug_first_chunk",
      }],
      failedCases: [{
        name: "youtube_smoke",
        code: "SCOREBOARD_OCR_TIMEOUT",
        phase: "analysis",
        step: "run_scorebug_ocr",
        substep: "scorebug_first_chunk",
        timeoutMs: 15000,
        currentJob,
      }],
      jobLifecycle: [currentJob],
      renderPlan: null,
      export: null,
      generatedArtifact: null,
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "SCOREBOARD_OCR_TIMEOUT");
  assert.equal(report.failedCases[0].currentJob.progressMeta.chunkIndex, 1);
  assert.equal(report.currentJob.progressMeta.chunkCount, 8);
  assert.equal(report.outputProof.code, "SCOREBOARD_OCR_TIMEOUT");
  assert.equal(report.outputProof.ocrChunkSummary.mode, "chunked_scorebug_first_ocr");
  assert.equal(report.outputProof.ocrChunkSummary.chunkCount, 8);
  assert.equal(report.outputProof.ocrChunkSummary.totalBudgetMs, 120000);
  assert.equal(report.outputProof.ocrChunkSummary.chunks[0].status, "timed_out");
  assert.equal(report.outputProof.ocrChunkSummary.chunks[1].status, "skipped");
  assert.equal(report.outputProof.scorebugDebug.state, "scorebug_all_chunks_timed_out");
  assert.equal(report.outputProof.logsDownloaded, false);
  assert.equal(report.outputProof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects invalid configured port safely", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT: "99999" }),
    checkYouTubeIngest: async () => passedDoctor(),
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.phase, "env");
  assert.equal(report.failedCases[0].code, "ENV_NUMERIC_INVALID");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e mocked success wraps smoke proof without raw URL leakage", async () => {
  let stopped = false;
  let smokeEnvSeen = null;
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [{ event: "server_started", level: "info" }] }),
    stopServer: async () => {
      stopped = true;
    },
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async ({ env }) => {
      smokeEnvSeen = env;
      return passedSmokeReport();
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(report.command, "youtube:proof");
  assert.equal(report.passed, true);
  assert.equal(report.skipped, false);
  assert.equal(report.phase, "completed");
  assert.equal(report.source.videoId, VIDEO_ID);
  assert.equal(report.triage.failedPhase, null);
  assert.equal(report.triage.preflight.ingestEnabled, true);
  assert.equal(report.triage.preflight.rightsConfirmed, true);
  assert.equal(report.triage.preflight.sourceConfigured, true);
  assert.equal(report.triage.preflight.manualUnlistedGate, true);
  assert.equal(report.smoke.ids.projectId, "prj_12345678");
  assert.equal(report.smoke.export.contentType, "video/mp4");
  assert.equal(report.smoke.renderPlan.mode, "single_moment");
  assert.equal(report.generatedArtifact.relativePath, "manual-downloads/shortsengine-youtube-dQw4w9WgXcQ-test.mp4");
  assert.equal(report.generatedArtifact.downloadVerified, true);
  assert.equal(report.outputProof.source.videoId, VIDEO_ID);
  assert.equal(report.outputProof.outputMp4.relativePath, "manual-downloads/shortsengine-youtube-dQw4w9WgXcQ-test.mp4");
  assert.equal(report.outputProof.ffprobe.status, "missing");
  assert.equal(report.outputProof.countedGoalsFound, 0);
  assert.equal(report.outputProof.replayOnlySegments, 0);
  assert.equal(report.outputProof.visualPolishScore, 96);
  assert.equal(report.outputProof.renderStylePreset, "punchy_highlight");
  assert.equal(report.outputProof.transitionRenderedCount, 0);
  assert.equal(report.outputProof.animatedCaptionCount, 2);
  assert.equal(report.outputProof.overlayRenderedCount, 2);
  assert.equal(report.outputProof.renderPolishQA.captionMotion, "ass_word_by_word_highlight");
  assert.equal(report.outputProof.dynamicWordCaptionCount, 2);
  assert.equal(report.outputProof.abruptCutRiskCount, 0);
  assert.equal(report.outputProof.referenceStyleQA.captionsMisalignedCount, 0);
  assert.equal(report.outputProof.generatedVideoPath, "manual-downloads/shortsengine-youtube-dQw4w9WgXcQ-test.mp4");
  assert.equal(report.outputProof.staleArtifactCleanup.attempted, false);
  assert.equal(report.outputProof.comparison.ready, false);
  assert.deepEqual(report.steps.map((step) => step.step), ["env", "fresh-output-cleanup", "doctor", "server", "server-ready", "smoke", "ffprobe"]);
  assert.equal(stopped, true);
  assert.equal(smokeEnvSeen.SHORTSENGINE_YOUTUBE_SMOKE, "1");
  assert.equal(smokeEnvSeen.SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL, "http://127.0.0.1:4175");
  assert.equal(smokeEnvSeen.SHORTSENGINE_YOUTUBE_SMOKE_SAVE_DOWNLOAD, "1");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SAFE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e reports counted goal coverage and replay-only segment counts", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "3" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => countedGoalSmokeReport(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.outputProof.countedGoalsFound, 3);
  assert.equal(report.outputProof.countedGoalsIncluded, 3);
  assert.equal(report.outputProof.scoreChangeAnchors.length, 3);
  assert.equal(report.outputProof.scoreChangeAnchors[0].selectedForRender, true);
  assert.equal(report.outputProof.stableScoreChangeAnchorCount, 3);
  assert.equal(report.outputProof.anchorsMissingVisualSupportCount, 0);
  assert.equal(report.outputProof.humanVisibleGoalsIncluded, 3);
  assert.equal(report.outputProof.humanVisibleGoalRecall, 1);
  assert.equal(report.outputProof.passedVisualGate, true);
  assert.equal(report.outputProof.expectedCountedGoals, 3);
  assert.equal(report.outputProof.replayOnlySegments, 0);
  assert.equal(report.outputProof.nonGoalFillerRate, 0);
  assert.equal(report.outputProof.excessiveTailRate, 0);
  assert.equal(report.outputProof.referencePacingScore, 1);
  assert.equal(report.outputProof.visualPolishScore, 97);
  assert.equal(report.outputProof.renderStylePreset, "reference_football_multi_goal_v1");
  assert.equal(report.outputProof.transitionRenderedCount, 2);
  assert.equal(report.outputProof.hardCutFallbackCount, 0);
  assert.equal(report.outputProof.animatedCaptionCount, 5);
  assert.equal(report.outputProof.dynamicWordCaptionCount, 5);
  assert.equal(report.outputProof.overlayRenderedCount, 5);
  assert.equal(report.outputProof.renderPolishQA.transitions.length, 2);
  assert.equal(report.outputProof.abruptCutRiskCount, 0);
  assert.equal(report.outputProof.referenceStyleQA.countedGoalsExpected, 3);
  assert.equal(report.outputProof.segmentWindows.length, 3);
  assert.equal(report.outputProof.segmentWindows[0].shotStart, 100);
  assert.equal(report.outputProof.segmentWindows[0].phaseCoverage.hasBuildup, true);
  assert.equal(report.outputProof.segmentWindows[0].visualGoalGate.passed, true);
  assert.equal(report.outputProof.comparison.checklist.countedGoals, true);
  assert.equal(report.outputProof.comparison.checklist.humanVisibleGoals, true);
  assert.equal(report.outputProof.comparison.checklist.livePhaseVsReplayOnly, true);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e fails release proof when expected counted goals are missing", async () => {
  const smoke = countedGoalSmokeReport();
  smoke.renderPlan.segments = smoke.renderPlan.segments.slice(0, 2);
  smoke.renderPlan.segmentCount = 2;
  smoke.renderPlan.totalDuration = 48;
  smoke.renderPlan.countedGoalProof.finalSegmentCount = 2;
  smoke.renderPlan.countedGoalProof.selectedTimelineWindows =
    smoke.renderPlan.countedGoalProof.selectedTimelineWindows.slice(0, 2);
  smoke.renderPlan.visualPolishQA.countedGoalsIncluded = 2;

  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "3" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => smoke,
    requireOutputValidation: true,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.phase, "render");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_GOAL_COVERAGE_INCOMPLETE");
  assert.equal(report.outputProof.countedGoalsFound, 3);
  assert.equal(report.outputProof.countedGoalsIncluded, 2);
  assert.equal(report.outputProof.expectedCountedGoals, 3);
  assert.equal(report.outputProof.comparison.checklist.countedGoals, false);
  assert.equal(
    report.checks.some((check) => check.name === "youtube_live_e2e_counted_goal_coverage_complete" && check.passed === false),
    true,
  );
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e reports final output gate details when smoke fails before MP4", async () => {
  const videoOutputQA = failedVideoOutputQA();
  const failedSmoke = {
    ...passedSmokeReport(),
    status: "failed",
    failedCases: [{
      name: "youtube_smoke",
      code: "VIDEO_OUTPUT_QA_FAILED",
      message: "Final video output did not pass QA.",
      nextAction: "inspect-video-output-qa-missing-goals-and-fix-final-edit-plan-before-release",
      countedGoalEventCount: 3,
      actualConfirmedGoalSegmentCount: 2,
      coveredGoalCount: 2,
      missingGoalNumbers: [3],
      failedReasons: ["missing_or_invalid_counted_goal_segment"],
      videoOutputQA,
    }],
    jobLifecycle: [{
      id: "job_12345678",
      status: "failed",
      progress: 72,
      step: "failed",
      error: { code: "VIDEO_OUTPUT_QA_FAILED", message: "Final video output did not pass QA." },
      videoOutputQA,
    }],
    renderPlan: null,
    export: null,
    generatedArtifact: null,
  };

  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "3" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => failedSmoke,
    requireOutputValidation: true,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.phase, "render");
  assert.equal(report.failedCases[0].code, "VIDEO_OUTPUT_QA_FAILED");
  assert.equal(report.failedCases[0].countedGoalEventCount, 3);
  assert.equal(report.failedCases[0].actualConfirmedGoalSegmentCount, 2);
  assert.equal(report.failedCases[0].coveredGoalCount, 2);
  assert.deepEqual(report.failedCases[0].missingGoalNumbers, [3]);
  assert.deepEqual(report.failedCases[0].failedReasons, ["missing_or_invalid_counted_goal_segment"]);
  assert.equal(report.outputProof.outputMp4, null);
  assert.equal(report.outputProof.countedGoalsFound, 3);
  assert.equal(report.outputProof.countedGoalsIncluded, 2);
  assert.equal(report.outputProof.actualConfirmedGoalSegmentCount, 2);
  assert.equal(report.outputProof.coveredGoalCount, 2);
  assert.deepEqual(report.outputProof.missingGoalNumbers, [3]);
  assert.equal(report.outputProof.videoOutputQA.status, "failed");
  assert.equal(report.outputProof.ffprobe.code, "OUTPUT_MP4_NOT_CREATED");
  assert.equal(report.outputProof.logsDownloaded, false);
  assert.equal(report.outputProof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e fails release proof when counted goals are not human-visible", async () => {
  const smoke = countedGoalSmokeReport();
  smoke.renderPlan.segments[2].visualGoalGate = {
    passed: false,
    confidence: 0.4,
    failureCode: "NO_FINISH_VISIBLE",
    evidence: {
      hasBuildupFrames: true,
      hasShotFrames: true,
      hasGoalmouthFrames: false,
      hasPayoffFrames: false,
      hasConfirmationAfterFinish: true,
    },
    sampledFrames: [
      { label: "shot_start", time: 280 },
      { label: "finish", time: 284 },
    ],
  };
  smoke.renderPlan.countedGoalProof.selectedTimelineWindows[2].visualGoalGate = smoke.renderPlan.segments[2].visualGoalGate;
  smoke.renderPlan.visualPolishQA.humanVisibleGoalsIncluded = 2;
  smoke.renderPlan.visualPolishQA.humanVisibleGoalRecall = 0.6667;
  smoke.renderPlan.visualPolishQA.passedVisualGate = false;
  smoke.renderPlan.visualPolishQA.failedVisibleGoalSegments = [{
    index: 3,
    segmentId: "goal_3",
    failureCode: "NO_FINISH_VISIBLE",
    confidence: 0.4,
    evidence: smoke.renderPlan.segments[2].visualGoalGate.evidence,
    sampledFrames: smoke.renderPlan.segments[2].visualGoalGate.sampledFrames,
  }];

  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "3" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => smoke,
    requireOutputValidation: true,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.phase, "render");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_HUMAN_VISIBLE_GOAL_INCOMPLETE");
  assert.equal(report.outputProof.countedGoalsIncluded, 3);
  assert.equal(report.outputProof.humanVisibleGoalsIncluded, 2);
  assert.equal(report.outputProof.humanVisibleGoalRecall, 0.6667);
  assert.equal(report.outputProof.passedVisualGate, false);
  assert.equal(report.outputProof.failedVisibleGoalSegments[0].failureCode, "NO_FINISH_VISIBLE");
  assert.equal(report.outputProof.segmentWindows[2].visualGoalGate.failureCode, "NO_FINISH_VISIBLE");
  assert.equal(report.outputProof.comparison.checklist.countedGoals, true);
  assert.equal(report.outputProof.comparison.checklist.humanVisibleGoals, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live proof derives visual polish QA from public render summary when explicit QA is missing", async () => {
  const smoke = countedGoalSmokeReport();
  smoke.renderPlan.visualPolishQA = null;
  smoke.renderPlan.editAssembly = null;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "3" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => smoke,
  });

  assert.equal(report.status, "passed");
  assert.equal(report.outputProof.countedGoalsIncluded, 3);
  assert.equal(report.outputProof.replayOnlySegments, 0);
  assert.equal(report.outputProof.abruptCutRiskCount, 0);
  assert.equal(report.outputProof.captionsMisalignedCount, 0);
  assert.equal(report.outputProof.visualPolishScore, 100);
  assert.equal(report.outputProof.referenceStyleQA.visualPolishScore, 100);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e strict mode fails when generated MP4 is missing", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 10, status: 200 }),
    runYouTubeSmoke: async () => passedSmokeReport(),
    requireOutputValidation: true,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.phase, "download");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_OUTPUT_NOT_READY");
  assert.equal(report.failedCases[0].causeCode, "OUTPUT_MP4_MISSING");
  assert.equal(report.outputProof.ffprobe.status, "missing");
  assert.match(report.failedCases[0].nextAction, /generated-mp4|ffprobe/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e report writer creates stable safe latest report", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => passedSmokeReport(),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "shortsengine-youtube-live-e2e-"));
  const written = writeYouTubeLiveE2EReport(report, outputDir);
  const latestFile = join(outputDir, "youtube-live-e2e-latest.json");
  assert.equal(existsSync(latestFile), true);
  assert.equal(written.latestPath.endsWith("youtube-live-e2e-latest.json"), true);
  const persisted = JSON.parse(readFileSync(latestFile, "utf8"));
  assert.equal(persisted.status, "passed");
  assert.equal(findSensitiveLeak(persisted), null);
});

test("youtube live local e2e failure report keeps safe valid-goal discovery counts", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({
      child: { exitCode: null, signalCode: null },
      events: [{
        stream: "stdout",
        level: "info",
        event: "scoreboard_ocr_completed",
        scoreboardOcr: {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: true,
          sampledFrameCount: 4,
          evidenceCount: 0,
          scoreChangeCount: 0,
          scoreRevertedCount: 0,
          ambiguousCount: 0,
          unreadableCount: 1,
          regionIdsUsed: ["scorebug_left_compact", "broadcast_top_band"],
          preprocessingVariantCount: 3,
          qaReport: {
            enabled: true,
            runId: "ocr-scoreboard-test",
            status: "completed",
            reportPath: "demo/results/ocr-scoreboard-qa-test.json",
            latestPath: "demo/results/ocr-scoreboard-qa-latest.json",
            contactSheetPath: "demo/results/scoreboard-ocr-artifacts/ocr-scoreboard-test/contact-sheet.json",
            reviewPath: "demo/results/scoreboard-ocr-artifacts/ocr-scoreboard-test/review.html",
            cropCount: 2,
            attemptCount: 4,
          },
          scorebugDebug: {
            attemptedRoiCount: 2,
            attemptedObservationCount: 4,
            textPresentObservationCount: 4,
            readableObservationCount: 0,
            state: "scorebug_unreadable",
            nextAction: "enable-scoreboard-ocr-qa-artifacts-and-inspect-crops-for-wrong-roi-or-small-scorebug",
            qaRecommended: true,
            reasonCodes: ["score_not_readable", "no_stable_score_change", "roi_timeline_selected"],
            selectedRoi: {
              regionId: "scorebug_left_compact",
              layoutId: "broadcast-compact-score-only-v1",
              observationCount: 4,
              readableCount: 0,
              readableObservationCount: 0,
              scoreChangeCount: 0,
              revertedCount: 0,
              unchangedCount: 0,
              ambiguousCount: 0,
              diagnosis: "scorebug_unreadable",
              reasonCodes: ["score_not_readable", "no_stable_score_change"],
            },
            rejectedRois: [{
              regionId: "broadcast_top_band",
              layoutId: null,
              observationCount: 2,
              readableObservationCount: 0,
              scoreChangeCount: 0,
              diagnosis: "scorebug_unreadable",
              reasonCodes: ["lower_roi_score_than_selected", "score_not_readable"],
            }],
          },
          scoreTimeline: [{
            timestamp: 24.5,
            status: "score_unchanged",
            scoreBefore: "0-0",
            scoreAfter: "0-0",
            temporalConsistency: true,
          }],
        },
      }, {
        stream: "stdout",
        level: "info",
        event: "valid_goal_selection_empty",
        code: "NO_VALID_GOALS_FOUND",
        goalDiscovery: {
          sourceValidated: true,
          downloadedSourceReady: true,
          sourceDuration: 180,
          scoreboardOcrAttempted: true,
          scoreboardOcrEnabled: true,
          scoreboardOcrProviderMode: "mock-scoreboard-ocr",
          scoreboardObservationCount: 0,
          scoreboardSampledFrameCount: 4,
          scoreChangeCount: 0,
          stableScoreChangeCount: 0,
          scoreChangesFound: 0,
          chunksScanned: 0,
          countedGoalEventCount: 0,
          discoveredCountedGoals: 0,
          expectedCountedGoals: 3,
          visualWindowCount: 24,
          bucketCount: 7,
          lateBucketInspected: true,
          selectedValidGoalCount: 0,
          candidateCount: 3,
          rejectedCandidateCount: 3,
          topRejectionReasons: [{ reason: "goalmouth_or_finish_context", count: 1 }],
          excludedOffsideOrNoGoalCount: 2,
          excludedUnconfirmedBallInNetCount: 1,
          goalEvidenceEventCount: 3,
          validGoalEvidenceCount: 0,
          offsideOrNoGoalEvidenceCount: 2,
          celebrationOnlyEvidenceCount: 1,
          anthemOrIntroEvidenceCount: 1,
          ocrEvidenceCount: 2,
          scoreboardConfirmedGoalCount: 0,
          missingEvidenceByCandidate: [{
            index: 1,
            id: "non_goal_chance_1",
            outcomeHint: "non_goal_chance",
            start: 45.38,
            end: 59.38,
            missingEvidence: ["explicit_ball_in_net", "decision_or_reaction_confirmation"],
            rejectionReason: "goalmouth_or_finish_context",
          }],
          nextAction: "inspect-score-timeline-for-unreadable-or-ambiguous-scorebug",
        },
      }],
    }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => ({
      status: "failed",
      source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
      failedCases: [{
        name: "youtube_smoke",
        code: "NO_VALID_GOALS_FOUND",
        nextAction: "inspect-youtube-smoke-configuration",
      }],
    }),
  });

  assert.equal(report.status, "failed");
  const ocrEvent = report.serverEvents.find((item) => item.event === "scoreboard_ocr_completed");
  assert.ok(ocrEvent);
  const expectedScorebugDebug = {
    attemptedRoiCount: 2,
    attemptedObservationCount: 4,
    textPresentObservationCount: 4,
    readableObservationCount: 0,
    state: "scorebug_unreadable",
    nextAction: "enable-scoreboard-ocr-qa-artifacts-and-inspect-crops-for-wrong-roi-or-small-scorebug",
    qaRecommended: true,
    reasonCodes: ["score_not_readable", "no_stable_score_change", "roi_timeline_selected"],
    selectedRoi: {
      regionId: "scorebug_left_compact",
      layoutId: "broadcast-compact-score-only-v1",
      observationCount: 4,
      readableCount: 0,
      readableObservationCount: 0,
      scoreChangeCount: 0,
      revertedCount: 0,
      unchangedCount: 0,
      ambiguousCount: 0,
      diagnosis: "scorebug_unreadable",
      reasonCodes: ["score_not_readable", "no_stable_score_change"],
    },
    rejectedRois: [{
      regionId: "broadcast_top_band",
      layoutId: null,
      observationCount: 2,
      readableObservationCount: 0,
      scoreChangeCount: 0,
      diagnosis: "scorebug_unreadable",
      reasonCodes: ["lower_roi_score_than_selected", "score_not_readable"],
    }],
  };
  assert.deepEqual(ocrEvent.scoreboardOcr, {
    providerMode: "mock-scoreboard-ocr",
    fallbackUsed: true,
    sampledFrameCount: 4,
    evidenceCount: 0,
    scoreChangeCount: 0,
    scoreRevertedCount: 0,
    ambiguousCount: 0,
    unreadableCount: 1,
    regionIdsUsed: ["scorebug_left_compact", "broadcast_top_band"],
    preprocessingVariantCount: 3,
    chunkSummary: null,
    qaReport: {
      enabled: true,
      runId: "ocr-scoreboard-test",
      status: "completed",
      reportPath: "demo/results/ocr-scoreboard-qa-test.json",
      latestPath: "demo/results/ocr-scoreboard-qa-latest.json",
      contactSheetPath: "demo/results/scoreboard-ocr-artifacts/ocr-scoreboard-test/contact-sheet.json",
      reviewPath: "demo/results/scoreboard-ocr-artifacts/ocr-scoreboard-test/review.html",
      cropCount: 2,
      attemptCount: 4,
    },
    scorebugDebug: expectedScorebugDebug,
    scoreTimeline: [{
      timestamp: 24.5,
      status: "score_unchanged",
      scoreBefore: "0-0",
      scoreAfter: "0-0",
      temporalConsistency: true,
    }],
  });
  const event = report.serverEvents.find((item) => item.event === "valid_goal_selection_empty");
  assert.ok(event);
  assert.deepEqual(event.goalDiscovery, {
    sourceValidated: true,
    downloadedSourceReady: true,
    sourceDuration: 180,
    scoreboardOcrAttempted: true,
    scoreboardOcrEnabled: true,
    scoreboardOcrProviderMode: "mock-scoreboard-ocr",
    scoreboardObservationCount: 0,
    scoreboardSampledFrameCount: 4,
    scoreChangeCount: 0,
    stableScoreChangeCount: 0,
    scoreChangesFound: 0,
    chunksScanned: 0,
    countedGoalEventCount: 0,
    discoveredCountedGoals: 0,
    expectedCountedGoals: 3,
    visualWindowCount: 24,
    bucketCount: 7,
    lateBucketInspected: true,
    selectedValidGoalCount: 0,
    candidateCount: 3,
    rejectedCandidateCount: 3,
    topRejectionReasons: [{ reason: "goalmouth_or_finish_context", count: 1 }],
    excludedOffsideOrNoGoalCount: 2,
    excludedUnconfirmedBallInNetCount: 1,
    goalEvidenceEventCount: 3,
    validGoalEvidenceCount: 0,
    offsideOrNoGoalEvidenceCount: 2,
    celebrationOnlyEvidenceCount: 1,
    anthemOrIntroEvidenceCount: 1,
    ocrEvidenceCount: 2,
    scoreboardConfirmedGoalCount: 0,
    missingEvidenceByCandidate: [{
      index: 1,
      id: "non_goal_chance_1",
      outcomeHint: "non_goal_chance",
      start: 45.38,
      end: 59.38,
      missingEvidence: ["explicit_ball_in_net", "decision_or_reaction_confirmation"],
      rejectionReason: "goalmouth_or_finish_context",
    }],
    nextAction: "inspect-score-timeline-for-unreadable-or-ambiguous-scorebug",
  });
  assert.equal(report.outputProof.scoreboardOcrAttempted, true);
  assert.equal(report.outputProof.scoreboardOcrEnabled, true);
  assert.equal(report.outputProof.scoreboardObservationCount, 0);
  assert.equal(report.outputProof.scoreChangeCount, 0);
  assert.equal(report.outputProof.stableScoreChangeCount, 0);
  assert.equal(report.outputProof.countedGoalEventCount, 0);
  assert.deepEqual(report.outputProof.scoreChangeAnchors, []);
  assert.equal(report.outputProof.stableScoreChangeAnchorCount, null);
  assert.equal(report.outputProof.revertedScoreChangeAnchorCount, null);
  assert.equal(report.outputProof.anchorsLinkedToGoalPhaseCount, null);
  assert.equal(report.outputProof.anchorsMissingVisualSupportCount, null);
  assert.deepEqual(report.outputProof.scorebugDebug, expectedScorebugDebug);
  assert.deepEqual(report.outputProof.missingEvidenceByCandidate, [{
    index: 1,
    id: "non_goal_chance_1",
    outcomeHint: "non_goal_chance",
    start: 45.38,
    end: 59.38,
    missingEvidence: ["explicit_ball_in_net", "decision_or_reaction_confirmation"],
    rejectionReason: "goalmouth_or_finish_context",
  }]);
  assert.equal(report.outputProof.nextAction, "inspect-score-timeline-for-unreadable-or-ambiguous-scorebug");
  assert.equal(report.outputProof.goalDiscovery.selectedValidGoalCount, 0);
  assert.equal(report.outputProof.goalDiscovery.sourceValidated, true);
  assert.equal(report.outputProof.goalDiscovery.downloadedSourceReady, true);
  assert.equal(report.outputProof.goalDiscovery.candidateCount, 3);
  assert.equal(report.outputProof.goalDiscovery.rejectedCandidateCount, 3);
  assert.equal(report.outputProof.goalDiscovery.goalEvidenceEventCount, 3);
  assert.equal(report.outputProof.goalDiscovery.offsideOrNoGoalEvidenceCount, 2);
  assert.equal(report.outputProof.ffprobe.code, "OUTPUT_MP4_NOT_CREATED");
  assert.equal(report.outputProof.logsDownloaded, false);
  assert.equal(report.outputProof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live failed output proof preserves discovered and expected goal counts before render", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "5" }),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({
      child: { exitCode: null, signalCode: null },
      events: [{
        stream: "stdout",
        level: "info",
        event: "scoreboard_ocr_completed",
        scoreboardOcr: {
          providerMode: "chunked-scoreboard-ocr",
          fallbackUsed: false,
          sampledFrameCount: 44,
          evidenceCount: 5,
          scoreChangeCount: 5,
          scoreRevertedCount: 0,
          ambiguousCount: 12,
          unreadableCount: 0,
          regionIdsUsed: ["scorebug_broadcast_compact"],
          preprocessingVariantCount: 2,
          chunkSummary: {
            mode: "chunked_scorebug_first_ocr",
            chunkCount: 9,
            scannedChunks: 9,
            skippedChunks: 0,
            scannedDurationSeconds: 764.52,
            discoveredScoreChanges: 5,
            plannedFrameCount: 44,
            attemptedRoiCount: 5,
            attemptedObservationCount: 220,
            totalBudgetMs: 120000,
            chunkTimeoutMs: 14000,
            scoreCandidateDiagnostics: {
              mode: "chunked_score_candidate_progression",
              firstReadableChunk: 1,
              acceptedCount: 6,
              acceptedScoreChangeCount: 5,
              rejectedCount: 7,
              finalScore: "3-2",
              acceptedCandidates: [{
                chunkIndex: 1,
                timestamp: 42,
                score: "0-0",
                role: "initial_score_state",
                reasonCodes: ["initial_score_observed"],
              }, {
                chunkIndex: 2,
                timestamp: 123,
                scoreBefore: "0-0",
                scoreAfter: "1-0",
                role: "score_change_bridge",
                reasonCodes: ["score_candidate_progression", "cross_chunk_score_state_bridge"],
              }],
              rejectedCandidates: [{
                chunkIndex: 6,
                chunkStart: 450,
                chunkEnd: 540,
                score: "6-6",
                currentScore: "1-1",
                reason: "score_candidate_jump_too_large",
              }],
              reasonCodes: ["chunked_score_candidate_progression", "score_candidate_progression_evidence_added"],
            },
            chunks: [{
              index: 6,
              start: 450,
              end: 540,
              status: "completed",
              plannedFrameCount: 5,
              sampledFrameCount: 5,
              sampledFrameTimestamps: [462, 483, 506],
              roiCandidateIds: ["scorebug_broadcast_compact"],
              attemptedRoiCount: 1,
              attemptedObservationCount: 5,
              roiDetected: true,
              selectedRoiId: "scorebug_broadcast_compact",
              ocrTextCandidateCount: 5,
              evidenceCount: 0,
              scoreChangeCount: 0,
              textPresentObservationCount: 5,
              readableObservationCount: 5,
              clockOnlyObservationCount: 0,
              rejectedObservationCount: 0,
              stableScoreDecision: "candidate_progression_bridge",
              normalizedScoreCandidates: ["1-1", "4-1", "0-0", "6-6", "2-1"],
              rejectedScoreCandidateReasons: ["score_candidate_jump_too_large"],
            }],
          },
          scoreTimeline: [{
            timestamp: 123,
            status: "score_changed",
            scoreBefore: "0-0",
            scoreAfter: "1-0",
            temporalConsistency: true,
          }, {
            timestamp: 483,
            status: "score_changed",
            scoreBefore: "1-0",
            scoreAfter: "1-1",
            temporalConsistency: true,
          }, {
            timestamp: 506,
            status: "score_changed",
            scoreBefore: "1-1",
            scoreAfter: "2-1",
            temporalConsistency: true,
          }, {
            timestamp: 550,
            status: "score_changed",
            scoreBefore: "2-1",
            scoreAfter: "2-2",
            temporalConsistency: true,
          }, {
            timestamp: 558,
            status: "score_changed",
            scoreBefore: "2-2",
            scoreAfter: "3-2",
            temporalConsistency: true,
          }],
        },
      }, {
        stream: "stdout",
        level: "info",
        event: "valid_goal_selection_empty",
        code: "NO_VALID_GOALS_FOUND",
        goalDiscovery: {
          sourceValidated: true,
          downloadedSourceReady: true,
          sourceDuration: 764.52,
          scoreboardOcrAttempted: true,
          scoreboardOcrEnabled: true,
          scoreboardOcrProviderMode: "chunked-scoreboard-ocr",
          scoreboardObservationCount: 17,
          scoreboardSampledFrameCount: 44,
          scoreChangeCount: 5,
          stableScoreChangeCount: 5,
          scoreChangesFound: 5,
          chunksScanned: 9,
          countedGoalEventCount: 5,
          discoveredCountedGoals: 5,
          expectedCountedGoals: 0,
          visualWindowCount: 12,
          bucketCount: 8,
          selectedValidGoalCount: 0,
          candidateCount: 0,
          rejectedCandidateCount: 0,
          nextAction: "connect-stable-score-changes-to-live-action-windows-before-render",
        },
      }],
    }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => ({
      status: "failed",
      source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
      failedCases: [{
        name: "youtube_smoke",
        code: "NO_VALID_GOALS_FOUND",
        phase: "planning",
        step: "create_edit_plan",
        substep: "build_edit_plan",
        nextAction: "connect-stable-score-changes-to-live-action-windows-before-render",
      }],
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.outputProof.expectedCountedGoals, 5);
  assert.equal(report.outputProof.countedGoalsFound, 5);
  assert.equal(report.outputProof.scoreChangeCount, 5);
  assert.equal(report.outputProof.stableScoreChangeCount, 5);
  assert.equal(report.outputProof.countedGoalEventCount, 5);
  assert.equal(report.outputProof.goalDiscovery.discoveredCountedGoals, 5);
  assert.equal(report.outputProof.goalDiscovery.countedGoalEventCount, 5);
  assert.equal(report.outputProof.goalDiscovery.expectedCountedGoals, 5);
  assert.equal(report.outputProof.ocrChunkSummary.scoreCandidateDiagnostics.acceptedScoreChangeCount, 5);
  assert.equal(report.outputProof.ocrChunkSummary.scoreCandidateDiagnostics.finalScore, "3-2");
  assert.equal(
    report.outputProof.ocrChunkSummary.scoreCandidateDiagnostics.rejectedCandidates[0].reason,
    "score_candidate_jump_too_large",
  );
  assert.equal(report.outputProof.nextAction, "connect-stable-score-changes-to-live-action-windows-before-render");
  assert.equal(report.outputProof.ffprobe.code, "OUTPUT_MP4_NOT_CREATED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live failed output proof preserves pre-render download failure action", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({
      child: { exitCode: null, signalCode: null },
      events: [],
    }),
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    runYouTubeSmoke: async () => ({
      status: "failed",
      source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
      steps: [{
        step: "failure",
        status: "failed",
        code: "YOUTUBE_DOWNLOAD_FAILED",
        nextAction: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
        phase: "ingest",
        activeStep: "download_source",
        substep: "youtube_downloader",
      }],
      failedCases: [{
        name: "youtube_smoke",
        code: "YOUTUBE_DOWNLOAD_FAILED",
        message: "The YouTube ingest download failed safely.",
        nextAction: "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun",
        phase: "ingest",
        step: "download_source",
        substep: "youtube_downloader",
        safeMessage: "The YouTube ingest download failed safely.",
        failureReason: "download_failed",
        retryable: true,
        attempts: 2,
        attemptsConfigured: 2,
        timeoutMs: 120000,
        fallbackUsed: true,
        sourceAcquisitionStatus: "failed",
        stallClassification: "no_progress_timeout",
        heartbeatIntervalMs: 5000,
        noProgressTimeoutMs: 45000,
        progressHeartbeatCount: 18,
        progressEventCount: 2,
        progressBytesObserved: 8192,
        lastProgressAgeMs: 400,
        timeoutClassification: "DOWNLOAD_TIMED_OUT_WITH_PROGRESS",
        bytesStillMovingAtTimeout: true,
        continueEnabled: true,
        continueAttempted: true,
        resumableStateEnabled: false,
        resumeStateRetained: false,
        metadataPreflightStatus: "local",
        metadataPreflightDurationSeconds: 540,
        cleanupSucceeded: true,
        partialCleanupSucceeded: true,
        partialCleanupRemovedCount: 2,
        downloadedOutputReady: false,
      }],
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.outputProof.code, "YOUTUBE_DOWNLOAD_FAILED");
  assert.equal(report.outputProof.safeMessage, "The YouTube ingest download failed safely.");
  assert.equal(report.outputProof.ingest.safeMessage, "The YouTube ingest download failed safely.");
  assert.equal(report.outputProof.ingest.failureReason, "download_failed");
  assert.equal(report.failedCases[0].message, "The YouTube ingest download failed safely.");
  assert.equal(report.failedCases[0].safeMessage, "The YouTube ingest download failed safely.");
  assert.equal(report.failedCases[0].failureReason, "download_failed");
  assert.equal(report.failedCases[0].retryable, true);
  assert.equal(report.failedCases[0].attempts, 2);
  assert.equal(report.failedCases[0].progressBytesObserved, 8192);
  assert.equal(report.outputProof.phase, "ingest");
  assert.equal(report.outputProof.step, "download_source");
  assert.equal(report.outputProof.substep, "youtube_downloader");
  assert.equal(report.outputProof.ingest.attempts, 2);
  assert.equal(report.outputProof.ingest.attemptsConfigured, 2);
  assert.equal(report.outputProof.ingest.fallbackUsed, true);
  assert.equal(report.outputProof.ingest.sourceAcquisitionStatus, "failed");
  assert.equal(report.outputProof.ingest.stallClassification, "no_progress_timeout");
  assert.equal(report.outputProof.ingest.heartbeatIntervalMs, 5000);
  assert.equal(report.outputProof.ingest.noProgressTimeoutMs, 45000);
  assert.equal(report.outputProof.ingest.progressHeartbeatCount, 18);
  assert.equal(report.outputProof.ingest.progressEventCount, 2);
  assert.equal(report.outputProof.ingest.progressBytesObserved, 8192);
  assert.equal(report.outputProof.ingest.lastProgressAgeMs, 400);
  assert.equal(report.outputProof.ingest.timeoutClassification, "DOWNLOAD_TIMED_OUT_WITH_PROGRESS");
  assert.equal(report.outputProof.ingest.bytesStillMovingAtTimeout, true);
  assert.equal(report.outputProof.ingest.continueEnabled, true);
  assert.equal(report.outputProof.ingest.continueAttempted, true);
  assert.equal(report.outputProof.ingest.resumableStateEnabled, false);
  assert.equal(report.outputProof.ingest.resumeStateRetained, false);
  assert.equal(report.outputProof.ingest.metadataPreflightStatus, "local");
  assert.equal(report.outputProof.ingest.metadataPreflightDurationSeconds, 540);
  assert.equal(report.outputProof.ingest.cleanupSucceeded, true);
  assert.equal(report.outputProof.ingest.partialCleanupSucceeded, true);
  assert.equal(report.outputProof.ingest.partialCleanupRemovedCount, 2);
  assert.equal(report.outputProof.ingest.downloadedOutputReady, false);
  assert.equal(report.outputProof.ingest.outputMp4Created, false);
  assert.equal(report.failedCases[0].step, "download_source");
  assert.equal(report.failedCases[0].substep, "youtube_downloader");
  assert.equal(report.outputProof.outputMp4, null);
  assert.equal(report.outputProof.nextAction, "use-rights-cleared-local-mp4-proof-or-fix-downloader-and-rerun");
  assert.equal(report.outputProof.scoreboardOcrAttempted, false);
  assert.equal(report.outputProof.logsDownloaded, false);
  assert.equal(report.outputProof.artifactsDownloaded, false);
  assert.equal(findSensitiveLeak(report), null);
});
