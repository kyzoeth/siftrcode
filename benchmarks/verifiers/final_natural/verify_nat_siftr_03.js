
let provMod;
try {
  provMod = require("./dist/provenance/build_provenance");
} catch (e) {
  process.exit(1);
}
if (typeof provMod.computeSourceTreeHash !== "function") {
  process.exit(1);
}
const hash = provMod.computeSourceTreeHash(__dirname);
if (!hash || hash.length !== 64) {
  process.exit(1);
}
process.exit(0);
