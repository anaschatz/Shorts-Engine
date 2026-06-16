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
    youtubeError: "#youtubeError",
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
  });

  const state = {
    activeMoment: 0,
    activePreset: "hype",
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
    },
    pollTimer: null,
    generated: false,
    exportId: null,
    downloadUrl: null,
    moments: Core.validateAiOutput(DEFAULT_MOMENTS).data || [],
    rateLimiters: {
      generate: Core.createRateLimiter({ limit: 8, windowMs: 60 * 1000 }),
    },
  };

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
    nodes.push(document.createTextNode(label));
    button.replaceChildren(...nodes);
  }

  function setProjectStatus(status, label) {
    els.projectStatus.dataset.status = status;
    els.projectStatus.textContent = label;
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
    els.youtubeUrlInput.removeAttribute("aria-invalid");
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
      pace: els.paceRange.value,
      motion: els.motionRange.value,
      captionsEnabled: els.captionsToggle.checked,
      rightsConfirmed: state.sourceType === "youtube" ? els.youtubeRightsCheckbox.checked : els.rightsCheckbox.checked,
      ...(extra || {}),
    });
  }

  function isBusy() {
    return state.activeJob && ["queued", "processing"].includes(state.activeJob.status);
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

  function updateActionStates() {
    const youtubeUi = currentYouTubeUiState();
    const busy = youtubeUi.busy;
    const youtubeSource = youtubeUi.youtubeSource;
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
    els.validateYoutubeBtn.disabled = !youtubeUi.canValidate;
    els.ingestYoutubeBtn.disabled = !youtubeUi.canIngest;
    els.validateYoutubeBtn.textContent = state.youtubeAction === "validating" ? "Validating..." : "Validate source";
    els.ingestYoutubeBtn.textContent = state.youtubeAction === "ingesting" ? "Ingesting..." : "Ingest video";
    els.youtubeSourcePanel.dataset.flowState = youtubeUi.status;
    els.exportBtn.disabled = !youtubeUi.canDownload;
    els.exportButtons.forEach((button) => {
      button.disabled = !youtubeUi.canDownload;
    });
    els.downloadLink.hidden = !youtubeUi.canDownload;
    els.momentList.setAttribute("aria-busy", busy ? "true" : "false");
    renderYouTubeIngestStatus(youtubeUi);
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
    } else if (ready) {
      els.youtubeIngestStatus.textContent = "YouTube ingest is enabled. Validate the URL before ingest.";
    } else if (health.enabled && !health.downloaderConfigured) {
      els.youtubeIngestStatus.textContent = "YouTube ingest is enabled but the downloader is unavailable.";
    } else {
      els.youtubeIngestStatus.textContent = "YouTube ingest is disabled by default. Local uploads still work.";
    }
  }

  function showYouTubeError(error, context = "youtube-validate") {
    const response = showSafeError(error, context);
    els.youtubeError.hidden = false;
    els.youtubeError.textContent = `${response.error.message} (${response.error.code})`;
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
      };
    } finally {
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
      transcribe: "Transcribing commentary",
      detect_highlights: "Detecting highlights",
      create_edit_plan: "Creating edit plans",
      render_short: "Rendering 9:16 short",
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
          styleChip.textContent = moment.stylePreset === "social_sports_v1" ? "Social sports" : moment.stylePreset.replace(/_/g, " ");
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

  function resetRenderState() {
    window.clearInterval(state.pollTimer);
    Object.assign(state, {
      activeJob: null,
      generated: false,
      exportId: null,
      downloadUrl: null,
    });
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

  async function handleYouTubeValidate() {
    clearError();
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
      state.youtubeValidation = data.source;
      state.youtubeAction = "validated";
      renderYouTubePreview(data.source);
      setProjectStatus("draft", "URL checked");
      showToast(
        state.youtubeHealth.ingestAvailable
          ? "Το YouTube source πέρασε validation. Μπορείς να κάνεις ingest."
          : "Το YouTube source πέρασε validation. Το ingest μένει κλειδωμένο.",
        "success",
      );
    } catch (error) {
      state.youtubeAction = "failed";
      showYouTubeError(error);
    } finally {
      updateActionStates();
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
          rightsConfirmed: settings.data.rightsConfirmed,
          idempotencyKey: Core.createIdempotencyKey("generate", {
            uploadId: state.activeUpload.id,
            preset: settings.data.preset,
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
    state.moments = Core.validateAiOutput(momentsFromCandidatePlans(candidatePlans, editPlan)).data || state.moments;
    els.downloadLink.href = state.downloadUrl;
    els.downloadLink.hidden = false;
    const styleLabel = editPlan.stylePreset === "social_sports_v1" ? "Social sports" : editPlan.stylePreset || "Style";
    const framingLabel = editPlan.framingMode ? editPlan.framingMode.replace(/_/g, " ") : "safe framing";
    els.timelineLabel.textContent = `${Math.round(editPlan.sourceEnd - editPlan.sourceStart)}s short · ${candidatePlans.length || 1} candidates · ${styleLabel} · ${framingLabel}`;
    els.momentCount.textContent = String(state.moments.length);
    els.shortCount.textContent = "1";
    setProjectStatus("ready", "Rendered");
    setButtonContent(els.generateBtn, "Regenerate", "bolt");
    setButtonContent(els.exportBtn, "Download", "download");
    renderMoments();
    selectMoment(0);
    showToast("Το 9:16 MP4 render είναι έτοιμο για download.", "success");
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
    els.ratioButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    els.phonePreview.classList.remove("square", "wide");
    if (ratio === "square") els.phonePreview.classList.add("square");
    if (ratio === "wide") els.phonePreview.classList.add("wide");
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
    els.sourceLocalBtn.addEventListener("click", () => selectSource("local"));
    els.sourceYoutubeBtn.addEventListener("click", () => selectSource("youtube"));
    els.youtubeUrlInput.addEventListener("input", () => {
      clearYouTubeProjectState();
      clearYouTubeFieldError();
      updateActionStates();
    });
    els.youtubeRightsCheckbox.addEventListener("change", () => {
      clearYouTubeProjectState();
      clearYouTubeFieldError();
      updateActionStates();
    });
    els.validateYoutubeBtn.addEventListener("click", handleYouTubeValidate);
    els.ingestYoutubeBtn.addEventListener("click", handleYouTubeIngest);
    els.videoInput.addEventListener("change", handleVideoInputChange);
    els.generateBtn.addEventListener("click", handleGenerate);
    els.retryBtn.addEventListener("click", retryLastFailedAction);
    els.cancelJobBtn.addEventListener("click", cancelCurrentJob);
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
    els.matchTitle.addEventListener("input", updateActionStates);
    els.languageSelect.addEventListener("change", updateActionStates);
  }

  function init() {
    bindEvents();
    renderMoments();
    selectMoment(0);
    setButtonContent(els.generateBtn, "Generate shorts", "bolt");
    setButtonContent(els.exportBtn, "Export", "download");
    resetFileInput();
    clearYouTubeValidation({ clearInput: false });
    syncSourcePanels();
    els.jobProgress.hidden = true;
    updateActionStates();
    refreshYouTubeHealth();
  }

  init();
})();
