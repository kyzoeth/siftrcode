
const { Command } = require("./");
const program = new Command();
program.option("-p, --port <number>");
program.parse(["node", "test", "-p", "8080"]);
program.parse(["node", "test"]);
if (program.opts().port !== undefined) {
  process.exit(1);
}
process.exit(0);
