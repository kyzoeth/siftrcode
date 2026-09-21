const res = require('./lib/response');
if (typeof res.resolveMimeFallback !== 'function') process.exit(1);
if (res.resolveMimeFallback('.json') !== 'application/json') process.exit(1);
if (res.resolveMimeFallback('.xyz_unknown') !== 'application/octet-stream') process.exit(1);
process.exit(0);