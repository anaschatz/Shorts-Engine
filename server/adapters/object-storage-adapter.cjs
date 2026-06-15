const { CONFIG, validateStorageConfig } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { LocalArtifactAdapter } = require("./local-artifact-adapter.cjs");
const { MockCloudArtifactAdapter } = require("./mock-cloud-artifact-adapter.cjs");
const { S3CompatibleArtifactAdapter } = require("./s3-artifact-adapter.cjs");
const { validateArtifactAdapter } = require("./artifact-adapter.cjs");

const S3_COMPATIBLE_MODES = Object.freeze(["s3", "r2"]);
const CLOUD_PLACEHOLDER_MODES = Object.freeze(["gcs"]);

function normalizeAdapterConfig(options = {}) {
  return validateStorageConfig({
    adapter: options.storageAdapterMode || options.adapter || CONFIG.storage.adapter,
    bucket: options.bucket ?? CONFIG.storage.bucket,
    region: options.region ?? CONFIG.storage.region,
    endpoint: options.endpoint ?? CONFIG.storage.endpoint,
    accessKeyId: options.accessKeyId ?? CONFIG.storage.accessKeyId,
    secretAccessKey: options.secretAccessKey ?? CONFIG.storage.secretAccessKey,
    sessionToken: options.sessionToken ?? CONFIG.storage.sessionToken,
    forcePathStyle: options.forcePathStyle ?? CONFIG.storage.forcePathStyle,
    signedUrlTtlSeconds: options.signedUrlTtlSeconds ?? CONFIG.storage.signedUrlTtlSeconds,
    multipartThresholdBytes: options.multipartThresholdBytes ?? CONFIG.storage.multipartThresholdBytes,
    multipartPartSizeBytes: options.multipartPartSizeBytes ?? CONFIG.storage.multipartPartSizeBytes,
    lifecycleCleanupMaxAgeSeconds: options.lifecycleCleanupMaxAgeSeconds ?? CONFIG.storage.lifecycleCleanupMaxAgeSeconds,
    lifecycleCleanupMaxPerRun: options.lifecycleCleanupMaxPerRun ?? CONFIG.storage.lifecycleCleanupMaxPerRun,
  });
}

function publicStorageConfig(config) {
  return {
    adapter: config.adapter,
    bucketConfigured: Boolean(config.bucket),
    regionConfigured: Boolean(config.region),
    endpointConfigured: Boolean(config.endpoint),
    credentialsConfigured: Boolean(config.credentialsConfigured),
    forcePathStyle: Boolean(config.forcePathStyle),
    signedUrlTtlSeconds: config.signedUrlTtlSeconds,
    multipartThresholdBytes: config.multipartThresholdBytes,
    multipartPartSizeBytes: config.multipartPartSizeBytes,
    lifecycleCleanupMaxAgeSeconds: config.lifecycleCleanupMaxAgeSeconds,
    lifecycleCleanupMaxPerRun: config.lifecycleCleanupMaxPerRun,
  };
}

function createArtifactAdapterFromConfig(options = {}) {
  const config = normalizeAdapterConfig(options);
  if (config.adapter === "local") {
    return validateArtifactAdapter(
      new LocalArtifactAdapter({
        ...options.artifactOptions,
        tokenTtlSeconds: config.signedUrlTtlSeconds,
      }),
    );
  }
  if (config.adapter === "mock-cloud") {
    return validateArtifactAdapter(
      new MockCloudArtifactAdapter({
        ...options.artifactOptions,
        tokenTtlSeconds: config.signedUrlTtlSeconds,
      }),
    );
  }
  if (S3_COMPATIBLE_MODES.includes(config.adapter)) {
    return validateArtifactAdapter(
      new S3CompatibleArtifactAdapter({
        ...options.artifactOptions,
        client: options.client || options.artifactOptions?.client,
        config,
        mode: config.adapter,
        tokenTtlSeconds: config.signedUrlTtlSeconds,
      }),
    );
  }
  if (CLOUD_PLACEHOLDER_MODES.includes(config.adapter)) {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500, {
      adapter: config.adapter,
      reason: "cloud_adapter_placeholder",
    });
  }
  throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
}

module.exports = {
  CLOUD_PLACEHOLDER_MODES,
  S3_COMPATIBLE_MODES,
  createArtifactAdapterFromConfig,
  normalizeAdapterConfig,
  publicStorageConfig,
};
