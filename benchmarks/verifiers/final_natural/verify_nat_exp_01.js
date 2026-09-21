const req = require('./lib/request');
if (typeof req.supportsQueryMethodRevalidation !== 'function') process.exit(1);
if (req.supportsQueryMethodRevalidation('QUERY') !== true) process.exit(1);
if (req.supportsQueryMethodRevalidation('POST') !== false) process.exit(1);
process.exit(0);