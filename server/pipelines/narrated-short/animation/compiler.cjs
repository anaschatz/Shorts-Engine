const { validateAnimationIR } = require("./contract.cjs");
const { validateComplexityBudget } = require("./complexity-budget.cjs");

function compileAnimationIR(input, options = {}) {
  const compiled = validateAnimationIR({ ...structuredClone(input), contentHash: undefined }, options);
  validateComplexityBudget(compiled);
  return compiled;
}

module.exports = { compileAnimationIR };
