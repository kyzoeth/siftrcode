
const egressMod = require("./dist/security/structured_egress");
if (typeof egressMod.EgressDeniedError !== "function") {
  process.exit(1);
}
const err = new egressMod.EgressDeniedError("RIGHTS", "blocked");
if (err.reason !== "RIGHTS") {
  process.exit(1);
}
process.exit(0);
