const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const {
  renderShort,
  writeAssSubtitles,
  createRenderPolishSummary,
  twoPhaseGoalCameraSummary,
  renderDimensions,
  normalizeRenderProfileName,
} = require("../server/render.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");

process.env.SHORTSENGINE_VIDEO_ENHANCEMENT_ENABLED = "0";

const metadata = { durationSeconds: 16, width: 1920, height: 1080 };

function validKineticPlan() {
  return validateEditPlan({
    sourceStart: 0,
    sourceEnd: 12,
    aspectRatio: "9:16",
    highlightType: "crowd_reaction",
    confidence: 0.84,
    hook: "Η ΚΕΡΚΙΔΑ ΤΟ ΕΝΙΩΣΕ",
    title: "Αργεντινή - Αλγερία",
    captions: [
      {
        start: 0,
        end: 2,
        text: "Η ΚΕΡΚΙΔΑ ΤΟ ΕΝΙΩΣΕ",
        role: "opening_hook",
        emphasis: "shout",
        layout: "center",
        style: { fontScale: 1.1, highlightColor: "gold", uppercase: true, maxLines: 2 },
      },
      {
        start: 2.1,
        end: 4,
        text: "Ματς: Αργεντινή - Αλγερία",
        role: "context",
        emphasis: "detail",
        layout: "top",
        style: { fontScale: 0.78, highlightColor: "cyan", uppercase: false, maxLines: 1 },
      },
      {
        start: 4.1,
        end: 6.2,
        text: "ΑΥΤΗ Η ΑΝΤΙΔΡΑΣΗ ΤΑ ΛΕΕΙ ΟΛΑ",
        role: "action_callout",
        emphasis: "strong",
        layout: "bottom",
      },
    ],
    effects: ["wide_safe_framing", "caption_emphasis", "beat_sync_pulse"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "punchy_highlight",
    captionEmphasis: [{ captionIndex: 0, words: ["ΚΕΡΚΙΔΑ"], style: "kinetic_bold", start: 0, end: 2 }],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2 },
      { type: "kinetic_caption", start: 0.1, end: 2.1 },
      { type: "punch_zoom", start: 3.1, end: 4.2 },
      { type: "impact_flash", start: 4.25, end: 4.38 },
      { type: "end_replay_prompt", start: 10.8, end: 12 },
    ],
    reasonCodes: ["crowd_reaction", "audio_energy_spike"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, metadata);
}

test("edit plan validation keeps late captions inside a valid word-timing window", () => {
  const plan = validateEditPlan({
    sourceStart: 0,
    sourceEnd: 12,
    aspectRatio: "9:16",
    highlightType: "goal",
    confidence: 0.9,
    hook: "VALID FINISHES ONLY",
    title: "Late caption",
    captions: [
      {
        start: 11.95,
        end: 13,
        text: "FINAL WHISTLE",
        role: "closing_punch",
        emphasis: "strong",
        layout: "bottom",
      },
    ],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, metadata);

  const [caption] = plan.captions;
  assert.equal(caption.start, 11.6);
  assert.equal(caption.end, 12);
  assert.equal(caption.activeWordTiming.length, caption.words.length);
  assert.equal(caption.activeWordTiming.every((timing, index) => (
    timing.word === caption.words[index] &&
    timing.start >= caption.start &&
    timing.end <= caption.end &&
    timing.end - timing.start >= 0.08
  )), true);
});

test("ASS renderer writes role-specific kinetic caption styles safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-"));
  const outputPath = join(dir, "captions.ass");
  writeAssSubtitles(validKineticPlan(), outputPath);

  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /Style: Caption_opening_hook_0/);
  assert.match(ass, /Style: Caption_context_1/);
  assert.match(ass, /PUNCHY HIGHLIGHT/);
  assert.match(ass, /\\fad\(180,80\)/);
  assert.match(ass, /\\t\(0,180,\\fscx104\\fscy104\)/);
  assert.ok((ass.match(/Dialogue: 0/g) || []).length >= 10);
  assert.match(ass, /\\c&H[0-9A-F]+\\b1/);
  assert.match(ass, /\\N|Ματς: Αργεντινή - Αλγερία/);
  assert.doesNotMatch(ass, /\bGOAL\b|ΓΚΟΛ/);
  assert.doesNotMatch(ass, /\/Users|OPENAI_API_KEY|storageKey/i);
});

test("ASS renderer writes offside outcome badge without confirmed-goal copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-outcome-"));
  const outputPath = join(dir, "captions.ass");
  const plan = validateEditPlan({
    sourceStart: 0,
    sourceEnd: 22,
    aspectRatio: "9:16",
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "disallowed_offside",
      offsideStatus: "offside",
      decisionEvidence: ["ball_in_net", "offside_commentary", "visual_offside_flag"],
      decisionTimestamp: 18.4,
      postContextSeconds: 12,
      confidence: 0.92,
    },
    confidence: 0.9,
    hook: "OFFSIDE - NO GOAL",
    title: "Offside goal",
    captions: [
      { start: 0, end: 2.2, text: "GOAL... BUT THE FLAG IS UP", role: "opening_hook" },
      { start: 7.5, end: 10.2, text: "OFFSIDE - NO GOAL", role: "action_callout" },
      { start: 18, end: 21, text: "FINISH RULED OUT", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    reasonCodes: ["goal", "visual_ball_in_net", "visual_offside_flag"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 30, width: 1920, height: 1080 });

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /OutcomeBadge/);
  assert.match(ass, /OFFSIDE - NO GOAL/);
  assert.doesNotMatch(ass, /GOAL CONFIRMED|THE FINISH COUNTS|\/Users|storageKey/i);
});

test("ASS renderer writes VAR check badge for possible offside outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-var-outcome-"));
  const outputPath = join(dir, "captions.ass");
  const plan = validateEditPlan({
    sourceStart: 0,
    sourceEnd: 20,
    aspectRatio: "9:16",
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "possible_offside",
      offsideStatus: "possible",
      decisionEvidence: ["ball_in_net", "visual_var_check", "visual_replay_angle"],
      safeCaptionBadge: "VAR CHECK",
      decisionWindow: { start: 9.8, end: 20 },
      confidence: 0.74,
    },
    confidence: 0.82,
    hook: "WAS HE OFF?",
    title: "VAR check",
    captions: [
      { start: 0, end: 2, text: "WAS HE OFF?", role: "opening_hook" },
      { start: 9, end: 12, text: "VAR CHECK", role: "action_callout" },
      { start: 16, end: 19, text: "DECISION NOT CLEAR", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    reasonCodes: ["goal", "visual_ball_in_net", "visual_var_check"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 24, width: 1920, height: 1080 });

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /VAR CHECK/);
  assert.doesNotMatch(ass, /GOAL CONFIRMED|THE FINISH COUNTS|\/Users|storageKey/i);
});

test("reference football style delays confirmed-goal badges until confirmation windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-reference-style-"));
  const outputPath = join(dir, "captions.ass");
  const plan = {
    mode: "multi_moment_compilation",
    sourceStart: 50,
    sourceEnd: 164,
    totalDuration: 48,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    hook: "VALID FINISHES ONLY",
    stylePreset: "reference_football_multi_goal_v1",
    framingMode: "wide_safe_vertical",
    export: { width: 1080, height: 1920, format: "mp4" },
    segments: [
      {
        id: "goal_1",
        sourceStart: 50,
        sourceEnd: 74,
        timelineStart: 0,
        timelineEnd: 24,
        goalNumber: 1,
        goalOutcome: {
          eventType: "ball_in_net",
          outcome: "confirmed_goal",
          offsideStatus: "onside",
          safeCaptionBadge: "CONFIRMED GOAL",
        },
        confirmationTime: 72,
      },
      {
        id: "goal_2",
        sourceStart: 140,
        sourceEnd: 164,
        timelineStart: 24,
        timelineEnd: 48,
        goalNumber: 2,
        goalOutcome: {
          eventType: "ball_in_net",
          outcome: "confirmed_goal",
          offsideStatus: "onside",
          safeCaptionBadge: "CONFIRMED GOAL",
        },
        confirmationTime: 162,
      },
    ],
    captions: [
      { start: 0.2, end: 2.2, text: "VALID FINISHES ONLY", role: "opening_hook", emphasis: "strong" },
      { start: 21.8, end: 24, text: "GOAL 1 COUNTS", role: "action_callout", emphasis: "detail" },
      { start: 45.8, end: 48, text: "GOAL 2 COUNTS", role: "closing_punch", emphasis: "detail" },
    ],
  };

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /REFERENCE FOOTBALL MULTI GOAL V1/);
  assert.match(ass, /GOAL 1 · CONFIRMED/);
  assert.match(ass, /GOAL 2 · CONFIRMED/);
  assert.match(ass, /Dialogue: 2,0:00:21\.80,0:00:24\.00,OutcomeBadge.*GOAL 1 · CONFIRMED/);
  assert.match(ass, /Dialogue: 2,0:00:45\.79,0:00:48\.00,OutcomeBadge.*GOAL 2 · CONFIRMED/);
  assert.doesNotMatch(ass, /Dialogue: 2,0:00:00\.00.*GOAL 1 · CONFIRMED/);
  assert.doesNotMatch(ass, /\/Users|OPENAI_API_KEY|storageKey/i);
});

test("multi-segment renderer cuts segments, concatenates them, then applies captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-multi-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    mode: "multi_moment_compilation",
    sourceStart: 0,
    sourceEnd: 72,
    segments: [
      {
        id: "seg_chance",
        sourceStart: 0,
        sourceEnd: 12,
        highlightType: "big_chance",
        reasonCodes: ["big_chance", "visual_shot_like_motion"],
        confidence: 0.9,
        retentionScore: 90,
      },
      {
        id: "seg_save",
        sourceStart: 30,
        sourceEnd: 42,
        highlightType: "save",
        reasonCodes: ["save", "visual_save_like_motion"],
        confidence: 0.88,
        retentionScore: 88,
      },
      {
        id: "seg_foul",
        sourceStart: 60,
        sourceEnd: 72,
        highlightType: "hard_foul",
        reasonCodes: ["hard_foul", "visual_foul_like_contact"],
        confidence: 0.86,
        retentionScore: 86,
      },
    ],
    totalDuration: 36,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.88,
    hook: "BEST PHASES ONLY",
    title: "Multi phase render",
    captions: [
      { start: 0, end: 2, text: "BEST PHASES ONLY", role: "opening_hook" },
      { start: 12.4, end: 14.8, text: "PHASE 2: KEEPER REACTS", role: "action_callout" },
      { start: 33.7, end: 36, text: "RUN THE WHOLE SEQUENCE BACK", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "punchy_highlight",
    reasonCodes: ["big_chance", "save", "hard_foul"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 90, width: 1920, height: 1080 });

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(0, 3).map((args) => args[args.indexOf("-ss") + 1]), ["0", "30", "60"]);
  assert.ok(calls.slice(0, 3).every((args) => args.includes("-vf") && /fade=t=in/.test(args[args.indexOf("-vf") + 1]) && /fade=t=out/.test(args[args.indexOf("-vf") + 1])));
  assert.ok(calls.slice(0, 3).every((args) => args[args.indexOf("-qp") + 1] === "0" && !args.includes("-crf")));
  assert.ok(calls.slice(0, 3).every((args) => args[args.indexOf("-c:a") + 1] === "pcm_s16le"));
  assert.equal(calls[3].includes("concat"), true);
  assert.equal(calls[4].includes("-filter_complex"), true);
  assert.equal(calls[4][calls[4].indexOf("-t") + 1], "36");
  assert.equal(plan.renderPolishQA.renderStylePreset, "punchy_highlight");
  assert.equal(plan.renderPolishQA.transitionRenderedCount, 2);
  assert.equal(plan.renderPolishQA.hardCutFallbackCount, 0);
  assert.equal(plan.renderPolishQA.animatedCaptionCount, 3);
  assert.equal(plan.renderPolishQA.dynamicWordCaptionCount, 3);
  assert.equal(plan.renderPolishQA.intermediateVideoEncoding, "lossless_x264_qp0");
  assert.equal(plan.renderPolishQA.lossyVideoEncodeCount, 1);
  assert.equal(plan.renderPolishQA.captionMotion, "ass_word_by_word_highlight");
  assert.equal(plan.renderPolishQA.staticCaptionFallbackCount, 0);
  assert.ok(plan.renderPolishQA.overlayRenderedCount >= 2);
  assert.ok(plan.renderPolishQA.visualPolishScore >= 95);
  const ass = readFileSync(subtitlesPath, "utf8");
  assert.match(ass, /BEST[\s\S]*PHASES[\s\S]*ONLY/);
  assert.doesNotMatch(ass, /\bGOAL\b|ΓΚΟΛ|\/Users|storageKey/i);
});

test("proof-fast render profile keeps visible framing while using faster encoding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-proof-fast-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validKineticPlan();
  plan.renderProfile = "proof_fast";

  assert.equal(normalizeRenderProfileName("PROOF_FAST"), "proof_fast");
  assert.deepEqual(renderDimensions(plan), { width: 1080, height: 1920 });

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  const args = calls[0];
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.equal(args[args.indexOf("-preset") + 1], "ultrafast");
  assert.equal(args[args.indexOf("-crf") + 1], "28");
  assert.equal(args[args.indexOf("-r") + 1], "30");
  assert.equal(args[args.indexOf("-b:a") + 1], "96k");
  assert.doesNotMatch(filter, /boxblur=18:1/);
  assert.match(filter, /pad=1080:1920/);
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=decrease/);
  assert.equal(plan.renderPolishQA.renderProfile, "proof_fast");
  assert.equal(plan.renderPolishQA.outputWidth, 1080);
  assert.equal(plan.renderPolishQA.outputHeight, 1920);
  assert.equal(plan.renderPolishQA.encoderPreset, "ultrafast");
  assert.equal(plan.renderPolishQA.encoderCrf, 28);
  assert.equal(plan.renderPolishQA.actionLayoutMode, "clean_action_letterbox");
  assert.equal(plan.renderPolishQA.blurredBackgroundUsed, false);
  assert.equal(plan.renderPolishQA.duplicateBackgroundUsed, false);
  assert.ok(plan.renderPolishQA.renderPolishWarnings.includes("proof_fast_render_profile"));
  assert.equal(plan.renderPolishQA.renderPolishWarnings.includes("clean_action_letterbox_background"), true);
});

test("confirmed-goal renderer fills 9:16 and preserves the live scorebug at top center", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-scorebug-fill-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    ...validKineticPlan(),
    validGoalsOnly: true,
    framingMode: "safe_center",
    framingReason: "reference_vertical_fill_with_scorebug_overlay",
    cropPlan: {
      mode: "reference_fill",
      targetAspectRatio: "9:16",
      safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
      cropBox: { x: 656, y: 0, width: 608, height: 1080 },
      confidence: 0.74,
      fallbackUsed: true,
      textObstructionRisk: false,
      actionSafeZones: [],
      textSafeZones: [],
      reasonCodes: ["reference_vertical_center_fill"],
    },
    cropStrategy: {
      type: "center_crop",
      x: 656,
      y: 0,
      width: 608,
      height: 1080,
      zoom: 1,
      background: "none",
      preserveFullFrame: false,
      maxCropPercent: 0.35,
    },
    scoreboardOverlay: {
      enabled: true,
      mode: "source_roi",
      regionId: "scorebug_broadcast_compact",
      sourceRect: { x: 0.04, y: 0.045, width: 0.33, height: 0.065 },
      outputWidthRatio: 0.7,
      topMarginRatio: 0.055,
    },
  }, metadata);

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  const filter = calls[0][calls[0].indexOf("-filter_complex") + 1];
  assert.match(filter, /split=2\[base_source\]\[score_source\]/);
  assert.match(filter, /\[base_source\]delogo=/);
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(filter, /crop=iw\*0\.33:ih\*0\.065:iw\*0\.04:ih\*0\.045/);
  assert.match(filter, /overlay=\(W-w\)\/2:106/);
  assert.doesNotMatch(filter, /pad=1080:1920|color=black|boxblur/);
  assert.equal(plan.renderPolishQA.actionLayoutMode, "scorebug_preserved_vertical_fill");
  assert.equal(plan.renderPolishQA.fullHeightActionCrop, true);
  assert.equal(plan.renderPolishQA.scoreboardOverlayRendered, true);
  assert.equal(plan.renderPolishQA.scoreboardOverlayRegionId, "scorebug_broadcast_compact");
  assert.equal(plan.renderPolishQA.sourceScoreboardDuplicateSuppressed, true);
  assert.equal(plan.renderPolishQA.renderPolishWarnings.includes("clean_action_letterbox_background"), false);
  const ass = readFileSync(subtitlesPath, "utf8");
  assert.doesNotMatch(ass, /PUNCHY HIGHLIGHT/);
});

test("ball-follow renderer moves the action crop while the live scorebug stays fixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-ball-follow-"));
  const calls = [];
  const plan = validateEditPlan({
    ...validKineticPlan(),
    validGoalsOnly: true,
    framingMode: "safe_center",
    framingReason: "ball_follow_multi_moment_tracks_validated_action_timeline",
    visualTrackingSummary: {
      trackingProviderMode: "ffmpeg-football-tracking",
      trackingConfidence: 0.82,
      ballCandidateConfidence: 0.84,
      playerClusterConfidence: 0.78,
      ballTrackCount: 3,
      playerClusterCount: 3,
      celebrationHeadTrackCount: 1,
      fallbackUsed: false,
    },
    cropPlan: {
      mode: "ball_follow",
      targetAspectRatio: "9:16",
      safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
      cropBox: { x: 120, y: 0, width: 608, height: 1080 },
      confidence: 0.82,
      maxPanSpeed: 0.18,
      maxZoomSpeed: 0,
      hysteresis: 0.055,
      keyframes: [
        { sourceTime: 1, centerX: 420, centerY: 540, zoom: 1, confidence: 0.82, source: "ball_detection", reset: true },
        { sourceTime: 5, centerX: 960, centerY: 540, zoom: 1, confidence: 0.78, source: "player_cluster_fallback" },
        { sourceTime: 8, centerX: 1320, centerY: 540, zoom: 1, confidence: 0.84, source: "celebration_face_detection", trackingTarget: "celebration_head", reset: true },
        { sourceTime: 10, centerX: 1480, centerY: 540, zoom: 1, confidence: 0.86, source: "ball_detection" },
      ],
      fallbackUsed: false,
      textObstructionRisk: false,
      actionSafeZones: [],
      textSafeZones: [],
      reasonCodes: ["ball_follow_validated_tracking_timeline"],
    },
    cropStrategy: {
      type: "ball_follow_crop",
      x: 120,
      y: 0,
      width: 608,
      height: 1080,
      zoom: 1,
      background: "none",
      preserveFullFrame: false,
      maxCropPercent: 0.35,
    },
    scoreboardOverlay: {
      enabled: true,
      mode: "source_roi",
      regionId: "scorebug_broadcast_compact",
      sourceRect: { x: 0.04, y: 0.045, width: 0.33, height: 0.065 },
      outputWidthRatio: 0.46,
      topMarginRatio: 0.035,
    },
  }, metadata);

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath: join(dir, "output.mp4"),
    subtitlesPath: join(dir, "captions.ass"),
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  const filter = calls[0][calls[0].indexOf("-filter_complex") + 1];
  assert.match(filter, /crop=w=608:h=1080:x='if\(lt\(t,/);
  assert.match(filter, /\[base_source\]delogo=/);
  assert.match(filter, /\[score_source\]crop=iw\*0\.33/);
  assert.match(filter, /scale=496:-2\[scorebug\]/);
  assert.match(filter, /overlay=\(W-w\)\/2:67/);
  assert.doesNotMatch(filter, /boxblur|pad=1080:1920/);
  assert.equal(plan.renderPolishQA.actionLayoutMode, "ball_follow_with_synchronized_scorebug");
  assert.equal(plan.renderPolishQA.dynamicCropRendered, true);
  assert.ok(plan.renderPolishQA.cropKeyframeCount >= 3);
  assert.equal(plan.renderPolishQA.celebrationHeadTrackCount, 1);
  assert.equal(plan.renderPolishQA.celebrationHeadKeyframeCount, 1);
  assert.equal(plan.renderPolishQA.celebrationHeadFollowRendered, true);
  assert.equal(plan.renderPolishQA.trackingProviderMode, "ffmpeg-football-tracking");
  assert.equal(plan.renderPolishQA.sourceScoreboardDuplicateSuppressed, true);
});

test("edit plan rejects unsafe scoreboard overlay placement", () => {
  assert.throws(
    () => validateEditPlan({
      ...validKineticPlan(),
      scoreboardOverlay: {
        enabled: true,
        mode: "source_roi",
        regionId: "scorebug_broadcast_compact",
        sourceRect: { x: 0.8, y: 0.05, width: 0.4, height: 0.08 },
        outputWidthRatio: 0.95,
        topMarginRatio: 0.01,
      },
    }, metadata),
    /Scoreboard overlay/,
  );
});

test("multi-segment renderer accepts full valid-goal compilations up to 210 seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-long-goals-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    mode: "multi_moment_compilation",
    sourceStart: 120,
    sourceEnd: 392,
    segments: [
      {
        id: "goal_1",
        sourceStart: 120,
        sourceEnd: 152,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 126,
        finishTime: 142,
        confirmationTime: 150,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
      {
        id: "goal_2",
        sourceStart: 240,
        sourceEnd: 272,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 246,
        finishTime: 262,
        confirmationTime: 270,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
      {
        id: "goal_3",
        sourceStart: 360,
        sourceEnd: 392,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 366,
        finishTime: 382,
        confirmationTime: 390,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
    ],
    totalDuration: 96,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.92,
    hook: "VALID FINISHES ONLY",
    title: "Three valid goals",
    captions: [
      { start: 0, end: 2, text: "VALID FINISHES ONLY", role: "opening_hook" },
      { start: 32.4, end: 35, text: "MOMENT 2: FINISH COUNTS", role: "action_callout" },
      { start: 93, end: 96, text: "ONLY VALID FINISHES", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "reference_football_multi_goal_v1",
    reasonCodes: ["goal", "scoreboard_backed_goal_sequence"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 420, width: 1920, height: 1080 });

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(plan.totalDuration, 96);
  assert.equal(calls.length, 5);
  assert.equal(calls[4][calls[4].indexOf("-t") + 1], "96");
  assert.equal(plan.renderPolishQA.transitionRenderedCount, 2);
  assert.equal(plan.renderPolishQA.hardCutFallbackCount, 0);
});

test("proof-fast multi-segment renderer uses fast bounded encoding for every pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-proof-fast-multi-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    mode: "multi_moment_compilation",
    sourceStart: 0,
    sourceEnd: 40,
    segments: [
      {
        id: "goal_1",
        sourceStart: 4,
        sourceEnd: 18,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 9,
        finishTime: 13,
        confirmationTime: 16,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
      {
        id: "goal_2",
        sourceStart: 24,
        sourceEnd: 38,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 29,
        finishTime: 33,
        confirmationTime: 36,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
    ],
    totalDuration: 28,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.92,
    hook: "VALID FINISHES ONLY",
    title: "Two valid goals",
    captions: [
      { start: 0, end: 2, text: "VALID FINISHES ONLY", role: "opening_hook" },
      { start: 25, end: 28, text: "ONLY VALID FINISHES", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "reference_football_multi_goal_v1",
    reasonCodes: ["goal", "scoreboard_backed_goal_sequence"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 60, width: 1920, height: 1080 });
  plan.renderProfile = "proof_fast";

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0][calls[0].indexOf("-preset") + 1], "ultrafast");
  assert.equal(calls[1][calls[1].indexOf("-preset") + 1], "ultrafast");
  assert.equal(calls[0][calls[0].indexOf("-qp") + 1], "0");
  assert.equal(calls[1][calls[1].indexOf("-qp") + 1], "0");
  assert.equal(calls[3][calls[3].indexOf("-preset") + 1], "ultrafast");
  assert.equal(calls[3][calls[3].indexOf("-crf") + 1], "28");
  assert.equal(calls[3][calls[3].indexOf("-r") + 1], "30");
  assert.doesNotMatch(calls[3][calls[3].indexOf("-filter_complex") + 1], /boxblur=18:1/);
  assert.match(calls[3][calls[3].indexOf("-filter_complex") + 1], /pad=1080:1920/);
  assert.equal(plan.renderPolishQA.renderProfile, "proof_fast");
  assert.equal(plan.renderPolishQA.segmentRenderMode, "fast_fade_transcode");
  assert.equal(plan.renderPolishQA.outputWidth, 1080);
  assert.equal(plan.renderPolishQA.outputHeight, 1920);
  assert.equal(plan.renderPolishQA.actionLayoutMode, "clean_action_letterbox");
  assert.equal(plan.renderPolishQA.blurredBackgroundUsed, false);
  assert.equal(plan.renderPolishQA.duplicateBackgroundUsed, false);
});

test("render polish summary reports transition fallback when no multi-segment render happened", () => {
  const summary = createRenderPolishSummary({
    stylePreset: "reference_football_multi_goal_v1",
    totalDuration: 48,
    segments: [
      { id: "goal_1", sourceStart: 10, sourceEnd: 34, timelineStart: 0, timelineEnd: 24 },
      { id: "goal_2", sourceStart: 80, sourceEnd: 104, timelineStart: 24, timelineEnd: 48 },
    ],
    captions: [{ start: 0.2, end: 2.2, text: "VALID FINISHES ONLY" }],
    transitionPlan: [{ fromSegmentId: "goal_1", toSegmentId: "goal_2", timelineStart: 24, type: "short_fade" }],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { transitionRenderedCount: 0 });

  assert.equal(summary.renderStylePreset, "reference_football_multi_goal_v1");
  assert.equal(summary.transitionRenderedCount, 0);
  assert.equal(summary.hardCutFallbackCount, 1);
  assert.equal(summary.animatedCaptionCount, 1);
  assert.equal(summary.dynamicWordCaptionCount, 0);
  assert.equal(summary.captionMotion, "ass_fade_scale");
  assert.ok(summary.renderPolishWarnings.includes("hard_cut_fallback_used"));
  assert.doesNotMatch(JSON.stringify(summary), /\/Users|OPENAI_API_KEY|storageKey/i);
});

test("Real-ESRGAN enhances the clean visual layer before captions and audio are composed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-enhanced-"));
  const calls = [];
  const plan = validKineticPlan();
  plan.visualTrackingSummary = { sourceFrameRate: 60 };
  const enhancementConfig = {
    enabled: true,
    provider: "realesrgan-ncnn",
    binary: "realesrgan-ncnn-vulkan",
    model: "realesrgan-x4plus",
    scale: 2,
    tile: 0,
    fps: 30,
    timeoutMs: 1800000,
  };

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath: join(dir, "output.mp4"),
    subtitlesPath: join(dir, "captions.ass"),
    plan,
    enhancementConfig,
    ffmpegRunner: async (args) => calls.push(args),
    videoEnhancer: async ({ inputPath, outputPath, config }) => {
      assert.match(inputPath, /clean-base\.mkv$/);
      assert.match(outputPath, /enhanced-base\.mkv$/);
      assert.notEqual(config, enhancementConfig);
      assert.equal(config.fps, 30);
      return {
        enabled: true,
        applied: true,
        provider: config.provider,
        model: config.model,
        scale: config.scale,
        fps: config.fps,
        temporalMode: "frame_independent",
        overlayProtection: "compose_after_enhancement",
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf("-r") + 1], "30");
  assert.equal(calls[0][calls[0].indexOf("-qp") + 1], "0");
  assert.doesNotMatch(calls[0][calls[0].indexOf("-filter_complex") + 1], /subtitles=/);
  assert.match(calls[1][calls[1].indexOf("-filter_complex") + 1], /subtitles=/);
  assert.equal(calls[1][calls[1].indexOf("-r") + 1], "30");
  assert.equal(calls[1][calls[1].indexOf("-map") + 3], "1:a?");
  assert.equal(plan.renderPolishQA.videoEnhancementApplied, true);
  assert.equal(plan.renderPolishQA.videoEnhancementModel, "realesrgan-x4plus");
  assert.equal(plan.renderPolishQA.videoEnhancementOverlayProtection, "compose_after_enhancement");
});

test("automatic Real-ESRGAN failures fall back to the normal quality render", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-enhancement-fallback-"));
  const calls = [];
  const plan = validKineticPlan();
  const enhancementConfig = {
    mode: "auto",
    required: false,
    enabled: true,
    provider: "realesrgan-ncnn",
    binary: "realesrgan-ncnn-vulkan",
    model: "realesrgan-x4plus",
    scale: 2,
    tile: 0,
    fps: 30,
    timeoutMs: 120000,
  };

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath: join(dir, "output.mp4"),
    subtitlesPath: join(dir, "captions.ass"),
    plan,
    enhancementConfig,
    ffmpegRunner: async (args) => calls.push(args),
    videoEnhancer: async () => {
      throw Object.assign(new Error("bounded enhancement failure"), { code: "VIDEO_ENHANCEMENT_FAILED" });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(plan.renderPolishQA.videoEnhancementEnabled, true);
  assert.equal(plan.renderPolishQA.videoEnhancementApplied, false);
  assert.equal(plan.renderPolishQA.videoEnhancementFallbackUsed, true);
  assert.equal(plan.renderPolishQA.videoEnhancementFallbackReason, "VIDEO_ENHANCEMENT_FAILED");
  assert.ok(plan.renderPolishQA.renderPolishWarnings.includes("video_enhancement_auto_fallback"));
});

test("two-phase camera summary requires ball coverage before switching to scorer or group follow", () => {
  const summary = twoPhaseGoalCameraSummary({
    segments: [{
      goalNumber: 1,
      sourceStart: 2,
      finishTime: 10,
      confirmationTime: 16,
      sourceEnd: 18,
    }],
    visualTrackingSummary: { trackingSamples: [
      { sourceTime: 3, ballBox: { x: 290, y: 440, width: 20, height: 20 } },
      { sourceTime: 7, ballBox: { x: 690, y: 430, width: 20, height: 20 } },
      { sourceTime: 9.7, ballBox: { x: 890, y: 420, width: 20, height: 20 } },
    ] },
    cropPlan: {
      cropBox: { x: 0, y: 0, width: 608, height: 1080 },
      keyframes: [
        { sourceTime: 3, centerX: 300, source: "ball_detection", phase: "ball_follow", confidence: 0.82 },
        { sourceTime: 7, centerX: 700, source: "ball_detection", phase: "ball_follow", confidence: 0.86 },
        { sourceTime: 9.7, centerX: 900, source: "ball_interpolation", phase: "ball_follow", confidence: 0.72 },
        { sourceTime: 11, source: "celebration_group_fallback", phase: "scorer_follow", confidence: 0.78 },
        { sourceTime: 15, source: "celebration_group_fallback", phase: "scorer_follow", confidence: 0.8 },
      ],
    },
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.coveredGoalCount, 1);
  assert.equal(summary.goals[0].targetSwitchTime, 10);
  assert.equal(summary.goals[0].ballVisibilityCoverage, 1);
  assert.equal(summary.goals[0].ballCenterCoverage, 1);
  assert.equal(summary.goals[0].ballVerticalSafeCoverage, 1);
  assert.equal(summary.goals[0].scorerTargetMode, "celebration_group_fallback");
  assert.equal(summary.goalClaimAllowed, false);
});

test("two-phase camera summary accepts a low-confidence wide celebration fallback without an identity claim", () => {
  const summary = twoPhaseGoalCameraSummary({
    segments: [{ goalNumber: 1, sourceStart: 2, finishTime: 10, confirmationTime: 16, sourceEnd: 18 }],
    visualTrackingSummary: { trackingSamples: [
      { sourceTime: 3, ballBox: { x: 290, y: 440, width: 20, height: 20 } },
      { sourceTime: 9.7, ballBox: { x: 890, y: 420, width: 20, height: 20 } },
    ] },
    cropPlan: { cropBox: { x: 0, y: 0, width: 608, height: 1080 }, keyframes: [
      { sourceTime: 3, centerX: 300, source: "ball_detection", phase: "ball_follow", confidence: 0.82 },
      { sourceTime: 9.7, centerX: 900, source: "ball_detection", phase: "ball_follow", confidence: 0.8 },
      { sourceTime: 12, source: "celebration_wide_safe_fallback", phase: "scorer_follow", confidence: 0.45 },
    ] },
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.goals[0].scorerTargetMode, "celebration_wide_safe_fallback");
  assert.equal(summary.goals[0].scorerHeadCoverage, 0);
  assert.equal(summary.goals[0].verticalWideSafeFallbackRequired, false);
  assert.equal(summary.goalClaimAllowed, false);
});
