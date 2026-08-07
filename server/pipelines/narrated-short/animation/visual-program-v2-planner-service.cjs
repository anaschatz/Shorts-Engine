"use strict";

const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
  VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS,
  buildDeterministicVisualProgramV2PlannerChoice,
  buildVisualProgramV2PlannerContext,
  materializeVisualProgramProposalV2,
  normalizeVisualProgramV2PlannerChoice,
} = require("./visual-program-v2-planner-contract.cjs");
const {
  compileGeneralizedVisualProgramV2,
} = require("./visual-program-v2-compiler.cjs");
const {
  evaluateVisualProgramV2Repetition,
  evaluateVisualProgramV2SemanticTrace,
} = require("./visual-program-v2-quality-gates.cjs");
const {
  createLocalLlmVisualProgramV2Planner,
} = require("./providers/local-llm-visual-program-v2-planner.cjs");

const MAX_AGGREGATE_TIMEOUT_MS = 10 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;
const REJECTION_CODE_BY_PROVIDER_FAILURE = Object.freeze({
  ANIMATION_LOCAL_LLM_CHOICE_FOCUS_GROUNDING_INVALID: "focus_not_grounded",
  ANIMATION_LOCAL_LLM_CHOICE_FOCUS_DOMINANCE_INVALID: "focus_not_dominant",
  ANIMATION_LOCAL_LLM_CHOICE_SCENE_DENSITY_INVALID: "scene_density_exceeded",
  ANIMATION_LOCAL_LLM_CHOICE_PARTICIPANT_BUDGET_INVALID:
    "participant_budget_exceeded",
  ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID: "partition_invalid",
});

function fail(field, reason = "invalid", status = 500) {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual-program planner is invalid.",
    status,
    { field, reason },
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function safeFailure(failure) {
  if (failure === null) return null;
  if (!failure || typeof failure !== "object"
    || typeof failure.code !== "string"
    || typeof failure.phase !== "string"
    || typeof failure.retryable !== "boolean") {
    fail("planner.result.failure", "safe_failure_required", 502);
  }
  return Object.freeze({
    code: failure.code,
    phase: failure.phase,
    retryable: failure.retryable,
  });
}

function plannerMetadata(planner) {
  if (!planner || typeof planner !== "object"
    || typeof planner.id !== "string"
    || typeof planner.mode !== "string"
    || typeof planner.health !== "function"
    || typeof planner.propose !== "function") {
    fail("planner", "planner_contract_required");
  }
  const health = planner.health();
  if (!health || typeof health !== "object"
    || health.mode !== planner.mode
    || typeof health.promptProfileId !== "string"
    || !HASH_RE.test(health.configurationHash || "")
    || !Number.isInteger(health.maximumAttempts)
    || health.maximumAttempts !== VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS
    || !Number.isInteger(health.aggregateTimeoutMs)
    || health.aggregateTimeoutMs < 1
    || health.aggregateTimeoutMs > MAX_AGGREGATE_TIMEOUT_MS) {
    fail("planner.health", "planner_health_contract_required");
  }
  return Object.freeze({
    plannerId: planner.id,
    mode: planner.mode,
    promptProfileId: health.promptProfileId,
    configurationHash: health.configurationHash,
    aggregateTimeoutMs: health.aggregateTimeoutMs,
  });
}

function aggregateGuard(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let callerCancelled = externalSignal?.aborted === true;
  let deadlineExpired = false;
  let rejectTerminal;
  const terminal = new Promise((_resolve, reject) => {
    rejectTerminal = reject;
  });
  terminal.catch(() => {});
  const cancel = () => {
    if (callerCancelled || deadlineExpired) return;
    callerCancelled = true;
    rejectTerminal(new AppError(
      "JOB_CANCELLED",
      SAFE_MESSAGES.JOB_CANCELLED,
      409,
    ));
    controller.abort();
  };
  if (callerCancelled) {
    rejectTerminal(new AppError(
      "JOB_CANCELLED",
      SAFE_MESSAGES.JOB_CANCELLED,
      409,
    ));
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", cancel, { once: true });
  }
  const timeout = setTimeout(() => {
    if (callerCancelled || deadlineExpired) return;
    deadlineExpired = true;
    rejectTerminal(new AppError(
      "ANIMATION_LOCAL_LLM_VISUAL_PROGRAM_AGGREGATE_TIMEOUT",
      "The local visual-program planner exceeded its aggregate deadline.",
      504,
    ));
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get callerCancelled() {
      return callerCancelled || externalSignal?.aborted === true;
    },
    get deadlineExpired() {
      return deadlineExpired;
    },
    race(value) {
      return Promise.race([Promise.resolve(value), terminal]);
    },
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", cancel);
      controller.abort();
    },
  };
}

function validatePlannerResult(result, plannerInfo) {
  if (!result || typeof result !== "object"
    || !["local_openai_compatible", "deterministic_mock", "deterministic_fallback"]
      .includes(result.providerId)
    || typeof result.modelId !== "string" || !result.modelId
    || result.promptProfileId !== plannerInfo.promptProfileId
    || typeof result.fallbackUsed !== "boolean"
    || (result.providerSelectionHash !== null
      && !HASH_RE.test(result.providerSelectionHash || ""))
    || (!result.fallbackUsed
      && !HASH_RE.test(result.providerSelectionHash || ""))
    || (result.fallbackUsed !== (result.failure !== null))) {
    fail("planner.result", "planner_result_invalid", 502);
  }
  return {
    providerId: result.providerId,
    modelId: result.modelId,
    promptProfileId: result.promptProfileId,
    fallbackUsed: result.fallbackUsed,
    providerSelectionHash: result.providerSelectionHash,
    failure: safeFailure(result.failure),
    choice: result.choice,
  };
}

function safeStoryId(value, fallback) {
  const storyId = String(value || fallback).trim();
  if (!storyId || storyId.length > 120 || /[\u0000-\u001f]/.test(storyId)) {
    fail("storyId", "bounded_text_required", 400);
  }
  return storyId;
}

function safeBaselinePrograms(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 63) {
    fail("baselinePrograms", "array_size_invalid", 400);
  }
  return [...value];
}

function compileCandidate(context, choice, proposalSource) {
  const normalizedChoice = normalizeVisualProgramV2PlannerChoice(
    choice,
    context,
    { allowContentHash: true },
  );
  const proposal = materializeVisualProgramProposalV2(context, normalizedChoice);
  const compilerProposal = structuredClone(proposal);
  delete compilerProposal.contentHash;
  const visualProgram = compileGeneralizedVisualProgramV2({
    semanticEventGraph: context.graph,
    timingContext: context.timingContext,
    proposal: compilerProposal,
    proposalSource,
    trustMode: "calibration_trusted",
  });
  return {
    choice: normalizedChoice,
    proposal,
    visualProgram,
    choiceHash: normalizedChoice.contentHash,
  };
}

function evaluateCandidate(candidate, storyId, baselinePrograms) {
  const semanticGate = evaluateVisualProgramV2SemanticTrace(
    candidate.visualProgram,
  );
  const repetitionGate = evaluateVisualProgramV2Repetition([
    ...baselinePrograms,
    { storyId, program: candidate.visualProgram },
  ], { failClosed: true });
  return { semanticGate, repetitionGate };
}

function completedResult(candidate, gates, provenance) {
  if (!candidate.choice || !Object.isFrozen(candidate.choice)
    || candidate.choice.contentHash !== provenance.choiceHash) {
    fail("planner.result.choice", "choice_hash_mismatch", 500);
  }
  return deepFreeze({
    choice: candidate.choice,
    proposal: candidate.proposal,
    visualProgram: candidate.visualProgram,
    provenance: Object.freeze(provenance),
    semanticGate: gates.semanticGate,
    repetitionGate: gates.repetitionGate,
  });
}

function fallbackFailure(code, retryable = false) {
  return Object.freeze({
    code,
    phase: "local_visual_program_planner",
    retryable,
  });
}

async function planGeneralizedVisualProgramV2(input = {}, dependencies = {}) {
  const signal = input.signal || dependencies.signal || null;
  if (signal?.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const context = buildVisualProgramV2PlannerContext({
    semanticEventGraph: input.semanticEventGraph,
    timingContext: input.timingContext,
  });
  const storyId = safeStoryId(input.storyId, context.graph.draftHash);
  const baselinePrograms = safeBaselinePrograms(input.baselinePrograms);
  const deterministicChoice = buildDeterministicVisualProgramV2PlannerChoice(
    context,
  );
  // Synchronous deterministic compilation proves the complete trusted context
  // before any provider or fallback path is allowed to run.
  compileCandidate(context, deterministicChoice, "operator");

  const planner = dependencies.planner
    || input.planner
    || createLocalLlmVisualProgramV2Planner(
      dependencies.localLlmVisualProgramV2Options || {},
    );
  const plannerInfo = plannerMetadata(planner);
  const guard = aggregateGuard(signal, plannerInfo.aggregateTimeoutMs);
  const rejectionCodes = [];
  let lastResult = null;
  let attemptCount = 0;

  try {
    for (let attemptIndex = 1;
      attemptIndex <= VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS;
      attemptIndex += 1) {
      attemptCount = attemptIndex;
      if (guard.callerCancelled) {
        throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      }
      if (guard.deadlineExpired) break;
      let rawResult;
      try {
        rawResult = await guard.race(planner.propose({
          context,
          attemptIndex,
          rejectionCodes: [...rejectionCodes],
          signal: guard.signal,
        }));
      } catch (cause) {
        if (guard.callerCancelled || cause?.code === "JOB_CANCELLED") {
          throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
        }
        if (guard.deadlineExpired) break;
        throw cause;
      }
      const result = validatePlannerResult(rawResult, plannerInfo);
      lastResult = result;
      if (result.fallbackUsed) {
        if (result.failure.retryable
          || result.failure.code === "ANIMATION_LOCAL_LLM_DISABLED") break;
        const rejectionCode = REJECTION_CODE_BY_PROVIDER_FAILURE[
          result.failure.code
        ] || "candidate_contract_invalid";
        if (!rejectionCodes.includes(rejectionCode)) {
          rejectionCodes.push(rejectionCode);
        }
        continue;
      }

      let candidate;
      try {
        candidate = compileCandidate(
          context,
          result.choice,
          result.providerId === "local_openai_compatible"
            ? "local_llm"
            : "operator",
        );
      } catch (cause) {
        if (cause?.code === "JOB_CANCELLED") throw cause;
        if (!rejectionCodes.includes("candidate_compile_invalid")) {
          rejectionCodes.push("candidate_compile_invalid");
        }
        continue;
      }
      const gates = evaluateCandidate(candidate, storyId, baselinePrograms);
      if (!gates.semanticGate.passed) {
        if (!rejectionCodes.includes("semantic_trace_failed")) {
          rejectionCodes.push("semantic_trace_failed");
        }
        continue;
      }
      if (!gates.repetitionGate.passed) {
        if (!rejectionCodes.includes("repetition_gate_failed")) {
          rejectionCodes.push("repetition_gate_failed");
        }
        continue;
      }
      return completedResult(candidate, gates, {
        plannerId: plannerInfo.plannerId,
        mode: plannerInfo.mode,
        providerId: result.providerId,
        modelId: result.modelId,
        promptProfileId: plannerInfo.promptProfileId,
        plannerConfigurationHash: plannerInfo.configurationHash,
        providerSelectionHash: result.providerSelectionHash,
        choiceHash: candidate.choiceHash,
        promptProjectionHash: context.projectionHash,
        attemptCount,
        fallbackUsed: false,
        failure: null,
      });
    }
  } finally {
    guard.dispose();
  }

  if (guard.callerCancelled) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const fallback = compileCandidate(context, deterministicChoice, "operator");
  const gates = evaluateCandidate(fallback, storyId, baselinePrograms);
  let failure = lastResult?.failure || null;
  if (guard.deadlineExpired) {
    failure = fallbackFailure(
      "ANIMATION_LOCAL_LLM_VISUAL_PROGRAM_AGGREGATE_TIMEOUT",
      true,
    );
  } else if (!failure || lastResult?.fallbackUsed !== true) {
    failure = fallbackFailure(
      "ANIMATION_LOCAL_LLM_VISUAL_PROGRAM_REPLAN_EXHAUSTED",
      false,
    );
  }
  return completedResult(fallback, gates, {
    plannerId: plannerInfo.plannerId,
    mode: plannerInfo.mode,
    providerId: "deterministic_fallback",
    modelId: lastResult?.modelId || "deterministic-visual-program-v2",
    promptProfileId: plannerInfo.promptProfileId,
    plannerConfigurationHash: plannerInfo.configurationHash,
    providerSelectionHash: lastResult?.providerSelectionHash || null,
    choiceHash: fallback.choiceHash,
    promptProjectionHash: context.projectionHash,
    attemptCount,
    fallbackUsed: true,
    failure,
  });
}

module.exports = {
  MAX_AGGREGATE_TIMEOUT_MS,
  planGeneralizedVisualProgramV2,
};
