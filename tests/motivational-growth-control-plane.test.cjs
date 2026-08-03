const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  FORMAT_PROFILE,
  RENDER_PROFILE,
  SECONDARY_METRICS,
  SELECTION_PROFILE,
  evaluateEqualAgeCohorts,
  normalizeAnalyticsSnapshot,
  normalizeCandidateDecision,
  normalizeCreativeQa,
  normalizeExperimentDecision,
  normalizeExperimentManifest,
  normalizePublishManifest,
  normalizePublishReceipt,
  normalizeRenderManifest,
  normalizeSourceAssetManifest,
} = require("../server/pipelines/motivational-source-short/growth-contracts.cjs");
const {
  GrowthStore,
  STORE_FILE_NAME,
} = require("../server/pipelines/motivational-source-short/growth-store.cjs");

const digest = (character) => character.repeat(64);

function sourceInput(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "SourceAssetManifest",
    sourceId: "src_source001",
    canonicalUrl: "https://www.youtube.com/watch?v=source001",
    sourceHash: digest("1"),
    speaker: "Example Speaker",
    owner: "Example Rights Owner",
    rightsStatus: "licensed",
    licenseEvidence: "license://budget-friendly/source-001",
    allowedPlatforms: ["youtube", "instagram"],
    allowedTransformations: ["clip", "crop", "caption", "grade", "audio-mix"],
    attributionText: "Source: Example Speaker",
    reviewedBy: "rights_operator",
    reviewedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function candidateInput(source, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "CandidateDecision",
    decisionId: "cdec_decision001",
    sourceManifestHash: source.contentHash,
    sourceHash: source.sourceHash,
    candidateHash: digest("2"),
    selectionProfile: SELECTION_PROFILE,
    decision: "approved",
    reviewer: "editor_operator",
    decidedAt: "2026-07-02T00:00:00.000Z",
    notes: "Standalone tension arc with a resolved payoff.",
    ...overrides,
  };
}

function experimentInput(candidate, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "ExperimentManifest",
    manifestId: "expm_manifest001",
    experimentId: "exp_growth001",
    cohortId: "contradiction_hook",
    treatmentId: "treatment_a",
    candidateDecisionHash: candidate.contentHash,
    candidateHash: candidate.candidateHash,
    hypothesis: "A contradiction hook improves stayed-to-watch at equal video age.",
    primaryVariable: "hook_family",
    pillar: "discipline_work",
    durationBucket: "13_16s",
    formatProfile: FORMAT_PROFILE,
    selectionProfile: SELECTION_PROFILE,
    renderProfile: RENDER_PROFILE,
    language: "en",
    artificialCutLimit: 0,
    uploadCadence: "one_per_day_five_per_week",
    declaredAt: "2026-07-02T01:00:00.000Z",
    decisionDueAt: "2026-08-02T01:00:00.000Z",
    snapshotGatesHours: [1, 6, 24, 72, 168, 672],
    decisionGatesHours: [24, 72, 168, 672],
    primaryMetric: "stayed_to_watch_percentile",
    secondaryMetrics: [...SECONDARY_METRICS],
    humanDecisionRequired: true,
    ...overrides,
  };
}

function renderInput(source, candidate, experiment, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "RenderManifest",
    renderId: "render_render001",
    sourceManifestHash: source.contentHash,
    sourceHash: source.sourceHash,
    candidateDecisionHash: candidate.contentHash,
    candidateHash: candidate.candidateHash,
    experimentManifestHash: experiment.contentHash,
    editPlanHash: digest("3"),
    formatProfile: FORMAT_PROFILE,
    selectionProfile: SELECTION_PROFILE,
    renderProfile: RENDER_PROFILE,
    rendererVersion: "bf_editorial_renderer_v1",
    outputHash: digest("4"),
    durationSeconds: 14,
    delivery: { width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac" },
    cuts: { sourceCutCount: 1, artificialCutCount: 0 },
    brandTail: { profile: "bf_youtube_tail_v1", durationSeconds: 0.3 },
    renderedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function qaInput(source, candidate, render, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "CreativeQa",
    qaId: "cqa_review001",
    renderManifestHash: render.contentHash,
    sourceManifestHash: source.contentHash,
    candidateHash: candidate.candidateHash,
    hookLatencySeconds: 0.18,
    semanticClosurePassed: true,
    titleAlignmentScore: 94,
    similarityScore: 0.19,
    similarityThreshold: 0.3,
    originalityPassed: true,
    rightsPassed: true,
    policyPassed: true,
    technicalPassed: true,
    artificialCutCount: 0,
    passed: true,
    failedGates: [],
    reviewer: "qa_operator",
    checkedAt: "2026-07-03T01:00:00.000Z",
    ...overrides,
  };
}

function publishInput(source, candidate, experiment, render, qa, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "PublishManifest",
    publishId: "pubm_publish001",
    sourceManifestHash: source.contentHash,
    sourceHash: source.sourceHash,
    candidateDecisionHash: candidate.contentHash,
    candidateHash: candidate.candidateHash,
    experimentManifestHash: experiment.contentHash,
    renderManifestHash: render.contentHash,
    creativeQaHash: qa.contentHash,
    outputHash: render.outputHash,
    expectedChannelId: "UCbudgetfriendly001",
    expectedChannelHandle: "@BudgetFriendlyShorts",
    metadata: {
      title: "Approval is not integrity",
      description: "A compact contrast on approval and integrity. Source: Example Speaker",
      tags: ["discipline", "integrity"],
      aiGeneratedDisclosure: false,
      relatedVideoId: "related001",
      relatedVideoWaiverReason: null,
    },
    privacyStatus: "private",
    idempotencyKeyHash: digest("5"),
    approvedBy: "publish_operator",
    approvedAt: "2026-07-03T02:00:00.000Z",
    requestedAt: "2026-07-03T02:01:00.000Z",
    ...overrides,
  };
}

function receiptInput(source, candidate, experiment, render, publish, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: "PublishReceipt",
    receiptId: "receipt_receipt001",
    publishManifestHash: publish.contentHash,
    sourceManifestHash: source.contentHash,
    sourceHash: source.sourceHash,
    candidateHash: candidate.candidateHash,
    experimentManifestHash: experiment.contentHash,
    renderManifestHash: render.contentHash,
    outputHash: render.outputHash,
    idempotencyKeyHash: publish.idempotencyKeyHash,
    youtubeVideoId: "video000001",
    channelId: "UCbudgetfriendly001",
    channelHandle: "@BudgetFriendlyShorts",
    privacyStatus: "private",
    responseState: "uploaded",
    publishedAt: "2026-07-03T03:00:00.000Z",
    ...overrides,
  };
}

function completeness(metrics) {
  return Object.fromEntries([
    "views", "engagedViews", "stayedToWatchPercent", "averageViewDurationSeconds",
    "averagePercentageViewed", "likes", "shares", "comments", "subscribersGained",
  ].map((key) => [key, metrics[key] !== null && metrics[key] !== undefined]));
}

function snapshotInput(receipt, experiment, overrides = {}) {
  const metrics = overrides.metrics || {
    views: 2000,
    engagedViews: 1500,
    stayedToWatchPercent: 55,
    averageViewDurationSeconds: 13,
    averagePercentageViewed: 92,
    likes: 120,
    shares: 30,
    comments: 18,
    subscribersGained: 9,
  };
  return {
    schemaVersion: 1,
    artifactType: "AnalyticsSnapshot",
    snapshotId: "snap_snapshot001",
    publishReceiptHash: receipt.contentHash,
    publishManifestHash: receipt.publishManifestHash,
    experimentManifestHash: experiment.contentHash,
    videoId: receipt.youtubeVideoId,
    publishedAt: receipt.publishedAt,
    observedAt: "2026-07-10T03:00:00.000Z",
    videoAgeHours: 168,
    snapshotGateHours: 168,
    decisionEligible: true,
    source: "youtube_analytics_api",
    experimentId: experiment.experimentId,
    cohortId: experiment.cohortId,
    treatmentId: experiment.treatmentId,
    pillar: experiment.pillar,
    formatProfile: experiment.formatProfile,
    selectionProfile: experiment.selectionProfile,
    renderProfile: experiment.renderProfile,
    durationSeconds: 14,
    durationBucket: "13_16s",
    metrics,
    completeness: completeness(metrics),
    completeForPrimaryDecision: true,
    ...overrides,
    metrics,
    completeness: overrides.completeness || completeness(metrics),
  };
}

function buildChain() {
  const source = normalizeSourceAssetManifest(sourceInput());
  const candidate = normalizeCandidateDecision(candidateInput(source), { sourceAssetManifest: source });
  const experiment = normalizeExperimentManifest(experimentInput(candidate), {
    sourceAssetManifest: source,
    candidateDecision: candidate,
  });
  const options = { sourceAssetManifest: source, candidateDecision: candidate, experimentManifest: experiment };
  const render = normalizeRenderManifest(renderInput(source, candidate, experiment), options);
  const qa = normalizeCreativeQa(qaInput(source, candidate, render), { ...options, renderManifest: render });
  const publish = normalizePublishManifest(publishInput(source, candidate, experiment, render, qa), {
    ...options,
    renderManifest: render,
    creativeQa: qa,
  });
  const fullOptions = { ...options, renderManifest: render, creativeQa: qa, publishManifest: publish };
  const receipt = normalizePublishReceipt(receiptInput(source, candidate, experiment, render, publish), fullOptions);
  const snapshot = normalizeAnalyticsSnapshot(snapshotInput(receipt, experiment), {
    ...fullOptions,
    publishReceipt: receipt,
  });
  return { source, candidate, experiment, render, qa, publish, receipt, snapshot, options: fullOptions };
}

test("growth normalizers seal and hash-link the entire publish-to-analytics chain", () => {
  const chain = buildChain();

  for (const artifact of [
    chain.source,
    chain.candidate,
    chain.experiment,
    chain.render,
    chain.qa,
    chain.publish,
    chain.receipt,
    chain.snapshot,
  ]) {
    assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(artifact), true);
  }
  assert.equal(chain.render.delivery.width, 1080);
  assert.equal(chain.render.delivery.height, 1920);
  assert.equal(chain.render.delivery.fps, 30);
  assert.equal(chain.render.cuts.artificialCutCount, 0);
  assert.equal(chain.snapshot.metrics.sharesPer1000Engaged, 20);
  assert.equal(chain.snapshot.snapshotGateHours, 168);
});

test("growth normalizers reject unknown fields, tampered seals, stale links, and failed QA", () => {
  const chain = buildChain();

  assert.throws(
    () => normalizeSourceAssetManifest({ ...sourceInput(), credential: "must-not-enter-contract" }),
    (error) => error.code === "GROWTH_CONTRACT_INVALID" && error.details.field === "sourceAssetManifest.credential",
  );
  assert.throws(
    () => normalizeSourceAssetManifest({ ...chain.source, owner: "Tampered owner" }),
    (error) => error.code === "GROWTH_HASH_MISMATCH" && error.details.field === "sourceAssetManifest.contentHash",
  );
  assert.throws(
    () => normalizeRenderManifest({ ...chain.render, candidateHash: digest("9"), contentHash: undefined }, chain.options),
    (error) => error.code === "GROWTH_LINK_MISMATCH" && error.details.field === "renderManifest.candidateHash",
  );

  const expiredSource = normalizeSourceAssetManifest({
    ...chain.source,
    contentHash: undefined,
    expiresAt: "2026-07-03T02:00:00.000Z",
  });
  assert.throws(
    () => normalizePublishManifest({
      ...chain.publish,
      contentHash: undefined,
      sourceManifestHash: expiredSource.contentHash,
    }, { ...chain.options, sourceAssetManifest: expiredSource, renderManifest: chain.render, creativeQa: chain.qa }),
    (error) => error.code === "GROWTH_CONTRACT_INVALID"
      && error.details.field === "publishManifest.sourceManifestHash",
  );

  const failedQa = normalizeCreativeQa(qaInput(chain.source, chain.candidate, chain.render, {
    hookLatencySeconds: 0.5,
    passed: false,
    failedGates: ["hook_latency"],
  }), { ...chain.options, renderManifest: chain.render });
  assert.throws(
    () => normalizePublishManifest({
      ...publishInput(chain.source, chain.candidate, chain.experiment, chain.render, failedQa),
      creativeQaHash: failedQa.contentHash,
    }, { ...chain.options, renderManifest: chain.render, creativeQa: failedQa }),
    (error) => error.code === "GROWTH_CONTRACT_INVALID" && error.details.field === "publishManifest.creativeQaHash",
  );
});

function cohortSnapshot({ index, cohortId, gateHours = 168, metrics, experimentManifestHash }) {
  const published = new Date("2026-01-01T00:00:00.000Z");
  const observed = new Date(published.getTime() + gateHours * 3600000);
  const base = {
    schemaVersion: 1,
    artifactType: "AnalyticsSnapshot",
    snapshotId: `snap_cohort${String(index).padStart(3, "0")}`,
    publishReceiptHash: digest(index % 8 + 1 + ""),
    publishManifestHash: digest(index % 7 + 2 + ""),
    experimentManifestHash,
    videoId: `video${String(index).padStart(6, "0")}`,
    publishedAt: published.toISOString(),
    observedAt: observed.toISOString(),
    videoAgeHours: gateHours,
    snapshotGateHours: gateHours,
    decisionEligible: gateHours >= 24,
    source: "youtube_analytics_api",
    experimentId: "exp_growth001",
    cohortId,
    treatmentId: `${cohortId}_${index}`,
    pillar: "discipline_work",
    formatProfile: FORMAT_PROFILE,
    selectionProfile: SELECTION_PROFILE,
    renderProfile: RENDER_PROFILE,
    durationSeconds: 14,
    durationBucket: "13_16s",
    metrics,
    completeness: completeness(metrics),
    completeForPrimaryDecision: true,
  };
  return normalizeAnalyticsSnapshot(base);
}

function evaluationSnapshots(gateHours = 168) {
  const snapshots = [];
  const winnerEngaged = [2000, 2100, 2200];
  const loserEngaged = [900, 1000, 1100, 100000];
  winnerEngaged.forEach((engagedViews, index) => snapshots.push(cohortSnapshot({
    index: index + 1,
    cohortId: "contradiction_hook",
    gateHours,
    experimentManifestHash: digest("a"),
    metrics: {
      views: engagedViews + 500,
      engagedViews,
      stayedToWatchPercent: 55 + index,
      averageViewDurationSeconds: 13,
      averagePercentageViewed: 90 + index,
      likes: 100,
      shares: 30,
      comments: 20,
      subscribersGained: 10,
    },
  })));
  loserEngaged.forEach((engagedViews, index) => snapshots.push(cohortSnapshot({
    index: index + 10,
    cohortId: "generic_motivation",
    gateHours,
    experimentManifestHash: digest("b"),
    metrics: {
      views: engagedViews + 500,
      engagedViews,
      stayedToWatchPercent: 43 + index,
      averageViewDurationSeconds: 11,
      averagePercentageViewed: 78 + index,
      likes: 70,
      shares: 5,
      comments: 4,
      subscribersGained: 2,
    },
  })));
  return snapshots;
}

test("equal-age evaluator uses medians, ignores one viral outlier, and requires human approval", () => {
  const snapshots = evaluationSnapshots();
  const pending = evaluateEqualAgeCohorts(snapshots, {
    experimentId: "exp_growth001",
    gateHours: 168,
    minimumPerCohort: 3,
  });

  assert.equal(pending.evaluation.metricRule, "median");
  assert.equal(pending.evaluation.equalAgeComparison, true);
  assert.equal(pending.evaluation.recommendation, "human_review_winner");
  assert.equal(pending.evaluation.winnerCohortId, "contradiction_hook");
  assert.equal(pending.experimentDecision, null);
  const loser = pending.evaluation.cohorts.find((entry) => entry.cohortId === "generic_motivation");
  assert.equal(loser.medians.engagedViews, 1050);

  const approved = evaluateEqualAgeCohorts(snapshots, {
    experimentId: "exp_growth001",
    gateHours: 168,
    minimumPerCohort: 3,
    humanApproval: {
      decisionId: "exd_decision001",
      decision: "keep",
      winnerCohortId: "contradiction_hook",
      approver: "growth_operator",
      approvedAt: "2026-07-16T00:00:00.000Z",
      notes: "Winner leads all primary medians and satisfaction.",
    },
  });
  assert.equal(approved.experimentDecision.decision, "keep");
  assert.equal(approved.experimentDecision.humanApproved, true);
  assert.equal(approved.experimentDecision.profileMutationApplied, false);
  assert.equal(normalizeExperimentDecision(approved.experimentDecision, { evaluation: approved.evaluation }).contentHash, approved.experimentDecision.contentHash);
});

test("1h and 6h evaluations are observational and cannot create a decision", () => {
  for (const gateHours of [1, 6]) {
    const snapshots = evaluationSnapshots(gateHours);
    const result = evaluateEqualAgeCohorts(snapshots, { experimentId: "exp_growth001", gateHours });
    assert.equal(result.evaluation.recommendation, "observational_only");
    assert.equal(result.evaluation.humanApprovalRequired, false);
    assert.equal(result.experimentDecision, null);
    assert.throws(
      () => evaluateEqualAgeCohorts(snapshots, {
        experimentId: "exp_growth001",
        gateHours,
        humanApproval: {
          decisionId: "exd_tooearly001",
          decision: "keep",
          winnerCohortId: "contradiction_hook",
          approver: "growth_operator",
          approvedAt: "2026-07-16T00:00:00.000Z",
          notes: "Too early",
        },
      }),
      (error) => error.code === "GROWTH_CONTRACT_INVALID" && error.details.field === "humanApproval",
    );
  }
});

test("all six declared equal-age gates route to observational or decision review state", () => {
  for (const gateHours of [1, 6, 24, 72, 168, 672]) {
    const result = evaluateEqualAgeCohorts(evaluationSnapshots(gateHours), {
      experimentId: "exp_growth001",
      gateHours,
    });
    assert.equal(result.evaluation.snapshotGateHours, gateHours);
    assert.equal(
      result.evaluation.recommendation,
      gateHours < 24 ? "observational_only" : "human_review_winner",
    );
    assert.equal(result.experimentDecision, null);
  }
});

test("growth store atomically persists receipts and snapshots with durable idempotency", () => {
  const directory = mkdtempSync(join(tmpdir(), "motivational-growth-store-"));
  try {
    assert.throws(
      () => new GrowthStore(directory, { fileName: "../escape.json" }),
      (error) => error.code === "GROWTH_STORE_INVALID" && error.details.field === "fileName",
    );
    const chain = buildChain();
    const firstStore = new GrowthStore(directory);
    const insertedReceipt = firstStore.putPublishReceipt(chain.receipt);
    assert.equal(insertedReceipt.replayed, false);

    const reloadedStore = new GrowthStore(directory);
    assert.equal(reloadedStore.putPublishReceipt(chain.receipt).replayed, true);
    assert.equal(reloadedStore.getPublishReceiptByIdempotencyKey(chain.receipt.idempotencyKeyHash).youtubeVideoId, chain.receipt.youtubeVideoId);

    const conflictingReceipt = normalizePublishReceipt({
      ...chain.receipt,
      contentHash: undefined,
      receiptId: "receipt_conflict001",
      youtubeVideoId: "video000002",
    });
    assert.throws(
      () => reloadedStore.putPublishReceipt(conflictingReceipt),
      (error) => error.code === "GROWTH_IDEMPOTENCY_CONFLICT",
    );

    const duplicateOutputReceipt = normalizePublishReceipt({
      ...chain.receipt,
      contentHash: undefined,
      receiptId: "receipt_duplicate001",
      publishManifestHash: digest("6"),
      idempotencyKeyHash: digest("7"),
      youtubeVideoId: "video000003",
    });
    assert.throws(
      () => reloadedStore.putPublishReceipt(duplicateOutputReceipt),
      (error) => error.code === "GROWTH_DUPLICATE_PUBLISH"
        && error.details.field === "publishReceipt.outputHash",
    );

    const insertedSnapshot = reloadedStore.putAnalyticsSnapshot(chain.snapshot);
    assert.deepEqual({ replayed: insertedSnapshot.replayed, replaced: insertedSnapshot.replaced }, { replayed: false, replaced: false });
    assert.equal(new GrowthStore(directory).putAnalyticsSnapshot(chain.snapshot).replayed, true);

    const newerMetrics = { ...chain.snapshot.metrics, views: 2200, engagedViews: 1600, shares: 32 };
    delete newerMetrics.sharesPer1000Engaged;
    delete newerMetrics.commentsPer1000Engaged;
    delete newerMetrics.subscribersPer1000Engaged;
    const newerSnapshot = normalizeAnalyticsSnapshot({
      ...chain.snapshot,
      contentHash: undefined,
      snapshotId: "snap_snapshot002",
      observedAt: "2026-07-10T04:00:00.000Z",
      videoAgeHours: 169,
      metrics: newerMetrics,
      completeness: completeness(newerMetrics),
    });
    assert.equal(reloadedStore.putAnalyticsSnapshot(newerSnapshot).replaced, true);
    assert.equal(new GrowthStore(directory).listAnalyticsSnapshots({ gateHours: 168 })[0].snapshotId, "snap_snapshot002");

    const file = join(directory, STORE_FILE_NAME);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory), [STORE_FILE_NAME]);
    assert.doesNotMatch(readFileSync(file, "utf8"), /credential|storageKey|\/Users\//i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
