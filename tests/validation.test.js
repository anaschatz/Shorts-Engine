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

test("project settings are normalized and consent is required for jobs", () => {
  const settings = Core.normalizeProjectSettings({
    title: "  Derby Final  ",
    language: "Unknown",
    preset: "not-real",
    pace: 999,
    motion: -4,
    captionsEnabled: true,
    rightsConfirmed: false,
  });

  assert.equal(settings.ok, true);
  assert.equal(settings.data.title, "Derby Final");
  assert.equal(settings.data.language, "Ελληνικά");
  assert.equal(settings.data.preset, "hype");
  assert.equal(settings.data.pace, 100);
  assert.equal(settings.data.motion, 0);
  assert.equal(Core.validateProjectForJob(settings.data, "generate").error.code, "RIGHTS_REQUIRED");
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
  const withReasons = Core.validateAiOutput([{ title: "Goal", caption: "GOAL", reasons: ["audio_peak"] }]);
  assert.deepEqual(withReasons.data[0].reasons, ["audio_peak"]);
});

test("completed job export validation gates demo download state", () => {
  const valid = Core.validateCompletedJobForExport({
    status: "completed",
    exportId: "exp_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    editPlan: {
      sourceStart: 2,
      sourceEnd: 14,
      captions: [{ start: 2, end: 4, text: "Opening hook" }],
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
