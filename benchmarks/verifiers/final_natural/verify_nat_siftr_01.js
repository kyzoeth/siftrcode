const { PythonSymbolParser } = require('./dist/parsing/python_parser');
const parser = new PythonSymbolParser();
if (typeof parser.getProcessTimeoutMs !== 'function') process.exit(1);
if (parser.getProcessTimeoutMs() !== 10000) process.exit(1);
process.exit(0);