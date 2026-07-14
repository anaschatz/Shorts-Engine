const { validateAnimationIR } = require("./contract.cjs");
const { validateComplexityBudget } = require("./complexity-budget.cjs");
const { bindAnimationTiming } = require("./timing-compiler.cjs");
const { validateTemplateOperations } = require("./template-validator.cjs");
const { validateSemanticNarrative } = require("./semantic-narrative.cjs");

function compileAnimationIR(input, options = {}) {
  const bound = bindAnimationTiming({ ...structuredClone(input), contentHash: undefined }, options.timingContext || null);
  const compiled = validateAnimationIR(bound, options);
  validateComplexityBudget(compiled);
  validateTemplateOperations(compiled);
  validateSemanticNarrative(compiled);
  return compiled;
}

function compileTimingBoundAnimationIR(input, timingContext) {
  return compileAnimationIR(input, { timingContext });
}

module.exports = { compileAnimationIR, compileTimingBoundAnimationIR };
