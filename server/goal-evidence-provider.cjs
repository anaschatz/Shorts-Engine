const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const { validateVisualSignals, visualReasonCodesForWindow } = require("./vision.cjs");

const DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS = 12000;
const MAX_EVIDENCE_EVENTS = 16;
const MAX_REASON_CODES = 14;
const POST_GOAL_CONTEXT_SECONDS = 15;

const GOAL_EVIDENCE_OUTCOMES = Object.freeze([
  "valid_goal",
  "offside_goal",
  "no_goal",
  "possible_goal_unconfirmed",
  "non_goal_chance",
]);

const GOAL_EVIDENCE_REASON_CODES = Object.freeze([
  "ball_in_net",
  "visual_ball_in_net",
  "visual_scoreboard_goal_confirmed",
  "visual_referee_goal_signal",
  "confirmed_by_commentary",
  "visual_offside_flag",
  "visual_no_goal_decision",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "visual_offside_line",
  "visual_var_check",
  "visual_var_decision",
  "offside_commentary",
  "flag_commentary",
  "disallowed_commentary",
  "no_goal_commentary",
  "var_check",
  "commentator_goal_call_support",
  "crowd_reaction_support",
  "replay_goal_confirmation",
  "kickoff_after_goal",
  "shot_sequence_support",
  "non_goal_chance",
]);

const SUPPLEMENTAL_VISUAL_BY_REASON = Object.freeze({
  visual_scoreboard_goal_confirmed: "scoreboard_goal_confirmed",
  visual_referee_goal_signal: "referee_goal_signal",
  visual_offside_flag: "assistant_referee_flag",
  visual_no_goal_decision: "scoreboard_no_goal",
  visual_referee_no_goal_signal: "referee_no_goal_signal",
  visual_scoreboard_goal_removed: "scoreboard_goal_removed",
  visual_offside_line: "offside_line_replay",
  visual_var_check: "var_check_graphic",
  visual_var_decision: "var_decision_graphic",
});

const CONFIRMED_CAPTION_TERMS = Object.freeze([
  "goal confirmed",
  "confirmed goal",
  "it counts",
  "the goal stands",
  "finish counts",
  "μετραει",
  "μετράει",
]);

const GOAL_CALL_TERMS = Object.freeze([
  "goal",
  "scores",
  "scored",
  "back of the net",
  "finds the net",
  "into the net",
  "γκολ",
  "σκοραρ",
  "σκόραρ",
]);

const OFFSIDE_TERMS = Object.freeze(["offside", "flag is up", "flag goes up", "οφσαιντ", "οφσάιντ", "σημαια", "σημαία"]);
const DISALLOWED_TERMS = Object.freeze(["disallowed", "ruled out", "no goal", "chalked off", "does not count", "δεν μετρά", "ακυρώνεται"]);
const VAR_TERMS = Object.freeze(["var", "check", "review", "checking", "video assistant", "ελεγχος", "έλεγχος"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function hasUnsafeValue(value) {
  const serialized = JSON.stringify(value || {});
  return /\/Users\/|\/private\/|storageKey|localPath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout/i.test(serialized);
}

function hasTerm(text, terms) {
  const safe = sanitizeText(text, 240).toLowerCase();
  return terms.some((term) => safe.includes(term.toLowerCase()));
}

function captionEvidence(caption = {}) {
  const text = sanitizeText(caption.text || "", 240);
  const reasons = [];
  if (hasTerm(text, CONFIRMED_CAPTION_TERMS)) reasons.push("confirmed_by_commentary");
  if (hasTerm(text, GOAL_CALL_TERMS)) reasons.push("commentator_goal_call_support");
  if (hasTerm(text, OFFSIDE_TERMS)) reasons.push("offside_commentary", "flag_commentary");
  if (hasTerm(text, DISALLOWED_TERMS)) reasons.push("disallowed_commentary", "no_goal_commentary");
  if (hasTerm(text, VAR_TERMS)) reasons.push("var_check");
  return [...new Set(reasons)];
}

function captionsInRange(captions = [], start = 0, end = 0) {
  return (Array.isArray(captions) ? captions : [])
    .filter((caption) => seconds(caption.start) <= end && seconds(caption.end) >= start)
    .map((caption) => ({
      start: seconds(caption.start),
      end: seconds(caption.end),
      reasonCodes: captionEvidence(caption),
    }))
    .filter((item) => item.reasonCodes.length);
}

function windowCenter(window = {}) {
  const start = seconds(window.start);
  const end = seconds(window.end, start);
  return seconds(window.center ?? (start + end) / 2, start);
}

function windowHasReason(window, reason) {
  return visualReasonCodesForWindow(window).includes(reason);
}

function visualDecisionReasons(window = {}) {
  return visualReasonCodesForWindow(window).filter((reason) => [
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "visual_offside_flag",
    "visual_no_goal_decision",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
    "visual_offside_line",
    "visual_var_check",
    "visual_var_decision",
    "visual_replay_angle",
  ].includes(reason));
}

function eventWindowForBallInNet(ballWindow, windows = [], metadata = {}) {
  const payoff = seconds(ballWindow.end, windowCenter(ballWindow));
  const start = Math.max(0, firstShotStartBefore(payoff, windows) ?? seconds(ballWindow.start) - 4);
  const duration = seconds(metadata.durationSeconds, payoff + POST_GOAL_CONTEXT_SECONDS);
  const end = Math.min(duration || payoff + POST_GOAL_CONTEXT_SECONDS, payoff + POST_GOAL_CONTEXT_SECONDS);
  return { start: round(start), end: round(end), payoff };
}

function firstShotStartBefore(payoff, windows = []) {
  const match = [...windows]
    .filter((window) => {
      const center = windowCenter(window);
      return center <= payoff + 0.5 &&
        center >= payoff - 18 &&
        ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal"].some((reason) => windowHasReason(window, reason));
    })
    .sort((a, b) => seconds(a.start) - seconds(b.start))[0];
  return match ? seconds(match.start) : null;
}

function reasonFlags(reasonCodes = []) {
  const reasons = new Set(reasonCodes);
  return {
    ballInNetEvidence: reasons.has("ball_in_net") || reasons.has("visual_ball_in_net"),
    scoreboardChanged: reasons.has("visual_scoreboard_goal_confirmed") || reasons.has("visual_scoreboard_goal_removed"),
    scoreboardGoalConfirmed: reasons.has("visual_scoreboard_goal_confirmed"),
    refereeGoalSignal: reasons.has("visual_referee_goal_signal"),
    kickoffAfterGoal: reasons.has("kickoff_after_goal"),
    replayGoalConfirmation: reasons.has("replay_goal_confirmation"),
    offsideFlag: reasons.has("visual_offside_flag") || reasons.has("flag_commentary") || reasons.has("offside_commentary"),
    VARNoGoalSignal: reasons.has("visual_no_goal_decision") ||
      reasons.has("visual_referee_no_goal_signal") ||
      reasons.has("visual_scoreboard_goal_removed") ||
      reasons.has("disallowed_commentary") ||
      reasons.has("no_goal_commentary"),
    commentatorGoalCall: reasons.has("confirmed_by_commentary") || reasons.has("commentator_goal_call_support"),
    crowdReactionSupport: reasons.has("crowd_reaction_support"),
  };
}

function outcomeForReasons(reasonCodes = []) {
  const reasons = new Set(reasonCodes);
  if (
    reasons.has("visual_offside_flag") ||
    reasons.has("visual_offside_line") ||
    reasons.has("visual_no_goal_decision") ||
    reasons.has("visual_referee_no_goal_signal") ||
    reasons.has("visual_scoreboard_goal_removed") ||
    reasons.has("offside_commentary") ||
    reasons.has("flag_commentary") ||
    reasons.has("disallowed_commentary") ||
    reasons.has("no_goal_commentary")
  ) {
    return "offside_goal";
  }
  if (
    reasons.has("visual_scoreboard_goal_confirmed") ||
    reasons.has("visual_referee_goal_signal") ||
    reasons.has("confirmed_by_commentary")
  ) {
    return "valid_goal";
  }
  if (reasons.has("ball_in_net") || reasons.has("visual_ball_in_net")) return "possible_goal_unconfirmed";
  return "non_goal_chance";
}

function normalizeReasonCodes(reasonCodes = []) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .map((reason) => sanitizeText(reason, 80))
    .filter(Boolean))]
    .filter((reason) => GOAL_EVIDENCE_REASON_CODES.includes(reason))
    .slice(0, MAX_REASON_CODES);
}

function normalizeEvent(event = {}, metadata = {}, index = 0) {
  if (!event || typeof event !== "object" || Array.isArray(event) || hasUnsafeValue(event)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const duration = seconds(metadata.durationSeconds, 0);
  const start = round(clamp(event.start, 0, duration || seconds(event.end, 0)));
  const end = round(clamp(event.end, start + 0.4, duration || seconds(event.end, start + 1)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const reasonCodes = normalizeReasonCodes(event.reasonCodes);
  if (!reasonCodes.length) throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  const outcomeHint = sanitizeText(event.outcomeHint || outcomeForReasons(reasonCodes), 48);
  if (!GOAL_EVIDENCE_OUTCOMES.includes(outcomeHint)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const flags = reasonFlags(reasonCodes);
  return {
    id: sanitizeText(event.id || `goal_evidence_${index + 1}`, 80),
    start,
    end,
    center: round((start + end) / 2),
    outcomeHint,
    confidence: round(clamp(event.confidence, 0.05, 0.98)),
    evidenceSource: sanitizeText(event.evidenceSource || "deterministic_goal_evidence", 60),
    reasonCodes,
    ...flags,
  };
}

function eventScore(event = {}) {
  const reasons = new Set(event.reasonCodes || []);
  const outcomeBoost = event.outcomeHint === "valid_goal" ? 1.1 : event.outcomeHint === "offside_goal" ? 0.9 : 0;
  const evidenceBoost = [
    "ball_in_net",
    "visual_ball_in_net",
    "visual_scoreboard_goal_confirmed",
    "visual_referee_goal_signal",
    "confirmed_by_commentary",
    "visual_offside_flag",
    "visual_no_goal_decision",
  ].reduce((score, reason) => score + (reasons.has(reason) ? 0.25 : 0), 0);
  return Number((Number(event.confidence || 0) + outcomeBoost + evidenceBoost).toFixed(4));
}

function validateGoalEvidenceOutput(output, metadata = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output) || hasUnsafeValue(output)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const rawEvents = Array.isArray(output.events) ? output.events : [];
  const events = rawEvents
    .map((event, index) => normalizeEvent(event, metadata, index))
    .sort((a, b) => eventScore(b) - eventScore(a) || a.start - b.start)
    .slice(0, MAX_EVIDENCE_EVENTS)
    .sort((a, b) => a.start - b.start);
  if (rawEvents.length !== events.length && rawEvents.length <= MAX_EVIDENCE_EVENTS) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const supplementalVisualWindows = events.flatMap((event) => supplementalWindowsForEvent(event, metadata));
  return {
    providerMode: sanitizeText(output.providerMode || "deterministic-goal-evidence", 60),
    fallbackUsed: Boolean(output.fallbackUsed),
    confidence: round(clamp(output.confidence ?? (events.length ? Math.max(...events.map((event) => event.confidence)) : 0), 0, 1)),
    events,
    supplementalVisualWindows,
    summary: {
      eventCount: events.length,
      validGoalCount: events.filter((event) => event.outcomeHint === "valid_goal").length,
      offsideOrNoGoalCount: events.filter((event) => ["offside_goal", "no_goal"].includes(event.outcomeHint)).length,
      unconfirmedGoalCount: events.filter((event) => event.outcomeHint === "possible_goal_unconfirmed").length,
      nonGoalChanceCount: events.filter((event) => event.outcomeHint === "non_goal_chance").length,
      goalEvidenceCoverage: events.some((event) => event.outcomeHint === "valid_goal") ? 1 : 0,
    },
  };
}

function supplementalWindowsForEvent(event = {}, metadata = {}) {
  const windows = [];
  const decisionReasons = (event.reasonCodes || []).filter((reason) => SUPPLEMENTAL_VISUAL_BY_REASON[reason]);
  for (const reason of decisionReasons) {
    windows.push({
      start: Math.max(0, round(event.end - 1.2)),
      end: round(event.end),
      types: [SUPPLEMENTAL_VISUAL_BY_REASON[reason]],
      confidence: event.confidence,
      source: "goal_evidence_provider",
    });
  }
  return validateVisualSignals({
    providerMode: "goal-evidence-provider",
    fallbackUsed: false,
    windows,
  }, metadata).windows;
}

function deterministicGoalEvidence(input = {}) {
  const metadata = input.metadata || {};
  const visualSignals = validateVisualSignals(
    input.visualSignals || { providerMode: "goal-evidence-input-none", fallbackUsed: true, windows: [] },
    metadata,
  );
  const windows = Array.isArray(visualSignals.windows) ? visualSignals.windows : [];
  const transcript = input.transcript || {};
  const captions = Array.isArray(transcript.captions) ? transcript.captions : [];
  const events = [];
  const ballInNetWindows = windows.filter((window) => windowHasReason(window, "visual_ball_in_net"));

  for (const [index, ballWindow] of ballInNetWindows.entries()) {
    const range = eventWindowForBallInNet(ballWindow, windows, metadata);
    const postEnd = Math.min(seconds(metadata.durationSeconds, range.end), range.payoff + POST_GOAL_CONTEXT_SECONDS);
    const nearbyWindows = windows.filter((window) => seconds(window.start) <= postEnd && seconds(window.end) >= range.start - 1);
    const visualReasons = [...new Set([
      "ball_in_net",
      "visual_ball_in_net",
      ...nearbyWindows.flatMap(visualDecisionReasons),
      ...(nearbyWindows.some((window) => windowHasReason(window, "visual_crowd_reaction")) ? ["crowd_reaction_support"] : []),
      ...(nearbyWindows.some((window) => windowHasReason(window, "visual_replay_indicator") || windowHasReason(window, "visual_replay_angle"))
        ? ["replay_goal_confirmation"]
        : []),
    ])];
    const textReasons = [...new Set(captionsInRange(captions, range.payoff - 0.5, postEnd).flatMap((item) => item.reasonCodes))];
    const reasonCodes = normalizeReasonCodes([...visualReasons, ...textReasons]);
    events.push({
      id: `goal_event_${index + 1}`,
      start: range.start,
      end: postEnd,
      confidence: Math.max(Number(ballWindow.confidence || 0.72), reasonCodes.includes("confirmed_by_commentary") ? 0.86 : 0.68),
      outcomeHint: outcomeForReasons(reasonCodes),
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes,
    });
  }

  const shotOnlyWindows = windows.filter((window) => (
    !ballInNetWindows.length &&
    ["visual_shot_contact", "visual_shot_like_motion", "visual_ball_toward_goal", "visual_goal_mouth", "visual_goal_area"].some((reason) => windowHasReason(window, reason))
  ));
  for (const [index, shotWindow] of shotOnlyWindows.slice(0, 4).entries()) {
    const start = Math.max(0, seconds(shotWindow.start) - 3);
    const end = Math.min(seconds(metadata.durationSeconds, seconds(shotWindow.end) + 8), seconds(shotWindow.end) + 8);
    events.push({
      id: `non_goal_chance_${index + 1}`,
      start,
      end,
      confidence: Math.min(0.74, Number(shotWindow.confidence || 0.62)),
      outcomeHint: "non_goal_chance",
      evidenceSource: "deterministic_visual_text_goal_evidence",
      reasonCodes: ["non_goal_chance", "shot_sequence_support"],
    });
  }

  return validateGoalEvidenceOutput({
    providerMode: "deterministic-goal-evidence",
    fallbackUsed: false,
    events,
  }, metadata);
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

function raceWithTimeout(promise, { signal, timeoutMs = DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return Promise.reject(cancellationError());
  let timer = null;
  let abortListener = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortListener);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => finish(reject, cancellationError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => {
      finish(reject, new AppError("GOAL_EVIDENCE_PROVIDER_TIMEOUT", SAFE_MESSAGES.AI_OUTPUT_INVALID, 504));
    }, Math.max(250, Math.min(DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS)));
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

class DeterministicGoalEvidenceProvider {
  health() {
    return {
      ready: true,
      mode: "deterministic-goal-evidence",
      networkRequired: false,
      goalClaimAllowed: false,
      providerTimeoutMs: DEFAULT_GOAL_EVIDENCE_TIMEOUT_MS,
    };
  }

  async analyzeGoalEvidence(input = {}) {
    return deterministicGoalEvidence(input);
  }
}

class ExternalGoalEvidenceProviderAdapter extends DeterministicGoalEvidenceProvider {
  constructor({ client = null } = {}) {
    super();
    this.client = client;
  }

  health() {
    return {
      ...super.health(),
      ready: Boolean(this.client),
      mode: this.client ? "external-goal-evidence-adapter" : "external-goal-evidence-disabled",
      networkRequired: Boolean(this.client),
    };
  }

  async analyzeGoalEvidence(input = {}) {
    if (!this.client || typeof this.client.analyzeGoalEvidence !== "function") {
      return validateGoalEvidenceOutput({
        ...deterministicGoalEvidence(input),
        providerMode: "deterministic-goal-evidence",
        fallbackUsed: true,
      }, input.metadata || {});
    }
    try {
      const output = await raceWithTimeout(this.client.analyzeGoalEvidence(input), {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });
      return validateGoalEvidenceOutput({
        ...output,
        providerMode: "external-goal-evidence-adapter",
        fallbackUsed: Boolean(output && output.fallbackUsed),
      }, input.metadata || {});
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      if (error && error.code === "AI_OUTPUT_INVALID") throw error;
      return validateGoalEvidenceOutput({
        ...deterministicGoalEvidence(input),
        providerMode: "deterministic-goal-evidence",
        fallbackUsed: true,
      }, input.metadata || {});
    }
  }
}

function createGoalEvidenceProvider({ mode, client } = {}) {
  const safeMode = sanitizeText(mode || "", 80).toLowerCase();
  if (safeMode === "external" || safeMode === "external-goal-evidence-adapter") {
    return new ExternalGoalEvidenceProviderAdapter({ client });
  }
  return new DeterministicGoalEvidenceProvider();
}

async function analyzeGoalEvidence(input = {}) {
  const provider = input.provider || createGoalEvidenceProvider({
    mode: input.providerMode || input.mode,
    client: input.providerClient || input.client,
  });
  return provider.analyzeGoalEvidence(input);
}

function mergeGoalEvidenceIntoVisualSignals(visualSignals, goalEvidence, metadata = {}) {
  const base = validateVisualSignals(
    visualSignals || { providerMode: "goal-evidence-merge-empty", fallbackUsed: true, windows: [] },
    metadata,
  );
  const supplemental = Array.isArray(goalEvidence && goalEvidence.supplementalVisualWindows)
    ? goalEvidence.supplementalVisualWindows
    : [];
  return validateVisualSignals({
    ...base,
    providerMode: base.providerMode,
    windows: [...base.windows, ...supplemental],
  }, metadata);
}

function publicGoalEvidence(goalEvidence) {
  const safe = goalEvidence && typeof goalEvidence === "object" ? goalEvidence : {};
  return {
    providerMode: sanitizeText(safe.providerMode || "deterministic-goal-evidence", 60),
    fallbackUsed: Boolean(safe.fallbackUsed),
    confidence: round(clamp(safe.confidence, 0, 1)),
    summary: safe.summary && typeof safe.summary === "object"
      ? {
          eventCount: Number(safe.summary.eventCount || 0),
          validGoalCount: Number(safe.summary.validGoalCount || 0),
          offsideOrNoGoalCount: Number(safe.summary.offsideOrNoGoalCount || 0),
          unconfirmedGoalCount: Number(safe.summary.unconfirmedGoalCount || 0),
          nonGoalChanceCount: Number(safe.summary.nonGoalChanceCount || 0),
          goalEvidenceCoverage: Number(safe.summary.goalEvidenceCoverage || 0),
        }
      : null,
    events: Array.isArray(safe.events)
      ? safe.events.map((event) => ({
          id: sanitizeText(event.id, 80),
          start: Number(event.start || 0),
          end: Number(event.end || 0),
          outcomeHint: sanitizeText(event.outcomeHint || "possible_goal_unconfirmed", 48),
          confidence: Number(event.confidence || 0),
          evidenceSource: sanitizeText(event.evidenceSource || "deterministic_goal_evidence", 60),
          reasonCodes: Array.isArray(event.reasonCodes) ? event.reasonCodes.map((reason) => sanitizeText(reason, 80)).slice(0, MAX_REASON_CODES) : [],
          ballInNetEvidence: Boolean(event.ballInNetEvidence),
          scoreboardGoalConfirmed: Boolean(event.scoreboardGoalConfirmed),
          refereeGoalSignal: Boolean(event.refereeGoalSignal),
          offsideFlag: Boolean(event.offsideFlag),
          VARNoGoalSignal: Boolean(event.VARNoGoalSignal),
          commentatorGoalCall: Boolean(event.commentatorGoalCall),
          crowdReactionSupport: Boolean(event.crowdReactionSupport),
        }))
      : [],
  };
}

module.exports = {
  GOAL_EVIDENCE_OUTCOMES,
  GOAL_EVIDENCE_REASON_CODES,
  POST_GOAL_CONTEXT_SECONDS,
  DeterministicGoalEvidenceProvider,
  ExternalGoalEvidenceProviderAdapter,
  analyzeGoalEvidence,
  createGoalEvidenceProvider,
  deterministicGoalEvidence,
  mergeGoalEvidenceIntoVisualSignals,
  publicGoalEvidence,
  validateGoalEvidenceOutput,
};
