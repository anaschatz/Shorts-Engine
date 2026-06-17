(function attachMatchCutsCore(global) {
  "use strict";

  const CONFIG = Object.freeze({
    appName: "ShortsEngine",
    maxUploadBytes: 250 * 1024 * 1024,
    minDurationSeconds: 1,
    maxDurationSeconds: 30 * 60,
    maxTitleLength: 120,
    maxFileNameLength: 160,
    maxYouTubeUrlLength: 2048,
    maxMoments: 20,
    metadataTimeoutMs: 7000,
    jobTimeoutMs: 8000,
    allowedExtensions: Object.freeze(["mp4", "mov", "webm"]),
    allowedMimeTypes: Object.freeze(["video/mp4", "video/quicktime", "video/webm"]),
    allowedLanguages: Object.freeze(["Ελληνικά", "English", "Spanish", "Arabic"]),
    allowedPresets: Object.freeze(["hype", "drama", "tactical", "fan"]),
    allowedRenderStylePresets: Object.freeze(["clean_sports", "social_sports_v1", "punchy_highlight"]),
    allowedRatios: Object.freeze(["vertical", "square", "auto"]),
    allowedStyleTargets: Object.freeze(["vertical_9_16", "square_1_1", "auto"]),
    allowedEditIntensities: Object.freeze(["clean", "balanced", "punchy"]),
    allowedExportTargets: Object.freeze(["tiktok", "reels", "shorts", "square"]),
    allowedHighlightTypes: Object.freeze([
      "goal",
      "shot_on_target",
      "near_miss",
      "big_chance",
      "save",
      "foul",
      "hard_foul",
      "card_moment",
      "counter_attack",
      "skill_move",
      "crowd_reaction",
      "commentator_peak",
      "replay_or_reaction",
      "replay_worthy_moment",
      "audio_energy_spike",
      "unknown_action",
      "generic_highlight",
    ]),
  });

  const JOB_STATUS = Object.freeze({
    QUEUED: "queued",
    PROCESSING: "processing",
    FAILED: "failed",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
  });

  const SAFE_MESSAGES = Object.freeze({
    UPLOAD_EMPTY: "Διάλεξε ένα αρχείο βίντεο πριν συνεχίσεις.",
    FILE_TOO_LARGE: "Το αρχείο είναι μεγαλύτερο από το επιτρεπτό όριο.",
    FILE_TOO_SMALL: "Το αρχείο είναι άδειο ή δεν μπορεί να διαβαστεί.",
    FILE_NAME_UNSAFE: "Το όνομα αρχείου δεν είναι ασφαλές.",
    FILE_TYPE_UNSUPPORTED: "Υποστηρίζονται μόνο MP4, MOV και WEBM αρχεία.",
    FILE_SIGNATURE_UNSUPPORTED: "Το αρχείο δεν φαίνεται να είναι έγκυρο MP4, MOV ή WEBM.",
    FILE_SIGNATURE_MISMATCH: "Το περιεχόμενο του αρχείου δεν ταιριάζει με τον τύπο που δηλώθηκε.",
    VIDEO_DURATION_INVALID: "Δεν μπορώ να διαβάσω αξιόπιστη διάρκεια για αυτό το βίντεο.",
    VIDEO_TOO_LONG: "Το βίντεο ξεπερνά το όριο των 30 λεπτών.",
    VIDEO_TOO_SHORT: "Το βίντεο είναι πολύ μικρό για ασφαλή ανάλυση.",
    METADATA_TIMEOUT: "Η ανάγνωση metadata άργησε υπερβολικά. Δοκίμασε άλλο αρχείο.",
    RIGHTS_REQUIRED: "Επιβεβαίωσε ότι έχεις δικαίωμα χρήσης του βίντεο.",
    TITLE_INVALID: "Ο τίτλος πρέπει να έχει 3 έως 120 χαρακτήρες.",
    PRESET_INVALID: "Το επιλεγμένο edit preset δεν είναι έγκυρο.",
    EXPORT_NOT_READY: "Πρέπει πρώτα να δημιουργηθεί ένα έγκυρο AI cut plan.",
    RATE_LIMITED: "Πάρα πολλές ενέργειες σε μικρό χρόνο. Περίμενε λίγο και ξαναδοκίμασε.",
    JOB_IN_PROGRESS: "Υπάρχει ήδη ενέργεια που τρέχει.",
    JOB_CANCELLED: "Η ενέργεια ακυρώθηκε.",
    JOB_TIMEOUT: "Η ενέργεια ξεπέρασε το χρονικό όριο.",
    AI_OUTPUT_INVALID: "Το AI output δεν πέρασε validation.",
    EXPORT_PAYLOAD_INVALID: "Το ολοκληρωμένο render δεν έχει έγκυρα στοιχεία export.",
    YOUTUBE_DURATION_TOO_LONG: "Το YouTube video ξεπερνά το όριο διάρκειας.",
    YOUTUBE_AGE_RESTRICTED: "Το YouTube video χρειάζεται age-gated ή authorized access.",
    YOUTUBE_AUTH_REQUIRED: "Το YouTube video χρειάζεται authorized access πριν γίνει ingest.",
    YOUTUBE_BOT_CHECK_REQUIRED: "Το YouTube μπλόκαρε το download με anti-bot check.",
    YOUTUBE_COOKIES_REQUIRED: "Αυτό το YouTube video χρειάζεται authorized browser/cookie import flow.",
    YOUTUBE_DOWNLOAD_FAILED: "Το YouTube ingest απέτυχε με ασφαλή τρόπο.",
    YOUTUBE_DOWNLOAD_TIMEOUT: "Το YouTube ingest άργησε πολύ και σταμάτησε.",
    YOUTUBE_DOWNLOADER_MISSING: "Ο YouTube downloader δεν είναι διαθέσιμος σε αυτό το περιβάλλον.",
    YOUTUBE_GEO_RESTRICTED: "Το YouTube video δεν είναι διαθέσιμο από αυτό το περιβάλλον.",
    YOUTUBE_INGEST_NOT_ENABLED: "Το YouTube ingest δεν είναι ακόμα ενεργό για render.",
    YOUTUBE_LIVE_UNSUPPORTED: "Τα YouTube live streams δεν υποστηρίζονται.",
    YOUTUBE_PLAYLIST_UNSUPPORTED: "Τα YouTube playlists δεν υποστηρίζονται.",
    YOUTUBE_RATE_LIMITED: "Το YouTube έκανε rate limit στο ingest. Δοκίμασε αργότερα.",
    YOUTUBE_RIGHTS_REQUIRED: "Επιβεβαίωσε ότι έχεις δικαίωμα χρήσης αυτού του YouTube video.",
    YOUTUBE_URL_INVALID: "Βάλε ένα έγκυρο YouTube video ή Shorts link.",
    YOUTUBE_VIDEO_PRIVATE: "Το YouTube video είναι private.",
    YOUTUBE_VIDEO_UNAVAILABLE: "Το YouTube video δεν είναι διαθέσιμο.",
    UNEXPECTED: "Κάτι πήγε στραβά. Δοκίμασε ξανά.",
  });

  class SafeAppError extends Error {
    constructor(code, message, details) {
      super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.UNEXPECTED);
      this.name = "SafeAppError";
      this.code = code || "UNEXPECTED";
      this.userMessage = message || SAFE_MESSAGES[this.code] || SAFE_MESSAGES.UNEXPECTED;
      this.details = details || null;
    }
  }

  function ok(data) {
    return { ok: true, data: data ?? null, error: null };
  }

  const YOUTUBE_AUTHORIZED_IMPORT_CODES = Object.freeze([
    "YOUTUBE_AGE_RESTRICTED",
    "YOUTUBE_AUTH_REQUIRED",
    "YOUTUBE_BOT_CHECK_REQUIRED",
    "YOUTUBE_COOKIES_REQUIRED",
  ]);

  function safeErrorDetails(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const safeDetails = {};
    for (const key of ["authorizedImportRequired", "ingestRisk", "metadataStatus", "nextAction", "retryable"]) {
      const value = details[key];
      if (typeof value === "boolean") safeDetails[key] = value;
      if (typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value)) safeDetails[key] = value;
    }
    return Object.keys(safeDetails).length ? safeDetails : null;
  }

  function fail(code, message, details) {
    const safeCode = code || "UNEXPECTED";
    const publicDetails = safeErrorDetails(details);
    return {
      ok: false,
      data: null,
      error: {
        code: safeCode,
        message: message || SAFE_MESSAGES[safeCode] || SAFE_MESSAGES.UNEXPECTED,
        ...(publicDetails || {}),
      },
    };
  }

  function errorFromUnknown(error, fallbackCode) {
    if (error && error.ok === false && error.error) return error;
    if (error instanceof SafeAppError) return fail(error.code, error.userMessage);
    return fail(fallbackCode || "UNEXPECTED");
  }

  function throwIfFailed(response) {
    if (!response || response.ok !== false) return response;
    throw new SafeAppError(response.error.code, response.error.message);
  }

  function sanitizeText(value, maxLength) {
    const text = String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, Math.max(0, maxLength || 160));
  }

  function sanitizeFileName(value) {
    const raw = sanitizeText(value, CONFIG.maxFileNameLength);
    const baseName = raw.split(/[\\/]/).pop() || "";
    const cleaned = baseName
      .replace(/[<>:"|?*]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, CONFIG.maxFileNameLength) || "untitled-video";
  }

  function getExtension(fileName) {
    const safeName = sanitizeFileName(fileName).toLowerCase();
    const dotIndex = safeName.lastIndexOf(".");
    if (dotIndex < 0 || dotIndex === safeName.length - 1) return "";
    return safeName.slice(dotIndex + 1);
  }

  function validateFileName(fileName) {
    const raw = String(fileName ?? "");
    if (!raw.trim()) return fail("FILE_NAME_UNSAFE");
    if (raw.length > CONFIG.maxFileNameLength) return fail("FILE_NAME_UNSAFE");
    if (/[\\/]/.test(raw)) return fail("FILE_NAME_UNSAFE");
    if (/[\u0000-\u001f\u007f]/.test(raw)) return fail("FILE_NAME_UNSAFE");

    const sanitizedName = sanitizeFileName(raw);
    const extension = getExtension(sanitizedName);
    if (!CONFIG.allowedExtensions.includes(extension)) return fail("FILE_TYPE_UNSUPPORTED");

    const lowerName = sanitizedName.toLowerCase();
    if (/\.(exe|js|mjs|html|svg|php|sh|bat|cmd|ps1)\./.test(lowerName)) {
      return fail("FILE_NAME_UNSAFE");
    }

    return ok({ sanitizedName, extension });
  }

  function validateUploadFile(fileLike) {
    if (!fileLike) return fail("UPLOAD_EMPTY");

    const nameResult = validateFileName(fileLike.name);
    if (!nameResult.ok) return nameResult;

    const size = Number(fileLike.size);
    if (!Number.isFinite(size) || size <= 0) return fail("FILE_TOO_SMALL");
    if (size > CONFIG.maxUploadBytes) return fail("FILE_TOO_LARGE");

    const mimeType = sanitizeText(fileLike.type, 80).toLowerCase();
    if (mimeType && !CONFIG.allowedMimeTypes.includes(mimeType)) {
      return fail("FILE_TYPE_UNSUPPORTED");
    }

    return ok({
      sanitizedName: nameResult.data.sanitizedName,
      extension: nameResult.data.extension,
      size,
      mimeType,
    });
  }

  function createProjectTitleCandidate(input) {
    const sourceTitle = sanitizeText(input && input.title, CONFIG.maxTitleLength);
    const rawFileName = sanitizeText(input && input.fileName, CONFIG.maxFileNameLength);
    let candidate = sourceTitle;
    if (!candidate && rawFileName) {
      const safeName = sanitizeFileName(rawFileName);
      const extension = getExtension(safeName);
      candidate = extension ? safeName.slice(0, -(extension.length + 1)) : safeName;
    }
    const title = sanitizeText(candidate, CONFIG.maxTitleLength)
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 3) return fail("TITLE_INVALID");
    return ok({ title });
  }

  function toByteArray(input) {
    if (!input) return new Uint8Array();
    if (input instanceof Uint8Array) return input;
    if (Array.isArray(input)) return new Uint8Array(input);
    if (input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return new Uint8Array();
  }

  function asciiFromBytes(bytes, start, end) {
    return Array.from(bytes.slice(start, end))
      .map((byte) => String.fromCharCode(byte))
      .join("");
  }

  function detectVideoContainer(headerBytes) {
    const bytes = toByteArray(headerBytes);
    if (bytes.length < 4) return null;

    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return "webm";
    }

    if (bytes.length >= 12 && asciiFromBytes(bytes, 4, 8) === "ftyp") {
      const brand = asciiFromBytes(bytes, 8, 12);
      if (brand === "qt  ") return "mov";
      return "mp4";
    }

    return null;
  }

  function validateVideoSignature(headerBytes, expectedExtension, mimeType) {
    const container = detectVideoContainer(headerBytes);
    if (!container) return fail("FILE_SIGNATURE_UNSUPPORTED");

    const extension = sanitizeText(expectedExtension, 12).toLowerCase();
    const normalizedMime = sanitizeText(mimeType, 80).toLowerCase();

    if (container === "webm" && extension !== "webm") return fail("FILE_SIGNATURE_MISMATCH");
    if (container !== "webm" && extension === "webm") return fail("FILE_SIGNATURE_MISMATCH");
    if (normalizedMime === "video/webm" && container !== "webm") return fail("FILE_SIGNATURE_MISMATCH");
    if (
      (normalizedMime === "video/mp4" || normalizedMime === "video/quicktime") &&
      container === "webm"
    ) {
      return fail("FILE_SIGNATURE_MISMATCH");
    }

    return ok({ container });
  }

  async function readBlobHeader(blob, bytesToRead) {
    if (!blob || typeof blob.slice !== "function") {
      throw new SafeAppError("UPLOAD_EMPTY");
    }
    const buffer = await blob.slice(0, bytesToRead || 32).arrayBuffer();
    return new Uint8Array(buffer);
  }

  function validateVideoDuration(durationSeconds) {
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration)) return fail("VIDEO_DURATION_INVALID");
    if (duration < CONFIG.minDurationSeconds) return fail("VIDEO_TOO_SHORT");
    if (duration > CONFIG.maxDurationSeconds) return fail("VIDEO_TOO_LONG");
    return ok({ durationSeconds: duration });
  }

  function youtubeUrlObject(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw.length > CONFIG.maxYouTubeUrlLength || /[\u0000-\u001f\u007f]/.test(raw)) {
      return fail("YOUTUBE_URL_INVALID");
    }
    try {
      return ok(new global.URL(raw));
    } catch {
      return fail("YOUTUBE_URL_INVALID");
    }
  }

  function normalizedHostname(hostname) {
    return String(hostname || "").toLowerCase().replace(/\.$/, "");
  }

  function youtubePathSegments(pathname) {
    return String(pathname || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  function normalizeYouTubeVideoId(value) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  }

  function normalizeYouTubeUrl(value) {
    const parsed = youtubeUrlObject(value);
    if (!parsed.ok) return parsed;
    const url = parsed.data;
    if (url.protocol !== "https:") return fail("YOUTUBE_URL_INVALID");
    if (url.username || url.password) return fail("YOUTUBE_URL_INVALID");
    const host = normalizedHostname(url.hostname);
    const segments = youtubePathSegments(url.pathname);
    if (url.searchParams.has("list") || segments[0] === "playlist") return fail("YOUTUBE_PLAYLIST_UNSUPPORTED");
    if (segments[0] === "live" || url.searchParams.get("live") === "1") return fail("YOUTUBE_LIVE_UNSUPPORTED");

    let kind = "";
    let videoId = "";
    if (host === "youtu.be") {
      kind = "shortlink";
      videoId = normalizeYouTubeVideoId(segments[0]);
    } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      if (segments.length === 0 || segments[0] === "watch") {
        kind = "watch";
        videoId = normalizeYouTubeVideoId(url.searchParams.get("v"));
      } else if (segments[0] === "shorts") {
        kind = "shorts";
        videoId = normalizeYouTubeVideoId(segments[1]);
      }
    }
    if (!videoId) return fail("YOUTUBE_URL_INVALID");
    return ok({
      sourceType: "youtube",
      kind,
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  function validateYouTubeSourceInput(input) {
    if (!input || input.rightsConfirmed !== true) return fail("YOUTUBE_RIGHTS_REQUIRED");
    return normalizeYouTubeUrl(input.url);
  }

  function hasUsableYouTubeUrl(value) {
    const raw = String(value ?? "").trim();
    return Boolean(raw && raw.length <= CONFIG.maxYouTubeUrlLength && !/[\u0000-\u001f\u007f]/.test(raw));
  }

  function createYouTubePreviewSummary(source, ingestAvailable) {
    const videoId = normalizeYouTubeVideoId(source && source.videoId);
    const kind = sanitizeText(source && source.kind, 24) || "watch";
    const warning = createYouTubeWarningMessage(source);
    return {
      sourceType: "youtube",
      kind,
      videoId: videoId || "unknown",
      label: `${kind} video - ${videoId || "unknown id"}`,
      status: warning || (ingestAvailable
        ? "Validated. Ingest is available for this environment."
        : "Validated. Ingest is unavailable in this environment."),
    };
  }

  function isAuthorizedImportRequired(value) {
    const code = sanitizeText(value && value.code, 80);
    return Boolean(
      value &&
        (value.authorizedImportRequired === true ||
          value.ingestRisk === "authorized-import-required" ||
          YOUTUBE_AUTHORIZED_IMPORT_CODES.includes(code)),
    );
  }

  function createYouTubeWarningMessage(source) {
    if (!source) return "";
    if (isAuthorizedImportRequired(source)) {
      return "Validated, but this video may need an authorized import flow before it can be downloaded.";
    }
    if (source.ingestRisk === "source-unavailable") {
      return "Validated URL, but this video may not be accessible for ingest from this environment.";
    }
    if (source.ingestRisk === "retry-later") {
      return "Validated URL, but ingest may need a retry later.";
    }
    return "";
  }

  function createYouTubeRecoveryMessage(error) {
    const response = error && error.ok === false ? error : fail(error && error.code, error && error.message, error);
    const details = response.error || {};
    if (isAuthorizedImportRequired(details)) {
      return `${details.message} Authorized import is not enabled yet, so use another public video or upload the MP4 fallback.`;
    }
    if (details.nextAction === "check-link-or-use-another-video") {
      return `${details.message} Check the link or use another video.`;
    }
    if (details.retryable === true) {
      return `${details.message} You can retry ingest or upload the MP4 fallback.`;
    }
    return details.message;
  }

  function deriveYouTubeUiState(input) {
    const sourceType = input && input.sourceType;
    const youtubeSource = sourceType === "youtube";
    const youtubeAction = sanitizeText(input && input.youtubeAction, 32) || "idle";
    const youtubeBusy = youtubeAction === "validating" || youtubeAction === "ingesting";
    const renderBusy = Boolean(input && input.renderBusy);
    const busy = Boolean(renderBusy || youtubeBusy);
    const urlReady = hasUsableYouTubeUrl(input && input.url);
    const rightsConfirmed = Boolean(input && input.rightsConfirmed);
    const validation = input && input.youtubeValidation;
    const validated = Boolean(validation && normalizeYouTubeVideoId(validation.videoId));
    const health = (input && input.youtubeHealth) || {};
    const ingestAvailable = Boolean(
      health.ready !== false &&
        health.enabled &&
        health.downloaderConfigured &&
        health.ingestAvailable,
    );
    const authorizedImportRequired = isAuthorizedImportRequired(validation);
    const ingestRisk = sanitizeText(validation && validation.ingestRisk, 80);
    const ingested = Boolean(youtubeSource && input && input.activeUpload && input.activeProject);
    const generated = Boolean(input && input.generated);
    const downloadReady = Boolean(generated && input && input.downloadUrl);

    return {
      youtubeSource,
      youtubeAction,
      youtubeBusy,
      renderBusy,
      busy,
      urlReady,
      rightsConfirmed,
      validated,
      ingestAvailable,
      ingestRisk,
      authorizedImportRequired,
      ingested,
      canValidate: Boolean(youtubeSource && !busy && urlReady && rightsConfirmed),
      canIngest: Boolean(youtubeSource && !busy && urlReady && rightsConfirmed && validated && ingestAvailable && !ingested),
      canGenerate: Boolean(!busy && (!youtubeSource || ingested)),
      canDownload: Boolean(!busy && downloadReady),
      status: youtubeBusy
        ? youtubeAction
        : ingested
          ? "ready_to_generate"
          : validated
            ? "validated"
            : "idle",
    };
  }

  function toBoundedInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeProjectSettings(input) {
    const title = sanitizeText(input && input.title, CONFIG.maxTitleLength);
    if (title.length < 3) return fail("TITLE_INVALID");

    const language = CONFIG.allowedLanguages.includes(input && input.language)
      ? input.language
      : CONFIG.allowedLanguages[0];
    const preset = CONFIG.allowedPresets.includes(input && input.preset) ? input.preset : "hype";
    const styleTarget = CONFIG.allowedStyleTargets.includes(input && input.styleTarget)
      ? input.styleTarget
      : "vertical_9_16";
    const editIntensity = CONFIG.allowedEditIntensities.includes(input && input.editIntensity)
      ? input.editIntensity
      : "balanced";
    const stylePreset = CONFIG.allowedRenderStylePresets.includes(input && input.stylePreset)
      ? input.stylePreset
      : "social_sports_v1";

    return ok({
      title,
      language,
      preset,
      styleTarget,
      editIntensity,
      stylePreset,
      pace: toBoundedInteger(input && input.pace, 20, 100, 72),
      motion: toBoundedInteger(input && input.motion, 0, 100, 64),
      captionsEnabled: Boolean(input && input.captionsEnabled),
      rightsConfirmed: Boolean(input && input.rightsConfirmed),
    });
  }

  function validateProjectForJob(settings, action) {
    const normalized = normalizeProjectSettings(settings);
    if (!normalized.ok) return normalized;
    if (!normalized.data.rightsConfirmed) return fail("RIGHTS_REQUIRED");
    if (action === "export" && !settings.generated) return fail("EXPORT_NOT_READY");
    return normalized;
  }

  function normalizeMoment(moment, index) {
    if (!moment || typeof moment !== "object") return null;
    const title = sanitizeText(moment.title, 120);
    const caption = sanitizeText(moment.caption, 120);
    if (!title || !caption) return null;

    return {
      time: sanitizeText(moment.time, 8) || `00:${String(index + 1).padStart(2, "0")}`,
      title,
      subtitle: sanitizeText(moment.subtitle, 180),
      score: sanitizeText(moment.score, 8) || "0%",
      caption,
      highlightType: CONFIG.allowedHighlightTypes.includes(moment.highlightType) ? moment.highlightType : "generic_highlight",
      stylePreset: sanitizeText(moment.stylePreset, 40) || "",
      framingMode: sanitizeText(moment.framingMode, 40) || "",
      reasons: Array.isArray(moment.reasons)
        ? moment.reasons.map((reason) => sanitizeText(reason, 40)).filter(Boolean).slice(0, 5)
        : [],
    };
  }

  function validateAiOutput(moments) {
    if (!Array.isArray(moments) || moments.length === 0) return fail("AI_OUTPUT_INVALID");
    const normalized = moments
      .slice(0, CONFIG.maxMoments)
      .map((moment, index) => normalizeMoment(moment, index))
      .filter(Boolean);
    if (normalized.length === 0) return fail("AI_OUTPUT_INVALID");
    return ok(normalized);
  }

  function validateExportId(value) {
    const safe = sanitizeText(value, 100);
    if (!/^exp_[A-Za-z0-9-]{8,80}$/.test(safe)) return fail("EXPORT_PAYLOAD_INVALID");
    return ok(safe);
  }

  function validateCompletedEditPlan(plan) {
    if (!plan || typeof plan !== "object") return fail("EXPORT_PAYLOAD_INVALID");
    const sourceStart = Number(plan.sourceStart);
    const sourceEnd = Number(plan.sourceEnd);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd <= sourceStart) {
      return fail("EXPORT_PAYLOAD_INVALID");
    }
    const duration = sourceEnd - sourceStart;
    if (!Array.isArray(plan.captions) || plan.captions.length === 0) {
      return fail("EXPORT_PAYLOAD_INVALID");
    }
    const captions = plan.captions
      .slice(0, 80)
      .map((caption) => ({
        start: Number(caption && caption.start),
        end: Number(caption && caption.end),
        text: sanitizeText(caption && caption.text, 140),
      }))
      .filter((caption) => (
        Number.isFinite(caption.start) &&
        Number.isFinite(caption.end) &&
        caption.start >= 0 &&
        caption.end <= duration + 0.25 &&
        caption.end > caption.start &&
        Boolean(caption.text)
      ));
    if (!captions.length) return fail("EXPORT_PAYLOAD_INVALID");
    return ok({
      ...plan,
      sourceStart,
      sourceEnd,
      captions,
    });
  }

  function validateCompletedJobForExport(job) {
    if (!job || typeof job !== "object" || job.status !== JOB_STATUS.COMPLETED) {
      return fail("EXPORT_NOT_READY");
    }
    const exportId = validateExportId(job.exportId);
    if (!exportId.ok) return exportId;
    const editPlan = validateCompletedEditPlan(job.editPlan);
    if (!editPlan.ok) return editPlan;
    return ok({
      exportId: exportId.data,
      editPlan: editPlan.data,
      candidatePlans: Array.isArray(job.candidatePlans) ? job.candidatePlans : [],
    });
  }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function createIdempotencyKey(action, payload) {
    const safeAction = sanitizeText(action, 32).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return `${safeAction || "job"}-${hashString(stableStringify(payload || {}))}`;
  }

  function createRequestId(prefix) {
    const randomPart =
      global.crypto && typeof global.crypto.getRandomValues === "function"
        ? Array.from(global.crypto.getRandomValues(new Uint8Array(6)))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
        : Math.random().toString(36).slice(2, 10);
    return `${prefix || "req"}_${Date.now().toString(36)}_${randomPart}`;
  }

  function createJob(action, idempotencyKey) {
    const now = new Date().toISOString();
    return {
      id: createRequestId(action || "job"),
      action,
      idempotencyKey,
      status: JOB_STATUS.QUEUED,
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function updateJob(job, status, patch) {
    if (!job) return null;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    Object.assign(job, patch || {});
    return job;
  }

  function createRateLimiter(options) {
    const limit = Math.max(1, Number(options && options.limit) || 1);
    const windowMs = Math.max(1000, Number(options && options.windowMs) || 60000);
    const now = (options && options.now) || (() => Date.now());
    const buckets = new Map();

    return {
      check(key) {
        const bucketKey = key || "default";
        const current = now();
        const previous = (buckets.get(bucketKey) || []).filter((stamp) => current - stamp < windowMs);
        if (previous.length >= limit) {
          return fail("RATE_LIMITED");
        }
        previous.push(current);
        buckets.set(bucketKey, previous);
        return ok({ remaining: limit - previous.length, resetAt: current + windowMs });
      },
      reset(key) {
        if (key) buckets.delete(key);
        else buckets.clear();
      },
    };
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new SafeAppError("JOB_CANCELLED"));
        return;
      }
      const timeout = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            reject(new SafeAppError("JOB_CANCELLED"));
          },
          { once: true },
        );
      }
    });
  }

  async function withTimeout(task, options) {
    const timeoutMs = Number(options && options.timeoutMs) || CONFIG.jobTimeoutMs;
    const signal = options && options.signal;
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new SafeAppError("JOB_TIMEOUT")), timeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve().then(() => task({ signal })), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function withRetry(task, options) {
    const retries = Math.max(0, Number(options && options.retries) || 0);
    const retryDelayMs = Math.max(0, Number(options && options.retryDelayMs) || 250);
    const signal = options && options.signal;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal && signal.aborted) throw new SafeAppError("JOB_CANCELLED");
      try {
        return await withTimeout(
          () => task({ attempt, signal }),
          { timeoutMs: options && options.timeoutMs, signal },
        );
      } catch (error) {
        lastError = error;
        const code = error instanceof SafeAppError ? error.code : "UNEXPECTED";
        if (attempt >= retries || code === "JOB_CANCELLED") throw error;
        await delay(retryDelayMs * (attempt + 1), signal);
      }
    }

    throw lastError || new SafeAppError("UNEXPECTED");
  }

  function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size)) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let unitIndex = 0;
    let value = size;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remaining = safeSeconds % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  const api = {
    CONFIG,
    JOB_STATUS,
    SAFE_MESSAGES,
    SafeAppError,
    ok,
    fail,
    errorFromUnknown,
    throwIfFailed,
    sanitizeText,
    sanitizeFileName,
    getExtension,
    validateFileName,
    validateUploadFile,
    createProjectTitleCandidate,
    detectVideoContainer,
    validateVideoSignature,
    readBlobHeader,
    validateVideoDuration,
    normalizeYouTubeUrl,
    validateYouTubeSourceInput,
    createYouTubePreviewSummary,
    createYouTubeRecoveryMessage,
    createYouTubeWarningMessage,
    deriveYouTubeUiState,
    toBoundedInteger,
    normalizeProjectSettings,
    validateProjectForJob,
    normalizeMoment,
    validateAiOutput,
    validateCompletedJobForExport,
    validateCompletedEditPlan,
    validateExportId,
    stableStringify,
    createIdempotencyKey,
    createRequestId,
    createJob,
    updateJob,
    createRateLimiter,
    delay,
    withTimeout,
    withRetry,
    formatBytes,
    formatDuration,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.MatchCutsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
