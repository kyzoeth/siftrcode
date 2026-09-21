
const { Option, Help } = require("./");
const option = new Option("-a <value>").default("default value", "custom");
const helper = new Help();
const desc = helper.optionDescription(option);
if (desc !== "(default: custom)") {
  process.exit(1);
}
process.exit(0);
