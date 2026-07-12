const { existsSync, readFileSync, statSync } = require("node:fs");
const { resolve } = require("node:path");

const MAX_BETA_REPORT_BYTES = 512 * 1024;

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function loadBetaEvaluationSummary(options = {}) {
  const reportPath = resolve(options.rootDir || process.cwd(), "eval/results/beta-latest.json");
  if (!existsSync(reportPath)) {
    return { status: "missing", productionBetaReady: false, metrics: null };
  }
  try {
    const stat = statSync(reportPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BETA_REPORT_BYTES) throw new Error("invalid report");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const metrics = report.metrics && typeof report.metrics === "object" && !Array.isArray(report.metrics)
      ? {
          matchCount: numberOrNull(report.metrics.matchCount),
          rightsClearedCount: numberOrNull(report.metrics.rightsClearedCount),
          reviewedClipCount: numberOrNull(report.metrics.reviewedClipCount),
          acceptedWithoutEditRate: numberOrNull(report.metrics.acceptedWithoutEditRate),
          falseGoalRate: numberOrNull(report.metrics.falseGoalRate),
          renderFailureRate: numberOrNull(report.metrics.renderFailureRate),
          costCoverageRate: numberOrNull(report.metrics.costCoverageRate),
          costPerVideoUsd: numberOrNull(report.metrics.costPerVideoUsd),
          costPerCompletedVideoUsd: numberOrNull(report.metrics.costPerCompletedVideoUsd),
        }
      : null;
    return {
      status: report.status === "passed" ? "passed" : "blocked",
      productionBetaReady: report.productionBetaReady === true,
      metrics,
    };
  } catch {
    return { status: "invalid", productionBetaReady: false, metrics: null };
  }
}

function createProductionBetaReadiness(input = {}) {
  const persistence = input.persistence || {};
  const artifacts = input.artifacts || {};
  const queue = input.queue || {};
  const auth = input.auth || {};
  const evaluation = input.evaluation || { status: "missing", productionBetaReady: false, metrics: null };
  const persistenceMode = String(persistence.mode || persistence.adapter || "local");
  const storageMode = String(artifacts.mode || artifacts.adapter || "local");
  const authMode = String(auth.mode || "operator");
  const checks = [
    {
      id: "rights_cleared_human_evaluation",
      passed: evaluation.productionBetaReady === true && Number(evaluation.metrics && evaluation.metrics.matchCount) >= 20,
      status: evaluation.status,
    },
    {
      id: "postgres_persistence",
      passed: persistenceMode === "postgres" && persistence.ready === true,
      status: persistenceMode,
    },
    {
      id: "object_storage",
      passed: ["s3", "r2", "gcs"].includes(storageMode) && artifacts.ready === true,
      status: storageMode,
    },
    {
      id: "durable_multi_worker_queue",
      passed: queue.persisted === true && persistenceMode === "postgres" && queue.claimingSupported !== false,
      status: queue.persisted === true ? "persisted" : "local",
    },
    {
      id: "accounts_identity",
      passed: ["accounts", "oidc"].includes(authMode) && auth.ready === true,
      status: authMode,
    },
    {
      id: "ambiguous_goal_human_review_gate",
      passed: input.humanReviewGateAvailable === true,
      status: input.humanReviewGateAvailable === true ? "available" : "missing",
    },
    {
      id: "measurable_beta_metrics",
      passed: Boolean(
        evaluation.metrics &&
        evaluation.metrics.acceptedWithoutEditRate !== null &&
        evaluation.metrics.falseGoalRate !== null &&
        evaluation.metrics.renderFailureRate !== null &&
        evaluation.metrics.costPerVideoUsd !== null
      ),
      status: evaluation.metrics ? "reported" : "missing",
    },
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.id);
  return {
    ready: blockers.length === 0,
    stage: blockers.length === 0 ? "production_beta" : "prototype",
    checks,
    blockers,
    betaEvaluation: evaluation,
  };
}

module.exports = {
  createProductionBetaReadiness,
  loadBetaEvaluationSummary,
};
