const utils = require('./lib/utils');
if (typeof utils.safeNormalizeType !== 'function') process.exit(1);
if (utils.safeNormalizeType('unknown/custom').value !== 'application/octet-stream') process.exit(1);
process.exit(0);