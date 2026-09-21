
const { Command } = require("./");
const program = new Command();
program.option("--no-pepper", "remove pepper").option("--pepper", "pepper only");
program.parse([], { from: "user" });
if (program.opts().pepper !== undefined) {
  process.exit(1);
}
process.exit(0);
