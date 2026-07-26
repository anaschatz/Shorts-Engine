const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const test = require("node:test");

const {
  assertSafeContent,
  validateManifest,
  validateRepository,
} = require("../tools/validate-showcase.cjs");

const ROOT_DIR = resolve(__dirname, "..");
const MANIFEST = require("../showcase/examples.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("showcase manifest, documentation, README link, and metrics contract validate", () => {
  const result = validateRepository(ROOT_DIR);
  assert.deepEqual(result, {
    ok: true,
    manifestPath: "showcase/examples.json",
    examples: 3,
    verifiedPublic: 1,
    localVerified: 1,
  });
});

test("public examples require credential-free HTTPS Shorts URLs", () => {
  const invalid = clone(MANIFEST);
  invalid.examples[0].public_url = "http://www.youtube.com/shorts/3sQmO4611mo";
  assert.throws(
    () => validateManifest(invalid),
    (error) => error.code === "SHOWCASE_INVALID" && /HTTPS/.test(error.message),
  );
});

test("unknown evidence must be explicit", () => {
  const invalid = clone(MANIFEST);
  invalid.examples[1].output.duration_seconds = null;
  assert.throws(
    () => validateManifest(invalid),
    (error) => error.code === "SHOWCASE_INVALID" && /explicit value/.test(error.message),
  );
});

test("showcase safety rejects local paths and likely secrets", () => {
  assert.throws(
    () => assertSafeContent({ artifact: "/private/tmp/render.mp4" }),
    (error) => error.code === "SHOWCASE_INVALID" && /unsafe local path/.test(error.message),
  );
  assert.throws(
    () => assertSafeContent("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    (error) => error.code === "SHOWCASE_INVALID" && /possible secret/.test(error.message),
  );
});
