
let tokMod;
try {
  tokMod = require("./dist/token/tokenizer_registry");
} catch (e) {
  process.exit(1);
}
if (typeof tokMod.DefaultTokenizerRegistry !== "function") {
  process.exit(1);
}
const reg = tokMod.DefaultTokenizerRegistry.getInstance();
if (typeof reg.estimate !== "function") {
  process.exit(1);
}
const est = reg.estimate("hello world");
if (!est || typeof est.tokens !== "number") {
  process.exit(1);
}
process.exit(0);
