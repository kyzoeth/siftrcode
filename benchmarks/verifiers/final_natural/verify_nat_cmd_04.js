
const { Command } = require("./");
const program = new Command();
program.exitOverride().configureOutput({ writeErr: () => {} }).argument("<value>", "argument");
let caught = null;
try {
  program.parse(["-123"], { from: "user" });
} catch (err) {
  caught = err;
}
if (caught || !program.args || program.args[0] !== "-123") {
  process.exit(1);
}
process.exit(0);
