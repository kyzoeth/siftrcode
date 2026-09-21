
let parseMod;
try {
  parseMod = require("./dist/parsing/golang_parser");
} catch (e) {
  process.exit(1);
}
if (typeof parseMod.GolangSymbolParser !== "function") {
  process.exit(1);
}
const parser = new parseMod.GolangSymbolParser();
if (typeof parser.parseSymbols !== "function") {
  process.exit(1);
}
process.exit(0);
