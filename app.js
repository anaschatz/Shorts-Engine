(() => {
  "use strict";

  const Core = window.MatchCutsCore;

  const PRESET_CAPTIONS = Object.freeze({
    hype: "Η ΦΑΣΗ ΠΟΥ ΑΝΕΒΑΣΕ ΤΗΝ ΕΝΤΑΣΗ",
    drama: "ΟΛΑ ΠΑΙΧΤΗΚΑΝ ΣΕ ΑΥΤΑ ΤΑ 3 ΔΕΥΤΕΡΟΛΕΠΤΑ",
    tactical: "Η ΚΙΝΗΣΗ ΠΟΥ ΑΝΟΙΞΕ ΟΛΗ ΤΗΝ ΑΜΥΝΑ",
    fan: "ΑΥΤΟ ΔΕΝ ΓΙΝΕΤΑΙ ΝΑ ΜΗΝ ΤΟ ΞΑΝΑΔΕΙΣ",
  });

  const DEFAULT_MOMENTS = [
    {
      time: "00:07",
      title: "Cold open: missed defender, instant pressure",
      subtitle: "Ξεκινά με το πιο έντονο frame για retention.",
      score: "92%",
      caption: PRESET_CAPTIONS.hype,
      stylePreset: "social_sports_v1",
    },
    {
      time: "00:13",
      title: "Assist angle with player tag",
      subtitle: "Auto zoom στο passing lane και nameplate animation.",
      score: "87%",
      caption: "Η ΠΑΣΑ ΠΟΥ ΕΣΠΑΣΕ ΤΗΝ ΑΜΥΝΑ",
      stylePreset: "social_sports_v1",
    },
    {
      time: "00:18",
      title: "Peak action beat",
      subtitle: "Beat pulse, safer framing και punch subtitle.",
      score: "98%",
      caption: "ΚΟΙΤΑ ΤΗΝ ΚΙΝΗΣΗ ΠΡΙΝ ΤΗ ΦΑΣΗ",
      stylePreset: "social_sports_v1",
    },
  ];

  const YOUTUBE_AUTO_VALIDATE_DELAY_MS = 650;

  const REQUIRED_SELECTORS = Object.freeze({
    momentList: "#momentList",
    captionPreview: "#captionPreview",
    generateBtn: "#generateBtn",
    retryBtn: "#retryBtn",
    cancelJobBtn: "#cancelJobBtn",
    exportBtn: "#exportBtn",
    saveBtn: "#saveBtn",
    clearBtn: "#clearBtn",
    toast: "#toast",
    sourceLocalBtn: "#sourceLocalBtn",
    sourceYoutubeBtn: "#sourceYoutubeBtn",
    localSourcePanel: "#localSourcePanel",
    youtubeSourcePanel: "#youtubeSourcePanel",
    youtubeUrlInput: "#youtubeUrlInput",
    youtubeRightsCheckbox: "#youtubeRightsCheckbox",
    validateYoutubeBtn: "#validateYoutubeBtn",
    ingestYoutubeBtn: "#ingestYoutubeBtn",
    youtubeIngestStatus: "#youtubeIngestStatus",
    youtubePreview: "#youtubePreview",
    youtubePreviewUrl: "#youtubePreviewUrl",
    youtubePreviewVideoId: "#youtubePreviewVideoId",
    youtubePreviewStatus: "#youtubePreviewStatus",
    youtubeWarning: "#youtubeWarning",
    youtubeError: "#youtubeError",
    youtubeRecoveryActions: "#youtubeRecoveryActions",
    retryYoutubeIngestBtn: "#retryYoutubeIngestBtn",
    useAnotherYoutubeBtn: "#useAnotherYoutubeBtn",
    uploadMp4FallbackBtn: "#uploadMp4FallbackBtn",
    videoInput: "#videoInput",
    fileLabel: "#fileLabel",
    uploadError: "#uploadError",
    videoPreview: "#videoPreview",
    syntheticPreview: "#syntheticPreview",
    phonePreview: "#phonePreview",
    projectStatus: "#projectStatus",
    momentCount: "#momentCount",
    shortCount: "#shortCount",
    paceRange: "#paceRange",
    motionRange: "#motionRange",
    paceValue: "#paceValue",
    motionValue: "#motionValue",
    captionsToggle: "#captionsToggle",
    timelineLabel: "#timelineLabel",
    rightsCheckbox: "#rightsCheckbox",
    matchTitle: "#matchTitle",
    languageSelect: "#languageSelect",
    errorPanel: "#errorPanel",
    jobProgress: "#jobProgress",
    jobStepLabel: "#jobStepLabel",
    jobProgressValue: "#jobProgressValue",
    jobProgressBar: "#jobProgressBar",
    downloadLink: "#downloadLink",
    reviewPanel: "#reviewPanel",
    reviewRegisterBtn: "#reviewRegisterBtn",
    reviewStatus: "#reviewStatus",
    reviewSummary: "#reviewSummary",
    reviewMetrics: "#reviewMetrics",
    reviewFailures: "#reviewFailures",
  });

  const state = {
    activeMoment: 0,
    activePreset: "hype",
    activeRatio: "vertical",
    activeIntensity: "balanced",
    activeStylePreset: "social_sports_v1",
    activeObjectUrl: null,
    activeUpload: null,
    activeProject: null,
    activeJob: null,
    sourceType: "local",
    youtubeAction: "idle",
    youtubeValidation: null,
    youtubeHealth: {
      ready: false,
      enabled: false,
      mode: "mock",
      networkCalls: false,
      downloaderConfigured: false,
      ingestAvailable: false,
      authorizedImportAvailable: false,
    },
    titleEdited: false,
    lastAutoTitle: "",
    pollTimer: null,
    generated: false,
    exportId: null,
    downloadUrl: null,
    review: {
      status: "idle",
      result: null,
      error: null,
    },
    moments: Core.validateAiOutput(DEFAULT_MOMENTS).data || [],
    rateLimiters: {
      generate: Core.createRateLimiter({ limit: 8, windowMs: 60 * 1000 }),
    },
  };

  let youtubeAutoValidateTimer = null;
  let youtubeValidationRequestId = 0;

  const els = resolveElements();
  if (!els) return;

  function resolveElements() {
    if (!Core) {
      renderFatalError("The hardening layer failed to load.");
      return null;
    }
    const resolved = {};
    const missing = [];
    Object.entries(REQUIRED_SELECTORS).forEach(([key, selector]) => {
      const element = document.querySelector(selector);
      if (!element) missing.push(selector);
      resolved[key] = element;
    });
    resolved.ratioButtons = Array.from(document.querySelectorAll(".segmented-control button"));
    resolved.presetButtons = Array.from(document.querySelectorAll(".preset"));
    resolved.intensityButtons = Array.from(document.querySelectorAll("[data-intensity]"));
    resolved.stylePresetButtons = Array.from(document.querySelectorAll("[data-style-preset]"));
    resolved.exportButtons = Array.from(document.querySelectorAll("[data-export-target]"));
    if (missing.length) {
      renderFatalError(`Missing required UI elements: ${missing.join(", ")}`);
      return null;
    }
    return resolved;
  }

  function renderFatalError(message) {
    const container = document.createElement("div");
    container.className = "fatal-error";
    container.setAttribute("role", "alert");
    container.textContent = message;
    document.body.replaceChildren(container);
    console.error("[ShortsEngine]", { message });
  }

  function createSvg(paths) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    paths.forEach((pathData) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      svg.appendChild(path);
    });
    return svg;
  }

  function setButtonContent(button, label, icon) {
    const nodes = [];
    if (icon === "bolt") nodes.push(createSvg(["M13 2 4 14h7l-1 8 10-13h-7z"]));
    if (icon === "download") nodes.push(createSvg(["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"]));
    if (icon === "check") nodes.push(createSvg(["M20 6 9 17l-5-5"]));
    nodes.push(document.createTextNode(label));
    button.replaceChildren(...nodes);
  }

  function setProjectStatus(status, label) {
    els.projectStatus.dataset.status = status;
    els.projectStatus.textContent = label;
  }

  function formatRenderStyleLabel(value) {
    const labels = {
      clean_sports: "Clean sports",
      social_sports_v1: "Social sports",
      punchy_highlight: "Punchy highlight",
    };
    return labels[value] || String(value || "Style").replace(/_/g, " ");
  }

  function showToast(message, kind = "info") {
    els.toast.className = `toast ${kind}`;
    els.toast.textContent = message;
    els.toast.classList.add("visible");
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => els.toast.classList.remove("visible"), 3200);
  }

  function clearError() {
    els.errorPanel.hidden = true;
    els.errorPanel.textContent = "";
    els.uploadError.hidden = true;
    els.uploadError.textContent = "";
    clearYouTubeFieldError();
    document.querySelector(".dropzone")?.classList.remove("invalid");
  }

  function clearYouTubeFieldError() {
    els.youtubeError.hidden = true;
    els.youtubeError.textContent = "";
    els.youtubeRecoveryActions.hidden = true;
    els.youtubeUrlInput.removeAttribute("aria-invalid");
  }

  function clearYouTubeWarning() {
    els.youtubeWarning.hidden = true;
    els.youtubeWarning.textContent = "";
  }

  function safeErrorResponse(error) {
    if (error && error.ok === false && error.error) return error;
    if (error instanceof Core.SafeAppError) return Core.fail(error.code, error.userMessage);
    if (error && error.code && error.message) return Core.fail(error.code, error.message);
    return Core.fail("UNEXPECTED");
  }

  function showSafeError(error, context) {
    const response = safeErrorResponse(error);
    els.errorPanel.hidden = false;
    els.errorPanel.textContent = `${response.error.message} (${response.error.code})`;
    showToast(response.error.message, response.error.code === "JOB_CANCELLED" ? "warning" : "error");
    console.error("[ShortsEngine]", { context, code: response.error.code });
    return response;
  }

  function showUploadError(error) {
    const response = showSafeError(error, "upload");
    els.uploadError.hidden = false;
    els.uploadError.textContent = response.error.message;
    document.querySelector(".dropzone")?.classList.add("invalid");
  }

  async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
      headers: options.body instanceof FormData ? {} : { "content-type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => Core.fail("UNEXPECTED"));
    if (!response.ok || !payload.ok) {
      throw payload && payload.error ? payload : Core.fail("UNEXPECTED");
    }
    return payload.data;
  }

  function readSettings(extra) {
    return Core.normalizeProjectSettings({
      title: els.matchTitle.value,
      language: els.languageSelect.value,
      preset: state.activePreset,
      styleTarget: styleTargetForRatio(state.activeRatio),
      editIntensity: state.activeIntensity,
      stylePreset: state.activeStylePreset,
      pace: els.paceRange.value,
      motion: els.motionRange.value,
      captionsEnabled: els.captionsToggle.checked,
      rightsConfirmed: state.sourceType === "youtube" ? els.youtubeRightsCheckbox.checked : els.rightsCheckbox.checked,
      ...(extra || {}),
    });
  }

  function styleTargetForRatio(ratio) {
    if (ratio === "square") return "square_1_1";
    if (ratio === "auto") return "auto";
    return "vertical_9_16";
  }

  function isBusy() {
    return state.activeJob && ["queued", "processing"].includes(state.activeJob.status);
  }

  function rightsConfirmedForActiveSource() {
    return state.sourceType === "youtube" ? els.youtubeRightsCheckbox.checked : els.rightsCheckbox.checked;
  }

  function canRegisterReview() {
    return Boolean(
      state.generated &&
      state.exportId &&
      state.activeProject &&
      state.activeJob &&
      state.activeJob.status === "completed" &&
      rightsConfirmedForActiveSource() &&
      !["registering", "registered"].includes(state.review.status),
    );
  }

  function currentYouTubeUiState() {
    return Core.deriveYouTubeUiState({
      sourceType: state.sourceType,
      youtubeAction: state.youtubeAction,
      youtubeValidation: state.youtubeValidation,
      youtubeHealth: state.youtubeHealth,
      activeUpload: state.activeUpload,
      activeProject: state.activeProject,
      generated: state.generated,
      downloadUrl: state.downloadUrl,
      renderBusy: isBusy(),
      url: els.youtubeUrlInput.value,
      rightsConfirmed: els.youtubeRightsCheckbox.checked,
    });
  }

  function invalidateYouTubeValidationRequest() {
    youtubeValidationRequestId += 1;
    return youtubeValidationRequestId;
  }

  function clearScheduledYouTubeAutoValidation() {
    window.clearTimeout(youtubeAutoValidateTimer);
    youtubeAutoValidateTimer = null;
  }

  function scheduleYouTubeAutoValidate() {
    clearScheduledYouTubeAutoValidation();
    const youtubeUi = currentYouTubeUiState();
    if (!youtubeUi.canValidate) return;
    const clientValidation = Core.validateYouTubeSourceInput({
      url: els.youtubeUrlInput.value,
      rightsConfirmed: els.youtubeRightsCheckbox.checked,
    });
    if (!clientValidation.ok) return;
    if (state.youtubeValidation?.canonicalUrl === clientValidation.data.canonicalUrl) return;
    const requestId = invalidateYouTubeValidationRequest();
    youtubeAutoValidateTimer = window.setTimeout(() => {
      handleYouTubeValidate({ automatic: true, requestId });
    }, YOUTUBE_AUTO_VALIDATE_DELAY_MS);
  }

  function updateActionStates() {
    const youtubeUi = currentYouTubeUiState();
    const busy = youtubeUi.busy;
    const youtubeSource = youtubeUi.youtubeSource;
    const showValidationFallback = youtubeSource && ["validating", "failed"].includes(state.youtubeAction);
    els.generateBtn.disabled = !youtubeUi.canGenerate;
    if (!busy && youtubeSource && !youtubeUi.ingested) {
      setButtonContent(els.generateBtn, "Ingest first", "bolt");
    } else if (!busy && !state.generated) {
      setButtonContent(els.generateBtn, "Generate shorts", "bolt");
    }
    els.cancelJobBtn.hidden = !isBusy();
    els.retryBtn.hidden = !(state.activeJob && state.activeJob.status === "failed");
    els.saveBtn.disabled = busy;
    els.clearBtn.disabled = busy;
    els.sourceLocalBtn.disabled = busy;
    els.sourceYoutubeBtn.disabled = busy;
    els.videoInput.disabled = busy || youtubeSource;
    els.youtubeUrlInput.disabled = busy || !youtubeSource;
    els.youtubeRightsCheckbox.disabled = busy || !youtubeSource;
    els.validateYoutubeBtn.hidden = !showValidationFallback;
    els.validateYoutubeBtn.disabled = state.youtubeAction === "validating" || !youtubeUi.canValidate;
    els.ingestYoutubeBtn.disabled = !youtubeUi.canIngest;
    els.retryYoutubeIngestBtn.disabled = !youtubeUi.canIngest;
    els.useAnotherYoutubeBtn.disabled = busy || !youtubeSource;
    els.uploadMp4FallbackBtn.disabled = busy;
    els.validateYoutubeBtn.textContent = state.youtubeAction === "validating" ? "Validating..." : "Retry validation";
    els.ingestYoutubeBtn.textContent = state.youtubeAction === "ingesting" ? "Ingesting..." : "Ingest video";
    els.youtubeSourcePanel.dataset.flowState = youtubeUi.status;
    els.exportBtn.disabled = !youtubeUi.canDownload;
    els.exportButtons.forEach((button) => {
      button.disabled = !youtubeUi.canDownload;
    });
    els.downloadLink.hidden = !youtubeUi.canDownload;
    els.reviewRegisterBtn.disabled = !canRegisterReview();
    setButtonContent(
      els.reviewRegisterBtn,
      state.review.status === "registering" ? "Registering..." : state.review.status === "registered" ? "Registered" : "Register",
      state.review.status === "registered" ? "check" : null,
    );
    els.momentList.setAttribute("aria-busy", busy ? "true" : "false");
    renderReviewPanel();
    renderYouTubeIngestStatus(youtubeUi);
  }

  function resetReviewState() {
    state.review = {
      status: "idle",
      result: null,
      error: null,
    };
    renderReviewPanel();
  }

  function formatReviewMetric(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    if (numeric <= 1) return `${Math.round(numeric * 100)}%`;
    return `${Math.round(numeric)}%`;
  }

  function reviewMetricLabel(key) {
    const labels = {
      noFalseGoalClaim: "No false goal",
      captionActionAlignment: "Caption/action",
      framingSafety: "Framing",
      aspectRatioCorrectness: "Aspect ratio",
      animationCueCoverage: "Animation cues",
      reviewerReadinessScore: "Reviewer ready",
    };
    return labels[key] || String(key || "Metric").replace(/([A-Z])/g, " $1").trim();
  }

  function renderReviewPanel() {
    const status = state.review.status;
    els.reviewPanel.dataset.status = status;
    els.reviewMetrics.hidden = true;
    els.reviewMetrics.replaceChildren();
    els.reviewFailures.hidden = true;
    els.reviewFailures.replaceChildren();

    if (status === "registering") {
      els.reviewStatus.textContent = "Registering draft";
      els.reviewSummary.textContent = "Preparing a local review draft from the completed render.";
      return;
    }

    if (status === "registered" && state.review.result) {
      const review = state.review.result.review || {};
      els.reviewStatus.textContent = review.passed ? "Review passed" : "Needs review";
      els.reviewSummary.textContent = `${Math.round(Number(review.overallScore) || 0)} overall score · ${review.nextAction || "Inspect review criteria."}`;
      els.reviewMetrics.hidden = false;
      Object.entries(review.metrics || {}).forEach(([key, value]) => {
        const item = document.createElement("div");
        item.className = "review-metric";
        const label = document.createElement("span");
        label.textContent = reviewMetricLabel(key);
        const score = document.createElement("strong");
        score.textContent = formatReviewMetric(value);
        item.append(label, score);
        els.reviewMetrics.appendChild(item);
      });
      const failures = [...(review.failedCriteria || []), ...(review.failedCases || [])].slice(0, 6);
      if (failures.length) {
        els.reviewFailures.hidden = false;
        failures.forEach((failure) => {
          const item = document.createElement("p");
          item.textContent = failure.note || failure.message || failure.metric || failure.code || "Review criterion needs attention.";
          els.reviewFailures.appendChild(item);
        });
      }
      return;
    }

    if (status === "failed" && state.review.error) {
      els.reviewStatus.textContent = "Review not registered";
      els.reviewSummary.textContent = state.review.error.message || "This render cannot be registered for local review. Rerun a local render or use a future cloud review adapter.";
      return;
    }

    if (state.generated && state.exportId) {
      els.reviewStatus.textContent = rightsConfirmedForActiveSource() ? "Ready for review" : "Confirm rights";
      els.reviewSummary.textContent = rightsConfirmedForActiveSource()
        ? "Register this completed render as a local review draft."
        : "Confirm footage rights before registering this render for review.";
      return;
    }

    els.reviewStatus.textContent = "Waiting for render";
    els.reviewSummary.textContent = "A completed render with rights confirmation can be registered for local review.";
  }

  function resetVideoPreview() {
    if (state.activeObjectUrl) URL.revokeObjectURL(state.activeObjectUrl);
    state.activeObjectUrl = null;
    els.videoPreview.removeAttribute("src");
    els.videoPreview.hidden = true;
    els.syntheticPreview.hidden = false;
  }

  function clearYouTubeValidation(options = {}) {
    state.youtubeValidation = null;
    state.youtubeAction = "idle";
    els.youtubePreview.hidden = true;
    els.youtubePreviewVideoId.textContent = "Pending";
    els.youtubePreviewUrl.textContent = "";
    els.youtubePreviewStatus.textContent = "Ingest disabled until an MP4 artifact exists.";
    clearYouTubeWarning();
    if (options.clearInput) {
      els.youtubeUrlInput.value = "";
      els.youtubeRightsCheckbox.checked = false;
    }
  }

  function clearYouTubeProjectState() {
    resetRenderState();
    state.activeUpload = null;
    state.activeProject = null;
    clearYouTubeValidation();
    resetFileInput();
    setProjectStatus("draft", "URL source");
  }

  function syncSourcePanels() {
    const youtubeSource = state.sourceType === "youtube";
    els.sourceLocalBtn.classList.toggle("active", !youtubeSource);
    els.sourceYoutubeBtn.classList.toggle("active", youtubeSource);
    els.sourceLocalBtn.setAttribute("aria-pressed", youtubeSource ? "false" : "true");
    els.sourceYoutubeBtn.setAttribute("aria-pressed", youtubeSource ? "true" : "false");
    els.localSourcePanel.hidden = youtubeSource;
    els.youtubeSourcePanel.hidden = !youtubeSource;
  }

  function selectSource(type) {
    const nextType = type === "youtube" ? "youtube" : "local";
    if (state.sourceType === nextType) return;
    clearError();
    resetRenderState();
    state.sourceType = nextType;
    if (nextType === "youtube") {
      state.activeUpload = null;
      state.activeProject = null;
      resetVideoPreview();
      resetFileInput();
      setProjectStatus("draft", "URL source");
      refreshYouTubeHealth();
    } else {
      clearYouTubeValidation();
      setProjectStatus("draft", state.activeProject ? "Uploaded" : "Draft");
    }
    syncSourcePanels();
    updateActionStates();
  }

  function renderYouTubePreview(source) {
    const summary = Core.createYouTubePreviewSummary(source, state.youtubeHealth.ingestAvailable);
    els.youtubePreview.hidden = false;
    els.youtubePreviewVideoId.textContent = summary.videoId;
    els.youtubePreviewUrl.textContent = summary.label;
    els.youtubePreviewStatus.textContent = summary.status;
    renderYouTubeWarning(source);
  }

  function renderYouTubeWarning(source) {
    const warning = Core.createYouTubeWarningMessage(source);
    els.youtubeWarning.hidden = !warning;
    els.youtubeWarning.textContent = warning;
  }

  function renderYouTubeIngestStatus(uiState) {
    const health = state.youtubeHealth || {};
    const ready = Boolean(uiState ? uiState.ingestAvailable : health.ingestAvailable);
    els.youtubeIngestStatus.dataset.ready = ready ? "true" : "false";
    if (state.youtubeAction === "validating") {
      els.youtubeIngestStatus.textContent = "Validating YouTube source...";
    } else if (state.youtubeAction === "ingesting") {
      els.youtubeIngestStatus.textContent = "Ingesting authorized YouTube source into a local MP4 artifact...";
    } else if (uiState && uiState.ingested) {
      els.youtubeIngestStatus.textContent = "YouTube source ingested. Generate shorts is ready.";
    } else if (state.youtubeAction === "failed") {
      els.youtubeIngestStatus.textContent = "Ingest failed safely. Use retry, another link, or MP4 fallback.";
    } else if (uiState && uiState.urlReady && !uiState.rightsConfirmed) {
      els.youtubeIngestStatus.textContent = "Confirm rights to auto-validate this YouTube URL.";
    } else if (uiState && uiState.urlReady && uiState.rightsConfirmed && !uiState.validated) {
      els.youtubeIngestStatus.textContent = "Ready. Auto-validates after typing stops.";
    } else if (ready) {
      els.youtubeIngestStatus.textContent = "YouTube ingest is enabled. URL validation runs automatically.";
    } else if (health.enabled && !health.downloaderConfigured) {
      els.youtubeIngestStatus.textContent = "YouTube ingest is enabled but the downloader is unavailable.";
    } else {
      els.youtubeIngestStatus.textContent = "YouTube ingest is disabled by default. URL validation still works.";
    }
  }

  function showYouTubeError(error, context = "youtube-validate") {
    const response = showSafeError(error, context);
    els.youtubeError.hidden = false;
    els.youtubeError.textContent = `${Core.createYouTubeRecoveryMessage(response)} (${response.error.code})`;
    els.youtubeRecoveryActions.hidden = false;
    els.youtubeUrlInput.setAttribute("aria-invalid", "true");
    return response;
  }

  async function refreshYouTubeHealth() {
    try {
      const data = await apiFetch("/health");
      state.youtubeHealth = data.youtubeIngest || state.youtubeHealth;
    } catch {
      state.youtubeHealth = {
        ready: false,
        enabled: false,
        mode: "unknown",
        networkCalls: false,
        downloaderConfigured: false,
        ingestAvailable: false,
        authorizedImportAvailable: false,
      };
    } finally {
      if (state.youtubeValidation) renderYouTubePreview(state.youtubeValidation);
      scheduleYouTubeAutoValidate();
      renderYouTubeIngestStatus();
      updateActionStates();
    }
  }

  function updateProgress(job) {
    els.jobProgress.hidden = !job;
    const progress = Math.max(0, Math.min(100, Number(job && job.progress) || 0));
    els.jobProgressValue.textContent = `${progress}%`;
    els.jobProgressBar.style.width = `${progress}%`;
    els.jobStepLabel.textContent = formatJobStep(job && job.step);
  }

  function formatJobStep(step) {
    const labels = {
      queued: "Queued",
      extract_audio: "Extracting audio",
      analyze_media: "Analyzing media signals",
      extract_sampled_frames: "Sampling vision frames",
      analyze_visuals: "Analyzing visual context",
      transcribe: "Transcribing commentary",
      detect_highlights: "Detecting highlights",
      plan_story: "Planning football story",
      create_edit_plan: "Creating edit plans",
      render_short: "Rendering short",
      render_kinetic_captions: "Composing kinetic captions",
      render_beat_effects: "Applying beat effects",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    return labels[step] || "Waiting";
  }

  function renderMoments() {
    els.momentList.replaceChildren();
    const validated = Core.validateAiOutput(state.moments);
    if (!validated.ok) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Δεν υπάρχει έγκυρο AI cut plan ακόμα.";
      els.momentList.appendChild(empty);
      return;
    }
    validated.data.forEach((moment, index) => {
      const button = document.createElement("button");
      button.className = `moment-card${index === state.activeMoment ? " active" : ""}`;
      button.type = "button";
      button.setAttribute("aria-pressed", index === state.activeMoment ? "true" : "false");
      const time = document.createElement("span");
      time.className = "moment-time";
      time.textContent = moment.time;
      const copy = document.createElement("span");
      copy.className = "moment-copy";
      const title = document.createElement("strong");
      title.textContent = moment.title;
      const subtitle = document.createElement("span");
      subtitle.textContent = moment.subtitle;
      copy.append(title, subtitle);
      if ((Array.isArray(moment.reasons) && moment.reasons.length) || moment.highlightType || moment.stylePreset) {
        const reasons = document.createElement("span");
        reasons.className = "reason-row";
        if (moment.highlightType) {
          const typeChip = document.createElement("small");
          typeChip.className = "reason-chip highlight-chip";
          typeChip.textContent = moment.highlightType.replace(/_/g, " ");
          reasons.appendChild(typeChip);
        }
        if (moment.stylePreset) {
          const styleChip = document.createElement("small");
          styleChip.className = "reason-chip style-chip";
          styleChip.textContent = formatRenderStyleLabel(moment.stylePreset);
          reasons.appendChild(styleChip);
        }
        moment.reasons.slice(0, 3).forEach((reason) => {
          const chip = document.createElement("small");
          chip.className = "reason-chip";
          chip.textContent = reason.replace(/_/g, " ");
          reasons.appendChild(chip);
        });
        copy.appendChild(reasons);
      }
      const score = document.createElement("span");
      score.className = "moment-score";
      score.textContent = moment.score;
      button.append(time, copy, score);
      button.addEventListener("click", () => selectMoment(index));
      els.momentList.appendChild(button);
    });
  }

  function selectMoment(index) {
    const moment = state.moments[index];
    if (!moment) return;
    state.activeMoment = index;
    els.captionPreview.textContent = moment.caption;
    pulseCaption();
    renderMoments();
  }

  function pulseCaption() {
    els.captionPreview.classList.remove("pulse");
    window.requestAnimationFrame(() => els.captionPreview.classList.add("pulse"));
  }

  function formatUploadLabel(upload) {
    const duration = upload.metadata ? Core.formatDuration(upload.metadata.durationSeconds) : "--";
    return `${upload.originalFilename} · ${Core.formatBytes(upload.byteSize)} · ${duration}`;
  }

  function canAutoFillMatchTitle() {
    const currentTitle = Core.sanitizeText(els.matchTitle.value, Core.CONFIG.maxTitleLength);
    return !currentTitle || !state.titleEdited || currentTitle === state.lastAutoTitle;
  }

  function autoFillMatchTitle(input) {
    if (!canAutoFillMatchTitle()) return false;
    const candidate = Core.createProjectTitleCandidate(input);
    if (!candidate.ok) return false;
    els.matchTitle.value = candidate.data.title;
    state.lastAutoTitle = candidate.data.title;
    state.titleEdited = false;
    updateActionStates();
    return true;
  }

  function resetRenderState() {
    window.clearInterval(state.pollTimer);
    Object.assign(state, {
      activeJob: null,
      generated: false,
      exportId: null,
      downloadUrl: null,
    });
    resetReviewState();
    els.downloadLink.hidden = true;
    els.downloadLink.href = "#";
    updateProgress(null);
    els.shortCount.textContent = "0";
    setButtonContent(els.exportBtn, "Export", "download");
  }

  async function handleVideoInputChange(event) {
    clearError();
    state.sourceType = "local";
    clearYouTubeValidation();
    syncSourcePanels();
    const file = event.target.files && event.target.files[0];
    resetRenderState();
    const basics = Core.validateUploadFile(file);
    if (!basics.ok) {
      showUploadError(basics);
      resetFileInput();
      return;
    }
    setProjectStatus("processing", "Uploading");
    els.fileLabel.textContent = "Validating locally...";
    try {
      const header = await Core.readBlobHeader(file, 32);
      Core.throwIfFailed(Core.validateVideoSignature(header, basics.data.extension, basics.data.mimeType));
      const metadata = await previewAndReadMetadata(file);
      Core.throwIfFailed(Core.validateVideoDuration(metadata.duration));
      autoFillMatchTitle({ fileName: basics.data.sanitizedName });

      els.fileLabel.textContent = "Uploading to backend...";
      const form = new FormData();
      form.append("video", file, basics.data.sanitizedName);
      form.append("title", els.matchTitle.value);
      const data = await apiFetch("/api/uploads", { method: "POST", body: form });
      state.activeUpload = data.upload;
      state.activeProject = data.project;
      els.fileLabel.textContent = formatUploadLabel(data.upload);
      setProjectStatus("draft", "Uploaded");
      showToast("Το βίντεο ανέβηκε και πέρασε backend validation.", "success");
    } catch (error) {
      state.activeUpload = null;
      state.activeProject = null;
      state.generated = false;
      setProjectStatus("failed", "Upload failed");
      showUploadError(error);
    } finally {
      updateActionStates();
    }
  }

  function previewAndReadMetadata(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const timeout = window.setTimeout(() => {
        cleanup(false);
        reject(new Core.SafeAppError("METADATA_TIMEOUT"));
      }, Core.CONFIG.metadataTimeoutMs);
      function cleanup(keepUrl) {
        window.clearTimeout(timeout);
        els.videoPreview.onloadedmetadata = null;
        els.videoPreview.onerror = null;
        if (!keepUrl) URL.revokeObjectURL(objectUrl);
      }
      els.videoPreview.onloadedmetadata = () => {
        const metadata = {
          duration: els.videoPreview.duration,
          width: els.videoPreview.videoWidth,
          height: els.videoPreview.videoHeight,
        };
        cleanup(true);
        if (state.activeObjectUrl) URL.revokeObjectURL(state.activeObjectUrl);
        state.activeObjectUrl = objectUrl;
        els.videoPreview.hidden = false;
        els.syntheticPreview.hidden = true;
        resolve(metadata);
      };
      els.videoPreview.onerror = () => {
        cleanup(false);
        reject(new Core.SafeAppError("VIDEO_DURATION_INVALID"));
      };
      els.videoPreview.src = objectUrl;
      els.videoPreview.load();
    });
  }

  function resetFileInput() {
    els.videoInput.value = "";
    els.fileLabel.textContent = "MP4, MOV ή WEBM · μέχρι 30 λεπτά · μέχρι 250 MB";
  }

  async function handleYouTubeValidate(options = {}) {
    const automatic = Boolean(options.automatic);
    const requestId = options.requestId || invalidateYouTubeValidationRequest();
    clearScheduledYouTubeAutoValidation();
    if (automatic) {
      clearYouTubeFieldError();
    } else {
      clearError();
    }
    resetRenderState();
    state.activeUpload = null;
    state.activeProject = null;
    clearYouTubeValidation();
    updateActionStates();
    const clientValidation = Core.validateYouTubeSourceInput({
      url: els.youtubeUrlInput.value,
      rightsConfirmed: els.youtubeRightsCheckbox.checked,
    });
    if (!clientValidation.ok) {
      if (automatic && clientValidation.error?.code === "YOUTUBE_RIGHTS_REQUIRED") {
        updateActionStates();
        return;
      }
      showYouTubeError(clientValidation);
      updateActionStates();
      return;
    }
    try {
      state.youtubeAction = "validating";
      setProjectStatus("processing", "Validating URL");
      updateActionStates();
      const data = await apiFetch("/api/youtube/validate", {
        method: "POST",
        body: JSON.stringify({
          url: clientValidation.data.canonicalUrl,
          rightsConfirmed: true,
        }),
      });
      if (requestId !== youtubeValidationRequestId) return;
      state.youtubeValidation = data.source;
      state.youtubeAction = "validated";
      autoFillMatchTitle({ title: data.source && data.source.title });
      renderYouTubePreview(data.source);
      setProjectStatus("draft", "URL checked");
      if (!automatic) {
        showToast(
          state.youtubeHealth.ingestAvailable
            ? "Το YouTube source πέρασε validation. Μπορείς να κάνεις ingest."
            : "Το YouTube source πέρασε validation. Το ingest μένει κλειδωμένο.",
          "success",
        );
      }
    } catch (error) {
      if (requestId !== youtubeValidationRequestId) return;
      state.youtubeAction = "failed";
      showYouTubeError(error);
    } finally {
      if (requestId === youtubeValidationRequestId) updateActionStates();
    }
  }

  async function handleYouTubeIngest() {
    clearError();
    if (!state.youtubeValidation) {
      showYouTubeError(Core.fail("YOUTUBE_URL_INVALID"), "youtube-ingest");
      updateActionStates();
      return;
    }
    if (!state.youtubeHealth.ingestAvailable) {
      const code = state.youtubeHealth.enabled && !state.youtubeHealth.downloaderConfigured
        ? "YOUTUBE_DOWNLOADER_MISSING"
        : "YOUTUBE_INGEST_NOT_ENABLED";
      showYouTubeError(Core.fail(code), "youtube-ingest");
      updateActionStates();
      return;
    }
    const clientValidation = Core.validateYouTubeSourceInput({
      url: state.youtubeValidation.canonicalUrl,
      rightsConfirmed: els.youtubeRightsCheckbox.checked,
    });
    if (!clientValidation.ok) {
      showYouTubeError(clientValidation, "youtube-ingest");
      updateActionStates();
      return;
    }
    try {
      state.youtubeAction = "ingesting";
      setProjectStatus("processing", "Ingesting");
      updateActionStates();
      const data = await apiFetch("/api/youtube/ingest", {
        method: "POST",
        body: JSON.stringify({
          url: clientValidation.data.canonicalUrl,
          rightsConfirmed: true,
          title: els.matchTitle.value,
        }),
      });
      state.activeUpload = data.upload;
      state.activeProject = data.project;
      state.youtubeValidation = data.source;
      state.youtubeAction = "ready_to_generate";
      autoFillMatchTitle({ title: data.project && data.project.title });
      els.fileLabel.textContent = formatUploadLabel(data.upload);
      renderYouTubePreview(data.source);
      setProjectStatus("draft", "YouTube ingested");
      showToast("Το YouTube video έγινε ασφαλές MP4 artifact και είναι έτοιμο για generate.", "success");
    } catch (error) {
      state.activeUpload = null;
      state.activeProject = null;
      state.youtubeAction = "failed";
      setProjectStatus("failed", "Ingest failed");
      showYouTubeError(error, "youtube-ingest");
    } finally {
      updateActionStates();
    }
  }

  function focusAnotherYouTubeLink() {
    invalidateYouTubeValidationRequest();
    clearScheduledYouTubeAutoValidation();
    clearYouTubeProjectState();
    clearYouTubeFieldError();
    clearYouTubeWarning();
    els.youtubeUrlInput.focus();
    els.youtubeUrlInput.select();
    updateActionStates();
  }

  function useMp4Fallback() {
    selectSource("local");
    window.setTimeout(() => els.videoInput.focus(), 0);
  }

  async function handleGenerate() {
    clearError();
    if (state.sourceType === "youtube" && (!state.activeUpload || !state.activeProject)) {
      showSafeError(Core.fail("YOUTUBE_INGEST_NOT_ENABLED"), "generate-youtube");
      updateActionStates();
      return;
    }
    if (!state.activeUpload || !state.activeProject) {
      showSafeError({ code: "UPLOAD_EMPTY", message: "Ανέβασε πρώτα ένα βίντεο." }, "generate");
      return;
    }
    const settings = readSettings({ generated: state.generated });
    const jobReady = Core.validateProjectForJob(settings.ok ? settings.data : {}, "generate");
    if (!settings.ok || !jobReady.ok) {
      showSafeError(settings.ok ? jobReady : settings, "generate-validation");
      return;
    }
    const rate = state.rateLimiters.generate.check("local-user");
    if (!rate.ok) {
      showSafeError(rate, "generate-rate-limit");
      return;
    }
    try {
      setButtonContent(els.generateBtn, "Starting render...", "bolt");
      setProjectStatus("processing", "Queued");
      const data = await apiFetch(`/api/projects/${state.activeProject.id}/generate`, {
        method: "POST",
        body: JSON.stringify({
          title: settings.data.title,
          preset: settings.data.preset,
          language: settings.data.language,
          styleTarget: settings.data.styleTarget,
          editIntensity: settings.data.editIntensity,
          stylePreset: settings.data.stylePreset,
          rightsConfirmed: settings.data.rightsConfirmed,
          idempotencyKey: Core.createIdempotencyKey("generate", {
            uploadId: state.activeUpload.id,
            preset: settings.data.preset,
            styleTarget: settings.data.styleTarget,
            editIntensity: settings.data.editIntensity,
            stylePreset: settings.data.stylePreset,
            title: settings.data.title,
          }),
        }),
      });
      state.activeJob = data.job;
      updateProgress(data.job);
      updateActionStates();
      pollJob(data.job.id);
    } catch (error) {
      setButtonContent(els.generateBtn, "Generate shorts", "bolt");
      setProjectStatus("failed", "Failed");
      showSafeError(error, "generate");
      updateActionStates();
    }
  }

  function pollJob(jobId) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(async () => {
      try {
        const data = await apiFetch(`/api/jobs/${jobId}`);
        state.activeJob = data.job;
        updateProgress(data.job);
        if (data.job.status === "completed") {
          window.clearInterval(state.pollTimer);
          handleJobComplete(data.job);
        } else if (data.job.status === "failed") {
          window.clearInterval(state.pollTimer);
          handleJobFailed(data.job);
        } else if (data.job.status === "cancelled") {
          window.clearInterval(state.pollTimer);
          setProjectStatus("cancelled", "Cancelled");
          setButtonContent(els.generateBtn, "Generate shorts", "bolt");
          showToast("Η δημιουργία ακυρώθηκε.", "warning");
          updateActionStates();
        } else {
          setProjectStatus("processing", `${Math.round(data.job.progress || 0)}%`);
          updateActionStates();
        }
      } catch (error) {
        window.clearInterval(state.pollTimer);
        showSafeError(error, "job-poll");
        updateActionStates();
      }
    }, 900);
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(safe / 60);
    const remaining = safe % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  function momentsFromCandidatePlans(candidatePlans, editPlan) {
    const plans = Array.isArray(candidatePlans) && candidatePlans.length ? candidatePlans : [editPlan].filter(Boolean);
    return plans.map((plan, index) => {
      const analysisMoment = plan.analysisMoment || {};
      const reasons = Array.isArray(plan.reasonCodes) ? plan.reasonCodes : analysisMoment.reasonCodes || [];
      const firstCaption = Array.isArray(plan.captions) && plan.captions[0] ? plan.captions[0].text : plan.hook;
      return {
        time: formatTime(plan.sourceStart),
        title: analysisMoment.title || (index === 0 ? "Best candidate short" : `Candidate short ${index + 1}`),
        subtitle: analysisMoment.summary || `${Math.round(plan.sourceEnd - plan.sourceStart)}s candidate · ${reasons.join(", ")}`,
        score: `${Math.round(plan.retentionScore || analysisMoment.retentionScore || 90)}%`,
        caption: firstCaption,
        highlightType: plan.highlightType || analysisMoment.highlightType || "generic_highlight",
        stylePreset: plan.stylePreset || "",
        framingMode: plan.framingMode || "",
        reasons,
      };
    });
  }

  function handleJobComplete(job) {
    const exportReady = Core.validateCompletedJobForExport(job);
    if (!exportReady.ok) {
      state.generated = false;
      state.exportId = null;
      state.downloadUrl = null;
      els.downloadLink.hidden = true;
      els.downloadLink.href = "#";
      setProjectStatus("failed", "Export invalid");
      setButtonContent(els.generateBtn, "Generate shorts", "bolt");
      setButtonContent(els.exportBtn, "Export", "download");
      showSafeError(exportReady, "job-complete-validation");
      updateActionStates();
      return;
    }
    const { exportId, editPlan, candidatePlans } = exportReady.data;
    state.generated = true;
    state.exportId = exportId;
    state.downloadUrl = `/api/exports/${exportId}/download`;
    resetReviewState();
    state.moments = Core.validateAiOutput(momentsFromCandidatePlans(candidatePlans, editPlan)).data || state.moments;
    els.downloadLink.href = state.downloadUrl;
    els.downloadLink.hidden = false;
    const styleLabel = formatRenderStyleLabel(editPlan.stylePreset);
    const framingLabel = editPlan.framingMode ? editPlan.framingMode.replace(/_/g, " ") : "safe framing";
    const ratioLabel = editPlan.aspectRatio || "9:16";
    els.timelineLabel.textContent = `${Math.round(editPlan.sourceEnd - editPlan.sourceStart)}s short · ${ratioLabel} · ${candidatePlans.length || 1} candidates · ${styleLabel} · ${framingLabel}`;
    els.momentCount.textContent = String(state.moments.length);
    els.shortCount.textContent = "1";
    setProjectStatus("ready", "Rendered");
    setButtonContent(els.generateBtn, "Regenerate", "bolt");
    setButtonContent(els.exportBtn, "Download", "download");
    renderMoments();
    selectMoment(0);
    showToast(`Το ${ratioLabel} MP4 render είναι έτοιμο για download.`, "success");
    updateActionStates();
  }

  function handleJobFailed(job) {
    setProjectStatus("failed", "Failed");
    setButtonContent(els.generateBtn, "Generate shorts", "bolt");
    showSafeError(job.error || { code: "RENDER_FAILED", message: "Το render απέτυχε." }, "job");
    updateActionStates();
  }

  async function cancelCurrentJob() {
    if (!state.activeJob) return;
    try {
      const data = await apiFetch(`/api/jobs/${state.activeJob.id}/cancel`, { method: "POST", body: "{}" });
      state.activeJob = data.job;
      setProjectStatus("cancelled", "Cancelled");
      updateProgress(data.job);
    } catch (error) {
      showSafeError(error, "cancel");
    } finally {
      updateActionStates();
    }
  }

  function retryLastFailedAction() {
    handleGenerate();
  }

  function downloadExport() {
    if (!state.generated || !state.downloadUrl || !state.exportId) {
      showSafeError(Core.fail("EXPORT_NOT_READY"), "download");
      updateActionStates();
      return;
    }
    window.location.href = state.downloadUrl;
  }

  async function handleReviewRegister() {
    clearError();
    if (!canRegisterReview()) {
      state.review = {
        status: "failed",
        result: null,
        error: {
          message: "A completed render, export, and rights confirmation are required before review registration.",
        },
      };
      updateActionStates();
      return;
    }
    try {
      state.review = { status: "registering", result: null, error: null };
      updateActionStates();
      const data = await apiFetch("/api/review/register", {
        method: "POST",
        body: JSON.stringify({
          projectId: state.activeProject.id,
          jobId: state.activeJob.id,
          exportId: state.exportId,
          rightsConfirmed: true,
          title: els.matchTitle.value,
        }),
      });
      state.review = { status: "registered", result: data, error: null };
      showToast(
        data.review && data.review.passed ? "Το review draft πέρασε το quality check." : "Το review draft χρειάζεται έλεγχο.",
        data.review && data.review.passed ? "success" : "warning",
      );
    } catch (error) {
      const response = safeErrorResponse(error);
      state.review = {
        status: "failed",
        result: null,
        error: {
          code: response.error.code,
          message: response.error.code === "ARTIFACT_NOT_FOUND"
            ? "This render cannot be registered for local review because the generated media artifact is not locally available."
            : response.error.message,
        },
      };
      showSafeError(response, "review-register");
    } finally {
      updateActionStates();
    }
  }

  function handleSave() {
    const settings = readSettings({ generated: state.generated });
    if (!settings.ok) {
      showSafeError(settings, "save-validation");
      return;
    }
    try {
      window.localStorage.setItem(
        "shortsengine:draft",
        JSON.stringify({
          settings: settings.data,
          upload: state.activeUpload,
          project: state.activeProject,
          exportId: state.exportId,
          savedAt: new Date().toISOString(),
        }),
      );
      setProjectStatus("saved", "Saved");
      showToast("Το draft αποθηκεύτηκε τοπικά.", "success");
    } catch {
      showSafeError({ code: "UNEXPECTED", message: "Δεν μπόρεσε να αποθηκευτεί το draft." }, "save");
    }
  }

  function clearProject() {
    const confirmed = window.confirm("Να καθαριστεί το loaded video, το render state και τα local draft δεδομένα;");
    if (!confirmed) return;
    window.clearInterval(state.pollTimer);
    if (state.activeObjectUrl) URL.revokeObjectURL(state.activeObjectUrl);
    Object.assign(state, {
      activeMoment: 0,
      activeRatio: "vertical",
      activeIntensity: "balanced",
      activeStylePreset: "social_sports_v1",
      activeObjectUrl: null,
      activeUpload: null,
      activeProject: null,
      activeJob: null,
      sourceType: "local",
      youtubeAction: "idle",
      youtubeValidation: null,
      generated: false,
      exportId: null,
      downloadUrl: null,
      review: {
        status: "idle",
        result: null,
        error: null,
      },
      moments: Core.validateAiOutput(DEFAULT_MOMENTS).data || [],
    });
    window.localStorage.removeItem("shortsengine:draft");
    els.videoInput.value = "";
    els.videoPreview.removeAttribute("src");
    els.videoPreview.hidden = true;
    els.syntheticPreview.hidden = false;
    els.downloadLink.hidden = true;
    els.downloadLink.href = "#";
    els.jobProgress.hidden = true;
    els.timelineLabel.textContent = "00:18 short · 4 scenes · 7 caption beats";
    els.ratioButtons.forEach((item) => item.classList.toggle("active", item.dataset.ratio === "vertical"));
    els.phonePreview.classList.remove("square", "wide");
    els.intensityButtons.forEach((item) => item.classList.toggle("active", item.dataset.intensity === "balanced"));
    els.stylePresetButtons.forEach((item) => item.classList.toggle("active", item.dataset.stylePreset === "social_sports_v1"));
    els.momentCount.textContent = "3";
    els.shortCount.textContent = "0";
    resetFileInput();
    clearYouTubeValidation({ clearInput: true });
    syncSourcePanels();
    clearError();
    setProjectStatus("draft", "Draft");
    setButtonContent(els.generateBtn, "Generate shorts", "bolt");
    setButtonContent(els.exportBtn, "Export", "download");
    renderMoments();
    selectMoment(0);
    updateActionStates();
    showToast("Το project καθαρίστηκε.", "success");
  }

  function updateRatio(button) {
    const ratio = button.dataset.ratio;
    if (!Core.CONFIG.allowedRatios.includes(ratio)) return;
    state.activeRatio = ratio;
    els.ratioButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    els.phonePreview.classList.remove("square", "wide");
    if (ratio === "square") els.phonePreview.classList.add("square");
    updateActionStates();
  }

  function updateIntensity(button) {
    const intensity = button.dataset.intensity;
    if (!Core.CONFIG.allowedEditIntensities.includes(intensity)) return;
    state.activeIntensity = intensity;
    els.intensityButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    updateActionStates();
  }

  function updateStylePreset(button) {
    const stylePreset = button.dataset.stylePreset;
    if (!Core.CONFIG.allowedRenderStylePresets.includes(stylePreset)) return;
    state.activeStylePreset = stylePreset;
    els.stylePresetButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    updateActionStates();
  }

  function updatePreset(button) {
    const preset = button.dataset.preset;
    if (!Core.CONFIG.allowedPresets.includes(preset)) {
      showSafeError(Core.fail("PRESET_INVALID"), "preset");
      return;
    }
    state.activePreset = preset;
    els.presetButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    els.captionPreview.textContent = PRESET_CAPTIONS[preset];
    pulseCaption();
    updateActionStates();
  }

  function bindEvents() {
    els.ratioButtons.forEach((button) => button.addEventListener("click", () => updateRatio(button)));
    els.presetButtons.forEach((button) => button.addEventListener("click", () => updatePreset(button)));
    els.intensityButtons.forEach((button) => button.addEventListener("click", () => updateIntensity(button)));
    els.stylePresetButtons.forEach((button) => button.addEventListener("click", () => updateStylePreset(button)));
    els.sourceLocalBtn.addEventListener("click", () => selectSource("local"));
    els.sourceYoutubeBtn.addEventListener("click", () => selectSource("youtube"));
    els.youtubeUrlInput.addEventListener("input", () => {
      invalidateYouTubeValidationRequest();
      clearScheduledYouTubeAutoValidation();
      clearYouTubeProjectState();
      clearYouTubeFieldError();
      clearYouTubeWarning();
      updateActionStates();
      scheduleYouTubeAutoValidate();
    });
    els.youtubeRightsCheckbox.addEventListener("change", () => {
      invalidateYouTubeValidationRequest();
      clearScheduledYouTubeAutoValidation();
      clearYouTubeProjectState();
      clearYouTubeFieldError();
      clearYouTubeWarning();
      updateActionStates();
      scheduleYouTubeAutoValidate();
    });
    els.youtubeUrlInput.addEventListener("blur", scheduleYouTubeAutoValidate);
    els.validateYoutubeBtn.addEventListener("click", () => handleYouTubeValidate({ automatic: false }));
    els.ingestYoutubeBtn.addEventListener("click", handleYouTubeIngest);
    els.retryYoutubeIngestBtn.addEventListener("click", handleYouTubeIngest);
    els.useAnotherYoutubeBtn.addEventListener("click", focusAnotherYouTubeLink);
    els.uploadMp4FallbackBtn.addEventListener("click", useMp4Fallback);
    els.videoInput.addEventListener("change", handleVideoInputChange);
    els.generateBtn.addEventListener("click", handleGenerate);
    els.retryBtn.addEventListener("click", retryLastFailedAction);
    els.cancelJobBtn.addEventListener("click", cancelCurrentJob);
    els.reviewRegisterBtn.addEventListener("click", handleReviewRegister);
    els.saveBtn.addEventListener("click", handleSave);
    els.clearBtn.addEventListener("click", clearProject);
    els.exportBtn.addEventListener("click", downloadExport);
    els.exportButtons.forEach((button) => button.addEventListener("click", downloadExport));
    els.paceRange.addEventListener("input", () => {
      els.paceValue.textContent = String(Core.toBoundedInteger(els.paceRange.value, 20, 100, 72));
    });
    els.motionRange.addEventListener("input", () => {
      els.motionValue.textContent = String(Core.toBoundedInteger(els.motionRange.value, 0, 100, 64));
    });
    els.captionsToggle.addEventListener("change", () => {
      els.captionPreview.style.display = els.captionsToggle.checked ? "grid" : "none";
    });
    els.rightsCheckbox.addEventListener("change", updateActionStates);
    els.matchTitle.addEventListener("input", () => {
      state.titleEdited = true;
      updateActionStates();
    });
    els.languageSelect.addEventListener("change", updateActionStates);
  }

  function init() {
    bindEvents();
    renderMoments();
    selectMoment(0);
    setButtonContent(els.generateBtn, "Generate shorts", "bolt");
    setButtonContent(els.exportBtn, "Export", "download");
    state.lastAutoTitle = Core.sanitizeText(els.matchTitle.value, Core.CONFIG.maxTitleLength);
    resetFileInput();
    clearYouTubeValidation({ clearInput: false });
    syncSourcePanels();
    els.jobProgress.hidden = true;
    updateActionStates();
    refreshYouTubeHealth();
  }

  init();
})();
