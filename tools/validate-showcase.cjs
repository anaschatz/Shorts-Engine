const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const WORKFLOWS = new Set(["football", "motivational", "narrated-animation"]);
const PROVENANCE_STATUSES = new Set(["verified_repository_bundle", "not_recorded", "unknown", "pending"]);
const EXPLICIT_MARKERS = new Set(["unknown", "not_recorded", "pending", "unavailable"]);
const METRICS_COLUMNS = Object.freeze([
  "video_id",
  "workflow",
  "publish_date",
  "views",
  "viewed_vs_swiped_away",
  "average_view_duration",
  "average_percentage_viewed",
  "three_second_retention",
  "likes",
  "comments",
  "subscribers_gained",
  "generation_time_seconds",
  "estimated_cost",
  "manual_edit_minutes",
  "render_failed",
  "published_without_manual_edit",
]);

function validationError(message) {
  const error = new Error(message);
  error.code = "SHOWCASE_INVALID";
  return error;
}

function assertHttpsUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw validationError(`${field} must be a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw validationError(`${field} must be a credential-free HTTPS URL.`);
  }
  return url;
}

function assertExplicitValue(value, field) {
  if (value === null || value === undefined || value === "") {
    throw validationError(`${field} must use an explicit value such as unknown, not_recorded or pending.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw validationError(`${field} must be finite.`);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw validationError(`${field} must not be empty.`);
    value.forEach((item, index) => assertExplicitValue(item, `${field}[${index}]`));
  } else if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) throw validationError(`${field} must not be empty.`);
    entries.forEach(([key, item]) => assertExplicitValue(item, `${field}.${key}`));
  }
}

function assertSafeContent(value, label = "showcase content") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const unsafePathPatterns = [
    /(?:^|[\s"'`(=])\/(?:Users|private|tmp|var\/folders)\//m,
    /(?:^|[\s"'`(=])[A-Za-z]:\\(?:Users|Windows|ProgramData)\\/m,
    /file:\/\//i,
  ];
  const secretPatterns = [
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
    /\bsk-[A-Za-z0-9_-]{10,}/,
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/i,
  ];
  if (unsafePathPatterns.some((pattern) => pattern.test(text))) {
    throw validationError(`${label} contains an unsafe local path.`);
  }
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw validationError(`${label} contains a possible secret.`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw validationError("showcase/examples.json must contain an object.");
  }
  assertExplicitValue(manifest, "manifest");
  if (manifest.schema_version !== 1) throw validationError("Unsupported showcase schema_version.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.verified_at)) {
    throw validationError("verified_at must use YYYY-MM-DD.");
  }
  assertHttpsUrl(manifest.channel.url, "channel.url");
  assertHttpsUrl(manifest.channel.canonical_url, "channel.canonical_url");
  if (!Array.isArray(manifest.examples) || manifest.examples.length !== 3) {
    throw validationError("The showcase must contain exactly three documented examples.");
  }

  const ids = new Set();
  for (const [index, example] of manifest.examples.entries()) {
    const field = `examples[${index}]`;
    for (const required of [
      "id",
      "title",
      "workflow",
      "public_url",
      "verification_url",
      "public_url_status",
      "artifact_status",
      "engine_version",
      "provenance_status",
      "source_rights_status",
      "generation_mode",
      "automatic_pipeline_stages",
      "known_human_interventions",
      "render_duration_seconds",
      "output",
      "quality_gates_executed",
      "final_verification",
      "technical_summary",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(example, required)) {
        throw validationError(`${field}.${required} is required.`);
      }
    }
    if (!/^[a-z0-9][a-z0-9-]{4,79}$/.test(example.id)) {
      throw validationError(`${field}.id is invalid.`);
    }
    if (ids.has(example.id)) throw validationError(`Duplicate showcase id: ${example.id}.`);
    ids.add(example.id);
    if (!WORKFLOWS.has(example.workflow)) throw validationError(`${field}.workflow is invalid.`);
    if (!PROVENANCE_STATUSES.has(example.provenance_status)) {
      throw validationError(`${field}.provenance_status is invalid.`);
    }
    if (example.public_url_status === "verified_public") {
      const publicUrl = assertHttpsUrl(example.public_url, `${field}.public_url`);
      if (!publicUrl.pathname.startsWith("/shorts/")) {
        throw validationError(`${field}.public_url must be a YouTube Shorts URL.`);
      }
    } else if (!EXPLICIT_MARKERS.has(example.public_url)) {
      assertHttpsUrl(example.public_url, `${field}.public_url`);
    }
    if (!EXPLICIT_MARKERS.has(example.verification_url)) {
      assertHttpsUrl(example.verification_url, `${field}.verification_url`);
    }
    if (!Array.isArray(example.automatic_pipeline_stages) || example.automatic_pipeline_stages.length === 0) {
      throw validationError(`${field}.automatic_pipeline_stages must be explicit.`);
    }
    if (!Array.isArray(example.known_human_interventions) || example.known_human_interventions.length === 0) {
      throw validationError(`${field}.known_human_interventions must be explicit.`);
    }
    if (!Array.isArray(example.quality_gates_executed) || example.quality_gates_executed.length === 0) {
      throw validationError(`${field}.quality_gates_executed must be explicit.`);
    }
    assertExplicitValue(example, field);
  }
  assertSafeContent(manifest, "showcase/examples.json");
  return manifest;
}

function validateMetricsTemplate(csv) {
  const lines = csv.trimEnd().split(/\r?\n/);
  if (lines.length !== 1) throw validationError("metrics-template.csv must contain only its unpopulated header.");
  const columns = lines[0].split(",");
  if (columns.length !== METRICS_COLUMNS.length || columns.some((column, index) => column !== METRICS_COLUMNS[index])) {
    throw validationError("metrics-template.csv columns do not match the required contract.");
  }
  return columns;
}

function validateRepository(rootDir = resolve(__dirname, "..")) {
  const root = resolve(rootDir);
  const manifestPath = resolve(root, "showcase/examples.json");
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const manifest = validateManifest(JSON.parse(read("showcase/examples.json")));
  const readme = read("README.md");
  const showcase = read("SHOWCASE.md");
  const descriptions = read("showcase/youtube-descriptions.md");
  const metrics = read("showcase/metrics-template.csv");

  if (!readme.includes("SHOWCASE.md") || !readme.includes("Real Generated Outputs")) {
    throw validationError("README.md must contain a visible link to the showcase.");
  }
  for (const example of manifest.examples) {
    if (!showcase.includes(example.id)) {
      throw validationError(`SHOWCASE.md is missing manifest id ${example.id}.`);
    }
  }
  assertSafeContent(showcase, "SHOWCASE.md");
  assertSafeContent(descriptions, "showcase/youtube-descriptions.md");
  validateMetricsTemplate(metrics);

  return {
    ok: true,
    manifestPath: "showcase/examples.json",
    examples: manifest.examples.length,
    verifiedPublic: manifest.examples.filter((example) => example.public_url_status === "verified_public").length,
    localVerified: manifest.examples.filter((example) => example.artifact_status === "verified_local_technical_final").length,
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(validateRepository())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || "SHOWCASE_INVALID",
      message: String(error.message || "Showcase validation failed.").slice(0, 240),
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPLICIT_MARKERS,
  METRICS_COLUMNS,
  assertHttpsUrl,
  assertSafeContent,
  validateManifest,
  validateMetricsTemplate,
  validateRepository,
};
