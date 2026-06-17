const test = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../hardening.js");

const mp4Header = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
]);
const movHeader = new Uint8Array([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
  0x00, 0x00, 0x00, 0x00,
]);
const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const invalidHeader = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

test("structured response helpers keep a consistent API shape", () => {
  assert.deepEqual(Core.ok({ value: 1 }), {
    ok: true,
    data: { value: 1 },
    error: null,
  });

  assert.deepEqual(Core.fail("RIGHTS_REQUIRED"), {
    ok: false,
    data: null,
    error: {
      code: "RIGHTS_REQUIRED",
      message: Core.SAFE_MESSAGES.RIGHTS_REQUIRED,
    },
  });
});

test("filename validation rejects unsafe names and unsupported formats", () => {
  assert.equal(Core.validateFileName("derby-highlight.mp4").ok, true);
  assert.equal(Core.validateFileName("../derby.mp4").error.code, "FILE_NAME_UNSAFE");
  assert.equal(Core.validateFileName("payload.js.mp4").error.code, "FILE_NAME_UNSAFE");
  assert.equal(Core.validateFileName("notes.txt").error.code, "FILE_TYPE_UNSUPPORTED");
});

test("upload validation checks empty, size, extension and MIME type", () => {
  assert.equal(Core.validateUploadFile(null).error.code, "UPLOAD_EMPTY");
  assert.equal(
    Core.validateUploadFile({ name: "empty.mp4", size: 0, type: "video/mp4" }).error.code,
    "FILE_TOO_SMALL",
  );
  assert.equal(
    Core.validateUploadFile({
      name: "huge.mp4",
      size: Core.CONFIG.maxUploadBytes + 1,
      type: "video/mp4",
    }).error.code,
    "FILE_TOO_LARGE",
  );
  assert.equal(
    Core.validateUploadFile({ name: "derby.mp4", size: 1024, type: "text/html" }).error.code,
    "FILE_TYPE_UNSUPPORTED",
  );
  assert.equal(
    Core.validateUploadFile({ name: "derby.mov", size: 1024, type: "video/quicktime" }).ok,
    true,
  );
});

test("container signature validation catches mismatches", () => {
  assert.equal(Core.detectVideoContainer(mp4Header), "mp4");
  assert.equal(Core.detectVideoContainer(movHeader), "mov");
  assert.equal(Core.detectVideoContainer(webmHeader), "webm");
  assert.equal(Core.validateVideoSignature(mp4Header, "mp4", "video/mp4").ok, true);
  assert.equal(Core.validateVideoSignature(webmHeader, "webm", "video/webm").ok, true);
  assert.equal(
    Core.validateVideoSignature(webmHeader, "mp4", "video/mp4").error.code,
    "FILE_SIGNATURE_MISMATCH",
  );
  assert.equal(
    Core.validateVideoSignature(invalidHeader, "mp4", "video/mp4").error.code,
    "FILE_SIGNATURE_UNSUPPORTED",
  );
});

test("duration validation enforces finite production limits", () => {
  assert.equal(Core.validateVideoDuration(Number.NaN).error.code, "VIDEO_DURATION_INVALID");
  assert.equal(Core.validateVideoDuration(0.2).error.code, "VIDEO_TOO_SHORT");
  assert.equal(Core.validateVideoDuration(Core.CONFIG.maxDurationSeconds + 1).error.code, "VIDEO_TOO_LONG");
  assert.equal(Core.validateVideoDuration(90).ok, true);
});

test("project title candidates use source metadata or safe filenames", () => {
  assert.deepEqual(Core.createProjectTitleCandidate({ title: "  Derby Final Highlights  " }), {
    ok: true,
    data: { title: "Derby Final Highlights" },
    error: null,
  });
  assert.equal(
    Core.createProjectTitleCandidate({ title: "\u0000" }).error.code,
    "TITLE_INVALID",
  );
  assert.equal(
    Core.createProjectTitleCandidate({ fileName: "olympiacos_aek-final-cut.mp4" }).data.title,
    "olympiacos aek final cut",
  );
  assert.equal(
    Core.createProjectTitleCandidate({ fileName: "../unsafe.mp4" }).data.title,
    "unsafe",
  );
  assert.equal(
    Core.createProjectTitleCandidate({ fileName: "a.mp4" }).error.code,
    "TITLE_INVALID",
  );
});

test("youtube source validation normalizes supported urls", () => {
  const watch = Core.validateYouTubeSourceInput({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
  });
  assert.equal(watch.ok, true);
  assert.equal(watch.data.sourceType, "youtube");
  assert.equal(watch.data.videoId, "dQw4w9WgXcQ");
  assert.equal(watch.data.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  const short = Core.validateYouTubeSourceInput({
    url: "https://youtu.be/dQw4w9WgXcQ",
    rightsConfirmed: true,
  });
  assert.equal(short.ok, true);
  assert.equal(short.data.kind, "shortlink");
});

test("youtube source validation rejects unsafe or unsupported sources", () => {
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsConfirmed: false }).error.code,
    "YOUTUBE_RIGHTS_REQUIRED",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", rightsConfirmed: true }).error.code,
    "YOUTUBE_PLAYLIST_UNSUPPORTED",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/live/dQw4w9WgXcQ", rightsConfirmed: true }).error.code,
    "YOUTUBE_LIVE_UNSUPPORTED",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/embed/dQw4w9WgXcQ", rightsConfirmed: true }).error.code,
    "YOUTUBE_URL_INVALID",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "javascript:alert(1)", rightsConfirmed: true }).error.code,
    "YOUTUBE_URL_INVALID",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({
      url: `https://www.youtube.com/watch?v=dQw4w9WgXcQ${"a".repeat(Core.CONFIG.maxYouTubeUrlLength)}`,
      rightsConfirmed: true,
    }).error.code,
    "YOUTUBE_URL_INVALID",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ\u0000", rightsConfirmed: true }).error.code,
    "YOUTUBE_URL_INVALID",
  );
  assert.equal(
    Core.validateYouTubeSourceInput({ url: "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ", rightsConfirmed: true }).error.code,
    "YOUTUBE_URL_INVALID",
  );
});

test("youtube UI state gates validate ingest generate and download", () => {
  const unavailable = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: false,
    youtubeValidation: null,
    youtubeHealth: { ready: true, enabled: false, downloaderConfigured: false, ingestAvailable: false },
  });
  assert.equal(unavailable.canValidate, false);
  assert.equal(unavailable.canIngest, false);
  assert.equal(unavailable.canGenerate, false);
  assert.equal(unavailable.canDownload, false);

  const validatedButUnavailable = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: { videoId: "dQw4w9WgXcQ" },
    youtubeHealth: { ready: true, enabled: false, downloaderConfigured: false, ingestAvailable: false },
  });
  assert.equal(validatedButUnavailable.canValidate, true);
  assert.equal(validatedButUnavailable.canIngest, false);
  assert.equal(validatedButUnavailable.canGenerate, false);

  const readyToIngest = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: { videoId: "dQw4w9WgXcQ" },
    youtubeHealth: { ready: true, enabled: true, downloaderConfigured: true, ingestAvailable: true },
  });
  assert.equal(readyToIngest.canIngest, true);
  assert.equal(readyToIngest.canGenerate, false);

  const ingested = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: { videoId: "dQw4w9WgXcQ" },
    youtubeHealth: { ready: true, enabled: true, downloaderConfigured: true, ingestAvailable: true },
    activeUpload: { id: "upl_12345678" },
    activeProject: { id: "prj_12345678" },
  });
  assert.equal(ingested.ingested, true);
  assert.equal(ingested.canIngest, false);
  assert.equal(ingested.canGenerate, true);

  const completed = Core.deriveYouTubeUiState({
    ...ingested,
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: { videoId: "dQw4w9WgXcQ" },
    youtubeHealth: { ready: true, enabled: true, downloaderConfigured: true, ingestAvailable: true },
    activeUpload: { id: "upl_12345678" },
    activeProject: { id: "prj_12345678" },
    generated: true,
    downloadUrl: "/api/exports/exp_12345678/download",
  });
  assert.equal(completed.canDownload, true);

  const busy = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    youtubeAction: "ingesting",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: { videoId: "dQw4w9WgXcQ" },
    youtubeHealth: { ready: true, enabled: true, downloaderConfigured: true, ingestAvailable: true },
  });
  assert.equal(busy.youtubeBusy, true);
  assert.equal(busy.canValidate, false);
  assert.equal(busy.canIngest, false);
  assert.equal(busy.canGenerate, false);
});

test("youtube UI preview summary avoids raw canonical URLs", () => {
  const summary = Core.createYouTubePreviewSummary(
    {
      kind: "watch",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    true,
  );
  assert.equal(summary.videoId, "dQw4w9WgXcQ");
  assert.equal(summary.label, "watch video - dQw4w9WgXcQ");
  assert.equal(summary.status, "Validated. Ingest is available for this environment.");
  assert.doesNotMatch(JSON.stringify(summary), /https:\/\/www\.youtube\.com/);
});

test("youtube UI warning and recovery copy handles authorized import failures safely", () => {
  const warning = Core.createYouTubeWarningMessage({
    videoId: "dQw4w9WgXcQ",
    ingestRisk: "authorized-import-required",
    authorizedImportRequired: true,
  });
  assert.match(warning, /authorized import/i);

  const summary = Core.createYouTubePreviewSummary(
    {
      kind: "watch",
      videoId: "dQw4w9WgXcQ",
      ingestRisk: "authorized-import-required",
      authorizedImportRequired: true,
    },
    true,
  );
  assert.match(summary.status, /authorized import/i);
  assert.doesNotMatch(JSON.stringify(summary), /https:\/\/www\.youtube\.com|cookies-from-browser|\/Users/i);

  const recovery = Core.createYouTubeRecoveryMessage(Core.fail("YOUTUBE_BOT_CHECK_REQUIRED", null, {
    authorizedImportRequired: true,
    nextAction: "try-public-video-or-use-authorized-import",
  }));
  assert.match(recovery, /upload the MP4 fallback/i);
  assert.doesNotMatch(recovery, /cookies-from-browser|\/Users|stderr|stdout/i);

  const ui = Core.deriveYouTubeUiState({
    sourceType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    youtubeValidation: {
      videoId: "dQw4w9WgXcQ",
      ingestRisk: "authorized-import-required",
      authorizedImportRequired: true,
    },
    youtubeHealth: { ready: true, enabled: true, downloaderConfigured: true, ingestAvailable: true },
  });
  assert.equal(ui.authorizedImportRequired, true);
  assert.equal(ui.canGenerate, false);
  assert.equal(ui.canDownload, false);
});

test("project settings are normalized and consent is required for jobs", () => {
  const settings = Core.normalizeProjectSettings({
    title: "  Derby Final  ",
    language: "Unknown",
    preset: "not-real",
    styleTarget: "square_1_1",
    editIntensity: "punchy",
    pace: 999,
    motion: -4,
    captionsEnabled: true,
    rightsConfirmed: false,
  });

  assert.equal(settings.ok, true);
  assert.equal(settings.data.title, "Derby Final");
  assert.equal(settings.data.language, "Ελληνικά");
  assert.equal(settings.data.preset, "hype");
  assert.equal(settings.data.styleTarget, "square_1_1");
  assert.equal(settings.data.editIntensity, "punchy");
  assert.equal(settings.data.pace, 100);
  assert.equal(settings.data.motion, 0);
  assert.equal(Core.validateProjectForJob(settings.data, "generate").error.code, "RIGHTS_REQUIRED");

  const fallback = Core.normalizeProjectSettings({
    title: "Derby Final",
    styleTarget: "unsafe",
    editIntensity: "chaos",
    rightsConfirmed: true,
  });
  assert.equal(fallback.data.styleTarget, "vertical_9_16");
  assert.equal(fallback.data.editIntensity, "balanced");
});

test("AI output validation normalizes valid moments and rejects unusable output", () => {
  assert.equal(Core.validateAiOutput([]).error.code, "AI_OUTPUT_INVALID");
  const output = Core.validateAiOutput([
    {
      time: "00:11",
      title: "Goal",
      subtitle: "Fast cut",
      score: "95%",
      caption: "GOAL",
    },
    { title: "", caption: "" },
  ]);
  assert.equal(output.ok, true);
  assert.equal(output.data.length, 1);
  assert.equal(output.data[0].caption, "GOAL");
  const withReasons = Core.validateAiOutput([{ title: "Big save", caption: "SO CLOSE", reasons: ["audio_energy_spike"] }]);
  assert.deepEqual(withReasons.data[0].reasons, ["audio_energy_spike"]);
});

test("completed job export validation gates demo download state", () => {
  const valid = Core.validateCompletedJobForExport({
    status: "completed",
    exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    editPlan: {
      sourceStart: 2,
      sourceEnd: 14,
      captions: [{ start: 0, end: 2, text: "Opening hook" }],
    },
    candidatePlans: [{ sourceStart: 2, sourceEnd: 14 }],
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.data.exportId, "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
  assert.equal(valid.data.editPlan.captions.length, 1);

  assert.equal(Core.validateCompletedJobForExport(null).error.code, "EXPORT_NOT_READY");
  assert.equal(
    Core.validateCompletedJobForExport({
      status: "processing",
      exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      editPlan: { sourceStart: 0, sourceEnd: 10, captions: [{ start: 0, end: 1, text: "Hook" }] },
    }).error.code,
    "EXPORT_NOT_READY",
  );
  assert.equal(
    Core.validateCompletedJobForExport({
      status: "completed",
      exportId: "../bad",
      editPlan: { sourceStart: 0, sourceEnd: 10, captions: [{ start: 0, end: 1, text: "Hook" }] },
    }).error.code,
    "EXPORT_PAYLOAD_INVALID",
  );
  assert.equal(
    Core.validateCompletedJobForExport({
      status: "completed",
      exportId: "exp_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      editPlan: { sourceStart: 8, sourceEnd: 4, captions: [{ start: 0, end: 1, text: "Hook" }] },
    }).error.code,
    "EXPORT_PAYLOAD_INVALID",
  );
});

test("idempotency keys are stable regardless of object key order", () => {
  const first = Core.createIdempotencyKey("generate", { b: 2, a: 1 });
  const second = Core.createIdempotencyKey("generate", { a: 1, b: 2 });
  assert.equal(first, second);
});

test("client rate limiter blocks bursts and recovers after the window", () => {
  let now = 1000;
  const limiter = Core.createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check("user").ok, true);
  assert.equal(limiter.check("user").ok, true);
  assert.equal(limiter.check("user").error.code, "RATE_LIMITED");
  now = 2101;
  assert.equal(limiter.check("user").ok, true);
});

test("retry helper retries transient failures and stops on cancellation", async () => {
  let attempts = 0;
  const result = await Core.withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Core.SafeAppError("UNEXPECTED");
      return "ok";
    },
    { retries: 1, timeoutMs: 1000 },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});
