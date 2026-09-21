
const { ContextEngine } = require("./dist/engine/context_engine");
const engine = new ContextEngine({});
if (typeof engine.getDataRights !== "function") {
  process.exit(1);
}
const rights = engine.getDataRights();
if (!rights) {
  process.exit(1);
}
process.exit(0);
