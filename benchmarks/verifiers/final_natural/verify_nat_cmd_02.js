
const { Command } = require("./");
const program = new Command();
let caughtErr = null;
program.exitOverride().allowExcessArguments(false).action(() => {});
try {
  program.parse(["node", "test", "extra_one"]);
} catch (err) {
  caughtErr = err;
}
if (!caughtErr || !caughtErr.message.includes(": extra_one.")) {
  process.exit(1);
}
process.exit(0);
