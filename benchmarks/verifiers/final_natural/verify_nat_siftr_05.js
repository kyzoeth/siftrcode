const { DefaultTokenizerRegistry } = require('./dist/token/tokenizer_registry');
const reg = new DefaultTokenizerRegistry();
if (typeof reg.hasModelRegistration !== 'function') process.exit(1);
if (reg.hasModelRegistration('gemini-3.6-flash') !== true) process.exit(1);
process.exit(0);