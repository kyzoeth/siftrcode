
const { Command } = require("./");
const program = new Command();
if (typeof program.optionsGroup !== "function") {
  process.exit(1);
}
program.optionsGroup("CustomOptions:");
program.option("--custom-flag");
const help = program.helpInformation();
if (!help.includes("CustomOptions:") || !help.includes("--custom-flag")) {
  process.exit(1);
}
process.exit(0);
