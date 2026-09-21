
const cp = require("child_process");
let passedTimeout = null;
const orig = cp.spawnSync;
cp.spawnSync = function(cmd, args, opts) {
  passedTimeout = opts ? opts.timeout : undefined;
  return { status: 0, stdout: "[]" };
};
const { PythonSymbolParser } = require("./dist/parsing/python_parser");
const p = new PythonSymbolParser();
p.parseSymbols("x = 1", "test.py");
cp.spawnSync = orig;
if (passedTimeout !== 5000) {
  process.exit(1);
}
process.exit(0);
