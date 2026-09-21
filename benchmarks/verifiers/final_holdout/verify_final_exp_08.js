const utils = require('./lib/utils');
if (typeof utils.appendHeader !== 'function') process.exit(1);
const h = {};
const r = { get: k => h[k], set: (k, v) => { h[k] = v; } };
utils.appendHeader(r, 'x-test', '1');
utils.appendHeader(r, 'x-test', '2');
if (!Array.isArray(h['x-test']) || h['x-test'].length !== 2) process.exit(1);
process.exit(0);