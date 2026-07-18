const { AppError } = require("../../../errors.cjs");
const { contentHash, normalizeDraftBundle } = require("../contracts.cjs");
const { normalizeSpeechToken, scriptWords } = require("../narration/alignment.cjs");
const { compileTimingBoundAnimationIR } = require("./compiler.cjs");
const { buildGenericProductionAnimationPlan } = require("./semantic-production-plan-compiler.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticSentenceProductionAnimationPlan,
} = require("./semantic-sentence-production-plan-compiler.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");

const PRODUCTION_PROVIDER_ID = "hyperframes_local";
const PRODUCTION_RUNTIME_VERSION = "0.7.55";
const PRODUCTION_STYLE_VERSION = "1.9.0";
const SEMANTIC_PROFILE_ID = "wow_signal_case_v1";
const TEMPLATE_VERSION = "1.0.0";
const OUTFIT_FONT_SHA256 = "8cfe15c2c6de6ef8efff3eedbd52a383ac9ef23d6c23f6cd9f9b838f5f37dc36";
const ROLES = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);
const OPERATION_COUNTS = Object.freeze({ hook: 3, context: 2, evidence: 3, turn: 4, payoff: 5 });

function unsupported(field) {
  throw new AppError("ANIMATION_TEMPLATE_INVALID", "The approved storyboard cannot be rendered by the production animation grammar.", 409, { field });
}

function unsupportedAnimationProfile(value) {
  throw new AppError(
    "ANIMATION_PROFILE_INVALID",
    "The requested production animation profile is unsupported.",
    409,
    { field: "animationProfile", value: String(value || "") },
  );
}

function wrapText(value, maxCharacters = 22, maxLines = 2) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || (current.length + word.length + 1 > maxCharacters && lines.length < maxLines)) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (!lines.length) lines.push("UNTITLED");
  return lines.slice(0, maxLines).map((line) => line.slice(0, 50));
}

function sceneValue(scene, op, field, fallback = "") {
  const operation = scene.operations.find((candidate) => candidate.op === op);
  return String(operation?.[field] || fallback).trim();
}

function wordIndex(timing, beat, token, field) {
  const normalized = normalizeSpeechToken(token);
  const matches = timing.words.filter((word) => word.index >= beat.wordStartIndex && word.index < beat.wordEndIndex && normalizeSpeechToken(word.text) === normalized);
  if (matches.length !== 1) unsupported(field);
  return matches[0].index;
}

function anchor(type, extra = {}) { return { anchor: type, ...extra }; }

function operation({ op, targetId, from, to, easing, params, claimId, visualStatement, carryPolicy = "clear_at_scene_end" }) {
  return { op, targetId, from, to, easing, params, semanticClaimId: claimId, visualStatement, carryPolicy };
}

function semantic(role, scripted, visualStatement) {
  return { beatId: scripted[role].id, role, claimIds: [...scripted[role].claimIds], visualStatement };
}

function settledHold(startFrame, endFrame) {
  return endFrame > startFrame ? [{ startFrame, endFrame }] : [];
}

function buildWowSignalAnimationPlan(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timing = normalizeAnimationTimingContext(input.timingContext);
  if (draft.verticalId !== "dark_curiosity" || draft.brief.formatId !== "documented_mystery_v1") unsupported("formatId");
  if (draft.contentHash !== timing.draftHash) unsupported("draftHash");

  const scripted = Object.fromEntries(draft.script.beats.map((beat) => [beat.role, beat]));
  const beatById = new Map(timing.beats.map((beat) => [beat.beatId, beat]));
  const storyboardByBeatId = new Map();
  for (const scene of draft.storyboard.scenes) {
    if (scene.beatIds.length !== 1 || storyboardByBeatId.has(scene.beatIds[0])) unsupported("storyboard.scenes.beatIds");
    storyboardByBeatId.set(scene.beatIds[0], scene);
  }
  for (const role of ROLES) if (!scripted[role] || !beatById.has(scripted[role].id) || !storyboardByBeatId.has(scripted[role].id)) unsupported(`script.${role}`);
  const beats = Object.fromEntries(ROLES.map((role) => [role, beatById.get(scripted[role].id)]));
  const sourceScenes = Object.fromEntries(ROLES.map((role) => [role, storyboardByBeatId.get(scripted[role].id)]));
  const expectedTemplates = { hook: "hook_scene", context: "evidence_scene", evidence: "system_scale_scene", turn: "map_timeline_scene", payoff: "payoff_scene" };
  for (const role of ROLES) if (sourceScenes[role].template !== expectedTemplates[role]) unsupported(`storyboard.${role}.template`);
  const link = sourceScenes.evidence.operations.find((candidate) => candidate.op === "connect_nodes");
  if (!link || link.fromId !== "telescope" || link.toId !== "signal") unsupported("storyboard.evidence.connect_nodes");

  const cue = {
    hookSignal: wordIndex(timing, beats.hook, "signal", "timing.hook.signal"),
    hookWrote: wordIndex(timing, beats.hook, "wrote", "timing.hook.wrote"),
    hookWow: wordIndex(timing, beats.hook, "Wow", "timing.hook.wow"),
    contextFrequency: wordIndex(timing, beats.context, "frequency", "timing.context.frequency"),
    contextCommunication: wordIndex(timing, beats.context, "communication", "timing.context.communication"),
    contextLasted: wordIndex(timing, beats.context, "lasted", "timing.context.lasted"),
    contextDuration: wordIndex(timing, beats.context, "seventy-two", "timing.context.duration"),
    contextSeconds: wordIndex(timing, beats.context, "seconds", "timing.context.seconds"),
    evidenceStrength: wordIndex(timing, beats.evidence, "strength", "timing.evidence.strength"),
    evidenceFell: wordIndex(timing, beats.evidence, "fell", "timing.evidence.fell"),
    evidenceAs: wordIndex(timing, beats.evidence, "as", "timing.evidence.as"),
    evidenceSource: wordIndex(timing, beats.evidence, "source", "timing.evidence.source"),
    evidenceMaking: wordIndex(timing, beats.evidence, "making", "timing.evidence.making"),
    evidenceConvincing: wordIndex(timing, beats.evidence, "convincing", "timing.evidence.convincing"),
    turnLater: wordIndex(timing, beats.turn, "later", "timing.turn.later"),
    turnSearches: wordIndex(timing, beats.turn, "searches", "timing.turn.searches"),
    turnNever: wordIndex(timing, beats.turn, "never", "timing.turn.never"),
    turnSignal: wordIndex(timing, beats.turn, "signal", "timing.turn.signal"),
    turnAgain: wordIndex(timing, beats.turn, "again", "timing.turn.again"),
    turnNo: wordIndex(timing, beats.turn, "no", "timing.turn.no"),
    turnTransmission: wordIndex(timing, beats.turn, "transmission", "timing.turn.transmission"),
    payoffNot: wordIndex(timing, beats.payoff, "not", "timing.payoff.not"),
    payoffAliens: wordIndex(timing, beats.payoff, "aliens", "timing.payoff.aliens"),
    payoffUnexplained: wordIndex(timing, beats.payoff, "unexplained", "timing.payoff.unexplained"),
    payoffCandidate: wordIndex(timing, beats.payoff, "candidate", "timing.payoff.candidate"),
    payoffNo: wordIndex(timing, beats.payoff, "no", "timing.payoff.no"),
    payoffProof: wordIndex(timing, beats.payoff, "proof", "timing.payoff.proof"),
  };

  const metricLabel = scripted.context.onScreenText;
  const metricValue = (metricLabel.match(/\b\d[\d.,-]*\b/) || [sceneValue(sourceScenes.context, "show_evidence", "text", "72")])[0];
  const year = (scripted.hook.spokenText.match(/\b(?:19|20)\d{2}\b/) || ["RECORDED"])[0];
  const content = {
    compositionId: `dc_${draft.contentHash.slice(0, 24)}`,
    kicker: draft.brief.formatId.replace(/_v\d+$/, "").replace(/_/g, " ").toUpperCase(),
    titleLines: wrapText(draft.script.title.toUpperCase(), 20, 2),
    metricValue: metricValue.toUpperCase().slice(0, 32),
    metricLabel: metricLabel.toUpperCase().slice(0, 72),
    evidenceCode: sceneValue(sourceScenes.evidence, "show_evidence", "text", "RISE AND FALL").toUpperCase().slice(0, 32),
    evidenceLabel: scripted.evidence.onScreenText.toUpperCase().slice(0, 72),
    reasoningLeft: "ONE OBSERVATION",
    reasoningRight: "PROOF",
    payoffLines: wrapText(scripted.payoff.onScreenText.toUpperCase(), 24, 2),
    timelineLabels: [year, `${metricValue} SEC`, "BEAM", "SEARCHES", "VERDICT"],
    semantic: {
      profileId: SEMANTIC_PROFILE_ID,
      eventYearLabel: year,
      eraLabel: `${year} • RADIO OBSERVATION`,
      recordLabel: scripted.hook.onScreenText.toUpperCase(),
      annotationLabel: /\bwow\b/i.test(scripted.hook.spokenText) ? "WOW!" : "UNUSUAL",
      frequencyLabel: "NEAR A NOTABLE FREQUENCY",
      durationValue: metricValue.toUpperCase(),
      durationUnit: "SECONDS",
      sourceLabel: "PROMISING COMMUNICATION BAND",
      beamTitle: scripted.evidence.onScreenText.toUpperCase(),
      beamXAxis: sceneValue(sourceScenes.evidence, "connect_nodes", "label", "BEAM CROSSING").toUpperCase(),
      beamYAxis: "SIGNAL STRENGTH",
      interferenceLabel: "LOCAL INTERFERENCE LESS CONVINCING",
      disclosureLabel: String(sourceScenes.evidence.disclosure || "ILLUSTRATIVE RECONSTRUCTION").toUpperCase(),
      repeatRangeLabel: sceneValue(sourceScenes.turn, "advance_timeline", "date", "LATER SEARCHES").toUpperCase(),
      noRepeatLabel: sceneValue(sourceScenes.turn, "advance_timeline", "label", scripted.turn.onScreenText).toUpperCase(),
      transmissionLabel: "NO CONFIRMED TRANSMISSION",
      observationLabel: "ONE OBSERVATION",
      proofLabel: "PROOF",
      speculationLabel: /\baliens\b/i.test(scripted.payoff.spokenText) ? "ALIENS?" : "SPECULATION?",
      conclusionLabel: scripted.payoff.onScreenText.toUpperCase(),
      candidateLeadLabel: "STRONG UNEXPLAINED",
      candidateNounLabel: "CANDIDATE",
      uncertaintyLabel: sceneValue(sourceScenes.payoff, "show_uncertainty", "text", "ORIGIN UNRESOLVED").toUpperCase(),
      finalEvidenceLabel: "NO REPEATABLE PROOF",
    },
  };
  const assetManifestHash = contentHash({ grammar: "dark_curiosity_semantic_v2", storyboardHash: draft.storyboard.contentHash, outfitFontSha256: OUTFIT_FONT_SHA256 });
  const seed = Number.parseInt(contentHash({ draftHash: draft.contentHash, fps: timing.fps, durationFrames: timing.durationFrames, words: timing.words, beats: timing.beats }).slice(0, 8), 16) >>> 0;
  const dimensions = input.renderProfile === "final" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  const sceneStart = { hook: 0, context: beats.context.startFrame, evidence: beats.evidence.startFrame, turn: beats.turn.startFrame, payoff: beats.payoff.startFrame };
  const sceneEnd = { hook: sceneStart.context, context: sceneStart.evidence, evidence: sceneStart.turn, turn: sceneStart.payoff, payoff: timing.durationFrames };
  const claims = Object.fromEntries(ROLES.map((role) => [role, [...scripted[role].claimIds]]));
  for (const role of ROLES) if (claims[role].length > OPERATION_COUNTS[role]) unsupported(`script.${role}.claimIds`);
  const claimFor = (role, operationIndex) => claims[role][operationIndex % claims[role].length];
  const wordStartFrame = (wordIndex, offsetFrames = 0) => timing.words[wordIndex].startFrame + offsetFrames;
  const wordEndFrame = (wordIndex, offsetFrames = 0) => timing.words[wordIndex].endFrame - 1 + offsetFrames;
  const clampFrame = (desired, minimum, maximum, field) => {
    if (![desired, minimum, maximum].every(Number.isInteger) || minimum > maximum) unsupported(field);
    return Math.min(maximum, Math.max(minimum, desired));
  };
  const wordAnchorAt = (type, wordIndex, targetFrame, field) => {
    const baseFrame = type === "word_start" ? wordStartFrame(wordIndex) : wordEndFrame(wordIndex);
    const offsetFrames = targetFrame - baseFrame;
    if (!Number.isInteger(offsetFrames) || Math.abs(offsetFrames) > 90) unsupported(field);
    return anchor(type, offsetFrames === 0 ? { wordIndex } : { wordIndex, offsetFrames });
  };
  const wordStartAnchorAt = (wordIndex, targetFrame, field) => wordAnchorAt("word_start", wordIndex, targetFrame, field);
  const wordEndAnchorAt = (wordIndex, targetFrame, field) => wordAnchorAt("word_end", wordIndex, targetFrame, field);
  const focusHoldFrames = 18;

  const hookSignalSettle = wordEndFrame(cue.hookSignal);
  const hookWowStart = clampFrame(wordStartFrame(cue.hookWrote), hookSignalSettle + focusHoldFrames, sceneEnd.hook - 24 - focusHoldFrames, "timing.hook.focus");
  const hookWowSettle = clampFrame(wordEndFrame(cue.hookWow), hookWowStart + 24, sceneEnd.hook - focusHoldFrames, "timing.hook.wow");

  const contextFrequencySettle = wordEndFrame(cue.contextFrequency);
  const contextDurationStart = clampFrame(wordStartFrame(cue.contextLasted), contextFrequencySettle + focusHoldFrames, sceneEnd.context - 24 - focusHoldFrames, "timing.context.focus");
  const contextDurationSettle = clampFrame(wordEndFrame(cue.contextSeconds), contextDurationStart + 24, sceneEnd.context - focusHoldFrames, "timing.context.duration");

  const evidenceTransitionSettle = sceneStart.evidence + 30;
  const evidenceTraceSettle = wordEndFrame(cue.evidenceFell);
  const evidenceBeamMinimumSettle = wordStartFrame(cue.evidenceAs) + 30;
  const evidenceShapeMinimumSettle = Math.max(evidenceTransitionSettle, evidenceTraceSettle, evidenceBeamMinimumSettle);
  const evidenceInferenceStart = clampFrame(wordStartFrame(cue.evidenceMaking), evidenceShapeMinimumSettle + focusHoldFrames, sceneEnd.evidence - 24 - focusHoldFrames, "timing.evidence.focus");
  const evidenceShapeSettle = clampFrame(wordEndFrame(cue.evidenceSource, -10), evidenceShapeMinimumSettle, evidenceInferenceStart - focusHoldFrames, "timing.evidence.shape");
  const evidenceInferenceSettle = clampFrame(wordEndFrame(cue.evidenceConvincing), evidenceInferenceStart + 24, sceneEnd.evidence - focusHoldFrames, "timing.evidence.inference");

  const turnObservationSettle = sceneStart.turn + 26;
  const turnSearchStart = clampFrame(wordStartFrame(cue.turnNever, 4), turnObservationSettle + focusHoldFrames, sceneEnd.turn - 132, "timing.turn.searchStart");
  const turnSearchSettle = clampFrame(wordStartFrame(cue.turnSignal, -15), turnSearchStart + 30, sceneEnd.turn - 102, "timing.turn.searchSettle");
  const turnNoRepeatStart = clampFrame(wordStartFrame(cue.turnSignal, 3), turnSearchSettle + focusHoldFrames, sceneEnd.turn - 84, "timing.turn.noRepeatStart");
  const turnNoRepeatSettle = clampFrame(wordStartFrame(cue.turnNo, -17), turnNoRepeatStart + 24, sceneEnd.turn - 60, "timing.turn.noRepeatSettle");
  const turnTransmissionStart = clampFrame(wordStartFrame(cue.turnNo, 1), turnNoRepeatSettle + focusHoldFrames, sceneEnd.turn - 42, "timing.turn.transmissionStart");
  const turnTransmissionSettle = clampFrame(wordEndFrame(cue.turnTransmission, 6), turnTransmissionStart + 24, sceneEnd.turn - focusHoldFrames, "timing.turn.transmissionSettle");

  const payoffObservationSettle = sceneStart.payoff + 32;
  const finalReadabilityHoldFrames = 24;
  const payoffProofSettleMaximum = Math.min(sceneEnd.payoff - finalReadabilityHoldFrames - 1, beats.payoff.endFrame - 1);
  const payoffProofStartMaximum = payoffProofSettleMaximum - 27;
  const payoffCandidateSettleMaximum = payoffProofStartMaximum - focusHoldFrames;
  const payoffCandidateStartMaximum = payoffCandidateSettleMaximum - 24;
  const payoffRejectionSettleMaximum = payoffCandidateStartMaximum - focusHoldFrames;
  const payoffRejectionStartMaximum = payoffRejectionSettleMaximum - 24;
  const payoffRejectionStart = clampFrame(wordStartFrame(cue.payoffNot), payoffObservationSettle + focusHoldFrames, payoffRejectionStartMaximum, "timing.payoff.rejectionStart");
  const payoffRejectionSettle = clampFrame(wordEndFrame(cue.payoffAliens, 8), payoffRejectionStart + 24, payoffRejectionSettleMaximum, "timing.payoff.rejectionSettle");
  const payoffCandidateStart = clampFrame(wordStartFrame(cue.payoffUnexplained), payoffRejectionSettle + focusHoldFrames, payoffCandidateStartMaximum, "timing.payoff.candidateStart");
  const payoffCandidateSettle = clampFrame(wordEndFrame(cue.payoffCandidate, 8), payoffCandidateStart + 24, payoffCandidateSettleMaximum, "timing.payoff.candidateSettle");
  const payoffProofStart = clampFrame(wordStartFrame(cue.payoffNo), payoffCandidateSettle + focusHoldFrames, payoffProofStartMaximum, "timing.payoff.proofStart");
  const payoffProofSettle = clampFrame(wordEndFrame(cue.payoffProof), payoffProofStart + 27, payoffProofSettleMaximum, "timing.payoff.proofSettle");

  const scenes = [
    {
      id: "scene_hook", startFrame: sceneStart.hook, endFrame: sceneEnd.hook, template: "wow_observation_v1", templateVersion: TEMPLATE_VERSION,
      semantic: semantic("hook", scripted, "A dated radio observation reveals the handwritten reaction to one unusual signal."),
      entityIds: ["deep_background", "observation_record", "wow_annotation"],
      operations: [
        operation({ op: "create", targetId: "deep_background", from: anchor("beat_start", { beatId: scripted.hook.id }), to: anchor("word_end", { wordIndex: cue.hookSignal }), easing: "linear", params: { opacity: 1 }, claimId: claimFor("hook", 0), visualStatement: "Keep one continuous documented-mystery field behind every claim.", carryPolicy: "persistent" }),
        operation({ op: "draw_path", targetId: "observation_record", from: anchor("beat_start", { beatId: scripted.hook.id }), to: anchor("word_end", { wordIndex: cue.hookSignal }), easing: "ease_out_cubic", params: { direction: "left_to_right" }, claimId: claimFor("hook", 1), visualStatement: "Reveal a dated radio observation record and isolate its unusual signal column." }),
        operation({ op: "highlight", targetId: "wow_annotation", from: wordStartAnchorAt(cue.hookWrote, hookWowStart, "timing.hook.wow.from"), to: wordEndAnchorAt(cue.hookWow, hookWowSettle, "timing.hook.wow.to"), easing: "ease_out_cubic", params: { strength: 1 }, claimId: claimFor("hook", 2), visualStatement: "Write and circle WOW exactly when the narration names the astronomer's reaction." }),
      ], readabilityHolds: settledHold(beats.hook.endFrame, sceneEnd.hook), complexityCost: 7,
    },
    {
      id: "scene_context", startFrame: sceneStart.context, endFrame: sceneEnd.context, template: "frequency_duration_v1", templateVersion: TEMPLATE_VERSION,
      semantic: semantic("context", scripted, "A spectrum marker explains the notable frequency before a timer resolves to seventy-two seconds."),
      entityIds: ["deep_background", "frequency_scale", "duration_timer"],
      operations: [
        operation({ op: "create", targetId: "frequency_scale", from: anchor("beat_start", { beatId: scripted.context.id }), to: anchor("word_end", { wordIndex: cue.contextFrequency }), easing: "ease_in_out_cubic", params: { opacity: 1 }, claimId: claimFor("context", 0), visualStatement: "Reach and lock the notable frequency marker by the end of the narrated word frequency." }),
        operation({ op: "pulse", targetId: "duration_timer", from: wordStartAnchorAt(cue.contextLasted, contextDurationStart, "timing.context.duration.from"), to: wordEndAnchorAt(cue.contextSeconds, contextDurationSettle, "timing.context.duration.to"), easing: "smoothstep", params: { scale: 1.08, opacity: 1 }, claimId: claimFor("context", 1), visualStatement: "Draw a timer and reveal 72 seconds only while that duration is spoken." }),
      ], readabilityHolds: settledHold(beats.context.endFrame, sceneEnd.context), complexityCost: 3,
    },
    {
      id: "scene_evidence", startFrame: sceneStart.evidence, endFrame: sceneEnd.evidence, template: "telescope_beam_v1", templateVersion: TEMPLATE_VERSION,
      semantic: semantic("evidence", scripted, "A source crosses a labeled telescope beam while the measured signal rises and falls with it."),
      entityIds: ["deep_background", "beam_graph", "evidence_trace", "interference_label"],
      operations: [
        operation({ op: "draw_path", targetId: "beam_graph", from: anchor("word_start", { wordIndex: cue.evidenceAs }), to: wordEndAnchorAt(cue.evidenceSource, evidenceShapeSettle, "timing.evidence.shape.to"), easing: "ease_in_out_cubic", params: { direction: "left_to_right" }, claimId: claimFor("evidence", 0), visualStatement: "Replay a source crossing the telescope beam and connect it to the completed response below." }),
        operation({ op: "trace_signal", targetId: "evidence_trace", from: anchor("word_start", { wordIndex: cue.evidenceStrength }), to: anchor("word_end", { wordIndex: cue.evidenceFell }), easing: "smoothstep", params: { amplitude: 260, frequency: 1, decay: 1 }, claimId: claimFor("evidence", 1), visualStatement: "Complete the measured rise-and-fall curve inside the exact narrated phrase.", carryPolicy: "carry_to_next" }),
        operation({ op: "highlight", targetId: "interference_label", from: wordStartAnchorAt(cue.evidenceMaking, evidenceInferenceStart, "timing.evidence.inference.from"), to: wordEndAnchorAt(cue.evidenceConvincing, evidenceInferenceSettle, "timing.evidence.inference.to"), easing: "ease_out_cubic", params: { strength: 1 }, claimId: claimFor("evidence", 2), visualStatement: "Reveal that ordinary local interference is less convincing only when that inference is narrated." }),
      ], readabilityHolds: settledHold(beats.evidence.endFrame, sceneEnd.evidence), complexityCost: 11,
    },
    {
      id: "scene_turn", startFrame: sceneStart.turn, endFrame: sceneEnd.turn, template: "repeat_search_v1", templateVersion: TEMPLATE_VERSION,
      semantic: semantic("turn", scripted, "The original signal becomes one event on a timeline while every later search stays flat."),
      entityIds: ["deep_background", "evidence_trace", "search_timeline", "no_repeat_label", "transmission_label"],
      operations: [
        operation({ op: "morph_path", targetId: "evidence_trace", from: anchor("beat_start", { beatId: scripted.turn.id }), to: anchor("beat_start", { beatId: scripted.turn.id, offsetFrames: 26 }), easing: "smoothstep", params: { toShape: "node" }, claimId: claimFor("turn", 0), visualStatement: "Condense the observed curve into one isolated timeline event before later search passes begin." }),
        operation({ op: "stagger", targetId: "search_timeline", from: wordStartAnchorAt(cue.turnNever, turnSearchStart, "timing.turn.search.from"), to: wordStartAnchorAt(cue.turnSignal, turnSearchSettle, "timing.turn.search.to"), easing: "ease_in_out_cubic", params: { delayFrames: 5 }, claimId: claimFor("turn", 1), visualStatement: "Reveal multiple later search passes in sequence, stop cleanly, and hold their zero results before stating the conclusion." }),
        operation({ op: "highlight", targetId: "no_repeat_label", from: wordStartAnchorAt(cue.turnSignal, turnNoRepeatStart, "timing.turn.noRepeat.from"), to: wordStartAnchorAt(cue.turnNo, turnNoRepeatSettle, "timing.turn.noRepeat.to"), easing: "ease_in_out_cubic", params: { strength: 1 }, claimId: claimFor("turn", 2), visualStatement: "Land NO VERIFIED REPEAT only after the failed search markers have remained settled for eighteen frames." }),
        operation({ op: "fade", targetId: "transmission_label", from: wordStartAnchorAt(cue.turnNo, turnTransmissionStart, "timing.turn.transmission.from"), to: wordEndAnchorAt(cue.turnTransmission, turnTransmissionSettle, "timing.turn.transmission.to"), easing: "ease_in_out_cubic", params: { from: 0, to: 1 }, claimId: claimFor("turn", 3), visualStatement: "State that no confirmed transmission explains the observation when that limit is narrated." }),
      ], readabilityHolds: settledHold(beats.turn.endFrame, sceneEnd.turn), complexityCost: 14,
    },
    {
      id: "scene_payoff", startFrame: sceneStart.payoff, endFrame: sceneEnd.payoff, template: "evidence_payoff_v1", templateVersion: TEMPLATE_VERSION,
      semantic: semantic("payoff", scripted, "One observation rejects the aliens leap and settles under unexplained rather than proof."),
      entityIds: ["deep_background", "evidence_node", "reasoning_bridge", "payoff_label", "final_evidence_label"],
      operations: [
        operation({ op: "transition_match", targetId: "evidence_node", from: anchor("beat_start", { beatId: scripted.payoff.id }), to: anchor("beat_start", { beatId: scripted.payoff.id, offsetFrames: 32 }), easing: "ease_in_out_cubic", params: { toEntityId: "evidence_node" }, claimId: claimFor("payoff", 0), visualStatement: "Carry the single observation into the verdict, settle it, and hold before evaluating the unsupported interpretation." }),
        operation({ op: "fade", targetId: "reasoning_bridge", from: wordStartAnchorAt(cue.payoffNot, payoffRejectionStart, "timing.payoff.rejection.from"), to: wordEndAnchorAt(cue.payoffAliens, payoffRejectionSettle, "timing.payoff.rejection.to"), easing: "ease_in_out_cubic", params: { from: 0, to: 1 }, claimId: claimFor("payoff", 1), visualStatement: "Strike the aliens speculation deliberately, then leave the rejection settled on screen." }),
        operation({ op: "fade", targetId: "payoff_label", from: wordStartAnchorAt(cue.payoffUnexplained, payoffCandidateStart, "timing.payoff.candidate.from"), to: wordEndAnchorAt(cue.payoffCandidate, payoffCandidateSettle, "timing.payoff.candidate.to"), easing: "ease_in_out_cubic", params: { from: 0, to: 1 }, claimId: claimFor("payoff", 2), visualStatement: "Move the surviving observation into the UNEXPLAINED conclusion and let it settle." }),
        operation({ op: "highlight", targetId: "final_evidence_label", from: wordStartAnchorAt(cue.payoffNo, payoffProofStart, "timing.payoff.proof.from"), to: wordEndAnchorAt(cue.payoffProof, payoffProofSettle, "timing.payoff.proof.to"), easing: "ease_in_out_cubic", params: { strength: 1 }, claimId: claimFor("payoff", 3), visualStatement: "Land NO REPEATABLE PROOF on the final spoken phrase." }),
        operation({ op: "pulse", targetId: "deep_background", from: anchor("beat_start", { beatId: scripted.payoff.id }), to: wordEndAnchorAt(cue.payoffProof, payoffProofSettle, "timing.payoff.background.to"), easing: "smoothstep", params: { scale: 1.04, opacity: 0.22 }, claimId: claimFor("payoff", 4), visualStatement: "Sustain restrained motion behind the final evidence verdict.", carryPolicy: "persistent" }),
      ], readabilityHolds: settledHold(payoffProofSettle + 1, timing.durationFrames), complexityCost: 13,
    },
  ];

  const focusPolicy = Object.freeze({ mode: "single_primary", supportingOpacity: 0.42, dimmedOpacity: 0.14, preserveContext: true, captionPolicy: "avoid" });
  const stateSpecs = [
    { id: "observation_record", role: "hook", settleFrames: 18, supportingEntityIds: ["observation_record", "wow_annotation"], semanticStatement: "The documented anomaly remains the same observed signal when the handwritten reaction appears." },
    { id: "frequency_context", role: "context", settleFrames: 24, supportingEntityIds: ["frequency_scale", "duration_timer"], semanticStatement: "The observed signal becomes the frequency marker before its measured duration is isolated." },
    { id: "beam_response", role: "evidence", settleFrames: 30, supportingEntityIds: ["beam_graph", "evidence_trace", "interference_label"], semanticStatement: "The same signal opens into the measured beam-shaped response and supports the interference inference." },
    { id: "failed_repeat_search", role: "turn", settleFrames: 26, supportingEntityIds: ["search_timeline", "no_repeat_label", "transmission_label"], semanticStatement: "The same observation compresses into one timeline event while every later verification attempt remains empty." },
    { id: "bounded_candidate", role: "payoff", settleFrames: 32, supportingEntityIds: ["evidence_node", "reasoning_bridge", "payoff_label", "final_evidence_label"], semanticStatement: "The same observation becomes an open candidate boundary that cannot close into repeatable proof." },
  ];
  const graphStates = stateSpecs.map((spec) => ({
    id: spec.id,
    beatId: scripted[spec.role].id,
    claimIds: [...claims[spec.role]],
    primaryEntityId: "signal_evidence",
    supportingEntityIds: spec.supportingEntityIds,
    enterAnchor: anchor("absolute", { frame: sceneStart[spec.role] }),
    settleAnchor: anchor("beat_start", { beatId: scripted[spec.role].id, offsetFrames: spec.settleFrames }),
    exitAnchor: anchor("absolute", { frame: sceneEnd[spec.role] - 1 }),
    carriedEntityIds: ["signal_evidence"],
    focusPolicy: { ...focusPolicy },
    semanticStatement: spec.semanticStatement,
  }));
  const representationIds = ["signal_observation_rep", "signal_frequency_rep", "signal_beam_rep", "signal_timeline_rep", "signal_candidate_rep"];
  const geometryTokens = ["observation_spike_v1", "frequency_cursor_v1", "beam_response_v1", "timeline_spike_v1", "candidate_boundary_v1"];
  const stateTransitions = stateSpecs.slice(1).map((spec, index) => ({
    id: `signal_transition_${index + 1}`,
    fromStateId: stateSpecs[index].id,
    toStateId: spec.id,
    continuityBindingId: `signal_continuity_${index + 1}`,
    fromAnchor: anchor("beat_start", { beatId: scripted[spec.role].id }),
    toAnchor: anchor("beat_start", { beatId: scripted[spec.role].id, offsetFrames: spec.settleFrames }),
    easing: "ease_in_out_cubic",
  }));
  const makeFocus = (id, stateId, role, primaryEntityId, supportingEntityIds, startFrame, settleFrame, endFrame) => ({
    id,
    stateId,
    claimId: claims[role][0],
    primaryEntityId,
    supportingEntityIds,
    startFrame,
    settleFrame,
    endFrame,
    supportingOpacity: 0.42,
    dimmedOpacity: 0.14,
  });
  const focusIntervals = [
    makeFocus("focus_hook_signal", "observation_record", "hook", "signal_evidence", ["observation_record"], sceneStart.hook, hookSignalSettle, hookWowStart),
    makeFocus("focus_hook_wow", "observation_record", "hook", "wow_annotation", ["signal_evidence", "observation_record"], hookWowStart, hookWowSettle, sceneEnd.hook),
    makeFocus("focus_context_frequency", "frequency_context", "context", "signal_evidence", ["frequency_scale"], sceneStart.context, contextFrequencySettle, contextDurationStart),
    makeFocus("focus_context_duration", "frequency_context", "context", "duration_timer", ["signal_evidence", "frequency_scale"], contextDurationStart, contextDurationSettle, sceneEnd.context),
    makeFocus("focus_evidence_shape", "beam_response", "evidence", "signal_evidence", ["beam_graph", "evidence_trace"], sceneStart.evidence, evidenceShapeSettle, evidenceInferenceStart),
    makeFocus("focus_evidence_inference", "beam_response", "evidence", "interference_label", ["signal_evidence", "beam_graph"], evidenceInferenceStart, evidenceInferenceSettle, sceneEnd.evidence),
    makeFocus("focus_turn_observation", "failed_repeat_search", "turn", "signal_evidence", ["search_timeline"], sceneStart.turn, turnObservationSettle, turnSearchStart),
    makeFocus("focus_turn_searches", "failed_repeat_search", "turn", "search_timeline", ["signal_evidence"], turnSearchStart, turnSearchSettle, turnNoRepeatStart),
    makeFocus("focus_turn_no_repeat", "failed_repeat_search", "turn", "no_repeat_label", ["signal_evidence", "search_timeline"], turnNoRepeatStart, turnNoRepeatSettle, turnTransmissionStart),
    makeFocus("focus_turn_transmission", "failed_repeat_search", "turn", "transmission_label", ["signal_evidence"], turnTransmissionStart, turnTransmissionSettle, sceneEnd.turn),
    makeFocus("focus_payoff_observation", "bounded_candidate", "payoff", "signal_evidence", ["evidence_node"], sceneStart.payoff, payoffObservationSettle, payoffRejectionStart),
    makeFocus("focus_payoff_rejection", "bounded_candidate", "payoff", "reasoning_bridge", ["signal_evidence"], payoffRejectionStart, payoffRejectionSettle, payoffCandidateStart),
    makeFocus("focus_payoff_candidate", "bounded_candidate", "payoff", "payoff_label", ["signal_evidence"], payoffCandidateStart, payoffCandidateSettle, payoffProofStart),
    makeFocus("focus_payoff_proof", "bounded_candidate", "payoff", "final_evidence_label", ["signal_evidence"], payoffProofStart, payoffProofSettle, timing.durationFrames),
  ];
  const visualStateGraph = {
    schemaVersion: 1,
    graphId: "wow_signal_visual_state_v1",
    bindings: { draftHash: draft.contentHash, alignmentHash: timing.alignmentHash, timingContextHash: timing.contentHash },
    entryStateId: stateSpecs[0].id,
    terminalStateId: stateSpecs.at(-1).id,
    states: graphStates,
    persistentEntities: [{
      id: "signal_evidence",
      kind: "matched_path",
      browserEntityId: "signal_evidence",
      representations: stateSpecs.map((spec, index) => ({ id: representationIds[index], stateId: spec.id, geometryToken: geometryTokens[index], styleToken: "signal_cyan", pointCount: 128 })),
    }],
    stateTransitions,
    continuityBindings: stateTransitions.map((transition, index) => ({ id: transition.continuityBindingId, persistentEntityId: "signal_evidence", fromRepresentationId: representationIds[index], toRepresentationId: representationIds[index + 1], interpolation: "matched_control_points", preserveIdentity: true })),
    focusIntervals,
    semanticMotionConcurrency: { profile: "single_primary_v1", maxPrimaryActions: 1, maxSupportingActions: 3, minimumSettleFrames: 18, ambientEntityIds: ["deep_background"] },
  };

  return {
    schemaVersion: 1,
    profile: "dark_curiosity_continuous",
    profileVersion: "1.1.0",
    projectId: String(input.projectId),
    projectRevision: Number(input.projectRevision),
    verticalId: "dark_curiosity",
    ...dimensions,
    fps: timing.fps,
    durationFrames: timing.durationFrames,
    draftHash: draft.contentHash,
    alignmentHash: timing.alignmentHash,
    assetManifestHash,
    renderer: { provider: PRODUCTION_PROVIDER_ID, runtimeVersion: PRODUCTION_RUNTIME_VERSION, styleVersion: PRODUCTION_STYLE_VERSION },
    seed,
    content,
    sharedEntities: [
      { id: "deep_background", type: "background", role: "ambient_field", layer: 0, styleToken: "navy_depth" },
      { id: "signal_evidence", type: "persistent_signal", role: "observed_evidence", layer: 7, styleToken: "signal_cyan" },
      { id: "observation_record", type: "observation_record", role: "documented_signal_record", layer: 2, styleToken: "paper_record" },
      { id: "wow_annotation", type: "annotation", role: "astronomer_reaction", layer: 3, styleToken: "marker_amber", text: content.semantic.annotationLabel },
      { id: "frequency_scale", type: "frequency_scale", role: "notable_frequency", layer: 2, styleToken: "spectrum_cyan" },
      { id: "duration_timer", type: "duration_timer", role: "observed_duration", layer: 3, styleToken: "timer_amber", text: `${content.semantic.durationValue} ${content.semantic.durationUnit}` },
      { id: "beam_graph", type: "beam_graph", role: "telescope_beam_relationship", layer: 2, styleToken: "beam_violet" },
      { id: "evidence_trace", type: "waveform", role: "measured_signal_strength", layer: 3, styleToken: "signal_cyan" },
      { id: "interference_label", type: "label", role: "interference_inference", layer: 4, styleToken: "evidence_cyan", text: content.semantic.interferenceLabel },
      { id: "search_timeline", type: "search_timeline", role: "later_searches", layer: 2, styleToken: "timeline_cyan" },
      { id: "no_repeat_label", type: "label", role: "repeat_search_outcome", layer: 3, styleToken: "warning_amber", text: content.semantic.noRepeatLabel },
      { id: "transmission_label", type: "label", role: "transmission_outcome", layer: 4, styleToken: "evidence_cyan", text: content.semantic.transmissionLabel },
      { id: "evidence_node", type: "evidence_node", role: "single_observation", layer: 3, styleToken: "evidence_cyan", text: content.semantic.observationLabel },
      { id: "reasoning_bridge", type: "proof_bridge", role: "evidence_not_proof", layer: 4, styleToken: "proof_amber" },
      { id: "payoff_label", type: "label", role: "bounded_conclusion", layer: 5, styleToken: "payoff_amber", text: content.semantic.conclusionLabel },
      { id: "final_evidence_label", type: "label", role: "repeatable_proof_outcome", layer: 6, styleToken: "warning_amber", text: content.semantic.finalEvidenceLabel },
    ],
    scenes,
    transitions: ROLES.slice(1).map((role, index) => {
      const previous = ROLES[index];
      const boundary = sceneStart[role];
      return { fromSceneId: `scene_${previous}`, toSceneId: `scene_${role}`, sharedEntityId: "signal_evidence", startFrame: boundary, endFrame: Math.min(sceneEnd[role], boundary + stateSpecs[index + 1].settleFrames) };
    }),
    visualStateGraph,
    motionBudget: { profile: "dark_curiosity", maxCost: 60, maxConcurrentOperations: 8, maxCameraScale: 1.15, maxTravelPxPerFrame: 12, captionSafeZone: { topRatio: 0.74, bottomRatio: 1 } },
  };
}

function usesLegacyWowSignalStoryboard(draft) {
  const scripted = Object.fromEntries(draft.script.beats.map((beat) => [beat.role, beat]));
  const evidenceBeatId = scripted.evidence?.id;
  const evidenceScene = draft.storyboard.scenes.find((scene) => scene.beatIds.includes(evidenceBeatId));
  const link = evidenceScene?.operations.find((operation) => operation.op === "connect_nodes");
  const documentedCase = `${draft.brief.topic} ${draft.brief.thesis}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return Boolean(
    documentedCase.includes("wow signal")
    && link?.fromId === "telescope"
    && link?.toId === "signal"
    && /\bastronomer\b/i.test(scripted.hook?.spokenText || "")
    && /\binterstellar\b/i.test(scripted.context?.spokenText || "")
    && /\btelescope\b/i.test(scripted.evidence?.spokenText || ""),
  );
}

function timingMatchesApprovedScript(draft, timing) {
  const approvedWords = scriptWords(draft.script);
  return approvedWords.length === timing.words.length && approvedWords.every(
    (word, index) => normalizeSpeechToken(word.text) === normalizeSpeechToken(timing.words[index].text),
  );
}

function buildProductionAnimationPlan(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  if (draft.verticalId !== "dark_curiosity" || draft.brief.formatId !== "documented_mystery_v1") unsupported("formatId");
  if (draft.contentHash !== timingContext.draftHash) unsupported("draftHash");
  if (!timingMatchesApprovedScript(draft, timingContext)) unsupported("timingContext.words");
  if (
    input.animationProfile === SEMANTIC_SENTENCE_PROFILE_TOKEN
    || input.animationProfile === SEMANTIC_SENTENCE_PROFILE_ID
  ) {
    return buildSemanticSentenceProductionAnimationPlan({
      ...input,
      draft,
      timingContext,
      semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
    });
  }
  if (input.animationProfile !== undefined && input.animationProfile !== null && input.animationProfile !== "") {
    unsupportedAnimationProfile(input.animationProfile);
  }
  if (usesLegacyWowSignalStoryboard(draft)) {
    try {
      return buildWowSignalAnimationPlan({ ...input, draft, timingContext });
    } catch (error) {
      if (error?.code !== "ANIMATION_TEMPLATE_INVALID") throw error;
    }
  }
  return buildGenericProductionAnimationPlan({ ...input, draft, timingContext });
}

function compileProductionAnimation(input = {}) {
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const plan = buildProductionAnimationPlan({ ...input, timingContext });
  const animationIR = compileTimingBoundAnimationIR(plan, timingContext);
  return Object.freeze({ timingContext, plan: Object.freeze(structuredClone(plan)), animationIR });
}

module.exports = {
  OUTFIT_FONT_SHA256,
  PRODUCTION_PROVIDER_ID,
  PRODUCTION_RUNTIME_VERSION,
  PRODUCTION_STYLE_VERSION,
  SEMANTIC_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
  buildProductionAnimationPlan,
  compileProductionAnimation,
};
