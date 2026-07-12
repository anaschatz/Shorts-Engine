const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { sanitizeText } = require("../../repositories/ids.cjs");
const {
  DARK_CURIOSITY_FORMAT_IDS,
  FOOTBALL_FORMAT_IDS,
  VERTICALS,
  assertVerticalFormat,
  normalizeVerticalId,
} = require("./vertical-registry.cjs");

const SCHEMA_VERSION = 1;
const DARK_CURIOSITY_SCHEMA_VERSION = 2;
const FORMAT_IDS = Object.freeze([...FOOTBALL_FORMAT_IDS, ...DARK_CURIOSITY_FORMAT_IDS]);
const LANGUAGES = Object.freeze(["el", "en"]);
const CLAIM_KINDS = Object.freeze(["supported_fact", "analysis", "opinion"]);
const BEAT_ROLES = Object.freeze(["hook", "setup", "mechanism", "consequence", "payoff"]);
const SCENE_TEMPLATES = Object.freeze([
  "hook_text",
  "pitch_tactical_sequence",
  "formation_compare",
  "stat_card",
  "payoff",
]);
const RECONSTRUCTION_MODES = Object.freeze(["generic", "illustrative", "exact_verified"]);
const FOOTBALL_OPERATIONS = Object.freeze([
  "place_player",
  "move_player",
  "hide_player",
  "place_ball",
  "pass",
  "carry",
  "draw_run",
  "draw_press",
  "highlight_zone",
  "label",
  "freeze",
  "zoom",
]);
const DARK_SOURCE_CLASSES = Object.freeze(["primary", "institutional", "reputable_secondary", "other"]);
const DARK_CLAIM_TYPES = Object.freeze(["verifiable_fact", "quote", "estimate", "interpretation", "hypothesis", "legend"]);
const DARK_CLAIM_VERDICTS = Object.freeze(["verified", "qualified", "disputed", "unsupported"]);
const DARK_RISK_CLASSES = Object.freeze(["ordinary", "manual_review"]);
const DARK_RISK_TAGS = Object.freeze(["crime", "death", "sensitive_event", "living_person", "medical", "financial", "political", "dangerous_behavior"]);
const SOURCE_SUPPORT_TYPES = Object.freeze(["direct", "corroborating", "context", "contradicts"]);

function validationError(message, field, details = {}) {
  throw new AppError("VALIDATION_ERROR", message || SAFE_MESSAGES.VALIDATION_ERROR, 400, {
    field,
    ...details,
  });
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validationError(`${field} must be an object.`, field);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) validationError(`${field} contains an unsupported field.`, `${field}.${key}`);
  }
}

function boundedText(value, field, maxLength, options = {}) {
  const text = sanitizeText(value, maxLength);
  if (!text && options.required !== false) validationError(`${field} is required.`, field);
  if (options.pattern && text && !options.pattern.test(text)) validationError(`${field} is invalid.`, field);
  return text;
}

function allowedToken(value, field, allowed) {
  const token = boundedText(value, field, 80).toLowerCase();
  if (!allowed.includes(token)) validationError(`${field} is unsupported.`, field, { value: token });
  return token;
}

function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    validationError(`${field} must be an integer between ${min} and ${max}.`, field);
  }
  return number;
}

function boundedNumber(value, field, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    validationError(`${field} must be between ${min} and ${max}.`, field);
  }
  return Number(number.toFixed(4));
}

function boundedList(value, field, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    validationError(`${field} must contain between ${min} and ${max} items.`, field);
  }
  return value;
}

function uniqueIds(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) validationError(`${field} contains a duplicate id.`, field, { id: item.id });
    seen.add(item.id);
  }
  return seen;
}

function normalizeId(value, field, prefix) {
  return boundedText(value, field, 80, {
    pattern: new RegExp(`^${prefix}_[A-Za-z0-9-]{2,72}$`),
  });
}

function normalizeHttpUrl(value, field) {
  const safe = boundedText(value, field, 2048);
  let parsed;
  try {
    parsed = new URL(safe);
  } catch {
    validationError(`${field} must be a valid URL.`, field);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) validationError(`${field} must use HTTP or HTTPS.`, field);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeContentBrief(input = {}) {
  const brief = assertObject(input, "brief");
  const verticalId = normalizeVerticalId(brief.verticalId, brief.formatId);
  if (verticalId === "dark_curiosity") {
    assertAllowedKeys(brief, [
      "schemaVersion", "verticalId", "formatId", "language", "audience", "topic", "thesis", "targetSeconds",
      "tone", "sourceRefs", "operatorNotes", "riskClass", "riskTags", "contentHash",
    ], "brief");
  }
  const sourceRefs = [...new Set((Array.isArray(brief.sourceRefs) ? brief.sourceRefs : [])
    .map((value, index) => normalizeId(value, `sourceRefs[${index}]`, "src")))]
    .slice(0, 8);
  const formatId = assertVerticalFormat(verticalId, brief.formatId);
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    formatId,
    language: allowedToken(brief.language, "language", LANGUAGES),
    audience: boundedText(brief.audience, "audience", 120),
    topic: boundedText(brief.topic, "topic", 180),
    thesis: boundedText(brief.thesis, "thesis", 280),
    targetSeconds: boundedInteger(brief.targetSeconds, "targetSeconds", 20, 45),
    tone: boundedText(brief.tone || "clear_direct", "tone", 40),
    sourceRefs,
    operatorNotes: boundedText(brief.operatorNotes || "", "operatorNotes", 500, { required: false }),
  };
  if (verticalId === "dark_curiosity") {
    const riskClass = allowedToken(brief.riskClass || "ordinary", "riskClass", DARK_RISK_CLASSES);
    if (riskClass !== "ordinary") validationError("This topic requires manual risk review and is outside the MVP.", "riskClass");
    const riskTags = [...new Set((Array.isArray(brief.riskTags) ? brief.riskTags : [])
      .map((value, index) => allowedToken(value, `riskTags[${index}]`, DARK_RISK_TAGS)))]
      .slice(0, 8);
    if (riskTags.length) validationError("Risk-tagged topics require manual review and are outside the MVP.", "riskTags");
    return {
      ...normalized,
      schemaVersion: DARK_CURIOSITY_SCHEMA_VERSION,
      verticalId,
      riskClass,
      riskTags,
      contentHash: contentHash({
        ...normalized,
        schemaVersion: DARK_CURIOSITY_SCHEMA_VERSION,
        verticalId,
        riskClass,
        riskTags,
      }),
    };
  }
  return { ...normalized, contentHash: contentHash(normalized) };
}

function normalizeSource(source, index) {
  assertObject(source, `sources[${index}]`);
  const normalized = {
    id: normalizeId(source.id, `sources[${index}].id`, "src"),
    title: boundedText(source.title, `sources[${index}].title`, 180),
    url: normalizeHttpUrl(source.url, `sources[${index}].url`),
    verifiedBy: boundedText(source.verifiedBy || "operator", `sources[${index}].verifiedBy`, 80),
    verifiedAt: boundedText(source.verifiedAt, `sources[${index}].verifiedAt`, 40),
    snapshotHash: boundedText(source.snapshotHash, `sources[${index}].snapshotHash`, 80, {
      pattern: /^(?:sha256:)?[a-f0-9]{64}$/i,
    }).toLowerCase(),
  };
  if (!Number.isFinite(Date.parse(normalized.verifiedAt))) {
    validationError(`sources[${index}].verifiedAt is invalid.`, `sources[${index}].verifiedAt`);
  }
  return normalized;
}

function normalizeDarkSource(source, index) {
  assertAllowedKeys(source, [
    "id", "title", "publisher", "author", "url", "publishedAt", "verifiedBy", "verifiedAt", "snapshotHash",
    "sourceClass", "independenceGroup", "evidenceNote",
  ], `sources[${index}]`);
  const base = normalizeSource(source, index);
  const normalized = {
    ...base,
    publisher: boundedText(source.publisher, `sources[${index}].publisher`, 160),
    author: boundedText(source.author || "", `sources[${index}].author`, 120, { required: false }) || null,
    publishedAt: boundedText(source.publishedAt || "", `sources[${index}].publishedAt`, 40, { required: false }) || null,
    sourceClass: allowedToken(source.sourceClass, `sources[${index}].sourceClass`, DARK_SOURCE_CLASSES),
    independenceGroup: boundedText(source.independenceGroup, `sources[${index}].independenceGroup`, 100, {
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/,
    }),
    evidenceNote: boundedText(source.evidenceNote, `sources[${index}].evidenceNote`, 360),
  };
  if (normalized.publishedAt && !Number.isFinite(Date.parse(normalized.publishedAt))) {
    validationError(`sources[${index}].publishedAt is invalid.`, `sources[${index}].publishedAt`);
  }
  return normalized;
}

function normalizeClaim(claim, index) {
  assertObject(claim, `claims[${index}]`);
  return {
    id: normalizeId(claim.id, `claims[${index}].id`, "claim"),
    text: boundedText(claim.text, `claims[${index}].text`, 400),
    kind: allowedToken(claim.kind, `claims[${index}].kind`, CLAIM_KINDS),
    sourceIds: [...new Set((Array.isArray(claim.sourceIds) ? claim.sourceIds : [])
      .map((value, sourceIndex) => normalizeId(value, `claims[${index}].sourceIds[${sourceIndex}]`, "src")))]
      .slice(0, 6),
    operatorApproved: claim.operatorApproved === true,
  };
}

function normalizeDarkSourceLink(link, claimIndex, linkIndex, sourceById) {
  const field = `claims[${claimIndex}].sourceLinks[${linkIndex}]`;
  assertObject(link, field);
  assertAllowedKeys(link, ["sourceId", "support", "evidenceExcerpt", "pageOrTimecode"], field);
  const sourceId = normalizeId(link.sourceId, `${field}.sourceId`, "src");
  if (!sourceById.has(sourceId)) validationError("Claim references an unknown source.", `${field}.sourceId`, { sourceId });
  return {
    sourceId,
    support: allowedToken(link.support, `${field}.support`, SOURCE_SUPPORT_TYPES),
    evidenceExcerpt: boundedText(link.evidenceExcerpt, `${field}.evidenceExcerpt`, 280),
    pageOrTimecode: boundedText(link.pageOrTimecode || "", `${field}.pageOrTimecode`, 80, { required: false }) || null,
  };
}

function normalizeDarkClaim(claim, index, sourceById) {
  assertObject(claim, `claims[${index}]`);
  assertAllowedKeys(claim, [
    "id", "text", "kind", "claimType", "verdict", "riskTags", "sourceIds", "sourceLinks", "operatorApproved",
  ], `claims[${index}]`);
  const sourceLinks = boundedList(claim.sourceLinks, `claims[${index}].sourceLinks`, 1, 6)
    .map((link, linkIndex) => normalizeDarkSourceLink(link, index, linkIndex, sourceById));
  const sourceIds = [...new Set(sourceLinks.filter((link) => link.support !== "contradicts").map((link) => link.sourceId))];
  const claimType = allowedToken(claim.claimType, `claims[${index}].claimType`, DARK_CLAIM_TYPES);
  const verdict = allowedToken(claim.verdict, `claims[${index}].verdict`, DARK_CLAIM_VERDICTS);
  if (verdict === "unsupported") validationError("Unsupported claims cannot enter a narrated draft.", `claims[${index}].verdict`);
  const normalized = {
    id: normalizeId(claim.id, `claims[${index}].id`, "claim"),
    text: boundedText(claim.text, `claims[${index}].text`, 400),
    kind: allowedToken(claim.kind || (claimType === "verifiable_fact" || claimType === "quote" || claimType === "estimate" ? "supported_fact" : "analysis"), `claims[${index}].kind`, CLAIM_KINDS),
    claimType,
    verdict,
    riskTags: [...new Set((Array.isArray(claim.riskTags) ? claim.riskTags : [])
      .map((value, riskIndex) => allowedToken(value, `claims[${index}].riskTags[${riskIndex}]`, DARK_RISK_TAGS)))]
      .slice(0, 8),
    sourceIds,
    sourceLinks,
    operatorApproved: claim.operatorApproved === true,
  };
  if (!normalized.operatorApproved) validationError("Every claim must be operator approved.", `claims[${index}].operatorApproved`);
  if (["verifiable_fact", "quote", "estimate"].includes(claimType)) {
    const supportingLinks = sourceLinks.filter((link) => ["direct", "corroborating"].includes(link.support));
    const independenceGroups = new Set(supportingLinks.map((link) => sourceById.get(link.sourceId).independenceGroup));
    const definitivePrimary = supportingLinks.some((link) => {
      const sourceClass = sourceById.get(link.sourceId).sourceClass;
      return link.support === "direct" && ["primary", "institutional"].includes(sourceClass);
    });
    if (!definitivePrimary && independenceGroups.size < 2) {
      validationError("A factual Dark Curiosity claim requires two independent sources or one definitive primary record.", `claims[${index}].sourceLinks`);
    }
  }
  return normalized;
}

function normalizeClaimLedger(input = {}, options = {}) {
  const ledger = assertObject(input, "claimLedger");
  const brief = options.brief ? normalizeContentBrief(options.brief) : null;
  const verticalId = normalizeVerticalId(brief && brief.verticalId, brief && brief.formatId);
  if (verticalId === "dark_curiosity") {
    assertAllowedKeys(ledger, ["schemaVersion", "verticalId", "sources", "claims", "contentHash"], "claimLedger");
  }
  const sources = boundedList(ledger.sources, "sources", 1, 12)
    .map(verticalId === "dark_curiosity" ? normalizeDarkSource : normalizeSource);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const claims = boundedList(ledger.claims, "claims", 1, 6)
    .map((claim, index) => verticalId === "dark_curiosity" ? normalizeDarkClaim(claim, index, sourceById) : normalizeClaim(claim, index));
  const sourceIds = uniqueIds(sources, "sources");
  uniqueIds(claims, "claims");
  for (const [index, claim] of claims.entries()) {
    if (!claim.operatorApproved) validationError("Every claim must be operator approved.", `claims[${index}].operatorApproved`);
    if (claim.kind === "supported_fact" && claim.sourceIds.length === 0) {
      validationError("A supported fact requires a source.", `claims[${index}].sourceIds`);
    }
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) validationError("Claim references an unknown source.", `claims[${index}].sourceIds`, { sourceId });
    }
  }
  if (brief) {
    for (const sourceRef of brief.sourceRefs) {
      if (!sourceIds.has(sourceRef)) validationError("Brief references an unknown source.", "brief.sourceRefs", { sourceRef });
    }
  }
  const normalized = verticalId === "dark_curiosity"
    ? { schemaVersion: DARK_CURIOSITY_SCHEMA_VERSION, verticalId, sources, claims }
    : { schemaVersion: SCHEMA_VERSION, sources, claims };
  return { ...normalized, contentHash: contentHash(normalized) };
}

function normalizeBeat(beat, index, allowedRoles = BEAT_ROLES) {
  assertObject(beat, `beats[${index}]`);
  return {
    id: normalizeId(beat.id, `beats[${index}].id`, "beat"),
    role: allowedToken(beat.role, `beats[${index}].role`, allowedRoles),
    spokenText: boundedText(beat.spokenText, `beats[${index}].spokenText`, 320),
    onScreenText: boundedText(beat.onScreenText, `beats[${index}].onScreenText`, 96),
    claimIds: [...new Set((Array.isArray(beat.claimIds) ? beat.claimIds : [])
      .map((value, claimIndex) => normalizeId(value, `beats[${index}].claimIds[${claimIndex}]`, "claim")))]
      .slice(0, 4),
  };
}

function normalizeNarrativeScript(input = {}, options = {}) {
  const script = assertObject(input, "script");
  const brief = options.brief ? normalizeContentBrief(options.brief) : null;
  const verticalId = normalizeVerticalId(brief && brief.verticalId, brief && brief.formatId);
  if (verticalId === "dark_curiosity") {
    assertAllowedKeys(script, ["schemaVersion", "verticalId", "title", "estimatedSeconds", "beats", "provider", "contentHash"], "script");
    for (const [index, beat] of (Array.isArray(script.beats) ? script.beats : []).entries()) {
      if (beat && typeof beat === "object" && !Array.isArray(beat)) {
        assertAllowedKeys(beat, ["id", "role", "spokenText", "onScreenText", "claimIds"], `beats[${index}]`);
      }
    }
    if (script.provider && typeof script.provider === "object" && !Array.isArray(script.provider)) {
      assertAllowedKeys(script.provider, ["mode", "model", "promptVersion"], "provider");
    }
  }
  const beatRoles = VERTICALS[verticalId].beatRoles;
  const beats = boundedList(script.beats, "beats", 3, 8).map((beat, index) => normalizeBeat(beat, index, beatRoles));
  uniqueIds(beats, "beats");
  if (beats[0].role !== "hook") validationError("The first beat must be the hook.", "beats[0].role");
  if (beats[beats.length - 1].role !== "payoff") validationError("The last beat must be the payoff.", `beats[${beats.length - 1}].role`);
  let previousRoleIndex = -1;
  for (const [index, beat] of beats.entries()) {
    if (!beatRoles.includes(beat.role)) validationError("Script beat role is unsupported for this vertical.", `beats[${index}].role`);
    const roleIndex = beatRoles.indexOf(beat.role);
    if (roleIndex < previousRoleIndex) validationError("Script beats are out of narrative order.", `beats[${index}].role`);
    previousRoleIndex = roleIndex;
  }
  if (options.claimLedger) {
    const ledger = normalizeClaimLedger(options.claimLedger, brief ? { brief } : {});
    const claimIds = new Set(ledger.claims.map((claim) => claim.id));
    for (const [index, beat] of beats.entries()) {
      for (const claimId of beat.claimIds) {
        if (!claimIds.has(claimId)) validationError("Script beat references an unknown claim.", `beats[${index}].claimIds`, { claimId });
      }
    }
  }
  const totalWords = beats.reduce((sum, beat) => sum + beat.spokenText.split(/\s+/).filter(Boolean).length, 0);
  const estimatedSeconds = boundedInteger(script.estimatedSeconds, "estimatedSeconds", 20, 45);
  const wordsPerMinute = totalWords / (estimatedSeconds / 60);
  if (wordsPerMinute < 105 || wordsPerMinute > 205) validationError("Script reading speed is outside the supported range.", "beats", { wordsPerMinute: Math.round(wordsPerMinute) });
  const normalized = {
    schemaVersion: verticalId === "dark_curiosity" ? DARK_CURIOSITY_SCHEMA_VERSION : SCHEMA_VERSION,
    title: boundedText(script.title, "title", 120),
    estimatedSeconds,
    beats,
    provider: {
      mode: boundedText(script.provider && script.provider.mode || "manual", "provider.mode", 60),
      model: boundedText(script.provider && script.provider.model || "", "provider.model", 100, { required: false }) || null,
      promptVersion: boundedText(script.provider && script.provider.promptVersion || "manual_v1", "provider.promptVersion", 80),
    },
  };
  if (verticalId === "dark_curiosity") normalized.verticalId = verticalId;
  return { ...normalized, contentHash: contentHash(normalized) };
}

function normalizePoint(value, field) {
  if (!Array.isArray(value) || value.length !== 2) validationError(`${field} must be an [x,y] point.`, field);
  return [boundedNumber(value[0], `${field}[0]`, 0, 1), boundedNumber(value[1], `${field}[1]`, 0, 1)];
}

function normalizeOperation(operation, sceneIndex, operationIndex, durationFrames) {
  const field = `scenes[${sceneIndex}].operations[${operationIndex}]`;
  assertObject(operation, field);
  const op = allowedToken(operation.op, `${field}.op`, FOOTBALL_OPERATIONS);
  const normalized = { op };
  if (operation.id != null) normalized.id = boundedText(operation.id, `${field}.id`, 32, { pattern: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/ });
  if (operation.team != null) normalized.team = allowedToken(operation.team, `${field}.team`, ["attack", "defend", "neutral"]);
  if (operation.x != null) normalized.x = boundedNumber(operation.x, `${field}.x`, 0, 1);
  if (operation.y != null) normalized.y = boundedNumber(operation.y, `${field}.y`, 0, 1);
  if (operation.from != null) normalized.from = normalizePoint(operation.from, `${field}.from`);
  if (operation.to != null) normalized.to = normalizePoint(operation.to, `${field}.to`);
  if (operation.startFrame != null) normalized.startFrame = boundedInteger(operation.startFrame, `${field}.startFrame`, 0, durationFrames - 1);
  if (operation.endFrame != null) normalized.endFrame = boundedInteger(operation.endFrame, `${field}.endFrame`, 1, durationFrames);
  if (normalized.startFrame != null && normalized.endFrame != null && normalized.endFrame <= normalized.startFrame) {
    validationError(`${field} has an invalid frame range.`, field);
  }
  for (const token of ["shape", "side", "text", "targetId"]) {
    if (operation[token] != null) normalized[token] = boundedText(operation[token], `${field}.${token}`, token === "text" ? 80 : 40);
  }
  return normalized;
}

function normalizeScene(scene, index, beatIds) {
  assertObject(scene, `scenes[${index}]`);
  const durationFrames = boundedInteger(scene.durationFrames, `scenes[${index}].durationFrames`, 15, 900);
  const normalizedBeatIds = [...new Set(boundedList(scene.beatIds, `scenes[${index}].beatIds`, 1, 4)
    .map((value, beatIndex) => normalizeId(value, `scenes[${index}].beatIds[${beatIndex}]`, "beat")))];
  for (const beatId of normalizedBeatIds) {
    if (!beatIds.has(beatId)) validationError("Scene references an unknown beat.", `scenes[${index}].beatIds`, { beatId });
  }
  const template = allowedToken(scene.template, `scenes[${index}].template`, SCENE_TEMPLATES);
  const operations = (Array.isArray(scene.operations) ? scene.operations : []).slice(0, 40)
    .map((operation, operationIndex) => normalizeOperation(operation, index, operationIndex, durationFrames));
  if (["pitch_tactical_sequence", "formation_compare"].includes(template) && operations.length === 0) {
    validationError("A football scene requires at least one operation.", `scenes[${index}].operations`);
  }
  return {
    id: normalizeId(scene.id, `scenes[${index}].id`, "scene"),
    beatIds: normalizedBeatIds,
    template,
    reconstructionMode: allowedToken(scene.reconstructionMode || "generic", `scenes[${index}].reconstructionMode`, RECONSTRUCTION_MODES),
    durationFrames,
    operations,
  };
}

function normalizeStoryboard(input = {}, options = {}) {
  const storyboard = assertObject(input, "storyboard");
  if (!options.script) validationError("Storyboard validation requires a script.", "script");
  const brief = options.brief ? normalizeContentBrief(options.brief) : null;
  const claimLedger = options.claimLedger ? normalizeClaimLedger(options.claimLedger, brief ? { brief } : {}) : null;
  const script = normalizeNarrativeScript(options.script, { ...options, brief: brief || options.brief, claimLedger: claimLedger || options.claimLedger });
  const verticalId = normalizeVerticalId(brief && brief.verticalId, brief && brief.formatId);
  if (verticalId === "dark_curiosity") {
    const { normalizeDarkCuriosityStoryboard } = require("./dark-curiosity/storyboard-validator.cjs");
    return normalizeDarkCuriosityStoryboard(storyboard, { brief, claimLedger, script });
  }
  const beatIds = new Set(script.beats.map((beat) => beat.id));
  const scenes = boundedList(storyboard.scenes, "scenes", 3, 10)
    .map((scene, index) => normalizeScene(scene, index, beatIds));
  uniqueIds(scenes, "scenes");
  const coveredBeats = new Set(scenes.flatMap((scene) => scene.beatIds));
  for (const beatId of beatIds) {
    if (!coveredBeats.has(beatId)) validationError("Every script beat must be represented by a scene.", "scenes", { beatId });
  }
  if (scenes[0].template !== "hook_text") validationError("The first scene must use hook_text.", "scenes[0].template");
  if (scenes[scenes.length - 1].template !== "payoff") validationError("The final scene must use payoff.", `scenes[${scenes.length - 1}].template`);
  const normalized = { schemaVersion: SCHEMA_VERSION, fps: 30, scenes };
  return { ...normalized, contentHash: contentHash(normalized) };
}

function normalizeDraftBundle(input = {}) {
  const bundle = assertObject(input, "draftBundle");
  const brief = normalizeContentBrief(bundle.brief);
  const claimLedger = normalizeClaimLedger(bundle.claimLedger, { brief });
  const script = normalizeNarrativeScript(bundle.script, { brief, claimLedger });
  const storyboard = normalizeStoryboard(bundle.storyboard, { brief, claimLedger, script });
  const verticalId = normalizeVerticalId(brief.verticalId, brief.formatId);
  const normalized = verticalId === "dark_curiosity"
    ? { schemaVersion: DARK_CURIOSITY_SCHEMA_VERSION, verticalId, brief, claimLedger, script, storyboard }
    : { schemaVersion: SCHEMA_VERSION, brief, claimLedger, script, storyboard };
  return { ...normalized, contentHash: contentHash(normalized) };
}

module.exports = {
  BEAT_ROLES,
  CLAIM_KINDS,
  DARK_CLAIM_TYPES,
  DARK_CLAIM_VERDICTS,
  DARK_CURIOSITY_SCHEMA_VERSION,
  DARK_RISK_CLASSES,
  DARK_RISK_TAGS,
  DARK_SOURCE_CLASSES,
  FOOTBALL_OPERATIONS,
  FORMAT_IDS,
  LANGUAGES,
  RECONSTRUCTION_MODES,
  SCENE_TEMPLATES,
  SCHEMA_VERSION,
  contentHash,
  normalizeClaimLedger,
  normalizeContentBrief,
  normalizeDraftBundle,
  normalizeNarrativeScript,
  normalizeStoryboard,
  stableStringify,
};
