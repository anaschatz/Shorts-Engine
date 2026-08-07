"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  stableStringify,
} = require("../server/pipelines/narrated-short/animation/canonical-json.cjs");
const {
  calibrationSemanticGraphContentHashV2,
  compileGeneralizedVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-compiler.cjs");
const {
  VISUAL_PROGRAM_V2_LAYOUT_INTENTS,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-contract.cjs");
const {
  buildDeterministicVisualProgramV2PlannerChoice,
  buildVisualProgramV2PlannerContext,
  buildVisualProgramV2PlannerPrompt,
  materializeVisualProgramV2PlannerChoiceFromProviderSelection,
  materializeVisualProgramV2ProviderSelectionFromPlannerChoice,
  materializeVisualProgramProposalV2,
  normalizeVisualProgramV2ProviderSelection,
  normalizeVisualProgramV2PlannerChoice,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-planner-contract.cjs");
const {
  buildProviderResponseFormat,
  createLocalLlmVisualProgramV2Planner,
} = require("../server/pipelines/narrated-short/animation/providers/local-llm-visual-program-v2-planner.cjs");
const {
  planGeneralizedVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-planner-service.cjs");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const draftHash = sha("planner-v2-draft");
  const timingContext = normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: 240,
    alignmentHash: sha("planner-v2-alignment"),
    draftHash,
    words: [
      ["A", 0, 18],
      ["signal", 20, 38],
      ["reaches", 40, 58],
      ["software", 60, 80],
      ["then", 90, 108],
      ["shows", 110, 128],
      ["the", 130, 148],
      ["date", 150, 170],
    ].map(([text, startFrame, endFrame], index) => ({
      index,
      text,
      startFrame,
      endFrame,
    })),
    beats: [{
      beatId: "beat_signal",
      wordStartIndex: 0,
      wordEndIndex: 8,
      startFrame: 0,
      endFrame: 170,
    }],
  });
  const semanticEventGraph = {
    storyTitle: "PRIVATE TITLE MUST NOT REACH THE MODEL",
    draftHash,
    sourceStoryboardHash: sha("planner-v2-storyboard"),
    timingContextHash: timingContext.contentHash,
    entities: [
      {
        id: "source_signal",
        kind: "navigation_signal",
        visualSubjectKind: "signal",
        label: "private satellite label",
        persistent: false,
        claimIds: ["claim_signal"],
      },
      {
        id: "receiver_software",
        kind: "software_interpreter",
        visualSubjectKind: "mapping",
        label: "private software label",
        persistent: true,
        claimIds: ["claim_signal", "claim_output"],
      },
      {
        id: "reported_output",
        kind: "device_output",
        visualSubjectKind: "date",
        label: "private output label",
        persistent: false,
        claimIds: ["claim_output"],
      },
    ],
    propositions: [
      {
        id: "prop_signal_route",
        beatId: "beat_signal",
        eventKind: "causal_action",
        predicate: "routes_to",
        polarity: "affirmed",
        certainty: "verified",
        subject: { entityId: "source_signal" },
        object: { entityIds: ["receiver_software"] },
        visualAction: {
          operation: "send_signal",
          focusEntityIds: ["receiver_software"],
        },
        wordSpan: { startFrame: 0, endFrame: 80, text: "private narration" },
      },
      {
        id: "prop_output",
        beatId: "beat_signal",
        eventKind: "state_transition",
        predicate: "maps_to_output",
        polarity: "affirmed",
        certainty: "verified",
        subject: { entityId: "receiver_software" },
        object: { entityIds: ["reported_output"] },
        visualAction: {
          operation: "show_output",
          focusEntityIds: ["reported_output"],
        },
        wordSpan: { startFrame: 90, endFrame: 170, text: "more private narration" },
      },
    ],
  };
  return { semanticEventGraph, timingContext };
}

function rawChoice() {
  return {
    schemaVersion: 1,
    scenes: [{
      startPropositionIndex: 0,
      endPropositionIndexExclusive: 2,
      layoutIntent: "directed_flow",
      focusEntityIndex: 2,
    }],
  };
}

function fixtureWithPropositionCount(count) {
  const values = fixture();
  const source = values.semanticEventGraph.propositions[0];
  values.semanticEventGraph.propositions = Array.from(
    { length: count },
    (_unused, index) => ({
      ...structuredClone(source),
      id: `prop_repeated_${String(index).padStart(2, "0")}`,
    }),
  );
  return values;
}

function completeCandidatePaths(context, maximum = 512) {
  const paths = [];
  function visit(start, path) {
    if (paths.length >= maximum) return;
    if (start === context.propositions.length) {
      paths.push(path);
      return;
    }
    for (const candidate of context.sceneRangeCandidates) {
      if (candidate.startPropositionIndex !== start) continue;
      visit(candidate.endPropositionIndexExclusive, [
        ...path,
        candidate.candidateIndex,
      ]);
    }
  }
  visit(0, []);
  return paths;
}

function responseSchemaAllowsPath(responseFormat, candidateIndexes) {
  return responseFormat.json_schema.schema.properties.scenes.oneOf.some(
    (candidateSchema) => (
      candidateSchema.prefixItems.length === candidateIndexes.length
      && candidateSchema.prefixItems.every((sceneSchema, index) => (
        sceneSchema.properties.rangeCandidateIndex.const
          === candidateIndexes[index]
      ))
    ),
  );
}

function rawProviderSelection() {
  return {
    schemaVersion: 1,
    scenes: [{
      rangeCandidateIndex: 2,
      layoutIntent: "directed_flow",
    }],
  };
}

function providerPayload(choice = rawProviderSelection()) {
  return {
    choices: [{ message: { content: typeof choice === "string"
      ? choice
      : JSON.stringify(choice) } }],
  };
}

function jsonResponse(value, options = {}) {
  const content = JSON.stringify(value);
  const bytes = Buffer.from(content, "utf8");
  let sent = false;
  return {
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    url: options.url || "",
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") {
          return options.contentType || "application/json; charset=utf-8";
        }
        if (String(name).toLowerCase() === "content-length") {
          return String(options.contentLength ?? bytes.length);
        }
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {
            options.onCancel?.();
          },
        };
      },
      async cancel() {
        options.onCancel?.();
      },
    },
  };
}

function liveOptions(fetch, overrides = {}) {
  return {
    mode: "openai_compatible",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    modelId: "qwen3:4b-instruct",
    timeoutMs: 1000,
    aggregateTimeoutMs: 5000,
    maxResponseBytes: 4096,
    maxTokens: 512,
    fetch,
    env: {},
    ...overrides,
  };
}

test("indexed planner context excludes copy, identifiers, hashes, timing and geometry from the prompt", () => {
  const values = fixture();
  const context = buildVisualProgramV2PlannerContext(values);
  const prompt = buildVisualProgramV2PlannerPrompt(context, { attemptIndex: 1 });
  const serialized = JSON.stringify(prompt);

  assert.equal(context.graphHash, calibrationSemanticGraphContentHashV2(values.semanticEventGraph));
  assert.match(context.projectionHash, /^[a-f0-9]{64}$/);
  assert.equal(context.projectionHash, sha(stableStringify(prompt.context)));
  assert.doesNotMatch(serialized, /PRIVATE TITLE|private |source_signal|receiver_software|prop_signal/i);
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/);
  assert.doesNotMatch(serialized, /startFrame|endFrame|label|narration|storyTitle|sourceRef/);
  assert.doesNotMatch(serialized, /\b(?:x|y|width|height|svg|html|javascript|url)\b/i);
  assert.equal(prompt.context.entities[0].index, 0);
  assert.deepEqual(prompt.context.propositions[0].objectEntityIndexes, [1]);
  assert.deepEqual(prompt.context.propositions[0].participantEntityIndexes, [0, 1]);
  assert.deepEqual(prompt.context.propositions[1].focusEntityIndexes, [2]);
  assert.deepEqual(prompt.context.sceneRangeCandidates, [
    {
      candidateIndex: 0,
      startPropositionIndex: 0,
      endPropositionIndexExclusive: 1,
      focusEntityIndex: 1,
    },
    {
      candidateIndex: 1,
      startPropositionIndex: 0,
      endPropositionIndexExclusive: 2,
      focusEntityIndex: 1,
    },
    {
      candidateIndex: 2,
      startPropositionIndex: 0,
      endPropositionIndexExclusive: 2,
      focusEntityIndex: 2,
    },
    {
      candidateIndex: 3,
      startPropositionIndex: 1,
      endPropositionIndexExclusive: 2,
      focusEntityIndex: 2,
    },
  ]);
  assert.equal(
    prompt.constraints.everySceneMustSelectOneContextSceneRangeCandidate,
    true,
  );

  const expandedValues = fixtureWithPropositionCount(8);
  const expanded = buildVisualProgramV2PlannerContext(expandedValues);
  const replay = buildVisualProgramV2PlannerContext(
    fixtureWithPropositionCount(8),
  );
  assert.deepEqual(expanded.completePartitionCatalog, replay.completePartitionCatalog);
  assert.equal(expanded.completePartitionCatalog.length <= 8, true);
  assert.equal(expanded.completePartitionCatalog[0].length >= 3, true);
  assert.equal(expanded.completePartitionCatalog[0].length <= 7, true);
  for (const path of expanded.completePartitionCatalog) {
    assert.equal(path.length >= 1 && path.length <= 12, true);
    let expectedStart = 0;
    path.forEach((candidateIndex) => {
      assert.equal(Number.isSafeInteger(candidateIndex), true);
      const candidate = expanded.sceneRangeCandidates[candidateIndex];
      assert.equal(candidate.startPropositionIndex, expectedStart);
      expectedStart = candidate.endPropositionIndexExclusive;
    });
    assert.equal(expectedStart, expanded.propositions.length);
  }
  const nonCatalogPath = completeCandidatePaths(expanded).find((path) => (
    !expanded.completePartitionCatalog.some((catalogPath) => (
      catalogPath.length === path.length
      && catalogPath.every((candidateIndex, index) => candidateIndex === path[index])
    ))
  ));
  assert.ok(nonCatalogPath);
  const expandedPrompt = buildVisualProgramV2PlannerPrompt(expanded, {
    attemptIndex: 1,
  });
  const expandedResponseFormat = buildProviderResponseFormat(
    expanded,
    expandedPrompt,
  );
  assert.equal(responseSchemaAllowsPath(expandedResponseFormat, nonCatalogPath), false);
  assert.throws(() => normalizeVisualProgramV2ProviderSelection({
    schemaVersion: 1,
    scenes: nonCatalogPath.map((rangeCandidateIndex) => ({
      rangeCandidateIndex,
      layoutIntent: "directed_flow",
    })),
  }, expanded), { code: "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID" });
});

test("choice is an exact contiguous indexed partition and materialization is engine-owned", () => {
  const context = buildVisualProgramV2PlannerContext(fixture());
  const choice = normalizeVisualProgramV2PlannerChoice(rawChoice(), context);
  const proposal = materializeVisualProgramProposalV2(context, choice);
  const providerSelection =
    materializeVisualProgramV2ProviderSelectionFromPlannerChoice(context, choice);
  const replayedChoice =
    materializeVisualProgramV2PlannerChoiceFromProviderSelection(
      context,
      providerSelection,
    );

  assert.match(choice.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(proposal.scenes, [{
    id: "visual_scene_00",
    entityIds: ["source_signal", "receiver_software", "reported_output"],
    propositionIds: ["prop_signal_route", "prop_output"],
    layoutIntent: "directed_flow",
    focusEntityId: "reported_output",
  }]);
  assert.equal(proposal.bindings.semanticEventGraphHash, context.graphHash);
  assert.equal(proposal.styleSpecId, "educational_line_art_reference_v1");
  assert.deepEqual(providerSelection, {
    ...rawProviderSelection(),
    contentHash: providerSelection.contentHash,
  });
  assert.deepEqual(replayedChoice, choice);

  for (const mutate of [
    (value) => { value.scenes[0].text = "invented"; },
    (value) => { value.scenes[0].x = 20; },
    (value) => { value.scenes[0].startPropositionIndex = 1; },
    (value) => { value.scenes[0].endPropositionIndexExclusive = 1; },
    (value) => { value.scenes[0].focusEntityIndex = 0; },
  ]) {
    const candidate = rawChoice();
    mutate(candidate);
    assert.throws(
      () => normalizeVisualProgramV2PlannerChoice(candidate, context),
      { code: "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID" },
    );
  }
});

test("disabled and mock modes are deterministic and make no network calls", async () => {
  const context = buildVisualProgramV2PlannerContext(fixture());
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    throw new Error("network not allowed");
  };
  const disabled = createLocalLlmVisualProgramV2Planner({ env: {}, fetch });
  const disabledResult = await disabled.propose({ context, attemptIndex: 1 });
  assert.equal(disabledResult.fallbackUsed, true);
  assert.equal(disabledResult.failure.code, "ANIMATION_LOCAL_LLM_DISABLED");
  assert.equal(disabled.health().loopbackOnly, true);
  assert.equal(disabled.health().apiKeyRequired, false);

  const mock = createLocalLlmVisualProgramV2Planner({
    mode: "mock",
    env: {},
    fetch,
  });
  const first = await mock.propose({ context, attemptIndex: 1 });
  const second = await mock.propose({ context, attemptIndex: 1 });
  assert.equal(fetchCalls, 0);
  assert.equal(first.providerId, "deterministic_mock");
  assert.equal(first.fallbackUsed, false);
  assert.deepEqual(first.choice, second.choice);
});

test("live mode sends one bounded credential-free loopback request", async () => {
  const requests = [];
  const secret = "credential-must-not-leak";
  const planner = createLocalLlmVisualProgramV2Planner(liveOptions(
    async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(providerPayload());
    },
    { env: { OPENAI_API_KEY: secret } },
  ));
  const context = buildVisualProgramV2PlannerContext(fixture());
  const result = await planner.propose({ context, attemptIndex: 1 });

  assert.equal(result.providerId, "local_openai_compatible");
  assert.equal(result.fallbackUsed, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(requests[0].options.redirect, "error");
  assert.deepEqual(requests[0].options.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.doesNotMatch(requests[0].options.body, /authorization|api[_-]?key|cookie/i);
  assert.doesNotMatch(requests[0].options.body, new RegExp(secret));
  assert.doesNotMatch(requests[0].options.body, /PRIVATE TITLE|private |source_signal|prop_signal/i);
  const request = JSON.parse(requests[0].options.body);
  assert.equal(request.temperature, 0);
  assert.equal(request.stream, false);
  assert.equal(request.response_format.type, "json_schema");
  assert.equal(
    request.response_format.json_schema.name,
    "visual_program_v2_provider_selection",
  );
  assert.equal(request.response_format.json_schema.strict, true);
  const responseSchema = request.response_format.json_schema.schema;
  assert.deepEqual(responseSchema.required, ["schemaVersion", "scenes"]);
  assert.equal(responseSchema.additionalProperties, false);
  assert.deepEqual(responseSchema.properties.schemaVersion, {
    type: "integer",
    const: 1,
  });
  const partitionSchemas = responseSchema.properties.scenes.oneOf;
  assert.equal(partitionSchemas.length, context.completePartitionCatalog.length);
  context.completePartitionCatalog.forEach((path, pathIndex) => {
    const pathSchema = partitionSchemas[pathIndex];
    assert.equal(pathSchema.type, "array");
    assert.equal(pathSchema.minItems, path.length);
    assert.equal(pathSchema.maxItems, path.length);
    assert.equal(Object.hasOwn(pathSchema, "items"), false);
    assert.deepEqual(
      pathSchema.prefixItems.map(
        (item) => item.properties.rangeCandidateIndex,
      ),
      path.map((candidateIndex) => ({ type: "integer", const: candidateIndex })),
    );
    pathSchema.prefixItems.forEach((item) => {
      assert.deepEqual(item.required, ["rangeCandidateIndex", "layoutIntent"]);
      assert.equal(item.additionalProperties, false);
      assert.deepEqual(
        item.properties.layoutIntent.enum,
        [...VISUAL_PROGRAM_V2_LAYOUT_INTENTS],
      );
    });
    assert.equal(responseSchemaAllowsPath(request.response_format, path), true);
  });
  assert.equal(responseSchemaAllowsPath(request.response_format, [0]), false);
  assert.equal(Number.isSafeInteger(request.seed), true);
});

test("invalid provider output is retried without feeding raw output back to the model", async () => {
  const requests = [];
  const rawSecret = "sensitive-provider-output";
  const values = fixture();
  const expectedContext = buildVisualProgramV2PlannerContext(values);
  const planner = createLocalLlmVisualProgramV2Planner(liveOptions(
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? jsonResponse(providerPayload({
          ...rawProviderSelection(),
          javascript: rawSecret,
        }))
        : jsonResponse(providerPayload());
    },
  ));
  const result = await planGeneralizedVisualProgramV2({
    storyId: "fixture_story",
    ...values,
    planner,
  });

  assert.equal(requests.length, 2);
  assert.equal(result.provenance.providerId, "local_openai_compatible");
  assert.equal(result.provenance.attemptCount, 2);
  assert.equal(result.provenance.fallbackUsed, false);
  assert.equal(Object.isFrozen(result.choice), true);
  assert.equal(Object.isFrozen(result.choice.scenes), true);
  assert.equal(Object.isFrozen(result.choice.scenes[0]), true);
  assert.match(result.provenance.choiceHash, /^[a-f0-9]{64}$/);
  assert.match(result.provenance.providerSelectionHash, /^[a-f0-9]{64}$/);
  assert.match(result.provenance.promptProjectionHash, /^[a-f0-9]{64}$/);
  assert.equal(
    result.provenance.choiceHash,
    normalizeVisualProgramV2PlannerChoice(rawChoice(), expectedContext).contentHash,
  );
  assert.equal(result.choice.contentHash, result.provenance.choiceHash);
  assert.deepEqual(result.choice, normalizeVisualProgramV2PlannerChoice(
    rawChoice(),
    expectedContext,
  ));
  const persistedChoice = JSON.parse(JSON.stringify(result.choice));
  const replayedChoice = normalizeVisualProgramV2PlannerChoice(
    persistedChoice,
    expectedContext,
    { allowContentHash: true },
  );
  assert.equal(replayedChoice.contentHash, result.provenance.choiceHash);
  assert.deepEqual(
    materializeVisualProgramProposalV2(expectedContext, replayedChoice),
    result.proposal,
  );
  assert.equal(
    materializeVisualProgramV2ProviderSelectionFromPlannerChoice(
      expectedContext,
      replayedChoice,
    ).contentHash,
    result.provenance.providerSelectionHash,
  );
  assert.equal(result.provenance.promptProjectionHash, expectedContext.projectionHash);
  assert.notEqual(result.provenance.choiceHash, result.proposal.contentHash);
  assert.equal(
    result.provenance.providerSelectionHash,
    normalizeVisualProgramV2ProviderSelection(
      rawProviderSelection(),
      expectedContext,
    ).contentHash,
  );
  assert.equal(result.visualProgram.trust.disclosure, "local_llm_generated_nonproduction");
  assert.match(requests[1].messages[1].content, /candidate_contract_invalid/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawSecret));
  assert.doesNotMatch(JSON.stringify(requests[1]), new RegExp(rawSecret));
  assert.equal(result.semanticGate.passed, true);
  assert.equal(result.repetitionGate.passed, true);
});

test("choice validation retries disclose only an allowlisted correction code", async () => {
  const requests = [];
  const incompletePartition = {
    schemaVersion: 1,
    scenes: [{ rangeCandidateIndex: 0, layoutIntent: "directed_flow" }],
  };
  const planner = createLocalLlmVisualProgramV2Planner(liveOptions(
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse(providerPayload(
        requests.length === 1 ? incompletePartition : rawProviderSelection(),
      ));
    },
  ));
  const result = await planGeneralizedVisualProgramV2({
    storyId: "fixture_story",
    ...fixture(),
    planner,
  });

  assert.equal(requests.length, 2);
  const retryPrompt = JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(retryPrompt.rejectionCodes, ["partition_invalid"]);
  assert.deepEqual(retryPrompt.rejectionGuidance, [{
    code: "partition_invalid",
    action: "return_one_contiguous_ordered_partition_covering_every_proposition_exactly_once",
  }]);
  assert.equal(
    retryPrompt.retryInstruction,
    "correct_every_listed_rejection_code_without_relaxing_any_constraint",
  );
  assert.doesNotMatch(JSON.stringify(requests[1]), /choice\.scenes|focusEntityIndex.*invalid/i);
  assert.equal(result.provenance.providerId, "local_openai_compatible");
  assert.equal(result.provenance.attemptCount, 2);
  assert.equal(result.provenance.failure, null);
});

test("transport failure opens the circuit and returns a marked operator fallback", async () => {
  let calls = 0;
  const planner = createLocalLlmVisualProgramV2Planner(liveOptions(async () => {
    calls += 1;
    throw new Error("raw transport detail");
  }));
  const result = await planGeneralizedVisualProgramV2({
    storyId: "fixture_story",
    ...fixture(),
    planner,
  });

  assert.equal(calls, 1);
  assert.equal(result.provenance.providerId, "deterministic_fallback");
  assert.equal(result.provenance.fallbackUsed, true);
  assert.equal(result.provenance.failure.code, "ANIMATION_LOCAL_LLM_FETCH_FAILED");
  assert.equal(result.provenance.attemptCount, 1);
  assert.match(result.provenance.choiceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.choice.contentHash, result.provenance.choiceHash);
  assert.equal(Object.isFrozen(result.choice), true);
  assert.match(result.provenance.promptProjectionHash, /^[a-f0-9]{64}$/);
  assert.equal(result.visualProgram.trust.disclosure, "operator_created_nonproduction");
  assert.doesNotMatch(JSON.stringify(result), /raw transport detail/);
});

test("trusted context errors and cancellation fail closed before fallback", async () => {
  let fetchCalls = 0;
  const planner = createLocalLlmVisualProgramV2Planner(liveOptions(async () => {
    fetchCalls += 1;
    return jsonResponse(providerPayload());
  }));
  const invalid = fixture();
  invalid.semanticEventGraph.propositions[0].subject.entityId = "missing_entity";
  await assert.rejects(
    () => planGeneralizedVisualProgramV2({ ...invalid, planner }),
    { code: "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID" },
  );
  assert.equal(fetchCalls, 0);

  const oversized = fixture();
  const proposition = oversized.semanticEventGraph.propositions[0];
  oversized.semanticEventGraph.propositions = Array.from(
    { length: 49 },
    (_unused, index) => ({
      ...structuredClone(proposition),
      id: `prop_oversized_${String(index).padStart(2, "0")}`,
    }),
  );
  await assert.rejects(
    () => planGeneralizedVisualProgramV2({ ...oversized, planner }),
    { code: "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID" },
  );
  assert.equal(fetchCalls, 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => planGeneralizedVisualProgramV2({
      ...fixture(),
      planner,
      signal: controller.signal,
    }),
    { code: "JOB_CANCELLED" },
  );
  assert.equal(fetchCalls, 0);
});

test("operator remains the byte-compatible default while local LLM provenance is explicit", () => {
  const context = buildVisualProgramV2PlannerContext(fixture());
  const choice = buildDeterministicVisualProgramV2PlannerChoice(context);
  const proposal = materializeVisualProgramProposalV2(context, choice);
  const compilerProposal = structuredClone(proposal);
  delete compilerProposal.contentHash;
  const base = {
    semanticEventGraph: context.graph,
    timingContext: context.timingContext,
    proposal: compilerProposal,
    trustMode: "calibration_trusted",
  };
  const implicit = compileGeneralizedVisualProgramV2(base);
  const explicit = compileGeneralizedVisualProgramV2({
    ...base,
    proposalSource: "operator",
  });
  const local = compileGeneralizedVisualProgramV2({
    ...base,
    proposalSource: "local_llm",
  });

  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.contentHash, explicit.contentHash);
  assert.equal(implicit.trust.disclosure, "operator_created_nonproduction");
  assert.equal(local.trust.disclosure, "local_llm_generated_nonproduction");
  assert.notEqual(local.contentHash, implicit.contentHash);
  assert.throws(
    () => compileGeneralizedVisualProgramV2({ ...base, proposalSource: "remote" }),
    { code: "GENERALIZED_VISUAL_PROGRAM_V2_INVALID" },
  );
});
