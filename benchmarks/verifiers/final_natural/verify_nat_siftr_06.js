
process.env.SIFTR_JEV_MAX_CALLS = "7";
const { JevShadowRunner } = require("./dist/providers/judgment/typesafe/jev_shadow_runner");
const runner = new JevShadowRunner();
const budget = runner.getBudget ? runner.getBudget() : runner.budget;
if (!budget || budget.maxCallsPerTask !== 7) {
  process.exit(1);
}
process.exit(0);
