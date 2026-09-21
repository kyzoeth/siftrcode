
const { RightsFilter } = require("./dist/rights/rights_filter");
const filter = new RightsFilter();
if (typeof filter.evaluateTrainingEvidenceRecord !== "function") {
  process.exit(1);
}
process.exit(0);
