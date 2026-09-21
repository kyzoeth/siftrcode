
const { Command } = require("./");
const program = new Command();
program.configureOutput({ getOutHelpWidth: () => 80 });
const copy = program.createCommand("copy");
copy.copyInheritedSettings(program);
copy.configureOutput({ getOutHelpWidth: () => 40 });
if (copy.configureOutput().getOutHelpWidth() !== 40) process.exit(1);
if (program.configureOutput().getOutHelpWidth() !== 80) process.exit(1);
process.exit(0);
