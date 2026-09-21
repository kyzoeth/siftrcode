const { TypeScriptSymbolParser } = require('./dist/parsing/typescript_parser');
const tsp = new TypeScriptSymbolParser();
if (typeof tsp.supportsCharacterByteOffsets !== 'function') process.exit(1);
if (tsp.supportsCharacterByteOffsets() !== true) process.exit(1);
process.exit(0);