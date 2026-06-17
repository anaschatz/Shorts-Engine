import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "./report-safety.mjs";
import {
  buildSideBySideReview,
  safeRelativeRef,
} from "./run-side-by-side-review.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROOF = "demo/results/youtube-live-e2e-latest.json";
const DEFAULT_REFERENCE = "manual-downloads/shortsengine-reference-rZZUzMSfaQ.mp4";
const DEFAULT_RESULTS_DIR = "demo/results";
const REVIEW_SCHEMA_VERSION = 1;

const HUMAN_VISUAL_CHECKLIST = Object.freeze([
  {
    id: "action_sequence_visible",
    label: "Shows the real action or goal sequence",
    mappedCriterion: "moment_selection",
  },
  {
    id: "shot_contact_included",
    label: "Includes shot/contact instead of starting from reaction",
    mappedCriterion: "moment_selection",
  },
  {
    id: "ball_goalmouth_payoff_visible",
    label: "Shows trajectory, goal mouth/keeper and payoff when available",
    mappedCriterion: "ball_player_framing",
  },
  {
    id: "reaction_support_only",
    label: "Uses crowd/coach/reaction only as support",
    mappedCriterion: "replay_or_context_use",
  },
  {
    id: "payoff_not_cut",
    label: "Does not cut before the decisive payoff",
    mappedCriterion: "pacing_energy",
  },
  {
    id: "ball_players_in_frame",
    label: "Keeps ball and players readable in frame",
    mappedCriterion: "ball_player_framing",
  },
  {
    id: "captions_match_action",
    label: "Captions match the visible action",
    mappedCriterion: "caption_action_alignment",
  },
  {
    id: "no_false_goal_claim",
    label: "No false goal claim",
    mappedCriterion: "false_goal_guard",
  },
  {
    id: "text_not_blocking_action",
    label: "Text does not block critical action",
    mappedCriterion: "text_readability",
  },
  {
    id: "reference_pacing_energy",
    label: "Pacing/editing feels close to the reference",
    mappedCriterion: "reference_style_editing",
  },
]);

function nowIso() {
  return new Date().toISOString();
}

function safeTimestamp(value) {
  return String(value || nowIso()).replace(/[:.]/g, "-").replace(/[^A-Za-z0-9TZ_-]/g, "-");
}

function atomicWriteJson(fileName, payload) {
  mkdirSync(dirname(fileName), { recursive: true });
  const tempName = `${fileName}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempName, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempName, fileName);
}

function relativeFromRoot(fileName, rootDir = ROOT_DIR) {
  return relative(rootDir, fileName).replace(/\\/g, "/");
}

function failure(code, message, nextAction, details = {}) {
  return {
    code,
    message,
    nextAction,
    ...details,
  };
}

function loadProofReport(rootDir, proofPath) {
  const ref = safeRelativeRef(rootDir, proofPath);
  if (!ref.ok) {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_REF_UNSAFE",
        "Live proof report reference must stay inside the workspace.",
        "use-a-safe-relative-proof-report",
        { field: "proof" },
      ),
    };
  }
  if (extname(ref.resolvedFile).toLowerCase() !== ".json") {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_EXTENSION_UNSUPPORTED",
        "Live proof report must be a JSON file.",
        "use-demo-results-youtube-live-e2e-latest-json",
        { field: "proof" },
      ),
    };
  }
  if (!existsSync(ref.resolvedFile)) {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_MISSING",
        "Live proof report is missing.",
        "run-youtube-proof-operator-after-rights-confirmation-or-pass-generated-ref",
        { field: "proof", proofReport: ref.relativePath },
      ),
    };
  }
  try {
    const report = JSON.parse(readFileSync(ref.resolvedFile, "utf8"));
    if (findSensitiveLeak(report)) {
      return {
        ok: false,
        failedCase: failure(
          "HUMAN_VISUAL_REVIEW_PROOF_LEAK_GUARD",
          "Live proof report contains unsafe data.",
          "regenerate-safe-live-proof-report",
          { field: "proof", proofReport: ref.relativePath },
        ),
      };
    }
    return { ok: true, report, relativePath: ref.relativePath };
  } catch {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_JSON_INVALID",
        "Live proof report could not be parsed.",
        "regenerate-safe-live-proof-report",
        { field: "proof", proofReport: ref.relativePath },
      ),
    };
  }
}

function generatedArtifactFromProof(proof) {
  if (!proof || typeof proof !== "object") {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_INVALID",
        "Live proof report shape is invalid.",
        "regenerate-safe-live-proof-report",
      ),
    };
  }
  if (proof.status !== "passed" || proof.passed !== true) {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_PROOF_NOT_PASSED",
        "Live proof did not pass, so no generated comparison can be trusted.",
        proof.nextAction || "fix-live-proof-before-human-review",
        { proofStatus: proof.status || null, proofPhase: proof.phase || null },
      ),
    };
  }
  const artifact = proof.generatedArtifact || proof.smoke?.generatedArtifact || null;
  const relativePath = String(artifact?.relativePath || "").trim();
  if (!relativePath || artifact.downloadVerified !== true) {
    return {
      ok: false,
      failedCase: failure(
        "HUMAN_VISUAL_REVIEW_GENERATED_ARTIFACT_MISSING",
        "Live proof passed but did not include a verified generated video artifact.",
        "rerun-youtube-proof-operator-with-download-artifact-saving-enabled",
      ),
    };
  }
  return {
    ok: true,
    artifact: {
      type: artifact.type || "rendered_video",
      status: artifact.status || "available",
      relativePath,
      sourceType: artifact.sourceType || "youtube",
      videoId: artifact.videoId || proof.source?.videoId || null,
      projectId: artifact.projectId || proof.smoke?.ids?.projectId || null,
      uploadId: artifact.uploadId || proof.smoke?.ids?.uploadId || null,
      jobId: artifact.jobId || proof.smoke?.ids?.jobId || null,
      exportId: artifact.exportId || proof.smoke?.ids?.exportId || null,
      durationSeconds: Number.isFinite(Number(artifact.durationSeconds)) ? Number(artifact.durationSeconds) : null,
      width: Number.isFinite(Number(artifact.width)) ? Number(artifact.width) : null,
      height: Number.isFinite(Number(artifact.height)) ? Number(artifact.height) : null,
      sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
      sha256Prefix: artifact.sha256Prefix || proof.smoke?.export?.sha256Prefix || null,
      downloadVerified: true,
    },
  };
}

function sourceSummaryFromProof(proofRelativePath, proof, artifact = null) {
  if (!proof) {
    return { mode: "direct_refs", proofReport: null, liveProof: null, generatedArtifact: artifact };
  }
  return {
    mode: "live_proof",
    proofReport: proofRelativePath,
    liveProof: {
      command: proof.command || null,
      status: proof.status || null,
      passed: proof.passed === true,
      phase: proof.phase || null,
      source: proof.source
        ? {
            sourceType: proof.source.sourceType || "youtube",
            kind: proof.source.kind || null,
            videoId: proof.source.videoId || null,
          }
        : null,
      logsDownloaded: false,
      artifactsDownloaded: false,
    },
    generatedArtifact: artifact,
  };
}

function statusForHumanReview(sideReport) {
  if (!sideReport || sideReport.status !== "passed") return "failed";
  if (sideReport.quality?.productReady) return "product_ready";
  if (sideReport.quality?.humanReviewRequired) return "pending_human_review";
  return "needs_improvement";
}

function checklistFromSideReport(sideReport) {
  const criteria = new Map(
    (sideReport.quality?.criterionBreakdown || []).map((entry) => [entry.id, entry]),
  );
  const humanPending = sideReport.quality?.humanReviewRequired !== false;
  return HUMAN_VISUAL_CHECKLIST.map((item) => {
    const criterion = criteria.get(item.mappedCriterion);
    if (humanPending || !criterion) {
      return {
        id: item.id,
        label: item.label,
        status: "needs_human_review",
        evidence: "Requires operator playback review against the generated and reference videos.",
      };
    }
    return {
      id: item.id,
      label: item.label,
      status: criterion.status,
      evidence: `Mapped from ${criterion.id} operator score ${criterion.score}/5.`,
    };
  });
}

function recommendedNextFix(sideReport, failedCases = []) {
  if (failedCases.length > 0) return failedCases[0].nextAction || "fix-human-visual-review-inputs";
  const hint = sideReport?.quality?.improvementHints?.[0];
  if (hint) return hint.id;
  if (sideReport?.quality?.productReady) return "use-as-product-review-sample";
  return "complete-human-visual-review";
}

function failedReport({ timestamp, source, failedCases }) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: timestamp,
    command: "npm run demo:human-review",
    phase: "human_visual_review",
    status: "failed",
    passed: false,
    skipped: false,
    productReady: false,
    source,
    comparison: null,
    machineStructuralMetrics: null,
    humanReview: {
      status: "not_available",
      present: false,
      productReady: false,
    },
    checklist: HUMAN_VISUAL_CHECKLIST.map((item) => ({
      id: item.id,
      label: item.label,
      status: "blocked",
      evidence: "Comparison could not be created safely.",
    })),
    recommendedNextFix: failedCases[0]?.nextAction || "fix-human-visual-review-inputs",
    failedCases,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function buildHumanVisualReview(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const timestamp = options.now || nowIso();
  let generated = options.generated || null;
  const reference = options.reference || DEFAULT_REFERENCE;
  let proof = null;
  let proofRelativePath = null;
  let artifact = null;
  const failedCases = [];

  if (!generated) {
    const proofPath = options.proof || DEFAULT_PROOF;
    const loaded = loadProofReport(rootDir, proofPath);
    if (!loaded.ok) {
      failedCases.push(loaded.failedCase);
      return failedReport({ timestamp, source: sourceSummaryFromProof(null, null), failedCases });
    }
    proof = loaded.report;
    proofRelativePath = loaded.relativePath;
    const extracted = generatedArtifactFromProof(proof);
    if (!extracted.ok) {
      failedCases.push(extracted.failedCase);
      return failedReport({
        timestamp,
        source: sourceSummaryFromProof(proofRelativePath, proof),
        failedCases,
      });
    }
    artifact = extracted.artifact;
    generated = artifact.relativePath;
  } else {
    artifact = { relativePath: generated, sourceType: "direct" };
  }

  const sideReport = buildSideBySideReview({
    rootDir,
    generated,
    reference,
    review: options.review,
    reviewPayload: options.reviewPayload,
    now: timestamp,
    probeVideo: options.probeVideo,
    createContactSheets: options.createContactSheets,
  });
  const status = statusForHumanReview(sideReport);
  const comparisonFailed = sideReport.status !== "passed";
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: timestamp,
    command: "npm run demo:human-review",
    phase: "human_visual_review",
    status,
    passed: !comparisonFailed,
    skipped: false,
    productReady: sideReport.quality?.productReady === true,
    source: sourceSummaryFromProof(proofRelativePath, proof, artifact),
    comparison: sideReport.comparison,
    machineStructuralMetrics: {
      structuralScore: sideReport.metrics?.machineScore ?? null,
      aspectRatioFit: sideReport.metrics?.aspectRatioFit ?? null,
      durationFit: sideReport.metrics?.durationFit ?? null,
      resolutionFit: sideReport.metrics?.resolutionFit ?? null,
      fileReadable: sideReport.metrics?.fileReadable ?? null,
      contactSheetAvailable: sideReport.metrics?.contactSheetAvailable ?? null,
    },
    humanReview: {
      status: sideReport.quality?.humanReviewRequired
        ? "pending_human_review"
        : sideReport.quality?.productReady
          ? "product_ready"
          : "needs_improvement",
      present: sideReport.operatorReview?.present === true && sideReport.operatorReview?.status !== "invalid",
      humanReviewRequired: sideReport.quality?.humanReviewRequired === true,
      humanScore: sideReport.quality?.humanScore ?? null,
      combinedScore: sideReport.quality?.combinedScore ?? null,
      qualityStatus: sideReport.quality?.qualityStatus || null,
      productReady: sideReport.quality?.productReady === true,
      failedCriteria: sideReport.quality?.failedCriteria || [],
      borderlineCriteria: sideReport.quality?.borderlineCriteria || [],
      improvementHints: sideReport.quality?.improvementHints || [],
      operatorReview: sideReport.operatorReview,
    },
    checklist: checklistFromSideReport(sideReport),
    recommendedNextFix: recommendedNextFix(sideReport, sideReport.failedCases || []),
    artifacts: {
      contactSheets: sideReport.artifacts?.contactSheets || [],
      logsDownloaded: false,
      rawArtifactsRequired: false,
    },
    failedCases: sideReport.failedCases || [],
    limitations: [
      "Machine metrics verify structure and readability, not creative quality.",
      "Product readiness requires human playback review for action sequence, captions, framing and pacing.",
      "Reports use safe relative references only and do not include raw downloader logs or absolute paths.",
    ],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  const leak = findSensitiveLeak(report);
  if (!leak) return report;
  return failedReport({
    timestamp,
    source: sourceSummaryFromProof(proofRelativePath, proof, artifact),
    failedCases: [
      failure(
        "HUMAN_VISUAL_REVIEW_REPORT_LEAK",
        "Human visual review report contained unsafe data.",
        "remove-sensitive-output-from-review-report",
        { leakCode: leak.code, leakPath: leak.path },
      ),
    ],
  });
}

function writeHumanVisualReviewReport(report, resultsDir = DEFAULT_RESULTS_DIR, rootDir = ROOT_DIR) {
  const outputDir = safeRelativeRef(rootDir, resultsDir);
  if (!outputDir.ok) throw new Error("HUMAN_VISUAL_REVIEW_RESULTS_DIR_UNSAFE");
  mkdirSync(outputDir.resolvedFile, { recursive: true });
  const latest = safeRelativeRef(rootDir, join(resultsDir, "human-visual-review-latest.json"));
  const timestamped = safeRelativeRef(rootDir, join(resultsDir, `human-visual-review-${safeTimestamp(report.generatedAt)}.json`));
  if (!latest.ok || !timestamped.ok) throw new Error("HUMAN_VISUAL_REVIEW_REPORT_REF_UNSAFE");
  const leak = findSensitiveLeak(report);
  const safeReport = leak
    ? failedReport({
        timestamp: report.generatedAt || nowIso(),
        source: report.source || sourceSummaryFromProof(null, null),
        failedCases: [
          failure(
            "HUMAN_VISUAL_REVIEW_REPORT_LEAK",
            "Human visual review report contained unsafe data and was not written.",
            "remove-sensitive-output-from-review-report",
            { leakCode: leak.code, leakPath: leak.path },
          ),
        ],
      })
    : report;
  atomicWriteJson(latest.resolvedFile, safeReport);
  atomicWriteJson(timestamped.resolvedFile, safeReport);
  return {
    latestPath: relativeFromRoot(latest.resolvedFile, rootDir),
    reportPath: relativeFromRoot(timestamped.resolvedFile, rootDir),
    report: safeReport,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--proof=")) options.proof = arg.slice("--proof=".length);
    else if (arg.startsWith("--generated=")) options.generated = arg.slice("--generated=".length);
    else if (arg.startsWith("--reference=")) options.reference = arg.slice("--reference=".length);
    else if (arg.startsWith("--review=")) options.review = arg.slice("--review=".length);
    else if (arg.startsWith("--results=")) options.resultsDir = arg.slice("--results=".length);
    else if (arg === "--no-contact-sheet") options.createContactSheets = false;
  }
  return options;
}

function runCli() {
  const options = parseArgs();
  const report = buildHumanVisualReview({ ...options, rootDir: ROOT_DIR });
  const written = writeHumanVisualReviewReport(report, options.resultsDir || DEFAULT_RESULTS_DIR, ROOT_DIR);
  const summary = {
    status: written.report.status,
    passed: written.report.passed,
    productReady: written.report.productReady,
    structuralScore: written.report.machineStructuralMetrics?.structuralScore ?? null,
    humanScore: written.report.humanReview?.humanScore ?? null,
    combinedScore: written.report.humanReview?.combinedScore ?? null,
    generated: written.report.comparison?.generated?.relativePath || written.report.source?.generatedArtifact?.relativePath || null,
    reference: written.report.comparison?.reference?.relativePath || null,
    latestPath: written.latestPath,
    reportPath: written.reportPath,
    failedCases: written.report.failedCases,
    recommendedNextFix: written.report.recommendedNextFix,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return written.report.status === "failed" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}

export {
  DEFAULT_PROOF,
  DEFAULT_REFERENCE,
  HUMAN_VISUAL_CHECKLIST,
  REVIEW_SCHEMA_VERSION,
  buildHumanVisualReview,
  generatedArtifactFromProof,
  writeHumanVisualReviewReport,
};
