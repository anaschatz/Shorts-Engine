const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { sanitizeText } = require("../../repositories/ids.cjs");
const { renderSceneSvg: renderFootballSceneSvg, planSceneKeyframes: planFootballKeyframes } = require("./football/scene-svg.cjs");
const { renderDarkCuriositySceneSvg, planDarkCuriosityKeyframes } = require("./dark-curiosity/scene-svg.cjs");
const { verticalDescriptor } = require("./vertical-registry.cjs");

const TEMPLATE_VERSION = "1.0.0";
const RENDERER_VERSION = "2.0.0";

const RENDERERS = Object.freeze({
  football_explainer: Object.freeze({
    version: TEMPLATE_VERSION,
    render: renderFootballSceneSvg,
    planKeyframes: planFootballKeyframes,
  }),
  dark_curiosity: Object.freeze({
    version: TEMPLATE_VERSION,
    render: renderDarkCuriositySceneSvg,
    planKeyframes: planDarkCuriosityKeyframes,
  }),
});

function fail(code, message, details = {}) {
  throw new AppError(code, message || SAFE_MESSAGES.VALIDATION_ERROR, 400, details);
}

function normalizeTemplateVersion(value) {
  const version = sanitizeText(value || TEMPLATE_VERSION, 24);
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail("TEMPLATE_VERSION_UNSUPPORTED", "Scene template version is unsupported.", { version });
  return version;
}

function resolveSceneRenderer(input = {}) {
  const vertical = verticalDescriptor(input.verticalId, input.formatId);
  const template = sanitizeText(input.template || "", 80).toLowerCase();
  if (!vertical.sceneTemplates.includes(template)) {
    fail("SCENE_TEMPLATE_MISMATCH", "Scene template does not belong to the selected content vertical.", {
      verticalId: vertical.verticalId,
      template,
    });
  }
  const renderer = RENDERERS[vertical.verticalId];
  if (!renderer) fail("SCENE_RENDERER_UNAVAILABLE", "Scene renderer is unavailable.", { verticalId: vertical.verticalId });
  const templateVersion = normalizeTemplateVersion(input.templateVersion);
  if (templateVersion !== renderer.version) {
    fail("TEMPLATE_VERSION_UNSUPPORTED", "Scene template version is unsupported.", {
      verticalId: vertical.verticalId,
      template,
      templateVersion,
    });
  }
  return Object.freeze({
    verticalId: vertical.verticalId,
    template,
    templateVersion,
    rendererVersion: RENDERER_VERSION,
    render: renderer.render,
    planKeyframes: renderer.planKeyframes,
  });
}

function templateVersionsFor(verticalId, templates, formatId = null) {
  const uniqueTemplates = [...new Set(Array.isArray(templates) ? templates : [])];
  return Object.fromEntries(uniqueTemplates.map((template) => {
    const resolved = resolveSceneRenderer({ verticalId, formatId, template, templateVersion: TEMPLATE_VERSION });
    return [resolved.template, resolved.templateVersion];
  }));
}

module.exports = {
  RENDERER_VERSION,
  TEMPLATE_VERSION,
  resolveSceneRenderer,
  templateVersionsFor,
};
