const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  CreateBucketCommand,
  DeleteBucketCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const {
  R2ArtifactStore,
  artifactStorageKey,
} = require("../server/storage/r2-artifact-store.cjs");

const endpoint = String(process.env.TEST_S3_ENDPOINT || "");

async function bodyBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("S3-compatible storage shares verified artifacts across independent workers", {
  skip: endpoint ? false : "TEST_S3_ENDPOINT is not configured",
  timeout: 60_000,
}, async () => {
  const bucket = `shortsengine-${randomUUID()}`;
  const config = {
    bucket,
    region: "us-east-1",
    endpoint,
    accessKeyId: String(process.env.TEST_S3_ACCESS_KEY_ID || ""),
    secretAccessKey: String(process.env.TEST_S3_SECRET_ACCESS_KEY || ""),
    partSizeBytes: 5 * 1024 * 1024,
    presignTtlSeconds: 60,
  };
  const admin = new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  const workerA = new R2ArtifactStore({ config });
  const workerB = new R2ArtifactStore({ config });
  const storageKey = artifactStorageKey({
    ownerId: "usr_integration",
    artifactId: "art_integration",
    purpose: "preview",
    extension: "bin",
  });
  const payload = Buffer.from("shared-worker-artifact");
  try {
    await workerA.putObjectStream({
      storageKey,
      body: Readable.from(payload),
      byteSize: payload.length,
      contentType: "application/octet-stream",
      metadata: { purpose: "integration" },
    });
    const head = await workerB.headObject(storageKey);
    assert.equal(head.byteSize, payload.length);
    const ranged = await workerB.getObjectStream(storageKey, {
      range: { start: 7, end: 12 },
    });
    assert.equal((await bodyBuffer(ranged.body)).toString(), "worker");
    assert.equal((await workerA.readiness()).ready, true);
    await workerB.deleteObject(storageKey);
  } finally {
    await workerA.close();
    await workerB.close();
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
    admin.destroy();
  }
});
