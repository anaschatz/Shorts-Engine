import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

function safeJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function printAndExit(payload, status = 0) {
  process.stdout.write(`${safeJson(payload)}\n`);
  process.exitCode = status;
}

function missingCredentials(config) {
  if (!["s3", "r2"].includes(config.adapter)) return ["MATCHCUTS_STORAGE_ADAPTER"];
  const missing = [];
  if (!config.bucket) missing.push("MATCHCUTS_STORAGE_BUCKET");
  if (!config.accessKeyId) missing.push("MATCHCUTS_STORAGE_ACCESS_KEY_ID");
  if (!config.secretAccessKey) missing.push("MATCHCUTS_STORAGE_SECRET_ACCESS_KEY");
  if (config.adapter === "s3" && !config.region) missing.push("MATCHCUTS_STORAGE_REGION");
  if (config.adapter === "r2" && !config.endpoint) missing.push("MATCHCUTS_STORAGE_ENDPOINT");
  return missing;
}

function safeCleanup(adapter, artifacts) {
  try {
    return adapter.cleanupArtifactsByPolicy(artifacts.filter(Boolean), {
      allowedTypes: ["render_temp"],
      dryRun: false,
      maxAgeSeconds: 60,
      maxArtifacts: 10,
      nowMs: Date.now() + 120 * 1000,
    });
  } catch {
    return { dryRun: false, scanned: 0, eligible: 0, deleted: 0, skipped: 0, errors: 1 };
  }
}

async function main() {
  if (process.env.MATCHCUTS_RUN_REAL_CLOUD_TESTS !== "1") {
    printAndExit({
      ok: true,
      skipped: true,
      reason: "MATCHCUTS_RUN_REAL_CLOUD_TESTS is not enabled.",
    });
    return;
  }

  const {
    createArtifactAdapterFromConfig,
    normalizeAdapterConfig,
    publicStorageConfig,
  } = require("../server/adapters/object-storage-adapter.cjs");

  let config;
  try {
    config = normalizeAdapterConfig();
  } catch (error) {
    printAndExit({
      ok: true,
      skipped: true,
      reason: "Cloud storage configuration is incomplete or invalid.",
      code: error && error.code ? error.code : "CONFIG_INVALID",
    });
    return;
  }

  const missing = missingCredentials(config);
  if (missing.length > 0) {
    printAndExit({
      ok: true,
      skipped: true,
      reason: "Real cloud credentials are not fully configured.",
      missing,
      storage: publicStorageConfig(config),
    });
    return;
  }

  const adapter = createArtifactAdapterFromConfig();
  const testId = `cloud_it_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const inputKey = `integration/${testId}-input.txt`;
  const outputKey = `integration/${testId}-output.txt`;
  const signedKey = `integration/${testId}-signed.mp4`;
  let inputArtifact = null;
  let outputArtifact = null;
  let signedArtifact = null;
  let stage = null;
  let outputStage = null;

  try {
    const body = Buffer.from(`shortsengine-cloud-integration:${testId}`, "utf8");
    inputArtifact = adapter.writeArtifact({
      id: `render_temp_${testId}_input`,
      type: "render_temp",
      storageKey: inputKey,
      contentType: "text/plain",
      buffer: body,
    });

    const readBack = adapter.readArtifact(inputArtifact, { maxBytes: 1024 }).toString("utf8");
    stage = adapter.stageInputForProcessing(inputArtifact, { step: "real_cloud_integration" });
    const stagedBody = existsSync(stage.localPath) ? readFileSync(stage.localPath, "utf8") : "";

    outputStage = adapter.createOutputStage("render_temp", {
      id: `render_temp_${testId}_output`,
      storageKey: outputKey,
      contentType: "text/plain",
    });
    writeFileSync(outputStage.localPath, body, "utf8");
    outputArtifact = adapter.commitOutputStage(outputStage, { contentType: "text/plain" });
    signedArtifact = adapter.writeArtifact({
      id: `exp_${testId}_signed`,
      type: "export",
      storageKey: signedKey,
      contentType: "video/mp4",
      buffer: body,
      status: "staging",
    });
    const signed = adapter.createSignedDownloadUrl(signedArtifact, {
      basePath: "/api/artifacts/download",
      ttlSeconds: 60,
    });
    const cleanup = safeCleanup(adapter, [inputArtifact, outputArtifact]);

    printAndExit({
      ok: readBack === body.toString("utf8") && stagedBody === body.toString("utf8") && cleanup.deleted >= 1,
      skipped: false,
      storage: publicStorageConfig(config),
      checks: {
        write: inputArtifact.status === "available",
        read: readBack === body.toString("utf8"),
        stage: stagedBody === body.toString("utf8"),
        commit: outputArtifact.status === "available",
        signedDownload: Boolean(signed.downloadUrl || signed.url),
        cleanup: cleanup.deleted >= 1 && cleanup.errors === 0,
      },
      cleanup: {
        deleted: cleanup.deleted,
        skipped: cleanup.skipped,
        errors: cleanup.errors,
      },
    }, cleanup.errors === 0 ? 0 : 1);
  } catch (error) {
    safeCleanup(adapter, [inputArtifact, outputArtifact]);
    try {
      if (signedArtifact) adapter.deleteStagingArtifact(signedArtifact);
    } catch {
      // Best-effort integration object cleanup.
    }
    printAndExit({
      ok: false,
      skipped: false,
      code: error && error.code ? error.code : "CLOUD_INTEGRATION_FAILED",
      message: "Real cloud integration failed with a safe structured error.",
    }, 1);
  } finally {
    try {
      if (signedArtifact) adapter.deleteStagingArtifact(signedArtifact);
    } catch {
      // Best-effort integration object cleanup.
    }
    try {
      if (stage) adapter.cleanupStage(stage);
    } catch {
      // Best-effort local staging cleanup.
    }
    try {
      if (outputStage) adapter.cleanupStage(outputStage);
    } catch {
      // Best-effort local staging cleanup.
    }
  }
}

await main();
