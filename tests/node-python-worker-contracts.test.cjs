const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const {
  VALIDATORS,
  WorkerContractError,
  validateFixture,
  validateRenderRequest,
} = require("../server/python-worker-contracts.cjs");

const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(
  __dirname,
  "fixtures",
  "node-python-contracts",
  "valid-v1.json",
);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("Node and Python accept the same path-free v1 fixture", () => {
  const payload = fixture();
  validateFixture(payload);
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(VALIDATORS).sort());

  const result = spawnSync(
    process.env.PYTHON_BIN || "python3",
    ["-m", "shorts_generator.worker_contracts", "--validate-fixture", FIXTURE],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /worker contract fixture valid/);
});

test("runtime validators reject paths, unknown fields, and unsupported versions", () => {
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    const invalid = structuredClone(fixture()[name]);
    invalid.localPath = "/tmp/private.mp4";
    assert.throws(
      () => validator(invalid),
      (error) => error instanceof WorkerContractError
        && error.code === "CONTRACT_SHAPE_INVALID",
      name,
    );
  }
  const unsupported = fixture().analysisRequest;
  unsupported.schemaVersion = 2;
  assert.throws(
    () => VALIDATORS.analysisRequest(unsupported),
    (error) => error.code === "CONTRACT_VERSION_UNSUPPORTED",
  );
});

test("render contract binds artifact, candidate, HookGate, and approved profile", () => {
  const request = fixture().renderRequest;
  assert.deepEqual(validateRenderRequest(request), request);

  request.candidate.sourceArtifactId = "artifact.other";
  assert.throws(
    () => validateRenderRequest(request),
    (error) => error.code === "CONTRACT_LINK_INVALID",
  );
});
