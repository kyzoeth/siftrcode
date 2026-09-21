const { DefaultTokenCostEstimator } = require('./dist/token/token_cost_estimator');
const e = new DefaultTokenCostEstimator();
if (typeof e.verifyMonotonicity !== 'function') process.exit(1);
const c = { name: 5, signature: 10, skeleton: 20, body: 50, full: 100 };
if (!e.verifyMonotonicity(c)) process.exit(1);
process.exit(0);