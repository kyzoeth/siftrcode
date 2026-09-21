
let brandMod;
try {
  brandMod = require("./dist/learning/training_persistence_brand");
} catch (e) {
  process.exit(1);
}
if (typeof brandMod.markSanctionedExport !== "function") {
  process.exit(1);
}
const obj = {};
brandMod.markSanctionedExport(obj);
if (!brandMod.isSanctionedTrainingExport(obj)) {
  process.exit(1);
}
process.exit(0);
