"use strict";

const { createHash } = require("node:crypto");

const { AppError, SAFE_MESSAGES } = require("../../../../errors.cjs");
const { stableStringify } = require("../canonical-json.cjs");
const {
  LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
  VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS,
  VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS,
  buildDeterministicVisualProgramV2PlannerChoice,
  buildVisualProgramV2PlannerPrompt,
  materializeVisualProgramV2PlannerChoiceFromProviderSelection,
  materializeVisualProgramV2ProviderSelectionFromPlannerChoice,
  normalizeVisualProgramV2ProviderSelection,
  normalizeVisualProgramV2PlannerChoice,
} = require("../visual-program-v2-planner-contract.cjs");
const {
  MAX_REQUEST_BYTES,
  normalizeLocalLlmScenePlannerConfig,
  readBoundedResponseText,
} = require("./local-llm-scene-planner.cjs");

const LOCAL_LLM_VISUAL_PROGRAM_V2_MODES = Object.freeze([
  "disabled",
  "mock",
  "openai_compatible",
]);
const SYSTEM_PROMPT = [
  "You are a bounded semantic visual-scene composer.",
  "Return exactly one JSON object matching the supplied output schema.",
  "The top-level object must contain exactly schemaVersion and scenes.",
  "Do not wrap it in output, result, answer, data, response, or any other key.",
  "Each scene must contain exactly rangeCandidateIndex and layoutIntent.",
  "Copy each rangeCandidateIndex from context.sceneRangeCandidates and each",
  "layoutIntent from allowedLayoutIntents. Do not return start, end, or focus.",
  "The complete rangeCandidateIndex sequence must exactly copy one indexed array",
  "from context.completePartitionCatalog; choose layouts for those entries.",
  "Choose candidate indexes whose embedded start and end values form one exact",
  "ordered contiguous partition: first start is zero, each next start equals the",
  "previous end, and the final end equals context.propositionCount.",
  "Return at least constraints.minimumScenes and no more than",
  "constraints.maximumScenes scene entries.",
  "On a retry, correct every supplied rejectionCodes item without relaxing any",
  "other rule.",
  "Never return markdown, prose, identifiers, labels, narration, hashes, code,",
  "SVG, HTML, CSS, URLs, assets, coordinates, colors, paths, frames, timing,",
  "bindings, style fields, or extra fields.",
].join(" ");
const RECOVERABLE_CODES = new Set([
  "ANIMATION_LOCAL_LLM_FETCH_FAILED",
  "ANIMATION_LOCAL_LLM_HTTP_FAILED",
  "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
  "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE",
  "ANIMATION_LOCAL_LLM_TIMEOUT",
  "ANIMATION_LOCAL_LLM_UNAVAILABLE",
  "ANIMATION_LOCAL_LLM_CHOICE_FOCUS_GROUNDING_INVALID",
  "ANIMATION_LOCAL_LLM_CHOICE_FOCUS_DOMINANCE_INVALID",
  "ANIMATION_LOCAL_LLM_CHOICE_SCENE_DENSITY_INVALID",
  "ANIMATION_LOCAL_LLM_CHOICE_PARTICIPANT_BUDGET_INVALID",
  "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
]);
const CHOICE_VALIDATION_CODE_BY_REASON = Object.freeze({
  focus_not_grounded: "ANIMATION_LOCAL_LLM_CHOICE_FOCUS_GROUNDING_INVALID",
  focus_not_dominant: "ANIMATION_LOCAL_LLM_CHOICE_FOCUS_DOMINANCE_INVALID",
  scene_semantic_density_exceeded:
    "ANIMATION_LOCAL_LLM_CHOICE_SCENE_DENSITY_INVALID",
  participant_budget_exceeded:
    "ANIMATION_LOCAL_LLM_CHOICE_PARTICIPANT_BUDGET_INVALID",
  contiguous_partition_required: "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
  complete_partition_required: "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
  scene_budget_invalid: "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
  provider_selection_partition_invalid:
    "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
  provider_selection_path_not_catalogued:
    "ANIMATION_LOCAL_LLM_CHOICE_PARTITION_INVALID",
});

function error(code, message, status = 409, details = null) {
  return new AppError(code, message, status, details);
}

function normalizeLocalLlmVisualProgramV2Config(options = {}) {
  const env = options.env || process.env;
  const mode = String(
    options.mode
      ?? env.SHORTSENGINE_LOCAL_LLM_VISUAL_PROGRAM_V2_MODE
      ?? "disabled",
  ).trim().toLowerCase();
  if (!LOCAL_LLM_VISUAL_PROGRAM_V2_MODES.includes(mode)) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local visual-program planner configuration is invalid.",
      500,
      { field: "mode" },
    );
  }
  const base = normalizeLocalLlmScenePlannerConfig({
    env: {},
    mode,
    endpoint: options.endpoint ?? env.SHORTSENGINE_LOCAL_LLM_ENDPOINT,
    modelId: options.modelId ?? env.SHORTSENGINE_LOCAL_LLM_MODEL,
    timeoutMs: options.timeoutMs ?? env.SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS,
    aggregateTimeoutMs: options.aggregateTimeoutMs
      ?? env.SHORTSENGINE_LOCAL_LLM_AGGREGATE_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes
      ?? env.SHORTSENGINE_LOCAL_LLM_RESPONSE_MAX_BYTES,
    maxTokens: options.maxTokens ?? env.SHORTSENGINE_LOCAL_LLM_MAX_TOKENS,
  });
  return Object.freeze({
    ...base,
    maximumAttempts: VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS,
  });
}

function localLlmVisualProgramV2ConfigurationHash(config) {
  return createHash("sha256").update(stableStringify({
    mode: config.mode,
    endpoint: config.endpoint,
    modelId: config.modelId,
    timeoutMs: config.timeoutMs,
    aggregateTimeoutMs: config.aggregateTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxTokens: config.maxTokens,
    maximumAttempts: config.maximumAttempts,
    promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
    systemPromptHash: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
    responseContractRevision:
      "exact_top_level_schemaVersion_scenes_v8_ollama_projected_catalog_8",
    maximumCompletePartitionPaths:
      VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS,
    choiceSchemaVersion: 1,
    proposalSchemaVersion: 2,
    styleSpecId: "educational_line_art_reference_v1",
    layoutProfileId: "deterministic_semantic_graph_layout_v2",
  })).digest("hex");
}

function isAbortError(value) {
  return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

function buildProviderResponseFormat(context, prompt) {
  const sceneSchema = (rangeCandidateIndex) => Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["rangeCandidateIndex", "layoutIntent"]),
    properties: Object.freeze({
      rangeCandidateIndex: Object.freeze({
        type: "integer",
        const: rangeCandidateIndex,
      }),
      layoutIntent: Object.freeze({
        type: "string",
        enum: Object.freeze([...prompt.allowedLayoutIntents]),
      }),
    }),
  });
  const partitionSchemas = context.completePartitionCatalog.map((path) => (
    Object.freeze({
      type: "array",
      minItems: path.length,
      maxItems: path.length,
      prefixItems: Object.freeze(path.map(sceneSchema)),
    })
  ));
  return Object.freeze({
    type: "json_schema",
    json_schema: Object.freeze({
      name: "visual_program_v2_provider_selection",
      strict: true,
      schema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze(["schemaVersion", "scenes"]),
        properties: Object.freeze({
          schemaVersion: Object.freeze({
            type: "integer",
            const: prompt.responseContract.schemaVersionValue,
          }),
          scenes: Object.freeze({
            oneOf: Object.freeze(partitionSchemas),
          }),
        }),
      }),
    }),
  });
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") {
      await response.body.cancel();
      return;
    }
    if (typeof response?.body?.getReader === "function") {
      await response.body.getReader().cancel();
    }
  } catch {
    // Best-effort release of an untrusted local response stream.
  }
}

function parseProviderChoice(payloadText, context) {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local visual-program planner returned invalid JSON.",
      502,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.choices) || payload.choices.length !== 1
    || !payload.choices[0] || typeof payload.choices[0] !== "object"
    || !payload.choices[0].message
    || typeof payload.choices[0].message !== "object"
    || typeof payload.choices[0].message.content !== "string"
    || !payload.choices[0].message.content.trim()) {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local visual-program planner returned an invalid response.",
      502,
    );
  }
  let selection;
  try {
    selection = JSON.parse(payload.choices[0].message.content);
  } catch {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local visual-program planner returned an invalid choice.",
      502,
    );
  }
  try {
    const normalizedSelection = normalizeVisualProgramV2ProviderSelection(
      selection,
      context,
    );
    return Object.freeze({
      choice: materializeVisualProgramV2PlannerChoiceFromProviderSelection(
        context,
        normalizedSelection,
      ),
      providerSelectionHash: normalizedSelection.contentHash,
    });
  } catch (cause) {
    throw error(
      CHOICE_VALIDATION_CODE_BY_REASON[cause?.details?.reason]
        || "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local visual-program planner returned an invalid choice.",
      502,
    );
  }
}

async function requestLocalChoice(config, context, prompt, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw error(
      "ANIMATION_LOCAL_LLM_UNAVAILABLE",
      "The local visual-program planner is unavailable.",
      503,
    );
  }
  const externalSignal = dependencies.signal || null;
  if (externalSignal?.aborted) {
    throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const seed = Number.parseInt(context.graphHash.slice(0, 8), 16) >>> 0;
  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(prompt) },
    ],
    temperature: 0,
    seed,
    max_tokens: config.maxTokens,
    response_format: buildProviderResponseFormat(context, prompt),
    stream: false,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw error(
      "ANIMATION_LOCAL_LLM_REQUEST_TOO_LARGE",
      "The local visual-program planner request is too large.",
      500,
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    if (response?.redirected === true
      || (typeof response?.url === "string" && response.url
        && response.url !== config.endpoint)) {
      await cancelResponseBody(response);
      throw error(
        "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
        "The local visual-program planner returned an invalid response.",
        502,
      );
    }
    if (!response || typeof response.status !== "number"
      || response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      throw error(
        "ANIMATION_LOCAL_LLM_HTTP_FAILED",
        "The local visual-program planner rejected the request.",
        502,
        { status: Number.isInteger(response?.status) ? response.status : 0 },
      );
    }
    const responseText = await readBoundedResponseText(
      response,
      config.maxResponseBytes,
    );
    return parseProviderChoice(responseText, context);
  } catch (cause) {
    if (externallyAborted || externalSignal?.aborted) {
      throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
    }
    if (timedOut) {
      throw error(
        "ANIMATION_LOCAL_LLM_TIMEOUT",
        "The local visual-program planner timed out.",
        504,
      );
    }
    if (cause instanceof AppError) throw cause;
    if (controller.signal.aborted && isAbortError(cause)) {
      throw error(
        "ANIMATION_LOCAL_LLM_TIMEOUT",
        "The local visual-program planner timed out.",
        504,
      );
    }
    throw error(
      "ANIMATION_LOCAL_LLM_FETCH_FAILED",
      "The local visual-program planner request failed.",
      502,
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
  }
}

function safeFailure(code) {
  return Object.freeze({
    code,
    phase: "local_visual_program_planner",
    retryable: [
      "ANIMATION_LOCAL_LLM_FETCH_FAILED",
      "ANIMATION_LOCAL_LLM_HTTP_FAILED",
      "ANIMATION_LOCAL_LLM_TIMEOUT",
      "ANIMATION_LOCAL_LLM_UNAVAILABLE",
    ].includes(code),
  });
}

function freezeResult(value) {
  Object.freeze(value.choice);
  if (value.failure) Object.freeze(value.failure);
  return Object.freeze(value);
}

function createLocalLlmVisualProgramV2Planner(options = {}) {
  const config = normalizeLocalLlmVisualProgramV2Config(options);
  const configurationHash = localLlmVisualProgramV2ConfigurationHash(config);
  const fetchImpl = options.fetch;
  return Object.freeze({
    id: "local_llm_visual_program_v2_planner",
    mode: config.mode,
    health() {
      return Object.freeze({
        status: config.mode === "disabled" ? "disabled" : "configured",
        ready: true,
        mode: config.mode,
        networkRequired: config.mode === "openai_compatible",
        loopbackOnly: true,
        apiKeyRequired: false,
        configurationHash,
        aggregateTimeoutMs: config.aggregateTimeoutMs,
        maximumAttempts: config.maximumAttempts,
        promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
      });
    },
    async propose(input = {}) {
      const context = input.context;
      const signal = input.signal || options.signal;
      if (signal?.aborted) {
        throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      }
      const prompt = buildVisualProgramV2PlannerPrompt(context, {
        attemptIndex: input.attemptIndex,
        rejectionCodes: input.rejectionCodes,
      });
      const deterministicChoice = buildDeterministicVisualProgramV2PlannerChoice(
        context,
      );
      if (config.mode === "disabled") {
        return freezeResult({
          providerId: "deterministic_fallback",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
          fallbackUsed: true,
          failure: safeFailure("ANIMATION_LOCAL_LLM_DISABLED"),
          choice: deterministicChoice,
          providerSelectionHash: null,
        });
      }
      if (config.mode === "mock") {
        let providerSelection;
        if (options.mockSelection !== undefined) {
          const rawSelection = typeof options.mockSelection === "function"
            ? options.mockSelection({ context, prompt })
            : options.mockSelection;
          providerSelection = normalizeVisualProgramV2ProviderSelection(
            rawSelection,
            context,
            { allowContentHash: true },
          );
        } else if (options.mockChoice !== undefined) {
          const rawChoice = typeof options.mockChoice === "function"
            ? options.mockChoice({ context, prompt })
            : options.mockChoice;
          const choice = normalizeVisualProgramV2PlannerChoice(
            rawChoice,
            context,
            { allowContentHash: true },
          );
          providerSelection =
            materializeVisualProgramV2ProviderSelectionFromPlannerChoice(
              context,
              choice,
            );
        } else {
          // The default mock still exercises the exact provider boundary. Use
          // the first engine-catalogued complete path, then borrow only the
          // deterministic planner's bounded layout vocabulary by ordinal.
          const catalogPath = context.completePartitionCatalog[0];
          providerSelection = normalizeVisualProgramV2ProviderSelection({
            schemaVersion: 1,
            scenes: catalogPath.map((rangeCandidateIndex, index) => ({
              rangeCandidateIndex,
              layoutIntent: deterministicChoice.scenes[
                Math.min(index, deterministicChoice.scenes.length - 1)
              ].layoutIntent,
            })),
          }, context);
        }
        const choice = materializeVisualProgramV2PlannerChoiceFromProviderSelection(
          context,
          providerSelection,
        );
        return freezeResult({
          providerId: "deterministic_mock",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
          fallbackUsed: false,
          failure: null,
          choice,
          providerSelectionHash: providerSelection.contentHash,
        });
      }
      try {
        const providerResult = await requestLocalChoice(config, context, prompt, {
          fetch: fetchImpl,
          signal,
        });
        return freezeResult({
          providerId: "local_openai_compatible",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
          fallbackUsed: false,
          failure: null,
          choice: providerResult.choice,
          providerSelectionHash: providerResult.providerSelectionHash,
        });
      } catch (cause) {
        if (cause?.code === "JOB_CANCELLED") throw cause;
        if (!RECOVERABLE_CODES.has(cause?.code)) throw cause;
        return freezeResult({
          providerId: "deterministic_fallback",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
          fallbackUsed: true,
          failure: safeFailure(cause.code),
          choice: deterministicChoice,
          providerSelectionHash: null,
        });
      }
    },
  });
}

module.exports = {
  LOCAL_LLM_VISUAL_PROGRAM_V2_MODES,
  LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
  createLocalLlmVisualProgramV2Planner,
  buildProviderResponseFormat,
  localLlmVisualProgramV2ConfigurationHash,
  normalizeLocalLlmVisualProgramV2Config,
  parseProviderChoice,
};
